// Layer C — manual standard cost against a temporary database (WP-B1).
//
// WHAT THESE TESTS ARE ACTUALLY DEFENDING
//
// Greaz has reported a 100% margin on every prepared menu item since the day
// it shipped — not because the margin was good, but because the only writer of
// `products.avg_cost_*` is a purchase and a burger is not purchased. WP-B1
// lets the owner type a plate cost. Everything that can go wrong with that is
// a figure quietly becoming a different figure, so every test here asserts on
// PERSISTED rows: the snapshot on the posted line, the provenance beside it,
// the absence of an inventory movement, and the product row afterwards.
//
// The four rules the suite exists to pin:
//
//   1. The cost is resolved from the DATABASE at post time, never from the
//      request. There is no field for it on the wire and no test may add one.
//   2. NULL is not zero. A missing cost stops the till; a stated zero posts.
//   3. A posted snapshot never moves, whatever happens to the product after.
//   4. Manual cost never touches stock, cost pools or movements — which is
//      exactly why it is restricted to non-stock items in this milestone.

use crate::catalog::{
    save_product_with_pool, SaveProductPayload, MANUAL_COST_NEEDS_SERVICE, MANUAL_COST_REQUIRED,
    RECIPE_COSTING_NEEDS_ACTIVE_RECIPE, RECIPE_COSTING_NEEDS_SERVICE,
};
use crate::cost::cents_to_microcents;
use crate::posting::{post_credit_memo_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_BURGER: &str = "00000000-0000-0000-0000-0000000000b1";
const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_SAUCE: &str = "00000000-0000-0000-0000-0000000000b2";

// ============================================================================
// Fixtures
// ============================================================================

/// A shop that can sell, holding:
///
///   * Burger — a SERVICE (no stock tracking), sold at $11.10 incl VAT (11%),
///     i.e. $10.00 net. The manual-cost subject.
///   * Coffee — STOCKED, 100 on hand at $2.00 excl / $2.22 incl, sold at
///     $5.00 incl. The purchase-valuation control.
async fn shop() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            ..ProductSpec::stocked(P_BURGER, "SKU-B1", "Greaz Burger")
        },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")
        },
    )
    .await;
    db
}

/// One burger at $11.10 incl VAT, paid in cash.
fn burger_sale() -> crate::posting::PostSalePayload {
    sale_payload(
        vec![SaleLineBuilder::new(P_BURGER, "Greaz Burger")
            .service(true)
            .qty(1)
            .unit_incl(1110)
            .build()],
        vec![cash_usd(1110)],
    )
}

async fn line_cogs(db: &TempDb, sale_id: &str) -> (i64, i64, i64, String) {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT unit_cogs_excl_vat_microcents, unit_cogs_excl_vat_cents,
                line_cogs_excl_vat_cents, COALESCE(cogs_source, 'NULL') AS src
           FROM sale_items WHERE sale_id = ?",
    )
    .bind(sale_id)
    .fetch_one(db.pool())
    .await
    .unwrap_or_else(|e| panic!("read sale line of {sale_id}: {e}"));
    (
        row.try_get("unit_cogs_excl_vat_microcents").unwrap(),
        row.try_get("unit_cogs_excl_vat_cents").unwrap(),
        row.try_get("line_cogs_excl_vat_cents").unwrap(),
        row.try_get("src").unwrap(),
    )
}

// ============================================================================
// 1. A configured manual cost is what the line is costed at
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_cost_is_snapshotted_on_the_posted_line() {
    let db = shop().await;
    // $1.85 per burger, exclusive of VAT.
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, rate_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 185_000_000, "the typed rate, in microcents");
    assert_eq!(rate_cents, 185, "the rounded display mirror beside it");
    assert_eq!(line_cents, 185, "one unit, so the line COGS is the rate");
    assert_eq!(source, "standard", "and the provenance says where it came from");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        185,
        "the header COGS is the sum of the lines, as always"
    );

    // $10.00 net revenue against $1.85 of cost. Before WP-B1 this line cost
    // nothing and reported a 100% margin.
    let subtotal = db
        .scalar_i64(&format!(
            "SELECT subtotal_excl_vat_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await;
    assert_eq!(subtotal - 185, 815, "an $8.15 gross profit, not $10.00");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_cost_moves_no_stock_and_writes_no_movement() {
    // The whole reason manual cost is safe for a non-stock item: there is no
    // second figure for the typed rate to contradict. Asserted, not assumed.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert!(result.movement_ids.is_empty(), "no movement for a service line");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        0
    );
    assert_eq!(quantity_on_hand(&db, P_BURGER).await, 0, "stock untouched");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        0,
        "and the cost POOL is untouched: a manual cost is not a purchase"
    );
}

