// Layer C — posted rows are immutable.
//
// These triggers are the last line of defence: they hold even when application
// code is wrong. Corrections are made by reversal, never by edit.

use crate::posting::{post_purchase_with_pool, post_sale_with_pool, post_supplier_payment_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

/// Assert a statement is rejected, and that the message explains why.
async fn assert_rejected(db: &TempDb, sql: &str, expected_fragment: &str) {
    let err = db
        .try_exec(sql)
        .await
        .expect_err(&format!("statement should have been rejected: {sql}"));
    let msg = err.to_string();
    assert!(
        msg.contains(expected_fragment),
        "expected a message containing {expected_fragment:?}, got: {msg}"
    );
}

async fn a_posted_sale() -> (TempDb, String) {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(1000)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();
    (db, sale_id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sale_header_cannot_be_edited_or_deleted() {
    let (db, sale_id) = a_posted_sale().await;

    assert_rejected(
        &db,
        &format!("UPDATE sales SET total_incl_vat_cents = 1 WHERE id='{sale_id}'"),
        "Posted sales are immutable",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM sales WHERE id='{sale_id}'"),
        "Posted sales cannot be deleted",
    )
    .await;

    // The row is unharmed.
    assert_eq!(
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
        1000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn voiding_a_posted_sale_remains_the_one_permitted_transition() {
    // The schema deliberately carves out status → 'voided'; that carve-out is
    // part of the contract, so pin it.
    let (db, sale_id) = a_posted_sale().await;

    db.exec(&format!(
        "UPDATE sales SET status='voided', voided_at='2026-03-01T12:00:00.000Z'
          WHERE id='{sale_id}'"
    ))
    .await;
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'")).await,
        "voided"
    );

    // But the money still cannot be rewritten on the way through.
    assert_rejected(
        &db,
        &format!("UPDATE sales SET status='voided', total_incl_vat_cents=7 WHERE id='{sale_id}'"),
        "Posted sales are immutable",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posted_sale_items_and_payments_are_frozen() {
    let (db, sale_id) = a_posted_sale().await;

    assert_rejected(
        &db,
        &format!("UPDATE sale_items SET unit_cogs_excl_vat_cents = 0 WHERE sale_id='{sale_id}'"),
        "Sale items of a posted sale are immutable",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM sale_items WHERE sale_id='{sale_id}'"),
        "Sale items of a posted sale cannot be deleted",
    )
    .await;
    assert_rejected(
        &db,
        &format!("UPDATE sale_payments SET amount_usd_cents_equivalent = 1 WHERE sale_id='{sale_id}'"),
        "Payments of a posted sale are immutable",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM sale_payments WHERE sale_id='{sale_id}'"),
        "Payments of a posted sale cannot be deleted",
    )
    .await;

    // COGS snapshots in particular survive the attempt.
    assert_eq!(
        db.scalar_i64(&format!("SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'")).await,
        200
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_inventory_ledger_is_append_only() {
    let (db, sale_id) = a_posted_sale().await;

    assert_rejected(
        &db,
        &format!("UPDATE inventory_movements SET quantity_delta = 0 WHERE related_sale_id='{sale_id}'"),
        "append-only",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM inventory_movements WHERE related_sale_id='{sale_id}'"),
        "cannot be deleted",
    )
    .await;

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_purchase_and_its_items_are_frozen() {
    let db = TempDb::new().await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build()];
    let payload = purchase_payload("normal", Some(SUPPLIER), lines);
    let purchase_id = payload.purchase_id.clone();
    post_purchase_with_pool(db.pool(), payload).await.unwrap();

    assert_rejected(
        &db,
        &format!("UPDATE purchases SET total_incl_vat_cents = 1 WHERE id='{purchase_id}'"),
        "immutable",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM purchases WHERE id='{purchase_id}'"),
        "cannot be deleted",
    )
    .await;
    assert_rejected(
        &db,
        &format!("UPDATE purchase_items SET quantity_base = 1 WHERE purchase_id='{purchase_id}'"),
        "immutable",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM purchase_items WHERE purchase_id='{purchase_id}'"),
        "cannot be deleted",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_supplier_ledger_is_append_only() {
    let db = TempDb::new().await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;

    let r = post_supplier_payment_with_pool(
        db.pool(),
        supplier_payment_payload(SUPPLIER, "opening_balance", 5_000),
    )
    .await
    .unwrap();
    let entry = r.ledger_entry_id;

    assert_rejected(
        &db,
        &format!("UPDATE supplier_ledger SET amount_cents = 1 WHERE id='{entry}'"),
        "Supplier ledger entries are immutable",
    )
    .await;
    assert_rejected(
        &db,
        &format!("DELETE FROM supplier_ledger WHERE id='{entry}'"),
        "Supplier ledger entries cannot be deleted",
    )
    .await;

    assert_eq!(
        db.scalar_i64(&format!("SELECT amount_cents FROM supplier_ledger WHERE id='{entry}'")).await,
        5_000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sale_payment_currency_check_rejects_inconsistent_rows() {
    // Schema-level defence behind the command's own validation.
    //
    // Attached to a DRAFT sale on purpose. Since migration 012 a POSTED sale
    // refuses a new payment row outright, so against one of those the trigger
    // would answer first and this test would be asserting the wrong guard. A
    // draft is the only state in which the row gets far enough for the CHECK
    // constraint to be what rejects it — which is the thing under test, and the
    // state `post_sale` is in when it writes its real payment rows.
    let (db, _) = a_posted_sale().await;
    db.exec(&format!(
        "INSERT INTO sales (
           id, store_id, receipt_number, exchange_rate_lbp_per_usd,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           cogs_method, sale_type, status
         ) VALUES ('draft-sale', '{STORE_ID}', 9001, 89500, 0, 0, 0,
                   'weighted_average', 'normal', 'draft')"
    ))
    .await;

    let err = db
        .try_exec(&format!(
            "INSERT INTO sale_payments
               (id, sale_id, store_id, method, currency,
                amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent)
             VALUES ('bad-1', 'draft-sale', '{STORE_ID}', 'cash_usd', 'USD', 0, 5000, 100)"
        ))
        .await
        .expect_err("a USD row carrying LBP must be rejected");
    assert!(err.to_string().contains("CHECK"), "got: {err}");
}
