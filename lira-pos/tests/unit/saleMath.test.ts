import { describe, expect, it } from "vitest";
import { computeSaleLineMath } from "../../src/lib/saleMath";
import type { Factor } from "../../src/lib/uom";

const BASE: Factor = { num: 1, den: 1 };
const BOX_OF_12: Factor = { num: 12, den: 1 };
const STANDARD = 1100;
const EXEMPT = 0;

/** A VAT-inclusive-priced product: $5.00 incl / $4.50 excl. */
const COFFEE = {
  basePriceExclVatCents: 450,
  basePriceInclVatCents: 500,
  uomOverrideExclVatCents: null,
  uomOverrideInclVatCents: null,
};

describe("computeSaleLineMath", () => {
  it("reconciles: line subtotal + line VAT = line total", () => {
    const line = computeSaleLineMath({
      ...COFFEE,
      quantityInUom: 3,
      factor: BASE,
      vatBps: STANDARD,
    });

    expect(line.unitPriceExclVatCents).toBe(450);
    expect(line.unitPriceInclVatCents).toBe(500);
    expect(line.quantityBase).toBe(3);
    expect(line.lineSubtotalExclVatCents).toBe(1350);
    expect(line.lineVatCents).toBe(150);
    expect(line.lineTotalInclVatCents).toBe(1500);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
  });

  it("carries the VAT rate snapshot through untouched", () => {
    const line = computeSaleLineMath({
      ...COFFEE,
      quantityInUom: 1,
      factor: BASE,
      vatBps: STANDARD,
    });
    expect(line.vatBps).toBe(STANDARD);
    expect(line.factor).toEqual(BASE);
  });

  it("charges no VAT on an exempt line", () => {
    const line = computeSaleLineMath({
      basePriceExclVatCents: 200,
      basePriceInclVatCents: 200,
      uomOverrideExclVatCents: null,
      uomOverrideInclVatCents: null,
      quantityInUom: 4,
      factor: BASE,
      vatBps: EXEMPT,
    });
    expect(line.lineVatCents).toBe(0);
    expect(line.lineSubtotalExclVatCents).toBe(800);
    expect(line.lineTotalInclVatCents).toBe(800);
  });

  it("prices a derived UoM and converts the quantity to base units", () => {
    const line = computeSaleLineMath({
      ...COFFEE,
      quantityInUom: 2,
      factor: BOX_OF_12,
      vatBps: STANDARD,
    });

    // Derived from base: 450 × 12 and 500 × 12 per box.
    expect(line.unitPriceExclVatCents).toBe(5400);
    expect(line.unitPriceInclVatCents).toBe(6000);
    // Two boxes of twelve leave the shelf as 24 base units.
    expect(line.quantityBase).toBe(24);
    // But the money is priced per box, not per base unit.
    expect(line.lineTotalInclVatCents).toBe(12_000);
    expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
  });

  it("honours a per-UoM price override", () => {
    const line = computeSaleLineMath({
      basePriceExclVatCents: 450,
      basePriceInclVatCents: 500,
      uomOverrideExclVatCents: 4_500,
      uomOverrideInclVatCents: 5_000,
      quantityInUom: 1,
      factor: BOX_OF_12,
      vatBps: STANDARD,
    });
    // A wholesale box price beats 12 × the single-unit price.
    expect(line.lineTotalInclVatCents).toBe(5_000);
    expect(line.lineSubtotalExclVatCents).toBe(4_500);
    expect(line.lineVatCents).toBe(500);
    expect(line.quantityBase).toBe(12);
  });

  it("handles the zero-price and zero-quantity boundaries", () => {
    const free = computeSaleLineMath({
      basePriceExclVatCents: 0,
      basePriceInclVatCents: 0,
      uomOverrideExclVatCents: null,
      uomOverrideInclVatCents: null,
      quantityInUom: 2,
      factor: BASE,
      vatBps: STANDARD,
    });
    expect(free.lineTotalInclVatCents).toBe(0);
    expect(free.lineVatCents).toBe(0);

    const none = computeSaleLineMath({ ...COFFEE, quantityInUom: 0, factor: BASE, vatBps: STANDARD });
    expect(none.lineTotalInclVatCents).toBe(0);
    expect(none.quantityBase).toBe(0);
  });

  it("stays exact and reconciled across awkward prices and quantities", () => {
    for (const qty of [1, 2, 7, 13, 99, 1_000]) {
      for (const incl of [1, 3, 99, 333, 555, 123_456]) {
        const line = computeSaleLineMath({
          basePriceExclVatCents: Math.round((incl * 10_000) / (10_000 + STANDARD)),
          basePriceInclVatCents: incl,
          uomOverrideExclVatCents: null,
          uomOverrideInclVatCents: null,
          quantityInUom: qty,
          factor: BASE,
          vatBps: STANDARD,
        });
        expect(line.lineSubtotalExclVatCents + line.lineVatCents).toBe(line.lineTotalInclVatCents);
        expect(line.lineTotalInclVatCents).toBe(incl * qty);
        expect(Number.isInteger(line.lineVatCents)).toBe(true);
      }
    }
  });
});