// ============================================================================
// 2. Missing versus intentional zero
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_manual_cost_refuses_the_sale_by_name() {
    // The deliberate, debatable choice: mis-configuring a product stops the
    // till. The alternative — posting at zero — is how a restaurant ends up
    // with a year of 100% margins and no way to find out when it started.
    let db = shop().await;
    forge_manual_cost_without_figure(&db, P_BURGER).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    let err = post_sale_with_pool(db.pool(), payload).await.unwrap_err();

    assert!(
        err.contains("Greaz Burger") && err.contains("Manual Cost"),
        "the refusal must name the product and the setting: {err}"
    );
    // Nothing persists, and in particular no receipt number is consumed: the
    // check runs inside the transaction and before the sequence.
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sales WHERE id='{sale_id}'")).await,
        0
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'")
            .await,
        "1",
        "a refused sale costs the receipt sequence nothing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_intentional_zero_posts_and_is_distinguishable_from_a_missing_cost() {
    // Both print "$0.00". They are not the same claim, and `cogs_source` is
    // the column that says so: a stated zero is an assertion by the owner, a
    // missing one would not have posted at all.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, 0).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 0);
    assert_eq!(line_cents, 0);
    assert_eq!(
        source, "standard",
        "a deliberate zero is a STANDARD cost, not an absence of one"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_service_on_purchase_valuation_is_recorded_as_uncosted() {
    // Today's silent zero, finally named. This is the row the cost-coverage
    // panel counts as a gap, and the reason a gross-profit figure needs that
    // panel beside it.
    let db = shop().await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 0);
    assert_eq!(line_cents, 0);
    assert_eq!(source, "uncosted");
}

// ============================================================================
// 3. VAT, and precision
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_manual_cost_is_net_of_vat_whatever_the_price_mode_is() {
    // The typed figure is EXCLUSIVE of VAT and is used as stated. No VAT is
    // added to it, none is stripped from it, and the product's own
    // `vat_pricing_mode` — which governs the PRICE — does not touch it. A
    // $1.85 cost against a $11.10 gross price is $1.85, not $1.67 and not
    // $2.05.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, _, _) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 185_000_000);

    // And the same item priced VAT-exclusively costs the same.
    db.exec(&format!(
        "UPDATE products SET vat_pricing_mode='exclusive' WHERE id='{P_BURGER}'"
    ))
    .await;
    let second = burger_sale();
    let second_id = second.sale_id.clone();
    post_sale_with_pool(db.pool(), second).await.unwrap();
    let (rate_two, _, _, _) = line_cogs_of(&db, &second_id).await;
    assert_eq!(rate_two, 185_000_000, "the cost is net, and the mode is about price");
}

async fn line_cogs_of(db: &TempDb, sale_id: &str) -> (i64, i64, i64, String) {
    line_cogs(db, sale_id).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sub_cent_manual_cost_is_extended_before_it_is_rounded() {
    // The GP-A03 rule, applied to a typed cost: the precise RATE times the
    // base quantity, rounded ONCE. A sauce portion costing $0.0025 is
    // $0.0025 — rounding the rate first would cost 400 portions nothing.
    let db = shop().await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            ..ProductSpec::stocked(P_SAUCE, "SKU-B2", "Sauce portion")
        },
    )
    .await;
    // 250,000 microcents = $0.0025 per portion.
    seed_manual_cost(&db, P_SAUCE, 250_000).await;

    let payload = sale_payload(
        vec![SaleLineBuilder::new(P_SAUCE, "Sauce portion")
            .service(true)
            .qty(400)
            .unit_incl(5)
            .build()],
        vec![cash_usd(2000)],
    );
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, rate_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 250_000, "the rate survives at full precision");
    assert_eq!(rate_cents, 0, "and its cents mirror is legitimately zero");
    assert_eq!(
        line_cents, 100,
        "400 x $0.0025 = $1.00 — rounding the rate first would have given $0.00"
    );
    assert_eq!(source, "standard");
}

