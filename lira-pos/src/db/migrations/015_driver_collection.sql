-- ============================================================================
-- Migration v15 — driver collection and the driver clearing subledger (WP-6)
-- ----------------------------------------------------------------------------
-- THE BUSINESS PROCESS, as the founder confirmed it
--
-- An order arrives on WhatsApp. The cashier types it into the till like any
-- other order. Greaz assigns one of its OWN drivers and agrees a delivery
-- charge with the customer. The driver takes the food out, collects ONE amount
-- from the customer — food plus delivery — keeps the delivery charge, and
-- brings the food money back to the shop.
--
-- Two facts follow, and everything in this migration is downstream of them.
--
--   1. The food money is Greaz's revenue, but it is NOT in the drawer when the
--      sale posts. It is in the driver's pocket. That is a RECEIVABLE from the
--      driver, and it is extinguished later, when he hands cash over.
--
--   2. The delivery charge is NOT Greaz's money at all. It never enters the
--      shop. Under the stated arrangement it is the driver's, and the customer
--      pays it to him.
--
-- WHAT THIS REPLACES
--
-- Migration 014 shipped the channel column and said, correctly for what was
-- known then, that a delivery platform collecting from the customer and
-- settling later "genuinely is an accounts-receivable problem" which it would
-- not approximate. That problem is now specified, and it turned out NOT to be
-- a platform problem: there is no third party, no commission, no platform
-- settlement and no external receivable. The counterparty is an employee of the
-- shop holding the shop's cash. So the ledger this adds is deliberately much
-- smaller than the platform design 014 deferred, and the platform design is
-- cancelled rather than postponed.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No general ledger, no payroll, no driver commission, no GPS, no dispatch, no
-- customer messaging. A driver record is a name, a phone number and a balance.
--
-- AND ONE THING THAT IS NOT DECIDED
--
-- The VAT and invoice treatment of the delivery charge is an OPEN QUESTION for
-- Greaz's accountant, and this migration is built so that the answer can be
-- implemented without restating a single posted row. The charge is stored in
-- its own column, outside every total, and it is never VAT-rated, never summed
-- into revenue, and never turned into a sale line. If the accountant rules that
-- it is Greaz's supply (and so Greaz's output VAT), that becomes a product line
-- or a fee line in a later migration and the historical rows stay exactly as
-- recorded — a number the shop tracked, attributed to nobody's revenue. If the
-- accountant rules it is the driver's own income, nothing needs to change at
-- all. Guessing either way now would put the wrong VAT on real receipts.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. DRIVERS — the counterparty master record.
--
--    Shaped like `suppliers`, because it is the same kind of thing pointing the
--    other way: a party the shop has a running balance with. Kept to the four
--    fields the process actually needs.
--
--    `is_active` retires a driver without deleting him. A driver who has ever
--    held the shop's money must stay joinable forever — his name is on posted
--    receipts and on ledger rows — so there is no delete path, and the foreign
--    keys are RESTRICT to make that structural rather than a convention.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  name               TEXT NOT NULL,
  phone              TEXT,
  notes              TEXT,

  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- The canonical form of the name, by the same trim+uppercase convention
  -- migration 002 uses for `product_barcodes.lookup_value` and migration 010
  -- for `purchases.supplier_reference_key`. Two rows for "Ali" and "ali " are
  -- one driver, and one driver must have one balance or the balance means
  -- nothing.
  name_key           TEXT GENERATED ALWAYS AS
                       (NULLIF(TRIM(UPPER(name), char(9,10,13,32)), '')) VIRTUAL,

  CHECK (NULLIF(TRIM(name, char(9,10,13,32)), '') IS NOT NULL)
);

-- One driver of a given name per store. Scoped by store, like every other
-- master record here: two branches may each employ an Ali.
CREATE UNIQUE INDEX IF NOT EXISTS ux_drivers_store_name
  ON drivers(store_id, name_key);

CREATE INDEX IF NOT EXISTS idx_drivers_store_active
  ON drivers(store_id, is_active, name);


