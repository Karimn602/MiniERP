-- ============================================================================
-- Migration v4 — Full multi-UoM support
-- ----------------------------------------------------------------------------
-- Adds:
--   * units_of_measure       — global UoM catalog (pcs, g, kg, ml, l, box, ...)
--   * product_uoms           — N rows per product; exactly one flagged is_base
--   * UoM snapshot columns on sale_items, inventory_movements
--   * UoM linkage column on product_barcodes (a barcode CAN target a specific UoM)
--
-- Drops:
--   * products.unit  (replaced by per-product rows in product_uoms)
--
-- Conventions:
--   * Conversion is stored as (factor_numerator / factor_denominator) — both
--     POSITIVE INTEGERS — to avoid floats. base_qty = sale_qty * num / den.
--   * The base UoM row always has factor (1, 1).
--   * quantity_on_hand on products is denominated in the product's base UoM.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- UNITS_OF_MEASURE — global catalog. Code is the natural primary key (short,
-- stable identifier). The category groups roughly-comparable UoMs for UI
-- (e.g. "g, kg, lb, oz" are all weight) but does NOT itself enforce convertibility
-- — that's per-product via product_uoms.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS units_of_measure (
  code            TEXT PRIMARY KEY,                -- 'pcs', 'g', 'kg', 'ml', 'l', 'box', 'pack', 'each'
  name            TEXT NOT NULL,                   -- 'Pieces', 'Grams', 'Kilograms', ...
  category        TEXT NOT NULL CHECK (category IN ('count','weight','volume','length','other')),
  -- A purely informational symbol for display ('kg', 'g', 'L', 'mL', 'pc'); may
  -- differ from `code` (e.g. code='each' could display as 'ea').
  symbol          TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


-- ----------------------------------------------------------------------------
-- PRODUCT_UOMS — N rows per product. Each row represents a UoM the product can
-- be sold, purchased, or stocked in. The base row (is_base=1) is the canonical
-- unit; everything else converts to it via (factor_num / factor_den).
--
-- Constraints (enforced by partial indexes below):
--   * Exactly one row per product has is_base = 1.
--   * Exactly one row per product has is_default_sale_uom = 1.
--   * Exactly one row per product has is_default_purchase_uom = 1.
--   * (The defaults may or may not be the base — that's a business choice.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_uoms (
  id                          TEXT PRIMARY KEY,
  store_id                    TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id                  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  uom_code                    TEXT NOT NULL REFERENCES units_of_measure(code) ON DELETE RESTRICT,

  -- Conversion to base UoM: 1 × this_uom = (factor_num / factor_den) × base_uom
  -- For the base row itself: (1, 1).
  factor_num                  INTEGER NOT NULL CHECK (factor_num > 0),
  factor_den                  INTEGER NOT NULL CHECK (factor_den > 0),

  -- Role flags
  is_base                     INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0,1)),
  is_default_sale_uom         INTEGER NOT NULL DEFAULT 0 CHECK (is_default_sale_uom IN (0,1)),
  is_default_purchase_uom     INTEGER NOT NULL DEFAULT 0 CHECK (is_default_purchase_uom IN (0,1)),
  is_active                   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),

  -- Optional: the price of this UoM when sold. NULL means "compute from base
  -- price × factor" at sale time. Phase 2C: if a shop wants "1 box = $20"
  -- but "1 pcs = $1" (so a box is cheaper than 24× single pcs), they fill this.
  -- Stored as USD cents like all other prices.
  sale_price_excl_vat_cents   INTEGER CHECK (sale_price_excl_vat_cents IS NULL OR sale_price_excl_vat_cents >= 0),
  sale_price_incl_vat_cents   INTEGER CHECK (sale_price_incl_vat_cents IS NULL OR sale_price_incl_vat_cents >= 0),

  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- A product can't list the same UoM twice (would be ambiguous)
  UNIQUE (product_id, uom_code),

  -- Base row MUST have factor (1,1). Anything else is a data bug.
  CHECK (is_base = 0 OR (factor_num = 1 AND factor_den = 1)),

  -- If a price is set for this UoM, both incl and excl must be set together —
  -- never one without the other (mirrors the products table policy).
  CHECK ((sale_price_excl_vat_cents IS NULL) = (sale_price_incl_vat_cents IS NULL))
);

-- Hot lookup: "give me all UoMs for this product"
CREATE INDEX IF NOT EXISTS idx_product_uoms_product
  ON product_uoms(product_id, is_active);

-- Enforce: exactly one base UoM per product
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_uoms_one_base
  ON product_uoms(product_id)
  WHERE is_base = 1;

