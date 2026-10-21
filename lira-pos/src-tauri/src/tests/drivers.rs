// Layer C — driver collection and driver settlements, against a temporary
// database (WP-6).
//
// The shape of the feature is: a WhatsApp order is rung up like any other, it
// is tendered `driver_collection` instead of cash, and that raises a
// RECEIVABLE against the shop's own driver which he clears later by handing
// cash over. So these tests are mostly about three things not happening:
//
//   * the delivery fee must never reach revenue, VAT, COGS or the receivable;
//   * the sale must never reach the cash drawer;
//   * a remittance must never look like a second sale.
//
// Everything asserts on PERSISTED rows. The balance is read through the
// `driver_balances` view the UI reads, so a test failing means the owner's
// screen would have been wrong, not merely that an internal helper was.

use crate::posting::{
    close_shift_with_pool, post_credit_memo_with_pool, post_driver_remittance_with_pool,
    post_sale_with_pool, CloseShiftPayload, PostCreditMemoRefund, PostDriverRemittancePayload,
    PostSaleLine,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_BURGER: &str = "00000000-0000-0000-0000-0000000000e1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000e2";
const ALI: &str = "00000000-0000-0000-0000-00000000d001";
const HASSAN: &str = "00000000-0000-0000-0000-00000000d002";

// ============================================================================
// Fixtures
// ============================================================================

/// A restaurant that can sell and deliver, with an open shift holding `usd` of
/// float and two drivers on the books.
///
///   * Burger — stocked, 100 on hand at $3.00 excl cost, sold at $10.00 incl.
///   * Water  — stocked and VAT-EXEMPT, 100 on hand at $0.50, sold at $1.00.
async fn shop_with_float(usd: i64, lbp: i64) -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_shift(&db, SHIFT_ID, usd, lbp).await;
    seed_driver(&db, ALI, "Ali").await;
    seed_driver(&db, HASSAN, "Hassan").await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 300,
            avg_cost_incl_vat_cents: 333,
            price_excl_vat_cents: 901,
            price_incl_vat_cents: 1_000,
            ..ProductSpec::stocked(P_BURGER, "SKU-D1", "Double Burger")
        },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            vat_rate_id: VAT_EXEMPT_ID,
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 50,
            avg_cost_incl_vat_cents: 50,
            price_excl_vat_cents: 100,
            price_incl_vat_cents: 100,
            ..ProductSpec::stocked(P_WATER, "SKU-D2", "Water 500ml")
        },
    )
    .await;
    db
}

async fn shop() -> TempDb {
    shop_with_float(0, 0).await
}

fn burger(qty: i64) -> PostSaleLine {
    SaleLineBuilder::new(P_BURGER, "Double Burger").qty(qty).unit_incl(1_000).build()
}

fn water(qty: i64) -> PostSaleLine {
    SaleLineBuilder::new(P_WATER, "Water 500ml")
        .qty(qty)
        .unit_prices(100, 100)
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .build()
}

/// A remittance payload: `cents` of US dollars handed over.
fn remit_usd(driver_id: &str, cents: i64) -> PostDriverRemittancePayload {
    PostDriverRemittancePayload {
        ledger_entry_id: uuid(),
        store_id: STORE_ID.to_string(),
        driver_id: driver_id.to_string(),
        entry_type: "remittance".to_string(),
        entry_date: "2026-10-21".to_string(),
        notes: None,
        received_currency: Some("USD".to_string()),
        received_native_usd_cents: cents,
        received_native_lbp: 0,
        exchange_rate_id: None,
        exchange_rate_lbp_per_usd: None,
        direction: None,
        amount_magnitude_cents: 0,
        reference: None,
        shift_id: Some(SHIFT_ID.to_string()),
        created_by_user_id: Some(USER_ID.to_string()),
        device_id: None,
    }
}

/// A remittance in lira.
fn remit_lbp(driver_id: &str, lbp: i64) -> PostDriverRemittancePayload {
    PostDriverRemittancePayload {
        received_currency: Some("LBP".to_string()),
        received_native_usd_cents: 0,
        received_native_lbp: lbp,
        exchange_rate_id: Some(RATE_ID.to_string()),
        exchange_rate_lbp_per_usd: Some(RATE_LBP_PER_USD),
        ..remit_usd(driver_id, 0)
    }
}

/// A signed-off correction.
fn adjust(driver_id: &str, magnitude: i64, direction: &str) -> PostDriverRemittancePayload {
    PostDriverRemittancePayload {
        entry_type: "adjustment".to_string(),
        received_currency: None,
        received_native_usd_cents: 0,
        received_native_lbp: 0,
        exchange_rate_id: None,
        exchange_rate_lbp_per_usd: None,
        direction: Some(direction.to_string()),
        amount_magnitude_cents: magnitude,
        notes: Some("Owner signed off".to_string()),
        ..remit_usd(driver_id, 0)
    }
}

/// The first sale-item id of a sale — what a return line points at.
async fn first_item(db: &TempDb, sale_id: &str) -> String {
    sqlx::query_scalar("SELECT id FROM sale_items WHERE sale_id = ? ORDER BY rowid LIMIT 1")
        .bind(sale_id)
        .fetch_one(db.pool())
        .await
        .expect("read sale item")
}

/// A refund leg that credits the DRIVER rather than opening the drawer.
fn driver_refund(cents: i64) -> PostCreditMemoRefund {
    PostCreditMemoRefund {
        refund_id: uuid(),
        method: crate::posting::DRIVER_COLLECTION.to_string(),
        currency: "USD".to_string(),
        amount_native_usd_cents: cents,
        amount_native_lbp: 0,
        amount_usd_cents_equivalent: cents,
        reference: None,
    }
}

/// Expected USD cash in `SHIFT_ID`'s drawer right now, read through the same
/// definition `close_shift` reconciles against.
async fn drawer_expected(db: &TempDb) -> i64 {
    let float: i64 =
        sqlx::query_scalar("SELECT opening_cash_usd_cents FROM shifts WHERE id = ?")
            .bind(SHIFT_ID)
            .fetch_one(db.pool())
            .await
            .expect("read float");
    let cash_in: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(sp.amount_native_usd_cents), 0)
           FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
          WHERE s.shift_id = ? AND s.status = 'posted' AND sp.method = 'cash_usd'",
    )
    .bind(SHIFT_ID)
    .fetch_one(db.pool())
    .await
    .expect("read cash in");
    let remitted: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(received_native_usd_cents), 0) FROM driver_ledger
          WHERE shift_id = ? AND entry_type = 'remittance'",
    )
    .bind(SHIFT_ID)
    .fetch_one(db.pool())
    .await
    .expect("read remittances");
    let refunded: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(r.amount_native_usd_cents), 0)
           FROM sales_credit_memo_refunds r
           JOIN sales_credit_memos m ON m.id = r.credit_memo_id
          WHERE m.shift_id = ? AND m.status = 'posted' AND r.method = 'cash_usd'",
    )
    .bind(SHIFT_ID)
    .fetch_one(db.pool())
    .await
    .expect("read refunds");
    float + cash_in + remitted - refunded
}

/// Every driver-ledger row of a driver, oldest first.
async fn ledger_rows(db: &TempDb, driver_id: &str) -> Vec<(String, i64, Option<String>)> {
    sqlx::query_as::<_, (String, i64, Option<String>)>(
        "SELECT entry_type, amount_cents, related_sale_id
           FROM driver_ledger WHERE driver_id = ? ORDER BY posted_at, rowid",
    )
    .bind(driver_id)
    .fetch_all(db.pool())
    .await
    .expect("read driver ledger")
}

// ============================================================================
// 1. A counter sale is untouched
// ============================================================================

#[tokio::test]
async fn a_counter_sale_is_unchanged_by_the_driver_feature() {
    // The regression that matters most. Nothing about counter trade may move
    // because delivery exists: same tender, same drawer, no driver, no fee, no
    // ledger row anywhere.
    let db = shop_with_float(0, 0).await;
    let p = sale_payload(vec![burger(1)], vec![cash_usd(1_000)]);
    let sale_id = p.sale_id.clone();
    post_sale_with_pool(db.pool(), p).await.expect("counter sale posts");

    let (driver, fee): (Option<String>, i64) = sqlx::query_as(
        "SELECT driver_id, delivery_fee_cents FROM sales WHERE id = ?",
    )
    .bind(&sale_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(driver, None, "a counter sale names no driver");
    assert_eq!(fee, 0, "a counter sale has no delivery fee");

    let ledger_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM driver_ledger").fetch_one(db.pool()).await.unwrap();
    assert_eq!(ledger_count, 0, "a counter sale writes no driver ledger row");

    // And the cash still reaches the drawer.
    let closed = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 1_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close shift");
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000));
}

// ============================================================================
// 2. A delivery sale raises a receivable and no drawer cash
// ============================================================================

#[tokio::test]
async fn a_delivery_sale_creates_a_driver_receivable_without_adding_drawer_cash() {
    let db = shop_with_float(5_000, 0).await;
    // $10.00 of food, $3.00 delivery the customer pays Ali directly.
    let p = delivery_payload(vec![burger(1)], ALI, 300);
    let sale_id = p.sale_id.clone();
    post_sale_with_pool(db.pool(), p).await.expect("delivery sale posts");

    // The receivable is the FOOD money, and only that.
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "Ali holds the $10.00 of food money");
    assert_eq!(ledger_rows(&db, ALI).await, vec![
        ("collection".to_string(), 1_000, Some(sale_id.clone()))
    ]);

    // The drawer is untouched: the float, and not a cent more.
    let closed = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 5_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close shift");
    assert_eq!(
        closed.expected_cash_usd_cents,
        Some(5_000),
        "a driver collection puts nothing in the till"
    );
    assert_eq!(closed.variance_usd_cents, Some(0), "and the shift balances");
}

#[tokio::test]
async fn the_delivery_fee_does_not_inflate_food_revenue() {
    let db = shop().await;
    let p = delivery_payload(vec![burger(1)], ALI, 500);
    let sale_id = p.sale_id.clone();
    post_sale_with_pool(db.pool(), p).await.expect("post");

    let (subtotal, vat, total, fee): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                delivery_fee_cents
           FROM sales WHERE id = ?",
    )
    .bind(&sale_id)
    .fetch_one(db.pool())
    .await
    .unwrap();

    // The sale is the food. The $5.00 fee is beside it, not inside it.
    assert_eq!(subtotal, 901, "net food revenue only");
    assert_eq!(vat, 99, "VAT on the food only — the fee is not VAT-rated");
    assert_eq!(total, 1_000, "the Greaz receipt amount");
    assert_eq!(subtotal + vat, total, "the header still reconciles");
    assert_eq!(fee, 500, "and the fee is recorded, separately");

    // The customer's total payment is a SUM the UI makes, never a stored total.
    assert_eq!(total + fee, 1_500);

    // Nothing in the tender claims the fee either: Ali owes the food, he keeps
    // the delivery charge.
    assert_eq!(driver_balance(&db, ALI).await, 1_000);
    let tendered: i64 =
        sqlx::query_scalar("SELECT SUM(amount_usd_cents_equivalent) FROM sale_payments WHERE sale_id = ?")
            .bind(&sale_id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(tendered, 1_000, "the tender settles the food, not the fee");
}

