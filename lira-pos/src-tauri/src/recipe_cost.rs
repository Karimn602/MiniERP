//! Recipe cost arithmetic (WP-B2-A) — the authoritative implementation.
//!
//! WHAT THIS COMPUTES
//!
//! One number: the per-base-unit COGS RATE, in microcents, of a product built
//! from a recipe. It is the same kind of figure as
//! `products.avg_cost_excl_vat_microcents` and
//! `products.standard_cost_excl_vat_microcents`, so everything downstream —
//! `extended_cost_cents`, the `sale_items` snapshot, every margin report —
//! keeps working on it unchanged. Introducing a new costing method must change
//! what is WRITTEN at post time, never what is READ from history.
//!
//! EXCLUSIVE OF VAT, always. Every COGS figure any report in this application
//! reads is net, both component inputs are net, and there is no inclusive
//! sibling: deriving one would mean choosing a VAT rate for a cost with no
//! document behind it.
//!
//! `src/lib/recipeCost.ts` mirrors this file for the editor's live preview.
//! THIS file is the authority; the mirror exists because an editor that cannot
//! show a cost until it round-trips to Rust is not an editor. They are pinned
//! against each other by the shared fixtures in `recipe_cost::FIXTURES`, which
//! the TypeScript suite reads as literal expected values.
//!
//!
//! THE FORMULA
//!
//! For each component:
//!
//! ```text
//!   base quantity  = quantity_num/quantity_den * factor_num/factor_den
//!   consumed       = base quantity * (10_000 + waste_bps)/10_000
//!   contribution   = ingredient rate (microcents per base unit) * consumed
//! ```
//!
//! and for the recipe:
//!
//! ```text
//!   per-base-unit rate = (sum of contributions) / yield_quantity_base
//! ```
//!
//! None of that is evaluated in that order, because evaluating it in that
//! order would round a quantity before multiplying it by a rate — the GP-A03
//! defect, which is how $0.0025/g flour came to cost $0.00. Instead every
//! component collapses to ONE integer division:
//!
//! ```text
//!   contribution_acc = round( rate * q_num * f_num * (10_000 + waste) * ACC
//!                             / (q_den * f_den * 10_000) )
//!
//!   rate_microcents  = round( sum(contribution_acc) / (ACC * yield) )
//! ```
//!
//! `ACC` is an accumulator scale of 1,000,000: contributions are summed six
//! decimal digits finer than the microcent they will be reported in.
//!
//!
//! PRECISION, STATED EXACTLY RATHER THAN CLAIMED
//!
//! There are two rounding points, not one, and pretending otherwise would be
//! the kind of claim this codebase exists to avoid making:
//!
//!   1. each component's contribution is rounded to 1/ACC of a microcent;
//!   2. the final rate is rounded to a whole microcent.
//!
//! With at most [`MAX_COMPONENTS`] components, the total error introduced at
//! step 1 is bounded by `64 / 2_000_000` = 0.000032 microcents, against a
//! final unit of 1 microcent. It can therefore change the answer only if the
//! true value lies within 0.000032 of an exact half-microcent boundary — and
//! if it does, both answers are within half a microcent of the truth anyway.
//! For comparison, one microcent is one ten-thousandth of a cent.
//!
//! In the COMMON case step 1 does not round at all. When `waste_bps` is 0 and
//! both denominators are 1 the divisor is 10,000, the numerator carries a
//! factor of `ACC` = 1,000,000, and the division is exact. That is asserted,
//! not assumed: see `a_whole_quantity_recipe_rounds_nowhere_at_all`.
//!
//! Rounding is half away from zero, through `cost::div_round_half_away`, which
//! is the single rounding helper this whole application uses. All values here
//! are non-negative, so half away from zero and half up coincide.
//!
//!
//! THE OVERFLOW PROOF
//!
//! Every bound below is enforced BEFORE any multiplication, by
//! [`check_component_bounds`] and [`check_recipe_bounds`], and every
//! multiplication is additionally `checked_mul` so that a bound somebody
//! widens later fails loudly instead of wrapping. Migration 021 carries the
//! same bounds as CHECK constraints, so a row written by any other path is
//! inside the envelope too — except the ingredient RATE, which no CHECK on
//! `recipe_components` can see and which is therefore bounded here.
//!
//! | quantity | bound | why that bound |
//! |---|---|---|
//! | ingredient rate | [`MAX_RATE_MICROCENTS`] = 10^13 | $100,000 per base unit. A gram of anything a restaurant buys is many orders of magnitude below this. |
//! | `quantity_num`, `quantity_den` | 10^6 | a recipe quantity of a million units, or one millionth of a unit |
//! | `factor_num`, `factor_den` | 10^6 | matches the 021 CHECK; a tonne-to-gram conversion is 10^6 |
//! | `10_000 + waste_bps` | < 2 x 10^4 | `waste_bps < 10_000` (021 CHECK) |
//! | `ACC` | 10^6 | fixed constant |
//! | components | [`MAX_COMPONENTS`] = 64 | a recipe nobody can read is a different problem |
//! | `yield_quantity_base` | 10^6 | matches the 021 CHECK |
//!
//! Worst-case numerator at step 1:
//!
//! ```text
//!   10^13 * 10^6 * 10^6 * 2x10^4 * 10^6  =  2 x 10^35
//! ```
//!
//! against `i128::MAX` = 1.7 x 10^38 — a factor of 850 in hand. The divisor is
//! at least 10^4, so each `contribution_acc` is at most 2 x 10^31, and 64 of
//! them sum to at most 1.3 x 10^33: no addition can overflow either. The final
//! division by `ACC * yield` only shrinks the value, and its result is then
//! converted to `i64` with a checked conversion, so a recipe whose honest cost
//! genuinely exceeds `i64` is refused by name rather than wrapped.
//!
//! Anything outside the envelope is REJECTED with a message naming the field
//! and the limit. A silently clamped cost would be a wrong number that looks
//! like a right one, which is worse than a refusal in every case.

