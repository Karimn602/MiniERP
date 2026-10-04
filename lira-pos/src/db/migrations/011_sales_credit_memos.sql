-- ============================================================================
-- Migration v11 — sales returns / credit memos (GP-A08, WP-06)
-- ----------------------------------------------------------------------------
-- A credit memo (cashier-facing: "Return / Refund") reverses part or all of a
-- POSTED sale. It refunds the customer and, line by line, may or may not put
-- the goods back on the shelf.
--
-- WHY DEDICATED TABLES AND NOT NEGATIVE SALES
--
--   * `sale_items.quantity` is `CHECK (quantity > 0)` and every
--     `sale_payments` amount is `CHECK (>= 0)`. A negative sale would either
--     violate those or force them to be weakened — and they are load-bearing:
--     `post_sale` and every report are written on top of them.
--   * Every report, shift summary and drawer query in the application filters
--     `status = 'posted'` WITHOUT filtering `sale_type`. Folding returns into
--     `sales` would silently change the meaning of every one of them, with the
--     wrong sign, on the day this migration ships.
--   * A posted sale is immutable by trigger (migration 001) and WP-02 made the
--     register idempotent on `sales.id`. Returns must not reopen either rule.
--
-- So returns are layered ADDITIVELY: the sale stands exactly as recorded, and
-- "not returned / partially returned / fully returned" is DERIVED by summing
-- the credit-memo lines that point at it. `sales.sale_type = 'credit_memo'`
-- and `sales.original_sale_id` stay in the schema, unused, exactly as
-- migration 001 left them.
--
-- CONVENTIONS, unchanged from the rest of the schema:
--   * TEXT UUID primary keys; money is INTEGER (USD cents / whole lira).
--   * A UNIT COST is a RATE and is carried in MICROCENTS beside a rounded
--     cents mirror (migration 008). A credit-memo line snapshots the ORIGINAL
--     sale's COGS rate, never today's.
--   * `posted_at IS NOT NULL` ⇒ the row is immutable; triggers enforce it.
--   * Corrections are new rows, never edits.
--
-- EVERY AMOUNT ON A CREDIT MEMO COMES FROM THE ORIGINAL POSTED SALE SNAPSHOT.
-- Nothing is recomputed from today's price, VAT rate, product settings,
-- inventory cost or exchange rate. See `posting.rs::post_credit_memo`.
--
-- Nothing is dropped, no table is rebuilt, and no posted sale, movement or
-- ledger row is read back, rewritten or deleted.
--
-- NEVER edit this file after shipping. Add a new migration instead.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. SALES_CREDIT_MEMOS — the header of one return document.
--
--    `id` is the RETURN IDENTITY and the caller mints it once, exactly as
--    `sales.id` is the checkout identity (WP-02, GP-A01): replaying it
--    reconciles to the memo that already posted instead of refunding twice.
--
--    `shift_id` is nullable in the schema and REQUIRED by the command for a
--    new memo — the same split WP-04 made for `sales.shift_id`, and for the
--    same reason: the rule governs what may be written from now on, while a
--    replay of an already-posted memo must keep resolving after its shift has
--    been closed and counted.
--
--    The exchange rate is the ORIGINAL SALE's locked rate, copied here so a
--    credit-memo receipt reprints with the rate the transaction was priced at.
--    Refund economics belong to the original sale; today's rate never changes
--    the USD equivalent of a historical one.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_memos (
  id                        TEXT PRIMARY KEY,
  store_id                  TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  original_sale_id          TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,

  -- Human-friendly sequential number per store, assigned inside the posting
  -- transaction from `app_settings.next_credit_memo_number`.
  credit_memo_number        INTEGER NOT NULL,

  -- The shift whose drawer this refund moves. Cash refunds reduce that
  -- shift's expected cash; card refunds do not.
  shift_id                  TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
  device_id                 TEXT REFERENCES devices(id) ON DELETE SET NULL,
  cashier_user_id           TEXT REFERENCES users(id) ON DELETE RESTRICT,

  -- Copied from the original sale. NOT re-resolved from today's rates.
  exchange_rate_lbp_per_usd INTEGER NOT NULL CHECK (exchange_rate_lbp_per_usd > 0),
  exchange_rate_id          TEXT REFERENCES exchange_rates(id) ON DELETE RESTRICT,

  reason                    TEXT,

  -- Totals (USD cents), summed from the lines this memo actually wrote. Each
  -- line's subtotal and VAT are prorated on their own cumulative series and its
  -- total is their sum, so subtotal + vat = total holds for every memo and the
  -- three columns each reverse the original line exactly across every memo of
  -- it.
  subtotal_excl_vat_cents   INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_excl_vat_cents >= 0),
  vat_total_cents           INTEGER NOT NULL DEFAULT 0 CHECK (vat_total_cents >= 0),
  discount_cents            INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_incl_vat_cents      INTEGER NOT NULL DEFAULT 0 CHECK (total_incl_vat_cents >= 0),

  -- COGS put BACK into inventory — the restocked portion only. A line refunded
  -- but written off (damaged food) contributes 0: the cost stays consumed.
  cogs_reversed_cents       INTEGER NOT NULL DEFAULT 0 CHECK (cogs_reversed_cents >= 0),

  -- USD-cent equivalent of every refund leg at the locked rate. Equal to
  -- `total_incl_vat_cents` exactly — there is no unpaid-credit model.
  refund_total_usd_cents    INTEGER NOT NULL DEFAULT 0 CHECK (refund_total_usd_cents >= 0),

  status                    TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','posted','voided')),

  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- posted_at IS NOT NULL ⇒ this memo and its children are immutable.
  posted_at                 TEXT,
  voided_at                 TEXT,
  voided_by_user_id         TEXT REFERENCES users(id) ON DELETE RESTRICT,
  void_reason               TEXT,

  notes                     TEXT,
  UNIQUE (store_id, credit_memo_number)
);
CREATE INDEX IF NOT EXISTS idx_credit_memos_store_posted ON sales_credit_memos(store_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_memos_original     ON sales_credit_memos(original_sale_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_memos_shift        ON sales_credit_memos(shift_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_memos_status       ON sales_credit_memos(store_id, status);


-- ----------------------------------------------------------------------------
-- 2. SALES_CREDIT_MEMO_LINES — the returned lines.
--
--    Each one names exactly one `sale_items` row, and `(original_sale_item_id,
--    quantity_base)` summed over POSTED memos is what bounds over-returning.
--
--    `quantity_base` is canonical: it is the unit `sale_items.quantity` and
--    `inventory_movements.quantity_delta` are in, so it is the one quantity the
--    over-return bound, the stock movement and the money proration all speak.
--    `quantity_in_uom` plus the factor snapshot are the original line's own
--    display units, copied so a credit-memo receipt reads like the receipt it
--    reverses ("1 box", not "12").
--
--    MONEY IS PRORATED CUMULATIVELY, never per-memo independently:
--
--        cumulative(q) = round(original_component × q ÷ original_quantity)
--        this memo     = cumulative(already_returned + returning)
--                        − cumulative(already_returned)
--
--    which is what makes several partial returns of one line add up to the
--    original line EXACTLY, with no penny drift.
--
--    AND IT IS APPLIED COMPONENT BY COMPONENT. `line_subtotal_excl_vat_cents`,
--    `line_vat_cents` and `line_discount_cents` each get their OWN cumulative
--    series, taken from the figure the SALE persisted, and
--    `line_total_incl_vat_cents` is the SUM of the subtotal and VAT slices. The
--    total is never prorated on its own, and VAT is never the residual
--    `total − subtotal`.
--
--    That residual WAS the first design and it is unsound: the total series and
--    the subtotal series are each monotone, but their difference is not, so the
--    two roundings can move opposite ways on one step. An 11-cent, 3-unit line
--    of 10 net + 1 VAT gives cumulative totals 4, 7, 11 against cumulative
--    subtotals 3, 7, 10 — so the second unit's residual VAT is 3 − 4 = −1, and
--    `line_vat_cents`'s own CHECK (>= 0) below would refuse a return the
--    customer was entitled to. Per component, both originals are non-negative,
--    so both series are monotone and every slice is non-negative; and each
--    lands exactly on its own original at full return, so their sum lands
--    exactly on the line total. See `posting.rs::prorated_cumulative_cents`.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_memo_lines (
  id                            TEXT PRIMARY KEY,
  credit_memo_id                TEXT NOT NULL REFERENCES sales_credit_memos(id) ON DELETE RESTRICT,
  store_id                      TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  original_sale_item_id         TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  product_id                    TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Snapshots, copied verbatim from the ORIGINAL sale line. Frozen.
  product_name_snapshot         TEXT NOT NULL,
  product_sku_snapshot          TEXT,
  vat_rate_id_snapshot          TEXT NOT NULL REFERENCES vat_rates(id) ON DELETE RESTRICT,
  vat_rate_bps_snapshot         INTEGER NOT NULL,

  quantity_base                 INTEGER NOT NULL CHECK (quantity_base > 0),
  quantity_in_uom               INTEGER NOT NULL CHECK (quantity_in_uom > 0),
  uom_code_snapshot             TEXT,
  factor_num_snapshot           INTEGER,
  factor_den_snapshot           INTEGER,

  unit_price_excl_vat_cents     INTEGER NOT NULL CHECK (unit_price_excl_vat_cents >= 0),
  unit_price_incl_vat_cents     INTEGER NOT NULL CHECK (unit_price_incl_vat_cents >= 0),

  -- Each cumulatively prorated from the ORIGINAL line's own persisted figure;
  -- the total is the sum of the other two, so subtotal + vat = total holds by
  -- construction rather than by a third rounding that might not agree.
  line_subtotal_excl_vat_cents  INTEGER NOT NULL CHECK (line_subtotal_excl_vat_cents >= 0),
  line_vat_cents                INTEGER NOT NULL CHECK (line_vat_cents >= 0),
  line_total_incl_vat_cents     INTEGER NOT NULL CHECK (line_total_incl_vat_cents >= 0),
  -- The returned share of the ORIGINAL line's persisted discount allocation.
  -- Today's discount is never redistributed.
  line_discount_cents           INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_cents >= 0),

  -- The ORIGINAL sale's COGS rate for this line, in microcents — the rate the
  -- goods left inventory at, and therefore the rate they come back at.
  -- Snapshotted whether or not this line restocks, because it is evidence
  -- about the original sale either way.
  unit_cogs_excl_vat_microcents INTEGER NOT NULL DEFAULT 0,
  -- Rounded display mirror of the rate above. Never feeds a calculation.
  unit_cogs_excl_vat_cents      INTEGER NOT NULL DEFAULT 0,
  -- The COGS this line actually reversed, as money. ZERO when the line does
  -- not restock: discarded goods did not come back into inventory and their
  -- cost stays consumed.
  line_cogs_excl_vat_cents      INTEGER NOT NULL DEFAULT 0 CHECK (line_cogs_excl_vat_cents >= 0),

  -- Whether the ORIGINAL sale line moved physical stock. Determined from the
  -- existence of its 'sale' inventory movement, not from `products.is_service`
  -- as it reads today: whether the goods left the shelf in the first place is
  -- a fact about that sale, and a product reclassified since cannot change it.
  is_service                    INTEGER NOT NULL DEFAULT 0 CHECK (is_service IN (0,1)),

  -- Whether this line put the goods back. Always 0 for a non-stock line.
  return_to_stock               INTEGER NOT NULL DEFAULT 1 CHECK (return_to_stock IN (0,1)),

  -- The 'return_in' movement this line created; NULL when it did not restock.
  related_movement_id           TEXT REFERENCES inventory_movements(id) ON DELETE RESTRICT,

  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- A non-stock line can never restock, and a line that did not restock can
  -- never have reversed cost or produced a movement.
  CHECK (is_service = 0 OR return_to_stock = 0),
  CHECK (return_to_stock = 1 OR line_cogs_excl_vat_cents = 0),
  CHECK (return_to_stock = 1 OR related_movement_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_credit_memo_lines_memo      ON sales_credit_memo_lines(credit_memo_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_lines_orig_item ON sales_credit_memo_lines(original_sale_item_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_lines_product   ON sales_credit_memo_lines(product_id);


-- ----------------------------------------------------------------------------
-- 3. SALES_CREDIT_MEMO_REFUNDS — one row per refund tender, shaped like
--    `sale_payments` so the two can be summed against each other.
--
--    `store_credit` IS DELIBERATELY ABSENT from the method list. Greaz has no
--    customer-credit or customer-wallet ledger, so a store-credit refund would
--    be a liability recorded nowhere — money the shop owes a customer with no
--    row saying so, no balance to spend it against, and no way to reconcile it.
--    `sale_payments` still permits the method (migration 001), so a sale could
--    in principle carry one; such a sale simply cannot be refunded through it,
--    and that is the honest outcome until a customer ledger exists.
--
--    There is no `change_given_*` pair. A refund hands back a fixed amount
--    agreed to the cent; there is nothing to make change from.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_memo_refunds (
  id                          TEXT PRIMARY KEY,
  credit_memo_id              TEXT NOT NULL REFERENCES sales_credit_memos(id) ON DELETE RESTRICT,
  store_id                    TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  method                      TEXT NOT NULL CHECK (method IN (
                                'cash_usd','cash_lbp','card_usd','card_lbp',
                                'bank_transfer','wallet','other'
                              )),
  currency                    TEXT NOT NULL CHECK (currency IN ('USD','LBP')),

  amount_native_usd_cents     INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_usd_cents >= 0),
  amount_native_lbp           INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_lbp >= 0),

  -- USD-cent equivalent at the ORIGINAL SALE's locked rate. Derived by the
  -- posting command, never taken from the caller.
  amount_usd_cents_equivalent INTEGER NOT NULL CHECK (amount_usd_cents_equivalent > 0),

  reference                   TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Exactly one native amount is meaningful, and it matches the currency.
  CHECK ((amount_native_usd_cents > 0 AND currency = 'USD' AND amount_native_lbp = 0)
      OR (amount_native_lbp > 0 AND currency = 'LBP' AND amount_native_usd_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_credit_memo_refunds_memo  ON sales_credit_memo_refunds(credit_memo_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_refunds_store ON sales_credit_memo_refunds(store_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- 4. Link an inventory movement back to the credit memo that caused it.
--    Symmetric with `related_purchase_id` / `related_sale_id`.
--
--    `related_sale_id` is deliberately NOT set on a return movement, even
--    though the original sale is one join away through the memo line. WP-02
--    rebuilds a replayed sale's result from `inventory_movements WHERE
--    related_sale_id = ?`; a restock movement wearing that column would start
--    appearing in the movement list of the sale it reverses.
-- ----------------------------------------------------------------------------
ALTER TABLE inventory_movements ADD COLUMN related_credit_memo_id      TEXT
  REFERENCES sales_credit_memos(id) ON DELETE RESTRICT;
ALTER TABLE inventory_movements ADD COLUMN related_credit_memo_line_id TEXT
  REFERENCES sales_credit_memo_lines(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_inv_mov_credit_memo
  ON inventory_movements(related_credit_memo_id)
  WHERE related_credit_memo_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 5. A posted credit memo is SEALED — completely.
--
--    No UPDATE of any kind, no DELETE, and no new child row. The document and
--    its lines and refund legs are frozen the instant `posted_at` is set.
--
--    WHY THIS IS STRICTER THAN MIGRATION 001'S `sales` RULE
--
--    `trg_sales_no_update_after_post` carves out one transition: a posted sale
--    may become 'voided' provided a short list of columns is unchanged. That
--    carve-out exists because voiding a sale is a workflow somebody intends to
--    build, and it is survivable there because a void that is never written is
--    simply a feature that does not exist yet.
--
--    Copying it onto a credit memo was a mistake, for two reasons.
--
--    First, WP-06 HAS NO VOID COMMAND, and a posted credit memo has already
--    MOVED things: stock went back on the shelf, the weighted average was
--    re-blended at the returned cost, and cash left the drawer. Every read
--    model filters `status = 'posted'`, so flipping the status alone would make
--    the refund disappear from the reports, from the day's VAT and from the
--    shift's expected cash — while the goods, the cost basis and the money
--    stayed exactly where the memo put them. That is not a void; it is a hole
--    in the books that balances nowhere. Undoing a return needs COMPENSATING
--    ENTRIES — a reversing movement, a reversing cost blend, a reversing drawer
--    effect — and a future workflow that writes them belongs in its own
--    migration, which can relax this trigger in the same breath as it defines
--    them. Until then `voided` is unreachable, and the `status` CHECK, the
--    `voided_at` / `voided_by_user_id` / `void_reason` columns and the read
--    models' `status = 'posted'` filters are all RESERVED for it rather than
--    half-wired.
--
--    Second, a column list is a denylist worn as an allowlist. The one above
--    omitted `shift_id`, `cashier_user_id`, `exchange_rate_lbp_per_usd`,
--    `exchange_rate_id`, `reason` and `notes` — so the same statement that
--    voided a memo could re-point it at a different shift's drawer, re-attribute
--    it to a different cashier, or restate the rate it settled at. Enumerating
--    what may not change means every column added later is permitted by
--    default; refusing the UPDATE outright means none is.
--
--    Corrections follow the policy the rest of this schema follows: a new,
--    compensating document, never an edit to a settled one.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_credit_memos_no_update_after_post
BEFORE UPDATE ON sales_credit_memos
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted credit memo is immutable, including its status. Post a new compensating document instead of editing this one.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memos_no_delete_after_post
BEFORE DELETE ON sales_credit_memos
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted credit memo cannot be deleted.');
END;

-- A posted memo takes no FURTHER children. Insert is guarded as well as update
-- and delete, because adding a line to a settled document is not an edit to any
-- row that already exists and so slips past an update guard entirely: a
-- smuggled line would credit quantity against the original receipt, and a
-- smuggled refund leg would pay out money the memo does not owe, in both cases
-- without changing a single byte of what the posting command wrote.
--
-- The guard keys on the PARENT's `posted_at`, which is NULL for the whole of
-- `post_credit_memo`'s construction phase — the command inserts its header as a
-- draft, writes the lines, the movements, the line→movement links and the
-- refund legs, and promotes the header last. So the seal closes exactly when the
-- document becomes real, and not a statement earlier.

-- A posted memo takes no FURTHER children. Insert is guarded as well as update
-- and delete, because adding a line to a settled document is not an edit to any
-- row that already exists and so slips past an update guard entirely: a
-- smuggled line would credit quantity against the original receipt, and a
-- smuggled refund leg would pay out money the memo does not owe, in both cases
-- without changing a single byte of what the posting command wrote.
--
-- The guard keys on the PARENT's `posted_at`, which is NULL for the whole of
-- `post_credit_memo`'s construction phase — the command inserts its header as a
-- draft, writes the lines, the movements, the line-to-movement links and the
-- refund legs, and promotes the header last. So the seal closes exactly when the
-- document becomes real, and not a statement earlier.
CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_insert_after_post
BEFORE INSERT ON sales_credit_memo_lines
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = NEW.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted credit memo cannot take another line. Post a new return instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_insert_after_post
BEFORE INSERT ON sales_credit_memo_refunds
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = NEW.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted credit memo cannot take another refund leg. Post a new return instead.');
END;

-- A child UPDATE is judged on BOTH its parents, not just the one it came from.
--
-- `credit_memo_id` is an ordinary updatable column, so an UPDATE can MOVE a
-- child between documents. Checking only `OLD.credit_memo_id` therefore left
-- the seal open from the other side: create a line under a draft memo, then
-- re-point it at a memo that has already posted. The old parent is a draft, so
-- a one-sided guard waves it through — and the posted document grows a line it
-- did not post with, crediting quantity against the original receipt, without a
-- single INSERT into it and without touching any row that already belonged to
-- it. The refund table had the same hole, where a smuggled leg pays out money
-- the memo does not owe.
--
-- The rule is symmetric: a child may never be updated if doing so would mutate
-- a POSTED document, whether that document is the source or the destination.
-- `id IN (OLD.credit_memo_id, NEW.credit_memo_id)` states exactly that, and
-- collapses to the original check when the parent is unchanged.
--
-- Draft → draft stays allowed, and that is what `post_credit_memo`'s own
-- construction needs: it UPDATEs each line to link its restock movement while
-- the memo is still a draft, with `credit_memo_id` unchanged.
CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_update_after_post
BEFORE UPDATE ON sales_credit_memo_lines
WHEN EXISTS (
      SELECT 1 FROM sales_credit_memos
       WHERE id IN (OLD.credit_memo_id, NEW.credit_memo_id)
         AND posted_at IS NOT NULL
     )
BEGIN
  SELECT RAISE(ABORT, 'Lines of a posted credit memo are immutable, and a line cannot be moved into or out of one.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_delete_after_post
BEFORE DELETE ON sales_credit_memo_lines
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = OLD.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Lines of a posted credit memo cannot be deleted.');
END;

-- Same rule, same reason, for the refund legs.
CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_update_after_post
BEFORE UPDATE ON sales_credit_memo_refunds
WHEN EXISTS (
      SELECT 1 FROM sales_credit_memos
       WHERE id IN (OLD.credit_memo_id, NEW.credit_memo_id)
         AND posted_at IS NOT NULL
     )
BEGIN
  SELECT RAISE(ABORT, 'Refunds of a posted credit memo are immutable, and a refund leg cannot be moved into or out of one.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_delete_after_post
BEFORE DELETE ON sales_credit_memo_refunds
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = OLD.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Refunds of a posted credit memo cannot be deleted.');
END;


-- ----------------------------------------------------------------------------
-- 6. A return cannot exceed what the receipt sold, and cannot be filed against
--    the wrong receipt.
--
--    `post_credit_memo` checks both before it consumes a credit-memo number,
--    so the cashier gets a sentence they can act on. These are the backstop:
--    they bind every writer, including a direct SQL fix or a future importer,
--    and they bind the CONCURRENT case too. SQLite permits one write
--    transaction at a time and the sums below are evaluated inside the
--    transaction doing the writing, so a rival return either committed before
--    this transaction's read snapshot — and is counted — or it cannot commit
--    until this one ends, at which point its own trigger sees this one.
--
--    Memos in `draft` are counted alongside `posted` on purpose: a memo is
--    draft only for the instant between its header insert and its final
--    promotion inside one transaction, so counting drafts is what makes two
--    lines of the SAME memo unable to over-return between them.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_over_return
BEFORE INSERT ON sales_credit_memo_lines
BEGIN
  SELECT RAISE(ABORT, 'A credit memo line must reference an item of the memo''s own original sale.')
   WHERE (SELECT si.sale_id FROM sale_items si WHERE si.id = NEW.original_sale_item_id)
      IS NOT (SELECT m.original_sale_id FROM sales_credit_memos m WHERE m.id = NEW.credit_memo_id);

  SELECT RAISE(ABORT, 'A return cannot exceed the quantity the original sale line sold.')
   WHERE NEW.quantity_base
       + COALESCE((
           SELECT SUM(l.quantity_base)
             FROM sales_credit_memo_lines l
             JOIN sales_credit_memos m ON m.id = l.credit_memo_id
            WHERE l.original_sale_item_id = NEW.original_sale_item_id
              AND m.status IN ('draft','posted')
         ), 0)
       > COALESCE((SELECT si.quantity FROM sale_items si WHERE si.id = NEW.original_sale_item_id), 0);
END;


-- ----------------------------------------------------------------------------
-- 7. The credit-memo number sequence, alongside the receipt and purchase ones.
-- ----------------------------------------------------------------------------

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('next_credit_memo_number', '1');
