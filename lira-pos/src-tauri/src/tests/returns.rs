// Layer C — `post_credit_memo` against a temporary database (WP-06, GP-A08).
//
// Every test asserts on PERSISTED rows, not on the command's return value
// alone, because persistence is what later work packages must not regress.
//
// The shape of a returns test is almost always: post a real sale through
// `post_sale`, then return part or all of it through `post_credit_memo`, then
// read back the credit memo, the inventory movements, the product's cost pool
// and — for the drawer tests — the shift `close_shift` actually writes. Nothing
// here inserts a credit-memo row by hand except where a test is specifically
// about the database guards binding a writer that is not this command.

use crate::posting::{
    close_shift_with_pool, open_shift_with_pool, post_credit_memo_with_pool,
    post_purchase_with_pool, post_sale_with_pool, prorated_cumulative_cents, CloseShiftPayload,
    OpenShiftPayload, PostCreditMemoPayload, PostCreditMemoRefund, PostSaleLine, PostSalePayload,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_BREAD: &str = "00000000-0000-0000-0000-0000000000c3";
const P_DELIVERY: &str = "00000000-0000-0000-0000-0000000000c4";
const SHIFT_B: &str = "00000000-0000-0000-0000-00000000f002";
const SUPPLIER: &str = "00000000-0000-0000-0000-00000000a0b1";

// ============================================================================
// Fixtures
// ============================================================================

/// A shop that can sell, with an open shift holding `usd`/`lbp` of float.
///
///   * Coffee  — stocked, 100 on hand at $2.00 excl / $2.22 incl cost,
///               sold at $5.00 incl VAT (11%).
///   * Bread   — stocked and VAT-EXEMPT, 50 on hand at $1.00 cost,
///               sold at $3.00.
///   * Delivery— a SERVICE: no stock, no cost, sold at $11.10 incl VAT.
async fn shop_with_float(usd: i64, lbp: i64) -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_shift(&db, SHIFT_ID, usd, lbp).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            price_excl_vat_cents: 450,
            price_incl_vat_cents: 500,
            vat_pricing_mode: "exclusive",
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")
        },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            vat_rate_id: VAT_EXEMPT_ID,
            quantity_on_hand: 50,
            avg_cost_excl_vat_cents: 100,
            avg_cost_incl_vat_cents: 100,
            price_excl_vat_cents: 300,
            price_incl_vat_cents: 300,
            ..ProductSpec::stocked(P_BREAD, "SKU-C3", "Bread loaf")
        },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            price_excl_vat_cents: 1_000,
            price_incl_vat_cents: 1_110,
            ..ProductSpec::stocked(P_DELIVERY, "SKU-C4", "Delivery")
        },
    )
    .await;
    db
}

async fn shop() -> TempDb {
    shop_with_float(0, 0).await
}

fn coffee(qty: i64) -> PostSaleLine {
    SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(qty).unit_incl(500).build()
}

fn bread(qty: i64) -> PostSaleLine {
    SaleLineBuilder::new(P_BREAD, "Bread loaf")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(qty)
        .unit_incl(300)
        .build()
}

fn delivery() -> PostSaleLine {
    SaleLineBuilder::new(P_DELIVERY, "Delivery").service(true).unit_incl(1_110).build()
}

/// Post a sale and hand back its id.
async fn post_sale_ok(db: &TempDb, payload: PostSalePayload) -> String {
    let id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload)
        .await
        .unwrap_or_else(|e| panic!("the fixture sale must post: {e}"));
    id
}

/// Sell `qty` coffees for USD cash. The commonest fixture in this file.
async fn sell_coffee_for_cash(db: &TempDb, qty: i64) -> String {
    let lines = vec![coffee(qty)];
    let total = lines_total(&lines);
    post_sale_ok(db, sale_payload(lines, vec![cash_usd(total)])).await
}

/// Sell `qty` coffees on a card.
async fn sell_coffee_on_card(db: &TempDb, qty: i64) -> String {
    let lines = vec![coffee(qty)];
    let total = lines_total(&lines);
    post_sale_ok(db, sale_payload(lines, vec![card_usd(total)])).await
}

async fn credit_memo_count(db: &TempDb) -> i64 {
    db.count("SELECT COUNT(*) FROM sales_credit_memos").await
}

async fn next_credit_memo_number(db: &TempDb) -> i64 {
    db.scalar_string("SELECT value FROM app_settings WHERE key = 'next_credit_memo_number'")
        .await
        .parse()
        .expect("the credit-memo sequence is a number")
}

async fn memo_i64(db: &TempDb, memo_id: &str, column: &str) -> i64 {
    db.scalar_i64(&format!(
        "SELECT {column} FROM sales_credit_memos WHERE id = '{memo_id}'"
    ))
    .await
}

async fn memo_line_i64(db: &TempDb, memo_id: &str, product_id: &str, column: &str) -> i64 {
    db.scalar_i64(&format!(
        "SELECT {column} FROM sales_credit_memo_lines
          WHERE credit_memo_id = '{memo_id}' AND product_id = '{product_id}'"
    ))
    .await
}

/// A one-line, fully-restocked, cash-refunded return of `qty` units.
async fn cash_return(
    db: &TempDb,
    sale_id: &str,
    sale_item: &str,
    qty: i64,
    refund_cents: i64,
) -> PostCreditMemoPayload {
    let _ = db;
    credit_memo_payload(
        sale_id,
        vec![return_line(sale_item).qty(qty).build()],
        vec![refund_cash_usd(refund_cents)],
    )
}

/// A verbatim fingerprint of a sale, its lines and its tender — every column a
/// return could conceivably restate, in one string.
async fn sale_fingerprint(db: &TempDb, sale: &str) -> String {
    let header = db
        .scalar_string(&format!(
            "SELECT receipt_number || '|' || status || '|' || sale_type
                    || '|' || subtotal_excl_vat_cents || '|' || vat_total_cents
                    || '|' || total_incl_vat_cents || '|' || discount_cents
                    || '|' || cogs_total_cents || '|' || exchange_rate_lbp_per_usd
                    || '|' || COALESCE(posted_at, '')
               FROM sales WHERE id = '{sale}'"
        ))
        .await;
    let items = db
        .scalar_string(&format!(
            "SELECT COALESCE(GROUP_CONCAT(row, ';'), '') FROM (
               SELECT id || '|' || quantity || '|' || line_subtotal_excl_vat_cents
                      || '|' || line_vat_cents || '|' || line_total_incl_vat_cents
                      || '|' || line_discount_cents || '|' || line_cogs_excl_vat_cents
                      || '|' || unit_cogs_excl_vat_microcents AS row
                 FROM sale_items WHERE sale_id = '{sale}' ORDER BY id)"
        ))
        .await;
    let payments = db
        .scalar_string(&format!(
            "SELECT COALESCE(GROUP_CONCAT(row, ';'), '') FROM (
               SELECT id || '|' || method || '|' || amount_native_usd_cents
                      || '|' || amount_usd_cents_equivalent
                      || '|' || change_given_usd_cents AS row
                 FROM sale_payments WHERE sale_id = '{sale}' ORDER BY id)"
        ))
        .await;
    format!("{header}#{items}#{payments}")
}

// ============================================================================
// 1 — the whole line comes back
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_single_line_return_credits_the_whole_line() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await; // 900 + 100 VAT = 1000
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let payload = cash_return(&db, &sale, &item, 2, 1_000).await;
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("a full return of a cash sale must post");

    assert_eq!(result.credit_memo_number, 1, "the first return is #1");
    assert_eq!(result.subtotal_excl_vat_cents, 900);
    assert_eq!(result.vat_total_cents, 100);
    assert_eq!(result.total_incl_vat_cents, 1_000);
    assert_eq!(result.refund_total_usd_cents, 1_000);
    assert_eq!(result.cogs_reversed_cents, 400, "2 units at the $2.00 sale cost");
    assert_eq!(result.movement_ids.len(), 1);

    // The persisted header is what the command reported.
    assert_eq!(memo_i64(&db, &memo_id, "subtotal_excl_vat_cents").await, 900);
    assert_eq!(memo_i64(&db, &memo_id, "vat_total_cents").await, 100);
    assert_eq!(memo_i64(&db, &memo_id, "total_incl_vat_cents").await, 1_000);
    assert_eq!(memo_i64(&db, &memo_id, "cogs_reversed_cents").await, 400);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT status FROM sales_credit_memos WHERE id = '{memo_id}'"
        ))
        .await,
        "posted",
        "the memo is promoted out of draft inside the same transaction"
    );
    assert!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memos WHERE id = '{memo_id}' AND posted_at IS NOT NULL"
        ))
        .await
            == 1,
        "a posted memo carries a posted_at"
    );

    // Stock is back where it started, and the ledger says so.
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(
        movement_sum(&db, P_COFFEE).await,
        0,
        "sale out + return in must cancel"
    );
    assert_eq!(returned_quantity(&db, &item).await, 2);
}

// ============================================================================
// 2, 3, 15 — partial returns, and the cumulative allocation that makes them
//            add up
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_partial_return_credits_only_the_returned_units() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let result = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 500).await)
        .await
        .expect("a partial return must post");

    assert_eq!(result.total_incl_vat_cents, 500, "half the line");
    assert_eq!(result.subtotal_excl_vat_cents, 450);
    assert_eq!(result.vat_total_cents, 50);
    assert_eq!(result.cogs_reversed_cents, 200, "one unit at the $2.00 sale cost");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 99, "one unit back, one still sold");
    assert_eq!(returned_quantity(&db, &item).await, 1);
}

/// THE rounding invariant. A three-unit line whose discounted total does not
/// divide by three is returned one unit at a time; the three memos must add up
/// to the original line to the cent, in every column.
///
/// Independent per-memo rounding gives 333 + 333 + 333 = 999 against a 1,000
/// cent line, and the customer is a cent short for ever because the memos are
/// immutable. The cumulative rule gives 333 + 334 + 333.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn several_partial_returns_add_up_to_the_original_line_exactly() {
    let db = shop().await;

    // 3 coffees at $5.00 = $15.00, less a $5.00 sale discount = $10.00 due.
    // `post_sale` persists the line POST-discount: 901 + 99 = 1000, with the
    // 500-cent allocation recorded beside it.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
        .qty(3)
        .unit_incl(500)
        .discount(500)
        .raw_line_totals(901, 99, 1_000)
        .build();
    let mut payload = sale_payload(vec![line], vec![cash_usd(1_000)]);
    payload.discount_cents = 500;
    let sale = post_sale_ok(&db, payload).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // Three returns of one unit each. The expected figures are the differences
    // of round(original x q / 3) for q = 1, 2, 3.
    let expected = [
        // (total, subtotal, vat, discount)
        (333, 300, 33, 167),
        (334, 301, 33, 166),
        (333, 300, 33, 167),
    ];

    let mut totals = (0, 0, 0, 0);
    for (i, (total, subtotal, vat, discount)) in expected.iter().enumerate() {
        let result =
            post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, *total).await)
                .await
                .unwrap_or_else(|e| panic!("return {} must post: {e}", i + 1));
        assert_eq!(result.total_incl_vat_cents, *total, "return {} total", i + 1);
        assert_eq!(result.subtotal_excl_vat_cents, *subtotal, "return {} subtotal", i + 1);
        assert_eq!(result.vat_total_cents, *vat, "return {} VAT", i + 1);
        assert_eq!(result.discount_cents, *discount, "return {} discount", i + 1);
        assert_eq!(
            result.subtotal_excl_vat_cents + result.vat_total_cents,
            result.total_incl_vat_cents,
            "return {} must reconcile on its own",
            i + 1
        );
        totals.0 += result.total_incl_vat_cents;
        totals.1 += result.subtotal_excl_vat_cents;
        totals.2 += result.vat_total_cents;
        totals.3 += result.discount_cents;
    }

    // The whole point: three independent documents, one exact reversal.
    assert_eq!(totals.0, 1_000, "the returned totals must equal the line total");
    assert_eq!(totals.1, 901, "the returned subtotals must equal the line subtotal");
    assert_eq!(totals.2, 99, "the reversed VAT must equal the line VAT");
    assert_eq!(
        totals.3, 500,
        "the reversed discount must equal the line's own allocation"
    );
    assert_eq!(returned_quantity(&db, &item).await, 3);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

