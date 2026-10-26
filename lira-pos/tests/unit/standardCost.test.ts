/**
 * `lib/standardCost.ts` and the cost-coverage half of `lib/reportMath.ts`
 * (WP-B1).
 *
 * These are the pure halves of manual costing: the input shape, the
 * vocabulary, the status a screen may print, and the classification a
 * coverage panel is built from. None of them decides money — the authoritative
 * cost is resolved by `post_sale` from the database — so what is being pinned
 * here is that a typo is refused rather than read as a plausible wrong cost,
 * and that "not configured", "deliberately zero" and "costed" never collapse
 * into one another.
 */
import { describe, expect, it } from "vitest";
import {
  COSTING_METHODS,
  SELECTABLE_COSTING_METHODS,
  cogsSourceLabelKey,
  costConfigurationStatus,
  costStatusLabelKey,
  effectiveUnitCostMicrocents,
  formatManualCostInput,
  isBlankCostInput,
  isCostBearingLine,
  isVerifiedCostSource,
  isSelectableCostingMethod,
  isUncostedStatus,
  normalizeCogsSource,
  normalizeCostingMethod,
  parseManualCostInput,
} from "../../src/lib/standardCost";
import type { CogsSource } from "../../src/lib/standardCost";
import { costCoverage, formatCoverage } from "../../src/lib/reportMath";
import type { CogsCoverageRow } from "../../src/db/repos/reports";

// ---------------------------------------------------------------------------
// Parsing a typed cost
// ---------------------------------------------------------------------------

describe("parseManualCostInput", () => {
  it("reads whole dollars and cents into microcents", () => {
    // $1.85 = 185 cents = 185,000,000 microcents. A microcent is the eighth
    // decimal place of a dollar.
    expect(parseManualCostInput("1.85")).toBe(185_000_000);
    expect(parseManualCostInput("2")).toBe(200_000_000);
    expect(parseManualCostInput("0.07")).toBe(7_000_000);
  });

  it("keeps a SUB-CENT rate, which is the reason the column is microcents", () => {
    // $0.0025 per gram of flour. Two decimals would make this zero, and a
    // zero cost is the defect this whole work package is about.
    expect(parseManualCostInput("0.0025")).toBe(250_000);
    expect(parseManualCostInput("0.0001")).toBe(10_000);
  });

  it("accepts a deliberate zero, which is NOT the same as a blank", () => {
    expect(parseManualCostInput("0")).toBe(0);
    expect(parseManualCostInput("0.00")).toBe(0);
    // Blank parses to null too, so the caller must ask which it was.
    expect(parseManualCostInput("")).toBeNull();
    expect(isBlankCostInput("")).toBe(true);
    expect(isBlankCostInput("   ")).toBe(true);
    expect(isBlankCostInput("0")).toBe(false);
  });

  it("strips a leading $ and well-formed thousands groups", () => {
    expect(parseManualCostInput("$1.85")).toBe(185_000_000);
    expect(parseManualCostInput(" $12.50 ")).toBe(1_250_000_000);
    expect(parseManualCostInput("1,200.00")).toBe(120_000_000_000);
  });

  it("validates in FULL and never by numeric prefix", () => {
    // The WP-A importer lesson. `parseFloat("2abc")` is 2, and a typo that
    // reads as a plausible wrong cost is worse than one that is refused,
    // because the margin it produces looks fine.
    for (const bad of [
      "2abc",
      "1.8.5",
      "1,2,3",
      "abc",
      "-1",
      "-0.5",
      "1e3",
      "1 85",
      "$",
      ".5",
      "1.",
      "1.23456",
      "NaN",
      "Infinity",
    ]) {
      expect(parseManualCostInput(bad), `"${bad}" must be refused`).toBeNull();
    }
  });

  it("refuses a fifth decimal place rather than rounding it away", () => {
    // Four places is the documented bound. Silently rounding a fifth would
    // let an import or a typed figure decide a margin by a rule nobody saw.
    expect(parseManualCostInput("0.0025")).toBe(250_000);
    expect(parseManualCostInput("0.00255")).toBeNull();
  });
});

