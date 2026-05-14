-- ============================================================================
-- Migration v5 — Suppliers, Purchases, Purchase Items
-- ----------------------------------------------------------------------------
-- Adds the documents that justify every 'purchase' and 'opening' row in
-- inventory_movements. Purchases follow the same immutability rules as
-- sales: once posted_at IS NOT NULL, the row is frozen. Corrections are
-- done via reversing adjustments, not by editing history.
--
-- Why a header/lines split (suppliers/purchases/purchase_items) when an
-- adjustment is just a movements row? Because purchases have a real-world
-- document (a supplier invoice) that you'll want to look up, print, and
-- eventually reconcile against accounts payable in Phase 3+. Adjustments
-- don't — they're internal shrinkage/count corrections.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SUPPLIERS — minimal vendor record. We can attach an address, contact, etc.
-- in a later migration without touching purchases.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  contact_name    TEXT,
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_store_active ON suppliers(store_id, is_active);
CREATE INDEX IF NOT EXISTS idx_suppliers_name         ON suppliers(store_id, name);

CREATE TRIGGER IF NOT EXISTS trg_suppliers_updated_at
AFTER UPDATE ON suppliers
BEGIN
  UPDATE suppliers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;


-- ----------------------------------------------------------------------------
-- PURCHASES — header row for a supplier invoice (or opening-stock batch).
-- Conventions match the sales table: posted_at IS NOT NULL ⇒ immutable.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id                       TEXT PRIMARY KEY,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  -- supplier_id is NULL only for opening-stock batches.
  supplier_id              TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,

  -- 'normal'  → real purchase from a supplier (supplier_id required)
  -- 'opening' → opening stock for newly-introduced products (supplier_id NULL ok)
  purchase_type            TEXT NOT NULL DEFAULT 'normal'
                           CHECK (purchase_type IN ('normal','opening')),

  -- Supplier-facing reference: invoice number on the bill, etc.
  supplier_reference       TEXT,
  -- Internal sequential number per store, app-assigned.
  purchase_number          INTEGER NOT NULL,

  -- Document date — when the supplier issued the invoice (local YYYY-MM-DD).
  purchase_date            TEXT NOT NULL,

  -- Totals (USD cents) — denormalized, recomputed from lines at posting time.
  subtotal_excl_vat_cents  INTEGER NOT NULL DEFAULT 0,
  vat_total_cents          INTEGER NOT NULL DEFAULT 0,
  total_incl_vat_cents     INTEGER NOT NULL DEFAULT 0,

  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','posted','voided')),

  -- Audit
  created_by_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id                TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  posted_at                TEXT,           -- IS NOT NULL ⇒ immutable
  voided_at                TEXT,
  voided_by_user_id        TEXT REFERENCES users(id) ON DELETE RESTRICT,
  void_reason              TEXT,

  notes                    TEXT,
  UNIQUE (store_id, purchase_number),

  -- Opening-stock batches don't need a supplier. Normal purchases do.
  CHECK (purchase_type = 'opening' OR supplier_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_purchases_store_posted ON purchases(store_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier     ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status       ON purchases(store_id, status);


-- ----------------------------------------------------------------------------
-- PURCHASE_ITEMS — lines on a purchase. Snapshots UoM and cost like
-- sale_items snapshots price/VAT. The inventory_movements row created at
-- posting carries the canonical base-UoM quantity and per-base unit cost
-- that drives the weighted-avg cost recompute.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
  id                            TEXT PRIMARY KEY,
  purchase_id                   TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  store_id                      TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id                    TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Snapshots
  product_name_snapshot         TEXT NOT NULL,
  product_sku_snapshot          TEXT,

  -- UoM used for the line. Snapshot the conversion factor so future UoM
  -- changes don't retroactively rewrite history.
  product_uom_id_snapshot       TEXT REFERENCES product_uoms(id) ON DELETE RESTRICT,
  uom_code_snapshot             TEXT NOT NULL,
  factor_num_snapshot           INTEGER NOT NULL CHECK (factor_num_snapshot > 0),
  factor_den_snapshot           INTEGER NOT NULL CHECK (factor_den_snapshot > 0),

  -- Quantities — both stored. quantity_in_uom is what the user typed
  -- (e.g. "10 boxes"); quantity_base is the canonical (e.g. 120 pcs).
  quantity_in_uom               INTEGER NOT NULL CHECK (quantity_in_uom > 0),
  quantity_base                 INTEGER NOT NULL CHECK (quantity_base > 0),

  -- Unit costs (USD cents)
  --   * unit_cost_excl_vat_in_uom_cents → cost per 1 UoM (what was on the invoice)
  --   * unit_cost_incl_vat_in_uom_cents → same with VAT
  --   * unit_cost_excl_vat_base_cents   → derived per-base cost, used for the
  --                                       movement's unit_cost and weighted-avg.
  --   * unit_cost_incl_vat_base_cents   → same with VAT
  unit_cost_excl_vat_in_uom_cents  INTEGER NOT NULL CHECK (unit_cost_excl_vat_in_uom_cents  >= 0),
  unit_cost_incl_vat_in_uom_cents  INTEGER NOT NULL CHECK (unit_cost_incl_vat_in_uom_cents  >= 0),
  unit_cost_excl_vat_base_cents    INTEGER NOT NULL CHECK (unit_cost_excl_vat_base_cents    >= 0),
  unit_cost_incl_vat_base_cents    INTEGER NOT NULL CHECK (unit_cost_incl_vat_base_cents    >= 0),

  -- VAT on this purchase line (input VAT) — snapshotted from product, but
  -- the user can override if the supplier invoiced a different rate.
  vat_rate_id_snapshot          TEXT NOT NULL REFERENCES vat_rates(id) ON DELETE RESTRICT,
  vat_rate_bps_snapshot         INTEGER NOT NULL,

  -- Line totals (USD cents)
  line_subtotal_excl_vat_cents  INTEGER NOT NULL,
  line_vat_cents                INTEGER NOT NULL,
  line_total_incl_vat_cents     INTEGER NOT NULL,

  -- The inventory movement this line created. Set by post_transaction;
  -- null on drafts.
  related_movement_id           TEXT REFERENCES inventory_movements(id) ON DELETE RESTRICT,

  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product  ON purchase_items(product_id);


-- ----------------------------------------------------------------------------
-- Link inventory_movements back to a purchase document. Sales already have
-- related_sale_id; this is the symmetric column for purchases.
-- ----------------------------------------------------------------------------
ALTER TABLE inventory_movements ADD COLUMN related_purchase_id      TEXT
  REFERENCES purchases(id) ON DELETE RESTRICT;
ALTER TABLE inventory_movements ADD COLUMN related_purchase_item_id TEXT
  REFERENCES purchase_items(id) ON DELETE RESTRICT;


-- ----------------------------------------------------------------------------
-- IMMUTABILITY TRIGGERS — same pattern as sales.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_purchases_no_update_after_post
BEFORE UPDATE ON purchases
WHEN OLD.posted_at IS NOT NULL
  -- Allow only status→voided + matching void columns.
  AND NOT (
    NEW.status = 'voided'
    AND OLD.status = 'posted'
    AND NEW.id = OLD.id
    AND NEW.purchase_number = OLD.purchase_number
    AND NEW.total_incl_vat_cents = OLD.total_incl_vat_cents
    AND NEW.posted_at = OLD.posted_at
  )
BEGIN
  SELECT RAISE(ABORT, 'Posted purchases are immutable. Post a reversing adjustment instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchases_no_delete_after_post
BEFORE DELETE ON purchases
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Posted purchases cannot be deleted.');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_no_update_after_post
BEFORE UPDATE ON purchase_items
WHEN (SELECT posted_at FROM purchases WHERE id = OLD.purchase_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Purchase items of a posted purchase are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_no_delete_after_post
BEFORE DELETE ON purchase_items
WHEN (SELECT posted_at FROM purchases WHERE id = OLD.purchase_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Purchase items of a posted purchase cannot be deleted.');
END;


-- ----------------------------------------------------------------------------
-- App settings — purchase number sequence.
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('next_purchase_number', '1');