/// The same invariant on the cost side, which is prorated against the
/// RESTOCKED quantity rather than the returned one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_restocks_reverse_the_lines_cogs_exactly_once_in_total() {
    let db = shop().await;
    // A sub-cent cost, so the per-unit COGS cannot be expressed in whole cents
    // and only the cumulative rule can land on the line's own figure.
    // 7 grams at 333,333 microcents = $0.00333333/unit.
    seed_product_avg_cost_microcents(&db, P_COFFEE, 333_333, 333_333).await;

    let lines = vec![coffee(7)];
    let total = lines_total(&lines);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let line_cogs = db
        .scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE id = '{item}'"
        ))
        .await;
    assert_eq!(line_cogs, 2, "7 x 333,333 microcents rounds to 2 cents");

    // Return them one at a time. Each unit is 0.333333 cents, which rounds to
    // 0 on its own — so per-memo rounding would reverse nothing at all.
    let mut reversed = 0;
    for _ in 0..7 {
        let r = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 500).await)
            .await
            .expect("each unit must come back");
        reversed += r.cogs_reversed_cents;
    }
    assert_eq!(
        reversed, line_cogs,
        "restocking every unit must reverse exactly the COGS the sale booked"
    );
}

// ============================================================================
// 4 — over-return
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn returning_more_than_the_receipt_sold_is_refused() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 3, 1_500).await)
        .await
        .expect_err("three cannot come back from a sale of two");
    assert!(err.contains("sold 2"), "got: {err}");

    assert_eq!(credit_memo_count(&db).await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98, "nothing restocked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_return_cannot_exceed_what_is_left() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 3).await; // 1500
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect("two of three may come back");

    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect_err("only one is left");
    assert!(err.contains("leaving 1"), "got: {err}");

    assert_eq!(credit_memo_count(&db).await, 1);
    assert_eq!(returned_quantity(&db, &item).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fully_returned_line_cannot_be_returned_again() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 1).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 500).await)
        .await
        .expect("the one unit may come back");

    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 500).await)
        .await
        .expect_err("nothing is left to return");
    assert!(err.contains("already been returned in full"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_of_another_receipt_cannot_be_returned_against_this_one() {
    let db = shop().await;
    let sale_a = sell_coffee_for_cash(&db, 1).await;
    let sale_b = sell_coffee_for_cash(&db, 1).await;
    let item_b = sale_item_id(&db, &sale_b, P_COFFEE).await;

    // A return filed against receipt A, quoting a line of receipt B.
    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale_a, &item_b, 1, 500).await)
        .await
        .expect_err("a line of another sale is not returnable here");
    assert!(err.contains("is not a line of receipt"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
}

/// Two lines of one memo naming the same receipt line would each be prorated
/// against the same already-returned figure, so the pair could credit more
/// than the line is worth and walk past the remaining quantity between them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_memo_may_not_list_the_same_receipt_line_twice() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let payload = credit_memo_payload(
        &sale,
        vec![
            return_line(&item).qty(1).build(),
            return_line(&item).qty(1).build(),
        ],
        vec![refund_cash_usd(1_000)],
    );
    let err = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect_err("a repeated receipt line is refused");
    assert!(err.contains("repeats sale line"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_or_negative_return_quantity_is_refused() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    for qty in [0, -1] {
        let payload = credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(qty).build()],
            vec![refund_cash_usd(500)],
        );
        let err = post_credit_memo_with_pool(db.pool(), payload)
            .await
            .unwrap_err();
        assert!(err.contains("positive quantity"), "qty {qty} got: {err}");
    }
    assert_eq!(credit_memo_count(&db).await, 0);
}

/// The base quantity follows the ORIGINAL line's own factor snapshot, not the
/// payload's claim about it — the GP-A02 rule applied in reverse.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_returned_base_quantity_comes_from_the_original_lines_conversion() {
    let db = shop().await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;

    // 2 boxes of 12 = 24 base units.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
        .uom("box", 12, 1)
        .qty(2)
        .unit_incl(6_000)
        .build();
    let total = lines_total(&[clone_sale_line(&line)]);
    let sale = post_sale_ok(&db, sale_payload(vec![line], vec![cash_usd(total)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 76, "100 - 24");

    // One box back: 12 base units, $60.00.
    let payload = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(1).uom(12, 1).build()],
        vec![refund_cash_usd(6_000)],
    );
    let memo_id = payload.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("one box must come back");

    assert_eq!(memo_line_i64(&db, &memo_id, P_COFFEE, "quantity_base").await, 12);
    assert_eq!(memo_line_i64(&db, &memo_id, P_COFFEE, "quantity_in_uom").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 88, "76 + 12");

    // And a payload that contradicts that conversion is refused rather than
    // normalized: the cashier agreed to a box, not to a number someone sent.
    let crafted = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(1).raw_quantity_base(1).build()],
        vec![refund_cash_usd(6_000)],
    );
    let err = post_credit_memo_with_pool(db.pool(), crafted)
        .await
        .expect_err("a contradicted base quantity is refused");
    assert!(err.contains("does not match the original line"), "got: {err}");
}

// ============================================================================
// 6, 7, 8, 10, 11, 12 — stock and cost
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_service_line_can_be_refunded_but_never_restocked() {
    let db = shop().await;
    let lines = vec![delivery()];
    let total = lines_total(&lines);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let item = sale_item_id(&db, &sale, P_DELIVERY).await;

    // Asking to restock a service is refused outright rather than quietly
    // downgraded: the cashier ticked a box that cannot mean anything.
    let err = post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).restock(true).build()],
            vec![refund_cash_usd(1_110)],
        ),
    )
    .await
    .expect_err("a service cannot go back on a shelf");
    assert!(err.contains("moved no stock"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);

    // Refunded without restocking, it posts.
    let payload = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(1).restock(false).build()],
        vec![refund_cash_usd(1_110)],
    );
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("a service refund must post");

    assert_eq!(result.total_incl_vat_cents, 1_110);
    assert_eq!(result.cogs_reversed_cents, 0, "a service consumed no inventory");
    assert!(result.movement_ids.is_empty(), "no stock moved");
    assert_eq!(memo_line_i64(&db, &memo_id, P_DELIVERY, "is_service").await, 1);
    assert_eq!(memo_line_i64(&db, &memo_id, P_DELIVERY, "return_to_stock").await, 0);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'return_in'")
            .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restocked_return_puts_the_quantity_back_and_a_write_off_does_not() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 4).await; // 2000, qoh 96
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 96);

    // Two go back on the shelf.
    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect("a restocked return must post");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);

    // Two are refunded and thrown away — damaged food, the policy case.
    let payload = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(2).restock(false).build()],
        vec![refund_cash_usd(1_000)],
    );
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("a write-off return must post");

    assert_eq!(
        quantity_on_hand(&db, P_COFFEE).await,
        98,
        "discarded goods do not come back into stock"
    );
    assert_eq!(result.total_incl_vat_cents, 1_000, "the money still comes back");
    assert_eq!(result.cogs_reversed_cents, 0, "the cost stays consumed");
    assert!(result.movement_ids.is_empty());
    assert_eq!(memo_line_i64(&db, &memo_id, P_COFFEE, "line_cogs_excl_vat_cents").await, 0);
    assert!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines
              WHERE credit_memo_id = '{memo_id}' AND related_movement_id IS NULL"
        ))
        .await
            == 1,
        "a write-off line links to no movement"
    );
    // Both are still RETURNED, so neither can come back a second time.
    assert_eq!(returned_quantity(&db, &item).await, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restocked_return_reverses_the_cogs_the_sale_booked() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 3).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    let sale_cogs = db
        .scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE id = '{item}'"
        ))
        .await;
    assert_eq!(sale_cogs, 600, "3 x $2.00");

    let payload = cash_return(&db, &sale, &item, 3, 1_500).await;
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload).await.expect("post");

    assert_eq!(result.cogs_reversed_cents, sale_cogs);
    // The movement carries the ORIGINAL rate, in microcents, so the cost that
    // re-enters inventory is the cost that left it.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements
              WHERE related_credit_memo_id = '{memo_id}'"
        ))
        .await,
        200_000_000
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity_delta FROM inventory_movements WHERE related_credit_memo_id = '{memo_id}'"
        ))
        .await,
        3,
        "a return is stock IN"
    );
}

/// THE cost-basis invariant. A purchase between the sale and the return moves
/// the weighted average; the return must still value the goods at what THEY
/// cost, not at what the shop is paying today.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_after_the_sale_does_not_change_the_returns_cost_basis() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 10).await; // qoh 90, avg still $2.00
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // The shop restocks at twice the price: 10 units at $4.00 net.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload(
            "normal",
            Some(SUPPLIER),
            vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee 250g")
                .qty(10)
                .unit_cost_excl(400)
                .build()],
        ),
    )
    .await
    .expect("the purchase must post");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(
        avg_cost_excl_microcents(&db, P_COFFEE).await,
        220_000_000,
        "(90 x $2.00 + 10 x $4.00) / 100 = $2.20"
    );

    // Now the customer brings all ten back.
    let result = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 10, 5_000).await)
        .await
        .expect("the return must post");

    assert_eq!(
        result.cogs_reversed_cents, 2_000,
        "10 units at the $2.00 they were SOLD at, not the $2.20 the pool holds today"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 110);
    // 9, continued: the pool is RE-BLENDED with the returned units at their own
    // cost — (100 x $2.20 + 10 x $2.00) / 110.
    assert_eq!(avg_cost_excl_microcents(&db, P_COFFEE).await, 218_181_818);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restocked_return_blends_the_original_cost_into_the_average() {
    let db = shop().await;
    // Sub-cent costs, where leaving the average alone would be invisible in
    // whole cents but wrong in the accounting value.
    seed_product_avg_cost_microcents(&db, P_COFFEE, 2_500, 2_775).await; // $0.000025/unit
    let sale = sell_coffee_for_cash(&db, 10).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // The pool is revalued upward by a purchase at a much higher rate.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload(
            "normal",
            Some(SUPPLIER),
            vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee 250g")
                .qty(10)
                .unit_cost_excl(100)
                .build()],
        ),
    )
    .await
    .expect("the purchase must post");
    let avg_before = avg_cost_excl_microcents(&db, P_COFFEE).await;
    assert_eq!(avg_before, 10_002_250, "(90 x 2,500 + 10 x 100,000,000) / 100");

    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 10, 5_000).await)
        .await
        .expect("the return must post");

    // (100 x 10,002,250 + 10 x 2,500) / 110, at full microcent precision.
    let expected = crate::cost::new_weighted_avg(100, avg_before, 10, 2_500).unwrap();
    assert_eq!(expected, 9_093_182, "(100 x 10,002,250 + 10 x 2,500) / 110");
    assert_eq!(
        avg_cost_excl_microcents(&db, P_COFFEE).await,
        expected,
        "returned stock must bring its own cost back into the pool"
    );
    assert!(
        avg_cost_excl_microcents(&db, P_COFFEE).await < avg_before,
        "cheap units coming back must pull the average down"
    );
    // The rounded cents mirror is maintained from the same figure.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_cents FROM products WHERE id = '{P_COFFEE}'"
        ))
        .await,
        crate::cost::microcents_to_cents(expected).unwrap()
    );
}

/// The negative-stock edge. `allow_negative_inventory` lets a sale drive the
/// pool below zero, and a return can then arrive into a pool that is still
/// short. No average exists over a non-positive quantity, so the quantity goes
/// back and the existing rate is left standing — documented behaviour, not an
/// accident.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restock_into_a_still_negative_pool_adds_quantity_without_inventing_an_average() {
    let db = shop().await;
    let lines = vec![coffee(130)];
    let total = lines_total(&lines);
    let mut payload = sale_payload(lines, vec![cash_usd(total)]);
    payload.allow_negative_inventory = true;
    let sale = post_sale_ok(&db, payload).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, -30);

    let avg_before = avg_cost_excl_microcents(&db, P_COFFEE).await;
    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 10, 5_000).await)
        .await
        .expect("the return must still post");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, -20, "the goods are physically back");
    assert_eq!(
        avg_cost_excl_microcents(&db, P_COFFEE).await,
        avg_before,
        "no average exists over a pool that is still short; the existing rate stands"
    );
    assert_eq!(
        movement_sum(&db, P_COFFEE).await,
        -120,
        "the ledger still reconciles with quantity_on_hand - opening"
    );
}

