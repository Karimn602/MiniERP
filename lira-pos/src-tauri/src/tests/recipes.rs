//! Recipe definitions, versioning and cost arithmetic (WP-B2-A).
//!
//! The authority. `tests/unit/recipeCost.test.ts` asserts the same fixtures
//! against the TypeScript mirror, and `tests/integration/recipes.test.ts`
//! asserts the schema and the read models; everything about what the ENGINE
//! does lives here, against a real database through the real migration chain.
//!
//! What is deliberately NOT tested here, because WP-B2-A deliberately does not
//! do it: no sale is costed from a recipe, no product can be recipe-costed, no
//! ingredient stock moves. The last section asserts each of those as a
//! standing refusal rather than leaving them to be assumed.

use crate::recipe_cost::{
    fixture_component, recipe_cost, same_conversion, ComponentCostSource, ResolvedComponent,
    FIXTURES, MAX_COMPONENTS, MAX_RATE_MICROCENTS,
};
use crate::recipes::{
    activate_recipe_with_pool, retire_recipe_with_pool, save_recipe_draft_with_pool,
    ActivateRecipePayload, RecipeComponentInput, RetireRecipePayload, SaveRecipeDraftPayload,
};
use crate::test_support::*;

const P_BURGER: &str = "00000000-0000-0000-0000-00000000b100";
const P_BUN: &str = "00000000-0000-0000-0000-00000000b101";
const P_PATTY: &str = "00000000-0000-0000-0000-00000000b102";
const P_SAUCE: &str = "00000000-0000-0000-0000-00000000b103";

/// A kitchen that can be costed:
///
///   * Burger — a SERVICE, the thing the recipe makes.
///   * Bun    — stocked, base `each`, $0.22 each (22,000,000 mc), documented.
///   * Patty  — stocked, base `g`, $0.0085/g (850,000 mc), documented, and also
///              carries a `kg` unit so a fixture can state 0.15 kg.
///   * Sauce  — stocked, base `ml`, $0.0012/ml (120,000 mc), documented.
async fn kitchen() -> TempDb {
    let db = TempDb::new().await;
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
    // 1 kg = 1000 g, so a chef may state the patty in kilograms.
    seed_product_uom(&db, P_PATTY, "kg", 1_000, 1).await;
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

fn rid(tag: &str) -> String {
    format!("00000000-0000-0000-0000-{:0>12}", tag)
}

// ============================================================================
// 1. The arithmetic, against the fixtures the TypeScript mirror shares
// ============================================================================

#[test]
fn every_shared_fixture_costs_exactly_as_published() {
    // These same tuples and these same expected figures are transcribed into
    // `tests/unit/recipeCost.test.ts`. A mirror that is only tested against
    // itself is not a mirror.
    for f in FIXTURES {
        let components: Vec<ResolvedComponent> = f
            .components
            .iter()
            .enumerate()
            .map(|(i, t)| fixture_component(i, *t))
            .collect();
        let cost = recipe_cost(&components, f.yield_base)
            .unwrap_or_else(|e| panic!("fixture {} must cost: {e}", f.name));
        assert_eq!(
            cost.batch_microcents, f.expect_batch_microcents,
            "fixture {} batch",
            f.name
        );
        assert_eq!(
            cost.per_base_unit_microcents, f.expect_per_base_unit_microcents,
            "fixture {} per base unit",
            f.name
        );
    }
}

#[test]
fn naive_per_component_rounding_gives_a_different_answer() {
    // The reason the accumulator exists. Three pinches worth 0.4 microcents
    // each vanish entirely if every component is rounded to a whole microcent
    // before being summed; accumulated at ACC scale they are worth a microcent
    // between them. It is the shape of the GP-A03 defect, which is how
    // $0.0025/g flour came to cost $0.00.
    let f = FIXTURES
        .iter()
        .find(|f| f.name == "pinches_naive_rounding_loses")
        .expect("the rounding fixture");
    let components: Vec<ResolvedComponent> = f
        .components
        .iter()
        .enumerate()
        .map(|(i, t)| fixture_component(i, *t))
        .collect();
    let cost = recipe_cost(&components, f.yield_base).unwrap();

    let naive: i64 = cost
        .components
        .iter()
        .map(|c| c.contribution_microcents)
        .sum();

    assert_eq!(cost.batch_microcents, 22_000_001, "accumulated once");
    assert_eq!(naive, 22_000_000, "summing rounded components loses the pinches");
    assert_ne!(
        cost.batch_microcents, naive,
        "if these ever agree the fixture has stopped testing anything"
    );
}

#[test]
fn a_whole_quantity_recipe_rounds_nowhere_at_all() {
    // The common case is EXACT, not merely accurate: with waste 0 and both
    // denominators 1 the divisor is 10,000 and the numerator carries a factor
    // of ACC = 1,000,000, so every component division is exact.
    let components = vec![
        fixture_component(0, (22_000_000, 1, 1, 1, 1, 0)),
        fixture_component(1, (850_000, 150, 1, 1, 1, 0)),
    ];
    let cost = recipe_cost(&components, 1).unwrap();
    // 22,000,000 + 127,500,000, with no residue anywhere.
    assert_eq!(cost.batch_microcents, 149_500_000);
    let exact: i64 = cost
        .components
        .iter()
        .map(|c| c.contribution_microcents)
        .sum();
    assert_eq!(exact, cost.batch_microcents, "no rounding happened");
}

#[test]
fn a_sub_cent_ingredient_rate_survives_a_fractional_quantity() {
    // Flour at $2.50/kg stocked in grams is 2,500 microcents a gram. An eighth
    // of a kilo of it is 125 g and costs $0.3125 — not $0.00, which is what
    // rounding the rate to cents first would give.
    let components = vec![fixture_component(0, (250_000, 1, 8, 1_000, 1, 0))];
    let cost = recipe_cost(&components, 1).unwrap();
    assert_eq!(cost.per_base_unit_microcents, 31_250_000);
}

// ============================================================================
// 2. Numeric bounds and overflow
// ============================================================================

#[test]
fn a_rate_above_the_envelope_is_refused_by_name() {
    let mut c = fixture_component(0, (0, 1, 1, 1, 1, 0));
    c.unit_cost_excl_vat_microcents = MAX_RATE_MICROCENTS + 1;
    let err = recipe_cost(&[c], 1).expect_err("outside the proven range");
    assert!(
        err.contains("ingredient cost rate") && err.contains("supported limit"),
        "the refusal must name the field and the limit, got: {err}"
    );
}

#[test]
fn quantity_conversion_waste_and_yield_are_each_bounded() {
    for (label, mutate) in [
        ("quantity numerator", 0usize),
        ("quantity denominator", 1),
        ("conversion numerator", 2),
        ("conversion denominator", 3),
    ] {
        let mut c = fixture_component(0, (1_000, 1, 1, 1, 1, 0));
        match mutate {
            0 => c.quantity_num = 1_000_001,
            1 => c.quantity_den = 1_000_001,
            2 => c.factor_num = 1_000_001,
            _ => c.factor_den = 1_000_001,
        }
        let err = recipe_cost(&[c], 1).expect_err(label);
        assert!(err.contains("supported limit"), "{label}: {err}");
    }
    // Waste at or above 100% is refused; 9,999 bps is the last legal value.
    let mut w = fixture_component(0, (1_000, 1, 1, 1, 1, 0));
    w.waste_bps = 10_000;
    assert!(recipe_cost(&[w], 1).is_err());

    let yield_err = recipe_cost(&[fixture_component(0, (1_000, 1, 1, 1, 1, 0))], 1_000_001)
        .expect_err("yield above the envelope");
    assert!(yield_err.contains("batch yield"), "{yield_err}");
}

#[test]
fn the_worst_admissible_recipe_does_not_overflow() {
    // The overflow proof, executed. Sixty-four components, every one at the
    // maximum rate, the maximum quantity numerator, the maximum conversion
    // numerator and the maximum waste — the exact corner the module header
    // computes as 2 x 10^35 against i128::MAX of 1.7 x 10^38.
    //
    // The RESULT legitimately exceeds i64, so what this proves is that the
    // arithmetic reaches a checked conversion and refuses by name rather than
    // wrapping into a plausible small number.
    let components: Vec<ResolvedComponent> = (0..MAX_COMPONENTS)
        .map(|i| {
            let mut c = fixture_component(i, (MAX_RATE_MICROCENTS, 1_000_000, 1, 1_000_000, 1, 9_999));
            c.cost_source = ComponentCostSource::PurchaseAverage;
            c
        })
        .collect();
    let err = recipe_cost(&components, 1).expect_err("does not fit i64");
    assert!(
        err.contains("does not fit"),
        "an unrepresentable cost must be refused, not wrapped: {err}"
    );
}

#[test]
fn a_recipe_with_too_many_ingredients_is_refused() {
    let components: Vec<ResolvedComponent> = (0..MAX_COMPONENTS + 1)
        .map(|i| fixture_component(i, (1_000, 1, 1, 1, 1, 0)))
        .collect();
    let err = recipe_cost(&components, 1).expect_err("above the cap");
    assert!(err.contains("at most 64"), "{err}");
}

#[test]
fn an_empty_recipe_is_refused() {
    assert!(recipe_cost(&[], 1).is_err());
}

// ============================================================================
// 3. Draft persistence and versioning
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_persists_its_components_and_reports_the_cost() {
    let db = kitchen().await;
    let r = rid("d001");

    let result = save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![
                component(P_BUN, 1, 1, "each"),
                component(P_PATTY, 150, 1, "g"),
                component(P_SAUCE, 25, 1, "ml"),
            ],
        ),
    )
    .await
    .expect("a complete draft saves");

    assert_eq!(result.version, 1, "the first version of this product");
    assert_eq!(recipe_status(&db, &r).await, "draft");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipe_components WHERE recipe_id = '{r}'"
        ))
        .await,
        3
    );
    // $0.22 + 150 x $0.0085 + 25 x $0.0012 = 152,500,000 microcents = $1.525.
    assert_eq!(result.per_base_unit_microcents, Some(152_500_000));
    assert_eq!(result.batch_microcents, Some(152_500_000));
    assert!(result.uncosted_components.is_empty());
    // A draft is not published, so both lifecycle timestamps are empty.
    assert_eq!(recipe_timestamps(&db, &r).await, (None, None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resaving_a_draft_replaces_its_lines_rather_than_adding_to_them() {
    let db = kitchen().await;
    let r = rid("d002");

    save_recipe_draft_with_pool(db.pool(), draft(&r, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .unwrap();
    let again = save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 2, 1, "each"), component(P_SAUCE, 10, 1, "ml")],
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipe_components WHERE recipe_id = '{r}'"
        ))
        .await,
        2,
        "replaced, not appended"
    );
    assert_eq!(again.version, 1, "re-saving a draft does not consume a version");
    // 2 x 22,000,000 + 10 x 120,000 = 45,200,000 = $0.452.
    assert_eq!(again.per_base_unit_microcents, Some(45_200_000));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quantity_is_stored_in_reduced_form_whatever_the_client_sent() {
    // 2/4 and 1/2 are one recipe. Reducing in the command rather than trusting
    // the client is what makes two screens produce one row.
    let db = kitchen().await;
    let r = rid("d003");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_BUN, 2, 4, "each")]),
    )
    .await
    .unwrap();

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity_num FROM recipe_components WHERE recipe_id = '{r}'"
        ))
        .await,
        1
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity_den FROM recipe_components WHERE recipe_id = '{r}'"
        ))
        .await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn editing_an_active_recipe_creates_the_next_version_as_a_draft() {
    let db = kitchen().await;
    let v1 = rid("d010");
    save_recipe_draft_with_pool(db.pool(), draft(&v1, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .unwrap();
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v1.clone(),
        },
    )
    .await
    .unwrap();

    let v2 = rid("d011");
    let saved = save_recipe_draft_with_pool(
        db.pool(),
        draft(&v2, vec![component(P_BUN, 2, 1, "each")]),
    )
    .await
    .expect("a new draft beside an active version");

    assert_eq!(saved.version, 2);
    assert_eq!(recipe_status(&db, &v1).await, "active", "v1 still publishes");
    assert_eq!(recipe_status(&db, &v2).await, "draft");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_draft_per_product_at_a_time() {
    let db = kitchen().await;
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("d020"), vec![component(P_BUN, 1, 1, "each")]),
    )
    .await
    .unwrap();

    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("d021"), vec![component(P_BUN, 1, 1, "each")]),
    )
    .await
    .expect_err("a second rival draft");
    assert!(err.contains("unpublished draft"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_version_number_is_never_reused() {
    let db = kitchen().await;
    let v1 = rid("d030");
    save_recipe_draft_with_pool(db.pool(), draft(&v1, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .unwrap();
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v1.clone(),
        },
    )
    .await
    .unwrap();
    retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v1,
        },
    )
    .await
    .unwrap();

    let next = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("d031"), vec![component(P_BUN, 1, 1, "each")]),
    )
    .await
    .unwrap();
    assert_eq!(next.version, 2, "MAX(version) + 1, never a gap filled in");
}

