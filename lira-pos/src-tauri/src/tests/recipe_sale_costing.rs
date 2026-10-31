//! Recipe-derived SALE costing against a real database (WP-B2-B).
//!
//! WHAT THESE TESTS ARE ACTUALLY DEFENDING
//!
//! B2-A could cost a recipe in a preview. B2-B lets that figure reach a posted
//! financial document, which changes the stakes completely: a preview that is
//! wrong is re-read, and a posted `sale_items.unit_cogs_excl_vat_microcents` is
//! sealed by migration 012 and feeds every gross-profit figure the shop will
//! ever print. So everything here asserts on PERSISTED ROWS — the snapshot on
//! the line, the provenance beside it, the evidence rows under it, the ABSENCE
//! of any ingredient movement, and what the ingredients look like afterwards.
//!
//! The rules the suite exists to pin:
//!
//!   1. The rate is resolved from the DATABASE inside the posting transaction.
//!      There is no field for a recipe, an ingredient or a rate on the wire and
//!      no test may add one.
//!   2. Missing cost is not zero. An ingredient with no basis stops the till;
//!      a DOCUMENTED zero posts.
//!   3. A posted cost never moves — not when an ingredient is repriced, not
//!      when version 2 is published, not when a unit is redefined, not when the
//!      product's costing method changes.
//!   4. NO INGREDIENT STOCK MOVES. B2-B is an estimated food cost, not a
//!      consumption document. That is WP-B3.
//!   5. A posted sale never references missing or incomplete evidence.

use crate::catalog::{
    save_product_with_pool, SaveProductPayload, RECIPE_COSTING_NEEDS_ACTIVE_RECIPE,
    RECIPE_COSTING_NEEDS_SERVICE,
};
use crate::posting::{post_credit_memo_with_pool, post_sale_with_pool};
use crate::recipes::{
    activate_recipe_with_pool, retire_recipe_with_pool, save_recipe_draft_with_pool,
    ActivateRecipePayload, RecipeComponentInput, RetireRecipePayload, SaveRecipeDraftPayload,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_BURGER: &str = "00000000-0000-0000-0000-00000000c100";
const P_BUN: &str = "00000000-0000-0000-0000-00000000c101";
const P_PATTY: &str = "00000000-0000-0000-0000-00000000c102";
const P_SAUCE: &str = "00000000-0000-0000-0000-00000000c103";
const P_CHEESE: &str = "00000000-0000-0000-0000-00000000c104";
const P_SAMPLE: &str = "00000000-0000-0000-0000-00000000c105";
const P_UNPRICED: &str = "00000000-0000-0000-0000-00000000c106";
const P_COFFEE: &str = "00000000-0000-0000-0000-00000000c1ff";
const DRIVER_ID: &str = "00000000-0000-0000-0000-00000000cd01";

/// A kitchen that can both cost and SELL:
///
///   * Burger — a SERVICE, the thing the recipe makes, $11.10 incl VAT.
///   * Bun    — stocked, base `each`, $0.22 each (22,000,000 mc), documented.
///   * Patty  — stocked, base `g`, $0.0085/g (850,000 mc), documented, and
///              carrying a `kg` unit so a fixture can state 0.15 kg.
///   * Sauce  — stocked, base `ml`, $0.0012/ml (120,000 mc), documented.
///   * Cheese — stocked, base `each`, $0.30 each (30,000,000 mc), documented.
///   * Coffee — STOCKED, purchase-valued. The control that must not change.
async fn kitchen() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            ..ProductSpec::stocked(P_BURGER, "SKU-BURGER", "Greaz Burger")
        },
    )
    .await;
    for (id, sku, name, base, rate) in [
        (P_BUN, "SKU-BUN", "Burger bun", "each", 22_000_000_i64),
        (P_PATTY, "SKU-PATTY", "Beef patty mince", "g", 850_000),
        (P_SAUCE, "SKU-SAUCE", "Greaz sauce", "ml", 120_000),
        (P_CHEESE, "SKU-CHEESE", "Cheddar slice", "each", 30_000_000),
    ] {
        seed_product(
            &db,
            &ProductSpec {
                quantity_on_hand: 1_000,
                base_uom_code: base,
                ..ProductSpec::stocked(id, sku, name)
            },
        )
        .await;
        seed_product_avg_cost_microcents(&db, id, rate, rate).await;
        seed_purchase_movement(&db, id, rate).await;
    }
    seed_product_uom(&db, P_PATTY, "kg", 1_000, 1).await;

    // THE TWO ZEROES, seeded as the two different facts they are, because
    // `inventory_movements` is append-only and neither state can be forged by
    // editing one afterwards.
    //
    //   * Sample  — a free case. Zero average WITH a purchase movement that
    //     states zero: the $0.00 is a documented ANSWER.
    //   * Unpriced — never purchased and never priced. Zero average with NO
    //     movement at all: the $0.00 is the ABSENCE of an answer.
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 1_000,
            base_uom_code: "each",
            ..ProductSpec::stocked(P_SAMPLE, "SKU-SAMPLE", "Supplier sample pickle")
        },
    )
    .await;
    seed_purchase_movement(&db, P_SAMPLE, 0).await;

    // The unpriced one is a SERVICE, which is what makes it expressible: a
    // service can carry a Manual Cost (so a recipe naming it can be published),
    // and a service on purchase valuation can never acquire a basis, because
    // the only writer of `avg_cost_*` is a purchase and a service is not
    // purchased into stock.
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            base_uom_code: "each",
            ..ProductSpec::stocked(P_UNPRICED, "SKU-UNPRICED", "Unpriced garnish")
        },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-COFFEE", "Coffee 250g")
        },
    )
    .await;
    db
}

fn component(product_id: &str, num: i64, den: i64, uom: &str) -> RecipeComponentInput {
    RecipeComponentInput {
        component_product_id: product_id.to_string(),
        quantity_num: num,
        quantity_den: den,
        uom_code: uom.to_string(),
        waste_bps: 0,
    }
}

fn wasteful(product_id: &str, num: i64, den: i64, uom: &str, bps: i64) -> RecipeComponentInput {
    RecipeComponentInput {
        waste_bps: bps,
        ..component(product_id, num, den, uom)
    }
}

fn rid(tag: &str) -> String {
    format!("00000000-0000-0000-0000-{:0>12}", tag)
}