// ============================================================================
// 13, 16 — VAT comes from the snapshot
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_reversed_vat_comes_from_the_sale_snapshot_not_todays_rate() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // The shop's standard rate changes, and the product is re-pointed at a new
    // one. The sale's own snapshot is what the refund reverses.
    db.exec(
        "INSERT INTO vat_rates (id, name, rate_bps, is_exempt, effective_from)
         VALUES ('rate-new', 'Standard 20%', 2000, 0, '2026-06-01')",
    )
    .await;
    db.exec(&format!(
        "UPDATE products SET vat_rate_id = 'rate-new' WHERE id = '{P_COFFEE}'"
    ))
    .await;

    let payload = cash_return(&db, &sale, &item, 2, 1_000).await;
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload).await.expect("post");

    assert_eq!(result.vat_total_cents, 100, "11% of the sale, not 20% of today");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT vat_rate_bps_snapshot FROM sales_credit_memo_lines
              WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        1_100
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT vat_rate_id_snapshot FROM sales_credit_memo_lines
              WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        VAT_STD_ID,
        "the memo line carries the sale's VAT code, not the product's current one"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mixed_vat_and_exempt_sale_returns_each_line_on_its_own_terms() {
    let db = shop().await;
    let lines = vec![coffee(1), bread(1)]; // 500 @ 11% + 300 exempt
    let total = lines_total(&lines);
    assert_eq!(total, 800);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let coffee_item = sale_item_id(&db, &sale, P_COFFEE).await;
    let bread_item = sale_item_id(&db, &sale, P_BREAD).await;

    let payload = credit_memo_payload(
        &sale,
        vec![
            return_line(&coffee_item).qty(1).build(),
            return_line(&bread_item).qty(1).build(),
        ],
        vec![refund_cash_usd(800)],
    );
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("a mixed-VAT return must post");

    assert_eq!(result.total_incl_vat_cents, 800);
    assert_eq!(result.subtotal_excl_vat_cents, 750, "450 + 300");
    assert_eq!(result.vat_total_cents, 50, "the coffee's VAT only");

    assert_eq!(memo_line_i64(&db, &memo_id, P_COFFEE, "line_vat_cents").await, 50);
    assert_eq!(
        memo_line_i64(&db, &memo_id, P_BREAD, "line_vat_cents").await,
        0,
        "an exempt line reverses no VAT"
    );
    assert_eq!(memo_line_i64(&db, &memo_id, P_BREAD, "line_subtotal_excl_vat_cents").await, 300);
    assert_eq!(memo_line_i64(&db, &memo_id, P_BREAD, "line_total_incl_vat_cents").await, 300);

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(quantity_on_hand(&db, P_BREAD).await, 50);
    assert_eq!(result.cogs_reversed_cents, 300, "$2.00 coffee + $1.00 bread");
}

// ============================================================================
// 17, 18, 19 — the refund settles the memo exactly
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_under_refund_is_refused() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 900).await)
        .await
        .expect_err("a short refund leaves money owed in no ledger");
    assert!(err.contains("must equal the return exactly"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_over_refund_is_refused() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_100).await)
        .await
        .expect_err("a refund larger than the credit memo hands out money no return earned");
    assert!(err.contains("must equal the return exactly"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_refund_legs_sum_to_the_credit_memo_total() {
    let db = shop().await;
    let lines = vec![coffee(2)];
    let total = lines_total(&lines);
    let sale = post_sale_ok(
        &db,
        sale_payload(lines, vec![cash_usd(300), card_usd(total - 300)]),
    )
    .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let payload = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(2).build()],
        vec![refund_cash_usd(300), refund_card_usd(700)],
    );
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("a split refund that adds up must post");

    assert_eq!(result.refund_total_usd_cents, 1_000);
    assert_eq!(result.total_incl_vat_cents, 1_000);
    assert_eq!(memo_i64(&db, &memo_id, "refund_total_usd_cents").await, 1_000);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_usd_cents_equivalent), 0)
               FROM sales_credit_memo_refunds WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        1_000,
        "the persisted legs must sum to the memo total"
    );
}

// ============================================================================
// 20, 21, 22, 23 — money goes back the way it came
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_card_only_sale_cannot_be_refunded_in_cash() {
    // Opening float of $100 so the drawer could easily FUND the refund. The
    // refusal is about where the money came from, not about whether the till
    // happens to have any.
    let db = shop_with_float(10_000, 0).await;
    let sale = sell_coffee_on_card(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect_err("cash cannot leave the till against a card payment");
    assert!(err.contains("took no cash_usd"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);

    // Back to the card, it posts.
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(2).build()],
            vec![refund_card_usd(1_000)],
        ),
    )
    .await
    .expect("a card refund of a card sale must post");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cash_only_sale_cannot_be_refunded_to_a_card() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(2).build()],
            vec![refund_card_usd(1_000)],
        ),
    )
    .await
    .expect_err("a card that was never charged cannot be credited");
    assert!(err.contains("took no card_usd"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_split_sale_may_be_refunded_through_either_of_its_own_methods_only() {
    let db = shop().await;
    let lines = vec![coffee(2)]; // 1000
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(300), card_usd(700)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // A refund that leans harder on cash than the sale took is refused — and
    // so is one through a method that never appeared on the receipt. The split
    // need not be proportional, only within each method's own cap.
    for (refunds, needle) in [
        (vec![refund_cash_usd(500)], "Refund through cash_usd"),
        (vec![refund_cash_usd(400), refund_card_usd(100)], "Refund through cash_usd"),
        (
            vec![PostCreditMemoRefund {
                refund_id: uuid(),
                method: "bank_transfer".to_string(),
                currency: "USD".to_string(),
                amount_native_usd_cents: 500,
                amount_native_lbp: 0,
                amount_usd_cents_equivalent: 500,
                reference: None,
            }],
            "took no bank_transfer",
        ),
    ] {
        let err = post_credit_memo_with_pool(
            db.pool(),
            credit_memo_payload(&sale, vec![return_line(&item).qty(1).build()], refunds),
        )
        .await
        .unwrap_err();
        assert!(err.contains(needle), "expected {needle}, got: {err}");
    }
    assert_eq!(credit_memo_count(&db).await, 0);

    // Cash 200 + card 300 is inside both caps, and is not the sale's 30/70
    // proportion — which the policy deliberately does not require.
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![refund_cash_usd(200), refund_card_usd(300)],
        ),
    )
    .await
    .expect("a non-proportional split inside both caps must post");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_per_method_refund_cap_is_cumulative_across_every_return_of_a_sale() {
    let db = shop().await;
    let sale = post_sale_ok(&db, sale_payload(vec![coffee(2)], vec![cash_usd(300), card_usd(700)]))
        .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // The first return uses up the whole $3.00 of cash the sale took.
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![refund_cash_usd(300), refund_card_usd(200)],
        ),
    )
    .await
    .expect("the first return must post");

    // So the second cannot take another cent of it, however small.
    let err = post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![refund_cash_usd(1), refund_card_usd(499)],
        ),
    )
    .await
    .expect_err("cash is exhausted for this sale");
    assert!(err.contains("301 against the 300"), "got: {err}");

    // Back to the card, which still has $5.00 of room, it posts.
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![refund_card_usd(500)],
        ),
    )
    .await
    .expect("the card still has room");

    assert_eq!(credit_memo_count(&db).await, 2);
    assert_eq!(
        db.scalar_i64(
            "SELECT COALESCE(SUM(amount_native_usd_cents), 0) FROM sales_credit_memo_refunds
              WHERE method = 'cash_usd'"
        )
        .await,
        300,
        "cash refunded can never exceed cash received"
    );
}

/// Availability is NET of change: a sale that handed $2.00 back received $8.00,
/// and that is also exactly what the drawer counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_cash_cap_is_net_of_the_change_the_sale_gave() {
    let db = shop().await;
    // 2 coffees = $10.00 due, $12.00 tendered, $2.00 change.
    let sale = post_sale_ok(&db, sale_payload(vec![coffee(2)], vec![cash_usd(1_200)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT change_given_usd_cents FROM sale_payments WHERE sale_id = '{sale}'"
        ))
        .await,
        200
    );

    // The full return is $10.00 — the net the customer actually paid — and
    // that is exactly the cap, so it posts.
    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect("the net cash received is refundable in full");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_credit_refund_is_refused_outright() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(2).build()],
            vec![PostCreditMemoRefund {
                refund_id: uuid(),
                method: "store_credit".to_string(),
                currency: "USD".to_string(),
                amount_native_usd_cents: 1_000,
                amount_native_lbp: 0,
                amount_usd_cents_equivalent: 1_000,
                reference: None,
            }],
        ),
    )
    .await
    .expect_err("there is no customer-credit ledger to record it in");
    assert!(err.contains("no customer store-credit ledger"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
}

// ============================================================================
// 24, 25 — the exchange rate is the sale's
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refund_uses_the_sales_locked_rate_and_not_todays() {
    let db = shop().await;
    // $10.00 paid in lira at the locked rate.
    let sale = post_sale_ok(&db, sale_payload(vec![coffee(2)], vec![cash_lbp(895_000)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // The lira moves — sharply, as it does.
    seed_exchange_rate_at(&db, "rate-today", 120_000).await;

    let payload = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(2).build()],
        vec![refund_cash_lbp(895_000)],
    );
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("the lira refund must settle at the sale's own rate");

    assert_eq!(result.refund_total_usd_cents, 1_000);
    assert_eq!(
        memo_i64(&db, &memo_id, "exchange_rate_lbp_per_usd").await,
        RATE_LBP_PER_USD,
        "the memo is locked to the sale's rate, not to the rate in force today"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT amount_usd_cents_equivalent FROM sales_credit_memo_refunds
              WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        1_000,
        "895,000 LBP at 89,500 LBP/USD is $10.00 — at 120,000 it would be $7.46"
    );

    // And a payload that declares today's rate is refused rather than ignored:
    // the screen the cashier read was priced against a different number.
    let sale_b = post_sale_ok(&db, sale_payload(vec![coffee(2)], vec![cash_lbp(895_000)])).await;
    let item_b = sale_item_id(&db, &sale_b, P_COFFEE).await;
    let mut crafted = credit_memo_payload(
        &sale_b,
        vec![return_line(&item_b).qty(2).build()],
        vec![refund_cash_lbp(895_000)],
    );
    crafted.exchange_rate_lbp_per_usd = Some(120_000);
    let err = post_credit_memo_with_pool(db.pool(), crafted)
        .await
        .expect_err("a declared rate that disagrees with the sale is refused");
    assert!(err.contains("Exchange rate mismatch"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refund_that_misstates_its_usd_equivalent_is_refused() {
    let db = shop().await;
    let sale = post_sale_ok(
        &db,
        sale_payload(vec![coffee(2)], vec![cash_usd(500), cash_lbp(447_500)]),
    )
    .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // A USD leg whose equivalent is not its own amount.
    let mut bad_usd = refund_cash_usd(500);
    bad_usd.amount_usd_cents_equivalent = 499;
    let err = post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![bad_usd],
        ),
    )
    .await
    .expect_err("a declared USD equivalent is a cross-check, not an input");
    assert!(err.contains("does not match"), "got: {err}");

    // An LBP leg whose equivalent is not the conversion at the locked rate.
    let mut bad_lbp = refund_cash_lbp(447_500);
    bad_lbp.amount_usd_cents_equivalent = 900;
    let err = post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![bad_lbp],
        ),
    )
    .await
    .expect_err("an inflated lira equivalent is refused");
    assert!(err.contains("at the sale's locked rate"), "got: {err}");

    assert_eq!(credit_memo_count(&db).await, 0);
}

// ============================================================================
// 26, 27, 28, 29 — the cash drawer
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cash_refund_reduces_the_expected_drawer_and_a_card_refund_does_not() {
    let db = shop_with_float(5_000, 0).await;
    let sale = post_sale_ok(
        &db,
        sale_payload(vec![coffee(4)], vec![cash_usd(1_000), card_usd(1_000)]),
    )
    .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // $10.00 back on the card: no cash moves.
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(2).build()],
            vec![refund_card_usd(1_000)],
        ),
    )
    .await
    .expect("a card refund must post");

    // $10.00 back in cash: the till is $10.00 lighter.
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(2).build()],
            vec![refund_cash_usd(1_000)],
        ),
    )
    .await
    .expect("a cash refund must post");

    // Expected = $50 float + $10 cash in - $10 cash refunded = $50.
    let shift = close_shift_with_pool(
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
    .expect("the shift must close");

    assert_eq!(
        shift.expected_cash_usd_cents,
        Some(5_000),
        "the card refund is absent from the drawer; the cash refund is subtracted"
    );
    assert_eq!(shift.variance_usd_cents, Some(0), "a counted $50 reconciles exactly");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_lbp_cash_refund_reduces_the_expected_lira_drawer() {
    let db = shop_with_float(0, 1_000_000).await;
    let sale = post_sale_ok(&db, sale_payload(vec![coffee(2)], vec![cash_lbp(895_000)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(1).build()],
            vec![refund_cash_lbp(447_500)],
        ),
    )
    .await
    .expect("a lira refund must post");

    let shift = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 0,
            closing_cash_lbp: 1_447_500,
        },
    )
    .await
    .expect("the shift must close");

    assert_eq!(
        shift.expected_cash_lbp,
        Some(1_447_500),
        "1,000,000 float + 895,000 in - 447,500 refunded"
    );
    assert_eq!(shift.variance_lbp, Some(0));
}

