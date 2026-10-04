-- ============================================================================
-- Migration v10 — supplier / accounts-payable integrity (GZ-HI-05)
-- ----------------------------------------------------------------------------
-- Three database-level guards behind the WP-05 posting rules. None of them
-- invents an accounting model: each one writes down, in the engine, a rule the
-- application already believed.
--
--   1. `purchases.supplier_reference_key` — the ONE canonical normalized form
--      of a supplier invoice reference, so "the same invoice" means the same
--      thing to the posting command, to the duplicate guard and to any query.
--
--   2. `trg_purchases_no_duplicate_supplier_invoice` — one supplier invoice
--      reference may be POSTED once per supplier per store. A second entry of
--      the same bill is a second payable for goods received once.
--
--   3. `trg_supplier_ledger_sign_discipline` — the sign convention migration
--      006 states in a comment, enforced. A payment row that carries a positive
--      amount would INCREASE the payable; the ledger is append-only and
--      immutable, so such a row could never be corrected, only offset.
--
-- Nothing is dropped, no table is rebuilt, and no posted purchase, movement or
-- ledger row is read back, rewritten or deleted. Every guard below constrains
-- writes from here on; history stands as recorded. That is the same policy
-- migration 009 took with `sales.shift_id`, and for the same reason: a shop's
-- books are not ours to restate.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The canonical normalized supplier reference.
--
--    A supplier invoice number is typed by a human off a paper bill, so
--    "INV-1024", "inv-1024" and " INV-1024 " are one document. The application
--    already has a convention for exactly this problem — migration 002's
--    `product_barcodes.lookup_value`, documented there as "trim + uppercase"
--    and computed by `lib/barcode.ts::normalizeBarcode` before every insert and
--    every lookup. This column is that same rule, applied to the other
--    human-typed document identifier in the schema.
--
--    GENERATED ... VIRTUAL rather than a column the posting command maintains:
--    the normalization then has exactly one definition, cannot drift from what
--    a writer remembers to compute, costs no storage, and needs no backfill —
--    which matters because backfilling a column on `purchases` would mean
--    lifting the posted-purchase immutability trigger over a shop's whole
--    purchase history.
--
--    NULLIF(..., '') is what keeps blank references from colliding: a purchase
--    with no supplier reference, or one whose reference is whitespace, has a
--    NULL key, and NULL is never equal to NULL. Opening-stock batches and
--    cash-and-carry receipts with nothing to quote therefore stay unconstrained,
--    however many of them a store records.
--
--    `TRIM` is given an explicit character set, because SQLite's one-argument
--    `TRIM` strips SPACES only — a reference pasted in with a trailing tab or
--    newline would not match the same reference typed by hand. char(9,10,13,32)
--    is tab, newline, carriage return and space, which is the whitespace
--    `String.prototype.trim()` strips on the JavaScript side of the same
--    convention (`lib/barcode.ts::normalizeBarcode`).
--
--    `UPPER()` here is SQLite's, which folds ASCII only. That is deliberate and
--    not a limitation worth working around: every rule below compares this
--    column against the SAME SQL expression applied to the incoming reference,
--    so both sides fold identically, and Arabic — the other script a Lebanese
--    supplier invoice is numbered in — is caseless.
-- ----------------------------------------------------------------------------

ALTER TABLE purchases ADD COLUMN supplier_reference_key TEXT
  GENERATED ALWAYS AS (NULLIF(TRIM(UPPER(supplier_reference), char(9,10,13,32)), '')) VIRTUAL;


-- ----------------------------------------------------------------------------
-- 2. Index behind the duplicate-invoice lookup and the trigger's EXISTS.
--
--    Scoped exactly as the rule is scoped — (store, supplier, key) over POSTED
--    purchases — so the probe `post_purchase` runs before it consumes a
--    purchase number is an index seek rather than a scan of every bill the shop
--    has ever received.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_purchases_supplier_reference_key
  ON purchases(store_id, supplier_id, supplier_reference_key)
  WHERE status = 'posted'
    AND supplier_id IS NOT NULL
    AND supplier_reference_key IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 3. One posted purchase per (store, supplier, supplier reference).
