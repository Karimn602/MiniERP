/**
 * Unit-cost fixed-point arithmetic (WP-03, GP-A03).
 *
 * `src/lib/cost.ts` is the TypeScript mirror of `src-tauri/src/cost.rs`. The
 * Rust side is authoritative for every persisted value, so the job of these
 * tests is twofold:
 *
 *   1. the helpers are correct on their own terms, and
 *   2. they produce the SAME numbers as the Rust tests in
 *      `src-tauri/src/tests/cost.rs`, case for case — if the two ever disagree
 *      the UI shows one cost and the database stores another.
 *
 * Each block below names the Rust test it mirrors.
 */
import { describe, expect, it } from "vitest";
import {
  COST_SCALE,
  centsToMicrocents,
  divRoundHalfAway,
  extendedCostCents,
  formatUnitCostUsd,
  microcentsToCents,
  newWeightedAvgMicrocents,
  restockWeightedAvgMicrocents,
  unitCostInBaseToUomMicrocents,
  unitCostInUomToBaseMicrocents,
} from "../../src/lib/cost";
import type { Factor } from "../../src/lib/uom";

const KG_IN_GRAMS: Factor = { num: 1000, den: 1 };
const BOX_OF_12: Factor = { num: 12, den: 1 };
const BASE: Factor = { num: 1, den: 1 };

/** $0.0025 per gram — the per-base rate of $2.50/kg. */
const FLOUR_PER_GRAM = 250_000;

describe("the scale", () => {
  // Mirrors `the_scale_is_one_million_microcents_per_cent`.
  it("is one million microcents per cent, in both languages", () => {
    expect(COST_SCALE).toBe(1_000_000);
  });

  // Mirrors `whole_cents_convert_to_microcents_exactly_and_back`.
  it("converts whole cents exactly, and back unchanged", () => {
    for (const cents of [0, 1, 7, 200, 237, 1_999, 123_456, 9_999_999]) {
      const mc = centsToMicrocents(cents);
      expect(mc).toBe(cents * COST_SCALE);
      expect(microcentsToCents(mc)).toBe(cents);
    }
  });

  // Mirrors `converting_to_cents_rounds_half_away_from_zero`.
  it("rounds to cents half away from zero", () => {
    expect(microcentsToCents(COST_SCALE / 2)).toBe(1);
    expect(microcentsToCents(COST_SCALE / 2 - 1)).toBe(0);
    expect(microcentsToCents((3 * COST_SCALE) / 2)).toBe(2);
    expect(microcentsToCents(-(COST_SCALE / 2))).toBe(-1);
    // A sub-cent rate rounds to nothing, which is why the cents mirror is for
    // display and never for costing.
    expect(microcentsToCents(FLOUR_PER_GRAM)).toBe(0);
  });

  // Mirrors `the_rounding_helper_is_half_away_from_zero_for_odd_and_even_divisors`.
  it("has one rounding helper, half away from zero, for odd and even divisors", () => {
    expect(divRoundHalfAway(1n, 2n)).toBe(1n);
    expect(divRoundHalfAway(-1n, 2n)).toBe(-1n);
    expect(divRoundHalfAway(1n, 3n)).toBe(0n);
    expect(divRoundHalfAway(2n, 3n)).toBe(1n);
    expect(divRoundHalfAway(3n, 2n)).toBe(2n);
    expect(divRoundHalfAway(5n, 2n)).toBe(3n);
    expect(divRoundHalfAway(2n, 5n)).toBe(0n);
    expect(divRoundHalfAway(3n, 5n)).toBe(1n);
    expect(divRoundHalfAway(0n, 7n)).toBe(0n);
    expect(() => divRoundHalfAway(1n, 0n)).toThrow();
    expect(() => divRoundHalfAway(1n, -2n)).toThrow();
  });

  it("rejects non-integer inputs rather than quietly truncating them", () => {
    expect(() => centsToMicrocents(1.5)).toThrow();
    expect(() => microcentsToCents(0.5)).toThrow();
    expect(() => extendedCostCents(250_000, 1.5)).toThrow();
  });
});

