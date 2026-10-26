-- ============================================================================
-- Migration v20 — manual standard cost per menu item (WP-B1)
-- ----------------------------------------------------------------------------
-- THE HOLE THIS CLOSES
--
-- Greaz can value things it BUYS AND COUNTS. It cannot value things it MAKES.
-- A burger assembled from a bun, a patty and sauce is, to this system, either
-- a stocked product nobody ever purchases (average cost 0) or a service
-- (average cost 0, because the only writer of `avg_cost_*` is a purchase).
-- Both report a 100% margin, and the demonstration menu says so in its own
-- test: "anyone reading a margin off this catalogue is reading the absence of
-- costing."
--
-- WP-B1 gives the owner the smallest honest answer: he types a plate cost. No
-- recipe, no ingredient tracking, no stock consumption. That is phase 1 of
-- `docs/COSTING-ARCHITECTURE.md`, and this migration is its whole schema.
--
-- WHAT IS ADDED — FOUR COLUMNS AND TWO TRIGGERS, NOTHING ELSE
--
--   products.costing_method                    — the per-item switch
--   products.standard_cost_excl_vat_microcents — the typed cost, as a RATE
--   products.standard_cost_set_at              — when it was last stated
--   sale_items.cogs_source                     — provenance of a posted rate
--
-- No table is created, no row is rewritten, no existing constraint is
-- tightened, and every product that exists today keeps the behaviour it has:
-- `costing_method` DEFAULTS to `'purchase_average'`, which is the weighted
-- average / last-purchase resolution `post_sale` already performs. Nothing
-- changes meaning on upgrade, which is the only acceptable shape for a change
-- to a table that posted documents reference.
--
-- WHY A RATE IN MICROCENTS AND NOT AN AMOUNT IN CENTS
--
-- A unit cost is money PER BASE UNIT, not an amount, and this codebase has one
-- convention for that: microcents, 1 cent = 1,000,000 microcents, with cost
-- arithmetic going through `cost.rs` / `lib/cost.ts` and money appearing
-- exactly once at `extended_cost_cents` — the precise rate times the base
-- quantity, rounded ONCE. `avg_cost_excl_vat_microcents` is that column's
-- sibling and `sale_items.unit_cogs_excl_vat_microcents` is where the rate
-- lands. A typed cost is the same kind of number, so it is stored the same
-- way; storing it in cents would make a sub-cent plate component round to
-- nothing before it was ever extended.
--
-- Unlike `avg_cost_*` there is NO rounded cents mirror. A mirror exists on the
-- average for back-compatibility with pre-migration-008 readers; this column
-- has no history and no second reader, and a second figure nobody needs is a
-- second figure that can disagree.
--
-- WHY EXCLUSIVE OF VAT, AND WHY THERE IS NO INCLUSIVE SIBLING
--
-- Every COGS figure any report in this application reads is exclusive of VAT:
-- `sale_items.unit_cogs_excl_vat_microcents`, `line_cogs_excl_vat_cents`,
-- `sales.cogs_total_cents`, and both margin series in `lib/reportMath.ts`. A
-- VAT-inclusive standard cost would therefore be a column with no reader, and
-- deriving one here would mean choosing a VAT rate for a cost the owner stated
-- net — a rounding decision with no document behind it. So the typed figure is
-- net, it is labelled net in the UI, and it is the only figure stored.
--
-- WHY `NULL` IS NOT ZERO
--
-- Three states, three different answers, and conflating them is how a margin
-- report lies:
--
--   NULL  — no cost has been configured. The owner has not answered yet.
--   0     — the owner deliberately asserts this item costs nothing.
--   > 0   — the stated cost.
--
-- The column is therefore nullable with a `>= 0` check rather than
-- `NOT NULL DEFAULT 0`, because a default of 0 would silently answer the
-- question on the owner's behalf for every product in the catalogue and there
-- would be no way afterwards to tell an assertion from an omission. Selecting
-- Manual Cost without stating a figure is REFUSED (below), not defaulted.
--
-- WHY MANUAL COST IS RESTRICTED TO NON-STOCK (SERVICE) ITEMS IN B1
--
-- This is the one restriction of this milestone and it is a financial
-- argument, not a scheduling one.
--
-- For a STOCKED product, the COGS rate is not just a reporting figure: it is
-- written onto the sale's `inventory_movements` row as
-- `unit_cost_excl_vat_microcents`, and that ledger is what makes stock
-- auditable. `quantity_on_hand` and `avg_cost_*` are maintained together by
-- the posting commands precisely so the quantity and the value of the shelf
-- agree. Let a manual rate cost a stocked line and the movement says the goods
-- left at $1.80 while the pool they left says $0.00 — the stock ledger and the
-- P&L then disagree permanently, with no document reconciling them, and an
-- append-only movement table means it can never be unwound.
--
-- A SERVICE line writes no movement, decrements no stock and touches no cost
-- pool (`post_sale` skips all three on `is_service`), so there is no second
-- figure for a manual rate to contradict. That makes the service case
-- financially closed and the stocked case financially open, and B1 ships only
-- the closed one. A restaurant's prepared menu items are exactly the service
-- case: nobody counts burgers in a freezer.
--
-- Valuing stocked items from a recipe of counted ingredients is WP-B2/B3's
-- job, and it is the honest answer for them, because there the cost comes WITH
-- a consumption document.
--
-- WHY `'recipe'` IS IN THE CHECK BUT REFUSED BY A TRIGGER
--
-- SQLite cannot ALTER a CHECK constraint. Widening one means the documented
-- table rebuild, and `products` is referenced by `sale_items`,
-- `purchase_items`, `inventory_movements`, `product_uoms`, `product_barcodes`
-- and `sales_credit_memo_lines` — a rebuild there is the single most dangerous
-- statement this codebase could run, for the sake of one enum value.
--
-- So the DOMAIN is stated once, now, with all three methods the architecture
-- document commits to; and the IMPLEMENTED SUBSET is enforced by a trigger,
-- which WP-B2 drops and recreates exactly as migration 017 replaced 016's
-- shift guard. `'recipe'` is unreachable today — the trigger refuses it on
-- insert and on update — so no row can be configured into a state `post_sale`
-- would not know how to cost.
--
-- WHY THE RULES ARE TRIGGERS AND NOT ONLY RUST
--
-- `save_product` refuses all three with friendlier messages, and it is the only
-- path the UI and the spreadsheet importer take. But `post_sale` resolves the
-- cost from the DATABASE, so the row's coherence is what the money depends on,
-- and a row is also reachable by an import, a script, a fixture and a second
-- terminal. The predicates are plain column comparisons with no subqueries,
-- which matters because `products` is UPDATEd by every sale (stock) and every
-- purchase (stock and cost): the triggers fire on those too, find
-- `costing_method = 'purchase_average'`, and cost nothing.
--
-- WHAT `sale_items.cogs_source` IS FOR
--
-- A margin report six months from now cannot otherwise say whether a line was
-- costed from documents or from somebody's opinion, and that is exactly the
-- distinction an owner needs when a margin looks wrong. It is PROVENANCE, not
-- arithmetic: no total is derived from it, no posting command reads it to
-- decide anything, and it is NOT part of the sale's canonical content — it is
-- derived by the backend from the product row, so a replay cannot carry a
-- different value and there is nothing for the idempotency comparison to
-- disagree about.
--
--   'standard'          the owner's typed cost (including a deliberate zero)
--   'purchase_average'  the product's weighted average
--   'last_purchase'     the most recent purchase/opening movement's rate
--   'uncosted'          NO costing basis existed: a service item with no
--                       manual cost. Today's silent zero, finally named.
--   'recipe'            reserved for WP-B2; unreachable (see above)
--   NULL                posted before this migration existed
--
-- NULL on every historical row is the truth about those rows, and it is why
-- the column is nullable: `sale_items` holds immutable posted documents and
-- not one of them is rewritten here.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. THE PER-ITEM SWITCH
--
--    NOT NULL with a default, so every existing row and every row written by
--    a caller that has never heard of this column lands on today's behaviour.
--    Nullable was considered and rejected: a NULL would mean "ask somewhere
--    else", and the entire point of the column is that one place answers the
--    question.
-- ----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN costing_method TEXT NOT NULL
  DEFAULT 'purchase_average'
  CHECK (costing_method IN ('purchase_average', 'standard', 'recipe'));