-- ----------------------------------------------------------------------------
-- 2. THE SALE SIDE — who carried it, and what the customer paid him for it.
--
--    `driver_id` is the assignment. It is mandatory for a driver-collected
--    sale and that is enforced in `post_sale`, not here, because the rule is
--    about the TENDER (see section 4) and a trigger on `sales` cannot see the
--    payment rows during a draft.
--
--    `delivery_fee_cents` IS NOT MONEY GREAZ RECEIVED. It is recorded so the
--    shop can tell the customer what the total was, see what its drivers are
--    charging, and hand the accountant a real figure. It is:
--
--      * NOT in `sales.subtotal_excl_vat_cents`, `vat_total_cents` or
--        `total_incl_vat_cents` — those stay exactly "the food", which is what
--        every existing report, shift summary and credit memo already means by
--        them, and what the driver therefore owes;
--      * NOT VAT-rated, because whose supply it is has not been ruled on;
--      * NOT a `sale_items` row, so it cannot reach COGS, inventory, a product
--        report or a margin;
--      * NOT in the driver's receivable, because he keeps it.
--
--    So "the customer paid" is `total_incl_vat_cents + delivery_fee_cents`, and
--    that addition is done in the places that display it and nowhere else.
--
--    USD cents, like every other money column (`lib/money.ts`). A fee agreed in
--    lira is converted at the sale's own locked rate by the caller, exactly as
--    a lira tender is.
-- ----------------------------------------------------------------------------
ALTER TABLE sales ADD COLUMN driver_id TEXT REFERENCES drivers(id) ON DELETE RESTRICT;
ALTER TABLE sales ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sales_driver_posted
  ON sales(driver_id, posted_at)
  WHERE driver_id IS NOT NULL;

-- `ALTER TABLE ADD COLUMN` cannot carry a CHECK, so the invariants are
-- triggers. They fire on draft construction too, which is deliberate: a
-- nonsense fee should be refused at the first statement that writes it, not
-- discovered at promotion.
CREATE TRIGGER IF NOT EXISTS trg_sales_delivery_fee_sane_ins
BEFORE INSERT ON sales
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'A delivery fee cannot be negative.')
   WHERE NEW.delivery_fee_cents < 0;

  -- A fee with nobody to pay it is a number attributed to no one. The process
  -- is "the restaurant assigns its own driver and adds a delivery charge": the
  -- charge exists BECAUSE a driver carried it.
  SELECT RAISE(ABORT, 'A delivery fee requires the driver who collected it.')
   WHERE NEW.delivery_fee_cents > 0 AND NEW.driver_id IS NULL;

  -- A driver on a counter sale would mean somebody walked in, paid at the
  -- till, and a courier was nonetheless booked against the receipt. The
  -- channel is the reporting dimension the owner reads delivery by, so letting
  -- the two disagree would put delivery orders in the counter figure.
  SELECT RAISE(ABORT, 'Only a delivery order can name a driver. Set the order channel first.')
   WHERE NEW.driver_id IS NOT NULL AND NEW.channel <> 'online_delivery';
END;

CREATE TRIGGER IF NOT EXISTS trg_sales_delivery_fee_sane_upd
BEFORE UPDATE OF driver_id, delivery_fee_cents, channel ON sales
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'A delivery fee cannot be negative.')
   WHERE NEW.delivery_fee_cents < 0;

  SELECT RAISE(ABORT, 'A delivery fee requires the driver who collected it.')
   WHERE NEW.delivery_fee_cents > 0 AND NEW.driver_id IS NULL;

  SELECT RAISE(ABORT, 'Only a delivery order can name a driver. Set the order channel first.')
   WHERE NEW.driver_id IS NOT NULL AND NEW.channel <> 'online_delivery';
END;

-- And both are part of the posted record.
--
-- Migration 001's void path lists the columns a 'voided' update may leave
-- alone, and migration 014 already explained why that list is a denylist worn
-- as an allowlist: a column added afterwards is, by default, one a void
-- statement may rewrite. Re-pointing a posted sale at a different driver would
-- move a receivable between two people's balances; rewriting the fee would
-- change what the shop believes the customer was charged. Same narrow guard as
-- `trg_sales_channel_is_immutable_after_post`, same reason.
CREATE TRIGGER IF NOT EXISTS trg_sales_driver_immutable_after_post
BEFORE UPDATE OF driver_id, delivery_fee_cents ON sales
FOR EACH ROW
WHEN OLD.posted_at IS NOT NULL
 AND (NEW.driver_id IS NOT OLD.driver_id
   OR NEW.delivery_fee_cents IS NOT OLD.delivery_fee_cents)
