/**
 * Manual standard cost — the vocabulary, the input shape, and the status a
 * screen is allowed to print (WP-B1, migration 020).
 *
 * WHAT THIS FILE IS FOR
 *
 * Three screens now say something about costing — the Products form, the
 * profitability report and Sales History — and all three must say the same
 * things in the same words. The alternative is three slightly different ideas
 * of what "not configured" means, which is how a margin report comes to
 * disagree with the product page it was derived from.
 *
 * WHAT IS **NOT** HERE
 *
 * No arithmetic that decides money. A manual cost is stored on the product and
 * resolved by `post_sale` from the DATABASE, inside the posting transaction —
 * never from anything this file computes and never from request data a cashier
 * can influence. The only number this file produces is the microcent value the
 * owner typed into the product form, on its way to `save_product`, which then
 * validates it again and which migration 020's triggers constrain regardless.
 *
 * So this is presentation and input parsing. The authority is Rust.
 */

// Imported from the two money modules rather than from `db/types`, which
// imports THIS file for `CostingMethod`. A type-only cycle would compile, but
// one direction of dependency is easier to reason about than two.
import { COST_SCALE, formatUnitCostUsd, type Microcents } from "./cost";

// ---------- The per-item switch ----------

/**
 * The costing methods `products.costing_method` may hold.
 *
 * `"recipe"` was in the schema's CHECK from migration 020 so that shipping
 * WP-B2 would need no `products` table rebuild — SQLite cannot ALTER a CHECK,
 * and that table is referenced by every posted document family. WP-B2-B
 * (migration 022) turned 020's blanket refusal into a CONDITIONAL one, so it
 * is selectable now, but only for a non-stock item that has a published
 * recipe. Those two conditions are enforced by `save_product` with a sentence
 * the operator can act on and by 022's trigger pair against every other
 * writer; this list states the domain, not the eligibility.
 */
export const COSTING_METHODS = ["purchase_average", "standard", "recipe"] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];

/** The methods a user may actually choose today. */
export const SELECTABLE_COSTING_METHODS = [
  "purchase_average",
  "standard",
  "recipe",
] as const satisfies readonly CostingMethod[];
export type SelectableCostingMethod = (typeof SELECTABLE_COSTING_METHODS)[number];

/** The default, and the behaviour every product had before WP-B1. */
export const DEFAULT_COSTING_METHOD: CostingMethod = "purchase_average";

/**
 * Read a `costing_method` out of a database row.
 *
 * Anything unrecognised — including the `undefined` a row decoded from a
 * pre-020 database carries — reads as the default, because that is the
 * behaviour such a row actually has. A screen must never show a method the
 * engine would not honour.
 */
export function normalizeCostingMethod(raw: string | null | undefined): CostingMethod {
  const value = (raw ?? "").trim();
  return (COSTING_METHODS as readonly string[]).includes(value)
    ? (value as CostingMethod)
    : DEFAULT_COSTING_METHOD;
}

export function isSelectableCostingMethod(
  method: CostingMethod,
): method is SelectableCostingMethod {
  return (SELECTABLE_COSTING_METHODS as readonly string[]).includes(method);
}

// ---------- Provenance of a posted COGS rate ----------

/**
 * `sale_items.cogs_source` — how the line in front of you was costed.
 *
 * `null` means the line was posted before migration 020 existed, which is the
 * truth about it: `sale_items` holds immutable posted documents and WP-B1
 * rewrites none of them.
 */
export const COGS_SOURCES = [
  "purchase_average",
  "last_purchase",
  "standard",
  "recipe",
  "uncosted",
] as const;
export type CogsSource = (typeof COGS_SOURCES)[number];

export function normalizeCogsSource(raw: string | null | undefined): CogsSource | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return (COGS_SOURCES as readonly string[]).includes(value) ? (value as CogsSource) : null;
}

