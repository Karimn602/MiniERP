-- ============================================================================
-- Migration v21 — INGREDIENT RECIPE DEFINITIONS (WP-B2-A)
-- ----------------------------------------------------------------------------
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT
--
-- Two new tables: `recipes` (a versioned header per product) and
-- `recipe_components` (its ingredient lines). Nothing else. No column is added
-- to `products`, because migration 020 already put `'recipe'` in
-- `products.costing_method`'s CHECK for exactly this reason, and no column is
-- added to `sale_items`, because this migration does not touch sale posting.
--
-- **`costing_method = 'recipe'` IS STILL REFUSED.** 020's
-- `trg_products_costing_coherence_{ins,upd}` pair is left standing, untouched.
-- A recipe can be authored, costed in preview, versioned and activated by this
-- migration, and no product can select it as its sales costing method. That is
-- the WP-B2-A boundary and it is what makes this step unable to misstate a
-- single posted figure: `post_sale` is not modified, reads nothing here, and
-- cannot reach either table. WP-B2-B replaces that trigger pair — DROP then
-- CREATE, the way 017 replaced 016's weak shift guard — in the same migration
-- that teaches `post_sale` to honour a recipe.
--
-- No ingredient stock moves. There is no `consumes_stock` column here at all:
-- a column with no reader is a promise the engine has not made. Ingredient
-- consumption is WP-B3, and it arrives with its own command, its own movement
-- rows and its own return semantics.
--
--
-- WHY A RECIPE QUANTITY IS A FRACTION
--
-- `sale_items.quantity`, `inventory_movements.quantity_delta` and
-- `products.quantity_on_hand` are INTEGER, and `lib/uom.ts::parseQuantityInput`
-- REFUSES a typed decimal that does not land on a whole base unit. That is
-- right for a sale: half a box of twelve is not a thing you can hand over.
--
-- A recipe cannot live under that rule. "150 g of beef" is fine when the base
-- unit is the gram, but "half a bun" is not expressible as an integer count of
-- buns at all, and rounding it to 0 or 1 would be a costing error of 100% on
-- that line. So a component quantity is stored as an exact reduced fraction,
-- `quantity_num / quantity_den`, in the component's own unit.
--
-- This is safe in B2 for one specific reason, and the reason must be stated
-- because B3 cannot borrow it: **in B2 a recipe quantity is only ever a
-- multiplier on a cost RATE.** It is never a quantity of anything that moves.
-- No `inventory_movements` row is written from a recipe, so no fractional base
-- quantity ever has to be reconciled against an integer column. When WP-B3
-- consumes ingredients it will have to decide what half a bun does to an
-- integer `quantity_on_hand` — a consumption-rounding policy, with a residual
-- somewhere — and that decision is NOT made here and is not implied by
-- anything in this migration. FRACTIONAL RECIPE QUANTITIES ARE COSTING-ONLY
-- IN B2.
--
-- A fraction rather than a scaled decimal because it is exact for 1/3 as well
-- as for 0.125, and because it is the convention this schema already uses for
-- precisely this job: `product_uoms.factor_num / factor_den`.
--
--
-- WHY THE CONVERSION IS SNAPSHOTTED ONTO THE COMPONENT
--
-- This is the subtle one. A component names a unit — "1 box" — and what a box
-- IS lives in `product_uoms.factor_num/factor_den` on the ingredient. That row
-- is MUTABLE: `catalog.rs::save_product_tx` runs
-- `UPDATE product_uoms SET factor_num = ?, factor_den = ?` on a product's
-- selling unit whenever the owner edits the product. So a shop that changes
-- "1 box = 12 pcs" to "1 box = 24 pcs" would silently double the physical
-- quantity of every published recipe that said "1 box", and double its cost,
-- with no edit to the recipe and no record that anything happened.
--
-- A published recipe is therefore a snapshot of its own physical quantities.
-- `product_uom_id_snapshot`, `factor_num_snapshot` and `factor_den_snapshot`
-- are NOT NULL and are resolved from the database at save time, never taken
-- from the client — the same rule `post_sale` and `post_purchase` follow for a
-- sale or purchase line. Once the parent recipe leaves `draft` those columns
-- can never change (`trg_recipe_components_frozen_upd`), so an edited factor
-- changes what the NEXT draft snapshots and nothing that is already published.
--
-- The factor is snapshotted AND `product_uom_id_snapshot` carries a real
-- foreign key with ON DELETE RESTRICT, so the row the snapshot came from
-- cannot be deleted out from under it either.
--
-- A blocking trigger on `product_uoms` was considered and rejected: refusing
-- to edit a factor while an active recipe references it would deadlock the
-- owner (they cannot change the factor until they re-version the recipe, and
-- re-versioning would re-snapshot the factor they are trying to change). The
-- snapshot already makes the recipe immune, so the remaining problem is only
-- that the recipe and the catalogue can disagree — which is DRIFT, and drift
-- that is visible is a decision the owner can make. `recipesRepo` surfaces it
-- and the editor shows it per line; nothing is silently restated either way.
--
--
-- NO HISTORICAL MIGRATION IS CHANGED, and nothing here applies to any row that
-- already exists: both tables are new and empty. Every trigger is BEFORE
-- INSERT or BEFORE UPDATE/DELETE on those new tables alone.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. RECIPES — one versioned header per product
--
--    The lifecycle is three states and the timestamps ARE the state:
--
--      draft    activated_at IS NULL      retired_at IS NULL
--      active   activated_at IS NOT NULL  retired_at IS NULL
--      retired  activated_at IS NOT NULL  retired_at IS NOT NULL
--
--    So `retired` preserves its activation history: retiring a version records
--    when it stopped being authoritative WITHOUT erasing when it started. A
--    recipe that was never activated cannot be retired at all — there is no
--    such thing as retiring something that never published, and the CHECK
--    forbids expressing it. That is enforced here as a table CHECK rather than
--    in application code, because it is the one invariant every reader of a
--    historical recipe depends on.
--
--    `yield_quantity_base` is what one batch produces, in the RECIPE PRODUCT's
--    own base unit, and is what makes a sauce expressible: "this batch fills 20
--    portions" means the per-portion cost is the batch cost divided by 20, in
--    one division, rounded once.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id                    TEXT PRIMARY KEY,
  store_id              TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id            TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  version               INTEGER NOT NULL CHECK (version >= 1),

  -- Bounded at 1,000,000 so the cost arithmetic's overflow proof holds; see
  -- `src-tauri/src/recipe_cost.rs`, which states the admissible envelope and
  -- refuses anything outside it before multiplying.
  yield_quantity_base   INTEGER NOT NULL
                        CHECK (yield_quantity_base >= 1
                               AND yield_quantity_base <= 1000000),

  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'retired')),

  activated_at          TEXT,
  retired_at            TEXT,
  notes                 TEXT,

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- The lifecycle table above, as one constraint per state.
  CHECK (status <> 'draft'   OR (activated_at IS NULL     AND retired_at IS NULL)),
  CHECK (status <> 'active'  OR (activated_at IS NOT NULL AND retired_at IS NULL)),
  CHECK (status <> 'retired' OR (activated_at IS NOT NULL AND retired_at IS NOT NULL)),

  -- A version cannot stop being authoritative before it started. Both columns
  -- hold the project's canonical timestamp (`%Y-%m-%dT%H:%M:%S%.3fZ`, UTC,
  -- fixed width), so lexicographic order IS chronological order and a string
  -- comparison is the right one.
  CHECK (retired_at IS NULL OR activated_at IS NULL OR retired_at >= activated_at)
);