/// An UPDATE payload for the burger, as the Products form sends one.
fn burger_update() -> SaveProductPayload {
    SaveProductPayload {
        product_id: P_BURGER.to_string(),
        store_id: STORE_ID.to_string(),
        mode: "update".to_string(),
        sku: Some("SKU-BURGER".to_string()),
        name: "Greaz Burger".to_string(),
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

fn draft(recipe_id: &str, components: Vec<RecipeComponentInput>) -> SaveRecipeDraftPayload {
    SaveRecipeDraftPayload {
        store_id: STORE_ID.to_string(),
        product_id: P_BURGER.to_string(),
        recipe_id: recipe_id.to_string(),
        yield_quantity_base: 1,
        notes: None,
        components,
    }
}

/// Publish a recipe for the burger and return its id.
async fn publish(db: &TempDb, tag: &str, components: Vec<RecipeComponentInput>) -> String {
    let r = rid(tag);
    save_recipe_draft_with_pool(db.pool(), draft(&r, components))
        .await
        .unwrap_or_else(|e| panic!("draft {tag} must save: {e}"));
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("recipe {tag} must publish: {e}"));
    r
}

/// THE four-ingredient burger: 1 bun, 150 g patty at 5% waste, 25 ml sauce,
/// half a cheddar slice.
///
///   bun    1       x 22,000,000                        =  22,000,000
///   patty  150     x    850,000 x 1.05                 = 133,875,000
///   sauce  25      x    120,000                        =   3,000,000
///   cheese 1/2     x 30,000,000                        =  15,000,000
///                                                        -----------
///                                                        173,875,000 mc
///                                                      = $1.73875
fn four_ingredient_burger() -> Vec<RecipeComponentInput> {
    vec![
        component(P_BUN, 1, 1, "each"),
        wasteful(P_PATTY, 150, 1, "g", 500),
        component(P_SAUCE, 25, 1, "ml"),
        component(P_CHEESE, 1, 2, "each"),
    ]
}

const BURGER_RATE_MC: i64 = 173_875_000;

/// Switch the burger onto recipe costing. Separate from publishing, because
/// the two are separate acts and several tests need only one of them.
async fn use_recipe_costing(db: &TempDb) {
    db.exec(&format!(
        "UPDATE products SET costing_method='recipe' WHERE id='{P_BURGER}'"
    ))
    .await;
}

fn burger_sale(qty: i64) -> crate::posting::PostSalePayload {
    sale_payload(
        vec![SaleLineBuilder::new(P_BURGER, "Greaz Burger")
            .service(true)
            .qty(qty)
            .unit_incl(1110)
            .build()],
        vec![cash_usd(1110 * qty)],
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

/// Every evidence row of a sale, as a readable line, in stored order.
async fn evidence(db: &TempDb, sale_id: &str) -> Vec<String> {
    use sqlx::Row;
    sqlx::query(
        "SELECT component_name_snapshot AS n, uom_code AS u,
                quantity_num AS qn, quantity_den AS qd,
                factor_num_snapshot AS fn_, factor_den_snapshot AS fd,
                waste_bps AS w, unit_cost_excl_vat_microcents AS rate,
                cost_source AS src, contribution_microcents AS contrib
           FROM sale_item_recipe_costs
          WHERE sale_id = ?
          ORDER BY sort_order, component_name_snapshot",
    )
    .bind(sale_id)
    .fetch_all(db.pool())
    .await
    .unwrap_or_else(|e| panic!("read evidence of {sale_id}: {e}"))
    .iter()
    .map(|r| {
        format!(
            "{} {}/{} {} @{}/{} w{} rate={} src={} contrib={}",
            r.try_get::<String, _>("n").unwrap(),
            r.try_get::<i64, _>("qn").unwrap(),
            r.try_get::<i64, _>("qd").unwrap(),
            r.try_get::<String, _>("u").unwrap(),
            r.try_get::<i64, _>("fn_").unwrap(),
            r.try_get::<i64, _>("fd").unwrap(),
            r.try_get::<i64, _>("w").unwrap(),
            r.try_get::<i64, _>("rate").unwrap(),
            r.try_get::<String, _>("src").unwrap(),
            r.try_get::<i64, _>("contrib").unwrap(),
        )
    })
    .collect()
}

async fn recipe_stamp(db: &TempDb, sale_id: &str) -> (String, i64) {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT COALESCE(recipe_id,'NULL') AS r, COALESCE(recipe_version,-1) AS v
           FROM sale_items WHERE sale_id = ?",
    )
    .bind(sale_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    (row.try_get("r").unwrap(), row.try_get("v").unwrap())
}

// ============================================================================
// 1. The headline case: a four-ingredient burger, costed from its recipe
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_four_ingredient_burger_is_costed_from_its_published_recipe() {
    let db = kitchen().await;
    let recipe_id = publish(&db, "r001", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, rate_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, BURGER_RATE_MC, "the recipe rate, in microcents");
    assert_eq!(rate_cents, 174, "the rounded display mirror beside it");
    assert_eq!(line_cents, 174, "one unit, so the line COGS is the rate");
    assert_eq!(source, "recipe", "and the provenance says where it came from");

    // The line names WHICH recipe and WHICH version.
    assert_eq!(recipe_stamp(&db, &sale_id).await, (recipe_id, 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fractional_quantities_and_waste_are_costed_exactly() {
    // Half a slice and a 5% waste allowance are the two things a recipe can
    // express that `sale_items.quantity` cannot, and both are in the figures
    // above. Asserted per ingredient so a compensating pair of errors in the
    // total cannot hide.
    let db = kitchen().await;
    publish(&db, "r002", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        evidence(&db, &sale_id).await,
        vec![
            "Burger bun 1/1 each @1/1 w0 rate=22000000 src=purchase_average contrib=22000000",
            "Beef patty mince 150/1 g @1/1 w500 rate=850000 src=purchase_average contrib=133875000",
            "Greaz sauce 25/1 ml @1/1 w0 rate=120000 src=purchase_average contrib=3000000",
            "Cheddar slice 1/2 each @1/1 w0 rate=30000000 src=purchase_average contrib=15000000",
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_rate_multiplies_by_the_sale_quantity_once_and_rounds_once() {
    // The rate is per base unit and the line is three of them. 173,875,000 mc
    // x 3 = 521,625,000 mc = 521.625 cents, which rounds HALF AWAY FROM ZERO to
    // 522 — and never to 3 x round(1.73875) = 3 x 174 = 522... which happens to
    // agree here, so the test also pins a case where it does NOT.
    let db = kitchen().await;
    publish(&db, "r003", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(3);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, line_cents, _) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, BURGER_RATE_MC, "the RATE does not scale");
    assert_eq!(line_cents, 522, "522.625 cents, rounded once at the boundary");

    // The sale header's COGS total is the same figure.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        522
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sub_cent_recipe_rate_is_not_rounded_before_it_is_extended() {
    // The defect `extended_cost_cents` exists to prevent, one level up: a
    // recipe whose plate cost is a fraction of a cent must cost a hundred
    // plates at the fraction, not at zero.
    //
    // 1 ml of sauce at 120,000 mc = $0.0012. A hundred of them is 12 cents;
    // rounding the rate first would make it 0.
    let db = kitchen().await;
    publish(&db, "r004", vec![component(P_SAUCE, 1, 1, "ml")]).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(100);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, rate_cents, line_cents, _) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 120_000, "the precise rate is what is stored");
    assert_eq!(rate_cents, 0, "its cents mirror rounds to nothing, as it must");
    assert_eq!(line_cents, 12, "and the LINE is costed from the rate, not the mirror");
}

// ============================================================================
// 2. Missing cost is not zero
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_documented_zero_cost_ingredient_posts_normally() {
    // A free case, a supplier sample, an opening count valued at nothing. The
    // $0.00 is an ANSWER and the sale is costed with it — here, at the bun
    // alone, because the sample contributes exactly what it cost.
    let db = kitchen().await;
    publish(
        &db,
        "r010",
        vec![component(P_BUN, 1, 1, "each"), component(P_SAMPLE, 1, 1, "each")],
    )
    .await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 22_000_000, "the bun, plus a documented nothing");
    assert_eq!(source, "recipe");
    // And the zero is RECORDED as a purchase-average answer, not hidden.
    assert!(
        evidence(&db, &sale_id)
            .await
            .iter()
            .any(|e| e.contains("Supplier sample pickle")
                && e.contains("rate=0")
                && e.contains("src=purchase_average")),
        "{:?}",
        evidence(&db, &sale_id).await
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ingredient_with_no_cost_basis_refuses_the_sale() {
    // The other zero. The ingredient has never been purchased and nobody typed
    // a cost, so its $0.00 is the ABSENCE of an answer — and posting at that
    // figure is exactly how a restaurant acquires a year of 100% margins with
    // no way to date the start of it. The till stops and names the ingredient.
    let db = kitchen().await;
    // Published while the garnish still carried a Manual Cost, which is the
    // only way a recipe naming it could have been activated at all: activation
    // refuses an ingredient with no cost. The owner then clears the manual
    // figure back onto purchase valuation it has no document for — the
    // reconfiguration that is the one route to this state, since a purchase
    // basis is otherwise monotone.
    seed_manual_cost(&db, P_UNPRICED, 5_000_000).await;
    publish(
        &db,
        "r011",
        vec![component(P_BUN, 1, 1, "each"), component(P_UNPRICED, 1, 1, "each")],
    )
    .await;
    use_recipe_costing(&db).await;
    db.exec(&format!(
        "UPDATE products
            SET costing_method='purchase_average', standard_cost_excl_vat_microcents=NULL
          WHERE id='{P_UNPRICED}'"
    ))
    .await;

    let err = post_sale_with_pool(db.pool(), burger_sale(1)).await.unwrap_err();
    assert!(err.contains("Unpriced garnish"), "it must name the ingredient: {err}");
    assert!(err.contains("no cost on file"), "{err}");

    // NOTHING was written, and the receipt sequence is untouched.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 0);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'")
            .await,
        "1",
        "a refused sale consumes no receipt number"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_product_with_no_active_recipe_refuses_the_sale() {
    // Unreachable through the screens — migration 022's trigger refuses the
    // configuration, and `retire_recipe` refuses to retire the incumbent while
    // the product uses it — so the row is forged the way a migration bug, an
    // import or a hand-edited database would leave it. The posting command
    // must not depend on the schema having held.
    let db = kitchen().await;
    db.exec("DROP TRIGGER trg_products_costing_coherence_upd").await;
    use_recipe_costing(&db).await;

    let err = post_sale_with_pool(db.pool(), burger_sale(1)).await.unwrap_err();
    assert!(err.contains("no published recipe"), "{err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posting_refuses_a_recipe_costed_stocked_line_even_if_the_row_existed() {
    // Belt and braces, exactly as WP-B1 does for Manual Cost. A recipe rate on
    // a stocked line would be stamped onto the sale's `inventory_movements`
    // row while the pool those goods left says something else.
    let db = kitchen().await;
    publish(&db, "r012", four_ingredient_burger()).await;
    db.exec("DROP TRIGGER trg_products_costing_coherence_upd").await;
    db.exec(&format!(
        "UPDATE products
            SET costing_method='recipe', is_service=0, quantity_on_hand=50
          WHERE id='{P_BURGER}'"
    ))
    .await;

    let payload = sale_payload(
        vec![SaleLineBuilder::new(P_BURGER, "Greaz Burger")
            .qty(1)
            .unit_incl(1110)
            .build()],
        vec![cash_usd(1110)],
    );
    let err = post_sale_with_pool(db.pool(), payload).await.unwrap_err();
    assert!(
        err.contains("stocked product") && err.contains("Recipe costing"),
        "{err}"
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
}

// ============================================================================
// 3. A posted cost is HISTORY
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repricing_an_ingredient_moves_the_next_sale_and_not_the_last_one() {
    let db = kitchen().await;
    publish(&db, "r020", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let first = burger_sale(1);
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.unwrap();

    // The patty doubles in price.
    seed_product_avg_cost_microcents(&db, P_PATTY, 1_700_000, 1_700_000).await;

    let second = burger_sale(1);
    let second_id = second.sale_id.clone();
    post_sale_with_pool(db.pool(), second).await.unwrap();

    assert_eq!(line_cogs(&db, &first_id).await.0, BURGER_RATE_MC, "yesterday stands");
    assert_eq!(
        line_cogs(&db, &second_id).await.0,
        BURGER_RATE_MC + 133_875_000,
        "today follows the new rate: the patty's contribution doubles"
    );

    // And the EVIDENCE of the first sale still records the old rate.
    assert!(
        evidence(&db, &first_id)
            .await
            .iter()
            .any(|e| e.contains("Beef patty") && e.contains("rate=850000")),
        "the explanation is history too"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishing_version_two_does_not_restate_a_sale_costed_from_version_one() {
    let db = kitchen().await;
    let v1 = publish(&db, "r021", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let first = burger_sale(1);
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.unwrap();

    // Version 2: the cheese is dropped.
    let v2 = publish(
        &db,
        "r022",
        vec![
            component(P_BUN, 1, 1, "each"),
            wasteful(P_PATTY, 150, 1, "g", 500),
            component(P_SAUCE, 25, 1, "ml"),
        ],
    )
    .await;

    let second = burger_sale(1);
    let second_id = second.sale_id.clone();
    post_sale_with_pool(db.pool(), second).await.unwrap();

    assert_eq!(line_cogs(&db, &first_id).await.0, BURGER_RATE_MC);
    assert_eq!(
        line_cogs(&db, &second_id).await.0,
        BURGER_RATE_MC - 15_000_000,
        "the cheese is gone from the NEXT sale only"
    );
    assert_eq!(recipe_stamp(&db, &first_id).await, (v1.clone(), 1));
    assert_eq!(recipe_stamp(&db, &second_id).await, (v2, 2));

    // v1 is retired and the first sale still points at it — which is the whole
    // reason the identity is recorded on the line.
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM recipes WHERE id='{v1}'"))
            .await,
        "retired"
    );
    assert_eq!(evidence(&db, &first_id).await.len(), 4);
    assert_eq!(evidence(&db, &second_id).await.len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redefining_an_ingredients_unit_does_not_move_a_posted_cost() {
    // The B2-A snapshot argument, carried into a posted document. The recipe
    // states 0.15 kg and a kg was 1000 g when it was published; the shop then
    // redefines a kg as 2000 g. The posted cost, and its explanation, still
    // describe the conversion that was published.
    let db = kitchen().await;
    publish(&db, "r023", vec![component(P_PATTY, 15, 100, "kg")]).await;
    use_recipe_costing(&db).await;

    let first = burger_sale(1);
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.unwrap();
    // 0.15 x 1000 g x 850,000 = 127,500,000
    assert_eq!(line_cogs(&db, &first_id).await.0, 127_500_000);

    db.exec(&format!(
        "UPDATE product_uoms SET factor_num=2000 WHERE product_id='{P_PATTY}' AND uom_code='kg'"
    ))
    .await;

    let second = burger_sale(1);
    let second_id = second.sale_id.clone();
    post_sale_with_pool(db.pool(), second).await.unwrap();

    assert_eq!(
        line_cogs(&db, &first_id).await.0,
        127_500_000,
        "the posted cost is untouched"
    );
    assert_eq!(
        line_cogs(&db, &second_id).await.0,
        127_500_000,
        "and so is the NEXT one: a published recipe's conversion is its own, \
         so an edited factor changes neither"
    );
    for id in [&first_id, &second_id] {
        assert!(
            evidence(&db, id).await[0].contains("@1000/1"),
            "the explanation names the published conversion: {:?}",
            evidence(&db, id).await
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_the_products_costing_method_does_not_restate_history() {
    let db = kitchen().await;
    publish(&db, "r024", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    seed_manual_cost(&db, P_BURGER, 500_000_000).await;

    let (rate_mc, _, _, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, BURGER_RATE_MC, "the posted rate stands");
    assert_eq!(source, "recipe", "and so does its provenance");
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_an_ingredient_does_not_change_a_posted_explanation() {
    let db = kitchen().await;
    publish(&db, "r025", vec![component(P_BUN, 1, 1, "each")]).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    db.exec(&format!(
        "UPDATE products SET name='Brioche bun' WHERE id='{P_BUN}'"
    ))
    .await;

    assert!(
        evidence(&db, &sale_id).await[0].contains("Burger bun"),
        "the evidence names what the recipe said at the time"
    );
}

// ============================================================================
// 4. Exactly-once, and the evidence that goes with it
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replayed_recipe_sale_returns_its_original_cost_and_duplicates_no_evidence() {
    let db = kitchen().await;
    publish(&db, "r030", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    let first = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();
    let again = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();

    assert_eq!(first.receipt_number, again.receipt_number);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        4,
        "a replay writes no second explanation"
    );
    assert_eq!(line_cogs(&db, &sale_id).await.0, BURGER_RATE_MC);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_resolves_after_the_product_is_reconfigured_out_of_recipe_costing() {
    // The ordering WP-B1 established and B2-B inherits: the idempotency
    // resolution runs BEFORE the costing branch, so a till that lost an answer
    // still gets its own receipt back even when the product has since been
    // changed into a state a fresh sale would be refused in.
    let db = kitchen().await;
    let v1 = publish(&db, "r031", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    let first = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();

    // The owner switches the item to Manual Cost and retires the recipe.
    seed_manual_cost(&db, P_BURGER, 500_000_000).await;
    retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v1,
        },
    )
    .await
    .unwrap();

    let again = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();
    assert_eq!(first.receipt_number, again.receipt_number);
    assert_eq!(line_cogs(&db, &sale_id).await.0, BURGER_RATE_MC);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        4
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_identity_with_different_content_is_still_a_conflict() {
    let db = kitchen().await;
    publish(&db, "r032", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();

    let mut rival = replay_of(&payload);
    rival.lines[0].quantity_in_uom = 2;
    rival.lines[0].quantity_base = 2;
    let err = post_sale_with_pool(db.pool(), rival).await.unwrap_err();
    assert!(
        err.contains("already exists") && err.contains("different basket line"),
        "{err}"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        4
    );
}

// ============================================================================
// 5. Financial isolation: no ingredient stock moves
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selling_a_recipe_costed_item_moves_no_ingredient_stock() {
    // THE rule that separates B2-B from B3. A recipe COGS figure is an
    // estimated ingredient cost; it is not a consumption document, and nothing
    // here may pretend otherwise.
    let db = kitchen().await;
    publish(&db, "r040", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let movements_before = db.count("SELECT COUNT(*) FROM inventory_movements").await;
    let before: Vec<i64> = {
        let mut v = Vec::new();
        for id in [P_BUN, P_PATTY, P_SAUCE, P_CHEESE] {
            v.push(
                db.scalar_i64(&format!(
                    "SELECT quantity_on_hand FROM products WHERE id='{id}'"
                ))
                .await,
            );
        }
        v
    };

    let payload = burger_sale(5);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements").await,
        movements_before,
        "not one movement row: the burger is a service and no ingredient is consumed"
    );
    for (i, id) in [P_BUN, P_PATTY, P_SAUCE, P_CHEESE].iter().enumerate() {
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT quantity_on_hand FROM products WHERE id='{id}'"
            ))
            .await,
            before[i],
            "ingredient {id} stock is untouched"
        );
    }
    // Nor is any ingredient's cost pool re-blended.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_PATTY}'"
        ))
        .await,
        850_000
    );
    assert_eq!(line_cogs(&db, &sale_id).await.3, "recipe");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_valued_and_a_manual_costed_line_are_unaffected() {
    // The regression half: B2-B adds a branch, and the other three must behave
    // exactly as they did. One sale, three lines, three provenances.
    let db = kitchen().await;
    publish(&db, "r041", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            ..ProductSpec::stocked(
                "00000000-0000-0000-0000-00000000c1aa",
                "SKU-WRAP",
                "Greaz Wrap",
            )
        },
    )
    .await;
    seed_manual_cost(&db, "00000000-0000-0000-0000-00000000c1aa", 400_000_000).await;

    let payload = sale_payload(
        vec![
            SaleLineBuilder::new(P_BURGER, "Greaz Burger")
                .service(true)
                .qty(1)
                .unit_incl(1110)
                .build(),
            SaleLineBuilder::new("00000000-0000-0000-0000-00000000c1aa", "Greaz Wrap")
                .service(true)
                .qty(1)
                .unit_incl(888)
                .build(),
            SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
                .qty(2)
                .unit_incl(500)
                .build(),
        ],
        vec![cash_usd(1110 + 888 + 1000)],
    );
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT product_name_snapshot AS n, cogs_source AS s,
                unit_cogs_excl_vat_microcents AS r,
                COALESCE(recipe_id,'-') AS rid
           FROM sale_items WHERE sale_id = ? ORDER BY product_name_snapshot",
    )
    .bind(&sale_id)
    .fetch_all(db.pool())
    .await
    .unwrap();
    let got: Vec<String> = rows
        .iter()
        .map(|r| {
            format!(
                "{} {} {} recipe={}",
                r.try_get::<String, _>("n").unwrap(),
                r.try_get::<String, _>("s").unwrap(),
                r.try_get::<i64, _>("r").unwrap(),
                if r.try_get::<String, _>("rid").unwrap() == "-" { "no" } else { "yes" }
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            "Coffee 250g purchase_average 200000000 recipe=no",
            "Greaz Burger recipe 173875000 recipe=yes",
            "Greaz Wrap standard 400000000 recipe=no",
        ]
    );

    // The coffee still moved stock; the other two did not.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        1
    );
    // And only the recipe line has evidence.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        4
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_split_tender_delivery_order_costs_and_settles_exactly_as_before() {
    // Costing is orthogonal to settlement, and this is the test that says so
    // rather than leaving it to be assumed. A driver-collected delivery of a
    // recipe-costed burger: the receivable, the shift and the VAT are what
    // WP-6/7 made them, and the COGS is the recipe's.
    let db = kitchen().await;
    publish(&db, "r042", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    seed_driver(&db, DRIVER_ID, "Sami").await;

    let payload = delivery_payload(
        vec![SaleLineBuilder::new(P_BURGER, "Greaz Burger")
            .service(true)
            .qty(2)
            .unit_incl(1110)
            .build()],
        DRIVER_ID,
        200,
    );
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let (rate_mc, _, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, BURGER_RATE_MC);
    assert_eq!(line_cents, 348, "347.75 cents, rounded once");
    assert_eq!(source, "recipe");

    // The receivable is the FOOD total, and the fee is in neither figure.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT amount_cents FROM driver_ledger WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        2220
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT delivery_fee_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        200
    );
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
}

// ============================================================================
// 6. Returns
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refunded_prepared_burger_reverses_revenue_and_not_the_food_cost() {
    // The brief's rule, and it needs no new code: whether a line may be
    // restocked is decided by whether the SALE produced an inventory movement,
    // and a service line produced none. So the memo reverses the money and the
    // VAT, restocks nothing, reverses no cost and blends nothing into any pool.
    // The food was made and discarded, and the margin on it is lost — which is
    // the truth about it.
    let db = kitchen().await;
    publish(&db, "r050", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();
    let sale_item_id = payload.lines[0].sale_item_id.clone();

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&sale_item_id).qty(1).restock(false).build()],
        vec![refund_cash_usd(1110)],
    );
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo).await.unwrap();

    // Revenue and VAT came back.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT total_incl_vat_cents FROM sales_credit_memos WHERE id='{memo_id}'"
        ))
        .await,
        1110
    );
    // The cost did NOT.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(cogs_reversed_cents, 0) FROM sales_credit_memos WHERE id='{memo_id}'"
        ))
        .await,
        0,
        "a prepared item that was never restocked reverses no food cost"
    );
    // No ingredient moved, in either direction.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_credit_memo_id='{memo_id}'"
        ))
        .await,
        0
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_PATTY}'"
        ))
        .await,
        850_000
    );
    // And the sale's own cost snapshot and evidence are untouched.
    assert_eq!(line_cogs(&db, &sale_id).await.0, BURGER_RATE_MC);
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
}

// ============================================================================
// 7. The evidence is sealed, and a sale cannot post without it
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posted_recipe_cost_evidence_takes_no_update_no_delete_and_no_new_row() {
    let db = kitchen().await;
    publish(&db, "r060", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    let sale_item_id = payload.lines[0].sale_item_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    for (sql, expect) in [
        (
            format!(
                "UPDATE sale_item_recipe_costs SET unit_cost_excl_vat_microcents = 1
                  WHERE sale_id='{sale_id}'"
            ),
            "immutable",
        ),
        (
            format!("DELETE FROM sale_item_recipe_costs WHERE sale_id='{sale_id}'"),
            "append-only",
        ),
        (
            format!(
                "INSERT INTO sale_item_recipe_costs (
                   id, sale_id, sale_item_id, store_id, recipe_id, recipe_version,
                   component_product_id, component_name_snapshot, uom_code,
                   quantity_num, quantity_den, factor_num_snapshot, factor_den_snapshot,
                   waste_bps, unit_cost_excl_vat_microcents, cost_source,
                   contribution_microcents, sort_order)
                 SELECT 'smuggled', '{sale_id}', '{sale_item_id}', '{STORE_ID}',
                        recipe_id, recipe_version, '{P_COFFEE}', 'Smuggled', 'each',
                        1, 1, 1, 1, 0, 999, 'standard', 999, 9
                   FROM sale_items WHERE id='{sale_item_id}'"
            ),
            "posted sale",
        ),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(e.contains(expect), "expected {expect:?} in: {e}");
    }

    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        4
    );
    assert_eq!(
        db.scalar_i64("SELECT MIN(unit_cost_excl_vat_microcents) FROM sale_item_recipe_costs")
            .await,
        120_000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_cannot_post_with_a_recipe_line_that_has_no_evidence() {
    // The engine's own guarantee, proved by building the half-state by hand:
    // a draft sale with a recipe-costed line and no evidence must not be
    // promotable. `post_sale` can never produce this, which is the point —
    // the rule is a property of the database, not of one command.
    let db = kitchen().await;
    let recipe_id = publish(&db, "r061", four_ingredient_burger()).await;

    db.exec(&format!(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
            exchange_rate_lbp_per_usd, exchange_rate_id,
            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
            discount_cents, cogs_total_cents, cogs_method, sale_type, status, posted_at)
         VALUES ('halfsale', '{STORE_ID}', '{SHIFT_ID}', '{USER_ID}', 9001,
            {RATE_LBP_PER_USD}, '{RATE_ID}', 1000, 110, 1110, 0, 174,
            'weighted_average', 'normal', 'draft', NULL)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_items (id, sale_id, store_id, product_id,
            product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
            quantity, unit_price_excl_vat_cents, unit_price_incl_vat_cents,
            line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
            unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
            unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
            factor_num_snapshot, factor_den_snapshot, cogs_source,
            recipe_id, recipe_version)
         VALUES ('halfline', 'halfsale', '{STORE_ID}', '{P_BURGER}', 'Greaz Burger',
            '{VAT_STD_ID}', 1100, 1, 1000, 1110, 1000, 110, 1110,
            174, 174, 173875000, 1, 'each', 1, 1, 'recipe', '{recipe_id}', 1)"
    ))
    .await;

    let e = db
        .exec_err(
            "UPDATE sales SET status='posted', posted_at='2026-01-01T00:00:00.000Z'
              WHERE id='halfsale'",
        )
        .await;
    assert!(e.contains("no cost evidence"), "{e}");
    assert_eq!(
        db.scalar_string("SELECT status FROM sales WHERE id='halfsale'").await,
        "draft",
        "and it stays a draft"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_line_cannot_claim_a_recipe_it_was_not_costed_from() {
    let db = kitchen().await;
    let recipe_id = publish(&db, "r062", four_ingredient_burger()).await;
    db.exec(&format!(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
            exchange_rate_lbp_per_usd, exchange_rate_id,
            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
            discount_cents, cogs_total_cents, cogs_method, sale_type, status, posted_at)
         VALUES ('s2', '{STORE_ID}', '{SHIFT_ID}', '{USER_ID}', 9002,
            {RATE_LBP_PER_USD}, '{RATE_ID}', 1000, 110, 1110, 0, 0,
            'weighted_average', 'normal', 'draft', NULL)"
    ))
    .await;

    let line = |id: &str, src: &str, rid: &str, ver: &str| {
        format!(
            "INSERT INTO sale_items (id, sale_id, store_id, product_id,
                product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
                quantity, unit_price_excl_vat_cents, unit_price_incl_vat_cents,
                line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
                unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
                factor_num_snapshot, factor_den_snapshot, cogs_source,
                recipe_id, recipe_version)
             VALUES ('{id}', 's2', '{STORE_ID}', '{P_BURGER}', 'Greaz Burger',
                '{VAT_STD_ID}', 1100, 1, 1000, 1110, 1000, 110, 1110,
                0, 0, 0, 1, 'each', 1, 1, {src}, {rid}, {ver})"
        )
    };

    // `recipe` with no identity.
    let e = db.exec_err(&line("l1", "'recipe'", "NULL", "NULL")).await;
    assert!(e.contains("must record which recipe version"), "{e}");

    // An identity under a different provenance.
    let e = db
        .exec_err(&line("l2", "'standard'", &format!("'{recipe_id}'"), "1"))
        .await;
    assert!(e.contains("only name a recipe when it was costed"), "{e}");

    // A version that is not the one the identity names.
    let e = db
        .exec_err(&line("l3", "'recipe'", &format!("'{recipe_id}'"), "7"))
        .await;
    assert!(e.contains("own store, and of its own product"), "{e}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items WHERE sale_id='s2'").await, 0);
}

// ============================================================================
// 8. Configuration
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retiring_the_recipe_is_refused_while_the_item_uses_it() {
    // B2-A's guard, now load-bearing: it is what makes
    // "a recipe-costed product always has a recipe" true from the other end.
    let db = kitchen().await;
    let r = publish(&db, "r070", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let err = retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap_err();
    assert!(err.contains("costed from its recipe"), "{err}");
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM recipes WHERE id='{r}'")).await,
        "active"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_accepts_recipe_costing_once_a_recipe_is_published() {
    let db = kitchen().await;
    publish(&db, "r071", four_ingredient_burger()).await;

    let mut payload = burger_update();
    payload.costing_method = Some("recipe".to_string());
    save_product_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT costing_method FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        "recipe"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_recipe_costing_without_one() {
    let db = kitchen().await;
    let mut payload = burger_update();
    payload.costing_method = Some("recipe".to_string());

    let err = save_product_with_pool(db.pool(), payload).await.unwrap_err();
    assert_eq!(err, RECIPE_COSTING_NEEDS_ACTIVE_RECIPE);
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT costing_method FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        "purchase_average"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_product_refuses_recipe_costing_for_a_stocked_item() {
    let db = kitchen().await;
    publish(&db, "r072", four_ingredient_burger()).await;

    let mut payload = burger_update();
    payload.is_service = false;
    payload.costing_method = Some("recipe".to_string());

    let err = save_product_with_pool(db.pool(), payload).await.unwrap_err();
    assert_eq!(err, RECIPE_COSTING_NEEDS_SERVICE);
}

// ============================================================================
// 9. THE DIRECT-SQL ATTACK MATRIX (P1-A and P1-B)
//
// Every test in this section goes round `post_sale` entirely and writes the
// rows by hand against a real SQLite file, because that is the only thing that
// tests what the claim is about: the INVARIANT IS A PROPERTY OF THE ENGINE,
// not of one command. A suite that can only reach the database through
// `post_sale` proves that `post_sale` is careful, which nobody doubted — it
// says nothing about an import, a script, a second terminal or a future
// screen, and those are exactly the writers an append-only financial
// explanation has to survive.
//
// The shape of every attack is the same: build a DRAFT sale by hand (the
// window migration 012's guards deliberately leave open, because every posting
// command needs it), attach a recipe-costed line and some set of evidence
// rows, then either try the illegal write or try to PROMOTE the draft. The
// assertions are on the error and on the rows afterwards.
// ============================================================================

const STORE_B: &str = "00000000-0000-0000-0000-0000000000b0";
const PB_ITEM: &str = "00000000-0000-0000-0000-0000000000b1";
const PB_INGREDIENT: &str = "00000000-0000-0000-0000-0000000000b2";
const RB_RECIPE: &str = "00000000-0000-0000-0000-0000000000b3";

/// One evidence row with every column settable, so an attack can alter exactly
/// one figure and leave the rest honest. A test that has to restate eighteen
/// columns to change one of them is a test nobody can read.
#[derive(Clone)]
struct Ev {
    id: String,
    sale_id: String,
    sale_item_id: String,
    store_id: String,
    recipe_id: String,
    version: i64,
    component: String,
    name: String,
    uom: String,
    qn: i64,
    qd: i64,
    fnum: i64,
    fden: i64,
    waste: i64,
    rate: i64,
    source: String,
    contrib: i64,
    sort: i64,
}

impl Ev {
    fn sql(&self) -> String {
        format!(
            "INSERT INTO sale_item_recipe_costs (
               id, sale_id, sale_item_id, store_id, recipe_id, recipe_version,
               component_product_id, component_name_snapshot, uom_code,
               quantity_num, quantity_den, factor_num_snapshot, factor_den_snapshot,
               waste_bps, unit_cost_excl_vat_microcents, cost_source,
               contribution_microcents, sort_order)
             VALUES ('{}', '{}', '{}', '{}', '{}', {}, '{}', '{}', '{}',
                     {}, {}, {}, {}, {}, {}, '{}', {}, {})",
            self.id,
            self.sale_id,
            self.sale_item_id,
            self.store_id,
            self.recipe_id,
            self.version,
            self.component,
            self.name,
            self.uom,
            self.qn,
            self.qd,
            self.fnum,
            self.fden,
            self.waste,
            self.rate,
            self.source,
            self.contrib,
            self.sort,
        )
    }
}

/// The FOUR evidence rows a faithful `post_sale` would write for
/// `four_ingredient_burger()`, with the figures `recipe_cost.rs` produces.
/// Every attack below starts from this set and corrupts one thing.
fn burger_evidence(sale_id: &str, line_id: &str, recipe_id: &str, version: i64) -> Vec<Ev> {
    [
        ("e1", P_BUN, "Burger bun", "each", 1_i64, 1_i64, 0_i64, 22_000_000_i64, 22_000_000_i64),
        ("e2", P_PATTY, "Beef patty mince", "g", 150, 1, 500, 850_000, 133_875_000),
        ("e3", P_SAUCE, "Greaz sauce", "ml", 25, 1, 0, 120_000, 3_000_000),
        ("e4", P_CHEESE, "Cheddar slice", "each", 1, 2, 0, 30_000_000, 15_000_000),
    ]
    .iter()
    .enumerate()
    .map(|(i, (id, component, name, uom, qn, qd, waste, rate, contrib))| Ev {
        id: format!("{line_id}-{id}"),
        sale_id: sale_id.to_string(),
        sale_item_id: line_id.to_string(),
        store_id: STORE_ID.to_string(),
        recipe_id: recipe_id.to_string(),
        version,
        component: (*component).to_string(),
        name: (*name).to_string(),
        uom: (*uom).to_string(),
        qn: *qn,
        qd: *qd,
        fnum: 1,
        fden: 1,
        waste: *waste,
        rate: *rate,
        source: "purchase_average".to_string(),
        contrib: *contrib,
        sort: i as i64,
    })
    .collect()
}

/// `cost::microcents_to_cents` — half away from zero, for a non-negative rate.
/// Written out here rather than imported so the TEST states the rule it is
/// asserting independently of the code under test.
fn unit_cents(rate_mc: i64) -> i64 {
    (rate_mc + 500_000) / 1_000_000
}

/// `cost::extended_cost_cents` — the PRECISE rate times the quantity, rounded
/// ONCE. Deliberately not `unit_cents(rate) * qty`: three units at 14,756,250
/// microcents are 44 cents, where 15 x 3 would be 45.
fn line_cents(rate_mc: i64, qty: i64) -> i64 {
    (rate_mc * qty + 500_000) / 1_000_000
}

/// A DRAFT `sales` row of the fixture store. `posted_at` NULL is the whole
/// point: it is the state every posting command passes through.
///
/// `cogs_total` is a parameter because migration 022 now reconciles the header
/// against the sum of its lines' extended costs, so a fixture has to state a
/// total its own lines support — and an attack has to fabricate it explicitly
/// rather than inherit a wrong one.
fn draft_sale_sql(sale_id: &str, receipt: i64, cogs_total: i64) -> String {
    draft_sale_sql_in(sale_id, receipt, STORE_ID, SHIFT_ID, cogs_total)
}

fn draft_sale_sql_in(
    sale_id: &str,
    receipt: i64,
    store: &str,
    shift: &str,
    cogs_total: i64,
) -> String {
    format!(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
            exchange_rate_lbp_per_usd, exchange_rate_id,
            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
            discount_cents, cogs_total_cents, cogs_method, sale_type, status, posted_at)
         VALUES ('{sale_id}', '{store}', '{shift}', '{USER_ID}', {receipt},
            {RATE_LBP_PER_USD}, '{RATE_ID}', 1000, 110, 1110, 0, {cogs_total},
            'weighted_average', 'normal', 'draft', NULL)"
    )
}

/// A recipe-costed `sale_items` row, every column an attack might want to move
/// taken as an argument.
///
/// The two CENT columns are DERIVED from `unit_mc` and the quantity by the
/// rules above, so a test that moves the microcent rate moves them with it and
/// each attack falsifies exactly one thing. `recipe_line_cents_sql` is the
/// variant an attack on the cents themselves uses.
#[allow(clippy::too_many_arguments)]
fn recipe_line_sql(
    line_id: &str,
    sale_id: &str,
    store: &str,
    product: &str,
    recipe_id: &str,
    version: &str,
    source: &str,
    unit_mc: i64,
) -> String {
    recipe_line_cents_sql(
        line_id,
        sale_id,
        store,
        product,
        recipe_id,
        version,
        source,
        unit_mc,
        1,
        unit_cents(unit_mc),
        line_cents(unit_mc, 1),
    )
}

#[allow(clippy::too_many_arguments)]
fn recipe_line_cents_sql(
    line_id: &str,
    sale_id: &str,
    store: &str,
    product: &str,
    recipe_id: &str,
    version: &str,
    source: &str,
    unit_mc: i64,
    qty: i64,
    unit_c: i64,
    line_c: i64,
) -> String {
    format!(
        "INSERT INTO sale_items (id, sale_id, store_id, product_id,
            product_name_snapshot, vat_rate_id_snapshot, vat_rate_bps_snapshot,
            quantity, unit_price_excl_vat_cents, unit_price_incl_vat_cents,
            line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
            unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
            unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
            factor_num_snapshot, factor_den_snapshot, cogs_source,
            recipe_id, recipe_version)
         VALUES ('{line_id}', '{sale_id}', '{store}', '{product}', 'Greaz Burger',
            '{VAT_STD_ID}', 1100, {qty}, 1000, 1110, 1000, 110, 1110,
            {unit_c}, {line_c}, {unit_mc}, {qty}, 'each', 1, 1, {source},
            {recipe_id}, {version})"
    )
}

/// A draft sale carrying one recipe-costed burger line and the COMPLETE,
/// faithful four-row explanation. This state is legal and promotable — which
/// is what makes it the right baseline: every attack below starts from a
/// database that would otherwise post.
async fn complete_draft(db: &TempDb, recipe_id: &str, tag: &str, receipt: i64) -> (String, String) {
    let sale_id = format!("ds-{tag}");
    let line_id = format!("dl-{tag}");
    db.exec(&draft_sale_sql(&sale_id, receipt, line_cents(BURGER_RATE_MC, 1)))
        .await;
    db.exec(&recipe_line_sql(
        &line_id,
        &sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{recipe_id}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;
    for e in burger_evidence(&sale_id, &line_id, recipe_id, 1) {
        db.exec(&e.sql()).await;
    }
    (sale_id, line_id)
}

fn promote(sale_id: &str) -> String {
    format!(
        "UPDATE sales SET status='posted', posted_at='2026-01-01T00:00:00.000Z'
          WHERE id='{sale_id}'"
    )
}

async fn is_draft(db: &TempDb, sale_id: &str) -> bool {
    db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'"))
        .await
        == "draft"
}

// ---------------------------------------------------------------------------
// 9.0 The baseline: a complete, faithful explanation PROMOTES.
//
// Asserted first and deliberately. Eleven refusals are only worth having if
// the honest case still goes through, and a guard suite that never
// demonstrates the permitted path is how a correction ships a till that
// refuses every sale.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_complete_and_faithful_evidence_set_still_promotes() {
    let db = kitchen().await;
    let r = publish(&db, "r080", four_ingredient_burger()).await;
    let (sale_id, _) = complete_draft(&db, &r, "ok", 9100).await;

    db.exec(&promote(&sale_id)).await;
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'")).await,
        "posted"
    );
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
}

// ---------------------------------------------------------------------------
// 9.1 THE P1-A DEFECT ITSELF: a four-ingredient recipe, one evidence row.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_four_ingredient_recipe_cannot_post_with_one_evidence_row() {
    // The defect Codex found, stated as the test that failed to exist: the
    // old guard asked "is there AT LEAST ONE row?", so a receipt could carry
    // an explanation of a quarter of its own cost, sealed for ever.
    let db = kitchen().await;
    let r = publish(&db, "r081", four_ingredient_burger()).await;
    let sale_id = "ds-one";
    let line_id = "dl-one";
    db.exec(&draft_sale_sql(sale_id, 9101, line_cents(BURGER_RATE_MC, 1))).await;
    db.exec(&recipe_line_sql(
        line_id,
        sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    // ONE row, and a perfectly honest one — the bun, with its real quantity,
    // conversion, rate and contribution. Nothing about this row is wrong; the
    // SET is.
    db.exec(&burger_evidence(sale_id, line_id, &r, 1)[0].sql()).await;

    let e = db.exec_err(&promote(sale_id)).await;
    assert!(e.contains("incomplete recipe-cost explanation"), "{e}");
    assert!(is_draft(&db, sale_id).await, "and it stays a draft");

    // Two more rows: still short, still refused. The guard is the SET, not a
    // threshold.
    for ev in burger_evidence(sale_id, line_id, &r, 1).iter().skip(1).take(2) {
        db.exec(&ev.sql()).await;
    }
    let e = db.exec_err(&promote(sale_id)).await;
    assert!(e.contains("incomplete recipe-cost explanation"), "{e}");

    // The fourth completes it, and only then does it post.
    db.exec(&burger_evidence(sale_id, line_id, &r, 1)[3].sql()).await;
    db.exec(&promote(sale_id)).await;
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'")).await,
        "posted"
    );
}

// ---------------------------------------------------------------------------
// 9.2 An evidence row naming an ingredient the recipe does not contain.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evidence_for_an_unrelated_ingredient_is_refused() {
    let db = kitchen().await;
    let r = publish(&db, "r082", four_ingredient_burger()).await;
    let sale_id = "ds-alien";
    let line_id = "dl-alien";
    db.exec(&draft_sale_sql(sale_id, 9102, line_cents(BURGER_RATE_MC, 1))).await;
    db.exec(&recipe_line_sql(
        line_id,
        sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    // Coffee is a real product of the right store, correctly costed, and is
    // not in the burger. Every foreign key is satisfied.
    let mut alien = burger_evidence(sale_id, line_id, &r, 1)[0].clone();
    alien.id = "alien".to_string();
    alien.component = P_COFFEE.to_string();
    alien.name = "Coffee 250g".to_string();

    let e = db.exec_err(&alien.sql()).await;
    assert!(e.contains("not in the recipe version it cites"), "{e}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 0);
}

// ---------------------------------------------------------------------------
// 9.3 Altered frozen quantity, unit, conversion or waste.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evidence_whose_frozen_physics_disagree_with_the_recipe_is_refused() {
    let db = kitchen().await;
    let r = publish(&db, "r083", four_ingredient_burger()).await;
    let sale_id = "ds-phys";
    let line_id = "dl-phys";
    db.exec(&draft_sale_sql(sale_id, 9103, line_cents(BURGER_RATE_MC, 1))).await;
    db.exec(&recipe_line_sql(
        line_id,
        sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    // The patty line, published as 150 g at 5% waste with a 1/1 conversion.
    // Each variant below moves ONE physical figure and keeps the contribution
    // arithmetically consistent with the figure it moved, so the only thing
    // wrong is that the recipe does not say it.
    let base = burger_evidence(sale_id, line_id, &r, 1)[1].clone();

    let doubled_quantity = Ev { qn: 300, contrib: 267_750_000, ..base.clone() };
    let doubled_factor = Ev { fnum: 2, contrib: 267_750_000, ..base.clone() };
    let halved_denominator = Ev { qd: 2, contrib: 66_937_500, ..base.clone() };
    let extra_waste = Ev { waste: 1000, contrib: 140_250_000, ..base.clone() };
    let other_unit = Ev { uom: "kg".to_string(), ..base.clone() };

    for (what, ev) in [
        ("quantity", doubled_quantity),
        ("conversion numerator", doubled_factor),
        ("quantity denominator", halved_denominator),
        ("waste", extra_waste),
        ("unit", other_unit),
    ] {
        let e = db.exec_err(&ev.sql()).await;
        assert!(
            e.contains("disagrees with the published recipe"),
            "an altered {what} must be refused, got: {e}"
        );
    }
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 0);
}

// ---------------------------------------------------------------------------
// 9.4 A fabricated contribution, and a fabricated line rate.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fabricated_contribution_is_refused_at_the_row() {
    let db = kitchen().await;
    let r = publish(&db, "r084", four_ingredient_burger()).await;
    let sale_id = "ds-fab";
    let line_id = "dl-fab";
    db.exec(&draft_sale_sql(sale_id, 9104, line_cents(BURGER_RATE_MC, 1))).await;
    db.exec(&recipe_line_sql(
        line_id,
        sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    let bun = burger_evidence(sale_id, line_id, &r, 1)[0].clone();

    // The physics and the rate are the recipe's own; only the contribution is
    // invented. This is the row a fraud would write: it reconciles against
    // nothing and reads as an ordinary explanation.
    for bogus in [0_i64, 1, 21_999_998, 22_000_002, 999_000_000] {
        let e = db.exec_err(&Ev { contrib: bogus, ..bun.clone() }.sql()).await;
        assert!(
            e.contains("does not follow from its own rate"),
            "a contribution of {bogus} against 22,000,000 must be refused, got: {e}"
        );
    }

    // ONE MICROCENT of slack is admitted, and that is deliberate: it is what
    // `recipe_cost.rs`'s two rounding points can introduce, and the migration
    // states it as a tolerance rather than claiming an identity. A microcent
    // is a MILLIONTH of a cent on a column nothing derives a total from.
    db.exec(&Ev { contrib: 21_999_999, ..bun.clone() }.sql()).await;
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_rate_that_does_not_follow_from_its_evidence_cannot_post() {
    // The complement of the row-level check: every evidence row is faithful
    // and the LINE's own rate is invented. Without this the explanation and
    // the figure it explains could describe different costs, permanently.
    let db = kitchen().await;
    let r = publish(&db, "r085", four_ingredient_burger()).await;

    for (tag, receipt, rate) in [
        ("lo", 9105_i64, BURGER_RATE_MC / 2),
        ("hi", 9106, BURGER_RATE_MC * 3),
        ("zero", 9107, 0),
    ] {
        let sale_id = format!("ds-rate-{tag}");
        let line_id = format!("dl-rate-{tag}");
        db.exec(&draft_sale_sql(&sale_id, receipt, line_cents(rate, 1))).await;
        db.exec(&recipe_line_sql(
            &line_id,
            &sale_id,
            STORE_ID,
            P_BURGER,
            &format!("'{r}'"),
            "1",
            "'recipe'",
            rate,
        ))
        .await;
        for e in burger_evidence(&sale_id, &line_id, &r, 1) {
            db.exec(&e.sql()).await;
        }

        let e = db.exec_err(&promote(&sale_id)).await;
        assert!(
            e.contains("does not follow from the evidence beneath it"),
            "a line rate of {rate} must be refused, got: {e}"
        );
        assert!(is_draft(&db, &sale_id).await);
    }
}

// ---------------------------------------------------------------------------
// 9.5 Evidence citing another recipe, or another version of the same one.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evidence_for_a_different_recipe_version_is_refused() {
    let db = kitchen().await;
    let v1 = publish(&db, "r086", four_ingredient_burger()).await;
    // Version 2 drops the cheese. Both versions exist; v1 is retired.
    let v2 = publish(
        &db,
        "r087",
        vec![
            component(P_BUN, 1, 1, "each"),
            wasteful(P_PATTY, 150, 1, "g", 500),
            component(P_SAUCE, 25, 1, "ml"),
        ],
    )
    .await;

    let sale_id = "ds-ver";
    let line_id = "dl-ver";
    db.exec(&draft_sale_sql(sale_id, 9108, line_cents(BURGER_RATE_MC - 15_000_000, 1))).await;
    // The LINE says it was costed from version 2.
    db.exec(&recipe_line_sql(
        line_id,
        sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{v2}'"),
        "2",
        "'recipe'",
        BURGER_RATE_MC - 15_000_000,
    ))
    .await;

    // Evidence citing version 1 — a real published version of the same product
    // in the same store, with the same ingredient in it.
    let mut stale = burger_evidence(sale_id, line_id, &v1, 1)[0].clone();
    stale.id = "stale".to_string();
    let e = db.exec_err(&stale.sql()).await;
    assert!(e.contains("must name the recipe its line was costed from"), "{e}");

    // And a row citing v2's id under v1's version number: the recipe exists,
    // the version does not describe it.
    let mut wrong_number = burger_evidence(sale_id, line_id, &v2, 1)[0].clone();
    wrong_number.id = "wrongnum".to_string();
    let e = db.exec_err(&wrong_number.sql()).await;
    assert!(e.contains("must name the recipe its line was costed from"), "{e}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_version_cannot_be_smuggled_under_a_line_that_cites_the_current_one() {
    // The set-completeness rule read against the CITED version, not against
    // whatever is active today. v1 had four ingredients and v2 has three, so a
    // v2 line explained by four rows is one row too many — and the extra one
    // names an ingredient v2 does not contain.
    let db = kitchen().await;
    publish(&db, "r088", four_ingredient_burger()).await;
    let v2 = publish(
        &db,
        "r089",
        vec![
            component(P_BUN, 1, 1, "each"),
            wasteful(P_PATTY, 150, 1, "g", 500),
            component(P_SAUCE, 25, 1, "ml"),
        ],
    )
    .await;

    let sale_id = "ds-extra";
    let line_id = "dl-extra";
    db.exec(&draft_sale_sql(sale_id, 9109, line_cents(BURGER_RATE_MC - 15_000_000, 1))).await;
    db.exec(&recipe_line_sql(
        line_id,
        sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{v2}'"),
        "2",
        "'recipe'",
        BURGER_RATE_MC - 15_000_000,
    ))
    .await;
    for e in burger_evidence(sale_id, line_id, &v2, 2).iter().take(3) {
        db.exec(&e.sql()).await;
    }
    // Three faithful rows: v2 is complete and would post.
    let cheese = Ev {
        id: "cheese-extra".to_string(),
        ..burger_evidence(sale_id, line_id, &v2, 2)[3].clone()
    };
    let e = db.exec_err(&cheese.sql()).await;
    assert!(e.contains("not in the recipe version it cites"), "{e}");

    db.exec(&promote(sale_id)).await;
    assert_eq!(evidence(&db, sale_id).await.len(), 3);
}

// ---------------------------------------------------------------------------
// 9.6 Reparenting a line with evidence from one draft sale to another.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recipe_costed_line_cannot_be_moved_between_draft_sales() {
    // THE P1-B DEFECT. Migration 012's reparenting guard fires only when the
    // OLD or NEW parent is POSTED, and every posting command builds a draft
    // first — so between two drafts a line was an ordinary updatable row. The
    // explanation would have stayed filed against sale A while the charge
    // moved to sale B, with every foreign key still satisfied.
    let db = kitchen().await;
    let r = publish(&db, "r090", four_ingredient_burger()).await;
    let (sale_a, line_a) = complete_draft(&db, &r, "a", 9110).await;
    db.exec(&draft_sale_sql("ds-b", 9111, 0)).await;

    let e = db
        .exec_err(&format!(
            "UPDATE sale_items SET sale_id='ds-b' WHERE id='{line_a}'"
        ))
        .await;
    assert!(e.contains("frozen") || e.contains("cannot be moved"), "{e}");
    assert_eq!(
        db.scalar_string(&format!("SELECT sale_id FROM sale_items WHERE id='{line_a}'")).await,
        sale_a,
        "the line stays where its explanation is"
    );

    // And with the evidence out of the way the rule still holds, because a
    // recipe-costed line is never reparented at all.
    db.exec(&draft_sale_sql("ds-c", 9112, line_cents(BURGER_RATE_MC, 1))).await;
    db.exec(&recipe_line_sql(
        "dl-bare",
        "ds-c",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;
    let e = db
        .exec_err("UPDATE sale_items SET sale_id='ds-b' WHERE id='dl-bare'")
        .await;
    assert!(e.contains("cannot be moved to another sale"), "{e}");
}

// ---------------------------------------------------------------------------
// 9.7 Editing a line's product, store, recipe, provenance or cost after the
//     evidence has been attached.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_with_evidence_is_frozen_in_identity_and_in_cost() {
    let db = kitchen().await;
    let r = publish(&db, "r091", four_ingredient_burger()).await;
    // The draft is built while v1 is the PUBLISHED version, because since the
    // P1-A correction a new line may only cite an active one. v2 is published
    // afterwards so the "re-point it at another version" attack has a real
    // target; publishing it retires v1, which is exactly the state a posted v1
    // sale legitimately lives in for ever.
    let (_, line) = complete_draft(&db, &r, "frozen", 9113).await;
    let v2 = publish(
        &db,
        "r092",
        vec![component(P_BUN, 1, 1, "each"), wasteful(P_PATTY, 150, 1, "g", 500)],
    )
    .await;

    for (what, set) in [
        ("its identity", "id='other'".to_string()),
        ("its store", format!("store_id='{STORE_B}'")),
        ("its product", format!("product_id='{P_COFFEE}'")),
        ("its recipe", format!("recipe_id='{v2}', recipe_version=2")),
        ("its recipe version", "recipe_version=2".to_string()),
        ("its provenance", "cogs_source='standard'".to_string()),
        ("its quantity", "quantity=5".to_string()),
        ("its cost rate", "unit_cogs_excl_vat_microcents=1".to_string()),
        ("its cost in cents", "unit_cogs_excl_vat_cents=1".to_string()),
        ("its extended cost", "line_cogs_excl_vat_cents=1".to_string()),
    ] {
        let e = db
            .exec_err(&format!("UPDATE sale_items SET {set} WHERE id='{line}'"))
            .await;
        assert!(
            e.contains("frozen") || e.contains("may only name a recipe"),
            "changing {what} must be refused, got: {e}"
        );
    }

    // The row is exactly as it was.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE id='{line}'"
        ))
        .await,
        BURGER_RATE_MC
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT recipe_id FROM sale_items WHERE id='{line}'")).await,
        r
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_line_cannot_be_updated_onto_another_stores_recipe() {
    // No evidence attached at all, so rule 5a does not apply — this is the
    // UPDATE path that had NO guard: the INSERT trigger would have refused the
    // same row outright.
    let db = kitchen().await;
    let r = publish(&db, "r093", four_ingredient_burger()).await;
    seed_store_b(&db).await;

    db.exec(&draft_sale_sql("ds-xstore", 9114, line_cents(BURGER_RATE_MC, 1))).await;
    db.exec(&recipe_line_sql(
        "dl-xstore",
        "ds-xstore",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    let e = db
        .exec_err(&format!(
            "UPDATE sale_items SET recipe_id='{RB_RECIPE}', recipe_version=1
              WHERE id='dl-xstore'"
        ))
        .await;
    assert!(e.contains("own store, and of its own product"), "{e}");

    // Dropping the provenance while keeping the identity is the other half.
    let e = db
        .exec_err("UPDATE sale_items SET cogs_source='purchase_average' WHERE id='dl-xstore'")
        .await;
    assert!(e.contains("may only name a recipe when it was costed"), "{e}");

    // And claiming `recipe` with the identity removed.
    let e = db
        .exec_err("UPDATE sale_items SET recipe_id=NULL, recipe_version=NULL WHERE id='dl-xstore'")
        .await;
    assert!(e.contains("must record which recipe version"), "{e}");
}

// ---------------------------------------------------------------------------
// 9.8 Cross-store: a store-A header, a store-B line, store-B evidence.
// ---------------------------------------------------------------------------

/// A second branch with its own menu item, its own ingredient and its own
/// published recipe, written by direct SQL because `seed_product` is bound to
/// the fixture store. This is the shape every cross-store attack needs: not a
/// broken row, but a perfectly coherent row of the WRONG BRANCH.
async fn seed_store_b(db: &TempDb) {
    db.exec(&format!(
        "INSERT INTO stores (id, name, default_currency) VALUES ('{STORE_B}', 'Branch B', 'USD')"
    ))
    .await;
    for (id, sku, name, service, method, std) in [
        (PB_INGREDIENT, "SKU-B-ING", "B ingredient", 1, "standard", "2000000"),
        (PB_ITEM, "SKU-B-ITEM", "B menu item", 1, "purchase_average", "NULL"),
    ] {
        db.exec(&format!(
            "INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
               price_excl_vat_cents, price_incl_vat_cents,
               avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
               avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
               quantity_on_hand, is_active, is_service,
               costing_method, standard_cost_excl_vat_microcents)
             VALUES ('{id}', '{STORE_B}', '{sku}', '{name}', '{VAT_STD_ID}', 'inclusive',
               1000, 1110, 0, 0, 0, 0, 0, 1, {service}, '{method}', {std})"
        ))
        .await;
        db.exec(&format!(
            "INSERT INTO product_uoms (id, store_id, product_id, uom_code,
               factor_num, factor_den, is_base, is_default_sale_uom,
               is_default_purchase_uom, is_active)
             VALUES ('uom-{id}', '{STORE_B}', '{id}', 'each', 1, 1, 1, 1, 1, 1)"
        ))
        .await;
    }
    // As a DRAFT first: migration 021 refuses a new ingredient on a published
    // version, which is the rule this fixture has to respect like any writer.
    db.exec(&format!(
        "INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
         VALUES ('{RB_RECIPE}', '{STORE_B}', '{PB_ITEM}', 1, 1, 'draft')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO recipe_components (id, recipe_id, store_id, component_product_id,
           quantity_num, quantity_den, uom_code, product_uom_id_snapshot,
           factor_num_snapshot, factor_den_snapshot, waste_bps, sort_order)
         VALUES ('rcb', '{RB_RECIPE}', '{STORE_B}', '{PB_INGREDIENT}',
           1, 1, 'each', 'uom-{PB_INGREDIENT}', 1, 1, 0, 0)"
    ))
    .await;
    db.exec(&format!(
        "UPDATE recipes SET status='active', activated_at='2026-01-01T00:00:00.000Z'
          WHERE id='{RB_RECIPE}'"
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_a_sale_cannot_hold_a_store_b_line_or_store_b_evidence() {
    let db = kitchen().await;
    let r = publish(&db, "r094", four_ingredient_burger()).await;
    seed_store_b(&db).await;
    db.exec(&draft_sale_sql("ds-mix", 9115, line_cents(BURGER_RATE_MC, 1))).await;

    // (a) A store-B LINE under a store-A header. Every recipe relationship on
    //     this row is coherent — B's recipe, B's product, B's store — and only
    //     the header it hangs under is wrong. Nothing in the schema said so
    //     before migration 022's correction.
    let e = db
        .exec_err(&recipe_line_sql(
            "dl-mix-b",
            "ds-mix",
            STORE_B,
            PB_ITEM,
            &format!("'{RB_RECIPE}'"),
            "1",
            "'recipe'",
            2_000_000,
        ))
        .await;
    assert!(e.contains("same store as its own sale"), "{e}");

    // (b) A store-A line with store-B EVIDENCE.
    db.exec(&recipe_line_sql(
        "dl-mix-a",
        "ds-mix",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;
    let mut foreign = burger_evidence("ds-mix", "dl-mix-a", &r, 1)[0].clone();
    foreign.store_id = STORE_B.to_string();
    let e = db.exec_err(&foreign.sql()).await;
    assert!(e.contains("must name its own sale line"), "{e}");

    // (c) Store-A evidence naming a store-B INGREDIENT.
    let mut foreign_ingredient = burger_evidence("ds-mix", "dl-mix-a", &r, 1)[0].clone();
    foreign_ingredient.component = PB_INGREDIENT.to_string();
    let e = db.exec_err(&foreign_ingredient.sql()).await;
    assert!(
        e.contains("ingredient of its own store") || e.contains("not in the recipe version"),
        "{e}"
    );

    // (d) Evidence naming a store-B RECIPE on a store-A line.
    let mut foreign_recipe = burger_evidence("ds-mix", "dl-mix-a", &r, 1)[0].clone();
    foreign_recipe.recipe_id = RB_RECIPE.to_string();
    let e = db.exec_err(&foreign_recipe.sql()).await;
    assert!(e.contains("must name the recipe its line was costed from"), "{e}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cross_store_line_cannot_be_promoted_even_if_it_was_written_first() {
    // Defence in depth: rule 5 refuses the WRITE and rule 6 refuses the
    // PROMOTION, so a row that exists by any route cannot become a receipt.
    // The line is written while its sale still names store B, and the header
    // is then switched to store A — which the `sales` table permits.
    let db = kitchen().await;
    seed_store_b(&db).await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
           opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('shift-b', '{STORE_B}', '{USER_ID}', '2026-01-01T00:00:00.000Z', 'open', 0, 0)"
    ))
    .await;
    db.exec(&draft_sale_sql_in("ds-switch", 9116, STORE_B, "shift-b", 2)).await;
    db.exec(&recipe_line_sql(
        "dl-switch",
        "ds-switch",
        STORE_B,
        PB_ITEM,
        &format!("'{RB_RECIPE}'"),
        "1",
        "'recipe'",
        2_000_000,
    ))
    .await;
    db.exec(
        &Ev {
            id: "evb".to_string(),
            sale_id: "ds-switch".to_string(),
            sale_item_id: "dl-switch".to_string(),
            store_id: STORE_B.to_string(),
            recipe_id: RB_RECIPE.to_string(),
            version: 1,
            component: PB_INGREDIENT.to_string(),
            name: "B ingredient".to_string(),
            uom: "each".to_string(),
            qn: 1,
            qd: 1,
            fnum: 1,
            fden: 1,
            waste: 0,
            rate: 2_000_000,
            source: "standard".to_string(),
            contrib: 2_000_000,
            sort: 0,
        }
        .sql(),
    )
    .await;

    // Coherent in store B, and promotable there.
    db.exec(&format!(
        "UPDATE sales SET store_id='{STORE_ID}', shift_id='{SHIFT_ID}' WHERE id='ds-switch'"
    ))
    .await;
    let e = db.exec_err(&promote("ds-switch")).await;
    assert!(e.contains("belongs to another store than the sale"), "{e}");
    assert!(is_draft(&db, "ds-switch").await);
}

// ---------------------------------------------------------------------------
// 9.9 Evidence attached to a line that was not recipe-costed.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evidence_cannot_be_attached_to_a_line_that_was_not_recipe_costed() {
    let db = kitchen().await;
    let r = publish(&db, "r095", four_ingredient_burger()).await;
    db.exec(&draft_sale_sql("ds-nosrc", 9117, 200)).await;
    // A perfectly ordinary purchase-valued line, no recipe columns at all.
    db.exec(&recipe_line_sql(
        "dl-nosrc",
        "ds-nosrc",
        STORE_ID,
        P_COFFEE,
        "NULL",
        "NULL",
        "'purchase_average'",
        200_000_000,
    ))
    .await;

    let mut ev = burger_evidence("ds-nosrc", "dl-nosrc", &r, 1)[0].clone();
    ev.id = "nosrc".to_string();
    let e = db.exec_err(&ev.sql()).await;
    assert!(e.contains("only explain a line that was costed from a recipe"), "{e}");
}

// ---------------------------------------------------------------------------
// 9.10 Posted evidence takes no UPDATE and no DELETE — including the columns a
//      reconciliation reads.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posted_evidence_resists_every_edit_and_every_deletion() {
    let db = kitchen().await;
    let r = publish(&db, "r096", four_ingredient_burger()).await;
    let (sale_id, line_id) = complete_draft(&db, &r, "sealed", 9118).await;
    db.exec(&promote(&sale_id)).await;

    for set in [
        "contribution_microcents = 1",
        "unit_cost_excl_vat_microcents = 1",
        "quantity_num = 9",
        "factor_num_snapshot = 9",
        "waste_bps = 9",
        "cost_source = 'standard'",
        &format!("sale_item_id = '{line_id}'"),
    ] {
        let e = db
            .exec_err(&format!(
                "UPDATE sale_item_recipe_costs SET {set} WHERE sale_id='{sale_id}'"
            ))
            .await;
        assert!(e.contains("immutable"), "setting {set} must be refused: {e}");
    }

    let e = db
        .exec_err(&format!(
            "DELETE FROM sale_item_recipe_costs WHERE sale_id='{sale_id}'"
        ))
        .await;
    assert!(e.contains("append-only"), "{e}");

    // And the posted sale takes no further evidence, whichever guard sees it
    // first — the coherence trigger now states that rule as its own first
    // statement so the message is deterministic.
    let mut extra = burger_evidence(&sale_id, &line_id, &r, 1)[0].clone();
    extra.id = "late".to_string();
    extra.component = P_SAMPLE.to_string();
    let e = db.exec_err(&extra.sql()).await;
    assert!(e.contains("posted sale"), "{e}");

    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT SUM(contribution_microcents) FROM sale_item_recipe_costs
              WHERE sale_id='{sale_id}'"
        ))
        .await,
        BURGER_RATE_MC
    );
}

// ---------------------------------------------------------------------------
// 9.11 A batch yield above one, with fractional quantities and waste, posts
//      through `post_sale` and reconciles.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_yield_recipe_with_fractions_and_waste_posts_and_reconciles() {
    // The batch costs $1.73875 and fills twenty portions, so one portion is
    // 8,693,750 microcents. The evidence rows describe the BATCH — which is
    // why the breakdown screen now says so — and rule 6m is what proves the
    // line's rate is that batch divided by the published yield.
    let db = kitchen().await;
    let r = rid("r097");
    save_recipe_draft_with_pool(
        db.pool(),
        SaveRecipeDraftPayload {
            yield_quantity_base: 20,
            ..draft(&r, four_ingredient_burger())
        },
    )
    .await
    .expect("draft saves");
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect("publishes");
    use_recipe_costing(&db).await;

    let payload = burger_sale(3);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("posts");

    let (rate_mc, unit_cents, line_cents, source) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, BURGER_RATE_MC / 20, "the batch, divided by its yield");
    assert_eq!(rate_mc, 8_693_750);
    assert_eq!(unit_cents, 9, "round(8,693,750 microcents) = 9 cents");
    assert_eq!(line_cents, 26, "round(3 x 8.69375 cents) = 26, rounded ONCE");
    assert_eq!(source, "recipe");

    // The evidence is the BATCH's, unchanged by the yield: four rows summing
    // to the batch cost, not to the portion cost.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT SUM(contribution_microcents) FROM sale_item_recipe_costs
              WHERE sale_id='{sale_id}'"
        ))
        .await,
        BURGER_RATE_MC
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT yield_quantity_base FROM recipes WHERE id='{r}'"
        ))
        .await,
        20
    );

    // No ingredient moved. B2-B is an estimated food cost, not a consumption
    // document, and a yield above one changes nothing about that.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements
              WHERE product_id IN ('{P_BUN}','{P_PATTY}','{P_SAUCE}','{P_CHEESE}')
                AND movement_type <> 'purchase'"
        ))
        .await,
        0
    );
}

