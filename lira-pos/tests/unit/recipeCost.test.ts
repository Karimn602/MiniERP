/**
 * The editor's recipe arithmetic, and the quantity parser it depends on
 * (WP-B2-A).
 *
 * `src-tauri/src/recipe_cost.rs` is the authority; this suite proves the
 * MIRROR agrees with it. The agreement is enforced by shared fixtures:
 * `FIXTURES` here is a literal transcription of `recipe_cost::FIXTURES`, and
 * `tests/recipes.rs::every_shared_fixture_costs_exactly_as_published` asserts
 * the same tuples and the same expected figures on the Rust side. A mirror
 * tested only against itself is not a mirror.
 */
import { describe, expect, it } from "vitest";
import {
  ACC,
  FIXTURES,
  MAX_COMPONENTS,
  MAX_RATE_MICROCENTS,
  fixtureComponent,
  recipeCost,
  type RecipeCostComponent,
} from "../../src/lib/recipeCost";
import {
  MAX_QUANTITY_DECIMALS,
  QuantityParseError,
  formatBaseQuantity,
  formatQuantity,
  parseQuantity,
  reduceQuantity,
} from "../../src/lib/recipeQuantity";

function costOf(components: RecipeCostComponent[], yieldBase = 1) {
  const outcome = recipeCost(components, yieldBase);
  if (outcome.kind !== "costed") {
    throw new Error(`expected a cost, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome.cost;
}

// ---------------------------------------------------------------------------
// The shared contract with Rust
// ---------------------------------------------------------------------------

describe("recipeCost agrees with the Rust authority", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    "fixture %s",
    (_name, f) => {
      const components = f.components.map((t, i) => fixtureComponent(i, t));
      const cost = costOf(components, f.yieldBase);
      expect(cost.batchMicrocents).toBe(f.expectBatchMicrocents);
      expect(cost.perBaseUnitMicrocents).toBe(f.expectPerBaseUnitMicrocents);
    },
  );

  it("sums at accumulator scale, so naive per-component rounding differs", () => {
    // The reason the accumulator exists. Three pinches worth 0.4 microcents
    // each vanish if each component is rounded to a whole microcent before
    // being summed; accumulated they are worth a microcent between them. It is
    // the shape of the GP-A03 defect, where rounding a rate before multiplying
    // made $0.0025/g flour cost $0.00.
    const f = FIXTURES.find((x) => x.name === "pinches_naive_rounding_loses")!;
    const cost = costOf(f.components.map((t, i) => fixtureComponent(i, t)));
    const naive = cost.contributions.reduce((s, c) => s + c.contributionMicrocents, 0);

    expect(cost.batchMicrocents).toBe(22_000_001);
    expect(naive).toBe(22_000_000);
    expect(cost.batchMicrocents).not.toBe(naive);
  });

  it("rounds nowhere at all in the common whole-quantity case", () => {
    // With waste 0 and both denominators 1 the divisor is 10,000 and the
    // numerator carries a factor of ACC, so each division is EXACT.
    const cost = costOf([
      fixtureComponent(0, [22_000_000, 1, 1, 1, 1, 0]),
      fixtureComponent(1, [850_000, 150, 1, 1, 1, 0]),
    ]);
    expect(cost.batchMicrocents).toBe(149_500_000);
    expect(cost.contributions.reduce((s, c) => s + c.contributionMicrocents, 0)).toBe(
      cost.batchMicrocents,
    );
  });

  it("exposes the accumulator scale it documents", () => {
    expect(ACC).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// Verdicts: a cost, an absence, or a refusal — never a silent zero
// ---------------------------------------------------------------------------

describe("recipeCost verdicts", () => {
  it("reports an ingredient with NO cost basis as incomplete, not as zero", () => {
    // `null` is not zero, and the difference is the whole point. Reporting a
    // zero here is how a catalogue of 100% margins stops looking like a
    // problem — WP-B1's lesson, one level down.
    const missing = fixtureComponent(1, [0, 2, 1, 1, 1, 0]);
    missing.unitCostExclVatMicrocents = null;
    missing.componentName = "Mystery pickle";

    const outcome = recipeCost([fixtureComponent(0, [22_000_000, 1, 1, 1, 1, 0]), missing], 1);
    expect(outcome.kind).toBe("incomplete");
    if (outcome.kind !== "incomplete") throw new Error("unreachable");
    expect(outcome.incomplete.uncosted).toEqual(["Mystery pickle"]);
  });

  it("costs a DOCUMENTED zero at zero and does not call it incomplete", () => {
    // A supplier sample received at a stated cost of nothing. The zero is an
    // answer, and the recipe is complete.
    const free = fixtureComponent(1, [0, 3, 1, 1, 1, 0]);
    const cost = costOf([fixtureComponent(0, [22_000_000, 1, 1, 1, 1, 0]), free]);
    expect(cost.perBaseUnitMicrocents).toBe(22_000_000);
  });

  it("refuses an empty recipe and one above the component cap", () => {
    expect(recipeCost([], 1).kind).toBe("refused");
    const many = Array.from({ length: MAX_COMPONENTS + 1 }, (_, i) =>
      fixtureComponent(i, [1_000, 1, 1, 1, 1, 0]),
    );
    const outcome = recipeCost(many, 1);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toContain("at most 64");
  });

  it("refuses a rate, quantity, conversion, waste or yield outside the envelope", () => {
    const over = fixtureComponent(0, [1_000, 1, 1, 1, 1, 0]);
    over.unitCostExclVatMicrocents = MAX_RATE_MICROCENTS + 1;
    expect(recipeCost([over], 1).kind).toBe("refused");

    const bigQty = fixtureComponent(0, [1_000, 1_000_001, 1, 1, 1, 0]);
    expect(recipeCost([bigQty], 1).kind).toBe("refused");

    const bigFactor = fixtureComponent(0, [1_000, 1, 1, 1_000_001, 1, 0]);
    expect(recipeCost([bigFactor], 1).kind).toBe("refused");

    const fullWaste = fixtureComponent(0, [1_000, 1, 1, 1, 1, 10_000]);
    expect(recipeCost([fullWaste], 1).kind).toBe("refused");

    expect(recipeCost([fixtureComponent(0, [1_000, 1, 1, 1, 1, 0])], 0).kind).toBe(
      "refused",
    );
    expect(
      recipeCost([fixtureComponent(0, [1_000, 1, 1, 1, 1, 0])], 1_000_001).kind,
    ).toBe("refused");
  });

  it("refuses rather than losing precision at the top of the envelope", () => {
    // A `number` implementation would silently go wrong here; BigInt reaches a
    // checked conversion and refuses by name. Quietly wrong is the one failure
    // mode this codebase will not accept in money.
    const components = Array.from({ length: MAX_COMPONENTS }, (_, i) =>
      fixtureComponent(i, [MAX_RATE_MICROCENTS, 1_000_000, 1, 1_000_000, 1, 9_999]),
    );
    const outcome = recipeCost(components, 1);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toContain("too large");
  });
});

// ---------------------------------------------------------------------------
// Quantity parsing — validated in FULL, never by numeric prefix
// ---------------------------------------------------------------------------

describe("parseQuantity", () => {
  it("parses whole numbers, decimals and fractions exactly", () => {
    expect(parseQuantity("150")).toEqual({ num: 150, den: 1 });
    expect(parseQuantity("0.5")).toEqual({ num: 1, den: 2 });
    expect(parseQuantity("0.125")).toEqual({ num: 1, den: 8 });
    expect(parseQuantity("2.25")).toEqual({ num: 9, den: 4 });
    expect(parseQuantity("1/3")).toEqual({ num: 1, den: 3 });
    expect(parseQuantity(" 1 / 3 ")).toEqual({ num: 1, den: 3 });
    expect(parseQuantity("0.000001")).toEqual({ num: 1, den: 1_000_000 });
  });

  it("reduces, so two spellings of one quantity are one row", () => {
    expect(parseQuantity("2/4")).toEqual({ num: 1, den: 2 });
    expect(parseQuantity("0.50")).toEqual({ num: 1, den: 2 });
    expect(parseQuantity("150/1")).toEqual({ num: 150, den: 1 });
    expect(reduceQuantity(1_000, 100)).toEqual({ num: 10, den: 1 });
  });

  it("refuses a numeric PREFIX, which parseFloat would have accepted", () => {
    // `parseFloat("2abc")` is 2, and a typo that saves as a plausible wrong
    // quantity is worse than one that is refused, because the cost it produces
    // looks fine. The WP-A importer lesson.
    for (const bad of ["2abc", "150g", "0.5 kg", "1e3", "--1"]) {
      expect(() => parseQuantity(bad)).toThrow(QuantityParseError);
    }
  });

  it("refuses blank, zero, negative, malformed and divide-by-zero", () => {
    for (const bad of ["", "   ", "0", "0.0", "-1", "1.2.3", "1/0", "/3", "3/", "1//3"]) {
      expect(() => parseQuantity(bad)).toThrow(QuantityParseError);
    }
  });

  it("refuses more decimals than it can hold, and says to use a fraction", () => {
    expect(() => parseQuantity("0.1234567")).toThrow(/decimal places/);
    expect(parseQuantity(`0.${"1".repeat(MAX_QUANTITY_DECIMALS)}`)).toBeTruthy();
  });

  it("refuses parts outside the storable range", () => {
    expect(() => parseQuantity("1000001")).toThrow(/range/);
    expect(() => parseQuantity("1/1000001")).toThrow(/range/);
    expect(parseQuantity("1000000")).toEqual({ num: 1_000_000, den: 1 });
  });
});

describe("formatQuantity", () => {
  it("prints a terminating value as the decimal that was typed", () => {
    expect(formatQuantity({ num: 150, den: 1 })).toBe("150");
    expect(formatQuantity({ num: 1, den: 2 })).toBe("0.5");
    expect(formatQuantity({ num: 1, den: 8 })).toBe("0.125");
    expect(formatQuantity({ num: 9, den: 4 })).toBe("2.25");
  });

  it("prints a repeating value as the FRACTION, because the decimal is not it", () => {
    // Showing `0.333333` would invite the owner to "fix" an exact value into
    // an approximate one.
    expect(formatQuantity({ num: 1, den: 3 })).toBe("1/3");
    expect(formatQuantity({ num: 2, den: 7 })).toBe("2/7");
  });

  it("round-trips through parseQuantity", () => {
    for (const text of ["150", "0.5", "0.125", "2.25", "1/3", "2/7"]) {
      expect(formatQuantity(parseQuantity(text))).toBe(text);
    }
  });
});

describe("formatBaseQuantity", () => {
  it("resolves the recipe quantity into the ingredient's base unit", () => {
    // "0.15 kg" means nothing to a cook checking against a scale that reads
    // grams.
    expect(formatBaseQuantity({ num: 3, den: 20 }, { num: 1_000, den: 1 })).toBe("150");
    expect(formatBaseQuantity({ num: 1, den: 2 }, { num: 1, den: 1 })).toBe("0.5");
    expect(formatBaseQuantity({ num: 2, den: 1 }, { num: 12, den: 1 })).toBe("24");
  });
});
