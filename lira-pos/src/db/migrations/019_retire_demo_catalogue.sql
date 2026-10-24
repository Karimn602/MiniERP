-- ============================================================================
-- Migration v19 — retire the v3 demonstration catalogue, and ONLY if it is
-- still exactly what migration 003 and 004 wrote (WP-A corrections, round 2)
-- ----------------------------------------------------------------------------
-- THE PROBLEM
--
-- Migration 003 inserts three products — "Coffee 250g", "Bottled Water 1.5L"
-- and "Wholesale Olive Oil 5L" — with four barcodes, and migration 004 gives
-- them five `product_uoms` rows. Its own header says why: "so dev environments
-- come up with usable data". But a migration is not a development fixture. It
-- runs on every installation, so a restaurant opening Greaz for the first time
-- is handed three sellable grocery items on the register's menu grid: they
-- scan, they can be rung up, and they print on a customer's receipt.
--
-- WHY THIS MIGRATION RATHER THAN A CHANGE TO 003
--
-- 003 has shipped. Its checksum is recorded in every database that applied it,
-- and editing it would stop those databases opening at all. The only
-- forward-compatible remedy is an additive migration that corrects the state
-- 003 left behind.
--
-- WHAT IT DOES
--
-- It sets `is_active = 0` on a demonstration product, and nothing else. No row
-- is deleted, no child is touched, no historical document is rewritten, and no
-- other table is read except to PROVE the product was never used.
--
-- WHY DEACTIVATE RATHER THAN DELETE
--
-- A product is referenced by every document that ever sold or received it.
-- Deleting one either fails on a foreign key or takes a posted line with it.
-- `is_active = 0` is the application's own supported way to say "not
-- sellable": `productsRepo.listEnriched` and `findByScan` both filter on it,
-- so the item leaves the menu grid and stops resolving from a scan while
-- every row that names it stays exactly as it was posted.
--
-- ============================================================================
-- THE PREDICATE: "CONCLUSIVELY AN UNTOUCHED ORIGINAL SEED ROW"
-- ============================================================================
--
-- The first version of this migration matched on `id IN (...) AND sku IN
-- (...)` plus three sanity checks. That was too weak in two different ways,
-- and both are fixed here.
--
-- 1. INDEPENDENT `IN` LISTS ARE NOT A PAIRING. `id IN (d1,d2,d3) AND sku IN
--    ('DEMO-001','DEMO-002','DEMO-003')` also matches a row whose id is d1 and
--    whose SKU is DEMO-003 — a shop that renamed and re-SKU'd one seed row
--    into another's slot would have had it switched off on the strength of a
--    pairing that was never checked. Every statement below names ONE id and
--    ONE sku, together, in the same equality test.
--
-- 2. A SHOP MAY HAVE ADOPTED THE ROW BY EDITING IT. Zero stock and no
--    transactions do not mean "untouched": an owner can rename the product,
--    reprice it, give it a menu section, an icon, a description, a reorder
--    point, change its VAT rate or its pricing mode, make it a service, add a
--    barcode, retire a UoM — all without ever selling one. Any of those is
--    somebody deciding this row is theirs. So the predicate now compares the
--    COMPLETE mutable signature of the product and of its children, and
--    retires the row only when every single field still holds the value the
--    seed wrote.
--
-- THE SIGNATURE, FIELD BY FIELD (products, in its v18 shape)
--
--   id + sku            the pair, in one statement, never two IN lists
--   store_id            the seeded store
--   name                exact
--   description         still NULL
--   vat_rate_id         the seeded standard rate
--   vat_pricing_mode    'inclusive' / 'exclusive' as seeded per product
--   price_excl_vat_cents, price_incl_vat_cents       exact
--   avg_cost_excl_vat_cents, avg_cost_incl_vat_cents both still 0
--   avg_cost_excl_vat_microcents, ..._incl_...       both still 0
--   quantity_on_hand    still 0
--   reorder_point       still NULL
--   is_active           still 1 (so re-running this migration changes nothing)
--   is_service          still 0
--   category, icon      both still NULL
--
-- SCHEMA DRIFT BETWEEN 003 AND 018 IS ACCOUNTED FOR. The signature is written
-- against the table as it exists at v18, not as 003 wrote it:
--
--   * `products.unit` was in 003's INSERT and was DROPPED by 004 (UoM rows
--     replaced it), so it cannot be compared and is not referenced here.
--   * `avg_cost_*_microcents` did not exist until 008, which backfilled them
--     from the cents columns; for a seed row that is 0 → 0.
--   * `category` and `icon` did not exist until 013, which added them NULL and
--     wrote no data.
--   * `product_uoms` did not exist until 004, which seeded the five rows below.
--
-- CHILDREN ARE COMPARED AS EXACT SETS
--
-- For each product: the number of `product_barcodes` rows must equal the
-- number the seed created, and each expected row must still exist with every
-- column intact; the same for `product_uoms`. Count plus full-column EXISTS
-- is what proves no child was ADDED, none was DELETED, and none was MODIFIED.
-- A shop that added its own barcode to the demo coffee, or retired the box
-- UoM on the water, keeps the product.
--
-- TIMESTAMPS ARE USED, AND THEIR SEMANTICS ARE PROVEN
--
-- `updated_at = created_at` is required on the product and on every child.
-- This is sound because each of the three tables carries an unconditional
-- AFTER UPDATE trigger that rewrites `updated_at` to `now`:
-- `trg_products_updated_at` (001, recreated in 008),
-- `trg_product_barcodes_updated_at` (002) and `trg_product_uoms_updated_at`
-- (004). Any UPDATE through any path — the app, a script, a SQL console —
-- therefore bumps it, so an unequal pair PROVES the row was written since it
-- was inserted. The one place that bypasses it is 008's microcent backfill,
-- which deliberately drops the trigger around itself and does not write
-- `updated_at` at all, so it preserves equality.
--
-- The converse is NOT claimed: equality does not by itself prove the row is
-- pristine, which is why it is an additional condition on top of the full
-- signature rather than a substitute for any part of it. And the failure
-- direction is safe — a row whose timestamps differ for any reason is simply
-- left active.
--
-- HISTORY AND TRANSACTION GUARDS (unchanged, and still required)
--
-- Even a byte-perfect seed row is left alone if anything in the ledger
-- references it: a `sale_items` line, a `purchase_items` line, an
-- `inventory_movements` row, or a `sales_credit_memo_lines` line. A product
-- that has been traded is the shop's, whatever its columns say.
--
-- WHAT THIS MIGRATION CANNOT DO
--
-- If a demonstration product cannot be proven pristine, it stays ACTIVE. That
-- is the deliberate failure direction: leaving a stale demo item sellable is a
-- tidiness problem the owner can fix in one click, while deactivating a
-- product a shop has adopted is a stock item vanishing from the till in the
-- middle of service.
--
-- Re-running changes nothing: `is_active = 1` is part of every predicate.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Coffee 250g — seeded as DEMO-001, id 00000000-0000-0000-0000-0000000000d1
-- ----------------------------------------------------------------------------
UPDATE products
   SET is_active = 0
 WHERE
   -- The id and the SKU as ONE pairing, never two independent lists.
       products.id  = '00000000-0000-0000-0000-0000000000d1'
   AND products.sku = 'DEMO-001'
   AND products.store_id = '00000000-0000-0000-0000-000000000001'
   -- The full mutable signature of the seed row, at the v18 shape.
   AND products.name = 'Coffee 250g'
   AND products.description IS NULL
   AND products.vat_rate_id = '00000000-0000-0000-0000-000000000010'
   AND products.vat_pricing_mode = 'inclusive'
   AND products.price_excl_vat_cents = 450
   AND products.price_incl_vat_cents = 500
   AND products.avg_cost_excl_vat_cents = 0
   AND products.avg_cost_incl_vat_cents = 0
   AND products.avg_cost_excl_vat_microcents = 0
   AND products.avg_cost_incl_vat_microcents = 0
   AND products.quantity_on_hand = 0
   AND products.reorder_point IS NULL
   AND products.is_active = 1
   AND products.is_service = 0
   AND products.category IS NULL
   AND products.icon IS NULL
   -- Never updated since it was inserted (see the header for why
   -- this is evidence and not a guess).
   AND products.updated_at = products.created_at
   -- The barcode set, exactly: this many rows, and each one intact.
   AND (SELECT COUNT(*) FROM product_barcodes b
         WHERE b.product_id = products.id) = 1
   AND EXISTS (
         SELECT 1 FROM product_barcodes b
          WHERE b.id = '00000000-0000-0000-0000-000000000a01'
            AND b.product_id = products.id
            AND b.store_id = '00000000-0000-0000-0000-000000000001'
            AND b.barcode = '5281234567890'
            AND b.lookup_value = '5281234567890'
            AND b.barcode_type = 'EAN13'
            AND b.is_primary = 1
            AND b.is_active = 1
            AND b.product_uom_id IS NULL
            AND b.updated_at = b.created_at
       )
   -- The unit-of-measure set, exactly, on the same terms.
   AND (SELECT COUNT(*) FROM product_uoms u
         WHERE u.product_id = products.id) = 1
   AND EXISTS (
         SELECT 1 FROM product_uoms u
          WHERE u.id = '00000000-0000-0000-0000-0000000000e1'
            AND u.product_id = products.id
            AND u.store_id = '00000000-0000-0000-0000-000000000001'
            AND u.uom_code = 'pcs'
            AND u.factor_num = 1
            AND u.factor_den = 1
            AND u.is_base = 1
            AND u.is_default_sale_uom = 1
            AND u.is_default_purchase_uom = 1
            AND u.is_active = 1
            AND u.sale_price_excl_vat_cents IS NULL
            AND u.sale_price_incl_vat_cents IS NULL
            AND u.updated_at = u.created_at
       )
   -- And nothing in the ledger has ever referenced it.
   AND NOT EXISTS (SELECT 1 FROM sale_items              si WHERE si.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM purchase_items          pi WHERE pi.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM inventory_movements     im WHERE im.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM sales_credit_memo_lines cl WHERE cl.product_id = products.id)