-- A product's versions are numbered, once each.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recipes_product_version
  ON recipes (product_id, version);

-- ONE active version per product. The same mechanism
-- `ux_shifts_one_open_per_store` uses: the engine decides it, not a convention,
-- so "activate v2 and retire v1" has no outcome in which both are active.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recipes_one_active
  ON recipes (product_id) WHERE status = 'active';

-- ONE draft per product, so "edit the recipe" cannot accumulate rival drafts
-- and leave the editor asking which one the owner meant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recipes_one_draft
  ON recipes (product_id) WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_recipes_store_status
  ON recipes (store_id, status);


-- ----------------------------------------------------------------------------
-- 2. RECIPE COMPONENTS — the ingredient lines
--
--    `quantity_num / quantity_den` is the quantity as the chef states it, in
--    `uom_code`, stored reduced (the command divides by the gcd) so two
--    spellings of one quantity compare equal.
--
--    `factor_*_snapshot` is what that unit MEANT when the recipe was saved —
--    see the header. `product_uom_id_snapshot` is the row it came from, with a
--    restricting foreign key.
--
--    `waste_bps` is trim or spoilage in basis points: 500 means 5% more is
--    consumed than reaches the plate. It is a separate column rather than
--    folded into the quantity so the recipe still reads as the recipe when a
--    chef checks it — which is the whole reason a recipe is worth having.
--
--    Every numeric bound here is half of the overflow proof in
--    `recipe_cost.rs`; the other half is the resolved ingredient rate, which
--    the command bounds because no CHECK here can see it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipe_components (
  id                       TEXT PRIMARY KEY,
  recipe_id                TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  component_product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  quantity_num             INTEGER NOT NULL
                           CHECK (quantity_num >= 1 AND quantity_num <= 1000000),
  quantity_den             INTEGER NOT NULL
                           CHECK (quantity_den >= 1 AND quantity_den <= 1000000),

  uom_code                 TEXT NOT NULL REFERENCES units_of_measure(code) ON DELETE RESTRICT,

  -- The immutable conversion snapshot (see the header).
  product_uom_id_snapshot  TEXT NOT NULL REFERENCES product_uoms(id) ON DELETE RESTRICT,
  factor_num_snapshot      INTEGER NOT NULL
                           CHECK (factor_num_snapshot >= 1
                                  AND factor_num_snapshot <= 1000000),
  factor_den_snapshot      INTEGER NOT NULL
                           CHECK (factor_den_snapshot >= 1
                                  AND factor_den_snapshot <= 1000000),

  waste_bps                INTEGER NOT NULL DEFAULT 0
                           CHECK (waste_bps >= 0 AND waste_bps < 10000),

  sort_order               INTEGER NOT NULL DEFAULT 0,

  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- One line per ingredient. Two lines of beef is a quantity, not two lines —
  -- and two lines would make "how much beef is in this?" a query rather than a
  -- reading.
  UNIQUE (recipe_id, component_product_id)
);

