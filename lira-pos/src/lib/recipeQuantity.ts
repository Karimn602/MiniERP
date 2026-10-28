/**
 * Recipe quantities as exact reduced fractions (WP-B2-A).
 *
 * WHY A FRACTION AND NOT A NUMBER
 *
 * `sale_items.quantity`, `inventory_movements.quantity_delta` and
 * `products.quantity_on_hand` are integers, and `lib/uom.ts::parseQuantityInput`
 * REFUSES a typed decimal that does not land on a whole base unit. That is
 * right for a sale — half a box of twelve is not something you hand over.
 *
 * A recipe cannot live under that rule. "150 g of beef" is fine when the base
 * unit is the gram, but "half a bun" is not an integer count of buns at all,
 * and rounding it to 0 or 1 is a 100% costing error on that line. So a recipe
 * quantity is a fraction: exact for `0.125` and for `1/3` alike, and the same
 * convention `product_uoms.factor_num / factor_den` already uses for the same
 * job.
 *
 * FRACTIONAL RECIPE QUANTITIES ARE COSTING-ONLY IN B2. A recipe quantity is a
 * multiplier on a cost RATE and never a quantity of anything that moves: no
 * `inventory_movements` row is written from a recipe, so no fractional base
 * quantity ever has to reconcile against an integer column. WP-B3, which does
 * consume ingredients, will have to decide what half a bun does to an integer
 * `quantity_on_hand` — a consumption-rounding policy with a residual
 * somewhere. That decision is not made here and nothing here implies it.
 *
 * VALIDATED IN FULL, NEVER BY NUMERIC PREFIX. `parseFloat("2abc")` is 2, and a
 * typo that imports as a plausible wrong quantity is worse than one that is
 * refused, because the cost it produces looks fine. This is the WP-A importer
 * lesson and the rule `parseManualCostInput` already follows.
 *
 * The REDUCTION matters as much as the parse: `2/4` and `1/2` are one recipe,
 * and two screens must not produce two different rows. `recipes.rs::reduce`
 * does it again on the way in, because a client is never the authority on
 * canonical form.
 */

/** The most decimal places a typed quantity accepts. */
export const MAX_QUANTITY_DECIMALS = 6;

/**
 * The largest numerator or denominator a stored quantity may hold.
 *
 * Half of the overflow proof in `recipe_cost.rs`; migration 021 carries the
 * same bound as a CHECK, so a row written by any other path is inside the
 * envelope too.
 */
export const MAX_QUANTITY_PART = 1_000_000;

export interface Quantity {
  num: number;
  den: number;
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Reduce a fraction to canonical form. */
export function reduceQuantity(num: number, den: number): Quantity {
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

export class QuantityParseError extends Error {}

/**
 * Parse a typed recipe quantity into an exact reduced fraction.
 *
 * Accepts, and nothing else:
 *
 * ```text
 *   "150"     -> 150/1      a whole quantity
 *   "0.5"     ->   1/2      a decimal, up to six places
 *   "0.125"   ->   1/8
 *   "1/3"     ->   1/3      a fraction, for a third of an onion
 *   "1 / 3"   ->   1/3      spaces around the bar are a person typing
 * ```
 *
 * Refused, with a sentence: blank, zero, negative, `"2abc"`, `"1/0"`,
 * `"1.2.3"`, seven decimal places, and anything whose reduced parts exceed
 * [`MAX_QUANTITY_PART`]. A refusal names what was wrong; it never falls back
 * to a default, because the default would be a wrong cost that looks right.
 */
export function parseQuantity(raw: string): Quantity {
  const text = raw.trim();
  if (text === "") {
    throw new QuantityParseError("Enter a quantity, such as 150, 0.5 or 1/3.");
  }

  // A fraction: "1/3".
  const slash = text.indexOf("/");
  if (slash !== -1) {
    const left = text.slice(0, slash).trim();
    const right = text.slice(slash + 1).trim();
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
      throw new QuantityParseError(
        `"${raw}" is not a quantity. A fraction looks like 1/3 — whole numbers either side of the bar.`,
      );
    }
    const num = Number(left);
    const den = Number(right);
    if (num < 1) {
      throw new QuantityParseError("A recipe quantity must be above zero.");
    }
    if (den < 1) {
      throw new QuantityParseError(`"${raw}" divides by zero.`);
    }
    return bounded(reduceQuantity(num, den), raw);
  }

  // A decimal or a whole number.
  if (!new RegExp(`^\\d+(\\.\\d{1,${MAX_QUANTITY_DECIMALS}})?$`).test(text)) {
    if (/^\d+\.\d+$/.test(text)) {
      throw new QuantityParseError(
        `"${raw}" has more than ${MAX_QUANTITY_DECIMALS} decimal places. Use a fraction such as 1/3 if that is what you mean.`,
      );
    }
    throw new QuantityParseError(
      `"${raw}" is not a quantity. Enter a number such as 150 or 0.5, or a fraction such as 1/3.`,
    );
  }

  const [whole, frac = ""] = text.split(".");
  const den = 10 ** frac.length;
  const num = Number(whole) * den + Number(frac || "0");
  if (num < 1) {
    throw new QuantityParseError("A recipe quantity must be above zero.");
  }
  return bounded(reduceQuantity(num, den), raw);
}

function bounded(q: Quantity, raw: string): Quantity {
  if (q.num > MAX_QUANTITY_PART || q.den > MAX_QUANTITY_PART) {
    throw new QuantityParseError(
      `"${raw}" is outside the range Greaz can cost exactly (parts up to ${MAX_QUANTITY_PART.toLocaleString()}).`,
    );
  }
  return q;
}

/**
 * A stored quantity as text for the field it is edited in.
 *
 * A terminating decimal prints as a decimal, because that is what was typed;
 * a repeating one prints as the fraction, because `0.333333` is not the
 * quantity and showing it would invite the owner to "fix" an exact value into
 * an approximate one.
 */
export function formatQuantity(q: Quantity): string {
  if (q.den === 1) return String(q.num);
  // A denominator of the form 2^a * 5^b terminates in base ten.
  let d = q.den;
  while (d % 2 === 0) d /= 2;
  while (d % 5 === 0) d /= 5;
  if (d === 1) {
    const decimals = decimalPlacesFor(q.den);
    return (q.num / q.den).toFixed(decimals).replace(/\.?0+$/, "");
  }
  return `${q.num}/${q.den}`;
}

function decimalPlacesFor(den: number): number {
  for (let places = 0; places <= MAX_QUANTITY_DECIMALS; places += 1) {
    if (10 ** places % den === 0) return places;
  }
  return MAX_QUANTITY_DECIMALS;
}

/**
 * The quantity in BASE units of the ingredient, as a display string.
 *
 * Presentation only — nothing costs anything from this. It exists because
 * "0.15 kg" means nothing to a cook checking a recipe against a scale that
 * reads grams, and because a quantity that resolves to a fraction of a base
 * unit is a thing the owner should see before publishing.
 */
export function formatBaseQuantity(q: Quantity, factor: { num: number; den: number }): string {
  const num = q.num * factor.num;
  const den = q.den * factor.den;
  const reduced = reduceQuantity(num, den);
  return formatQuantity(reduced);
}
