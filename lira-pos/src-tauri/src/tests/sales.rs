// Layer C — `post_sale` against a temporary database.
//
// Every test asserts on PERSISTED rows, not on the command's return value
// alone, because persistence is what later work packages must not regress.

use crate::posting::{post_sale_with_pool, PostSaleLine, PostSalePayload, PostSalePayment};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000c2";
const P_BREAD: &str = "00000000-0000-0000-0000-0000000000c3";
const P_DELIVERY: &str = "00000000-0000-0000-0000-0000000000c4";

/// A store with one stocked product: 100 on hand at a $2.00 weighted-average
/// cost (excl VAT) / $2.22 incl.
async fn store_with_coffee() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            price_excl_vat_cents: 450,
            price_incl_vat_cents: 500,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")
        },
    )
    .await;
    db
}

// ============================================================================
// Happy path + persisted reconciliation
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sale_reconciles_header_lines_payments_and_stock() {
    let db = store_with_coffee().await;

    // 3 × $5.00 incl VAT at 11% → excl 450/unit → 1350 + 150 = 1500.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(3).unit_incl(500).build()];
    let total = lines_total(&lines);
    assert_eq!(total, 1500);

    let payload = sale_payload(lines, vec![cash_usd(2000)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.expect("sale posts");
    assert_eq!(result.receipt_number, 1);
    assert_eq!(result.change_total_usd_cents, 500);
    assert_eq!(result.movement_ids.len(), 1);

    // --- Header reconciles internally ---
    let subtotal = db
        .scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM sales WHERE id='{sale_id}'"))
        .await;
    let vat = db
        .scalar_i64(&format!("SELECT vat_total_cents FROM sales WHERE id='{sale_id}'"))
        .await;
    let header_total = db
        .scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'"))
        .await;
    assert_eq!(subtotal, 1350);
    assert_eq!(vat, 150);
    assert_eq!(header_total, 1500);
    assert_eq!(subtotal + vat, header_total, "subtotal + VAT = total");

    // --- Header reconciles to its lines ---
    for (col, expected) in [
        ("line_subtotal_excl_vat_cents", subtotal),
        ("line_vat_cents", vat),
        ("line_total_incl_vat_cents", header_total),
    ] {
        let summed = db
            .scalar_i64(&format!(
                "SELECT COALESCE(SUM({col}),0) FROM sale_items WHERE sale_id='{sale_id}'"
            ))
            .await;
        assert_eq!(summed, expected, "SUM(sale_items.{col}) must equal the header");
    }

    // --- Payments reconcile to amount due plus change ---
    let tendered = db
        .scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_usd_cents_equivalent),0) FROM sale_payments WHERE sale_id='{sale_id}'"
        ))
        .await;
    let change = db
        .scalar_i64(&format!(
            "SELECT COALESCE(SUM(change_given_usd_cents),0) FROM sale_payments WHERE sale_id='{sale_id}'"
        ))
        .await;
    assert_eq!(tendered - change, header_total, "tendered − change = amount due");

    // --- Inventory moved exactly once, in the right direction ---
    let delta = db
        .scalar_i64(&format!(
            "SELECT quantity_delta FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await;
    assert_eq!(delta, -3, "a sale is stock OUT of the base quantity");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 97);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT movement_type FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        "sale"
    );

    // --- COGS snapshot ---
    let unit_cogs = db
        .scalar_i64(&format!("SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"))
        .await;
    let line_cogs = db
        .scalar_i64(&format!("SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"))
        .await;
    let header_cogs = db
        .scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"))
        .await;
    assert_eq!(unit_cogs, 200);
    assert_eq!(line_cogs, 600);
    assert_eq!(header_cogs, 600, "header COGS is the sum of its lines");

    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'")).await,
        "posted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn receipt_numbers_increment_and_never_repeat() {
    let db = store_with_coffee().await;

    for expected in 1..=3 {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
        let payload = sale_payload(lines, vec![cash_usd(500)]);
        let r = post_sale_with_pool(db.pool(), payload).await.unwrap();
        assert_eq!(r.receipt_number, expected);
    }

    assert_eq!(db.count("SELECT COUNT(DISTINCT receipt_number) FROM sales").await, 3);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "4",
        "the sequence advances with each post"
    );
}