BEGIN
  SELECT RAISE(
    ABORT,
    'A posted sale''s driver and delivery fee cannot be changed. Post a correction instead.'
  );
END;


-- ----------------------------------------------------------------------------
-- 3. DRIVER_LEDGER — the clearing subledger.
--
--    Append-only, signed, balance = SUM(amount_cents), mistakes fixed by
--    posting another row. That is `supplier_ledger`'s design (migration 006)
--    and it is reused rather than reinvented, down to the sign discipline
--    trigger migration 010 added to it.
--
--    CONVENTION: positive means the DRIVER OWES GREAZ MORE.
--
--      collection    → +  a delivery sale posted; he is holding the food money
--      remittance    → −  he handed cash over; the shop has it now
--      return_credit → −  a credit memo reduced what the order was worth
--      adjustment    → ±  a signed-off correction, with a reason
--
--    Why a subledger and not a column on `drivers`: the audit trail is the
--    whole point of the feature. The owner's question is never only "what does
--    Ali owe" — it is "which orders is that, and what has he brought back".
--    `related_sale_id` and `related_credit_memo_id` are what make the balance
--    traceable to source documents, which Priority 4 requires.
--
--    WHAT A REMITTANCE RECORDS, AND WHAT IT DOES NOT
--
--    `received_currency` and the two native columns record the cash that
--    physically changed hands, in the unit it changed hands in — USD cents or
--    whole lira, the same pair `sale_payments` carries and for the same reason
--    (`lib/money.ts`). `amount_cents` is its USD-cent equivalent, DERIVED by
--    `post_driver_remittance` at the rate named here, never taken from the
--    caller, exactly as `post_sale` derives a lira tender's equivalent.
--
--    `shift_id` is recorded when the cashier who took the money was on a
--    shift. It is NOT, in this release, part of the expected-drawer figure that
--    `close_shift` reconciles — see the note at the end of this migration.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_ledger (
  id                        TEXT PRIMARY KEY,
  store_id                  TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  driver_id                 TEXT NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,

  entry_type                TEXT NOT NULL CHECK (entry_type IN
                              ('collection','remittance','return_credit','adjustment')),

  -- Signed USD cents. + = the driver owes the shop more.
  amount_cents              INTEGER NOT NULL,

  -- Document date the user typed (local YYYY-MM-DD), as `supplier_ledger`.
  entry_date                TEXT NOT NULL,

  notes                     TEXT,

  -- Source traceability.
  related_sale_id           TEXT REFERENCES sales(id) ON DELETE RESTRICT,
  related_credit_memo_id    TEXT REFERENCES sales_credit_memos(id) ON DELETE RESTRICT,

  -- Remittance only: the cash that actually arrived.
  received_currency         TEXT CHECK (received_currency IN ('USD','LBP')),
  received_native_usd_cents INTEGER NOT NULL DEFAULT 0
                              CHECK (received_native_usd_cents >= 0),
  received_native_lbp       INTEGER NOT NULL DEFAULT 0
                              CHECK (received_native_lbp >= 0),
  exchange_rate_id          TEXT REFERENCES exchange_rates(id) ON DELETE RESTRICT,
  exchange_rate_lbp_per_usd INTEGER,

  reference                 TEXT,

  -- Audit
  shift_id                  TEXT REFERENCES shifts(id) ON DELETE RESTRICT,
  created_by_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id                 TEXT REFERENCES devices(id) ON DELETE SET NULL,
  posted_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- ---- Each entry type carries exactly the columns it means ----
  --
  -- A `collection` without its sale is a balance nobody can trace; a
  -- `remittance` without a currency is money of no denomination; an
  -- `adjustment` without a reason is the thing the audit trail exists to
  -- prevent. These are table CHECKs rather than triggers because this is a new
  -- table and a CHECK cannot be forgotten by a writer.
  CHECK (
    CASE entry_type
      WHEN 'collection' THEN
        related_sale_id IS NOT NULL
        AND related_credit_memo_id IS NULL
        AND received_currency IS NULL
      WHEN 'return_credit' THEN
        related_credit_memo_id IS NOT NULL
        AND received_currency IS NULL
      WHEN 'remittance' THEN
        related_sale_id IS NULL
        AND related_credit_memo_id IS NULL
        AND received_currency IS NOT NULL
      WHEN 'adjustment' THEN
        related_sale_id IS NULL
        AND related_credit_memo_id IS NULL
        AND received_currency IS NULL
        AND NULLIF(TRIM(COALESCE(notes, ''), char(9,10,13,32)), '') IS NOT NULL
    END
  ),

  -- A non-remittance moves no physical cash, so its native columns are zero.
  CHECK (entry_type = 'remittance'
      OR (received_native_usd_cents = 0 AND received_native_lbp = 0)),

  -- A remittance names its currency and carries the amount in THAT currency's
  -- own unit, with the other column zero. Same shape as `sale_payments`.
  CHECK (entry_type <> 'remittance'
      OR (received_native_usd_cents > 0 AND received_currency = 'USD'
          AND received_native_lbp = 0)
      OR (received_native_lbp > 0 AND received_currency = 'LBP'
          AND received_native_usd_cents = 0)),

  -- A lira remittance must say what rate converted it, or `amount_cents` is
  -- an unexplained number. A USD remittance needs no rate and must not claim
  -- one, so a reader never has to wonder which figure a rate applied to.
  CHECK (CASE
    WHEN entry_type = 'remittance' AND received_currency = 'LBP'
      THEN exchange_rate_id IS NOT NULL AND exchange_rate_lbp_per_usd > 0
    ELSE exchange_rate_id IS NULL AND exchange_rate_lbp_per_usd IS NULL
  END)
);

