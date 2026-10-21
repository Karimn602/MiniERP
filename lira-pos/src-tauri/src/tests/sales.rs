// Layer C — `post_sale` against a temporary database.
//
// Every test asserts on PERSISTED rows, not on the command's return value
// alone, because persistence is what later work packages must not regress.

use crate::posting::{
    close_shift_with_pool, post_sale_with_pool, CloseShiftPayload, PostSalePayload,
    SALES_CHANNEL_COUNTER, SALES_CHANNEL_ONLINE_DELIVERY,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000c2";
const P_BREAD: &str = "00000000-0000-0000-0000-0000000000c3";
const P_DELIVERY: &str = "00000000-0000-0000-0000-0000000000c4";
/// The store's own driver, for the delivery-channel tests below. A new
/// delivery order must name an active driver of its store and be collected by
/// him (GZ-P1-1), so the channel tests need one on the books.
const D_SAMI: &str = "00000000-0000-0000-0000-00000000d0c1";

/// Close the fixture's own open shift, so a test can open one of its own.
///
/// `store_with_coffee` seeds `SHIFT_ID` because a new sale needs an open shift
/// (WP-04), and a store may hold only one (migration 009). A test that wants to
/// name its own shift retires that one first, exactly as a real handover does.
async fn close_the_fixture_shift(db: &TempDb) {
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
    .expect("close the fixture shift");
}

/// A store with one stocked product: 100 on hand at a $2.00 weighted-average
/// cost (excl VAT) / $2.22 incl.
async fn store_with_coffee() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    // Inert for every counter test, and required by the delivery-channel ones.
    seed_driver(&db, D_SAMI, "Sami").await;
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
    seed_open_shift(&db).await;
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
    seed_open_shift(&db).await;
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
    seed_open_shift(&db).await;
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
    seed_open_shift(&db).await;
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
    seed_open_shift(&db).await;
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
    seed_open_shift(&db).await;
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
    seed_open_shift(&db).await;
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
    // A purchase movement whose cost differs from the weighted average. Both
    // cost representations are written, as `post_purchase` writes them: the
    // microcent column is the rate `last_purchase` costs from, the cents column
    // its rounded mirror.
    db.exec(&format!(
        "INSERT INTO inventory_movements
           (id, store_id, product_id, movement_type, quantity_delta,
            unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
            unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents, posted_at)
         VALUES ('m-last', '{STORE_ID}', '{P_COFFEE}', 'purchase', 0, 350, 389,
                 350000000, 389000000, '2026-03-01T10:00:00.000Z')"
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
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 100, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;
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
    seed_open_shift(&db).await;
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

    // A store holds one open shift at a time (migration 009), and a sale may
    // only post into an open one, so the two shifts here run in sequence: ring
    // up shift-1, close it, open shift-2. That is also the real sequence a
    // handover produces. The fixture's own empty shift is closed first to make
    // room for shift-1 and its float.
    close_the_fixture_shift(&db).await;
    seed_shift(&db, "shift-1", 10_000, 500_000).await;
    for qty in [1, 2] {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_incl(500).build()];
        let mut payload = sale_payload(lines, vec![cash_usd(500 * qty)]);
        payload.shift_id = Some("shift-1".to_string());
        post_sale_with_pool(db.pool(), payload).await.unwrap();
    }
    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: "shift-1".to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 0,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close shift-1");
    seed_shift(&db, "shift-2", 0, 0).await;
    {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
        let mut payload = sale_payload(lines, vec![cash_usd(500)]);
        payload.shift_id = Some("shift-2".to_string());
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
// Checkout idempotency  (GP-A01)
// ============================================================================
//
// `sales.id` IS the checkout identity: the client issues one per checkout
// attempt and reuses it unchanged for every retry of that attempt, so the
// backend can tell "the cashier pressed Post twice" from "the next customer
// bought the same basket".
//
// Both halves have to hold, and both are proven below:
//
//   1. the SAME identity replayed  → exactly one financial transaction and one
//      stock effect, and the retry reconciles to the sale that already exists;
//   2. two identical baskets under DIFFERENT identities → two legitimate sales.
//
// Nothing in the implementation deduplicates on basket content, totals, or
// timing. `two_identical_baskets_with_different_identities_both_post` is the
// control test that keeps it that way.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_the_same_checkout_identity_posts_exactly_one_sale() {
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let first = sale_payload(lines, vec![cash_usd(1000)]);
    let sale_id = first.sale_id.clone();
    let retry = replay_of(&first);

    let r1 = post_sale_with_pool(db.pool(), first).await.expect("the first attempt posts");
    let r2 = post_sale_with_pool(db.pool(), retry)
        .await
        .expect("the retry must reconcile to the posted sale, not fail");

    // The retry answers with the sale that exists, so the cashier gets the
    // receipt they were owed rather than an error or a second receipt.
    assert_eq!(r2.sale_id, r1.sale_id);
    assert_eq!(r2.receipt_number, r1.receipt_number, "one checkout, one receipt number");
    assert_eq!(r2.posted_at, r1.posted_at);
    assert_eq!(r2.movement_ids, r1.movement_ids, "the same movement rows, not new ones");
    assert_eq!(r2.change_total_usd_cents, r1.change_total_usd_cents);

    // Exactly one of everything.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);

    // Money is banked once.
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(amount_usd_cents_equivalent),0) FROM sale_payments").await,
        1000
    );
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(total_incl_vat_cents),0) FROM sales").await,
        1000,
        "revenue must count the checkout once"
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        400,
        "COGS is charged once"
    );

    // Stock left the shelf once, and the books agree.
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -2);

    // The receipt sequence advanced once: a replay consumes no number.
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_checkout_identity_stays_idempotent_across_repeated_retries() {
    // A cashier hammering F5, or a client resending an answer it never saw.
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(4).unit_incl(500).build()];
    let first = sale_payload(lines, vec![cash_usd(2000)]);
    let sale_id = first.sale_id.clone();
    let template = replay_of(&first);

    let original = post_sale_with_pool(db.pool(), first).await.expect("first attempt posts");
    let original_item_id = db
        .scalar_string(&format!("SELECT id FROM sale_items WHERE sale_id='{sale_id}'"))
        .await;

    for attempt in 0..6 {
        // Alternate between a byte-for-byte replay and one carrying fresh child
        // ids: idempotency keys on the checkout identity alone.
        let retry = if attempt % 2 == 0 {
            replay_of(&template)
        } else {
            replay_of_with_new_child_ids(&template)
        };
        let r = post_sale_with_pool(db.pool(), retry)
            .await
            .unwrap_or_else(|e| panic!("retry {attempt} must reconcile, got: {e}"));
        assert_eq!(r.receipt_number, original.receipt_number, "retry {attempt}");
        assert_eq!(r.movement_ids, original.movement_ids, "retry {attempt}");
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(
        db.scalar_string(&format!("SELECT id FROM sale_items WHERE sale_id='{sale_id}'")).await,
        original_item_id,
        "the first attempt's rows are the ones that stand; retries write nothing"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 96, "stock moved once, not seven times");
    assert_eq!(movement_sum(&db, P_COFFEE).await, -4);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reusing_a_posted_checkout_identity_for_different_content_is_refused() {
    // A client that failed to retire a spent identity must not be handed a
    // receipt for a transaction nobody rang up. This is the one place content
    // is compared — to detect that reuse, never to decide two requests are the
    // same checkout.
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let first = sale_payload(lines, vec![cash_usd(1000)]);
    let identity = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.expect("first attempt posts");

    // Same identity, bigger basket.
    let mut different = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(3).unit_incl(500).build()],
        vec![cash_usd(1500)],
    );
    different.sale_id = identity.clone();
    let err = post_sale_with_pool(db.pool(), different)
        .await
        .expect_err("a spent checkout identity must not absorb different content");
    assert!(err.contains("already exists"), "got: {err}");

    // Same identity, same basket, a different tender split.
    let mut retendered = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()],
        vec![cash_usd(500), card_usd(500)],
    );
    retendered.sale_id = identity.clone();
    let err = post_sale_with_pool(db.pool(), retendered)
        .await
        .expect_err("a different tender is different content");
    assert!(err.contains("already exists"), "got: {err}");

    // Nothing moved on either rejection.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
    assert_eq!(
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{identity}'")).await,
        1000,
        "the posted sale is untouched"
    );
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2",
        "a rejected reuse consumes no receipt number"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_voided_sale_cannot_be_resurrected_by_replaying_its_identity() {
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let first = sale_payload(lines, vec![cash_usd(1000)]);
    let sale_id = first.sale_id.clone();
    let retry = replay_of(&first);
    post_sale_with_pool(db.pool(), first).await.unwrap();

    // The schema's one permitted transition (see immutability.rs).
    db.exec(&format!(
        "UPDATE sales SET status='voided', voided_at='2026-03-01T12:00:00.000Z' WHERE id='{sale_id}'"
    ))
    .await;

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a voided checkout must not re-post under its old identity");
    assert!(err.contains("voided"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_identical_baskets_with_different_identities_both_post() {
    // GUARD AGAINST A BAD FIX: two customers buying exactly the same items are
    // two sales. Any deduplication keyed on basket CONTENT rather than on the
    // checkout identity would swallow the second one and lose real money.
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
async fn a_new_checkout_identity_posts_normally_after_a_replayed_one() {
    // The next customer must be unaffected by the previous retry storm.
    let db = store_with_coffee().await;

    let first = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()],
        vec![cash_usd(1000)],
    );
    let retry = replay_of(&first);
    post_sale_with_pool(db.pool(), first).await.unwrap();
    post_sale_with_pool(db.pool(), retry).await.unwrap();

    let next = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()],
        vec![cash_usd(500)],
    );
    let r = post_sale_with_pool(db.pool(), next).await.expect("a fresh checkout posts");

    assert_eq!(r.receipt_number, 2, "the replay did not burn receipt #2");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 2);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 97);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -3);
}

