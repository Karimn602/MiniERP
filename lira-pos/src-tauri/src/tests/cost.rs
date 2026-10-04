// Layer B — the fixed-point cost abstraction (WP-03, GP-A03).
//
// `crate::cost` is the only place in the application that scales, divides or
// rounds a unit cost, so these tests are the authority on:
//
//   * the scale and its exactness in both directions,
//   * the single rounding rule (half away from zero),
//   * the no-early-rounding property that GP-A03 is about,
//   * and the overflow boundaries, which must ERROR rather than wrap.
//
// `src/lib/cost.ts` holds the TypeScript mirror of these cases; the two must
// agree value for value, which `tests/unit/cost.test.ts` restates.

use crate::cost::{
    cents_to_microcents, div_round_half_away, extended_cost_cents, microcents_to_cents,
    new_weighted_avg, restock_weighted_avg, unit_cost_in_uom_to_base_microcents, COST_SCALE,
};

/// Factors used throughout: 1 kg = 1000 g, 1 box = 12 each, 1 L = 1000 ml.
const KG_IN_GRAMS: (i64, i64) = (1000, 1);
const BOX_OF_12: (i64, i64) = (12, 1);

fn to_base(cost_per_uom_cents: i64, factor: (i64, i64)) -> i64 {
    unit_cost_in_uom_to_base_microcents(cost_per_uom_cents, factor.0, factor.1).unwrap()
}

// ============================================================================
// The scale itself
// ============================================================================

#[test]
fn the_scale_is_one_million_microcents_per_cent() {
    // Stated as a test because every persisted cost value, the migration's
    // backfill and the TypeScript mirror all depend on this exact number.
    assert_eq!(COST_SCALE, 1_000_000);
}

#[test]
fn whole_cents_convert_to_microcents_exactly_and_back() {
    for cents in [0, 1, 7, 200, 237, 1_999, 123_456, 9_999_999] {
        let mc = cents_to_microcents(cents).unwrap();
        assert_eq!(mc, cents * COST_SCALE);
        assert_eq!(
            microcents_to_cents(mc).unwrap(),
            cents,
            "a whole-cent cost must round-trip unchanged"
        );
    }
}

#[test]
fn converting_to_cents_rounds_half_away_from_zero() {
    // 0.5 of a cent rounds up, 0.49 down — the same rule the money layer uses.
    assert_eq!(microcents_to_cents(COST_SCALE / 2).unwrap(), 1);
    assert_eq!(microcents_to_cents(COST_SCALE / 2 - 1).unwrap(), 0);
    assert_eq!(microcents_to_cents(3 * COST_SCALE / 2).unwrap(), 2);
    assert_eq!(microcents_to_cents(-(COST_SCALE / 2)).unwrap(), -1);
    // And a sub-cent rate rounds to nothing, which is exactly why the rounded
    // mirror is display-only and never a costing basis.
    assert_eq!(microcents_to_cents(250_000).unwrap(), 0);
}

#[test]
fn the_rounding_helper_is_half_away_from_zero_for_odd_and_even_divisors() {
    assert_eq!(div_round_half_away(1, 2).unwrap(), 1); // 0.5  -> 1
    assert_eq!(div_round_half_away(-1, 2).unwrap(), -1); // -0.5 -> -1
    assert_eq!(div_round_half_away(1, 3).unwrap(), 0); // 0.33 -> 0
    assert_eq!(div_round_half_away(2, 3).unwrap(), 1); // 0.67 -> 1
    assert_eq!(div_round_half_away(3, 2).unwrap(), 2); // 1.5  -> 2
    assert_eq!(div_round_half_away(5, 2).unwrap(), 3); // 2.5  -> 3
    assert_eq!(div_round_half_away(2, 5).unwrap(), 0); // 0.4  -> 0
    assert_eq!(div_round_half_away(3, 5).unwrap(), 1); // 0.6  -> 1
    assert_eq!(div_round_half_away(0, 7).unwrap(), 0);
    // A non-positive divisor is a caller bug, not a value to guess at.
    assert!(div_round_half_away(1, 0).is_err());
    assert!(div_round_half_away(1, -2).is_err());
}

// ============================================================================
// REQUIRED TEST 1 — a fractional base-unit cost survives
// ============================================================================

