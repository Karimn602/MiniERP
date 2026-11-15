// V1.1 — the operator controls of migration 025, against a real database.
//
//   * `show_on_register`: hidden items are refused by `post_sale`, a replay of
//     a sale that already posted still resolves, and the upgrade backfill
//     hides exactly the unambiguous rows;
//   * `allow_negative_stock`: the OWNER's per-item policy governs sales and
//     adjustments, not the request;
//   * a purchase received onto an empty or negative pool takes the invoice
//     rate and is never refused for it;
//   * `product_valuation_audit` records cost-override and policy changes and
//     is append-only;
//   * the cashier-safe "which lines moved stock" read.

use crate::catalog::save_product_with_pool;
use crate::cost::{purchase_weighted_avg, rate_with_vat_microcents};
use crate::posting::{
    post_adjustment_with_pool, post_purchase_with_pool, post_sale_with_pool,
    sale_lines_with_stock_movement_for,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_MEAT: &str = "00000000-0000-0000-0000-0000000025a1";
const P_BUN: &str = "00000000-0000-0000-0000-0000000025a2";
const P_FREE_WATER: &str = "00000000-0000-0000-0000-0000000025a3";
const P_FRIES: &str = "00000000-0000-0000-0000-0000000025a4";

async fn shop() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec { quantity_on_hand: 10, ..ProductSpec::stocked(P_FRIES, "SKU-F", "Fries") },
    )
    .await;
    db
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

#[test]
fn a_purchase_onto_an_empty_or_negative_pool_takes_the_invoice_rate() {
    // Positive pool: an ordinary blend, unchanged.
    assert_eq!(purchase_weighted_avg(1_000, 300_000, 1_000, 500_000).unwrap(), 400_000);
    // Empty pool: the receipt's rate.
    assert_eq!(purchase_weighted_avg(0, 999_999, 20, 400_000).unwrap(), 400_000);
    // Negative pool cleared by the receipt: the receipt's rate — NOT the 450,000
    // a blend against the deficit would invent.
    assert_eq!(purchase_weighted_avg(-1_000, 300_000, 3_000, 400_000).unwrap(), 400_000);
    // A receipt too small to clear the deficit is no longer refused.
    assert_eq!(purchase_weighted_avg(-3_000, 300_000, 1_000, 400_000).unwrap(), 400_000);
    // Still refused: nothing received, a negative cost, an unrepresentable value.
    assert!(purchase_weighted_avg(-3, 1, 0, 1).is_err());
    assert!(purchase_weighted_avg(5, 1, 1, -1).is_err());
    assert!(purchase_weighted_avg(0, 0, 2, i64::MAX).is_err());
}

#[test]
fn a_vat_inclusive_override_rate_rounds_once_half_away() {
    assert_eq!(rate_with_vat_microcents(185_000_000, 1100).unwrap(), 205_350_000);
    assert_eq!(rate_with_vat_microcents(5, 1100).unwrap(), 6); // 5.55 -> 6
    assert_eq!(rate_with_vat_microcents(100, 0).unwrap(), 100);
    assert!(rate_with_vat_microcents(-1, 1100).is_err());
}

