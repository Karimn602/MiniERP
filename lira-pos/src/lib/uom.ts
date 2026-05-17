/**
 * Unit-of-Measure utilities — pure, integer-only.
 *
 * A UoM conversion is stored as a rational: factor = num / den.
 *   1 × this_uom = (num / den) × base_uom
 *
 * Examples (assuming base = 'pcs'):
 *   'pcs'  → (num=1,    den=1)         (the base itself)
 *   'box'  → (num=12,   den=1)         1 box  = 12 pcs
 *   'case' → (num=4,    den=1)         1 case = 4  pcs
 *
 * Examples (assuming base = 'g'):
 *   'g'    → (num=1,    den=1)
 *   'kg'   → (num=1000, den=1)         1 kg = 1000 g
 *
 * Quantities entered by the user are integers in the chosen UoM. The
 * "decimal" notion is a UI affordance — a user typing "1.5 kg" produces
 * a base-quantity calculation of `round(1.5 × 1000 / 1) = 1500` grams.
 * But in the *database*, both quantity_in_uom and quantity_base are integers.
 * Decimal handling happens at the input layer (see parseQuantityInput below).
 *
 * INVARIANTS:
 *   - factor_num and factor_den are POSITIVE INTEGERS, always.
 *   - base UoM rows have (1, 1).
 *   - base_quantity = sale_quantity × num ÷ den  (the ÷ is the only rounding spot)
 *   - All quantity types in this file are `number` but always Number.isInteger
 */

import { type UsdCents } from "./money";

export type UomCode = string;

export interface Factor {
  num: number; // positive integer
  den: number; // positive integer
}

export interface ProductUom {
  id: string;
  productId: string;
  uomCode: UomCode;
  factor: Factor;
  isBase: boolean;
  isDefaultSale: boolean;
  isDefaultPurchase: boolean;
  isActive: boolean;
  // Optional UoM-specific override prices (USD cents). NULL/undefined means
  // "derive from product base price × factor" at sale time.
  salePriceExclVatCents: UsdCents | null;
  salePriceInclVatCents: UsdCents | null;
}

// ---------- Guards ----------

function assertPositiveInt(n: number, label: string): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${n}`);
  }
}

function assertNonNegInt(n: number, label: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${n}`);
  }
}

export function assertValidFactor(f: Factor): void {
  assertPositiveInt(f.num, "factor.num");
  assertPositiveInt(f.den, "factor.den");
}
export interface Factor {
  num: number;
  den: number;
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }

  return x;
}

export function makeFactor(num: number, den: number = 1): Factor {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new Error("UoM factor must use integer numerator and denominator.");
  }

  if (num <= 0 || den <= 0) {
    throw new Error("UoM factor numerator and denominator must be positive.");
  }

  const divisor = gcd(num, den);

  return {
    num: num / divisor,
    den: den / divisor,
  };
}
// ---------- Core conversions ----------

/**
 * Convert a quantity expressed in some UoM to base-UoM quantity.
 *
 *   base = qty × num ÷ den
 *
 * The division is integer-truncated by Math.round (half-away-from-zero).
 * If the inputs guarantee no fractional remainder (the normal case for
 * count-based products like boxes-to-pieces where den=1), this is exact.
 *
 * For products where the factor would create fractional base units (e.g.
 * base=kg, sale=g with factor 1/1000), you'd accumulate rounding error —
 * but the design rule is "base is always the finest UoM", which prevents
 * that case from arising. The products repo (Phase 2A.2) enforces this.
 */
export function toBaseQty(qtyInUom: number, factor: Factor): number {
  assertNonNegInt(qtyInUom, "qtyInUom");
  assertValidFactor(factor);
  return Math.round((qtyInUom * factor.num) / factor.den);
}

/**
 * Convert a base-UoM quantity back to a target UoM.
 *
 *   uomQty = baseQty × den ÷ num
 *
 * Used for display: "we have 48 pcs in stock — that's 4 boxes" (factor 12/1
 * → 48 × 1 / 12 = 4). Rounding matters here: 50 pcs in a 12-per-box product
 * displays as "4 boxes" with 2 stragglers — see toBaseQtyWithRemainder for
 * the cases that need both.
 */
export function fromBaseQty(baseQty: number, factor: Factor): number {
  assertNonNegInt(baseQty, "baseQty");
  assertValidFactor(factor);
  return Math.round((baseQty * factor.den) / factor.num);
}

/**
 * Convert base → target UoM with explicit remainder.
 * Used by the stock display ("4 boxes + 2 pcs remaining") and by
 * weighted-avg cost calculations that need exact integer math.
 *
 * Returns: { whole: integer count of full target-UoM units,
 *            remainderBase: leftover base units that don't fill a full unit }
 *
 * Example: baseQty=50, factor=12/1 (box→pcs)
 *   → whole=4, remainderBase=2  (4 boxes + 2 loose pcs)
 */
export function fromBaseQtyWithRemainder(
  baseQty: number,
  factor: Factor,
): { whole: number; remainderBase: number } {
  assertNonNegInt(baseQty, "baseQty");
  assertValidFactor(factor);
  // base per 1 uom = num/den. Whole UoMs that fit:
  //   whole = floor(baseQty * den / num)
  const whole = Math.floor((baseQty * factor.den) / factor.num);
  const remainderBase = baseQty - Math.round((whole * factor.num) / factor.den);
  return { whole, remainderBase };
}

// ---------- Cost conversion ----------

/**
 * Convert a per-UoM cost to per-base-UoM cost.
 * Used at purchase time: shop buys 10 boxes @ $24/box; we need to record
 * the cost as $/pcs in the inventory movement.
 *
 *   costPerBase = costPerUom × den ÷ num
 *
 * Both costs are in USD cents (integer). Rounded to nearest cent.
 */