// ============================================================================
// Authoritative UoM / base quantity  (GP-A02)
// ============================================================================
//
// The product's own `product_uoms` row decides the conversion. The two
// originating audit cases live in `known_defects::gp_a02_*`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_products_own_uom_factor_drives_the_movement_and_the_decrement() {
    let db = store_with_coffee().await; // 100 on hand
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_incl(6000)
        .build()];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("2 boxes of 12 is a valid sale");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 76, "2 boxes of 12 remove 24 base units");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity_delta FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        -24
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT quantity FROM sale_items WHERE sale_id='{sale_id}'")).await,
        24,
        "sale_items.quantity is the authoritative base quantity"
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT quantity_in_uom FROM sale_items WHERE sale_id='{sale_id}'"))
            .await,
        2,
        "what the cashier typed is kept alongside it"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_understated_base_quantity_is_refused_and_nothing_persists() {
    let db = store_with_coffee().await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;

    // "2 boxes, but please only take 1 piece off the shelf."
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_incl(6000)
        .raw_quantity_base(1)
        .build();
    let total = lines_total(std::slice::from_ref(&line));

    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(total)]))
        .await
        .expect_err("a base quantity that contradicts the product's UoM must be refused");
    assert!(err.contains("base quantity"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "1",
        "a refused sale consumes no receipt number"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_uom_the_product_does_not_sell_in_is_refused() {
    let db = store_with_coffee().await; // 'each' only — no 'box' row

    let line =
        SaleLineBuilder::new(P_COFFEE, "Coffee").uom("box", 12, 1).qty(1).unit_incl(6000).build();
    let total = lines_total(std::slice::from_ref(&line));
    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(total)]))
        .await
        .expect_err("a UoM the product does not sell in is not a valid pairing");
    assert!(err.contains("unit of measure"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deactivated_uom_cannot_be_sold() {
    // The register only ever offers active UoMs; the backend enforces the same.
    let db = store_with_coffee().await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;
    db.exec(&format!(
        "UPDATE product_uoms SET is_active = 0 WHERE product_id='{P_COFFEE}' AND uom_code='box'"
    ))
    .await;

    let line =
        SaleLineBuilder::new(P_COFFEE, "Coffee").uom("box", 12, 1).qty(1).unit_incl(6000).build();
    let total = lines_total(std::slice::from_ref(&line));
    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(total)]))
        .await
        .expect_err("an inactive UoM must be refused");
    assert!(err.contains("unit of measure"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_conversion_factor_in_the_payload_does_not_change_what_is_sold() {
    // A cart parked when a box held 24 pieces, posted after it was redefined as
    // 12. The payload's factor snapshot is not evidence of anything.
    let db = store_with_coffee().await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;

    // The stale cart's own arithmetic: 2 boxes × 24 = 48 base units.
    let stale =
        SaleLineBuilder::new(P_COFFEE, "Coffee").uom("box", 24, 1).qty(2).unit_incl(6000).build();
    assert_eq!(stale.quantity_base, 48, "the stale cart believes a box holds 24");
    let total = lines_total(std::slice::from_ref(&stale));
    let err = post_sale_with_pool(db.pool(), sale_payload(vec![stale], vec![cash_usd(total)]))
        .await
        .expect_err("a stale factor must not post a quantity nobody agreed to");
    assert!(err.contains("base quantity"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);

    // The same stale factor, but a base quantity that matches the DB's own
    // conversion: the sale posts, and the AUTHORITATIVE factor is persisted.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 24, 1)
        .qty(2)
        .unit_incl(6000)
        .raw_quantity_base(24)
        .build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("the quantity agrees with the DB");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        12,
        "the snapshot records the factor the goods actually shipped on"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        12
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 76);
}

// ============================================================================
// Authoritative service flag  (GP-A05)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_database_decides_whether_a_line_moves_stock_not_the_payload() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    // Stocked in the DB; the payload will claim it is a service.
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 10, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;
    // A service in the DB; the payload will claim it is stocked.
    seed_product(
        &db,
        &ProductSpec { is_service: true, ..ProductSpec::stocked(P_DELIVERY, "SKU-D1", "Delivery") },
    )
    .await;

    let lines = vec![
        SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).service(true).build(),
        SaleLineBuilder::new(P_DELIVERY, "Delivery").qty(1).unit_incl(300).service(false).build(),
    ];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("both lines are legitimate");

    // The stocked product moved despite the payload's stale service flag...
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 8);
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements
              WHERE related_sale_id='{sale_id}' AND product_id='{P_COFFEE}'"
        ))
        .await,
        1
    );
    // ...and the real service did not, despite the payload claiming otherwise.
    assert_eq!(quantity_on_hand(&db, P_DELIVERY).await, 0);
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements
              WHERE related_sale_id='{sale_id}' AND product_id='{P_DELIVERY}'"
        ))
        .await,
        0
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        1,
        "one movement for the whole sale"
    );
    assert_eq!(movement_sum(&db, P_COFFEE).await + 10, quantity_on_hand(&db, P_COFFEE).await);
}