describe("GP-A03 — a fractional per-base cost survives the UoM conversion", () => {
  // Mirrors `a_sub_cent_per_base_cost_survives_the_uom_conversion`.
  it("keeps a sub-cent rate instead of rounding it to zero", () => {
    expect(unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS)).toBe(FLOUR_PER_GRAM);
    expect(unitCostInUomToBaseMicrocents(300, KG_IN_GRAMS)).toBe(300_000);
    expect(unitCostInUomToBaseMicrocents(1, KG_IN_GRAMS)).toBe(1_000);
    // A millilitre of $0.20-per-1000-litre water is 20 microcents, not nothing.
    expect(unitCostInUomToBaseMicrocents(20, { num: 1_000_000, den: 1 })).toBe(20);
  });

  // Mirrors `the_derived_rate_still_accounts_for_the_whole_invoice`.
  it("still accounts for the whole invoice", () => {
    const perGram = unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS);
    // 20 kg at $2.50/kg is $50.00, and so is 20,000 g at the derived rate.
    expect(extendedCostCents(perGram, 20_000)).toBe(5_000);
    // The same rate rounded to cents first accounts for nothing at all.
    expect(microcentsToCents(perGram) * 20_000).toBe(0);
  });

  // Mirrors `a_conversion_that_does_not_divide_evenly_rounds_once_at_microcent_scale`.
  it("rounds once, at microcent scale, when the conversion does not divide evenly", () => {
    expect(unitCostInUomToBaseMicrocents(1_000, { num: 3, den: 1 })).toBe(333_333_333);
    expect(extendedCostCents(333_333_333, 3)).toBe(1_000);
  });

  it("round-trips a rate back to its purchasing UoM", () => {
    expect(unitCostInBaseToUomMicrocents(FLOUR_PER_GRAM, KG_IN_GRAMS)).toBe(250 * COST_SCALE);
    for (const perBox of [12, 120, 1_200, 2_400, 99_996]) {
      const perPiece = unitCostInUomToBaseMicrocents(perBox, BOX_OF_12);
      expect(microcentsToCents(unitCostInBaseToUomMicrocents(perPiece, BOX_OF_12))).toBe(perBox);
    }
  });

  it("rejects a bad factor rather than dividing by zero", () => {
    expect(() => unitCostInUomToBaseMicrocents(100, { num: 0, den: 1 })).toThrow();
    expect(() => unitCostInUomToBaseMicrocents(100, { num: 1, den: 0 })).toThrow();
    expect(() => unitCostInUomToBaseMicrocents(100, { num: -12, den: 1 })).toThrow();
  });
});

describe("GP-A03 — no early rounding", () => {
  // Mirrors `rounding_the_unit_cost_first_is_not_the_same_as_rounding_the_extended_cost`.
  it("round(rate x qty) is not round(rate) x qty", () => {
    const perGram = unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS);
    const correct = extendedCostCents(perGram, 500);
    const earlyRounded = microcentsToCents(perGram) * 500;

    expect(correct).toBe(125); // 500 g at $0.0025/g is $1.25
    expect(earlyRounded).toBe(0); // the same cost, rounded first, is nothing
    expect(correct).not.toBe(earlyRounded);
  });

  // Mirrors `early_rounding_also_overstates_cost_when_the_fraction_rounds_up`.
  it("overstates as well as understates — the error is not one-directional", () => {
    const unit = 1_600_000; // $0.016/unit, i.e. 1.6 cents
    expect(extendedCostCents(unit, 1_000)).toBe(1_600);
    expect(microcentsToCents(unit) * 1_000).toBe(2_000);
  });
});

describe("whole-cent costs are unaffected", () => {
  // Mirrors `an_ordinary_whole_cent_cost_is_unchanged_by_the_new_precision`.
  it("gives the same answers the cents-only code gave", () => {
    expect(unitCostInUomToBaseMicrocents(2_400, BOX_OF_12)).toBe(200 * COST_SCALE);
    expect(microcentsToCents(unitCostInUomToBaseMicrocents(2_400, BOX_OF_12))).toBe(200);
    expect(unitCostInUomToBaseMicrocents(500, BASE)).toBe(500 * COST_SCALE);
    expect(extendedCostCents(200 * COST_SCALE, 7)).toBe(1_400);
    expect(extendedCostCents(0, 7)).toBe(0);
  });
});