-- Enforce: exactly one default sale UoM per product (across active rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_uoms_one_default_sale
  ON product_uoms(product_id)
  WHERE is_default_sale_uom = 1 AND is_active = 1;

-- Enforce: exactly one default purchase UoM per product (across active rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_uoms_one_default_purchase
  ON product_uoms(product_id)
  WHERE is_default_purchase_uom = 1 AND is_active = 1;

-- Auto-update timestamp
CREATE TRIGGER IF NOT EXISTS trg_product_uoms_updated_at
AFTER UPDATE ON product_uoms
BEGIN
  UPDATE product_uoms SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;


-- ----------------------------------------------------------------------------
-- PRODUCT_BARCODES — link a barcode to a SPECIFIC UoM (optional).
-- If product_uom_id IS NULL, the barcode resolves to the product's default
-- sale UoM at scan time. If it IS set, scanning auto-picks that UoM.
--
-- Example: water product has UoMs (pcs, box). Two barcodes:
--   '528...0001' → product_uom_id = <pcs row id>   (sticker on each bottle)
--   '528...0024' → product_uom_id = <box row id>   (sticker on the case)
-- ----------------------------------------------------------------------------
ALTER TABLE product_barcodes ADD COLUMN product_uom_id TEXT
  REFERENCES product_uoms(id) ON DELETE SET NULL;


-- ----------------------------------------------------------------------------
-- SALE_ITEMS — snapshot the UoM that was used at the time of the sale.
-- Without these, editing a product's UoMs later would silently change what
-- historical sale quantities mean.
--
-- We store:
--   * quantity_in_uom         — what the cashier typed (e.g. 2 boxes → 2)
--   * uom_code_snapshot       — which UoM (e.g. 'box')
--   * factor_num_snapshot,
--     factor_den_snapshot     — the conversion factor AT SALE TIME
--   * (existing) quantity     — the canonical base-UoM amount
--                               (e.g. 2 boxes × 24 = 48 pcs)
--
-- COGS math and inventory decrement use the existing `quantity` column.
-- Display / receipts use the *_in_uom + uom_code_snapshot pair.
-- ----------------------------------------------------------------------------
ALTER TABLE sale_items ADD COLUMN quantity_in_uom    INTEGER;
ALTER TABLE sale_items ADD COLUMN uom_code_snapshot  TEXT;
ALTER TABLE sale_items ADD COLUMN factor_num_snapshot INTEGER;
ALTER TABLE sale_items ADD COLUMN factor_den_snapshot INTEGER;


-- ----------------------------------------------------------------------------
-- INVENTORY_MOVEMENTS — same snapshot, same reasoning.
-- ----------------------------------------------------------------------------
ALTER TABLE inventory_movements ADD COLUMN quantity_in_uom    INTEGER;
ALTER TABLE inventory_movements ADD COLUMN uom_code_snapshot  TEXT;
ALTER TABLE inventory_movements ADD COLUMN factor_num_snapshot INTEGER;
ALTER TABLE inventory_movements ADD COLUMN factor_den_snapshot INTEGER;


-- ----------------------------------------------------------------------------
-- PRODUCTS — drop the now-redundant `unit` column.
--
-- SQLite supports DROP COLUMN as of 3.35 (2021). The Tauri SQL plugin ships
-- with a recent SQLite, so this is safe. If for any reason the plugin's
-- bundled SQLite is older, this statement will fail loudly — at which point
-- the fix is one line: comment this out and ignore the dead column.
-- ----------------------------------------------------------------------------
ALTER TABLE products DROP COLUMN unit;


-- ============================================================================
-- SEED — populate the UoM catalog and attach UoMs to the 3 demo products.
-- ============================================================================

-- Canonical UoMs. Start small; we can add more later without a migration
-- (this table is data, not schema).
INSERT OR IGNORE INTO units_of_measure (code, name, category, symbol) VALUES
  ('pcs',  'Pieces',     'count',  'pcs'),
  ('each', 'Each',       'count',  'ea'),
  ('box',  'Box',        'count',  'box'),
  ('pack', 'Pack',       'count',  'pack'),
  ('case', 'Case',       'count',  'case'),
  ('dozen','Dozen',      'count',  'dz'),
  ('g',    'Grams',      'weight', 'g'),
  ('kg',   'Kilograms',  'weight', 'kg'),
  ('ml',   'Milliliters','volume', 'mL'),
  ('l',    'Liters',     'volume', 'L'),
  ('m',    'Meters',     'length', 'm'),
  ('cm',   'Centimeters','length', 'cm');


-- ----------------------------------------------------------------------------
-- Demo product UoMs.
--
-- DEMO-001 Coffee 250g → pcs only (simple case)
-- DEMO-002 Bottled Water 1.5L → pcs + box (case of 12). Demonstrates multi-UoM.
-- DEMO-003 Wholesale Olive Oil 5L → pcs + case (case of 4). Demonstrates multi-UoM.
-- ----------------------------------------------------------------------------

-- Coffee 250g — single UoM (pcs), is base, is sale default, is purchase default.
INSERT OR IGNORE INTO product_uoms (
  id, store_id, product_id, uom_code,
  factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  '00000000-0000-0000-0000-0000000000e1',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000d1',
  'pcs', 1, 1, 1, 1, 1, 1
);

-- Water — base is pcs, also sold in box of 12.
INSERT OR IGNORE INTO product_uoms (
  id, store_id, product_id, uom_code,
  factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  '00000000-0000-0000-0000-0000000000e2',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000d2',
  'pcs', 1, 1, 1, 1, 0, 1
);
-- Box of 12: 1 box = 12 pcs. Purchases come in boxes (purchase default).
INSERT OR IGNORE INTO product_uoms (
  id, store_id, product_id, uom_code,
  factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  '00000000-0000-0000-0000-0000000000e3',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000d2',
  'box', 12, 1, 0, 0, 1, 1
);

-- Olive Oil — base is pcs, also sold in case of 4.
INSERT OR IGNORE INTO product_uoms (
  id, store_id, product_id, uom_code,
  factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  '00000000-0000-0000-0000-0000000000e4',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000d3',
  'pcs', 1, 1, 1, 1, 0, 1
);
INSERT OR IGNORE INTO product_uoms (
  id, store_id, product_id, uom_code,
  factor_num, factor_den,
  is_base, is_default_sale_uom, is_default_purchase_uom, is_active
) VALUES (
  '00000000-0000-0000-0000-0000000000e5',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000d3',
  'case', 4, 1, 0, 0, 1, 1
);