-- ----------------------------------------------------------------------------
-- 2. THE TYPED COST — a RATE per base unit, exclusive of VAT, in microcents.
--
--    NULL means "not configured" and is distinct from 0. See the header.
-- ----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN standard_cost_excl_vat_microcents INTEGER
  CHECK (standard_cost_excl_vat_microcents IS NULL
         OR standard_cost_excl_vat_microcents >= 0);


-- ----------------------------------------------------------------------------
-- 3. WHEN THE COST WAS LAST STATED
--
--    A standard cost is an ASSERTION BY A PERSON, unlike an average which is
--    derived from documents, so when it was made is part of reading it: a
--    plate cost stated eighteen months ago against today's prices is a number
--    worth doubting, and the Products screen shows this date for that reason.
--
--    There is deliberately NO `standard_cost_set_by_user_id`. This application
--    has no login, no session and no role check anywhere — `activeContext`
--    picks whichever `owner` row sorts first at boot — so such a column would
--    record a guess while LOOKING like attribution, which is the same defect
--    `UNVERIFIED_APPROVAL_PREFIX` exists to name. A timestamp is a fact; an
--    author here would be a claim. When authentication arrives, the column
--    arrives with it, in the same change as the audit row that makes it true.
-- ----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN standard_cost_set_at TEXT;


-- ----------------------------------------------------------------------------
-- 4. PROVENANCE ON A POSTED SALE LINE
--
--    Nullable, because every row that already exists was posted before this
--    feature and NULL is what that means. No index: the only reader is the
--    cost-coverage panel, which scopes by store and date through `sales` and
--    is served by the existing `idx_sale_items_sale`.
-- ----------------------------------------------------------------------------
ALTER TABLE sale_items ADD COLUMN cogs_source TEXT
  CHECK (cogs_source IS NULL
         OR cogs_source IN ('purchase_average', 'last_purchase',
                            'standard', 'recipe', 'uncosted'));


-- ----------------------------------------------------------------------------
-- 5. COHERENCE OF A PRODUCT'S COSTING CONFIGURATION
--
--    Three rules, each a plain column comparison:
--
--      a. Manual Cost requires a cost. Selecting the method and leaving the
--         figure blank must not post sales at zero under a configuration that
--         claims to have a cost.
--      b. Manual Cost requires a non-stock item (see the header's financial
--         argument).
--      c. `'recipe'` is not implemented. WP-B2 drops this trigger pair and
--         recreates it without rule (c).
--
--    A standard cost may be left on a product that has since gone back to
--    `purchase_average`: the figure is then simply not read, exactly as the
--    weighted average is not read by a `standard` product. Clearing a stated
--    cost is the owner's call, not a consequence of switching a switch, and
--    discarding it would lose an assertion he may want back.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_products_costing_coherence_ins
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
    'products: recipe costing is not implemented (WP-B2).'
  )
  WHERE NEW.costing_method = 'recipe';
END;

CREATE TRIGGER IF NOT EXISTS trg_products_costing_coherence_upd
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
    'products: recipe costing is not implemented (WP-B2).'
  )
  WHERE NEW.costing_method = 'recipe';
END;