#[tokio::test]
async fn the_delivery_fee_reaches_no_line_cost_or_stock() {
    // A fee implemented as a product line would have reached COGS, inventory
    // and the margin report. It is a column, so it reaches none of them.
    let db = shop().await;
    let p = delivery_payload(vec![burger(2)], ALI, 400);
    let sale_id = p.sale_id.clone();
    post_sale_with_pool(db.pool(), p).await.expect("post");

    let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sale_items WHERE sale_id = ?")
        .bind(&sale_id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(line_count, 1, "one food line, and no fee line");

    let cogs: i64 = sqlx::query_scalar("SELECT cogs_total_cents FROM sales WHERE id = ?")
        .bind(&sale_id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(cogs, 600, "2 x $3.00 of burger cost, with no fee in it");

    let on_hand: i64 = sqlx::query_scalar("SELECT quantity_on_hand FROM products WHERE id = ?")
        .bind(P_BURGER)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(on_hand, 98, "stock moved for the food only");
}

// WP-6's two PREPAID delivery tests lived here: a card-prepaid delivery order
// posting with no receivable, and a part-prepaid one raising a receivable for
// only the leg the driver carried. Both asserted the permissiveness that
// GZ-P1-1 removes, so they are not merely obsolete — they asserted the opposite
// of the rule now in force. Their cases are covered by section 9 below
// (`a_delivery_order_prepaid_by_card_alone_is_refused` and
// `a_part_prepaid_delivery_order_is_refused`), which assert the refusal and
// that nothing is written.
//
// What they were PROTECTING is still protected: the receivable is raised by the
// TENDER and never by the sale total, which is what
// `a_mixed_currency_delivery_sums_both_legs_into_one_receivable` and
// `the_delivery_fee_does_not_inflate_food_revenue` pin. The difference is that
// the only tender a new delivery order may now carry is the collection itself.

// ============================================================================
// 3. The rules that keep a receivable attributable
// ============================================================================

#[tokio::test]
async fn a_driver_collection_without_a_driver_is_refused() {
    // Otherwise the sale would read as settled with no balance anywhere saying
    // who was holding the money.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 0);
    p.driver_id = None;
    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("needs the driver"), "got: {err}");
}

#[tokio::test]
async fn a_delivery_fee_without_a_driver_is_refused() {
    let db = shop().await;
    let mut p = sale_payload(vec![burger(1)], vec![cash_usd(1_000)]);
    p.delivery_fee_cents = 300;
    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("delivery fee needs the driver"), "got: {err}");
}

#[tokio::test]
async fn a_negative_delivery_fee_is_refused() {
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 0);
    p.delivery_fee_cents = -1;
    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("cannot be negative"), "got: {err}");
}

#[tokio::test]
async fn a_driver_on_a_counter_sale_is_refused() {
    // A courier booked against a walk-in receipt describes nothing that
    // happened, and would move the order between the two channel figures.
    let db = shop().await;
    let mut p = sale_payload(vec![burger(1)], vec![cash_usd(1_000)]);
    p.driver_id = Some(ALI.to_string());
    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("Only a delivery order"), "got: {err}");
}

#[tokio::test]
async fn an_unknown_or_other_stores_driver_is_refused() {
    let db = shop().await;
    seed_store(&db, "00000000-0000-0000-0000-0000000000f9", "Other branch").await;
    seed_driver_in_store(
        &db,
        "00000000-0000-0000-0000-00000000d0f9",
        "Outsider",
        "00000000-0000-0000-0000-0000000000f9",
        true,
    )
    .await;

    let mut p = delivery_payload(vec![burger(1)], "no-such-driver", 0);
    p.driver_id = Some("no-such-driver".to_string());
    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("does not exist"), "got: {err}");

    let p2 = delivery_payload(vec![burger(1)], "00000000-0000-0000-0000-00000000d0f9", 0);
    let err2 = post_sale_with_pool(db.pool(), p2).await.expect_err("must refuse");
    assert!(err2.contains("not a driver of store"), "got: {err2}");
}

#[tokio::test]
async fn an_inactive_driver_cannot_take_a_new_order() {
    let db = shop().await;
    let retired = "00000000-0000-0000-0000-00000000d0aa";
    seed_inactive_driver(&db, retired, "Retired Rami").await;
    let p = delivery_payload(vec![burger(1)], retired, 0);
    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("no longer active"), "got: {err}");
}

#[tokio::test]
async fn a_refused_delivery_sale_consumes_no_receipt_number_and_leaves_no_balance() {
    // The "posting failure does not create orphan balances" requirement. The
    // driver checks run before the receipt number is drawn, so a bad order
    // costs the sequence nothing and leaves no trace at all.
    let db = shop().await;
    let mut bad = delivery_payload(vec![burger(1)], ALI, 0);
    bad.driver_id = Some("no-such-driver".to_string());
    post_sale_with_pool(db.pool(), bad).await.expect_err("must refuse");

    assert!(ledger_rows(&db, ALI).await.is_empty(), "no orphan balance");
    let sales: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales").fetch_one(db.pool()).await.unwrap();
    assert_eq!(sales, 0, "and no draft left behind");

    // The next good sale is still receipt #1.
    let good = delivery_payload(vec![burger(1)], ALI, 0);
    let r = post_sale_with_pool(db.pool(), good).await.expect("post");
    assert_eq!(r.receipt_number, 1);
}

// ============================================================================
// 4. Replay — one sale, one receivable
// ============================================================================

#[tokio::test]
async fn replaying_a_delivery_sale_duplicates_neither_the_sale_nor_the_receivable() {
    let db = shop().await;
    let p = delivery_payload(vec![burger(1)], ALI, 300);
    let replay = replay_of_with_new_child_ids(&p);
    let first = post_sale_with_pool(db.pool(), p).await.expect("first post");
    let again = post_sale_with_pool(db.pool(), replay).await.expect("replay reconciles");

    assert_eq!(first.receipt_number, again.receipt_number, "same receipt");
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "and ONE receivable");
    assert_eq!(ledger_rows(&db, ALI).await.len(), 1);
}

#[tokio::test]
async fn replaying_with_a_different_driver_is_a_conflict() {
    // Accepted-and-ignored would be the dangerous outcome: the receivable would
    // stay on Ali while the screen believed it had moved to Hassan.
    let db = shop().await;
    let p = delivery_payload(vec![burger(1)], ALI, 300);
    let mut replay = replay_of(&p);
    replay.driver_id = Some(HASSAN.to_string());
    post_sale_with_pool(db.pool(), p).await.expect("first post");
    let err = post_sale_with_pool(db.pool(), replay).await.expect_err("must conflict");
    assert!(err.contains("delivery driver"), "got: {err}");

    assert_eq!(driver_balance(&db, ALI).await, 1_000, "Ali still owes it");
    assert_eq!(driver_balance(&db, HASSAN).await, 0, "and Hassan owes nothing");
}

#[tokio::test]
async fn replaying_with_a_different_delivery_fee_is_a_conflict() {
    let db = shop().await;
    let p = delivery_payload(vec![burger(1)], ALI, 300);
    let mut replay = replay_of(&p);
    replay.delivery_fee_cents = 900;
    post_sale_with_pool(db.pool(), p).await.expect("first post");
    let err = post_sale_with_pool(db.pool(), replay).await.expect_err("must conflict");
    assert!(err.contains("delivery fee"), "got: {err}");
}

#[tokio::test]
async fn two_drivers_keep_separate_balances() {
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 100))
        .await
        .expect("post");
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 100))
        .await
        .expect("post");
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], HASSAN, 200))
        .await
        .expect("post");

    assert_eq!(driver_balance(&db, ALI).await, 3_000, "one plus two burgers");
    assert_eq!(driver_balance(&db, HASSAN).await, 1_000);

    // And a remittance from one does not touch the other.
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 3_000))
        .await
        .expect("Ali settles");
    assert_eq!(driver_balance(&db, ALI).await, 0);
    assert_eq!(driver_balance(&db, HASSAN).await, 1_000, "Hassan is unaffected");
}

// ============================================================================
// 5. Settlements
// ============================================================================

#[tokio::test]
async fn a_partial_then_full_settlement_reconciles() {
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(3)], ALI, 500))
        .await
        .expect("post");
    assert_eq!(driver_balance(&db, ALI).await, 3_000);

    let r1 = post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_200))
        .await
        .expect("partial");
    assert_eq!(r1.amount_cents, -1_200, "a remittance is stored negative");
    assert_eq!(r1.new_balance_cents, 1_800);
    assert_eq!(driver_balance(&db, ALI).await, 1_800);

    let r2 = post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_800))
        .await
        .expect("the rest");
    assert_eq!(r2.new_balance_cents, 0, "settled to the cent");
    assert_eq!(driver_balance(&db, ALI).await, 0);
}

#[tokio::test]
async fn a_remittance_creates_no_sale_and_no_revenue() {
    // The double-counting requirement. A remittance is cash arriving against a
    // receivable, not a transaction — the revenue was recognised when the order
    // posted.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 300))
        .await
        .expect("post");
    let sales_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sales").fetch_one(db.pool()).await.unwrap();
    let revenue_before: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(total_incl_vat_cents), 0) FROM sales WHERE status = 'posted'")
            .fetch_one(db.pool())
            .await
            .unwrap();

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("remit");

    let sales_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sales").fetch_one(db.pool()).await.unwrap();
    let revenue_after: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(total_incl_vat_cents), 0) FROM sales WHERE status = 'posted'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(sales_after, sales_before, "no second sale");
    assert_eq!(revenue_after, revenue_before, "and no second helping of revenue");

    // Nor any tender row, which is what a report would sum.
    let payments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sale_payments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(payments, 1, "the order's own driver_collection leg, and nothing else");
}

#[tokio::test]
async fn over_settlement_is_refused() {
    // The shop carries no driver advance, and the ledger is immutable, so an
    // overshoot could never be unwound.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    let err = post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_001))
        .await
        .expect_err("must refuse");
    assert!(err.contains("more than"), "got: {err}");
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "balance untouched");
}

