-- ============================================================================
-- Migration v13 — menu presentation: category and icon (WP-3)
-- ----------------------------------------------------------------------------
-- Two nullable TEXT columns on `products`, and nothing else. No data is
-- rewritten, no constraint is tightened, and no existing row changes meaning.
--
-- WHY THIS IS SCHEMA AND NOT SETTINGS
--
-- The register's menu grid has always wanted real restaurant sections —
-- "Burgers", "Wraps", "Sides", "Drinks" — and could not have them, because the
-- only `category` anywhere in the schema is `units_of_measure.category`, which
-- classifies units (count / weight / volume / length) and not food. The
-- grouping seam in `lib/menuGrid.ts::deriveMenuGroups` was written against the
-- day this column would arrive and says so.
--
-- Holding it in localStorage instead was considered and rejected: a product's
-- section is master data about the product, not a preference of the machine
-- looking at it, and scattering it per-device means two tills disagree about
-- what a burger is. It belongs beside the name and the price.
--
-- WHY BOTH COLUMNS ARE NULLABLE, WITH NO DEFAULT AND NO CHECK
--
-- Every product that exists today is valid without either field, and must stay
-- valid: a shop mid-service cannot be asked to categorise its catalogue before
-- it can sell again. So NULL means "uncategorised", the register groups those
-- under its own fallback chip, and nothing refuses to load.
--
-- `category` deliberately has no CHECK constraint listing the sections. The
-- menu of a restaurant changes more often than its database schema should, and
-- a CHECK would mean a migration to add a section. The canonical list lives in
-- `lib/menuCategories.ts`, which also owns the normalisation that stops
-- "Drinks", "drinks" and " Drinks " becoming three sections — the duplicate
-- problem a free-text column really does have, solved at the one boundary that
-- writes it rather than by a constraint that cannot normalise.
--
-- `icon` is a short presentational string (the fixture uses an emoji). It is
-- never parsed, matched or used to infer anything about the product; a product
-- with no icon falls back to its category's glyph in the UI, which is why this
-- column may stay NULL for ever without anything looking broken.
--
-- NEITHER COLUMN IS FINANCIAL. They are not snapshotted onto `sale_items`, do
-- not enter any canonical comparison, and no posting command reads them. A
-- product's section is not part of what was sold; `product_name_snapshot` and
-- the price already record that, at the moment of posting.

ALTER TABLE products ADD COLUMN category TEXT;
ALTER TABLE products ADD COLUMN icon TEXT;

-- Grouping the grid is the only query that touches `category`, and it is a
-- per-store read of the sellable catalogue. Indexed with `store_id` leading, to
-- match how every other product query is scoped.
CREATE INDEX IF NOT EXISTS idx_products_store_category
  ON products (store_id, category);