describe("formatManualCostInput", () => {
  it("round-trips a stored rate back into the field it was typed in", () => {
    for (const typed of ["1.85", "0.0025", "12.50", "0"]) {
      const parsed = parseManualCostInput(typed);
      expect(parsed).not.toBeNull();
      expect(parseManualCostInput(formatManualCostInput(parsed))).toBe(parsed);
    }
  });

  it("carries no currency sigil or thousands comma, so the field stays editable", () => {
    expect(formatManualCostInput(185_000_000)).toBe("1.85");
    expect(formatManualCostInput(250_000)).toBe("0.0025");
    expect(formatManualCostInput(120_000_000_000)).toBe("1200.00");
  });

  it("formats a missing cost as an empty field, not as zero", () => {
    expect(formatManualCostInput(null)).toBe("");
    expect(formatManualCostInput(0)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe("costing method vocabulary", () => {
  it("states the schema's whole domain, and the selectable subset separately", () => {
    // `recipe` is in migration 020's CHECK so that shipping WP-B2 needs no
    // `products` table rebuild — SQLite cannot ALTER a CHECK and that table
    // is referenced by every posted document family. It is not offered.
    expect(COSTING_METHODS).toEqual(["purchase_average", "standard", "recipe"]);
    expect(SELECTABLE_COSTING_METHODS).toEqual(["purchase_average", "standard"]);
    expect(isSelectableCostingMethod("recipe")).toBe(false);
    expect(isSelectableCostingMethod("standard")).toBe(true);
  });

  it("reads an unknown or missing method as today's behaviour", () => {
    // A row decoded from a pre-020 database has no such key at all, and a
    // screen must never show a method the engine would not honour.
    expect(normalizeCostingMethod(undefined)).toBe("purchase_average");
    expect(normalizeCostingMethod(null)).toBe("purchase_average");
    expect(normalizeCostingMethod("")).toBe("purchase_average");
    expect(normalizeCostingMethod("something_else")).toBe("purchase_average");
    expect(normalizeCostingMethod("standard")).toBe("standard");
  });
});

describe("cogs provenance", () => {
  it("reads a missing source as null — 'costed before this feature existed'", () => {
    expect(normalizeCogsSource(null)).toBeNull();
    expect(normalizeCogsSource(undefined)).toBeNull();
    expect(normalizeCogsSource("")).toBeNull();
    expect(normalizeCogsSource("invented")).toBeNull();
    expect(normalizeCogsSource("standard")).toBe("standard");
    expect(normalizeCogsSource("uncosted")).toBe("uncosted");
  });

  it("treats legacy and uncosted as the two sources that cannot be traced", () => {
    // `uncosted` is the engine saying nothing was configured; `null` is Greaz
    // never having recorded where the cost came from. Neither can be traced.
    expect(isVerifiedCostSource(null)).toBe(false);
    expect(isVerifiedCostSource("uncosted")).toBe(false);
    // A manual cost IS an answer — an assertion by the owner rather than a
    // document, which the UI says in its own words, but an answer.
    expect(isVerifiedCostSource("standard")).toBe(true);
    expect(isVerifiedCostSource("purchase_average")).toBe(true);
    expect(isVerifiedCostSource("last_purchase")).toBe(true);
  });

  it("separates HAVING a cost from having a traceable source for it", () => {
    // The WP-B1 P1-B distinction. A legacy line with a real COGS snapshot has
    // a cost — it is in the gross-profit figure already — even though its
    // provenance is NULL and always will be.
    expect(isCostBearingLine(null, 200_000_000, 200)).toBe(true);
    expect(isVerifiedCostSource(null)).toBe(false);
    // A sub-cent rate that rounds to $0.00 of line money still bears a cost:
    // the microcent rate is the authoritative column.
    expect(isCostBearingLine(null, 2_500, 0)).toBe(true);
    // And a legacy row written with money but no rate counts too, so no path
    // that produced one can be read as uncosted.
    expect(isCostBearingLine(null, 0, 200)).toBe(true);
    // A legacy ZERO stays indeterminate: "cost of nothing" and "nobody said"
    // are indistinguishable, and the generous reading would hide the revenue
    // an owner needs to see.
    expect(isCostBearingLine(null, 0, 0)).toBe(false);
    // `uncosted` is never cost-bearing, whatever the figures say.
    expect(isCostBearingLine("uncosted", 0, 0)).toBe(false);
    // And a recorded answer is cost-bearing without consulting the figure: a
    // deliberate manual zero is the owner stating the item costs nothing.
    expect(isCostBearingLine("standard", 0, 0)).toBe(true);
    expect(isCostBearingLine("purchase_average", 0, 0)).toBe(true);
  });

  it("names a label key for every source and for the legacy case", () => {
    expect(cogsSourceLabelKey(null)).toBe("costing.source.legacy");
    expect(cogsSourceLabelKey("standard")).toBe("costing.source.standard");
    expect(cogsSourceLabelKey("uncosted")).toBe("costing.source.uncosted");
  });
});

// ---------------------------------------------------------------------------
// What a screen may say about a product
// ---------------------------------------------------------------------------

describe("costConfigurationStatus", () => {
  const base = {
    costingMethod: "purchase_average" as const,
    standardCostExclVatMicrocents: null,
    isService: false,
    avgCostExclVatMicrocents: 0,
  };

  it("keeps a DELIBERATE zero apart from an unstated cost", () => {
    // Both display "$0.00". They are not the same claim, and collapsing them
    // is how a catalogue of 100% margins stops looking like a problem.
    expect(
      costConfigurationStatus({
        ...base,
        costingMethod: "standard",
        isService: true,
        standardCostExclVatMicrocents: 0,
      }),
    ).toBe("manual_zero");
    expect(
      costConfigurationStatus({ ...base, isService: true }),
    ).toBe("service_uncosted");
  });

  it("reports a stated cost as manual", () => {
    expect(
      costConfigurationStatus({
        ...base,
        costingMethod: "standard",
        isService: true,
        standardCostExclVatMicrocents: 185_000_000,
      }),
    ).toBe("manual");
  });

  it("distinguishes a stocked product with a basis from one without", () => {
    expect(
      costConfigurationStatus({ ...base, avgCostExclVatMicrocents: 200_000_000 }),
    ).toBe("purchase");
    expect(costConfigurationStatus(base)).toBe("purchase_uncosted");
  });

  it("marks both uncosted states as gaps and neither costed state as one", () => {
    expect(isUncostedStatus("service_uncosted")).toBe(true);
    expect(isUncostedStatus("purchase_uncosted")).toBe(true);
    expect(isUncostedStatus("manual_zero")).toBe(false);
    expect(isUncostedStatus("manual")).toBe(false);
    expect(isUncostedStatus("purchase")).toBe(false);
  });

  it("names a label key for every status", () => {
    expect(costStatusLabelKey("manual_zero")).toBe("costing.status.manual_zero");
  });
});

describe("effectiveUnitCostMicrocents", () => {
  it("shows the manual cost for a manual-costed item", () => {
    // Reading `avgCost` unconditionally printed $0.00 for exactly the products
    // whose cost the owner HAD taken the trouble to state.
    expect(
      effectiveUnitCostMicrocents({
        costingMethod: "standard",
        standardCostExclVatMicrocents: 185_000_000,
        avgCostExclVatMicrocents: 0,
        isService: true,
      }),
    ).toBe(185_000_000);
  });

  it("returns null when nothing has been configured, rather than a zero that reads as a cost", () => {
    expect(
      effectiveUnitCostMicrocents({
        costingMethod: "purchase_average",
        standardCostExclVatMicrocents: null,
        avgCostExclVatMicrocents: 0,
        isService: true,
      }),
    ).toBeNull();
  });

  it("shows a stocked product's weighted average, and its zero as a zero", () => {
    // A stocked product's zero is an absence too, but a temporary one: the
    // next purchase fills it.
    expect(
      effectiveUnitCostMicrocents({
        costingMethod: "purchase_average",
        standardCostExclVatMicrocents: null,
        avgCostExclVatMicrocents: 200_000_000,
        isService: false,
      }),
    ).toBe(200_000_000);
    expect(
      effectiveUnitCostMicrocents({
        costingMethod: "purchase_average",
        standardCostExclVatMicrocents: null,
        avgCostExclVatMicrocents: 0,
        isService: false,
      }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cost coverage
// ---------------------------------------------------------------------------

/**
 * A coverage bucket. Unless a test says otherwise the bucket's lines all carry
 * a cost, which is what every source but `uncosted` and legacy means — the
 * `costBearing*` split only ever matters for the NULL bucket, where there is
 * no provenance to read and the posted COGS figure is the only evidence.
 */
function row(over: Partial<CogsCoverageRow>): CogsCoverageRow {
  const base = {
    source: "purchase_average" as CogsSource | null,
    lineCount: 1,
    totalQty: 1,
    lineSubtotalExclVatCents: 1000,
    lineCogsExclVatCents: 200,
    zeroRateLineCount: 0,
    ...over,
  };
  return {
    ...base,
    costBearingLineCount: over.costBearingLineCount ?? base.lineCount,
    costBearingSubtotalExclVatCents:
      over.costBearingSubtotalExclVatCents ?? base.lineSubtotalExclVatCents,
  };
}

describe("costCoverage", () => {
  it("measures coverage as a share of REVENUE, not of line count", () => {
    // Ten uncosted sides matter less than one uncosted platter, and it is the
    // money that reaches the margin.
    const summary = costCoverage([
      row({ source: "standard", lineCount: 1, lineSubtotalExclVatCents: 9000 }),
      row({
        source: "uncosted",
        lineCount: 10,
        lineSubtotalExclVatCents: 1000,
        costBearingLineCount: 0,
        costBearingSubtotalExclVatCents: 0,
      }),
    ]);
    expect(summary.totalRevenueExclVatCents).toBe(10_000);
    expect(summary.costBearingRevenueExclVatCents).toBe(9000);
    expect(summary.costBearingRevenueFraction).toBeCloseTo(0.9, 6);
    expect(summary.totalLineCount).toBe(11);
    expect(summary.costBearingLineCount).toBe(1);
  });

  it("counts a legacy line with a nonzero COGS as cost-bearing, source unknown", () => {
    // The P1-B correction. The line was posted before provenance existed, so
    // its source is NULL and always will be — but the cost it was posted with
    // is in the row, and it is already inside the gross-profit figure this
    // panel qualifies. Calling it uncosted said money was missing from a
    // calculation that was complete.
    const summary = costCoverage([
      row({ source: null, lineCount: 4, lineSubtotalExclVatCents: 4000 }),
    ]);
    expect(summary.costBearingRevenueExclVatCents).toBe(4000);
    expect(summary.costBearingRevenueFraction).toBe(1);
    expect(summary.legacyCostedRevenueExclVatCents).toBe(4000);
    expect(summary.legacyCostedLineCount).toBe(4);
    expect(summary.missingCostRevenueExclVatCents).toBe(0);
    expect(summary.hasMissingCost).toBe(false);

    // And it is NOT given a provenance it does not have. It stays outside the
    // verified share, and outside both the documented and estimated rows.
    expect(summary.verifiedSourceRevenueExclVatCents).toBe(0);
    expect(summary.verifiedSourceRevenueFraction).toBe(0);
    expect(summary.documentedRevenueExclVatCents).toBe(0);
    expect(summary.estimatedRevenueExclVatCents).toBe(0);
    expect(summary.hasUnknownSource).toBe(true);
  });

  it("keeps a legacy ZERO cost indeterminate, and counts it as missing", () => {
    // Nothing distinguishes "cost of nothing" from "nobody said" on a line
    // with no provenance and a zero snapshot, so it is not claimed as costed.
    const summary = costCoverage([
      row({
        source: null,
        lineCount: 3,
        lineSubtotalExclVatCents: 3000,
        costBearingLineCount: 0,
        costBearingSubtotalExclVatCents: 0,
      }),
    ]);
    expect(summary.legacyUncostedRevenueExclVatCents).toBe(3000);
    expect(summary.legacyUncostedLineCount).toBe(3);
    expect(summary.legacyCostedRevenueExclVatCents).toBe(0);
    expect(summary.costBearingRevenueExclVatCents).toBe(0);
    expect(summary.missingCostRevenueExclVatCents).toBe(3000);
    expect(summary.hasMissingCost).toBe(true);
    expect(summary.hasUnknownSource).toBe(false);
  });

  it("splits ONE legacy bucket holding both kinds of line", () => {
    // Which is how the bucket actually arrives: `cogsCoverage` groups on the
    // raw column, so every pre-020 line in the period is one row.
    const summary = costCoverage([
      row({
        source: null,
        lineCount: 5,
        lineSubtotalExclVatCents: 5000,
        costBearingLineCount: 2,
        costBearingSubtotalExclVatCents: 3000,
      }),
    ]);
    expect(summary.legacyRevenueExclVatCents).toBe(5000);
    expect(summary.legacyCostedRevenueExclVatCents).toBe(3000);
    expect(summary.legacyUncostedRevenueExclVatCents).toBe(2000);
    expect(summary.legacyCostedLineCount).toBe(2);
    expect(summary.legacyUncostedLineCount).toBe(3);
    expect(summary.costBearingRevenueFraction).toBeCloseTo(0.6, 6);
    expect(summary.missingCostRevenueExclVatCents).toBe(2000);
    // Both warnings are true at once, and they say different things.
    expect(summary.hasMissingCost).toBe(true);
    expect(summary.hasUnknownSource).toBe(true);
  });

  it("keeps UNCOSTED and legacy apart, because one is a to-do list", () => {
    // An uncosted line is a product the owner can configure today. A legacy
    // line can never be improved; history is not restated.
    const summary = costCoverage([
      row({
        source: null,
        lineCount: 3,
        lineSubtotalExclVatCents: 3000,
        costBearingLineCount: 0,
        costBearingSubtotalExclVatCents: 0,
      }),
      row({
        source: "uncosted",
        lineCount: 2,
        lineSubtotalExclVatCents: 2000,
        costBearingLineCount: 0,
        costBearingSubtotalExclVatCents: 0,
      }),
    ]);
    expect(summary.legacyRevenueExclVatCents).toBe(3000);
    expect(summary.legacyLineCount).toBe(3);
    expect(summary.uncostedRevenueExclVatCents).toBe(2000);
    expect(summary.uncostedLineCount).toBe(2);
    expect(summary.costBearingRevenueExclVatCents).toBe(0);
    expect(summary.missingCostRevenueExclVatCents).toBe(5000);
  });

  it("separates ESTIMATED costs from costs derived from purchase documents", () => {
    // They are different claims. A manual cost is what the owner stated; a
    // purchase average is what an invoice said.
    const summary = costCoverage([
      row({ source: "standard", lineSubtotalExclVatCents: 4000 }),
      row({ source: "purchase_average", lineSubtotalExclVatCents: 3000 }),
      row({ source: "last_purchase", lineSubtotalExclVatCents: 2000 }),
    ]);
    expect(summary.estimatedRevenueExclVatCents).toBe(4000);
    expect(summary.documentedRevenueExclVatCents).toBe(5000);
    expect(summary.hasMissingCost).toBe(false);
    expect(summary.hasUnknownSource).toBe(false);
    expect(summary.costBearingRevenueFraction).toBe(1);
    expect(summary.verifiedSourceRevenueFraction).toBe(1);
  });

  it("treats a DELIBERATE zero as an answer, on the source and not the figure", () => {
    // A `standard` product stated at $0.00 is the owner saying the item costs
    // nothing. That is as much of an answer as $1.85, and the zero-rate count
    // beside it does not demote it.
    const summary = costCoverage([
      row({
        source: "standard",
        lineSubtotalExclVatCents: 1000,
        lineCogsExclVatCents: 0,
        zeroRateLineCount: 1,
        costBearingLineCount: 0,
        costBearingSubtotalExclVatCents: 0,
      }),
    ]);
    expect(summary.costBearingRevenueExclVatCents).toBe(1000);
    expect(summary.verifiedSourceRevenueExclVatCents).toBe(1000);
    expect(summary.hasMissingCost).toBe(false);
  });

  it("reports no missing cost and full coverage when every line is costed", () => {
    const summary = costCoverage([row({ source: "standard" })]);
    expect(summary.hasMissingCost).toBe(false);
    expect(summary.costBearingRevenueFraction).toBe(1);
  });

  it("is null-coverage on an empty period rather than a confident 0%", () => {
    const summary = costCoverage([]);
    expect(summary.totalLineCount).toBe(0);
    expect(summary.costBearingRevenueFraction).toBeNull();
    expect(summary.verifiedSourceRevenueFraction).toBeNull();
    expect(summary.hasMissingCost).toBe(false);
    expect(formatCoverage(summary.costBearingRevenueFraction)).toBe("—");
  });

  it("does not treat a zero-revenue costed line as missing a cost", () => {
    // A $0.00 giveaway with a stated cost is costed. The test is about the
    // SOURCE, never about the size of the revenue.
    const summary = costCoverage([
      row({ source: "standard", lineSubtotalExclVatCents: 0, lineCogsExclVatCents: 0 }),
    ]);
    expect(summary.hasMissingCost).toBe(false);
    expect(summary.costBearingRevenueFraction).toBeNull();
  });

  it("adds up: cost-bearing plus missing is the whole period", () => {
    // The numerator and the denominator describe one population, so the two
    // shares a reader is shown cannot leave revenue unaccounted for.
    const rows = [
      row({ source: "standard", lineSubtotalExclVatCents: 4000 }),
      row({ source: "purchase_average", lineSubtotalExclVatCents: 3000 }),
      row({
        source: "uncosted",
        lineCount: 2,
        lineSubtotalExclVatCents: 2000,
        costBearingLineCount: 0,
        costBearingSubtotalExclVatCents: 0,
      }),
      row({
        source: null,
        lineCount: 4,
        lineSubtotalExclVatCents: 4000,
        costBearingLineCount: 1,
        costBearingSubtotalExclVatCents: 1000,
      }),
    ];
    const s = costCoverage(rows);
    expect(s.costBearingRevenueExclVatCents + s.missingCostRevenueExclVatCents).toBe(
      s.totalRevenueExclVatCents,
    );
    expect(s.costBearingLineCount + s.missingCostLineCount).toBe(s.totalLineCount);
    // And the verified share is a SUBSET of the cost-bearing one, never equal
    // to it while legacy costed revenue exists.
    expect(s.verifiedSourceRevenueExclVatCents).toBeLessThan(
      s.costBearingRevenueExclVatCents,
    );
  });
});

describe("formatCoverage", () => {
  it("prints one decimal place, and a dash when there is nothing to share", () => {
    expect(formatCoverage(1)).toBe("100%");
    expect(formatCoverage(0)).toBe("0%");
    expect(formatCoverage(0.9)).toBe("90%");
    expect(formatCoverage(0.8155)).toBe("81.6%");
    expect(formatCoverage(null)).toBe("—");
  });
});
