// Layer C — the cost lifecycle end to end at microcent precision (WP-03,
// GP-A03).
//
// `tests::cost` proves the arithmetic. This file proves that the arithmetic is
// the arithmetic the POSTING COMMANDS actually use, through the real migration
// list and the real SQLite transactions: that a fractional per-base cost is
// what gets persisted on a purchase, what the weighted average blends, what
// `last_purchase` reads back, what a sale is costed at, what an adjustment is
// valued at — and that none of it disturbs the whole-cent products that make up
// most of a shop's catalogue.
//
// The running example is the one GP-A03 names: an ingredient bought by the kilo
// and stocked in grams.

use crate::cost::COST_SCALE;
use crate::posting::{post_adjustment_with_pool, post_purchase_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

/// Flour, stocked in grams.
const P_FLOUR: &str = "00000000-0000-0000-0000-0000000000f1";
/// Coffee, stocked in whole pieces at a whole-cent cost — the control product.
const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

/// $0.0025 per gram — the per-base rate of $2.50/kg.
const FLOUR_PER_GRAM: i64 = 250_000;

/// A store that buys flour by the kilo and stocks it by the gram.
async fn store_with_flour() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(
        &db,
        &ProductSpec {
            base_uom_code: "g",
            ..ProductSpec::stocked(P_FLOUR, "SKU-F1", "Flour")
        },
    )
    .await;
    seed_product_uom(&db, P_FLOUR, "kg", 1_000, 1).await;
    db
}

/// Buy `kg` kilos of flour at `price_per_kg` cents per kilo.
async fn buy_flour(db: &TempDb, kg: i64, price_per_kg_cents: i64) {
    let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
        .uom("kg", 1_000, 1)
        .qty(kg)
        .unit_cost_excl(price_per_kg_cents)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .expect("purchase must post");
}

async fn avg_microcents(db: &TempDb, product_id: &str) -> i64 {
    db.scalar_i64(&format!(
        "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{product_id}'"
    ))
    .await
}

// ============================================================================
// REQUIRED TEST 1 — a purchase persists the fractional rate everywhere
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_persists_the_fractional_per_base_cost_on_every_row_it_writes() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await; // 20 kg at $2.50/kg = $50.00

    // The purchase line, the movement it created, and the product's cost pool
    // all carry the same rate — derived by the backend from the invoice's
    // per-UoM cost, not taken from the client's cents-rounded copy.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_microcents FROM purchase_items").await,
        FLOUR_PER_GRAM
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_microcents FROM inventory_movements").await,
        FLOUR_PER_GRAM
    );
    assert_eq!(avg_microcents(&db, P_FLOUR).await, FLOUR_PER_GRAM);

    // The VAT-inclusive rate is derived the same way: $2.78/kg incl 11% VAT.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_base_microcents FROM purchase_items").await,
        278_000
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_incl_vat_microcents FROM products WHERE id='{P_FLOUR}'"
        ))
        .await,
        278_000
    );

    // The legacy cents columns are still maintained, as the rounded mirror they
    // now are. A quarter of a cent rounds to nothing — which is exactly why
    // nothing costs from them any more.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_cents FROM purchase_items").await,
        0
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_FLOUR}'"
        ))
        .await,
        0
    );

    // Quantity bookkeeping is untouched by any of this (WP-02 invariant).
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 20_000);
    assert_eq!(movement_sum(&db, P_FLOUR).await, 20_000);

    // The invoice total is still exact cents: $50.00 net, 11% VAT.
    assert_eq!(db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await, 5_000);
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await, 5_560);
}