use crate::cost::div_round_half_away;

/// Contributions are accumulated this many times finer than a microcent.
pub const ACC: i64 = 1_000_000;

/// The most ingredients one recipe may hold.
pub const MAX_COMPONENTS: usize = 64;

/// The largest ingredient rate the arithmetic admits: $100,000 per base unit.
pub const MAX_RATE_MICROCENTS: i64 = 10_000_000_000_000;

/// The largest quantity numerator/denominator, conversion factor and yield.
/// Mirrors migration 021's CHECK constraints.
pub const MAX_QUANTITY_PART: i64 = 1_000_000;
pub const MAX_FACTOR_PART: i64 = 1_000_000;
pub const MAX_YIELD_BASE: i64 = 1_000_000;

/// Where one ingredient's cost rate came from.
///
/// Only two values, and that is the point: an ingredient is valued from its
/// purchases or from a cost its owner typed, and `'recipe'` is not reachable
/// because migration 021 refuses a recipe-costed ingredient outright (one
/// level of composition). A third value here would mean the one-level guard
/// had a hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentCostSource {
    PurchaseAverage,
    Standard,
}

impl ComponentCostSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ComponentCostSource::PurchaseAverage => "purchase_average",
            ComponentCostSource::Standard => "standard",
        }
    }
}

/// One ingredient line, already resolved against the database.
///
/// Nothing here is taken from a client: the quantity pair is what the command
/// parsed and reduced, the factor pair is the snapshot read from the
/// ingredient's own `product_uoms` row, and the rate was resolved from the
/// ingredient's own costing configuration.
#[derive(Debug, Clone)]
pub struct ResolvedComponent {
    pub component_product_id: String,
    pub component_name: String,
    pub quantity_num: i64,
    pub quantity_den: i64,
    pub uom_code: String,
    pub factor_num: i64,
    pub factor_den: i64,
    pub waste_bps: i64,
    /// Per-base-unit rate of the INGREDIENT, in microcents, excl VAT.
    pub unit_cost_excl_vat_microcents: i64,
    pub cost_source: ComponentCostSource,
}

