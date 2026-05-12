/**
 * Money & currency utilities.
 *
 * INVARIANTS — never violate these anywhere in the codebase:
 *   - USD is stored and passed around as INTEGER cents (number).
 *     $12.34 → 1234.  Never `12.34`. Never a Decimal class. Never a string.
 *   - LBP is stored as INTEGER whole lira. Sub-lira amounts don't exist.
 *   - Exchange rate is INTEGER lira-per-USD. 89,500 LBP/USD → 89500.
 *
 * All functions here are PURE. No I/O, no rounding surprises hidden away.
 * Rounding policy is explicit at every conversion boundary.
 */

export type UsdCents = number; // integer
export type Lbp = number;      // integer
export type Rate = number;     // integer LBP per 1 USD

// ---------- Guards ----------

function assertInt(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    throw new Error(`${label} must be an integer, got ${n}`);
  }
}

// ---------- Parsing user input ----------

/**
 * Parse a user-typed USD amount ("12.34", "12", "12.3") into integer cents.
 * Rejects negative, NaN, and >2 decimal places.
 */
export function parseUsdInput(raw: string): UsdCents {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`Invalid USD amount: "${raw}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return cents;
}

/** Parse a user-typed LBP amount. Strips commas. Whole lira only. */
export function parseLbpInput(raw: string): Lbp {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d+$/.test(cleaned)) {
    throw new Error(`Invalid LBP amount: "${raw}"`);
  }
  return Number(cleaned);
}

/** Parse a typed exchange rate ("89500" or "89,500"). */
export function parseRateInput(raw: string): Rate {
  return parseLbpInput(raw); // same shape — integer LBP per 1 USD
}

// ---------- Display ----------

export function formatUsd(cents: UsdCents): string {
  assertInt(cents, "cents");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

export function formatLbp(lbp: Lbp): string {
  assertInt(lbp, "lbp");
  return `${lbp.toLocaleString("en-US")} L.L.`;
}

export function formatRate(rate: Rate): string {
  assertInt(rate, "rate");
  return `${rate.toLocaleString("en-US")} L.L. / USD`;
}

// ---------- Conversions ----------

/**
 * Convert LBP → USD cents at a given rate. Rounds to nearest cent (banker's-ish:
 * we use Math.round, which is "round half away from zero" in JS). The rounding
 * direction matters and should be CONSISTENT — never mix policies in one calc.
 */
export function lbpToUsdCents(lbp: Lbp, rate: Rate): UsdCents {
  assertInt(lbp, "lbp");
  assertInt(rate, "rate");
  if (rate <= 0) throw new Error("rate must be positive");
  // cents = lbp / rate * 100, but do it in integer-safe order:
  return Math.round((lbp * 100) / rate);
}

/**
 * Convert USD cents → LBP at a given rate. Rounds to whole lira.
 * Used when a customer pays in USD but we record the LBP equivalent for
 * a daily-sales report in LBP, for instance.
 */
export function usdCentsToLbp(cents: UsdCents, rate: Rate): Lbp {
  assertInt(cents, "cents");
  assertInt(rate, "rate");
  if (rate <= 0) throw new Error("rate must be positive");
  return Math.round((cents * rate) / 100);
}

// ---------- Arithmetic ----------

/** Multiply USD cents by an integer quantity — exact. */
export function multiplyUsd(cents: UsdCents, qty: number): UsdCents {
  assertInt(cents, "cents");
  assertInt(qty, "qty");
  return cents * qty;
}

/**
 * Weighted-average cost recalculation (per Phase 1 spec).
 *   new_avg = (old_qty * old_avg + new_qty * new_cost) / total_qty
 * All inputs/outputs in USD cents; quantities are integers.
 * Rounds the resulting average to the nearest cent.
 */
export function newWeightedAvgCost(args: {
  oldQty: number;
  oldAvgCostCents: UsdCents;
  newQty: number;
  newCostCents: UsdCents;
}): UsdCents {
  const { oldQty, oldAvgCostCents, newQty, newCostCents } = args;
  assertInt(oldQty, "oldQty");
  assertInt(oldAvgCostCents, "oldAvgCostCents");
  assertInt(newQty, "newQty");
  assertInt(newCostCents, "newCostCents");
  const totalQty = oldQty + newQty;
  if (totalQty <= 0) throw new Error("total quantity must be positive");
  const totalValue = oldQty * oldAvgCostCents + newQty * newCostCents;
  return Math.round(totalValue / totalQty);
}