// ============================================================================
// Line / header financial reconciliation  (GP-A06)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_internally_inconsistent_line_is_refused_and_nothing_persists() {
    let db = store_with_coffee().await;

    // 900 + 150 ≠ 1000.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(2)
        .unit_incl(500)
        .raw_line_totals(900, 150, 1000)
        .build();
    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(1000)]))
        .await
        .expect_err("a line whose parts do not sum must be refused");
    assert!(err.contains("does not reconcile"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_charging_vat_at_an_exempt_rate_is_refused() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 50,
            vat_rate_id: VAT_EXEMPT_ID,
            ..ProductSpec::stocked(P_BREAD, "SKU-B1", "Bread")
        },
    )
    .await;

    let line = SaleLineBuilder::new(P_BREAD, "Bread")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(2)
        .unit_incl(150)
        .raw_line_totals(280, 20, 300)
        .build();
    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(300)]))
        .await
        .expect_err("an exempt line cannot carry VAT");
    assert!(err.contains("exempt"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(quantity_on_hand(&db, P_BREAD).await, 50);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_valid_taxable_line_and_a_valid_exempt_line_both_post() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
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

    // The decomposition the register actually sends: the excl-VAT part is
    // stripped from the line total, so the parts sum exactly.
    let taxable_total = 1500;
    let taxable_subtotal = strip_vat(taxable_total, VAT_STD_BPS);
    let taxable = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(3)
        .unit_incl(500)
        .raw_line_totals(taxable_subtotal, taxable_total - taxable_subtotal, taxable_total)
        .build();
    let exempt = SaleLineBuilder::new(P_BREAD, "Bread")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(4)
        .unit_incl(150)
        .build();

    let lines = vec![taxable, exempt];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("both decompositions are legitimate");

    let (s, v, t) = (
        db.scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM sales WHERE id='{sale_id}'"))
            .await,
        db.scalar_i64(&format!("SELECT vat_total_cents FROM sales WHERE id='{sale_id}'")).await,
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
    );
    assert_eq!(s + v, t);
    assert_eq!(t, 1500 + 600);
    assert_eq!(v, taxable_total - taxable_subtotal, "only the taxable line carries VAT");
}

// ============================================================================
// Discount reconciliation  (GP-A07)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_discount_that_misses_the_header_discount_is_refused() {
    let db = store_with_coffee().await;

    let line = SaleLineBuilder::new(P_COFFEE, "Coffee").qty(4).unit_incl(500).discount(30).build();
    let total = lines_total(std::slice::from_ref(&line));
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.discount_cents = 100; // the header claims $1.00, the line 30¢

    let err = post_sale_with_pool(db.pool(), payload)
        .await
        .expect_err("a discount that does not reconcile must be refused");
    assert!(err.contains("Discount does not reconcile"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_discount_sale_reconciles() {
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(1000)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("no discount is the common case");

    assert_eq!(
        db.scalar_i64(&format!("SELECT discount_cents FROM sales WHERE id='{sale_id}'")).await,
        0
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(line_discount_cents),0) FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_discount_with_an_awkward_remainder_reconciles_to_the_cent() {
    // The allocation `lib/discount.ts::allocateLineDiscounts` produces for a
    // header discount of 101¢ over line totals of 1000/700/300 (pre-total 2000):
    //   floor(101 × 1000/2000) = 50, floor(101 × 700/2000) = 35,
    //   floor(101 × 300/2000) = 15  → 100, and the leftover cent goes to the
    // largest line → 51/35/15.
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    for (id, sku, name) in
        [(P_COFFEE, "SKU-C1", "Coffee"), (P_WATER, "SKU-W1", "Water"), (P_BREAD, "SKU-B1", "Bread")]
    {
        seed_product(
            &db,
            &ProductSpec { quantity_on_hand: 100, ..ProductSpec::stocked(id, sku, name) },
        )
        .await;
    }

    let allocations = [51i64, 35, 15];
    assert_eq!(allocations.iter().sum::<i64>(), 101);

    let mut lines = Vec::new();
    for (i, (product, name, unit, qty)) in
        [(P_COFFEE, "Coffee", 500i64, 2i64), (P_WATER, "Water", 700, 1), (P_BREAD, "Bread", 300, 1)]
            .into_iter()
            .enumerate()
    {
        let discounted = unit * qty - allocations[i];
        let subtotal = strip_vat(discounted, VAT_STD_BPS);
        lines.push(
            SaleLineBuilder::new(product, name)
                .qty(qty)
                .unit_incl(unit)
                .discount(allocations[i])
                .raw_line_totals(subtotal, discounted - subtotal, discounted)
                .build(),
        );
    }

    let total = lines_total(&lines);
    assert_eq!(total, 2000 - 101);
    let mut payload = sale_payload(lines, vec![cash_usd(total)]);
    payload.discount_cents = 101;
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("an exact allocation must post");

    let header =
        db.scalar_i64(&format!("SELECT discount_cents FROM sales WHERE id='{sale_id}'")).await;
    let line_sum = db
        .scalar_i64(&format!(
            "SELECT COALESCE(SUM(line_discount_cents),0) FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await;
    assert_eq!(line_sum, header, "SUM(line_discount_cents) must equal sales.discount_cents");
    assert_eq!(header, 101);

    // The header still reconciles to its post-discount lines.
    let (s, v, t) = (
        db.scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM sales WHERE id='{sale_id}'"))
            .await,
        db.scalar_i64(&format!("SELECT vat_total_cents FROM sales WHERE id='{sale_id}'")).await,
        db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM sales WHERE id='{sale_id}'")).await,
    );
    assert_eq!(s + v, t);
    assert_eq!(t, 1899);
}

// ============================================================================
// Replay conflict detection  (GP-A01, WP-02 correction)
// ============================================================================
//
// Idempotency is keyed on the checkout identity ALONE — never on basket
// content, which would swallow a second customer buying the same things (see
// `two_identical_baskets_with_different_identities_both_post`).
//
// Content is compared for the opposite reason: to catch one identity reused
// for a DIFFERENT transaction. `sale_replay_matches_existing` compares the
// canonical business meaning of the request against the persisted rows —
// attribution, locked rate, COGS method, header money, every line's price,
// VAT code and VAT/discount allocation, and every tender's method, currency
// and native amount. Matching aggregate totals is not enough: a cash sale and
// a card sale for the same amount are different transactions.
//
// Every test below proves the rejected replay changed NOTHING.

/// Assert a rejected replay left the ledger exactly as the first post did.
async fn assert_replay_changed_nothing(db: &TempDb, sale_id: &str, expected_qoh: i64) {
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1, "no second sale");
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sale_payments WHERE sale_id='{sale_id}'")).await,
        1,
        "no additional payment row"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        1,
        "no additional stock movement"
    );
    assert_eq!(quantity_on_hand(db, P_COFFEE).await, expected_qoh, "QOH unchanged");
    assert_eq!(movement_sum(db, P_COFFEE).await, expected_qoh - 100);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2",
        "no additional receipt number consumed"
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT receipt_number FROM sales WHERE id='{sale_id}'")).await,
        1,
        "the original sale is unchanged"
    );
}

/// Post one $10.00 cash sale; hand back the database and the original payload.
async fn one_posted_cash_sale() -> (TempDb, PostSalePayload) {
    let db = store_with_coffee().await;
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(1000)]);
    post_sale_with_pool(db.pool(), replay_of(&payload)).await.expect("first post");
    (db, payload)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_of_the_identical_canonical_request_is_idempotent() {
    let (db, original) = one_posted_cash_sale().await;

    // Child identifiers are regenerated, as a real client does; they are
    // request noise and must not be compared.
    let retry = replay_of_with_new_child_ids(&original);
    let r = post_sale_with_pool(db.pool(), retry).await.expect("a true retry reconciles");

    assert_eq!(r.sale_id, original.sale_id);
    assert_eq!(r.receipt_number, 1);
    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_swaps_cash_for_card_is_a_conflict() {
    // Same identity, same basket, same money — but the drawer and the card
    // settlement are different transactions.
    let (db, original) = one_posted_cash_sale().await;

    let mut retry = replay_of(&original);
    retry.payments = vec![card_usd(1000)];

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("changing the tender type must not be accepted as a retry");
    assert!(err.contains("different tender"), "got: {err}");

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT method FROM sale_payments WHERE sale_id='{}'",
            original.sale_id
        ))
        .await,
        "cash_usd",
        "the posted tender is untouched"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changes_the_tender_currency_or_native_amount_is_a_conflict() {
    let db = store_with_coffee().await;

    // Pay 895,000 LBP, worth $10.00 at the locked rate.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let original = sale_payload(lines, vec![cash_lbp(895_000)]);
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // Same USD-equivalent, but tendered as USD cash instead of lira.
    let mut retry = replay_of(&original);
    retry.payments = vec![cash_usd(1000)];
    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a different tender currency is a different transaction");
    assert!(err.contains("different tender"), "got: {err}");

    // Same currency, a different number of lira actually handed over. The tender
    // is built through `cash_lbp` so its USD equivalent is the one the locked
    // rate gives for 900,000 lira: an internally CONSISTENT tender that is
    // nevertheless a different transaction, which is what the replay comparison
    // has to catch. (A payload claiming 900,000 lira at $10.00 would be refused
    // one step earlier, by the WP-04 tender check, and would prove nothing
    // about replay detection.)
    let mut retry = replay_of(&original);
    retry.payments = vec![cash_lbp(900_000)];
    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a different native amount is a different transaction");
    assert!(err.contains("different tender"), "got: {err}");

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changes_a_payment_reference_is_a_conflict() {
    let db = store_with_coffee().await;
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut original = sale_payload(lines, vec![card_usd(1000)]);
    original.payments[0].reference = Some("card ****4321".to_string());
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    let mut retry = replay_of(&original);
    retry.payments[0].reference = Some("card ****9999".to_string());

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a different card settled this, so it is a different transaction");
    assert!(err.contains("different tender"), "got: {err}");

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changes_the_exchange_rate_is_a_conflict() {
    let db = store_with_coffee().await;
    seed_exchange_rate_at(&db, "rate-2", 100_000).await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let original = sale_payload(lines, vec![cash_usd(1000)]);
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // The rate is LOCKED at sale time, so a replay carrying a different one is
    // not the same transaction even though the USD money is identical.
    let mut retry = replay_of(&original);
    retry.exchange_rate_lbp_per_usd = 100_000;
    retry.exchange_rate_id = "rate-2".to_string();

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("the locked rate must match");
    assert!(err.contains("different exchange rate"), "got: {err}");

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT exchange_rate_lbp_per_usd FROM sales WHERE id='{}'",
            original.sale_id
        ))
        .await,
        RATE_LBP_PER_USD,
        "the locked rate is untouched"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changes_the_cogs_method_is_a_conflict() {
    let (db, original) = one_posted_cash_sale().await; // posted weighted_average

    let mut retry = replay_of(&original);
    retry.cogs_method = "last_purchase".to_string();

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("the costing basis is part of the transaction");
    assert!(err.contains("different COGS method"), "got: {err}");

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
    assert_eq!(
        db.scalar_string(&format!("SELECT cogs_method FROM sales WHERE id='{}'", original.sale_id))
            .await,
        "weighted_average"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_reprices_lines_but_keeps_the_total_is_a_conflict() {
    // The aggregate total is identical, so a coarse comparison would wave this
    // through. A different split of revenue between products is a different
    // sale — different per-product margin, different reports.
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
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

    let original = sale_payload(
        vec![
            SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(600).build(),
            SaleLineBuilder::new(P_WATER, "Water").qty(1).unit_incl(400).build(),
        ],
        vec![cash_usd(1000)],
    );
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // Move $1.00 of revenue from the water line onto the coffee line.
    let mut retry = replay_of(&original);
    retry.lines = vec![
        SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(700).build(),
        SaleLineBuilder::new(P_WATER, "Water").qty(1).unit_incl(300).build(),
    ];
    assert_eq!(lines_total(&retry.lines), 1000, "the header total is unchanged");

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("per-line repricing must not hide behind an unchanged total");
    assert!(err.contains("different basket line"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 99);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 99);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_total_incl_vat_cents FROM sale_items
              WHERE sale_id='{}' AND product_id='{P_COFFEE}'",
            original.sale_id
        ))
        .await,
        600,
        "the posted line prices are untouched"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_moves_the_discount_between_lines_is_a_conflict() {
    // Header discount and header total both unchanged; only the per-line
    // allocation differs. That is still a different set of persisted lines.
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
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

    let build = |coffee_disc: i64, water_disc: i64| {
        let mut p = sale_payload(
            vec![
                SaleLineBuilder::new(P_COFFEE, "Coffee")
                    .qty(1)
                    .unit_incl(600)
                    .discount(coffee_disc)
                    .build(),
                SaleLineBuilder::new(P_WATER, "Water")
                    .qty(1)
                    .unit_incl(400)
                    .discount(water_disc)
                    .build(),
            ],
            vec![cash_usd(1000)],
        );
        p.discount_cents = coffee_disc + water_disc;
        p
    };

    let original = build(60, 40);
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // The same $1.00 discount, allocated differently across the two lines.
    let mut retry = build(40, 60);
    retry.sale_id = original.sale_id.clone();
    assert_eq!(retry.discount_cents, original.discount_cents);

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a different discount allocation is a different transaction");
    assert!(err.contains("different basket line"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_discount_cents FROM sale_items
              WHERE sale_id='{}' AND product_id='{P_COFFEE}'",
            original.sale_id
        ))
        .await,
        60
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changes_the_vat_code_is_a_conflict() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 100, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;

    // An exempt line: $6.00 with no VAT.
    let original = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee")
            .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
            .qty(1)
            .unit_incl(600)
            .build()],
        vec![cash_usd(600)],
    );
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // Same cash, same basket — but now claimed under the standard VAT code,
    // which changes what the shop owes the tax authority.
    let mut retry = replay_of(&original);
    retry.lines[0].vat_rate_id_snapshot = VAT_STD_ID.to_string();

    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a different VAT code is a different transaction");
    assert!(err.contains("different basket line"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT vat_rate_bps_snapshot FROM sale_items WHERE sale_id='{}'",
            original.sale_id
        ))
        .await,
        VAT_EXEMPT_BPS
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_that_changes_shift_or_cashier_attribution_is_a_conflict() {
    let db = store_with_coffee().await;
    close_the_fixture_shift(&db).await;
    seed_shift(&db, "shift-1", 0, 0).await;
    // shift-2 only ever appears in a payload that is refused, so it is the
    // store's closed shift rather than a second open one (migration 009).
    seed_closed_shift(&db, "shift-2", 0, 0).await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut original = sale_payload(lines, vec![cash_usd(1000)]);
    original.shift_id = Some("shift-1".to_string());
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // Re-attributing a posted sale to another shift would move cash between
    // two drawer counts.
    let mut retry = replay_of(&original);
    retry.shift_id = Some("shift-2".to_string());
    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("shift attribution is part of the transaction");
    assert!(err.contains("different shift"), "got: {err}");

    // The same goes for who is named on the receipt.
    let mut retry = replay_of(&original);
    retry.cashier_user_id = None;
    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("cashier attribution is part of the transaction");
    assert!(err.contains("different cashier"), "got: {err}");

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
    assert_eq!(
        db.scalar_string(&format!("SELECT shift_id FROM sales WHERE id='{}'", original.sale_id))
            .await,
        "shift-1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_and_payment_order_alone_never_makes_a_retry_fail() {
    // Persisted query order need not match payload order, so the comparison is
    // a multiset. A reordered retry is still the same checkout.
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
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

    let original = sale_payload(
        vec![
            SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(600).build(),
            SaleLineBuilder::new(P_WATER, "Water").qty(1).unit_incl(400).build(),
        ],
        vec![cash_usd(700), card_usd(300)],
    );
    let first = post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    let mut retry = replay_of_with_new_child_ids(&original);
    retry.lines.reverse();
    retry.payments.reverse();

    let r = post_sale_with_pool(db.pool(), retry)
        .await
        .expect("a reordered retry is still the same checkout");
    assert_eq!(r.receipt_number, first.receipt_number);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 99);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 99);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_lines_are_compared_as_a_multiset_not_a_set() {
    // Two identical lines must not collapse into one during comparison: a
    // retry that drops one of them is a different basket.
    let db = store_with_coffee().await;

    let original = sale_payload(
        vec![
            SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build(),
            SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build(),
        ],
        vec![cash_usd(1000)],
    );
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // A faithful retry of both lines reconciles.
    let r = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
        .await
        .expect("the duplicate-line basket replays cleanly");
    assert_eq!(r.receipt_number, 1);

    // Dropping one of them does not.
    let mut retry = replay_of(&original);
    retry.lines.truncate(1);
    retry.payments = vec![cash_usd(500)];
    let err = post_sale_with_pool(db.pool(), retry)
        .await
        .expect_err("a shorter basket is a different transaction");
    assert!(err.contains("different"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
}

// ============================================================================
// GZ-WP0-08 — a restored checkout must replay the payload it was SENT
// ============================================================================
//
// The register persists an open cart to localStorage, and from the first Post
// press that cart carries its `checkoutId` — the `sale_id` below. So a cart
// that comes back from storage still holding one is a payment whose answer
// never arrived: the app died between the request and the response, and whether
// the sale committed is knowable only by replaying that identity.
//
// WP-0 then added a restore-time revalidation that re-prices every restored
// line against the current catalog, to stop a cart parked across a price rise
// posting at yesterday's money (GZ-WP0-05). Applied to an unresolved checkout
// that is a defect, not a feature, and these two tests are its proof. The
// SAME committed sale, the SAME identity, one price rise, two outcomes:
//
//   * replay the frozen payload  → the original receipt comes back, nothing is
//     written, the customer is charged once.
//   * replay the revalidated one → CONFLICT. The sale that exists is not
//     returned, and the one mechanism built to recover a lost response has
//     been disabled by the one built to keep prices current.
//
// `lib/cartRestore.ts::revalidateRestoredCarts` is what keeps the first case
// the one that happens: a restored cart with a `checkoutId` is frozen and not
// repriced, and the register locks it against editing.

/// Assert the backend refused this replay as a CONFLICT over the sale that
/// already posted under the identity — the state in which the cashier holds a
/// refusal for a sale that exists and cannot reach it.
fn assert_conflict_over_the_committed_sale(err: &str, sale_id: &str) {
    assert!(err.contains(sale_id), "the refusal must name the sale; got: {err}");
    assert!(err.contains("already exists"), "got: {err}");
    assert!(err.contains("Start a new checkout"), "got: {err}");
}

/// The same cart re-rung at a new catalog price — what the unguarded restore
/// path handed to a retry. Only the per-unit price and the tender move; the
/// checkout identity is the same one the committed sale posted under.
fn repriced_replay(
    original: &PostSalePayload,
    new_unit_incl: i64,
    tender: i64,
) -> PostSalePayload {
    let mut retry = replay_of_with_new_child_ids(original);
    retry.lines =
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(new_unit_incl).build()];
    retry.payments = vec![cash_usd(tender)];
    retry
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frozen_restored_checkout_replays_onto_the_sale_that_already_committed() {
    // The sale committed; the client never saw the answer.
    let (db, original) = one_posted_cash_sale().await;
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98, "the first post moved stock");

    // The cashier reopens the register. The cart comes back frozen, so the
    // retry carries the payload that was sent, to the cent.
    let retry = replay_of_with_new_child_ids(&original);
    let r = post_sale_with_pool(db.pool(), retry)
        .await
        .expect("a frozen restored checkout must reconcile, not conflict");

    // One sale, its own receipt, and no second charge of any kind.
    assert_eq!(r.sale_id, original.sale_id, "the committed sale is returned");
    assert_eq!(r.receipt_number, 1, "the original receipt, not a new one");
    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revalidating_an_unresolved_checkout_would_break_its_replay() {
    let (db, original) = one_posted_cash_sale().await;

    // Coffee was CUT from $5.00 to $4.50 while the register was down. This is
    // exactly what `revalidateRestoredLines` would write onto the restored
    // line, and on a price cut the register's own checks wave it through — the
    // $10.00 already in the payment box simply becomes $1.00 of change. So the
    // request reaches the backend, and the per-line comparison is all that is
    // left between the customer and a second charge.
    let err = post_sale_with_pool(db.pool(), repriced_replay(&original, 450, 1000))
        .await
        .expect_err("a repriced replay is a conflict — which is why carts are frozen");
    // A conflict, not a reconciliation. The first material difference the
    // backend reaches is the header subtotal; which field it names matters far
    // less than the fact that the identity no longer resolves to its sale.
    assert_conflict_over_the_committed_sale(&err, &original.sale_id);
    assert!(err.contains("different subtotal"), "got: {err}");

    // A price RISE breaks the retry one step earlier and just as completely:
    // the restored tender no longer covers the revalidated total, so the sale
    // is refused as underpaid. Either way the identity can no longer reach the
    // sale it names.
    let err = post_sale_with_pool(db.pool(), repriced_replay(&original, 550, 1000))
        .await
        .expect_err("a revalidated rise cannot be paid for by the restored tender");
    assert!(err.contains("Underpayment"), "got: {err}");

    // And "fixing" that underpayment at the keyboard only moves the refusal
    // back to the conflict, because the basket is still not the one that
    // posted.
    let err = post_sale_with_pool(db.pool(), repriced_replay(&original, 550, 1100))
        .await
        .expect_err("topping up the tender does not make it the same transaction");
    assert_conflict_over_the_committed_sale(&err, &original.sale_id);

    // The damage is not that the retry failed. It is that the cashier is now
    // holding a refusal for a sale that DID post, with no way to reconcile it
    // and every reason to ring the order up again.
    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_price_incl_vat_cents FROM sale_items WHERE sale_id='{}'",
            original.sale_id
        ))
        .await,
        500,
        "the committed sale still stands at the price it was rung at"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frozen_replay_reconciles_however_many_times_the_cashier_presses_post() {
    // A locked cart stays locked until a retry succeeds or the attempt is
    // discarded, so Post may be pressed repeatedly. Every press must land on
    // the same receipt.
    let (db, original) = one_posted_cash_sale().await;

    for attempt in 1..=4 {
        let r = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
            .await
            .unwrap_or_else(|e| panic!("retry {attempt} must reconcile: {e}"));
        assert_eq!(r.sale_id, original.sale_id, "retry {attempt}");
        assert_eq!(r.receipt_number, 1, "retry {attempt}");
    }

    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
}

// ============================================================================
// WP-1 — the refusal contract, and what a replay must never duplicate
// ============================================================================
//
// `PostSaleFailure` tells the client, in one boolean, that the backend reached
// a verdict and committed nothing. The register treats that as PROOF: it hands
// the cart back to be edited and re-posted, rather than locking it for
// reconciliation. So the proof had better hold.
//
// It rests on one structural fact — `post_sale_tx` performs `tx.commit()` as
// its last fallible operation and returns `Ok` immediately after — and these
// tests check the CONSEQUENCE rather than the shape: for a representative
// refusal of each kind, nothing whatsoever is left in the database.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_kind_of_refusal_leaves_the_database_completely_untouched() {
    // One database, several refusals in a row, each of a different kind, with
    // the invariant re-checked after every one. If any refusal could leave a
    // partial write, the register telling the cashier "edit it and post again"
    // would build a second sale on top of that debris.
    let db = store_with_coffee().await;

    let checks: Vec<(&str, PostSalePayload)> = vec![
        (
            "more stock than exists",
            sale_payload(
                vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(5000).unit_incl(500).build()],
                vec![cash_usd(2_500_000)],
            ),
        ),
        (
            "a product that is not there",
            sale_payload(
                vec![SaleLineBuilder::new("no-such-product", "Ghost").qty(1).unit_incl(500).build()],
                vec![cash_usd(500)],
            ),
        ),
        (
            "tender that does not cover the total",
            sale_payload(
                vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()],
                vec![cash_usd(100)],
            ),
        ),
        (
            "a sale with no value at all",
            sale_payload(
                vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(0).build()],
                vec![cash_usd(0)],
            ),
        ),
    ];

    for (what, payload) in checks {
        post_sale_with_pool(db.pool(), payload)
            .await
            .expect_err(what);

        assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0, "{what}: no sale row");
        assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0, "{what}: no line");
        assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0, "{what}: no payment");
        assert_eq!(
            db.count("SELECT COUNT(*) FROM inventory_movements").await,
            0,
            "{what}: no stock movement"
        );
        assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "{what}: stock untouched");
        assert_eq!(
            db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'")
                .await,
            "1",
            "{what}: no receipt number consumed"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_sale_can_be_corrected_and_posted_under_the_same_identity() {
    // The behaviour the refusal contract licenses. The register keeps the cart
    // editable after a proven refusal, so a corrected basket arrives under the
    // identity that was refused — and it must post, exactly once.
    let db = store_with_coffee().await;

    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(5000).unit_incl(500).build()],
        vec![cash_usd(2_500_000)],
    );
    let identity = payload.sale_id.clone();

    post_sale_with_pool(db.pool(), replay_of(&payload))
        .await
        .expect_err("5000 units out of a 100-unit stock must be refused");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);

    // The quantity is fixed. Same identity, different basket — and that is NOT
    // a conflict, because nothing ever posted under it.
    payload.lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    payload.payments = vec![cash_usd(1000)];
    let r = post_sale_with_pool(db.pool(), payload)
        .await
        .expect("a corrected basket under a refused identity must post");

    assert_eq!(r.sale_id, identity);
    assert_eq!(r.receipt_number, 1, "the refusals consumed no receipt number");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_response_replayed_creates_no_second_money_anywhere() {
    // WP-1 stated as an accounting assertion. The sale committed, the answer
    // was lost, the register replays the frozen request — and every figure the
    // shop is judged on is unchanged.
    let (db, original) = one_posted_cash_sale().await;

    let movements_before = movement_sum(&db, P_COFFEE).await;
    let cash_before = db
        .scalar_i64("SELECT COALESCE(SUM(amount_native_usd_cents), 0) FROM sale_payments")
        .await;
    let revenue_before = db
        .scalar_i64("SELECT COALESCE(SUM(total_incl_vat_cents), 0) FROM sales WHERE status='posted'")
        .await;
    let vat_before = db
        .scalar_i64("SELECT COALESCE(SUM(vat_total_cents), 0) FROM sales WHERE status='posted'")
        .await;

    // Three retries, as a worried cashier would.
    for attempt in 1..=3 {
        let r = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
            .await
            .unwrap_or_else(|e| panic!("retry {attempt}: {e}"));
        assert_eq!(r.sale_id, original.sale_id);
        assert_eq!(r.receipt_number, 1);
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1, "one sale");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_items WHERE sale_id='{}'",
            original.sale_id
        ))
        .await,
        1,
        "one line"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_payments WHERE sale_id='{}'",
            original.sale_id
        ))
        .await,
        1,
        "one cash receipt"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{}'",
            original.sale_id
        ))
        .await,
        1,
        "one stock movement"
    );
    assert_eq!(movement_sum(&db, P_COFFEE).await, movements_before, "stock unchanged");
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(amount_native_usd_cents), 0) FROM sale_payments").await,
        cash_before,
        "drawer unchanged"
    );
    assert_eq!(
        db.scalar_i64(
            "SELECT COALESCE(SUM(total_incl_vat_cents), 0) FROM sales WHERE status='posted'"
        )
        .await,
        revenue_before,
        "revenue unchanged"
    );
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(vat_total_cents), 0) FROM sales WHERE status='posted'")
            .await,
        vat_before,
        "output VAT unchanged"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_reconciles_after_its_shift_has_been_closed() {
    // The morning-after case, and the reason the register may replay with no
    // open shift of its own. The sale committed into last night's shift, the
    // answer was lost, and the shift has since been closed and counted. The
    // replay still resolves on the identity, because the shift check sits
    // AFTER the idempotency block (the WP-04 ordering).
    let (db, original) = one_posted_cash_sale().await;
    close_the_fixture_shift(&db).await;

    let r = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
        .await
        .expect("a replay must resolve even once its shift is closed");

    assert_eq!(r.sale_id, original.sale_id);
    assert_eq!(r.receipt_number, 1);
    assert_replay_changed_nothing(&db, &original.sale_id, 98).await;
}