// ============================================================================
// REQUIRED TEST 2 — weighted average across two fractional purchases
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_fractional_purchases_blend_into_the_mathematically_correct_average() {
    let db = store_with_flour().await;
    buy_flour(&db, 10, 250).await; // 10,000 g @ $0.0025/g
    assert_eq!(avg_microcents(&db, P_FLOUR).await, 250_000);

    buy_flour(&db, 10, 310).await; // 10,000 g @ $0.0031/g

    // The true midpoint, held exactly: $0.0028/g.
    assert_eq!(avg_microcents(&db, P_FLOUR).await, 280_000);
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 20_000);

    // Under the old cents-only pool both receipts were worth $0.00 and the
    // average stayed 0. Now the pool is worth the $56.00 that was spent on it.
    let value_cents = db
        .scalar_i64(&format!(
            "SELECT (avg_cost_excl_vat_microcents * quantity_on_hand + {half}) / {scale}
               FROM products WHERE id='{P_FLOUR}'",
            half = COST_SCALE / 2,
            scale = COST_SCALE
        ))
        .await;
    assert_eq!(value_cents, 5_600);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_fractional_purchases_keep_the_pool_worth_what_was_paid() {
    let db = store_with_flour().await;
    let receipts = [(7i64, 233i64), (3, 419), (11, 177)];
    for (kg, price) in receipts {
        buy_flour(&db, kg, price).await;
    }
    let paid: i64 = receipts.iter().map(|(kg, price)| kg * price).sum();

    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 21_000);
    let value_cents = db
        .scalar_i64(&format!(
            "SELECT (avg_cost_excl_vat_microcents * quantity_on_hand + {half}) / {scale}
               FROM products WHERE id='{P_FLOUR}'",
            half = COST_SCALE / 2,
            scale = COST_SCALE
        ))
        .await;
    assert_eq!(value_cents, paid, "the pool must still be worth $46.07");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchases_in_different_uoms_blend_on_the_base_unit() {
    let db = store_with_flour().await;
    buy_flour(&db, 1, 300).await; // 1 kg at $3.00/kg -> 1,000 g @ 300,000 µ¢

    // The same product bought in its base UoM, by the gram, at 1 cent per gram.
    let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
        .uom("g", 1, 1)
        .qty(500)
        .unit_cost_excl(1)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .unwrap();

    // (1000 x 300,000 + 500 x 1,000,000) / 1500 = 533,333.33 -> 533,333
    assert_eq!(avg_microcents(&db, P_FLOUR).await, 533_333);
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 1_500);
}

// ============================================================================
// REQUIRED TEST 4 — COGS at the new precision
// ============================================================================

/// Sell `grams` of flour in its base UoM and return the posted line COGS.
async fn sell_flour_grams(db: &TempDb, grams: i64) -> i64 {
    let line = SaleLineBuilder::new(P_FLOUR, "Flour")
        .uom("g", 1, 1)
        .qty(grams)
        .unit_incl(1)
        .build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("sale must post");
    db.scalar_i64(&format!(
        "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
    ))
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn weighted_average_cogs_values_a_fractional_sale_in_whole_cents() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await; // $0.0025/g

    // 500 g at $0.0025/g is $1.25 — the figure the old code made $0.00.
    assert_eq!(sell_flour_grams(&db, 500).await, 125);
    // 1 g is a quarter of a cent, which rounds to nothing as an AMOUNT. That is
    // correct: a cent is the smallest bookable amount. The RATE is intact, which
    // is what makes the 500 g line right.
    assert_eq!(sell_flour_grams(&db, 1).await, 0);
    assert_eq!(sell_flour_grams(&db, 2).await, 1, "0.5¢ rounds half away from zero");
    assert_eq!(sell_flour_grams(&db, 3).await, 1, "0.75¢ rounds to 1¢");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cogs_is_charged_on_the_derived_base_quantity_of_a_larger_uom() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await;

    // Sell 2 kg. The authoritative base quantity is 2,000 g (WP-02/GP-A02), so
    // COGS is 2,000 x $0.0025 = $5.00.
    let line = SaleLineBuilder::new(P_FLOUR, "Flour")
        .uom("kg", 1_000, 1)
        .qty(2)
        .unit_incl(600)
        .build();
    assert_eq!(line.quantity_base, 2_000);
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        500
    );
    // The movement carries the RATE per base unit, not per kilo.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements
              WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        FLOUR_PER_GRAM
    );
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 18_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_sale_sums_its_rounded_line_cogs_into_the_header() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await;
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

    let lines = vec![
        SaleLineBuilder::new(P_FLOUR, "Flour").uom("g", 1, 1).qty(300).unit_incl(1).build(),
        SaleLineBuilder::new(P_COFFEE, "Coffee").qty(3).unit_incl(500).build(),
    ];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    // 300 g x $0.0025 = $0.75, plus 3 x $2.00 = $6.00.
    let line_sum = db
        .scalar_i64(&format!(
            "SELECT SUM(line_cogs_excl_vat_cents) FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await;
    assert_eq!(line_sum, 75 + 600);
    // The header is the sum of the ROUNDED lines, so reports that group by
    // product still reconcile to the day's total to the cent.
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        line_sum
    );
}

