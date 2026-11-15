-- ============================================================================
-- Migration v25 — OPERATOR CONTROLS (V1.1)
-- ----------------------------------------------------------------------------
-- Owner-facing controls from the founder's own trial of the Training build.
-- Append-only: no posted row is touched and no existing column changes
-- meaning.
--
-- 1. products.show_on_register — WHETHER AN ITEM IS SOLD AT THE TILL.
--    Before this, every active product was a Register tile, so an ingredient
--    (Meat, Potato Bun) appeared as a $0.00 tile a cashier could ring up.
--    Hiding it by deactivating it was not an option: `is_active = 0` also
--    takes it out of purchasing, the Products list and the recipe editor.
--    This flag is narrower: the item stays active, purchasable, countable and
--    usable as a recipe ingredient; it is simply not offered for SALE, and
--    `post_sale` refuses a new sale of it.
--
--    The backfill hides exactly the rows that are unambiguous: an item priced
--    at zero that is either STOCKED or used as a recipe INGREDIENT. A zero
--    price on a stocked good or an ingredient is not a menu decision anybody
--    made; it is an item that was never meant to be sold. A zero-priced
--    service that is not an ingredient (a free side, "water on request")
--    stays visible, because that one may well be deliberate. Nothing else is
--    touched, and the owner can re-enable any row from Products.
--
-- 2. products.allow_negative_stock — THE OWNER'S NEGATIVE-STOCK POLICY.
--    Selling below zero used to be a per-DEVICE setting held in localStorage
--    and sent on every sale request, so any cashier could turn it on and the
--    backend believed the request. It is now a property of the ITEM, set by
--    the owner (`SaveProductCost`, owner-only), and `post_sale` and
--    `post_adjustment` read it from the database. Default 0: no item may go
--    below zero until the owner says so. A purchase received onto an empty or
--    negative pool takes the invoice rate as the new average
--    (`cost::purchase_weighted_avg`) instead of being refused.
--
-- 3. MANUAL COST ON A STOCKED ITEM — THE OWNER'S OVERRIDE.
--    Founder decision (V1.1): an owner-stated cost takes precedence over the
--    purchase average until the owner changes or removes it. Migrations 020
--    and 022 restricted `costing_method = 'standard'` to non-stock items; the
--    trigger pair is REPLACED below (DROP then CREATE, as 017 and 022 did
--    before it) so a stocked item may carry one. What that does and does not
--    mean, stated once:
--
--      * A SALE of the item is costed at the owner's figure. The sale's
--        `inventory_movements` row records that rate, so the movement says
--        exactly what the P&L was charged, and `cogs_source = 'standard'`
--        names where it came from.
--      * The SHELF is still valued by the weighted average of its purchases.
--        `avg_cost_*` keeps moving on every purchase as it always has, and it
--        is what an adjustment is valued at. The override moves no quantity
--        and rewrites no average.
--      * The difference between the two figures is NOT recognised anywhere:
--        Greaz has no cost-variance account. Removing the override returns the
--        item to the purchase average from its NEXT sale.
--      * Nothing posted is restated, ever.
--
--    Recipe costing stays restricted to non-stock items; nothing about it
--    changed.
--
-- 4. product_valuation_audit — WHO CHANGED A COST OR A STOCK POLICY.
--    Every change of an item's Manual Cost (set, changed, removed) and of its
--    negative-stock policy is written here by `save_product`, in the same
--    transaction, naming the owner. Append-only: no UPDATE, no DELETE, ever.
-- ============================================================================

ALTER TABLE products ADD COLUMN show_on_register INTEGER NOT NULL DEFAULT 1
  CHECK (show_on_register IN (0, 1));

ALTER TABLE products ADD COLUMN allow_negative_stock INTEGER NOT NULL DEFAULT 0
  CHECK (allow_negative_stock IN (0, 1));

-- Presentation-only backfill (see 1. above). `trg_products_updated_at` stamps
-- the rows, which is the truthful record that they were changed today.
UPDATE products
   SET show_on_register = 0
 WHERE price_incl_vat_cents = 0
   AND price_excl_vat_cents = 0
   AND (is_service = 0
        OR id IN (SELECT component_product_id FROM recipe_components));

