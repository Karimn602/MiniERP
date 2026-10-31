-- ============================================================================
-- Migration v22 — RECIPE-DERIVED SALE COSTING (WP-B2-B)
-- ----------------------------------------------------------------------------
-- WHAT THIS ADDS
--
-- B2-A could author, cost, version and publish a recipe, and no product could
-- select it: 020's `trg_products_costing_coherence_{ins,upd}` pair refused
-- `costing_method = 'recipe'` outright, and `post_sale` read neither recipe
-- table. This migration is the other half. It
--
--   1. REPLACES that trigger pair — DROP then CREATE, the way 017 replaced
--      016's weak shift guard, because a v21 database already carries the
--      refusing version and `IF NOT EXISTS` would keep it — so `'recipe'` is
--      admitted under conditions rather than refused;
--   2. gives `sale_items` the recipe IDENTITY and VERSION the line was costed
--      from, beside the `cogs_source` 020 added; and
--   3. adds `sale_item_recipe_costs`, the per-component evidence that explains
--      a posted recipe COGS rate for as long as the receipt exists.
--
-- It is additive. No posted row is rewritten, no column is dropped, no CHECK on
-- an existing column is widened, and every sale that existed under v21 reads
-- back byte for byte: its new columns are NULL, which is the truth about it —
-- it was posted before recipes could cost anything.
--
-- STILL NOT HERE, DELIBERATELY: ingredient stock consumption. No ingredient
-- `inventory_movements` row is written by anything this migration enables, and
-- there is still no `consumes_stock` column. Recipe COGS in B2-B is an
-- ESTIMATED ingredient-based food cost — what the plate's ingredients cost at
-- the rates on file — and it is not proof that any ingredient was depleted.
-- WP-B3 is where consumption arrives, with its own command, its own movement
-- rows and its own return semantics, and it will have to decide what half a bun
-- does to an integer `quantity_on_hand`. Nothing here makes or implies that
-- decision.
--
--
-- WHY RECIPE COSTING IS RESTRICTED TO NON-STOCK ITEMS
--
-- The same financial argument WP-B1 made for Manual Cost, unchanged. For a
-- STOCKED product the COGS rate is not merely a reporting figure: it is written
-- onto the sale's `inventory_movements` row, and that ledger is what makes
-- stock auditable, because `quantity_on_hand` and `avg_cost_*` are maintained
-- together so the quantity and the value of the shelf agree. A recipe-derived
-- rate there would say the goods left at one price while the pool they left
-- from says another, and `inventory_movements` is append-only, so nothing could
-- ever unwind it. A service line writes no movement, decrements no stock and
-- touches no pool, so there is no second figure to contradict. A restaurant's
-- prepared items ARE the service case.
--
--
-- WHY THE PRODUCT MUST HAVE AN ACTIVE RECIPE, IN THE ENGINE
--
-- `costing_method = 'recipe'` with no published recipe is a product that cannot
-- be sold: `post_sale` would have nothing to cost it from and would refuse at
-- the till, in front of a customer, for a configuration mistake made days
-- earlier on a different screen. The trigger moves that refusal to the moment
-- the mistake is made. B2-A's `retire_recipe` already refuses to retire the
-- active version while the product is recipe-costed, so the two guards close
-- the loop from both ends and there is no reachable state in which a
-- recipe-costed product has no recipe.
--
--
-- WHY THE EVIDENCE IS A TABLE AND NOT A JSON COLUMN
--
-- A posted recipe COGS rate is one number standing for up to 64 decisions —
-- which ingredients, how much of each, at what conversion, with what waste, at
-- what rate, from which basis — and every one of them is mutable afterwards:
-- a rate moves with the next purchase, a factor moves when the owner edits a
-- unit, a recipe moves when version 2 is published. Without the breakdown
-- frozen beside the receipt, "why did this burger cost $1.90 in March?" has no
-- answer that today's database can give, and a gross-profit figure nobody can
-- explain is a gross-profit figure nobody should trust. Rows rather than a blob
-- because this is the project's convention for document children — sealed by
-- triggers, scoped by store, joined by reporting — and because a blob is a
-- schema nothing validates.
--
-- The evidence records the INGREDIENT RATES AS RESOLVED AT POST TIME and the
-- PHYSICAL QUANTITIES AS FROZEN BY THE PUBLISHED RECIPE VERSION. Those are two
-- different ages on purpose, and it is the same split B2-A established: what a
-- thing costs is forward-only and follows the purchase history, while what the
-- plate is made of was fixed when the version was published.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. `sale_items` remembers WHICH recipe, and WHICH VERSION, costed the line.
--
--    `cogs_source = 'recipe'` says the rate came from a recipe; these say from
--    WHICH, and that is what makes a posted cost explainable after version 2 is
--    published and version 1 retired. Both are NULL for every line posted
--    before this migration, and for every line not costed from a recipe.
--
--    `recipe_version` is DENORMALISED on purpose. `recipes.version` is
--    immutable (021's `trg_recipes_identity_immutable`), so the join would
--    return the same figure — but the column states the answer without one,
--    and a reader of a five-year-old receipt should not have to join a table
--    that a future migration may reshape. The FK keeps the identity honest.
--
--    No CHECK ties these to `cogs_source` here: a cross-column rule on
--    `sale_items` belongs in a trigger (the pattern 020 used on `products`),
--    and `trg_sale_items_recipe_coherence` below is that trigger.
-- ----------------------------------------------------------------------------

ALTER TABLE sale_items ADD COLUMN recipe_id TEXT
  REFERENCES recipes(id) ON DELETE RESTRICT;

ALTER TABLE sale_items ADD COLUMN recipe_version INTEGER
  CHECK (recipe_version IS NULL OR recipe_version >= 1);


-- ----------------------------------------------------------------------------
-- 2. The per-component evidence for one posted recipe-costed line.
--
--    One row per ingredient of the recipe version, per sale line. Every
--    physical figure is the PUBLISHED VERSION'S OWN SNAPSHOT, copied forward so
--    that editing a unit, retiring a version or deleting a draft can never
--    change what a posted receipt says it cost.
--
--    The bounds mirror `recipe_components` and `recipe_cost.rs`'s admissible
--    envelope exactly, because these rows hold the same numbers; a row outside
--    them could not have been produced by the arithmetic that is proven not to
--    overflow.
--
--    `cost_source` is the INGREDIENT's basis and has two values, not five: an
--    ingredient may not itself be recipe-costed (one level of composition), a
--    recipe never consults the till's `cogs_method`, and an ingredient with no
--    basis at all refuses the sale rather than posting an `uncosted` component.
--    So `'standard'` and `'purchase_average'` are the whole domain, and a zero
--    under `purchase_average` is a DOCUMENTED zero — a free case, a sample, an
--    opening count valued at nothing — because the undocumented one never gets
--    this far.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sale_item_recipe_costs (
  id                           TEXT PRIMARY KEY,

  sale_id                      TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  sale_item_id                 TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  store_id                     TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  recipe_id                    TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  recipe_version               INTEGER NOT NULL CHECK (recipe_version >= 1),

  component_product_id         TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- The ingredient's name AS IT WAS. A product can be renamed; the receipt's
  -- explanation should go on naming what the kitchen was told it used, exactly
  -- as `sale_items.product_name_snapshot` does one level up.
  component_name_snapshot      TEXT NOT NULL,

  uom_code                     TEXT NOT NULL REFERENCES units_of_measure(code) ON DELETE RESTRICT,

  quantity_num                 INTEGER NOT NULL
                               CHECK (quantity_num >= 1 AND quantity_num <= 1000000),
  quantity_den                 INTEGER NOT NULL
                               CHECK (quantity_den >= 1 AND quantity_den <= 1000000),

  factor_num_snapshot          INTEGER NOT NULL
                               CHECK (factor_num_snapshot >= 1
                                      AND factor_num_snapshot <= 1000000),
  factor_den_snapshot          INTEGER NOT NULL
                               CHECK (factor_den_snapshot >= 1
                                      AND factor_den_snapshot <= 1000000),

  waste_bps                    INTEGER NOT NULL DEFAULT 0
                               CHECK (waste_bps >= 0 AND waste_bps < 10000),

  -- The ingredient's rate AS RESOLVED AT POST TIME, per base unit of the
  -- ingredient, excluding VAT, in microcents. Bounded as `recipe_cost.rs`
  -- bounds it. `>= 0` because a negative cost is not a thing a document states.
  unit_cost_excl_vat_microcents INTEGER NOT NULL
                               CHECK (unit_cost_excl_vat_microcents >= 0
                                      AND unit_cost_excl_vat_microcents <= 10000000000000),

  cost_source                  TEXT NOT NULL
                               CHECK (cost_source IN ('purchase_average', 'standard')),

  -- What this ingredient contributed to ONE BATCH, in microcents. DISPLAY, and
  -- the project says so in the same words `recipe_cost.rs` does: the batch is
  -- summed at accumulator scale and divided once, so summing these would
  -- reintroduce the per-component rounding the accumulator exists to avoid.
  -- Nothing derives a total from this column.
  contribution_microcents      INTEGER NOT NULL CHECK (contribution_microcents >= 0),

  sort_order                   INTEGER NOT NULL DEFAULT 0,

  created_at                   TEXT NOT NULL
                               DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- One row per ingredient per sale line, which is `recipe_components`'
  -- `UNIQUE (recipe_id, component_product_id)` carried forward: a replay that
  -- somehow re-ran the evidence write would collide rather than double it.
  UNIQUE (sale_item_id, component_product_id)
);

CREATE INDEX IF NOT EXISTS ix_sale_item_recipe_costs_item
  ON sale_item_recipe_costs(sale_item_id);
CREATE INDEX IF NOT EXISTS ix_sale_item_recipe_costs_sale
  ON sale_item_recipe_costs(sale_id, store_id);
CREATE INDEX IF NOT EXISTS ix_sale_item_recipe_costs_recipe
  ON sale_item_recipe_costs(recipe_id, recipe_version);


-- ----------------------------------------------------------------------------
-- 3. The evidence is sealed the way every other document child is (012).
--
--    Harder, in fact: there is no UPDATE at all and no DELETE at all, in any
--    state. `sale_items` permits neither after its sale posts, and the only
--    writer of these rows builds them inside the same transaction that builds
--    the sale and never revisits one. A row here explains an immutable figure
--    on an immutable line; nothing legitimate ever edits it, so forbidding it
--    outright costs nothing and is cheaper than reasoning about when it would
--    be safe.
--
--    INSERT is guarded on the PARENT SALE'S `posted_at`, which is why
--    `post_sale` builds a draft and promotes it last — the WP-07 ordering these
--    guards already depend on.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_sale_item_recipe_costs_no_insert_after_post
BEFORE INSERT ON sale_item_recipe_costs
WHEN (SELECT posted_at FROM sales WHERE id = NEW.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted sale cannot take further recipe-cost evidence.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_item_recipe_costs_no_update
BEFORE UPDATE ON sale_item_recipe_costs
BEGIN
  SELECT RAISE(ABORT, 'Recipe-cost evidence is immutable. It explains a posted cost and is never edited.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_item_recipe_costs_no_delete
BEFORE DELETE ON sale_item_recipe_costs
BEGIN
  SELECT RAISE(ABORT, 'Recipe-cost evidence is append-only. It explains a posted cost and is never deleted.');
END;


-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- 4. Evidence must describe the line it is attached to, AND agree with the
--    published recipe it cites.
--
--    The FKs prove the rows exist; these prove they belong together. An
--    evidence row naming another sale's line, or another store, would be an
--    explanation filed against the wrong receipt — and since the table is
--    append-only, a row against the wrong document can only ever be offset by
--    one that misstates something else. 017 learned this on `driver_ledger`'s
--    `related_credit_memo_id`.
--
--
-- WHAT SQLITE ACTUALLY DOES, MEASURED RATHER THAN ASSUMED
--
-- Three facts about SQLite 3.51 decide the whole shape of this migration's
-- arithmetic. All three were measured against the engine this application
-- ships with, not taken from memory:
--
--   1. `*` and `+` on two INTEGERs SILENTLY PROMOTE TO REAL on overflow.
--      `9223372036854775807 * 2` returns 1.8446744073709552e19 and raises
--      nothing. So every multiplication below must be reached only after its
--      operands have been proven small enough, and a comparison against an
--      overflowed product is worthless.
--   2. `SUM()` over INTEGERs RAISES `integer overflow`. That is fail-closed and
--      is relied on as a backstop, never as the primary bound.
--   3. INTEGER AFFINITY IS NOT A TYPE. A column declared INTEGER will hold
--      1.5 as a REAL, 'abc' as TEXT and NULL as NULL; only a lossless numeric
--      literal is converted. `typeof()` tells them apart, and affinity is
--      applied BEFORE a BEFORE-trigger sees `NEW.x`, so `typeof(NEW.x)` is a
--      reliable guard. Note `typeof(2.0)` is `'real'`, not `'integer'`.
--
-- Therefore every numeric figure this migration multiplies, divides or sums is
-- first held to THREE conditions, in three SEPARATE statements, in this order:
-- integer STORAGE CLASS, then RANGE, then a MAGNITUDE GATE. They cannot be
-- combined into one `WHERE ... OR ...`, because SQLite does not promise the
-- order in which it evaluates the terms of a boolean expression and an
-- unproven short-circuit is exactly how an overflowed product reaches a
-- comparison.
--
--
-- WHAT THE DATABASE CAN AND CANNOT PROVE ABOUT THE ARITHMETIC
--
--   * `recipe_cost.rs` is the authority. It accumulates in `i128` at a scale of
--     ACC = 1,000,000 finer than a microcent and its worst-case numerator is
--     2 x 10^35. That expression does not fit 64 bits and cannot be reproduced
--     here at all.
--   * `contribution_microcents` is the accumulator figure ALREADY ROUNDED to a
--     microcent, and the accumulator value is not stored, so the batch total
--     cannot be recovered exactly in SQL even in principle.
--
-- So the microcent layer is reconciled to a stated TOLERANCE and the CENT
-- layer — which is the money — is reconciled EXACTLY. Section 6 states both.
--
--
-- THE ADMISSIBLE ENVELOPE, AND ITS OVERFLOW PROOF
--
-- Enforced by rules 4A (storage) and 4B (range), which are this trigger's
-- first two statements after the posted-parent seal — before any comparison,
-- let alone any multiplication, so a malformed value is named as malformed
-- rather than reported as disagreeing with a recipe it cannot be compared to:
--
--     qn, qd, fn, fd  integer, [1, 10^6]        (migration 021's own bounds)
--     waste           integer, [0, 10^4)
--     R   = rate      integer, [0, 10^13]       ($100,000 per base unit)
--     C   = contrib   integer, [0, 10^15]       ($10,000,000 for one
--                                                ingredient of one batch)
--
-- whence
--
--     A = qn * fn * (10000 + waste)  <=  10^6 * 10^6 * 2x10^4  =  2 x 10^16
--     D = qd * fd * 10000            <=  10^6 * 10^6 * 10^4    =  10^16
--
-- both inside i64 (9.22 x 10^18) with three orders of magnitude to spare, and
-- both strictly positive, so neither is ever a zero divisor. Rule 4k then
-- gates the two products that could still overflow:
--
--     R <= 4x10^18 / A   =>   R * A <= 4 x 10^18
--     C <= 4x10^18 / D   =>   C * D <= 4 x 10^18
--
-- (integer division floors, so each implication is exact). Their difference is
-- therefore within [-4x10^18, 4x10^18], and rule 4l's `ABS(C*D - R*A)` is
-- computed entirely inside i64. ANYTHING OUTSIDE THE GATE IS REFUSED BY NAME:
-- not verified-and-passed, and not skipped, which is the only fail-closed
-- reading of "the database cannot check this one".
--
-- THE FIRST CUT OF THIS TRIGGER proved four relationships and stopped: that the
-- evidence named its own line, its line's recipe version, a recipe of its own
-- store and an ingredient of its own store. It said nothing about whether that
-- ingredient was IN the recipe, whether the frozen physical figures were the
-- ones the recipe published, or whether the contribution followed from its own
-- inputs — so a hand-written row could cite the burger's recipe and describe an
-- ingredient the burger has never contained, at a quantity the recipe never
-- stated, contributing a figure of its author's choosing.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_sale_item_recipe_costs_coherence
BEFORE INSERT ON sale_item_recipe_costs
BEGIN
  -- 4@. The parent sale must still be a draft — the same rule
  --     `trg_sale_item_recipe_costs_no_insert_after_post` states in rule 3,
  --     repeated here as this trigger's FIRST statement on purpose. SQLite
  --     does not define the order in which two BEFORE INSERT triggers on one
  --     table fire, so without this the message an operator sees for a row
  --     smuggled onto a posted sale depended on that order. A refusal is only
  --     as useful as the reason it gives.
  SELECT RAISE(ABORT, 'A posted sale cannot take further recipe-cost evidence.')
  WHERE (SELECT posted_at FROM sales WHERE id = NEW.sale_id) IS NOT NULL;

  -- 4A. INTEGER STORAGE CLASS. FIRST, before any comparison and long before any
  --     multiplication. A statement of its own, because INTEGER affinity is not a type, and a REAL, a
  --     TEXT or a NULL reaching the multiplications below would make every
  --     comparison after it meaningless. `typeof(2.0)` is `'real'`, so a
  --     deliberately integral REAL is caught too.
  SELECT RAISE(ABORT, 'Recipe-cost evidence must hold whole numbers. A value stored as text, as a decimal or as NULL cannot be reconciled.')
  WHERE typeof(NEW.quantity_num)                  <> 'integer'
     OR typeof(NEW.quantity_den)                  <> 'integer'
     OR typeof(NEW.factor_num_snapshot)           <> 'integer'
     OR typeof(NEW.factor_den_snapshot)           <> 'integer'
     OR typeof(NEW.waste_bps)                     <> 'integer'
     OR typeof(NEW.unit_cost_excl_vat_microcents) <> 'integer'
     OR typeof(NEW.contribution_microcents)       <> 'integer';

  -- 4B. RANGE. SECOND, restated here rather than inherited from
  --     the CHECKs on the table, because a BEFORE INSERT trigger fires BEFORE a
  --     CHECK is evaluated. These are the bounds `recipe_cost.rs` and migration
  --     021 both state; `contribution_microcents` gains an upper bound it never
  --     had, which is what makes the batch sum in rule 6 provably finite.
  SELECT RAISE(ABORT, 'Recipe-cost evidence is outside the range the recipe arithmetic is proven for, so the database will not record it.')
  WHERE NEW.quantity_num        < 1 OR NEW.quantity_num        > 1000000
     OR NEW.quantity_den        < 1 OR NEW.quantity_den        > 1000000
     OR NEW.factor_num_snapshot < 1 OR NEW.factor_num_snapshot > 1000000
     OR NEW.factor_den_snapshot < 1 OR NEW.factor_den_snapshot > 1000000
     OR NEW.waste_bps           < 0 OR NEW.waste_bps          >= 10000
     OR NEW.unit_cost_excl_vat_microcents < 0
     OR NEW.unit_cost_excl_vat_microcents > 10000000000000
     OR NEW.contribution_microcents       < 0
     OR NEW.contribution_microcents       > 1000000000000000;

  -- 4a. The line, its sale and the store are ONE triple.
  SELECT RAISE(ABORT, 'Recipe-cost evidence must name its own sale line.')
  WHERE NOT EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.id       = NEW.sale_item_id
       AND si.sale_id  = NEW.sale_id
       AND si.store_id = NEW.store_id
  );

  -- 4b. ...and that sale must itself belong to the same store. Without this
  --     the triple above proves only that the LINE agrees, and a line whose
  --     store disagrees with its own header is exactly the cross-store shape
  --     rule 5 forbids. Proved from both ends.
  SELECT RAISE(ABORT, 'Recipe-cost evidence must name a sale of its own store.')
  WHERE NOT EXISTS (
    SELECT 1 FROM sales s
     WHERE s.id       = NEW.sale_id
       AND s.store_id = NEW.store_id
  );

  -- 4c. Evidence explains a RECIPE-COSTED line. Attached to anything else it
  --     asserts a provenance the line's own rate does not have.
  SELECT RAISE(ABORT, 'Recipe-cost evidence may only explain a line that was costed from a recipe.')
  WHERE NOT EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.id          = NEW.sale_item_id
       AND si.cogs_source = 'recipe'
  );

  -- 4d. ...from THIS recipe, at THIS version.
  SELECT RAISE(ABORT, 'Recipe-cost evidence must name the recipe its line was costed from.')
  WHERE NOT EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.id             = NEW.sale_item_id
       AND si.recipe_id      = NEW.recipe_id
       AND si.recipe_version = NEW.recipe_version
  );

  -- 4e. A recipe of its own store, at the version named, and CURRENTLY ACTIVE.
  --
  --     The active clause is the P1-A correction at this level. `post_sale`
  --     costs only from the active version and writes the line, the evidence
  --     and the promotion in ONE transaction, so there is no legitimate path
  --     that files evidence against a draft or a retired version. A DRAFT is
  --     the dangerous one: migration 021 lets a draft's components be edited,
  --     so evidence proven against a draft could be made to disagree with it
  --     afterwards and the proof would be worthless. Reads of history are not
  --     affected — a trigger does not fire on a SELECT — so a posted v1 sale
  --     stays readable for ever after v1 retires.
  SELECT RAISE(ABORT, 'Recipe-cost evidence must name a PUBLISHED recipe of its own store. A draft or retired version cannot cost a new sale.')
  WHERE NOT EXISTS (
    SELECT 1 FROM recipes r
     WHERE r.id       = NEW.recipe_id
       AND r.store_id = NEW.store_id
       AND r.version  = NEW.recipe_version
       AND r.status   = 'active'
  );

  -- 4f. An ingredient of its own store.
  SELECT RAISE(ABORT, 'Recipe-cost evidence must name an ingredient of its own store.')
  WHERE NOT EXISTS (
    SELECT 1 FROM products p
     WHERE p.id       = NEW.component_product_id
       AND p.store_id = NEW.store_id
  );

  -- 4g. MEMBERSHIP. The ingredient must be one the cited recipe version
  --     actually names. `recipe_components` carries
  --     `UNIQUE (recipe_id, component_product_id)` and a recipe VERSION is its
  --     own `recipes` row, so this is version-specific and single-valued.
  SELECT RAISE(ABORT, 'Recipe-cost evidence names an ingredient that is not in the recipe version it cites.')
  WHERE NOT EXISTS (
    SELECT 1 FROM recipe_components rc
     WHERE rc.recipe_id            = NEW.recipe_id
       AND rc.component_product_id = NEW.component_product_id
  );

  -- 4h. THE PHYSICS MUST BE THE PUBLISHED VERSION'S OWN. Quantity, unit,
  --     conversion snapshot, waste and store, compared as stored. These are
  --     the figures a published recipe freezes and can never edit (021), so a
  --     difference means the evidence was not copied from the recipe it claims
  --     to explain.
  SELECT RAISE(ABORT, 'Recipe-cost evidence disagrees with the published recipe''s own frozen quantity, unit, conversion or waste.')
  WHERE NOT EXISTS (
    SELECT 1 FROM recipe_components rc
     WHERE rc.recipe_id            = NEW.recipe_id
       AND rc.component_product_id = NEW.component_product_id
       AND rc.store_id             = NEW.store_id
       AND rc.quantity_num         = NEW.quantity_num
       AND rc.quantity_den         = NEW.quantity_den
       AND rc.uom_code             = NEW.uom_code
       AND rc.factor_num_snapshot  = NEW.factor_num_snapshot
       AND rc.factor_den_snapshot  = NEW.factor_den_snapshot
       AND rc.waste_bps            = NEW.waste_bps
  );

  -- 4k. MAGNITUDE GATE. THIRD precondition. Every operand of the two divisions
  --     below is now a proven integer in [1, 2x10^16], so neither division can
  --     overflow and neither divisor can be zero. Fail-closed: a figure whose
  --     product the database cannot form in 64 bits is refused, never waved
  --     through.
  SELECT RAISE(ABORT, 'Recipe-cost evidence states a figure too large for the database to verify its arithmetic against, so it is refused rather than recorded unchecked.')
  WHERE NEW.unit_cost_excl_vat_microcents
          > 4000000000000000000
            / (NEW.quantity_num * NEW.factor_num_snapshot * (10000 + NEW.waste_bps))
     OR NEW.contribution_microcents
          > 4000000000000000000
            / (NEW.quantity_den * NEW.factor_den_snapshot * 10000);

  -- 4l. THE CONTRIBUTION FOLLOWS FROM ITS OWN INPUTS, to within the one
  --     microcent `recipe_cost.rs`'s two rounding points can introduce. A
  --     microcent is a MILLIONTH of a cent, and nothing derives a total
  --     from this column — section 6 reconciles the money in cents, exactly.
  SELECT RAISE(ABORT, 'Recipe-cost evidence states a contribution that does not follow from its own rate, quantity, conversion and waste.')
  WHERE ABS(
          NEW.contribution_microcents
            * (NEW.quantity_den * NEW.factor_den_snapshot * 10000)
          - NEW.unit_cost_excl_vat_microcents
            * (NEW.quantity_num * NEW.factor_num_snapshot * (10000 + NEW.waste_bps))
        ) > (NEW.quantity_den * NEW.factor_den_snapshot * 10000);
END;


-- ----------------------------------------------------------------------------
-- 5. A recipe-costed LINE names a PUBLISHED recipe, and a line that names one
--    says so — ON INSERT **AND** ON UPDATE.
--
--    The two columns and `cogs_source` are one fact written three ways, and a
--    row where they disagree is a row no reader can interpret: a `'recipe'`
--    line with no identity cannot be explained, and an identity under any
--    other `cogs_source` claims a provenance the rate does not have.
--
--    A NEW LINE MAY ONLY CITE AN ACTIVE VERSION. Checking the product, the
--    store and the version number proves which recipe is meant; it does not
--    prove that recipe is the authoritative one. A direct-SQL writer could
--    therefore cost a new sale from a DRAFT — whose components migration 021
--    permits editing, so nothing proven about it stays proven — or from a
--    RETIRED version that was superseded precisely because it no longer states
--    what the kitchen makes. Reads are untouched: a trigger does not fire on a
--    SELECT, so a sale legitimately posted from v1 stays readable, and
--    immutable, for ever after v1 retires. Version replacement is untouched
--    too, because `activate_recipe` promotes v2 and retires v1 in one
--    transaction and `post_sale` costs from whichever is active when it runs.
--
--    THE FIRST CUT GUARDED INSERT ONLY, and reasoned that a posted sale's
--    lines are immutable anyway. That describes a POSTED sale. Migration 012's
--    `trg_sale_items_no_update_after_post` fires only when the OLD or NEW
--    parent is posted, and every posting command builds a DRAFT and promotes
--    it last — so between those two statements a sale's lines are ordinary
--    updatable rows, and so are the lines of any draft any writer leaves lying
--    about. That window admitted three edits this pair now refuses:
--
--      * a line with evidence beneath it REPARENTED from draft sale A to draft
--        sale B, leaving the explanation filed against A and the charge
--        against B, with every foreign key still satisfied;
--      * `UPDATE sale_items SET recipe_id = <another store's recipe>` on a
--        draft, which the INSERT guard would have refused and which no guard
--        saw;
--      * `UPDATE sale_items SET unit_cogs_excl_vat_microcents = ...` after the
--        evidence was written, so the posted rate and the explanation beneath
--        it describe different costs — permanently, because the evidence takes
--        no UPDATE and no DELETE in any state.
--
--    ONCE EVIDENCE IS ATTACHED, THE LINE'S IDENTITY AND COST ARE FROZEN. That
--    is a stronger rule than "a posted line is immutable", and it is the right
--    one here: the evidence explains exactly those figures, it is append-only,
--    and the only writer that attaches it writes the line and the evidence in
--    one transaction and never revisits either. Nothing legitimate edits them,
--    so refusing outright costs nothing.
--
--    A LINE'S STORE MUST BE ITS SALE'S STORE. Nothing in the schema said so
--    before — `sale_items.store_id` is a column a writer supplies — and every
--    cross-store proof in rule 4 compares the evidence against the LINE, so a
--    store-B line under a store-A header carried store-B evidence coherently
--    all the way onto a store-A receipt. Enforced for recipe-involved lines
--    here; the general case is deliberately NOT widened in this migration,
--    because every `sale_items` row ever written would have to be re-proved
--    against it and history is not restated.
--
--    Deliberately NOT retrospective. Both triggers fire only when the row
--    names a recipe, claims `cogs_source = 'recipe'`, or has evidence beneath
--    it — so every pre-v22 line is untouched, which it must be.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_sale_items_recipe_coherence
BEFORE INSERT ON sale_items
WHEN NEW.recipe_id IS NOT NULL OR NEW.cogs_source = 'recipe'
BEGIN
  SELECT RAISE(ABORT, 'A recipe-costed sale line must record which recipe version costed it.')
  WHERE NEW.cogs_source = 'recipe'
    AND (NEW.recipe_id IS NULL OR NEW.recipe_version IS NULL);

  SELECT RAISE(ABORT, 'A sale line may only name a recipe when it was costed from one.')
  WHERE NEW.recipe_id IS NOT NULL
    AND (NEW.cogs_source IS NULL OR NEW.cogs_source <> 'recipe');

  SELECT RAISE(ABORT, 'A sale line must name a recipe of its own store, and of its own product.')
  WHERE NEW.recipe_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM recipes r
       WHERE r.id         = NEW.recipe_id
         AND r.store_id   = NEW.store_id
         AND r.product_id = NEW.product_id
         AND r.version    = NEW.recipe_version
    );

  SELECT RAISE(ABORT, 'A new sale can only be costed from a PUBLISHED recipe. This version is a draft or has been retired.')
  WHERE NEW.recipe_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM recipes r
       WHERE r.id     = NEW.recipe_id
         AND r.status = 'active'
    );

  SELECT RAISE(ABORT, 'A recipe-costed sale line must belong to the same store as its own sale.')
  WHERE NEW.store_id <> (SELECT store_id FROM sales WHERE id = NEW.sale_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_recipe_coherence_upd
BEFORE UPDATE ON sale_items
FOR EACH ROW
WHEN OLD.recipe_id IS NOT NULL
  OR NEW.recipe_id IS NOT NULL
  OR OLD.cogs_source = 'recipe'
  OR NEW.cogs_source = 'recipe'
  OR EXISTS (SELECT 1 FROM sale_item_recipe_costs e WHERE e.sale_item_id = OLD.id)
BEGIN
  -- 5a. Evidence attached: identity and cost are frozen, in any state.
  SELECT RAISE(ABORT, 'A sale line with recipe-cost evidence beneath it is frozen: its identity, sale, store, product, recipe, provenance, quantity and cost can never change, because the evidence explains exactly those figures and is append-only.')
  WHERE EXISTS (SELECT 1 FROM sale_item_recipe_costs e WHERE e.sale_item_id = OLD.id)
    AND (   NEW.id         <> OLD.id
         OR NEW.sale_id    <> OLD.sale_id
         OR NEW.store_id   <> OLD.store_id
         OR NEW.product_id <> OLD.product_id
         OR COALESCE(NEW.recipe_id, '')      <> COALESCE(OLD.recipe_id, '')
         OR COALESCE(NEW.recipe_version, -1) <> COALESCE(OLD.recipe_version, -1)
         OR COALESCE(NEW.cogs_source, '')    <> COALESCE(OLD.cogs_source, '')
         OR NEW.quantity                     <> OLD.quantity
         OR COALESCE(NEW.unit_cogs_excl_vat_microcents, -1)
              <> COALESCE(OLD.unit_cogs_excl_vat_microcents, -1)
         OR COALESCE(NEW.unit_cogs_excl_vat_cents, -1)
              <> COALESCE(OLD.unit_cogs_excl_vat_cents, -1)
         OR COALESCE(NEW.line_cogs_excl_vat_cents, -1)
              <> COALESCE(OLD.line_cogs_excl_vat_cents, -1)
        );

  -- 5b. A recipe-involved line is NEVER moved to another sale, evidence or
  --     not. Posting builds every line under its own sale, so there is no
  --     legitimate reparenting to preserve.
  SELECT RAISE(ABORT, 'A recipe-costed sale line cannot be moved to another sale.')
  WHERE NEW.sale_id <> OLD.sale_id;

  -- 5c..5g. The INSERT rules, re-applied to the row as it would stand —
  --         including the published-version requirement, so a draft line
  --         cannot be re-pointed at a draft or a retired recipe.
  SELECT RAISE(ABORT, 'A recipe-costed sale line must record which recipe version costed it.')
  WHERE NEW.cogs_source = 'recipe'
    AND (NEW.recipe_id IS NULL OR NEW.recipe_version IS NULL);

  SELECT RAISE(ABORT, 'A sale line may only name a recipe when it was costed from one.')
  WHERE NEW.recipe_id IS NOT NULL
    AND (NEW.cogs_source IS NULL OR NEW.cogs_source <> 'recipe');

  SELECT RAISE(ABORT, 'A sale line must name a recipe of its own store, and of its own product.')
  WHERE NEW.recipe_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM recipes r
       WHERE r.id         = NEW.recipe_id
         AND r.store_id   = NEW.store_id
         AND r.product_id = NEW.product_id
         AND r.version    = NEW.recipe_version
    );

  SELECT RAISE(ABORT, 'A new sale can only be costed from a PUBLISHED recipe. This version is a draft or has been retired.')
  WHERE NEW.recipe_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM recipes r
       WHERE r.id     = NEW.recipe_id
         AND r.status = 'active'
    );

  SELECT RAISE(ABORT, 'A recipe-costed sale line must belong to the same store as its own sale.')
  WHERE (NEW.recipe_id IS NOT NULL OR NEW.cogs_source = 'recipe')
    AND NEW.store_id <> (SELECT store_id FROM sales WHERE id = NEW.sale_id);