/// Refunding yesterday's cash sale out of today's empty till. The tender cap
/// permits it — the sale really did take that cash — but the drawer cannot
/// fund it, and that is a separate rule with its own answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_usd_cash_refund_cannot_drive_the_usd_drawer_negative() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 10).await; // $50.00 into shift A
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    close_shift_with_pool(
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
    .expect("shift A closes with the cash in it");

    // Today's shift opens with $6.00 of float and nothing else.
    open_shift_with_pool(
        db.pool(),
        OpenShiftPayload {
            shift_id: SHIFT_B.to_string(),
            store_id: STORE_ID.to_string(),
            opened_by_user_id: USER_ID.to_string(),
            device_id: None,
            opening_cash_usd_cents: 600,
            opening_cash_lbp: 0,
            notes: None,
        },
    )
    .await
    .expect("shift B opens");

    let mut full = cash_return(&db, &sale, &item, 10, 5_000).await;
    full.shift_id = Some(SHIFT_B.to_string());
    let err = post_credit_memo_with_pool(db.pool(), full)
        .await
        .expect_err("$50 cannot come out of a $6 till");
    assert!(err.contains("expected to hold 600"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 90, "nothing restocked");

    // One coffee — $5.00 — fits.
    let mut small = cash_return(&db, &sale, &item, 1, 500).await;
    small.shift_id = Some(SHIFT_B.to_string());
    post_credit_memo_with_pool(db.pool(), small)
        .await
        .expect("a refund the till can fund must post");

    let shift = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_B.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 100,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("shift B closes");
    assert_eq!(shift.expected_cash_usd_cents, Some(100), "$6.00 float less the $5.00 refund");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_lbp_cash_refund_cannot_drive_the_lbp_drawer_negative() {
    let db = shop().await;
    let sale = post_sale_ok(&db, sale_payload(vec![coffee(2)], vec![cash_lbp(895_000)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 0,
            closing_cash_lbp: 895_000,
        },
    )
    .await
    .expect("shift A closes");

    open_shift_with_pool(
        db.pool(),
        OpenShiftPayload {
            shift_id: SHIFT_B.to_string(),
            store_id: STORE_ID.to_string(),
            opened_by_user_id: USER_ID.to_string(),
            device_id: None,
            opening_cash_usd_cents: 0,
            opening_cash_lbp: 500_000,
            notes: None,
        },
    )
    .await
    .expect("shift B opens");

    let mut full = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(2).build()],
        vec![refund_cash_lbp(895_000)],
    );
    full.shift_id = Some(SHIFT_B.to_string());
    let err = post_credit_memo_with_pool(db.pool(), full)
        .await
        .expect_err("895,000 LBP cannot come out of a 500,000 LBP till");
    assert!(err.contains("expected to hold 500000"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 0);

    // Half of it fits.
    let mut half = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(1).build()],
        vec![refund_cash_lbp(447_500)],
    );
    half.shift_id = Some(SHIFT_B.to_string());
    post_credit_memo_with_pool(db.pool(), half)
        .await
        .expect("447,500 LBP fits in a 500,000 LBP till");
}

// ============================================================================
// 30, 31, 32 — the shift
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_return_must_name_an_open_shift_of_its_store() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // No shift at all.
    let mut unattributed = cash_return(&db, &sale, &item, 2, 1_000).await;
    unattributed.shift_id = None;
    let err = post_credit_memo_with_pool(db.pool(), unattributed)
        .await
        .expect_err("a refund outside the cash-control model is refused");
    assert!(err.contains("not attached to a shift"), "got: {err}");

    // A shift of another store.
    seed_store(&db, "store-b", "Branch B").await;
    db.exec(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                             opening_cash_usd_cents, opening_cash_lbp, status)
         VALUES ('shift-other', 'store-b', '00000000-0000-0000-0000-000000000002',
                 '2026-01-01T08:00:00.000Z', 0, 0, 'open')",
    )
    .await;
    let mut foreign = cash_return(&db, &sale, &item, 2, 1_000).await;
    foreign.shift_id = Some("shift-other".to_string());
    let err = post_credit_memo_with_pool(db.pool(), foreign)
        .await
        .expect_err("another store's shift is not this store's drawer");
    assert!(err.contains("is not a shift of store"), "got: {err}");

    assert_eq!(credit_memo_count(&db).await, 0);
    assert_eq!(next_credit_memo_number(&db).await, 1, "no number was consumed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_return_into_a_closed_shift_is_refused_but_a_replay_still_resolves() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 4).await; // $20.00
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // One return goes through while the shift is open.
    let posted = cash_return(&db, &sale, &item, 2, 1_000).await;
    let replay = replay_of_credit_memo(&posted);
    let first = post_credit_memo_with_pool(db.pool(), posted)
        .await
        .expect("the first return posts into the open shift");

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
    .expect("the shift closes with the refund counted");

    // A NEW return into the closed shift is refused.
    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect_err("a closed shift cannot acquire a refund");
    assert!(err.contains("not open"), "got: {err}");
    assert_eq!(credit_memo_count(&db).await, 1);

    // But a REPLAY of the one that already posted still reconciles — the
    // customer has the money and the retry must hand back the same memo.
    let again = post_credit_memo_with_pool(db.pool(), replay)
        .await
        .expect("a replay must resolve even after the shift has closed and been counted");
    assert_eq!(again.credit_memo_number, first.credit_memo_number);
    assert_eq!(again.total_incl_vat_cents, first.total_incl_vat_cents);
    assert_eq!(credit_memo_count(&db).await, 1, "no second memo");
}

/// Return versus close, racing through two real connection pools. Only two
/// outcomes are valid: the return lands in the shift that then closes with it
/// counted, or the close wins and the return is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_return_racing_a_shift_close_resolves_into_valid_outcomes_only() {
    let db = shop().await;
    let rival = db.rival_pool().await;
    let sale = sell_coffee_for_cash(&db, 4).await; // $20.00 in the till
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let returning = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await);
    let closing = close_shift_with_pool(
        &rival,
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 1_000,
            closing_cash_lbp: 0,
        },
    );
    let (ret, close) = tokio::join!(returning, closing);

    let memos = credit_memo_count(&db).await;
    let expected_usd = db
        .scalar_i64(&format!(
            "SELECT COALESCE(expected_cash_usd_cents, -1) FROM shifts WHERE id = '{SHIFT_ID}'"
        ))
        .await;

    match (ret.is_ok(), close.is_ok()) {
        (true, true) => {
            // The return committed first, so the close must have counted it.
            assert_eq!(memos, 1);
            assert_eq!(
                expected_usd, 1_000,
                "a close that commits after a refund must include it: $20 in - $10 back"
            );
        }
        (false, true) => {
            assert_eq!(memos, 0, "a refused return leaves nothing behind");
            assert_eq!(expected_usd, 2_000, "the drawer holds the whole sale");
        }
        (true, false) => {
            // The close lost; the shift is still open and holds the return.
            assert_eq!(memos, 1);
            assert_eq!(shift_status(&db, SHIFT_ID).await, "open");
        }
        (false, false) => panic!("one of the two operations must succeed: {ret:?} / {close:?}"),
    }

    // Whatever happened, no refund committed into a closed shift.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM sales_credit_memos m
               JOIN shifts s ON s.id = m.shift_id
              WHERE m.status = 'posted' AND s.status = 'closed' AND s.closed_at < m.posted_at"
        )
        .await,
        0,
        "no credit memo may be stamped after its shift was closed"
    );

    rival.close().await;
}

/// Two returns of the whole line, racing. Between them they would send back
/// twice what was sold.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_concurrent_full_returns_cannot_both_commit() {
    let db = shop_with_float(10_000, 0).await;
    let rival = db.rival_pool().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let a = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await);
    let b = post_credit_memo_with_pool(&rival, cash_return(&db, &sale, &item, 2, 1_000).await);
    let (ra, rb) = tokio::join!(a, b);

    let winners = [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count();
    assert_eq!(
        winners, 1,
        "exactly one of two full returns may commit; got a={ra:?} b={rb:?}"
    );

    assert_eq!(credit_memo_count(&db).await, 1, "one memo, not two");
    assert_eq!(returned_quantity(&db, &item).await, 2, "two sold, two returned");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "not 102");
    assert_eq!(movement_sum(&db, P_COFFEE).await, 0);
    assert_eq!(
        db.scalar_i64(
            "SELECT COALESCE(SUM(amount_native_usd_cents), 0) FROM sales_credit_memo_refunds"
        )
        .await,
        1_000,
        "the customer is refunded once"
    );

    rival.close().await;
}

// ============================================================================
// 33, 34, 35 — idempotency on the return identity
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_a_return_reconciles_to_the_memo_that_already_posted() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let payload = cash_return(&db, &sale, &item, 2, 1_000).await;
    let replay = replay_of_credit_memo(&payload);
    let fresh_children = replay_of_credit_memo_with_new_child_ids(&payload);
    let first = post_credit_memo_with_pool(db.pool(), payload).await.expect("post");

    for (label, again) in [("verbatim", replay), ("new child ids", fresh_children)] {
        let result = post_credit_memo_with_pool(db.pool(), again)
            .await
            .unwrap_or_else(|e| panic!("the {label} replay must reconcile: {e}"));
        assert_eq!(result.credit_memo_number, first.credit_memo_number, "{label}");
        assert_eq!(result.posted_at, first.posted_at, "{label}");
        assert_eq!(result.total_incl_vat_cents, first.total_incl_vat_cents, "{label}");
        assert_eq!(result.cogs_reversed_cents, first.cogs_reversed_cents, "{label}");
        assert_eq!(result.movement_ids, first.movement_ids, "{label}");
    }

    // A replay writes NOTHING: one memo, one refund, one restock, one number.
    assert_eq!(credit_memo_count(&db).await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales_credit_memo_lines").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales_credit_memo_refunds").await, 1);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'return_in'")
            .await,
        1
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "not 102");
    assert_eq!(next_credit_memo_number(&db).await, 2, "a replay consumes no number");
    assert_eq!(avg_cost_excl_microcents(&db, P_COFFEE).await, 200_000_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_return_identity_with_different_content_is_a_conflict() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 4).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    let payload = cash_return(&db, &sale, &item, 1, 500).await;
    let identity = payload.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), payload).await.expect("post");

    // Same identity, a different quantity.
    let mut different_qty = cash_return(&db, &sale, &item, 2, 1_000).await;
    different_qty.credit_memo_id = identity.clone();
    let err = post_credit_memo_with_pool(db.pool(), different_qty)
        .await
        .expect_err("a reused identity for different content is a conflict");
    assert!(err.contains("a different returned line"), "got: {err}");

    // Same identity, a different restock decision.
    let mut different_restock = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(1).restock(false).build()],
        vec![refund_cash_usd(500)],
    );
    different_restock.credit_memo_id = identity.clone();
    let err = post_credit_memo_with_pool(db.pool(), different_restock)
        .await
        .expect_err("whether the goods came back is material");
    assert!(err.contains("a different returned line"), "got: {err}");

    // Same identity, a different refund method mix.
    let mut different_tender = credit_memo_payload(
        &sale,
        vec![return_line(&item).qty(1).build()],
        vec![refund_cash_usd(250), refund_cash_usd(250)],
    );
    different_tender.credit_memo_id = identity.clone();
    let err = post_credit_memo_with_pool(db.pool(), different_tender)
        .await
        .expect_err("how the money went back is material");
    assert!(err.contains("a different refund"), "got: {err}");

    assert_eq!(credit_memo_count(&db).await, 1);
    assert_eq!(returned_quantity(&db, &item).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_partial_return_under_its_own_identity_posts() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 4).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // Two separate visits, two identities, the same amount each time. Content
    // deduplication would swallow the second; identity keying must not.
    let first = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 500).await)
        .await
        .expect("the first visit");
    let second = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 500).await)
        .await
        .expect("the second visit is a second return, not a retry of the first");

    assert_eq!(first.credit_memo_number, 1);
    assert_eq!(second.credit_memo_number, 2);
    assert_eq!(credit_memo_count(&db).await, 2);
    assert_eq!(returned_quantity(&db, &item).await, 2);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
}