#[tokio::test]
async fn settling_a_driver_who_owes_nothing_is_refused() {
    let db = shop().await;
    let err = post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 100))
        .await
        .expect_err("must refuse");
    assert!(err.contains("nothing outstanding"), "got: {err}");
}

#[tokio::test]
async fn a_duplicate_settlement_submission_reconciles_instead_of_paying_twice() {
    // The retry case: the cash is in the till, the ledger says so, and the
    // caller needs to be told which entry it was.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 0))
        .await
        .expect("post");

    let payload = remit_usd(ALI, 800);
    let entry_id = payload.ledger_entry_id.clone();
    let replay = PostDriverRemittancePayload { ..remit_usd(ALI, 800) };
    let replay = PostDriverRemittancePayload { ledger_entry_id: entry_id.clone(), ..replay };

    let first = post_driver_remittance_with_pool(db.pool(), payload).await.expect("first");
    let again = post_driver_remittance_with_pool(db.pool(), replay).await.expect("replay");

    assert_eq!(first.posted_at, again.posted_at, "the same entry, not a second one");
    assert_eq!(driver_balance(&db, ALI).await, 1_200, "paid down once");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM driver_ledger WHERE id = ?")
        .bind(&entry_id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn replaying_a_settlement_with_a_different_amount_is_a_conflict() {
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 0))
        .await
        .expect("post");
    let payload = remit_usd(ALI, 800);
    let entry_id = payload.ledger_entry_id.clone();
    post_driver_remittance_with_pool(db.pool(), payload).await.expect("first");

    let conflicting =
        PostDriverRemittancePayload { ledger_entry_id: entry_id, ..remit_usd(ALI, 900) };
    let err = post_driver_remittance_with_pool(db.pool(), conflicting)
        .await
        .expect_err("must conflict");
    assert!(err.contains("already exists with a different"), "got: {err}");
}

#[tokio::test]
async fn two_separate_settlements_of_the_same_amount_are_two_settlements() {
    // A driver really can hand over $8.00 twice. Identity, not amount, decides.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 0))
        .await
        .expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 800)).await.expect("one");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 800)).await.expect("two");
    assert_eq!(driver_balance(&db, ALI).await, 400);
}

#[tokio::test]
async fn a_remittance_sent_with_the_wrong_sign_still_pays_the_balance_down() {
    // The direction is the backend's. A caller cannot accidentally increase
    // what a driver owes by sending a positive — or a negative — magnitude.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    let mut p = remit_usd(ALI, 400);
    p.amount_magnitude_cents = -99_999; // ignored for a remittance
    p.direction = Some("increase".to_string()); // also ignored
    let r = post_driver_remittance_with_pool(db.pool(), p).await.expect("remit");
    assert_eq!(r.amount_cents, -400);
    assert_eq!(driver_balance(&db, ALI).await, 600);
}

#[tokio::test]
async fn a_lira_remittance_converts_at_the_rate_on_record() {
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");

    // 447,500 lira at 89,500/USD is exactly $5.00.
    let r = post_driver_remittance_with_pool(db.pool(), remit_lbp(ALI, 447_500))
        .await
        .expect("remit lira");
    assert_eq!(r.amount_cents, -500, "derived, not declared");
    assert_eq!(driver_balance(&db, ALI).await, 500);

    // And the lira that actually arrived is on the row, in lira.
    let (cur, lbp, usd): (String, i64, i64) = sqlx::query_as(
        "SELECT received_currency, received_native_lbp, received_native_usd_cents
           FROM driver_ledger WHERE id = ?",
    )
    .bind(&r.ledger_entry_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!((cur.as_str(), lbp, usd), ("LBP", 447_500, 0));
}

#[tokio::test]
async fn a_lira_remittance_at_a_rate_that_is_not_on_record_is_refused() {
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    let mut p = remit_lbp(ALI, 447_500);
    p.exchange_rate_lbp_per_usd = Some(50_000); // a kinder rate than the shop's
    let err = post_driver_remittance_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("Exchange rate mismatch"), "got: {err}");
}

#[tokio::test]
async fn a_lira_remittance_without_a_rate_is_refused_and_a_dollar_one_with_a_rate_too() {
    let db = shop().await;
    let mut no_rate = remit_lbp(ALI, 447_500);
    no_rate.exchange_rate_lbp_per_usd = None;
    let e1 = post_driver_remittance_with_pool(db.pool(), no_rate).await.expect_err("refuse");
    assert!(e1.contains("must say what rate"), "got: {e1}");

    let mut usd_with_rate = remit_usd(ALI, 100);
    usd_with_rate.exchange_rate_lbp_per_usd = Some(RATE_LBP_PER_USD);
    usd_with_rate.exchange_rate_id = Some(RATE_ID.to_string());
    let e2 = post_driver_remittance_with_pool(db.pool(), usd_with_rate)
        .await
        .expect_err("refuse");
    assert!(e2.contains("needs no exchange rate"), "got: {e2}");
}

#[tokio::test]
async fn a_collection_cannot_be_posted_as_a_settlement() {
    // A collection is a consequence of a sale and is written in that sale's own
    // transaction. Allowing it here would let a balance disagree with the
    // receipts behind it.
    let db = shop().await;
    let mut p = remit_usd(ALI, 100);
    p.entry_type = "collection".to_string();
    let err = post_driver_remittance_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("cannot be posted on its own"), "got: {err}");
}

#[tokio::test]
async fn an_adjustment_needs_a_direction_and_a_reason() {
    let db = shop().await;
    let mut no_reason = adjust(ALI, 500, "decrease");
    no_reason.notes = None;
    // The database CHECK is the backstop; the command refuses it first only if
    // it validates notes, so either message is acceptable — what matters is
    // that the row does not land.
    assert!(post_driver_remittance_with_pool(db.pool(), no_reason).await.is_err());

    let mut no_direction = adjust(ALI, 500, "decrease");
    no_direction.direction = None;
    let err = post_driver_remittance_with_pool(db.pool(), no_direction)
        .await
        .expect_err("must refuse");
    assert!(err.contains("increases or decreases"), "got: {err}");

    assert_eq!(driver_balance(&db, ALI).await, 0, "nothing landed");
}

#[tokio::test]
async fn an_adjustment_is_the_only_way_to_a_negative_balance() {
    // Deliberately reachable, because a shop genuinely can owe a driver — but
    // only through an instrument a human signed, never through a typo.
    let db = shop().await;
    let r = post_driver_remittance_with_pool(db.pool(), adjust(ALI, 250, "decrease"))
        .await
        .expect("signed-off adjustment");
    assert_eq!(r.new_balance_cents, -250, "credit on file");

    post_driver_remittance_with_pool(db.pool(), adjust(ALI, 250, "increase"))
        .await
        .expect("and back");
    assert_eq!(driver_balance(&db, ALI).await, 0);
}

#[tokio::test]
async fn a_posted_settlement_cannot_be_edited_or_deleted() {
    // Corrections go through another row, never through an edit.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    let r = post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 400))
        .await
        .expect("remit");

    let upd = sqlx::query("UPDATE driver_ledger SET amount_cents = -1 WHERE id = ?")
        .bind(&r.ledger_entry_id)
        .execute(db.pool())
        .await;
    assert!(upd.is_err(), "a posted settlement is immutable");

    let del = sqlx::query("DELETE FROM driver_ledger WHERE id = ?")
        .bind(&r.ledger_entry_id)
        .execute(db.pool())
        .await;
    assert!(del.is_err(), "and cannot be deleted");

    assert_eq!(driver_balance(&db, ALI).await, 600, "unchanged by either attempt");
}

#[tokio::test]
async fn a_retired_driver_may_still_settle_what_he_is_holding() {
    // Retiring a driver stops new orders. It must not trap the shop's money on
    // his balance for ever.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    sqlx::query("UPDATE drivers SET is_active = 0 WHERE id = ?")
        .bind(ALI)
        .execute(db.pool())
        .await
        .expect("retire Ali");

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("a retired driver can still pay up");
    assert_eq!(driver_balance(&db, ALI).await, 0);
}

// ============================================================================
// 6. Returns on a delivery order
// ============================================================================

#[tokio::test]
async fn a_return_credits_the_driver_and_opens_no_drawer() {
    // The customer is settled by the driver out of the same cash he is holding.
    // So the receivable falls and the till is not touched — which is the
    // alternative to "invent a cash refund".
    let db = shop_with_float(2_000, 0).await;
    let sale = delivery_payload(vec![burger(2)], ALI, 300);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    assert_eq!(driver_balance(&db, ALI).await, 2_000);

    let item_id: String =
        sqlx::query_scalar("SELECT id FROM sale_items WHERE sale_id = ? LIMIT 1")
            .bind(&sale_id)
            .fetch_one(db.pool())
            .await
            .unwrap();

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![PostCreditMemoRefund {
            refund_id: uuid(),
            method: "driver_collection".to_string(),
            currency: "USD".to_string(),
            amount_native_usd_cents: 1_000,
            amount_native_lbp: 0,
            amount_usd_cents_equivalent: 1_000,
            reference: None,
        }],
    );
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.expect("return posts");

    assert_eq!(driver_balance(&db, ALI).await, 1_000, "one burger's worth credited back");
    let rows = ledger_rows(&db, ALI).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].0, "return_credit");
    assert_eq!(rows[1].1, -1_000, "negative: he owes less");

    let memo_link: Option<String> = sqlx::query_scalar(
        "SELECT related_credit_memo_id FROM driver_ledger WHERE entry_type = 'return_credit'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(memo_link, Some(memo_id), "traceable to the memo that caused it");

    // The drawer never moved, in either direction.
    let closed = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 2_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close");
    assert_eq!(closed.expected_cash_usd_cents, Some(2_000));
    assert_eq!(closed.variance_usd_cents, Some(0));

    // And the stock came back.
    let on_hand: i64 = sqlx::query_scalar("SELECT quantity_on_hand FROM products WHERE id = ?")
        .bind(P_BURGER)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(on_hand, 99, "sold 2, returned 1");
}

