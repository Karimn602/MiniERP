-- ============================================================================
-- Migration v8 — fractional base-unit cost precision (GP-A03)
-- ----------------------------------------------------------------------------
-- Every unit-COST column in this schema was INTEGER USD cents, so the smallest
-- representable cost per base unit was $0.01. A product bought by the kilo and
-- stocked in grams, or by the litre and consumed in millilitres, has a true
-- per-base cost far below that:
--
--     flour at $2.50/kg, base = gram  ->  $0.0025/g
--     oil   at $3.00/L,  base = ml    ->  $0.0030/ml
--
-- Rounded to cents at purchase time both become 0: every gram costs nothing,
-- COGS collapses, and gross margin is overstated without any visible error.
--
-- This migration gives unit cost — and ONLY unit cost — a finer fixed-point
-- scale beside the existing cents column:
--
--     1 cent = 1,000,000 microcents        (src-tauri/src/cost.rs::COST_SCALE)
--     1 microcent = 1e-6 cents = 1e-8 USD  (src/lib/cost.ts::COST_SCALE)
--
-- WHAT STAYS IN CENTS. Transaction money is untouched: line subtotals, VAT,
-- totals, discounts, tender, extended COGS amounts (`line_cogs_excl_vat_cents`,
-- `sales.cogs_total_cents`) and the supplier ledger remain exact integer cents,
-- because a cent is the smallest amount that can be invoiced, paid or banked.
-- Only the per-unit RATE gains precision. Cost becomes money exactly once, at
-- `cost::extended_cost_cents` (unit microcents x base quantity, rounded once).
--
-- THE `*_cents` COLUMNS ARE KEPT, as a rounded mirror of their microcent
-- sibling, maintained by the posting commands on every write. They remain
-- correct for display and for every pre-existing query, and they are never read
-- back into a cost calculation. The microcent column is the accounting source
-- of truth. Nothing is dropped and no table is rebuilt, so posted history
-- survives byte for byte.
--
-- BACKFILL is exactly `cents * 1000000` — an integer multiplication with no
-- rounding, so every existing cost value is preserved precisely. This is a
-- change of UNITS, not a recomputation: no posted sale's COGS, no posted
-- purchase's cost and no movement snapshot is re-derived from today's prices.
--
-- Three of the four tables being backfilled are append-only, guarded by
-- immutability triggers that (correctly) refuse any UPDATE. The backfill drops
-- exactly those triggers, rewrites the new columns only, and recreates them
-- verbatim from migrations 001 and 005 before the migration's transaction
-- commits. `trg_products_updated_at` is dropped for the same window so the
-- backfill does not rewrite every product's `updated_at`.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. New columns. Each one mirrors an existing cents column, with the same
--    sign constraint, defaulting to 0 so the ALTER needs no table rewrite.
-- ----------------------------------------------------------------------------

-- products — the weighted-average cost pool.
ALTER TABLE products ADD COLUMN avg_cost_excl_vat_microcents INTEGER NOT NULL DEFAULT 0
  CHECK (avg_cost_excl_vat_microcents >= 0);
ALTER TABLE products ADD COLUMN avg_cost_incl_vat_microcents INTEGER NOT NULL DEFAULT 0
  CHECK (avg_cost_incl_vat_microcents >= 0);

-- inventory_movements — the cost snapshot on every cost-bearing movement:
-- what a purchase/opening paid per base unit, and what a sale or adjustment
-- took out per base unit. `last_purchase` COGS reads its rate from here.
ALTER TABLE inventory_movements ADD COLUMN unit_cost_excl_vat_microcents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_movements ADD COLUMN unit_cost_incl_vat_microcents INTEGER NOT NULL DEFAULT 0;

-- purchase_items — the derived per-base purchase cost. The per-UoM cost
-- (`unit_cost_*_in_uom_cents`) stays in cents: it is what the supplier invoice
-- says and what the user typed, exact to the cent by construction.
ALTER TABLE purchase_items ADD COLUMN unit_cost_excl_vat_base_microcents INTEGER NOT NULL DEFAULT 0
  CHECK (unit_cost_excl_vat_base_microcents >= 0);
ALTER TABLE purchase_items ADD COLUMN unit_cost_incl_vat_base_microcents INTEGER NOT NULL DEFAULT 0
  CHECK (unit_cost_incl_vat_base_microcents >= 0);

-- sale_items — the per-unit COGS snapshot. `line_cogs_excl_vat_cents` stays in
-- cents: it is the monetary amount booked against the sale.
ALTER TABLE sale_items ADD COLUMN unit_cogs_excl_vat_microcents INTEGER NOT NULL DEFAULT 0;


-- ----------------------------------------------------------------------------
-- 2. Backfill. Exact: cents x 1,000,000.
--    The append-only guards are lifted only for these statements.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_products_updated_at;
DROP TRIGGER IF EXISTS trg_inv_mov_no_update;
DROP TRIGGER IF EXISTS trg_sale_items_no_update_after_post;
DROP TRIGGER IF EXISTS trg_purchase_items_no_update_after_post;

UPDATE products
   SET avg_cost_excl_vat_microcents = avg_cost_excl_vat_cents * 1000000,
       avg_cost_incl_vat_microcents = avg_cost_incl_vat_cents * 1000000;

UPDATE inventory_movements
   SET unit_cost_excl_vat_microcents = unit_cost_excl_vat_cents * 1000000,
       unit_cost_incl_vat_microcents = unit_cost_incl_vat_cents * 1000000;

UPDATE purchase_items
   SET unit_cost_excl_vat_base_microcents = unit_cost_excl_vat_base_cents * 1000000,
       unit_cost_incl_vat_base_microcents = unit_cost_incl_vat_base_cents * 1000000;

UPDATE sale_items
   SET unit_cogs_excl_vat_microcents = unit_cogs_excl_vat_cents * 1000000;


-- ----------------------------------------------------------------------------
-- 3. Restore the guards, verbatim from migrations 001 and 005.
-- ----------------------------------------------------------------------------

-- 001: inventory_movements — append-only ledger
CREATE TRIGGER IF NOT EXISTS trg_inv_mov_no_update
BEFORE UPDATE ON inventory_movements
BEGIN
  SELECT RAISE(ABORT, 'Inventory movements are append-only. Post a reversing movement instead.');
END;

-- 001: sale_items — completely immutable once the parent sale is posted
CREATE TRIGGER IF NOT EXISTS trg_sale_items_no_update_after_post
BEFORE UPDATE ON sale_items
WHEN (SELECT posted_at FROM sales WHERE id = OLD.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Sale items of a posted sale are immutable.');
END;

-- 005: purchase_items — same rule
CREATE TRIGGER IF NOT EXISTS trg_purchase_items_no_update_after_post
BEFORE UPDATE ON purchase_items
WHEN (SELECT posted_at FROM purchases WHERE id = OLD.purchase_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Purchase items of a posted purchase are immutable.');
END;

-- 001: products.updated_at housekeeping
CREATE TRIGGER IF NOT EXISTS trg_products_updated_at
AFTER UPDATE ON products
BEGIN
  UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