// ============================================================================
// 36, 37 — a rejected return leaves nothing behind
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_return_consumes_no_credit_memo_number() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    assert_eq!(next_credit_memo_number(&db).await, 1);

    // Four different refusals, each from a different stage of the command.
    for payload in [
        cash_return(&db, &sale, &item, 5, 2_500).await,  // over-return
        cash_return(&db, &sale, &item, 2, 900).await,    // under-refund
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(2).build()],
            vec![refund_card_usd(1_000)],
        ), // a method the sale never took
    ] {
        post_credit_memo_with_pool(db.pool(), payload)
            .await
            .expect_err("each of these must be refused");
    }

    assert_eq!(
        next_credit_memo_number(&db).await,
        1,
        "the sequence must not advance on a refusal"
    );

    let ok = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 2, 1_000).await)
        .await
        .expect("a good return still gets #1");
    assert_eq!(ok.credit_memo_number, 1);
    assert_eq!(next_credit_memo_number(&db).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_on_the_second_line_rolls_the_whole_return_back() {
    let db = shop().await;
    let lines = vec![coffee(2), bread(2)];
    let total = lines_total(&lines);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let coffee_item = sale_item_id(&db, &sale, P_COFFEE).await;
    let bread_item = sale_item_id(&db, &sale, P_BREAD).await;
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
    assert_eq!(quantity_on_hand(&db, P_BREAD).await, 48);

    // Line 1 is perfectly good; line 2 asks for more bread than was sold.
    let payload = credit_memo_payload(
        &sale,
        vec![
            return_line(&coffee_item).qty(1).build(),
            return_line(&bread_item).qty(3).build(),
        ],
        vec![refund_cash_usd(1_400)],
    );
    let err = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect_err("the second line is an over-return");
    assert!(err.contains("Return line 2"), "got: {err}");

    // Nothing from line 1 survives: no memo, no line, no movement, no stock.
    assert_eq!(credit_memo_count(&db).await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales_credit_memo_lines").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales_credit_memo_refunds").await, 0);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'return_in'")
            .await,
        0
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98, "the good line did not restock");
    assert_eq!(quantity_on_hand(&db, P_BREAD).await, 48);
    assert_eq!(next_credit_memo_number(&db).await, 1);
}

// ============================================================================
// 50 — the original sale is never touched
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_return_does_not_touch_the_sale_it_reverses() {
    let db = shop().await;
    let lines = vec![coffee(2), bread(2)];
    let total = lines_total(&lines);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let coffee_item = sale_item_id(&db, &sale, P_COFFEE).await;
    let bread_item = sale_item_id(&db, &sale, P_BREAD).await;

    let before = sale_fingerprint(&db, &sale).await;

    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![
                return_line(&coffee_item).qty(2).build(),
                return_line(&bread_item).qty(1).restock(false).build(),
            ],
            vec![refund_cash_usd(1_300)],
        ),
    )
    .await
    .expect("the return must post");

    assert_eq!(
        sale_fingerprint(&db, &sale).await,
        before,
        "a return must not restate a single column of the sale it reverses"
    );
    // And the sale is still a plain 'normal' sale with no credit-memo back-link
    // — the return status is derived, never written onto the sale.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales WHERE id = '{sale}' AND sale_type = 'normal'
               AND original_sale_id IS NULL"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sales WHERE sale_type = 'credit_memo'").await,
        0,
        "a return is never written into the sales table"
    );
    // The sale's own movements are untouched too: a restock movement does not
    // wear `related_sale_id`, so it cannot appear in the sale's movement list.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id = '{sale}'"
        ))
        .await,
        2,
        "two sale movements, and no return movement among them"
    );
}

/// The database refuses an over-return from ANY writer, not only from the
/// posting command — a direct SQL fix, a future importer, a second process.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_over_return_guard_binds_writers_that_bypass_the_command() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // A draft memo, written by hand.
    db.exec(&format!(
        "INSERT INTO sales_credit_memos (
           id, store_id, original_sale_id, credit_memo_number, shift_id,
           exchange_rate_lbp_per_usd, status
         ) VALUES ('memo-raw', '{STORE_ID}', '{sale}', 900, '{SHIFT_ID}', {RATE_LBP_PER_USD}, 'draft')"
    ))
    .await;

    let line = |id: &str, qty: i64| {
        format!(
            "INSERT INTO sales_credit_memo_lines (
               id, credit_memo_id, store_id, original_sale_item_id, product_id,
               product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
               quantity_base, quantity_in_uom,
               unit_price_excl_vat_cents, unit_price_incl_vat_cents,
               line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
               return_to_stock
             ) VALUES ('{id}', 'memo-raw', '{STORE_ID}', '{item}', '{P_COFFEE}',
                       'Coffee 250g', '{VAT_STD_ID}', 1100, {qty}, {qty},
                       450, 500, 450, 50, 500, 0)"
        )
    };

    // Three at once, from a sale of two.
    let err = db.try_exec(&line("raw-1", 3)).await.expect_err("the trigger must abort");
    assert!(
        err.to_string().contains("cannot exceed the quantity"),
        "got: {err}"
    );

    // Two is fine; a third unit afterwards is not, because the trigger counts
    // the memo's own draft lines as well as every posted one.
    db.exec(&line("raw-2", 2)).await;
    let err = db.try_exec(&line("raw-3", 1)).await.expect_err("the trigger must abort");
    assert!(err.to_string().contains("cannot exceed the quantity"), "got: {err}");

    // And a line naming an item of another receipt is refused.
    let sale_b = sell_coffee_for_cash(&db, 1).await;
    let item_b = sale_item_id(&db, &sale_b, P_COFFEE).await;
    let err = db
        .try_exec(&line("raw-4", 1).replace(&item, &item_b))
        .await
        .expect_err("the trigger must abort");
    assert!(
        err.to_string().contains("item of the memo's own original sale"),
        "got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_return_needs_a_posted_sale_of_its_own_store() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // A sale of another store is not this store's to refund.
    seed_store(&db, "store-b", "Branch B").await;
    let mut foreign = cash_return(&db, &sale, &item, 2, 1_000).await;
    foreign.store_id = "store-b".to_string();
    let err = post_credit_memo_with_pool(db.pool(), foreign)
        .await
        .expect_err("another store's books are not ours");
    assert!(err.contains("is not a sale of store"), "got: {err}");

    // And a sale that does not exist at all.
    let mut missing = cash_return(&db, &sale, &item, 2, 1_000).await;
    missing.original_sale_id = "no-such-sale".to_string();
    let err = post_credit_memo_with_pool(db.pool(), missing)
        .await
        .expect_err("a return needs a sale to reverse");
    assert!(err.contains("is not a sale of store"), "got: {err}");

    assert_eq!(credit_memo_count(&db).await, 0);
}

/// The whole-ledger invariant WP-01 protects: `products.quantity_on_hand` is
/// always the sum of that product's movements, plus whatever it was seeded
/// with. Returns are the first writer since WP-05 to add stock outside a
/// purchase, so it is restated here against a mixed history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_inventory_ledger_still_reconciles_after_returns() {
    let db = shop().await;
    let sale_a = sell_coffee_for_cash(&db, 5).await;
    let sale_b = sell_coffee_for_cash(&db, 3).await;
    let item_a = sale_item_id(&db, &sale_a, P_COFFEE).await;
    let item_b = sale_item_id(&db, &sale_b, P_COFFEE).await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload(
            "normal",
            Some(SUPPLIER),
            vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee 250g")
                .qty(20)
                .unit_cost_excl(250)
                .build()],
        ),
    )
    .await
    .expect("purchase");

    post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale_a, &item_a, 2, 1_000).await)
        .await
        .expect("restocked return");
    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale_b,
            vec![return_line(&item_b).qty(1).restock(false).build()],
            vec![refund_cash_usd(500)],
        ),
    )
    .await
    .expect("write-off return");

    // Seeded 100, then: -5, -3, +20, +2 (restocked), and nothing for the
    // write-off.
    assert_eq!(movement_sum(&db, P_COFFEE).await, 14);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 114);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'return_in'")
            .await,
        1,
        "only the restocked line produced a movement"
    );
}

/// A lira card sale, refunded to the same lira card. Two things are being
/// pinned: a non-cash lira tender touches the drawer in neither direction, and
/// the excl- and incl-VAT averages are re-blended as a PAIR — a product
/// carrying two costs that are not the same cost would make every
/// VAT-inclusive valuation report disagree with its exclusive twin.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lira_card_refund_reblends_both_averages_and_leaves_the_drawer_alone() {
    let db = shop_with_float(2_500, 3_000_000).await;
    let lines = vec![coffee(10)]; // $50.00
    let sale = post_sale_ok(&db, sale_payload(lines, vec![card_lbp(4_475_000)])).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // Restock at a higher cost, so both averages move before the return.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload(
            "normal",
            Some(SUPPLIER),
            vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee 250g")
                .qty(10)
                .unit_cost_excl(400)
                .build()],
        ),
    )
    .await
    .expect("purchase");
    assert_eq!(avg_cost_excl_microcents(&db, P_COFFEE).await, 220_000_000);
    assert_eq!(avg_cost_incl_microcents(&db, P_COFFEE).await, 244_200_000);

    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &sale,
            vec![return_line(&item).qty(10).build()],
            vec![refund_card_lbp(4_475_000)],
        ),
    )
    .await
    .expect("a lira card refund must post");

    // (100 x avg + 10 x the rate the goods left at) / 110, on both sides.
    assert_eq!(avg_cost_excl_microcents(&db, P_COFFEE).await, 218_181_818);
    assert_eq!(
        avg_cost_incl_microcents(&db, P_COFFEE).await,
        242_181_818,
        "the incl-VAT average must move with its excl-VAT twin, never without it"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_incl_vat_microcents FROM inventory_movements
              WHERE related_credit_memo_id IS NOT NULL AND product_id = '{P_COFFEE}'"
        ))
        .await,
        222_000_000,
        "the restock movement carries the sale's own incl-VAT cost rate"
    );

    // Not a cent and not a lira left the till.
    let shift = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 2_500,
            closing_cash_lbp: 3_000_000,
        },
    )
    .await
    .expect("close");
    assert_eq!(shift.expected_cash_usd_cents, Some(2_500), "the float, untouched");
    assert_eq!(shift.expected_cash_lbp, Some(3_000_000));
    assert_eq!(shift.variance_usd_cents, Some(0));
    assert_eq!(shift.variance_lbp, Some(0));
}

// ============================================================================
// Partial-return VAT allocation
// ============================================================================
//
// THE DEFECT THIS BLOCK EXISTS FOR. The first implementation prorated the line
// TOTAL and the line SUBTOTAL cumulatively and then took VAT as the residual
// `total − subtotal`. Each of those two series is monotone on its own, but
// their DIFFERENCE is not: the two roundings can move in opposite directions on
// the same step, and the residual goes negative.
//
// The smallest real case is a 3-unit line of 11 cents — 10 net + 1 VAT:
//
//            cumulative total      cumulative subtotal      residual VAT
//   q = 1    round(11/3) = 4       round(10/3) = 3          4 − 3 =  1
//   q = 2    round(22/3) = 7       round(20/3) = 7          3 − 4 = −1   <-- !
//   q = 3                11                      10
//
// So returning the second unit asked to credit −1 cent of VAT, the
// non-negative-VAT guard refused it, and a customer could not return goods they
// had bought. Weakening that guard was not an option: a negative VAT slice is a
// credit note that ADDS output VAT, which is worse than a refused refund.
//
// THE FIX is to prorate the two components the sale actually persisted —
// subtotal and VAT — each cumulatively, and to derive the TOTAL as their sum.
// Both originals are non-negative, so each series is monotone and every slice
// is non-negative; and because each lands exactly on its own original at full
// return, so does their sum.

/// Sell `qty` units as ONE line carrying the given persisted subtotal / VAT /
/// total, paid in cash. The figures are stated raw because the point here is
/// awkward arithmetic, not plausible pricing.
async fn sell_awkward_line(db: &TempDb, qty: i64, subtotal: i64, vat: i64) -> (String, String) {
    let total = subtotal + vat;
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
        .qty(qty)
        .unit_incl(1)
        .raw_line_totals(subtotal, vat, total)
        .build();
    let sale = post_sale_ok(db, sale_payload(vec![line], vec![cash_usd(total)])).await;
    let item = sale_item_id(db, &sale, P_COFFEE).await;
    (sale, item)
}