#[test]
fn a_sub_cent_per_base_cost_survives_the_uom_conversion() {
    // $2.50/kg stocked in grams. The old cents-only conversion gave 0.
    assert_eq!(to_base(250, KG_IN_GRAMS), 250_000); // $0.0025/g
    // $3.00/L consumed in ml.
    assert_eq!(to_base(300, KG_IN_GRAMS), 300_000); // $0.0030/ml
    // A gram of something that costs 1 cent per kilo is still not free.
    assert_eq!(to_base(1, KG_IN_GRAMS), 1_000);
    // Nor is a millilitre of $0.20-per-1000-litre water: 20 ¢ / 1,000,000 ml.
    assert_eq!(to_base(20, (1_000_000, 1)), 20);
}

#[test]
fn the_derived_rate_still_accounts_for_the_whole_invoice() {
    // The point of keeping the fraction: 20 kg at $2.50/kg is $50.00, and
    // 20,000 g at the derived per-gram rate is the same $50.00 to the cent.
    let per_gram = to_base(250, KG_IN_GRAMS);
    assert_eq!(extended_cost_cents(per_gram, 20_000).unwrap(), 5_000);
    // Whereas the rate rounded to cents first accounts for nothing at all.
    let rounded_first = microcents_to_cents(per_gram).unwrap();
    assert_eq!(rounded_first * 20_000, 0);
}

// ============================================================================
// REQUIRED TEST 6 — whole-cent costs behave exactly as before
// ============================================================================

#[test]
fn an_ordinary_whole_cent_cost_is_unchanged_by_the_new_precision() {
    // $24.00 per box of 12 is $2.00 each, as it always was.
    assert_eq!(to_base(2_400, BOX_OF_12), 200 * COST_SCALE);
    assert_eq!(microcents_to_cents(to_base(2_400, BOX_OF_12)).unwrap(), 200);
    // A base-UoM line (factor 1/1) is the identity.
    assert_eq!(to_base(500, (1, 1)), 500 * COST_SCALE);
    // And the extended cost is the plain multiplication it used to be.
    assert_eq!(extended_cost_cents(200 * COST_SCALE, 7).unwrap(), 1_400);
    assert_eq!(extended_cost_cents(0, 7).unwrap(), 0);
}

#[test]
fn a_conversion_that_does_not_divide_evenly_rounds_once_at_microcent_scale() {
    // $10.00 per box of 3: $3.333…/each. In microcents that is 333,333 (⅓ of a
    // cent resolved to six places), not the 333 cents the old conversion gave.
    assert_eq!(to_base(1_000, (3, 1)), 333_333_333);
    // Three of them come back to the $10.00 that was spent.
    assert_eq!(extended_cost_cents(333_333_333, 3).unwrap(), 1_000);
}

// ============================================================================
// REQUIRED TEST 5 — no early rounding
// ============================================================================

#[test]
fn rounding_the_unit_cost_first_is_not_the_same_as_rounding_the_extended_cost() {
    // The defect in one assertion. A 500 g sale of $2.50/kg flour:
    let per_gram = to_base(250, KG_IN_GRAMS); // 250_000 microcents
    let correct = extended_cost_cents(per_gram, 500).unwrap();
    let early_rounded = microcents_to_cents(per_gram).unwrap() * 500;

    assert_eq!(correct, 125, "500 g at $0.0025/g is $1.25");
    assert_eq!(early_rounded, 0, "the same cost, rounded first, is nothing");
    assert_ne!(correct, early_rounded);
}

#[test]
fn early_rounding_also_overstates_cost_when_the_fraction_rounds_up() {
    // The error is not one-directional. $0.016/unit (1,600,000 microcents, i.e.
    // 1.6 cents) rounds up to 2 cents, so rounding the rate first OVERstates a
    // 1,000-unit line by 25%.
    let unit = 1_600_000;
    assert_eq!(extended_cost_cents(unit, 1_000).unwrap(), 1_600);
    assert_eq!(microcents_to_cents(unit).unwrap() * 1_000, 2_000);
}

// ============================================================================
// REQUIRED TEST 2 — weighted average at the new precision
// ============================================================================

#[test]
fn the_weighted_average_of_two_fractional_costs_is_exact() {
    // 10 kg of flour at $2.50/kg, then 10 kg at $3.10/kg, stocked in grams:
    //   10,000 g @ 250,000 µ¢ + 10,000 g @ 310,000 µ¢ over 20,000 g
    //   = $0.0028/g, the true midpoint.
    let first = to_base(250, KG_IN_GRAMS);
    let second = to_base(310, KG_IN_GRAMS);
    let avg = new_weighted_avg(10_000, first, 10_000, second).unwrap();
    assert_eq!(avg, 280_000);
    // The pool is worth the $56.00 that was actually paid.
    assert_eq!(extended_cost_cents(avg, 20_000).unwrap(), 5_600);
}