// ============================================================================
// 4. A posted snapshot never moves
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_the_manual_cost_afterwards_does_not_restate_a_posted_sale() {
    // Forward-only, which is already true of every cost input in this system:
    // change a product's average today and yesterday's receipts keep their
    // COGS. A typed cost is no different, and `sale_items` is sealed, so the
    // alternative does not exist.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    // Beef goes up, and so does the stated cost.
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(260).unwrap()).await;

    let (rate_mc, rate_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 185_000_000, "yesterday's burger still cost $1.85");
    assert_eq!(rate_cents, 185);
    assert_eq!(line_cents, 185);
    assert_eq!(source, "standard");

    // The NEXT sale gets the new figure. Both facts matter: the first is that
    // history stands, the second is that the change took effect at all.
    let next = burger_sale();
    let next_id = next.sale_id.clone();
    post_sale_with_pool(db.pool(), next).await.unwrap();
    let (next_rate, _, next_line, _) = line_cogs_of(&db, &next_id).await;
    assert_eq!(next_rate, 260_000_000);
    assert_eq!(next_line, 260);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_a_product_back_to_purchase_valuation_does_not_restate_history() {
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    db.exec(&format!(
        "UPDATE products SET costing_method='purchase_average' WHERE id='{P_BURGER}'"
    ))
    .await;

    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 185_000_000);
    assert_eq!(
        source, "standard",
        "the line still records HOW it was costed, not how the product is configured today"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_lines_cost_snapshot_cannot_be_edited_at_all() {
    // Migration 012's seal, re-asserted for the two columns WP-B1 writes.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;
    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    for column in [
        "unit_cogs_excl_vat_microcents = 999",
        "cogs_source = 'purchase_average'",
    ] {
        let err = db
            .try_exec(&format!(
                "UPDATE sale_items SET {column} WHERE sale_id='{sale_id}'"
            ))
            .await
            .expect_err("a posted sale line takes no UPDATE");
        assert!(
            err.to_string().to_lowercase().contains("posted"),
            "refusal should name the seal: {err}"
        );
    }
}

// ============================================================================
// 5. Returns
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_return_of_a_manual_cost_line_restocks_nothing_and_reverses_no_cost() {
    // The existing rule, unchanged and deliberately so: whether a line may be
    // restocked is decided by whether the SALE produced an inventory movement.
    // A manual-costed line is a non-stock item, produced none, and so reverses
    // no cost — the margin on food already made and discarded is lost, which
    // is the truth about it. No ingredient movement is invented in its place.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();
    let sale_item_id = db
        .scalar_string(&format!(
            "SELECT id FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await;

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&sale_item_id).qty(1).restock(false).build()],
        vec![refund_cash_usd(1110)],
    );
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_reversed_cents FROM sales_credit_memos WHERE id='{memo_id}'"
        ))
        .await,
        0,
        "a write-off of food already prepared reverses no cost"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_credit_memo_id='{memo_id}'"
        ))
        .await,
        0,
        "and moves no stock — there is none to move"
    );
    assert_eq!(quantity_on_hand(&db, P_BURGER).await, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        0,
        "and does not blend a typed cost into a purchase cost pool"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restocking_return_of_a_manual_cost_line_is_refused() {
    // Asking to put a burger back on the shelf is asking for an inventory
    // movement against a product that has no stock model. The existing guard
    // refuses it; WP-B1 adds nothing and must not weaken it.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;
    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();
    let sale_item_id = db
        .scalar_string(&format!(
            "SELECT id FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await;

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&sale_item_id).qty(1).restock(true).build()],
        vec![refund_cash_usd(1110)],
    );
    let err = post_credit_memo_with_pool(db.pool(), memo)
        .await
        .unwrap_err();
    assert!(
        !err.is_empty(),
        "a non-stock line cannot be restocked: {err}"
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM sales_credit_memos").await, 0);
}

// ============================================================================
// 6. Repeated and recovered posting
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_a_manual_cost_sale_reconciles_to_the_one_receipt() {
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    let first = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();
    let second = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();

    assert_eq!(first.receipt_number, second.receipt_number, "one receipt");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        1,
        "and one line: a retry costs nothing twice"
    );
    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 185_000_000);
    assert_eq!(source, "standard");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovered_replay_still_reconciles_after_the_costing_changed() {
    // The ordering WP-04 established: idempotency resolves BEFORE the lines
    // are re-resolved against the catalogue. So a till that lost the answer
    // and re-sent it still gets its own receipt back even though the product
    // has since been reconfigured — and in particular even though the new
    // configuration would REFUSE a fresh sale.
    let db = shop().await;
    seed_manual_cost(&db, P_BURGER, cents_to_microcents(185).unwrap()).await;

    let payload = burger_sale();
    let sale_id = payload.sale_id.clone();
    let first = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();

    // The owner clears the cost — reachable only by a direct write, which is
    // what makes it the right adversarial case for a replay.
    forge_manual_cost_without_figure(&db, P_BURGER).await;

    let replay = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();
    assert_eq!(first.receipt_number, replay.receipt_number);

    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 185_000_000, "the original snapshot, untouched");
    assert_eq!(source, "standard");

    // And a NEW sale of the same product is refused, because the product is
    // now mis-configured. The replay is not a licence to post afresh.
    let fresh = burger_sale();
    assert!(post_sale_with_pool(db.pool(), fresh).await.is_err());
}