/**
 * Is this line's cost SOURCE recorded — can the figure be traced to where it
 * came from?
 *
 * `"uncosted"` is not: it is the engine saying nothing had been configured.
 * `null` is not either, but for a different reason — the line was posted
 * before migration 020 and provenance was never recorded, which is a gap in
 * what Greaz KNOWS and not necessarily in what the line HOLDS. `"standard"` IS
 * recorded in this sense: an assertion by the owner is not a document, which
 * the UI says in its own words, but it is an answer with a known origin.
 *
 * This question is deliberately NOT "does the line have a cost" — see
 * `isCostBearingLine`. Conflating the two is the WP-B1 P1-B defect: every
 * legacy line was reported as uncosted, so a shop whose history was costed
 * throughout was told its gross profit was overstated while the cost sat in
 * the row and in the profit figure already.
 */
export function isVerifiedCostSource(source: CogsSource | null): boolean {
  return source !== null && source !== "uncosted";
}

/**
 * Does a cost figure exist behind this line at all?
 *
 * A recorded source that is an answer settles it, and the FIGURE is not
 * consulted there: a `"standard"` zero is the owner asserting the item costs
 * nothing, which is an answer. For a legacy line there is no source to read,
 * so the only honest evidence is the posted COGS snapshot — and both persisted
 * forms are consulted, the authoritative microcent rate and the line's rounded
 * money, so a row written by any path counts if either says a cost was
 * recorded.
 *
 * A legacy line whose snapshot is zero stays INDETERMINATE and is counted as
 * missing: nothing distinguishes "it cost nothing" from "nobody said", and
 * claiming the generous reading would hide exactly the revenue an owner needs
 * to see. Nothing here is ever written back onto the line.
 */
export function isCostBearingLine(
  source: CogsSource | null,
  unitCogsExclVatMicrocents: number,
  lineCogsExclVatCents = 0,
): boolean {
  if (isVerifiedCostSource(source)) return true;
  if (source !== null) return false;
  return unitCogsExclVatMicrocents !== 0 || lineCogsExclVatCents !== 0;
}

/** The i18n key for a provenance label. */
export function cogsSourceLabelKey(source: CogsSource | null): string {
  return `costing.source.${source ?? "legacy"}`;
}

// ---------- Typing a cost ----------

/**
 * The most decimal places a typed cost accepts.
 *
 * A unit cost is a RATE, not an amount, so it is legitimately sub-cent: the
 * architecture's own example is flour at $0.0025/g. Four places covers that
 * and still refuses anything that looks like a mistyped figure. Prices stop at
 * two because a price is an amount somebody pays to the cent.
 */
export const MANUAL_COST_MAX_DECIMALS = 4;

/**
 * Parse a typed manual cost into microcents, or `null` if the input is not a
 * cost at all.
 *
 * Validated in FULL, never by numeric prefix — the WP-A importer lesson.
 * `parseFloat("2abc")` is 2, and a typo that imports as a plausible wrong cost
 * is worse than one that is refused, because the margin it produces looks
 * fine. A leading `$` and well-formed thousands groups are stripped first,
 * because that is what a person types; `"1,2,3"` is not a number in any locale
 * this ships to and is refused rather than read as 123.
 *
 * A BLANK input is `null` too — and the caller must distinguish that from a
 * refusal, because blank means "not configured" and is a legal state.
 * `parseManualCostInput` therefore pairs with `isBlankCostInput`.
 */
export function parseManualCostInput(input: string): Microcents | null {
  const raw = input.trim().replace(/^\$/, "").trim();
  if (!raw) return null;
  const grouped = new RegExp(
    `^\\d{1,3}(,\\d{3})+(\\.\\d{1,${MANUAL_COST_MAX_DECIMALS}})?$`,
  ).test(raw);
  const s = grouped ? raw.replace(/,/g, "") : raw;
  if (!new RegExp(`^\\d+(\\.\\d{1,${MANUAL_COST_MAX_DECIMALS}})?$`).test(s)) return null;

  const [whole, frac = ""] = s.split(".");
  // COST_SCALE microcents per cent, 100 cents per dollar: eight decimal places
  // in a dollar. The typed fraction is padded to four and then scaled by the
  // remaining four, so the conversion is exact and no rounding happens here.
  const perDollar = 100 * COST_SCALE;
  const scaleOfFourDecimals = perDollar / 10_000;
  const microcents =
    Number(whole) * perDollar + Number(frac.padEnd(MANUAL_COST_MAX_DECIMALS, "0")) * scaleOfFourDecimals;
  return Number.isSafeInteger(microcents) ? microcents : null;
}