CREATE INDEX IF NOT EXISTS idx_driver_ledger_driver
  ON driver_ledger(driver_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_ledger_store
  ON driver_ledger(store_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_ledger_sale
  ON driver_ledger(related_sale_id)
  WHERE related_sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_ledger_memo
  ON driver_ledger(related_credit_memo_id)
  WHERE related_credit_memo_id IS NOT NULL;

-- One collection per sale, and one credit per memo.
--
-- This is the structural half of posting idempotency. `post_sale` resolves a
-- replay by `sales.id` and returns the original receipt without writing again,
-- but that check is a read the command performs; this index is the guarantee
-- that holds even if a future writer forgets it. A second collection row
-- against one receipt would double a driver's balance off one order, and the
-- ledger is append-only, so it could never be removed — only offset by an
-- adjustment that misstates a correction.
CREATE UNIQUE INDEX IF NOT EXISTS ux_driver_ledger_one_per_sale
  ON driver_ledger(related_sale_id)
  WHERE related_sale_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_driver_ledger_one_per_memo
  ON driver_ledger(related_credit_memo_id)
  WHERE related_credit_memo_id IS NOT NULL;

-- Append-only, as `supplier_ledger`.
CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_no_update
BEFORE UPDATE ON driver_ledger
BEGIN
  SELECT RAISE(ABORT, 'Driver ledger entries are immutable. Post a correcting entry instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_no_delete
BEFORE DELETE ON driver_ledger
BEGIN
  SELECT RAISE(ABORT, 'Driver ledger entries cannot be deleted.');
END;

-- The sign convention above, enforced against every writer — migration 010's
-- `trg_supplier_ledger_sign_discipline`, pointed the other way.
--
-- The direction is the BACKEND's, not the caller's: a remittance sent with the
-- wrong sign would ADD to what the driver owes, and an immutable row cannot be
-- corrected, only offset. `adjustment` is the one bidirectional instrument,
-- because a correction genuinely goes either way and a human signs it.
CREATE TRIGGER IF NOT EXISTS trg_driver_ledger_sign_discipline
BEFORE INSERT ON driver_ledger
BEGIN
  SELECT RAISE(ABORT, 'driver_ledger: a collection is money the driver holds and must be positive.')
   WHERE NEW.entry_type = 'collection' AND NEW.amount_cents <= 0;

  SELECT RAISE(ABORT, 'driver_ledger: a remittance pays the balance down and must be negative.')
   WHERE NEW.entry_type = 'remittance' AND NEW.amount_cents >= 0;

  SELECT RAISE(ABORT, 'driver_ledger: a return credit reduces what the driver owes and must be negative.')
   WHERE NEW.entry_type = 'return_credit' AND NEW.amount_cents >= 0;

  SELECT RAISE(ABORT, 'driver_ledger: an adjustment of zero records nothing.')
   WHERE NEW.entry_type = 'adjustment' AND NEW.amount_cents = 0;

  -- An entry is filed against the driver's OWN store, like migration 010's.
  -- The foreign keys only prove both rows exist somewhere; which store's books
  -- the entry lands in decides whose receivable moves.
  SELECT RAISE(ABORT, 'driver_ledger: the entry''s store is not the driver''s store.')
   WHERE NEW.store_id <> (SELECT store_id FROM drivers WHERE id = NEW.driver_id);

  -- And the source document is the same store's, and names the same driver.
  -- Without this, a collection could credit one branch's receipt to another
  -- branch's driver.
  SELECT RAISE(ABORT, 'driver_ledger: the related sale is not this driver''s sale.')
   WHERE NEW.related_sale_id IS NOT NULL
     AND NEW.driver_id IS NOT (SELECT driver_id FROM sales WHERE id = NEW.related_sale_id);
END;


-- ----------------------------------------------------------------------------
-- 4. A NEW TENDER: `driver_collection`.
--
--    A delivery order IS settled — just not into the drawer. The driver takes
--    responsibility for the food money at the moment the food leaves, and the
--    shop's claim is on him from then on.
--
--    This is a `sale_payments` row, the same as a card, and the comparison is
--    exact rather than convenient: a card sale is money the shop will receive
--    from a third party later, it is not in the till tonight, it settles the
--    sale in full, and it is already modelled as a non-cash tender here. A
--    driver collection is that, with the acquirer replaced by an employee.
--
--    Putting it in `sale_payments` is what keeps every existing invariant
--    intact for free:
--
--      * tender must cover the sale total — a delivery order is not "unpaid";
--      * `is_cash_method` is unchanged, so `close_shift` counts no drawer cash
--        for it and the expected-cash figure is untouched;
--      * the overpayment rule already refuses non-cash tender above the amount
--        due, so a driver collection cannot be written as drawer change;
--      * a credit memo may refund only a `(method, currency)` pair the sale
--        actually took, so a driver-collected order cannot be refunded in cash
--        out of a till that never received it.
--
--    The alternative — a sale with no payment row, settled by a ledger entry
--    off to the side — would have had to relax "tender covers the total", and
--    then every drawer query, refund cap and reconciliation that reads
--    `sale_payments` would be blind to how the order settled.
--
--    WHY A TABLE REBUILD
--
--    `method` is constrained by a CHECK, and SQLite cannot alter one. So this
--    is the documented 12-step rebuild. It is safe to do to THIS table
--    specifically, and it is worth stating why rather than trusting it:
--
--      * nothing references `sale_payments` — it is a leaf, a child of `sales`
--        and `stores` — so no foreign key anywhere needs repointing, and the
--        implicit row delete that `DROP TABLE` performs can violate nothing;
--      * the column list, the other CHECKs and both indexes are reproduced
--        below verbatim from migration 001;
--      * the three immutability triggers are dropped FIRST and recreated
--        after, in migration 012's symmetric form — the copy would otherwise
--        be refused by `trg_sale_payments_no_insert_after_post` on the first
--        posted sale, which is also the proof that those guards work;
--      * no amount, method, currency or rate is recalculated. The copy is a
--        column-for-column `SELECT`, so every posted tender row comes out
--        byte-identical. A rebuild that re-derived anything would be a
--        restatement of the shop's books, which migration 010 established is
--        not ours to do.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sale_payments_no_insert_after_post;
DROP TRIGGER IF EXISTS trg_sale_payments_no_update_after_post;
DROP TRIGGER IF EXISTS trg_sale_payments_no_delete_after_post;

CREATE TABLE sale_payments_v15 (
  id                       TEXT PRIMARY KEY,
  sale_id                  TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  method                   TEXT NOT NULL CHECK (method IN (
                             'cash_usd','cash_lbp','card_usd','card_lbp',
                             'bank_transfer','wallet','store_credit','other',
                             'driver_collection'
                           )),
  currency                 TEXT NOT NULL CHECK (currency IN ('USD','LBP')),

  amount_native_usd_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_usd_cents >= 0),
  amount_native_lbp        INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_lbp >= 0),

  amount_usd_cents_equivalent INTEGER NOT NULL CHECK (amount_usd_cents_equivalent >= 0),

  change_given_usd_cents   INTEGER NOT NULL DEFAULT 0,
  change_given_lbp         INTEGER NOT NULL DEFAULT 0,

  reference                TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK ((amount_native_usd_cents > 0 AND currency = 'USD' AND amount_native_lbp = 0)
      OR (amount_native_lbp > 0 AND currency = 'LBP' AND amount_native_usd_cents = 0))
);

INSERT INTO sale_payments_v15 (
  id, sale_id, store_id, method, currency,
  amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
  change_given_usd_cents, change_given_lbp, reference, created_at
)
SELECT
  id, sale_id, store_id, method, currency,
  amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
  change_given_usd_cents, change_given_lbp, reference, created_at
FROM sale_payments;

DROP TABLE sale_payments;
ALTER TABLE sale_payments_v15 RENAME TO sale_payments;

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale  ON sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_store ON sale_payments(store_id, created_at DESC);

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

CREATE TRIGGER IF NOT EXISTS trg_sale_payments_no_delete_after_post
BEFORE DELETE ON sale_payments
WHEN (SELECT posted_at FROM sales WHERE id = OLD.sale_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Payments of a posted sale cannot be deleted.');
END;


-- ----------------------------------------------------------------------------
-- 5. The same tender on the REFUND side.
--
--    A return on a delivery order must go back the way it came. The existing
--    rule — a memo may refund only a `(method, currency)` pair the sale took,
--    capped in that currency and cumulative across memos — already says so;
--    what was missing was permission for the method to exist on a refund leg.
--
--    Without it, a driver-collected order would have been unrefundable, and
--    the pressure would have been to refund it in cash: handing a customer
--    money out of a drawer that never received any, against a receivable that
--    stays on a driver's balance in full. That is the "invent a cash refund"
--    outcome the requirement names, and this is how it is avoided — the refund
--    leg reduces the DRIVER's balance, because the driver is holding the money
--    being refunded.
--
--    `store_credit` stays absent for migration 011's reason, which is
--    unchanged: there is still no customer ledger.
--
--    Same rebuild, same reasoning. `sales_credit_memo_refunds` is also a leaf.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_credit_memo_refunds_no_insert_after_post;
DROP TRIGGER IF EXISTS trg_credit_memo_refunds_no_update_after_post;
DROP TRIGGER IF EXISTS trg_credit_memo_refunds_no_delete_after_post;
DROP TRIGGER IF EXISTS trg_credit_memo_refunds_no_reparent;

CREATE TABLE sales_credit_memo_refunds_v15 (
  id                          TEXT PRIMARY KEY,
  credit_memo_id              TEXT NOT NULL REFERENCES sales_credit_memos(id) ON DELETE RESTRICT,
  store_id                    TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,

  method                      TEXT NOT NULL CHECK (method IN (
                                'cash_usd','cash_lbp','card_usd','card_lbp',
                                'bank_transfer','wallet','other',
                                'driver_collection'
                              )),
  currency                    TEXT NOT NULL CHECK (currency IN ('USD','LBP')),

  amount_native_usd_cents     INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_usd_cents >= 0),
  amount_native_lbp           INTEGER NOT NULL DEFAULT 0 CHECK (amount_native_lbp >= 0),

  amount_usd_cents_equivalent INTEGER NOT NULL CHECK (amount_usd_cents_equivalent > 0),

  reference                   TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK ((amount_native_usd_cents > 0 AND currency = 'USD' AND amount_native_lbp = 0)
      OR (amount_native_lbp > 0 AND currency = 'LBP' AND amount_native_usd_cents = 0))
);

INSERT INTO sales_credit_memo_refunds_v15 (
  id, credit_memo_id, store_id, method, currency,
  amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
  reference, created_at
)
SELECT
  id, credit_memo_id, store_id, method, currency,
  amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
  reference, created_at
FROM sales_credit_memo_refunds;

DROP TABLE sales_credit_memo_refunds;
ALTER TABLE sales_credit_memo_refunds_v15 RENAME TO sales_credit_memo_refunds;

CREATE INDEX IF NOT EXISTS idx_credit_memo_refunds_memo  ON sales_credit_memo_refunds(credit_memo_id);
CREATE INDEX IF NOT EXISTS idx_credit_memo_refunds_store ON sales_credit_memo_refunds(store_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_insert_after_post
BEFORE INSERT ON sales_credit_memo_refunds
WHEN (SELECT posted_at FROM sales_credit_memos WHERE id = NEW.credit_memo_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A posted credit memo cannot take another refund leg. Post a new return instead.');
END;

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

CREATE TRIGGER IF NOT EXISTS trg_credit_memo_refunds_no_reparent
BEFORE UPDATE OF credit_memo_id ON sales_credit_memo_refunds
WHEN NEW.credit_memo_id <> OLD.credit_memo_id
BEGIN
  SELECT RAISE(ABORT, 'A credit memo refund leg belongs to the memo it was created under and cannot be moved to another.');
END;


-- ----------------------------------------------------------------------------
-- 6. A read-side view: what each driver owes, and what he has brought back.
--
--    Read-only, never written to, shaped like `supplier_balances`. Every
--    figure comes from the SAME rows, so the parts cannot fail to add up to
--    the balance — which is the mistake a second query over the same table
--    would eventually make.
--
--    `outstanding_cents` is the balance: collections, less remittances, less
--    return credits, plus or minus adjustments. It should never be negative;
--    `post_driver_remittance` refuses a remittance larger than the outstanding
--    amount, so the only route to a negative balance is a signed-off
--    `adjustment`, which is deliberate and is shown as a credit on file.
-- ----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS driver_balances AS
SELECT
  d.id        AS driver_id,
  d.store_id  AS store_id,
  d.name      AS driver_name,
  d.is_active AS is_active,
  COALESCE(SUM(l.amount_cents), 0) AS outstanding_cents,
  COALESCE(SUM(CASE WHEN l.entry_type = 'collection'    THEN l.amount_cents END), 0)
    AS collected_cents,
  COALESCE(SUM(CASE WHEN l.entry_type = 'remittance'    THEN -l.amount_cents END), 0)
    AS remitted_cents,
  COALESCE(SUM(CASE WHEN l.entry_type = 'return_credit' THEN -l.amount_cents END), 0)
    AS return_credit_cents,
  COALESCE(SUM(CASE WHEN l.entry_type = 'adjustment'    THEN l.amount_cents END), 0)
    AS adjustment_cents,
  COUNT(CASE WHEN l.entry_type = 'collection' THEN 1 END) AS collection_count,
  MAX(l.posted_at) AS last_activity_at
FROM drivers d
LEFT JOIN driver_ledger l ON l.driver_id = d.id
GROUP BY d.id;


-- ============================================================================
-- OPEN POLICY QUESTIONS — recorded here because the schema is what a later
-- decision will have to live with.
--
-- 1. VAT AND INVOICING OF THE DELIVERY CHARGE. Stated at the top. The charge
--    is tracked and displayed, attributed to no revenue line and given no VAT
--    rate, pending Greaz's accountant.
--
-- 2. IS A REMITTANCE A DRAWER EVENT? A remittance records the cash that
--    arrived, in its own currency, and `shift_id` says who was on duty. It is
--    NOT added to the expected-drawer figure `close_shift` reconciles against.
--
--    That is the same position WP-05 took for supplier payments, and holding
--    the line matters more than the small convenience of changing it: expected
--    drawer cash is defined once, as `opening float + cash in − change out −
--    cash refunds out` over `sale_payments` and credit-memo refund rows, and
--    every shift already closed was counted that way. Folding a new source of
--    cash into it silently would change what a closed shift's variance means,
--    in a column that is immutable once written.
--
--    So this is a live product decision, not an oversight: a shop that wants
--    driver remittances counted in the till needs them tied to an open shift,
--    added to `drawer_cash_for_shift`, and the change dated — the same work
--    giving supplier payments a tender model would be. Until then, remittances
--    reconcile as their own figure, which is what the driver report shows.
-- ============================================================================
