/**
 * Unit-cost fixed-point arithmetic — pure, integer-only, BigInt-checked.
 *
 * The TypeScript mirror of `src-tauri/src/cost.rs`. Both files define the SAME
 * scale and the SAME rounding rule, and the Rust side is authoritative for
 * every persisted value; this module exists so the UI can show, and the
 * purchase payload can carry, exactly what the backend will compute.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND SCALE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Transaction MONEY stays exact integer USD cents (see `lib/money.ts`). A cent
 * is the smallest amount that can be invoiced, paid or banked.
 *
 * A UNIT COST is not money — it is a RATE, money per base unit, and when the
 * purchasing UoM is much larger than the base UoM that rate is legitimately
 * smaller than a cent:
 *
 *     flour at $2.50 / kg stocked in grams  ->  $0.0025 / g
 *     oil   at $3.00 / L  consumed in ml    ->  $0.0030 / ml
 *
 * In whole cents both collapse to 0, COGS becomes zero and margin becomes
 * fiction (GP-A03). So unit cost — and only unit cost — carries a finer scale.
 *
 * ---------------------------------------------------------------------------
 * THE REPRESENTATION
 * ---------------------------------------------------------------------------
 *
 *     1 cent = COST_SCALE microcents (1_000_000)
 *     1 microcent = 1e-6 cents = 1e-8 USD
 *
 * INVARIANTS — never violate these:
 *   - A microcent value is an INTEGER `number`, always a safe integer.
 *   - Arithmetic on microcents happens in BigInt inside this module. A
 *     `number` multiplication of two scaled values silently loses precision
 *     above 2^53, and a float must never become the source of truth for an
 *     accounting value.
 *   - Rounding is HALF AWAY FROM ZERO, performed only by `divRoundHalfAway`.
 *   - Rounding a unit cost to cents is PRESENTATION. Never feed the result of
 *     `microcentsToCents` into another cost calculation.
 */

import type { UsdCents } from "./money";
import { assertValidFactor, type Factor } from "./uom";

/** Microcents per cent. The Rust twin is `cost::COST_SCALE`. */
export const COST_SCALE = 1_000_000;

/** An integer count of microcents (1e-6 cents). */
export type Microcents = number;

const SCALE = BigInt(COST_SCALE);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function assertInt(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    throw new Error(`${label} must be an integer, got ${n}`);
  }
}

/**
 * Narrow a BigInt result back to a `number`, refusing anything that would stop
 * being exact. The Rust mirror performs the same check against i64; here the
 * binding constraint is the double's 53-bit mantissa, which is tighter, so a
 * value this accepts is also representable in the database column.
 */
function toSafeNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new Error(`${what} is out of range (${value})`);
  }
  return Number(value);
}

/**
 * `numerator / denominator`, rounded half away from zero.
 *
 * The central rounding helper. Every cost boundary goes through it, so the
 * rounding rule is one testable decision rather than a convention repeated at
 * each call site.
 */
export function divRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error(`cost division requires a positive divisor, got ${denominator}`);
  }
  const half = denominator / 2n;
  const adjusted = numerator >= 0n ? numerator + half : numerator - half;
  // BigInt division truncates toward zero, which is what the adjustment assumes.
  return adjusted / denominator;
}

/**
 * Exact: a whole-cent cost expressed in microcents. Migration 008's backfill is
 * this same multiplication, which is why pre-WP-03 cost data converts without
 * losing or inventing a fraction.
 */
export function centsToMicrocents(cents: UsdCents): Microcents {
  assertInt(cents, "cents");
  return toSafeNumber(BigInt(cents) * SCALE, "cost in microcents");
}

/**
 * Lossy by design: a microcent cost rounded to the nearest whole cent.
 *
 * PRESENTATION / compatibility only — it maintains the legacy `*_cents` cost
 * columns beside their microcent counterparts. Feeding its result into another
 * cost calculation is exactly the early rounding GP-A03 is about.
 */
export function microcentsToCents(microcents: Microcents): UsdCents {
  assertInt(microcents, "microcents");
  return toSafeNumber(divRoundHalfAway(BigInt(microcents), SCALE), "cost in cents");
}

/**
 * Per-base-unit cost, in microcents, of something priced per purchasing UoM.
 *
 *     base cost = cost per UoM * den / num      (1 UoM = num/den base units)
 *
 * The GP-A03 fix: the division happens ONCE, at microcent scale, never after a
 * rounding to cents. `$2.50/kg` with a gram base (1000/1) gives 250_000
 * microcents — $0.0025/g — where `unitCostInUomToBase` gives 0.
 */
export function unitCostInUomToBaseMicrocents(
  costPerUomCents: UsdCents,
  factor: Factor,
): Microcents {
  assertInt(costPerUomCents, "costPerUomCents");
  assertValidFactor(factor);
  const numerator = BigInt(costPerUomCents) * SCALE * BigInt(factor.den);
  return toSafeNumber(
    divRoundHalfAway(numerator, BigInt(factor.num)),
    "per-base unit cost in microcents",
  );
}

/** The inverse, for display: what one purchasing UoM costs, in microcents. */
export function unitCostInBaseToUomMicrocents(
  costPerBaseMicrocents: Microcents,
  factor: Factor,
): Microcents {
  assertInt(costPerBaseMicrocents, "costPerBaseMicrocents");
  assertValidFactor(factor);
  const numerator = BigInt(costPerBaseMicrocents) * BigInt(factor.num);
  return toSafeNumber(
    divRoundHalfAway(numerator, BigInt(factor.den)),
    "per-UoM unit cost in microcents",
  );
}

