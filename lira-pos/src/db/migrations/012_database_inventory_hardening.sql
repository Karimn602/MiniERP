-- ============================================================================
-- Migration v12 — database & inventory hardening (WP-07)
-- ----------------------------------------------------------------------------
-- Three narrow gaps, all of the same shape, all found by auditing what DIRECT
-- SQL can still do to a settled document. None of them is reachable through
-- the application; each of them produces a state the application could never
-- produce, which is exactly what a database backstop is for.
--
--   1. A CLOSED SHIFT COULD BE DELETED. Migration 009 made it immutable
--      against UPDATE and stopped there.
--
--   2. A POSTED SALE COULD GAIN A LINE OR A PAYMENT. Migration 001 guards
--      `sale_items` and `sale_payments` against UPDATE and DELETE, but not
--      against INSERT — and its UPDATE guards look only at `OLD.sale_id`, so a
--      child could also be MOVED into (or out of) a posted sale.
--
--   3. A POSTED PURCHASE COULD GAIN A LINE, the same way, with the same
--      reparenting hole on `purchase_items`.
--
-- WP-06 found and closed exactly this pattern on credit memos. This migration
-- applies the finished shape to the two older document families.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
--   * `supplier_ledger` needs nothing. Migration 006 already refuses every
--     UPDATE and every DELETE unconditionally, so a liability can neither be
--     modified nor detached, and migration 010's sign discipline is a BEFORE
--     INSERT trigger — so a legitimate signed `adjustment` or `opening_balance`
--     is still an ordinary insert and still works. Append-only was already the
--     whole rule.
--   * `inventory_movements` needs nothing: migrations 001/008 make it
--     unconditionally append-only, which is stronger than anything here.
--   * No table is rebuilt, no column is added, no row is read back, rewritten
--     or deleted. Every guard below constrains writes from here on; history
--     stands as recorded, which is the policy migrations 009, 010 and 011 took.
--
-- NEVER edit this file after shipping. Add a new migration instead.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. A closed shift cannot be deleted.
--
--    Closing a shift writes a cash reconciliation somebody counted and signed
--    off: the opening float, the counted cash, the expected cash and the
--    variance. Migration 009 made that record immutable
--    (`trg_shifts_no_update_after_close`) but left DELETE open.
--
--    Foreign keys already protect a shift that has ACTIVITY —
--    `sales.shift_id` and `sales_credit_memos.shift_id` are both
--    `ON DELETE RESTRICT`, so a shift with a sale or a refund against it cannot
--    be removed. The gap is the quiet one: a closed shift with no sales is pure
--    reconciliation evidence, and nothing stopped it from vanishing. A drawer
--    that was counted and found short is exactly the shift somebody might
--    prefer did not exist.
--
--    Scoped to CLOSED shifts on purpose. An open shift that was created by
--    mistake, before anything was rung up against it, is not yet a financial
--    record; `open_shift`/`close_shift` own that lifecycle and this migration
--    does not change it.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_shifts_no_delete_after_close
BEFORE DELETE ON shifts
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'A closed shift is a signed-off cash reconciliation and cannot be deleted.');
END;


