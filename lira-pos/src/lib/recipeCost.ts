/**
 * Recipe cost arithmetic — the EDITOR'S MIRROR of `src-tauri/src/recipe_cost.rs`.
 *
 * `recipe_cost.rs` is the authority. Every figure that reaches a stored row is
 * computed there, inside the transaction that stores it. This file exists for
 * one reason: an editor that cannot show a cost until it round-trips to Rust
 * is not an editor, and a cook adjusting a quantity needs the number to move
 * as they type. The same relationship `lib/creditMemoMath.ts` has with
 * `posting.rs::prorated_cumulative_cents`.
 *
 * The two are pinned against each other by shared fixtures: `FIXTURES` below
 * is a literal transcription of `recipe_cost::FIXTURES`, with the same
 * expected figures, and `tests/unit/recipeCost.test.ts` asserts them here
 * while `tests/recipes.rs::every_shared_fixture_costs_exactly_as_published`
 * asserts them there. A mirror tested only against itself is not a mirror.
 *
 * BIGINT, NOT NUMBER. The Rust side accumulates in `i128` because the
 * worst-case numerator reaches 2 x 10^35. A JavaScript `number` is a double
 * with 53 bits of integer precision — about 9 x 10^15 — so a `number`
 * implementation of this formula would silently lose precision long before the
 * documented envelope is reached, and would do it quietly, which is the one
 * failure mode this codebase will not accept in money. Every intermediate here
 * is a `bigint`; only the final microcent figures narrow to `number`, through a
 * checked conversion.
 *
 * THE FORMULA, identical to the Rust and in the same order:
 *
 * ```text
 *   contribution_acc = round( rate * q_num * f_num * (10_000 + waste) * ACC
 *                             / (q_den * f_den * 10_000) )
 *   rate_microcents  = round( sum(contribution_acc) / (ACC * yield) )
 * ```
 *
 * Rounding is half away from zero, through `cost.ts::divRoundHalfAway` — the
 * one rounding helper this application uses, and the same semantics as
 * `cost.rs::div_round_half_away`. All values are non-negative, so half away
 * from zero and half up coincide.
 *
 * The precision statement and the overflow proof live in the Rust module's
 * header and are not restated here, because two copies of a proof is one copy
 * too many: this file implements the same formula under the same bounds.
 */
import { divRoundHalfAway, type Microcents } from "./cost";
import type { Quantity } from "./recipeQuantity";

/** Contributions are accumulated this many times finer than a microcent. */
export const ACC = 1_000_000;

/** The most ingredients one recipe may hold. */
export const MAX_COMPONENTS = 64;

/** $100,000 per base unit — the largest ingredient rate the arithmetic admits. */
export const MAX_RATE_MICROCENTS = 10_000_000_000_000;

export const MAX_QUANTITY_PART = 1_000_000;
export const MAX_FACTOR_PART = 1_000_000;
export const MAX_YIELD_BASE = 1_000_000;

const ACC_BIG = BigInt(ACC);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Where one ingredient's rate came from.
 *
 * Only two values, and that is the point: an ingredient is valued from its
 * purchases or from a cost its owner typed. `'recipe'` is unreachable —
 * migration 021 refuses a recipe-costed ingredient outright, because Greaz
 * supports one level of composition.
 */
export type ComponentCostSource = "purchase_average" | "standard";

/** One ingredient line, with its rate already resolved. */
export interface RecipeCostComponent {
  componentProductId: string;
  componentName: string;
  quantity: Quantity;
  uomCode: string;
  factorNum: number;
  factorDen: number;
  wasteBps: number;
  /**
   * The INGREDIENT's per-base-unit rate, excl. VAT, in microcents — or `null`
   * when no cost basis exists.
   *
   * `null` is not zero, and the difference is the whole of WP-B1's P1-A
   * lesson applied one level down: zero is what a documented free receipt
   * contributes, and `null` is nobody having said what the thing costs.
   */
  unitCostExclVatMicrocents: Microcents | null;
  costSource: ComponentCostSource;
}

export interface ComponentContribution {
  componentProductId: string;
  componentName: string;
  /** This ingredient's share of one batch, in microcents. Display only. */
  contributionMicrocents: Microcents;
  costSource: ComponentCostSource;
}

export interface RecipeCostResult {
  /** The cost of ONE batch, in microcents. */
  batchMicrocents: Microcents;
  /** The figure a sale would be costed at: per base unit of the recipe product. */
  perBaseUnitMicrocents: Microcents;
  contributions: ComponentContribution[];
}