// ============================================================================
// 4. Lifecycle transitions, legal and illegal
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activation_publishes_and_stamps_the_time() {
    let db = kitchen().await;
    let r = rid("a001");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 1, 1, "each"), component(P_PATTY, 150, 1, "g")],
        ),
    )
    .await
    .unwrap();

    let result = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect("a complete draft publishes");

    assert_eq!(result.version, 1);
    assert_eq!(result.retired_recipe_id, None);
    assert_eq!(result.per_base_unit_microcents, 149_500_000);
    assert_eq!(recipe_status(&db, &r).await, "active");
    let (activated, retired) = recipe_timestamps(&db, &r).await;
    assert!(activated.is_some(), "active carries its activation time");
    assert_eq!(retired, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activating_v2_retires_v1_in_one_transaction_and_keeps_its_history() {
    let db = kitchen().await;
    let v1 = rid("a010");
    let v2 = rid("a011");
    save_recipe_draft_with_pool(db.pool(), draft(&v1, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .unwrap();
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v1.clone(),
        },
    )
    .await
    .unwrap();
    let (v1_activated, _) = recipe_timestamps(&db, &v1).await;

    save_recipe_draft_with_pool(db.pool(), draft(&v2, vec![component(P_BUN, 2, 1, "each")]))
        .await
        .unwrap();
    let result = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v2.clone(),
        },
    )
    .await
    .unwrap();

    assert_eq!(result.retired_recipe_id, Some(v1.clone()));
    assert_eq!(recipe_status(&db, &v1).await, "retired");
    assert_eq!(recipe_status(&db, &v2).await, "active");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipes WHERE product_id = '{P_BURGER}' AND status = 'active'"
        ))
        .await,
        1,
        "never two active, never none"
    );

    // RETIREMENT PRESERVES ACTIVATION HISTORY: the retired version still says
    // when it became authoritative, as well as when it stopped.
    let (still_activated, now_retired) = recipe_timestamps(&db, &v1).await;
    assert_eq!(still_activated, v1_activated, "its activation is not erased");
    assert!(now_retired.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_illegal_transitions_are_each_refused_by_the_engine() {
    let db = kitchen().await;
    let r = rid("a020");
    save_recipe_draft_with_pool(db.pool(), draft(&r, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .unwrap();

    // draft -> retired: nothing was ever published.
    let e = db
        .exec_err(&format!(
            "UPDATE recipes SET status='retired', retired_at='2026-10-26T00:00:00.000Z' WHERE id='{r}'"
        ))
        .await;
    assert!(e.contains("never activated"), "{e}");

    // retire_recipe refuses it too, with its own sentence.
    let err = retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("a draft cannot be retired");
    assert!(err.contains("Only the active"), "{err}");

    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap();

    // active -> draft: a published version does not come back.
    let e = db
        .exec_err(&format!(
            "UPDATE recipes SET status='draft', activated_at=NULL WHERE id='{r}'"
        ))
        .await;
    assert!(e.contains("cannot return to draft"), "{e}");

    // An activation timestamp is written once.
    let e = db
        .exec_err(&format!(
            "UPDATE recipes SET activated_at='2020-01-01T00:00:00.000Z' WHERE id='{r}'"
        ))
        .await;
    assert!(e.contains("written once"), "{e}");

    // Activating something already published, and re-activating a retired one.
    let again = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("already published");
    assert!(again.contains("already been published"), "{again}");

    retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap();
    let revive = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("a retired version does not come back");
    assert!(revive.contains("cannot be activated again"), "{revive}");

    // retired -> anything, at the SQL level.
    let e = db
        .exec_err(&format!("UPDATE recipes SET status='active' WHERE id='{r}'"))
        .await;
    assert!(e.contains("cannot be activated again"), "{e}");
}

// ============================================================================
// 5. A published recipe is immutable
// ============================================================================

async fn an_active_recipe(db: &TempDb, tag: &str) -> String {
    let r = rid(tag);
    save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 1, 1, "each"), component(P_PATTY, 150, 1, "g")],
        ),
    )
    .await
    .unwrap();
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap();
    r
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_published_recipes_contents_cannot_be_edited() {
    // The yield, the notes and the creation time are part of what was
    // published: the note explaining why a plate is built this way is as much
    // a part of the document as the quantities, and a creation time that can
    // be moved is not a creation time.
    let db = kitchen().await;
    let r = an_active_recipe(&db, "i001").await;
    for sql in [
        format!("UPDATE recipes SET yield_quantity_base = 20 WHERE id='{r}'"),
        format!("UPDATE recipes SET notes = 'rewritten' WHERE id='{r}'"),
        format!("UPDATE recipes SET created_at = '2020-01-01T00:00:00.000Z' WHERE id='{r}'"),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(e.contains("part of what was published"), "{sql} -> {e}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_published_recipes_lines_are_frozen() {
    let db = kitchen().await;
    let r = an_active_recipe(&db, "i010").await;

    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET quantity_num = 999 WHERE recipe_id='{r}'"
        ))
        .await;
    assert!(e.contains("frozen"), "{e}");

    let e = db
        .exec_err(&format!("DELETE FROM recipe_components WHERE recipe_id='{r}'"))
        .await;
    assert!(e.contains("cannot be removed"), "{e}");

    // INSERT is guarded too: adding a child to a published document edits no
    // existing row, so it would slip past an update guard.
    let e = db
        .exec_err(&format!(
            "INSERT INTO recipe_components
               (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
                uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot)
             SELECT 'sneak', '{r}', '{STORE_ID}', '{P_SAUCE}', 1, 1, 'ml', u.id, 1, 1
               FROM product_uoms u WHERE u.product_id='{P_SAUCE}' AND u.uom_code='ml'"
        ))
        .await;
    assert!(e.contains("takes no new ingredient"), "{e}");

    // And the saving command refuses it with a sentence rather than a trigger.
    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_BUN, 5, 1, "each")]),
    )
    .await
    .expect_err("a published version is not edited");
    assert!(err.contains("Published versions are never edited"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_published_recipe_is_never_deleted_and_a_draft_may_be() {
    let db = kitchen().await;
    let r = an_active_recipe(&db, "i020").await;
    let e = db.exec_err(&format!("DELETE FROM recipes WHERE id='{r}'")).await;
    assert!(e.contains("never deleted"), "{e}");

    let d = rid("i021");
    save_recipe_draft_with_pool(db.pool(), {
        let mut p = draft(&d, vec![component(P_SAUCE, 1, 1, "ml")]);
        p.product_id = P_BUN.to_string();
        p
    })
    .await
    .expect_err("bun is an ingredient of an active recipe, so it cannot have one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_published_recipes_lines_cannot_be_reparented_into_or_out_of_it() {
    // `recipe_id` is an ordinary updatable column. A one-sided check on the OLD
    // parent would let a line be moved out of a draft and into something
    // published — migration 012's lesson.
    let db = kitchen().await;
    let active = an_active_recipe(&db, "i030").await;
    let dr = rid("i031");
    save_recipe_draft_with_pool(db.pool(), draft(&dr, vec![component(P_SAUCE, 1, 1, "ml")]))
        .await
        .unwrap();

    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET recipe_id='{active}' WHERE recipe_id='{dr}'"
        ))
        .await;
    assert!(
        e.contains("stays with the recipe") || e.contains("frozen"),
        "moving a line INTO a published recipe: {e}"
    );

    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET recipe_id='{dr}' WHERE recipe_id='{active}'"
        ))
        .await;
    assert!(
        e.contains("stays with the recipe") || e.contains("frozen"),
        "moving a line OUT of one: {e}"
    );

}