/// Return one line in `chunks`, in order, and assert the whole line is reversed
/// exactly: every slice non-negative and self-consistent, and the cumulative
/// subtotal, VAT and total each landing on the original to the cent.
async fn assert_partition_reverses_exactly(qty: i64, subtotal: i64, vat: i64, chunks: &[i64]) {
    let db = shop().await;
    let (sale, item) = sell_awkward_line(&db, qty, subtotal, vat).await;
    let total = subtotal + vat;

    let mut got = (0i64, 0i64, 0i64);
    for (i, chunk) in chunks.iter().enumerate() {
        // The refund must equal the memo exactly, so the amount is not
        // something the test may guess at — it is derived the same way the
        // command derives it, which is also what makes this an assertion about
        // the allocation rule rather than about a number copied from it.
        let already = returned_quantity(&db, &item).await;
        let slice = |amount: i64| {
            prorated_cumulative_cents(amount, already + chunk, qty).unwrap()
                - prorated_cumulative_cents(amount, already, qty).unwrap()
        };
        let expected_total = slice(subtotal) + slice(vat);

        let result = post_credit_memo_with_pool(
            db.pool(),
            cash_return(&db, &sale, &item, *chunk, expected_total).await,
        )
        .await
        .unwrap_or_else(|e| {
            panic!(
                "qty {qty}, {subtotal}+{vat}, partition {chunks:?}: chunk {} must post: {e}",
                i + 1
            )
        });

        assert!(
            result.vat_total_cents >= 0,
            "qty {qty}, {subtotal}+{vat}, partition {chunks:?}: a VAT slice went negative"
        );
        assert!(result.subtotal_excl_vat_cents >= 0 && result.total_incl_vat_cents >= 0);
        assert_eq!(
            result.subtotal_excl_vat_cents + result.vat_total_cents,
            result.total_incl_vat_cents,
            "qty {qty}, {subtotal}+{vat}: every memo must reconcile on its own"
        );
        got.0 += result.subtotal_excl_vat_cents;
        got.1 += result.vat_total_cents;
        got.2 += result.total_incl_vat_cents;
    }

    assert_eq!(
        got,
        (subtotal, vat, total),
        "qty {qty}, {subtotal}+{vat}, partition {chunks:?}: the line must reverse exactly"
    );
    assert_eq!(returned_quantity(&db, &item).await, qty);
}

/// THE regression case. 11 cents over three units, as 1+1+1, 2+1, 1+2 and 3.
/// Under the residual-VAT rule the second unit of the 1+1+1 partition asked to
/// credit −1 cent and the return was refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_eleven_cent_three_unit_line_reverses_exactly_in_every_partition() {
    for chunks in [vec![1, 1, 1], vec![2, 1], vec![1, 2], vec![3]] {
        assert_partition_reverses_exactly(3, 10, 1, &chunks).await;
    }
}

/// The PROPERTY the residual rule failed. It is not enough for a full return to
/// reconcile: every ordering and every split of the quantity has to go through,
/// with no negative slice anywhere along the way.
///
/// Exhaustive over the shapes a till actually produces — small quantities,
/// awkward cent totals, every VAT split of each — as pure arithmetic, so the
/// whole space is covered rather than sampled. It is the CUMULATIVE position
/// that decides a slice, so a monotone cumulative series means every chunk from
/// every earlier position is non-negative, for every partition at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_partition_of_any_small_line_can_produce_a_negative_slice() {
    for qty in 2..=12i64 {
        for total in 1..=40i64 {
            for vat in 0..=total {
                let subtotal = total - vat;
                let mut prev_sub = 0;
                let mut prev_vat = 0;
                for q in 1..=qty {
                    let cum_sub = prorated_cumulative_cents(subtotal, q, qty).unwrap();
                    let cum_vat = prorated_cumulative_cents(vat, q, qty).unwrap();
                    assert!(
                        cum_sub >= prev_sub,
                        "qty {qty}, {subtotal}+{vat}: subtotal series decreased at q={q}"
                    );
                    assert!(
                        cum_vat >= prev_vat,
                        "qty {qty}, {subtotal}+{vat}: VAT series decreased at q={q}"
                    );
                    prev_sub = cum_sub;
                    prev_vat = cum_vat;
                }
                // And a full return lands exactly on each original, so the sum
                // of the slices is the original line, penny for penny.
                assert_eq!(prev_sub, subtotal, "qty {qty}, {subtotal}+{vat}");
                assert_eq!(prev_vat, vat, "qty {qty}, {subtotal}+{vat}");
                assert_eq!(prev_sub + prev_vat, total);
            }
        }
    }
}

/// The same property, but driven end to end through the real posting command
/// at several quantities and in several orders.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn awkward_vat_amounts_reverse_exactly_across_several_quantities() {
    for (qty, subtotal, vat, chunks) in [
        (3i64, 10i64, 1i64, vec![1, 1, 1]),
        (3, 2, 1, vec![1, 1, 1]),
        (3, 2, 1, vec![2, 1]),
        (3, 4, 2, vec![1, 1, 1]),
        (4, 7, 3, vec![1, 1, 1, 1]),
        (4, 7, 3, vec![3, 1]),
        (5, 13, 2, vec![1, 2, 2]),
        (7, 100, 11, vec![4, 3]),
        (9, 29, 3, vec![2, 3, 4]),
    ] {
        assert_partition_reverses_exactly(qty, subtotal, vat, &chunks).await;
    }
}

/// THE BOUNDARY the cumulative rule has, stated so nobody has to rediscover it.
///
/// A cent is the smallest amount that can be refunded, so a line worth LESS
/// than about one cent per unit has steps on which nothing more is owed yet. A
/// 2-cent line over three units credits 0, 1, 1 — and a credit memo that
/// credits nothing is refused, because a document with no money on it has no
/// refund leg to balance and nothing for a report to show.
///
/// This is a property of money's resolution, not of the allocation: the whole
/// remainder always credits the whole remaining amount, so such a line is
/// returnable — in one go rather than unit by unit. It is unreachable in
/// practice (three items sold for under a cent each is not a transaction a till
/// produces, and a zero-total sale is refused outright by `post_sale`), and it
/// is pinned here rather than papered over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_worth_less_than_a_cent_per_unit_must_be_returned_in_one_go() {
    let db = shop().await;
    let (sale, item) = sell_awkward_line(&db, 3, 1, 1).await;

    // The first unit of a 2-cent, 3-unit line credits nothing.
    let err = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 1, 1).await)
        .await
        .expect_err("a memo that credits nothing cannot be posted");
    assert!(
        err.contains("must equal the return exactly") || err.contains("positive amount"),
        "got: {err}"
    );
    assert_eq!(credit_memo_count(&db).await, 0);

    // The whole line comes back for its whole value.
    let result = post_credit_memo_with_pool(db.pool(), cash_return(&db, &sale, &item, 3, 2).await)
        .await
        .expect("the whole remainder is always returnable");
    assert_eq!(result.subtotal_excl_vat_cents, 1);
    assert_eq!(result.vat_total_cents, 1);
    assert_eq!(result.total_incl_vat_cents, 2);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

/// The degenerate ends of the rule: an exempt line reverses no VAT at any step,
/// and a line that is all VAT reverses no subtotal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_degenerate_ends_of_the_allocation_hold() {
    assert_partition_reverses_exactly(3, 10, 0, &[1, 1, 1]).await;
    assert_partition_reverses_exactly(3, 0, 10, &[1, 1, 1]).await;
}

/// A mixed-VAT sale returned a unit at a time: each line is allocated against
/// its OWN persisted components, so the exempt line stays at zero VAT while the
/// standard-rate line reverses its own awkward split.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mixed_vat_sale_allocates_each_line_against_its_own_components() {
    let db = shop().await;
    // Coffee: 3 units persisted as 10 + 1 = 11. Bread: 3 exempt units of 300.
    let coffee_line = SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
        .qty(3)
        .unit_incl(1)
        .raw_line_totals(10, 1, 11)
        .build();
    let bread_line = bread(3);
    let total = 11 + 900;
    let sale = post_sale_ok(
        &db,
        sale_payload(vec![coffee_line, bread_line], vec![cash_usd(total)]),
    )
    .await;
    let coffee_item = sale_item_id(&db, &sale, P_COFFEE).await;
    let bread_item = sale_item_id(&db, &sale, P_BREAD).await;

    let mut sums = (0i64, 0i64, 0i64);
    for step in 0..3 {
        let payload = credit_memo_payload(
            &sale,
            vec![
                return_line(&coffee_item).qty(1).build(),
                return_line(&bread_item).qty(1).build(),
            ],
            // coffee slice + 300 of bread. The coffee slices are 3, 5, 3.
            vec![refund_cash_usd([3, 5, 3][step] + 300)],
        );
        let memo_id = payload.credit_memo_id.clone();
        let result = post_credit_memo_with_pool(db.pool(), payload)
            .await
            .unwrap_or_else(|e| panic!("mixed return {} must post: {e}", step + 1));

        assert_eq!(
            memo_line_i64(&db, &memo_id, P_BREAD, "line_vat_cents").await,
            0,
            "an exempt line reverses no VAT at any step"
        );
        assert_eq!(memo_line_i64(&db, &memo_id, P_BREAD, "line_total_incl_vat_cents").await, 300);
        assert!(memo_line_i64(&db, &memo_id, P_COFFEE, "line_vat_cents").await >= 0);

        sums.0 += result.subtotal_excl_vat_cents;
        sums.1 += result.vat_total_cents;
        sums.2 += result.total_incl_vat_cents;
    }

    // 10 + 900 net, 1 VAT, 911 gross — the header of the sale, exactly.
    assert_eq!(sums, (910, 1, 911));
}

// ============================================================================
// Posted-credit-memo sealing
// ============================================================================
//
// WP-06 HAS NO VOID COMMAND. A posted credit memo has already moved stock, the
// cost pool and the drawer, so "voided" is not a status a row may simply
// acquire: undoing it needs compensating entries that nothing in this package
// writes. Migration 011 therefore seals a posted memo COMPLETELY — no UPDATE of
// any kind, no DELETE, and no new child row — and the `voided_*` columns stay
// reserved for a future workflow that defines those compensating effects in its
// own migration.
//
// The first draft of 011 copied migration 001's `sales` carve-out, which allows
// `posted → voided` as long as a short list of columns is unchanged. On a credit
// memo that left two holes: raw SQL could void a memo with no compensation at
// all, and could rewrite every header column the list omitted (the shift, the
// cashier, the locked rate, the reason) on the way through. INSERT was also
// unguarded on both child tables, so a line or a refund leg could be added to a
// document that had already posted.

