// Layer C — `post_purchase` is DB-authoritative for product/UoM conversion.
//
// WP-02 made `post_sale` authoritative (GP-A02): the base quantity comes from
// the product's own `product_uoms` factor, and a payload that contradicts it is
// refused. WP-03's release-gate review found the PURCHASE boundary still
// trusting the client:
//
//   * the factor snapshots were only checked for positivity,
//   * that client factor drove the precise per-base cost conversion,
//   * `quantity_base` arrived separately and drove stock, the movement and the
//     weighted average,
//   * and no `product_uoms` row was ever resolved.
//
// So a stale client could post 2 boxes of 12 as "2 base units" and get a
// mathematically immaculate cost per unit that nobody had bought — precision
// over a quantity that never existed, which defeats the point of WP-03.
//
// `post_purchase` now resolves ONE authoritative conversion per line and uses it
// for the cost, the persisted snapshots, the movement, stock, the weighted
// average and the last-purchase rate. These tests fence that off.
//
// The costing model is untouched: 1 cent = `COST_SCALE` microcents, weighted
// average and last-purchase policies unchanged, COGS rounded at the same
// boundary.

use crate::cost::COST_SCALE;
use crate::posting::{post_purchase_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_FLOUR: &str = "00000000-0000-0000-0000-0000000000f1";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

/// $0.0025 per gram — the per-base rate of $2.50/kg.
const FLOUR_PER_GRAM: i64 = 250_000;

/// Coffee counted in pieces and bought by the box of 12; flour stocked in grams
/// and bought by the kilo. Both derived UoMs are real active `product_uoms` rows,
/// because that is what a real shop has and what the backend now requires.
async fn store_with_derived_purchase_uoms() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;
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

/// Everything a rejected purchase must have left untouched.
async fn assert_nothing_was_written(db: &TempDb) {
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0, "no purchase header");
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 0, "no purchase item");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger").await,
        0,
        "no supplier-ledger posting"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements").await,
        0,
        "no inventory movement"
    );
    for product in [P_COFFEE, P_FLOUR] {
        assert_eq!(quantity_on_hand(db, product).await, 0, "no quantity_on_hand change");
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{product}'"
            ))
            .await,
            0,
            "no average-cost change"
        );
    }
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "1",
        "the purchase-number sequence must not be consumed by a refused post"
    );
}

// ============================================================================
// 1 — a valid derived UoM resolves and posts
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_valid_derived_uom_is_resolved_from_the_database_and_posts() {
    let db = store_with_derived_purchase_uoms().await;

    // 2 boxes at $24.00/box. The DB says 1 box = 12 pcs.
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_cost_excl(2_400)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .expect("a payload agreeing with the database must post");

    // 2 x 12 = 24 base units, everywhere.
    assert_eq!(db.scalar_i64("SELECT quantity_base FROM purchase_items").await, 24);
    assert_eq!(db.scalar_i64("SELECT quantity_delta FROM inventory_movements").await, 24);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 24);
    assert_eq!(movement_sum(&db, P_COFFEE).await, 24);

    // The cost conversion used factor 12: $24.00/box is $2.00 per piece.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_microcents FROM purchase_items").await,
        200 * COST_SCALE
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        200 * COST_SCALE
    );

    // The persisted snapshots are the RESOLVED conversion, not the payload's
    // copy of it, and they name the row that resolved.
    assert_eq!(db.scalar_i64("SELECT factor_num_snapshot FROM purchase_items").await, 12);
    assert_eq!(db.scalar_i64("SELECT factor_den_snapshot FROM purchase_items").await, 1);
    assert_eq!(
        db.scalar_string("SELECT product_uom_id_snapshot FROM purchase_items").await,
        product_uom_id(&db, P_COFFEE, "box").await
    );
}