// ============================================================================
// 6. The conversion snapshot — an edited factor does not restate a recipe
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edited_uom_factor_does_not_change_a_published_recipes_quantities() {
    // THE reason `factor_*_snapshot` exists. `catalog.rs::save_product_tx` runs
    // `UPDATE product_uoms SET factor_num = ?, factor_den = ?` whenever a
    // product's selling unit is edited, so a shop changing "1 kg = 1000 g" to
    // "1 kg = 1200 g" would otherwise silently restate the physical quantity
    // and the cost of every published recipe that said "kg".
    let db = kitchen().await;
    let r = rid("s001");
    save_recipe_draft_with_pool(
        db.pool(),
        // 0.15 kg of patty: 1/1000 kg x 150 ... stated as 15/100 kg, reduced.
        draft(&r, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();
    let activated = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap();
    // 0.15 kg = 150 g at 850,000 mc/g = 127,500,000 mc = $1.275.
    assert_eq!(activated.per_base_unit_microcents, 127_500_000);

    // The shop now redefines what a kilo means for this product.
    db.exec(&format!(
        "UPDATE product_uoms SET factor_num = 1200 WHERE product_id='{P_PATTY}' AND uom_code='kg'"
    ))
    .await;

    // The published recipe's own conversion is untouched.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        1_000,
        "the snapshot is the recipe's own"
    );
    // And re-activating is impossible, so nothing can recompute it either.
    assert_eq!(recipe_status(&db, &r).await, "active");

    // A NEW draft picks up the new factor — forward-only, like every other
    // cost input here.
    let v2 = rid("s002");
    let saved = save_recipe_draft_with_pool(
        db.pool(),
        draft(&v2, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM recipe_components WHERE recipe_id='{v2}'"
        ))
        .await,
        1_200
    );
    // 0.15 x 1200 = 180 g at 850,000 = 153,000,000 = $1.53.
    assert_eq!(saved.per_base_unit_microcents, Some(153_000_000));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_component_cannot_declare_a_conversion_the_product_does_not_have() {
    // The database decides the conversion (GP-A02), enforced in SQL as well as
    // in the command: a row written by any other path is refused too.
    let db = kitchen().await;
    let r = rid("s010");
    save_recipe_draft_with_pool(db.pool(), draft(&r, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .unwrap();

    let e = db
        .exec_err(&format!(
            "INSERT INTO recipe_components
               (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
                uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot)
             SELECT 'liar', '{r}', '{STORE_ID}', '{P_SAUCE}', 1, 1, 'ml', u.id, 77, 1
               FROM product_uoms u WHERE u.product_id='{P_SAUCE}' AND u.uom_code='ml'"
        ))
        .await;
    assert!(e.contains("must be that unit"), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_unit_the_ingredient_does_not_have_is_refused() {
    let db = kitchen().await;
    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("s020"), vec![component(P_BUN, 1, 1, "kg")]),
    )
    .await
    .expect_err("a bun has no kilogram unit");
    assert!(err.contains("no active unit"), "{err}");
}

// ============================================================================
// 7. Documented zero versus uncosted
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_documented_free_ingredient_contributes_zero_and_publishes() {
    // A supplier sample received at a stated cost of nothing. The zero is an
    // ANSWER, and WP-B1's P1-A predicate is what says so.
    let db = kitchen().await;
    let free = "00000000-0000-0000-0000-00000000b1f0";
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 50,
            ..ProductSpec::stocked(free, "SKU-FREE", "Promo napkin")
        },
    )
    .await;
    seed_purchase_movement(&db, free, 0).await;

    let r = rid("z001");
    let saved = save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 1, 1, "each"), component(free, 3, 1, "each")],
        ),
    )
    .await
    .unwrap();
    assert!(saved.uncosted_components.is_empty());
    assert_eq!(saved.per_base_unit_microcents, Some(22_000_000));

    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r,
        },
    )
    .await
    .expect("a documented zero does not block publication");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undocumented_zero_is_reported_as_uncosted_and_blocks_activation() {
    // MISSING EVIDENCE IS NOT A LEGITIMATE ZERO. The draft still SAVES, so the
    // owner can build the recipe and see what is missing; it cannot PUBLISH.
    let db = kitchen().await;
    let unknown = "00000000-0000-0000-0000-00000000b1f1";
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 50,
            ..ProductSpec::stocked(unknown, "SKU-UNK", "Mystery pickle")
        },
    )
    .await;

    let r = rid("z010");
    let saved = save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 1, 1, "each"), component(unknown, 2, 1, "each")],
        ),
    )
    .await
    .expect("an incomplete draft still saves");

    assert_eq!(saved.uncosted_components, vec!["Mystery pickle".to_string()]);
    assert_eq!(
        saved.per_base_unit_microcents, None,
        "a cost that cannot be computed is ABSENT, never zero"
    );
    assert_eq!(saved.batch_microcents, None);

    let err = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("an uncostable recipe does not publish");
    assert!(err.contains("Mystery pickle"), "names the ingredient: {err}");
    assert!(err.contains("purchase or an opening"), "{err}");
    assert_eq!(recipe_status(&db, &r).await, "draft", "and nothing changed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_costed_non_stock_ingredient_is_honoured() {
    // The supported way to state a cost for something that is not counted.
    // Reusing WP-B1 is why no recipe-level override column exists.
    let db = kitchen().await;
    let spice = "00000000-0000-0000-0000-00000000b1f2";
    seed_product(
        &db,
        &ProductSpec {
            is_service: true,
            ..ProductSpec::stocked(spice, "SKU-SPICE", "House spice blend")
        },
    )
    .await;
    seed_manual_cost(&db, spice, 4_500_000).await;

    let saved = save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &rid("z020"),
            vec![component(P_BUN, 1, 1, "each"), component(spice, 2, 1, "each")],
        ),
    )
    .await
    .unwrap();
    assert_eq!(saved.per_base_unit_microcents, Some(22_000_000 + 9_000_000));
    assert!(saved
        .components
        .iter()
        .any(|c| c.cost_source == "standard" && c.contribution_microcents == 9_000_000));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_nonzero_average_needs_no_document() {
    // The average IS the valuation; the probe only runs on a zero pair.
    let db = kitchen().await;
    let bought = "00000000-0000-0000-0000-00000000b1f3";
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 10,
            ..ProductSpec::stocked(bought, "SKU-BGT", "Imported cheese")
        },
    )
    .await;
    seed_product_avg_cost_microcents(&db, bought, 31_000_000, 34_410_000).await;
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE product_id='{bought}'"
        ))
        .await,
        0
    );

    let saved = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("z030"), vec![component(bought, 1, 2, "each")]),
    )
    .await
    .unwrap();
    assert_eq!(saved.per_base_unit_microcents, Some(15_500_000));
}