/**
 * What the editor shows when a recipe cannot be costed yet.
 *
 * The cost is ABSENT, not zero. Returning zero here is exactly how a
 * catalogue of 100% margins stops looking like a problem.
 */
export interface RecipeCostIncomplete {
  /** Ingredient names with no cost basis. Never empty in this variant. */
  uncosted: string[];
}

export type RecipeCostOutcome =
  | { kind: "costed"; cost: RecipeCostResult }
  | { kind: "incomplete"; incomplete: RecipeCostIncomplete }
  | { kind: "refused"; reason: string };

function toNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new Error(`Recipe arithmetic: ${what} is too large to represent exactly.`);
  }
  return Number(value);
}

/** Reject anything outside the admissible envelope, BEFORE multiplying. */
function checkComponent(c: RecipeCostComponent): string | null {
  const q = c.quantity;
  if (!Number.isInteger(q.num) || !Number.isInteger(q.den) || q.num < 1 || q.den < 1) {
    return `"${c.componentName}" has a quantity of ${q.num}/${q.den}; both parts must be whole numbers of at least 1.`;
  }
  if (q.num > MAX_QUANTITY_PART || q.den > MAX_QUANTITY_PART) {
    return `"${c.componentName}" has a quantity outside the range Greaz can cost exactly.`;
  }
  if (
    !Number.isInteger(c.factorNum) ||
    !Number.isInteger(c.factorDen) ||
    c.factorNum < 1 ||
    c.factorDen < 1 ||
    c.factorNum > MAX_FACTOR_PART ||
    c.factorDen > MAX_FACTOR_PART
  ) {
    return `"${c.componentName}" has a unit conversion of ${c.factorNum}/${c.factorDen}, which is outside the supported range.`;
  }
  if (!Number.isInteger(c.wasteBps) || c.wasteBps < 0 || c.wasteBps >= 10_000) {
    return `"${c.componentName}" has a waste of ${c.wasteBps} basis points; it must be at least 0 and below 10000 (100%).`;
  }
  const rate = c.unitCostExclVatMicrocents;
  if (rate !== null && (rate < 0 || rate > MAX_RATE_MICROCENTS)) {
    return `"${c.componentName}" has a cost rate outside the range Greaz can cost exactly.`;
  }
  return null;
}

/**
 * Cost a recipe for the editor.
 *
 * Returns a VERDICT rather than throwing, because every one of these outcomes
 * is something the editor has to render: a cost, a list of ingredients that
 * have none, or a refusal naming what is out of range. `null` is never
 * returned in place of a cost.
 */
