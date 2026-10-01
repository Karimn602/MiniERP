import { describe, expect, it } from "vitest";
import { computeLineMath } from "../../src/lib/purchaseMath";
import type { Factor } from "../../src/lib/uom";
import { COST_SCALE, extendedCostCents, microcentsToCents } from "../../src/lib/cost";

const BASE: Factor = { num: 1, den: 1 };
const BOX_OF_12: Factor = { num: 12, den: 1 };
const STANDARD = 1100;
const EXEMPT = 0;

describe("computeLineMath — supplier invoice priced excluding VAT", () => {
  it("reconciles: subtotal + VAT = total", () => {
    const line = computeLineMath({
      quantityInUom: 10,
      unitCostInUomCents: 200, // $2.00 net per unit
      unitCostInUomMode: "exclusive",
      factor: BASE,
      vatBps: STANDARD,
    });

    expect(line.unitCostExclVatInUomCents).toBe(200);
    expect(line.unitCostInclVatInUomCents).toBe(222);
    expect(line.lineSubtotalExclVatCents).toBe(2000);
    expect(line.lineVatCents).toBe(220);
    expect(line.lineTotalInclVatCents).toBe(2220);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
  });

  it("keeps the typed cost untouched as the source of truth", () => {
    const line = computeLineMath({
      quantityInUom: 1,
      unitCostInUomCents: 1_999,
      unitCostInUomMode: "exclusive",
      factor: BASE,
      vatBps: STANDARD,
    });
    expect(line.unitCostInUomCents).toBe(1_999);
    expect(line.unitCostExclVatInUomCents).toBe(1_999);
  });
});

describe("computeLineMath — supplier invoice priced including VAT", () => {
  it("decomposes the gross cost and still reconciles", () => {
    const line = computeLineMath({
      quantityInUom: 10,
      unitCostInUomCents: 222, // $2.22 gross per unit
      unitCostInUomMode: "inclusive",
      factor: BASE,
      vatBps: STANDARD,
    });

    expect(line.unitCostInclVatInUomCents).toBe(222);
    expect(line.unitCostExclVatInUomCents).toBe(200);
    expect(line.lineSubtotalExclVatCents).toBe(2000);
    expect(line.lineVatCents).toBe(220);
    expect(line.lineTotalInclVatCents).toBe(2220);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
  });
});

describe("computeLineMath — UoM conversion", () => {
  it("converts both quantity and cost to base units", () => {
    const line = computeLineMath({
      quantityInUom: 5,
      unitCostInUomCents: 2_400, // $24.00 per box of 12
      unitCostInUomMode: "exclusive",
      factor: BOX_OF_12,
      vatBps: STANDARD,
    });

    expect(line.quantityBase).toBe(60);
    expect(line.unitCostExclVatBaseCents).toBe(200); // $2.00 per unit
    expect(line.unitCostInclVatBaseCents).toBe(222);
    // Money is still counted per purchase UoM, not per base unit.
    expect(line.lineSubtotalExclVatCents).toBe(12_000);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
  });

  it("is a no-op at the base UoM", () => {
    const line = computeLineMath({
      quantityInUom: 3,
      unitCostInUomCents: 500,
      unitCostInUomMode: "exclusive",
      factor: BASE,
      vatBps: STANDARD,
    });
    expect(line.quantityBase).toBe(3);
    expect(line.unitCostExclVatBaseCents).toBe(500);
  });
});