// ============================================================================
// WP-4 — the sales channel
// ============================================================================
//
// One column recording where an order came from. The tests below are mostly
// about what it must NOT do: it must not settle anything, must not move
// between the two reported figures after the fact, and must not let a replay
// re-attribute revenue.

/// A sale on a named channel.
///
/// A COUNTER order is tendered at the till. A DELIVERY order is not: since
/// GZ-P1-1 the backend requires a new one to name an active driver of its store
/// and to be collected by him in full, so this builder gives the delivery
/// channel the only shape the shop actually operates. These tests are about the
/// channel COLUMN — attribution, immutability, replay, reconciliation — and
/// each keeps asserting exactly what it did before.
fn channel_sale(channel: &str) -> PostSalePayload {
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    if channel == SALES_CHANNEL_ONLINE_DELIVERY {
        return delivery_payload(lines, D_SAMI, 0);
    }
    let mut p = sale_payload(lines, vec![cash_usd(1000)]);
    p.channel = channel.to_string();
    p
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_counter_sale_and_an_online_sale_both_post_and_are_attributed() {
    let db = store_with_coffee().await;

    let counter = channel_sale(SALES_CHANNEL_COUNTER);
    let online = channel_sale(SALES_CHANNEL_ONLINE_DELIVERY);
    post_sale_with_pool(db.pool(), replay_of(&counter)).await.expect("counter sale");
    post_sale_with_pool(db.pool(), replay_of(&online)).await.expect("online sale");

    assert_eq!(
        db.scalar_string(&format!("SELECT channel FROM sales WHERE id='{}'", counter.sale_id))
            .await,
        "counter"
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT channel FROM sales WHERE id='{}'", online.sale_id))
            .await,
        "online_delivery"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_online_order_moves_stock_and_is_vat_rated_exactly_like_a_counter_one() {
    // The channel changes nothing about the GOODS: same inventory movement,
    // same VAT, same snapshots — which is the premise of entering WhatsApp
    // orders on the till rather than integrating a platform.
    //
    // What it does change is who holds the money. A delivery order is settled
    // by the driver who carries it, so the tender is a `driver_collection` and
    // no drawer figure moves (WP-6, and enforced by the backend since
    // GZ-P1-1). That is asserted here rather than left implied.
    let db = store_with_coffee().await;

    let online = channel_sale(SALES_CHANNEL_ONLINE_DELIVERY);
    post_sale_with_pool(db.pool(), replay_of(&online)).await.expect("post");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98, "stock moved");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{}'",
            online.sale_id
        ))
        .await,
        1
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT vat_total_cents FROM sales WHERE id='{}'",
            online.sale_id
        ))
        .await,
        100,
        "VAT charged the same way (50c per unit, twice)"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_payments
              WHERE sale_id='{}' AND method='driver_collection'",
            online.sale_id
        ))
        .await,
        1,
        "and settled by the driver who carries it, not at the till"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_payments
              WHERE sale_id='{}' AND method IN ('cash_usd','cash_lbp')",
            online.sale_id
        ))
        .await,
        0,
        "no drawer cash for an order nobody paid at the counter"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unpaid_online_order_is_refused_like_any_other_unpaid_order() {
    // THE rule that keeps the channel from becoming a payment method. Marking
    // an order "Online" buys it no credit: no cash row is invented for it and
    // no receivable is raised, so it is refused for being unpaid exactly as a
    // counter order would be.
    let db = store_with_coffee().await;

    let mut online = channel_sale(SALES_CHANNEL_ONLINE_DELIVERY);
    online.payments = vec![];
    let err = post_sale_with_pool(db.pool(), online)
        .await
        .expect_err("an online order with no tender must not post");
    assert!(err.contains("at least one payment"), "got: {err}");

    let mut underpaid = channel_sale(SALES_CHANNEL_ONLINE_DELIVERY);
    underpaid.payments = vec![cash_usd(400)];
    let err = post_sale_with_pool(db.pool(), underpaid)
        .await
        .expect_err("an underpaid online order must not post");
    assert!(err.contains("Underpayment"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_payload_with_no_channel_field_at_all_posts_as_counter() {
    // Backwards compatibility ON THE WIRE. What could break here is
    // `#[serde(default)]`, not the constant behind it, so the payload is built
    // as a pre-WP-4 client would actually send it — a JSON object with no
    // `channel` key at all — and decoded through the real `Deserialize`.
    let db = store_with_coffee().await;

    let sale_id = uuid();
    let item_id = uuid();
    let payment_id = uuid();
    let json = serde_json::json!({
        "saleId": sale_id,
        "storeId": STORE_ID,
        "cashierUserId": USER_ID,
        "deviceId": null,
        "shiftId": SHIFT_ID,
        "exchangeRateId": RATE_ID,
        "exchangeRateLbpPerUsd": RATE_LBP_PER_USD,
        "notes": null,
        "cogsMethod": "weighted_average",
        "discountCents": 0,
        "allowNegativeInventory": false,
        "lines": [{
            "saleItemId": item_id,
            "productId": P_COFFEE,
            "productNameSnapshot": "Coffee",
            "productSkuSnapshot": null,
            "uomCodeSnapshot": "each",
            "factorNumSnapshot": 1,
            "factorDenSnapshot": 1,
            "quantityInUom": 2,
            "quantityBase": 2,
            "unitPriceExclVatCents": 450,
            "unitPriceInclVatCents": 500,
            "vatRateIdSnapshot": VAT_STD_ID,
            "vatRateBpsSnapshot": VAT_STD_BPS,
            "lineSubtotalExclVatCents": 901,
            "lineVatCents": 99,
            "lineTotalInclVatCents": 1000,
            "lineDiscountCents": 0,
            "barcodeUsedSnapshot": null,
            "barcodeTypeSnapshot": null,
            "isService": false,
        }],
        "payments": [{
            "paymentId": payment_id,
            "method": "cash_usd",
            "currency": "USD",
            "amountNativeUsdCents": 1000,
            "amountNativeLbp": 0,
            "amountUsdCentsEquivalent": 1000,
            "reference": null,
        }],
    });
    assert!(json.get("channel").is_none(), "the key is genuinely absent");

    let decoded: PostSalePayload =
        serde_json::from_value(json).expect("a payload without a channel must still decode");
    assert_eq!(decoded.channel, "counter");

    post_sale_with_pool(db.pool(), decoded).await.expect("post");
    assert_eq!(
        db.scalar_string(&format!("SELECT channel FROM sales WHERE id='{sale_id}'")).await,
        "counter"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_channel_is_refused_before_a_receipt_number_is_consumed() {
    // Checked in the application, not only at the CHECK constraint: a typo'd
    // channel would otherwise drop a sale out of BOTH reported figures while
    // still counting in the overall total, so the parts would stop summing to
    // the whole with nothing to show why.
    let db = store_with_coffee().await;

    for bad in ["phone", "COUNTER", "", "online", "counter "] {
        let err = post_sale_with_pool(db.pool(), channel_sale(bad))
            .await
            .unwrap_err();
        assert!(err.contains("Unknown sales channel"), "{bad}: got {err}");
        assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0, "{bad}: nothing written");
        assert_eq!(
            db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'")
                .await,
            "1",
            "{bad}: no receipt number consumed"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_keeps_the_original_channel_and_a_changed_one_is_a_conflict() {
    // The channel is canonical business content, so a retry that arrives with
    // a different channel is refused LOUDLY rather than accepted and silently
    // ignored. Revenue cannot move between the two figures the owner reads
    // against each other.
    let db = store_with_coffee().await;
    // Counter → delivery is the direction tested, because it isolates the
    // CHANNEL comparison: the re-labelled retry carries no driver and no fee,
    // so nothing else about it is incoherent and the conflict is the only thing
    // that can refuse it. It also proves the ordering — the replay comparison
    // runs before GZ-P1-1's delivery-shape rule, so a conflict is reported as a
    // conflict rather than as a shape complaint.
    let original = channel_sale(SALES_CHANNEL_COUNTER);
    post_sale_with_pool(db.pool(), replay_of(&original)).await.expect("first post");

    // A faithful retry reconciles.
    let r = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
        .await
        .expect("a true retry must reconcile");
    assert_eq!(r.sale_id, original.sale_id);
    assert_eq!(r.receipt_number, 1);

    // The same basket under the same identity, re-labelled, does not.
    let mut switched = replay_of_with_new_child_ids(&original);
    switched.channel = SALES_CHANNEL_ONLINE_DELIVERY.to_string();
    let err = post_sale_with_pool(db.pool(), switched)
        .await
        .expect_err("a replay may not re-attribute the sale");
    assert!(err.contains("different sales channel"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT channel FROM sales WHERE id='{}'",
            original.sale_id
        ))
        .await,
        "counter",
        "the posted attribution stands"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sales_channel_cannot_be_edited_even_by_direct_sql() {
    // Migration 001's void trigger works from a column LIST, so a column added
    // later is one a "void" could rewrite by default. Migration 014 adds its
    // own guard for this one, because re-attributing a posted sale moves
    // revenue between two figures on a row that is supposed to be immutable.
    //
    // Run on a COUNTER sale, so migration 014's guard is the trigger under
    // test: a posted DELIVERY row carries a driver, and moving it to the
    // counter channel is refused first by migration 015's coherence trigger,
    // which would make this test pass for the wrong reason.
    let db = store_with_coffee().await;
    let p = channel_sale(SALES_CHANNEL_COUNTER);
    let id = p.sale_id.clone();
    post_sale_with_pool(db.pool(), p).await.expect("post");

    let err = db
        .try_exec(&format!("UPDATE sales SET channel='online_delivery' WHERE id='{id}'"))
        .await
        .expect_err("re-attributing a posted sale must be rejected")
        .to_string();
    assert!(err.contains("channel cannot be changed"), "got: {err}");

    assert_eq!(
        db.scalar_string(&format!("SELECT channel FROM sales WHERE id='{id}'")).await,
        "counter"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_database_refuses_an_out_of_range_channel_as_a_backstop() {
    // The CHECK, independent of the application's own validation.
    let db = store_with_coffee().await;
    let p = channel_sale(SALES_CHANNEL_COUNTER);
    let id = p.sale_id.clone();
    post_sale_with_pool(db.pool(), p).await.expect("post");

    // On a DRAFT row, so the immutability trigger is not what refuses it.
    db.exec(&format!(
        "INSERT INTO sales (id, store_id, receipt_number, exchange_rate_lbp_per_usd,
                            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                            discount_cents, cogs_total_cents, status)
         VALUES ('draft-ch', '{STORE_ID}', 9999, 89500, 0, 0, 0, 0, 0, 'draft')"
    ))
    .await;

    let err = db
        .try_exec("UPDATE sales SET channel='pigeon' WHERE id='draft-ch'")
        .await
        .expect_err("the CHECK must reject an out-of-range channel")
        .to_string();
    assert!(err.contains("CHECK constraint failed"), "got: {err}");

    let _ = id;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn channel_totals_reconcile_to_the_overall_sales_total() {
    // The reconciliation requirement, asserted in SQL rather than trusted: the
    // sum of the per-channel figures IS the overall figure, because they are
    // the same rows grouped two ways.
    let db = store_with_coffee().await;

    for (channel, qty) in [
        (SALES_CHANNEL_COUNTER, 2),
        (SALES_CHANNEL_ONLINE_DELIVERY, 3),
        (SALES_CHANNEL_COUNTER, 1),
        (SALES_CHANNEL_ONLINE_DELIVERY, 4),
    ] {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_incl(500).build()];
        // Each channel in the shape it is actually taken in: the counter at the
        // till, delivery collected by the driver. The figures being reconciled
        // are the sale TOTALS, which neither tender changes.
        let p = if channel == SALES_CHANNEL_ONLINE_DELIVERY {
            delivery_payload(lines, D_SAMI, 0)
        } else {
            let mut counter = sale_payload(lines, vec![cash_usd(500 * qty)]);
            counter.channel = channel.to_string();
            counter
        };
        post_sale_with_pool(db.pool(), p).await.expect("post");
    }

    let overall = db
        .scalar_i64("SELECT SUM(total_incl_vat_cents) FROM sales WHERE status='posted'")
        .await;
    let counter = db
        .scalar_i64(
            "SELECT COALESCE(SUM(total_incl_vat_cents), 0) FROM sales
              WHERE status='posted' AND channel='counter'",
        )
        .await;
    let online = db
        .scalar_i64(
            "SELECT COALESCE(SUM(total_incl_vat_cents), 0) FROM sales
              WHERE status='posted' AND channel='online_delivery'",
        )
        .await;

    assert_eq!(counter, 1500, "2 + 1 units at $5.00");
    assert_eq!(online, 3500, "3 + 4 units at $5.00");
    assert_eq!(counter + online, overall, "the parts sum to the whole");

    // And no sale escapes classification, which is what a nullable column or a
    // third bucket would have allowed.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM sales
              WHERE status='posted' AND channel NOT IN ('counter','online_delivery')"
        )
        .await,
        0
    );
}
