-- ============================================================================
-- Migration v17 — a remittance needs an OPEN shift, and a return credit needs
-- its own return (GZ-P1-3, GZ-P1-4)
-- ----------------------------------------------------------------------------
-- WHY A NEW MIGRATION RATHER THAN AN EDIT OF 016
--
-- 016 is already applied to databases: the WP-6 and WP-7 disposable identities
-- are at v16, and an edit to an applied migration does not re-run. A shop
-- upgrading from v16 would therefore keep the weaker trigger for ever, which is
-- the opposite of what a hardening change is for. sqlx would also refuse the
-- edited file outright, because it checksums what it applied.
--
-- The same reasoning 016 gave for not amending 015 applies here, in the same
-- order: 016 has a populated regression test pinned against it, a rule about
-- what may be WRITTEN FROM NOW ON belongs in its own dated step, and a shop's
-- history is not ours to restate. So this file REPLACES two guards and adds
-- one, and leaves every posted row exactly as it stands.
--
-- WHAT IS NOT CHANGED
--
-- No column is added, no row is rewritten, and nothing here applies to rows
-- that already exist. Both rules are BEFORE INSERT, so a remittance recorded
-- while its shift was open stands after that shift closes, and a return credit
-- written before this migration stands whatever it points at.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. A REMITTANCE MUST NAME AN **OPEN** SHIFT OF ITS OWN STORE (GZ-P1-3)
--
--    016 required a shift and required it to be the entry's own store's. What
--    it did not require was that the shift still be OPEN, and that is the part
--    that matters to the drawer:
--
--      * `close_shift` computes `expected_cash_usd_cents`, `expected_cash_lbp`
--        and the variances ONCE, inside the transaction that marks the shift
--        closed, and migration 009 makes a closed shift immutable afterwards.
--      * Expected drawer cash includes driver remittances (016).
--
--    So a remittance inserted against a closed shift increases the cash that
--    shift's drawer should have expected, on a row that can never be recomputed
--    and that nobody will ever recount. The variance already written becomes a
--    statement about a figure that is no longer true, and the cash sits in a
--    till whose reconciliation says it does not.
--
--    `post_driver_remittance` refuses this first, with a message a cashier can
--    act on. This is the same rule for every other writer — an import, a
--    script, a future screen, a second terminal — which is what makes it a
--    property of the books rather than of one code path.
--
--    DROP-then-CREATE rather than CREATE IF NOT EXISTS: on a v16 database the
--    weaker trigger is already there, and `IF NOT EXISTS` would silently keep
--    it. The DROP is of a guard, not of data.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_driver_ledger_remittance_needs_shift;

CREATE TRIGGER trg_driver_ledger_remittance_needs_shift
BEFORE INSERT ON driver_ledger
FOR EACH ROW
WHEN NEW.entry_type = 'remittance'
BEGIN
  SELECT RAISE(
    ABORT,
    'A driver remittance is cash into the drawer and must name an open shift of its store.'
  )
  WHERE NULLIF(TRIM(COALESCE(NEW.shift_id, ''), char(9,10,13,32)), '') IS NULL;

  -- The shift's store must be the entry's store. The foreign key only proves
  -- the shift exists somewhere; which store's drawer the cash lands in is the
  -- whole point of the row.
  SELECT RAISE(
    ABORT,
    'A driver remittance must name an open shift of its own store.'
  )
  WHERE NEW.store_id IS NOT (SELECT store_id FROM shifts WHERE id = NEW.shift_id);

  -- And it must still be open. `IS NOT` rather than `<>` so a shift that is
  -- not there at all fails here too rather than comparing against NULL.
  SELECT RAISE(
    ABORT,
    'That shift is closed. A driver remittance must name an open shift, because its cash is counted when the shift closes.'
  )
  WHERE (SELECT status FROM shifts WHERE id = NEW.shift_id) IS NOT 'open';
END;


-- ----------------------------------------------------------------------------
-- 2. A RETURN CREDIT COMES FROM **THIS DRIVER'S OWN** RETURN (GZ-P1-4)
--
--    Migration 015 proved the source of a COLLECTION: `related_sale_id` has to
--    name a sale whose own `driver_id` is this driver. It proved nothing about
--    `related_credit_memo_id`, so a `return_credit` could point at any credit
--    memo in the database and write down any driver's balance by it:
--
--      * another driver's return — moving one man's credit onto another's
--        balance, with a traceable link to a document that contradicts it;
--      * another store's return — two branches keep separate books, and 015's
--        sign-discipline trigger already insists an entry is filed against the
--        driver's own store;
--      * a COUNTER sale's return — nobody was carrying that money, so there is
--        no receivable for it to reduce. This is the reachable one: a memo of a
--        delivery order always carries its automatic credit and the
--        one-credit-per-memo index blocks a second, but a memo whose refund
--        took no `driver_collection` leg has no credit row at all and was
--        completely unguarded.
--
--    The amount caps do not help here. They bound the SIZE of a credit; they
--    say nothing about whose return justifies it. And `driver_ledger` is
--    append-only, so a row written against the wrong document can never be
--    removed — only offset by an entry that misstates something else.
--
--    Rule 3 is about the OTHER source column. `related_sale_id` is optional on
--    a return credit (`post_credit_memo` leaves it NULL), so an extraneous one
--    went unchecked: a row could name the right memo and the wrong receipt, and
--    the audit trail would then describe two different documents.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_return_credit_source
BEFORE INSERT ON driver_ledger
FOR EACH ROW
WHEN NEW.entry_type = 'return_credit'
BEGIN
  SELECT RAISE(
    ABORT,
    'driver_ledger: the related credit memo belongs to another store.'
  )
  WHERE NEW.store_id IS NOT (
    SELECT store_id FROM sales_credit_memos WHERE id = NEW.related_credit_memo_id
  );

  SELECT RAISE(
    ABORT,
    'driver_ledger: the related credit memo is not this driver''s own return.'
  )
  WHERE NEW.driver_id IS NOT (
    SELECT s.driver_id
      FROM sales_credit_memos m
      JOIN sales s ON s.id = m.original_sale_id
     WHERE m.id = NEW.related_credit_memo_id
  );

  SELECT RAISE(
    ABORT,
    'driver_ledger: a return credit may not name a sale its own memo does not reverse.'
  )
  WHERE NEW.related_sale_id IS NOT NULL
    AND NEW.related_sale_id IS NOT (
      SELECT original_sale_id FROM sales_credit_memos WHERE id = NEW.related_credit_memo_id
    );
END;