// ============================================================================
// 8. Cross-store, eligibility and one level of composition
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ingredient_from_another_store_is_refused() {
    let db = kitchen().await;
    db.exec(
        "INSERT INTO stores (id, name, default_currency) VALUES ('store-other', 'Branch 2', 'USD')",
    )
    .await;
    let foreign = "00000000-0000-0000-0000-00000000b1e0";
    db.exec(&format!(
        "INSERT INTO products
           (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
            price_excl_vat_cents, price_incl_vat_cents, avg_cost_excl_vat_microcents)
         VALUES ('{foreign}', 'store-other', 'SKU-FOREIGN', 'Other branch bun',
                 '{VAT_STD_ID}', 'inclusive', 100, 111, 200000)"
    ))
    .await;

    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("x001"), vec![component(foreign, 1, 1, "each")]),
    )
    .await
    .expect_err("another branch's ingredient");
    assert!(err.contains("does not exist in this store"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_inactive_ingredient_is_refused() {
    let db = kitchen().await;
    db.exec(&format!("UPDATE products SET is_active = 0 WHERE id = '{P_SAUCE}'"))
        .await;
    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("x010"), vec![component(P_SAUCE, 1, 1, "ml")]),
    )
    .await
    .expect_err("an inactive ingredient");
    assert!(err.contains("not active"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recipe_cannot_contain_the_product_it_makes() {
    let db = kitchen().await;
    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("x020"), vec![component(P_BURGER, 1, 1, "each")]),
    )
    .await
    .expect_err("self-reference");
    assert!(err.contains("cannot contain the product it makes"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_ingredient_cannot_be_listed_twice() {
    let db = kitchen().await;
    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &rid("x030"),
            vec![component(P_BUN, 1, 1, "each"), component(P_BUN, 2, 1, "each")],
        ),
    )
    .await
    .expect_err("two lines of bun");
    assert!(err.contains("listed twice"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_level_of_composition_in_both_directions() {
    // A cycle is INEXPRESSIBLE rather than detectable: with one level there is
    // no recursive walk to write and no depth limit to choose.
    let db = kitchen().await;

    // (a) An ingredient that owns a recipe cannot be used as an ingredient.
    let sub = rid("x041");
    save_recipe_draft_with_pool(db.pool(), {
        let mut p = draft(&sub, vec![component(P_SAUCE, 10, 1, "ml")]);
        p.product_id = P_PATTY.to_string();
        p
    })
    .await
    .unwrap();
    let err = save_recipe_draft_with_pool(
        db.pool(),
        draft(&rid("x042"), vec![component(P_PATTY, 150, 1, "g")]),
    )
    .await
    .expect_err("the patty now has a recipe of its own");
    assert!(err.contains("one level of composition"), "{err}");

    // (b) And the reverse order: a product already used as an ingredient
    //     cannot acquire a recipe.
    let db2 = kitchen().await;
    save_recipe_draft_with_pool(
        db2.pool(),
        draft(&rid("x050"), vec![component(P_BUN, 1, 1, "each")]),
    )
    .await
    .unwrap();
    let err = save_recipe_draft_with_pool(db2.pool(), {
        let mut p = draft(&rid("x051"), vec![component(P_SAUCE, 1, 1, "ml")]);
        p.product_id = P_BUN.to_string();
        p
    })
    .await
    .expect_err("the bun is already an ingredient");
    assert!(err.contains("one level of composition") || err.contains("ingredient of another"), "{err}");
}

// ============================================================================
// 9. Atomicity and rollback
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_whose_last_ingredient_is_bad_writes_nothing_at_all() {
    // Nothing is written until every line is resolved — the WP-07 discipline.
    // A first save that fails must leave no header behind, or the one-draft
    // index would then refuse the corrected attempt.
    let db = kitchen().await;
    let r = rid("t001");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 1, 1, "each"), component(P_SAUCE, 1, 1, "kg")],
        ),
    )
    .await
    .expect_err("sauce has no kilogram unit");

    assert_eq!(db.count("SELECT COUNT(*) FROM recipes").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM recipe_components").await, 0);

    // And the corrected attempt under the same identity succeeds.
    save_recipe_draft_with_pool(
        db.pool(),
        draft(
            &r,
            vec![component(P_BUN, 1, 1, "each"), component(P_SAUCE, 1, 1, "ml")],
        ),
    )
    .await
    .expect("the retry lands");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_activation_leaves_the_incumbent_publishing() {
    // Retirement and activation are one transaction. A failed activation must
    // not leave the product with no active recipe.
    let db = kitchen().await;
    let v1 = an_active_recipe(&db, "t010").await;

    let unknown = "00000000-0000-0000-0000-00000000b1f9";
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 5,
            ..ProductSpec::stocked(unknown, "SKU-UNK2", "Unpriced relish")
        },
    )
    .await;
    let v2 = rid("t011");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&v2, vec![component(unknown, 1, 1, "each")]),
    )
    .await
    .unwrap();

    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v2.clone(),
        },
    )
    .await
    .expect_err("incomplete");

    assert_eq!(recipe_status(&db, &v1).await, "active", "v1 still publishes");
    assert_eq!(recipe_status(&db, &v2).await, "draft");
    let (_, retired) = recipe_timestamps(&db, &v1).await;
    assert_eq!(retired, None, "and was never momentarily retired");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ingredient_deactivated_after_the_draft_was_saved_blocks_activation() {
    // The draft's physical quantities are its own, but the RATE and the
    // ingredient's eligibility are re-read at activation.
    let db = kitchen().await;
    let r = rid("t020");
    save_recipe_draft_with_pool(db.pool(), draft(&r, vec![component(P_SAUCE, 10, 1, "ml")]))
        .await
        .unwrap();
    db.exec(&format!("UPDATE products SET is_active = 0 WHERE id='{P_SAUCE}'"))
        .await;

    let err = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("an inactive ingredient");
    assert!(err.contains("not active"), "{err}");
    assert_eq!(recipe_status(&db, &r).await, "draft");
}