describe("computeLineMath — boundaries", () => {
  it("handles an exempt line", () => {
    const line = computeLineMath({
      quantityInUom: 10,
      unitCostInUomCents: 90,
      unitCostInUomMode: "exclusive",
      factor: BASE,
      vatBps: EXEMPT,
    });
    expect(line.lineVatCents).toBe(0);
    expect(line.lineSubtotalExclVatCents).toBe(900);
    expect(line.lineTotalInclVatCents).toBe(900);
  });

  it("handles free goods", () => {
    const line = computeLineMath({
      quantityInUom: 12,
      unitCostInUomCents: 0,
      unitCostInUomMode: "exclusive",
      factor: BASE,
      vatBps: STANDARD,
    });
    expect(line.lineSubtotalExclVatCents).toBe(0);
    expect(line.lineVatCents).toBe(0);
    expect(line.lineTotalInclVatCents).toBe(0);
    expect(line.quantityBase).toBe(12);
  });

  it("stays exact and reconciled at container scale", () => {
    const line = computeLineMath({
      quantityInUom: 10_000,
      unitCostInUomCents: 123_456,
      unitCostInUomMode: "exclusive",
      factor: BASE,
      vatBps: STANDARD,
    });
    expect(line.lineSubtotalExclVatCents).toBe(1_234_560_000);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
  });

  it("reconciles across a sweep of awkward costs in both pricing modes", () => {
    for (const mode of ["exclusive", "inclusive"] as const) {
      for (const cost of [1, 7, 99, 333, 1_001, 99_999]) {
        for (const qty of [1, 3, 17, 250]) {
          const line = computeLineMath({
            quantityInUom: qty,
            unitCostInUomCents: cost,
            unitCostInUomMode: mode,
            factor: BASE,
            vatBps: STANDARD,
          });
          expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(
            line.lineTotalInclVatCents,
          );
          expect(Number.isInteger(line.unitCostExclVatBaseCents)).toBe(true);
          expect(Number.isInteger(line.unitCostInclVatBaseCents)).toBe(true);
        }
      }
    }
  });
});

describe("computeLineMath — per-base unit cost precision (GP-A03)", () => {
  const KG_IN_GRAMS: Factor = { num: 1000, den: 1 };

  it("keeps a sub-cent per-base cost as a microcent rate", () => {
    // 20 kg of flour at $2.50/kg, stocked in grams.
    const line = computeLineMath({
      quantityInUom: 20,
      unitCostInUomCents: 250,
      unitCostInUomMode: "exclusive",
      factor: KG_IN_GRAMS,
      vatBps: STANDARD,
    });

    expect(line.quantityBase).toBe(20_000);
    // The accounting rate: $0.0025 per gram.
    expect(line.unitCostExclVatBaseMicrocents).toBe(250_000);
    expect(line.unitCostInclVatBaseMicrocents).toBe(278_000);
    // The rounded mirror is zero — which is exactly the old defect, and exactly
    // why nothing costs from this field any more.
    expect(line.unitCostExclVatBaseCents).toBe(0);
    // The invoice itself is still exact cents: $50.00 net.
    expect(line.lineSubtotalExclVatCents).toBe(5_000);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
    // And the rate values the whole receipt back to that $50.00.
    expect(extendedCostCents(line.unitCostExclVatBaseMicrocents, line.quantityBase)).toBe(5_000);
  });

  it("agrees with the mirror for an ordinary whole-cent cost", () => {
    const line = computeLineMath({
      quantityInUom: 5,
      unitCostInUomCents: 2_400, // $24.00 per box of 12
      unitCostInUomMode: "exclusive",
      factor: BOX_OF_12,
      vatBps: STANDARD,
    });
    expect(line.unitCostExclVatBaseMicrocents).toBe(200 * COST_SCALE);
    expect(line.unitCostInclVatBaseMicrocents).toBe(222 * COST_SCALE);
    expect(microcentsToCents(line.unitCostExclVatBaseMicrocents)).toBe(
      line.unitCostExclVatBaseCents,
    );
    expect(microcentsToCents(line.unitCostInclVatBaseMicrocents)).toBe(
      line.unitCostInclVatBaseCents,
    );
  });

  it("keeps the cents field as exactly the rounded rate, across a sweep", () => {
    // The invariant that lets the legacy column stay trustworthy as a display
    // value: it is never anything other than the rate, rounded.
    for (const mode of ["exclusive", "inclusive"] as const) {
      for (const cost of [1, 7, 99, 250, 333, 1_001, 99_999]) {
        for (const factor of [BASE, BOX_OF_12, KG_IN_GRAMS]) {
          const line = computeLineMath({
            quantityInUom: 4,
            unitCostInUomCents: cost,
            unitCostInUomMode: mode,
            factor,
            vatBps: STANDARD,
          });
          expect(Number.isInteger(line.unitCostExclVatBaseMicrocents)).toBe(true);
          expect(Number.isInteger(line.unitCostInclVatBaseMicrocents)).toBe(true);
          expect(line.unitCostExclVatBaseCents).toBe(
            microcentsToCents(line.unitCostExclVatBaseMicrocents),
          );
          expect(line.unitCostInclVatBaseCents).toBe(
            microcentsToCents(line.unitCostInclVatBaseMicrocents),
          );
        }
      }
    }
  });
});