END;


-- ----------------------------------------------------------------------------
-- 6. A sale does not POST unless its recipe-costed lines are completely
--    explained AND its money adds up.
--
--    "A completed sale must never reference missing or incomplete recipe-cost
--    evidence" is the invariant, and the engine is where it is made true
--    rather than the command, because the command is not the only writer a
--    database can have. `post_sale` writes the lines and the evidence inside
--    one transaction and promotes the sale last, so this fires on exactly the
--    statement that makes the sale real — and a sale whose evidence failed to
--    write cannot become posted at all. It rolls back with everything else.
--
--    THE FIRST CUT ASKED ONE QUESTION: does at least one evidence row exist
--    for this line? A four-ingredient burger with a single hand-written row
--    passed it, and the posted receipt then carried an explanation of one
--    quarter of its own cost, sealed for ever. "Complete" has to mean the SET.
--
--    THE SECOND CUT reconciled the MICROCENT rate and stopped there, leaving
--    the three CENT columns — `sale_items.unit_cogs_excl_vat_cents`,
--    `sale_items.line_cogs_excl_vat_cents` and `sales.cogs_total_cents` —
--    unchecked. Those are the money. A writer could file 174 cents' worth of
--    faithful ingredient evidence and book 1 cent of cost, and every
--    gross-profit figure the shop prints reads the cents.
--
--
-- THE CENT LAYER IS RECONCILED EXACTLY, AND IT IS THE RUST RULE, NOT AN
-- APPROXIMATION OF IT
--
-- Read out of `src-tauri/src/cost.rs` and `posting.rs` rather than assumed:
--
--     div_round_half_away(n, d)       = (n + d/2) / d           for n >= 0
--     unit_cogs_excl_vat_cents        = microcents_to_cents(U)
--                                     = (U + 500000) / 1000000
--     line_cogs_excl_vat_cents        = extended_cost_cents(U, Q)
--                                     = (U * Q + 500000) / 1000000
--     sales.cogs_total_cents          = SUM(line_cogs_excl_vat_cents)
--
-- Three things in that list are easy to get wrong and are therefore spelled
-- out. (1) The line cost is NOT the unit cost in cents times the quantity:
-- `post_sale` multiplies the PRECISE microcent rate by the quantity and rounds
-- ONCE, which is the whole of GP-A03. Three units at 14,756,250 microcents give
-- 44 cents, where 15 x 3 would give 45. (2) Rounding is half AWAY FROM ZERO,
-- and for the non-negative values these columns hold that is `(n + 500000) /
-- 1000000` with truncating integer division — which is exactly what SQLite's
-- `/` does on two positive integers. `ROUND()` is not used anywhere here: it
-- is floating-point, and a float is not a rounding rule. (3) `sale_items.
-- quantity` is `INTEGER NOT NULL CHECK (quantity > 0)` (migration 001), so
-- there is no fractional sale quantity to accommodate; a recipe quantity is a
-- fraction, a SALE quantity is not, and that asymmetry is migration 021's own
-- design.
--
-- The header reconciliation covers EVERY line of the sale, not only the recipe
-- ones, so a mixed recipe/manual/purchase-average sale is checked as a whole.
-- It is scoped to sales that hold at least one recipe-costed line: widening it
-- to every sale would be a new rule for documents this work package has no
-- finding about, and the finding is that a RECIPE sale can understate its cost.
-- That limit is stated in the report rather than hidden here.
--
--
-- THE MICROCENT LAYER IS RECONCILED TO A STATED TOLERANCE
--
--     | U * Y - SUM(C) |  <=  Y + n
--
-- where U is the line's microcent rate, Y the published batch yield, C each
-- contribution and n the component count. The true bound is 0.51 x (Y + n),
-- from the two rounding points `recipe_cost.rs` documents; `Y + n` is integer,
-- strictly weaker, and therefore cannot refuse an honest sale. With n held at
-- or below 64 (rule 6k) and Y at or below 10^6, the worst-case slack is
-- 10^6 + 64 microcents on a BATCH figure, i.e. at most 1 + 64/Y microcents per
-- selling unit — under a hundredth of a cent. IT CANNOT HIDE A CENT, because
-- the cent columns are reconciled exactly and independently in rules 6n to 6p.
-- That division of labour is the answer to "a tolerance is not a proof": the
-- tolerance governs a rate nobody spends, and the exactness governs the money.
--
--
-- AGGREGATE BOUNDS, PROVED
--
-- Rules 6i to 6m establish, in separate statements and in this order, that for
-- every recipe-costed line of this sale:
--
--     n = component count of the cited recipe  <=  64        (6k)
--     every evidence figure is an integer in rule 4j's range (6i, 6j)
--     Y = yield_quantity_base   integer, [1, 10^6]           (6i, 6j)
--     U = unit microcent rate   integer, [0, 10^15]          (6i, 6j)
--     Q = quantity              integer, [1, 10^9]           (6i, 6j)
--     U <= 4x10^18 / Y  and  U <= 4x10^18 / Q                (6m)
--
-- whence
--
--     SUM(C)   <=  64 * 10^15        =  6.4 x 10^16     inside i64
--     U * Y    <=  4 x 10^18                           inside i64
--     U * Q    <=  4 x 10^18, and + 500000 still does  inside i64
--     | U*Y - SUM(C) |  <=  4 x 10^18                  inside i64
--
-- No intermediate expression can reach 9.22 x 10^18. `SUM()` over INTEGERs
-- raises `integer overflow` rather than promoting to REAL, so even a bound
-- somebody widens later fails closed; that is the backstop, not the proof.
-- The header sum adds one more aggregate: each `line_cogs_excl_vat_cents` is
-- held to |LC| <= 10^13 (6j), so about 900,000 lines would be needed to
-- overflow the sum, and SUM() would raise before accepting one.
--
--
-- IT FIRES ON EVERY TRANSITION INTO A POSTED STATE, NOT ON ONE COLUMN
--
-- The first three cuts of this trigger were `BEFORE UPDATE OF posted_at`,
-- keyed on `posted_at` going NULL -> NOT NULL. That is NOT what the
-- application means by posted. THIRTY-SEVEN read models — Sales History, the
-- shift summary, every drawer and profit query — filter `status = 'posted'`,
-- and NOT ONE of them reads `posted_at`. So
--
--     UPDATE sales SET status = 'posted' WHERE id = ?;
--
-- made a sale financially real to every reader in the application while
-- changing no column this trigger watched: no evidence check, no cent
-- reconciliation, no component bound. Worse, migration 001's
-- `trg_sales_no_update_after_post` is keyed on `OLD.posted_at IS NOT NULL`
-- too, so the resulting row was not immutable either — nor were its lines,
-- whose own guards key on the PARENT's `posted_at`. A sale could be recognised
-- as posted, counted in a shift report, and still be edited afterwards.
--
-- The WHEN clause now fires on EITHER marker moving into the posted state, and
-- that is deliberate rather than belt-and-braces: it makes this trigger
-- correct independently of the state trigger in section 10, so nothing
-- depends on the order in which SQLite fires two BEFORE UPDATE triggers on one
-- table. Section 10 forbids the incoherent states; this one validates the
-- money on the way in. Either alone closes the bypass; together they also give
-- the operator the right message.
--
-- A VOID DOES NOT RE-FIRE IT. Migration 001 carves out `posted -> voided` with
-- `posted_at` unchanged, so neither clause matches: `NEW.status` is `'voided'`
-- and `posted_at` does not move. A posted sale is validated once, when it
-- posts.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sales_recipe_evidence_complete;