describe("weighted average at the new precision", () => {
  // Mirrors `the_weighted_average_of_two_fractional_costs_is_exact`.
  it("blends two fractional costs exactly", () => {
    const first = unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS);
    const second = unitCostInUomToBaseMicrocents(310, KG_IN_GRAMS);
    const avg = newWeightedAvgMicrocents({
      oldQty: 10_000,
      oldAvgMicrocents: first,
      newQty: 10_000,
      newCostMicrocents: second,
    });
    expect(avg).toBe(280_000);
    expect(extendedCostCents(avg, 20_000)).toBe(5_600);
  });

  // Mirrors `awkward_quantities_and_repeated_purchases_do_not_drift`.
  it("does not drift across repeated purchases at awkward prices", () => {
    let qty = 0;
    let avg = 0;
    let paid = 0;
    for (const [kg, pricePerKg] of [
      [7, 233],
      [3, 419],
      [11, 177],
    ]) {
      const grams = kg * 1_000;
      avg = newWeightedAvgMicrocents({
        oldQty: qty,
        oldAvgMicrocents: avg,
        newQty: grams,
        newCostMicrocents: unitCostInUomToBaseMicrocents(pricePerKg, KG_IN_GRAMS),
      });
      qty += grams;
      paid += kg * pricePerKg;
    }
    expect(qty).toBe(21_000);
    expect(extendedCostCents(avg, qty)).toBe(paid);
  });

  // Mirrors `different_purchase_uoms_blend_on_a_common_base`.
  it("blends different purchase UoMs on the base unit", () => {
    const avg = newWeightedAvgMicrocents({
      oldQty: 1_000,
      oldAvgMicrocents: unitCostInUomToBaseMicrocents(300, KG_IN_GRAMS),
      newQty: 500,
      newCostMicrocents: unitCostInUomToBaseMicrocents(1, BASE),
    });
    expect(avg).toBe(533_333);
    expect(extendedCostCents(avg, 1_500)).toBe(800);
  });

  // Mirrors `a_purchase_into_empty_stock_takes_the_incoming_fractional_cost_outright`
  // and `restocking_at_the_current_fractional_average_leaves_it_untouched`.
  it("handles the zero-stock transition and an unchanged restock", () => {
    expect(
      newWeightedAvgMicrocents({
        oldQty: 0,
        oldAvgMicrocents: 0,
        newQty: 20_000,
        newCostMicrocents: FLOUR_PER_GRAM,
      }),
    ).toBe(FLOUR_PER_GRAM);
    expect(
      newWeightedAvgMicrocents({
        oldQty: 40_000,
        oldAvgMicrocents: 733_000,
        newQty: 60_000,
        newCostMicrocents: 733_000,
      }),
    ).toBe(733_000);
  });

  // Mirrors `a_purchase_that_clears_negative_stock_blends_against_the_deficit`.
  it("blends against a negative opening quantity, and refuses a pool it cannot average", () => {
    expect(
      newWeightedAvgMicrocents({
        oldQty: -1_000,
        oldAvgMicrocents: 300_000,
        newQty: 3_000,
        newCostMicrocents: 400_000,
      }),
    ).toBe(450_000);
    expect(() =>
      newWeightedAvgMicrocents({
        oldQty: -3_000,
        oldAvgMicrocents: 300_000,
        newQty: 1_000,
        newCostMicrocents: 400_000,
      }),
    ).toThrow();
  });

  // Mirrors `a_purchase_cannot_leave_an_empty_pool_to_average_over`.
  it("refuses a non-positive resulting quantity", () => {
    expect(() =>
      newWeightedAvgMicrocents({
        oldQty: 0,
        oldAvgMicrocents: 100,
        newQty: 0,
        newCostMicrocents: 100,
      }),
    ).toThrow();
    expect(() =>
      newWeightedAvgMicrocents({
        oldQty: 10,
        oldAvgMicrocents: 100,
        newQty: -10,
        newCostMicrocents: 100,
      }),
    ).toThrow();
  });
});

