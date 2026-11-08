//! Recipe definition commands (WP-B2-A).
//!
//! WHY THESE ARE IN RUST
//!
//! The same reason `catalog.rs` exists. Saving a recipe is a compound write —
//! a `recipes` row plus one `recipe_components` row per ingredient — and
//! `tauri-plugin-sql` gives no usable `BEGIN`/`COMMIT` across statements. The
//! half-states are not untidy, they are WRONG: a header with no components is
//! a recipe that costs nothing, and a recipe that costs nothing is exactly the
//! figure this whole work package exists to stop printing. Activating is
//! worse: it retires one version and publishes another, and a failure between
//! those two leaves a product with no authoritative recipe or with two.
//!
//! So the three commands below each run in one transaction, and the frontend
//! is a read model plus a preview. **No frontend validation is the authority
//! for anything here.** The editor computes a preview with
//! `lib/recipeCost.ts`, and every rule that decides whether a recipe may be
//! saved or activated is re-decided in this file, inside the transaction,
//! against the database — and most of them a third time by migration 021's
//! triggers, which bind any other writer.
//!
//! WHAT THESE COMMANDS CANNOT DO
//!
//! They cannot make a product recipe-costed. `products.costing_method` is not
//! on any payload here, and migration 020's coherence trigger still refuses
//! `'recipe'` outright. A recipe authored by these commands is a definition
//! and a cost preview; no sale reads it, because `post_sale` is not modified
//! by WP-B2-A at all. They also move no stock: there is no consumption here,
//! no `inventory_movements` row is written, and `quantity_on_hand` is never
//! touched.

use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool};
use tauri::State;

use crate::posting::{pool, DbState};
use crate::recipe_cost::{
    check_component_bounds, check_recipe_bounds, recipe_cost, same_conversion,
    ComponentCostSource, ResolvedComponent, MAX_COMPONENTS,
};

// ============================================================================
// Payloads
// ============================================================================