--
--    WHY A TRIGGER AND NOT A UNIQUE INDEX
--
--    A unique index is the stronger, declarative mechanism and would be the
--    first choice — but it is a statement about the rows that ALREADY exist as
--    much as about the next one. A shop running an earlier release could have
--    keyed the same invoice twice: nothing stopped it. `CREATE UNIQUE INDEX`
--    over that data fails, and this file is a startup migration, so the failure
--    is "the application will not open" for the one shop whose books are
--    already wrong. The only ways around it are to rewrite or delete one of two
--    real financial documents, which is exactly what this package is not
--    allowed to do.
--
--    A BEFORE trigger constrains only the write in front of it. Historical
--    duplicates stay visible and queryable, annotated by nothing, deleted
--    never — and the shop can no longer add a third.
--
--    It is not a weaker guarantee against the concurrent case. SQLite permits
--    one write transaction at a time, and the EXISTS below runs inside the
--    transaction that is doing the writing: a rival attempt either committed
--    before this transaction took its read snapshot — in which case the EXISTS
--    sees it and aborts — or it did not, in which case it cannot commit until
--    this transaction ends and its own EXISTS then sees this one. Two
--    simultaneous entries of one invoice cannot both commit.
--
--    Fires on INSERT and on UPDATE, because 'posted' is reached both ways:
--    `post_purchase` inserts a draft and promotes it in the same transaction,
--    while a direct writer or a future importer could insert a posted row
--    outright.
--
--    `NEW.supplier_reference_key` is NOT used: SQLite does not expose a VIRTUAL
--    generated column through NEW (it reads as NULL), so the key is recomputed
--    here from `NEW.supplier_reference` with the identical expression that
--    defines the column above. The two must stay in step; the test
--    `the_duplicate_guard_normalizes_exactly_as_the_stored_key_does` is what
--    holds them there.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_purchases_no_duplicate_supplier_invoice_ins
BEFORE INSERT ON purchases
WHEN NEW.status = 'posted'
 AND NEW.supplier_id IS NOT NULL
 AND NULLIF(TRIM(UPPER(NEW.supplier_reference), char(9,10,13,32)), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'This supplier invoice reference is already posted for this supplier. Look the existing purchase up instead of entering the bill twice.')
   WHERE EXISTS (
     SELECT 1 FROM purchases p
      WHERE p.id          <> NEW.id
        AND p.store_id     = NEW.store_id
        AND p.supplier_id  = NEW.supplier_id
        AND p.status       = 'posted'
        AND p.supplier_reference_key = NULLIF(TRIM(UPPER(NEW.supplier_reference), char(9,10,13,32)), '')
   );
END;

CREATE TRIGGER IF NOT EXISTS trg_purchases_no_duplicate_supplier_invoice_upd
BEFORE UPDATE ON purchases
WHEN NEW.status = 'posted'
 AND OLD.status <> 'posted'
 AND NEW.supplier_id IS NOT NULL
 AND NULLIF(TRIM(UPPER(NEW.supplier_reference), char(9,10,13,32)), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'This supplier invoice reference is already posted for this supplier. Look the existing purchase up instead of entering the bill twice.')
   WHERE EXISTS (
     SELECT 1 FROM purchases p
      WHERE p.id          <> NEW.id
        AND p.store_id     = NEW.store_id
        AND p.supplier_id  = NEW.supplier_id
        AND p.status       = 'posted'
        AND p.supplier_reference_key = NULLIF(TRIM(UPPER(NEW.supplier_reference), char(9,10,13,32)), '')
   );
END;


-- ----------------------------------------------------------------------------
-- 4. The supplier-ledger sign convention, enforced.
--
--    Migration 006 states it in prose: positive means we owe more, negative
--    means we owe less, and each entry type has a direction —
--
--      purchase        → +   goods received on credit
--      payment         → −   we paid the balance down
--      credit_note     → −   the supplier credited us
--      opening_balance → ±   a balance carried in from elsewhere
--      adjustment      → ±   a manual write-up or write-down, reason required
--
--    Prose is not a constraint. A payment written with a positive amount — a
--    caller that forgot the minus, a direct SQL fix, an importer — INCREASES
--    the payable, and since ledger rows are immutable and undeletable the shop
--    can only offset it, never remove it. The balance is `SUM(amount_cents)`,
--    so one such row silently corrupts every figure derived from it.
--
--    `post_supplier_payment` now derives the sign for the direction-fixed types
--    rather than trusting the caller's. This trigger is the backstop for
--    everything that does not come through it.
--
--    A purchase entry of exactly zero is allowed: a supplier invoice for free
--    goods is a real document (see `purchases.rs`'s zero-cost purchase test),
--    it creates no payable, and recording the truthful zero is better than
--    refusing the bill. The bidirectional types must be non-zero, because an
--    opening balance or an adjustment of nothing is not a correction anybody
--    meant to make.
--
--    The store check closes the other way a ledger row can misreport: a
--    supplier belongs to exactly one store, so an entry filed against a
--    different store's books would be counted by `listBalances(storeId)` for
--    one store and by the supplier's own balance for another. When the supplier
--    does not exist the subquery is NULL, `<>` on NULL is NULL, and the row
--    falls through to the foreign key — which is the error that case should
--    report.
-- ----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_supplier_ledger_sign_discipline
BEFORE INSERT ON supplier_ledger
BEGIN
  SELECT RAISE(ABORT, 'supplier_ledger: a purchase entry raises the payable and cannot be negative.')
   WHERE NEW.entry_type = 'purchase' AND NEW.amount_cents < 0;

  SELECT RAISE(ABORT, 'supplier_ledger: a payment pays the balance down and must be negative.')
   WHERE NEW.entry_type = 'payment' AND NEW.amount_cents >= 0;

  SELECT RAISE(ABORT, 'supplier_ledger: a credit note reduces the payable and must be negative.')
   WHERE NEW.entry_type = 'credit_note' AND NEW.amount_cents >= 0;

  SELECT RAISE(ABORT, 'supplier_ledger: an opening balance or adjustment of zero records nothing.')
   WHERE NEW.entry_type IN ('opening_balance', 'adjustment') AND NEW.amount_cents = 0;

  SELECT RAISE(ABORT, 'supplier_ledger: the entry must be filed against the supplier''s own store.')
   WHERE NEW.store_id <> (SELECT s.store_id FROM suppliers s WHERE s.id = NEW.supplier_id);
END;