// ============================================================================
// VAT
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mixed_vat_sale_reconciles_at_transaction_level() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 50, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 50,
            vat_rate_id: VAT_EXEMPT_ID,
            ..ProductSpec::stocked(P_BREAD, "SKU-B1", "Bread")
        },
    )
    .await;

    let lines = vec![
        SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(555).build(),
        SaleLineBuilder::new(P_BREAD, "Bread")
            .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
            .qty(4)
            .unit_incl(150)
            .build(),
    ];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    // The exempt line carries zero VAT...
    let exempt_vat = db
        .scalar_i64(&format!(
            "SELECT line_vat_cents FROM sale_items WHERE sale_id='{sale_id}' AND product_id='{P_BREAD}'"
        ))
        .await;
    assert_eq!(exempt_vat, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT vat_rate_bps_snapshot FROM sale_items WHERE sale_id='{sale_id}' AND product_id='{P_BREAD}'"
        ))
        .await,
        0
    );

    // ...the taxable line does...
    let taxable_vat = db
        .scalar_i64(&format!(
            "SELECT line_vat_cents FROM sale_items WHERE sale_id='{sale_id}' AND product_id='{P_COFFEE}'"
        ))
        .await;
    assert!(taxable_vat > 0);

    // ...and the header still reconciles.
    let (s, v, t) = (
        db.scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
        db.scalar_i64(&format!("SELECT vat_total_cents FROM sales WHERE id='{sale_id}'")).await,
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
    );
    assert_eq!(s + v, t);
    assert_eq!(v, taxable_vat + exempt_vat);
    assert_eq!(t, 1110 + 600);
}

// ============================================================================
// Service items
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn service_items_never_touch_physical_stock() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            quantity_on_hand: 0,
            avg_cost_excl_vat_cents: 999,
            avg_cost_incl_vat_cents: 1109,
            ..ProductSpec::stocked(P_DELIVERY, "SKU-D1", "Delivery")
        },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_DELIVERY, "Delivery")
        .service(true)
        .qty(1)
        .unit_incl(300)
        .build()];
    let payload = sale_payload(lines, vec![cash_usd(300)]);
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert!(result.movement_ids.is_empty(), "a service line creates no movement");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        0
    );
    assert_eq!(quantity_on_hand(&db, P_DELIVERY).await, 0, "stock is untouched");
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        0,
        "a service carries no COGS even when the product row has an avg cost"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_service_line_can_be_sold_below_zero_stock_without_a_guard_error() {
    // Services have no stock to run out of; the guard must not fire.
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { is_service: true, ..ProductSpec::stocked(P_DELIVERY, "SKU-D1", "Delivery") },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_DELIVERY, "Delivery")
        .service(true)
        .qty(99)
        .unit_incl(100)
        .build()];
    let payload = sale_payload(lines, vec![cash_usd(9900)]);
    assert!(post_sale_with_pool(db.pool(), payload).await.is_ok());
}

