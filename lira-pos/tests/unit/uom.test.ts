import { describe, expect, it } from "vitest";
import {
  formatQty,
  fromBaseQty,
  fromBaseQtyWithRemainder,
  gcd,
  makeFactor,
  parseQuantityInput,
  resolvePriceForUom,
  toBaseQty,
  unitCostInBaseToUom,
  unitCostInUomToBase,
  type Factor,
} from "../../src/lib/uom";
import {
  extendedCostCents,
  microcentsToCents,
  unitCostInUomToBaseMicrocents,
} from "../../src/lib/cost";

const BASE: Factor = { num: 1, den: 1 };
const BOX_OF_12: Factor = { num: 12, den: 1 };
const KG_IN_GRAMS: Factor = { num: 1000, den: 1 };

describe("makeFactor / gcd", () => {
  it("reduces to lowest terms", () => {
    expect(makeFactor(1000, 500)).toEqual({ num: 2, den: 1 });
    expect(makeFactor(12, 8)).toEqual({ num: 3, den: 2 });
    expect(makeFactor(7)).toEqual({ num: 7, den: 1 });
  });

  it("computes gcd", () => {
    expect(gcd(12, 8)).toBe(4);
    expect(gcd(7, 13)).toBe(1);
    expect(gcd(0, 5)).toBe(5);
  });

  it("rejects zero, negative, and fractional factors", () => {
    for (const [n, d] of [
      [0, 1],
      [1, 0],
      [-12, 1],
      [12, -1],
      [1.5, 1],
      [1, 1.5],
    ]) {
      expect(() => makeFactor(n, d), `should reject ${n}/${d}`).toThrow();
    }
  });
});

describe("quantity conversion", () => {
  it("converts a derived UoM to base units exactly when the factor divides", () => {
    expect(toBaseQty(2, BOX_OF_12)).toBe(24);
    expect(toBaseQty(1, BOX_OF_12)).toBe(12);
    expect(toBaseQty(3, BASE)).toBe(3);
    expect(toBaseQty(2, KG_IN_GRAMS)).toBe(2000);
  });

  it("accepts a zero quantity", () => {
    expect(toBaseQty(0, BOX_OF_12)).toBe(0);
    expect(fromBaseQty(0, BOX_OF_12)).toBe(0);
  });

  it("stays exact at large quantities", () => {
    expect(toBaseQty(10_000, BOX_OF_12)).toBe(120_000);
    expect(fromBaseQty(120_000, BOX_OF_12)).toBe(10_000);
  });

  it("converts base units back to the display UoM", () => {
    expect(fromBaseQty(48, BOX_OF_12)).toBe(4);
    expect(fromBaseQty(1500, KG_IN_GRAMS)).toBe(2); // rounds; use the remainder form for exactness
  });

  it("rejects negative or fractional quantities", () => {
    expect(() => toBaseQty(-1, BOX_OF_12)).toThrow();
    expect(() => toBaseQty(1.5, BOX_OF_12)).toThrow();
    expect(() => fromBaseQty(-1, BOX_OF_12)).toThrow();
    expect(() => toBaseQty(1, { num: 0, den: 1 })).toThrow();
    expect(() => toBaseQty(1, { num: 1, den: 0 })).toThrow();
  });
});

describe("fromBaseQtyWithRemainder", () => {
  it("splits a base quantity into whole units plus loose remainder", () => {
    expect(fromBaseQtyWithRemainder(50, BOX_OF_12)).toEqual({ whole: 4, remainderBase: 2 });
    expect(fromBaseQtyWithRemainder(48, BOX_OF_12)).toEqual({ whole: 4, remainderBase: 0 });
    expect(fromBaseQtyWithRemainder(11, BOX_OF_12)).toEqual({ whole: 0, remainderBase: 11 });
    expect(fromBaseQtyWithRemainder(0, BOX_OF_12)).toEqual({ whole: 0, remainderBase: 0 });
  });

  it("never loses a unit: whole × factor + remainder = base", () => {
    for (const base of [0, 1, 11, 12, 13, 47, 48, 49, 1_000, 99_999]) {
      const { whole, remainderBase } = fromBaseQtyWithRemainder(base, BOX_OF_12);
      expect(whole * 12 + remainderBase).toBe(base);
    }
  });
});

