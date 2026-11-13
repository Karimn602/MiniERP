import { describe, expect, it } from "vitest";
import {
  allocateLineDiscounts,
  evaluateDiscountAmount,
  maxDiscountCents,
  percentToDiscountCents,
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

// ─────────────────────────────────────────────────────────────────────────────
// GZ-WP0-03 — an excessive discount is refused, never silently clamped
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateDiscountAmount (GZ-WP0-03)", () => {
  it("accepts an amount the cart can bear, exactly as typed", () => {
    expect(evaluateDiscountAmount("2.00", 1000)).toEqual({ kind: "ok", cents: 200 });
  });

  it("REFUSES an excessive discount instead of clamping it", () => {
    // The defect: $50.00 off a $3.00 order used to become $2.99 and a 1c sale,
    // with the box still reading 50.00 and nothing explaining the difference.
    const got = evaluateDiscountAmount("50.00", 300);
    expect(got.kind).toBe("exceeds");
    expect(got.cents).toBe(0); // nothing applied — the totals stay truthful
    if (got.kind === "exceeds") {
      expect(got.requestedCents).toBe(5000);
      expect(got.maxCents).toBe(299);
    }
  });

  it("accepts exactly the maximum, and refuses one cent more", () => {
    expect(evaluateDiscountAmount("2.99", 300)).toEqual({ kind: "ok", cents: 299 });
    expect(evaluateDiscountAmount("3.00", 300).kind).toBe("exceeds");
  });

  it("leaves at least one cent on every accepted discount", () => {
    for (const preTotal of [1, 2, 3, 100, 999, 123_456]) {
      for (const cents of [0, 1, Math.floor(preTotal / 2), preTotal - 1, preTotal, preTotal + 1]) {
        if (cents < 0) continue;
        const res = evaluateDiscountAmount((cents / 100).toFixed(2), preTotal);
        if (res.kind === "ok") expect(preTotal - res.cents).toBeGreaterThanOrEqual(1);
        else expect(res.cents).toBe(0);
      }
    }
  });

  it("treats blank, zero and an empty cart as no discount at all", () => {
    expect(evaluateDiscountAmount("", 1000)).toEqual({ kind: "none", cents: 0 });
    expect(evaluateDiscountAmount("   ", 1000)).toEqual({ kind: "none", cents: 0 });
    expect(evaluateDiscountAmount("0.00", 1000)).toEqual({ kind: "none", cents: 0 });
    expect(evaluateDiscountAmount("5.00", 0)).toEqual({ kind: "none", cents: 0 });
  });

  it("refuses a non-amount rather than silently reading it as zero", () => {
    for (const bad of ["abc", "1.234", "-5.00", "1,000", "$5"]) {
      const got = evaluateDiscountAmount(bad, 10_000);
      expect(got.kind, bad).toBe("invalid");
      expect(got.cents).toBe(0);
    }
  });

  it("never returns a non-zero amount on any rejecting branch", () => {
    // The whole point: an unresolved discount contributes nothing, so the
    // figures on screen always describe the cart as it actually stands.
    for (const raw of ["", "abc", "999999.00", "-1.00", "0.00"]) {
      const got = evaluateDiscountAmount(raw, 500);
      if (got.kind !== "ok") expect(got.cents).toBe(0);
    }
  });
});

describe("maxDiscountCents", () => {
  it("is the pre-discount total less one cent", () => {
    expect(maxDiscountCents(1000)).toBe(999);
    expect(maxDiscountCents(1)).toBe(0);
  });

  it("never goes negative on an empty or zero-value cart", () => {
    expect(maxDiscountCents(0)).toBe(0);
    expect(maxDiscountCents(-50)).toBe(0);
  });
});