CREATE INDEX IF NOT EXISTS idx_recipe_components_recipe
  ON recipe_components (recipe_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_recipe_components_product
  ON recipe_components (component_product_id);


-- ----------------------------------------------------------------------------
-- 3. A RECIPE HEADER'S IDENTITY IS IMMUTABLE FROM CREATION
--
--    NOT from publication. The first version of this migration protected the
--    header's identity only once `status <> 'draft'`, which left a draft
--    re-pointable at another product or another STORE by direct SQL — and
--    `activate_recipe` would then publish it, read a cost pool from a branch
--    the recipe has no claim on, and retire that branch's incumbent. A draft
--    is a document in progress, not a scratch row: what it is FOR is decided
--    when it is created, and only its contents are drafted.
--
--    So `id`, `store_id`, `product_id` and `version` can never change, in any
--    state. `yield_quantity_base`, `notes` and `created_at` are editable while
--    the row is a draft and frozen afterwards (rule 3b), because the yield and
--    the notes ARE the draft's contents.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipes_identity_immutable
BEFORE UPDATE ON recipes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'recipes: a recipe''s identity, store, product and version are fixed when it is created and can never be changed \u2014 not even on a draft. Create a new recipe for a different item.')
  WHERE NEW.id         <> OLD.id
     OR NEW.store_id   <> OLD.store_id
     OR NEW.product_id <> OLD.product_id
     OR NEW.version    <> OLD.version;
