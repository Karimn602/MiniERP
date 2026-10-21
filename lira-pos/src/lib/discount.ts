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

// ─── Sale-level discount validation ──────────────────────────────────────────
//
// The FINANCIAL RULE is unchanged and deliberately so: a posted sale must keep
// a total of at least one cent, so the largest discount a cart can carry is its
// VAT-inclusive pre-discount total minus a cent. What changes is what happens
// when the cashier asks for more than that.
//
// It used to be clamped in silence — `Math.min(raw, preTotal - 1)` — while the
// input kept showing the typed figure. A $50.00 discount on a $3.00 order
// became $2.99, the screen read "Discount USD 50.00" beside a total of $0.01,
// and nothing said why (GZ-WP0-03). A one-cent sale is also a plausible
// accidental posting. So the request is now evaluated and REFUSED rather than
// quietly rewritten, and the register will not post until it is resolved.

import { parseUsdInput } from "./money";

/** A posted sale keeps at least this much on the total. */
export const MIN_SALE_TOTAL_CENTS = 1;

/** The largest discount this cart may carry, in VAT-inclusive cents. */
export function maxDiscountCents(preDiscountTotalInclVatCents: number): number {
  return Math.max(preDiscountTotalInclVatCents - MIN_SALE_TOTAL_CENTS, 0);
}

export type DiscountEvaluation =
  /** Nothing typed, or nothing to discount. */
  | { kind: "none"; cents: 0 }
  /** Accepted exactly as typed. */
  | { kind: "ok"; cents: number }
  /** Not a USD amount. */
  | { kind: "invalid"; cents: 0 }
  /** More than the cart can bear; carries the permitted maximum to show. */
  | { kind: "exceeds"; cents: 0; requestedCents: number; maxCents: number };

/**
 * Decide what a typed discount amount means for this cart.
 *
 * Note that every rejecting branch returns `cents: 0`. That is the point: an
 * unresolved discount contributes NOTHING to the totals, so the figures on
 * screen stay a faithful description of the cart as it stands, and the cashier
 * is told to fix the discount instead of being shown a total derived from an
 * amount nobody asked for.
 */
export function evaluateDiscountAmount(
  rawInput: string,
  preDiscountTotalInclVatCents: number,
): DiscountEvaluation {
  if (!rawInput.trim() || preDiscountTotalInclVatCents <= 0) return { kind: "none", cents: 0 };

  let requested: number;
  try {
    requested = parseUsdInput(rawInput);
  } catch {
    return { kind: "invalid", cents: 0 };
  }

  if (requested === 0) return { kind: "none", cents: 0 };

  const max = maxDiscountCents(preDiscountTotalInclVatCents);
  if (requested > max) return { kind: "exceeds", cents: 0, requestedCents: requested, maxCents: max };

  return { kind: "ok", cents: requested };
}

export const MAX_DISCOUNT_PERCENT = 100;

export type PercentEvaluation =
  /** Nothing typed, an explicit zero, or nothing to discount. */
  | { kind: "none"; cents: 0 }
  /** A usable percentage, carrying the cash it comes to. */
  | { kind: "ok"; cents: number }
  /** Not a number at all. */
  | { kind: "invalid"; cents: 0 }
  /** Over 100%: there is no more of the order to give away. */
  | { kind: "exceeds"; cents: 0; requestedPct: number }
  /** Positive, but worth less than a cent on this order. */
  | { kind: "tooSmall"; cents: 0; requestedPct: number };

/**
 * Decide what a typed discount PERCENTAGE means for this cart.
 *
 * This exists because the percentage box used to fail in silence (GZ-WP0-07).
 * `150`, `1000` and `abc` all cleared the amount box and applied nothing, while
 * the typed text stayed on screen and Post Sale stayed enabled — the very
 * failure mode the fixed-amount box had just been fixed for, surviving in the
 * field next to it.
 *
 * The cash value is FLOORED, so a derived amount can never exceed the
 * percentage the cashier actually agreed to. 100% is accepted here and then
 * refused downstream by `evaluateDiscountAmount` for leaving nothing on the
 * total: the one-cent floor is stated in exactly one place and this is not it.
 */
export function evaluateDiscountPercent(
  rawPct: string,
  preDiscountTotalInclVatCents: number,
): PercentEvaluation {
  const trimmed = rawPct.trim();
  if (!trimmed || preDiscountTotalInclVatCents <= 0) return { kind: "none", cents: 0 };

  // `parseFloat` is deliberately not used alone: it reads "12abc" as 12, which
  // would apply a discount the cashier never typed.
  if (!/^\d*\.?\d+$/.test(trimmed)) return { kind: "invalid", cents: 0 };

  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) return { kind: "invalid", cents: 0 };
  if (pct === 0) return { kind: "none", cents: 0 };
  if (pct > MAX_DISCOUNT_PERCENT) return { kind: "exceeds", cents: 0, requestedPct: pct };

  const cents = Math.floor((preDiscountTotalInclVatCents * pct) / 100);
  if (cents <= 0) return { kind: "tooSmall", cents: 0, requestedPct: pct };

  return { kind: "ok", cents };
}