CREATE TABLE IF NOT EXISTS product_valuation_audit (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT NOT NULL REFERENCES stores(id)   ON DELETE RESTRICT,
  product_id         TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  event              TEXT NOT NULL CHECK (event IN (
                       'manual_cost_set',
                       'manual_cost_removed',
                       'negative_stock_enabled',
                       'negative_stock_disabled')),

  -- The costing configuration either side of the change. Rates are per BASE
  -- unit, VAT-exclusive, in microcents; NULL is "no figure configured".
  previous_costing_method                TEXT,
  previous_standard_cost_excl_microcents INTEGER
    CHECK (previous_standard_cost_excl_microcents >= 0),
  new_costing_method                     TEXT,
  new_standard_cost_excl_microcents      INTEGER
    CHECK (new_standard_cost_excl_microcents >= 0),
  -- The purchase average and the stock on hand at the moment of the change,
  -- so an override can always be read against what it overrode.
  avg_cost_excl_microcents_at_change     INTEGER,
  quantity_on_hand_at_change             INTEGER,

  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK (event <> 'manual_cost_set' OR new_standard_cost_excl_microcents IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_product_valuation_audit_product
  ON product_valuation_audit (product_id, created_at);

-- Append-only, in every state.
CREATE TRIGGER IF NOT EXISTS trg_product_valuation_audit_no_update
BEFORE UPDATE ON product_valuation_audit
BEGIN
  SELECT RAISE(ABORT, 'product_valuation_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_valuation_audit_no_delete
BEFORE DELETE ON product_valuation_audit
BEGIN
  SELECT RAISE(ABORT, 'product_valuation_audit is append-only');
END;

-- An entry belongs to its product's own store, and is written by a user of
-- that store.
CREATE TRIGGER IF NOT EXISTS trg_product_valuation_audit_coherent
BEFORE INSERT ON product_valuation_audit
FOR EACH ROW
WHEN NOT EXISTS (
       SELECT 1 FROM products p
        WHERE p.id = NEW.product_id AND p.store_id = NEW.store_id)
  OR NOT EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = NEW.created_by_user_id AND u.store_id = NEW.store_id)
BEGIN
  SELECT RAISE(ABORT,
    'a valuation entry must name a product and a user of its own store');
END;

-- ----------------------------------------------------------------------------
-- The costing-coherence pair, REPLACED (see 3. above). Identical to migration
-- 022's except that Manual Cost no longer requires a non-stock item. DROP then
-- CREATE: a v24 database carries 022's version, and `IF NOT EXISTS` would keep
-- it.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_products_costing_coherence_ins;
DROP TRIGGER IF EXISTS trg_products_costing_coherence_upd;

CREATE TRIGGER trg_products_costing_coherence_ins
BEFORE INSERT ON products
FOR EACH ROW
WHEN NEW.costing_method <> 'purchase_average'
BEGIN
  SELECT RAISE(
    ABORT,
    'products: Manual Cost needs a cost. Enter a cost excluding VAT, or choose purchase valuation.'
  )
  WHERE NEW.costing_method = 'standard'
    AND NEW.standard_cost_excl_vat_microcents IS NULL;

  SELECT RAISE(
    ABORT,
    'products: Recipe costing applies to non-stock menu items only. A stocked product is valued from its purchases.'
  )
  WHERE NEW.costing_method = 'recipe'
    AND NEW.is_service <> 1;

  SELECT RAISE(
    ABORT,
    'products: Recipe costing needs a published recipe. Build and publish one for this item first.'
  )
  WHERE NEW.costing_method = 'recipe'
    AND NOT EXISTS (
      SELECT 1 FROM recipes r
       WHERE r.product_id = NEW.id
         AND r.store_id   = NEW.store_id
         AND r.status     = 'active'
    );
END;

CREATE TRIGGER trg_products_costing_coherence_upd
BEFORE UPDATE ON products
FOR EACH ROW
WHEN NEW.costing_method <> 'purchase_average'
BEGIN
  SELECT RAISE(
    ABORT,
    'products: Manual Cost needs a cost. Enter a cost excluding VAT, or choose purchase valuation.'
  )
  WHERE NEW.costing_method = 'standard'
    AND NEW.standard_cost_excl_vat_microcents IS NULL;

  SELECT RAISE(
    ABORT,
    'products: Recipe costing applies to non-stock menu items only. A stocked product is valued from its purchases.'
  )
  WHERE NEW.costing_method = 'recipe'
    AND NEW.is_service <> 1;

  SELECT RAISE(
    ABORT,
    'products: Recipe costing needs a published recipe. Build and publish one for this item first.'
  )
  WHERE NEW.costing_method = 'recipe'
    AND NOT EXISTS (
      SELECT 1 FROM recipes r
       WHERE r.product_id = NEW.id
         AND r.store_id   = NEW.store_id
         AND r.status     = 'active'
    );
END;
