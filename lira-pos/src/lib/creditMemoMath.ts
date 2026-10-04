/**
 * Credit-memo line math — pure, integer-only.
 *
 * The TypeScript mirror of `posting.rs::prorated_cumulative_cents`. The Rust
 * side is authoritative for every persisted value; this module exists so the
 * Create Return screen can show the cashier the exact figure the backend will
 * compute, before they commit to it.
 *
 * ---------------------------------------------------------------------------
 * WHY A MEMO'S SHARE IS A DIFFERENCE OF TWO CUMULATIVE FIGURES
 * ---------------------------------------------------------------------------
 *
 * Rounding each return independently makes the parts disagree with the whole.
 * Three returns of one unit from a 3-unit, $10.00 line each round $3.3333 to
 * $3.33, and the customer ends up a cent short of the line they paid for —
 * permanently, because a posted credit memo is immutable.
 *
 * So the share belonging to a return is
 *
 *     cumulative(already returned + returning) − cumulative(already returned)
 *
 * where `cumulative(q) = round(original × q ÷ original quantity)`. Each memo is
 * still a whole number of cents, and returning every unit lands on the original
 * amount exactly — however many memos it took, and in whatever order.
 *
 * ---------------------------------------------------------------------------
 * WHICH COMPONENTS, AND WHY IT MATTERS
 * ---------------------------------------------------------------------------
 *
 * Each component the sale PERSISTED gets its own cumulative series — the line's
 * subtotal, its VAT, its discount allocation — and the returned TOTAL is the
 * sum of the subtotal and VAT slices. The total is never prorated on its own,
 * and VAT is never a residual.
 *
 * The first implementation prorated the total and the subtotal and took VAT as
 * `total − subtotal`. Each of those series is monotone, but their DIFFERENCE is
 * not: the two roundings can move opposite ways on the same step. An 11-cent,
 * 3-unit line of 10 net + 1 VAT:
 *
 *          cumulative total    cumulative subtotal    residual VAT
 *   q = 1  round(11/3) = 4     round(10/3) = 3        4 − 3 =  1
 *   q = 2  round(22/3) = 7     round(20/3) = 7        3 − 4 = −1   <-- !
 *   q = 3              11                    10
 *
 * Returning the second unit asked to credit minus a cent of VAT, and the
 * backend's non-negative-VAT check refused a return the customer was entitled
 * to. Prorating the components separately fixes it at the root: both originals
 * are non-negative, so both series are monotone and every slice is
 * non-negative, and each lands exactly on its own original at full return, so
 * their sum lands exactly on the line total.
 */

import { divRoundHalfAway } from "./cost";
import type { UsdCents } from "./money";

function assertInt(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    throw new Error(`${label} must be an integer, got ${n}`);
  }
}

/**
 * The share of `originalAmount` that belongs to `cumulativeQty` of
 * `originalQty` units: `round(originalAmount × cumulativeQty ÷ originalQty)`,
 * half away from zero, taken in BigInt so the product cannot lose precision.
 */
export function proratedCumulativeCents(
  originalAmount: UsdCents,
  cumulativeQty: number,
  originalQty: number,
): UsdCents {
  assertInt(originalAmount, "originalAmount");
  assertInt(cumulativeQty, "cumulativeQty");
  assertInt(originalQty, "originalQty");
  if (originalQty <= 0) {
    throw new Error("the original line must have a positive quantity");
  }
  if (cumulativeQty < 0 || cumulativeQty > originalQty) {
    throw new Error(
      `cumulative returned quantity ${cumulativeQty} is outside 0..=${originalQty}`,
    );
  }
  if (originalAmount < 0) {
    throw new Error("the original line amount cannot be negative");
  }
  return Number(
    divRoundHalfAway(BigInt(originalAmount) * BigInt(cumulativeQty), BigInt(originalQty)),
  );
}

export interface ReturnedShareArgs {
  /** The ORIGINAL sale line's amount — total, subtotal or discount. */
  originalAmount: UsdCents;
  /** The ORIGINAL sale line's quantity, in base units. */
  originalQty: number;
  /** What POSTED credit memos have already sent back, in base units. */
  alreadyReturnedQty: number;
  /** What this return is sending back, in base units. */
  returningQty: number;
}

/**
 * What THIS return credits of ONE original line component. See the module note:
 * the difference of two cumulative shares, never an independent rounding of the
 * component itself.
 */
export function returnedShareCents(args: ReturnedShareArgs): UsdCents {
  const { originalAmount, originalQty, alreadyReturnedQty, returningQty } = args;
  const to = proratedCumulativeCents(
    originalAmount,
    alreadyReturnedQty + returningQty,
    originalQty,
  );
  const from = proratedCumulativeCents(originalAmount, alreadyReturnedQty, originalQty);
  return to - from;
}

export interface ReturnedLineAmounts {
  subtotalExclVatCents: UsdCents;
  vatCents: UsdCents;
  /** Always `subtotalExclVatCents + vatCents`. */
  totalInclVatCents: UsdCents;
  discountCents: UsdCents;
}

/**
 * Everything one return credits of one original sale line.
 *
 * The exact mirror of what `post_credit_memo` derives, so the Create Return
 * screen can show the figure the backend will compute before the cashier
 * commits to it. Subtotal, VAT and discount each get their own cumulative
 * series; the total is their sum, never its own rounding.
 *
 * Still only a preview: the backend re-derives all of it inside the posting
 * transaction, against the already-returned quantity as it stands THEN.
 */
export function returnedLineAmounts(args: {
  /** The ORIGINAL line's persisted components. */
  originalSubtotalExclVatCents: UsdCents;
  originalVatCents: UsdCents;
  originalDiscountCents: UsdCents;
  /** The ORIGINAL line's quantity, in base units. */
  originalQty: number;
  /** What POSTED credit memos have already sent back, in base units. */
  alreadyReturnedQty: number;
  /** What this return is sending back, in base units. */
  returningQty: number;
}): ReturnedLineAmounts {
  const {
    originalSubtotalExclVatCents,
    originalVatCents,
    originalDiscountCents,
    originalQty,
    alreadyReturnedQty,
    returningQty,
  } = args;

  const slice = (originalAmount: UsdCents): UsdCents =>
    returnedShareCents({
      originalAmount,
      originalQty,
      alreadyReturnedQty,
      returningQty,
    });

  const subtotalExclVatCents = slice(originalSubtotalExclVatCents);
  const vatCents = slice(originalVatCents);
  return {
    subtotalExclVatCents,
    vatCents,
    totalInclVatCents: subtotalExclVatCents + vatCents,
    discountCents: slice(originalDiscountCents),
  };
}