#[test]
fn awkward_quantities_and_repeated_purchases_do_not_drift() {
    // Three receipts at prices that do not divide evenly, in grams.
    let mut qty = 0i64;
    let mut avg = 0i64;
    let mut paid = 0i64;
    for (kg, price_per_kg) in [(7i64, 233i64), (3, 419), (11, 177)] {
        let grams = kg * 1_000;
        let rate = to_base(price_per_kg, KG_IN_GRAMS);
        avg = new_weighted_avg(qty, avg, grams, rate).unwrap();
        qty += grams;
        paid += price_per_kg * kg;
    }
    assert_eq!(qty, 21_000);
    assert_eq!(paid, 7 * 233 + 3 * 419 + 11 * 177); // $46.07
    // The average still values the whole pool at what was paid for it, to the
    // cent. Rounding each receipt to cents would have lost all of it.
    assert_eq!(extended_cost_cents(avg, qty).unwrap(), paid);
}

#[test]
fn different_purchase_uoms_blend_on_a_common_base() {
    // 1 kg bought by the kilo, then 500 g bought by the gram, same base.
    let by_kilo = to_base(300, KG_IN_GRAMS); // $3.00/kg -> 300,000 µ¢/g
    let by_gram = to_base(1, (1, 1)); // $0.01/g  -> 1,000,000 µ¢/g
    let avg = new_weighted_avg(1_000, by_kilo, 500, by_gram).unwrap();
    // (1000 x 300,000 + 500 x 1,000,000) / 1500 = 533,333.33 -> 533,333
    assert_eq!(avg, 533_333);
    // $3.00 + $5.00 = $8.00 of stock, recovered to the cent.
    assert_eq!(extended_cost_cents(avg, 1_500).unwrap(), 800);
}

#[test]
fn a_purchase_into_empty_stock_takes_the_incoming_fractional_cost_outright() {
    let rate = to_base(250, KG_IN_GRAMS);
    assert_eq!(new_weighted_avg(0, 0, 20_000, rate).unwrap(), rate);
    // The zero-stock transition does not depend on the old average's value.
    assert_eq!(new_weighted_avg(0, 999_999, 20_000, rate).unwrap(), rate);
}

#[test]
fn restocking_at_the_current_fractional_average_leaves_it_untouched() {
    let rate = to_base(733, KG_IN_GRAMS); // $0.00733/g
    assert_eq!(new_weighted_avg(40_000, rate, 60_000, rate).unwrap(), rate);
}

#[test]
fn a_purchase_that_clears_negative_stock_blends_against_the_deficit() {
    // Negative stock is reachable when a store allows overselling. Topping it up
    // is still a weighted average over the resulting positive pool; only the
    // sign of the opening quantity differs. Policy is unchanged — this test
    // records what it is.
    let avg = new_weighted_avg(-1_000, 300_000, 3_000, 400_000).unwrap();
    // (-1000 x 300,000 + 3000 x 400,000) / 2000 = 450,000
    assert_eq!(avg, 450_000);
    // A top-up too small to clear the deficit has no pool to average over.
    assert!(new_weighted_avg(-3_000, 300_000, 1_000, 400_000).is_err());
}

// ============================================================================
// REQUIRED TEST 11 — overflow and checked arithmetic
// ============================================================================

#[test]
fn an_unrealistic_unit_cost_errors_instead_of_wrapping() {
    // A cost whose microcent form exceeds i64 (~$92.2 billion per base unit).
    assert!(cents_to_microcents(i64::MAX / 1_000).is_err());
    assert!(unit_cost_in_uom_to_base_microcents(i64::MAX, 1, 1).is_err());
    // A nonsense factor is refused rather than dividing by zero.
    assert!(unit_cost_in_uom_to_base_microcents(100, 0, 1).is_err());
    assert!(unit_cost_in_uom_to_base_microcents(100, 1, 0).is_err());
    assert!(unit_cost_in_uom_to_base_microcents(100, -12, 1).is_err());
}

#[test]
fn an_unrealistic_extended_cost_errors_instead_of_wrapping() {
    assert!(extended_cost_cents(i64::MAX, i64::MAX).is_err());
    assert!(extended_cost_cents(i64::MAX, 1_000_000_000).is_err());
    // The largest honest case still works: ~$92.2bn per unit, one unit.
    assert_eq!(
        extended_cost_cents(i64::MAX, 1).unwrap(),
        i64::MAX / COST_SCALE + 1 // + 1 because the remainder rounds up
    );
}

