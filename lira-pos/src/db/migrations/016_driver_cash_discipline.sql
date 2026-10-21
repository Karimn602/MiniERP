-- ============================================================================
-- Migration v16 — driver remittances are DRAWER events (WP-7)
-- ----------------------------------------------------------------------------
-- WHAT CHANGED, AND WHY THIS IS A NEW MIGRATION RATHER THAN AN EDIT
--
-- Migration 015 recorded an open product decision at the bottom of the file:
-- a driver remittance stored the currency and amount that physically arrived,
-- but was NOT counted in the expected-drawer figure `close_shift` reconciles
-- against. That was the same position WP-05 took for supplier payments, and it
-- was deliberately left for the owner to decide.
--
-- The owner has now decided: **the driver returns the food payment to the
-- cashier's normal cash drawer.** So a remittance is a drawer event, it needs
-- an open shift to land in, and the expected cash figure has to include it.
--
-- 015 is additive and already applied to a disposable database, so this is a
-- NEW migration rather than an amendment of it. Three reasons, in order of
-- weight:
--
--   1. The 014-to-15 upgrade now has a populated regression test pinned
--      against it (`tests/migrations.rs`). Amending 015 would change the thing
--      that test exists to certify.
--   2. A rule about what may be WRITTEN FROM NOW ON belongs in its own dated
--      step. That is the policy migrations 009 and 010 set, and the reason is
--      the same: a shop's history is not ours to restate, and a reader needs
--      to see when a rule started applying.
--   3. 015 is unshipped but not unused. Amending it would have meant
--      destroying the WP-6 disposable database to re-run it, and "delete the
--      evidence so the migration applies cleanly" is the wrong instinct to
--      build into this project.
--
-- WHAT IS NOT CHANGED
--
-- The delivery FEE still does not touch the drawer, revenue, VAT or the
-- receivable, and its tax treatment is still an open question. A driver who
-- collected $17 — $15 of food and $2 of his own delivery charge — remits $15,
-- and $15 is what the till expects. The $2 was never the shop's.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. A remittance lands in a shift, and in the right store's shift.
--
--    `shift_id` stays NULLABLE in the column definition, exactly as
--    `sales.shift_id` did after migration 009: the rule governs writes from
--    here on, and any 015-era row that predates it stands as recorded. The
--    guard is a trigger on INSERT for that reason — a NOT NULL column would
--    have required rewriting history, and `driver_ledger` is append-only.
--
--    A remittance with no shift is cash that reached no till: no drawer count
--    could ever reconcile against it, which is precisely the hole that made
--    `sales.shift_id` mandatory for new sales in WP-04.
--
--    `collection`, `return_credit` and `adjustment` are deliberately NOT
--    required to name a shift. A collection moves no cash (the money is in the
--    driver's pocket), a return credit moves no cash, and an adjustment is a
--    signed-off correction that may be made by a manager outside trading
--    hours. Only the remittance is a till event.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_remittance_needs_shift
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
    'A driver remittance must name a shift of its own store.'
  )
  WHERE NEW.shift_id IS NOT NULL
    AND NEW.store_id IS NOT (SELECT store_id FROM shifts WHERE id = NEW.shift_id);
END;

-- The drawer figure is "this store, this shift, remittances only", and
-- `close_shift` runs it on every close. Ordered to match that access path.
CREATE INDEX IF NOT EXISTS idx_driver_ledger_shift_remittance
  ON driver_ledger (store_id, shift_id, entry_type)
  WHERE shift_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. A return credit may NOT drive a driver's balance below zero.
--
--    This is the structural half of the refund-source rule (WP-7 §5), and it
--    is here rather than only in `post_credit_memo` because an immutable
--    append-only ledger gives no second chance: a row that overshot could
--    never be removed, only offset by an entry that misstates something else.
--
--    WHY A NEGATIVE BALANCE IS WRONG *HERE* SPECIFICALLY
--
--    A driver's balance answers one question: how much of the shop's money is
--    in his pocket. A return credit says "he owes less, because goods came
--    back". That claim is only true while he is still HOLDING the money. Once
--    he has remitted it, the cash is in the drawer — the shop has it — and
--    crediting him again would assert the shop owes him money it never took
--    from him. The refund is real, but its payer is the till, not the driver.
--
--    So the honest answer at the point the two cannot be told apart is to
--    REFUSE, and `post_credit_memo` refuses first with a message that names
--    the amount already remitted and tells the operator a manager decision is
--    required. This trigger is what makes the rule true for any other writer.
--
--    `adjustment` is deliberately exempt and stays bidirectional: a shop
--    genuinely can end up owing a driver, and an adjustment is the signed-off
--    instrument for recording that a human decided it. The difference between
--    the two is the whole point — one is automatic, one is accountable.
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_no_automatic_negative
BEFORE INSERT ON driver_ledger
FOR EACH ROW
WHEN NEW.entry_type = 'return_credit'
BEGIN
  SELECT RAISE(
    ABORT,
    'This return would leave the driver owed money by the shop. The food payment has already been remitted, so the refund comes from the drawer and needs a manager decision.'
  )
  WHERE (
    COALESCE((SELECT SUM(amount_cents) FROM driver_ledger WHERE driver_id = NEW.driver_id), 0)
    + NEW.amount_cents
  ) < 0;
END;


-- ----------------------------------------------------------------------------
-- 3. A read-side view: what each shift is holding from its drivers.
--
--    Read-only, and summed from the same rows `close_shift` reconciles
--    against, so the figure on the shift screen and the figure in the
--    reconciliation cannot drift apart. The NATIVE amounts are what the drawer
--    physically holds — dollars as dollars and lira as lira — and the USD
--    equivalent is carried alongside for the reports that total in one
--    currency. Mixing the two is how a till count comes to disagree with a
--    ledger.
-- ----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS shift_driver_cash AS
SELECT
  l.store_id                                     AS store_id,
  l.shift_id                                     AS shift_id,
  COUNT(*)                                       AS remittance_count,
  COALESCE(SUM(l.received_native_usd_cents), 0)   AS remitted_usd_cents,
  COALESCE(SUM(l.received_native_lbp), 0)         AS remitted_lbp,
  -- Stored negative (a remittance pays the balance down), so the magnitude is
  -- negated once, here, rather than at each reader.
  COALESCE(SUM(-l.amount_cents), 0)               AS remitted_usd_equivalent_cents
FROM driver_ledger l
WHERE l.entry_type = 'remittance'
  AND l.shift_id IS NOT NULL
GROUP BY l.store_id, l.shift_id;
