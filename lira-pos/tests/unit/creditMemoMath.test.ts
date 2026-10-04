// Layer A — the cumulative proration that makes partial returns add up.
//
// `lib/creditMemoMath.ts` is the TypeScript mirror of
// `posting.rs::prorated_cumulative_cents`. The Rust side is authoritative for
// every persisted value; this module exists so the Create Return screen shows
// the cashier the figure the backend will compute. The two must therefore agree
// value for value, which is what these cases pin — they are the same figures
// `src-tauri/src/tests/pure.rs` asserts.

import { describe, expect, it } from "vitest";
import {
  proratedCumulativeCents,
  returnedLineAmounts,
  returnedShareCents,
} from "../../src/lib/creditMemoMath";

/** The share of each chunk, summed — the property the whole design rests on. */
function sumOfReturns(
  originalAmount: number,
  originalQty: number,
  chunks: number[],
): number {
  let returned = 0;
  let total = 0;
  for (const chunk of chunks) {
    total += returnedShareCents({
      originalAmount,
      originalQty,
      alreadyReturnedQty: returned,
      returningQty: chunk,
    });
    returned += chunk;
  }
  expect(returned).toBe(originalQty);
  return total;
}

describe("proratedCumulativeCents", () => {
  it("rounds half away from zero, like every other money boundary", () => {
    // $10.00 over three units: 333.33 -> 333, 666.67 -> 667, 1000 -> 1000.
    expect(proratedCumulativeCents(1_000, 0, 3)).toBe(0);
    expect(proratedCumulativeCents(1_000, 1, 3)).toBe(333);
    expect(proratedCumulativeCents(1_000, 2, 3)).toBe(667);
    expect(proratedCumulativeCents(1_000, 3, 3)).toBe(1_000);
    // An exact half goes away from zero: 5 over 2 is 2.5 -> 3.
    expect(proratedCumulativeCents(5, 1, 2)).toBe(3);
  });

  it("returns the whole amount when the whole quantity comes back", () => {
    for (const [amount, qty] of [
      [1, 1],
      [7, 3],
      [123_456_789, 97],
    ] as const) {
      expect(proratedCumulativeCents(amount, qty, qty)).toBe(amount);
    }
  });

  it("refuses a quantity outside the line, and a negative amount", () => {
    expect(() => proratedCumulativeCents(1_000, 4, 3)).toThrow();
    expect(() => proratedCumulativeCents(1_000, -1, 3)).toThrow();
    expect(() => proratedCumulativeCents(1_000, 0, 0)).toThrow();
    expect(() => proratedCumulativeCents(-1, 1, 3)).toThrow();
    expect(() => proratedCumulativeCents(1.5, 1, 3)).toThrow();
  });
});