#[tokio::test]
async fn a_delivery_order_cannot_be_refunded_in_cash_while_the_driver_holds_it() {
    // WP-7 §5. The money is not at the till unless the driver handed it in,
    // and whether THIS order’s notes are the ones in the drawer is not
    // determinable — remittances are allocated per driver, never per invoice.
    // So an unapproved cash refund is blocked, and the message names both
    // honest options instead of quietly choosing between them.
    let db = shop_with_float(5_000, 0).await;
    let sale = delivery_payload(vec![burger(1)], ALI, 300);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id: String =
        sqlx::query_scalar("SELECT id FROM sale_items WHERE sale_id = ? LIMIT 1")
            .bind(&sale_id)
            .fetch_one(db.pool())
            .await
            .unwrap();

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![refund_cash_usd(1_000)],
    );
    let err = post_credit_memo_with_pool(db.pool(), memo).await.expect_err("must refuse");
    // He is still holding the money, so the till is not the payer and the
    // message points at the one honest route.
    assert!(err.contains("refund it through the driver"), "got: {err}");
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "and nothing was credited");

    // Nothing was written at all: no memo, no refund leg, no ledger row.
    let memos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_credit_memos")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(memos, 0, "a blocked refund leaves no document behind");
}

#[tokio::test]
async fn a_counter_sale_cannot_be_refunded_to_a_driver() {
    // The cap in the other direction: crediting a driver for a sale he never
    // carried would invent a credit against his balance.
    let db = shop_with_float(5_000, 0).await;
    let sale = sale_payload(vec![burger(1)], vec![cash_usd(1_000)]);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id: String =
        sqlx::query_scalar("SELECT id FROM sale_items WHERE sale_id = ? LIMIT 1")
            .bind(&sale_id)
            .fetch_one(db.pool())
            .await
            .unwrap();

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![PostCreditMemoRefund {
            refund_id: uuid(),
            method: "driver_collection".to_string(),
            currency: "USD".to_string(),
            amount_native_usd_cents: 1_000,
            amount_native_lbp: 0,
            amount_usd_cents_equivalent: 1_000,
            reference: None,
        }],
    );
    let err = post_credit_memo_with_pool(db.pool(), memo).await.expect_err("must refuse");
    assert!(err.contains("method the sale used"), "got: {err}");
}

#[tokio::test]
async fn returns_cannot_drive_a_driver_balance_negative() {
    // The cumulative per-method tender cap already guarantees it: the credits
    // across every memo of a sale can never exceed what he collected for it.
    let db = shop().await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id: String =
        sqlx::query_scalar("SELECT id FROM sale_items WHERE sale_id = ? LIMIT 1")
            .bind(&sale_id)
            .fetch_one(db.pool())
            .await
            .unwrap();

    let driver_refund = |cents: i64| PostCreditMemoRefund {
        refund_id: uuid(),
        method: "driver_collection".to_string(),
        currency: "USD".to_string(),
        amount_native_usd_cents: cents,
        amount_native_lbp: 0,
        amount_usd_cents_equivalent: cents,
        reference: None,
    };

    // Both units back: the full $20.00.
    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(2).build()],
        vec![driver_refund(2_000)],
    );
    post_credit_memo_with_pool(db.pool(), memo).await.expect("full return");
    assert_eq!(driver_balance(&db, ALI).await, 0);

    // A third unit does not exist, and a further credit is refused.
    let extra = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    assert!(post_credit_memo_with_pool(db.pool(), extra).await.is_err());
    assert_eq!(driver_balance(&db, ALI).await, 0, "never negative");
}

#[tokio::test]
async fn a_return_after_settlement_is_refused_rather_than_going_negative() {
    // The policy WP-7 reverses. Ali handed over $20.00, then a burger came
    // back. Crediting him again would assert the shop owes him money it never
    // took from him — the cash is in the till, so the till is the payer.
    //
    // `driver_ledger` is append-only, so an automatic negative could never be
    // removed, only offset by an entry that misstates something else. The
    // refusal names the amount already handed in.
    let db = shop_with_float(0, 0).await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 2_000))
        .await
        .expect("settle in full");
    assert_eq!(driver_balance(&db, ALI).await, 0);

    let item_id = first_item(&db, &sale_id).await;
    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    let err = post_credit_memo_with_pool(db.pool(), memo)
        .await
        .expect_err("must refuse an automatic negative");
    assert!(err.contains("only holding 0"), "got: {err}");
    assert!(err.contains("already been handed in to the till"), "got: {err}");
    assert!(err.contains("signed-off driver adjustment"), "got: {err}");
    assert!(
        !err.contains("manager decision"),
        "the refusal must not offer a path item 6 disabled: {err}"
    );

    assert_eq!(driver_balance(&db, ALI).await, 0, "never negative, and never touched");
}

#[tokio::test]
async fn the_engine_refuses_an_automatic_negative_even_from_another_writer() {
    // `trg_driver_ledger_no_automatic_negative` (migration 016) is the backstop
    // behind the command's own check: the rule has to hold for any writer,
    // because an append-only ledger gives no second chance.
    let db = shop().await;
    let inserted = sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                    entry_date, related_credit_memo_id)
         VALUES (?, ?, ?, 'return_credit', -500, '2026-10-21', NULL)",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .execute(db.pool())
    .await;
    assert!(inserted.is_err(), "a bare negative return credit must be refused");
    assert_eq!(driver_balance(&db, ALI).await, 0);
}

#[tokio::test]
async fn an_approval_string_does_NOT_unlock_a_drawer_funded_refund() {
    // WP-7 item 6. The drawer-funded path is economically sound — once the
    // driver has remitted, the money IS in the till — but it was gated on a
    // `manager_approval` string, and that is not a gate.
    //
    // This application has no authentication and no permission enforcement:
    // `users.role` is schema-only and read by nothing, there is no login or
    // session, and the active user is whichever `owner` row sorts first at
    // boot. So the "approval" is a sentence the cashier types. Accepting it
    // would let anyone at the till pay money out of the drawer against a
    // receipt the drawer never collected, with an audit trail claiming a
    // manager agreed — worse than not having the feature, because it
    // manufactures the appearance of control.
    let db = shop_with_float(0, 0).await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 2_000))
        .await
        .expect("settle in full");

    let item_id = first_item(&db, &sale_id).await;
    let mut memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![refund_cash_usd(1_000)],
    );
    memo.manager_approval = Some("Owner approved, honestly".to_string());

    let err = post_credit_memo_with_pool(db.pool(), memo)
        .await
        .expect_err("an approval string must not unlock the drawer");
    assert!(err.contains("cannot refund it here"), "got: {err}");
    assert!(err.contains("signed-off driver adjustment"), "got: {err}");

    // Nothing moved: no memo, no drawer movement, no change to his balance.
    let memos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_credit_memos")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(memos, 0);
    assert_eq!(driver_balance(&db, ALI).await, 0);
    assert_eq!(drawer_expected(&db).await, 2_000, "the remittance, and nothing else");
}

#[tokio::test]
async fn the_refusal_is_the_same_with_or_without_an_approval_string() {
    // Stated on its own so a reader cannot mistake the field for a switch that
    // is merely turned off: it has no effect on the verdict at all.
    let db = shop_with_float(0, 0).await;
    let sale = delivery_payload(vec![burger(1)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("settle");
    let item_id = first_item(&db, &sale_id).await;

    let bare = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![refund_cash_usd(1_000)],
    );
    let without = post_credit_memo_with_pool(db.pool(), bare).await.expect_err("refused");

    let mut approved = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![refund_cash_usd(1_000)],
    );
    approved.manager_approval = Some("the manager said yes".to_string());
    let with = post_credit_memo_with_pool(db.pool(), approved).await.expect_err("refused");

    assert_eq!(without, with, "the approval field changes nothing");
}

#[tokio::test]
async fn a_driver_credit_is_still_available_while_he_holds_the_money() {
    // The path that remains open, and the one the confirmed workflow actually
    // needs: the driver has not handed it in yet, so he is the payer and his
    // balance is the thing that moves. No drawer, no approval, no exception.
    let db = shop_with_float(0, 0).await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    assert_eq!(driver_balance(&db, ALI).await, 2_000);

    let item_id = first_item(&db, &sale_id).await;
    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    post_credit_memo_with_pool(db.pool(), memo).await.expect("driver-funded return posts");

    assert_eq!(driver_balance(&db, ALI).await, 1_000);
    assert_eq!(drawer_expected(&db).await, 0, "and the till is untouched");

    // He then hands in what is actually left, and the books agree.
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("settle the remainder");
    assert_eq!(driver_balance(&db, ALI).await, 0);
    assert_eq!(drawer_expected(&db).await, 1_000);
}

// ============================================================================
// 7. Mixed currency, and the ledger's own arithmetic
// ============================================================================

#[tokio::test]
async fn a_lira_collection_is_recorded_at_the_sales_locked_rate() {
    let db = shop().await;
    // One water, VAT-exempt, $1.00 — collected in lira at the locked rate.
    let mut p = delivery_payload(vec![water(1)], ALI, 0);
    p.payments = vec![driver_collection_lbp(89_500)];
    post_sale_with_pool(db.pool(), p).await.expect("post");

    // 89,500 lira at 89,500/USD is $1.00.
    assert_eq!(driver_balance(&db, ALI).await, 100);
}

#[tokio::test]
async fn a_mixed_currency_delivery_sums_both_legs_into_one_receivable() {
    let db = shop().await;
    // $11.00 of food: one burger ($10.00) and one water ($1.00).
    let mut p = delivery_payload(vec![burger(1), water(1)], ALI, 0);
    p.payments = vec![driver_collection_usd(1_000), driver_collection_lbp(89_500)];
    post_sale_with_pool(db.pool(), p).await.expect("post");

    assert_eq!(driver_balance(&db, ALI).await, 1_100, "$10.00 plus $1.00 of lira");
    assert_eq!(ledger_rows(&db, ALI).await.len(), 1, "one receivable, not one per leg");

    // And a lira remittance settles part of it.
    post_driver_remittance_with_pool(db.pool(), remit_lbp(ALI, 895_000))
        .await
        .expect("remit $10.00 of lira");
    assert_eq!(driver_balance(&db, ALI).await, 100);
}

#[tokio::test]
async fn the_balance_view_reconciles_to_the_ledger_rows() {
    // Every figure the owner reads comes from the same rows, so the parts
    // cannot fail to add up to the balance.
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(3)], ALI, 300))
        .await
        .expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("remit");
    post_driver_remittance_with_pool(db.pool(), adjust(ALI, 50, "decrease"))
        .await
        .expect("adjust");

    let (outstanding, collected, remitted, credits, adjustments, count): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = sqlx::query_as(
        "SELECT outstanding_cents, collected_cents, remitted_cents, return_credit_cents,
                adjustment_cents, collection_count
           FROM driver_balances WHERE driver_id = ?",
    )
    .bind(ALI)
    .fetch_one(db.pool())
    .await
    .unwrap();

    assert_eq!(collected, 3_000);
    assert_eq!(remitted, 1_000);
    assert_eq!(credits, 0);
    assert_eq!(adjustments, -50);
    assert_eq!(count, 1);
    assert_eq!(
        outstanding,
        collected - remitted - credits + adjustments,
        "the balance IS the sum of its parts"
    );
    assert_eq!(outstanding, 1_950);

    let ledger_sum: i64 =
        sqlx::query_scalar("SELECT SUM(amount_cents) FROM driver_ledger WHERE driver_id = ?")
            .bind(ALI)
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(outstanding, ledger_sum, "and it is the ledger, not a second query");
}