// ============================================================================
// 10. The WP-B2-A boundary, asserted rather than assumed
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_published_recipe_is_what_makes_recipe_costing_selectable() {
    // WP-B2-B. 020's blanket refusal became a conditional one, and the
    // condition is the thing this file exists to produce: a PUBLISHED recipe
    // for that product in that store. With one, the method is accepted.
    let db = kitchen().await;
    an_active_recipe(&db, "b001").await;

    db.exec(&format!(
        "UPDATE products SET costing_method='recipe' WHERE id='{P_BURGER}'"
    ))
    .await;
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT costing_method FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        "recipe"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recipe_costing_is_refused_without_a_published_recipe() {
    // The other side of the same rule: a product with NO recipe cannot select
    // the method, because `post_sale` would have nothing to cost it from and
    // would stop in front of a customer for a configuration mistake made days
    // earlier. A DRAFT is not a publication and does not satisfy it either.
    let db = kitchen().await;

    let e = db
        .exec_err(&format!(
            "UPDATE products SET costing_method='recipe' WHERE id='{P_BURGER}'"
        ))
        .await;
    assert!(e.contains("published recipe"), "{e}");
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT costing_method FROM products WHERE id='{P_BURGER}'"
        ))
        .await,
        "purchase_average"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authoring_a_recipe_moves_no_stock_and_writes_no_movement() {
    // Asserted, not assumed. WP-B2-A consumes nothing: ingredient consumption
    // is WP-B3 and arrives with its own command and its own movement rows.
    let db = kitchen().await;
    let before = db.count("SELECT COUNT(*) FROM inventory_movements").await;
    let bun_qty = quantity_on_hand(&db, P_BUN).await;
    let patty_qty = quantity_on_hand(&db, P_PATTY).await;

    an_active_recipe(&db, "b010").await;

    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements").await,
        before,
        "no movement row"
    );
    assert_eq!(quantity_on_hand(&db, P_BUN).await, bun_qty);
    assert_eq!(quantity_on_hand(&db, P_PATTY).await, patty_qty);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authoring_a_recipe_does_not_touch_an_ingredients_cost_pool() {
    let db = kitchen().await;
    let before = db
        .scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_PATTY}'"
        ))
        .await;
    an_active_recipe(&db, "b020").await;
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_PATTY}'"
        ))
        .await,
        before
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retiring_is_blocked_while_the_item_is_recipe_costed() {
    // Unreachable today, because nothing can be recipe-costed. Written now
    // because the command it protects is written now: a guard added later is a
    // guard that was missing. The method is forced in past 020's trigger with
    // the trigger temporarily dropped, which is the only way to reach the
    // state WP-B2-B will make ordinary.
    let db = kitchen().await;
    let r = an_active_recipe(&db, "b030").await;

    db.exec("DROP TRIGGER trg_products_costing_coherence_upd").await;
    db.exec(&format!(
        "UPDATE products SET costing_method='recipe' WHERE id='{P_BURGER}'"
    ))
    .await;

    let err = retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r,
        },
    )
    .await
    .expect_err("the item would be left with no cost");
    assert!(err.contains("costed from its recipe"), "{err}");
}

// ============================================================================
// 11. DIRECT-SQL ATTACKS (GZ-B2A-P1-A and GZ-B2A-P1-B)
//
// Every test in this section bypasses the commands entirely and writes SQL,
// because that is the whole finding: the first version of migration 021 put
// its coherence rules on INSERT only and its header-identity rules behind
// `status <> 'draft'`, and both of those describe what the SAVE COMMAND does
// rather than what the DATABASE allows. `post_sale` is also reached by a
// replayed payload, a future screen, an import, a script and a second
// terminal, and a recipe is no different: the shape a table accepts is the
// shape it holds.
// ============================================================================

/// A draft with one bun, by the real command, ready to be attacked.
async fn draft_with_a_bun(db: &TempDb, tag: &str) -> String {
    let r = rid(tag);
    save_recipe_draft_with_pool(db.pool(), draft(&r, vec![component(P_BUN, 1, 1, "each")]))
        .await
        .expect("a valid draft");
    r
}