// ============================================================================
// REQUIRED TEST 5 — no early rounding, proved through the posting path
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_posted_line_cogs_is_not_the_rounded_unit_cost_times_quantity() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await;

    let line = SaleLineBuilder::new(P_FLOUR, "Flour").uom("g", 1, 1).qty(500).unit_incl(1).build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let col = |name: &str| format!("SELECT {name} FROM sale_items WHERE sale_id='{sale_id}'");
    let unit_cents = db.scalar_i64(&col("unit_cogs_excl_vat_cents")).await;
    let unit_mc = db.scalar_i64(&col("unit_cogs_excl_vat_microcents")).await;
    let line_cogs = db.scalar_i64(&col("line_cogs_excl_vat_cents")).await;
    let qty = db.scalar_i64(&col("quantity")).await;

    assert_eq!(unit_mc, FLOUR_PER_GRAM, "the precise rate is what is snapshotted");
    assert_eq!(unit_cents, 0, "rounded to cents the same rate is nothing");
    assert_eq!(line_cogs, 125, "round(rate x qty) is $1.25");
    assert_ne!(
        line_cogs,
        unit_cents * qty,
        "GP-A03: the line cost must not be the rounded unit cost times the quantity"
    );
}

// ============================================================================
// REQUIRED TEST 3 — last-purchase costing keeps the fractional rate
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn last_purchase_costing_reads_back_the_latest_fractional_rate() {
    let db = store_with_flour().await;
    buy_flour(&db, 10, 250).await; // $0.0025/g
    buy_flour(&db, 10, 410).await; // $0.0041/g — the latest

    // The weighted average is $0.0033/g; last purchase must be $0.0041/g, and
    // neither may collapse to zero.
    assert_eq!(avg_microcents(&db, P_FLOUR).await, 330_000);

    let line = SaleLineBuilder::new(P_FLOUR, "Flour").uom("g", 1, 1).qty(1_000).unit_incl(1).build();
    let total = lines_total(std::slice::from_ref(&line));
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        410_000,
        "the costing POLICY is unchanged: last purchase, at full precision"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        410,
        "1,000 g at $0.0041/g is $4.10"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn last_purchase_still_falls_back_to_the_weighted_average_at_full_precision() {
    // No purchase or opening movement exists, so the documented fallback is the
    // weighted average — which must also arrive in microcents.
    let db = store_with_flour().await;
    seed_product_avg_cost_microcents(&db, P_FLOUR, FLOUR_PER_GRAM, 278_000).await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 5000 WHERE id='{P_FLOUR}'"
    ))
    .await;

    let line = SaleLineBuilder::new(P_FLOUR, "Flour").uom("g", 1, 1).qty(800).unit_incl(1).build();
    let total = lines_total(std::slice::from_ref(&line));
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        FLOUR_PER_GRAM
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        200,
        "800 g at $0.0025/g is $2.00"
    );
}

// ============================================================================
// REQUIRED TEST 6 — ordinary whole-cent products are unaffected
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_whole_cent_product_produces_the_same_figures_as_before() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;

    // 10 boxes of 12 at $24.00/box: $2.00 per piece, as it always was.
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(10)
        .unit_cost_excl(2_400)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .unwrap();

    // The cents columns hold exactly the values the pre-WP-03 code wrote...
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        200
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_cents FROM purchase_items").await,
        200
    );
    // ...and the microcent columns are their exact scaling.
    assert_eq!(avg_microcents(&db, P_COFFEE).await, 200 * COST_SCALE);

    // COGS on a 3-piece sale is the same $6.00 it was before the change.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee").qty(3).unit_incl(500).build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        200
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        600
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        600
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 117);
}

