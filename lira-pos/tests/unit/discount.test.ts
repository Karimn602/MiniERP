import { describe, expect, it } from "vitest";
import {
  allocateLineDiscounts,
  postDiscountLineTotals,
  type DiscountAllocatableLine,
} from "../../src/lib/discount";

const STANDARD = 1100;

/** Build allocatable lines from their incl-VAT totals. */
function lines(...totals: number[]): DiscountAllocatableLine[] {
  return totals.map((t) => ({ math: { lineTotalInclVatCents: t } }));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocateLineDiscounts", () => {
  it("splits a discount proportionally when it divides cleanly", () => {
    // 1000 + 1000 + 2000 = 4000; a 400¢ discount is 10% of each.
    expect(allocateLineDiscounts(lines(1000, 1000, 2000), 400)).toEqual([100, 100, 200]);
  });

  it("NEVER loses or invents a cent, whatever the remainder", () => {
    // This is the invariant the whole discount feature rests on.
    const shapes = [
      lines(1000, 1000, 1000),
      lines(333, 333, 334),
      lines(1, 1, 1, 1, 1, 1, 1),
      lines(997, 991, 983, 977, 971, 967, 953), // seven primes
      lines(1, 999_999),
      lines(12_345),
      lines(500, 500, 500, 500, 500, 500, 500, 500, 500, 500),
    ];
    for (const shape of shapes) {
      const preTotal = sum(shape.map((l) => l.math.lineTotalInclVatCents));
      for (const discount of [1, 2, 3, 7, 99, 100, 101, Math.floor(preTotal / 3), preTotal - 1]) {
        if (discount <= 0 || discount >= preTotal) continue;
        const allocated = allocateLineDiscounts(shape, discount);
        expect(sum(allocated), `discount ${discount} over ${shape.length} lines`).toBe(discount);
        expect(allocated).toHaveLength(shape.length);
      }
    }
  });

  it("gives the leftover cents to the largest lines first", () => {
    // 1¢ over three equal lines: exactly one line absorbs it.
    const allocated = allocateLineDiscounts(lines(1000, 1000, 1000), 1);
    expect(sum(allocated)).toBe(1);
    expect(allocated.filter((x) => x === 1)).toHaveLength(1);

    // With unequal lines, the biggest takes the remainder.
    const uneven = allocateLineDiscounts(lines(100, 900), 3);
    expect(sum(uneven)).toBe(3);
    expect(uneven[1]).toBeGreaterThanOrEqual(uneven[0]);
  });

  it("never allocates more to a line than the line is worth", () => {
    const shape = lines(100, 900);
    const allocated = allocateLineDiscounts(shape, 999);
    expect(sum(allocated)).toBe(999);
    allocated.forEach((a, i) => {
      expect(a).toBeLessThanOrEqual(shape[i].math.lineTotalInclVatCents);
    });
  });

  it("allocates nothing for a zero or negative discount", () => {
    expect(allocateLineDiscounts(lines(1000, 2000), 0)).toEqual([0, 0]);
    expect(allocateLineDiscounts(lines(1000, 2000), -50)).toEqual([0, 0]);
  });

  it("handles an empty cart and a zero-value cart without dividing by zero", () => {
    expect(allocateLineDiscounts([], 500)).toEqual([]);
    expect(allocateLineDiscounts(lines(0, 0), 500)).toEqual([0, 0]);
  });

  it("gives a single line the whole discount", () => {
    expect(allocateLineDiscounts(lines(5000), 1234)).toEqual([1234]);
  });

  it("returns integers only", () => {
    const allocated = allocateLineDiscounts(lines(333, 333, 334), 100);
    allocated.forEach((a) => expect(Number.isInteger(a)).toBe(true));
  });
});

describe("postDiscountLineTotals", () => {
  it("keeps excl + VAT = total after a discount", () => {
    const pd = postDiscountLineTotals(1500, 150, STANDARD);
    expect(pd.totalInclVat).toBe(1350);
    expect(pd.subtotalExclVat + pd.vat).toBe(pd.totalInclVat);
  });

  it("charges no VAT on an exempt line", () => {
    const pd = postDiscountLineTotals(800, 100, 0);
    expect(pd).toEqual({ subtotalExclVat: 700, vat: 0, totalInclVat: 700 });
  });

  it("is a no-op when the discount is zero", () => {
    const pd = postDiscountLineTotals(1110, 0, STANDARD);
    expect(pd.totalInclVat).toBe(1110);
    expect(pd.subtotalExclVat).toBe(1000);
    expect(pd.vat).toBe(110);
  });

  it("handles a discount that takes the line to zero", () => {
    const pd = postDiscountLineTotals(500, 500, STANDARD);
    expect(pd).toEqual({ subtotalExclVat: 0, vat: 0, totalInclVat: 0 });
  });

  it("holds the reconciliation invariant across a wide sweep", () => {
    for (const bps of [0, 1100, 1500]) {
      for (const total of [1, 99, 555, 1_110, 99_999, 1_234_567]) {
        for (const discount of [0, 1, 7, Math.floor(total / 3), total]) {
          const pd = postDiscountLineTotals(total, discount, bps);
          expect(pd.subtotalExclVat + pd.vat).toBe(pd.totalInclVat);
          expect(pd.totalInclVat).toBe(total - discount);
          expect(Number.isInteger(pd.vat)).toBe(true);
        }
      }
    }
  });
});

describe("allocation and decomposition together", () => {
  it("post-discount line totals sum to the pre-discount total minus the discount", () => {
    // This is what PosRegister persists as the sale header, so it must hold.
    const shape = lines(1_110, 555, 2_220, 97);
    const preTotal = sum(shape.map((l) => l.math.lineTotalInclVatCents));

    for (const discount of [0, 1, 13, 500, preTotal - 1]) {
      const allocated = allocateLineDiscounts(shape, discount);
      const parts = shape.map((l, i) =>
        postDiscountLineTotals(l.math.lineTotalInclVatCents, allocated[i], STANDARD),
      );

      const postTotal = sum(parts.map((p) => p.totalInclVat));
      const postSubtotal = sum(parts.map((p) => p.subtotalExclVat));
      const postVat = sum(parts.map((p) => p.vat));

      expect(postTotal).toBe(preTotal - discount);
      expect(postSubtotal + postVat).toBe(postTotal);
    }
  });

  it("holds for a mixed-VAT cart", () => {
    const shape = lines(1_110, 800, 555);
    const rates = [STANDARD, 0, STANDARD];
    const preTotal = sum(shape.map((l) => l.math.lineTotalInclVatCents));
    const discount = 247;

    const allocated = allocateLineDiscounts(shape, discount);
    const parts = shape.map((l, i) =>
      postDiscountLineTotals(l.math.lineTotalInclVatCents, allocated[i], rates[i]),
    );

    expect(sum(allocated)).toBe(discount);
    expect(sum(parts.map((p) => p.totalInclVat))).toBe(preTotal - discount);
    expect(sum(parts.map((p) => p.subtotalExclVat)) + sum(parts.map((p) => p.vat))).toBe(
      preTotal - discount,
    );
    expect(parts[1].vat).toBe(0);
  });
});
