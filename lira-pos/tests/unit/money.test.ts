import { describe, expect, it } from "vitest";
import {
  formatLbp,
  formatRate,
  formatUsd,
  lbpToUsdCents,
  multiplyUsd,
  newWeightedAvgCost,
  parseLbpInput,
  parseRateInput,
  parseUsdInput,
  usdCentsToLbp,
} from "../../src/lib/money";

describe("parseUsdInput", () => {
  it("parses whole and fractional amounts into integer cents", () => {
    expect(parseUsdInput("12.34")).toBe(1234);
    expect(parseUsdInput("12")).toBe(1200);
    expect(parseUsdInput("12.3")).toBe(1230); // one decimal is tenths, not hundredths
    expect(parseUsdInput(" 7.05 ")).toBe(705);
  });

  it("accepts the zero boundary", () => {
    expect(parseUsdInput("0")).toBe(0);
    expect(parseUsdInput("0.00")).toBe(0);
    expect(parseUsdInput("0.01")).toBe(1);
  });

  it("handles large amounts exactly", () => {
    expect(parseUsdInput("1234567.89")).toBe(123456789);
  });

  it("rejects anything that is not a plain non-negative 2-decimal amount", () => {
    for (const bad of ["12.345", "-1", "", "abc", "1,000", "1.", ".5", "1e3", "12.3.4"]) {
      expect(() => parseUsdInput(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe("parseLbpInput / parseRateInput", () => {
  it("strips thousands separators and returns whole lira", () => {
    expect(parseLbpInput("89,500")).toBe(89500);
    expect(parseLbpInput("1500000")).toBe(1500000);
    expect(parseLbpInput("0")).toBe(0);
    expect(parseRateInput("89,500")).toBe(89500);
  });

  it("rejects sub-lira and non-numeric input", () => {
    for (const bad of ["89.5", "-1", "", "L.L. 500"]) {
      expect(() => parseLbpInput(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe("formatting", () => {
  it("renders USD cents with two decimals and thousands separators", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(1234)).toBe("$12.34");
    expect(formatUsd(123456789)).toBe("$1,234,567.89");
  });

  it("puts the sign ahead of the currency symbol", () => {
    expect(formatUsd(-1234)).toBe("-$12.34");
    expect(formatUsd(-5)).toBe("-$0.05");
  });

  it("renders LBP and rates", () => {
    expect(formatLbp(89500)).toBe("89,500 L.L.");
    expect(formatLbp(0)).toBe("0 L.L.");
    expect(formatRate(89500)).toBe("89,500 L.L. / USD");
  });

  it("refuses non-integer money, which would mean a float crept in", () => {
    expect(() => formatUsd(12.34)).toThrow();
    expect(() => formatLbp(89500.5)).toThrow();
  });
});

describe("currency conversion at a locked rate", () => {
  const RATE = 89_500;

  it("converts whole dollars exactly in both directions", () => {
    expect(usdCentsToLbp(100, RATE)).toBe(89_500);
    expect(lbpToUsdCents(89_500, RATE)).toBe(100);
    expect(usdCentsToLbp(0, RATE)).toBe(0);
    expect(lbpToUsdCents(0, RATE)).toBe(0);
  });

  it("rounds to the nearest minor unit", () => {
    // Half a dollar.
    expect(lbpToUsdCents(44_750, RATE)).toBe(50);
    // One cent's worth of lira.
    expect(usdCentsToLbp(1, RATE)).toBe(895);
    // Less than a cent rounds down to nothing.
    expect(lbpToUsdCents(1, RATE)).toBe(0);
    expect(lbpToUsdCents(447, RATE)).toBe(0);
    expect(lbpToUsdCents(448, RATE)).toBe(1);
  });

  it("round-trips USD → LBP → USD without drift at this rate", () => {
    for (const cents of [1, 5, 99, 100, 1234, 99_999, 1_000_000]) {
      expect(lbpToUsdCents(usdCentsToLbp(cents, RATE), RATE)).toBe(cents);
    }
  });

  it("rejects a non-positive rate rather than dividing by zero", () => {
    expect(() => lbpToUsdCents(1000, 0)).toThrow();
    expect(() => lbpToUsdCents(1000, -1)).toThrow();
    expect(() => usdCentsToLbp(1000, 0)).toThrow();
  });

  it("requires integer inputs", () => {
    expect(() => lbpToUsdCents(100.5, RATE)).toThrow();
    expect(() => usdCentsToLbp(100, 89_500.5)).toThrow();
  });
});

describe("multiplyUsd", () => {
  it("is exact for integer quantities", () => {
    expect(multiplyUsd(499, 3)).toBe(1497);
    expect(multiplyUsd(499, 0)).toBe(0);
    expect(multiplyUsd(123456, 9999)).toBe(1_234_436_544); // $1,234.56 × 9,999
  });

  it("rejects fractional quantities, which belong in a UoM conversion", () => {
    expect(() => multiplyUsd(100, 1.5)).toThrow();
    expect(() => multiplyUsd(100.5, 2)).toThrow();
  });
});

describe("newWeightedAvgCost", () => {
  it("adopts the first purchase cost when there is no stock", () => {
    expect(
      newWeightedAvgCost({ oldQty: 0, oldAvgCostCents: 0, newQty: 100, newCostCents: 250 }),
    ).toBe(250);
  });

  it("blends proportionally", () => {
    expect(
      newWeightedAvgCost({ oldQty: 100, oldAvgCostCents: 100, newQty: 100, newCostCents: 200 }),
    ).toBe(150);
    expect(
      newWeightedAvgCost({ oldQty: 300, oldAvgCostCents: 100, newQty: 100, newCostCents: 200 }),
    ).toBe(125);
  });

  it("does not move when restocking at the current average", () => {
    expect(
      newWeightedAvgCost({ oldQty: 40, oldAvgCostCents: 733, newQty: 60, newCostCents: 733 }),
    ).toBe(733);
  });

  it("rounds a half-cent average to the nearest cent", () => {
    expect(
      newWeightedAvgCost({ oldQty: 1, oldAvgCostCents: 100, newQty: 1, newCostCents: 101 }),
    ).toBe(101);
  });

  it("stays exact at warehouse scale", () => {
    expect(
      newWeightedAvgCost({
        oldQty: 50_000,
        oldAvgCostCents: 20_000,
        newQty: 10_000,
        newCostCents: 25_000,
      }),
    ).toBe(20_833);
  });

  it("refuses a non-positive resulting quantity", () => {
    expect(() =>
      newWeightedAvgCost({ oldQty: 0, oldAvgCostCents: 100, newQty: 0, newCostCents: 100 }),
    ).toThrow();
    expect(() =>
      newWeightedAvgCost({ oldQty: 10, oldAvgCostCents: 100, newQty: -10, newCostCents: 100 }),
    ).toThrow();
  });

  it("agrees with the Rust implementation used at posting time", () => {
    // Mirrors posting.rs::new_weighted_avg — the two must never diverge.
    const cases = [
      [0, 0, 100, 250, 250],
      [100, 100, 100, 200, 150],
      [300, 100, 100, 200, 125],
      [40, 733, 60, 733, 733],
      [1, 100, 1, 101, 101],
      [50_000, 20_000, 10_000, 25_000, 20_833],
    ] as const;
    for (const [oldQty, oldAvgCostCents, newQty, newCostCents, expected] of cases) {
      expect(newWeightedAvgCost({ oldQty, oldAvgCostCents, newQty, newCostCents })).toBe(expected);
    }
  });
});
