import { describe, expect, it } from "vitest";
import {
  discountBlocksPosting,
  evaluateCartDiscount,
  evaluateDiscountPercent,
  type DiscountVerdict,
} from "../../src/lib/discount";

/**
 * GZ-WP0-07 — the two discount boxes, judged together.
 *
 * `discount.test.ts` already pins `evaluateDiscountPercent` on its own. What
 * is tested here is the COMBINATION the register actually consults, because
 * the defect was never in the percentage arithmetic: it was that the page
 * evaluated only the amount box, so an unusable percentage blanked the derived
 * amount, reported "nothing typed", and let the order post at full price.
 *
 * `posRegisterWp0.test.tsx` proves the rendered register behaves. These pin the
 * decision table underneath it.
 */

/** A $10.00 cart, VAT-inclusive. */
const CART = 1000;

describe("evaluateCartDiscount (GZ-WP0-07)", () => {
  it("is 'none' when both boxes are empty", () => {
    expect(evaluateCartDiscount("", "", CART)).toEqual({ kind: "none", cents: 0 });
  });

  it("is 'none' on an empty cart whatever is typed", () => {
    // Nothing to discount, so there is no refusal to make either.
    expect(evaluateCartDiscount("150", "", 0).kind).toBe("none");
    expect(evaluateCartDiscount("abc", "9.99", 0).kind).toBe("none");
  });

  it("accepts a percentage and reports the cash it comes to", () => {
    // The register writes the derived cash into the amount box, so the honest
    // input to this function is the pair.
    expect(evaluateCartDiscount("10", "1.00", CART)).toEqual({ kind: "ok", cents: 100 });
  });

  it("accepts a hand-typed amount with no percentage", () => {
    expect(evaluateCartDiscount("", "2.50", CART)).toEqual({ kind: "ok", cents: 250 });
  });

  // --- The findings themselves -------------------------------------------
  //
  // In every case below the amount box is EMPTY, because that is what the
  // register's input handler leaves behind when a percentage cannot be used.
  // Returning "none" for these is exactly the defect.

  it.each([
    ["150", 150],
    ["1000", 1000],
    ["100.5", 100.5],
  ])("refuses %s%% as over the whole order", (typed, requestedPct) => {
    expect(evaluateCartDiscount(typed, "", CART)).toEqual({
      kind: "pctExceeds",
      cents: 0,
      requestedPct,
    });
  });

  it.each([["abc"], ["12abc"], ["-5"], ["1.2.3"], ["%"], ["1e3"], ["Infinity"], ["NaN"]])(
    "refuses %s as not a percentage",
    (typed) => {
      expect(evaluateCartDiscount(typed, "", CART)).toEqual({ kind: "pctInvalid", cents: 0 });
    },
  );

  it("refuses a percentage worth less than a cent", () => {
    // 0.001% of $10.00 is 0.01 cents, which floors to nothing. Applying
    // nothing in silence is the same failure in miniature.
    expect(evaluateCartDiscount("0.001", "", CART)).toEqual({
      kind: "pctTooSmall",
      cents: 0,
      requestedPct: 0.001,
    });
  });

  it("refuses 100% through the amount box's one-cent floor", () => {
    // 100% is a legal percentage. It is refused for what it leaves on the
    // total, by the single rule that owns that floor — not by a second copy
    // of it in the percentage evaluator.
    expect(evaluateCartDiscount("100", "10.00", CART)).toEqual({
      kind: "amountExceeds",
      cents: 0,
      requestedCents: 1000,
      maxCents: 999,
    });
  });

  it("reports the PERCENTAGE when the percentage is the thing that is wrong", () => {
    // Both boxes hold something unusable. The percentage is the upstream
    // control and the one the cashier typed, so it is the one named.
    expect(evaluateCartDiscount("150", "zzz", CART).kind).toBe("pctExceeds");
  });

  it("falls through to the amount box when the percentage is fine", () => {
    expect(evaluateCartDiscount("", "zzz", CART)).toEqual({ kind: "amountInvalid", cents: 0 });
    expect(evaluateCartDiscount("10", "50.00", CART)).toEqual({
      kind: "amountExceeds",
      cents: 0,
      requestedCents: 5000,
      maxCents: 999,
    });
  });

  it("treats an explicit zero in either box as nothing typed", () => {
    expect(evaluateCartDiscount("0", "", CART).kind).toBe("none");
    expect(evaluateCartDiscount("", "0", CART).kind).toBe("none");
    expect(evaluateCartDiscount("0", "0.00", CART).kind).toBe("none");
  });

  it("never returns a non-zero discount on any refusing verdict", () => {
    // The invariant the totals depend on: an unresolved discount contributes
    // NOTHING, so the figures on screen stay a faithful description of the
    // cart. A refusal that still moved the total would be the old bug with a
    // message bolted on.
    const refusals = ["150", "1000", "abc", "-5", "0.001", "100"];
    for (const typed of refusals) {
      const v = evaluateCartDiscount(typed, typed === "100" ? "10.00" : "", CART);
      expect(discountBlocksPosting(v)).toBe(true);
      expect(v.cents).toBe(0);
    }
  });
});

describe("discountBlocksPosting (GZ-WP0-07)", () => {
  it("permits only the two resolved verdicts", () => {
    expect(discountBlocksPosting({ kind: "none", cents: 0 })).toBe(false);
    expect(discountBlocksPosting({ kind: "ok", cents: 100 })).toBe(false);
  });

  it("blocks every refusal", () => {
    const refusals: DiscountVerdict[] = [
      { kind: "pctInvalid", cents: 0 },
      { kind: "pctExceeds", cents: 0, requestedPct: 150 },
      { kind: "pctTooSmall", cents: 0, requestedPct: 0.001 },
      { kind: "amountInvalid", cents: 0 },
      { kind: "amountExceeds", cents: 0, requestedCents: 5000, maxCents: 999 },
    ];
    for (const v of refusals) expect(discountBlocksPosting(v)).toBe(true);
  });
});

describe("evaluateCartDiscount agrees with evaluateDiscountPercent", () => {
  // The two must not drift: the combined verdict is the register's only view
  // of the percentage, so a percentage the pure evaluator refuses must never
  // reach `ok` here.
  const inputs = ["", "0", "1", "10", "99.99", "100", "100.01", "150", "abc", "-1", "0.0001"];

  it.each(inputs)("is consistent for %s", (typed) => {
    const pct = evaluateDiscountPercent(typed, CART);
    const combined = evaluateCartDiscount(
      typed,
      pct.kind === "ok" ? (pct.cents / 100).toFixed(2) : "",
      CART,
    );
    if (pct.kind === "invalid" || pct.kind === "exceeds" || pct.kind === "tooSmall") {
      expect(discountBlocksPosting(combined)).toBe(true);
      expect(combined.kind.startsWith("pct")).toBe(true);
    }
  });
});