CREATE TRIGGER trg_sales_recipe_evidence_complete
BEFORE UPDATE ON sales
WHEN (NEW.status = 'posted' AND COALESCE(OLD.status, '') <> 'posted')
  OR (NEW.posted_at IS NOT NULL AND OLD.posted_at IS NULL)
BEGIN
  -- 6a. A recipe-costed line with no evidence at all.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-costed line that has no cost evidence.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND NOT EXISTS (
         SELECT 1 FROM sale_item_recipe_costs e
          WHERE e.sale_item_id = si.id
       )
  );

  -- 6b. A line whose recipe identity and provenance disagree. Rule 5 refuses
  --     the write; this refuses the PROMOTION, so a row that reached the shape
  --     by any route cannot become a receipt.
  SELECT RAISE(ABORT, 'A sale cannot post with a line whose recipe identity and cost provenance disagree.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id = NEW.id
       AND (   (si.cogs_source = 'recipe'
                AND (si.recipe_id IS NULL OR si.recipe_version IS NULL))
            OR (si.recipe_id IS NOT NULL
                AND COALESCE(si.cogs_source, '') <> 'recipe')
           )
  );

  -- 6c. A recipe-involved line that belongs to another store than its header.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-costed line that belongs to another store than the sale.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id = NEW.id
       AND (si.cogs_source = 'recipe' OR si.recipe_id IS NOT NULL)
       AND si.store_id <> NEW.store_id
  );

  -- 6d. A line naming a recipe that is not its own product's, in its own
  --     store, at the version it states.
  SELECT RAISE(ABORT, 'A sale cannot post with a line naming a recipe that is not its own product''s, in its own store, at the version it states.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id   = NEW.id
       AND si.recipe_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM recipes r
          WHERE r.id         = si.recipe_id
            AND r.store_id   = si.store_id
            AND r.product_id = si.product_id
            AND r.version    = si.recipe_version
       )
  );

  -- 6e. ...and that recipe must be the PUBLISHED one, re-proved at the moment
  --     the sale becomes real. This is the P1-A correction's third arm, and it
  --     is the one that closes the interleaving: a draft sale prepared while v1
  --     was active cannot be promoted after v1 has been retired or demoted,
  --     because the state that matters is the state at FINALIZATION. `post_sale`
  --     does all of it in one transaction, so no honest sale is ever caught —
  --     SQLite serialises writers, and the recipe cannot change status between
  --     the line and the promotion of a sale that is posting.
  SELECT RAISE(ABORT, 'A sale cannot post against a recipe version that is not published. A draft or retired version cannot cost a new sale.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id   = NEW.id
       AND si.recipe_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM recipes r
          WHERE r.id     = si.recipe_id
            AND r.status = 'active'
       )
  );

  -- 6f. Evidence hanging off a line of this sale that was not recipe-costed.
  SELECT RAISE(ABORT, 'A sale cannot post with recipe-cost evidence attached to a line that was not costed from a recipe.')
  WHERE EXISTS (
    SELECT 1 FROM sale_item_recipe_costs e
      JOIN sale_items si ON si.id = e.sale_item_id
     WHERE si.sale_id = NEW.id
       AND COALESCE(si.cogs_source, '') <> 'recipe'
  );

  -- 6g. STALE OR MISFILED evidence: the sale, the store or the recipe version
  --     it names is not its own line's.
  SELECT RAISE(ABORT, 'A sale cannot post with recipe-cost evidence filed against another sale, another store or another recipe version than its own line.')
  WHERE EXISTS (
    SELECT 1 FROM sale_item_recipe_costs e
      JOIN sale_items si ON si.id = e.sale_item_id
     WHERE si.sale_id = NEW.id
       AND (   e.sale_id        <> si.sale_id
            OR e.store_id       <> si.store_id
            OR e.store_id       <> NEW.store_id
            OR e.recipe_id      <> si.recipe_id
            OR e.recipe_version <> si.recipe_version
           )
  );

  -- 6h. EXTRA OR UNRELATED: an evidence row naming an ingredient the cited
  --     recipe version does not contain. And MISSING: a component of that
  --     version with no evidence row on the line — the original P1-A defect,
  --     which a four-ingredient recipe with one evidence row walked straight
  --     through.
  SELECT RAISE(ABORT, 'A sale cannot post with recipe-cost evidence naming an ingredient that is not in the recipe version it cites.')
  WHERE EXISTS (
    SELECT 1 FROM sale_item_recipe_costs e
      JOIN sale_items si ON si.id = e.sale_item_id
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND NOT EXISTS (
         SELECT 1 FROM recipe_components rc
          WHERE rc.recipe_id            = si.recipe_id
            AND rc.component_product_id = e.component_product_id
       )
  );

  SELECT RAISE(ABORT, 'A sale cannot post with an incomplete recipe-cost explanation: an ingredient of the recipe has no evidence row on the line.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
      JOIN recipe_components rc ON rc.recipe_id = si.recipe_id
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND NOT EXISTS (
         SELECT 1 FROM sale_item_recipe_costs e
          WHERE e.sale_item_id         = si.id
            AND e.component_product_id = rc.component_product_id
       )
  );

  -- 6i. INTEGER STORAGE CLASS, for every figure the arithmetic below touches —
  --     the evidence rows, the line's own three financial columns and its
  --     quantity, the recipe's yield, and the sale header's total. A separate
  --     statement, BEFORE any range check and long before any multiplication,
  --     because INTEGER affinity is not a type and `typeof(2.0)` is `'real'`.
  SELECT RAISE(ABORT, 'A sale cannot post while a recipe-cost figure is stored as text, as a decimal or as NULL: such a value cannot be reconciled.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
      JOIN recipes r
        ON r.id      = si.recipe_id
       AND r.version = si.recipe_version
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND (   typeof(si.unit_cogs_excl_vat_microcents) <> 'integer'
            OR typeof(si.unit_cogs_excl_vat_cents)      <> 'integer'
            OR typeof(si.line_cogs_excl_vat_cents)      <> 'integer'
            OR typeof(si.quantity)                      <> 'integer'
            OR typeof(r.yield_quantity_base)            <> 'integer'
           )
  );

  SELECT RAISE(ABORT, 'A sale cannot post while a recipe-cost figure is stored as text, as a decimal or as NULL: such a value cannot be reconciled.')
  WHERE typeof(NEW.cogs_total_cents) <> 'integer'
     OR EXISTS (
    SELECT 1 FROM sale_item_recipe_costs e
      JOIN sale_items si ON si.id = e.sale_item_id
     WHERE si.sale_id = NEW.id
       AND (   typeof(e.contribution_microcents)       <> 'integer'
            OR typeof(e.unit_cost_excl_vat_microcents) <> 'integer'
           )
  );

  SELECT RAISE(ABORT, 'A sale cannot post while a line''s cost is stored as text, as a decimal or as NULL: the sale''s total cost cannot be reconciled against it.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id = NEW.id
       AND typeof(si.line_cogs_excl_vat_cents) <> 'integer'
  );

  -- 6j. RANGE, second precondition and its own statement.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe cost outside the range the database can verify its own arithmetic against. Greaz refuses it rather than recording it unchecked.')
  WHERE ABS(NEW.cogs_total_cents) > 1000000000000000
     OR EXISTS (
    SELECT 1 FROM sale_items si
      JOIN recipes r
        ON r.id      = si.recipe_id
       AND r.version = si.recipe_version
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND (   si.unit_cogs_excl_vat_microcents < 0
            OR si.unit_cogs_excl_vat_microcents > 1000000000000000
            OR si.quantity < 1
            OR si.quantity > 1000000000
            OR ABS(si.unit_cogs_excl_vat_cents) > 1000000000000
            OR ABS(si.line_cogs_excl_vat_cents) > 10000000000000
            OR r.yield_quantity_base < 1
            OR r.yield_quantity_base > 1000000
           )
  );

  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-cost evidence figure outside the range the database can verify its own arithmetic against.')
  WHERE EXISTS (
    SELECT 1 FROM sale_item_recipe_costs e
      JOIN sale_items si ON si.id = e.sale_item_id
     WHERE si.sale_id = NEW.id
       AND (   e.contribution_microcents < 0
            OR e.contribution_microcents > 1000000000000000
            OR e.unit_cost_excl_vat_microcents < 0
            OR e.unit_cost_excl_vat_microcents > 10000000000000
           )
  );

  SELECT RAISE(ABORT, 'A sale cannot post while a line''s cost in cents is outside the range the sale total can be reconciled in.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id = NEW.id
       AND ABS(si.line_cogs_excl_vat_cents) > 10000000000000
  );

  -- 6k. THE COMPONENT COUNT, bounded BEFORE any aggregate runs. Rust refuses a
  --     recipe above `MAX_COMPONENTS` = 64 and migration 021 carries no
  --     matching database rule, so a direct-SQL recipe of ten thousand
  --     ingredients could previously reach the aggregates below — where it
  --     would both inflate rule 6m's `Y + n` tolerance without limit and push
  --     `SUM(C)` towards the point at which SQLite stops being exact. Section 9
  --     stops such a recipe being BUILT; this stops one that exists from
  --     costing a sale.
  SELECT RAISE(ABORT, 'A sale cannot post from a recipe with more than 64 ingredients: that is the limit the cost arithmetic is proven for.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND (SELECT COUNT(*) FROM recipe_components rc
             WHERE rc.recipe_id = si.recipe_id) > 64
  );

  -- 6l. EXACTLY ONE ROW PER INGREDIENT. Implied by the two halves of 6h and the
  --     table's `UNIQUE (sale_item_id, component_product_id)`; asserted rather
  --     than assumed, because "the set matches" is the claim being made and a
  --     count is the cheapest independent statement of it. Safe to aggregate
  --     here: 6k has bounded the count.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-cost explanation that does not hold exactly one row per ingredient of its recipe version.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND (SELECT COUNT(*) FROM sale_item_recipe_costs e
             WHERE e.sale_item_id = si.id)
        <> (SELECT COUNT(*) FROM recipe_components rc
             WHERE rc.recipe_id = si.recipe_id)
  );

  -- 6m. THE PHYSICS. Every frozen figure equals the published component's.
  SELECT RAISE(ABORT, 'A sale cannot post with recipe-cost evidence whose frozen quantity, unit, conversion, waste or store disagrees with the published recipe.')
  WHERE EXISTS (
    SELECT 1 FROM sale_item_recipe_costs e
      JOIN sale_items si ON si.id = e.sale_item_id
      JOIN recipe_components rc
        ON rc.recipe_id            = si.recipe_id
       AND rc.component_product_id = e.component_product_id
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND (   rc.quantity_num        <> e.quantity_num
            OR rc.quantity_den        <> e.quantity_den
            OR rc.uom_code            <> e.uom_code
            OR rc.factor_num_snapshot <> e.factor_num_snapshot
            OR rc.factor_den_snapshot <> e.factor_den_snapshot
            OR rc.waste_bps           <> e.waste_bps
            OR rc.store_id            <> e.store_id
           )
  );

  -- 6n. THE MAGNITUDE GATE for the two products rule 6o multiplies. Its own
  --     statement, after 6i and 6j have proved every operand is a positive
  --     integer in range, so neither division can overflow or divide by zero.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe cost too large for the database to verify its own arithmetic against.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
      JOIN recipes r
        ON r.id      = si.recipe_id
       AND r.version = si.recipe_version
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND (   si.unit_cogs_excl_vat_microcents > 4000000000000000000 / r.yield_quantity_base
            OR si.unit_cogs_excl_vat_microcents > 4000000000000000000 / si.quantity
           )
  );

  -- 6o. THE MICROCENT RATE is the batch the evidence describes, divided by the
  --     published batch yield — to within `Y + n`, as the header states, and
  --     with n proven at or below 64 by 6k.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-costed line whose cost rate does not follow from the evidence beneath it and the recipe''s batch yield.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
      JOIN recipes r
        ON r.id      = si.recipe_id
       AND r.version = si.recipe_version
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND EXISTS (SELECT 1 FROM sale_item_recipe_costs e
                    WHERE e.sale_item_id = si.id)
       AND ABS(
             si.unit_cogs_excl_vat_microcents * r.yield_quantity_base
             - (SELECT SUM(e.contribution_microcents)
                  FROM sale_item_recipe_costs e
                 WHERE e.sale_item_id = si.id)
           ) > ( r.yield_quantity_base
               + (SELECT COUNT(*) FROM sale_item_recipe_costs e
                   WHERE e.sale_item_id = si.id) )
  );

  -- 6p. THE UNIT COST IN CENTS, derived exactly as `cost::microcents_to_cents`
  --     derives it: half away from zero, which for a non-negative rate is
  --     `(U + 500000) / 1000000` under truncating integer division. No
  --     `ROUND()`, no float.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-costed line whose unit cost in cents does not follow from its own microcent rate.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND si.unit_cogs_excl_vat_cents
             <> (si.unit_cogs_excl_vat_microcents + 500000) / 1000000
  );

  -- 6q. THE LINE COST IN CENTS, derived exactly as `cost::extended_cost_cents`
  --     derives it: the PRECISE rate times the quantity, rounded ONCE. It is
  --     deliberately not `unit cents x quantity` — three units at 14,756,250
  --     microcents are 44 cents, where 15 x 3 would be 45, and rounding the
  --     rate first is the GP-A03 defect that made 500 g of $0.0025/g flour cost
  --     $0.00.
  SELECT RAISE(ABORT, 'A sale cannot post with a recipe-costed line whose extended cost does not follow from its microcent rate and its quantity.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id     = NEW.id
       AND si.cogs_source = 'recipe'
       AND si.line_cogs_excl_vat_cents
             <> (si.unit_cogs_excl_vat_microcents * si.quantity + 500000) / 1000000
  );

  -- 6r. THE SALE'S OWN TOTAL COST is the sum of its lines' extended costs, over
  --     EVERY line — recipe, manual, purchase-average or legacy alike — because
  --     a mixed sale's header is one figure and it has to be the whole of it.
  --     `post_sale` accumulates exactly this sum, so an honest sale always
  --     agrees; a writer that booked 1 cent of cost against 174 cents of
  --     evidence does not. Scoped to sales holding a recipe-costed line: see
  --     the header note on why this is not widened to every document.
  SELECT RAISE(ABORT, 'A sale cannot post with a total cost that is not the sum of its own lines'' costs.')
  WHERE EXISTS (
    SELECT 1 FROM sale_items si
     WHERE si.sale_id = NEW.id AND si.cogs_source = 'recipe'
  )
    AND NEW.cogs_total_cents <> (
      SELECT COALESCE(SUM(si.line_cogs_excl_vat_cents), 0)
        FROM sale_items si WHERE si.sale_id = NEW.id
    );