export function recipeCost(
  components: RecipeCostComponent[],
  yieldQuantityBase: number,
): RecipeCostOutcome {
  if (components.length === 0) {
    return { kind: "refused", reason: "A recipe needs at least one ingredient." };
  }
  if (components.length > MAX_COMPONENTS) {
    return {
      kind: "refused",
      reason: `A recipe may hold at most ${MAX_COMPONENTS} ingredients; this one has ${components.length}.`,
    };
  }
  if (
    !Number.isInteger(yieldQuantityBase) ||
    yieldQuantityBase < 1 ||
    yieldQuantityBase > MAX_YIELD_BASE
  ) {
    return {
      kind: "refused",
      reason: `A batch yield must be a whole number between 1 and ${MAX_YIELD_BASE.toLocaleString()}.`,
    };
  }

  for (const c of components) {
    const problem = checkComponent(c);
    if (problem) return { kind: "refused", reason: problem };
  }

  const uncosted = components
    .filter((c) => c.unitCostExclVatMicrocents === null)
    .map((c) => c.componentName);
  if (uncosted.length > 0) {
    return { kind: "incomplete", incomplete: { uncosted } };
  }

  let batchAcc = 0n;
  const contributions: ComponentContribution[] = [];

  try {
    for (const c of components) {
      const rate = BigInt(c.unitCostExclVatMicrocents ?? 0);
      const numerator =
        rate *
        BigInt(c.quantity.num) *
        BigInt(c.factorNum) *
        BigInt(10_000 + c.wasteBps) *
        ACC_BIG;
      const denominator = BigInt(c.quantity.den) * BigInt(c.factorDen) * 10_000n;
      const contribution = divRoundHalfAway(numerator, denominator);
      batchAcc += contribution;
      contributions.push({
        componentProductId: c.componentProductId,
        componentName: c.componentName,
        // Display only. The batch sums the ACC-scale values, never these.
        contributionMicrocents: toNumber(
          divRoundHalfAway(contribution, ACC_BIG),
          `the contribution of "${c.componentName}"`,
        ),
        costSource: c.costSource,
      });
    }

    const batchMicrocents = toNumber(divRoundHalfAway(batchAcc, ACC_BIG), "the batch cost");
    const perBaseUnitMicrocents = toNumber(
      divRoundHalfAway(batchAcc, ACC_BIG * BigInt(yieldQuantityBase)),
      "the per-unit recipe cost",
    );
    return {
      kind: "costed",
      cost: { batchMicrocents, perBaseUnitMicrocents, contributions },
    };
  } catch (e) {
    return { kind: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures — transcribed from `recipe_cost::FIXTURES`
// ---------------------------------------------------------------------------

/**
 * The contract between this file and the Rust authority.
 *
 * Each component is `[rateMicrocents, qNum, qDen, fNum, fDen, wasteBps]`, in
 * the same order and with the same expected figures as
 * `src-tauri/src/recipe_cost.rs`. If the two ever disagree, one of them has
 * changed and the other has not, and the test that notices is the point.
 */
export interface RecipeCostFixture {
  name: string;
  components: [number, number, number, number, number, number][];
  yieldBase: number;
  expectBatchMicrocents: number;
  expectPerBaseUnitMicrocents: number;
}

export const FIXTURES: RecipeCostFixture[] = [
  {
    name: "greaz_burger",
    components: [
      [22_000_000, 1, 1, 1, 1, 0],
      [850_000, 150, 1, 1, 1, 0],
      [120_000, 25, 1, 1, 1, 0],
      [31_000_000, 1, 2, 1, 1, 0],
    ],
    yieldBase: 1,
    expectBatchMicrocents: 168_000_000,
    expectPerBaseUnitMicrocents: 168_000_000,
  },
  {
    name: "sauce_batch_yield_20",
    components: [[100_000, 500, 1, 1, 1, 0]],
    yieldBase: 20,
    expectBatchMicrocents: 50_000_000,
    expectPerBaseUnitMicrocents: 2_500_000,
  },
  {
    name: "waste_12_percent",
    components: [[40_000_000, 1, 1, 1, 1, 1_200]],
    yieldBase: 1,
    expectBatchMicrocents: 44_800_000,
    expectPerBaseUnitMicrocents: 44_800_000,
  },
  {
    name: "box_of_twelve",
    components: [[1_700_000, 2, 1, 12, 1, 0]],
    yieldBase: 1,
    expectBatchMicrocents: 40_800_000,
    expectPerBaseUnitMicrocents: 40_800_000,
  },
  {
    name: "thirds_and_sevenths",
    components: [
      [100_000, 1, 3, 1, 1, 0],
      [100_000, 1, 7, 1, 1, 0],
      [100_000, 20, 7, 1, 1, 0],
    ],
    yieldBase: 1,
    expectBatchMicrocents: 333_333,
    expectPerBaseUnitMicrocents: 333_333,
  },
  {
    name: "pinches_naive_rounding_loses",
    components: [
      [22_000_000, 1, 1, 1, 1, 0],
      [2, 1, 5, 1, 1, 0],
      [2, 1, 5, 1, 1, 0],
      [2, 1, 5, 1, 1, 0],
    ],
    yieldBase: 1,
    expectBatchMicrocents: 22_000_001,
    expectPerBaseUnitMicrocents: 22_000_001,
  },
  {
    name: "an_eighth_of_a_kilo",
    components: [[250_000, 1, 8, 1_000, 1, 0]],
    yieldBase: 1,
    expectBatchMicrocents: 31_250_000,
    expectPerBaseUnitMicrocents: 31_250_000,
  },
  {
    name: "documented_zero_component",
    components: [
      [22_000_000, 1, 1, 1, 1, 0],
      [0, 3, 1, 1, 1, 0],
    ],
    yieldBase: 1,
    expectBatchMicrocents: 22_000_000,
    expectPerBaseUnitMicrocents: 22_000_000,
  },
  {
    name: "yield_three_rounds_once",
    components: [[100_000, 1, 1, 1, 1, 0]],
    yieldBase: 3,
    expectBatchMicrocents: 100_000,
    expectPerBaseUnitMicrocents: 33_333,
  },
];

/** Build a component from a fixture tuple, for the test suite. */
export function fixtureComponent(
  index: number,
  t: [number, number, number, number, number, number],
): RecipeCostComponent {
  return {
    componentProductId: `fixture-component-${index}`,
    componentName: `Fixture ingredient ${index}`,
    quantity: { num: t[1], den: t[2] },
    uomCode: "each",
    factorNum: t[3],
    factorDen: t[4],
    wasteBps: t[5],
    unitCostExclVatMicrocents: t[0],
    costSource: "purchase_average",
  };
}