#[tokio::test]
async fn sales_by_channel_still_reconciles_to_total_posted_sales() {
    // Priority 4's reconciliation requirement, at the database level: the
    // channel figures must continue to sum to the posted-sales total, with the
    // delivery fee in NEITHER of them.
    let db = shop().await;
    post_sale_with_pool(db.pool(), sale_payload(vec![burger(1)], vec![cash_usd(1_000)]))
        .await
        .expect("counter");
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 250))
        .await
        .expect("delivery");
    post_sale_with_pool(db.pool(), delivery_payload(vec![water(1)], HASSAN, 150))
        .await
        .expect("delivery 2");

    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT channel, COUNT(*), SUM(total_incl_vat_cents), SUM(delivery_fee_cents)
           FROM sales WHERE status = 'posted' GROUP BY channel ORDER BY channel",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("counter".to_string(), 1, 1_000, 0),
            ("online_delivery".to_string(), 2, 1_100, 400),
        ]
    );

    let (total, orders, fees): (i64, i64, i64) = sqlx::query_as(
        "SELECT SUM(total_incl_vat_cents), COUNT(*), SUM(delivery_fee_cents)
           FROM sales WHERE status = 'posted'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(total, 2_100, "the parts sum to the whole");
    assert_eq!(orders, 3);
    assert_eq!(fees, 400, "and the fees are tracked beside revenue, not inside it");

    // The receivables reconcile to the delivery food total, since both delivery
    // orders were collected in full.
    let receivables: i64 =
        sqlx::query_scalar("SELECT SUM(amount_cents) FROM driver_ledger WHERE entry_type = 'collection'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(receivables, 1_100, "delivery food money, with no fee in it");
}

// ============================================================================
// 8. A remittance is a DRAWER event (WP-7)
//
// The owner's decision, and the reversal of the open question migration 015
// recorded: the driver returns the food payment to the cashier's normal cash
// drawer. So a remittance needs an open shift to land in, and the expected
// cash figure has to include it.
//
// The figure that matters is the NATIVE amount. A driver who collected $17 —
// $15 of food and $2 of his own delivery charge — remits $15, and $15 is what
// the till expects. The $2 was never the shop's money.
// ============================================================================

/// Close `SHIFT_ID` and return the snapshot, counting `usd`/`lbp` in the till.
async fn close_counting(db: &TempDb, usd: i64, lbp: i64) -> crate::posting::ShiftSnapshot {
    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: usd,
            closing_cash_lbp: lbp,
        },
    )
    .await
    .expect("close shift")
}

#[tokio::test]
async fn a_remittance_increases_expected_drawer_cash_by_exactly_what_arrived() {
    // The requirement's own example. $15.00 of food collected with a $2.00
    // delivery charge on top: the driver owes $15.00, hands over $15.00, and
    // the till expects $15.00 — not $17.00.
    let db = shop_with_float(0, 0).await;
    let mut sale = delivery_payload(vec![burger(1)], ALI, 200);
    // One burger is $10.00; price a $15.00 food total by selling one and a half
    // burgers' worth through the half-dollar water lines instead.
    sale.payments = vec![driver_collection_usd(1_000)];
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "the food only");

    // Nothing in the drawer yet: the money is in his pocket.
    let before = drawer_expected(&db).await;
    assert_eq!(before, 0, "a collection is not a till event");

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("he hands the food money in");

    assert_eq!(driver_balance(&db, ALI).await, 0, "and owes nothing");
    assert_eq!(
        drawer_expected(&db).await,
        1_000,
        "the till expects the food money, and not his delivery charge"
    );

    let closed = close_counting(&db, 1_000, 0).await;
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000));
    assert_eq!(closed.variance_usd_cents, Some(0), "and it reconciles");
}

#[tokio::test]
async fn the_delivery_fee_never_reaches_the_drawer() {
    // Stated on its own, because it is the whole accounting boundary. Three
    // delivery orders with $9.00 of charges between them put $0.00 of fee into
    // the till, however much is remitted.
    let db = shop_with_float(0, 0).await;
    for fee in [300, 200, 400] {
        post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, fee))
            .await
            .expect("post");
    }
    assert_eq!(driver_balance(&db, ALI).await, 3_000);

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 3_000))
        .await
        .expect("settle in full");

    let fees: i64 = sqlx::query_scalar("SELECT SUM(delivery_fee_cents) FROM sales")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(fees, 900, "the charges are recorded");
    assert_eq!(
        drawer_expected(&db).await,
        3_000,
        "and none of them is in the till"
    );
}

#[tokio::test]
async fn a_lira_remittance_adds_lira_to_the_drawer_and_not_dollars() {
    // Dollars stay dollars and lira stay lira. Converting a lira remittance
    // into the USD figure would make the till expect notes nobody put there.
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");

    // 447,500 lira at the fixture rate is exactly $5.00.
    post_driver_remittance_with_pool(db.pool(), remit_lbp(ALI, 447_500))
        .await
        .expect("remit lira");

    let closed = close_counting(&db, 0, 447_500).await;
    assert_eq!(closed.expected_cash_usd_cents, Some(0), "no dollars arrived");
    assert_eq!(closed.expected_cash_lbp, Some(447_500), "the lira did");
    assert_eq!(closed.variance_usd_cents, Some(0));
    assert_eq!(closed.variance_lbp, Some(0));

    // The driver's BALANCE moved by the USD equivalent, which is a different
    // question from what the drawer holds.
    assert_eq!(driver_balance(&db, ALI).await, 500);
}

#[tokio::test]
async fn counter_cash_and_driver_remittances_add_up_in_one_drawer() {
    // The reconciliation the owner actually counts: a counter sale's cash and a
    // driver's hand-over are the same till.
    let db = shop_with_float(5_000, 0).await;
    post_sale_with_pool(db.pool(), sale_payload(vec![burger(1)], vec![cash_usd(1_000)]))
        .await
        .expect("counter sale");
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 300))
        .await
        .expect("delivery");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_200))
        .await
        .expect("partial hand-over");

    // $50.00 float + $10.00 counter cash + $12.00 from Ali.
    let closed = close_counting(&db, 7_200, 0).await;
    assert_eq!(closed.expected_cash_usd_cents, Some(7_200));
    assert_eq!(closed.variance_usd_cents, Some(0));
    // And he still owes the $8.00 he has not handed in.
    assert_eq!(driver_balance(&db, ALI).await, 800);
}

#[tokio::test]
async fn a_partial_remittance_moves_only_what_was_handed_over() {
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(3)], ALI, 500))
        .await
        .expect("post");

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_250))
        .await
        .expect("part one");
    assert_eq!(drawer_expected(&db).await, 1_250);
    assert_eq!(driver_balance(&db, ALI).await, 1_750);

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_750))
        .await
        .expect("the rest");
    assert_eq!(drawer_expected(&db).await, 3_000);
    assert_eq!(driver_balance(&db, ALI).await, 0);
}

#[tokio::test]
async fn a_remittance_without_a_shift_is_refused() {
    // Cash that reached no till: no drawer count could ever reconcile against
    // it. The same hole that made `sales.shift_id` mandatory in WP-04.
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");

    let mut p = remit_usd(ALI, 500);
    p.shift_id = None;
    let err = post_driver_remittance_with_pool(db.pool(), p)
        .await
        .expect_err("must refuse");
    assert!(err.contains("Open a shift"), "got: {err}");
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "nothing moved");
    assert_eq!(drawer_expected(&db).await, 0);
}

#[tokio::test]
async fn a_remittance_into_a_closed_shift_is_refused() {
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    close_counting(&db, 0, 0).await;

    let err = post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 500))
        .await
        .expect_err("must refuse");
    assert!(err.to_lowercase().contains("shift"), "got: {err}");
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "nothing moved");
}

#[tokio::test]
async fn a_remittance_into_another_stores_shift_is_refused() {
    // Which store's drawer the cash lands in is the whole point of the row.
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");

    let other_store = "00000000-0000-0000-0000-0000000000fa";
    seed_store(&db, other_store, "Other branch").await;
    let other_shift = "00000000-0000-0000-0000-00000000fb01";
    sqlx::query(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, status) VALUES (?, ?, ?, 'open')",
    )
    .bind(other_shift)
    .bind(other_store)
    .bind(USER_ID)
    .execute(db.pool())
    .await
    .expect("seed other store shift");

    let mut p = remit_usd(ALI, 500);
    p.shift_id = Some(other_shift.to_string());
    assert!(post_driver_remittance_with_pool(db.pool(), p).await.is_err());
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "nothing moved");
}

#[tokio::test]
async fn a_replayed_remittance_does_not_double_the_drawer() {
    // The retry case, now that it moves cash. One hand-over, one drawer
    // increase, however many times the request is sent.
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 0))
        .await
        .expect("post");

    let payload = remit_usd(ALI, 800);
    let entry_id = payload.ledger_entry_id.clone();
    post_driver_remittance_with_pool(db.pool(), payload).await.expect("first");

    let replay = PostDriverRemittancePayload { ledger_entry_id: entry_id, ..remit_usd(ALI, 800) };
    post_driver_remittance_with_pool(db.pool(), replay).await.expect("replay reconciles");

    assert_eq!(drawer_expected(&db).await, 800, "counted once");
    assert_eq!(driver_balance(&db, ALI).await, 1_200);
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM driver_ledger WHERE entry_type = 'remittance'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(rows, 1);
}

#[tokio::test]
async fn a_replay_still_reconciles_after_its_shift_was_closed_and_counted() {
    // The WP-04 ordering, applied to money that has already been banked. The
    // idempotency resolution runs BEFORE the shift check, so a retry of a
    // remittance that already posted returns its entry rather than failing on
    // a shift nobody can reopen.
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");

    let payload = remit_usd(ALI, 600);
    let entry_id = payload.ledger_entry_id.clone();
    let first = post_driver_remittance_with_pool(db.pool(), payload).await.expect("first");
    close_counting(&db, 600, 0).await;

    let replay = PostDriverRemittancePayload { ledger_entry_id: entry_id, ..remit_usd(ALI, 600) };
    let again = post_driver_remittance_with_pool(db.pool(), replay)
        .await
        .expect("replay after close must still reconcile");
    assert_eq!(first.posted_at, again.posted_at);
    assert_eq!(again.new_balance_cents, 400);
}