END;


-- ----------------------------------------------------------------------------
-- 3a. A RECIPE BELONGS TO ITS PRODUCT'S STORE
--
--    Checked on INSERT **and** UPDATE. `recipes.store_id` is a column a writer
--    supplies, and a header whose store disagrees with its own product's store
--    is the corruption P1-B turns into a cross-store activation: every
--    ingredient lookup, cost pool and incumbent query downstream is scoped by
--    one of the two, and they have to be the same one.
--
--    The UPDATE arm is redundant while rule 3 holds \u2014 neither column can
--    change \u2014 and it is written anyway, because a guard that depends on
--    another guard is a guard that disappears when the other one is relaxed.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipes_store_matches_product_ins
BEFORE INSERT ON recipes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'recipes: a recipe must belong to the same store as the item it makes.')
  WHERE NEW.store_id <> (SELECT store_id FROM products WHERE id = NEW.product_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_recipes_store_matches_product_upd
BEFORE UPDATE ON recipes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'recipes: a recipe must belong to the same store as the item it makes.')
  WHERE NEW.store_id <> (SELECT store_id FROM products WHERE id = NEW.product_id);
END;


-- ----------------------------------------------------------------------------
-- 3b. A PUBLISHED RECIPE IS IMMUTABLE, AND THE LIFECYCLE IS THREE STATES
--
--    Editing an active recipe creates version + 1 as a draft; it never edits
--    the published one. So the only UPDATE a non-draft header may take is the
--    lifecycle transition itself, and the only legal transitions are:
--
--      draft   -> active    (activate)
--      active  -> retired   (retire, or superseded by a new activation)
--
--    Everything else is refused by name: no draft -> retired (nothing was
--    published), no active -> draft and no retired -> anything (a published
--    version does not come back; publish a new one), and no change to the
--    yield, the notes or the creation time of a header that has been
--    activated. `notes` and `created_at` are covered because a published
--    recipe is a document: the note explaining WHY a plate is built this way
--    is part of what was published, and a creation time that can be moved is
--    not a creation time.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipes_lifecycle
BEFORE UPDATE ON recipes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'recipes: a published recipe version''s yield, notes and creation time are part of what was published. Create a new version instead.')
  WHERE OLD.status <> 'draft'
    AND (NEW.yield_quantity_base <> OLD.yield_quantity_base
         OR COALESCE(NEW.notes, '') <> COALESCE(OLD.notes, '')
         OR NEW.created_at <> OLD.created_at);

  SELECT RAISE(ABORT, 'recipes: a recipe that was never activated cannot be retired. Delete the draft or activate it first.')
  WHERE OLD.status = 'draft' AND NEW.status = 'retired';

  SELECT RAISE(ABORT, 'recipes: a published recipe version cannot return to draft. Create a new version instead.')
  WHERE OLD.status <> 'draft' AND NEW.status = 'draft';

  SELECT RAISE(ABORT, 'recipes: a retired recipe version cannot be activated again. Create a new version instead.')
  WHERE OLD.status = 'retired' AND NEW.status <> 'retired';

  SELECT RAISE(ABORT, 'recipes: an activation timestamp is written once and never moved \u2014 it is when this version became authoritative.')
  WHERE OLD.activated_at IS NOT NULL
    AND (NEW.activated_at IS NULL OR NEW.activated_at <> OLD.activated_at);

  SELECT RAISE(ABORT, 'recipes: a retirement timestamp is written once and never moved.')
  WHERE OLD.retired_at IS NOT NULL
    AND (NEW.retired_at IS NULL OR NEW.retired_at <> OLD.retired_at);
END;