describe("overflow", () => {
  // Mirrors `an_unrealistic_unit_cost_errors_instead_of_wrapping` and friends.
  // The binding limit here is the double's 53-bit mantissa, which is tighter
  // than the i64 the column holds — so anything this accepts is storable, and
  // anything it would silently make inexact throws instead.
  it("throws rather than losing precision on an unrealistic cost", () => {
    expect(() => centsToMicrocents(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => extendedCostCents(Number.MAX_SAFE_INTEGER, 1_000_000_000)).toThrow();
    expect(() =>
      newWeightedAvgMicrocents({
        oldQty: 2,
        oldAvgMicrocents: Number.MAX_SAFE_INTEGER,
        newQty: 1,
        newCostMicrocents: 1,
      }),
    ).toThrow();
  });

  it("is exact right up to the boundary", () => {
    // 9,007,199,254 cents (~$90.07m) per base unit is the largest cost whose
    // microcent form is still an exact double.
    const biggest = Math.floor(Number.MAX_SAFE_INTEGER / COST_SCALE);
    expect(centsToMicrocents(biggest)).toBe(biggest * COST_SCALE);
    expect(microcentsToCents(centsToMicrocents(biggest))).toBe(biggest);
  });
});

describe("formatting a unit cost", () => {
  it("shows the ordinary whole-cent case with two decimals", () => {
    expect(formatUnitCostUsd(0)).toBe("$0.00");
    expect(formatUnitCostUsd(200 * COST_SCALE)).toBe("$2.00");
    expect(formatUnitCostUsd(237 * COST_SCALE)).toBe("$2.37");
    expect(formatUnitCostUsd(123_456 * COST_SCALE)).toBe("$1,234.56");
  });

  it("extends only as far as the cost actually carries, exactly", () => {
    expect(formatUnitCostUsd(FLOUR_PER_GRAM)).toBe("$0.0025"); // $2.50/kg per gram
    expect(formatUnitCostUsd(300_000)).toBe("$0.003");
    expect(formatUnitCostUsd(1_000)).toBe("$0.00001");
    expect(formatUnitCostUsd(20)).toBe("$0.0000002");
    expect(formatUnitCostUsd(1)).toBe("$0.00000001"); // one microcent
    expect(formatUnitCostUsd(333_333_333)).toBe("$3.33333333");
  });

  it("keeps the sign", () => {
    expect(formatUnitCostUsd(-FLOUR_PER_GRAM)).toBe("-$0.0025");
    expect(formatUnitCostUsd(-200 * COST_SCALE)).toBe("-$2.00");
  });

  it("is presentation only and rejects a non-integer", () => {
    expect(() => formatUnitCostUsd(0.5)).toThrow();
  });
});

// Mirrors `src-tauri/src/tests/cost.rs` › the `restock_weighted_avg` block.
describe("restockWeightedAvgMicrocents (WP-06)", () => {
  it("is an ordinary weighted average when the pool is sound", () => {
    expect(
      restockWeightedAvgMicrocents({
        oldQty: 98,
        oldAvgMicrocents: 200_000_000,
        returnedQty: 2,
        returnedCostMicrocents: 200_000_000,
      }),
    ).toBe(200_000_000);

    expect(
      restockWeightedAvgMicrocents({
        oldQty: 100,
        oldAvgMicrocents: 220_000_000,
        returnedQty: 10,
        returnedCostMicrocents: 200_000_000,
      }),
    ).toBe(218_181_818);

    // It is not a second costing rule: the same inputs through the purchase
    // side give the same answer.
    expect(
      restockWeightedAvgMicrocents({
        oldQty: 100,
        oldAvgMicrocents: 220_000_000,
        returnedQty: 10,
        returnedCostMicrocents: 200_000_000,
      }),
    ).toBe(
      newWeightedAvgMicrocents({
        oldQty: 100,
        oldAvgMicrocents: 220_000_000,
        newQty: 10,
        newCostMicrocents: 200_000_000,
      }),
    );
  });

  it("takes the returned cost when everything had been sold", () => {
    expect(
      restockWeightedAvgMicrocents({
        oldQty: 0,
        oldAvgMicrocents: 999_999_999,
        returnedQty: 5,
        returnedCostMicrocents: 250_000,
      }),
    ).toBe(250_000);
  });

  it("forms no average when the pool is still short", () => {
    // Dividing a value by a non-positive quantity is not a cost, so the caller
    // adds the quantity and leaves the existing rate standing.
    expect(
      restockWeightedAvgMicrocents({
        oldQty: -30,
        oldAvgMicrocents: 200_000_000,
        returnedQty: 10,
        returnedCostMicrocents: 200_000_000,
      }),
    ).toBeNull();
    expect(
      restockWeightedAvgMicrocents({
        oldQty: -10,
        oldAvgMicrocents: 200_000_000,
        returnedQty: 10,
        returnedCostMicrocents: 200_000_000,
      }),
    ).toBeNull();
    // One more unit and it is a pool again.
    expect(
      restockWeightedAvgMicrocents({
        oldQty: -9,
        oldAvgMicrocents: 200_000_000,
        returnedQty: 10,
        returnedCostMicrocents: 200_000_000,
      }),
    ).toBe(200_000_000);
  });

  it("forms no average that would value the pool below nothing", () => {
    // Reachable only from a negative pool. `avg_cost_*` is CHECK (>= 0).
    expect(
      restockWeightedAvgMicrocents({
        oldQty: -5,
        oldAvgMicrocents: 1_000_000,
        returnedQty: 10,
        returnedCostMicrocents: 1_000,
      }),
    ).toBeNull();
    for (const oldQty of [0, 1, 100]) {
      expect(
        restockWeightedAvgMicrocents({
          oldQty,
          oldAvgMicrocents: 0,
          returnedQty: 1,
          returnedCostMicrocents: 0,
        }),
      ).not.toBeNull();
    }
  });

  it("refuses a nonsensical request rather than guessing", () => {
    expect(() =>
      restockWeightedAvgMicrocents({
        oldQty: 10,
        oldAvgMicrocents: 100,
        returnedQty: 0,
        returnedCostMicrocents: 100,
      }),
    ).toThrow();
    expect(() =>
      restockWeightedAvgMicrocents({
        oldQty: 10,
        oldAvgMicrocents: 100,
        returnedQty: -1,
        returnedCostMicrocents: 100,
      }),
    ).toThrow();
    expect(() =>
      restockWeightedAvgMicrocents({
        oldQty: 10,
        oldAvgMicrocents: 100,
        returnedQty: 1,
        returnedCostMicrocents: -1,
      }),
    ).toThrow();
  });
});