/**
 * THE monetary rounding boundary for cost.
 *
 *     extended cost in cents = round(unit cost in microcents * quantity / COST_SCALE)
 *
 * Multiply first at full precision, round once at the end. This is the only
 * place a cost becomes money: 500 g of $0.0025/g flour books $1.25, not the
 * $0.00 that rounding the unit cost first would produce.
 */
export function extendedCostCents(
  unitCostMicrocents: Microcents,
  quantity: number,
): UsdCents {
  assertInt(unitCostMicrocents, "unitCostMicrocents");
  assertInt(quantity, "quantity");
  const total = BigInt(unitCostMicrocents) * BigInt(quantity);
  return toSafeNumber(divRoundHalfAway(total, SCALE), "extended cost in cents");
}

/**
 * Weighted-average unit cost after receiving stock, in microcents.
 *
 *     new value   = old qty * old average + incoming qty * incoming cost
 *     new average = new value / resulting quantity
 *
 * Accumulated at full microcent precision and divided once — no component is
 * rounded to cents on the way. Mirrors `cost::new_weighted_avg`, including its
 * two refusals: a non-positive resulting quantity, and a total inventory value
 * that would not be representable.
 */
export function newWeightedAvgMicrocents(args: {
  oldQty: number;
  oldAvgMicrocents: Microcents;
  newQty: number;
  newCostMicrocents: Microcents;
}): Microcents {
  const { oldQty, oldAvgMicrocents, newQty, newCostMicrocents } = args;
  assertInt(oldQty, "oldQty");
  assertInt(oldAvgMicrocents, "oldAvgMicrocents");
  assertInt(newQty, "newQty");
  assertInt(newCostMicrocents, "newCostMicrocents");

  const totalQty = BigInt(oldQty) + BigInt(newQty);
  if (totalQty <= 0n) {
    throw new Error("total quantity must be positive after purchase");
  }
  const totalValue =
    BigInt(oldQty) * BigInt(oldAvgMicrocents) + BigInt(newQty) * BigInt(newCostMicrocents);
  // The pool's value itself must stay representable, not just the average.
  toSafeNumber(totalValue, "inventory value in microcents");
  return toSafeNumber(
    divRoundHalfAway(totalValue, totalQty),
    "weighted-average unit cost in microcents",
  );
}

/**
 * Weighted-average unit cost after RETURNED stock comes back, in microcents,
 * or `null` when no average can honestly be formed.
 *
 * The mirror of `cost::restock_weighted_avg`. A restock is an ordinary
 * weighted average — the returned units re-enter the pool at the rate they
 * left it at — except that it can meet a pool that is already NEGATIVE,
 * because the POS allows selling below zero. Two states then have no answer:
 * a resulting quantity that is still zero or negative (nothing to average
 * over), and a resulting average that comes out negative (no pool costs less
 * than nothing, and the column is `CHECK (>= 0)`).
 *
 * `null` means LEAVE THE EXISTING AVERAGE ALONE. The quantity still goes back
 * on the shelf; the cost pool keeps the only rate that is still meaningful.
 */
export function restockWeightedAvgMicrocents(args: {
  oldQty: number;
  oldAvgMicrocents: Microcents;
  returnedQty: number;
  returnedCostMicrocents: Microcents;
}): Microcents | null {
  const { oldQty, oldAvgMicrocents, returnedQty, returnedCostMicrocents } = args;
  assertInt(oldQty, "oldQty");
  assertInt(oldAvgMicrocents, "oldAvgMicrocents");
  assertInt(returnedQty, "returnedQty");
  assertInt(returnedCostMicrocents, "returnedCostMicrocents");

  if (returnedQty <= 0) {
    throw new Error("a restock must return a positive quantity");
  }
  if (returnedCostMicrocents < 0) {
    throw new Error("a restock cost rate cannot be negative");
  }
  if (BigInt(oldQty) + BigInt(returnedQty) <= 0n) return null;

  const average = newWeightedAvgMicrocents({
    oldQty,
    oldAvgMicrocents,
    newQty: returnedQty,
    newCostMicrocents: returnedCostMicrocents,
  });
  return average < 0 ? null : average;
}

// ---------- Display ----------

/**
 * Format a microcent unit cost for the UI.
 *
 * Presentation only — never parse this back into an accounting value.
 *
 * The value is shown EXACTLY, never rounded: two decimals for the ordinary
 * whole-cent case (`$2.00`), and as many more as the cost actually carries, so a
 * $0.0025/g ingredient reads `$0.0025` instead of `$0.00`. A microcent is the
 * eighth decimal place of a dollar, so eight is the most that can ever appear.
 */
export function formatUnitCostUsd(microcents: Microcents): string {
  assertInt(microcents, "microcents");
  const sign = microcents < 0 ? "-" : "";
  const abs = BigInt(Math.abs(microcents));
  // 1 USD = 100 cents = 100 * COST_SCALE microcents, i.e. 8 decimal places.
  const perDollar = 100n * SCALE;
  const dollars = abs / perDollar;
  let fraction = (abs % perDollar).toString().padStart(8, "0");
  // Two decimals minimum; drop trailing zeros beyond that.
  while (fraction.length > 2 && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return `${sign}$${dollars.toLocaleString("en-US")}.${fraction}`;
}