// ---------------------------------------------------------------------------
// show_on_register
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_item_kept_off_the_register_cannot_be_sold_but_a_posted_sale_still_replays() {
    let db = shop().await;

    // Posted while it was still on the menu.
    let first = sale_payload(
        vec![SaleLineBuilder::new(P_FRIES, "Fries").qty(1).unit_incl(1110).build()],
        vec![cash_usd(1110)],
    );
    let receipt = post_sale_with_pool(db.pool(), replay_of(&first)).await.unwrap().receipt_number;

    db.exec(&format!("UPDATE products SET show_on_register = 0 WHERE id = '{P_FRIES}'")).await;

    // A NEW sale of it is refused, by name, before anything is written.
    let err = post_sale_with_pool(
        db.pool(),
        sale_payload(
            vec![SaleLineBuilder::new(P_FRIES, "Fries").qty(1).unit_incl(1110).build()],
            vec![cash_usd(1110)],
        ),
    )
    .await
    .expect_err("an inventory-only item is not for sale");
    assert!(err.contains("not sold at the Register"), "{err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);

    // The sale that already posted still replays to its own receipt.
    let again = post_sale_with_pool(db.pool(), replay_of(&first)).await.unwrap();
    assert_eq!(again.receipt_number, receipt);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_025_hides_only_unambiguous_zero_priced_items() {
    let db = TempDb::at_schema_version(24).await;
    for (id, sku, name, service, price) in [
        (P_MEAT, "M", "Meat", false, 0),
        (P_BUN, "B", "Potato Bun", false, 0),
        (P_FREE_WATER, "W", "Water on request", true, 0),
        (P_FRIES, "F", "Fries", false, 1000),
    ] {
        seed_product(
            &db,
            &ProductSpec {
                is_service: service,
                price_excl_vat_cents: price,
                price_incl_vat_cents: price,
                ..ProductSpec::stocked(id, sku, name)
            },
        )
        .await;
    }

    db.migrate_again().await.expect("025 applies to a populated v24 database");
    db.migrate_again().await.expect("and a second run is a no-op");

    let shown = |id: &'static str| {
        let db = &db;
        async move {
            db.scalar_i64(&format!("SELECT show_on_register FROM products WHERE id = '{id}'")).await
        }
    };
    assert_eq!(shown(P_MEAT).await, 0, "a $0 stocked ingredient leaves the menu");
    assert_eq!(shown(P_BUN).await, 0);
    assert_eq!(shown(P_FREE_WATER).await, 1, "a $0 service that is not an ingredient stays");
    assert_eq!(shown(P_FRIES).await, 1, "a priced item stays");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE allow_negative_stock <> 0").await,
        0,
        "nobody may oversell until the owner says so"
    );

    // An upgraded database and a fresh one have the same schema.
    let fresh = TempDb::new().await;
    let schema = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                  (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(fresh.scalar_string(schema).await, db.scalar_string(schema).await);
}

// ---------------------------------------------------------------------------
// allow_negative_stock
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_below_zero_needs_the_owners_policy() {
    let db = shop().await;
    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("count", vec![adjustment_line(P_FRIES, -12)]),
    )
    .await
    .expect_err("no policy, no negative stock");
    assert!(err.contains("negative"), "{err}");
    assert_eq!(quantity_on_hand(&db, P_FRIES).await, 10);

    db.exec(&format!("UPDATE products SET allow_negative_stock = 1 WHERE id = '{P_FRIES}'")).await;
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("count", vec![adjustment_line(P_FRIES, -12)]),
    )
    .await
    .expect("the owner's policy permits it");
    assert_eq!(quantity_on_hand(&db, P_FRIES).await, -2);
    assert_eq!(movement_sum(&db, P_FRIES).await, -12, "and it is a documented movement");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_that_does_not_clear_a_deficit_still_posts_at_the_invoice_rate() {
    let db = shop().await;
    db.exec(&format!(
        "UPDATE products SET allow_negative_stock = 1, quantity_on_hand = -5 WHERE id = '{P_FRIES}'"
    ))
    .await;
    // Keep the ledger reconciling with the forged opening position.
    db.exec(&format!(
        "INSERT INTO inventory_movements (id, store_id, product_id, movement_type, quantity_delta)
         VALUES ('{}', '{STORE_ID}', '{P_FRIES}', 'adjustment', -15)",
        uuid()
    ))
    .await;

    let line = PurchaseLineBuilder::new(P_FRIES, "Fries").qty(2).unit_cost_excl(300).build();
    post_purchase_with_pool(db.pool(), purchase_payload("opening", None, vec![line]))
        .await
        .expect("a receipt is never refused for landing on a deficit");

    assert_eq!(quantity_on_hand(&db, P_FRIES).await, -3);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id = '{P_FRIES}'"
        ))
        .await,
        300 * 1_000_000,
        "the units now on hand are valued at what the receipt says they cost"
    );
}

// ---------------------------------------------------------------------------
// product_valuation_audit
// ---------------------------------------------------------------------------