// ============================================================================
// Tenders and change
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_tender_change_lands_on_exactly_one_row_in_its_native_currency() {
    let db = store_with_coffee().await;

    // Amount due 1500. Card 500 + USD cash 1200 → 200 change on the cash row.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(3).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![card_usd(500), cash_usd(1200)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let rows_with_change = db
        .count(&format!(
            "SELECT COUNT(*) FROM sale_payments
             WHERE sale_id='{sale_id}' AND (change_given_usd_cents <> 0 OR change_given_lbp <> 0)"
        ))
        .await;
    assert_eq!(rows_with_change, 1, "change is attached to a single tender row");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT change_given_usd_cents FROM sale_payments WHERE sale_id='{sale_id}' AND method='cash_usd'"
        ))
        .await,
        200
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT change_given_lbp FROM sale_payments WHERE sale_id='{sale_id}' AND method='cash_usd'"
        ))
        .await,
        0,
        "change on a USD row is expressed in USD"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT change_given_usd_cents FROM sale_payments WHERE sale_id='{sale_id}' AND method='card_usd'"
        ))
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lbp_change_is_converted_at_the_locked_rate() {
    let db = store_with_coffee().await;

    // Due 500. Tender 1,000,000 LBP ≈ $11.17 → change ≈ $6.17 expressed in LBP.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let tender = cash_lbp(1_000_000);
    let tender_usd = tender.amount_usd_cents_equivalent;
    let payload = sale_payload(lines, vec![tender]);
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    let expected_change_usd = tender_usd - 500;
    assert_eq!(result.change_total_usd_cents, expected_change_usd);

    let change_lbp = db
        .scalar_i64(&format!(
            "SELECT change_given_lbp FROM sale_payments WHERE sale_id='{sale_id}'"
        ))
        .await;
    // round-half-up of usd_cents × rate ÷ 100, per posting.rs.
    assert_eq!(change_lbp, (expected_change_usd * RATE_LBP_PER_USD + 50) / 100);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT change_given_usd_cents FROM sale_payments WHERE sale_id='{sale_id}'"
        ))
        .await,
        0,
        "change on an LBP row is expressed in LBP"
    );

    // The locked rate is persisted on the header for reprints.
    assert_eq!(
        db.scalar_i64(&format!("SELECT exchange_rate_lbp_per_usd FROM sales WHERE id='{sale_id}'")).await,
        RATE_LBP_PER_USD
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_payment_records_no_change() {
    let db = store_with_coffee().await;
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(1000)]);
    let sale_id = payload.sale_id.clone();
    let r = post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(r.change_total_usd_cents, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(change_given_usd_cents + change_given_lbp),0)
               FROM sale_payments WHERE sale_id='{sale_id}'"
        ))
        .await,
        0
    );
}

// ============================================================================
// Stock guard
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selling_more_than_is_on_hand_is_refused_and_nothing_persists() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 2, ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water") },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_WATER, "Water").qty(3).unit_incl(100).build()];
    let err = post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(300)]))
        .await
        .unwrap_err();
    assert!(err.contains("insufficient stock"), "got: {err}");

    // The whole transaction rolled back.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selling_exactly_the_stock_on_hand_is_allowed() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 3, ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water") },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_WATER, "Water").qty(3).unit_incl(100).build()];
    post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(300)]))
        .await
        .expect("selling down to exactly zero is a valid boundary");
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn allow_negative_inventory_bypasses_the_guard_but_still_moves_stock() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 1, ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water") },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_WATER, "Water").qty(5).unit_incl(100).build()];
    let mut payload = sale_payload(lines, vec![cash_usd(500)]);
    payload.allow_negative_inventory = true;
    post_sale_with_pool(db.pool(), payload).await.expect("override permits the sale");

    assert_eq!(quantity_on_hand(&db, P_WATER).await, -4);
    assert_eq!(movement_sum(&db, P_WATER).await, -5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_inactive_product_cannot_be_sold() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_active: false,
            quantity_on_hand: 10,
            ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water")
        },
    )
    .await;

    let lines = vec![SaleLineBuilder::new(P_WATER, "Water").qty(1).unit_incl(100).build()];
    let err = post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(100)]))
        .await
        .unwrap_err();
    assert!(err.contains("inactive"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_product_is_refused() {
    let db = store_with_coffee().await;
    let lines = vec![SaleLineBuilder::new("no-such-product", "Ghost").qty(1).unit_incl(100).build()];
    let err = post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(100)]))
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "got: {err}");
}