export function isBlankCostInput(input: string): boolean {
  return input.trim() === "";
}

/**
 * A stored manual cost, as text for the form field it is edited in.
 *
 * `formatUnitCostUsd` is the display formatter and carries a `$`; a text input
 * whose value is `"$1.80"` cannot be edited without the user deleting the
 * sigil, so the field holds the bare number. Trailing zeros beyond two places
 * are dropped, so `$1.80` round-trips as `1.80` and `$0.0025` as `0.0025`.
 */
export function formatManualCostInput(microcents: Microcents | null): string {
  if (microcents === null) return "";
  return formatUnitCostUsd(microcents).replace(/^\$/, "").replace(/,/g, "");
}

// ---------- What a screen may say about a product's costing ----------

export type CostConfigurationStatus =
  /** Manual Cost, with a figure stated above zero. */
  | "manual"
  /** Manual Cost, deliberately stated as zero. An assertion, not a gap. */
  | "manual_zero"
  /** Purchase valuation, and the product has a cost basis. */
  | "purchase"
  /** Purchase valuation, no basis yet: a sale would cost nothing. */
  | "purchase_uncosted"
  /** A non-stock item on purchase valuation: it can never acquire a basis. */
  | "service_uncosted"
  /** Recipe costing, with a published recipe that costs out. */
  | "recipe"
  /** Recipe costing selected with no published recipe: it cannot be sold. */
  | "recipe_missing"
  /**
   * Recipe costing, a recipe published, and one of its ingredients has no cost
   * on file — so `post_sale` would refuse the line by name.
   *
   * Reachable only by RECONFIGURING an ingredient after publication:
   * `activate_recipe` refuses to publish a recipe whose ingredients cannot all
   * be costed, and a purchase basis is monotone. It is a distinct status
   * because the remedy is different from `recipe_missing` — there is a recipe,
   * and it is an ingredient that needs attention.
   */
  | "recipe_uncosted";

/**
 * What a screen needs to know about a product's ACTIVE recipe to say anything
 * about its costing.
 *
 * `perBaseUnitMicrocents` is `null` when the recipe cannot be costed today —
 * never 0, for WP-B1's reason one level down: returning zero is how a
 * catalogue of 100% margins stops looking like a problem.
 *
 * Both functions below take this as an OPTIONAL argument. Omitted, a
 * recipe-costed product reads as `recipe_missing` with no rate, which is the
 * safe direction: it invites the owner to look, where the reverse would print
 * a cost for an item that cannot be sold.
 */
export interface ActiveRecipeCost {
  hasActive: boolean;
  perBaseUnitMicrocents: Microcents | null;
}

/**
 * The costing status of one product, for the Products list and form.
 *
 * The distinction this exists to preserve: a stated zero and an unstated cost
 * are both "$0.00" and they are not the same claim. Collapsing them is how a
 * catalogue of 100% margins stops looking like a problem.
 *
 * It reads the PRODUCT ROW only, which is one thing less than `post_sale`
 * knows. Since the WP-B1 P1-A correction the engine resolves a stocked
 * product's zero average against its `inventory_movements` history, so goods
 * received free (a `purchase` or `opening` row stating zero) post as
 * `purchase_average` while this function still reports `purchase_uncosted`.
 * That is a deliberate limit, not an oversight: the Products list renders every
 * row in the catalogue and would need a per-product movement probe to say
 * otherwise. The erring direction is the safe one — the screen says "no cost
 * basis yet" about a product whose basis is a documented zero, which invites
 * the owner to look, where the reverse would hide a real gap. The authority on
 * what a sale is costed at remains the posted line's own `cogs_source`, which
 * Sales History and the coverage panel read.
 */
