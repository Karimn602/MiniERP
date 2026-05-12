-- ============================================================================
-- Migration v2 — Barcode-first product identification
-- ============================================================================
-- Adds product_barcodes as a dedicated table. Multiple barcodes per product,
-- one primary, uniqueness per (store, barcode). Includes a normalized
-- lookup_value column so POS scans are a single indexed equality check
-- regardless of input whitespace/casing variations.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_barcodes (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  -- The original barcode as scanned/entered. Preserved exactly for receipts
  -- and supplier matching (a leading zero on a UPC matters).
  barcode         TEXT NOT NULL,

  -- Normalized form for fast lookup. App layer computes this:
  --   trim + uppercase. The app inserts both columns explicitly.
  lookup_value    TEXT NOT NULL,

  barcode_type    TEXT NOT NULL DEFAULT 'OTHER'
                  CHECK (barcode_type IN (
                    'EAN13','EAN8','UPC_A','UPC_E','INTERNAL','SUPPLIER','OTHER'
                  )),

  is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- A given barcode string is unique within a store. Two stores in the future
  -- might (in theory) reuse the same INTERNAL code — that's fine, this scopes it.
  UNIQUE (store_id, barcode)
);

-- Primary POS lookup path: scan input → normalized lookup_value → product_id.
-- This is THE hot index of the entire POS. Every scan hits it.
CREATE INDEX IF NOT EXISTS idx_product_barcodes_lookup
  ON product_barcodes(store_id, lookup_value, is_active);

-- Reverse lookup: show all barcodes for a given product (product edit screen).
CREATE INDEX IF NOT EXISTS idx_product_barcodes_product
  ON product_barcodes(product_id, is_active);

-- Enforce AT MOST ONE primary barcode per product (across active rows).
-- Partial unique index — SQLite-supported, perfect fit. Without this, the
-- app could accidentally flag two barcodes as primary on the same product
-- and we'd have no idea which one to print on labels.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_barcodes_one_primary
  ON product_barcodes(product_id)
  WHERE is_primary = 1 AND is_active = 1;

-- Auto-update updated_at on any modification.
CREATE TRIGGER IF NOT EXISTS trg_product_barcodes_updated_at
AFTER UPDATE ON product_barcodes
BEGIN
  UPDATE product_barcodes
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Extend sale_items with a snapshot of which barcode was scanned.
-- Nullable: for service items there is no barcode, and historical sales
-- (none yet in MVP, but the column has to be NULL-tolerant for safety) won't
-- have it either.
-- ----------------------------------------------------------------------------
ALTER TABLE sale_items
  ADD COLUMN barcode_used_snapshot TEXT;

ALTER TABLE sale_items
  ADD COLUMN barcode_type_snapshot TEXT;

-- ----------------------------------------------------------------------------
-- Seed: backfill the demo products from migration v1 with barcodes.
-- Uses real-looking EAN13 codes (the structure is right; the check digits
-- aren't computed here — we'll add a check-digit helper in Phase 2 utilities).
-- ----------------------------------------------------------------------------
-- DEMO-001 → Coffee 250g
INSERT OR IGNORE INTO product_barcodes
  (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
SELECT
  '00000000-0000-0000-0000-000000000a01',
  store_id,
  id,
  '5281234567890',
  '5281234567890',
  'EAN13', 1, 1
FROM products
WHERE store_id = '00000000-0000-0000-0000-000000000001' AND sku = 'DEMO-001';

-- DEMO-002 → Bottled Water 1.5L
INSERT OR IGNORE INTO product_barcodes
  (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
SELECT
  '00000000-0000-0000-0000-000000000a02',
  store_id,
  id,
  '5281234567906',
  '5281234567906',
  'EAN13', 1, 1
FROM products
WHERE store_id = '00000000-0000-0000-0000-000000000001' AND sku = 'DEMO-002';

-- DEMO-003 → Olive Oil 5L — give it TWO barcodes (a primary EAN13 + a SUPPLIER code)
-- so we can demo multi-barcode lookups in Phase 2.
INSERT OR IGNORE INTO product_barcodes
  (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
SELECT
  '00000000-0000-0000-0000-000000000a03',
  store_id,
  id,
  '5281234567913',
  '5281234567913',
  'EAN13', 1, 1
FROM products
WHERE store_id = '00000000-0000-0000-0000-000000000001' AND sku = 'DEMO-003';

INSERT OR IGNORE INTO product_barcodes
  (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
SELECT
  '00000000-0000-0000-0000-000000000a04',
  store_id,
  id,
  'SUP-OLIVE-5L',
  'SUP-OLIVE-5L',
  'SUPPLIER', 0, 1
FROM products
WHERE store_id = '00000000-0000-0000-0000-000000000001' AND sku = 'DEMO-003';