// ============================================================================
// COGS
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cogs_snapshots_survive_later_cost_changes() {
    let db = store_with_coffee().await; // avg cost 200

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(1000)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let before = db
        .scalar_i64(&format!("SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"))
        .await;
    assert_eq!(before, 200);

    // The product's cost moves afterwards — by any means.
    db.exec(&format!(
        "UPDATE products SET avg_cost_excl_vat_cents = 777, avg_cost_incl_vat_cents = 863
           WHERE id = '{P_COFFEE}'"
    ))
    .await;

    let after = db
        .scalar_i64(&format!("SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"))
        .await;
    assert_eq!(after, before, "a posted COGS snapshot is immutable history");
    assert_eq!(
        db.scalar_i64(&format!("SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'")).await,
        400
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        400
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_cogs_method_is_recorded_and_changes_the_snapshot() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
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
    // A purchase movement whose cost differs from the weighted average.
    db.exec(&format!(
        "INSERT INTO inventory_movements
           (id, store_id, product_id, movement_type, quantity_delta,
            unit_cost_excl_vat_cents, unit_cost_incl_vat_cents, posted_at)
         VALUES ('m-last', '{STORE_ID}', '{P_COFFEE}', 'purchase', 0, 350, 389,
                 '2026-03-01T10:00:00.000Z')"
    ))
    .await;

    for (method, expected_unit_cogs) in [("weighted_average", 200), ("last_purchase", 350)] {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
        let mut payload = sale_payload(lines, vec![cash_usd(500)]);
        payload.cogs_method = method.to_string();
        let sale_id = payload.sale_id.clone();
        post_sale_with_pool(db.pool(), payload).await.unwrap();

        assert_eq!(
            db.scalar_string(&format!("SELECT cogs_method FROM sales WHERE id='{sale_id}'")).await,
            method,
            "the method used is recorded on the sale"
        );
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
            ))
            .await,
            expected_unit_cogs,
            "{method} must use its own cost basis"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn last_purchase_falls_back_to_weighted_average_without_purchase_history() {
    let db = store_with_coffee().await; // no purchase/opening movements exist

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![cash_usd(500)]);
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        200,
        "with no purchase history the weighted average is the documented fallback"
    );
}