/// One ingredient line as the editor sends it.
///
/// The quantity arrives as an already-reduced fraction: the TypeScript side
/// parses the typed text (`"150"`, `"0.5"`, `"1/3"`) and reduces it, and this
/// command reduces it AGAIN before storing, because a client is never the
/// authority on canonical form. `uom_code` names a unit; the CONVERSION is not
/// on the wire at all, because the database decides it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeComponentInput {
    pub component_product_id: String,
    pub quantity_num: i64,
    pub quantity_den: i64,
    pub uom_code: String,
    #[serde(default)]
    pub waste_bps: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecipeDraftPayload {
    pub store_id: String,
    pub product_id: String,
    /// The draft's identity, minted once by the caller. Re-saving the same
    /// draft replaces its contents under the same id.
    pub recipe_id: String,
    pub yield_quantity_base: i64,
    #[serde(default)]
    pub notes: Option<String>,
    pub components: Vec<RecipeComponentInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateRecipePayload {
    pub store_id: String,
    pub recipe_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetireRecipePayload {
    pub store_id: String,
    pub recipe_id: String,
}

// ============================================================================
// Results
// ============================================================================

/// What one ingredient costs in the saved draft, for the editor to display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentCostReport {
    pub component_product_id: String,
    pub component_name: String,
    pub contribution_microcents: i64,
    pub cost_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecipeDraftResult {
    pub recipe_id: String,
    pub version: i64,
    /// `null` when any ingredient has no cost basis: a cost that cannot be
    /// computed is reported as ABSENT, never as zero. Zero is what a
    /// documented free ingredient contributes, and the two must not share a
    /// representation — the WP-B1 lesson, applied one level down.
    pub per_base_unit_microcents: Option<i64>,
    pub batch_microcents: Option<i64>,
    pub components: Vec<ComponentCostReport>,
    /// Ingredient names with no cost basis. Empty means the draft is complete
    /// and `activate_recipe` will accept it.
    pub uncosted_components: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateRecipeResult {
    pub recipe_id: String,
    pub version: i64,
    pub activated_at: String,
    /// The version this activation retired, if any.
    pub retired_recipe_id: Option<String>,
    pub per_base_unit_microcents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetireRecipeResult {
    pub recipe_id: String,
    pub retired_at: String,
}

// ============================================================================
// Shared messages
// ============================================================================

pub const RECIPE_NEEDS_AN_INGREDIENT: &str =
    "A recipe needs at least one ingredient. Add one, or delete the draft.";

pub const RECIPE_PRODUCT_NOT_FOUND: &str =
    "That menu item does not exist in this store.";

pub const RECIPE_NOT_FOUND: &str = "That recipe does not exist in this store.";

pub const RECIPE_NOT_A_DRAFT: &str =
    "That recipe version is published. Published versions are never edited \u{2014} create a new \
     version instead.";

pub const RECIPE_ALREADY_PUBLISHED: &str =
    "That recipe version has already been published.";

pub const RECIPE_RETIRED_CANNOT_ACTIVATE: &str =
    "A retired recipe version cannot be activated again. Create a new version instead.";

pub const RECIPE_NOT_ACTIVE_CANNOT_RETIRE: &str =
    "Only the active recipe version can be retired.";

pub const RECIPE_RETIRE_BLOCKED_BY_COSTING: &str =
    "This item is currently costed from its recipe, so retiring the recipe would leave it with no \
     cost. Switch the item to purchase valuation or Manual Cost first.";

pub const DRAFT_ALREADY_EXISTS: &str =
    "This item already has an unpublished draft recipe. Open and edit that one, or delete it \
     first.";

pub const RECIPE_STORE_MISMATCH: &str =
    "That recipe does not belong to the store it is being published in. Nothing was changed.";

pub const RECIPE_SNAPSHOT_STALE: &str =
    "The unit of one of this recipe's ingredients has been changed since the draft was written, so \
     the quantities in the draft no longer mean what they did. Open the recipe, check each \
     quantity and save it again before publishing.";

pub const RECIPE_ON_RECIPE: &str =
    "An ingredient cannot itself be built from a recipe. Greaz supports one level of composition.";

// ============================================================================
// Quantity canonical form
// ============================================================================

fn gcd(a: i64, b: i64) -> i64 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// Reduce a quantity fraction to canonical form.
///
/// Performed here as well as in the editor because two spellings of one
/// quantity must compare equal in the DATABASE — `2/4` and `1/2` are the same
/// recipe, and a draft saved from two different screens must not produce two
/// different rows.
fn reduce(num: i64, den: i64) -> Result<(i64, i64), String> {
    if num < 1 || den < 1 {
        return Err(format!(
            "A recipe quantity must be a positive fraction; got {num}/{den}."
        ));
    }
    let g = gcd(num, den);
    Ok((num / g, den / g))
}

// ============================================================================
// Resolving one ingredient against the database
// ============================================================================

/// The conversion snapshot and the cost rate of one ingredient.
struct ResolvedIngredient {
    name: String,
    product_uom_id: String,
    factor_num: i64,
    factor_den: i64,
    /// `None` means NO COST BASIS EXISTS. It is not zero.
    rate_microcents: Option<i64>,
    cost_source: ComponentCostSource,
}

/// Resolve the ingredient's unit conversion and its authoritative cost rate.
///
/// THE COST RATE, AND WHY THERE IS NO RECIPE-LEVEL OVERRIDE
///
/// An ingredient's rate comes from the ingredient's OWN costing configuration,
/// which is WP-B1's work reused rather than second-guessed:
///
///   * `standard` — the figure its owner typed. Migration 020 guarantees it is
///     not NULL whenever the method is `standard`, and restricts the method to
///     non-stock items.
///   * `purchase_average` with a rate above zero — that rate. The average IS
///     the valuation and needs no further evidence.
///   * `purchase_average` with a zero pair — ambiguous, and resolved by exactly
///     the predicate WP-B1's P1-A correction established: a documented
///     `purchase` or `opening` movement makes the zero an ANSWER (a free case,
///     a supplier sample, an opening count valued at nothing); its absence
///     makes the zero the absence of an answer, and this function returns
///     `None`. **Missing evidence is never treated as a legitimate zero.**
///   * `recipe` — unreachable. Migration 021 refuses a recipe-costed
///     ingredient, and this function refuses it again by name.
///
/// A typed override on the COMPONENT was considered and rejected. For a
/// stocked ingredient it would be a rate that disagrees with the
/// `inventory_movements` ledger those goods left through, which is the exact
/// defect WP-B1 refused when it restricted Manual Cost to non-stock items —
/// one level deeper and harder to see. The supported way to state a cost for a
/// stocked ingredient is to receive it on a purchase or an opening valuation,
/// which is a document. A non-stock ingredient can carry a Manual Cost today.
async fn resolve_ingredient(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    store_id: &str,
    component_product_id: &str,
    uom_code: &str,
) -> Result<ResolvedIngredient, String> {
    let row = sqlx::query(
        "SELECT name, is_active, costing_method,
                standard_cost_excl_vat_microcents,
                avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents
           FROM products WHERE id = ? AND store_id = ?",
    )
    .bind(component_product_id)
    .bind(store_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read ingredient {component_product_id}: {e}"))?
    .ok_or_else(|| {
        format!("Ingredient {component_product_id} does not exist in this store.")
    })?;

    let name: String = row.try_get("name").map_err(|e| format!("decode name: {e}"))?;
    let is_active: i64 = row
        .try_get("is_active")
        .map_err(|e| format!("decode is_active: {e}"))?;
    let costing_method: String = row
        .try_get("costing_method")
        .map_err(|e| format!("decode costing_method: {e}"))?;
    let standard_mc: Option<i64> = row
        .try_get("standard_cost_excl_vat_microcents")
        .map_err(|e| format!("decode standard cost: {e}"))?;
    let avg_excl_mc: i64 = row
        .try_get("avg_cost_excl_vat_microcents")
        .map_err(|e| format!("decode avg excl: {e}"))?;
    let avg_incl_mc: i64 = row
        .try_get("avg_cost_incl_vat_microcents")
        .map_err(|e| format!("decode avg incl: {e}"))?;

    if is_active != 1 {
        return Err(format!(
            "\"{name}\" is not active, so it cannot be an ingredient."
        ));
    }
    if costing_method == "recipe" {
        return Err(format!("\"{name}\": {RECIPE_ON_RECIPE}"));
    }

    // ---- The unit, and the conversion snapshot ----
    //
    // Resolved from the ingredient's own `product_uoms` row and stored on the
    // component, because that row is MUTABLE: `catalog.rs` runs
    // `UPDATE product_uoms SET factor_num = ?, factor_den = ?` whenever a
    // product's selling unit is edited. Without the snapshot a shop changing
    // "1 box = 12" to "1 box = 24" would silently double the physical quantity
    // and the cost of every published recipe that said "1 box".
    let uom = sqlx::query(
        "SELECT id, factor_num, factor_den
           FROM product_uoms
          WHERE product_id = ? AND store_id = ? AND uom_code = ? AND is_active = 1",
    )
    .bind(component_product_id)
    .bind(store_id)
    .bind(uom_code)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read ingredient unit for {component_product_id}: {e}"))?
    .ok_or_else(|| {
        format!("\"{name}\" has no active unit \"{uom_code}\". Pick a unit the ingredient has.")
    })?;

    let product_uom_id: String = uom.try_get("id").map_err(|e| format!("decode uom id: {e}"))?;
    let factor_num: i64 = uom
        .try_get("factor_num")
        .map_err(|e| format!("decode factor_num: {e}"))?;
    let factor_den: i64 = uom
        .try_get("factor_den")
        .map_err(|e| format!("decode factor_den: {e}"))?;

    // ---- The rate ----
    let (rate_microcents, cost_source) = if costing_method == "standard" {
        (standard_mc, ComponentCostSource::Standard)
    } else if avg_excl_mc != 0 || avg_incl_mc != 0 {
        (Some(avg_excl_mc), ComponentCostSource::PurchaseAverage)
    } else {
        // A zero pair. Documented, or absent?
        let documented = crate::posting::has_purchase_valuation_basis(
            tx,
            store_id,
            component_product_id,
        )
        .await?;
        (
            if documented { Some(0) } else { None },
            ComponentCostSource::PurchaseAverage,
        )
    };

    Ok(ResolvedIngredient {
        name,
        product_uom_id,
        factor_num,
        factor_den,
        rate_microcents,
        cost_source,
    })
}

// ============================================================================
// save_recipe_draft
// ============================================================================

#[tauri::command]
pub async fn save_recipe_draft(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    payload: SaveRecipeDraftPayload,
) -> Result<SaveRecipeDraftResult, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::RecipeDraft,
    )
    .await?;
    save_recipe_draft_as(&pool, &actor, payload).await
}

/// The pre-Stage-B seam, kept so the ninety-odd existing recipe tests
/// need no edit: they are about versioning, costing and the lifecycle,
/// and have no opinion about who is signed in. Tests that are ABOUT
/// authorization call `save_recipe_draft_as` with an actor of their own.
#[cfg(test)]
pub(crate) async fn save_recipe_draft_with_pool(
    pool: &SqlitePool,
    payload: SaveRecipeDraftPayload,
) -> Result<SaveRecipeDraftResult, String> {
    save_recipe_draft_as(pool, &crate::auth::Actor::test_owner(), payload).await
}

pub(crate) async fn save_recipe_draft_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    payload: SaveRecipeDraftPayload,
) -> Result<SaveRecipeDraftResult, String> {
    if payload.components.is_empty() {
        return Err(RECIPE_NEEDS_AN_INGREDIENT.to_string());
    }
    if payload.components.len() > MAX_COMPONENTS {
        return Err(format!(
            "A recipe may hold at most {MAX_COMPONENTS} ingredients; this one has {}.",
            payload.components.len()
        ));
    }
    check_recipe_bounds(payload.components.len(), payload.yield_quantity_base)?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin save_recipe_draft tx: {e}"))?;

    // ---- Authorization, INSIDE the transaction ----
    //
    // Re-checked here and not only at the command boundary, because the
    // boundary check ran before this transaction opened and a role can
    // change in between. A recipe write moves no money, but it decides
    // what every future sale of that item is COSTED at, which reaches
    // every margin figure in the business.
    crate::authz::authorize_tx(&mut tx, actor, crate::authz::Operation::RecipeDraft).await?;

    // ---- The product this recipe makes ----
    let product = sqlx::query(
        "SELECT name, is_active FROM products WHERE id = ? AND store_id = ?",
    )
    .bind(&payload.product_id)
    .bind(&payload.store_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read recipe product: {e}"))?
    .ok_or_else(|| RECIPE_PRODUCT_NOT_FOUND.to_string())?;

    let product_active: i64 = product
        .try_get("is_active")
        .map_err(|e| format!("decode is_active: {e}"))?;
    if product_active != 1 {
        return Err("That menu item is not active, so it cannot take a recipe.".to_string());
    }

    // ---- The draft row: reuse, or create the next version ----
    //
    // `ux_recipes_one_draft` allows exactly one draft per product, so a second
    // identity for the same product is refused by the engine rather than
    // quietly accepted beside the first.
    let existing = sqlx::query(
        "SELECT status, version, product_id FROM recipes WHERE id = ? AND store_id = ?",
    )
    .bind(&payload.recipe_id)
    .bind(&payload.store_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read recipe: {e}"))?;

    let version: i64 = match &existing {
        Some(row) => {
            let status: String = row
                .try_get("status")
                .map_err(|e| format!("decode status: {e}"))?;
            if status != "draft" {
                return Err(RECIPE_NOT_A_DRAFT.to_string());
            }
            let owner: String = row
                .try_get("product_id")
                .map_err(|e| format!("decode product_id: {e}"))?;
            if owner != payload.product_id {
                return Err(
                    "That draft belongs to a different menu item. Open the recipe from the item \
                     it belongs to."
                        .to_string(),
                );
            }
            row.try_get("version")
                .map_err(|e| format!("decode version: {e}"))?
        }
        None => {
            // One draft per product, decided HERE as well as by
            // `ux_recipes_one_draft`. The index is the backstop that binds any
            // other writer, but SQLite reports a partial-index violation as
            // "UNIQUE constraint failed: recipes.product_id" — the same text
            // `ux_recipes_one_active` would produce — so a message keyed on
            // the driver error could not tell the operator which rule fired.
            // The check is inside the transaction, so it cannot race the
            // insert it guards.
            let rival: Option<String> = sqlx::query_scalar(
                "SELECT id FROM recipes WHERE product_id = ? AND status = 'draft'",
            )
            .bind(&payload.product_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| format!("read existing draft: {e}"))?;
            if rival.is_some() {
                return Err(DRAFT_ALREADY_EXISTS.to_string());
            }

            // The next version number for this product. MAX + 1, so a retired
            // v1 and an active v2 produce a v3 and no number is ever reused.
            let next: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM recipes WHERE product_id = ?",
            )
            .bind(&payload.product_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("read next recipe version: {e}"))?;
            next
        }
    };

    // ---- Resolve every ingredient BEFORE writing anything ----
    //
    // Same discipline as `post_adjustment` since WP-07: nothing is written
    // until every line is resolved, so a malformed ingredient leaves no draft
    // half-rewritten and no version number consumed.
    let mut resolved: Vec<(RecipeComponentInput, ResolvedIngredient, i64, i64)> =
        Vec::with_capacity(payload.components.len());
    let mut seen: Vec<String> = Vec::with_capacity(payload.components.len());

    for input in &payload.components {
        if input.component_product_id == payload.product_id {
            return Err("A recipe cannot contain the product it makes.".to_string());
        }
        if seen.contains(&input.component_product_id) {
            return Err(
                "The same ingredient is listed twice. Combine them into one quantity.".to_string(),
            );
        }
        seen.push(input.component_product_id.clone());

        // One level of composition, the other direction: an ingredient that
        // owns a recipe of its own would make this a two-level build.
        let ingredient_owns_a_recipe: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM recipes WHERE product_id = ?",
        )
        .bind(&input.component_product_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("read ingredient recipes: {e}"))?;
        if ingredient_owns_a_recipe > 0 {
            return Err(format!(
                "Ingredient {}: {RECIPE_ON_RECIPE}",
                input.component_product_id
            ));
        }

        let (q_num, q_den) = reduce(input.quantity_num, input.quantity_den)?;
        let ingredient =
            resolve_ingredient(&mut tx, &payload.store_id, &input.component_product_id, &input.uom_code)
                .await?;

        // Bounds are checked here, on the RESOLVED figures, so a refusal names
        // the field and the limit before any multiplication happens.
        check_component_bounds(&ResolvedComponent {
            component_product_id: input.component_product_id.clone(),
            component_name: ingredient.name.clone(),
            quantity_num: q_num,
            quantity_den: q_den,
            uom_code: input.uom_code.clone(),
            factor_num: ingredient.factor_num,
            factor_den: ingredient.factor_den,
            waste_bps: input.waste_bps,
            // A missing rate is bounds-checked as zero: the bound is about
            // magnitude, and whether it exists is reported separately.
            unit_cost_excl_vat_microcents: ingredient.rate_microcents.unwrap_or(0),
            cost_source: ingredient.cost_source,
        })?;

        resolved.push((input.clone(), ingredient, q_num, q_den));
    }

    // ---- Write ----
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    if existing.is_some() {
        // Replace the draft's contents wholesale. Legal only because the
        // parent is a draft; migration 021's frozen triggers refuse the same
        // statements against a published version.
        sqlx::query("DELETE FROM recipe_components WHERE recipe_id = ?")
            .bind(&payload.recipe_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("clear draft components: {e}"))?;
        sqlx::query(
            "UPDATE recipes SET yield_quantity_base = ?, notes = ? WHERE id = ?",
        )
        .bind(payload.yield_quantity_base)
        .bind(&payload.notes)
        .bind(&payload.recipe_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update draft header: {e}"))?;
    } else {
        sqlx::query(
            "INSERT INTO recipes (
               id, store_id, product_id, version, yield_quantity_base,
               status, activated_at, retired_at, notes, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, ?)",
        )
        .bind(&payload.recipe_id)
        .bind(&payload.store_id)
        .bind(&payload.product_id)
        .bind(version)
        .bind(payload.yield_quantity_base)
        .bind(&payload.notes)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            let m = e.to_string();
            // The partial-index backstop. Reached only if the check above is
            // somehow bypassed, and reported in the operator's words either way.
            if m.contains("UNIQUE constraint failed: recipes.product_id") {
                DRAFT_ALREADY_EXISTS.to_string()
            } else {
                format!("insert recipe draft: {m}")
            }
        })?;
    }

    for (index, (input, ingredient, q_num, q_den)) in resolved.iter().enumerate() {
        sqlx::query(
            "INSERT INTO recipe_components (
               id, recipe_id, store_id, component_product_id,
               quantity_num, quantity_den, uom_code,
               product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot,
               waste_bps, sort_order, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&payload.recipe_id)
        .bind(&payload.store_id)
        .bind(&input.component_product_id)
        .bind(q_num)
        .bind(q_den)
        .bind(&input.uom_code)
        .bind(&ingredient.product_uom_id)
        .bind(ingredient.factor_num)
        .bind(ingredient.factor_den)
        .bind(input.waste_bps)
        .bind(index as i64)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert recipe component \"{}\": {e}", ingredient.name))?;
    }

    // ---- Cost it, for the editor ----
    let uncosted: Vec<String> = resolved
        .iter()
        .filter(|(_, ing, _, _)| ing.rate_microcents.is_none())
        .map(|(_, ing, _, _)| ing.name.clone())
        .collect();

    let (per_base, batch, breakdown) = if uncosted.is_empty() {
        let costed: Vec<ResolvedComponent> = resolved
            .iter()
            .map(|(input, ing, q_num, q_den)| ResolvedComponent {
                component_product_id: input.component_product_id.clone(),
                component_name: ing.name.clone(),
                quantity_num: *q_num,
                quantity_den: *q_den,
                uom_code: input.uom_code.clone(),
                factor_num: ing.factor_num,
                factor_den: ing.factor_den,
                waste_bps: input.waste_bps,
                unit_cost_excl_vat_microcents: ing.rate_microcents.unwrap_or(0),
                cost_source: ing.cost_source,
            })
            .collect();
        let cost = recipe_cost(&costed, payload.yield_quantity_base)?;
        (
            Some(cost.per_base_unit_microcents),
            Some(cost.batch_microcents),
            cost.components
                .into_iter()
                .map(|c| ComponentCostReport {
                    component_product_id: c.component_product_id,
                    component_name: c.component_name,
                    contribution_microcents: c.contribution_microcents,
                    cost_source: c.cost_source.as_str().to_string(),
                })
                .collect(),
        )
    } else {
        // A cost that cannot be computed is reported as ABSENT. Returning zero
        // here is how a catalogue of 100% margins stops looking like a problem.
        (None, None, Vec::new())
    };

    tx.commit()
        .await
        .map_err(|e| format!("commit save_recipe_draft: {e}"))?;

    Ok(SaveRecipeDraftResult {
        recipe_id: payload.recipe_id,
        version,
        per_base_unit_microcents: per_base,
        batch_microcents: batch,
        components: breakdown,
        uncosted_components: uncosted,
    })
}