/// Post a one-line, fully-restocked, cash-refunded return; hand back its id.
async fn posted_memo(db: &TempDb) -> String {
    // FOUR sold, TWO returned — so the line still has quantity left on it, and
    // a smuggled child row is refused by the seal rather than incidentally by
    // `trg_credit_memo_lines_no_over_return`.
    let sale = sell_coffee_for_cash(db, 4).await;
    let item = sale_item_id(db, &sale, P_COFFEE).await;
    let payload = cash_return(db, &sale, &item, 2, 1_000).await;
    let memo_id = payload.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("the fixture return must post");
    memo_id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_credit_memo_rejects_a_new_line() {
    let db = shop().await;
    let memo_id = posted_memo(&db).await;
    // The memo's OWN sale line, which still has two of its four units
    // unreturned — so neither the over-return guard nor the wrong-sale guard
    // has anything to say, and only the seal can refuse this.
    let sale = db
        .scalar_string(&format!(
            "SELECT original_sale_id FROM sales_credit_memos WHERE id = '{memo_id}'"
        ))
        .await;
    let other_item = sale_item_id(&db, &sale, P_COFFEE).await;

    let err = db
        .try_exec(&format!(
            "INSERT INTO sales_credit_memo_lines (
               id, credit_memo_id, store_id, original_sale_item_id, product_id,
               product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
               quantity_base, quantity_in_uom,
               unit_price_excl_vat_cents, unit_price_incl_vat_cents,
               line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
               return_to_stock
             ) VALUES ('smuggled', '{memo_id}', '{STORE_ID}', '{other_item}', '{P_COFFEE}',
                       'Coffee 250g', '{VAT_STD_ID}', 1100, 1, 1, 450, 500, 450, 50, 500, 0)"
        ))
        .await
        .expect_err("a posted credit memo must not accept a new line");
    assert!(err.to_string().contains("posted credit memo"), "got: {err}");

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        1,
        "the memo still holds exactly the line it posted with"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_credit_memo_rejects_a_new_refund_leg() {
    let db = shop().await;
    let memo_id = posted_memo(&db).await;

    // An extra leg would make the refund exceed the credit memo — money out of
    // the drawer against a document that does not owe it.
    let err = db
        .try_exec(&format!(
            "INSERT INTO sales_credit_memo_refunds (
               id, credit_memo_id, store_id, method, currency,
               amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
             ) VALUES ('smuggled', '{memo_id}', '{STORE_ID}', 'cash_usd', 'USD', 500, 0, 500)"
        ))
        .await
        .expect_err("a posted credit memo must not accept a new refund leg");
    assert!(err.to_string().contains("posted credit memo"), "got: {err}");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_usd_cents_equivalent), 0)
               FROM sales_credit_memo_refunds WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        1_000,
        "the refund still equals the memo total exactly"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_credit_memos_children_cannot_be_rewritten_or_deleted() {
    let db = shop().await;
    let memo_id = posted_memo(&db).await;

    for (what, sql) in [
        (
            "rewrite a returned line's quantity",
            format!(
                "UPDATE sales_credit_memo_lines SET quantity_base = 99
                  WHERE credit_memo_id = '{memo_id}'"
            ),
        ),
        (
            "rewrite a returned line's money",
            format!(
                "UPDATE sales_credit_memo_lines SET line_total_incl_vat_cents = 1
                  WHERE credit_memo_id = '{memo_id}'"
            ),
        ),
        (
            "flip a returned line's restock flag",
            format!(
                "UPDATE sales_credit_memo_lines SET return_to_stock = 0
                  WHERE credit_memo_id = '{memo_id}'"
            ),
        ),
        (
            "delete a returned line",
            format!("DELETE FROM sales_credit_memo_lines WHERE credit_memo_id = '{memo_id}'"),
        ),
        (
            "rewrite a refund leg's amount",
            format!(
                "UPDATE sales_credit_memo_refunds SET amount_native_usd_cents = 1
                  WHERE credit_memo_id = '{memo_id}'"
            ),
        ),
        (
            "re-point a refund leg at another method",
            format!(
                "UPDATE sales_credit_memo_refunds SET method = 'card_usd'
                  WHERE credit_memo_id = '{memo_id}'"
            ),
        ),
        (
            "delete a refund leg",
            format!("DELETE FROM sales_credit_memo_refunds WHERE credit_memo_id = '{memo_id}'"),
        ),
    ] {
        assert!(
            db.try_exec(&sql).await.is_err(),
            "a posted credit memo must not let a writer {what}"
        );
    }

    // Everything is exactly as it posted.
    assert_eq!(memo_line_i64(&db, &memo_id, P_COFFEE, "quantity_base").await, 2);
    assert_eq!(memo_line_i64(&db, &memo_id, P_COFFEE, "return_to_stock").await, 1);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT method FROM sales_credit_memo_refunds WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        "cash_usd"
    );
    // And the restock movement is still append-only (migration 001).
    assert!(
        db.try_exec(&format!(
            "UPDATE inventory_movements SET quantity_delta = 99
              WHERE related_credit_memo_id = '{memo_id}'"
        ))
        .await
        .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_credit_memo_header_cannot_be_mutated_at_all() {
    let db = shop().await;
    let memo_id = posted_memo(&db).await;
    seed_closed_shift(&db, SHIFT_B, 0, 0).await;
    let other_sale = sell_coffee_for_cash(&db, 1).await;

    for (what, sql) in [
        // Money.
        (
            "rewrite the total",
            format!("UPDATE sales_credit_memos SET total_incl_vat_cents = 1 WHERE id = '{memo_id}'"),
        ),
        (
            "rewrite the reversed cost",
            format!("UPDATE sales_credit_memos SET cogs_reversed_cents = 0 WHERE id = '{memo_id}'"),
        ),
        (
            "rewrite the refund total",
            format!(
                "UPDATE sales_credit_memos SET refund_total_usd_cents = 1 WHERE id = '{memo_id}'"
            ),
        ),
        (
            "rewrite the reversed VAT",
            format!("UPDATE sales_credit_memos SET vat_total_cents = 0 WHERE id = '{memo_id}'"),
        ),
        // Audit attribution and monetary context — every one of these was
        // silently permitted by the first draft's void carve-out.
        (
            "re-point the memo at another shift",
            format!("UPDATE sales_credit_memos SET shift_id = '{SHIFT_B}' WHERE id = '{memo_id}'"),
        ),
        (
            "re-point the memo at another sale",
            format!(
                "UPDATE sales_credit_memos SET original_sale_id = '{other_sale}'
                  WHERE id = '{memo_id}'"
            ),
        ),
        (
            "rewrite the locked exchange rate",
            format!(
                "UPDATE sales_credit_memos SET exchange_rate_lbp_per_usd = 1 WHERE id = '{memo_id}'"
            ),
        ),
        (
            "rewrite the cashier",
            format!("UPDATE sales_credit_memos SET cashier_user_id = NULL WHERE id = '{memo_id}'"),
        ),
        (
            "rewrite the reason",
            format!(
                "UPDATE sales_credit_memos SET reason = 'something else' WHERE id = '{memo_id}'"
            ),
        ),
        (
            "rewrite the posting timestamp",
            format!(
                "UPDATE sales_credit_memos SET posted_at = '2020-01-01T00:00:00.000Z'
                  WHERE id = '{memo_id}'"
            ),
        ),
        (
            "renumber the memo",
            format!("UPDATE sales_credit_memos SET credit_memo_number = 99 WHERE id = '{memo_id}'"),
        ),
        (
            "delete the memo",
            format!("DELETE FROM sales_credit_memos WHERE id = '{memo_id}'"),
        ),
    ] {
        assert!(
            db.try_exec(&sql).await.is_err(),
            "a posted credit memo must not let a writer {what}"
        );
    }

    assert_eq!(memo_i64(&db, &memo_id, "total_incl_vat_cents").await, 1_000);
    assert_eq!(memo_i64(&db, &memo_id, "vat_total_cents").await, 100);
    assert_eq!(memo_i64(&db, &memo_id, "cogs_reversed_cents").await, 400);
    assert_eq!(memo_i64(&db, &memo_id, "credit_memo_number").await, 1);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT shift_id FROM sales_credit_memos WHERE id = '{memo_id}'"
        ))
        .await,
        SHIFT_ID
    );
}

/// The hole that mattered most. A posted memo could be marked `voided` by raw
/// SQL, and every read model then stops counting it — so the refund vanished
/// from the reports and from the drawer while the stock it restocked, the cost
/// it re-blended and the money it paid out all stayed exactly where they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_credit_memo_cannot_be_voided_by_raw_sql() {
    let db = shop().await;
    let memo_id = posted_memo(&db).await;
    let qoh_before = quantity_on_hand(&db, P_COFFEE).await;
    let avg_before = avg_cost_excl_microcents(&db, P_COFFEE).await;

    // Even the "well-behaved" void the first draft allowed: the status and the
    // void columns only, with every listed field untouched.
    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memos
                SET status = 'voided',
                    voided_at = '2026-04-01T10:00:00.000Z',
                    voided_by_user_id = '{USER_ID}',
                    void_reason = 'changed our mind'
              WHERE id = '{memo_id}'"
        ))
        .await
        .expect_err("WP-06 has no void workflow, so nothing may reach 'voided'");
    assert!(err.to_string().contains("posted credit memo"), "got: {err}");

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT status FROM sales_credit_memos WHERE id = '{memo_id}'"
        ))
        .await,
        "posted",
        "the memo is still a live document, so every read model still counts it"
    );
    assert_eq!(
        quantity_on_hand(&db, P_COFFEE).await,
        qoh_before,
        "and the stock it restocked is still on the shelf"
    );
    assert_eq!(avg_cost_excl_microcents(&db, P_COFFEE).await, avg_before);
}

/// The seal must not catch the posting command on its way through. A memo is
/// built as a DRAFT — header, lines, movements, the line→movement link, refund
/// legs — and only then promoted, which is the one UPDATE that has to work.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn draft_construction_still_works_before_a_memo_is_posted() {
    let db = shop().await;
    // Two lines and two refund legs, so every write the command makes is
    // exercised: two inserts into each child table, a line UPDATE to link the
    // restock movement, and the draft→posted promotion.
    let lines = vec![coffee(2), bread(2)];
    let total = lines_total(&lines);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let coffee_item = sale_item_id(&db, &sale, P_COFFEE).await;
    let bread_item = sale_item_id(&db, &sale, P_BREAD).await;

    let payload = credit_memo_payload(
        &sale,
        vec![
            return_line(&coffee_item).qty(2).build(),
            return_line(&bread_item).qty(1).restock(false).build(),
        ],
        vec![refund_cash_usd(800), refund_cash_usd(500)],
    );
    let memo_id = payload.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("a two-line, two-leg return must still post");

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        2,
        "both lines were written while the memo was still a draft"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_refunds WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        2,
        "both refund legs too"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines
              WHERE credit_memo_id = '{memo_id}' AND related_movement_id IS NOT NULL"
        ))
        .await,
        1,
        "the line→movement link UPDATE ran before the document was sealed"
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT status FROM sales_credit_memos WHERE id = '{memo_id}'"
        ))
        .await,
        "posted"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(quantity_on_hand(&db, P_BREAD).await, 48, "the write-off did not restock");
}

/// A hand-built DRAFT still accepts children — which is what the seal has to
/// leave alone, and what `trg_credit_memo_lines_no_over_return` relies on to
/// count a memo's own in-flight lines. Once promoted, it is sealed like any
/// other posted memo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_memo_takes_children_and_is_sealed_the_moment_it_is_promoted() {
    let db = shop().await;
    let sale = sell_coffee_for_cash(&db, 2).await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    db.exec(&format!(
        "INSERT INTO sales_credit_memos (
           id, store_id, original_sale_id, credit_memo_number, shift_id,
           exchange_rate_lbp_per_usd, status
         ) VALUES ('draft-memo', '{STORE_ID}', '{sale}', 900, '{SHIFT_ID}',
                   {RATE_LBP_PER_USD}, 'draft')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sales_credit_memo_lines (
           id, credit_memo_id, store_id, original_sale_item_id, product_id,
           product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
           quantity_base, quantity_in_uom,
           unit_price_excl_vat_cents, unit_price_incl_vat_cents,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
           return_to_stock
         ) VALUES ('draft-line', 'draft-memo', '{STORE_ID}', '{item}', '{P_COFFEE}',
                   'Coffee 250g', '{VAT_STD_ID}', 1100, 1, 1, 450, 500, 450, 50, 500, 0)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sales_credit_memo_refunds (
           id, credit_memo_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
         ) VALUES ('draft-refund', 'draft-memo', '{STORE_ID}', 'cash_usd', 'USD', 500, 0, 500)"
    ))
    .await;
    // A draft may also still be corrected, which is the whole point of the
    // draft stage: nothing has been handed to a customer yet.
    db.exec("UPDATE sales_credit_memo_lines SET quantity_base = 2, quantity_in_uom = 2 WHERE id = 'draft-line'")
        .await;

    // Promotion is the one UPDATE a memo may ever take.
    db.exec(
        "UPDATE sales_credit_memos SET status = 'posted', posted_at = '2026-04-01T10:00:00.000Z'
          WHERE id = 'draft-memo'",
    )
    .await;

    // After which it is as sealed as anything the command wrote.
    for sql in [
        "UPDATE sales_credit_memos SET total_incl_vat_cents = 1 WHERE id = 'draft-memo'",
        "UPDATE sales_credit_memo_lines SET quantity_base = 1 WHERE id = 'draft-line'",
        "DELETE FROM sales_credit_memo_refunds WHERE id = 'draft-refund'",
    ] {
        assert!(
            db.try_exec(sql).await.is_err(),
            "once promoted, a draft is immutable: {sql}"
        );
    }
    assert!(
        db.try_exec(&format!(
            "INSERT INTO sales_credit_memo_refunds (
               id, credit_memo_id, store_id, method, currency,
               amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
             ) VALUES ('late', 'draft-memo', '{STORE_ID}', 'cash_usd', 'USD', 1, 0, 1)"
        ))
        .await
        .is_err(),
        "and takes no further children"
    );
}

// ============================================================================
// Child reparenting
// ============================================================================
//
// THE HOLE THIS BLOCK EXISTS FOR. `credit_memo_id` is an ordinary updatable
// column, so an UPDATE can MOVE a child between documents. The first sealing
// pass guarded a child UPDATE on `OLD.credit_memo_id` alone, which left the
// seal open from the other side:
//
//   1. INSERT a line under a DRAFT memo — allowed, drafts take children
//   2. UPDATE that line's `credit_memo_id` to point at a POSTED memo
//   3. the old parent is a draft, so a one-sided guard waves it through
//
// The posted document then grows a line it did not post with — crediting
// quantity against the original receipt — with no INSERT into it and without
// touching any row that already belonged to it. The refund table had the same
// hole, where the smuggled leg pays out money the memo does not owe.
//
// The rule is symmetric: a child may never be updated if doing so would mutate
// a POSTED document, whether that document is the source or the destination.