#[tokio::test]
async fn an_adjustment_needs_no_shift_because_it_moves_no_cash() {
    // Deliberately not shift-scoped: a manager may sign one off outside
    // trading hours, and nothing physical changes hands.
    let db = shop_with_float(0, 0).await;
    close_counting(&db, 0, 0).await; // no open shift at all

    let mut p = adjust(ALI, 250, "increase");
    p.shift_id = None;
    post_driver_remittance_with_pool(db.pool(), p)
        .await
        .expect("an adjustment posts without a shift");
    assert_eq!(driver_balance(&db, ALI).await, 250);
    // And it is not cash.
    let remitted: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(received_native_usd_cents), 0) FROM driver_ledger",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(remitted, 0);
}

#[tokio::test]
async fn the_shift_driver_cash_view_agrees_with_the_closing_reconciliation() {
    // Two readers of one set of rows. The shift screen and the reconciliation
    // must not be able to disagree about what the drivers brought in.
    let db = shop_with_float(1_000, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 0))
        .await
        .expect("post");
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], HASSAN, 0))
        .await
        .expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 2_000))
        .await
        .expect("Ali settles");
    post_driver_remittance_with_pool(db.pool(), remit_lbp(HASSAN, 895_000))
        .await
        .expect("Hassan settles in lira");

    let (count, usd, lbp, usd_equiv): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT remittance_count, remitted_usd_cents, remitted_lbp,
                remitted_usd_equivalent_cents
           FROM shift_driver_cash WHERE shift_id = ?",
    )
    .bind(SHIFT_ID)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(count, 2);
    assert_eq!(usd, 2_000);
    assert_eq!(lbp, 895_000);
    assert_eq!(usd_equiv, 3_000, "$20.00 plus $10.00 of lira");

    // The closing figures are the float plus exactly those native amounts.
    let closed = close_counting(&db, 3_000, 895_000).await;
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000 + usd));
    assert_eq!(closed.expected_cash_lbp, Some(lbp));
    assert_eq!(closed.variance_usd_cents, Some(0));
    assert_eq!(closed.variance_lbp, Some(0));
}

// ============================================================================
// 9. GZ-P1-1 — the delivery SHAPE is the backend's rule, not the screen's
// ============================================================================
//
// WP-7 left this gap open on purpose and said so: the register permitted only
// a driver collection, `post_sale` still accepted a delivery order part-settled
// at the till, and the gap was declared safe "because no cashier-facing path
// reaches the permissive side".
//
// That is an argument about today's UI, not about the data. `post_sale` is the
// authoritative boundary — it is reachable from a replayed payload, a future
// screen, a script, an import and a second terminal — and the shape it accepts
// is the shape the database can end up holding. A delivery order settled with
// cashier cash means the drawer expects money that is in a driver's pocket; one
// with no driver means food left the shelf and no balance says who owes for it.
//
// So the confirmed WhatsApp process is now enforced where it is true: a NEW
// delivery sale names an active driver of its own store, and the food money is
// collected by HIM in full. Checked after the idempotency resolution, so a
// historical row still replays to its own receipt, and before the receipt
// number, so a refusal costs the sequence nothing.

#[tokio::test]
async fn a_delivery_order_tendered_as_cashier_cash_is_refused() {
    // The failure this closes: the sale reads as settled, the drawer expects
    // $10.00 that never reached it, and the driver owes nothing for food he
    // is carrying.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 300);
    p.payments = vec![cash_usd(1_000)];

    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("not at the till"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert!(ledger_rows(&db, ALI).await.is_empty());
}

#[tokio::test]
async fn a_delivery_order_prepaid_by_card_alone_is_refused() {
    // WP-6 accepted this as "a legitimate financial shape". It is not one Greaz
    // operates: the confirmed process is that the driver collects, and a card
    // leg on a delivery order is an unreviewed settlement path, not a feature.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 300);
    p.payments = vec![card_usd(1_000)];

    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("not at the till"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
}

#[tokio::test]
async fn a_part_prepaid_delivery_order_is_refused() {
    // The mixed shape is the dangerous one, because it looks reconciled from
    // every angle: tender covers the total, the receivable is non-zero, and the
    // drawer is short by the card leg with nothing on screen saying why.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 300);
    p.payments = vec![card_usd(400), driver_collection_usd(600)];

    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("not at the till"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert!(ledger_rows(&db, ALI).await.is_empty(), "and no part-receivable");
}

#[tokio::test]
async fn a_delivery_order_with_no_driver_at_all_is_refused() {
    // Previously accepted: with no fee and no `driver_collection` leg, none of
    // WP-6's three coherence rules had anything to object to, so a delivery
    // order could post with cash and nobody carrying it.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 0);
    p.driver_id = None;
    p.payments = vec![cash_usd(1_000)];

    let err = post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert!(err.contains("must name the driver"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
}

#[tokio::test]
async fn a_delivery_order_whose_collection_undershoots_the_food_total_is_refused() {
    // He carries the food, so he owes the food total exactly. Less than that is
    // a receivable that understates what left the shop.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 300);
    p.payments = vec![driver_collection_usd(600)];

    post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert!(ledger_rows(&db, ALI).await.is_empty());
}

#[tokio::test]
async fn a_delivery_order_whose_collection_overshoots_the_food_total_is_refused() {
    // The delivery fee is the DRIVER's and is not part of the food money, so a
    // collection of food-plus-fee is the exact confusion WP-6 exists to
    // prevent: it would put his own fee on his balance as the shop's money.
    let db = shop().await;
    let mut p = delivery_payload(vec![burger(1)], ALI, 300);
    p.payments = vec![driver_collection_usd(1_300)];

    post_sale_with_pool(db.pool(), p).await.expect_err("must refuse");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert!(ledger_rows(&db, ALI).await.is_empty());
}

#[tokio::test]
async fn a_refused_delivery_shape_leaves_no_sale_no_receipt_and_no_balance() {
    let db = shop().await;
    let mut bad = delivery_payload(vec![burger(1)], ALI, 0);
    bad.payments = vec![cash_usd(1_000)];
    post_sale_with_pool(db.pool(), bad).await.expect_err("must refuse");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0, "no draft left behind");
    assert!(ledger_rows(&db, ALI).await.is_empty(), "no orphan balance");

    // The sequence is intact: the next good order is still receipt #1.
    let good = delivery_payload(vec![burger(1)], ALI, 300);
    let r = post_sale_with_pool(db.pool(), good).await.expect("post");
    assert_eq!(r.receipt_number, 1);
    assert_eq!(driver_balance(&db, ALI).await, 1_000);
}

#[tokio::test]
async fn a_counter_sale_is_untouched_by_the_delivery_shape_rule() {
    // The rule is scoped to the delivery channel. Counter keeps every tender
    // it ever took, including a split one with change.
    let db = shop().await;
    let p = sale_payload(vec![burger(1)], vec![cash_usd(1_500)]);
    let r = post_sale_with_pool(db.pool(), p).await.expect("counter sale posts");
    assert_eq!(r.receipt_number, 1);

    let split = sale_payload(vec![burger(1)], vec![card_usd(400), cash_usd(600)]);
    post_sale_with_pool(db.pool(), split).await.expect("split counter tender posts");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales WHERE status='posted'").await, 2);
    assert!(ledger_rows(&db, ALI).await.is_empty(), "and no driver is involved");
}

#[tokio::test]
async fn a_historical_part_prepaid_delivery_still_replays_to_its_own_receipt() {
    // THE ORDERING TEST. The new rule governs what may be WRITTEN from now on.
    // A row that predates it is history, and a retry of it must still resolve
    // on its identity — otherwise the cashier is handed a failure for money
    // that is already banked, which is the exact harm the idempotency contract
    // exists to prevent.
    let db = shop().await;
    let mut historical = delivery_payload(vec![burger(1)], ALI, 300);
    historical.shift_id = None; // as a pre-WP-4 row would have been
    historical.payments = vec![card_usd(400), driver_collection_usd(600)];
    seed_posted_sale_without_shift(&db, &historical).await;

    // The receivable that sale raised, as its own posting would have written it.
    sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_sale_id, posted_at
         ) VALUES (?, ?, ?, 'collection', 600, '2026-01-01', ?, '2026-01-01T09:00:00.000Z')",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .bind(&historical.sale_id)
    .execute(db.pool())
    .await
    .expect("seed the historical receivable");

    let replay = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&historical))
        .await
        .expect("a historical delivery order must still replay");

    assert_eq!(replay.receipt_number, 1, "its own receipt");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1, "and no second sale");
    assert_eq!(ledger_rows(&db, ALI).await.len(), 1, "one receivable, not two");
    assert_eq!(driver_balance(&db, ALI).await, 600, "untouched");
}

// ============================================================================
// 10. GZ-P1-3 — the ENGINE requires an OPEN shift for a remittance
// ============================================================================
//
// Migration 016 made a remittance name a shift, and `post_driver_remittance`
// refuses one that is not open. The trigger behind it only proved that the
// shift EXISTS and belongs to the entry's store — so the engine still accepted
// cash into a shift that had already been closed and counted, from any writer
// that was not that one command.
//
// That is not a theoretical hole: a closed shift's `expected_cash_*` and
// `variance_*` are computed once, in the transaction that closes it, and are
// immutable afterwards (migration 009). A remittance landing in it afterwards
// increases the cash the shift's drawer figure ought to have expected, on a row
// nobody will ever recount. The money is then in a till whose reconciliation
// says it is not.
//
// So the rule is stated in SQL, where it binds every writer.

#[tokio::test]
async fn the_engine_refuses_a_remittance_into_a_CLOSED_shift() {
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post a delivery order");

    // The shift is closed and counted. Its drawer figures are now immutable.
    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 0,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close the shift");

    let refused = sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           received_currency, received_native_usd_cents, shift_id
         ) VALUES (?, ?, ?, 'remittance', -1000, '2026-01-02', 'USD', 1000, ?)",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .bind(SHIFT_ID)
    .execute(db.pool())
    .await;

    let err = refused.expect_err("a closed shift may not acquire new cash").to_string();
    assert!(err.contains("open shift"), "got: {err}");

    // Nothing was written, so the balance still says he is holding it.
    assert_eq!(driver_balance(&db, ALI).await, 1_000);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='remittance'").await,
        0
    );
}

