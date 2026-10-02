// Layer C — tender, exchange rate and change, as `post_sale` PERSISTS them.
//
// WP-04 (GZ-HI-04). `pure.rs` covers the decisions `prepare_sale` makes before
// the database is touched; this file covers what ends up in `sale_payments`,
// because that is what shift close reads and what no later work package may
// quietly change.
//
// The matrix under test — the combinations the application supports today:
//
//     cash USD exact / over        cash LBP exact / over
//     card USD exact               card USD over (refused)
//     cash USD + card USD          cash LBP + card USD
//     cash USD + cash LBP
//
// One rule runs through all of it: a payment row's `amount_usd_cents_equivalent`
// is derived from its native amount and the sale's locked rate, and only a cash
// row can carry `change_given_*`.

use crate::posting::{lbp_to_usd_cents, post_sale_with_pool, usd_cents_to_lbp};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";

async fn store_with_coffee() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 1_000,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db
}

/// A cart of `qty` coffees at $5.00 incl VAT.
fn cart(qty: i64) -> Vec<crate::posting::PostSaleLine> {
    vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_incl(500).build()]
}

/// Every `(method, native USD, native LBP, USD equivalent, change USD, change LBP)`
/// row persisted for one sale, ordered by method so assertions are stable.
async fn tender_rows(db: &TempDb, sale_id: &str) -> Vec<(String, i64, i64, i64, i64, i64)> {
    use sqlx::Row;
    sqlx::query(
        "SELECT method, amount_native_usd_cents, amount_native_lbp,
                amount_usd_cents_equivalent, change_given_usd_cents, change_given_lbp
           FROM sale_payments WHERE sale_id = ? ORDER BY method",
    )
    .bind(sale_id)
    .fetch_all(db.pool())
    .await
    .expect("read tender rows")
    .into_iter()
    .map(|r| {
        (
            r.get::<String, _>("method"),
            r.get::<i64, _>("amount_native_usd_cents"),
            r.get::<i64, _>("amount_native_lbp"),
            r.get::<i64, _>("amount_usd_cents_equivalent"),
            r.get::<i64, _>("change_given_usd_cents"),
            r.get::<i64, _>("change_given_lbp"),
        )
    })
    .collect()
}

/// Total change recorded on NON-cash rows. Must be zero, always.
async fn change_on_non_cash_rows(db: &TempDb) -> i64 {
    db.scalar_i64(
        "SELECT COALESCE(SUM(change_given_usd_cents + change_given_lbp), 0)
           FROM sale_payments
          WHERE method NOT IN ('cash_usd','cash_lbp')",
    )
    .await
}