END;


-- 7. `costing_method = 'recipe'` is ADMITTED, under conditions.
--
--    DROP then CREATE, not `IF NOT EXISTS`: a v21 database already holds the
--    pair that refuses `'recipe'` outright, and `CREATE TRIGGER IF NOT EXISTS`
--    would silently keep it — the mistake 017 was written to correct on 016's
--    shift guard.
--
--    The two Manual Cost rules are carried over UNCHANGED, because this
--    migration has no opinion about them. What changes is the third clause:
--    `'recipe'` is no longer refused, and is instead held to the two conditions
--    stated in the header — a non-stock item, and a published recipe to cost it
--    from.
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
    'products: Manual Cost applies to non-stock menu items only. A stocked product is valued from its purchases.'
  )
  WHERE NEW.costing_method = 'standard'
    AND NEW.is_service <> 1;

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
    'products: Manual Cost applies to non-stock menu items only. A stocked product is valued from its purchases.'
  )
  WHERE NEW.costing_method = 'standard'
    AND NEW.is_service <> 1;

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


-- ----------------------------------------------------------------------------
-- 8. A PUBLISHED RECIPE CANNOT BE RETIRED OUT FROM UNDER THE ITEM THAT USES IT
--
--    Rule 7 above refuses `costing_method = 'recipe'` for a product with no
--    published recipe, and `recipes.rs::retire_recipe` refuses to retire the
--    active version while the product is recipe-costed. Those two were
--    described as closing the loop from both ends, and they do — for the two
--    COMMANDS. Direct SQL went straight between them: one `UPDATE recipes SET
--    status='retired'` left a product configured for a cost it can no longer
--    obtain, which rule 7 would have refused as a product edit and had no
--    opinion about as a recipe edit. The product then cannot be sold at all,
--    and the refusal arrives at the till in front of a customer.
--
--    WHY THE GUARD IS NOT SIMPLY "NEVER", and this is the part that needs
--    care: `activate_recipe` publishes version N+1 by RETIRING THE INCUMBENT
--    FIRST, inside one transaction, so that `ux_recipes_one_active` is never
--    momentarily violated. A flat refusal would therefore make a recipe-costed
--    item's recipe uneditable for ever — the owner could not publish version 2
--    without first retiring version 1, and could not retire version 1 at all.
--    That is the deadlock, and it is reachable from the one workflow the
--    feature exists for.
--
--    So the rule is: an active version may not be retired while its product is
--    recipe-costed UNLESS A DRAFT VERSION OF THAT PRODUCT EXISTS. A draft is
--    the only shape an atomic replacement takes — `ux_recipes_one_draft` makes
--    it single-valued, `save_recipe_draft` is the only thing that creates one,
--    and `activate_recipe` promotes exactly it — so the exemption admits the
--    legitimate transition and nothing else a command can reach.
--
--    THE LIMIT, STATED RATHER THAN GLOSSED. A direct-SQL writer can still
--    insert a draft, retire the incumbent and then not activate, leaving a
--    recipe-costed product with a draft and no published version. That is not
--    silent and it is not a misstated figure: `post_sale` refuses such a line
--    by name (`recipe_sale_cost.rs::RECIPE_COSTING_NO_ACTIVE_RECIPE`) before a
--    receipt number is consumed, so the worst outcome is a refused sale with a
--    sentence naming the item and the screen to fix it on. Closing that last
--    gap would need a deferred constraint, which SQLite does not have, or a
--    guard on the ACTIVATION side that cannot distinguish an abandoned
--    replacement from one still in progress.
--
--    The guard reads the product row by the recipe's own `product_id` and
--    scopes the draft search by store AND product, the way every other query
--    in this family does: a corrupted header must not be able to borrow
--    another branch's draft as its excuse.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_recipes_no_retire_while_product_depends
BEFORE UPDATE ON recipes
FOR EACH ROW
WHEN OLD.status = 'active' AND NEW.status = 'retired'
BEGIN
  SELECT RAISE(
    ABORT,
    'recipes: this item is costed from its recipe, so its published version cannot be retired and leave it with none. Publish a replacement version, or switch the item to purchase valuation or Manual Cost first.'
  )
  WHERE (SELECT costing_method FROM products WHERE id = OLD.product_id) = 'recipe'
    AND NOT EXISTS (
      SELECT 1 FROM recipes d
       WHERE d.product_id = OLD.product_id
         AND d.store_id   = OLD.store_id
         AND d.status     = 'draft'
    );