/// What one ingredient contributes to one batch.
#[derive(Debug, Clone)]
pub struct ComponentCost {
    pub component_product_id: String,
    pub component_name: String,
    /// The contribution at accumulator scale — the figure that is summed.
    pub contribution_acc: i128,
    /// The same contribution as a microcent rate, rounded for display ONLY.
    /// Nothing sums these; the batch total sums `contribution_acc`.
    pub contribution_microcents: i64,
    pub cost_source: ComponentCostSource,
}

/// The cost of one recipe: the batch, the per-base-unit rate, and the
/// per-ingredient breakdown the editor shows.
#[derive(Debug, Clone)]
pub struct RecipeCost {
    /// Cost of ONE batch, in microcents per... nothing: it is a batch total,
    /// a rate multiplied by quantities, so it is an AMOUNT at microcent scale.
    pub batch_microcents: i64,
    /// The figure that matters: COGS rate per base unit of the recipe product.
    pub per_base_unit_microcents: i64,
    pub components: Vec<ComponentCost>,
}

fn bound(value: i64, max: i64, field: &str, what: &str) -> Result<(), String> {
    if value > max {
        return Err(format!(
            "Recipe arithmetic: {field} is {value}, above the supported limit of {max} ({what}). \
             Greaz refuses a figure outside the range its arithmetic is proven for rather than \
             computing a cost it cannot stand behind."
        ));
    }
    Ok(())
}

/// Reject a component outside the admissible envelope, BEFORE multiplying.
pub fn check_component_bounds(c: &ResolvedComponent) -> Result<(), String> {
    if c.quantity_num < 1 || c.quantity_den < 1 {
        return Err(format!(
            "Recipe arithmetic: \"{}\" has a quantity of {}/{} {}; both parts must be at least 1.",
            c.component_name, c.quantity_num, c.quantity_den, c.uom_code
        ));
    }
    if c.factor_num < 1 || c.factor_den < 1 {
        return Err(format!(
            "Recipe arithmetic: \"{}\" has a unit conversion of {}/{}; both parts must be at \
             least 1.",
            c.component_name, c.factor_num, c.factor_den
        ));
    }
    if c.waste_bps < 0 || c.waste_bps >= 10_000 {
        return Err(format!(
            "Recipe arithmetic: \"{}\" has a waste of {} basis points; it must be at least 0 and \
             below 10000 (100%).",
            c.component_name, c.waste_bps
        ));
    }
    if c.unit_cost_excl_vat_microcents < 0 {
        return Err(format!(
            "Recipe arithmetic: \"{}\" has a negative cost rate.",
            c.component_name
        ));
    }
    bound(c.quantity_num, MAX_QUANTITY_PART, "a recipe quantity", "numerator")?;
    bound(c.quantity_den, MAX_QUANTITY_PART, "a recipe quantity", "denominator")?;
    bound(c.factor_num, MAX_FACTOR_PART, "a unit conversion", "numerator")?;
    bound(c.factor_den, MAX_FACTOR_PART, "a unit conversion", "denominator")?;
    bound(
        c.unit_cost_excl_vat_microcents,
        MAX_RATE_MICROCENTS,
        "an ingredient cost rate",
        "microcents per base unit",
    )?;
    Ok(())
}

/// Reject a recipe shape outside the admissible envelope.
pub fn check_recipe_bounds(
    component_count: usize,
    yield_quantity_base: i64,
) -> Result<(), String> {
    if component_count == 0 {
        return Err("A recipe needs at least one ingredient.".to_string());
    }
    if component_count > MAX_COMPONENTS {
        return Err(format!(
            "A recipe may hold at most {MAX_COMPONENTS} ingredients; this one has \
             {component_count}."
        ));
    }
    if yield_quantity_base < 1 {
        return Err("A recipe's batch yield must be at least 1.".to_string());
    }
    bound(yield_quantity_base, MAX_YIELD_BASE, "a batch yield", "base units")?;
    Ok(())
}