-- A deleted recipe makes a posted sale unexplainable once WP-B2-B snapshots
-- `cogs_recipe_id` onto a line, and a deleted DRAFT is a convenience worth
-- having before then. So a draft may be deleted and a published version may
-- not, which is the same shape as every other document family here.
CREATE TRIGGER IF NOT EXISTS trg_recipes_no_delete_published
BEFORE DELETE ON recipes
FOR EACH ROW
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'recipes: a published recipe version is never deleted. Retire it instead \u2014 a deleted recipe makes the sales it costed unexplainable.');
END;


-- ----------------------------------------------------------------------------
-- 4. A PUBLISHED RECIPE'S LINES ARE IMMUTABLE
--
--    Keyed on the PARENT's status, which is why the status lives on the header
--    and not on the line. INSERT is guarded as well as UPDATE and DELETE,
--    because adding a child to a published document edits no existing row and
--    so slips past an update guard — migration 011's lesson, learned there on
--    credit-memo lines.
--
--    Reparenting is refused outright, in both directions, exactly as
--    migration 012's child guards test `id IN (OLD.parent_id, NEW.parent_id)`:
--    `recipe_id` is an ordinary updatable column, and a one-sided check would
--    let a line be moved out of a draft and into something published.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipe_components_insert_draft_only
BEFORE INSERT ON recipe_components
FOR EACH ROW
WHEN (SELECT status FROM recipes WHERE id = NEW.recipe_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'recipe_components: a published recipe version takes no new ingredient. Create a new version instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_recipe_components_frozen_upd
BEFORE UPDATE ON recipe_components
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM recipes
              WHERE id IN (OLD.recipe_id, NEW.recipe_id)
                AND status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'recipe_components: a published recipe version''s ingredients, quantities and conversions are frozen. Create a new version instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_recipe_components_frozen_del
BEFORE DELETE ON recipe_components
FOR EACH ROW
WHEN (SELECT status FROM recipes WHERE id = OLD.recipe_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'recipe_components: a published recipe version''s ingredients cannot be removed. Create a new version instead.');
END;


-- ----------------------------------------------------------------------------
-- 5. COHERENCE: STORE, ELIGIBILITY, AND THE UNIT — ON INSERT **AND** UPDATE
--
--    Six rules. The first version of this migration applied them on INSERT
--    only, on the reasoning that a published line can never be updated anyway
--    and a draft line is rewritten wholesale rather than patched. That
--    reasoning described the COMMAND, not the DATABASE. A draft component
--    could be updated directly:
--
--      UPDATE recipe_components SET factor_num_snapshot = 1000000 WHERE ...;
--
--    and `activate_recipe` would publish the inflated cost, because the
--    snapshot is exactly what it trusts. A trigger that holds only for the one
--    writer that does not need it is not a guard.
--
--    So the body below exists twice, once per operation, and the two are
--    generated from one source in the migration's own tooling so they cannot
--    drift apart. Anything that mutates a component of a PUBLISHED recipe is
--    still refused outright by rule 4, which fires alongside this one; this
--    rule is what keeps a DRAFT coherent while it is legitimately edited.
--
--      a. ONE STORE. The component, the recipe and the recipe's own product
--         all belong to the same store. A branch's recipe costed from another
--         branch's ingredient would read a cost pool it has no claim on.
--      b. NO SELF-REFERENCE.
--      c. ONE LEVEL OF COMPOSITION. A component may not itself be
--         recipe-costed, and may not own a recipe of its own in any state.
--         This is the cycle prevention, and it works by making a cycle
--         INEXPRESSIBLE rather than detectable: with one level there is no
--         recursive walk to write, no depth limit to choose and no
--         A-contains-B-contains-A to find. Sub-recipes are a later work
--         package and will bring their own cycle detection with them.
--      d. ACTIVE INGREDIENT. An inactive product is not sellable and is not
--         buildable-with either.
--      e. THE UNIT IS THE COMPONENT'S OWN, AND THE SNAPSHOT IS THAT UNIT'S.
--         `(component, store, uom_code)` must name an ACTIVE `product_uoms`
--         row, and `factor_*_snapshot` must be the factor OF THAT ROW. The
--         database decides the conversion; a recipe cannot invent a unit for
--         somebody else's product, and cannot declare a factor that row does
--         not have. Same rule as GP-A02 on a sale line.
--      f. The numeric bounds are the table's own CHECK constraints, which
--         SQLite applies to an UPDATE exactly as to an INSERT, so the quantity
--         fraction, the conversion parts and the waste are already covered on
--         both operations and are not restated here.
--
--    NOTE ON RULE (e) AND A PUBLISHED RECIPE: this trigger can never fire for
--    one, because rule 4 refuses the UPDATE first. A published recipe's frozen
--    conversion is therefore never re-validated and never rewritten, which is
--    the whole point of it being frozen — even when the ingredient's unit has
--    since been redefined.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipe_components_coherence_ins
BEFORE INSERT ON recipe_components
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'recipe_components: the ingredient, the recipe and the recipe''s product must all belong to one store.')
  WHERE NEW.store_id <> (SELECT store_id FROM recipes WHERE id = NEW.recipe_id)
     OR NEW.store_id <> (SELECT store_id FROM products WHERE id = NEW.component_product_id)
     OR NEW.store_id <> (SELECT p.store_id FROM products p
                           JOIN recipes r ON r.product_id = p.id
                          WHERE r.id = NEW.recipe_id);

  SELECT RAISE(ABORT, 'recipe_components: a recipe cannot contain the product it makes.')
  WHERE NEW.component_product_id = (SELECT product_id FROM recipes WHERE id = NEW.recipe_id);

  SELECT RAISE(ABORT, 'recipe_components: an ingredient cannot itself be recipe-costed. Greaz supports one level of composition.')
  WHERE (SELECT costing_method FROM products WHERE id = NEW.component_product_id) = 'recipe';

  SELECT RAISE(ABORT, 'recipe_components: an ingredient cannot have a recipe of its own. Greaz supports one level of composition.')
  WHERE EXISTS (SELECT 1 FROM recipes WHERE product_id = NEW.component_product_id);

  SELECT RAISE(ABORT, 'recipe_components: an inactive product cannot be an ingredient.')
  WHERE (SELECT is_active FROM products WHERE id = NEW.component_product_id) <> 1;

  SELECT RAISE(ABORT, 'recipe_components: the unit must be one the ingredient actually has, and the stored conversion must be that unit''s own.')
  WHERE NOT EXISTS (
    SELECT 1 FROM product_uoms u
     WHERE u.id         = NEW.product_uom_id_snapshot
       AND u.product_id = NEW.component_product_id
       AND u.store_id   = NEW.store_id
       AND u.uom_code   = NEW.uom_code
       AND u.is_active  = 1
       AND u.factor_num = NEW.factor_num_snapshot
       AND u.factor_den = NEW.factor_den_snapshot
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_recipe_components_coherence_upd
BEFORE UPDATE ON recipe_components
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'recipe_components: the ingredient, the recipe and the recipe''s product must all belong to one store.')
  WHERE NEW.store_id <> (SELECT store_id FROM recipes WHERE id = NEW.recipe_id)
     OR NEW.store_id <> (SELECT store_id FROM products WHERE id = NEW.component_product_id)
     OR NEW.store_id <> (SELECT p.store_id FROM products p
                           JOIN recipes r ON r.product_id = p.id
                          WHERE r.id = NEW.recipe_id);

  SELECT RAISE(ABORT, 'recipe_components: a recipe cannot contain the product it makes.')
  WHERE NEW.component_product_id = (SELECT product_id FROM recipes WHERE id = NEW.recipe_id);

  SELECT RAISE(ABORT, 'recipe_components: an ingredient cannot itself be recipe-costed. Greaz supports one level of composition.')
  WHERE (SELECT costing_method FROM products WHERE id = NEW.component_product_id) = 'recipe';

  SELECT RAISE(ABORT, 'recipe_components: an ingredient cannot have a recipe of its own. Greaz supports one level of composition.')
  WHERE EXISTS (SELECT 1 FROM recipes WHERE product_id = NEW.component_product_id);

  SELECT RAISE(ABORT, 'recipe_components: an inactive product cannot be an ingredient.')
  WHERE (SELECT is_active FROM products WHERE id = NEW.component_product_id) <> 1;

  SELECT RAISE(ABORT, 'recipe_components: the unit must be one the ingredient actually has, and the stored conversion must be that unit''s own.')
  WHERE NOT EXISTS (
    SELECT 1 FROM product_uoms u
     WHERE u.id         = NEW.product_uom_id_snapshot
       AND u.product_id = NEW.component_product_id
       AND u.store_id   = NEW.store_id
       AND u.uom_code   = NEW.uom_code
       AND u.is_active  = 1
       AND u.factor_num = NEW.factor_num_snapshot
       AND u.factor_den = NEW.factor_den_snapshot
  );