// ============================================================================
// Multi-line, UoM, boundaries
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_multi_uom_sale_decrements_each_product_in_base_units() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 100, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 100, ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water") },
    )
    .await;

    let lines = vec![
        // 2 boxes of 12 → 24 base units.
        SaleLineBuilder::new(P_COFFEE, "Coffee").uom("box", 12, 1).qty(2).unit_incl(6000).build(),
        // 5 singles.
        SaleLineBuilder::new(P_WATER, "Water").qty(5).unit_incl(100).build(),
    ];
    assert_eq!(lines[0].quantity_base, 24, "2 boxes of 12 are 24 base units");

    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 76);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 95);

    // Every stocked line produced exactly one movement.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        2
    );
    // sale_items.quantity is the canonical BASE quantity; the UoM view is kept too.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity FROM sale_items WHERE sale_id='{sale_id}' AND product_id='{P_COFFEE}'"
        ))
        .await,
        24
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity_in_uom FROM sale_items WHERE sale_id='{sale_id}' AND product_id='{P_COFFEE}'"
        ))
        .await,
        2
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT uom_code_snapshot FROM sale_items WHERE sale_id='{sale_id}' AND product_id='{P_COFFEE}'"
        ))
        .await,
        "box"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_priced_line_is_allowed_when_the_sale_still_has_value() {
    // Giveaways / included items: price 0 is valid, a zero-value SALE is not.
    let db = store_with_coffee().await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 10, ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water") },
    )
    .await;

    let lines = vec![
        SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build(),
        SaleLineBuilder::new(P_WATER, "Free water").qty(1).unit_prices(0, 0).build(),
    ];
    let payload = sale_payload(lines, vec![cash_usd(500)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
        500
    );
    // The free line still moves stock.
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 9);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_with_no_value_is_refused() {
    let db = store_with_coffee().await;
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_prices(0, 0).build()];
    let err = post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(1)]))
        .await
        .unwrap_err();
    assert!(err.contains("must be positive"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_value_sales_stay_exact_in_integer_cents() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 10_000,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Bulk coffee")
        },
    )
    .await;

    // 9,999 units at $1,234.56 incl VAT.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Bulk coffee").qty(9_999).unit_incl(123_456).build()];
    let expected_total = 123_456i64 * 9_999;
    let payload = sale_payload(lines, vec![cash_usd(expected_total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (s, v, t) = (
        db.scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
        db.scalar_i64(&format!("SELECT vat_total_cents FROM sales WHERE id='{sale_id}'")).await,
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
    );
    assert_eq!(t, expected_total);
    assert_eq!(s + v, t, "no cent is lost at scale");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 1);
}

// ============================================================================
// Shift association
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sales_are_attributable_to_their_shift() {
    let db = store_with_coffee().await;
    seed_shift(&db, "shift-1", 10_000, 500_000).await;
    seed_shift(&db, "shift-2", 0, 0).await;

    for (shift, qty) in [("shift-1", 1), ("shift-1", 2), ("shift-2", 1)] {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_incl(500).build()];
        let mut payload = sale_payload(lines, vec![cash_usd(500 * qty)]);
        payload.shift_id = Some(shift.to_string());
        post_sale_with_pool(db.pool(), payload).await.unwrap();
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM sales WHERE shift_id='shift-1'").await, 2);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales WHERE shift_id='shift-2'").await, 1);
    assert_eq!(
        db.scalar_i64(
            "SELECT COALESCE(SUM(total_incl_vat_cents),0) FROM sales WHERE shift_id='shift-1'"
        )
        .await,
        1500
    );

    // Expected drawer cash for shift-1: opening + cash received − change given.
    let received = db
        .scalar_i64(
            "SELECT COALESCE(SUM(sp.amount_native_usd_cents),0)
               FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
              WHERE s.shift_id='shift-1' AND sp.method='cash_usd'",
        )
        .await;
    let change = db
        .scalar_i64(
            "SELECT COALESCE(SUM(sp.change_given_usd_cents),0)
               FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
              WHERE s.shift_id='shift-1'",
        )
        .await;
    assert_eq!(10_000 + received - change, 11_500);
}

