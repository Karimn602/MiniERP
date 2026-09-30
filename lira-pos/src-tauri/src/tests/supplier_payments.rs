// Layer C — `post_supplier_payment` and the supplier ledger balance.

use crate::posting::{post_purchase_with_pool, post_supplier_payment_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

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
async fn overpaying_produces_a_negative_balance_the_supplier_owes_us() {
    let db = store_with_supplier().await;

    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "opening_balance", 1_000))
        .await
        .unwrap();
    let r = post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -3_000))
        .await
        .unwrap();
    assert_eq!(r.new_balance_cents, -2_000);
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
async fn posting_against_an_unknown_supplier_is_refused_by_the_foreign_key() {
    let db = store_with_supplier().await;

    let err =
        post_supplier_payment_with_pool(db.pool(), supplier_payment_payload("no-such-supplier", "payment", -100))
            .await
            .unwrap_err();
    assert!(err.contains("supplier_ledger"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}