END;

-- A component never changes parent. Rule 4 already refuses it whenever either
-- side is published; forbidding it outright costs nothing (production
-- reparents nothing) and means the coherence rules above never have to be
-- re-proved against a parent they were not written for — the same decision
-- migration 011 took for credit-memo lines.
CREATE TRIGGER IF NOT EXISTS trg_recipe_components_no_reparent
BEFORE UPDATE ON recipe_components
FOR EACH ROW
WHEN NEW.recipe_id <> OLD.recipe_id
BEGIN
  SELECT RAISE(ABORT, 'recipe_components: an ingredient line stays with the recipe it was added to. Add it to the other recipe instead.');
END;


-- ----------------------------------------------------------------------------
-- 6. THE OTHER HALF OF THE ONE-LEVEL GUARD
--
--    Rule 5c refuses a recipe-costed product as an ingredient. The reverse
--    direction has to be refused too, or the same two-level chain is reachable
--    by doing it in the other order: add flour as an ingredient of the burger,
--    then give flour a recipe.
--
--    A product that is an ingredient of ANY recipe — draft, active or retired
--    — may not acquire a recipe of its own. Retired counts on purpose: a
--    retired version is history, a WP-B2-B sale line will name it, and "this
--    was built from flour" must keep meaning what it meant.
--
--    On UPDATE as well as INSERT. `product_id` is immutable from creation
--    (rule 3), so the UPDATE arm cannot fire today; it is written for the same
--    reason rule 3a's is — a guard that depends on another guard disappears
--    when that one is relaxed.
--
--    `costing_method = 'recipe'` is still refused outright by 020's trigger
--    pair, so this guard is about the RECIPE, not the method. WP-B2-B adds the
--    method half when it relaxes 020.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipes_product_is_not_an_ingredient_ins
BEFORE INSERT ON recipes
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM recipe_components
              WHERE component_product_id = NEW.product_id)
BEGIN
  SELECT RAISE(ABORT, 'recipes: this product is an ingredient of another recipe, so it cannot have a recipe of its own. Greaz supports one level of composition.');
END;

CREATE TRIGGER IF NOT EXISTS trg_recipes_product_is_not_an_ingredient_upd
BEFORE UPDATE ON recipes
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM recipe_components
              WHERE component_product_id = NEW.product_id)
BEGIN
  SELECT RAISE(ABORT, 'recipes: this product is an ingredient of another recipe, so it cannot have a recipe of its own. Greaz supports one level of composition.');
END;


-- ----------------------------------------------------------------------------
-- 7. updated_at, by the convention every other table here uses
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_recipes_updated_at
AFTER UPDATE ON recipes
FOR EACH ROW
BEGIN
  UPDATE recipes
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;