describe("cost conversion between UoMs", () => {
  it("converts a per-box cost to a per-unit cost exactly when it divides", () => {
    expect(unitCostInUomToBase(2400, BOX_OF_12)).toBe(200); // $24.00/box → $2.00/unit
    expect(unitCostInUomToBase(1200, BOX_OF_12)).toBe(100);
    expect(unitCostInUomToBase(500, BASE)).toBe(500);
  });

  it("converts back to the purchase UoM", () => {
    expect(unitCostInBaseToUom(200, BOX_OF_12)).toBe(2400);
    expect(unitCostInBaseToUom(500, BASE)).toBe(500);
  });

  it("round-trips whole-unit costs without drift", () => {
    for (const perBox of [12, 120, 1200, 2400, 99_996]) {
      expect(unitCostInBaseToUom(unitCostInUomToBase(perBox, BOX_OF_12), BOX_OF_12)).toBe(perBox);
    }
  });

  it("rejects negative costs and bad factors", () => {
    expect(() => unitCostInUomToBase(-1, BOX_OF_12)).toThrow();
    expect(() => unitCostInUomToBase(100, { num: 1, den: 0 })).toThrow();
  });

  // ---------------------------------------------------------------------
  // GP-A03 — fractional base-unit cost precision.  Fixed in WP-03.
  //
  // Was: a per-base cost below one cent could not be represented, because
  // every cost column — and this helper — was INTEGER USD cents. Buying flour
  // at $2.50/kg with a base UoM of grams collapsed to $0.00/g and all
  // downstream COGS was zero.
  //
  // Now: the purchase path converts at MICROCENT precision, via
  // `lib/cost.ts::unitCostInUomToBaseMicrocents`, and `purchaseMath` derives
  // the cents figure from that for display. So the assertion moves to the
  // helper that is actually on the accounting path, and tightens from "greater
  // than zero" to the exact rate — at the new precision, being non-zero is no
  // longer the interesting part. `unitCostInUomToBase` keeps its old
  // cents-rounding behaviour, which the test below pins deliberately: that
  // behaviour is now presentation, which is why it is no longer what anything
  // costs from.
  //
  // The Rust twin is
  // `known_defects::gp_a03_fractional_base_unit_costs_must_survive_conversion`;
  // the full microcent suite is `tests/unit/cost.test.ts` and
  // `src-tauri/src/tests/cost.rs`.
  // ---------------------------------------------------------------------
  it("GP-A03: preserves sub-cent per-base costs", () => {
    expect(unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS)).toBeGreaterThan(0);
    expect(unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS)).toBe(250_000); // $0.0025/g
    // 20 kg of it is still the $50.00 that was spent.
    expect(extendedCostCents(unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS), 20_000)).toBe(5_000);
  });

  it("GP-A03: the cents-rounding conversion is kept, and is why it is display only", () => {
    expect(unitCostInUomToBase(250, KG_IN_GRAMS)).toBe(0);
    expect(microcentsToCents(unitCostInUomToBaseMicrocents(250, KG_IN_GRAMS))).toBe(0);
  });
});

describe("resolvePriceForUom", () => {
  const base = { basePriceExclVatCents: 450, basePriceInclVatCents: 500 };

  it("prefers an explicit per-UoM override over the derived price", () => {
    expect(
      resolvePriceForUom({
        ...base,
        uomOverrideExclVatCents: 4500,
        uomOverrideInclVatCents: 5000,
        factor: BOX_OF_12,
      }),
    ).toEqual({ exclVatCents: 4500, inclVatCents: 5000 });
  });

  it("derives from the base price when no override is set", () => {
    expect(
      resolvePriceForUom({
        ...base,
        uomOverrideExclVatCents: null,
        uomOverrideInclVatCents: null,
        factor: BOX_OF_12,
      }),
    ).toEqual({ exclVatCents: 5400, inclVatCents: 6000 });
  });

  it("derives when only one half of the override is present", () => {
    // Both must be set for the override to apply; a half-configured UoM
    // falls back rather than mixing an override with a derived figure.
    expect(
      resolvePriceForUom({
        ...base,
        uomOverrideExclVatCents: 4500,
        uomOverrideInclVatCents: null,
        factor: BOX_OF_12,
      }),
    ).toEqual({ exclVatCents: 5400, inclVatCents: 6000 });
  });

  it("is a no-op at the base UoM", () => {
    expect(
      resolvePriceForUom({
        ...base,
        uomOverrideExclVatCents: null,
        uomOverrideInclVatCents: null,
        factor: BASE,
      }),
    ).toEqual({ exclVatCents: 450, inclVatCents: 500 });
  });
});

describe("parseQuantityInput", () => {
  it("converts a decimal entry into an exact base quantity", () => {
    expect(parseQuantityInput("1.5", KG_IN_GRAMS)).toEqual({
      quantityInUom: null,
      quantityBase: 1500,
    });
    expect(parseQuantityInput("0.25", KG_IN_GRAMS)).toEqual({
      quantityInUom: null,
      quantityBase: 250,
    });
  });

  it("keeps the UoM quantity when the entry is a whole number", () => {
    expect(parseQuantityInput("2", BOX_OF_12)).toEqual({ quantityInUom: 2, quantityBase: 24 });
    expect(parseQuantityInput("0", BOX_OF_12)).toEqual({ quantityInUom: 0, quantityBase: 0 });
  });

  it("accepts a fractional entry when it lands on whole base units", () => {
    // 2.5 boxes of 12 is exactly 30 pieces, so it is representable.
    expect(parseQuantityInput("2.5", BOX_OF_12)).toEqual({
      quantityInUom: null,
      quantityBase: 30,
    });
  });

  it("refuses a quantity the conversion cannot represent exactly", () => {
    // Half of a base unit does not exist — the DB stores integers only.
    expect(() => parseQuantityInput("0.5", BASE)).toThrow(/finer-grained UoM/);
    // A third of a box of 12 is 4 pieces, but a quarter is 3 — and 2.1 boxes
    // is 25.2 pieces, which cannot be stored.
    expect(() => parseQuantityInput("2.1", BOX_OF_12)).toThrow(/finer-grained UoM/);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "-1", "abc", "1,5", "1.2.3"]) {
      expect(() => parseQuantityInput(bad, BASE), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe("formatQty", () => {
  it("renders exact conversions without decimals", () => {
    expect(formatQty(48, BOX_OF_12, "box")).toBe("4 box");
    expect(formatQty(2000, KG_IN_GRAMS, "kg")).toBe("2 kg");
    expect(formatQty(0, BOX_OF_12, "box")).toBe("0 box");
  });

  it("renders a fractional conversion with trimmed decimals", () => {
    expect(formatQty(1500, KG_IN_GRAMS, "kg")).toBe("1.5 kg");
  });

  it("can show a whole-plus-remainder breakdown", () => {
    expect(formatQty(50, BOX_OF_12, "box", { showRemainder: true })).toBe("4 box + 2");
    expect(formatQty(48, BOX_OF_12, "box", { showRemainder: true })).toBe("4 box");
  });
});