/// Do two rational conversions describe the SAME factor?
///
/// `1000/1` and `2000/2` are one conversion: a kilogram is a thousand grams
/// however the row spells it, and the physical quantity a recipe states is
/// unchanged by a rewrite that cancels. So the test is EQUIVALENCE, not
/// equality of the stored parts — comparing `factor_num` and `factor_den`
/// pairwise rejected a draft whose ingredient's unit had been rewritten to an
/// equal value, told the operator their quantities no longer meant what they
/// did, and asked them to re-save a recipe that had not changed.
///
/// Cross-multiplied in `i128` with `checked_mul`, never divided: a quotient
/// comparison would make `1/3` and `100_000/300_000` agree or disagree
/// depending on the arithmetic rather than on the data, and a division would
/// have to round. Both products are at most 10^12 under migration 021's
/// CHECKs, so the multiply cannot overflow within the admissible envelope and
/// `checked_mul` is the proof rather than the hope.
pub fn same_conversion(
    a_num: i64,
    a_den: i64,
    b_num: i64,
    b_den: i64,
) -> Result<bool, String> {
    if a_num < 1 || a_den < 1 || b_num < 1 || b_den < 1 {
        return Err(format!(
            "Conversion comparison: {a_num}/{a_den} and {b_num}/{b_den} must both be positive \
             fractions."
        ));
    }
    let left = (a_num as i128)
        .checked_mul(b_den as i128)
        .ok_or_else(|| format!("Conversion comparison overflows: {a_num} x {b_den}."))?;
    let right = (b_num as i128)
        .checked_mul(a_den as i128)
        .ok_or_else(|| format!("Conversion comparison overflows: {b_num} x {a_den}."))?;
    Ok(left == right)
}

/// One ingredient's contribution to one batch, at accumulator scale.
fn contribution_acc(c: &ResolvedComponent) -> Result<i128, String> {
    let overflow = |stage: &str| {
        format!(
            "Recipe arithmetic for \"{}\" overflows at {stage}, even though every input is inside \
             the supported range. This is a bug, not a configuration problem.",
            c.component_name
        )
    };

    let numerator = (c.unit_cost_excl_vat_microcents as i128)
        .checked_mul(c.quantity_num as i128)
        .ok_or_else(|| overflow("rate x quantity"))?
        .checked_mul(c.factor_num as i128)
        .ok_or_else(|| overflow("x conversion"))?
        .checked_mul((10_000 + c.waste_bps) as i128)
        .ok_or_else(|| overflow("x waste"))?
        .checked_mul(ACC as i128)
        .ok_or_else(|| overflow("x accumulator scale"))?;

    let denominator = (c.quantity_den as i128)
        .checked_mul(c.factor_den as i128)
        .and_then(|v| v.checked_mul(10_000))
        .ok_or_else(|| overflow("the divisor"))?;

    div_round_half_away(numerator, denominator)
}

/// Narrow an `i128` to `i64`, refusing rather than wrapping.
fn to_i64(value: i128, what: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| {
        format!(
            "Recipe arithmetic: {what} is {value}, which does not fit the 64-bit column it would \
             be stored in. Check the ingredient costs and quantities."
        )
    })
}

/// THE function. Cost one recipe from its resolved components.
///
/// Every component is bounds-checked first, so no multiplication below can
/// overflow within the documented envelope — and each one is `checked_mul`
/// anyway, because a proof is only as good as the bounds it assumed.
pub fn recipe_cost(
    components: &[ResolvedComponent],
    yield_quantity_base: i64,
) -> Result<RecipeCost, String> {
    check_recipe_bounds(components.len(), yield_quantity_base)?;
    for c in components {
        check_component_bounds(c)?;
    }

    let mut batch_acc: i128 = 0;
    let mut breakdown: Vec<ComponentCost> = Vec::with_capacity(components.len());

    for c in components {
        let contribution = contribution_acc(c)?;
        batch_acc = batch_acc
            .checked_add(contribution)
            .ok_or_else(|| "Recipe arithmetic: the batch cost overflows.".to_string())?;
        breakdown.push(ComponentCost {
            component_product_id: c.component_product_id.clone(),
            component_name: c.component_name.clone(),
            contribution_acc: contribution,
            // Display only. The batch sums `contribution_acc`, never these.
            contribution_microcents: to_i64(
                div_round_half_away(contribution, ACC as i128)?,
                "an ingredient's contribution",
            )?,
            cost_source: c.cost_source,
        });
    }

    let batch_microcents = to_i64(
        div_round_half_away(batch_acc, ACC as i128)?,
        "the batch cost",
    )?;

    // The ONE division that produces the figure a sale would be costed at.
    let divisor = (ACC as i128)
        .checked_mul(yield_quantity_base as i128)
        .ok_or_else(|| "Recipe arithmetic: the yield divisor overflows.".to_string())?;
    let per_base_unit_microcents = to_i64(
        div_round_half_away(batch_acc, divisor)?,
        "the per-unit recipe cost",
    )?;

    Ok(RecipeCost {
        batch_microcents,
        per_base_unit_microcents,
        components: breakdown,
    })
}