describe("percentToDiscountCents", () => {
  it("floors, so a derived amount never exceeds the percentage agreed", () => {
    // 33% of $10.00 is 330.0; 33% of $3.33 is 109.89 -> 109, not 110.
    expect(percentToDiscountCents("33", 1000)).toBe(330);
    expect(percentToDiscountCents("33", 333)).toBe(109);
  });

  it("does NOT clamp — an over-large percentage yields its true cash value", () => {
    // Clamping here is what made the % box and the $ box describe different
    // discounts. The refusal happens once, in evaluateDiscountAmount.
    expect(percentToDiscountCents("100", 300)).toBe(300);
    expect(evaluateDiscountAmount("3.00", 300).kind).toBe("exceeds");
  });

  it("rejects a percentage that is not usable", () => {
    for (const bad of ["", "abc", "0", "-5", "101", "150"]) {
      expect(percentToDiscountCents(bad, 1000), bad).toBeNull();
    }
    expect(percentToDiscountCents("50", 0)).toBeNull();
  });

  it("round-trips the two boxes without drifting", () => {
    for (const preTotal of [300, 1000, 1999, 12_345]) {
      for (const pct of ["5", "10", "12.5", "33", "99"]) {
        const cents = percentToDiscountCents(pct, preTotal)!;
        const res = evaluateDiscountAmount((cents / 100).toFixed(2), preTotal);
        if (res.kind === "ok") expect(res.cents).toBe(cents);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GZ-WP0-04 — the register's totals strip must add up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the exact figures `PosRegister`'s totals memo produces, from the two
 * functions that own them. The rail now renders these and `handlePost` posts
 * them, so an identity proved here is an identity on the screen AND on the
 * receipt.
 */
function railFigures(cart: { total: number; bps: number }[], discountCents: number) {
  const allocatable = cart.map((l) => ({ math: { lineTotalInclVatCents: l.total } }));
  const alloc = allocateLineDiscounts(allocatable, discountCents);
  let netExclVat = 0;
  let vat = 0;
  let total = 0;
  cart.forEach((l, i) => {
    const pd = postDiscountLineTotals(l.total, alloc[i], l.bps);
    netExclVat += pd.subtotalExclVat;
    vat += pd.vat;
    total += pd.totalInclVat;
  });
  return {
    itemsInclVat: cart.reduce((s, l) => s + l.total, 0),
    discount: discountCents,
    netExclVat,
    vat,
    total,
  };
}

describe("the totals strip adds up (GZ-WP0-04)", () => {
  const CARTS: { name: string; cart: { total: number; bps: number }[] }[] = [
    { name: "the S16 cart that exposed it: 2 x $6.00 incl-VAT", cart: [{ total: 1200, bps: STANDARD }] },
    { name: "single VAT-inclusive line", cart: [{ total: 600, bps: STANDARD }] },
    { name: "exempt line", cart: [{ total: 1000, bps: 0 }] },
    { name: "mixed exempt and standard", cart: [{ total: 1000, bps: 0 }, { total: 600, bps: STANDARD }] },
    {
      name: "awkward primes",
      cart: [{ total: 997, bps: STANDARD }, { total: 983, bps: STANDARD }, { total: 1, bps: STANDARD }],
    },
    { name: "many small lines", cart: Array.from({ length: 9 }, () => ({ total: 333, bps: STANDARD })) },
  ];

  it("subtotal + VAT = total when there is no discount", () => {
    // The original bug showed here with no discount at all: the rail printed
    // the PRE-discount subtotal, 1082, beside VAT 119 and a total of 1200.
    for (const { name, cart } of CARTS) {
      const f = railFigures(cart, 0);
      expect(f.netExclVat + f.vat, name).toBe(f.total);
    }
    const s16 = railFigures(CARTS[0].cart, 0);
    expect(s16).toMatchObject({ netExclVat: 1081, vat: 119, total: 1200 });
    expect(s16.netExclVat + s16.vat).toBe(1200);
  });

  it("items minus discount = total, and net + VAT = total, for every discount", () => {
    for (const { name, cart } of CARTS) {
      const preTotal = cart.reduce((s, l) => s + l.total, 0);
      for (const d of [1, 2, 7, 50, Math.floor(preTotal / 3), Math.floor(preTotal / 2), preTotal - 1]) {
        if (d <= 0 || d > maxDiscountCents(preTotal)) continue;
        const f = railFigures(cart, d);
        expect(f.itemsInclVat - f.discount, `${name} @${d}: items ladder`).toBe(f.total);
        expect(f.netExclVat + f.vat, `${name} @${d}: VAT ladder`).toBe(f.total);
      }
    }
  });

  it("never shows a negative VAT or a negative net", () => {
    for (const { name, cart } of CARTS) {
      const preTotal = cart.reduce((s, l) => s + l.total, 0);
      for (const d of [0, 1, maxDiscountCents(preTotal)]) {
        const f = railFigures(cart, d);
        expect(f.vat, name).toBeGreaterThanOrEqual(0);
        expect(f.netExclVat, name).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the displayed total is what an accepted discount produces, not a clamped one", () => {
    // $50.00 off a $3.00 order is refused, so the rail shows the undiscounted
    // order — NOT a 1c total derived from an amount nobody agreed to.
    const cart = [{ total: 300, bps: STANDARD }];
    const refused = evaluateDiscountAmount("50.00", 300);
    expect(refused.cents).toBe(0);
    const f = railFigures(cart, refused.cents);
    expect(f.total).toBe(300);
    expect(f.netExclVat + f.vat).toBe(300);
  });
});

// GZ-VAT-1: `post_sale` now REFUSES a new sale line whose split is not the
// product's rate applied to the line total, by `posting.rs::strip_vat`. That
// is only safe if the register's own rule is the same rule. The Rust suite
// holds `strip_vat` to this exact specification
// (`vat_authority::the_backend_split_is_the_exactly_rounded_quotient_for_every_small_total`);
// this holds the register's to it, over the same range.
describe("postDiscountLineTotals is the rule post_sale enforces (GZ-VAT-1)", () => {
  /**
   * net = nearest integer to total × 10000 / (10000 + bps), a half going up —
   * in exact integer arithmetic (total × 10000 stays far below 2^53 here).
   */
  function exactNet(total: number, bps: number): number {
    const num = total * 10000;
    const d = 10000 + bps;
    const lo = Math.floor(num / d);
    return 2 * (num - lo * d) >= d ? lo + 1 : lo;
  }

  it("splits every small total exactly as the backend does, at every rate step", () => {
    const rates = [...Array.from({ length: 101 }, (_, i) => i * 100), 1, 25, 550, 9999];
    const mismatches: string[] = [];
    for (const bps of rates) {
      for (let total = 1; total <= 20000; total++) {
        const pd = postDiscountLineTotals(total, 0, bps);
        if (pd.subtotalExclVat !== exactNet(total, bps) || pd.vat !== total - pd.subtotalExclVat) {
          mismatches.push(`${total}@${bps}: ${pd.subtotalExclVat}+${pd.vat}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("splits the post-DISCOUNT total, not the undiscounted one", () => {
    // Two $10.00 coffees, $4.00 off: $16.00 at 11% is 1441 + 159.
    expect(postDiscountLineTotals(2000, 400, STANDARD)).toEqual({
      subtotalExclVat: 1441,
      vat: 159,
      totalInclVat: 1600,
    });
  });
});