;

-- ----------------------------------------------------------------------------
-- Bottled Water 1.5L — seeded as DEMO-002, id 00000000-0000-0000-0000-0000000000d2
-- ----------------------------------------------------------------------------
UPDATE products
   SET is_active = 0
 WHERE
   -- The id and the SKU as ONE pairing, never two independent lists.
       products.id  = '00000000-0000-0000-0000-0000000000d2'
   AND products.sku = 'DEMO-002'
   AND products.store_id = '00000000-0000-0000-0000-000000000001'
   -- The full mutable signature of the seed row, at the v18 shape.
   AND products.name = 'Bottled Water 1.5L'
   AND products.description IS NULL
   AND products.vat_rate_id = '00000000-0000-0000-0000-000000000010'
   AND products.vat_pricing_mode = 'inclusive'
   AND products.price_excl_vat_cents = 90
   AND products.price_incl_vat_cents = 100
   AND products.avg_cost_excl_vat_cents = 0
   AND products.avg_cost_incl_vat_cents = 0
   AND products.avg_cost_excl_vat_microcents = 0
   AND products.avg_cost_incl_vat_microcents = 0
   AND products.quantity_on_hand = 0
   AND products.reorder_point IS NULL
   AND products.is_active = 1
   AND products.is_service = 0
   AND products.category IS NULL
   AND products.icon IS NULL
   -- Never updated since it was inserted (see the header for why
   -- this is evidence and not a guess).
   AND products.updated_at = products.created_at
   -- The barcode set, exactly: this many rows, and each one intact.
   AND (SELECT COUNT(*) FROM product_barcodes b
         WHERE b.product_id = products.id) = 1
   AND EXISTS (
         SELECT 1 FROM product_barcodes b
          WHERE b.id = '00000000-0000-0000-0000-000000000a02'
            AND b.product_id = products.id
            AND b.store_id = '00000000-0000-0000-0000-000000000001'
            AND b.barcode = '5281234567906'
            AND b.lookup_value = '5281234567906'
            AND b.barcode_type = 'EAN13'
            AND b.is_primary = 1
            AND b.is_active = 1
            AND b.product_uom_id IS NULL
            AND b.updated_at = b.created_at
       )
   -- The unit-of-measure set, exactly, on the same terms.
   AND (SELECT COUNT(*) FROM product_uoms u
         WHERE u.product_id = products.id) = 2
   AND EXISTS (
         SELECT 1 FROM product_uoms u
          WHERE u.id = '00000000-0000-0000-0000-0000000000e2'
            AND u.product_id = products.id
            AND u.store_id = '00000000-0000-0000-0000-000000000001'
            AND u.uom_code = 'pcs'
            AND u.factor_num = 1
            AND u.factor_den = 1
            AND u.is_base = 1
            AND u.is_default_sale_uom = 1
            AND u.is_default_purchase_uom = 0
            AND u.is_active = 1
            AND u.sale_price_excl_vat_cents IS NULL
            AND u.sale_price_incl_vat_cents IS NULL
            AND u.updated_at = u.created_at
       )
   AND EXISTS (
         SELECT 1 FROM product_uoms u
          WHERE u.id = '00000000-0000-0000-0000-0000000000e3'
            AND u.product_id = products.id
            AND u.store_id = '00000000-0000-0000-0000-000000000001'
            AND u.uom_code = 'box'
            AND u.factor_num = 12
            AND u.factor_den = 1
            AND u.is_base = 0
            AND u.is_default_sale_uom = 0
            AND u.is_default_purchase_uom = 1
            AND u.is_active = 1
            AND u.sale_price_excl_vat_cents IS NULL
            AND u.sale_price_incl_vat_cents IS NULL
            AND u.updated_at = u.created_at
       )
   -- And nothing in the ledger has ever referenced it.
   AND NOT EXISTS (SELECT 1 FROM sale_items              si WHERE si.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM purchase_items          pi WHERE pi.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM inventory_movements     im WHERE im.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM sales_credit_memo_lines cl WHERE cl.product_id = products.id)