// ============================================================================
// activate_recipe
// ============================================================================

/// Publish a draft, retiring the version it supersedes in the SAME transaction.
///
/// `ux_recipes_one_active` is what makes "retire the old one and activate the
/// new one" have no outcome in which both are active or neither is — the same
/// mechanism `ux_shifts_one_open_per_store` uses for a shift. The retirement
/// is written first, so the partial index is never momentarily violated.
///
/// COMPLETENESS IS VALIDATED HERE, not in the editor. Every ingredient must
/// resolve to a cost basis, and a draft with an ingredient that has none is
/// refused by ingredient name. That is what makes it safe for WP-B2-B to
/// REFUSE a sale whose recipe cannot be costed: a cost basis is monotone
/// (`inventory_movements` is append-only, so an ingredient that has a
/// purchase or opening row keeps it for ever), so an activated recipe cannot
/// become uncostable by anything a shop does to its purchase history.
#[tauri::command]
pub async fn activate_recipe(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    payload: ActivateRecipePayload,
) -> Result<ActivateRecipeResult, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::RecipeActivate,
    )
    .await?;
    activate_recipe_as(&pool, &actor, payload).await
}

/// The pre-Stage-B seam, kept so the ninety-odd existing recipe tests
/// need no edit: they are about versioning, costing and the lifecycle,
/// and have no opinion about who is signed in. Tests that are ABOUT
/// authorization call `activate_recipe_as` with an actor of their own.
#[cfg(test)]
pub(crate) async fn activate_recipe_with_pool(
    pool: &SqlitePool,
    payload: ActivateRecipePayload,
) -> Result<ActivateRecipeResult, String> {
    activate_recipe_as(pool, &crate::auth::Actor::test_owner(), payload).await
}

