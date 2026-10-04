// Layer C — `post_supplier_payment`, the supplier ledger balance, and the
// WP-05 payment rules: sign authority, overpayment, partial payment and
// payment-identity idempotency.
//
// Concurrency: the race uses `TempDb::rival_pool`, a second connection pool
// against the same file configured exactly as production is.

use crate::posting::{post_purchase_with_pool, post_supplier_payment_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";
const OTHER_STORE: &str = "00000000-0000-0000-0000-00000000bbbb";
const SUPPLIER_OTHER_STORE: &str = "00000000-0000-0000-0000-0000000000s9";

/// A supplier the shop owes `cents` to, carried in as an opening balance.
async fn store_owing(cents: i64) -> TempDb {
    let db = store_with_supplier().await;
    post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "opening_balance", cents),
    )
    .await
    .expect("opening balance posts");
    db
}

async fn store_with_supplier() -> TempDb {
    let db = TempDb::new().await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payment_reduces_the_balance_and_reports_the_new_total() {
    let db = store_with_supplier().await;

    let opening =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "opening_balance", 50_000))
            .await
            .expect("opening balance posts");
    assert_eq!(opening.new_balance_cents, 50_000);

    let payment =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -20_000))
            .await
            .expect("payment posts");
    assert_eq!(payment.new_balance_cents, 30_000, "a payment reduces what we owe");

    // The reported balance is exactly the sum of the ledger.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_cents),0) FROM supplier_ledger WHERE supplier_id='{SUPPLIER}'"
        ))
        .await,
        30_000
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchases_and_payments_reconcile_into_one_running_balance() {
    let db = store_with_supplier().await;

    // Two invoices on credit.
    let mut invoiced = 0;
    for qty in [10, 25] {
        let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_cost_excl(200).build()];
        let r = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
            .await
            .unwrap();
        assert!(r.ledger_entry_id.is_some());
        invoiced += 200 * qty + (200 * qty * 11 / 100); // excl + 11% VAT
    }
    assert_eq!(invoiced, 7770);

    // Pay part of it.
    let after =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -5_000))
            .await
            .unwrap();

    assert_eq!(after.new_balance_cents, invoiced - 5_000);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_cents),0) FROM supplier_ledger WHERE supplier_id='{SUPPLIER}'"
        ))
        .await,
        2_770,
        "balance = invoices − payments"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='purchase'").await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credit_note_offsets_what_we_owe() {
    let db = store_with_supplier().await;

    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "opening_balance", 10_000))
        .await
        .unwrap();
    let r =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "credit_note", -2_500))
            .await
            .unwrap();
    assert_eq!(r.new_balance_cents, 7_500);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payment_larger_than_the_outstanding_balance_is_refused() {
    // Before WP-05 this posted and left the supplier owing the shop $20 — a
    // receivable nothing in Greaz models, on an immutable row nothing could
    // unwind. A supplier advance is a product decision; a fat-fingered extra
    // zero is not.
    let db = store_with_supplier().await;

    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "opening_balance", 1_000))
        .await
        .unwrap();
    let err = post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -3_000))
        .await
        .unwrap_err();
    assert!(err.contains("exceeds the 1000 cents outstanding"), "got: {err}");

    // The balance is untouched and no row was written.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_cents),0) FROM supplier_ledger WHERE supplier_id='{SUPPLIER}'"
        ))
        .await,
        1_000
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ledger_entries_are_scoped_per_supplier() {
    let db = store_with_supplier().await;
    let other = "00000000-0000-0000-0000-0000000000s2";
    seed_supplier(&db, other, "Tripoli Imports").await;

    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "opening_balance", 4_000))
        .await
        .unwrap();
    let r = post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(other, "opening_balance", 900))
        .await
        .unwrap();

    assert_eq!(r.new_balance_cents, 900, "one supplier's balance excludes the other's");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posting_against_an_unknown_supplier_is_refused() {
    let db = store_with_supplier().await;

    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload("no-such-supplier", "payment", -100))
            .await
            .unwrap_err();
    // Since WP-05 the supplier is resolved before anything is written, so the
    // caller is told which supplier is missing instead of being handed the
    // foreign key's own wording.
    assert!(err.contains("does not exist"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}

// ============================================================================
// Sign authority (Part A)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payment_sent_with_the_wrong_sign_still_pays_the_balance_down() {
    // The GZ-HI-05 sign defect: `amount_cents` went to the ledger exactly as
    // sent, so a caller that forgot the minus — a stale build, a hand-rolled
    // integration, a refactor — ADDED to the payable. Ledger rows are
    // immutable and undeletable, so the shop could only offset it.
    //
    // Direction is now a fact about the entry type, not a field. Both of these
    // pay $50 off.
    for amount in [-5_000_i64, 5_000] {
        let db = store_owing(10_000).await;
        let r = post_supplier_payment_with_pool(
            db.pool(),
            supplier_payment_payload(SUPPLIER, "payment", amount),
        )
        .await
        .unwrap_or_else(|e| panic!("a payment of {amount} must post: {e}"));

        assert_eq!(
            r.new_balance_cents, 5_000,
            "a payment reduces what we owe, whatever sign arrived"
        );
        assert_eq!(
            db.scalar_i64("SELECT amount_cents FROM supplier_ledger WHERE entry_type='payment'")
                .await,
            -5_000,
            "and the row persisted carries the derived sign, not the caller's"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_legacy_signed_wire_contract_still_works_and_is_still_not_authoritative() {
    // A caller that predates WP-05 sends `amountCents` alone. Its MAGNITUDE is
    // honoured — that is the compatibility promise — and its sign is not.
    let db = store_owing(10_000).await;

    let r = post_supplier_payment_with_pool(
        db.pool(),
        legacy_supplier_payment_payload(SUPPLIER, "payment", -3_000),
    )
    .await
    .expect("the legacy payload posts");
    assert_eq!(r.new_balance_cents, 7_000);

    let r = post_supplier_payment_with_pool(
        db.pool(),
        legacy_supplier_payment_payload(SUPPLIER, "payment", 2_000),
    )
    .await
    .expect("the legacy payload posts even with the sign inverted");
    assert_eq!(
        r.new_balance_cents, 5_000,
        "its sign cannot invert the accounting meaning"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_negative_payment_magnitude_is_refused() {
    // A magnitude is how much money moved. A negative one is a malformed
    // request, and guessing which way the caller meant it is exactly the guess
    // this package exists to stop making.
    let db = store_owing(10_000).await;

    let mut payload = supplier_payment_payload(SUPPLIER, "payment", -5_000);
    payload.amount_magnitude_cents = Some(-5_000);
    let err = post_supplier_payment_with_pool(db.pool(), payload).await.unwrap_err();
    assert!(err.contains("must be a positive number of cents"), "got: {err}");

    assert_eq!(supplier_balance(&db, SUPPLIER).await, 10_000);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_payment_is_refused() {
    let db = store_owing(10_000).await;

    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", 0))
            .await
            .unwrap_err();
    assert!(err.contains("non-zero"), "got: {err}");

    // And through the magnitude field, which says the same thing differently.
    let mut payload = supplier_payment_payload(SUPPLIER, "payment", -1);
    payload.amount_magnitude_cents = Some(0);
    let err = post_supplier_payment_with_pool(db.pool(), payload).await.unwrap_err();
    assert!(err.contains("must be a positive number of cents"), "got: {err}");

    assert_eq!(supplier_balance(&db, SUPPLIER).await, 10_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payload_whose_two_amounts_disagree_is_refused() {
    // The magnitude and the legacy signed figure are the same money stated
    // twice. When they disagree the request does not know how much is being
    // paid, and no reading of it is safe to pick.
    let db = store_owing(10_000).await;

    let mut payload = supplier_payment_payload(SUPPLIER, "payment", -5_000);
    payload.amount_magnitude_cents = Some(7_000);
    let err = post_supplier_payment_with_pool(db.pool(), payload).await.unwrap_err();
    assert!(err.contains("disagrees with itself"), "got: {err}");

    assert_eq!(supplier_balance(&db, SUPPLIER).await, 10_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bidirectional_entry_types_keep_the_direction_the_caller_states() {
    // `opening_balance` and `adjustment` are deliberately two-way: the Supplier
    // screen gives adjustments an explicit +/- toggle, and a balance carried in
    // from elsewhere can fall either side of zero. For these two the caller's
    // sign IS the instruction — deriving one would mean inventing it.
    let db = store_with_supplier().await;

    let r = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "opening_balance", 8_000),
    )
    .await
    .unwrap();
    assert_eq!(r.new_balance_cents, 8_000);

    let r = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "adjustment", 1_500),
    )
    .await
    .unwrap();
    assert_eq!(r.new_balance_cents, 9_500, "a + adjustment writes the payable up");

    let r = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "adjustment", -2_500),
    )
    .await
    .unwrap();
    assert_eq!(r.new_balance_cents, 7_000, "a - adjustment writes it down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn this_command_cannot_raise_an_invoice_liability() {
    // Only `post_purchase` may raise a payable, and only from a purchase
    // document's own total. A caller able to book 'purchase' here could invent
    // debt with no goods, no lines and no paper behind it.
    let db = store_with_supplier().await;

    let err = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "purchase", 50_000),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Invalid entry_type for this command"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}

// ============================================================================
// Partial payment and overpayment (Parts E and F)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bill_can_be_paid_off_in_instalments_and_lands_exactly_on_zero() {
    // Part F, with the figures from the brief: $100 owed, $30 then $70, and a
    // further payment refused once the balance is settled.
    let db = store_owing(10_000).await;

    let r =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -3_000))
            .await
            .expect("a part payment posts");
    assert_eq!(r.new_balance_cents, 7_000);

    let r =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -7_000))
            .await
            .expect("the balancing payment posts");
    assert_eq!(r.new_balance_cents, 0, "paying the rest lands exactly on zero");

    // Settled is settled: a further payment has nothing to pay.
    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -7_100))
            .await
            .unwrap_err();
    assert!(err.contains("nothing outstanding"), "got: {err}");

    assert_eq!(supplier_balance(&db, SUPPLIER).await, 0);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payment_one_cent_over_the_balance_is_refused() {
    // The boundary, stated on its own: paying the balance to the cent is the
    // whole point of the feature, and one cent past it is an advance.
    let db = store_owing(7_000).await;
    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -7_000))
        .await
        .expect("paying the balance to the cent must work");

    let db = store_owing(7_000).await;
    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -7_001))
            .await
            .unwrap_err();
    assert!(err.contains("exceeds the 7000 cents outstanding"), "got: {err}");
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 7_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_payment_check_uses_the_balance_in_the_database_not_one_the_caller_believes() {
    // A screen the buyer left open an hour ago shows an hour-old balance. The
    // check reads the ledger inside the posting transaction, so a payment sized
    // against a stale figure is refused rather than written.
    let db = store_owing(10_000).await;

    // A credit note lands in between, so what is actually outstanding is less
    // than the buyer's screen said.
    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "credit_note", -6_000))
        .await
        .unwrap();

    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -10_000))
            .await
            .unwrap_err();
    assert!(err.contains("exceeds the 4000 cents outstanding"), "got: {err}");

    // Sized against the real balance, it posts.
    let r =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -4_000))
            .await
            .unwrap();
    assert_eq!(r.new_balance_cents, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credit_note_may_still_leave_the_supplier_owing_the_shop() {
    // Overpayment is refused; a NEGATIVE balance is not forbidden. It stays
    // reachable through the two explicitly-signed instruments, because those
    // record a decision somebody made about a real document — a credit note the
    // supplier issued, or an adjustment signed off in writing. The Supplier
    // screen already labels that state "credit on file".
    let db = store_owing(1_000).await;

    let r =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "credit_note", -3_000))
            .await
            .expect("a credit note larger than the balance is a real document");
    assert_eq!(r.new_balance_cents, -2_000);

    // And with a credit on file there is nothing to pay.
    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -500))
            .await
            .unwrap_err();
    assert!(err.contains("nothing outstanding"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_payments_racing_the_same_balance_cannot_together_overpay() {
    let db = store_owing(10_000).await;
    let rival = db.rival_pool().await;

    // Two tabs, each sized against the same $100 outstanding.
    let a = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "payment", -10_000),
    );
    let b = post_supplier_payment_with_pool(
        &rival,
        supplier_payment_payload(SUPPLIER, "payment", -10_000),
    );
    let (ra, rb) = tokio::join!(a, b);

    let winners = [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count();
    assert!(
        winners <= 1,
        "two payments must not both commit against one balance; got a={ra:?} b={rb:?}"
    );

    // The invariant that matters: the shop never paid more than it owed.
    let balance = supplier_balance(&db, SUPPLIER).await;
    assert!(
        balance >= 0,
        "the payable must never be driven negative by payments, got {balance}"
    );
    assert_eq!(
        balance,
        10_000 - 10_000 * winners as i64,
        "the balance must reflect exactly the payments that committed"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        winners as i64
    );

    // "Neither" is acceptable here, unlike opening a shift: a refused payment
    // is retried, not lost. So prove the path still works afterwards.
    if winners == 0 {
        post_supplier_payment_with_pool(
            db.pool(),
            supplier_payment_payload(SUPPLIER, "payment", -10_000),
        )
        .await
        .expect("a retry after a contended refusal must post");
        assert_eq!(supplier_balance(&db, SUPPLIER).await, 0);
    }
}

// ============================================================================
// Payment identity (Part H)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_a_payment_identity_does_not_pay_the_supplier_twice() {
    // The lost-answer case. Before WP-05 the replay hit the primary key and
    // came back as a raw "UNIQUE constraint failed", which tells a buyer
    // nothing about whether the money went out.
    let db = store_owing(10_000).await;

    let payload = supplier_payment_payload(SUPPLIER, "payment", -4_000);
    let first = post_supplier_payment_with_pool(db.pool(), replay_of_ledger_entry(&payload))
        .await
        .expect("the payment posts");
    assert_eq!(first.new_balance_cents, 6_000);

    let replay = post_supplier_payment_with_pool(db.pool(), replay_of_ledger_entry(&payload))
        .await
        .expect("a faithful replay must reconcile, not fail");

    assert_eq!(replay.ledger_entry_id, first.ledger_entry_id);
    assert_eq!(
        replay.posted_at, first.posted_at,
        "the replay reports the original posting time"
    );
    assert_eq!(replay.new_balance_cents, 6_000);

    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        1
    );
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 6_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changed_the_money_is_a_conflict() {
    let db = store_owing(10_000).await;

    let payload = supplier_payment_payload(SUPPLIER, "payment", -4_000);
    post_supplier_payment_with_pool(db.pool(), replay_of_ledger_entry(&payload))
        .await
        .unwrap();

    let mut changed = replay_of_ledger_entry(&payload);
    changed.amount_magnitude_cents = Some(5_000);
    changed.amount_cents = -5_000;
    let err = post_supplier_payment_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("different amount"), "got: {err}");

    let mut changed = replay_of_ledger_entry(&payload);
    changed.entry_date = "2026-03-03".to_string();
    let err = post_supplier_payment_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("different entry date"), "got: {err}");

    let mut changed = replay_of_ledger_entry(&payload);
    changed.payment_reference = Some("CHQ-9".to_string());
    let err = post_supplier_payment_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("different reference"), "got: {err}");

    let mut changed = replay_of_ledger_entry(&payload);
    changed.entry_type = "credit_note".to_string();
    let err = post_supplier_payment_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("different entry type"), "got: {err}");

    // None of the four refusals moved the balance.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        1
    );
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 6_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_compares_the_derived_sign_not_the_one_that_arrived() {
    // A client that sent -4000 first and +4000 on the retry sent the same
    // payment twice. Comparing the raw payload would call that a conflict and
    // hand the buyer an error about money that is already gone.
    let db = store_owing(10_000).await;

    let payload = supplier_payment_payload(SUPPLIER, "payment", -4_000);
    post_supplier_payment_with_pool(db.pool(), replay_of_ledger_entry(&payload))
        .await
        .unwrap();

    let mut retry = replay_of_ledger_entry(&payload);
    retry.amount_cents = 4_000;
    let replay = post_supplier_payment_with_pool(db.pool(), retry)
        .await
        .expect("the same payment, sign flipped on the wire, is still the same payment");
    assert_eq!(replay.new_balance_cents, 6_000);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_separate_payments_of_the_same_amount_both_post() {
    // The control for the rule above, and the reason identity-based idempotency
    // is the only safe kind here: paying a supplier $40 on Monday and $40 again
    // on Tuesday is two payments. Content-based deduplication would swallow the
    // second one and leave the shop still owing money it has already handed
    // over.
    let db = store_owing(10_000).await;

    let a =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -4_000))
            .await
            .unwrap();
    let b =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -4_000))
            .await
            .unwrap();

    assert_ne!(a.ledger_entry_id, b.ledger_entry_id);
    assert_eq!(b.new_balance_cents, 2_000);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger WHERE entry_type='payment'").await,
        2
    );
}