export function unitCostInUomToBase(
  costPerUomCents: UsdCents,
  factor: Factor,
): UsdCents {
  assertNonNegInt(costPerUomCents, "costPerUomCents");
  assertValidFactor(factor);
  return Math.round((costPerUomCents * factor.den) / factor.num);
}

/** Inverse: base cost → cost expressed in a specific UoM. Useful for display. */
export function unitCostInBaseToUom(
  costPerBaseCents: UsdCents,
  factor: Factor,
): UsdCents {
  assertNonNegInt(costPerBaseCents, "costPerBaseCents");
  assertValidFactor(factor);
  return Math.round((costPerBaseCents * factor.num) / factor.den);
}

// ---------- Price resolution ----------

/**
 * Given a product's base price and a target UoM, resolve the price for that UoM.
 * Precedence:
 *   1. If the UoM row has its own sale_price_*, use it (lets shops set
 *      "1 box = $20" even when 12 × $1.10 single-piece price would be $13.20).
 *   2. Otherwise, derive: priceInUom = priceInBase × num / den.
 *
 * Returns an object with both excl and incl variants so callers don't have
 * to call this twice with different inputs.
 */
export function resolvePriceForUom(args: {
  basePriceExclVatCents: UsdCents;
  basePriceInclVatCents: UsdCents;
  uomOverrideExclVatCents: UsdCents | null;
  uomOverrideInclVatCents: UsdCents | null;
  factor: Factor;
}): { exclVatCents: UsdCents; inclVatCents: UsdCents } {
  const { factor } = args;
  assertValidFactor(factor);

  if (
    args.uomOverrideExclVatCents !== null &&
    args.uomOverrideInclVatCents !== null
  ) {
    return {
      exclVatCents: args.uomOverrideExclVatCents,
      inclVatCents: args.uomOverrideInclVatCents,
    };
  }

  // Derive from base. Round each independently — they should already be
  // internally consistent (computed from the same VAT rate) but rounding
  // them independently keeps the policy explicit at every boundary.
  return {
    exclVatCents: Math.round(
      (args.basePriceExclVatCents * factor.num) / factor.den,
    ),
    inclVatCents: Math.round(
      (args.basePriceInclVatCents * factor.num) / factor.den,
    ),
  };
}

// ---------- User input ----------

/**
 * Parse a user-typed quantity ("1.5", "2", "0.25") into an integer in the
 * TARGET UoM. The decimal places are dictated by the precision of the
 * conversion: if factor.num/den lets us represent N decimals losslessly,
 * we allow up to N. Otherwise we round at parse time and warn the caller.
 *
 * Practical examples:
 *   - For "kg" with factor (1000, 1) to base "g": "1.5" → 1500 g, but the
 *     "quantity_in_uom" stored is conceptually 1.5 kg. Since the DB column
 *     is INTEGER, we store the base value (1500) and derive display.
 *     → THIS FUNCTION returns the BASE quantity, not the UoM quantity.
 *
 *   - For "box" with factor (12, 1) to base "pcs": "2.5" — invalid, you
 *     can't sell half a box of 12 unless you also have a 'pcs' UoM on
 *     this product. → throws.
 *
 * The function signature reflects this: you give it the typed string, the
 * factor, and the function returns the **base quantity** (integer). The
 * caller stores both `quantity_in_uom` (as a string-display thing the user
 * sees) and `quantity` (the integer base, what we just returned).
 *
 * Hmm — actually it's cleaner to return both. Let me do that:
 */
export function parseQuantityInput(
  raw: string,
  factor: Factor,
): { quantityInUom: number | null; quantityBase: number } {
  assertValidFactor(factor);

  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid quantity: "${raw}"`);
  }

  const [whole, frac = ""] = trimmed.split(".");
  const scale = Math.pow(10, frac.length);
  const scaledInput = Number(whole) * scale + Number(frac || "0");

  const numerator = scaledInput * factor.num;
  const denominator = factor.den * scale;
  if (numerator % denominator !== 0) {
    throw new Error(
      `Quantity "${raw}" doesn't fit conversion ${factor.num}/${factor.den}. ` +
        `Try a finer-grained UoM.`,
    );
  }
  const quantityBase = numerator / denominator;
  const quantityInUom = frac === "" ? Number(whole) : null;
  return { quantityInUom, quantityBase };
}
// ---------- Display ----------

/**
 * Format a base quantity as a user-friendly string in a target UoM.
 *   formatQty(1500, {num:1000, den:1}, 'kg')  →  "1.5 kg"
 *   formatQty(48,   {num:12,   den:1}, 'box') →  "4 box"
 *   formatQty(50,   {num:12,   den:1}, 'box') →  "4 box + 2"  (with remainder mode)
 */
export function formatQty(
  baseQty: number,
  factor: Factor,
  symbol: string,
  opts: { showRemainder?: boolean } = {},
): string {
  assertNonNegInt(baseQty, "baseQty");
  assertValidFactor(factor);

  if (opts.showRemainder && factor.num > 1) {
    const { whole, remainderBase } = fromBaseQtyWithRemainder(baseQty, factor);
    if (remainderBase === 0) return `${whole} ${symbol}`;
    return `${whole} ${symbol} + ${remainderBase}`;
  }

  // Compute exact: baseQty * den / num. If it lands cleanly, no decimals.
  // Otherwise, show up to 3 decimals.
  const numerator = baseQty * factor.den;
  if (numerator % factor.num === 0) {
    return `${numerator / factor.num} ${symbol}`;
  }
  const asNumber = numerator / factor.num;
  return `${asNumber.toFixed(3).replace(/\.?0+$/, "")} ${symbol}`;
}