#[test]
fn an_inventory_value_that_cannot_be_represented_errors() {
    // The boundary is the POOL's value, not just the average it divides down
    // to: an inventory worth more than i64 microcents (~$92.2 billion) is
    // refused rather than silently wrapped into a plausible-looking average.
    assert!(new_weighted_avg(2, i64::MAX, 1, 1).is_err());
    assert!(new_weighted_avg(1, 1, 2, i64::MAX).is_err());
    assert!(new_weighted_avg(i64::MAX, 2, 1, 1).is_err());
    // Just inside it, the arithmetic is exact.
    assert_eq!(new_weighted_avg(1, i64::MAX - 1, 1, 0).unwrap(), i64::MAX / 2);
}

#[test]
fn a_purchase_cannot_leave_an_empty_pool_to_average_over() {
    assert!(new_weighted_avg(0, 100, 0, 100).is_err());
    assert!(new_weighted_avg(10, 100, -10, 100).is_err());
}

// ============================================================================
// restock_weighted_avg — the cost side of a sales return (WP-06)
// ============================================================================
//
// Returned stock re-enters the pool at the rate it LEFT at, which is an
// ordinary weighted average. What makes it its own function is the state it
// can meet: the POS permits selling below zero, so a return can arrive into a
// pool that is still short, and two of those states have no honest answer.

#[test]
fn a_restock_is_an_ordinary_weighted_average_when_the_pool_is_sound() {
    // 98 units at $2.00, two coming back at the same $2.00 — nothing moves.
    assert_eq!(
        restock_weighted_avg(98, 200_000_000, 2, 200_000_000).unwrap(),
        Some(200_000_000)
    );
    // Cheaper units coming back pull the average down, at full precision.
    assert_eq!(
        restock_weighted_avg(100, 220_000_000, 10, 200_000_000).unwrap(),
        Some(218_181_818)
    );
    // And it agrees, value for value, with the purchase-side average: a
    // restock is not a second costing rule.
    assert_eq!(
        restock_weighted_avg(100, 220_000_000, 10, 200_000_000).unwrap(),
        Some(new_weighted_avg(100, 220_000_000, 10, 200_000_000).unwrap())
    );
}

#[test]
fn a_restock_into_an_empty_pool_takes_the_returned_cost() {
    // Everything was sold; the units that come back are the whole pool.
    assert_eq!(
        restock_weighted_avg(0, 999_999_999, 5, 250_000).unwrap(),
        Some(250_000)
    );
}

#[test]
fn a_restock_that_leaves_the_pool_still_short_forms_no_average() {
    // 30 units short, 10 come back: still 20 short. Dividing a value by a
    // non-positive quantity is not a cost, so there is no average to write —
    // the caller adds the quantity and leaves the existing rate standing.
    assert_eq!(restock_weighted_avg(-30, 200_000_000, 10, 200_000_000).unwrap(), None);
    // Exactly zero is still not a pool.
    assert_eq!(restock_weighted_avg(-10, 200_000_000, 10, 200_000_000).unwrap(), None);
    // One more unit and it is.
    assert_eq!(
        restock_weighted_avg(-9, 200_000_000, 10, 200_000_000).unwrap(),
        Some(200_000_000)
    );
}

#[test]
fn a_restock_that_would_value_the_pool_below_nothing_forms_no_average() {
    // A short pool carrying a high average, plus a few cheap units back:
    // (-5 x 1,000,000 + 10 x 1,000) / 5 is negative. `products.avg_cost_*` is
    // CHECK (>= 0), rightly — no inventory costs less than nothing.
    assert_eq!(restock_weighted_avg(-5, 1_000_000, 10, 1_000).unwrap(), None);
    // Reachable ONLY from a negative pool: with a non-negative one both terms
    // of the value are non-negative, so the average cannot be.
    for old_qty in [0, 1, 100] {
        assert!(
            restock_weighted_avg(old_qty, 0, 1, 0).unwrap().is_some(),
            "a sound pool always yields an average"
        );
    }
}

#[test]
fn a_restock_refuses_a_nonsensical_request_rather_than_guessing() {
    // A return of nothing, or of a negative quantity, is a programming error
    // in the caller — not a state with an answer.
    assert!(restock_weighted_avg(10, 100, 0, 100).is_err());
    assert!(restock_weighted_avg(10, 100, -1, 100).is_err());
    // A negative cost rate likewise.
    assert!(restock_weighted_avg(10, 100, 1, -1).is_err());
    // Overflow errors rather than wrapping, exactly as the purchase side does.
    assert!(restock_weighted_avg(2, i64::MAX, 1, 1).is_err());
}