// ============================================================================
// Store scoping, and the database-level backstop (Part D, and item 24)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payment_cannot_be_filed_against_another_stores_supplier() {
    let db = store_with_supplier().await;
    seed_store(&db, OTHER_STORE, "Second Branch").await;
    seed_supplier_in_store(&db, SUPPLIER_OTHER_STORE, "Saida Traders", OTHER_STORE).await;

    let err = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER_OTHER_STORE, "opening_balance", 5_000),
    )
    .await
    .unwrap_err();
    assert!(err.contains("belongs to store"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_direct_write_cannot_invert_the_accounting_meaning_of_an_entry() {
    // Part M item 24. `post_supplier_payment` derives the sign, but the ledger
    // has other possible writers — an importer, a manual fix, a future command.
    // `trg_supplier_ledger_sign_discipline` is what makes the convention
    // migration 006 describes in prose actually true of the table.
    let db = store_owing(10_000).await;

    let cases: [(&str, i64, &str); 5] = [
        ("payment", 5_000, "must be negative"),
        ("payment", 0, "must be negative"),
        ("credit_note", 5_000, "must be negative"),
        ("purchase", -5_000, "cannot be negative"),
        ("adjustment", 0, "records nothing"),
    ];
    for (entry_type, amount, expected) in cases {
        let err = db
            .try_exec(&format!(
                "INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount_cents, entry_date)
                 VALUES ('{}', '{STORE_ID}', '{SUPPLIER}', '{entry_type}', {amount}, '2026-02-02')",
                uuid()
            ))
            .await
            .expect_err("the sign-discipline trigger must refuse this row")
            .to_string();
        assert!(
            err.contains(expected),
            "a {entry_type} of {amount} must be refused for the right reason, got: {err}"
        );
    }

    // The balance is exactly what the legitimate opening balance left.
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 10_000);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_direct_write_cannot_file_an_entry_against_the_wrong_stores_books() {
    let db = store_with_supplier().await;
    seed_store(&db, OTHER_STORE, "Second Branch").await;

    let err = db
        .try_exec(&format!(
            "INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount_cents, entry_date)
             VALUES ('{}', '{OTHER_STORE}', '{SUPPLIER}', 'opening_balance', 5000, '2026-02-02')",
            uuid()
        ))
        .await
        .expect_err("the trigger must refuse an entry filed against another store");
    assert!(err.to_string().contains("supplier's own store"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}