export function costConfigurationStatus(
  product: {
    costingMethod: CostingMethod;
    standardCostExclVatMicrocents: Microcents | null;
    isService: boolean;
    avgCostExclVatMicrocents: Microcents;
  },
  recipe?: ActiveRecipeCost,
): CostConfigurationStatus {
  // WP-B2-B. The PRODUCT's method decides first, exactly as `post_sale`
  // resolves it, and `recipe` is checked before the other two for the same
  // reason: it is the one that does not read `avg_cost_*` or
  // `standard_cost_*` at all. Omitting this branch is what printed "None" and
  // a dash over a correctly configured recipe-costed burger — a stocked zero
  // average reported as `service_uncosted`, which is the one thing it was not.
  if (product.costingMethod === "recipe") {
    if (!recipe?.hasActive) return "recipe_missing";
    return recipe.perBaseUnitMicrocents === null ? "recipe_uncosted" : "recipe";
  }
  if (product.costingMethod === "standard") {
    // A `standard` product with no figure cannot post a sale at all
    // (`post_sale` refuses it by name) and migration 020 forbids the row, so
    // this is unreachable from a coherent database — it is reported as the
    // deliberate zero only when the figure really is zero.
    return product.standardCostExclVatMicrocents === 0 ? "manual_zero" : "manual";
  }
  if (product.avgCostExclVatMicrocents > 0) return "purchase";
  return product.isService ? "service_uncosted" : "purchase_uncosted";
}

/**
 * The rate a sale of this product WOULD be costed at today, or `null` when
 * nothing has been configured.
 *
 * Presentation only, and it says "today" for a reason: a posted line carries
 * its own snapshot and this figure has no bearing on it. The Products list
 * needs it because showing `avg_cost_*` unconditionally displayed $0.00 for a
 * manual-costed item — the one product whose cost the owner had actually
 * taken the trouble to state.
 *
 * `null` rather than 0 for the uncosted case, so a caller is forced to decide
 * what to print instead of inheriting a zero that reads as a real cost.
 */
export function effectiveUnitCostMicrocents(
  product: {
    costingMethod: CostingMethod;
    standardCostExclVatMicrocents: Microcents | null;
    avgCostExclVatMicrocents: Microcents;
    isService: boolean;
  },
  recipe?: ActiveRecipeCost,
): Microcents | null {
  // WP-B2-B. A recipe-costed item is valued from its recipe and from nothing
  // else — never from `avg_cost_*`, which for a non-stock item is zero for
  // ever, and never from a Manual Cost it may still be carrying inertly.
  if (product.costingMethod === "recipe") {
    return recipe?.hasActive ? recipe.perBaseUnitMicrocents : null;
  }
  if (product.costingMethod === "standard") {
    return product.standardCostExclVatMicrocents;
  }
  if (product.avgCostExclVatMicrocents > 0) return product.avgCostExclVatMicrocents;
  // A service on purchase valuation can never acquire a basis — the only
  // writer of `avg_cost_*` is a purchase — so its zero is an absence, not a
  // figure. A stocked product's zero is an absence too, but a temporary one.
  return product.isService ? null : 0;
}

/** Does this status mean "no cost has been configured"? */
export function isUncostedStatus(status: CostConfigurationStatus): boolean {
  return (
    status === "purchase_uncosted" ||
    status === "service_uncosted" ||
    // Both recipe gaps are the same kind of problem as the two above: a sale
    // today would have no cost behind it. They differ only in the remedy, and
    // `costStatusLabelKey` is what says which.
    status === "recipe_missing" ||
    status === "recipe_uncosted"
  );
}

/**
 * The `costing.sourceShort.*` key for where a product's cost would come from
 * TODAY — the compact label under the figure in the Products list.
 *
 * Derived from the STATUS rather than from `costingMethod` alone, because a
 * method with no usable figure behind it must not advertise itself as the
 * source of one. The list used to compute this inline with a two-branch
 * ternary that had no `recipe` arm at all, so a recipe-costed item was labelled
 * "None" or "Purchases" depending on an average it never reads.
 */
export function costSourceShortKey(status: CostConfigurationStatus): string {
  switch (status) {
    case "manual":
    case "manual_zero":
      return "costing.sourceShort.standard";
    case "recipe":
      return "costing.sourceShort.recipe";
    case "purchase":
      return "costing.sourceShort.purchase_average";
    default:
      return "costing.sourceShort.uncosted";
  }
}

/** The i18n key for a costing status label. */
export function costStatusLabelKey(status: CostConfigurationStatus): string {
  return `costing.status.${status}`;
}