END;


-- ----------------------------------------------------------------------------
-- 9. A RECIPE MAY NOT HOLD MORE THAN 64 INGREDIENTS, IN THE ENGINE
--
--    `recipe_cost.rs` sets `MAX_COMPONENTS = 64` and proves its overflow
--    envelope against that number; `save_recipe_draft` refuses a payload above
--    it and `activate_recipe` refuses to publish one. Migration 021 carries no
--    matching rule, which was fine while nothing but Rust could reach the
--    cost — and stopped being fine the moment migration 022 began aggregating
--    evidence in SQL. A direct-SQL recipe of ten thousand ingredients is not an
--    abstract worry: it inflates rule 6o's `Y + n` tolerance without limit, and
--    it pushes `SUM(contribution_microcents)` towards the point where SQLite is
--    no longer exact.
--
--    This is the rule stated where the row is created, which is cheaper and
--    clearer than discovering it at the till. Rule 6k is the other end: a
--    recipe that somehow exists above the limit cannot cost a sale.
--
--    IT LIVES IN 022, NOT 021. Migration 021 has shipped; its checksum is
--    recorded in every database that applied it, and editing it would stop
--    those databases opening. So the rule is added forward, the way 017 added
--    to 016 and 019 corrected 003.
--
--    FORWARD-ONLY, deliberately. The guard is BEFORE INSERT, so a recipe that
--    already holds more than 64 lines in some database keeps them: nothing is
--    deleted and no existing document is restated. Such a recipe simply cannot
--    cost a sale (6k), which is the honest outcome — a refusal naming the
--    reason, rather than a silently truncated cost.
--
--    The count is of the SAME parent, so each recipe is judged on its own, and
--    it is taken before the row is written, so the 65th is the one refused.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_recipe_components_max_count
BEFORE INSERT ON recipe_components
FOR EACH ROW
WHEN (SELECT COUNT(*) FROM recipe_components rc WHERE rc.recipe_id = NEW.recipe_id) >= 64
BEGIN
  SELECT RAISE(
    ABORT,
    'recipe_components: a recipe may hold at most 64 ingredients. That is the limit the cost arithmetic is proven not to overflow for, and a recipe nobody can read is a different problem.'
  );