// ============================================================================
// 2 — an understated client base quantity is refused
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_understated_client_base_quantity_is_refused_atomically() {
    // This is the whole defect in one payload: 2 boxes of 12 declared as 2 base
    // units. Before the correction it posted — 24 pieces of stock arrived as 2,
    // and the weighted average blended $2.00/piece against a quantity of 2.
    for claimed in [1, 2, 23, 25, 240] {
        let db = store_with_derived_purchase_uoms().await;
        let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .uom("box", 12, 1)
            .qty(2)
            .unit_cost_excl(2_400)
            .raw_quantity_base(claimed)
            .build();

        let result =
            post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
                .await;
        assert!(
            result.is_err(),
            "a declared base quantity of {claimed} must be refused, not posted as 24"
        );
        assert_nothing_was_written(&db).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_base_quantity_mismatch_error_names_the_authoritative_conversion() {
    let db = store_with_derived_purchase_uoms().await;
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_cost_excl(2_400)
        .raw_quantity_base(2)
        .build();

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), vec![line]),
    )
    .await
    .expect_err("an understated base quantity must be refused");
    assert!(
        err.contains("base quantity") && err.contains("24"),
        "the error must state the authoritative quantity, got: {err}"
    );
    assert_nothing_was_written(&db).await;
}

// ============================================================================
// 3 — a wrong client factor is refused
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_factor_that_contradicts_the_product_is_refused_atomically() {
    let db = store_with_derived_purchase_uoms().await;

    // The DB says 1 box = 12. The client insists on 10 — and is internally
    // consistent about it, declaring 20 base units for 2 boxes. Posting under
    // the DB factor instead would silently book 24 units at a cost the buyer
    // priced against 10, so the only safe answer is to refuse.
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_cost_excl(2_400)
        .raw_factor_snapshot(10, 1)
        .build();
    assert_eq!(line.quantity_base, 20, "the client is coherent about its own wrong factor");

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), vec![line]),
    )
    .await
    .expect_err("a contradictory UoM factor must be refused");
    assert!(
        err.contains("factor") && err.contains("12/1"),
        "the error must state the authoritative factor, got: {err}"
    );
    assert_nothing_was_written(&db).await;
}

// ============================================================================
// 4 — a UoM belonging to another product is refused
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_uom_code_belonging_to_another_product_cannot_be_borrowed() {
    let db = store_with_derived_purchase_uoms().await;

    // "kg" is flour's purchase UoM. Coffee has no such row, so buying coffee by
    // the kilo must not resolve — the lookup is scoped by product_id.
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("kg", 1_000, 1)
        .qty(2)
        .unit_cost_excl(2_400)
        .build();

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), vec![line]),
    )
    .await
    .expect_err("a UoM the product does not have must be refused");
    assert!(err.contains("not an active unit of measure"), "got: {err}");
    assert_nothing_was_written(&db).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_product_uom_row_id_from_another_product_is_refused() {
    let db = store_with_derived_purchase_uoms().await;

    // The code resolves, but the client names flour's "kg" ROW as the identity of
    // coffee's "box". A client whose UoM list has drifted must not post.
    let foreign_uom_id = product_uom_id(&db, P_FLOUR, "kg").await;
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_cost_excl(2_400)
        .product_uom_id(&foreign_uom_id)
        .build();

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), vec![line]),
    )
    .await
    .expect_err("a foreign product_uoms row id must be refused");
    assert!(err.contains("is not the active"), "got: {err}");
    assert_nothing_was_written(&db).await;
}

// ============================================================================
// 5 — an inactive UoM is refused
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_uom_cannot_be_purchased_in() {
    let db = store_with_derived_purchase_uoms().await;
    // The shop used to buy coffee by the case of 24 and has retired it.
    seed_inactive_product_uom(&db, P_COFFEE, "case", 24, 1).await;

    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("case", 24, 1)
        .qty(2)
        .unit_cost_excl(4_800)
        .build();

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), vec![line]),
    )
    .await
    .expect_err("an inactive UoM must be refused");
    assert!(err.contains("not an active unit of measure"), "got: {err}");
    assert_nothing_was_written(&db).await;
}

// ============================================================================
// 6 — the fractional case, now over the authoritative factor
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_factor_produces_the_correct_fractional_base_cost() {
    let db = store_with_derived_purchase_uoms().await;

    // 20 kg of flour at $2.50/kg. The factor 1000 comes from the DB, so the
    // per-gram rate is derived from a conversion the client cannot influence.
    let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
        .uom("kg", 1_000, 1)
        .qty(20)
        .unit_cost_excl(250)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .unwrap();

    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_microcents FROM purchase_items").await,
        FLOUR_PER_GRAM,
        "GP-A03: $2.50/kg over the DB factor of 1000 is $0.0025/g"
    );
    assert_eq!(db.scalar_i64("SELECT quantity_base FROM purchase_items").await, 20_000);
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 20_000);
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_microcents FROM inventory_movements").await,
        FLOUR_PER_GRAM
    );
    // Quantity and cost came from the same resolved conversion, so the pool is
    // worth the $50.00 that was spent.
    assert_eq!(db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await, 5_000);
}