// ============================================================================
// Cash USD
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usd_cash_paid_to_the_cent_records_no_change() {
    let db = store_with_coffee().await;
    let payload = sale_payload(cart(2), vec![cash_usd(1_000)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();
    assert_eq!(result.change_total_usd_cents, 0);
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![("cash_usd".to_string(), 1_000, 0, 1_000, 0, 0)]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usd_cash_overpayment_gives_usd_change_from_the_cash_row() {
    let db = store_with_coffee().await;
    // $10.00 due, $20.00 handed over.
    let payload = sale_payload(cart(2), vec![cash_usd(2_000)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();
    assert_eq!(result.change_total_usd_cents, 1_000);
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![("cash_usd".to_string(), 2_000, 0, 2_000, 1_000, 0)],
        "the tendered amount stays what was handed over; the change is recorded beside it"
    );

    // Tendered - change = amount due. The identity the drawer depends on.
    let header = db
        .scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'"))
        .await;
    assert_eq!(2_000 - 1_000, header);
}

// ============================================================================
// Cash LBP — the locked rate decides the USD equivalent
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lbp_cash_paid_exactly_records_the_locked_rate_equivalent() {
    let db = store_with_coffee().await;
    // 895,000 lira is exactly $10.00 at 89,500 LBP/USD.
    assert_eq!(lbp_to_usd_cents(895_000, RATE_LBP_PER_USD).unwrap(), 1_000);

    let payload = sale_payload(cart(2), vec![cash_lbp(895_000)]);
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(result.change_total_usd_cents, 0);
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![("cash_lbp".to_string(), 0, 895_000, 1_000, 0, 0)],
        "the lira amount is kept natively, with the USD equivalent beside it"
    );
    // The rate is locked onto the sale, so this receipt reprints at 89,500 for ever.
    assert_eq!(
        db.scalar_i64(&format!("SELECT exchange_rate_lbp_per_usd FROM sales WHERE id='{sale_id}'"))
            .await,
        RATE_LBP_PER_USD
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lbp_cash_overpayment_gives_lira_change_at_the_locked_rate() {
    let db = store_with_coffee().await;
    // $5.00 due, 1,000,000 lira handed over.
    let payload = sale_payload(cart(1), vec![cash_lbp(1_000_000)]);
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    let tendered_usd = lbp_to_usd_cents(1_000_000, RATE_LBP_PER_USD).unwrap();
    assert_eq!(result.change_total_usd_cents, tendered_usd - 500);

    let expected_change_lbp = usd_cents_to_lbp(tendered_usd - 500, RATE_LBP_PER_USD).unwrap();
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![(
            "cash_lbp".to_string(),
            0,
            1_000_000,
            tendered_usd,
            0,
            expected_change_lbp
        )],
        "change on a lira row is given in lira, never as USD cents"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_lbp_equivalent_is_refused_and_nothing_persists() {
    let db = store_with_coffee().await;

    // A client that converted at the wrong rate, or simply got it wrong. Both
    // directions are refused: the equivalent is what reports sum and what
    // reconciles against the sale total, so a wrong one is wrong for ever.
    for delta in [-100, -1, 1, 250] {
        let mut payload = sale_payload(cart(2), vec![cash_lbp(895_000)]);
        payload.payments[0].amount_usd_cents_equivalent += delta;
        let err = post_sale_with_pool(db.pool(), payload)
            .await
            .expect_err("a USD equivalent that is not the locked-rate conversion must be refused");
        assert!(err.contains("locked rate"), "got: {err}");
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 1_000);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "1",
        "a refused tender costs the receipt sequence nothing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_locked_rate_must_be_the_rate_the_database_holds() {
    let db = store_with_coffee().await;

    // A sale that names the store's rate row but declares a different number.
    // Everything downstream — the LBP equivalents, the change, the reprint —
    // hangs off this value, so it has to be the stored one.
    let mut payload = sale_payload(cart(2), vec![cash_usd(1_000)]);
    payload.exchange_rate_lbp_per_usd = RATE_LBP_PER_USD + 1;
    let err = post_sale_with_pool(db.pool(), payload)
        .await
        .expect_err("the declared locked rate must match the exchange_rates row");
    assert!(err.contains("Exchange rate mismatch"), "got: {err}");

    // A rate belonging to another store is not this store's locked rate either.
    db.exec("INSERT INTO stores (id, name) VALUES ('store-2', 'Second Branch')").await;
    db.exec(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('rate-other', 'store-2', '2026-01-01', 89500, 'manual')",
    )
    .await;
    let mut payload = sale_payload(cart(2), vec![cash_usd(1_000)]);
    payload.exchange_rate_id = "rate-other".to_string();
    let err = post_sale_with_pool(db.pool(), payload)
        .await
        .expect_err("a rate of another store is not this sale's locked rate");
    assert!(err.contains("not a rate of store"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);

    // The honest payload still posts — the check is specific, not a blanket
    // tightening of the rate contract.
    let payload = sale_payload(cart(2), vec![cash_usd(1_000)]);
    assert!(post_sale_with_pool(db.pool(), payload).await.is_ok());
}

// ============================================================================
// Card
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_card_paid_to_the_cent_posts_and_carries_no_change() {
    let db = store_with_coffee().await;
    let payload = sale_payload(cart(2), vec![card_usd(1_000)]);
    let sale_id = payload.sale_id.clone();

    post_sale_with_pool(db.pool(), payload).await.unwrap();
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![("card_usd".to_string(), 1_000, 0, 1_000, 0, 0)]
    );
    assert_eq!(change_on_non_cash_rows(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_card_overpayment_is_refused_rather_than_turned_into_drawer_change() {
    // THE GZ-HI-04 CASE. A $10.00 bill with $12.00 on the card used to post, and
    // the $2.00 surplus was written as `change_given_usd_cents` on the CARD row.
    // Shift close then subtracted it from expected physical cash: the till
    // reported $2.00 short for money that never passed through it, permanently,
    // because posted rows are immutable.
    let db = store_with_coffee().await;
    let payload = sale_payload(cart(2), vec![card_usd(1_200)]);

    let err = post_sale_with_pool(db.pool(), payload)
        .await
        .expect_err("a card cannot be over-collected and refunded from the drawer");
    assert!(err.contains("Non-cash tender"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 1_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_persisted_card_row_can_ever_hold_change() {
    // Swept across the whole supported matrix at once: whatever combination
    // posts, every non-cash row comes out with zero change on it.
    let db = store_with_coffee().await;

    let combinations = vec![
        vec![cash_usd(1_000)],
        vec![cash_usd(1_500)],
        vec![cash_lbp(895_000)],
        vec![cash_lbp(1_000_000)],
        vec![card_usd(1_000)],
        vec![card_usd(600), cash_usd(400)],
        vec![card_usd(600), cash_usd(900)],
        vec![card_usd(400), cash_lbp(600_000)],
        vec![cash_usd(500), cash_lbp(500_000)],
    ];

    for payments in combinations {
        let payload = sale_payload(cart(2), payments);
        post_sale_with_pool(db.pool(), payload)
            .await
            .expect("every combination in the supported matrix must post");
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 9);
    assert_eq!(
        change_on_non_cash_rows(&db).await,
        0,
        "a non-cash tender row must never carry change"
    );
    // And every sale's tender still reconciles: tendered - change = amount due.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM sales s
              WHERE s.total_incl_vat_cents <> (
                    SELECT COALESCE(SUM(sp.amount_usd_cents_equivalent), 0)
                         - COALESCE(SUM(sp.change_given_usd_cents), 0)
                         - COALESCE(SUM(CASE WHEN sp.change_given_lbp > 0
                                             THEN (sp.change_given_lbp * 100
                                                   + s.exchange_rate_lbp_per_usd / 2)
                                                  / s.exchange_rate_lbp_per_usd
                                             ELSE 0 END), 0)
                      FROM sale_payments sp WHERE sp.sale_id = s.id
              )"
        )
        .await,
        0,
        "for every sale, tendered minus change equals the amount due"
    );
}

// ============================================================================
// Mixed tender
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mixed_cash_and_card_sale_paid_exactly_splits_cleanly() {
    let db = store_with_coffee().await;
    // $10.00 due: $6.00 on the card, $4.00 in cash.
    let payload = sale_payload(cart(2), vec![card_usd(600), cash_usd(400)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();
    assert_eq!(result.change_total_usd_cents, 0);
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![
            ("card_usd".to_string(), 600, 0, 600, 0, 0),
            ("cash_usd".to_string(), 400, 0, 400, 0, 0),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_change_comes_off_the_cash_and_only_the_cash() {
    let db = store_with_coffee().await;
    // $10.00 due: $6.00 on the card, $9.00 in cash → $5.00 change, all cash.
    let payload = sale_payload(cart(2), vec![card_usd(600), cash_usd(900)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();
    assert_eq!(result.change_total_usd_cents, 500);
    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![
            ("card_usd".to_string(), 600, 0, 600, 0, 0),
            ("cash_usd".to_string(), 900, 0, 900, 500, 0),
        ],
        "the card settles its own amount; the change belongs to the cash row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn when_the_only_cash_is_lira_the_change_is_given_in_lira() {
    let db = store_with_coffee().await;
    // $10.00 due: $4.00 on the card, 600,000 lira (~$6.70) in cash.
    let payload = sale_payload(cart(2), vec![card_usd(400), cash_lbp(600_000)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();
    let cash_usd_equiv = lbp_to_usd_cents(600_000, RATE_LBP_PER_USD).unwrap();
    let change_usd = 400 + cash_usd_equiv - 1_000;
    assert_eq!(result.change_total_usd_cents, change_usd);

    assert_eq!(
        tender_rows(&db, &sale_id).await,
        vec![
            ("card_usd".to_string(), 400, 0, 400, 0, 0),
            (
                "cash_lbp".to_string(),
                0,
                600_000,
                cash_usd_equiv,
                0,
                usd_cents_to_lbp(change_usd, RATE_LBP_PER_USD).unwrap()
            ),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_both_cash_currencies_the_usd_row_hands_the_change_back() {
    // The application's own preference order: USD cash outranks lira cash. A
    // Lebanese till holding both gives dollars back, and the lira that came in
    // stay in. Both movements are real, so the drawer reconciles in each
    // currency separately — which is why `shifts` keeps two expected figures and
    // two variances rather than one blended total.
    let db = store_with_coffee().await;
    // $10.00 due: 500,000 lira (~$5.59) + $8.00 cash → change on the USD row.
    let payload = sale_payload(cart(2), vec![cash_lbp(500_000), cash_usd(800)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();
    let lbp_equiv = lbp_to_usd_cents(500_000, RATE_LBP_PER_USD).unwrap();
    assert_eq!(result.change_total_usd_cents, lbp_equiv + 800 - 1_000);

    let rows = tender_rows(&db, &sale_id).await;
    let lbp_row = rows.iter().find(|r| r.0 == "cash_lbp").unwrap();
    let usd_row = rows.iter().find(|r| r.0 == "cash_usd").unwrap();
    assert_eq!(lbp_row.4, 0, "no USD change on the lira row");
    assert_eq!(lbp_row.5, 0, "and no lira change either");
    assert_eq!(usd_row.4, result.change_total_usd_cents, "the USD row gives USD back");
    assert_eq!(usd_row.5, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn change_lands_on_exactly_one_row_whatever_the_combination() {
    let db = store_with_coffee().await;

    for payments in [
        vec![cash_usd(2_000)],
        vec![cash_lbp(1_000_000)],
        vec![card_usd(600), cash_usd(900)],
        vec![card_usd(400), cash_lbp(700_000)],
        vec![cash_lbp(500_000), cash_usd(800)],
    ] {
        let payload = sale_payload(cart(2), payments);
        let sale_id = payload.sale_id.clone();
        post_sale_with_pool(db.pool(), payload).await.unwrap();

        let rows_with_change = db
            .count(&format!(
                "SELECT COUNT(*) FROM sale_payments
                  WHERE sale_id='{sale_id}'
                    AND (change_given_usd_cents <> 0 OR change_given_lbp <> 0)"
            ))
            .await;
        assert_eq!(rows_with_change, 1, "change is never split across tender rows");
    }

    assert_eq!(change_on_non_cash_rows(&db).await, 0);
}