// ============================================================================
// Transaction identity  (background for GP-A01 / WP-02)
// ============================================================================
//
// These two tests are PASSING characterizations of today's contract. They exist
// to constrain WP-02's idempotency work, not to describe a defect.
//
// Greaz has no stable checkout identity yet: db/repos/sales.ts mints a fresh
// `saleId` (and fresh item/payment ids) on every `salesRepo.post()` call, so
// the backend cannot distinguish "the cashier double-clicked" from "the next
// customer bought the same things". WP-02 must introduce that identity; see
// tests/README.md for what its regression test has to prove.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_identical_baskets_with_different_identities_both_post() {
    // GUARD AGAINST A BAD FIX: two customers buying exactly the same items are
    // two sales. Any future deduplication keyed on basket CONTENT rather than
    // on a checkout identity would swallow the second one and lose real money.
    let db = store_with_coffee().await;

    let build = || {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
        // sale_payload() mints fresh sale/item/payment ids each call, so these
        // are genuinely distinct transactions that merely look alike.
        sale_payload(lines, vec![cash_usd(1000)])
    };

    let first = build();
    let second = build();
    assert_ne!(first.sale_id, second.sale_id, "distinct transaction identities");

    let r1 = post_sale_with_pool(db.pool(), first).await.expect("first customer");
    let r2 = post_sale_with_pool(db.pool(), second).await.expect("second customer");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 2, "both sales must exist");
    assert_ne!(r1.receipt_number, r2.receipt_number, "each gets its own receipt");
    assert_eq!(r1.receipt_number, 1);
    assert_eq!(r2.receipt_number, 2);

    // Stock left the shelf twice, because it did.
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 96);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -4);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 2);

    // Both tenders were banked.
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 2);
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(amount_usd_cents_equivalent),0) FROM sale_payments").await,
        2000
    );
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(total_incl_vat_cents),0) FROM sales").await,
        2000,
        "revenue must count both sales"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_a_payload_with_the_same_primary_keys_is_rejected_and_rolls_back() {
    // SCOPE: this is protection from duplicate PRIMARY IDENTIFIERS only —
    // the `sales.id` primary key refusing a second row. It is NOT checkout
    // idempotency, and it does NOT solve the double-submit problem: the real
    // client mints a new sale_id per attempt, so a retry never reaches this
    // path. WP-02 owns the actual fix.
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(1000)]);

    // Rebuild the identical payload, reusing every identifier verbatim.
    let replay = PostSalePayload {
        sale_id: payload.sale_id.clone(),
        store_id: payload.store_id.clone(),
        cashier_user_id: payload.cashier_user_id.clone(),
        device_id: payload.device_id.clone(),
        shift_id: payload.shift_id.clone(),
        exchange_rate_id: payload.exchange_rate_id.clone(),
        exchange_rate_lbp_per_usd: payload.exchange_rate_lbp_per_usd,
        notes: payload.notes.clone(),
        cogs_method: payload.cogs_method.clone(),
        discount_cents: payload.discount_cents,
        allow_negative_inventory: payload.allow_negative_inventory,
        lines: payload
            .lines
            .iter()
            .map(|l| PostSaleLine {
                sale_item_id: l.sale_item_id.clone(),
                product_id: l.product_id.clone(),
                product_name_snapshot: l.product_name_snapshot.clone(),
                product_sku_snapshot: l.product_sku_snapshot.clone(),
                uom_code_snapshot: l.uom_code_snapshot.clone(),
                factor_num_snapshot: l.factor_num_snapshot,
                factor_den_snapshot: l.factor_den_snapshot,
                quantity_in_uom: l.quantity_in_uom,
                quantity_base: l.quantity_base,
                unit_price_excl_vat_cents: l.unit_price_excl_vat_cents,
                unit_price_incl_vat_cents: l.unit_price_incl_vat_cents,
                vat_rate_id_snapshot: l.vat_rate_id_snapshot.clone(),
                vat_rate_bps_snapshot: l.vat_rate_bps_snapshot,
                line_subtotal_excl_vat_cents: l.line_subtotal_excl_vat_cents,
                line_vat_cents: l.line_vat_cents,
                line_total_incl_vat_cents: l.line_total_incl_vat_cents,
                line_discount_cents: l.line_discount_cents,
                barcode_used_snapshot: l.barcode_used_snapshot.clone(),
                barcode_type_snapshot: l.barcode_type_snapshot.clone(),
                is_service: l.is_service,
            })
            .collect(),
        payments: payload
            .payments
            .iter()
            .map(|p| PostSalePayment {
                payment_id: p.payment_id.clone(),
                method: p.method.clone(),
                currency: p.currency.clone(),
                amount_native_usd_cents: p.amount_native_usd_cents,
                amount_native_lbp: p.amount_native_lbp,
                amount_usd_cents_equivalent: p.amount_usd_cents_equivalent,
                reference: p.reference.clone(),
            })
            .collect(),
    };

    post_sale_with_pool(db.pool(), payload).await.expect("first post succeeds");
    let err = post_sale_with_pool(db.pool(), replay)
        .await
        .expect_err("re-using the sale primary key must be refused");
    assert!(err.contains("insert sale"), "got: {err}");

    // The rejected attempt left nothing behind.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98, "stock moved once");
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2",
        "the rolled-back attempt did not consume a receipt number"
    );
}
