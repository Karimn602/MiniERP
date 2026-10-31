//! WP-B2-B — costing a SALE line from the product's active recipe.
//!
//! This module is the whole of the B2-B posting change on the read side: given
//! a store, a product and the posting transaction, it answers "what does one
//! base unit of this cost, and why". `posting.rs` calls it from one new branch
//! in its per-line resolution loop and writes what comes back.
//!
//! It is a separate file from `recipes.rs` on purpose. `recipes.rs` is the
//! AUTHORING engine — it is reached only from the recipe editor and it writes
//! `recipes` and `recipe_components`. This is the POSTING path, it writes
//! nothing, and the two have different review stakes: a bug here misstates a
//! posted financial figure, and a bug there is a draft somebody can re-save.
//!
//! WHAT IT DOES NOT DO: it moves no stock, writes no `inventory_movements` row
//! and touches no cost pool. A recipe COGS figure in B2-B is an ESTIMATED
//! ingredient-based food cost — what the plate's ingredients cost at the rates
//! on file — and is not evidence that any ingredient was depleted. Ingredient
//! consumption is WP-B3.

use sqlx::{Row, Sqlite};

use crate::recipe_cost::{
    check_component_bounds, check_recipe_bounds, recipe_cost, ComponentCostSource,
    ResolvedComponent, MAX_COMPONENTS,
};
use crate::recipes::RECIPE_ON_RECIPE;

/// No published recipe exists for a product whose costing method says there is
/// one. Migration 022's `trg_products_costing_coherence_{ins,upd}` and B2-A's
/// `retire_recipe` close that loop from both ends, so this is defence in depth
/// against a writer that went round them rather than a state a screen reaches.
pub const RECIPE_COSTING_NO_ACTIVE_RECIPE: &str =
    "is set to Recipe costing but has no published recipe. Publish one for it, or switch the item \
     to purchase valuation or Manual Cost.";

/// Recipe costing is restricted to non-stock items for the same financial
/// reason Manual Cost is: a rate that disagrees with the `inventory_movements`
/// ledger the goods left through can never be unwound, because that table is
/// append-only.
pub const RECIPE_COSTING_NEEDS_SERVICE: &str =
    "is set to Recipe costing but is a stocked product. Recipe costing applies to non-stock menu \
     items only; a stocked product is valued from its purchases.";

/// One ingredient's frozen contribution to a posted sale line, ready to be
/// written as evidence. Nothing here is taken from a client.
#[derive(Debug, Clone)]
pub struct PostedRecipeComponent {
    pub component_product_id: String,
    pub component_name_snapshot: String,
    pub uom_code: String,
    pub quantity_num: i64,
    pub quantity_den: i64,
    pub factor_num_snapshot: i64,
    pub factor_den_snapshot: i64,
    pub waste_bps: i64,
    pub unit_cost_excl_vat_microcents: i64,
    pub cost_source: &'static str,
    pub contribution_microcents: i64,
    pub sort_order: i64,
}

/// What the active recipe costs one base unit of its product, plus the evidence
/// that explains the figure.
#[derive(Debug, Clone)]
pub struct PostedRecipeCost {
    pub recipe_id: String,
    pub version: i64,
    /// The COGS rate, per base unit of the RECIPE'S product, excluding VAT, in
    /// microcents — the same shape as `avg_cost_excl_vat_microcents` and
    /// `standard_cost_excl_vat_microcents`, so the line costs out through the
    /// one documented boundary (`extended_cost_cents`) exactly like every other
    /// line and nothing about the money's precision or rounding is special.
    pub per_base_unit_microcents: i64,
    pub components: Vec<PostedRecipeComponent>,
}

