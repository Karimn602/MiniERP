/**
 * Credit-memo (return / refund) line math — pure, integer-only.
 *
 * The single source of truth for a return is the ORIGINAL posted sale_item
 * snapshot. We never recompute from current product price / VAT / cost. A
 * partial return prorates the original line's VAT-inclusive total by returned
 * quantity, then backs VAT out so subtotal + VAT === total exactly.
 *
 * IMPORTANT: these formulas MUST stay byte-for-byte equivalent to the Rust
 * `prorate` / `split_incl_vat` helpers in src-tauri/src/posting.rs so the UI
 * preview matches what the server actually posts.
 */

import type { UsdCents } from "./money";

/** Proportional share of `amount` for `q` of `totalQ`, round-half-up. */
export function prorate(amount: number, q: number, totalQ: number): number {
  if (totalQ <= 0) return 0;
  return Math.round((amount * q) / totalQ);
}

/**
 * Split a VAT-inclusive total into { subtotalExclVat, vat } that always sum
 * back to the input. vatBps is integer basis points (1100 = 11%).
 */
export function splitInclVat(
  totalIncl: number,
  vatBps: number,
): { subtotalExclVat: number; vat: number } {
  if (vatBps <= 0) return { subtotalExclVat: totalIncl, vat: 0 };
  const subtotalExclVat = Math.round((totalIncl * 10000) / (10000 + vatBps));
  return { subtotalExclVat, vat: totalIncl - subtotalExclVat };
}

export interface ReturnLineAmounts {
  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
  lineDiscountCents: UsdCents;
  lineCogsExclVatCents: UsdCents;
}

/**
 * Compute the prorated monetary amounts for returning `returnQtyBase` base
 * units of an original sale line. `origQtyBase` is the line's full sold base
 * quantity; the *_orig values are the line's stored snapshots.
 */
export function computeReturnLineAmounts(args: {
  returnQtyBase: number;
  origQtyBase: number;
  origLineTotalInclVatCents: number;
  origLineDiscountCents: number;
  unitCogsExclVatCents: number;
  vatBps: number;
}): ReturnLineAmounts {
  const lineTotal = prorate(
    args.origLineTotalInclVatCents,
    args.returnQtyBase,
    args.origQtyBase,
  );
  const { subtotalExclVat, vat } = splitInclVat(lineTotal, args.vatBps);
  return {
    lineSubtotalExclVatCents: subtotalExclVat,
    lineVatCents: vat,
    lineTotalInclVatCents: lineTotal,
    lineDiscountCents: prorate(
      args.origLineDiscountCents,
      args.returnQtyBase,
      args.origQtyBase,
    ),
    lineCogsExclVatCents: args.unitCogsExclVatCents * args.returnQtyBase,
  };
}
