-- ============================================================================
-- Migration v9 — shift lifecycle integrity (GZ-HI-03)
-- ----------------------------------------------------------------------------
-- The application has always had exactly one shift scope: THE STORE.
--   * `shiftsRepo.getOpenShift(storeId)` selects on (store_id, status='open')
--   * `idx_shifts_store_status` indexes exactly that pair
--   * `shifts.device_id` has never been populated — `state/activeContext.ts`
--     hard-codes `deviceId: null` and no `devices` row is ever created
--   * the cashier is RECORDED (`opened_by_user_id`) but never scoped on: any
--     cashier may ring up against the store's open shift
--
-- That scope was enforced nowhere but in JavaScript, as a read followed by a
-- separate INSERT. Two tabs, two devices, or a double-click could each see "no
-- open shift" and then both insert one, after which `getOpenShift`'s
-- `ORDER BY opened_at DESC LIMIT 1` silently hides one of them — along with
-- every sale and every lira attributed to it.
--
-- This migration moves that invariant into the database. It does NOT invent a
-- different operating model: the uniqueness scope below is `store_id`, exactly
-- the scope the application already queries by.
--
-- Nothing is dropped, no table is rebuilt, and no posted sale, movement or
-- ledger row is touched.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Repair, so that step 2 can succeed on a database that already drifted.
--
--    A shop running an earlier release may already hold two or more open
--    shifts for one store — that is the defect. The unique index cannot be
--    created over them, so they have to be reconciled first, deterministically.
--
--    RULE: the most recently opened shift per store stays open; every older
--    open shift is marked closed. `closing_cash_*`, `expected_cash_*` and
--    `variance_*` are deliberately left NULL on those rows: nobody ever
--    counted that drawer, and inventing a count — or an expected figure to
--    compare a missing count against — would fabricate a reconciliation that
--    never happened. NULL is the truthful record of "never reconciled", and
--    `notes` says so in words.
--
--    Ties on `opened_at` are broken by `id` so the outcome is identical on
--    every machine that runs this migration against the same data.
--
--    The predicate is "close me if a strictly newer open shift exists for my
--    store", which is order-independent even though the statement updates the
--    table it reads: the newest open shift per store never satisfies it, so it
--    is never closed, so every older row keeps finding it whatever order the
--    scan visits rows in.
-- ----------------------------------------------------------------------------

UPDATE shifts
   SET status    = 'closed',
       closed_at = COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       notes     = COALESCE(notes || ' | ', '')
                   || 'Auto-closed by migration 009: a newer shift was open for '
                   || 'this store at the same time. Never cash-counted; '
                   || 'expected and counted cash are unknown.'
 WHERE status = 'open'
   AND EXISTS (
         SELECT 1
           FROM shifts newer
          WHERE newer.store_id = shifts.store_id
            AND newer.status   = 'open'
            AND (newer.opened_at > shifts.opened_at
                 OR (newer.opened_at = shifts.opened_at AND newer.id > shifts.id))
       );


-- ----------------------------------------------------------------------------
-- 2. One open shift per store, enforced by the engine.
--
--    A PARTIAL unique index is the right shape here: it constrains only the
--    rows whose status is 'open', so a store accumulates as many closed
--    (and voided) shifts as it likes while never holding two open ones. This
--    is what makes two concurrent opens resolve deterministically — one
--    commits, the other is refused by the engine rather than by a lost race
--    between two JavaScript reads.
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ux_shifts_one_open_per_store
  ON shifts(store_id)
  WHERE status = 'open';


-- ----------------------------------------------------------------------------
-- 3. A closed shift is immutable.
--
--    Closing a shift writes the cash reconciliation of a till that has already
--    been counted and locked. Re-closing it — a double-click, a retried
--    command, a stale tab — must not be able to overwrite the counted figures,
--    the variance, or who signed it off. Same rule, and the same idiom, as the
--    posted-sale and posted-purchase guards from migrations 001 and 005.
--
--    Corrections follow the same policy as the rest of this schema: a
--    reversing/adjusting record, never an edit to a settled one.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_shifts_no_update_after_close
BEFORE UPDATE ON shifts
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'A closed shift is immutable. Open a new shift instead of re-closing this one.');
END;