// ============================================================================
// 7 — weighted average over the server-derived base quantity
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_weighted_average_uses_the_server_derived_base_quantity() {
    let db = store_with_derived_purchase_uoms().await;

    // Both receipts are in the derived UoM. 10 kg at $2.50/kg then 10 kg at
    // $3.10/kg is 20,000 g averaging $0.0028/g — which only comes out right if
    // the blend weights are the DERIVED 10,000 g each.
    for price in [250, 310] {
        let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
            .uom("kg", 1_000, 1)
            .qty(10)
            .unit_cost_excl(price)
            .build();
        post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
            .await
            .unwrap();
    }

    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 20_000);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_FLOUR}'"
        ))
        .await,
        280_000
    );
    // $25.00 + $31.00 of stock, recovered to the cent.
    let value = db
        .scalar_i64(&format!(
            "SELECT (avg_cost_excl_vat_microcents * quantity_on_hand + {half}) / {scale}
               FROM products WHERE id='{P_FLOUR}'",
            half = COST_SCALE / 2,
            scale = COST_SCALE
        ))
        .await;
    assert_eq!(value, 5_600);
}

// ============================================================================
// 8 — last-purchase cost over the authoritative conversion
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn last_purchase_costing_reads_a_rate_derived_from_the_db_factor() {
    let db = store_with_derived_purchase_uoms().await;

    // Two receipts in kilos; the later one at $4.10/kg sets the last-purchase
    // rate. The movement it wrote carries a per-GRAM rate derived from the DB
    // factor, so a sale costed this way is right per base unit.
    for price in [250, 410] {
        let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
            .uom("kg", 1_000, 1)
            .qty(10)
            .unit_cost_excl(price)
            .build();
        post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
            .await
            .unwrap();
    }

    let sale_line = SaleLineBuilder::new(P_FLOUR, "Flour")
        .uom("g", 1, 1)
        .qty(1_000)
        .unit_incl(1)
        .build();
    let total = lines_total(std::slice::from_ref(&sale_line));
    let mut payload = sale_payload(vec![sale_line], vec![cash_usd(total)]);
    payload.cogs_method = "last_purchase".to_string();
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        410_000,
        "the last-purchase rate is $0.0041/g, derived from the DB factor of 1000"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        410
    );
}

// ============================================================================
// 9 — the real UI payload still posts
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_payload_the_purchases_page_sends_today_still_posts() {
    // `pages/Purchases.tsx` and the opening-stock form in `pages/Inventory.tsx`
    // both build their line from the product's own loaded `uoms` entry: they send
    // `productUomIdSnapshot`, `uomCodeSnapshot` and the factor from that row, and
    // `quantityBase` from `purchaseMath`. That payload agrees with the database
    // by construction, so the new boundary must be invisible to it.
    let db = store_with_derived_purchase_uoms().await;
    let box_uom_id = product_uom_id(&db, P_COFFEE, "box").await;

    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(5)
        .unit_cost_excl(2_400)
        .product_uom_id(&box_uom_id)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .expect("the current UI payload must keep posting unchanged");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 60);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        200 * COST_SCALE
    );
}

// ============================================================================
// 10 — the base UoM is unchanged
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_base_uom_purchase_behaves_exactly_as_before() {
    let db = store_with_derived_purchase_uoms().await;

    // Factor 1/1 — the overwhelmingly common case. Nothing about it changes.
    let line = PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build();
    assert_eq!(line.factor_num_snapshot, 1);
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .unwrap();

    assert_eq!(db.scalar_i64("SELECT quantity_base FROM purchase_items").await, 10);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        200 * COST_SCALE
    );
    assert_eq!(db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await, 2_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_opening_stock_purchase_resolves_its_uom_the_same_way() {
    // The opening-stock form posts `purchase_type = 'opening'` with no supplier.
    // It takes the same authoritative path.
    let db = store_with_derived_purchase_uoms().await;

    let line = PurchaseLineBuilder::new(P_FLOUR, "Flour")
        .uom("kg", 1_000, 1)
        .qty(3)
        .unit_cost_excl(250)
        .build();
    post_purchase_with_pool(db.pool(), purchase_payload("opening", None, vec![line]))
        .await
        .unwrap();

    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 3_000);
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_microcents FROM purchase_items").await,
        FLOUR_PER_GRAM
    );
    assert_eq!(
        db.scalar_string("SELECT movement_type FROM inventory_movements").await,
        "opening"
    );
    // Opening stock still raises no payable.
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}