#[tokio::test]
async fn the_engine_refuses_a_remittance_into_a_shift_that_does_not_exist() {
    let db = shop().await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");

    let refused = sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           received_currency, received_native_usd_cents, shift_id
         ) VALUES (?, ?, ?, 'remittance', -1000, '2026-01-02', 'USD', 1000, 'no-such-shift')",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .execute(db.pool())
    .await;
    assert!(refused.is_err(), "a remittance cannot name a shift that is not there");
}

#[tokio::test]
async fn a_remittance_into_the_OPEN_shift_posts_and_the_drawer_expects_it() {
    // The positive control, and the reconciliation check: the rule must not be
    // so broad that it blocks the hand-over the feature exists for, and the
    // cash must land in the figure the cashier counts against.
    let db = shop_with_float(1_000, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 300))
        .await
        .expect("post");

    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("the driver hands the food money in");

    assert_eq!(driver_balance(&db, ALI).await, 0, "settled in full");
    // Float + the native dollars that arrived. The $3.00 delivery charge was
    // never the shop's and is in neither figure.
    assert_eq!(drawer_expected(&db).await, 2_000);

    let closed = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 2_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close");
    assert_eq!(closed.expected_cash_usd_cents, Some(2_000));
    assert_eq!(closed.variance_usd_cents, Some(0), "the till reconciles exactly");
}

#[tokio::test]
async fn a_remittance_recorded_while_the_shift_was_open_stands_after_it_closes() {
    // The rule governs WRITES. A row that was legitimate when it was made is
    // history, and closing the shift it landed in does not retract it.
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("post");
    post_driver_remittance_with_pool(db.pool(), remit_usd(ALI, 1_000))
        .await
        .expect("remit");

    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 1_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close");

    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='remittance'").await,
        1,
        "the hand-over is still on the books"
    );
    assert_eq!(driver_balance(&db, ALI).await, 0);
}

// ============================================================================
// 11. GZ-P1-4 — a return credit must come from THIS driver's own return
// ============================================================================
//
// Migration 015 proved the source of a COLLECTION: `related_sale_id` has to be
// a sale that names the same driver. It proved nothing at all about
// `related_credit_memo_id`, so a `return_credit` could point at any memo in the
// database — another driver's, another branch's, or one whose original sale was
// a counter sale with no driver — and reduce this driver's balance by it.
//
// The amount caps do not help: they bound the SIZE of a credit, not whose
// return justifies it. The result would be a driver whose balance had been
// written down against somebody else's refund, with a traceable link that
// pointed at a document contradicting it.

/// A memo of ALI's delivery order that carries NO automatic driver credit, so
/// an injected one is not refused merely by the one-credit-per-memo index.
///
/// Built on a HISTORICAL part-prepaid delivery order — a shape GZ-P1-1 now
/// refuses for new sales but which the engine still holds rows of — whose
/// return is refunded on the CARD leg it was prepaid with. No
/// `driver_collection` leg is refunded, so `post_credit_memo` writes no
/// `return_credit`, and the memo sits there as the unguarded source a bad
/// writer would reach for.
///
/// Returns `(sale_id, memo_id)`.
async fn a_memo_with_no_driver_credit(db: &TempDb) -> (String, String) {
    let mut historical = delivery_payload(vec![burger(5)], ALI, 0);
    historical.shift_id = None;
    historical.payments = vec![card_usd(4_000), driver_collection_usd(1_000)];
    let sale_id = historical.sale_id.clone();
    seed_posted_sale_without_shift(db, &historical).await;

    // The receivable that order raised, as its own posting would have written it.
    sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_sale_id, posted_at
         ) VALUES (?, ?, ?, 'collection', 1000, '2026-01-01', ?, '2026-01-01T09:00:00.000Z')",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .bind(&sale_id)
    .execute(db.pool())
    .await
    .expect("seed the historical receivable");

    let item_id = first_item(db, &sale_id).await;
    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![PostCreditMemoRefund {
            refund_id: uuid(),
            method: "card_usd".to_string(),
            currency: "USD".to_string(),
            amount_native_usd_cents: 1_000,
            amount_native_lbp: 0,
            amount_usd_cents_equivalent: 1_000,
            reference: None,
        }],
    );
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.expect("refund it to the card");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='return_credit'").await,
        0,
        "a card refund credits no driver, which is what leaves this memo unguarded"
    );
    (sale_id, memo_id)
}

#[tokio::test]
async fn the_engine_refuses_a_return_credit_against_ANOTHER_drivers_memo() {
    let db = shop().await;
    let (_sale, ali_memo) = a_memo_with_no_driver_credit(&db).await;
    // Hassan carries his own order, so he has a balance to be written down and
    // the no-automatic-negative trigger is not what refuses this.
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], HASSAN, 0))
        .await
        .expect("post Hassan's order");
    assert_eq!(driver_balance(&db, HASSAN).await, 1_000);

    let refused = sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_credit_memo_id
         ) VALUES (?, ?, ?, 'return_credit', -1000, '2026-01-02', ?)",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(HASSAN)
    .bind(&ali_memo)
    .execute(db.pool())
    .await;

    let err = refused.expect_err("one driver's return may not credit another").to_string();
    assert!(err.contains("return"), "got: {err}");
    assert_eq!(driver_balance(&db, HASSAN).await, 1_000, "his balance stands");
}

#[tokio::test]
async fn the_engine_refuses_a_return_credit_against_ANOTHER_STORES_memo() {
    // Two branches, one database. A memo of store A may not write down the
    // receivable of store B's driver: the stores keep separate books, and the
    // sign-discipline trigger already says an entry is filed against the
    // driver's own store.
    let db = shop().await;
    let (_sale, memo) = a_memo_with_no_driver_credit(&db).await;

    const OTHER_STORE: &str = "00000000-0000-0000-0000-00000000f001";
    const OTHER_DRIVER: &str = "00000000-0000-0000-0000-00000000d003";
    seed_store(&db, OTHER_STORE, "Greaz Branch Two").await;
    seed_driver_in_store(&db, OTHER_DRIVER, "Karim", OTHER_STORE, true).await;
    // Give Karim a balance with a signed-off adjustment, so the
    // no-automatic-negative trigger is not what refuses the row below.
    sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date, notes
         ) VALUES (?, ?, ?, 'adjustment', 5000, '2026-01-01', 'opening float, signed off')",
    )
    .bind(uuid())
    .bind(OTHER_STORE)
    .bind(OTHER_DRIVER)
    .execute(db.pool())
    .await
    .expect("seed the other branch driver a balance");

    let refused = sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_credit_memo_id
         ) VALUES (?, ?, ?, 'return_credit', -1000, '2026-01-02', ?)",
    )
    .bind(uuid())
    .bind(OTHER_STORE)
    .bind(OTHER_DRIVER)
    .bind(&memo)
    .execute(db.pool())
    .await;
    let err = refused.expect_err("another branch's memo may not credit this driver").to_string();
    // Both halves of the rule are true of this row — the memo is store A's and
    // its sale names store A's driver — so the message is the source rule's,
    // not the negative-balance guard's.
    assert!(err.contains("credit memo"), "got: {err}");
    assert_eq!(driver_balance(&db, OTHER_DRIVER).await, 5_000, "his balance stands");
}

#[tokio::test]
async fn the_engine_refuses_a_return_credit_against_a_counter_sales_memo() {
    // A memo whose original sale had no driver at all. Nobody was carrying that
    // money, so there is no receivable for it to reduce.
    let db = shop_with_float(5_000, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(1)], ALI, 0))
        .await
        .expect("give Ali a balance");

    let counter = sale_payload(vec![burger(1)], vec![cash_usd(1_000)]);
    let counter_id = counter.sale_id.clone();
    post_sale_with_pool(db.pool(), counter).await.expect("post a counter sale");
    let item_id = first_item(&db, &counter_id).await;
    let memo = credit_memo_payload(
        &counter_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![PostCreditMemoRefund {
            refund_id: uuid(),
            method: "cash_usd".to_string(),
            currency: "USD".to_string(),
            amount_native_usd_cents: 1_000,
            amount_native_lbp: 0,
            amount_usd_cents_equivalent: 1_000,
            reference: None,
        }],
    );
    let counter_memo = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.expect("refund it in cash");

    let refused = sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_credit_memo_id
         ) VALUES (?, ?, ?, 'return_credit', -1000, '2026-01-02', ?)",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .bind(&counter_memo)
    .execute(db.pool())
    .await;
    assert!(refused.is_err(), "a counter return credits no driver");
    assert_eq!(driver_balance(&db, ALI).await, 1_000);
}

#[tokio::test]
async fn the_engine_refuses_a_return_credit_carrying_an_UNRELATED_sale_id() {
    // `related_sale_id` is optional on a return credit, so an extraneous one
    // was unchecked: the row could name the right memo and the wrong receipt,
    // and the audit trail would then describe two different documents.
    let db = shop().await;
    let (_sale, memo) = a_memo_with_no_driver_credit(&db).await;
    let other = delivery_payload(vec![burger(1)], ALI, 0);
    let other_id = other.sale_id.clone();
    post_sale_with_pool(db.pool(), other).await.expect("a second order");

    let refused = sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_credit_memo_id, related_sale_id
         ) VALUES (?, ?, ?, 'return_credit', -500, '2026-01-02', ?, ?)",
    )
    .bind(uuid())
    .bind(STORE_ID)
    .bind(ALI)
    .bind(&memo)
    .bind(&other_id)
    .execute(db.pool())
    .await;
    assert!(
        refused.is_err(),
        "a return credit may not name a sale its memo does not reverse"
    );
}

#[tokio::test]
async fn a_return_credit_naming_the_memos_own_sale_is_accepted() {
    // The positive control for the sale-id rule: naming the right receipt is
    // allowed, so the check refuses mismatches rather than the column itself.
    // A second memo on the same order, so the one-credit-per-memo index is not
    // what decides this.
    let db = shop().await;
    let sale = delivery_payload(vec![burger(3)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id = first_item(&db, &sale_id).await;

    let first = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    post_credit_memo_with_pool(db.pool(), first).await.expect("first return");

    let second = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    let second_memo = second.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), second).await.expect("second return");

    // Both credits are on the books, each traceable to its own memo.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='return_credit'").await,
        2
    );
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "3 carried, 2 returned");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM driver_ledger
              WHERE entry_type='return_credit' AND related_credit_memo_id='{second_memo}'"
        ))
        .await,
        1
    );
}

