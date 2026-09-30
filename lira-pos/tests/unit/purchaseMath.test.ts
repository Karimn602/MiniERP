import { describe, expect, it } from "vitest";
import { computeLineMath } from "../../src/lib/purchaseMath";
import type { Factor } from "../../src/lib/uom";

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