// ---------------------------------------------------------------------------
// P1-A: a DRAFT component cannot be made incoherent by direct UPDATE
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_conversion_snapshot_cannot_be_inflated_by_direct_update() {
    // THE P1-A FAILURE SCENARIO, exactly as reported: a valid draft component
    // with `factor_num_snapshot = 1` updated to 1,000,000, after which
    // activation publishes a cost a million times too high.
    let db = kitchen().await;
    let r = draft_with_a_bun(&db, "p1a01").await;

    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET factor_num_snapshot = 1000000 WHERE recipe_id = '{r}'"
        ))
        .await;
    assert!(
        e.contains("must be that unit"),
        "the snapshot must stay the unit's own: {e}"
    );

    // Unchanged, and the recipe still publishes at its honest cost.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM recipe_components WHERE recipe_id = '{r}'"
        ))
        .await,
        1
    );
    let published = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r,
        },
    )
    .await
    .unwrap();
    assert_eq!(published.per_base_unit_microcents, 22_000_000, "$0.22, not $220,000");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_component_coherence_rule_now_holds_on_UPDATE_too() {
    // The same six rules the INSERT trigger applies, each attacked by UPDATE
    // on a legitimately-editable DRAFT line.
    let db = kitchen().await;
    let r = draft_with_a_bun(&db, "p1a02").await;

    // (e) the factor pair, both parts, and the unit row it names
    for sql in [
        format!("UPDATE recipe_components SET factor_den_snapshot = 7 WHERE recipe_id='{r}'"),
        format!(
            "UPDATE recipe_components SET product_uom_id_snapshot =
               (SELECT id FROM product_uoms WHERE product_id='{P_SAUCE}' AND uom_code='ml')
             WHERE recipe_id='{r}'"
        ),
        // Pointing at a unit of the RIGHT product but naming a different code.
        format!("UPDATE recipe_components SET uom_code = 'kg' WHERE recipe_id='{r}'"),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(e.contains("must be that unit"), "{sql} -> {e}");
    }

    // (a) the component's store
    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET store_id = 'store-other' WHERE recipe_id='{r}'"
        ))
        .await;
    assert!(e.contains("belong to one store") || e.contains("FOREIGN KEY"), "{e}");

    // (b) self-reference: swap the ingredient for the product being made
    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET component_product_id = '{P_BURGER}' WHERE recipe_id='{r}'"
        ))
        .await;
    assert!(e.contains("cannot contain the product it makes"), "{e}");

    // (d) an inactive ingredient
    db.exec(&format!("UPDATE products SET is_active = 0 WHERE id='{P_SAUCE}'"))
        .await;
    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components
                SET component_product_id = '{P_SAUCE}',
                    uom_code = 'ml',
                    product_uom_id_snapshot =
                      (SELECT id FROM product_uoms WHERE product_id='{P_SAUCE}' AND uom_code='ml')
              WHERE recipe_id='{r}'"
        ))
        .await;
    assert!(e.contains("inactive product"), "{e}");
    db.exec(&format!("UPDATE products SET is_active = 1 WHERE id='{P_SAUCE}'"))
        .await;

    // (f) the numeric bounds, which are the table's CHECKs and apply to an
    //     UPDATE exactly as to an INSERT
    for sql in [
        format!("UPDATE recipe_components SET quantity_num = 0 WHERE recipe_id='{r}'"),
        format!("UPDATE recipe_components SET quantity_den = 0 WHERE recipe_id='{r}'"),
        format!("UPDATE recipe_components SET quantity_num = 1000001 WHERE recipe_id='{r}'"),
        format!("UPDATE recipe_components SET waste_bps = 10000 WHERE recipe_id='{r}'"),
        format!("UPDATE recipe_components SET waste_bps = -1 WHERE recipe_id='{r}'"),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(e.contains("CHECK constraint failed"), "{sql} -> {e}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_level_of_composition_holds_on_UPDATE_too() {
    // Swapping a draft line's ingredient for one that owns a recipe of its own.
    let db = kitchen().await;
    let r = draft_with_a_bun(&db, "p1a03").await;
    let sub = rid("p1a04");
    save_recipe_draft_with_pool(db.pool(), {
        let mut p = draft(&sub, vec![component(P_SAUCE, 10, 1, "ml")]);
        p.product_id = P_PATTY.to_string();
        p
    })
    .await
    .unwrap();

    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components
                SET component_product_id = '{P_PATTY}',
                    uom_code = 'g',
                    product_uom_id_snapshot =
                      (SELECT id FROM product_uoms WHERE product_id='{P_PATTY}' AND uom_code='g')
              WHERE recipe_id='{r}'"
        ))
        .await;
    assert!(e.contains("one level of composition"), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_legitimate_draft_edit_still_works() {
    // The guards must not cost the owner the ability to edit a draft, which is
    // the whole point of a draft. Every column a chef would change, changed by
    // direct SQL, coherently.
    let db = kitchen().await;
    let r = draft_with_a_bun(&db, "p1a05").await;

    db.exec(&format!(
        "UPDATE recipe_components SET quantity_num = 3, quantity_den = 2, waste_bps = 250
          WHERE recipe_id='{r}'"
    ))
    .await;
    db.exec(&format!(
        "UPDATE recipe_components
            SET component_product_id = '{P_PATTY}',
                uom_code = 'kg',
                product_uom_id_snapshot =
                  (SELECT id FROM product_uoms WHERE product_id='{P_PATTY}' AND uom_code='kg'),
                factor_num_snapshot = 1000,
                factor_den_snapshot = 1
          WHERE recipe_id='{r}'"
    ))
    .await;
    db.exec(&format!(
        "UPDATE recipes SET yield_quantity_base = 4, notes = 'half a kilo-ish' WHERE id='{r}'"
    ))
    .await;

    // And it publishes, on the edited figures:
    // 1.5 kg = 1500 g x 850,000 mc x 1.025 waste = 1,306,875,000 mc / 4 portions.
    let published = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r,
        },
    )
    .await
    .expect("a coherently edited draft publishes");
    assert_eq!(published.per_base_unit_microcents, 326_718_750);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_snapshot_blocks_activation_and_a_resave_clears_it() {
    // The legitimate case the triggers cannot catch, and requirement 6 of the
    // correction: the draft row is exactly as it was written, which is right,
    // and the ingredient's unit has since been REDEFINED, so the draft now
    // describes a quantity the catalogue has disowned. Publishing it would
    // freeze a conversion nobody agrees with.
    let db = kitchen().await;
    let r = rid("p1a06");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();

    db.exec(&format!(
        "UPDATE product_uoms SET factor_num = 1200 WHERE product_id='{P_PATTY}' AND uom_code='kg'"
    ))
    .await;

    let err = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("a stale snapshot must not publish");
    assert!(err.contains("has been changed since the draft was written"), "{err}");
    assert!(err.contains("Beef patty mince"), "it names the ingredient: {err}");
    assert_eq!(recipe_status(&db, &r).await, "draft", "and nothing changed");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        1_000,
        "the stale snapshot is NOT silently rewritten either"
    );

    // A DELIBERATE re-save re-snapshots, under the operator's eye, and then it
    // publishes on the new conversion.
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();
    let published = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r,
        },
    )
    .await
    .expect("a refreshed draft publishes");
    // 0.15 x 1200 = 180 g x 850,000 = 153,000,000.
    assert_eq!(published.per_base_unit_microcents, 153_000_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_published_recipes_frozen_conversion_is_never_revalidated_or_rewritten() {
    // The other side of the stale-snapshot rule, and requirement 7. Once
    // published, the conversion is history: a redefined unit does not refuse
    // it, does not rewrite it, and does not change what it costs.
    let db = kitchen().await;
    let r = rid("p1a07");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .unwrap();

    db.exec(&format!(
        "UPDATE product_uoms SET factor_num = 1200 WHERE product_id='{P_PATTY}' AND uom_code='kg'"
    ))
    .await;

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        1_000
    );
    assert_eq!(recipe_status(&db, &r).await, "active");
    // And nothing can bring it into line with the catalogue, either.
    let e = db
        .exec_err(&format!(
            "UPDATE recipe_components SET factor_num_snapshot = 1200 WHERE recipe_id='{r}'"
        ))
        .await;
    assert!(e.contains("frozen"), "{e}");
}