// ============================================================================
// 7. Purchased-stock regression
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stocked_product_still_costs_from_its_weighted_average() {
    // The regression that matters most: WP-B1 must change nothing for the
    // products Greaz could already value.
    let db = shop().await;

    let payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
            .qty(3)
            .unit_incl(500)
            .build()],
        vec![cash_usd(1500)],
    );
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, rate_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 200_000_000, "$2.00 of weighted average, as before");
    assert_eq!(rate_cents, 200);
    assert_eq!(line_cents, 600);
    assert_eq!(source, "purchase_average");

    assert_eq!(result.movement_ids.len(), 1, "and it still moves stock");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 97);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements
              WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        200_000_000,
        "the movement carries the same rate the line does — one cost, two rows"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sale_level_cogs_method_still_applies_to_purchase_valued_products() {
    // `sales.cogs_method` stays a SALE-level setting and keeps governing
    // purchase-valued products. WP-B1 only decided that it is consulted
    // SECOND, after the product's own method.
    let db = shop().await;
    // A purchase at $3.00/unit, so last-purchase and weighted average differ.
    db.exec(&format!(
        "INSERT INTO inventory_movements
           (id, store_id, product_id, movement_type, quantity_delta,
            unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
            unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents, posted_at)
         VALUES ('{}', '{STORE_ID}', '{P_COFFEE}', 'purchase', 10,
                 300, 333, 300000000, 333000000, '2026-10-24T10:00:00.000Z')",
        uuid::Uuid::new_v4()
    ))
    .await;

    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
            .qty(1)
            .unit_incl(500)
            .build()],
        vec![cash_usd(500)],
    );
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 300_000_000);
    assert_eq!(line_cents, 300);
    assert_eq!(source, "last_purchase");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_last_purchase_sale_with_no_purchase_history_records_the_average_it_fell_back_to() {
    // Provenance records what ACTUALLY supplied the rate. Recording
    // `last_purchase` on a line that fell back to the average would be a lie
    // in the one column that exists to stop exactly that.
    let db = shop().await;
    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
            .qty(1)
            .unit_incl(500)
            .build()],
        vec![cash_usd(500)],
    );
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 200_000_000);
    assert_eq!(source, "purchase_average");
}

// ============================================================================
// 7b. An UNDOCUMENTED zero is not a purchase average (WP-B1 P1-A)
//
// A zero weighted average is two different facts wearing one figure, and the
// first cut of WP-B1 recorded both as `purchase_average`:
//
//   * stock received at a stated cost of nothing — a free case, a sample, an
//     opening count valued at zero — whose $0.00 COGS is a documented answer;
//   * a product that has never been purchased at all, whose $0.00 is the
//     absence of an answer.
//
// The coverage panel reads `cogs_source` as "this line's cost is an answer", so
// the second one was counted as verified costed revenue and printed a 100%
// margin that nothing supported. The money is identical either way; what these
// tests pin is the CLAIM.
// ============================================================================

/// A stocked product with no `purchase` or `opening` movement anywhere.
async fn never_purchased(db: &TempDb) {
    seed_product(
        db,
        &ProductSpec {
            quantity_on_hand: 50,
            ..ProductSpec::stocked(P_SAUCE, "SKU-B2", "Sauce portion")
        },
    )
    .await;
}

fn sauce_sale() -> crate::posting::PostSalePayload {
    sale_payload(
        vec![SaleLineBuilder::new(P_SAUCE, "Sauce portion")
            .qty(2)
            .unit_incl(111)
            .build()],
        vec![cash_usd(222)],
    )
}