// ============================================================================
// Shared fixtures — the contract between this file and its TypeScript mirror
// ============================================================================

/// A fixture the Rust tests and `tests/unit/recipeCost.test.ts` both assert.
///
/// Expressed as flat tuples so the TypeScript side can transcribe it literally
/// rather than parse it. Each component is
/// `(rate_microcents, q_num, q_den, f_num, f_den, waste_bps)`.
///
/// The figures are not round numbers by accident: a mirror that only ever
/// agrees on easy cases is not pinned to anything.
pub struct Fixture {
    pub name: &'static str,
    pub components: &'static [(i64, i64, i64, i64, i64, i64)],
    pub yield_base: i64,
    pub expect_batch_microcents: i64,
    pub expect_per_base_unit_microcents: i64,
}

pub const FIXTURES: &[Fixture] = &[
    // A Greaz burger, the case the whole work package exists for. A microcent
    // is a MILLIONTH OF A CENT, so $0.22 is 22,000,000 of them.
    //   bun     1 pcs   @ $0.22/pcs   = 22,000,000 mc
    //   patty 150 g     @ $0.0085/g   =    850,000 mc/g  -> 127,500,000 mc
    //   sauce  25 ml    @ $0.0012/ml  =    120,000 mc/ml ->   3,000,000 mc
    //   cheese  0.5 pcs @ $0.31/pcs   = 31,000,000 mc    ->  15,500,000 mc
    //                                          batch     -> 168,000,000 mc = $1.68
    Fixture {
        name: "greaz_burger",
        components: &[
            (22_000_000, 1, 1, 1, 1, 0),
            (850_000, 150, 1, 1, 1, 0),
            (120_000, 25, 1, 1, 1, 0),
            (31_000_000, 1, 2, 1, 1, 0),
        ],
        yield_base: 1,
        expect_batch_microcents: 168_000_000,
        expect_per_base_unit_microcents: 168_000_000,
    },
    // A sauce batch: oil at $0.001/ml consumed 500 ml at a time, filling 20
    // portions. 500 x 100,000 = 50,000,000 mc = $0.50 a batch, $0.025 a portion.
    Fixture {
        name: "sauce_batch_yield_20",
        components: &[(100_000, 500, 1, 1, 1, 0)],
        yield_base: 20,
        expect_batch_microcents: 50_000_000,
        expect_per_base_unit_microcents: 2_500_000,
    },
    // Waste. One onion at $0.40 with 12% trim loss:
    // 40,000,000 x 1.12 = 44,800,000 mc = $0.448.
    Fixture {
        name: "waste_12_percent",
        components: &[(40_000_000, 1, 1, 1, 1, 1_200)],
        yield_base: 1,
        expect_batch_microcents: 44_800_000,
        expect_per_base_unit_microcents: 44_800_000,
    },
    // A purchasing unit bigger than the base unit: the recipe says "2 boxes",
    // a box is 12 pcs, and the rate is per pcs.
    //   2 box x 12 = 24 pcs @ $0.017 = 40,800,000 mc = $0.408
    Fixture {
        name: "box_of_twelve",
        components: &[(1_700_000, 2, 1, 12, 1, 0)],
        yield_base: 1,
        expect_batch_microcents: 40_800_000,
        expect_per_base_unit_microcents: 40_800_000,
    },
    // Exact fractional accumulation: thirds and sevenths of $0.001, whose
    // per-component microcent values all have non-terminating expansions.
    //   100,000 x 1/3  =  33,333.333...
    //   100,000 x 1/7  =  14,285.714...
    //   100,000 x 20/7 = 285,714.285...
    //                    333,333.333...  -> 333,333
    Fixture {
        name: "thirds_and_sevenths",
        components: &[
            (100_000, 1, 3, 1, 1, 0),
            (100_000, 1, 7, 1, 1, 0),
            (100_000, 20, 7, 1, 1, 0),
        ],
        yield_base: 1,
        expect_batch_microcents: 333_333,
        expect_per_base_unit_microcents: 333_333,
    },
    // THE ROUNDING FIXTURE, and the reason the accumulator exists.
    //
    // A bun plus three pinches worth 0.4 microcents each. Rounding each
    // component to a whole microcent first loses all three pinches —
    // 22,000,000 + 0 + 0 + 0 — because each one rounds to zero on its own.
    // Accumulating at ACC scale and rounding once gives 22,000,001.2 ->
    // 22,000,001. The difference is a ten-thousandth of a cent on one plate,
    // which is the point: it is the shape of the GP-A03 defect, where rounding
    // a rate before multiplying it made $0.0025/g flour cost $0.00.
    //
    // `naive_per_component_rounding_gives_a_different_answer` asserts BOTH
    // answers, so the test fails if the implementation ever reverts to summing
    // rounded components.
    Fixture {
        name: "pinches_naive_rounding_loses",
        components: &[
            (22_000_000, 1, 1, 1, 1, 0),
            (2, 1, 5, 1, 1, 0),
            (2, 1, 5, 1, 1, 0),
            (2, 1, 5, 1, 1, 0),
        ],
        yield_base: 1,
        expect_batch_microcents: 22_000_001,
        expect_per_base_unit_microcents: 22_000_001,
    },
    // Sub-cent ingredient rates, the GP-A03 shape: flour at $2.50/kg stocked
    // in grams is $0.0025/g = 250,000 mc/g, and an eighth of a kilo of it must
    // not cost nothing.
    //   1/8 kg -> 1/8 x 1000/1 = 125 g @ 250,000 = 31,250,000 mc = $0.3125
    Fixture {
        name: "an_eighth_of_a_kilo",
        components: &[(250_000, 1, 8, 1_000, 1, 0)],
        yield_base: 1,
        expect_batch_microcents: 31_250_000,
        expect_per_base_unit_microcents: 31_250_000,
    },
    // A documented zero ingredient contributes exactly nothing and does not
    // make the recipe uncostable.
    Fixture {
        name: "documented_zero_component",
        components: &[(22_000_000, 1, 1, 1, 1, 0), (0, 3, 1, 1, 1, 0)],
        yield_base: 1,
        expect_batch_microcents: 22_000_000,
        expect_per_base_unit_microcents: 22_000_000,
    },
    // A yield that does not divide the batch evenly: $0.001 over 3 portions is
    // 33,333.33 microcents, rounded half away from zero to 33,333.
    Fixture {
        name: "yield_three_rounds_once",
        components: &[(100_000, 1, 1, 1, 1, 0)],
        yield_base: 3,
        expect_batch_microcents: 100_000,
        expect_per_base_unit_microcents: 33_333,
    },
];

/// Build a `ResolvedComponent` from a fixture tuple, for both test suites.
pub fn fixture_component(
    index: usize,
    t: (i64, i64, i64, i64, i64, i64),
) -> ResolvedComponent {
    ResolvedComponent {
        component_product_id: format!("fixture-component-{index}"),
        component_name: format!("Fixture ingredient {index}"),
        quantity_num: t.1,
        quantity_den: t.2,
        uom_code: "each".to_string(),
        factor_num: t.3,
        factor_den: t.4,
        waste_bps: t.5,
        unit_cost_excl_vat_microcents: t.0,
        cost_source: ComponentCostSource::PurchaseAverage,
    }
}