;

-- ----------------------------------------------------------------------------
-- Wholesale Olive Oil 5L — seeded as DEMO-003, id 00000000-0000-0000-0000-0000000000d3
-- ----------------------------------------------------------------------------
UPDATE products
   SET is_active = 0
 WHERE
   -- The id and the SKU as ONE pairing, never two independent lists.
       products.id  = '00000000-0000-0000-0000-0000000000d3'
   AND products.sku = 'DEMO-003'
   AND products.store_id = '00000000-0000-0000-0000-000000000001'
   -- The full mutable signature of the seed row, at the v18 shape.
   AND products.name = 'Wholesale Olive Oil 5L'
   AND products.description IS NULL
   AND products.vat_rate_id = '00000000-0000-0000-0000-000000000010'
   AND products.vat_pricing_mode = 'exclusive'
   AND products.price_excl_vat_cents = 4000
   AND products.price_incl_vat_cents = 4440
   AND products.avg_cost_excl_vat_cents = 0
   AND products.avg_cost_incl_vat_cents = 0
   AND products.avg_cost_excl_vat_microcents = 0
   AND products.avg_cost_incl_vat_microcents = 0
   AND products.quantity_on_hand = 0
   AND products.reorder_point IS NULL
   AND products.is_active = 1
   AND products.is_service = 0
   AND products.category IS NULL
   AND products.icon IS NULL
   -- Never updated since it was inserted (see the header for why
   -- this is evidence and not a guess).
   AND products.updated_at = products.created_at
   -- The barcode set, exactly: this many rows, and each one intact.
   AND (SELECT COUNT(*) FROM product_barcodes b
         WHERE b.product_id = products.id) = 2
   AND EXISTS (
         SELECT 1 FROM product_barcodes b
          WHERE b.id = '00000000-0000-0000-0000-000000000a03'
            AND b.product_id = products.id
            AND b.store_id = '00000000-0000-0000-0000-000000000001'
            AND b.barcode = '5281234567913'
            AND b.lookup_value = '5281234567913'
            AND b.barcode_type = 'EAN13'
            AND b.is_primary = 1
            AND b.is_active = 1
            AND b.product_uom_id IS NULL
            AND b.updated_at = b.created_at
       )
   AND EXISTS (
         SELECT 1 FROM product_barcodes b
          WHERE b.id = '00000000-0000-0000-0000-000000000a04'
            AND b.product_id = products.id
            AND b.store_id = '00000000-0000-0000-0000-000000000001'
            AND b.barcode = 'SUP-OLIVE-5L'
            AND b.lookup_value = 'SUP-OLIVE-5L'
            AND b.barcode_type = 'SUPPLIER'
            AND b.is_primary = 0
            AND b.is_active = 1
            AND b.product_uom_id IS NULL
            AND b.updated_at = b.created_at
       )
   -- The unit-of-measure set, exactly, on the same terms.
   AND (SELECT COUNT(*) FROM product_uoms u
         WHERE u.product_id = products.id) = 2
   AND EXISTS (
         SELECT 1 FROM product_uoms u
          WHERE u.id = '00000000-0000-0000-0000-0000000000e4'
            AND u.product_id = products.id
            AND u.store_id = '00000000-0000-0000-0000-000000000001'
            AND u.uom_code = 'pcs'
            AND u.factor_num = 1
            AND u.factor_den = 1
            AND u.is_base = 1
            AND u.is_default_sale_uom = 1
            AND u.is_default_purchase_uom = 0
            AND u.is_active = 1
            AND u.sale_price_excl_vat_cents IS NULL
            AND u.sale_price_incl_vat_cents IS NULL
            AND u.updated_at = u.created_at
       )
   AND EXISTS (
         SELECT 1 FROM product_uoms u
          WHERE u.id = '00000000-0000-0000-0000-0000000000e5'
            AND u.product_id = products.id
            AND u.store_id = '00000000-0000-0000-0000-000000000001'
            AND u.uom_code = 'case'
            AND u.factor_num = 4
            AND u.factor_den = 1
            AND u.is_base = 0
            AND u.is_default_sale_uom = 0
            AND u.is_default_purchase_uom = 1
            AND u.is_active = 1
            AND u.sale_price_excl_vat_cents IS NULL
            AND u.sale_price_incl_vat_cents IS NULL
            AND u.updated_at = u.created_at
       )
   -- And nothing in the ledger has ever referenced it.
   AND NOT EXISTS (SELECT 1 FROM sale_items              si WHERE si.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM purchase_items          pi WHERE pi.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM inventory_movements     im WHERE im.product_id = products.id)
   AND NOT EXISTS (SELECT 1 FROM sales_credit_memo_lines cl WHERE cl.product_id = products.id)
;

-- The barcodes stay attached to the retired products, deliberately. They are
-- children of a product that no longer resolves — `findByScan` joins through
-- `products.is_active` — so nothing can be scanned into a sale, and a barcode
-- row may be referenced by history through the product it belongs to. Deleting
-- one to free its unique value would be destroying evidence to tidy a
-- constraint. The importer and the product form instead tell the operator that
-- the value belongs to an INACTIVE product and name it, so the owner can
-- reactivate that product rather than duplicate it.