/// Add a receipt that STATES a cost — the document the probe looks for.
async fn receipt_movement(db: &TempDb, movement_type: &str, rate_mc: i64) {
    db.exec(&format!(
        "INSERT INTO inventory_movements
           (id, store_id, product_id, movement_type, quantity_delta,
            unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
            unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents, posted_at)
         VALUES ('{}', '{STORE_ID}', '{P_SAUCE}', '{movement_type}', 50,
                 0, 0, {rate_mc}, {rate_mc}, '2026-10-24T09:00:00.000Z')",
        uuid::Uuid::new_v4()
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stocked_product_with_no_valuation_basis_is_recorded_as_uncosted() {
    let db = shop().await;
    never_purchased(&db).await;

    let payload = sauce_sale();
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, rate_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(
        source, "uncosted",
        "nothing has ever stated what this costs, and the line says so"
    );
    // The MONEY is exactly what it was before the correction. Only the claim
    // moved: a reclassification that changed a posted COGS figure would be a
    // restatement, which is the one thing this application never does.
    assert_eq!(rate_mc, 0);
    assert_eq!(rate_cents, 0);
    assert_eq!(line_cents, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_total_cents FROM sales WHERE id = '{sale_id}'"
        ))
        .await,
        0
    );

    // And it is still STOCK: the movement is written and the shelf is
    // decremented, because `uncosted` is a statement about the cost and not
    // about whether the goods left.
    assert_eq!(result.movement_ids.len(), 1);
    assert_eq!(quantity_on_hand(&db, P_SAUCE).await, 48);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements
              WHERE related_sale_id = '{sale_id}'"
        ))
        .await,
        0,
        "one cost, two rows — the movement still carries the line's own rate"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_documented_free_purchase_keeps_its_purchase_average_provenance() {
    // The legitimate zero, and the reason the probe asks for a DOCUMENT rather
    // than for a figure above zero: a supplier who sent a case for nothing has
    // told the shop what it costs, and that answer is $0.00.
    let db = shop().await;
    never_purchased(&db).await;
    receipt_movement(&db, "purchase", 0).await;

    let payload = sauce_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(source, "purchase_average");
    assert_eq!(rate_mc, 0);
    assert_eq!(line_cents, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_opening_valuation_of_zero_is_a_documented_basis_too() {
    // `opening` is the other movement type the weighted average is built from,
    // and the same pair `last_purchase` already reads.
    let db = shop().await;
    never_purchased(&db).await;
    receipt_movement(&db, "opening", 0).await;

    let payload = sauce_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(line_cogs(&db, &sale_id).await.3, "purchase_average");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_movement_is_not_a_valuation_basis() {
    // An adjustment is valued AT the average and never moves it — a quantity
    // correction is not a cost event — so it states no cost and cannot certify
    // one. Stock arriving by adjustment is exactly the "stale unrelated
    // transaction" that must not stand in for a receipt.
    let db = shop().await;
    never_purchased(&db).await;
    receipt_movement(&db, "adjustment", 0).await;

    let payload = sauce_sale();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(line_cogs(&db, &sale_id).await.3, "uncosted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_last_purchase_sale_against_a_zero_cost_receipt_stays_documented() {
    // Here the document is read DIRECTLY rather than probed for, so the zero
    // needs no second proof: the movement the rate came from is the evidence.
    let db = shop().await;
    never_purchased(&db).await;
    receipt_movement(&db, "purchase", 0).await;

    let mut payload = sauce_sale();
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(source, "last_purchase");
    assert_eq!(rate_mc, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_last_purchase_sale_with_no_history_at_all_is_uncosted() {
    // The fallback arm. It still records the average it actually used, and the
    // average is an absence, so the honest provenance is `uncosted` — not
    // `last_purchase` (no purchase existed) and not `purchase_average` (no
    // valuation existed either).
    let db = shop().await;
    never_purchased(&db).await;

    let mut payload = sauce_sale();
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(line_cogs(&db, &sale_id).await.3, "uncosted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_nonzero_average_needs_no_document() {
    // The average IS the valuation: a rate above zero cannot have come from
    // nowhere, so the probe never runs and the behaviour of every product
    // Greaz could already value is untouched. Coffee carries $2.00 and no
    // movement row at all.
    let db = shop().await;

    let payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
            .qty(1)
            .unit_incl(500)
            .build()],
        vec![cash_usd(500)],
    );
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements
              WHERE product_id = '{P_COFFEE}' AND movement_type IN ('purchase','opening')"
        ))
        .await,
        0,
        "no receipt exists — the average alone is the basis"
    );
    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 200_000_000);
    assert_eq!(source, "purchase_average");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_product_that_acquires_a_basis_costs_its_next_sale_from_it() {
    // Forward-only, like every other cost input here. The first sale's
    // `uncosted` snapshot stands — `sale_items` is sealed — and the purchase
    // that arrives afterwards governs the sale that follows it.
    let db = shop().await;
    never_purchased(&db).await;

    let first = sauce_sale();
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.unwrap();
    assert_eq!(line_cogs(&db, &first_id).await.3, "uncosted");

    receipt_movement(&db, "purchase", 40_000_000).await;
    db.exec(&format!(
        "UPDATE products
            SET avg_cost_excl_vat_microcents = 40000000,
                avg_cost_incl_vat_microcents = 44400000,
                avg_cost_excl_vat_cents = 40, avg_cost_incl_vat_cents = 44
          WHERE id = '{P_SAUCE}'"
    ))
    .await;

    let second = sauce_sale();
    let second_id = second.sale_id.clone();
    post_sale_with_pool(db.pool(), second).await.unwrap();

    let (rate_mc, _, line_cents, source) = line_cogs(&db, &second_id).await;
    assert_eq!(source, "purchase_average");
    assert_eq!(rate_mc, 40_000_000);
    assert_eq!(line_cents, 80);
    // The earlier line is exactly as it was posted.
    assert_eq!(line_cogs(&db, &first_id).await.3, "uncosted");
}

// ============================================================================
// 8. Manual cost is restricted to non-stock items
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_engine_refuses_a_manual_cost_on_a_stocked_product() {
    // Migration 020's trigger, against a direct writer. A manual rate on a
    // stocked line would be stamped onto the sale's inventory movement while
    // the pool those goods left says something else, and an append-only
    // movement table can never unwind that.
    let db = shop().await;
    let err = db
        .try_exec(&format!(
            "UPDATE products
                SET costing_method='standard', standard_cost_excl_vat_microcents=185000000
              WHERE id='{P_COFFEE}'"
        ))
        .await
        .expect_err("a stocked product may not be manual-costed");
    assert!(
        err.to_string().contains("non-stock"),
        "the refusal should say why: {err}"
    );
    let (method, cost) = costing_config(&db, P_COFFEE).await;
    assert_eq!(method, "purchase_average");
    assert_eq!(cost, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_engine_refuses_manual_cost_with_no_figure() {
    let db = shop().await;
    let err = db
        .try_exec(&format!(
            "UPDATE products SET costing_method='standard' WHERE id='{P_BURGER}'"
        ))
        .await
        .expect_err("manual cost needs a cost");
    assert!(err.to_string().contains("needs a cost"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_engine_refuses_recipe_costing_with_no_published_recipe() {
    // WP-B2-B admits `'recipe'` under two conditions and refuses it otherwise,
    // and the engine holds both against every writer — which is the same job
    // 020's refusal was doing, now stated as a rule rather than a blanket NO.
    //
    // `P_BURGER` here has no recipe at all, so a row configured this way would
    // be a product `post_sale` could not cost: the refusal belongs at the
    // moment the configuration is made, not in front of a customer.
    let db = shop().await;
    let err = db
        .try_exec(&format!(
            "UPDATE products SET costing_method='recipe' WHERE id='{P_BURGER}'"
        ))
        .await
        .expect_err("recipe costing needs a published recipe");
    assert!(err.to_string().contains("published recipe"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posting_refuses_a_manual_cost_stocked_line_even_if_the_row_existed() {
    // Belt and braces. The trigger makes this row unreachable, so the row is
    // forged by disabling the trigger — which is exactly the shape a future
    // migration bug, an import or a hand-edited database would take. The
    // posting command must not depend on the schema having held.
    let db = shop().await;
    db.exec("DROP TRIGGER trg_products_costing_coherence_upd").await;
    db.exec(&format!(
        "UPDATE products
            SET costing_method='standard', standard_cost_excl_vat_microcents=185000000
          WHERE id='{P_COFFEE}'"
    ))
    .await;

    let payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
            .qty(1)
            .unit_incl(500)
            .build()],
        vec![cash_usd(500)],
    );
    let err = post_sale_with_pool(db.pool(), payload).await.unwrap_err();
    assert!(
        err.contains("stocked product") && err.contains("Manual Cost"),
        "{err}"
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "no stock moved");
}

// ============================================================================
// 9. `save_product` — the path the UI and the importer take
// ============================================================================

/// A create payload for a SERVICE menu item, which is what manual cost is for.
fn service_create(product_id: &str, sku: &str, name: &str) -> SaveProductPayload {
    SaveProductPayload {
        product_id: product_id.to_string(),
        store_id: STORE_ID.to_string(),
        mode: "create".to_string(),
        sku: Some(sku.to_string()),
        name: name.to_string(),
        description: None,
        vat_rate_id: VAT_STD_ID.to_string(),
        vat_pricing_mode: "inclusive".to_string(),
        price_excl_vat_cents: 1000,
        price_incl_vat_cents: 1110,
        reorder_point: None,
        is_service: true,
        is_active: true,
        category: None,
        icon: None,
        costing_method: None,
        standard_cost_excl_vat_microcents: None,
        base_uom_code: "each".to_string(),
        sale_uom_code: "each".to_string(),
        sale_factor_num: 1,
        sale_factor_den: 1,
        sale_price_excl_vat_cents: None,
        sale_price_incl_vat_cents: None,
        barcode: None,
        barcode_type: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_writes_a_manual_cost_and_dates_it() {
    let db = TempDb::new().await;
    let mut payload = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    payload.costing_method = Some("standard".to_string());
    payload.standard_cost_excl_vat_microcents = Some(185_000_000);

    save_product_with_pool(db.pool(), payload).await.unwrap();

    let (method, cost) = costing_config(&db, P_BURGER).await;
    assert_eq!(method, "standard");
    assert_eq!(cost, Some(185_000_000));
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM products
              WHERE id='{P_BURGER}' AND standard_cost_set_at IS NOT NULL"
        ))
        .await,
        1,
        "a stated cost is dated, because it is an assertion by a person"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_omitted_costing_method_keeps_todays_behaviour() {
    // The backward-compatible half of the contract. The spreadsheet importer
    // and every other existing caller send no costing fields at all, and the
    // product they describe must be exactly the product they described before.
    let db = TempDb::new().await;
    save_product_with_pool(db.pool(), service_create(P_BURGER, "SKU-B1", "Greaz Burger"))
        .await
        .unwrap();

    let (method, cost) = costing_config(&db, P_BURGER).await;
    assert_eq!(method, "purchase_average");
    assert_eq!(cost, None, "not configured — which is NOT zero");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_update_that_names_no_costing_method_PRESERVES_the_one_on_file() {
    // The WP-A `isActive` defect, pre-empted. That field was optional, the
    // importer left it out, and every imported row landed sellable including
    // the ones a shop had deliberately retired.
    //
    // The same shape here would be worse: an update with no `costing_method`
    // would revert a manual-costed burger to purchase valuation, its future
    // margins would read 100%, and nothing on any screen would have said so.
    // So on an UPDATE silence preserves all three columns; only a CREATE takes
    // the default.
    let db = TempDb::new().await;
    let mut create = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    create.costing_method = Some("standard".to_string());
    create.standard_cost_excl_vat_microcents = Some(185_000_000);
    save_product_with_pool(db.pool(), create).await.unwrap();

    let stamped = db
        .scalar_string(&format!(
            "SELECT standard_cost_set_at FROM products WHERE id='{P_BURGER}'"
        ))
        .await;

    // A caller that has never heard of WP-B1 renames the product.
    let mut rename = service_create(P_BURGER, "SKU-B1", "Greaz Burger Deluxe");
    rename.mode = "update".to_string();
    assert_eq!(rename.costing_method, None, "the point of the fixture");
    save_product_with_pool(db.pool(), rename).await.unwrap();

    let (method, cost) = costing_config(&db, P_BURGER).await;
    assert_eq!(method, "standard", "the owner's choice survives an unrelated edit");
    assert_eq!(cost, Some(185_000_000), "and so does the figure");
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT standard_cost_set_at FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        stamped,
        "and so does the date it was stated on"
    );
    // The rest of the edit still applied — silence is about costing only.
    assert_eq!(
        db.scalar_string(&format!("SELECT name FROM products WHERE id='{P_BURGER}'")).await,
        "Greaz Burger Deluxe"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_explicit_switch_back_to_purchase_valuation_is_honoured() {
    // The other half: silence preserves, but a STATED method is a write. The
    // Products form always states one, so this is the path a user takes.
    let db = TempDb::new().await;
    let mut create = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    create.costing_method = Some("standard".to_string());
    create.standard_cost_excl_vat_microcents = Some(185_000_000);
    save_product_with_pool(db.pool(), create).await.unwrap();

    let mut switch = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    switch.mode = "update".to_string();
    switch.costing_method = Some("purchase_average".to_string());
    switch.standard_cost_excl_vat_microcents = None;
    save_product_with_pool(db.pool(), switch).await.unwrap();

    let (method, cost) = costing_config(&db, P_BURGER).await;
    assert_eq!(method, "purchase_average");
    assert_eq!(cost, None, "an explicitly cleared figure is cleared");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_manual_cost_with_no_figure() {
    let db = TempDb::new().await;
    let mut payload = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    payload.costing_method = Some("standard".to_string());

    let err = save_product_with_pool(db.pool(), payload).await.unwrap_err();
    assert_eq!(err, MANUAL_COST_REQUIRED);
    // Counted by id: migration 003 seeds three demonstration products into
    // every database and 019 deactivates rather than deletes them, so the
    // table is never empty.
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM products WHERE id='{P_BURGER}'")).await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_manual_cost_on_a_stocked_item() {
    let db = TempDb::new().await;
    let mut payload = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    payload.is_service = false;
    payload.costing_method = Some("standard".to_string());
    payload.standard_cost_excl_vat_microcents = Some(185_000_000);

    let err = save_product_with_pool(db.pool(), payload).await.unwrap_err();
    assert_eq!(err, MANUAL_COST_NEEDS_SERVICE);
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM products WHERE id='{P_BURGER}'")).await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_recipe_costing_on_a_new_product() {
    // A recipe belongs to a product, so a product being CREATED cannot already
    // have a published one. WP-B2-B says so in the operator's own terms and
    // names the screen they need, rather than letting migration 022's trigger
    // answer with a constraint message.
    let db = TempDb::new().await;
    let mut payload = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    payload.costing_method = Some("recipe".to_string());

    let err = save_product_with_pool(db.pool(), payload).await.unwrap_err();
    assert_eq!(err, RECIPE_COSTING_NEEDS_ACTIVE_RECIPE);
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM products WHERE id='{P_BURGER}'")).await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_recipe_costing_on_a_stocked_product() {
    // The same financial argument Manual Cost makes, one method along: a
    // recipe-derived rate on a stocked line would be stamped onto the sale's
    // `inventory_movements` row while the pool those goods left says something
    // else, and that table is append-only.
    let db = TempDb::new().await;
    let mut payload = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    payload.is_service = false;
    payload.costing_method = Some("recipe".to_string());

    let err = save_product_with_pool(db.pool(), payload).await.unwrap_err();
    assert_eq!(err, RECIPE_COSTING_NEEDS_SERVICE);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_a_negative_manual_cost() {
    let db = TempDb::new().await;
    let mut payload = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    payload.costing_method = Some("standard".to_string());
    payload.standard_cost_excl_vat_microcents = Some(-1);

    assert!(save_product_with_pool(db.pool(), payload).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ordinary_edit_does_not_restamp_the_cost_date() {
    // The date means "when this figure was asserted", so it moves only when
    // the figure does. Otherwise an eighteen-month-old plate cost would read
    // as stated today and stop looking like a number worth doubting.
    let db = TempDb::new().await;
    let mut create = service_create(P_BURGER, "SKU-B1", "Greaz Burger");
    create.costing_method = Some("standard".to_string());
    create.standard_cost_excl_vat_microcents = Some(185_000_000);
    save_product_with_pool(db.pool(), create).await.unwrap();

    let stamped = db
        .scalar_string(&format!(
            "SELECT standard_cost_set_at FROM products WHERE id='{P_BURGER}'"
        ))
        .await;

    // Rename it, same cost.
    let mut rename = service_create(P_BURGER, "SKU-B1", "Greaz Burger Deluxe");
    rename.mode = "update".to_string();
    rename.costing_method = Some("standard".to_string());
    rename.standard_cost_excl_vat_microcents = Some(185_000_000);
    save_product_with_pool(db.pool(), rename).await.unwrap();

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT standard_cost_set_at FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        stamped,
        "an unrelated edit must not restamp the cost date"
    );

    // Change the cost, and the date moves.
    let mut reprice = service_create(P_BURGER, "SKU-B1", "Greaz Burger Deluxe");
    reprice.mode = "update".to_string();
    reprice.costing_method = Some("standard".to_string());
    reprice.standard_cost_excl_vat_microcents = Some(260_000_000);
    save_product_with_pool(db.pool(), reprice).await.unwrap();

    assert_ne!(
        db.scalar_string(&format!(
            "SELECT standard_cost_set_at FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        stamped,
        "a changed figure is a new assertion and carries a new date"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_still_cannot_write_stock_or_the_cost_POOL() {
    // GZ-HI-10, re-asserted. WP-B1 adds a cost field to this command, and it
    // would be an easy mistake to think that reopens the door to the others.
    // It does not: `standard_cost_*` is a configuration the owner states, and
    // `quantity_on_hand` / `avg_cost_*` remain writable only by the posting
    // commands, each of which writes a movement alongside.
    let db = TempDb::new().await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 10,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")
        },
    )
    .await;

    let mut edit = service_create(P_COFFEE, "SKU-C1", "Coffee 250g");
    edit.mode = "update".to_string();
    edit.is_service = false;
    save_product_with_pool(db.pool(), edit).await.unwrap();

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        200_000_000
    );
}