// ============================================================================
// 12. GZ-P2-1 — a remittance replay compares its ATTRIBUTION too
// ============================================================================
//
// `post_driver_remittance` is idempotent on `ledger_entry_id`, and a replay
// whose content differs is a CONFLICT rather than a silent reconciliation. The
// canonical comparison covered the money — store, driver, type, amount, date,
// currency, native amounts, reference, notes — and stopped there.
//
// Four persisted columns were therefore outside it: the SHIFT the cash landed
// in, the exchange-rate row a lira hand-over was converted at, the user who
// recorded it and the device it was recorded on. A retry arriving with any of
// those changed was accepted as a faithful replay, and the caller was told the
// entry had posted — while the row on the books went on naming the first set.
//
// The shift is the one with money attached: it is a term in expected drawer
// cash, so a replay that believes it moved the hand-over to tonight's shift,
// and is told "already posted", leaves the cash expected in last night's till
// and a screen saying otherwise. The rate row decides which rate a reader
// believes converted the lira. The user and device are the audit trail.
//
// So the comparison now covers every column the command persists. Each test
// changes exactly one of them and asserts a conflict, and the control at the
// end proves a genuinely faithful replay still reconciles.

const DEVICE_A: &str = "00000000-0000-0000-0000-0000000000a1";
const DEVICE_B: &str = "00000000-0000-0000-0000-0000000000a2";

async fn seed_device(db: &TempDb, id: &str, name: &str) {
    sqlx::query("INSERT INTO devices (id, store_id, name) VALUES (?, ?, ?)")
        .bind(id)
        .bind(STORE_ID)
        .bind(name)
        .execute(db.pool())
        .await
        .expect("seed device");
}

/// A shop where Ali is holding $20.00 of food money.
async fn shop_with_ali_holding_2000() -> TempDb {
    let db = shop_with_float(0, 0).await;
    post_sale_with_pool(db.pool(), delivery_payload(vec![burger(2)], ALI, 0))
        .await
        .expect("post a delivery order");
    db
}

#[tokio::test]
async fn replaying_a_settlement_against_a_different_shift_is_a_conflict() {
    // The dangerous one. The shift is a term in expected drawer cash, so
    // "accepted and ignored" would leave the money expected in one till while
    // the screen that sent the retry believed it was in another.
    let db = shop_with_ali_holding_2000().await;
    let first = remit_usd(ALI, 1_000);
    let id = first.ledger_entry_id.clone();
    post_driver_remittance_with_pool(db.pool(), first).await.expect("first hand-over");

    seed_closed_shift(&db, "00000000-0000-0000-0000-00000000f002", 0, 0).await;
    let replay = PostDriverRemittancePayload {
        ledger_entry_id: id.clone(),
        shift_id: Some("00000000-0000-0000-0000-00000000f002".to_string()),
        ..remit_usd(ALI, 1_000)
    };
    let err = post_driver_remittance_with_pool(db.pool(), replay)
        .await
        .expect_err("a replay may not re-attribute the shift");
    assert!(err.contains("shift"), "got: {err}");

    // One row, still naming the shift it actually landed in.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='remittance'").await,
        1
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT shift_id FROM driver_ledger WHERE id='{id}'")).await,
        SHIFT_ID
    );
    assert_eq!(driver_balance(&db, ALI).await, 1_000, "and it was paid once");
}

#[tokio::test]
async fn replaying_a_lira_settlement_against_a_different_rate_row_is_a_conflict() {
    // Two rate rows carrying the SAME number, so the derived amount is
    // identical and the money comparison cannot tell them apart. Which row the
    // entry names is what a reader is told converted the lira.
    let db = shop_with_ali_holding_2000().await;
    const RATE_TWIN: &str = "00000000-0000-0000-0000-00000000e002";
    seed_exchange_rate_at(&db, RATE_TWIN, RATE_LBP_PER_USD).await;

    let first = remit_lbp(ALI, 895_000);
    let id = first.ledger_entry_id.clone();
    post_driver_remittance_with_pool(db.pool(), first).await.expect("first hand-over");

    let replay = PostDriverRemittancePayload {
        ledger_entry_id: id.clone(),
        exchange_rate_id: Some(RATE_TWIN.to_string()),
        ..remit_lbp(ALI, 895_000)
    };
    let err = post_driver_remittance_with_pool(db.pool(), replay)
        .await
        .expect_err("a replay may not re-attribute the rate row");
    assert!(err.contains("rate"), "got: {err}");
    assert_eq!(
        db.scalar_string(&format!("SELECT exchange_rate_id FROM driver_ledger WHERE id='{id}'"))
            .await,
        RATE_ID
    );
}

#[tokio::test]
async fn replaying_a_settlement_with_a_different_cashier_or_device_is_a_conflict() {
    // The audit trail. Neither changes a figure, and that is exactly why they
    // were silently overwritable: nothing downstream would ever notice that the
    // row says one person took the cash while the caller was told its own
    // claim had posted.
    let db = shop_with_ali_holding_2000().await;
    seed_device(&db, DEVICE_A, "Front Counter").await;
    seed_device(&db, DEVICE_B, "Back Office").await;

    let first = PostDriverRemittancePayload {
        device_id: Some(DEVICE_A.to_string()),
        ..remit_usd(ALI, 1_000)
    };
    let id = first.ledger_entry_id.clone();
    post_driver_remittance_with_pool(db.pool(), first).await.expect("first hand-over");

    let other_device = PostDriverRemittancePayload {
        ledger_entry_id: id.clone(),
        device_id: Some(DEVICE_B.to_string()),
        ..remit_usd(ALI, 1_000)
    };
    let err = post_driver_remittance_with_pool(db.pool(), other_device)
        .await
        .expect_err("a replay may not re-attribute the device");
    assert!(err.contains("device"), "got: {err}");

    let other_user = PostDriverRemittancePayload {
        ledger_entry_id: id.clone(),
        created_by_user_id: None,
        device_id: Some(DEVICE_A.to_string()),
        ..remit_usd(ALI, 1_000)
    };
    let err = post_driver_remittance_with_pool(db.pool(), other_user)
        .await
        .expect_err("a replay may not re-attribute the cashier");
    assert!(err.contains("record"), "got: {err}");

    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='remittance'").await,
        1
    );
}

#[tokio::test]
async fn a_faithful_settlement_replay_still_reconciles_with_every_column_equal() {
    // The control. The comparison is wider now, so the retry that matters —
    // the same screen re-sending the same hand-over after a lost answer — must
    // still resolve to the row that posted rather than being refused.
    let db = shop_with_ali_holding_2000().await;
    seed_device(&db, DEVICE_A, "Front Counter").await;

    let make = |id: &str| PostDriverRemittancePayload {
        ledger_entry_id: id.to_string(),
        device_id: Some(DEVICE_A.to_string()),
        reference: Some("hand-over 1".to_string()),
        notes: Some("counted together".to_string()),
        ..remit_usd(ALI, 1_500)
    };
    let id = uuid();
    let first = post_driver_remittance_with_pool(db.pool(), make(&id))
        .await
        .expect("first hand-over");
    let again = post_driver_remittance_with_pool(db.pool(), make(&id))
        .await
        .expect("a faithful replay must reconcile");

    assert_eq!(first.posted_at, again.posted_at, "the same row, not a second one");
    assert_eq!(again.amount_cents, -1_500);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM driver_ledger WHERE entry_type='remittance'").await,
        1,
        "paid once"
    );
    assert_eq!(driver_balance(&db, ALI).await, 500);
}

// ============================================================================
// 13. GZ-P2-2 — an approval string is a CLAIM, and the audit trail says so
// ============================================================================
//
// WP-7 disabled the drawer-funded refund path because nothing in this build can
// authenticate a manager: `users.role` exists and is read by nothing, there is
// no login and no session, and `activeContext` picks whichever `owner` row
// sorts first at boot. The verdict is therefore identical with and without an
// approval string, which the two tests above this section pin.
//
// What survived was the WORDING. A memo carrying the field was annotated
// "[Manager decision] ...", which is the one thing the finding is about: it
// reads as a verified decision by a person with authority, in an immutable
// financial document, when all that happened is that somebody typed into a
// box. An auditor reading the memo later has no way to know the difference, and
// a figure dressed as a control is worse than no control at all — it is the
// appearance of one.
//
// The field is still accepted and still recorded, because the operator's words
// are worth keeping and refusing the whole refund over a note would punish the
// customer. It is recorded as what it is: an unverified claim that authorised
// nothing.

#[tokio::test]
async fn an_approval_string_is_never_recorded_as_a_verified_manager_decision() {
    let db = shop().await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id = first_item(&db, &sale_id).await;

    let mut memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    memo.manager_approval = Some("Owner approved by phone".to_string());
    let memo_id = memo.credit_memo_id.clone();
    // Case A: the driver is still holding the money, so the refund itself is
    // determinable and posts. The note is the only thing under test.
    post_credit_memo_with_pool(db.pool(), memo).await.expect("the return posts");

    let notes = db
        .scalar_string(&format!("SELECT notes FROM sales_credit_memos WHERE id='{memo_id}'"))
        .await;

    assert!(
        !notes.contains("Manager decision"),
        "an unauthenticated string must not be filed as a manager's decision: {notes}"
    );
    assert!(
        notes.contains("Unverified"),
        "it must be marked as an unverified claim: {notes}"
    );
    assert!(
        notes.contains("Owner approved by phone"),
        "and what the operator typed is kept, not discarded: {notes}"
    );
}

#[tokio::test]
async fn an_operator_note_survives_beside_an_approval_claim() {
    let db = shop().await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id = first_item(&db, &sale_id).await;

    let mut memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    memo.notes = Some("Burger was cold".to_string());
    memo.manager_approval = Some("Owner says refund it".to_string());
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.expect("the return posts");

    let notes = db
        .scalar_string(&format!("SELECT notes FROM sales_credit_memos WHERE id='{memo_id}'"))
        .await;
    assert!(notes.contains("Burger was cold"), "got: {notes}");
    assert!(notes.contains("Owner says refund it"), "got: {notes}");
    assert!(!notes.contains("Manager decision"), "got: {notes}");
}

#[tokio::test]
async fn a_memo_with_no_approval_string_carries_no_claim_at_all() {
    // No empty annotation on the ordinary refund, which is the overwhelming
    // majority of them.
    let db = shop().await;
    let sale = delivery_payload(vec![burger(2)], ALI, 0);
    let sale_id = sale.sale_id.clone();
    post_sale_with_pool(db.pool(), sale).await.expect("post");
    let item_id = first_item(&db, &sale_id).await;

    let mut memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&item_id).qty(1).build()],
        vec![driver_refund(1_000)],
    );
    memo.notes = Some("Burger was cold".to_string());
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.expect("the return posts");

    let notes = db
        .scalar_string(&format!("SELECT notes FROM sales_credit_memos WHERE id='{memo_id}'"))
        .await;
    assert_eq!(notes, "Burger was cold");
}