// ============================================================================
// REQUIRED TEST 9 — historical snapshots stay put
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_fractional_cogs_snapshot_survives_later_purchases() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await; // $0.0025/g

    let line = SaleLineBuilder::new(P_FLOUR, "Flour").uom("g", 1, 1).qty(400).unit_incl(1).build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let unit_before = db
        .scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await;
    let line_before = db
        .scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await;
    assert_eq!((unit_before, line_before), (250_000, 100)); // 400 g = $1.00

    // Flour doubles in price, several times over.
    buy_flour(&db, 40, 1_000).await;
    buy_flour(&db, 40, 2_000).await;
    assert_ne!(
        avg_microcents(&db, P_FLOUR).await,
        250_000,
        "the product's current average must have moved"
    );

    // The posted sale is history and does not move with it.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        unit_before
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        line_before
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        line_before
    );
    // The movement's snapshot is equally frozen, and the trigger says so.
    assert!(db
        .try_exec(&format!(
            "UPDATE inventory_movements SET unit_cost_excl_vat_microcents = 1
              WHERE related_sale_id='{sale_id}'"
        ))
        .await
        .is_err());
}

// ============================================================================
// REQUIRED TEST 10 — cost-bearing adjustments
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_is_valued_at_the_current_fractional_average() {
    let db = store_with_flour().await;
    buy_flour(&db, 20, 250).await;

    // Write off 1,500 g of spoiled flour.
    let mut line = adjustment_line(P_FLOUR, -1_500);
    line.uom_code_snapshot = "g".to_string();
    let movement_id = line.movement_id.clone();
    post_adjustment_with_pool(db.pool(), adjustment_payload("spoilage", vec![line]))
        .await
        .unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements WHERE id='{movement_id}'"
        ))
        .await,
        FLOUR_PER_GRAM,
        "a write-off of a sub-cent ingredient must not be valued at zero"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_incl_vat_microcents FROM inventory_movements WHERE id='{movement_id}'"
        ))
        .await,
        278_000
    );
    // The rounded mirror is maintained beside it.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_cents FROM inventory_movements WHERE id='{movement_id}'"
        ))
        .await,
        0
    );

    // Quantity reconciliation (WP-02) is unaffected.
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 18_500);
    assert_eq!(movement_sum(&db, P_FLOUR).await, 18_500);

    // A positive adjustment snapshots the same rate.
    let mut up = adjustment_line(P_FLOUR, 500);
    up.uom_code_snapshot = "g".to_string();
    let up_id = up.movement_id.clone();
    post_adjustment_with_pool(db.pool(), adjustment_payload("recount", vec![up]))
        .await
        .unwrap();
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements WHERE id='{up_id}'"
        ))
        .await,
        FLOUR_PER_GRAM
    );
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 19_000);
}

// ============================================================================
// Service items and negative inventory, at the new precision
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_service_line_still_carries_no_cost_at_all() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            // A service with a stale cost on its row must still cost nothing.
            avg_cost_excl_vat_cents: 500,
            avg_cost_incl_vat_cents: 555,
            ..ProductSpec::stocked(P_COFFEE, "SVC-1", "Delivery")
        },
    )
    .await;

    let line = SaleLineBuilder::new(P_COFFEE, "Delivery").qty(2).unit_incl(1_000).build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        0
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        0
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        0
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_oversold_line_is_still_costed_at_the_fractional_rate() {
    let db = store_with_flour().await;
    buy_flour(&db, 1, 250).await; // only 1,000 g on hand

    // Sell 1,600 g with negative inventory allowed.
    let line = SaleLineBuilder::new(P_FLOUR, "Flour").uom("g", 1, 1).qty(1_600).unit_incl(1).build();
    let total = lines_total(std::slice::from_ref(&line));
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.allow_negative_inventory = true;
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, -600);
    assert_eq!(movement_sum(&db, P_FLOUR).await, -600);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        400,
        "1,600 g at $0.0025/g is $4.00 whether or not the stock existed"
    );
}

// ============================================================================
// REQUIRED TEST 11 — overflow at the posting boundary
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_whose_cost_cannot_be_represented_is_refused_and_writes_nothing() {
    let db = store_with_flour().await;

    // $100 billion per kilo. Its microcent form exceeds i64, so the posting must
    // error rather than wrap into a plausible-looking small number.
    let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
        .uom("kg", 1_000, 1)
        .qty(1)
        .unit_cost_excl(10_000_000_000_000)
        .build();
    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), vec![line]),
    )
    .await
    .expect_err("an unrepresentable cost must be refused");
    assert!(
        err.contains("out of range") || err.contains("overflow"),
        "the error must name the range problem, got: {err}"
    );

    // And the transaction rolled back in full: no purchase, no movement, no
    // stock, and the purchase-number sequence is where it was.
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 0);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "1"
    );
}