END;


-- ----------------------------------------------------------------------------
-- 10. THE POSTING STATE IS COHERENT, AND A SALE IS BORN A DRAFT
--
--     `sales` carries TWO markers of the same fact and migration 001 never
--     tied them together: `status` (`'draft'`, `'posted'`, `'voided'`) and
--     `posted_at`. Its own comment says "posted_at IS NOT NULL => row is
--     immutable. Set when status moves to 'posted'", and that is the intent —
--     but intent is not a constraint, and the two columns could disagree.
--
--     WHICH ONE IS AUTHORITATIVE DEPENDS ON WHO IS ASKING, and that is the
--     whole defect. The APPLICATION reads `status = 'posted'`: 37 query sites
--     across Sales History, the shift summary, the drawer reconciliation and
--     every profit report, and not one of them mentions `posted_at`. The
--     ENGINE read `posted_at`: migration 001's immutability trigger, 012's
--     child guards, and this migration's own finalization and evidence rules.
--     So the row shape `status = 'posted'` with `posted_at IS NULL` was a sale
--     that every report counted and every guard ignored.
--
--
--     THE LEGAL STATE MACHINE, as the commands actually implement it
--
--       INSERT                      -> (draft,  posted_at NULL)
--       (draft,  NULL)  --post-->      (posted, posted_at = now)   one statement
--       (posted, when)  --void-->      (voided, posted_at = when)  001's carve-out
--
--     and nothing else. `post_sale` is the only writer of this table in the
--     application — `post_credit_memo` writes `sales_credit_memos`, a separate
--     family — it INSERTs `'draft', NULL` and promotes with a SINGLE
--     `UPDATE sales SET status = 'posted', posted_at = ?`, which is true of
--     every committed version of the file (checked at 5bc99cd, 2604d8c and
--     f5939b5). So posting is already atomic in one statement and needs no
--     change to be compatible with the contract below.
--
--     The admissible pairs follow from that machine:
--
--       status = 'draft'   =>  posted_at IS NULL        (the build state)
--       status = 'posted'  =>  posted_at IS NOT NULL    (the money is real)
--       status = 'voided'  =>  either                   (see below)
--
--     `'voided'` is deliberately left unconstrained in BOTH directions. A
--     voided sale keeps the `posted_at` it was posted with — 001's carve-out
--     requires `NEW.posted_at = OLD.posted_at` precisely so a void preserves
--     when the sale happened — and a future "discard this draft" flow would
--     legitimately void a row that was never posted. Neither shape is
--     financially recognised: every read model filters `'posted'`, so a voided
--     row is invisible to all 37 of them whatever its timestamp says. Guessing
--     at a rule for a state no command reaches would be inventing a constraint,
--     not enforcing one.
--
--
--     A SALE IS BORN A DRAFT. The INSERT rule is the strong one and it is
--     stated as a shape rather than as a list of things not to do: no sale may
--     be inserted in any state but `draft` with no `posted_at`. That closes
--     the INSERT bypass completely instead of trying to validate it — and it
--     has to, because validating a posted INSERT is not possible in principle:
--     a sale's lines and its evidence reference the sale, so at the moment the
--     header is inserted there is nothing to check, and afterwards 012's
--     `trg_sale_items_no_insert_after_post` refuses to let the lines arrive.
--     An INSERT that arrived already posted could therefore only ever be an
--     empty receipt whose header columns claim whatever revenue its author
--     typed. Supplying both `status = 'posted'` AND a timestamp is not a way
--     round this: it is the shape being refused.
--
--     NO SALE GOES BACKWARDS. Once a row is posted by either marker, clearing
--     `posted_at`, rewriting it, or returning `status` to `'draft'` is
--     refused. Migration 001 already refuses most of this through
--     `OLD.posted_at IS NOT NULL`; what it could not see was the malformed row
--     whose `posted_at` was never set, which is exactly the row this section
--     makes unreachable.
--
--     ORDER-INDEPENDENCE. SQLite does not define the firing order of two
--     BEFORE UPDATE triggers on one table, so nothing here depends on it: this
--     trigger refuses the incoherent STATES and section 6 validates the MONEY,
--     each complete on its own, and both must pass for the statement to
--     succeed. The two overlap on purpose at the one transition that matters.
--
--     LEGACY DATA IS NOT REWRITTEN. Both rules are BEFORE triggers, so they
--     bind writes from the moment this migration applies and touch no existing
--     row. A database that somehow already holds `status = 'posted'` with
--     `posted_at IS NULL` keeps it — and can REPAIR it, because supplying the
--     missing `posted_at` is an UPDATE that satisfies rule 10e and runs
--     section 6's full validation on the way through. No shipped version of
--     `post_sale` can have produced such a row.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_sales_born_a_draft
BEFORE INSERT ON sales
FOR EACH ROW
WHEN NEW.status <> 'draft' OR NEW.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'A sale is created as a draft and promoted by posting it. A sale cannot be inserted already posted or voided: its lines and its cost evidence do not exist yet, so nothing could be validated, and a posted sale that never had lines is a receipt claiming revenue it cannot account for.'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_sales_posting_state_coherent
BEFORE UPDATE ON sales
FOR EACH ROW
BEGIN
  -- 10a. `posted` means the money is real, so it must carry its timestamp.
  --      This is the statement that kills `UPDATE sales SET status='posted'`.
  SELECT RAISE(ABORT, 'A posted sale must record when it posted. Set status and posted_at together, as posting does.')
  WHERE NEW.status = 'posted' AND NEW.posted_at IS NULL;

  -- 10b. ...and a draft must not carry one, or `posted_at` becomes a figure
  --      with no status behind it and the two markers disagree the other way.
  SELECT RAISE(ABORT, 'A draft sale cannot carry a posting time. A sale that has posted is not a draft.')
  WHERE NEW.status = 'draft' AND NEW.posted_at IS NOT NULL;

  -- 10c. No un-posting by clearing the timestamp.
  SELECT RAISE(ABORT, 'A posted sale cannot have its posting time cleared. Issue a credit memo instead.')
  WHERE (OLD.posted_at IS NOT NULL OR OLD.status = 'posted')
    AND NEW.posted_at IS NULL;

  -- 10d. No un-posting by reverting the status.
  SELECT RAISE(ABORT, 'A posted sale cannot be returned to a draft. Issue a credit memo instead.')
  WHERE (OLD.posted_at IS NOT NULL OR OLD.status = 'posted')
    AND NEW.status = 'draft';

  -- 10e. No re-finalisation: the posting time is written once. A row whose
  --      `posted_at` is NULL is exempt, which is the documented repair path
  --      for a malformed legacy row — and that UPDATE runs section 6's full
  --      validation, because it moves `posted_at` from NULL.
  SELECT RAISE(ABORT, 'A sale''s posting time is written once and never rewritten.')
  WHERE OLD.posted_at IS NOT NULL
    AND NEW.posted_at <> OLD.posted_at;

  -- 10f. A posted sale's STATUS may only become 'voided' — 001's carve-out,
  --      restated against the status marker so a malformed row cannot be
  --      edited freely either. 001 permits the void and constrains the id, the
  --      receipt number, the total and `posted_at`; this adds nothing to that
  --      and only refuses the transitions 001 could not see.
  SELECT RAISE(ABORT, 'A posted sale''s status may only change to voided.')
  WHERE OLD.status = 'posted'
    AND NEW.status <> 'posted'
    AND NEW.status <> 'voided';
END;
