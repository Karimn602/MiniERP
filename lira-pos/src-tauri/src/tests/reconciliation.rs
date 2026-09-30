// Layer C — the whole-ledger invariants.
//
// These are the tests later work packages must keep green: they say nothing
// about *how* posting works, only that the books balance afterwards.

use crate::posting::{post_adjustment_with_pool, post_purchase_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000c2";
const P_DELIVERY: &str = "00000000-0000-0000-0000-0000000000c4";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

/// INVARIANT: for every product, the sum of its inventory movements equals its
/// `quantity_on_hand`, given it started at zero.
async fn assert_movements_reconcile(db: &TempDb, product_id: &str) {
    assert_eq!(
        movement_sum(db, product_id).await,
        quantity_on_hand(db, product_id).await,
        "SUM(inventory_movements.quantity_delta) must equal products.quantity_on_hand for {product_id}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_trading_day_reconciles_stock_to_its_movement_trail() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    // Both products start at zero so movements alone must explain the balance.
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;
    seed_product(&db, &ProductSpec::stocked(P_WATER, "SKU-W1", "Water")).await;

    // 1. Opening stock: 100 coffee.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload(
            "opening",
            None,
            vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(100).unit_cost_excl(180).build()],
        ),
    )
    .await
    .unwrap();

    // 2. Supplier purchase: +60 coffee, +200 water.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload(
            "normal",
            Some(SUPPLIER),
            vec![
                PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(60).unit_cost_excl(220).build(),
                PurchaseLineBuilder::new(P_WATER, "Water").qty(200).unit_cost_excl(40).build(),
            ],
        ),
    )
    .await
    .unwrap();

    // 3. Three sales across the day.
    for (coffee_qty, water_qty) in [(3, 10), (7, 4), (1, 25)] {
        let lines = vec![
            SaleLineBuilder::new(P_COFFEE, "Coffee").qty(coffee_qty).unit_incl(500).build(),
            SaleLineBuilder::new(P_WATER, "Water").qty(water_qty).unit_incl(100).build(),
        ];
        let total = lines_total(&lines);
        post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(total)]))
            .await
            .unwrap();
    }

    // 4. A positive and a negative adjustment.
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("found in back room", vec![adjustment_line(P_COFFEE, 4)]),
    )
    .await
    .unwrap();
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("breakage", vec![adjustment_line(P_WATER, -6)]),
    )
    .await
    .unwrap();

    // --- The invariant ---
    assert_movements_reconcile(&db, P_COFFEE).await;
    assert_movements_reconcile(&db, P_WATER).await;

    // And the arithmetic is what a human would expect:
    // coffee: 100 + 60 − (3+7+1) + 4 = 153
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 153);
    // water: 200 − (10+4+25) − 6 = 155
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 155);

    // Every stock-affecting transaction left exactly the movements expected:
    // 1 opening + 2 purchase + 6 sale + 2 adjustment.
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 11);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type='opening'").await,
        1
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type='purchase'").await,
        2
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type='sale'").await,
        6
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type='adjustment'").await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_stocked_sale_line_has_exactly_one_movement_and_services_have_none() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 50, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec { is_service: true, ..ProductSpec::stocked(P_DELIVERY, "SKU-D1", "Delivery") },
    )
    .await;

    let lines = vec![
        SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build(),
        SaleLineBuilder::new(P_DELIVERY, "Delivery").service(true).qty(1).unit_incl(300).build(),
    ];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    // INVARIANT: a stocked sale line and its movement are 1:1.
    let stocked_lines = db
        .count(&format!(
            "SELECT COUNT(*) FROM sale_items si JOIN products p ON p.id = si.product_id
              WHERE si.sale_id='{sale_id}' AND p.is_service = 0"
        ))
        .await;
    let movements = db
        .count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await;
    assert_eq!(stocked_lines, 1);
    assert_eq!(movements, stocked_lines, "one movement per stocked line, no more, no fewer");

    // Every movement points back at a real sale_item.
    let orphans = db
        .count(&format!(
            "SELECT COUNT(*) FROM inventory_movements im
              WHERE im.related_sale_id='{sale_id}'
                AND im.related_sale_item_id NOT IN (SELECT id FROM sale_items)"
        ))
        .await;
    assert_eq!(orphans, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn header_totals_reconcile_to_line_totals_across_many_sales() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 5_000, ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee") },
    )
    .await;

    // Deliberately awkward prices so rounding has a chance to misbehave.
    for (qty, price) in [(1, 333), (7, 101), (13, 799), (2, 1), (99, 255)] {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_incl(price).build()];
        let total = lines_total(&lines);
        post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(total)]))
            .await
            .unwrap();
    }

    // INVARIANT, per sale: header == SUM(lines), and subtotal + VAT == total.
    let mismatched = db
        .count(
            "SELECT COUNT(*) FROM sales s
              WHERE s.subtotal_excl_vat_cents + s.vat_total_cents <> s.total_incl_vat_cents
                 OR s.subtotal_excl_vat_cents <> (
                      SELECT COALESCE(SUM(line_subtotal_excl_vat_cents),0)
                        FROM sale_items WHERE sale_id = s.id)
                 OR s.vat_total_cents <> (
                      SELECT COALESCE(SUM(line_vat_cents),0)
                        FROM sale_items WHERE sale_id = s.id)
                 OR s.total_incl_vat_cents <> (
                      SELECT COALESCE(SUM(line_total_incl_vat_cents),0)
                        FROM sale_items WHERE sale_id = s.id)",
        )
        .await;
    assert_eq!(mismatched, 0, "every posted sale must reconcile to its lines");

    // INVARIANT: payments cover the amount due exactly, once change is removed.
    let unbalanced = db
        .count(
            "SELECT COUNT(*) FROM sales s
              WHERE s.total_incl_vat_cents <> (
                      SELECT COALESCE(SUM(amount_usd_cents_equivalent - change_given_usd_cents),0)
                        FROM sale_payments WHERE sale_id = s.id)",
        )
        .await;
    assert_eq!(unbalanced, 0, "tendered − change must equal the amount due");

    // INVARIANT: header COGS is the sum of the line snapshots.
    let bad_cogs = db
        .count(
            "SELECT COUNT(*) FROM sales s
              WHERE s.cogs_total_cents <> (
                      SELECT COALESCE(SUM(line_cogs_excl_vat_cents),0)
                        FROM sale_items WHERE sale_id = s.id)",
        )
        .await;
    assert_eq!(bad_cogs, 0);

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchase_headers_reconcile_to_their_lines_across_many_purchases() {
    let db = TempDb::new().await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;
    seed_product(&db, &ProductSpec::stocked(P_WATER, "SKU-W1", "Water")).await;

    for (q1, c1, q2, c2) in [(3, 197, 11, 43), (100, 1, 1, 9_999), (7, 333, 7, 333)] {
        let lines = vec![
            PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(q1).unit_cost_excl(c1).build(),
            PurchaseLineBuilder::new(P_WATER, "Water").qty(q2).unit_cost_excl(c2).build(),
        ];
        post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
            .await
            .unwrap();
    }

    let mismatched = db
        .count(
            "SELECT COUNT(*) FROM purchases p
              WHERE p.subtotal_excl_vat_cents + p.vat_total_cents <> p.total_incl_vat_cents
                 OR p.subtotal_excl_vat_cents <> (
                      SELECT COALESCE(SUM(line_subtotal_excl_vat_cents),0)
                        FROM purchase_items WHERE purchase_id = p.id)
                 OR p.total_incl_vat_cents <> (
                      SELECT COALESCE(SUM(line_total_incl_vat_cents),0)
                        FROM purchase_items WHERE purchase_id = p.id)",
        )
        .await;
    assert_eq!(mismatched, 0, "every posted purchase must reconcile to its lines");

    // Each credit purchase raised the payable by its own gross total.
    let ledger_mismatch = db
        .count(
            "SELECT COUNT(*) FROM purchases p
               JOIN supplier_ledger sl ON sl.related_purchase_id = p.id
              WHERE sl.amount_cents <> p.total_incl_vat_cents",
        )
        .await;
    assert_eq!(ledger_mismatch, 0);

    assert_movements_reconcile(&db, P_COFFEE).await;
    assert_movements_reconcile(&db, P_WATER).await;
}