fn fries_update() -> crate::catalog::SaveProductPayload {
    crate::catalog::SaveProductPayload {
        product_id: P_FRIES.to_string(),
        store_id: STORE_ID.to_string(),
        mode: "update".to_string(),
        sku: Some("SKU-F".to_string()),
        name: "Fries".to_string(),
        description: None,
        vat_rate_id: VAT_STD_ID.to_string(),
        vat_pricing_mode: "inclusive".to_string(),
        price_excl_vat_cents: 1000,
        price_incl_vat_cents: 1110,
        reorder_point: None,
        is_service: false,
        is_active: true,
        category: None,
        icon: None,
        costing_method: None,
        standard_cost_excl_vat_microcents: None,
        show_on_register: None,
        allow_negative_stock: None,
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
async fn cost_override_and_policy_changes_are_audited_and_the_log_is_append_only() {
    let db = shop().await;

    let mut p = fries_update();
    p.costing_method = Some("standard".to_string());
    p.standard_cost_excl_vat_microcents = Some(120_000_000);
    p.allow_negative_stock = Some(true);
    save_product_with_pool(db.pool(), p).await.expect("owner sets an override and the policy");

    let mut p = fries_update();
    p.costing_method = Some("purchase_average".to_string());
    save_product_with_pool(db.pool(), p).await.expect("owner removes the override");

    // An unrelated edit writes nothing.
    let mut p = fries_update();
    p.name = "Fries (large)".to_string();
    save_product_with_pool(db.pool(), p).await.unwrap();

    let events: Vec<(String,)> = sqlx::query_as(
        "SELECT event FROM product_valuation_audit WHERE product_id = ? ORDER BY created_at, event",
    )
    .bind(P_FRIES)
    .fetch_all(db.pool())
    .await
    .unwrap();
    let mut names: Vec<String> = events.into_iter().map(|e| e.0).collect();
    names.sort();
    assert_eq!(
        names,
        vec!["manual_cost_removed", "manual_cost_set", "negative_stock_enabled"]
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM product_valuation_audit WHERE created_by_user_id IS NULL").await,
        0
    );

    assert!(db.try_exec("UPDATE product_valuation_audit SET event = 'manual_cost_set'").await.is_err());
    assert!(db.try_exec("DELETE FROM product_valuation_audit").await.is_err());
}

// ---------------------------------------------------------------------------
// The cashier-safe "which lines moved stock" read
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_lines_that_moved_stock_are_reported_and_only_in_the_callers_store() {
    let db = shop().await;
    let payload = sale_payload(
        vec![
            SaleLineBuilder::new(P_FRIES, "Fries").qty(1).unit_incl(1110).build(),
        ],
        vec![cash_usd(1110)],
    );
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let moved = sale_lines_with_stock_movement_for(db.pool(), STORE_ID, &sale_id).await.unwrap();
    assert_eq!(moved.len(), 1);
    let other_store =
        sale_lines_with_stock_movement_for(db.pool(), "another-store", &sale_id).await.unwrap();
    assert!(other_store.is_empty(), "another shop learns nothing");
}

/// Codex V1.1 P2: every role may POST a refund, but the posted result carries
/// the reversed COGS only to a tier that may read cost. For a cashier the
/// field is present and null — withheld, which a UI cannot mistake for $0.00.
#[test]
fn a_posted_refund_withholds_its_cost_from_the_cashier_tier() {
    use crate::posting::{credit_memo_result_for_tier, PostCreditMemoResult};
    use crate::read_guard::ReadTier;
    let r = PostCreditMemoResult {
        credit_memo_id: "m".into(),
        credit_memo_number: 3,
        posted_at: "now".into(),
        movement_ids: vec![],
        subtotal_excl_vat_cents: 451,
        vat_total_cents: 49,
        discount_cents: 0,
        total_incl_vat_cents: 500,
        cogs_reversed_cents: 0,
        refund_total_usd_cents: 500,
    };
    let staff = credit_memo_result_for_tier(&r, ReadTier::Staff);
    assert_eq!(staff["cogsReversedCents"], serde_json::json!(0), "a genuine zero stays zero");
    assert_eq!(staff["creditMemoNumber"], serde_json::json!(3));
    let cashier = credit_memo_result_for_tier(&r, ReadTier::Cashier);
    assert!(cashier["cogsReversedCents"].is_null(), "{cashier}");
    assert_eq!(cashier["totalInclVatCents"], serde_json::json!(500));
    assert_eq!(cashier["creditMemoNumber"], serde_json::json!(3));
}
