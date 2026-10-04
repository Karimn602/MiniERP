import { describe, expect, it } from "vitest";
import { addVat, formatBps, stripVat, vatFromGross, vatFromNet } from "../../src/lib/vat";

const STANDARD = 1100; // Lebanon, 11%
const EXEMPT = 0;

describe("addVat / stripVat at the standard rate", () => {
  it("adds and removes 11% exactly on round amounts", () => {
    expect(addVat(10_000, STANDARD)).toBe(11_100); // $100.00 → $111.00
    expect(stripVat(11_100, STANDARD)).toBe(10_000);
    expect(vatFromNet(10_000, STANDARD)).toBe(1_100);
    expect(vatFromGross(11_100, STANDARD)).toBe(1_100);
  });

  it("handles the zero boundary", () => {
    expect(addVat(0, STANDARD)).toBe(0);
    expect(stripVat(0, STANDARD)).toBe(0);
    expect(vatFromNet(0, STANDARD)).toBe(0);
    expect(vatFromGross(0, STANDARD)).toBe(0);
  });

  it("handles sub-cent tax on tiny amounts", () => {
    // 11% of one cent is 0.11¢, which rounds away.
    expect(addVat(1, STANDARD)).toBe(1);
    expect(vatFromNet(1, STANDARD)).toBe(0);
    // Five cents gross: the net is rounded to the nearest cent.
    expect(stripVat(5, STANDARD)).toBe(5);
    expect(vatFromGross(5, STANDARD)).toBe(0);
  });

  it("stays exact on large amounts", () => {
    expect(addVat(1_000_000, STANDARD)).toBe(1_110_000);
    expect(stripVat(1_110_000, STANDARD)).toBe(1_000_000);
  });
});

describe("exempt and zero-rated lines", () => {
  it("adds no tax at all", () => {
    for (const amount of [0, 1, 999, 123_456]) {
      expect(addVat(amount, EXEMPT)).toBe(amount);
      expect(stripVat(amount, EXEMPT)).toBe(amount);
      expect(vatFromNet(amount, EXEMPT)).toBe(0);
      expect(vatFromGross(amount, EXEMPT)).toBe(0);
    }
  });
});

describe("decomposition invariants", () => {
  it("net + tax always reconstitutes the gross, exactly", () => {
    // This is the invariant every sale line depends on.
    for (const bps of [0, 500, 1100, 1500]) {
      for (const gross of [0, 1, 7, 99, 100, 555, 1_110, 9_999, 123_456, 10_000_000]) {
        expect(stripVat(gross, bps) + vatFromGross(gross, bps)).toBe(gross);
      }
    }
  });

  it("net → gross → net round-trips within one cent", () => {
    // Rounding at both boundaries can cost a cent; it must never cost more.
    for (const bps of [500, 1100, 1500]) {
      for (let net = 0; net <= 2_000; net += 7) {
        const back = stripVat(addVat(net, bps), bps);
        expect(Math.abs(back - net)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("tax computed from net and from gross agree within one cent", () => {
    for (let net = 1; net <= 5_000; net += 13) {
      const gross = addVat(net, STANDARD);
      expect(Math.abs(vatFromNet(net, STANDARD) - vatFromGross(gross, STANDARD))).toBeLessThanOrEqual(1);
    }
  });
});

describe("input guards", () => {
  it("rejects non-integer money or rates", () => {
    expect(() => addVat(100.5, STANDARD)).toThrow();
    expect(() => addVat(100, 11.5)).toThrow();
    expect(() => stripVat(100.5, STANDARD)).toThrow();
    expect(() => stripVat(100, 11.5)).toThrow();
  });
});

describe("formatBps", () => {
  it("renders whole percents without decimals and finer rates with two", () => {
    expect(formatBps(1100)).toBe("11%");
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(500)).toBe("5%");
    expect(formatBps(1050)).toBe("10.50%");
    expect(formatBps(1125)).toBe("11.25%");
  });
});

describe("the boundary figures the purchase cost pair is derived with", () => {
  // Since the WP-05 correction `post_purchase` treats exactly ONE side of a
  // purchase line's excl/incl cost pair as the invoice's and derives the other
  // with these two functions' exact rules — `posting.rs::add_vat` and
  // `strip_vat` mirror them in integer arithmetic — then refuses the line if
  // the client's counterpart disagrees.
  //
  // So these are no longer only client display figures: they are a cross-
  // language contract. If this rounding ever changes on one side only, every
  // invoice landing on a half-cent starts being rejected as "not one price".
  // The Rust side pins the same numbers in `pure.rs`; this is the other half.
  const STD = 1100;

  it("rounds an exact half-cent of VAT away from zero", () => {
    // 50 × 11% = 5.5 cents exactly.
    expect(addVat(50, STD)).toBe(56);
    // 150 × 11% = 16.5 cents exactly.
    expect(addVat(150, STD)).toBe(167);
  });

  it("is not an exact round trip at cent precision, which is why the mode decides", () => {
    // A gross price of 55 strips to a net of 50, but grossing 50 back up gives
    // 56 — so (50, 55) is a coherent gross-quoted invoice and an impossible
    // net-quoted one. The backend cannot infer which side was typed; the line's
    // pricing mode has to say.
    expect(stripVat(55, STD)).toBe(50);
    expect(addVat(50, STD)).not.toBe(55);
    // Whereas (50, 56) reads coherently from either side.
    expect(stripVat(56, STD)).toBe(50);
  });

  it("adds and strips nothing at an exempt rate, so the pair is one figure", () => {
    for (const amount of [1, 150, 99_999]) {
      expect(addVat(amount, 0)).toBe(amount);
      expect(stripVat(amount, 0)).toBe(amount);
    }
  });
});