pub(crate) async fn activate_recipe_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    payload: ActivateRecipePayload,
) -> Result<ActivateRecipeResult, String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin activate_recipe tx: {e}"))?;

    // ---- Authorization, INSIDE the transaction ----
    //
    // Re-checked here and not only at the command boundary, because the
    // boundary check ran before this transaction opened and a role can
    // change in between. A recipe write moves no money, but it decides
    // what every future sale of that item is COSTED at, which reaches
    // every margin figure in the business.
    crate::authz::authorize_tx(&mut tx, actor, crate::authz::Operation::RecipeActivate).await?;

    // Read the row by ID ALONE, then prove its ownership, rather than filtering
    // by the caller's store and treating a miss as "not found". The two differ
    // in exactly the case that matters: a draft whose `store_id` disagreed with
    // its own product's store used to be reachable, and filtering by one of the
    // two silently decided which of them the rest of this command would trust.
    // Migration 021 now makes that row unwritable, and this reads it back
    // anyway, because a command that depends on a trigger to be correct stops
    // being correct the moment the trigger is relaxed.
    let header = sqlx::query(
        "SELECT r.store_id   AS recipe_store_id,
                r.product_id AS product_id,
                r.version    AS version,
                r.status     AS status,
                r.yield_quantity_base AS yield_quantity_base,
                p.store_id   AS product_store_id
           FROM recipes r
           LEFT JOIN products p ON p.id = r.product_id
          WHERE r.id = ?",
    )
    .bind(&payload.recipe_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read recipe: {e}"))?
    .ok_or_else(|| RECIPE_NOT_FOUND.to_string())?;

    let recipe_store_id: String = header
        .try_get("recipe_store_id")
        .map_err(|e| format!("decode recipe store_id: {e}"))?;
    let product_store_id: Option<String> = header
        .try_get("product_store_id")
        .map_err(|e| format!("decode product store_id: {e}"))?;
    let product_id: String = header
        .try_get("product_id")
        .map_err(|e| format!("decode product_id: {e}"))?;

    // Three ways the caller and the row can disagree, all refused before
    // anything is read or written: the caller naming another store's recipe,
    // the row naming a store its own product does not belong to, and a recipe
    // pointing at a product that no longer exists.
    if recipe_store_id != payload.store_id {
        return Err(RECIPE_STORE_MISMATCH.to_string());
    }
    match product_store_id.as_deref() {
        None => return Err(RECIPE_PRODUCT_NOT_FOUND.to_string()),
        Some(owner) if owner != recipe_store_id => {
            return Err(RECIPE_STORE_MISMATCH.to_string())
        }
        Some(_) => {}
    }

    let status: String = header
        .try_get("status")
        .map_err(|e| format!("decode status: {e}"))?;
    match status.as_str() {
        "draft" => {}
        "active" => return Err(RECIPE_ALREADY_PUBLISHED.to_string()),
        _ => return Err(RECIPE_RETIRED_CANNOT_ACTIVATE.to_string()),
    }
    let version: i64 = header
        .try_get("version")
        .map_err(|e| format!("decode version: {e}"))?;
    let yield_base: i64 = header
        .try_get("yield_quantity_base")
        .map_err(|e| format!("decode yield: {e}"))?;

    // ---- Re-resolve every component against TODAY's database ----
    //
    // The draft's own snapshot is the authority on the physical quantity; the
    // RATE is read now, because a draft saved last month against an ingredient
    // that has since been deactivated must not publish.
    let rows = sqlx::query(
        "SELECT component_product_id, store_id, quantity_num, quantity_den, uom_code,
                product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot, waste_bps
           FROM recipe_components WHERE recipe_id = ? ORDER BY sort_order",
    )
    .bind(&payload.recipe_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| format!("read recipe components: {e}"))?;

    if rows.is_empty() {
        return Err(RECIPE_NEEDS_AN_INGREDIENT.to_string());
    }
    check_recipe_bounds(rows.len(), yield_base)?;

    let mut components: Vec<ResolvedComponent> = Vec::with_capacity(rows.len());
    let mut uncosted: Vec<String> = Vec::new();

    for row in &rows {
        let component_product_id: String = row
            .try_get("component_product_id")
            .map_err(|e| format!("decode component id: {e}"))?;
        let uom_code: String = row
            .try_get("uom_code")
            .map_err(|e| format!("decode uom_code: {e}"))?;
        let component_store_id: String = row
            .try_get("store_id")
            .map_err(|e| format!("decode component store_id: {e}"))?;
        let snapshot_uom_id: String = row
            .try_get("product_uom_id_snapshot")
            .map_err(|e| format!("decode product_uom_id_snapshot: {e}"))?;
        let snapshot_num: i64 = row
            .try_get("factor_num_snapshot")
            .map_err(|e| format!("decode factor_num_snapshot: {e}"))?;
        let snapshot_den: i64 = row
            .try_get("factor_den_snapshot")
            .map_err(|e| format!("decode factor_den_snapshot: {e}"))?;

        // A line of this recipe belongs to this recipe's store. Enforced by
        // migration 021 on both INSERT and UPDATE, and re-read here.
        if component_store_id != recipe_store_id {
            return Err(RECIPE_STORE_MISMATCH.to_string());
        }

        // `resolve_ingredient` re-reads the ingredient's eligibility (exists,
        // active, not recipe-costed) and its CURRENT unit row, and refuses by
        // name when any of that has changed since the draft was written.
        let ingredient =
            resolve_ingredient(&mut tx, &recipe_store_id, &component_product_id, &uom_code).await?;

        // THE DRAFT'S SNAPSHOT IS PROVED AGAINST THE DATABASE, not trusted.
        //
        // This is the other half of the P1-A correction. Migration 021 refuses
        // an incoherent component on INSERT and on UPDATE, so a snapshot that
        // disagrees with its unit should be unwritable — but the snapshot is
        // precisely the figure the published cost is computed from, and a
        // command that trusts it is a command with no second opinion.
        //
        // It also covers the legitimate case the triggers cannot: a draft
        // written last month whose ingredient's unit has since been REDEFINED.
        // The draft row stayed exactly as it was, which is correct, and it now
        // describes a quantity the catalogue no longer agrees with. Publishing
        // it would freeze a conversion the shop has disowned, so activation is
        // refused and the operator is told to re-save the draft — which
        // re-snapshots deliberately, under their eye, rather than silently.
        //
        // THE TEST IS RATIONAL EQUIVALENCE, NOT EQUALITY OF THE STORED PARTS.
        // `1000/1` and `2000/2` are one conversion — a kilogram is a thousand
        // grams however the row spells it — and the physical quantity the
        // draft states is unchanged by a rewrite that cancels. Comparing the
        // parts pairwise refused such a draft and told the operator their
        // quantities no longer meant what they did, which was false.
        //
        // The unit ROW's identity is deliberately NOT part of the test either.
        // What decides the physical quantity is the conversion; which row
        // carries it is bookkeeping, and `product_uom_id_snapshot` holds a
        // restricting foreign key, so the row it names cannot vanish. A
        // snapshot that points at a row the shop has since deactivated while
        // an equal active one exists for the same unit code describes exactly
        // the same quantity, and refusing it would be refusing arithmetic.
        //
        // A PUBLISHED recipe is never reached by this: activation runs only
        // from `draft`, and rule 4 refuses every mutation of a published line.
        // Its frozen conversion is never re-validated and never rewritten.
        let _ = &snapshot_uom_id;
        if !same_conversion(
            snapshot_num,
            snapshot_den,
            ingredient.factor_num,
            ingredient.factor_den,
        )? {
            return Err(format!(
                "{}: \"{}\" ({} — the recipe was written when 1 {} meant {}/{} and it now means \
                 {}/{}).",
                RECIPE_SNAPSHOT_STALE,
                ingredient.name,
                uom_code,
                uom_code,
                snapshot_num,
                snapshot_den,
                ingredient.factor_num,
                ingredient.factor_den
            ));
        }

        match ingredient.rate_microcents {
            None => uncosted.push(ingredient.name.clone()),
            Some(rate) => components.push(ResolvedComponent {
                component_product_id,
                component_name: ingredient.name.clone(),
                quantity_num: row
                    .try_get("quantity_num")
                    .map_err(|e| format!("decode quantity_num: {e}"))?,
                quantity_den: row
                    .try_get("quantity_den")
                    .map_err(|e| format!("decode quantity_den: {e}"))?,
                uom_code,
                // The DRAFT'S SNAPSHOT, proved EQUIVALENT to the
                // ingredient's current conversion immediately above — and
                // stored and costed as written, never rewritten to today's
                // spelling of the same factor. A published recipe's physical
                // quantities are its own, and this is the moment they become
                // its own.
                factor_num: snapshot_num,
                factor_den: snapshot_den,
                waste_bps: row
                    .try_get("waste_bps")
                    .map_err(|e| format!("decode waste_bps: {e}"))?,
                unit_cost_excl_vat_microcents: rate,
                cost_source: ingredient.cost_source,
            }),
        }
    }

    if !uncosted.is_empty() {
        return Err(format!(
            "This recipe cannot be published yet: {} {} no cost. Receive {} on a purchase or an \
             opening stock valuation first, or set a Manual Cost if {} not stocked. Greaz will not \
             publish a recipe whose cost it would have to guess.",
            uncosted.join(", "),
            if uncosted.len() == 1 { "has" } else { "have" },
            if uncosted.len() == 1 { "it" } else { "them" },
            if uncosted.len() == 1 { "it is" } else { "they are" },
        ));
    }

    // Proves the arithmetic holds BEFORE the version is published, so a recipe
    // that cannot be costed never becomes authoritative.
    let cost = recipe_cost(&components, yield_base)?;

    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // Retire the incumbent FIRST, so `ux_recipes_one_active` is never
    // momentarily violated inside the transaction.
    // SCOPED BY STORE **AND** PRODUCT, and so is the retirement.
    //
    // `product_id` is a primary key, so one branch's product cannot be
    // another's — but this query decides which row gets RETIRED, and a
    // retirement written from the wrong store is unrecoverable on an
    // append-only history. Naming both columns costs one index lookup and
    // removes the whole class: whatever a corrupted header might say, this can
    // only ever retire a recipe of the store and product that were proved
    // above.
    let incumbent: Option<String> = sqlx::query_scalar(
        "SELECT id FROM recipes
          WHERE store_id = ? AND product_id = ? AND status = 'active'",
    )
    .bind(&recipe_store_id)
    .bind(&product_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read active recipe: {e}"))?;

    if let Some(old) = &incumbent {
        sqlx::query(
            "UPDATE recipes SET status = 'retired', retired_at = ?
              WHERE id = ? AND store_id = ? AND product_id = ? AND status = 'active'",
        )
        .bind(&now)
        .bind(old)
        .bind(&recipe_store_id)
        .bind(&product_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("retire superseded recipe: {e}"))?;
    }

    sqlx::query(
        "UPDATE recipes SET status = 'active', activated_at = ?
          WHERE id = ? AND store_id = ? AND product_id = ? AND status = 'draft'",
    )
    .bind(&now)
    .bind(&payload.recipe_id)
    .bind(&recipe_store_id)
    .bind(&product_id)
    .execute(&mut *tx)
        .await
        .map_err(|e| format!("activate recipe: {e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("commit activate_recipe: {e}"))?;

    Ok(ActivateRecipeResult {
        recipe_id: payload.recipe_id,
        version,
        activated_at: now,
        retired_recipe_id: incumbent,
        per_base_unit_microcents: cost.per_base_unit_microcents,
    })
}

// ============================================================================
// retire_recipe
// ============================================================================

/// Retire the active version, leaving the product with no authoritative recipe.
///
/// Refused while the product is recipe-costed, because that would leave an item
/// configured for a cost it can no longer obtain. In WP-B2-A no product can be
/// recipe-costed at all (migration 020 still refuses the method), so the guard
/// is unreachable today and is written now because the command it protects is
/// written now — a guard added later is a guard that was missing.
#[tauri::command]
pub async fn retire_recipe(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    payload: RetireRecipePayload,
) -> Result<RetireRecipeResult, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::RecipeRetire,
    )
    .await?;
    retire_recipe_as(&pool, &actor, payload).await
}

/// The pre-Stage-B seam, kept so the ninety-odd existing recipe tests
/// need no edit: they are about versioning, costing and the lifecycle,
/// and have no opinion about who is signed in. Tests that are ABOUT
/// authorization call `retire_recipe_as` with an actor of their own.
#[cfg(test)]
pub(crate) async fn retire_recipe_with_pool(
    pool: &SqlitePool,
    payload: RetireRecipePayload,
) -> Result<RetireRecipeResult, String> {
    retire_recipe_as(pool, &crate::auth::Actor::test_owner(), payload).await
}

pub(crate) async fn retire_recipe_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    payload: RetireRecipePayload,
) -> Result<RetireRecipeResult, String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin retire_recipe tx: {e}"))?;

    // ---- Authorization, INSIDE the transaction ----
    //
    // Re-checked here and not only at the command boundary, because the
    // boundary check ran before this transaction opened and a role can
    // change in between. A recipe write moves no money, but it decides
    // what every future sale of that item is COSTED at, which reaches
    // every margin figure in the business.
    crate::authz::authorize_tx(&mut tx, actor, crate::authz::Operation::RecipeRetire).await?;

    let header = sqlx::query(
        "SELECT r.product_id AS product_id,
                r.status     AS status,
                r.store_id   AS recipe_store_id,
                p.store_id   AS product_store_id
           FROM recipes r
           LEFT JOIN products p ON p.id = r.product_id
          WHERE r.id = ?",
    )
    .bind(&payload.recipe_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read recipe: {e}"))?
    .ok_or_else(|| RECIPE_NOT_FOUND.to_string())?;

    let recipe_store_id: String = header
        .try_get("recipe_store_id")
        .map_err(|e| format!("decode recipe store_id: {e}"))?;
    let product_store_id: Option<String> = header
        .try_get("product_store_id")
        .map_err(|e| format!("decode product store_id: {e}"))?;
    if recipe_store_id != payload.store_id
        || product_store_id.as_deref() != Some(recipe_store_id.as_str())
    {
        return Err(RECIPE_STORE_MISMATCH.to_string());
    }

    let status: String = header
        .try_get("status")
        .map_err(|e| format!("decode status: {e}"))?;
    if status != "active" {
        return Err(RECIPE_NOT_ACTIVE_CANNOT_RETIRE.to_string());
    }

    let product_id: String = header
        .try_get("product_id")
        .map_err(|e| format!("decode product_id: {e}"))?;
    let method: String = sqlx::query_scalar(
        "SELECT costing_method FROM products WHERE id = ?",
    )
    .bind(&product_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("read costing_method: {e}"))?;
    if method == "recipe" {
        return Err(RECIPE_RETIRE_BLOCKED_BY_COSTING.to_string());
    }

    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    sqlx::query(
        "UPDATE recipes SET status = 'retired', retired_at = ?
          WHERE id = ? AND store_id = ? AND product_id = ? AND status = 'active'",
    )
    .bind(&now)
    .bind(&payload.recipe_id)
    .bind(&recipe_store_id)
    .bind(&product_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("retire recipe: {e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("commit retire_recipe: {e}"))?;

    Ok(RetireRecipeResult {
        recipe_id: payload.recipe_id,
        retired_at: now,
    })
}