/**
 * The exact cash value of a typed percentage, or null when there isn't one.
 *
 * A thin reading of `evaluateDiscountPercent`, so the two cannot drift: this is
 * what the input handler needs (a number or nothing), while the verdict is what
 * the rail needs to explain a refusal.
 */
export function percentToDiscountCents(
  rawPct: string,
  preDiscountTotalInclVatCents: number,
): number | null {
  const ev = evaluateDiscountPercent(rawPct, preDiscountTotalInclVatCents);
  return ev.kind === "ok" ? ev.cents : null;
}

// ─── The cart's discount verdict: both boxes, one answer ─────────────────────
//
// The register has TWO discount inputs and they are linked: typing a percentage
// writes the derived cash into the amount box, and typing an amount writes the
// derived percentage back. Only the amount box was ever evaluated, so the
// percentage box inherited none of the honesty the amount box was given — and
// that is GZ-WP0-07. `150`, `1000` and `abc` each took the SILENT-CLEAR path in
// `handleDiscountPctChange`: the derived amount was blanked, the typed text
// stayed on screen, the evaluated amount was therefore "nothing typed", and the
// order posted at FULL PRICE with Post Sale and F5 both enabled. The cashier
// had every reason to believe a discount was on.
//
// So the page no longer composes two verdicts of its own. It asks this one
// function what the pair of boxes means, and takes the money, the message and
// the posting block from the single answer. One decision, one place.

export type DiscountVerdict =
  /** Nothing typed in either box, or nothing to discount. */
  | { kind: "none"; cents: 0 }
  /** Accepted; carries the cash to apply. */
  | { kind: "ok"; cents: number }
  /** The percentage box holds something that is not a number. */
  | { kind: "pctInvalid"; cents: 0 }
  /** Over 100%: there is no more of the order to give away. */
  | { kind: "pctExceeds"; cents: 0; requestedPct: number }
  /** A positive percentage worth less than a cent on this order. */
  | { kind: "pctTooSmall"; cents: 0; requestedPct: number }
  /** The amount box holds something that is not a USD amount. */
  | { kind: "amountInvalid"; cents: 0 }
  /** More than the cart can bear; carries the permitted maximum to show. */
  | { kind: "amountExceeds"; cents: 0; requestedCents: number; maxCents: number };

/** Whether this verdict must stop the sale from posting. */
export function discountBlocksPosting(v: DiscountVerdict): boolean {
  return v.kind !== "none" && v.kind !== "ok";
}

/**
 * What the two discount boxes, taken together, mean for this cart.
 *
 * The PERCENTAGE is judged first, because it is the upstream control: when it
 * holds something unusable the amount box has been blanked by the input
 * handler, so evaluating the amount alone would report "nothing typed" about a
 * cart whose cashier is staring at `150`. Reporting the percentage is the only
 * answer that describes what is actually on screen.
 *
 * A percentage that is FINE then falls through to the amount box, which is
 * where the derived cash lands and where the one-cent floor lives. That is how
 * `100` is refused: it is a legal percentage, and the cash it comes to leaves
 * nothing on the total, so `evaluateDiscountAmount` refuses it by the same rule
 * that refuses a hand-typed over-discount. The floor is stated once.
 */
export function evaluateCartDiscount(
  rawPct: string,
  rawAmount: string,
  preDiscountTotalInclVatCents: number,
): DiscountVerdict {
  const pct = evaluateDiscountPercent(rawPct, preDiscountTotalInclVatCents);
  switch (pct.kind) {
    case "invalid":
      return { kind: "pctInvalid", cents: 0 };
    case "exceeds":
      return { kind: "pctExceeds", cents: 0, requestedPct: pct.requestedPct };
    case "tooSmall":
      return { kind: "pctTooSmall", cents: 0, requestedPct: pct.requestedPct };
    case "none":
    case "ok":
      break;
  }

  const amount = evaluateDiscountAmount(rawAmount, preDiscountTotalInclVatCents);
  switch (amount.kind) {
    case "invalid":
      return { kind: "amountInvalid", cents: 0 };
    case "exceeds":
      return {
        kind: "amountExceeds",
        cents: 0,
        requestedCents: amount.requestedCents,
        maxCents: amount.maxCents,
      };
    case "none":
      return { kind: "none", cents: 0 };
    case "ok":
      return { kind: "ok", cents: amount.cents };
  }
}