/// A draft memo against `sale`, holding one line and one refund leg, both
/// built the way a draft legitimately is. Returns `(memo_id, line_id,
/// refund_id)`.
async fn draft_memo_with_children(
    db: &TempDb,
    tag: &str,
    sale: &str,
    sale_item: &str,
    number: i64,
) -> (String, String, String) {
    let memo = format!("draft-{tag}");
    let line = format!("draft-line-{tag}");
    let refund = format!("draft-refund-{tag}");

    db.exec(&format!(
        "INSERT INTO sales_credit_memos (
           id, store_id, original_sale_id, credit_memo_number, shift_id,
           exchange_rate_lbp_per_usd, status
         ) VALUES ('{memo}', '{STORE_ID}', '{sale}', {number}, '{SHIFT_ID}',
                   {RATE_LBP_PER_USD}, 'draft')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sales_credit_memo_lines (
           id, credit_memo_id, store_id, original_sale_item_id, product_id,
           product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
           quantity_base, quantity_in_uom,
           unit_price_excl_vat_cents, unit_price_incl_vat_cents,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
           return_to_stock
         ) VALUES ('{line}', '{memo}', '{STORE_ID}', '{sale_item}', '{P_COFFEE}',
                   'Coffee 250g', '{VAT_STD_ID}', 1100, 1, 1, 450, 500, 450, 50, 500, 0)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sales_credit_memo_refunds (
           id, credit_memo_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
         ) VALUES ('{refund}', '{memo}', '{STORE_ID}', 'cash_usd', 'USD', 500, 0, 500)"
    ))
    .await;

    (memo, line, refund)
}

/// 1 — a draft LINE cannot be re-pointed at a memo that has already posted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_line_cannot_be_reparented_into_a_posted_memo() {
    let db = shop().await;
    let posted = posted_memo(&db).await;
    let sale = db
        .scalar_string(&format!(
            "SELECT original_sale_id FROM sales_credit_memos WHERE id = '{posted}'"
        ))
        .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    // The same receipt line the posted memo drew on, which still has two of its
    // four units unreturned — so the over-return and wrong-sale guards have
    // nothing to say, and only the seal can refuse the move.
    let (_draft, line, _refund) = draft_memo_with_children(&db, "a", &sale, &item, 901).await;

    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memo_lines SET credit_memo_id = '{posted}' WHERE id = '{line}'"
        ))
        .await
        .expect_err("a posted memo must not grow a line by reparenting");
    assert!(err.to_string().contains("cannot be moved to another"), "got: {err}");

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{posted}'"
        ))
        .await,
        1,
        "the posted memo still holds exactly the line it posted with"
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT credit_memo_id FROM sales_credit_memo_lines WHERE id = '{line}'"
        ))
        .await,
        "draft-a",
        "and the line is still where it was"
    );
}

/// 2 — a draft REFUND LEG cannot be re-pointed at a posted memo. This is the
/// one that pays out money: the posted memo's refund legs would then exceed its
/// own total, which is the invariant `post_credit_memo` enforces to the cent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_refund_leg_cannot_be_reparented_into_a_posted_memo() {
    let db = shop().await;
    let posted = posted_memo(&db).await;
    let sale = db
        .scalar_string(&format!(
            "SELECT original_sale_id FROM sales_credit_memos WHERE id = '{posted}'"
        ))
        .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    let (_draft, _line, refund) = draft_memo_with_children(&db, "b", &sale, &item, 902).await;

    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memo_refunds SET credit_memo_id = '{posted}' WHERE id = '{refund}'"
        ))
        .await
        .expect_err("a posted memo must not grow a refund leg by reparenting");
    assert!(err.to_string().contains("cannot be moved to another"), "got: {err}");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_usd_cents_equivalent), 0)
               FROM sales_credit_memo_refunds WHERE credit_memo_id = '{posted}'"
        ))
        .await,
        1_000,
        "the posted memo's refund still equals its total exactly"
    );
}

/// 3 and 4 — the other direction. A child that BELONGS to a posted memo cannot
/// be moved out of it either: that would silently reduce a settled document.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_memos_children_cannot_be_reparented_out_of_it() {
    let db = shop().await;
    let posted = posted_memo(&db).await;
    let sale = db
        .scalar_string(&format!(
            "SELECT original_sale_id FROM sales_credit_memos WHERE id = '{posted}'"
        ))
        .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;
    let (draft, _line, _refund) = draft_memo_with_children(&db, "c", &sale, &item, 903).await;

    let posted_line = db
        .scalar_string(&format!(
            "SELECT id FROM sales_credit_memo_lines WHERE credit_memo_id = '{posted}'"
        ))
        .await;
    let posted_refund = db
        .scalar_string(&format!(
            "SELECT id FROM sales_credit_memo_refunds WHERE credit_memo_id = '{posted}'"
        ))
        .await;

    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memo_lines SET credit_memo_id = '{draft}'
              WHERE id = '{posted_line}'"
        ))
        .await
        .expect_err("a posted memo must not lose a line by reparenting");
    assert!(err.to_string().contains("cannot be moved to another"), "got: {err}");

    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memo_refunds SET credit_memo_id = '{draft}'
              WHERE id = '{posted_refund}'"
        ))
        .await
        .expect_err("a posted memo must not lose a refund leg by reparenting");
    assert!(err.to_string().contains("cannot be moved to another"), "got: {err}");

    // The posted document is untouched, and so is the draft.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{posted}'"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_refunds WHERE credit_memo_id = '{posted}'"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{draft}'"
        ))
        .await,
        1,
        "the draft gained nothing"
    );
}

/// 5 and 6 — a child NEVER changes parent, draft or not.
///
/// WP-06 permitted draft → draft reparenting, on the argument that a draft is
/// invisible to every read model. That argument was wrong, and this test is the
/// inversion of the one that asserted it.
///
/// The two rules that give a memo line its meaning —
/// `trg_credit_memo_lines_no_over_return` proving the line belongs to an item
/// of the memo's OWN original sale, and that the quantity is still available —
/// are checked on INSERT ONLY. So a line could be created under draft memo A,
/// attached to the sale it really belongs to, and then moved under draft memo
/// B, attached to a different sale entirely. Both inserts were valid; neither
/// guard re-ran on the move. Promote B and it is a posted credit memo crediting
/// a receipt that never sold the goods.
///
/// Production never reparents anything, so forbidding it outright gives nothing
/// up and is cheaper than re-running those checks on UPDATE.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credit_memo_child_can_never_change_parent() {
    let db = shop().await;
    let sale_a = sell_coffee_for_cash(&db, 4).await;
    // A SECOND sale, so the move would smuggle the line onto a receipt that
    // never sold the goods — the shape the INSERT-only guards cannot see.
    let sale_b = sell_coffee_for_cash(&db, 4).await;
    let item_a = sale_item_id(&db, &sale_a, P_COFFEE).await;
    let item_b = sale_item_id(&db, &sale_b, P_COFFEE).await;

    let (first, line, refund) = draft_memo_with_children(&db, "d", &sale_a, &item_a, 904).await;
    let (second, _, _) = draft_memo_with_children(&db, "e", &sale_b, &item_b, 905).await;

    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memo_lines SET credit_memo_id = '{second}' WHERE id = '{line}'"
        ))
        .await
        .expect_err("a line cannot be moved to another memo, draft or not");
    assert!(err.to_string().contains("cannot be moved to another"), "got: {err}");

    let err = db
        .try_exec(&format!(
            "UPDATE sales_credit_memo_refunds SET credit_memo_id = '{second}' WHERE id = '{refund}'"
        ))
        .await
        .expect_err("nor can a refund leg");
    assert!(err.to_string().contains("cannot be moved to another"), "got: {err}");

    // Both children are exactly where they were created.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{first}'"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{second}'"
        ))
        .await,
        1,
        "the destination draft gained nothing"
    );

    // And the ordinary in-draft UPDATE the posting command itself performs —
    // SAME parent, a different column — is untouched by the rule.
    db.exec(&format!(
        "UPDATE sales_credit_memo_lines SET quantity_in_uom = 1 WHERE id = '{line}'"
    ))
    .await;
    db.exec(&format!(
        "UPDATE sales_credit_memo_lines SET related_movement_id = NULL WHERE id = '{line}'"
    ))
    .await;
    // Even restating the parent to its own current value is fine: the trigger
    // fires on a CHANGE of parent, not on the column appearing in a SET list.
    db.exec(&format!(
        "UPDATE sales_credit_memo_lines SET credit_memo_id = '{first}' WHERE id = '{line}'"
    ))
    .await;
}

/// 7 — the one UPDATE production actually performs still works: the posting
/// command links each restocking line to its movement while the memo is a
/// draft, with `credit_memo_id` unchanged. Proved through the real command,
/// end to end, with a restock so the link UPDATE is reached.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_symmetric_rule_does_not_disturb_normal_posting() {
    let db = shop().await;
    let lines = vec![coffee(2), bread(2)];
    let total = lines_total(&lines);
    let sale = post_sale_ok(&db, sale_payload(lines, vec![cash_usd(total)])).await;
    let coffee_item = sale_item_id(&db, &sale, P_COFFEE).await;
    let bread_item = sale_item_id(&db, &sale, P_BREAD).await;

    let payload = credit_memo_payload(
        &sale,
        vec![
            return_line(&coffee_item).qty(2).build(),
            return_line(&bread_item).qty(2).build(),
        ],
        vec![refund_cash_usd(1_000), refund_cash_usd(600)],
    );
    let memo_id = payload.credit_memo_id.clone();
    let result = post_credit_memo_with_pool(db.pool(), payload)
        .await
        .expect("normal posting must be untouched by the symmetric rule");

    assert_eq!(result.movement_ids.len(), 2, "both lines restocked");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines
              WHERE credit_memo_id = '{memo_id}' AND related_movement_id IS NOT NULL"
        ))
        .await,
        2,
        "the link UPDATE ran for both lines while the memo was still a draft"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_refunds WHERE credit_memo_id = '{memo_id}'"
        ))
        .await,
        2
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(quantity_on_hand(&db, P_BREAD).await, 50);
}

/// 8, 9 and 10 restated against the symmetric trigger, so the stronger WHEN
/// clause is confirmed not to have loosened the three rules it replaced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_symmetric_rule_still_refuses_insert_update_and_delete() {
    let db = shop().await;
    let posted = posted_memo(&db).await;
    let sale = db
        .scalar_string(&format!(
            "SELECT original_sale_id FROM sales_credit_memos WHERE id = '{posted}'"
        ))
        .await;
    let item = sale_item_id(&db, &sale, P_COFFEE).await;

    // 8 — INSERT straight into the posted memo.
    assert!(
        db.try_exec(&format!(
            "INSERT INTO sales_credit_memo_lines (
               id, credit_memo_id, store_id, original_sale_item_id, product_id,
               product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
               quantity_base, quantity_in_uom,
               unit_price_excl_vat_cents, unit_price_incl_vat_cents,
               line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
               return_to_stock
             ) VALUES ('direct-line', '{posted}', '{STORE_ID}', '{item}', '{P_COFFEE}',
                       'Coffee 250g', '{VAT_STD_ID}', 1100, 1, 1, 450, 500, 450, 50, 500, 0)"
        ))
        .await
        .is_err(),
        "a posted memo still takes no new line"
    );
    assert!(
        db.try_exec(&format!(
            "INSERT INTO sales_credit_memo_refunds (
               id, credit_memo_id, store_id, method, currency,
               amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
             ) VALUES ('direct-refund', '{posted}', '{STORE_ID}', 'cash_usd', 'USD', 1, 0, 1)"
        ))
        .await
        .is_err(),
        "a posted memo still takes no new refund leg"
    );

    // 9 — UPDATE of a column other than the parent.
    assert!(
        db.try_exec(&format!(
            "UPDATE sales_credit_memo_lines SET quantity_base = 99
              WHERE credit_memo_id = '{posted}'"
        ))
        .await
        .is_err(),
        "a posted memo's line still cannot be rewritten"
    );
    assert!(
        db.try_exec(&format!(
            "UPDATE sales_credit_memo_refunds SET amount_native_usd_cents = 1
              WHERE credit_memo_id = '{posted}'"
        ))
        .await
        .is_err(),
        "a posted memo's refund leg still cannot be rewritten"
    );

    // 10 — DELETE.
    assert!(
        db.try_exec(&format!(
            "DELETE FROM sales_credit_memo_lines WHERE credit_memo_id = '{posted}'"
        ))
        .await
        .is_err(),
        "a posted memo's line still cannot be deleted"
    );
    assert!(
        db.try_exec(&format!(
            "DELETE FROM sales_credit_memo_refunds WHERE credit_memo_id = '{posted}'"
        ))
        .await
        .is_err(),
        "a posted memo's refund leg still cannot be deleted"
    );

    // The document is exactly as it posted, in every column that decides money.
    assert_eq!(memo_i64(&db, &posted, "total_incl_vat_cents").await, 1_000);
    assert_eq!(memo_i64(&db, &posted, "refund_total_usd_cents").await, 1_000);
    assert_eq!(memo_line_i64(&db, &posted, P_COFFEE, "quantity_base").await, 2);
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_lines WHERE credit_memo_id = '{posted}'"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales_credit_memo_refunds WHERE credit_memo_id = '{posted}'"
        ))
        .await,
        1
    );
}
