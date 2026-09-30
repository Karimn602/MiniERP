/**
 * Sale-level discount allocation — pure, integer-only.
 *
 * Extracted verbatim from pages/PosRegister.tsx (WP-01) so the allocation
 * invariants can be unit-tested without importing the React page. The
 * formulas, rounding, and types are unchanged.
 *
 * The parameter type is structural on purpose: the POS page passes its own
 * `CartLine[]`, which satisfies this shape, so call sites are unaffected.
 */

export interface DiscountAllocatableLine {
  math: { lineTotalInclVatCents: number };
}

// Allocate a sale-level discount proportionally across lines by incl-VAT weight.
// Guarantees sum(result) === totalDiscountCents exactly via largest-remainder rounding.
export function allocateLineDiscounts(
  lines: DiscountAllocatableLine[],
  totalDiscountCents: number,
): number[] {
  if (lines.length === 0 || totalDiscountCents <= 0) return lines.map(() => 0);
  const preTotal = lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0);
  if (preTotal <= 0) return lines.map(() => 0);

  const allocated = lines.map((l) =>
    Math.floor((totalDiscountCents * l.math.lineTotalInclVatCents) / preTotal),
  );

  let remainder = totalDiscountCents - allocated.reduce((s, x) => s + x, 0);
  if (remainder > 0) {
    const sorted = lines
      .map((l, i) => ({ i, total: l.math.lineTotalInclVatCents }))
      .sort((a, b) => b.total - a.total);
    let idx = 0;
    while (remainder > 0) {
      allocated[sorted[idx % sorted.length].i]++;
      remainder--;
      idx++;
    }
  }
  return allocated;
}

// Back-calculate post-discount excl-VAT and VAT for a single line.
// Returns values that always satisfy: subtotalExclVat + vat === totalInclVat.
export function postDiscountLineTotals(
  lineTotalInclVat: number,
  lineDiscountCents: number,
  vatBps: number,
): { subtotalExclVat: number; vat: number; totalInclVat: number } {
  const discountedTotal = lineTotalInclVat - lineDiscountCents;
  if (vatBps === 0) {
    return { subtotalExclVat: discountedTotal, vat: 0, totalInclVat: discountedTotal };
  }
  const subtotalExclVat = Math.round((discountedTotal * 10000) / (10000 + vatBps));
  return { subtotalExclVat, vat: discountedTotal - subtotalExclVat, totalInclVat: discountedTotal };
}
