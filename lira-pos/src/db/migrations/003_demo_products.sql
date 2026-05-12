-- ============================================================================
-- Migration v3 — Seed demo products + barcodes directly via SQL.
--
-- Why this exists: migration v2 tried to attach barcodes to demo products
-- via a JOIN on SKU, but the demo products were never actually inserted by
-- v1 (they lived in a TS seed helper that's not auto-called). This migration
-- inserts both atomically so dev environments come up with usable data.
--
-- All inserts use OR IGNORE so re-running on a partially-populated DB is safe.
-- ============================================================================

-- Demo product 1: Coffee 250g, VAT-inclusive pricing
INSERT OR IGNORE INTO products (
  id, store_id, sku, name, unit,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  quantity_on_hand, is_active, is_service
) VALUES (
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-000000000001',
  'DEMO-001', 'Coffee 250g', 'each',
  '00000000-0000-0000-0000-000000000010', 'inclusive',
  450, 500,
  0, 1, 0
);

-- Demo product 2: Bottled Water 1.5L, VAT-inclusive
INSERT OR IGNORE INTO products (
  id, store_id, sku, name, unit,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  quantity_on_hand, is_active, is_service
) VALUES (
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-000000000001',
  'DEMO-002', 'Bottled Water 1.5L', 'each',
  '00000000-0000-0000-0000-000000000010', 'inclusive',
  90, 100,
  0, 1, 0
);

-- Demo product 3: Wholesale Olive Oil 5L, VAT-exclusive
INSERT OR IGNORE INTO products (
  id, store_id, sku, name, unit,
  vat_rate_id, vat_pricing_mode,
  price_excl_vat_cents, price_incl_vat_cents,
  quantity_on_hand, is_active, is_service
) VALUES (
  '00000000-0000-0000-0000-0000000000d3',
  '00000000-0000-0000-0000-000000000001',
  'DEMO-003', 'Wholesale Olive Oil 5L', 'each',
  '00000000-0000-0000-0000-000000000010', 'exclusive',
  4000, 4440,
  0, 1, 0
);

-- Barcodes — now they have products to attach to.
-- The 528 prefix is the real GS1 Lebanon country code, so they look authentic.
-- Check digits aren't valid; Phase 2's barcode utility will compute proper ones.

INSERT OR IGNORE INTO product_barcodes
  (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000a01',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000d1',
   '5281234567890', '5281234567890', 'EAN13', 1, 1),

  ('00000000-0000-0000-0000-000000000a02',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000d2',
   '5281234567906', '5281234567906', 'EAN13', 1, 1),

  ('00000000-0000-0000-0000-000000000a03',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000d3',
   '5281234567913', '5281234567913', 'EAN13', 1, 1),

  -- Second barcode on the olive oil — supplier code, NOT primary.
  -- Demonstrates the multi-barcode setup for Phase 2.
  ('00000000-0000-0000-0000-000000000a04',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000d3',
   'SUP-OLIVE-5L', 'SUP-OLIVE-5L', 'SUPPLIER', 0, 1);