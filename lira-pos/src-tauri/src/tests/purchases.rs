// Layer C — `post_purchase` against a temporary database.

use crate::posting::post_purchase_with_pool;
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000c2";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

async fn store_with_supplier_and_products() -> TempDb {
    let db = TempDb::new().await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")).await;
    seed_product(&db, &ProductSpec::stocked(P_WATER, "SKU-W1", "Water 1.5L")).await;
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_purchase_reconciles_header_lines_stock_and_ledger() {
    let db = store_with_supplier_and_products().await;

    // 10 units at $2.00 excl VAT, 11% → $2.22 incl.
    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee 250g")
        .qty(10)
        .unit_cost_excl(200)
        .build()];
    let payload = purchase_payload("normal", Some(SUPPLIER), lines);
    let purchase_id = payload.purchase_id.clone();

    let result = post_purchase_with_pool(db.pool(), payload).await.expect("purchase posts");
    assert_eq!(result.purchase_number, 1);
    assert_eq!(result.movement_ids.len(), 1);
    assert!(result.ledger_entry_id.is_some());

    // --- Header reconciles internally ---
    let s = db
        .scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM purchases WHERE id='{purchase_id}'"))
        .await;
    let v = db
        .scalar_i64(&format!("SELECT vat_total_cents FROM purchases WHERE id='{purchase_id}'"))
        .await;
    let t = db
        .scalar_i64(&format!("SELECT total_incl_vat_cents FROM purchases WHERE id='{purchase_id}'"))
        .await;
    assert_eq!((s, v, t), (2000, 220, 2220));
    assert_eq!(s + v, t, "subtotal + VAT = total");

    // --- Header reconciles to its lines ---
    for (col, expected) in [
        ("line_subtotal_excl_vat_cents", s),
        ("line_vat_cents", v),
        ("line_total_incl_vat_cents", t),
    ] {
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT COALESCE(SUM({col}),0) FROM purchase_items WHERE purchase_id='{purchase_id}'"
            ))
            .await,
            expected,
            "SUM(purchase_items.{col}) must equal the header"
        );
    }

    // --- Stock in, at the purchased cost ---
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(movement_sum(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT movement_type FROM inventory_movements WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        "purchase"
    );

    // --- Weighted average adopts the first purchase's cost outright ---
    assert_eq!(
        db.scalar_i64(&format!("SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_COFFEE}'")).await,
        200
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT avg_cost_incl_vat_cents FROM products WHERE id='{P_COFFEE}'")).await,
        222
    );

    // --- The line is linked to its movement ---
    let linked = db
        .count(&format!(
            "SELECT COUNT(*) FROM purchase_items pi
               JOIN inventory_movements im ON im.id = pi.related_movement_id
              WHERE pi.purchase_id='{purchase_id}'"
        ))
        .await;
    assert_eq!(linked, 1, "every purchase line points at its inventory movement");

    // --- The supplier is owed the gross total ---
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT amount_cents FROM supplier_ledger WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        2220,
        "a credit purchase increases what we owe by the incl-VAT total"
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT entry_type FROM supplier_ledger WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        "purchase"
    );

    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM purchases WHERE id='{purchase_id}'")).await,
        "posted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn weighted_average_cost_blends_across_successive_purchases() {
    let db = store_with_supplier_and_products().await;

    for cost in [200, 400] {
        let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(cost).build()];
        post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
            .await
            .unwrap();
    }

    // 10 @ $2.00 then 10 @ $4.00 → $3.00
    assert_eq!(
        db.scalar_i64(&format!("SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_COFFEE}'")).await,
        300
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 20);
    assert_eq!(movement_sum(&db, P_COFFEE).await, 20);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_opening_purchase_moves_stock_but_creates_no_supplier_debt() {
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(25).unit_cost_excl(150).build()];
    let payload = purchase_payload("opening", None, lines);
    let purchase_id = payload.purchase_id.clone();

    let result = post_purchase_with_pool(db.pool(), payload).await.expect("opening stock posts");
    assert!(result.ledger_entry_id.is_none(), "opening stock owes no supplier");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT movement_type FROM inventory_movements WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        "opening",
        "opening stock is its own movement type"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 25);
    assert_eq!(
        db.scalar_i64(&format!("SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_COFFEE}'")).await,
        150
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchase_numbers_increment_per_post() {
    let db = store_with_supplier_and_products().await;

    for expected in 1..=3 {
        let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_cost_excl(100).build()];
        let r = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
            .await
            .unwrap();
        assert_eq!(r.purchase_number, expected);
    }
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "4"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_purchase_in_a_derived_uom_converts_quantity_and_cost_to_base() {
    let db = store_with_supplier_and_products().await;

    let lines = vec![
        // 5 boxes of 12 at $24.00/box → 60 base units at $2.00/unit.
        PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .uom("box", 12, 1)
            .qty(5)
            .unit_cost_excl(2400)
            .build(),
        PurchaseLineBuilder::new(P_WATER, "Water").qty(40).unit_cost_excl(50).build(),
    ];
    assert_eq!(lines[0].quantity_base, 60);
    assert_eq!(lines[0].unit_cost_excl_vat_base_cents, 200, "cost per base unit");

    let payload = purchase_payload("normal", Some(SUPPLIER), lines);
    let purchase_id = payload.purchase_id.clone();
    post_purchase_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 60);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 40);
    // Weighted average is always expressed per BASE unit.
    assert_eq!(
        db.scalar_i64(&format!("SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_COFFEE}'")).await,
        200
    );

    // Header still reconciles over both lines.
    let s = db.scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM purchases WHERE id='{purchase_id}'")).await;
    let v = db.scalar_i64(&format!("SELECT vat_total_cents FROM purchases WHERE id='{purchase_id}'")).await;
    let t = db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM purchases WHERE id='{purchase_id}'")).await;
    assert_eq!(s, 2400 * 5 + 50 * 40);
    assert_eq!(s + v, t);

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        2,
        "one movement per purchased line"
    );
    // A single ledger entry for the whole invoice, at the header total.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT amount_cents FROM supplier_ledger WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        t
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exempt_purchase_line_carries_no_vat() {
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_WATER, "Water")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(10)
        .unit_cost_excl(90)
        .build()];
    let payload = purchase_payload("normal", Some(SUPPLIER), lines);
    let purchase_id = payload.purchase_id.clone();
    post_purchase_with_pool(db.pool(), payload).await.unwrap();

    let s = db.scalar_i64(&format!("SELECT subtotal_excl_vat_cents FROM purchases WHERE id='{purchase_id}'")).await;
    let v = db.scalar_i64(&format!("SELECT vat_total_cents FROM purchases WHERE id='{purchase_id}'")).await;
    let t = db.scalar_i64(&format!("SELECT total_incl_vat_cents FROM purchases WHERE id='{purchase_id}'")).await;
    assert_eq!((s, v, t), (900, 0, 900));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchasing_an_unknown_product_rolls_everything_back() {
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new("no-such-product", "Ghost").qty(1).unit_cost_excl(100).build()];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_cost_purchase_is_allowed_and_drags_the_average_down() {
    // Free goods from a supplier are a real scenario and must not be rejected.
    let db = store_with_supplier_and_products().await;

    let paid = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(300).build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), paid))
        .await
        .unwrap();

    let free = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(0).build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), free))
        .await
        .unwrap();

    // (10 × 300 + 10 × 0) / 20 = 150
    assert_eq!(
        db.scalar_i64(&format!("SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_COFFEE}'")).await,
        150
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 20);
}