/// Cost one sale line from the product's ACTIVE recipe, inside the posting
/// transaction.
///
/// TWO DIFFERENT AGES, ON PURPOSE. The PHYSICAL figures — which ingredients,
/// how much of each, at what conversion, with what waste — are the published
/// version's own frozen snapshot, read from `recipe_components` and used
/// exactly as stored. The RATES are resolved against today's database. That is
/// not an inconsistency: it is the same split B2-A established and the one
/// every other cost input here already has. Changing an ingredient's cost
/// changes what the NEXT sale is costed at and restates nothing already posted,
/// because `sale_items` is sealed by migration 012.
///
/// In particular the CURRENT `product_uoms` factor is never read here. A shop
/// that redefines "1 box" after publishing changes what the next DRAFT
/// snapshots and nothing a published version says, so a posted receipt's
/// explanation cannot move under it.
///
/// AN INGREDIENT WITH NO COST BASIS REFUSES THE SALE. `activate_recipe` already
/// refuses to publish a recipe whose ingredients cannot all be costed, and a
/// cost basis is monotone — `inventory_movements` is append-only, so an
/// ingredient that has a `purchase` or `opening` row keeps it for ever — so the
/// only way to reach this refusal is for somebody to have RECONFIGURED an
/// ingredient since publication, for instance switching it off Manual Cost onto
/// purchase valuation it has no document for. Posting it at zero instead is
/// precisely how a restaurant acquires a year of 100% margins with no way to
/// date the start of it, so the till stops and names the ingredient. A
/// DOCUMENTED zero is not this case and posts normally: a free case, a supplier
/// sample or an opening count valued at nothing is an answer, and
/// `has_purchase_valuation_basis` is what tells the two apart.
///
/// An INACTIVE ingredient is deliberately NOT a refusal. Deactivating a product
/// says "we no longer sell or buy this"; it destroys no purchase history and
/// leaves the rate every bit as documented as it was, so refusing here would
/// stop a shift over a catalogue tidy-up while the cost stayed perfectly
/// knowable. `activate_recipe` checks `is_active` because publishing is a
/// deliberate act at a desk; posting is a queue of customers.
pub async fn cost_sale_line_from_active_recipe(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    store_id: &str,
    product_id: &str,
    product_name: &str,
) -> Result<PostedRecipeCost, String> {
    // The active recipe of THIS product in THIS store. `ux_recipes_one_active`
    // (migration 021) is what makes "the" the right article.
    let header = sqlx::query(
        "SELECT id, version, yield_quantity_base
           FROM recipes
          WHERE store_id = ? AND product_id = ? AND status = 'active'",
    )
    .bind(store_id)
    .bind(product_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read active recipe for {product_id}: {e}"))?
    .ok_or_else(|| format!("\"{product_name}\" {RECIPE_COSTING_NO_ACTIVE_RECIPE}"))?;

    let recipe_id: String = header
        .try_get("id")
        .map_err(|e| format!("decode recipe id: {e}"))?;
    let version: i64 = header
        .try_get("version")
        .map_err(|e| format!("decode recipe version: {e}"))?;
    let yield_base: i64 = header
        .try_get("yield_quantity_base")
        .map_err(|e| format!("decode yield: {e}"))?;

    let rows = sqlx::query(
        "SELECT rc.component_product_id, rc.uom_code,
                rc.quantity_num, rc.quantity_den,
                rc.factor_num_snapshot, rc.factor_den_snapshot,
                rc.waste_bps, rc.sort_order,
                p.name                              AS component_name,
                p.costing_method                    AS costing_method,
                p.standard_cost_excl_vat_microcents AS standard_mc,
                p.avg_cost_excl_vat_microcents      AS avg_excl_mc,
                p.avg_cost_incl_vat_microcents      AS avg_incl_mc
           FROM recipe_components rc
           JOIN products p ON p.id = rc.component_product_id
          WHERE rc.recipe_id = ?
          ORDER BY rc.sort_order, rc.id",
    )
    .bind(&recipe_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("read recipe components for {recipe_id}: {e}"))?;

    if rows.is_empty() {
        // Unreachable through the commands: activation refuses a recipe with no
        // ingredients. Stated anyway, because a costing engine that returns 0
        // for "I found nothing" is how a wrong zero stops looking wrong.
        return Err(format!(
            "\"{product_name}\": its published recipe version {version} has no ingredients, so it \
             cannot be costed."
        ));
    }
    if rows.len() > MAX_COMPONENTS {
        return Err(format!(
            "\"{product_name}\": its published recipe version {version} has {} ingredients, above \
             the {MAX_COMPONENTS} the cost arithmetic is proven for.",
            rows.len()
        ));
    }

    let mut components: Vec<ResolvedComponent> = Vec::with_capacity(rows.len());
    let mut sort_orders: Vec<i64> = Vec::with_capacity(rows.len());
    let mut uncosted: Vec<String> = Vec::new();

    for row in &rows {
        let component_product_id: String = row
            .try_get("component_product_id")
            .map_err(|e| format!("decode component product: {e}"))?;
        let component_name: String = row
            .try_get("component_name")
            .map_err(|e| format!("decode component name: {e}"))?;
        let costing_method: String = row
            .try_get("costing_method")
            .map_err(|e| format!("decode component costing_method: {e}"))?;
        let standard_mc: Option<i64> = row
            .try_get("standard_mc")
            .map_err(|e| format!("decode component standard cost: {e}"))?;
        let avg_excl_mc: i64 = row
            .try_get("avg_excl_mc")
            .map_err(|e| format!("decode component avg excl: {e}"))?;
        let avg_incl_mc: i64 = row
            .try_get("avg_incl_mc")
            .map_err(|e| format!("decode component avg incl: {e}"))?;

        // ONE LEVEL OF COMPOSITION. Migration 021 makes this unreachable from
        // both directions — an ingredient may not be recipe-costed, and a
        // product already used as an ingredient may not acquire a recipe — so
        // there is no recursive cost walk here and no depth limit to choose.
        // Checked anyway: if that guard ever had a hole, the honest outcome is
        // a refused sale, not an unbounded recursion inside a posting
        // transaction holding a write lock.
        if costing_method == "recipe" {
            return Err(format!(
                "\"{product_name}\": its ingredient \"{component_name}\" is itself recipe-costed. \
                 {RECIPE_ON_RECIPE}"
            ));
        }

        // The rate, resolved exactly as `recipes.rs::resolve_ingredient`
        // resolves it for the editor — WP-B1 reused, including the P1-A
        // predicate. Missing evidence is never a legitimate zero.
        let (rate, source) = if costing_method == "standard" {
            (standard_mc, ComponentCostSource::Standard)
        } else if avg_excl_mc != 0 || avg_incl_mc != 0 {
            (Some(avg_excl_mc), ComponentCostSource::PurchaseAverage)
        } else {
            let documented =
                crate::posting::has_purchase_valuation_basis(tx, store_id, &component_product_id)
                    .await?;
            (
                if documented { Some(0) } else { None },
                ComponentCostSource::PurchaseAverage,
            )
        };

        let Some(rate) = rate else {
            uncosted.push(component_name);
            continue;
        };

        let component = ResolvedComponent {
            component_product_id,
            component_name,
            quantity_num: row
                .try_get("quantity_num")
                .map_err(|e| format!("decode quantity_num: {e}"))?,
            quantity_den: row
                .try_get("quantity_den")
                .map_err(|e| format!("decode quantity_den: {e}"))?,
            uom_code: row
                .try_get("uom_code")
                .map_err(|e| format!("decode uom_code: {e}"))?,
            // THE PUBLISHED SNAPSHOT, never the catalogue's current factor.
            factor_num: row
                .try_get("factor_num_snapshot")
                .map_err(|e| format!("decode factor_num_snapshot: {e}"))?,
            factor_den: row
                .try_get("factor_den_snapshot")
                .map_err(|e| format!("decode factor_den_snapshot: {e}"))?,
            waste_bps: row
                .try_get("waste_bps")
                .map_err(|e| format!("decode waste_bps: {e}"))?,
            unit_cost_excl_vat_microcents: rate,
            cost_source: source,
        };
        check_component_bounds(&component)?;
        components.push(component);
        sort_orders.push(
            row.try_get("sort_order")
                .map_err(|e| format!("decode sort_order: {e}"))?,
        );
    }

    if !uncosted.is_empty() {
        return Err(format!(
            "\"{product_name}\" cannot be sold right now: {} {} no cost on file, so its recipe \
             cost cannot be worked out. Receive {} on a purchase or an opening stock valuation, \
             or set a Manual Cost if {} not stocked. Greaz will not post a sale at a cost it \
             would have to guess.",
            uncosted.join(", "),
            if uncosted.len() == 1 { "has" } else { "have" },
            if uncosted.len() == 1 { "it" } else { "them" },
            if uncosted.len() == 1 { "it is" } else { "they are" },
        ));
    }

    check_recipe_bounds(components.len(), yield_base)?;
    let costed = recipe_cost(&components, yield_base)?;

    // `recipe_cost` returns its breakdown in the order it was given, so zipping
    // is an index join and not a guess. Asserted rather than assumed, because a
    // silent misalignment here would attach one ingredient's rate to another's
    // name in an immutable financial explanation.
    debug_assert_eq!(costed.components.len(), components.len());
    let evidence = components
        .iter()
        .zip(sort_orders.iter())
        .zip(costed.components.iter())
        .map(|((c, sort_order), breakdown)| {
            debug_assert_eq!(breakdown.component_product_id, c.component_product_id);
            PostedRecipeComponent {
                component_product_id: c.component_product_id.clone(),
                component_name_snapshot: c.component_name.clone(),
                uom_code: c.uom_code.clone(),
                quantity_num: c.quantity_num,
                quantity_den: c.quantity_den,
                factor_num_snapshot: c.factor_num,
                factor_den_snapshot: c.factor_den,
                waste_bps: c.waste_bps,
                unit_cost_excl_vat_microcents: c.unit_cost_excl_vat_microcents,
                cost_source: c.cost_source.as_str(),
                contribution_microcents: breakdown.contribution_microcents,
                sort_order: *sort_order,
            }
        })
        .collect();

    Ok(PostedRecipeCost {
        recipe_id,
        version,
        per_base_unit_microcents: costed.per_base_unit_microcents,
        components: evidence,
    })
}