// ---------------------------------------------------------------------------
// P1-B: a DRAFT header cannot be re-pointed, and activation is store-scoped
// ---------------------------------------------------------------------------

/// A second branch with its own burger, its own bun and its own active recipe.
async fn second_store(db: &TempDb) -> (String, String, String) {
    const S2: &str = "store-b";
    const P2_BURGER: &str = "00000000-0000-0000-0000-00000000c100";
    const P2_BUN: &str = "00000000-0000-0000-0000-00000000c101";
    const P2_SPARE: &str = "00000000-0000-0000-0000-00000000c102";
    db.exec(&format!(
        "INSERT INTO stores (id, name, default_currency) VALUES ('{S2}', 'Branch B', 'USD')"
    ))
    .await;
    for (id, sku, name, service, rate) in [
        (P2_BURGER, "SKU-B2-BURGER", "Branch B Burger", 1, 0_i64),
        (P2_BUN, "SKU-B2-BUN", "Branch B bun", 0, 30_000_000),
        // Owns no recipe and is nobody's ingredient, so a re-point attempt
        // aimed at it collides with nothing: the refusal under test is then the
        // only one that can fire, which is what makes the assertion mean
        // something.
        (P2_SPARE, "SKU-B2-SPARE", "Branch B side", 1, 0),
    ] {
        db.exec(&format!(
            "INSERT INTO products
               (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand, is_service,
                avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents)
             VALUES ('{id}', '{S2}', '{sku}', '{name}', '{VAT_STD_ID}', 'inclusive',
                     1000, 1110, 100, {service}, {rate}, {rate})"
        ))
        .await;
        db.exec(&format!(
            "INSERT INTO product_uoms
               (id, store_id, product_id, uom_code, factor_num, factor_den,
                is_base, is_default_sale_uom, is_default_purchase_uom, is_active)
             VALUES ('uom-{id}', '{S2}', '{id}', 'each', 1, 1, 1, 1, 1, 1)"
        ))
        .await;
    }

    // Branch B's own active recipe, through the real command.
    let b_recipe = rid("b0001");
    save_recipe_draft_with_pool(
        db.pool(),
        SaveRecipeDraftPayload {
            store_id: S2.to_string(),
            product_id: P2_BURGER.to_string(),
            recipe_id: b_recipe.clone(),
            yield_quantity_base: 1,
            notes: None,
            components: vec![RecipeComponentInput {
                component_product_id: P2_BUN.to_string(),
                quantity_num: 1,
                quantity_den: 1,
                uom_code: "each".to_string(),
                waste_bps: 0,
            }],
        },
    )
    .await
    .expect("branch B's draft");
    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: S2.to_string(),
            recipe_id: b_recipe.clone(),
        },
    )
    .await
    .expect("branch B publishes its own recipe");

    (S2.to_string(), P2_SPARE.to_string(), b_recipe)
}

/// Branch B's own burger id, for the tests that need to collide with it.
const S2_BURGER: &str = "00000000-0000-0000-0000-00000000c100";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_header_cannot_be_repointed_at_another_product_or_store() {
    // THE P1-B FAILURE SCENARIO. The first version of this migration protected
    // the header's identity only after publication, which left a draft
    // re-pointable by direct SQL at another product or another STORE.
    let db = kitchen().await;
    let (s2, p2_burger, _) = second_store(&db).await;
    let r = draft_with_a_bun(&db, "p1b01").await;

    // Re-pointing it at another product of its OWN store: refused by the
    // identity rule alone, so the message is exactly that one. This is the
    // case the first version of the migration allowed, and the one that makes
    // a recipe mean something other than what it was created to mean.
    for sql in [
        format!("UPDATE recipes SET product_id = '{P_SAUCE}' WHERE id='{r}'"),
        format!("UPDATE recipes SET version = 9 WHERE id='{r}'"),
        format!("UPDATE recipes SET id = 'stolen' WHERE id='{r}'"),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(
            e.contains("fixed when it is created"),
            "a DRAFT's identity must be immutable too: {sql} -> {e}"
        );
    }

    // Re-pointing it ACROSS STORES trips two rules at once — the identity
    // rule and the store-matches-product rule — and SQLite does not define
    // which of several BEFORE UPDATE triggers fires first. Either refusal is
    // the right outcome, and asserting one of them specifically would be
    // asserting an implementation detail of the engine's trigger ordering.
    for sql in [
        format!("UPDATE recipes SET product_id = '{p2_burger}' WHERE id='{r}'"),
        format!("UPDATE recipes SET store_id = '{s2}' WHERE id='{r}'"),
    ] {
        let e = db.exec_err(&sql).await;
        assert!(
            e.contains("fixed when it is created") || e.contains("same store as the item"),
            "a DRAFT cannot cross stores: {sql} -> {e}"
        );
    }

    // And the row is exactly as it was created.
    assert_eq!(
        db.scalar_string(&format!("SELECT product_id FROM recipes WHERE id='{r}'")).await,
        P_BURGER
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT store_id FROM recipes WHERE id='{r}'")).await,
        STORE_ID
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_header_whose_store_is_not_its_products_store_cannot_be_created() {
    let db = kitchen().await;
    let (s2, _, _) = second_store(&db).await;

    // The burger belongs to STORE_ID; this header claims branch B.
    let e = db
        .exec_err(&format!(
            "INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
             VALUES ('mismatch', '{s2}', '{P_BURGER}', 1, 1, 'draft')"
        ))
        .await;
    assert!(e.contains("same store as the item it makes"), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activation_refuses_a_recipe_of_another_store() {
    // The caller naming another branch's recipe. Refused before anything is
    // read or written, and branch B's own recipe is untouched.
    let db = kitchen().await;
    let (_s2, _p2, b_recipe) = second_store(&db).await;

    let err = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: b_recipe.clone(),
        },
    )
    .await
    .expect_err("another store's recipe");
    assert!(err.contains("does not belong to the store"), "{err}");
    assert_eq!(recipe_status(&db, &b_recipe).await, "active");

    let err = retire_recipe_with_pool(
        db.pool(),
        RetireRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: b_recipe.clone(),
        },
    )
    .await
    .expect_err("and it cannot be retired from outside either");
    assert!(err.contains("does not belong to the store"), "{err}");
    assert_eq!(recipe_status(&db, &b_recipe).await, "active");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn store_b_keeps_its_incumbent_when_store_a_submits_a_corrupted_recipe() {
    // The scenario the scoping exists for, reached the only way it still can:
    // the header guards are dropped so the corruption can be written at all,
    // which is what a reviewer would do to check that the COMMAND does not
    // depend on them. Branch B's active recipe must survive.
    let db = kitchen().await;
    let (s2, p2_burger, b_recipe) = second_store(&db).await;
    let r = draft_with_a_bun(&db, "p1b02").await;
    let (b_activated_before, _) = recipe_timestamps(&db, &b_recipe).await;

    db.exec("DROP TRIGGER trg_recipes_identity_immutable").await;
    db.exec("DROP TRIGGER trg_recipes_store_matches_product_upd").await;
    db.exec(&format!(
        "UPDATE recipes SET store_id = '{s2}', product_id = '{S2_BURGER}', version = 2
          WHERE id='{r}'"
    ))
    .await;
    let _ = &p2_burger;

    // Branch A asks to publish it, and branch B asks to publish it. Both are
    // refused, for different reasons, and neither touches branch B's row.
    let a = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("the row no longer belongs to branch A");
    assert!(a.contains("does not belong to the store"), "{a}");

    let b = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: s2.clone(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("its components still belong to branch A");
    assert!(
        b.contains("does not belong to the store") || b.contains("does not exist in this store"),
        "{b}"
    );

    // Branch B's incumbent is exactly as it was: still active, same activation
    // timestamp, never momentarily retired.
    assert_eq!(recipe_status(&db, &b_recipe).await, "active");
    let (b_activated_after, b_retired) = recipe_timestamps(&db, &b_recipe).await;
    assert_eq!(b_activated_after, b_activated_before);
    assert_eq!(b_retired, None);
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipes WHERE store_id='{s2}' AND status='active'"
        ))
        .await,
        1
    );
    assert_eq!(recipe_status(&db, &r).await, "draft", "and the corrupted row published nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_activation_rolls_back_entirely() {
    // Atomicity, asserted on the figures a failure could plausibly leave
    // behind: the incumbent still active with its original timestamp, the
    // candidate still a draft, and exactly one active version.
    let db = kitchen().await;
    let v1 = an_active_recipe(&db, "p1b03").await;
    let (v1_activated, _) = recipe_timestamps(&db, &v1).await;

    let unknown = "00000000-0000-0000-0000-00000000b1fa";
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 5,
            ..ProductSpec::stocked(unknown, "SKU-ROLL", "Unpriced relish")
        },
    )
    .await;
    let v2 = rid("p1b04");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&v2, vec![component(unknown, 1, 1, "each")]),
    )
    .await
    .unwrap();

    activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: v2.clone(),
        },
    )
    .await
    .expect_err("incomplete");

    assert_eq!(recipe_status(&db, &v1).await, "active");
    assert_eq!(recipe_timestamps(&db, &v1).await, (v1_activated, None));
    assert_eq!(recipe_status(&db, &v2).await, "draft");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM recipes WHERE product_id='{P_BURGER}' AND status='active'"
        ))
        .await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retirement_cannot_precede_its_activation() {
    // P2-A. Both columns hold the project's canonical fixed-width UTC
    // timestamp, so lexicographic order IS chronological order.
    let db = kitchen().await;
    let r = an_active_recipe(&db, "p2a01").await;
    let e = db
        .exec_err(&format!(
            "UPDATE recipes SET status='retired', retired_at='2020-01-01T00:00:00.000Z'
              WHERE id='{r}'"
        ))
        .await;
    assert!(e.contains("CHECK constraint failed"), "{e}");
    assert_eq!(recipe_status(&db, &r).await, "active");
}