describe("returnedShareCents", () => {
  it("reverses a whole line exactly, however it is broken up", () => {
    for (const chunks of [[3], [1, 1, 1], [2, 1], [1, 2]]) {
      expect(sumOfReturns(1_000, 3, chunks)).toBe(1_000);
    }
    expect(sumOfReturns(100, 7, [1, 1, 1, 1, 1, 1, 1])).toBe(100);
    expect(sumOfReturns(1, 3, [1, 1, 1])).toBe(1);
    expect(sumOfReturns(9_999, 7, [4, 3])).toBe(9_999);
    expect(sumOfReturns(0, 5, [2, 3])).toBe(0);
  });

  it("does not lose the cent that independent per-memo rounding loses", () => {
    // THE defect this rule exists to prevent: round(1000 x 1 / 3) three times.
    const naive = 3 * Math.round(1_000 / 3);
    expect(naive).toBe(999);
    expect(sumOfReturns(1_000, 3, [1, 1, 1])).toBe(1_000);
  });

  it("gives the awkward-cent sequence the backend gives", () => {
    // The three memos of a 3-unit, 1,000-cent line, one unit at a time —
    // the figures `returns.rs` asserts against the real posting command.
    const shares = [0, 1, 2].map((already) =>
      returnedShareCents({
        originalAmount: 1_000,
        originalQty: 3,
        alreadyReturnedQty: already,
        returningQty: 1,
      }),
    );
    expect(shares).toEqual([333, 334, 333]);

    // And the discount on the same line: 500 cents over three units.
    const discountShares = [0, 1, 2].map((already) =>
      returnedShareCents({
        originalAmount: 500,
        originalQty: 3,
        alreadyReturnedQty: already,
        returningQty: 1,
      }),
    );
    expect(discountShares).toEqual([167, 166, 167]);
    expect(discountShares.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it("prorates each component on its own series, never the total", () => {
    // A 3-unit line persisted post-discount as 901 + 99 = 1000, returned one
    // unit at a time. Subtotal and VAT each get their own cumulative series and
    // the total is their sum — so each memo reconciles AND the three columns
    // each land exactly on the original.
    const rows = [0, 1, 2].map((already) =>
      returnedLineAmounts({
        originalSubtotalExclVatCents: 901,
        originalVatCents: 99,
        originalDiscountCents: 500,
        originalQty: 3,
        alreadyReturnedQty: already,
        returningQty: 1,
      }),
    );

    for (const r of rows) {
      expect(r.subtotalExclVatCents + r.vatCents).toBe(r.totalInclVatCents);
      expect(r.vatCents).toBeGreaterThanOrEqual(0);
      expect(r.subtotalExclVatCents).toBeGreaterThanOrEqual(0);
    }
    expect(rows.reduce((s, r) => s + r.subtotalExclVatCents, 0)).toBe(901);
    expect(rows.reduce((s, r) => s + r.vatCents, 0)).toBe(99);
    expect(rows.reduce((s, r) => s + r.totalInclVatCents, 0)).toBe(1_000);
    expect(rows.reduce((s, r) => s + r.discountCents, 0)).toBe(500);
  });

  it("never credits negative VAT on the 11-cent line that broke the old rule", () => {
    // THE regression. Under the superseded rule — prorate the total, prorate
    // the subtotal, take VAT as the residual — the second unit of this line
    // asked to credit MINUS one cent of VAT, and the backend refused a return
    // the customer was entitled to.
    const residualVatForSecondUnit =
      returnedShareCents({
        originalAmount: 11,
        originalQty: 3,
        alreadyReturnedQty: 1,
        returningQty: 1,
      }) -
      returnedShareCents({
        originalAmount: 10,
        originalQty: 3,
        alreadyReturnedQty: 1,
        returningQty: 1,
      });
    expect(residualVatForSecondUnit).toBe(-1);

    // Component-wise, every slice is non-negative and the three columns still
    // land exactly on 10 + 1 = 11.
    for (const chunks of [[1, 1, 1], [2, 1], [1, 2], [3]]) {
      let returned = 0;
      const sums = { sub: 0, vat: 0, total: 0 };
      for (const chunk of chunks) {
        const r = returnedLineAmounts({
          originalSubtotalExclVatCents: 10,
          originalVatCents: 1,
          originalDiscountCents: 0,
          originalQty: 3,
          alreadyReturnedQty: returned,
          returningQty: chunk,
        });
        expect(r.vatCents).toBeGreaterThanOrEqual(0);
        expect(r.subtotalExclVatCents).toBeGreaterThanOrEqual(0);
        expect(r.subtotalExclVatCents + r.vatCents).toBe(r.totalInclVatCents);
        sums.sub += r.subtotalExclVatCents;
        sums.vat += r.vatCents;
        sums.total += r.totalInclVatCents;
        returned += chunk;
      }
      expect(sums).toEqual({ sub: 10, vat: 1, total: 11 });
    }
  });

  it("has no partition of any small line that produces a negative slice", () => {
    // The same exhaustive property the Rust suite asserts, over the shapes a
    // till actually produces. It is the CUMULATIVE position that decides a
    // slice, so a monotone series means every chunk from every earlier position
    // is non-negative — for every partition at once.
    for (let qty = 2; qty <= 12; qty++) {
      for (let total = 1; total <= 40; total++) {
        for (let vat = 0; vat <= total; vat++) {
          const subtotal = total - vat;
          let prevSub = 0;
          let prevVat = 0;
          for (let q = 1; q <= qty; q++) {
            const cumSub = proratedCumulativeCents(subtotal, q, qty);
            const cumVat = proratedCumulativeCents(vat, q, qty);
            expect(cumSub).toBeGreaterThanOrEqual(prevSub);
            expect(cumVat).toBeGreaterThanOrEqual(prevVat);
            prevSub = cumSub;
            prevVat = cumVat;
          }
          expect(prevSub).toBe(subtotal);
          expect(prevVat).toBe(vat);
        }
      }
    }
  });

  it("reverses nothing for an exempt line's VAT", () => {
    // An exempt line's VAT component is zero, so every slice of it is zero —
    // no special case is needed anywhere.
    for (const already of [0, 1, 2]) {
      const r = returnedLineAmounts({
        originalSubtotalExclVatCents: 300,
        originalVatCents: 0,
        originalDiscountCents: 0,
        originalQty: 3,
        alreadyReturnedQty: already,
        returningQty: 1,
      });
      expect(r.vatCents).toBe(0);
      expect(r.totalInclVatCents).toBe(r.subtotalExclVatCents);
      expect(r.totalInclVatCents).toBe(100);
    }
  });
});