// ============================================================================
// 11 — mixed lines resolve independently
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_products_and_uoms_each_resolve_against_their_own_product() {
    let db = store_with_derived_purchase_uoms().await;

    let lines = vec![
        // 2 boxes of 12 = 24 pieces at $2.00 each.
        PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .uom("box", 12, 1)
            .qty(2)
            .unit_cost_excl(2_400)
            .build(),
        // 4 kg = 4,000 g at $0.0025 each.
        PurchaseLineBuilder::new(P_FLOUR, "Flour")
            .uom("kg", 1_000, 1)
            .qty(4)
            .unit_cost_excl(250)
            .build(),
        // 10 pieces of coffee in its base UoM, on the same invoice.
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(210).build(),
    ];
    let payload = purchase_payload("normal", Some(SUPPLIER), lines);
    let purchase_id = payload.purchase_id.clone();
    post_purchase_with_pool(db.pool(), payload).await.unwrap();

    // Coffee: 24 pieces at $2.00 then 10 at $2.10 → 34 pieces averaging
    // $2.029411…, held to the microcent.
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 34);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        202_941_176
    );
    // Flour resolved over its own factor, untouched by coffee's.
    assert_eq!(quantity_on_hand(&db, P_FLOUR).await, 4_000);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_FLOUR}'"
        ))
        .await,
        FLOUR_PER_GRAM
    );

    // Three movements, and stock reconciles to them (the WP-02 invariant).
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_purchase_id='{purchase_id}'"
        ))
        .await,
        3
    );
    assert_eq!(movement_sum(&db, P_COFFEE).await, quantity_on_hand(&db, P_COFFEE).await);
    assert_eq!(movement_sum(&db, P_FLOUR).await, quantity_on_hand(&db, P_FLOUR).await);

    // The invoice total: $48.00 + $10.00 + $21.00 net.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT subtotal_excl_vat_cents FROM purchases WHERE id='{purchase_id}'"
        ))
        .await,
        4_800 + 1_000 + 2_100
    );
}

// ============================================================================
// 12 — one bad line rolls the whole invoice back
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_bad_line_rolls_back_the_entire_multi_line_purchase() {
    // The good line comes FIRST, so by the time the bad one is reached the
    // transaction has already written a header, an item, a movement and a stock
    // increment. All of it must disappear.
    let db = store_with_derived_purchase_uoms().await;

    let lines = vec![
        PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .uom("box", 12, 1)
            .qty(2)
            .unit_cost_excl(2_400)
            .build(),
        PurchaseLineBuilder::new(P_FLOUR, "Flour")
            .uom("kg", 1_000, 1)
            .qty(4)
            .unit_cost_excl(250)
            .raw_quantity_base(4) // claims 4 grams for 4 kilos
            .build(),
    ];

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), lines),
    )
    .await
    .expect_err("one structurally corrupt line must refuse the whole invoice");
    assert!(err.contains("base quantity"), "got: {err}");

    assert_nothing_was_written(&db).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unresolvable_uom_on_a_later_line_rolls_back_the_earlier_ones() {
    let db = store_with_derived_purchase_uoms().await;

    let lines = vec![
        PurchaseLineBuilder::new(P_FLOUR, "Flour")
            .uom("kg", 1_000, 1)
            .qty(4)
            .unit_cost_excl(250)
            .build(),
        // Coffee has no 'crate' UoM at all.
        PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .uom("crate", 48, 1)
            .qty(1)
            .unit_cost_excl(9_600)
            .build(),
    ];

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER), lines),
    )
    .await
    .expect_err("an unresolvable UoM must refuse the whole invoice");
    assert!(err.contains("not an active unit of measure"), "got: {err}");

    assert_nothing_was_written(&db).await;
}