// ---------------------------------------------------------------------------
// 9.12 P2 — direct-SQL retirement of a recipe the product depends on.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_sql_cannot_retire_the_recipe_a_product_is_costed_from() {
    // `retire_recipe` has refused this since B2-A; the ENGINE had no opinion,
    // so one UPDATE left a product configured for a cost it could no longer
    // obtain — and the refusal then arrived at the till, in front of a
    // customer, for a mistake made days earlier on another screen.
    let db = kitchen().await;
    let r = publish(&db, "r098", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let e = db
        .exec_err(&format!(
            "UPDATE recipes SET status='retired', retired_at='2027-02-01T00:00:00.000Z'
              WHERE id='{r}'"
        ))
        .await;
    assert!(e.contains("cannot be retired"), "{e}");
    assert_eq!(recipe_status(&db, &r).await, "active");

    // The documented way out: switch the item off recipe costing first.
    db.exec(&format!(
        "UPDATE products SET costing_method='purchase_average' WHERE id='{P_BURGER}'"
    ))
    .await;
    db.exec(&format!(
        "UPDATE recipes SET status='retired', retired_at='2027-02-01T00:00:00.000Z'
          WHERE id='{r}'"
    ))
    .await;
    assert_eq!(recipe_status(&db, &r).await, "retired");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_retirement_guard_does_not_deadlock_a_version_two_publication() {
    // The guard's whole difficulty: `activate_recipe` retires the incumbent
    // FIRST, inside one transaction, so `ux_recipes_one_active` is never
    // momentarily violated. A flat refusal would have made a recipe-costed
    // item's recipe uneditable for ever. A draft of the same product is the
    // exemption, because it is the only shape an atomic replacement takes.
    let db = kitchen().await;
    let v1 = publish(&db, "r099", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let v2 = publish(
        &db,
        "r09a",
        vec![component(P_BUN, 1, 1, "each"), wasteful(P_PATTY, 150, 1, "g", 500)],
    )
    .await;

    assert_eq!(recipe_status(&db, &v1).await, "retired");
    assert_eq!(recipe_status(&db, &v2).await, "active");

    // And the item is still sellable, costed from the new version.
    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("posts from v2");
    assert_eq!(recipe_stamp(&db, &sale_id).await, (v2, 2));
    assert_eq!(evidence(&db, &sale_id).await.len(), 2);
}

// ============================================================================
// 10. P1-A — ONLY A PUBLISHED RECIPE MAY COST A NEW SALE
//
// Proving the product, the store and the version number establishes WHICH
// recipe is meant. It does not establish that the recipe is the authoritative
// one, and migration 022's first two cuts stopped there. A DRAFT is the
// dangerous case: migration 021 lets a draft's components be edited, so
// anything proven about evidence written against one can be falsified
// afterwards and the proof is worth nothing. A RETIRED version is the quieter
// case: it was superseded precisely because it no longer states what the
// kitchen makes.
//
// The rule is enforced at three points — the line INSERT, the line UPDATE and
// the PROMOTION — because a draft sale is a state that persists between
// statements and the state that matters is the one at FINALIZATION.
// ============================================================================

/// A draft recipe version for the burger, created the way `save_recipe_draft`
/// creates one but left unpublished.
async fn draft_version(db: &TempDb, tag: &str, components: Vec<RecipeComponentInput>) -> String {
    let r = rid(tag);
    save_recipe_draft_with_pool(db.pool(), draft(&r, components))
        .await
        .unwrap_or_else(|e| panic!("draft {tag} must save: {e}"));
    r
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_recipe_version_cannot_cost_a_new_sale() {
    // v1 is published and active; v2 exists only as a DRAFT. A direct-SQL
    // writer tries to cost a sale from the draft — whose ingredient lines it
    // could go on editing afterwards.
    let db = kitchen().await;
    publish(&db, "r100", four_ingredient_burger()).await;
    let v2 = draft_version(
        &db,
        "r101",
        vec![component(P_BUN, 1, 1, "each"), component(P_CHEESE, 1, 1, "each")],
    )
    .await;
    assert_eq!(recipe_status(&db, &v2).await, "draft");

    db.exec(&draft_sale_sql("ds-draftv", 9200, 52)).await;
    let e = db
        .exec_err(&recipe_line_sql(
            "dl-draftv",
            "ds-draftv",
            STORE_ID,
            P_BURGER,
            &format!("'{v2}'"),
            "2",
            "'recipe'",
            52_000_000,
        ))
        .await;
    assert!(e.contains("only be costed from a PUBLISHED recipe"), "{e}");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_items WHERE sale_id='ds-draftv'").await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_recipe_version_cannot_cost_a_new_sale() {
    // v1 posted sales for a week; v2 is then published, which retires v1. A new
    // sale may not reach back for v1's cheaper ingredients.
    let db = kitchen().await;
    let v1 = publish(&db, "r102", four_ingredient_burger()).await;
    publish(
        &db,
        "r103",
        vec![component(P_BUN, 1, 1, "each"), wasteful(P_PATTY, 150, 1, "g", 500)],
    )
    .await;
    assert_eq!(recipe_status(&db, &v1).await, "retired");

    db.exec(&draft_sale_sql(
        "ds-retv",
        9201,
        line_cents(BURGER_RATE_MC, 1),
    ))
    .await;
    let e = db
        .exec_err(&recipe_line_sql(
            "dl-retv",
            "ds-retv",
            STORE_ID,
            P_BURGER,
            &format!("'{v1}'"),
            "1",
            "'recipe'",
            BURGER_RATE_MC,
        ))
        .await;
    assert!(e.contains("only be costed from a PUBLISHED recipe"), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ACTIVE_version_costs_the_sale_and_version_replacement_still_works() {
    // The permitted path, and the one a flat refusal would have broken:
    // `activate_recipe` publishes v2 and retires v1 inside ONE transaction, and
    // `post_sale` then costs from whichever is active when it runs.
    let db = kitchen().await;
    publish(&db, "r104", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let first = burger_sale(1);
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.expect("v1 posts");

    let v2 = publish(
        &db,
        "r105",
        vec![
            component(P_BUN, 1, 1, "each"),
            wasteful(P_PATTY, 150, 1, "g", 500),
            component(P_SAUCE, 25, 1, "ml"),
        ],
    )
    .await;
    let second = burger_sale(1);
    let second_id = second.sale_id.clone();
    post_sale_with_pool(db.pool(), second).await.expect("v2 posts");

    assert_eq!(recipe_stamp(&db, &second_id).await, (v2, 2));
    assert_eq!(
        line_cogs(&db, &second_id).await.0,
        BURGER_RATE_MC - 15_000_000
    );

    // AND THE HISTORICAL v1 SALE IS STILL THERE, unchanged, readable, and
    // immutable — which is the half of P1-A that must NOT be enforced on a
    // read. A trigger does not fire on a SELECT.
    assert_eq!(line_cogs(&db, &first_id).await.0, BURGER_RATE_MC);
    assert_eq!(evidence(&db, &first_id).await.len(), 4);
    let e = db
        .exec_err(&format!(
            "UPDATE sale_items SET unit_cogs_excl_vat_microcents=1 WHERE sale_id='{first_id}'"
        ))
        .await;
    assert!(e.contains("frozen") || e.contains("immutable"), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_sale_cannot_be_promoted_after_its_recipe_stops_being_published() {
    // THE INTERLEAVING. The line is written while v1 is active, so every
    // INSERT-time rule passes. v2 is then published — retiring v1 — and only
    // then is the draft promoted. Finalization is where the state has to be
    // true, so this is refused.
    //
    // No honest sale is ever caught by it: `post_sale` writes the line, the
    // evidence and the promotion in ONE transaction and SQLite serialises
    // writers, so a recipe cannot change status in between.
    let db = kitchen().await;
    let v1 = publish(&db, "r106", four_ingredient_burger()).await;
    let (sale_id, _) = complete_draft(&db, &v1, "interleave", 9202).await;

    // It would post right now.
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'")).await,
        "draft"
    );

    publish(
        &db,
        "r107",
        vec![component(P_BUN, 1, 1, "each"), wasteful(P_PATTY, 150, 1, "g", 500)],
    )
    .await;
    assert_eq!(recipe_status(&db, &v1).await, "retired");

    let e = db.exec_err(&promote(&sale_id)).await;
    assert!(e.contains("not published"), "{e}");
    assert!(is_draft(&db, &sale_id).await, "and it stays a draft");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_line_cannot_be_re_pointed_at_an_unpublished_version() {
    // The UPDATE arm. No evidence attached, so rule 5a is not what refuses it.
    let db = kitchen().await;
    let v1 = publish(&db, "r108", four_ingredient_burger()).await;
    let v2 = draft_version(&db, "r109", vec![component(P_BUN, 1, 1, "each")]).await;

    db.exec(&draft_sale_sql(
        "ds-repoint",
        9203,
        line_cents(BURGER_RATE_MC, 1),
    ))
    .await;
    db.exec(&recipe_line_sql(
        "dl-repoint",
        "ds-repoint",
        STORE_ID,
        P_BURGER,
        &format!("'{v1}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    let e = db
        .exec_err(&format!(
            "UPDATE sale_items SET recipe_id='{v2}', recipe_version=2 WHERE id='dl-repoint'"
        ))
        .await;
    assert!(e.contains("only be costed from a PUBLISHED recipe"), "{e}");
}

// ============================================================================
// 11. P1-B — THE CENT COLUMNS ARE THE MONEY, AND THEY ARE RECONCILED EXACTLY
//
// The second cut reconciled the microcent RATE and left the three cent columns
// alone. Those are what every gross-profit figure in the application reads, so
// a writer could file 174 cents of faithful ingredient evidence and book 1 cent
// of cost. The rules are `cost.rs`'s own, read out of the source:
//
//     unit_cogs_excl_vat_cents = (U + 500000) / 1000000
//     line_cogs_excl_vat_cents = (U * Q + 500000) / 1000000      <- ONE rounding
//     sales.cogs_total_cents   = SUM(line_cogs_excl_vat_cents)
//
// The middle one is the trap: it is NOT the unit cost in cents times the
// quantity.
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_cent_rule_this_file_asserts_is_the_one_rust_uses() {
    // The test's own arithmetic, pinned against the engine on a real posted
    // sale, so the three refusals below are keyed to the real rule and not to
    // a restatement of it that happens to agree.
    let db = kitchen().await;
    publish(&db, "r110", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    for qty in [1_i64, 2, 3, 7] {
        let payload = burger_sale(qty);
        let sale_id = payload.sale_id.clone();
        post_sale_with_pool(db.pool(), payload).await.expect("posts");
        let (rate_mc, unit_c, line_c, _) = line_cogs(&db, &sale_id).await;
        assert_eq!(rate_mc, BURGER_RATE_MC);
        assert_eq!(unit_c, unit_cents(BURGER_RATE_MC), "unit cents, qty {qty}");
        assert_eq!(line_c, line_cents(BURGER_RATE_MC, qty), "line cents, qty {qty}");
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"
            ))
            .await,
            line_c,
            "the header is the sum of its lines"
        );
    }

    // 174 per unit; 3 units are 522 and NOT 3 x 174 = 522 by accident — the
    // case where the two differ is asserted in the multi-yield test below.
    assert_eq!(unit_cents(BURGER_RATE_MC), 174);
    assert_eq!(line_cents(BURGER_RATE_MC, 3), 522);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rounding_once_is_not_rounding_then_multiplying() {
    // The GP-A03 property, at the cent boundary this trigger now enforces. A
    // 20-portion batch gives 14,756,250 microcents a portion: 15 cents each,
    // but THREE of them are 44 cents, not 45. A reconciliation written as
    // `unit_cents * quantity` would have refused the honest sale and accepted
    // the wrong one.
    assert_eq!(unit_cents(14_756_250), 15);
    assert_eq!(line_cents(14_756_250, 3), 44);
    assert_ne!(line_cents(14_756_250, 3), unit_cents(14_756_250) * 3);

    // And the half-cent boundary itself, half AWAY from zero.
    assert_eq!(unit_cents(500_000), 1);
    assert_eq!(unit_cents(499_999), 0);
    assert_eq!(unit_cents(1_500_000), 2);
    assert_eq!(unit_cents(1_499_999), 1);

    let db = kitchen().await;
    let r = rid("r111");
    save_recipe_draft_with_pool(
        db.pool(),
        SaveRecipeDraftPayload {
            yield_quantity_base: 20,
            ..draft(&r, four_ingredient_burger())
        },
    )
    .await
    .expect("draft saves");
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r,
        },
    )
    .await
    .expect("publishes");
    use_recipe_costing(&db).await;

    let payload = burger_sale(3);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("posts");
    let (rate_mc, unit_c, line_c, _) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 8_693_750, "the batch over its yield");
    assert_eq!(unit_c, 9);
    assert_eq!(line_c, 26, "3 x 8.69375 cents rounded ONCE, not 9 x 3 = 27");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn faithful_evidence_with_a_fraudulent_unit_COST_IN_CENTS_is_refused() {
    // Codex's case: ~174 cents of honest ingredient evidence, 1 cent booked.
    let db = kitchen().await;
    let r = publish(&db, "r112", four_ingredient_burger()).await;

    for bogus in [0_i64, 1, 173, 175, 9999] {
        let tag = format!("uc{bogus}");
        let sale_id = format!("ds-{tag}");
        let line_id = format!("dl-{tag}");
        db.exec(&draft_sale_sql(&sale_id, 9300 + bogus, bogus)).await;
        db.exec(&recipe_line_cents_sql(
            &line_id,
            &sale_id,
            STORE_ID,
            P_BURGER,
            &format!("'{r}'"),
            "1",
            "'recipe'",
            BURGER_RATE_MC,
            1,
            bogus,
            bogus,
        ))
        .await;
        for e in burger_evidence(&sale_id, &line_id, &r, 1) {
            db.exec(&e.sql()).await;
        }
        let e = db.exec_err(&promote(&sale_id)).await;
        assert!(
            e.contains("unit cost in cents does not follow"),
            "a unit cost of {bogus} cents against a rate of {BURGER_RATE_MC} must be refused: {e}"
        );
        assert!(is_draft(&db, &sale_id).await);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_correct_unit_cost_with_a_fraudulent_LINE_cost_is_refused() {
    let db = kitchen().await;
    let r = publish(&db, "r113", four_ingredient_burger()).await;
    let honest_unit = unit_cents(BURGER_RATE_MC);
    let honest_line = line_cents(BURGER_RATE_MC, 3);
    assert_eq!((honest_unit, honest_line), (174, 522));

    for bogus in [1_i64, 174, 521, 523, 1_000_000] {
        let tag = format!("lc{bogus}");
        let sale_id = format!("ds-{tag}");
        let line_id = format!("dl-{tag}");
        db.exec(&draft_sale_sql(&sale_id, 9400 + (bogus % 500), bogus)).await;
        db.exec(&recipe_line_cents_sql(
            &line_id,
            &sale_id,
            STORE_ID,
            P_BURGER,
            &format!("'{r}'"),
            "1",
            "'recipe'",
            BURGER_RATE_MC,
            3,
            honest_unit,
            bogus,
        ))
        .await;
        for e in burger_evidence(&sale_id, &line_id, &r, 1) {
            db.exec(&e.sql()).await;
        }
        let e = db.exec_err(&promote(&sale_id)).await;
        assert!(
            e.contains("extended cost does not follow"),
            "a line cost of {bogus} against 3 x {BURGER_RATE_MC} must be refused: {e}"
        );
    }

    // And the honest figures post.
    db.exec(&draft_sale_sql("ds-lcok", 9499, honest_line)).await;
    db.exec(&recipe_line_cents_sql(
        "dl-lcok",
        "ds-lcok",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
        3,
        honest_unit,
        honest_line,
    ))
    .await;
    for e in burger_evidence("ds-lcok", "dl-lcok", &r, 1) {
        db.exec(&e.sql()).await;
    }
    db.exec(&promote("ds-lcok")).await;
    assert_eq!(
        db.scalar_string("SELECT status FROM sales WHERE id='ds-lcok'").await,
        "posted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn correct_line_costs_with_a_fraudulent_SALE_HEADER_total_are_refused() {
    let db = kitchen().await;
    let r = publish(&db, "r114", four_ingredient_burger()).await;
    let honest = line_cents(BURGER_RATE_MC, 1);

    for bogus in [0_i64, 1, honest - 1, honest + 1, 99_999] {
        let tag = format!("hd{bogus}");
        let sale_id = format!("ds-{tag}");
        let line_id = format!("dl-{tag}");
        db.exec(&draft_sale_sql(&sale_id, 9500 + (bogus % 400), bogus)).await;
        db.exec(&recipe_line_sql(
            &line_id,
            &sale_id,
            STORE_ID,
            P_BURGER,
            &format!("'{r}'"),
            "1",
            "'recipe'",
            BURGER_RATE_MC,
        ))
        .await;
        for e in burger_evidence(&sale_id, &line_id, &r, 1) {
            db.exec(&e.sql()).await;
        }
        let e = db.exec_err(&promote(&sale_id)).await;
        assert!(
            e.contains("total cost that is not the sum"),
            "a header total of {bogus} against a line of {honest} must be refused: {e}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_MIXED_sale_reconciles_its_header_over_every_line_whatever_costed_it() {
    // One recipe line, one manual-costed line and one purchase-valued line, on
    // one receipt, through the real command. The header is a single figure and
    // it has to be the whole of the sale — which is why the reconciliation is
    // over EVERY line and not only the recipe ones.
    let db = kitchen().await;
    publish(&db, "r115", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    seed_manual_cost(&db, P_UNPRICED, 40_000_000).await;

    let payload = sale_payload(
        vec![
            SaleLineBuilder::new(P_BURGER, "Greaz Burger")
                .service(true)
                .qty(2)
                .unit_incl(1110)
                .build(),
            SaleLineBuilder::new(P_UNPRICED, "Unpriced garnish")
                .service(true)
                .qty(3)
                .unit_incl(1110)
                .build(),
            SaleLineBuilder::new(P_COFFEE, "Coffee 250g")
                .qty(1)
                .unit_incl(1110)
                .build(),
        ],
        vec![cash_usd(1110 * 6)],
    );
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("mixed sale posts");

    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT COALESCE(cogs_source,'NULL') AS src, quantity AS q,
                unit_cogs_excl_vat_microcents AS mc,
                unit_cogs_excl_vat_cents AS uc, line_cogs_excl_vat_cents AS lc
           FROM sale_items WHERE sale_id = ? ORDER BY product_id",
    )
    .bind(&sale_id)
    .fetch_all(db.pool())
    .await
    .expect("read lines");
    assert_eq!(rows.len(), 3);

    let mut total = 0_i64;
    let mut sources: Vec<String> = Vec::new();
    for row in &rows {
        let mc: i64 = row.try_get("mc").unwrap();
        let q: i64 = row.try_get("q").unwrap();
        let uc: i64 = row.try_get("uc").unwrap();
        let lc: i64 = row.try_get("lc").unwrap();
        assert_eq!(uc, unit_cents(mc), "unit cents on every line, whatever costed it");
        assert_eq!(lc, line_cents(mc, q), "line cents on every line");
        total += lc;
        sources.push(row.try_get::<String, _>("src").unwrap());
    }
    sources.sort();
    assert_eq!(sources, vec!["purchase_average", "recipe", "standard"]);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        total,
        "the header is the sum of ALL three lines"
    );
    // The recipe line is still the only one with evidence, and the only one
    // with an identity.
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_items WHERE sale_id='{sale_id}' AND recipe_id IS NOT NULL"
        ))
        .await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sales_financial_cogs_is_immutable() {
    let db = kitchen().await;
    publish(&db, "r116", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    let payload = burger_sale(2);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    for set in [
        "unit_cogs_excl_vat_cents = 1",
        "line_cogs_excl_vat_cents = 1",
        "unit_cogs_excl_vat_microcents = 1",
    ] {
        let e = db
            .exec_err(&format!(
                "UPDATE sale_items SET {set} WHERE sale_id='{sale_id}'"
            ))
            .await;
        assert!(e.contains("frozen") || e.contains("immutable"), "{set}: {e}");
    }
    let e = db
        .exec_err(&format!(
            "UPDATE sales SET cogs_total_cents = 1 WHERE id='{sale_id}'"
        ))
        .await;
    assert!(e.contains("immutable") || e.contains("cannot be"), "{e}");

    assert_eq!(
        line_cogs(&db, &sale_id).await,
        (
            BURGER_RATE_MC,
            unit_cents(BURGER_RATE_MC),
            line_cents(BURGER_RATE_MC, 2),
            "recipe".to_string()
        )
    );
}

// ============================================================================
// 12. P1-C — BOUNDED, INTEGER-SAFE DATABASE ARITHMETIC
//
// SQLite 3.51, measured: `*` and `+` on INTEGERs SILENTLY PROMOTE TO REAL on
// overflow and raise nothing, `SUM()` over INTEGERs RAISES `integer overflow`,
// and INTEGER AFFINITY IS NOT A TYPE — a column declared INTEGER holds 1.5 as
// a REAL and 'abc' as TEXT, and `typeof(2.0)` is `'real'`.
//
// So the migration holds every figure it multiplies to three conditions in
// three SEPARATE statements, in order — storage class, range, magnitude gate —
// because SQLite promises no evaluation order inside one boolean expression.
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_silently_promotes_an_overflowing_product_which_is_why_the_gates_exist() {
    // The premise of the whole design, asserted against the engine this
    // application ships rather than taken on trust. If a future SQLite starts
    // raising instead, this test says so and the gates become belt-and-braces.
    let db = TempDb::new().await;
    assert_eq!(
        db.scalar_string("SELECT typeof(9223372036854775807 * 2)").await,
        "real",
        "an overflowing product is promoted, not refused"
    );
    assert_eq!(db.scalar_string("SELECT typeof(2.0)").await, "real");
    assert_eq!(db.scalar_string("SELECT typeof('7')").await, "text");
    assert_eq!(db.scalar_string("SELECT typeof(NULL)").await, "null");
    // ...and SUM is the one aggregate that fails closed.
    db.exec("CREATE TABLE ovf (x INTEGER)").await;
    db.exec("INSERT INTO ovf VALUES (9223372036854775807), (9223372036854775807)")
        .await;
    let e = db.exec_err("INSERT INTO ovf SELECT SUM(x) FROM ovf").await;
    assert!(e.to_lowercase().contains("overflow"), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recipe_takes_64_ingredients_and_refuses_the_65th() {
    let db = kitchen().await;
    // 64 distinct service ingredients, each with a Manual Cost so the recipe
    // can be costed, built through the real command.
    let mut components = Vec::new();
    for i in 0..64 {
        let id = format!("00000000-0000-0000-0000-0000000{:05}", 70000 + i);
        let sku = format!("SKU-C{i:03}");
        let name = format!("Ingredient {i}");
        seed_product(
            &db,
            &ProductSpec {
                is_service: true,
                base_uom_code: "each",
                ..ProductSpec::stocked(&id, &sku, &name)
            },
        )
        .await;
        seed_manual_cost(&db, &id, 1_000_000).await;
        components.push(component(&id, 1, 1, "each"));
    }
    let r = publish(&db, "r120", components).await;
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        64
    );

    // The 65th is refused by the ENGINE, not only by the command.
    let e = db
        .exec_err(&format!(
            "INSERT INTO recipe_components (id, recipe_id, store_id, component_product_id,
               quantity_num, quantity_den, uom_code, product_uom_id_snapshot,
               factor_num_snapshot, factor_den_snapshot, waste_bps, sort_order)
             VALUES ('rc-65', '{r}', '{STORE_ID}', '{P_BUN}', 1, 1, 'each',
               (SELECT id FROM product_uoms WHERE product_id='{P_BUN}' AND uom_code='each'),
               1, 1, 0, 99)"
        ))
        .await;
    assert!(e.contains("at most 64 ingredients"), "{e}");

    // ...and the command refuses it too, by its own count.
    let mut too_many = Vec::new();
    for i in 0..65 {
        let id = format!("00000000-0000-0000-0000-0000000{:05}", 70000 + i);
        too_many.push(component(&id, 1, 1, "each"));
    }
    let err = save_recipe_draft_with_pool(db.pool(), draft(&rid("r121"), too_many))
        .await
        .unwrap_err();
    assert!(err.contains("at most 64"), "{err}");

    // And a 64-ingredient recipe SELLS, inside the proven envelope: each
    // ingredient is 1,000,000 microcents of one unit, so the batch is
    // 64,000,000 and a yield of 1 makes that the rate.
    use_recipe_costing(&db).await;
    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload)
        .await
        .expect("a 64-ingredient burger posts");
    let (rate_mc, unit_c, line_c, src) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, 64_000_000);
    assert_eq!(unit_c, 64);
    assert_eq!(line_c, 64);
    assert_eq!(src, "recipe");
    assert_eq!(evidence(&db, &sale_id).await.len(), 64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recipe_forced_above_64_components_cannot_cost_a_sale() {
    // Section 9 stops the 65th being WRITTEN; rule 6k stops a recipe that is
    // already oversized from costing a sale. Proved by building the oversized
    // recipe at schema v21 — before 022's own guard exists — and then
    // upgrading, which is the only honest way to produce the state.
    let db = TempDb::at_schema_version(21).await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            ..ProductSpec::stocked(P_BURGER, "SKU-BURGER", "Greaz Burger")
        },
    )
    .await;
    let r = rid("r122");
    db.exec(&format!(
        "INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
         VALUES ('{r}', '{STORE_ID}', '{P_BURGER}', 1, 1, 'draft')"
    ))
    .await;
    for i in 0..70 {
        let id = format!("00000000-0000-0000-0000-0000000{:05}", 80000 + i);
        let sku = format!("SKU-D{i:03}");
        let name = format!("Bulk {i}");
        seed_product(
            &db,
            &ProductSpec {
                is_service: true,
                base_uom_code: "each",
                ..ProductSpec::stocked(&id, &sku, &name)
            },
        )
        .await;
        seed_manual_cost(&db, &id, 1_000_000).await;
        db.exec(&format!(
            "INSERT INTO recipe_components (id, recipe_id, store_id, component_product_id,
               quantity_num, quantity_den, uom_code, product_uom_id_snapshot,
               factor_num_snapshot, factor_den_snapshot, waste_bps, sort_order)
             VALUES ('rcb{i}', '{r}', '{STORE_ID}', '{id}', 1, 1, 'each',
               (SELECT id FROM product_uoms WHERE product_id='{id}' AND uom_code='each'),
               1, 1, 0, {i})"
        ))
        .await;
    }
    db.exec(&format!(
        "UPDATE recipes SET status='active', activated_at='2026-10-26T09:00:00.000Z'
          WHERE id='{r}'"
    ))
    .await;
    db.migrate_again().await.expect("migration 022 must apply");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        70,
        "the oversized recipe survives the upgrade: nothing is deleted"
    );

    // 70 ingredients at 1,000,000 microcents each, so a faithful rate is
    // 70,000,000 and a faithful explanation is 70 rows. Every row is honest;
    // the only thing wrong is that there are more of them than the arithmetic
    // is proven for.
    db.exec(&format!(
        "UPDATE products SET costing_method='recipe' WHERE id='{P_BURGER}'"
    ))
    .await;
    db.exec(&draft_sale_sql("ds-65", 9600, 70)).await;
    db.exec(&recipe_line_sql(
        "dl-65",
        "ds-65",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        70_000_000,
    ))
    .await;
    for i in 0..70 {
        let id = format!("00000000-0000-0000-0000-0000000{:05}", 80000 + i);
        db.exec(
            &Ev {
                id: format!("ev65-{i}"),
                sale_id: "ds-65".to_string(),
                sale_item_id: "dl-65".to_string(),
                store_id: STORE_ID.to_string(),
                recipe_id: r.clone(),
                version: 1,
                component: id,
                name: format!("Bulk {i}"),
                uom: "each".to_string(),
                qn: 1,
                qd: 1,
                fnum: 1,
                fden: 1,
                waste: 0,
                rate: 1_000_000,
                source: "standard".to_string(),
                contrib: 1_000_000,
                sort: i,
            }
            .sql(),
        )
        .await;
    }
    let e = db.exec_err(&promote("ds-65")).await;
    assert!(e.contains("more than 64 ingredients"), "{e}");
    assert!(is_draft(&db, "ds-65").await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_high_component_count_tolerance_attack_fails() {
    // The attack the component bound exists to stop. Rule 6o's tolerance is
    // `Y + n`, so an unbounded n bought an unbounded licence to misstate the
    // microcent rate. With n held at 64 and Y at 1 the slack is 65 microcents —
    // 0.0065 of a cent — and the CENT columns are reconciled exactly besides,
    // so there is no tolerance at all in the money.
    let db = kitchen().await;
    let mut components = Vec::new();
    for i in 0..64 {
        let id = format!("00000000-0000-0000-0000-0000000{:05}", 90000 + i);
        let sku = format!("SKU-E{i:03}");
        let name = format!("Tol {i}");
        seed_product(
            &db,
            &ProductSpec {
                is_service: true,
                base_uom_code: "each",
                ..ProductSpec::stocked(&id, &sku, &name)
            },
        )
        .await;
        seed_manual_cost(&db, &id, 1_000_000).await;
        components.push(component(&id, 1, 1, "each"));
    }
    let r = publish(&db, "r123", components).await;

    // A faithful explanation of 64,000,000 microcents, with the RATE inflated
    // by more than the tolerance can absorb.
    let build = |tag: &str, receipt: i64, rate: i64| {
        let sale_id = format!("ds-{tag}");
        let line_id = format!("dl-{tag}");
        (
            sale_id.clone(),
            line_id.clone(),
            draft_sale_sql(&sale_id, receipt, line_cents(rate, 1)),
            recipe_line_sql(
                &line_id,
                &sale_id,
                STORE_ID,
                P_BURGER,
                &format!("'{r}'"),
                "1",
                "'recipe'",
                rate,
            ),
        )
    };

    for (tag, receipt, rate, want) in [
        ("tolok", 9700_i64, 64_000_000_i64, true),
        ("tolhi", 9701, 64_000_000 + 65, true),
        ("tolbad", 9702, 64_000_000 + 66, false),
        ("tolwild", 9703, 640_000_000, false),
    ] {
        let (sale_id, line_id, sale_sql, line_sql) = build(tag, receipt, rate);
        db.exec(&sale_sql).await;
        db.exec(&line_sql).await;
        for i in 0..64 {
            let id = format!("00000000-0000-0000-0000-0000000{:05}", 90000 + i);
            db.exec(
                &Ev {
                    id: format!("{tag}-{i}"),
                    sale_id: sale_id.clone(),
                    sale_item_id: line_id.clone(),
                    store_id: STORE_ID.to_string(),
                    recipe_id: r.clone(),
                    version: 1,
                    component: id,
                    name: format!("Tol {i}"),
                    uom: "each".to_string(),
                    qn: 1,
                    qd: 1,
                    fnum: 1,
                    fden: 1,
                    waste: 0,
                    rate: 1_000_000,
                    source: "standard".to_string(),
                    contrib: 1_000_000,
                    sort: i,
                }
                .sql(),
            )
            .await;
        }
        if want {
            db.exec(&promote(&sale_id)).await;
            assert_eq!(
                db.scalar_string(&format!("SELECT status FROM sales WHERE id='{sale_id}'")).await,
                "posted",
                "{tag} is inside the documented tolerance"
            );
        } else {
            let e = db.exec_err(&promote(&sale_id)).await;
            assert!(e.contains("does not follow from the evidence"), "{tag}: {e}");
        }
        // Either way the MONEY was exact: the cent columns were derived from
        // the rate, so a rate inside the tolerance still produced the right
        // cents and a rate outside it never reached the cent rules at all.
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_integer_storage_is_refused_wherever_the_database_does_arithmetic() {
    // INTEGER affinity is not a type. Each of these values is storable in its
    // column and satisfies its CHECK; none of them can be reconciled.
    let db = kitchen().await;
    let r = publish(&db, "r124", four_ingredient_burger()).await;
    db.exec(&draft_sale_sql(
        "ds-typ",
        9800,
        line_cents(BURGER_RATE_MC, 1),
    ))
    .await;
    db.exec(&recipe_line_sql(
        "dl-typ",
        "ds-typ",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;

    // Built as raw SQL rather than through `Ev`, because the whole point is to
    // put a value of the WRONG STORAGE CLASS into an INTEGER column, which a
    // typed builder cannot express. Each literal below is storable and
    // satisfies its CHECK: `1.5` stays REAL because affinity converts only a
    // LOSSLESS numeric, and `'abc'` stays TEXT because it is not numeric at
    // all. `2.0` would be silently converted to an integer and is therefore
    // not an attack.
    let ev_raw = |id: &str, qn: &str, rate: &str, contrib: &str| {
        format!(
            "INSERT INTO sale_item_recipe_costs (
               id, sale_id, sale_item_id, store_id, recipe_id, recipe_version,
               component_product_id, component_name_snapshot, uom_code,
               quantity_num, quantity_den, factor_num_snapshot, factor_den_snapshot,
               waste_bps, unit_cost_excl_vat_microcents, cost_source,
               contribution_microcents, sort_order)
             VALUES ('{id}', 'ds-typ', 'dl-typ', '{STORE_ID}', '{r}', 1,
               '{P_BUN}', 'Burger bun', 'each',
               {qn}, 1, 1, 1, 0, {rate}, 'purchase_average', {contrib}, 0)"
        )
    };

    for (what, sql) in [
        ("a decimal quantity", ev_raw("t1", "1.5", "22000000", "33000000")),
        ("a decimal rate", ev_raw("t2", "1", "22000000.5", "22000000")),
        ("a decimal contribution", ev_raw("t3", "1", "22000000", "22000000.5")),
        ("a text rate", ev_raw("t4", "1", "'abc'", "22000000")),
        ("a text quantity", ev_raw("t5", "'two'", "22000000", "22000000")),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(
            e.contains("whole numbers"),
            "{what} must be refused by the storage-class rule, got: {e}"
        );
    }

    // The CONTROL: an integral REAL is converted by affinity before any
    // trigger sees it, so it is an integer and is accepted. Stated so the rule
    // above is understood as "integer storage class", not "no decimal point in
    // the SQL text".
    db.exec(&ev_raw("t6", "1.0", "22000000", "22000000")).await;
    assert_eq!(
        db.scalar_string("SELECT typeof(quantity_num) FROM sale_item_recipe_costs WHERE id='t6'")
            .await,
        "integer"
    );
    // Only the control row landed; every wrong-class row was refused.
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 1);

    // The remaining three honest rows go in. The control row IS the bun's
    // faithful evidence — same ingredient, same figures — so the set is
    // complete once the other three are written.
    for e in burger_evidence("ds-typ", "dl-typ", &r, 1).iter().skip(1) {
        db.exec(&e.sql()).await;
    }
    db.exec("UPDATE sales SET cogs_total_cents = 174.5 WHERE id='ds-typ'")
        .await;
    let e = db.exec_err(&promote("ds-typ")).await;
    assert!(
        e.contains("stored as text, as a decimal or as NULL"),
        "a REAL sale total must be refused: {e}"
    );
    db.exec("UPDATE sales SET cogs_total_cents = 174 WHERE id='ds-typ'")
        .await;
    db.exec(&promote("ds-typ")).await;
    assert_eq!(
        db.scalar_string("SELECT status FROM sales WHERE id='ds-typ'").await,
        "posted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_out_of_range_contribution_or_rate_is_refused_before_it_is_multiplied() {
    let db = kitchen().await;
    let r = publish(&db, "r125", four_ingredient_burger()).await;
    db.exec(&draft_sale_sql(
        "ds-rng",
        9801,
        line_cents(BURGER_RATE_MC, 1),
    ))
    .await;
    db.exec(&recipe_line_sql(
        "dl-rng",
        "ds-rng",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;
    let bun = burger_evidence("ds-rng", "dl-rng", &r, 1)[0].clone();

    // Above the documented contribution bound, and above the documented rate
    // bound. Both are refused BY NAME rather than multiplied and compared.
    let e = db
        .exec_err(&Ev { contrib: 1_000_000_000_000_001, ..bun.clone() }.sql())
        .await;
    assert!(e.contains("outside the range"), "{e}");
    let e = db
        .exec_err(&Ev {
            rate: 10_000_000_000_001,
            contrib: 100_000_000_000_010,
            ..bun.clone()
        }
        .sql())
        .await;
    assert!(e.contains("outside the range"), "{e}");

    // And the i64 extremes, which is where a silent promotion to REAL would
    // have made every later comparison meaningless.
    let e = db
        .exec_err(&Ev { contrib: 9_223_372_036_854_775_807, ..bun.clone() }.sql())
        .await;
    assert!(e.contains("outside the range"), "{e}");
    let e = db
        .exec_err(&Ev { rate: 9_223_372_036_854_775_807, ..bun.clone() }.sql())
        .await;
    assert!(e.contains("outside the range"), "{e}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_cannot_post_with_an_out_of_range_line_rate_or_quantity() {
    // The gate on the LINE's own figures, which rule 6n needs before it
    // multiplies the rate by the yield and by the quantity.
    let db = kitchen().await;
    let r = publish(&db, "r126", four_ingredient_burger()).await;
    let huge = 2_000_000_000_000_000_i64;
    db.exec(&draft_sale_sql("ds-big", 9802, 0)).await;
    db.exec(&recipe_line_cents_sql(
        "dl-big",
        "ds-big",
        STORE_ID,
        P_BURGER,
        &format!("'{r}'"),
        "1",
        "'recipe'",
        huge,
        1,
        unit_cents(huge),
        line_cents(huge, 1),
    ))
    .await;
    for e in burger_evidence("ds-big", "dl-big", &r, 1) {
        db.exec(&e.sql()).await;
    }
    let e = db.exec_err(&promote("ds-big")).await;
    assert!(e.contains("outside the range"), "{e}");
    assert!(is_draft(&db, "ds-big").await);
}

// ============================================================================
// 13. THE SELF-AUDIT CASES
//
// Paths the three corrections touch that nothing else in this file exercises.
// Each exists because the header reconciliation (rule 6r) and the active-recipe
// rule (6e) are NEW conditions on the promotion statement, and a new condition
// on `post_sale`'s last statement is a new way for an honest sale to be
// refused. These assert the honest sale still posts.
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_DISCOUNTED_recipe_sale_still_reconciles_its_header() {
    // A discount moves revenue and VAT; it does not move COGS. The header is
    // still the sum of its lines' extended costs, so a discounted recipe sale
    // has to pass rule 6r unchanged — and it would not if the rule had been
    // written against the sale's total or its subtotal instead.
    let db = kitchen().await;
    publish(&db, "r130", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_BURGER, "Greaz Burger")
            .service(true)
            .qty(2)
            .unit_incl(1110)
            .discount(200)
            .build()],
        // The tender is the declared total: `line_discount_cents` and the
        // header's `discount_cents` are RECORDED on the document in this
        // payload shape rather than reducing what is due, and what this test
        // is about is that a discount on the document does not disturb the
        // COGS header — which rule 6r would break if it had been written
        // against the sale's total or its subtotal instead of its lines' costs.
        vec![cash_usd(2220)],
    );
    payload.discount_cents = 200;
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload)
        .await
        .expect("a discounted recipe sale posts");

    let (rate_mc, unit_c, line_c, src) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate_mc, BURGER_RATE_MC, "a discount does not move the cost");
    assert_eq!(unit_c, unit_cents(BURGER_RATE_MC));
    assert_eq!(line_c, line_cents(BURGER_RATE_MC, 2));
    assert_eq!(src, "recipe");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        line_c
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT discount_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        200
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_TRIGGER_refusal_leaves_no_partial_sale_and_no_consumed_receipt() {
    // ATOMICITY, against the new surface. A refusal raised by a TRIGGER — not
    // by the command — happens in the middle of `post_sale`'s transaction,
    // after the lines, the evidence, the movements and the tender have been
    // written. If the abort did not roll all of that back, a receipt number
    // would be gone and half a sale would be on disk.
    //
    // Forced by making the product recipe-costed and then retiring its recipe
    // by direct SQL, which leaves the engine refusing at the line INSERT. The
    // command's own `RECIPE_COSTING_NO_ACTIVE_RECIPE` check is bypassed by
    // leaving an inactive recipe reachable only to the trigger: the product
    // keeps `costing_method='recipe'` and a RETIRED version, so
    // `cost_sale_line_from_active_recipe` refuses first — which is the OTHER
    // honest outcome, and is asserted here too.
    let db = kitchen().await;
    let r = publish(&db, "r131", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    // One good sale first, so there IS a receipt sequence to damage.
    let first = burger_sale(1);
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.unwrap();
    let receipt_before = db
        .scalar_i64(&format!(
            "SELECT receipt_number FROM sales WHERE id='{first_id}'"
        ))
        .await;
    let sales_before = db.count("SELECT COUNT(*) FROM sales").await;
    let items_before = db.count("SELECT COUNT(*) FROM sale_items").await;
    let evidence_before = db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await;
    let payments_before = db.count("SELECT COUNT(*) FROM sale_payments").await;

    // Now retire the recipe out from under the product, the only way the
    // engine permits: switch the item off recipe costing, retire, switch back.
    // The last step is refused by 022's trigger pair — which is the loop
    // closing — so the state is produced by retiring while a DRAFT exists.
    db.exec(&format!(
        "INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
         VALUES ('{}', '{STORE_ID}', '{P_BURGER}', 2, 1, 'draft')",
        rid("r132")
    ))
    .await;
    db.exec(&format!(
        "UPDATE recipes SET status='retired', retired_at='2027-01-01T00:00:00.000Z'
          WHERE id='{r}'"
    ))
    .await;
    assert_eq!(recipe_status(&db, &r).await, "retired");

    let doomed = burger_sale(1);
    let err = post_sale_with_pool(db.pool(), doomed).await.unwrap_err();
    assert!(
        err.contains("no published recipe") || err.contains("PUBLISHED recipe"),
        "{err}"
    );

    // NOTHING was left behind, and the receipt sequence did not move.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, sales_before);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, items_before);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        evidence_before
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_payments").await,
        payments_before
    );
    assert_eq!(
        db.scalar_i64("SELECT MAX(receipt_number) FROM sales").await,
        receipt_before,
        "a refused sale consumes no receipt number"
    );
    // And the first sale is untouched.
    assert_eq!(line_cogs(&db, &first_id).await.0, BURGER_RATE_MC);
    assert_eq!(evidence(&db, &first_id).await.len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_still_returns_its_receipt_after_the_recipe_is_retired() {
    // The idempotency ordering, re-proved against the new active-recipe rule.
    // A till that lost its answer must get its own receipt back even when the
    // recipe it was costed from has since been superseded — because the replay
    // resolves BEFORE any write and promotes nothing.
    let db = kitchen().await;
    let v1 = publish(&db, "r133", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    let first = post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();

    publish(
        &db,
        "r134",
        vec![component(P_BUN, 1, 1, "each"), wasteful(P_PATTY, 150, 1, "g", 500)],
    )
    .await;
    assert_eq!(recipe_status(&db, &v1).await, "retired");

    let again = post_sale_with_pool(db.pool(), replay_of(&payload))
        .await
        .expect("the replay resolves after the recipe retires");
    assert_eq!(again.receipt_number, first.receipt_number);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sales").await,
        1,
        "one sale, not two"
    );
    assert_eq!(evidence(&db, &sale_id).await.len(), 4, "and one explanation");
}

// ============================================================================
// 14. THE POSTING STATE MACHINE
//
// `sales` carries TWO markers of the same fact — `status` and `posted_at` —
// and migration 001 never tied them together. The APPLICATION reads
// `status = 'posted'` (37 query sites; not one reads `posted_at`), while the
// ENGINE read `posted_at` (001's immutability trigger, 012's child guards,
// 022's finalization). So `UPDATE sales SET status='posted'` made a sale
// financially real to every report while changing no column any guard
// watched — and left the row, and its lines, mutable afterwards.
//
// These tests go round `post_sale` entirely. The lettering follows the brief.
// ============================================================================

/// The admissible pairs, read back from a row so the state machine is asserted
/// and not merely described.
async fn state_of(db: &TempDb, sale_id: &str) -> (String, String) {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT status, COALESCE(posted_at, 'NULL') AS pa FROM sales WHERE id = ?",
    )
    .bind(sale_id)
    .fetch_one(db.pool())
    .await
    .unwrap_or_else(|e| panic!("read state of {sale_id}: {e}"));
    (row.try_get("status").unwrap(), row.try_get("pa").unwrap())
}

/// A sale header INSERT in an arbitrary state, for the A and B cases.
fn insert_sale_as(sale_id: &str, receipt: i64, status: &str, posted_at: &str) -> String {
    format!(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
            exchange_rate_lbp_per_usd, exchange_rate_id,
            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
            discount_cents, cogs_total_cents, cogs_method, sale_type, status, posted_at)
         VALUES ('{sale_id}', '{STORE_ID}', '{SHIFT_ID}', '{USER_ID}', {receipt},
            {RATE_LBP_PER_USD}, '{RATE_ID}', 1000, 110, 1110, 0, 0,
            'weighted_average', 'normal', '{status}', {posted_at})"
    )
}

// ---- A and B: a sale is BORN A DRAFT ---------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_cannot_be_INSERTED_already_posted_in_any_shape() {
    // A. `status='posted'` with `posted_at` NULL — the row every report counts
    //    and no guard protects.
    // B. `status='posted'` WITH a timestamp — which must not become the
    //    shortcut, because at header-insert time there are no lines and no
    //    evidence to validate, and afterwards 012 refuses to let the lines
    //    arrive. Such a row could only ever be an empty receipt claiming
    //    whatever revenue its author typed.
    let db = kitchen().await;

    for (what, status, posted) in [
        ("A  posted with no timestamp", "posted", "NULL"),
        ("B  posted WITH a timestamp", "posted", "'2026-01-01T00:00:00.000Z'"),
        ("   voided with a timestamp", "voided", "'2026-01-01T00:00:00.000Z'"),
        ("   voided with no timestamp", "voided", "NULL"),
        ("   draft carrying a timestamp", "draft", "'2026-01-01T00:00:00.000Z'"),
    ] {
        let e = db
            .exec_err(&insert_sale_as("ins-probe", 9900, status, posted))
            .await;
        assert!(
            e.contains("created as a draft"),
            "{what} must be refused: {e}"
        );
    }
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);

    // ...and the ONE legal shape is accepted, which is what `post_sale` writes.
    db.exec(&insert_sale_as("ins-ok", 9901, "draft", "NULL")).await;
    assert_eq!(state_of(&db, "ins-ok").await, ("draft".into(), "NULL".into()));
}

// ---- C, D, E: no transition into posted escapes finalization ---------------

/// A draft sale with a recipe-costed line and INCOMPLETE evidence: three of
/// the burger's four ingredients. Every other figure is honest.
async fn incomplete_draft(db: &TempDb, recipe_id: &str, tag: &str, receipt: i64) -> String {
    let sale_id = format!("inc-{tag}");
    let line_id = format!("incl-{tag}");
    db.exec(&draft_sale_sql(&sale_id, receipt, line_cents(BURGER_RATE_MC, 1)))
        .await;
    db.exec(&recipe_line_sql(
        &line_id,
        &sale_id,
        STORE_ID,
        P_BURGER,
        &format!("'{recipe_id}'"),
        "1",
        "'recipe'",
        BURGER_RATE_MC,
    ))
    .await;
    for e in burger_evidence(&sale_id, &line_id, recipe_id, 1).iter().take(3) {
        db.exec(&e.sql()).await;
    }
    sale_id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_route_into_the_posted_state_skips_the_evidence_check() {
    let db = kitchen().await;
    let r = publish(&db, "r140", four_ingredient_burger()).await;
    let now = "'2026-11-01T10:00:00.000Z'";

    // C. STATUS ONLY — the bypass. The old trigger was `BEFORE UPDATE OF
    //    posted_at` and never saw this statement.
    let c = incomplete_draft(&db, &r, "c", 9910).await;
    let e = db
        .exec_err(&format!("UPDATE sales SET status='posted' WHERE id='{c}'"))
        .await;
    assert!(
        e.contains("incomplete recipe-cost explanation") || e.contains("must record when it posted"),
        "C: {e}"
    );
    assert_eq!(state_of(&db, &c).await, ("draft".into(), "NULL".into()));

    // D. POSTED_AT ONLY — refused by the state rule AND, independently, by the
    //    finalization rule, since the WHEN clause watches both markers.
    let d = incomplete_draft(&db, &r, "d", 9911).await;
    let e = db
        .exec_err(&format!(
            "UPDATE sales SET posted_at={now} WHERE id='{d}'"
        ))
        .await;
    assert!(
        e.contains("incomplete recipe-cost explanation")
            || e.contains("draft sale cannot carry a posting time"),
        "D: {e}"
    );
    assert_eq!(state_of(&db, &d).await, ("draft".into(), "NULL".into()));

    // E. BOTH TOGETHER — the coherent transition, which is what `post_sale`
    //    issues. The state rules are satisfied, so it is the EVIDENCE rule
    //    that must refuse it.
    let x = incomplete_draft(&db, &r, "e", 9912).await;
    let e = db
        .exec_err(&format!(
            "UPDATE sales SET status='posted', posted_at={now} WHERE id='{x}'"
        ))
        .await;
    assert!(e.contains("incomplete recipe-cost explanation"), "E: {e}");
    assert_eq!(state_of(&db, &x).await, ("draft".into(), "NULL".into()));

    // F. The SAME sale posts the moment the explanation is complete, through
    //    the same coherent transition.
    db.exec(
        &burger_evidence(&x, &format!("incl-e"), &r, 1)[3].sql(),
    )
    .await;
    db.exec(&format!(
        "UPDATE sales SET status='posted', posted_at={now} WHERE id='{x}'"
    ))
    .await;
    assert_eq!(
        state_of(&db, &x).await,
        ("posted".into(), "2026-11-01T10:00:00.000Z".into())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_status_only_bypass_is_closed_for_a_NON_recipe_sale_too() {
    // The state invariant is not about recipes: a sale of ordinary
    // purchase-valued goods must not become financially visible with its two
    // markers disagreeing either, because 37 read models would count it and
    // 001's immutability trigger would not protect it.
    let db = kitchen().await;
    db.exec(&draft_sale_sql("ns-1", 9920, 200)).await;
    db.exec(&recipe_line_cents_sql(
        "nsl-1",
        "ns-1",
        STORE_ID,
        P_COFFEE,
        "NULL",
        "NULL",
        "'purchase_average'",
        200_000_000,
        1,
        200,
        200,
    ))
    .await;

    let e = db
        .exec_err("UPDATE sales SET status='posted' WHERE id='ns-1'")
        .await;
    assert!(e.contains("must record when it posted"), "{e}");
    let e = db
        .exec_err("UPDATE sales SET posted_at='2026-11-01T10:00:00.000Z' WHERE id='ns-1'")
        .await;
    assert!(e.contains("cannot carry a posting time"), "{e}");
    assert_eq!(state_of(&db, "ns-1").await, ("draft".into(), "NULL".into()));

    // Both together is the legal transition and it posts.
    db.exec(
        "UPDATE sales SET status='posted', posted_at='2026-11-01T10:00:00.000Z'
          WHERE id='ns-1'",
    )
    .await;
    assert_eq!(
        state_of(&db, "ns-1").await,
        ("posted".into(), "2026-11-01T10:00:00.000Z".into())
    );
}

// ---- G and H: nothing goes backwards --------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sale_cannot_be_returned_to_an_editable_draft() {
    let db = kitchen().await;
    publish(&db, "r141", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();
    let posted_at = db
        .scalar_string(&format!("SELECT posted_at FROM sales WHERE id='{sale_id}'"))
        .await;

    for (what, sql) in [
        // G. Clear the timestamp.
        ("clearing posted_at", format!("UPDATE sales SET posted_at=NULL WHERE id='{sale_id}'")),
        // H. Revert the status.
        ("reverting to draft", format!("UPDATE sales SET status='draft' WHERE id='{sale_id}'")),
        // ...and both at once, which is the shape that would otherwise look
        // coherent to a rule written only about one marker.
        (
            "both at once",
            format!("UPDATE sales SET status='draft', posted_at=NULL WHERE id='{sale_id}'"),
        ),
        // Rewriting the posting time is not a transition, it is a forgery.
        (
            "rewriting posted_at",
            format!("UPDATE sales SET posted_at='2020-01-01T00:00:00.000Z' WHERE id='{sale_id}'"),
        ),
    ] {
        let e = db.exec_err(&sql).await;
        // Any of these sentences is a correct refusal. WHICH one speaks is
        // decided by statement order inside one trigger, and asserting on that
        // would pin an implementation detail rather than the invariant: what
        // matters is that no route backwards is open.
        assert!(
            e.contains("immutable")
                || e.contains("must record when it posted")
                || e.contains("cannot have its posting time cleared")
                || e.contains("cannot be returned to a draft")
                || e.contains("cannot carry a posting time")
                || e.contains("written once"),
            "{what} must be refused: {e}"
        );
    }

    // The row is exactly as posted, and so is its explanation.
    assert_eq!(state_of(&db, &sale_id).await, ("posted".into(), posted_at));
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
    assert_eq!(line_cogs(&db, &sale_id).await.0, BURGER_RATE_MC);
}

// ---- I: history stays readable and immutable ------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sale_survives_its_recipe_being_retired_and_stays_sealed() {
    // The state rules must not make history fragile: a sale posted from v1 is
    // still readable, still carries its own figures, and is still immutable
    // after v1 is superseded.
    let db = kitchen().await;
    let v1 = publish(&db, "r142", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    let payload = burger_sale(2);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    publish(
        &db,
        "r143",
        vec![component(P_BUN, 1, 1, "each"), wasteful(P_PATTY, 150, 1, "g", 500)],
    )
    .await;
    assert_eq!(recipe_status(&db, &v1).await, "retired");

    // READABLE: the figures and the explanation are still there.
    let (rate, unit_c, line_c, src) = line_cogs(&db, &sale_id).await;
    assert_eq!(rate, BURGER_RATE_MC);
    assert_eq!(unit_c, unit_cents(BURGER_RATE_MC));
    assert_eq!(line_c, line_cents(BURGER_RATE_MC, 2));
    assert_eq!(src, "recipe");
    assert_eq!(recipe_stamp(&db, &sale_id).await, (v1, 1));
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
    // ...and still visible to a reader that filters the way the app does.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales WHERE id='{sale_id}' AND status='posted'"
        ))
        .await,
        1
    );

    // IMMUTABLE.
    for sql in [
        format!("UPDATE sales SET total_incl_vat_cents=1 WHERE id='{sale_id}'"),
        format!("UPDATE sales SET cogs_total_cents=1 WHERE id='{sale_id}'"),
        format!("DELETE FROM sales WHERE id='{sale_id}'"),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(e.contains("immutable") || e.contains("cannot be deleted"), "{e}");
    }
}

// ---- L: the void carve-out still works -----------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_void_carve_out_still_works_and_does_not_re_fire_finalization() {
    // Migration 001 permits `posted -> voided` with the id, the receipt
    // number, the total and `posted_at` unchanged. WP-B2-B ships no void
    // COMMAND — the columns are reserved — so this is the ENGINE contract
    // being preserved, not a workflow being exercised. It matters because a
    // rule written as "status may never leave 'posted'" would have broken the
    // one transition 001 deliberately allows.
    let db = kitchen().await;
    publish(&db, "r144", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    let payload = burger_sale(1);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();
    let posted_at = db
        .scalar_string(&format!("SELECT posted_at FROM sales WHERE id='{sale_id}'"))
        .await;

    db.exec(&format!(
        "UPDATE sales SET status='voided', voided_at='2026-11-02T10:00:00.000Z',
           voided_by_user_id='{USER_ID}'
          WHERE id='{sale_id}'"
    ))
    .await;
    assert_eq!(
        state_of(&db, &sale_id).await,
        ("voided".into(), posted_at.clone()),
        "a void preserves WHEN the sale happened"
    );
    // The evidence is untouched: finalization did not re-fire, and could not
    // have, because neither marker moved INTO the posted state.
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
    // And the voided sale leaves every read model that filters 'posted'.
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales WHERE id='{sale_id}' AND status='posted'"
        ))
        .await,
        0
    );
    // A voided sale cannot be un-voided back into a draft, nor re-posted with
    // a new time.
    let e = db
        .exec_err(&format!("UPDATE sales SET status='draft' WHERE id='{sale_id}'"))
        .await;
    assert!(
        e.contains("immutable")
            || e.contains("returned to a draft")
            || e.contains("cannot carry a posting time"),
        "{e}"
    );
}

// ---- J and K: the real command, and a failed one --------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_post_sale_still_posts_and_leaves_a_coherent_state() {
    // J. The whole point of the exercise: the legal transition is the one
    //    `post_sale` already issues — ONE statement setting both markers.
    let db = kitchen().await;
    publish(&db, "r145", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let payload = burger_sale(3);
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.expect("posts");

    let (status, posted_at) = state_of(&db, &sale_id).await;
    assert_eq!(status, "posted");
    assert_ne!(posted_at, "NULL", "and it carries its posting time");
    assert_eq!(result.receipt_number, 1);
    let (rate, unit_c, line_c, src) = line_cogs(&db, &sale_id).await;
    assert_eq!((rate, unit_c, line_c, src.as_str()),
               (BURGER_RATE_MC, unit_cents(BURGER_RATE_MC), line_cents(BURGER_RATE_MC, 3), "recipe"));
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'"
        ))
        .await,
        line_c
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sale_payments WHERE sale_id='{sale_id}'"
        ))
        .await,
        1
    );
    assert_eq!(evidence(&db, &sale_id).await.len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_finalization_leaves_no_posted_sale_and_no_consumed_receipt() {
    // K. The state rules are evaluated inside `post_sale`'s transaction, so a
    //    refusal must roll the whole thing back — no half-posted header, no
    //    orphan lines, no spent receipt number.
    let db = kitchen().await;
    publish(&db, "r146", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    let first = burger_sale(1);
    let first_id = first.sale_id.clone();
    post_sale_with_pool(db.pool(), first).await.unwrap();

    let before = (
        db.count("SELECT COUNT(*) FROM sales").await,
        db.count("SELECT COUNT(*) FROM sale_items").await,
        db.count("SELECT COUNT(*) FROM sale_payments").await,
        db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
        db.scalar_i64("SELECT MAX(receipt_number) FROM sales").await,
    );

    // An ingredient loses its cost basis AFTER publication — the one route to
    // this refusal, since `activate_recipe` will not publish a recipe it
    // cannot cost. The garnish is given a Manual Cost, the recipe is
    // published, and the Manual Cost is then taken away.
    seed_manual_cost(&db, P_UNPRICED, 40_000_000).await;
    let r2 = publish(
        &db,
        "r147",
        vec![component(P_BUN, 1, 1, "each"), component(P_UNPRICED, 1, 1, "each")],
    )
    .await;
    assert_eq!(recipe_status(&db, &r2).await, "active");
    db.exec(&format!(
        "UPDATE products SET costing_method='purchase_average',
           standard_cost_excl_vat_microcents=NULL
         WHERE id='{P_UNPRICED}'"
    ))
    .await;

    let doomed = burger_sale(1);
    let err = post_sale_with_pool(db.pool(), doomed).await.unwrap_err();
    assert!(err.contains("no cost on file"), "{err}");

    assert_eq!(
        (
            db.count("SELECT COUNT(*) FROM sales").await,
            db.count("SELECT COUNT(*) FROM sale_items").await,
            db.count("SELECT COUNT(*) FROM sale_payments").await,
            db.count("SELECT COUNT(*) FROM sale_item_recipe_costs").await,
            db.scalar_i64("SELECT MAX(receipt_number) FROM sales").await,
        ),
        before,
        "a refused sale leaves nothing behind and spends no receipt number"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sales WHERE status='posted' AND posted_at IS NULL").await,
        0,
        "and no row in the incoherent state this section exists to forbid"
    );
    // The earlier sale is untouched.
    assert_eq!(line_cogs(&db, &first_id).await.0, BURGER_RATE_MC);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refund_of_a_posted_sale_still_works_under_the_state_rules() {
    // L. `post_credit_memo` writes `sales_credit_memos`, a separate document
    //    family, and must not be disturbed by rules on `sales`. It reads the
    //    original sale and writes nothing to it, which is what this asserts.
    let db = kitchen().await;
    publish(&db, "r148", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;
    let payload = burger_sale(2);
    let sale_id = payload.sale_id.clone();
    let line_id = payload.lines[0].sale_item_id.clone();
    post_sale_with_pool(db.pool(), replay_of(&payload)).await.unwrap();
    let before = state_of(&db, &sale_id).await;

    let memo = credit_memo_payload(
        &sale_id,
        vec![return_line(&line_id).qty(1).restock(false).build()],
        vec![refund_cash_usd(1110)],
    );
    let memo_id = memo.credit_memo_id.clone();
    post_credit_memo_with_pool(db.pool(), memo)
        .await
        .expect("the refund posts");

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT status FROM sales_credit_memos WHERE id='{memo_id}'"
        ))
        .await,
        "posted"
    );
    assert_eq!(
        state_of(&db, &sale_id).await,
        before,
        "the original sale's own state is untouched by a refund"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(cogs_reversed_cents, 0) FROM sales_credit_memos WHERE id='{memo_id}'"
        ))
        .await,
        0,
        "and a prepared item still reverses revenue and not the food cost"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_sale_in_the_whole_suite_can_reach_the_incoherent_state() {
    // The invariant as a single assertion, stated against a database that has
    // been driven through the ordinary flows: posting, a replay, a refund and
    // a void. Nothing anywhere produces `status='posted'` with no timestamp,
    // nor a draft carrying one.
    let db = kitchen().await;
    publish(&db, "r149", four_ingredient_burger()).await;
    use_recipe_costing(&db).await;

    let a = burger_sale(1);
    let a_id = a.sale_id.clone();
    let a_line = a.lines[0].sale_item_id.clone();
    post_sale_with_pool(db.pool(), replay_of(&a)).await.unwrap();
    post_sale_with_pool(db.pool(), replay_of(&a)).await.unwrap(); // a replay
    let b = burger_sale(2);
    let b_id = b.sale_id.clone();
    post_sale_with_pool(db.pool(), b).await.unwrap();

    post_credit_memo_with_pool(
        db.pool(),
        credit_memo_payload(
            &a_id,
            vec![return_line(&a_line).qty(1).restock(false).build()],
            vec![refund_cash_usd(1110)],
        ),
    )
    .await
    .unwrap();
    db.exec(&format!(
        "UPDATE sales SET status='voided', voided_at='2026-11-03T10:00:00.000Z'
          WHERE id='{b_id}'"
    ))
    .await;

    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM sales
              WHERE (status = 'posted' AND posted_at IS NULL)
                 OR (status = 'draft'  AND posted_at IS NOT NULL)"
        )
        .await,
        0,
        "the posting-state invariant holds across every flow"
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 2);
}