-- ----------------------------------------------------------------------------
-- 2. A posted sale takes no further children, and cannot be reparented.
--
--    WHY INSERT NEEDS ITS OWN GUARD. Adding a line to a settled document is
--    not an edit to any row that already exists, so it slips past an UPDATE
--    guard entirely. A smuggled `sale_items` row changes what the receipt
--    sold — and therefore what is returnable against it, since WP-06 bounds a
--    return by `sale_items.quantity` — without touching a byte of what
--    `post_sale` wrote. A smuggled `sale_payments` row invents tender: it
--    inflates the drawer `close_shift` expects, and it hands a return a method
--    to refund through that nobody ever paid with.
--
--    WHY THE UPDATE GUARDS HAD TO BECOME SYMMETRIC. `sale_id` is an ordinary
--    updatable column, so an UPDATE can MOVE a child between documents.
--    Migration 001 tested `OLD.sale_id` alone, which left the seal open from
--    the destination side: insert a line under a draft sale, then re-point it
--    at a sale that has already posted. The old parent is a draft, so a
--    one-sided guard waves it through. `id IN (OLD.sale_id, NEW.sale_id)`
--    states the rule that was always meant — a child may never be updated if
--    doing so would mutate a POSTED document, whether that document is the
--    source or the destination — and collapses to the original check when the
--    parent is unchanged.
--
--    WHY `post_sale` NOW BUILDS A DRAFT. These guards key on the PARENT's
--    `posted_at`, so they are only expressible if the parent is not yet posted
--    while its children are being written. `post_purchase` and
--    `post_credit_memo` already inserted their header as a draft and promoted
--    it last; `post_sale` wrote `status = 'posted'` in its first statement and
--    then inserted children, so a parent-posted guard would have rejected
--    every sale in the application. WP-07 makes `post_sale` use the same
--    draft-then-promote sequence its two siblings use. That is a change of
--    write ORDER inside one transaction and nothing else: the draft exists only
--    between two statements of a transaction nobody else can observe, the
--    receipt number is still consumed exactly once, and a sale that fails
--    still leaves nothing at all.
--
--    The old one-sided triggers are DROPped rather than left beside the new
--    ones, because `CREATE TRIGGER IF NOT EXISTS` would silently keep the weak
--    version. Note for whoever writes the next migration: migration 008 also
--    drops and recreates `trg_sale_items_no_update_after_post` around its
--    backfill, so a future backfill that lifts these guards must restore the
--    SYMMETRIC version below, not migration 001's.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sale_items_no_update_after_post;
DROP TRIGGER IF EXISTS trg_sale_payments_no_update_after_post;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_no_insert_after_post
BEFORE INSERT ON sale_items
WHEN (SELECT posted_at FROM sales WHERE id = NEW.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted sale cannot take another line. Issue a credit memo instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_items_no_update_after_post
BEFORE UPDATE ON sale_items
WHEN EXISTS (
      SELECT 1 FROM sales
       WHERE id IN (OLD.sale_id, NEW.sale_id)
         AND posted_at IS NOT NULL
     )
BEGIN
  SELECT RAISE(ABORT, 'Sale items of a posted sale are immutable, and a line cannot be moved into or out of one.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_no_insert_after_post
BEFORE INSERT ON sale_payments
WHEN (SELECT posted_at FROM sales WHERE id = NEW.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted sale cannot take another payment. Issue a credit memo instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_no_update_after_post
BEFORE UPDATE ON sale_payments
WHEN EXISTS (
      SELECT 1 FROM sales
       WHERE id IN (OLD.sale_id, NEW.sale_id)
         AND posted_at IS NOT NULL
     )
BEGIN
  SELECT RAISE(ABORT, 'Payments of a posted sale are immutable, and a payment cannot be moved into or out of one.');
END;


-- ----------------------------------------------------------------------------
-- 3. A posted purchase takes no further lines, and cannot be reparented.
--
--    Same rule, same reasoning. A smuggled `purchase_items` row is worse than
--    its sales counterpart in one respect: the payable the purchase raised is
--    `SUM` of its lines' VAT-inclusive totals (WP-05), and the supplier-ledger
--    row that recorded it is immutable — so a line added afterwards makes the
--    purchase and the debt it raised permanently disagree, with no row anybody
--    can correct.
--
--    `post_purchase` already builds a draft and promotes it last, so the INSERT
--    guard needs no change on the Rust side. Its one child UPDATE — linking a
--    `purchase_items` row to the `inventory_movements` row it created — happens
--    while the purchase is still a draft and with `purchase_id` unchanged, so
--    the symmetric guard lets it through.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_purchase_items_no_update_after_post;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_no_insert_after_post
BEFORE INSERT ON purchase_items
WHEN (SELECT posted_at FROM purchases WHERE id = NEW.purchase_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted purchase cannot take another line. Enter a correcting document instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_items_no_update_after_post
BEFORE UPDATE ON purchase_items
WHEN EXISTS (
      SELECT 1 FROM purchases
       WHERE id IN (OLD.purchase_id, NEW.purchase_id)
         AND posted_at IS NOT NULL
     )
BEGIN
  SELECT RAISE(ABORT, 'Purchase items of a posted purchase are immutable, and a line cannot be moved into or out of one.');
END;


-- ----------------------------------------------------------------------------
-- 4. A credit-memo child never changes parent.
--
--    Migrations 011 and 012 seal a POSTED memo from both sides, but a DRAFT
--    child could still have its `credit_memo_id` rewritten — and the two rules
--    that give a memo line its meaning are checked only on INSERT:
--    `trg_credit_memo_lines_no_over_return` proves the line belongs to an item
--    of the memo's OWN original sale and that the quantity is still available.
--
--    So a line could be created under draft memo A, which is attached to the
--    sale the line really belongs to, and then moved under draft memo B, which
--    is attached to a different sale entirely. Both inserts were valid; neither
--    guard re-ran on the move. Promote B and it is a posted credit memo
--    crediting a receipt that never sold the goods.
--
--    THE SMALLEST RULE THAT CLOSES IT: once created, a child does not change
--    parent. Production never needs to — `post_credit_memo` writes each child
--    under the memo it belongs to and the only child UPDATE it performs is
--    setting `related_movement_id`, with `credit_memo_id` untouched — so
--    nothing is given up by forbidding it outright. That is cheaper and more
--    obviously correct than re-running the over-return and same-sale checks on
--    UPDATE, which would have to reason about a quantity that is already
--    counted under its current parent.
--
--    Draft-to-draft reparenting WAS permitted deliberately in WP-06, on the
--    argument that a draft is invisible to every read model. That argument was
--    wrong: a draft is one promotion away from being a financial document, and
--    the checks that would have caught the smuggled line do not run again.
--
--    These are separate triggers from the posted-parent guards above rather
--    than extra clauses inside them, so each refusal says which rule it was.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_lines_no_reparent
BEFORE UPDATE OF credit_memo_id ON sales_credit_memo_lines
WHEN NEW.credit_memo_id <> OLD.credit_memo_id
BEGIN
  SELECT RAISE(ABORT, 'A credit memo line belongs to the memo it was created under and cannot be moved to another.');
END;

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_reparent
BEFORE UPDATE OF credit_memo_id ON sales_credit_memo_refunds
WHEN NEW.credit_memo_id <> OLD.credit_memo_id
BEGIN
  SELECT RAISE(ABORT, 'A credit memo refund leg belongs to the memo it was created under and cannot be moved to another.');
END;