// ============================================================================
// 12. EQUIVALENT CONVERSIONS (GZ-B2A-P2-1)
//
// `1000/1` and `2000/2` are one conversion. The staleness check compared the
// stored parts pairwise, so an ingredient's unit rewritten to an equal value
// refused the draft and told the operator their quantities no longer meant
// what they did — which was false, and asked them to re-save a recipe that
// had not changed.
// ============================================================================

#[test]
fn equivalent_rational_conversions_compare_equal() {
    // A kilogram is a thousand grams however the row spells it.
    assert!(same_conversion(1_000, 1, 2_000, 2).unwrap());
    assert!(same_conversion(1, 3, 100_000, 300_000).unwrap());
    assert!(same_conversion(1, 1, 1_000_000, 1_000_000).unwrap());
    assert!(same_conversion(12, 1, 24, 2).unwrap());

    // And a genuinely different conversion still differs.
    assert!(!same_conversion(1_000, 1, 1_200, 1).unwrap());
    assert!(!same_conversion(1, 1, 1, 2).unwrap());
    assert!(!same_conversion(1, 3, 1, 4).unwrap());

    // Cross-multiplied, never divided: a quotient comparison would make these
    // agree or disagree depending on the arithmetic rather than on the data.
    assert!(same_conversion(333_333, 1_000_000, 999_999, 3_000_000).unwrap());
    assert!(!same_conversion(333_333, 1_000_000, 333_334, 1_000_000).unwrap());

    // Non-positive parts are refused rather than compared.
    assert!(same_conversion(0, 1, 0, 1).is_err());
    assert!(same_conversion(1, 0, 1, 1).is_err());
    assert!(same_conversion(-1, 1, -1, 1).is_err());
}

#[test]
fn the_conversion_comparison_cannot_overflow_in_the_envelope() {
    // Both products are at most 10^12 under migration 021's CHECKs; the widest
    // admissible pair is proved rather than assumed, and a part beyond i64's
    // own range refuses instead of wrapping.
    assert!(same_conversion(1_000_000, 1_000_000, 1_000_000, 1_000_000).unwrap());
    assert!(same_conversion(i64::MAX, 1, i64::MAX, 1).unwrap());
    assert!(same_conversion(i64::MAX, 2, i64::MAX, 2).unwrap());
    // 10^18 x 10^18 = 10^36, inside i128 (1.7 x 10^38): still answered, not
    // refused, which is what `checked_mul` being a proof rather than a hope
    // means.
    assert!(same_conversion(1_000_000_000_000_000_000, 1, 1_000_000_000_000_000_000, 1).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_equivalent_conversion_rewrite_still_activates() {
    // The P2-1 scenario end to end: the draft says 0.15 kg at 1000/1, the shop
    // rewrites the kilogram as 2000/2, and the physical quantity is unchanged.
    let db = kitchen().await;
    let r = rid("p2101");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();

    db.exec(&format!(
        "UPDATE product_uoms SET factor_num = 2000, factor_den = 2
          WHERE product_id='{P_PATTY}' AND uom_code='kg'"
    ))
    .await;

    let published = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect("an equivalent rewrite is not a change");

    // 0.15 kg = 150 g at 850,000 mc/g = 127,500,000 mc, exactly as before.
    assert_eq!(published.per_base_unit_microcents, 127_500_000);

    // AND THE STORED SNAPSHOT IS UNTOUCHED. It is costed as written, never
    // rewritten to today's spelling of the same factor.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num_snapshot FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        1_000
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_den_snapshot FROM recipe_components WHERE recipe_id='{r}'"
        ))
        .await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_genuinely_different_conversion_is_still_refused_as_stale() {
    // The other half: equivalence must not become permissiveness. The refusal
    // now states both conversions, because "it changed" without saying to what
    // leaves the operator checking the catalogue by hand.
    let db = kitchen().await;
    let r = rid("p2102");
    save_recipe_draft_with_pool(
        db.pool(),
        draft(&r, vec![component(P_PATTY, 15, 100, "kg")]),
    )
    .await
    .unwrap();

    db.exec(&format!(
        "UPDATE product_uoms SET factor_num = 1200 WHERE product_id='{P_PATTY}' AND uom_code='kg'"
    ))
    .await;

    let err = activate_recipe_with_pool(
        db.pool(),
        ActivateRecipePayload {
            store_id: STORE_ID.to_string(),
            recipe_id: r.clone(),
        },
    )
    .await
    .expect_err("1000/1 and 1200/1 are different quantities");
    assert!(err.contains("has been changed since the draft was written"), "{err}");
    assert!(err.contains("1000/1"), "it states what the recipe was written on: {err}");
    assert!(err.contains("1200/1"), "and what it means now: {err}");
    assert_eq!(recipe_status(&db, &r).await, "draft");
}
