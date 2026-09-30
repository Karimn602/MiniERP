// Layer C — `post_adjustment` against a temporary database.

use crate::posting::post_adjustment_with_pool;
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000c2";

async fn store_with_stock(qty: i64) -> TempDb {
    let db = TempDb::new().await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: qty,
            avg_cost_excl_vat_cents: 250,
            avg_cost_incl_vat_cents: 278,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_positive_adjustment_adds_stock_and_snapshots_the_current_cost() {
    let db = store_with_stock(20).await;

    let result = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("stock count correction", vec![adjustment_line(P_COFFEE, 5)]),
    )
    .await
    .expect("adjustment posts");
    assert_eq!(result.movement_ids.len(), 1);

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 25);
    assert_eq!(movement_sum(&db, P_COFFEE).await, 5);

    let id = &result.movement_ids[0];
    assert_eq!(
        db.scalar_string(&format!("SELECT movement_type FROM inventory_movements WHERE id='{id}'")).await,
        "adjustment"
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT quantity_delta FROM inventory_movements WHERE id='{id}'")).await,
        5
    );
    // The movement carries the product's cost at the moment of adjustment.
    assert_eq!(
        db.scalar_i64(&format!("SELECT unit_cost_excl_vat_cents FROM inventory_movements WHERE id='{id}'")).await,
        250
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT notes FROM inventory_movements WHERE id='{id}'")).await,
        "stock count correction",
        "the reason is preserved for audit"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_negative_adjustment_removes_stock() {
    let db = store_with_stock(20).await;

    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("breakage", vec![adjustment_line(P_COFFEE, -8)]),
    )
    .await
    .unwrap();

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 12);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adjusting_down_to_exactly_zero_is_the_allowed_boundary() {
    let db = store_with_stock(7).await;

    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("wrote off the last of them", vec![adjustment_line(P_COFFEE, -7)]),
    )
    .await
    .expect("landing exactly on zero is valid");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_that_would_go_negative_is_refused_and_rolls_back() {
    let db = store_with_stock(3).await;

    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("shrinkage", vec![adjustment_line(P_COFFEE, -4)]),
    )
    .await
    .unwrap_err();
    assert!(err.contains("negative"), "got: {err}");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 3, "stock is untouched");
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_adjustment_is_all_or_nothing() {
    let db = store_with_stock(10).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 1, ..ProductSpec::stocked(P_WATER, "SKU-W1", "Water") },
    )
    .await;

    // The first line is fine; the second would drive stock negative.
    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "recount",
            vec![adjustment_line(P_COFFEE, -2), adjustment_line(P_WATER, -5)],
        ),
    )
    .await
    .unwrap_err();
    assert!(err.contains("negative"), "got: {err}");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10, "the valid line rolled back too");
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn several_adjustments_accumulate_and_stay_reconciled() {
    let db = store_with_stock(100).await;

    for delta in [-10, 25, -5, 1] {
        post_adjustment_with_pool(
            db.pool(),
            adjustment_payload("periodic recount", vec![adjustment_line(P_COFFEE, delta)]),
        )
        .await
        .unwrap();
    }

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 111);
    assert_eq!(
        movement_sum(&db, P_COFFEE).await,
        11,
        "movements account for every change since the opening balance"
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 4);
}
