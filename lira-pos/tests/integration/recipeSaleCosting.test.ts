/**
 * Migration 022's schema and the posted-cost read model (WP-B2-B).
 *
 * Scope note, as elsewhere in this directory: this runs the real migration
 * chain and repository SQL against node:sqlite with the Tauri SQL plugin
 * mocked out. It is not an end-to-end Tauri test — `src-tauri/src/tests/
 * recipe_sale_costing.rs` is the authority on what `post_sale` DOES with a
 * recipe. What is proved HERE is the half that lives in SQL and TypeScript:
 * the constraints and triggers 022 produces, which bind ANY writer at all,
 * and the read model a screen shows an owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  resetIds,
  seedExchangeRate,
  seedProduct,
  STORE_ID,
  USER_ID,
  RATE_ID,
  RATE_LBP_PER_USD,
  VAT_STD_ID,
} from "../helpers/sqlDb";
import { recipesRepo } from "../../src/db/repos/recipes";

const BURGER = "prod-burger";
const BUN = "prod-bun";
const PATTY = "prod-patty";
const SALE = "sale-1";
const LINE = "line-1";
const RECIPE = "rcp-1";

let db: DatabaseSync;

function uom(productId: string, uomCode: string, num: number, den: number, isBase = false) {
  db.prepare(
    `INSERT INTO product_uoms
       (id, store_id, product_id, uom_code, factor_num, factor_den,
        is_base, is_default_sale_uom, is_default_purchase_uom, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
  ).run(
    `uom-${productId}-${uomCode}`,
    STORE_ID,
    productId,
    uomCode,
    num,
    den,
    isBase ? 1 : 0,
    isBase ? 1 : 0,
  );
}

interface ComponentFixture {
  productId: string;
  uomCode: string;
  quantityNum?: number;
  quantityDen?: number;
  factorNum?: number;
  factorDen?: number;
  wasteBps?: number;
}

/**
 * A published recipe for the burger. One bun by default.
 *
 * The component set is a PARAMETER since the P1-A correction, because migration
 * 022 now proves that a line's evidence set IS its recipe version's component
 * set, row for row and figure for figure. A fixture that wrote evidence for an
 * ingredient the recipe did not contain used to pass; it was never a state
 * `post_sale` could produce, and the read-model assertions it carried are
 * worth keeping, so the recipe is built to match the evidence instead.
 */
function publishedRecipe(
  components: ComponentFixture[] = [{ productId: BUN, uomCode: "each" }],
  yieldBase = 1,
): void {
  db.prepare(
    `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
     VALUES (?, ?, ?, 1, ?, 'draft')`,
  ).run(RECIPE, STORE_ID, BURGER, yieldBase);
  components.forEach((c, i) => {
    db.prepare(
      `INSERT INTO recipe_components
         (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
          uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot,
          waste_bps, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `rc-${i + 1}`,
      RECIPE,
      STORE_ID,
      c.productId,
      c.quantityNum ?? 1,
      c.quantityDen ?? 1,
      c.uomCode,
      `uom-${c.productId}-${c.uomCode}`,
      c.factorNum ?? 1,
      c.factorDen ?? 1,
      c.wasteBps ?? 0,
      i,
    );
  });
  db.prepare(
    `UPDATE recipes SET status='active', activated_at='2026-10-26T09:00:00.000Z' WHERE id=?`,
  ).run(RECIPE);
}

/**
 * `cost::microcents_to_cents` — half away from zero, for a non-negative rate.
 * Written out rather than imported so the TEST states the rule independently
 * of the code under test.
 */
function unitCents(rateMicrocents: number): number {
  return Math.trunc((rateMicrocents + 500_000) / 1_000_000);
}

/**
 * `cost::extended_cost_cents` — the PRECISE rate times the quantity, rounded
 * ONCE. Deliberately not `unitCents(rate) * qty`.
 */
function lineCents(rateMicrocents: number, qty: number): number {
  return Math.trunc((rateMicrocents * qty + 500_000) / 1_000_000);
}

/**
 * A DRAFT sale carrying one recipe-costed line. Promoted by `postSale`.
 *
 * The rate is a parameter for the same reason the component set is: rule 6o
 * reconciles it against the evidence beneath it and the recipe's batch yield,
 * so a fixture has to state a rate its own evidence supports. The CENT columns
 * and the header total are DERIVED, because since the P1-B correction the
 * engine reconciles all three exactly — the old fixture claimed 22 cents for a
 * rate of 220,000 microcents, which is 0.22 of a cent, and nothing checked it.
 */
function draftSaleWithRecipeLine(
  unitMicrocents = 220_000,
  qty = 1,
  overrides: { unitC?: number; lineC?: number; total?: number } = {},
): void {
  const unitC = overrides.unitC ?? unitCents(unitMicrocents);
  const lineC = overrides.lineC ?? lineCents(unitMicrocents, qty);
  const total = overrides.total ?? lineC;
  db.prepare(
    `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
        exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
        total_incl_vat_cents, cogs_total_cents, cogs_method, status)
     VALUES (?, ?, ?, ?, 1, ?, ?, 1000, 110, 1110, ?, 'weighted_average', 'draft')`,
  ).run(SALE, STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD, 0, total);
  db.prepare(
    `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
        vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
        unit_price_excl_vat_cents, unit_price_incl_vat_cents,
        line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
        unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
        unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
        factor_num_snapshot, factor_den_snapshot, cogs_source,
        recipe_id, recipe_version)
     VALUES (?, ?, ?, ?, 'Greaz Burger', ?, 1100, ?, 1000, 1110, 1000, 110, 1110,
        ?, ?, ?, ?, 'each', 1, 1, 'recipe', ?, 1)`,
  ).run(
    LINE,
    SALE,
    STORE_ID,
    BURGER,
    VAT_STD_ID,
    qty,
    unitC,
    lineC,
    unitMicrocents,
    qty,
    RECIPE,
  );
}

function evidenceRow(overrides: Record<string, unknown> = {}): void {
  const v = {
    id: "ev-1",
    sale_id: SALE,
    sale_item_id: LINE,
    store_id: STORE_ID,
    recipe_id: RECIPE,
    recipe_version: 1,
    component_product_id: BUN,
    component_name_snapshot: "Burger bun",
    uom_code: "each",
    quantity_num: 1,
    quantity_den: 1,
    factor_num_snapshot: 1,
    factor_den_snapshot: 1,
    waste_bps: 0,
    unit_cost_excl_vat_microcents: 220_000,
    cost_source: "purchase_average",
    contribution_microcents: 220_000,
    sort_order: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sale_item_recipe_costs
       (id, sale_id, sale_item_id, store_id, recipe_id, recipe_version,
        component_product_id, component_name_snapshot, uom_code,
        quantity_num, quantity_den, factor_num_snapshot, factor_den_snapshot,
        waste_bps, unit_cost_excl_vat_microcents, cost_source,
        contribution_microcents, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    v.id,
    v.sale_id,
    v.sale_item_id,
    v.store_id,
    v.recipe_id,
    v.recipe_version,
    v.component_product_id,
    v.component_name_snapshot,
    v.uom_code,
    v.quantity_num,
    v.quantity_den,
    v.factor_num_snapshot,
    v.factor_den_snapshot,
    v.waste_bps,
    v.unit_cost_excl_vat_microcents,
    v.cost_source,
    v.contribution_microcents,
    v.sort_order,
  );
}

function postSale(): void {
  db.prepare(
    `UPDATE sales SET status='posted', posted_at='2026-10-26T12:00:00.000Z' WHERE id=?`,
  ).run(SALE);
}

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  seedProduct(db, { id: BURGER, sku: "SKU-BRG", name: "Greaz Burger", isService: true });
  uom(BURGER, "each", 1, 1, true);
  seedProduct(db, { id: BUN, sku: "SKU-BUN", name: "Burger bun" });
  uom(BUN, "each", 1, 1, true);
  seedProduct(db, { id: PATTY, sku: "SKU-PTY", name: "Beef patty mince" });
  uom(PATTY, "g", 1, 1, true);
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

// ===========================================================================
// 1. The schema migration 022 produces
// ===========================================================================

describe("migration 022's schema", () => {
  it("adds exactly two NULLABLE columns to sale_items", () => {
    const cols = db
      .prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('sale_items')`)
      .all() as { name: string; nn: number }[];
    const added = cols.filter((c) => c.name === "recipe_id" || c.name === "recipe_version");
    expect(added.map((c) => c.name).sort()).toEqual(["recipe_id", "recipe_version"]);
    // Nullable, because every line posted before 022 has no recipe and never
    // will: history is not restated.
    expect(added.every((c) => c.nn === 0)).toBe(true);
  });

  it("creates the evidence table with its append-only guards", () => {
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='trigger' AND tbl_name='sale_item_recipe_costs'
          ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name)).toEqual([
      "trg_sale_item_recipe_costs_coherence",
      "trg_sale_item_recipe_costs_no_delete",
      "trg_sale_item_recipe_costs_no_insert_after_post",
      "trg_sale_item_recipe_costs_no_update",
    ]);
  });

  it("leaves the recipe tables and every financial table untouched", () => {
    // 022 is additive. Anything it changed here would be a table rebuild, and
    // a rebuild of a posted-document table is the most dangerous statement
    // this codebase could run.
    for (const table of ["sales", "sale_payments", "inventory_movements", "recipes"]) {
      const cols = db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all() as { name: string }[];
      expect(cols.some((c) => c.name.startsWith("recipe_cost"))).toBe(false);
    }
  });
});

// ===========================================================================
// 2. A line and its evidence must agree
// ===========================================================================

describe("the sale-line recipe stamp", () => {
  it("refuses a recipe-costed line that names no recipe version", () => {
    publishedRecipe();
    db.prepare(
      `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
          exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
          total_incl_vat_cents, cogs_total_cents, cogs_method, status)
       VALUES (?, ?, ?, ?, 1, ?, 0, 1000, 110, 1110, 0, 'weighted_average', 'draft')`,
    ).run(SALE, STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD);

    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
              vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
              unit_price_excl_vat_cents, unit_price_incl_vat_cents,
              line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
              unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
              unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
              factor_num_snapshot, factor_den_snapshot, cogs_source)
           VALUES ('l', ?, ?, ?, 'Greaz Burger', ?, 1100, 1, 1000, 1110, 1000, 110, 1110,
              0, 0, 0, 1, 'each', 1, 1, 'recipe')`,
        )
        .run(SALE, STORE_ID, BURGER, VAT_STD_ID),
    ).toThrow(/must record which recipe version/);
  });

  it("refuses a line that names a recipe under another provenance", () => {
    publishedRecipe();
    db.prepare(
      `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
          exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
          total_incl_vat_cents, cogs_total_cents, cogs_method, status)
       VALUES (?, ?, ?, ?, 1, ?, 0, 1000, 110, 1110, 0, 'weighted_average', 'draft')`,
    ).run(SALE, STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD);

    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
              vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
              unit_price_excl_vat_cents, unit_price_incl_vat_cents,
              line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
              unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
              unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
              factor_num_snapshot, factor_den_snapshot, cogs_source,
              recipe_id, recipe_version)
           VALUES ('l', ?, ?, ?, 'Greaz Burger', ?, 1100, 1, 1000, 1110, 1000, 110, 1110,
              0, 0, 0, 1, 'each', 1, 1, 'standard', ?, 1)`,
        )
        .run(SALE, STORE_ID, BURGER, VAT_STD_ID, RECIPE),
    ).toThrow(/only name a recipe when it was costed/);
  });

  it("leaves a legacy line, with neither column, entirely alone", () => {
    // The guard is keyed on presence, so a pre-022 line is never reached by
    // it. This is the assertion that stops the rule becoming retrospective.
    db.prepare(
      `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
          exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
          total_incl_vat_cents, cogs_total_cents, cogs_method, status)
       VALUES (?, ?, ?, ?, 1, ?, 0, 1000, 110, 1110, 0, 'weighted_average', 'draft')`,
    ).run(SALE, STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD);
    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
              vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
              unit_price_excl_vat_cents, unit_price_incl_vat_cents,
              line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
              unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
              unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
              factor_num_snapshot, factor_den_snapshot)
           VALUES ('l', ?, ?, ?, 'Greaz Burger', ?, 1100, 1, 1000, 1110, 1000, 110, 1110,
              0, 0, 0, 1, 'each', 1, 1)`,
        )
        .run(SALE, STORE_ID, BURGER, VAT_STD_ID),
    ).not.toThrow();
  });
});

// ===========================================================================
// 3. A sale does not post while a recipe line is unexplained
// ===========================================================================

describe("the posting guard", () => {
  it("refuses to post a recipe-costed line with no evidence", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    expect(() => postSale()).toThrow(/no cost evidence/);
    expect(
      (db.prepare(`SELECT status AS s FROM sales WHERE id='${SALE}'`).get() as { s: string }).s,
    ).toBe("draft");
  });

  it("posts once the evidence is there", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    expect(() => postSale()).not.toThrow();
    expect(
      (db.prepare(`SELECT status AS s FROM sales WHERE id='${SALE}'`).get() as { s: string }).s,
    ).toBe("posted");
  });

  it("does not stand in the way of a sale with no recipe line at all", () => {
    db.prepare(
      `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
          exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
          total_incl_vat_cents, cogs_total_cents, cogs_method, status)
       VALUES (?, ?, ?, ?, 1, ?, 0, 1000, 110, 1110, 0, 'weighted_average', 'draft')`,
    ).run(SALE, STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD);
    expect(() => postSale()).not.toThrow();
  });
});

// ===========================================================================
// 4. The evidence is sealed
// ===========================================================================

describe("posted recipe-cost evidence", () => {
  beforeEach(() => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    postSale();
  });

  it("takes no UPDATE, ever", () => {
    expect(() =>
      db.exec(
        `UPDATE sale_item_recipe_costs SET unit_cost_excl_vat_microcents = 1 WHERE id='ev-1'`,
      ),
    ).toThrow(/immutable/);
  });

  it("takes no DELETE, ever", () => {
    expect(() => db.exec(`DELETE FROM sale_item_recipe_costs WHERE id='ev-1'`)).toThrow(
      /append-only/,
    );
  });

  it("takes no new row once its sale has posted", () => {
    expect(() => evidenceRow({ id: "ev-2", component_product_id: PATTY })).toThrow(
      /posted sale/,
    );
  });

  it("still holds exactly what was written", () => {
    const row = db
      .prepare(
        `SELECT unit_cost_excl_vat_microcents AS r, contribution_microcents AS c,
                cost_source AS s, recipe_version AS v
           FROM sale_item_recipe_costs WHERE id='ev-1'`,
      )
      .get() as { r: number; c: number; s: string; v: number };
    expect(row).toEqual({ r: 220_000, c: 220_000, s: "purchase_average", v: 1 });
  });
});

describe("evidence coherence", () => {
  it("refuses a row naming a sale line that is not its own", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    expect(() => evidenceRow({ sale_item_id: "no-such-line" })).toThrow();
  });

  it("refuses a row naming a recipe version the line was not costed from", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    expect(() => evidenceRow({ recipe_version: 7 })).toThrow(
      /name the recipe its line was costed from/,
    );
  });

  it("refuses two rows for the same ingredient on one line", () => {
    // `recipe_components`' own uniqueness, carried forward: a replay that
    // somehow re-ran the evidence write collides rather than doubling it.
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    expect(() => evidenceRow({ id: "ev-dup" })).toThrow();
  });
});

// ===========================================================================
// 5. The read model a screen shows
// ===========================================================================

describe("recipesRepo.postedCostBreakdown", () => {
  it("returns the frozen explanation, in stored order", async () => {
    publishedRecipe([
      { productId: BUN, uomCode: "each" },
      { productId: PATTY, uomCode: "g", quantityNum: 150, wasteBps: 500 },
    ]);
    // 220,000 (bun) + 1,338,750 (150 g at 8,500 with 5% waste) = 1,558,750.
    draftSaleWithRecipeLine(1_558_750);
    evidenceRow();
    evidenceRow({
      id: "ev-2",
      component_product_id: PATTY,
      component_name_snapshot: "Beef patty mince",
      uom_code: "g",
      quantity_num: 150,
      unit_cost_excl_vat_microcents: 8_500,
      waste_bps: 500,
      contribution_microcents: 1_338_750,
      sort_order: 1,
    });
    postSale();

    const rows = await recipesRepo.postedCostBreakdown({ saleItemId: LINE });
    expect(rows.map((r) => r.componentName)).toEqual(["Burger bun", "Beef patty mince"]);
    expect(rows[1]).toMatchObject({
      uomCode: "g",
      quantity: { num: 150, den: 1 },
      wasteBps: 500,
      unitCostExclVatMicrocents: 8_500,
      contributionMicrocents: 1_338_750,
      costSource: "purchase_average",
      recipeVersion: 1,
    });
  });

  it("reads back the published snapshot, not the catalogue's current factor", async () => {
    // The whole reason the snapshot columns exist. The shop redefines the
    // ingredient's unit AFTER the sale; the explanation does not move.
    uom(PATTY, "kg", 1_000, 1);
    publishedRecipe([{ productId: PATTY, uomCode: "kg", factorNum: 1_000 }]);
    // One kg of mince at 220,000 microcents a gram.
    draftSaleWithRecipeLine(220_000_000);
    evidenceRow({
      component_product_id: PATTY,
      component_name_snapshot: "Beef patty mince",
      uom_code: "kg",
      factor_num_snapshot: 1_000,
      contribution_microcents: 220_000_000,
    });
    postSale();

    // The shop redefines a kilogram as 2000 grams AFTER the sale. (The base
    // unit cannot be redefined at all — its own CHECK pins it to 1/1 — so the
    // case only exists on a derived unit, which is also where it matters.)
    db.exec(
      `UPDATE product_uoms SET factor_num = 2000 WHERE product_id='${PATTY}' AND uom_code='kg'`,
    );

    const rows = await recipesRepo.postedCostBreakdown({ saleItemId: LINE });
    expect(rows[0]!.factorNum).toBe(1_000);
  });

  it("returns an empty array for a line that was not costed from a recipe", async () => {
    // Which the caller reports as "no breakdown recorded" rather than as an
    // empty table that looks like something went missing.
    expect(await recipesRepo.postedCostBreakdown({ saleItemId: "nope" })).toEqual([]);
  });
});

// ===========================================================================
// 6. P1-A — THE EVIDENCE SET, not merely the presence of a row
//
// The defect: `trg_sales_recipe_evidence_complete` asked "does at least one
// evidence row exist for this line?", so a four-ingredient burger with one
// hand-written row posted, and its receipt carried an explanation of a quarter
// of its own cost, sealed for ever. These run against the real migration
// chain, so they bind ANY writer at all — which is the claim being made.
// ===========================================================================

/** The burger as bun + patty: two ingredients, 220,000 + 1,338,750. */
function twoIngredientRecipe(): void {
  publishedRecipe([
    { productId: BUN, uomCode: "each" },
    { productId: PATTY, uomCode: "g", quantityNum: 150, wasteBps: 500 },
  ]);
}

function pattyEvidence(overrides: Record<string, unknown> = {}): void {
  evidenceRow({
    id: "ev-2",
    component_product_id: PATTY,
    component_name_snapshot: "Beef patty mince",
    uom_code: "g",
    quantity_num: 150,
    waste_bps: 500,
    unit_cost_excl_vat_microcents: 8_500,
    contribution_microcents: 1_338_750,
    sort_order: 1,
    ...overrides,
  });
}

function saleStatus(): string {
  return (
    db.prepare(`SELECT status AS s FROM sales WHERE id='${SALE}'`).get() as { s: string }
  ).s;
}

describe("the evidence SET must be the recipe's component set", () => {
  it("refuses to post a two-ingredient recipe explained by one row", () => {
    twoIngredientRecipe();
    draftSaleWithRecipeLine(1_558_750);
    evidenceRow(); // the bun only, and perfectly honest in itself
    expect(() => postSale()).toThrow(/incomplete recipe-cost explanation/);
    expect(saleStatus()).toBe("draft");
  });

  it("posts once every ingredient is explained", () => {
    twoIngredientRecipe();
    draftSaleWithRecipeLine(1_558_750);
    evidenceRow();
    pattyEvidence();
    expect(() => postSale()).not.toThrow();
    expect(saleStatus()).toBe("posted");
  });

  it("refuses an evidence row for an ingredient the recipe does not contain", () => {
    // Every foreign key is satisfied: the patty is a real product of the right
    // store with a real cost. It is simply not in this recipe.
    publishedRecipe();
    draftSaleWithRecipeLine();
    expect(() => pattyEvidence()).toThrow(/not in the recipe version it cites/);
  });

  it("refuses an evidence row whose frozen physics are not the recipe's", () => {
    twoIngredientRecipe();
    draftSaleWithRecipeLine(1_558_750);
    evidenceRow();
    // 300 g instead of the published 150 g, with a contribution internally
    // consistent with the 300 — so the ONLY thing wrong is that the recipe
    // does not say it. Same for the conversion and the waste.
    expect(() =>
      pattyEvidence({ quantity_num: 300, contribution_microcents: 2_677_500 }),
    ).toThrow(/disagrees with the published recipe/);
    expect(() =>
      pattyEvidence({ factor_num_snapshot: 2, contribution_microcents: 2_677_500 }),
    ).toThrow(/disagrees with the published recipe/);
    expect(() =>
      pattyEvidence({ waste_bps: 0, contribution_microcents: 1_275_000 }),
    ).toThrow(/disagrees with the published recipe/);
  });

  it("refuses a fabricated contribution, and admits one microcent of rounding", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    // The physics and the rate are the recipe's own; only the figure is
    // invented. 220,000 is the true contribution of one bun.
    for (const bogus of [0, 1, 219_998, 220_002, 9_000_000]) {
      expect(() => evidenceRow({ contribution_microcents: bogus })).toThrow(
        /does not follow from its own rate/,
      );
    }
    // One microcent — a MILLIONTH of a cent — is the DOCUMENTED
    // tolerance: `recipe_cost.rs` has two rounding points, and the migration
    // states that as a tolerance rather than claiming an identity.
    expect(() => evidenceRow({ contribution_microcents: 219_999 })).not.toThrow();
  });

  it("refuses a line rate that does not follow from its own evidence", () => {
    twoIngredientRecipe();
    draftSaleWithRecipeLine(220_000); // the bun alone, with the patty in the recipe
    evidenceRow();
    pattyEvidence();
    expect(() => postSale()).toThrow(/does not follow from the evidence beneath it/);
    expect(saleStatus()).toBe("draft");
  });

  it("reconciles a BATCH yield above one, dividing once", () => {
    // The evidence describes the batch; the line's rate is that batch over the
    // yield. Reading the two as one figure overstates a twenty-portion recipe
    // twentyfold, which is why the breakdown panel now names all three.
    publishedRecipe(
      [
        { productId: BUN, uomCode: "each" },
        { productId: PATTY, uomCode: "g", quantityNum: 150, wasteBps: 500 },
      ],
      20,
    );
    draftSaleWithRecipeLine(Math.round(1_558_750 / 20));
    evidenceRow();
    pattyEvidence();
    expect(() => postSale()).not.toThrow();
  });

  it("refuses evidence attached to a line that was not costed from a recipe", () => {
    publishedRecipe();
    db.prepare(
      `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
          exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
          total_incl_vat_cents, cogs_total_cents, cogs_method, status)
       VALUES (?, ?, ?, ?, 1, ?, 0, 1000, 110, 1110, 22, 'weighted_average', 'draft')`,
    ).run(SALE, STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD);
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
          vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
          unit_price_excl_vat_cents, unit_price_incl_vat_cents,
          line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
          unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
          unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
          factor_num_snapshot, factor_den_snapshot, cogs_source)
       VALUES (?, ?, ?, ?, 'Burger bun', ?, 1100, 1, 1000, 1110, 1000, 110, 1110,
          22, 22, 220000, 1, 'each', 1, 1, 'purchase_average')`,
    ).run(LINE, SALE, STORE_ID, BUN, VAT_STD_ID);
    expect(() => evidenceRow()).toThrow(/only explain a line that was costed from a recipe/);
  });
});

// ===========================================================================
// 7. P1-B — a recipe-costed line is not editable, and is never reparented
//
// Migration 012's reparenting guard fires only when the OLD or NEW parent is
// POSTED, and every posting command builds a draft and promotes it last. That
// window left a line with evidence beneath it an ordinary updatable row.
// ===========================================================================

describe("a recipe-costed sale line on a DRAFT sale", () => {
  beforeEach(() => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
  });

  it("cannot be moved to another draft sale", () => {
    db.prepare(
      `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
          exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
          total_incl_vat_cents, cogs_total_cents, cogs_method, status)
       VALUES ('sale-2', ?, ?, ?, 2, ?, 0, 1000, 110, 1110, 22, 'weighted_average', 'draft')`,
    ).run(STORE_ID, USER_ID, RATE_ID, RATE_LBP_PER_USD);
    expect(() => db.exec(`UPDATE sale_items SET sale_id='sale-2' WHERE id='${LINE}'`)).toThrow(
      /frozen|cannot be moved/,
    );
    expect(
      (
        db.prepare(`SELECT sale_id AS s FROM sale_items WHERE id='${LINE}'`).get() as {
          s: string;
        }
      ).s,
    ).toBe(SALE);
  });

  it("cannot have its cost, product, quantity, recipe or provenance edited", () => {
    for (const set of [
      "unit_cogs_excl_vat_microcents = 1",
      "unit_cogs_excl_vat_cents = 1",
      "line_cogs_excl_vat_cents = 1",
      "quantity = 9",
      `product_id = '${BUN}'`,
      "cogs_source = 'standard'",
      "recipe_version = 2",
    ]) {
      expect(() => db.exec(`UPDATE sale_items SET ${set} WHERE id='${LINE}'`)).toThrow(
        /frozen|may only name a recipe/,
      );
    }
    expect(
      (
        db
          .prepare(
            `SELECT unit_cogs_excl_vat_microcents AS m FROM sale_items WHERE id='${LINE}'`,
          )
          .get() as { m: number }
      ).m,
    ).toBe(220_000);
  });

  it("refuses an UPDATE onto another product's recipe, with no evidence attached", () => {
    // The UPDATE path that had no guard at all: the INSERT trigger would have
    // refused this very row. A SECOND line, with no evidence of its own, so
    // rule 5a is not what refuses it — the evidence is append-only even on a
    // draft and cannot be deleted to make room for this.
    db.prepare(
      `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base,
          status, activated_at)
       VALUES ('rcp-other', ?, ?, 1, 1, 'active', '2026-10-26T09:00:00.000Z')`,
    ).run(STORE_ID, PATTY);
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
          vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
          unit_price_excl_vat_cents, unit_price_incl_vat_cents,
          line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
          unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
          unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
          factor_num_snapshot, factor_den_snapshot, cogs_source,
          recipe_id, recipe_version)
       VALUES ('line-bare', ?, ?, ?, 'Greaz Burger', ?, 1100, 1, 1000, 1110, 1000, 110, 1110,
          22, 22, 220000, 1, 'each', 1, 1, 'recipe', ?, 1)`,
    ).run(SALE, STORE_ID, BURGER, VAT_STD_ID, RECIPE);
    expect(() =>
      db.exec(`UPDATE sale_items SET recipe_id='rcp-other' WHERE id='line-bare'`),
    ).toThrow(/own store, and of its own product/);
  });

  it("leaves an ordinary draft line with no recipe involvement editable", () => {
    // The guard must not get in the way of unrelated draft editing: it fires
    // only on a row that names a recipe, claims `recipe` provenance, or has
    // evidence beneath it.
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
          vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
          unit_price_excl_vat_cents, unit_price_incl_vat_cents,
          line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
          unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
          unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
          factor_num_snapshot, factor_den_snapshot)
       VALUES ('line-plain', ?, ?, ?, 'Burger bun', ?, 1100, 1, 1000, 1110, 1000, 110, 1110,
          22, 22, 220000, 1, 'each', 1, 1)`,
    ).run(SALE, STORE_ID, BUN, VAT_STD_ID);
    expect(() =>
      db.exec(`UPDATE sale_items SET quantity = 3 WHERE id='line-plain'`),
    ).not.toThrow();
  });
});

// ===========================================================================
// 8. P2 — the posted breakdown carries its BATCH YIELD
// ===========================================================================

describe("the posted breakdown's batch yield", () => {
  it("reports the published version's own yield, so a batch is not read as a serving", async () => {
    publishedRecipe([{ productId: BUN, uomCode: "each" }], 20);
    draftSaleWithRecipeLine(11_000); // 220,000 a batch over a yield of 20
    evidenceRow();
    postSale();

    const rows = await recipesRepo.postedCostBreakdown({ saleItemId: LINE });
    expect(rows[0]!.yieldQuantityBase).toBe(20);
    // The contribution is the BATCH's, not the serving's — which is exactly
    // why the panel has to state the yield beside it.
    expect(rows[0]!.contributionMicrocents).toBe(220_000);
  });
});

// ===========================================================================
// 9. P1-A — ONLY A PUBLISHED RECIPE MAY COST A NEW SALE
//
// Proving the product, the store and the version number says WHICH recipe is
// meant. It does not say that recipe is the authoritative one. A DRAFT is the
// dangerous case, because migration 021 lets a draft's components be edited:
// anything proven about evidence written against one can be falsified
// afterwards. A RETIRED version is the quieter case — it was superseded
// precisely because it no longer states what the kitchen makes.
// ===========================================================================

/**
 * The same recipe, left as a DRAFT.
 *
 * Built as its own row rather than by un-publishing one: migration 021 refuses
 * both the status change and the component delete, which is the point — a
 * published version is frozen, and that is exactly why evidence proven against
 * a DRAFT is worth nothing.
 */
function draftRecipe(components: ComponentFixture[] = [{ productId: BUN, uomCode: "each" }]): void {
  db.prepare(
    `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
     VALUES (?, ?, ?, 1, 1, 'draft')`,
  ).run(RECIPE, STORE_ID, BURGER);
  components.forEach((c, i) => {
    db.prepare(
      `INSERT INTO recipe_components
         (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
          uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot,
          waste_bps, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `rc-${i + 1}`,
      RECIPE,
      STORE_ID,
      c.productId,
      c.quantityNum ?? 1,
      c.quantityDen ?? 1,
      c.uomCode,
      `uom-${c.productId}-${c.uomCode}`,
      c.factorNum ?? 1,
      c.factorDen ?? 1,
      c.wasteBps ?? 0,
      i,
    );
  });
}

describe("only a published recipe may cost a new sale", () => {
  it("refuses a sale line citing a DRAFT version", () => {
    draftRecipe();
    expect(
      (db.prepare(`SELECT status AS s FROM recipes WHERE id='${RECIPE}'`).get() as { s: string }).s,
    ).toBe("draft");
    expect(() => draftSaleWithRecipeLine()).toThrow(/only be costed from a PUBLISHED recipe/);
  });

  it("refuses a sale line citing a RETIRED version", () => {
    publishedRecipe();
    db.exec(
      `UPDATE recipes SET status='retired', retired_at='2026-10-27T09:00:00.000Z'
        WHERE id='${RECIPE}'`,
    );
    expect(() => draftSaleWithRecipeLine()).toThrow(/only be costed from a PUBLISHED recipe/);
  });

  it("accepts the ACTIVE version", () => {
    publishedRecipe();
    expect(() => draftSaleWithRecipeLine()).not.toThrow();
    evidenceRow();
    expect(() => postSale()).not.toThrow();
  });

  it("refuses PROMOTION of a draft sale whose recipe stopped being published", () => {
    // The interleaving: every INSERT-time rule passed while the recipe was
    // active, and the state that matters is the one at FINALIZATION. No honest
    // sale is caught — `post_sale` does all of it in one transaction and
    // SQLite serialises writers.
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    db.exec(
      `UPDATE recipes SET status='retired', retired_at='2026-10-27T09:00:00.000Z'
        WHERE id='${RECIPE}'`,
    );
    expect(() => postSale()).toThrow(/not published/);
    expect(saleStatus()).toBe("draft");
  });

  it("leaves a POSTED sale readable and immutable after its version retires", () => {
    // The half of the rule that must NOT be enforced: a trigger does not fire
    // on a SELECT, and history is not restated.
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    postSale();
    db.exec(
      `UPDATE recipes SET status='retired', retired_at='2026-10-27T09:00:00.000Z'
        WHERE id='${RECIPE}'`,
    );
    const row = db
      .prepare(
        `SELECT unit_cogs_excl_vat_microcents AS mc, cogs_source AS src, recipe_version AS v
           FROM sale_items WHERE id='${LINE}'`,
      )
      .get() as { mc: number; src: string; v: number };
    expect(row).toMatchObject({ mc: 220_000, src: "recipe", v: 1 });
    expect(() =>
      db.exec(`UPDATE sale_items SET unit_cogs_excl_vat_microcents=1 WHERE id='${LINE}'`),
    ).toThrow(/frozen|immutable/);
  });

  it("refuses re-pointing a draft line at an unpublished version", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    db.prepare(
      `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
       VALUES ('rcp-draft2', ?, ?, 2, 1, 'draft')`,
    ).run(STORE_ID, BURGER);
    expect(() =>
      db.exec(
        `UPDATE sale_items SET recipe_id='rcp-draft2', recipe_version=2 WHERE id='${LINE}'`,
      ),
    ).toThrow(/only be costed from a PUBLISHED recipe/);
  });
});

// ===========================================================================
// 10. P1-B — THE CENT COLUMNS ARE THE MONEY, RECONCILED EXACTLY
//
//     unit_cogs_excl_vat_cents = (U + 500000) / 1000000
//     line_cogs_excl_vat_cents = (U * Q + 500000) / 1000000      <- ONE rounding
//     sales.cogs_total_cents   = SUM(line_cogs_excl_vat_cents)
//
// The middle one is the trap: it is NOT the unit cost in cents times the
// quantity. `ROUND()` is not used anywhere — a float is not a rounding rule.
// ===========================================================================

describe("the cent columns", () => {
  it("states the rounding rule the application actually uses", () => {
    // Half AWAY from zero, at the boundary and either side of it.
    expect(unitCents(499_999)).toBe(0);
    expect(unitCents(500_000)).toBe(1);
    expect(unitCents(1_499_999)).toBe(1);
    expect(unitCents(1_500_000)).toBe(2);
    // One rounding, not two: three portions at 14,756,250 microcents are 44
    // cents, where 15 x 3 would be 45.
    expect(unitCents(14_756_250)).toBe(15);
    expect(lineCents(14_756_250, 3)).toBe(44);
    expect(lineCents(14_756_250, 3)).not.toBe(unitCents(14_756_250) * 3);
  });

  it("refuses a fraudulent UNIT cost in cents against faithful evidence", () => {
    // Codex's case, in miniature: the evidence is honest and the money is not.
    publishedRecipe();
    draftSaleWithRecipeLine(220_000_000, 1, { unitC: 1, lineC: 1, total: 1 });
    evidenceRow({
      unit_cost_excl_vat_microcents: 220_000_000,
      contribution_microcents: 220_000_000,
    });
    expect(() => postSale()).toThrow(/unit cost in cents does not follow/);
    expect(saleStatus()).toBe("draft");
  });

  it("refuses a fraudulent LINE cost with a correct unit cost", () => {
    publishedRecipe();
    // 220 cents a unit, three units: 660. Claim 220.
    draftSaleWithRecipeLine(220_000_000, 3, { unitC: 220, lineC: 220, total: 220 });
    evidenceRow({
      unit_cost_excl_vat_microcents: 220_000_000,
      contribution_microcents: 220_000_000,
    });
    expect(() => postSale()).toThrow(/extended cost does not follow/);
  });

  it("refuses a fraudulent SALE HEADER total with correct line costs", () => {
    publishedRecipe();
    draftSaleWithRecipeLine(220_000_000, 1, { total: 1 });
    evidenceRow({
      unit_cost_excl_vat_microcents: 220_000_000,
      contribution_microcents: 220_000_000,
    });
    expect(() => postSale()).toThrow(/total cost that is not the sum/);
  });

  it("posts when all three figures follow from the microcent rate", () => {
    publishedRecipe();
    draftSaleWithRecipeLine(220_000_000, 3);
    evidenceRow({
      unit_cost_excl_vat_microcents: 220_000_000,
      contribution_microcents: 220_000_000,
    });
    expect(() => postSale()).not.toThrow();
    const row = db
      .prepare(
        `SELECT unit_cogs_excl_vat_cents AS uc, line_cogs_excl_vat_cents AS lc
           FROM sale_items WHERE id='${LINE}'`,
      )
      .get() as { uc: number; lc: number };
    expect(row).toEqual({ uc: 220, lc: 660 });
    expect(
      (db.prepare(`SELECT cogs_total_cents AS t FROM sales WHERE id='${SALE}'`).get() as {
        t: number;
      }).t,
    ).toBe(660);
  });

  it("reconciles the header over EVERY line of a mixed-method sale", () => {
    // One recipe line and one purchase-valued line on one receipt. The header
    // is a single figure and has to be the whole of the sale.
    publishedRecipe();
    draftSaleWithRecipeLine(220_000_000, 1, { total: 220 });
    evidenceRow({
      unit_cost_excl_vat_microcents: 220_000_000,
      contribution_microcents: 220_000_000,
    });
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
          vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
          unit_price_excl_vat_cents, unit_price_incl_vat_cents,
          line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
          unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
          unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
          factor_num_snapshot, factor_den_snapshot, cogs_source)
       VALUES ('line-pa', ?, ?, ?, 'Beef patty mince', ?, 1100, 2, 1000, 1110,
          1000, 110, 1110, 9, 17, 8500000, 2, 'g', 1, 1, 'purchase_average')`,
    ).run(SALE, STORE_ID, PATTY, VAT_STD_ID);

    // The header still says 220 and the sale is now worth 220 + 17.
    expect(() => postSale()).toThrow(/total cost that is not the sum/);
    db.exec(`UPDATE sales SET cogs_total_cents = 237 WHERE id='${SALE}'`);
    expect(() => postSale()).not.toThrow();
  });
});

// ===========================================================================
// 11. P1-C — BOUNDED, INTEGER-SAFE ARITHMETIC
//
// Measured against the engine this application ships: `*` and `+` on INTEGERs
// SILENTLY PROMOTE TO REAL on overflow, `SUM()` RAISES, and INTEGER affinity
// is not a type — `typeof(2.0)` is `'real'`.
// ===========================================================================

describe("integer safety", () => {
  it("confirms the SQLite behaviour the gates exist for", () => {
    const one = <T>(sql: string): T =>
      (db.prepare(`SELECT ${sql} AS v`).get() as { v: T }).v;
    expect(one<string>("typeof(9223372036854775807 * 2)")).toBe("real");
    expect(one<string>("typeof(2.0)")).toBe("real");
    expect(one<string>("typeof('7')")).toBe("text");
    expect(one<string>("typeof(NULL)")).toBe("null");
    db.exec("CREATE TABLE ovf (x INTEGER)");
    db.exec("INSERT INTO ovf VALUES (9223372036854775807), (9223372036854775807)");
    expect(() => db.exec("INSERT INTO ovf SELECT SUM(x) FROM ovf")).toThrow(/overflow/i);
  });

  it("refuses a recipe's 65th ingredient", () => {
    const many: ComponentFixture[] = [];
    for (let i = 0; i < 64; i += 1) {
      const id = `prod-bulk-${i}`;
      seedProduct(db, { id, sku: `SKU-B${i}`, name: `Bulk ${i}`, isService: true });
      uom(id, "each", 1, 1, true);
      many.push({ productId: id, uomCode: "each" });
    }
    publishedRecipe(many);
    expect(
      (db
        .prepare(`SELECT COUNT(*) AS n FROM recipe_components WHERE recipe_id='${RECIPE}'`)
        .get() as { n: number }).n,
    ).toBe(64);
    expect(() =>
      db.exec(
        `INSERT INTO recipe_components
           (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
            uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot,
            waste_bps, sort_order)
         VALUES ('rc-65', '${RECIPE}', '${STORE_ID}', '${BUN}', 1, 1, 'each',
            'uom-${BUN}-each', 1, 1, 0, 99)`,
      ),
    ).toThrow(/at most 64 ingredients/);
  });

  it("refuses a non-integer storage class wherever it does arithmetic", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    // 1.5 stays REAL because affinity converts only a LOSSLESS numeric, and
    // 'abc' stays TEXT because it is not numeric at all.
    expect(() => evidenceRow({ quantity_num: 1.5 })).toThrow(/whole numbers/);
    expect(() => evidenceRow({ contribution_microcents: 220_000.5 })).toThrow(/whole numbers/);
    expect(() => evidenceRow({ unit_cost_excl_vat_microcents: "abc" })).toThrow(/whole numbers/);
    // The CONTROL: an integral REAL is converted before any trigger sees it,
    // so the rule is about storage class and not about a decimal point in the
    // SQL text.
    expect(() => evidenceRow({ quantity_num: 1.0 })).not.toThrow();
  });

  it("refuses an out-of-range contribution or rate before multiplying it", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    expect(() => evidenceRow({ contribution_microcents: 1_000_000_000_000_001 })).toThrow(
      /outside the range/,
    );
    expect(() =>
      evidenceRow({
        unit_cost_excl_vat_microcents: 10_000_000_000_001,
        contribution_microcents: 100_000_000_000_010,
      }),
    ).toThrow(/outside the range/);
    // The i64 extreme, which is where a silent promotion to REAL would make
    // every later comparison meaningless.
    expect(() =>
      evidenceRow({ contribution_microcents: 9_223_372_036_854_775_807n }),
    ).toThrow(/outside the range/);
  });

  it("refuses a REAL sale-header total at promotion", () => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    db.exec(`UPDATE sales SET cogs_total_cents = 0.5 WHERE id='${SALE}'`);
    expect(() => postSale()).toThrow(/stored as text, as a decimal or as NULL/);
  });
});

// ===========================================================================
// 12. THE POSTING STATE MACHINE
//
// `sales` carries two markers of the same fact and migration 001 never tied
// them together. The APPLICATION reads `status = 'posted'` — 37 query sites,
// none of which mention `posted_at` — while the ENGINE read `posted_at`. So
// `UPDATE sales SET status='posted'` made a sale real to every report while
// changing no column any guard watched, and left the row mutable afterwards.
//
// These run the real migration chain, so they bind any writer at all. The
// lettering follows the brief.
// ===========================================================================

function stateOf(saleId = SALE): { status: string; posted_at: string | null } {
  return db
    .prepare(`SELECT status, posted_at FROM sales WHERE id='${saleId}'`)
    .get() as { status: string; posted_at: string | null };
}

function insertSaleAs(id: string, receipt: number, status: string, postedAt: string | null): void {
  db.prepare(
    `INSERT INTO sales (id, store_id, cashier_user_id, exchange_rate_id, receipt_number,
        exchange_rate_lbp_per_usd, discount_cents, subtotal_excl_vat_cents, vat_total_cents,
        total_incl_vat_cents, cogs_total_cents, cogs_method, status, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1000, 110, 1110, 0, 'weighted_average', ?, ?)`,
  ).run(id, STORE_ID, USER_ID, RATE_ID, receipt, RATE_LBP_PER_USD, status, postedAt);
}

describe("a sale is born a draft", () => {
  it("refuses an INSERT in any state but draft-with-no-timestamp", () => {
    // A. posted with no timestamp — the row every report counts and no guard
    //    protects.
    // B. posted WITH a timestamp — which must not become the shortcut: at
    //    header-insert time there are no lines and no evidence to validate,
    //    and afterwards migration 012 refuses to let the lines arrive, so such
    //    a row could only ever be an empty receipt claiming whatever revenue
    //    its author typed.
    for (const [what, status, postedAt] of [
      ["A posted, no timestamp", "posted", null],
      ["B posted, with a timestamp", "posted", "2026-11-01T10:00:00.000Z"],
      ["  voided, with a timestamp", "voided", "2026-11-01T10:00:00.000Z"],
      ["  draft carrying a timestamp", "draft", "2026-11-01T10:00:00.000Z"],
    ] as [string, string, string | null][]) {
      expect(() => insertSaleAs("ins-probe", 7001, status, postedAt), what).toThrow(
        /created as a draft/,
      );
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sales").get() as { n: number }).n,
    ).toBe(0);

    // The one legal shape — which is what `post_sale` writes.
    expect(() => insertSaleAs("ins-ok", 7002, "draft", null)).not.toThrow();
    expect(stateOf("ins-ok")).toEqual({ status: "draft", posted_at: null });
  });
});

describe("no route into the posted state skips finalization", () => {
  /** A draft recipe sale whose explanation is MISSING one of two ingredients. */
  function incompleteDraft(): void {
    twoIngredientRecipe();
    draftSaleWithRecipeLine(1_558_750);
    evidenceRow(); // the bun only
  }

  it("C refuses a STATUS-only transition to posted", () => {
    // The bypass. The old trigger was `BEFORE UPDATE OF posted_at` and never
    // saw this statement.
    incompleteDraft();
    expect(() => db.exec(`UPDATE sales SET status='posted' WHERE id='${SALE}'`)).toThrow(
      /incomplete recipe-cost explanation|must record when it posted/,
    );
    expect(stateOf()).toEqual({ status: "draft", posted_at: null });
  });

  it("D refuses a POSTED_AT-only transition", () => {
    incompleteDraft();
    expect(() =>
      db.exec(`UPDATE sales SET posted_at='2026-11-01T10:00:00.000Z' WHERE id='${SALE}'`),
    ).toThrow(/incomplete recipe-cost explanation|cannot carry a posting time/);
    expect(stateOf()).toEqual({ status: "draft", posted_at: null });
  });

  it("E refuses the COHERENT transition when the evidence is incomplete", () => {
    // Both markers together is the legal shape, so here it must be the
    // EVIDENCE rule that speaks.
    incompleteDraft();
    expect(() =>
      db.exec(
        `UPDATE sales SET status='posted', posted_at='2026-11-01T10:00:00.000Z'
          WHERE id='${SALE}'`,
      ),
    ).toThrow(/incomplete recipe-cost explanation/);
    expect(stateOf()).toEqual({ status: "draft", posted_at: null });
  });

  it("F accepts it once the explanation is complete", () => {
    incompleteDraft();
    pattyEvidence();
    expect(() =>
      db.exec(
        `UPDATE sales SET status='posted', posted_at='2026-11-01T10:00:00.000Z'
          WHERE id='${SALE}'`,
      ),
    ).not.toThrow();
    expect(stateOf()).toEqual({
      status: "posted",
      posted_at: "2026-11-01T10:00:00.000Z",
    });
  });

  it("closes the bypass for a NON-recipe sale too", () => {
    // The state invariant is not about recipes: an ordinary purchase-valued
    // sale must not become financially visible with its markers disagreeing
    // either, because the reports would count it and 001's immutability
    // trigger would not protect it.
    insertSaleAs("ns-1", 7010, "draft", null);
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, store_id, product_id, product_name_snapshot,
          vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
          unit_price_excl_vat_cents, unit_price_incl_vat_cents,
          line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
          unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
          unit_cogs_excl_vat_microcents, quantity_in_uom, uom_code_snapshot,
          factor_num_snapshot, factor_den_snapshot, cogs_source)
       VALUES ('nsl-1', 'ns-1', ?, ?, 'Burger bun', ?, 1100, 1, 1000, 1110,
          1000, 110, 1110, 0, 0, 220000, 1, 'each', 1, 1, 'purchase_average')`,
    ).run(STORE_ID, BUN, VAT_STD_ID);

    expect(() => db.exec("UPDATE sales SET status='posted' WHERE id='ns-1'")).toThrow(
      /must record when it posted/,
    );
    expect(() =>
      db.exec("UPDATE sales SET posted_at='2026-11-01T10:00:00.000Z' WHERE id='ns-1'"),
    ).toThrow(/cannot carry a posting time/);
    expect(stateOf("ns-1")).toEqual({ status: "draft", posted_at: null });
    expect(() =>
      db.exec(
        `UPDATE sales SET status='posted', posted_at='2026-11-01T10:00:00.000Z'
          WHERE id='ns-1'`,
      ),
    ).not.toThrow();
  });
});

describe("a posted sale does not go backwards", () => {
  beforeEach(() => {
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    postSale();
  });

  it("G refuses clearing posted_at, H refuses reverting the status", () => {
    for (const [what, sql] of [
      ["G clearing posted_at", `UPDATE sales SET posted_at=NULL WHERE id='${SALE}'`],
      ["H reverting to draft", `UPDATE sales SET status='draft' WHERE id='${SALE}'`],
      [
        "  both at once",
        `UPDATE sales SET status='draft', posted_at=NULL WHERE id='${SALE}'`,
      ],
      [
        "  rewriting the posting time",
        `UPDATE sales SET posted_at='2020-01-01T00:00:00.000Z' WHERE id='${SALE}'`,
      ],
    ]) {
      // Any of these sentences is a correct refusal; which one speaks is
      // statement order inside one trigger, not the invariant.
      expect(() => db.exec(sql), what).toThrow(
        /immutable|must record when it posted|posting time cleared|returned to a draft|carry a posting time|written once/,
      );
    }
    expect(stateOf()).toEqual({
      status: "posted",
      posted_at: "2026-10-26T12:00:00.000Z",
    });
  });

  it("L keeps 001's void carve-out working, without re-firing finalization", () => {
    // `posted -> voided` with the id, receipt number, total and posted_at
    // unchanged. A rule written as "status may never leave posted" would have
    // broken the one transition 001 deliberately allows.
    expect(() =>
      db.exec(
        `UPDATE sales SET status='voided', voided_at='2026-11-02T10:00:00.000Z'
          WHERE id='${SALE}'`,
      ),
    ).not.toThrow();
    expect(stateOf()).toEqual({
      status: "voided",
      posted_at: "2026-10-26T12:00:00.000Z",
    });
    // The evidence is untouched: neither marker moved INTO the posted state,
    // so the finalization trigger did not fire.
    expect(
      (db
        .prepare(`SELECT COUNT(*) AS n FROM sale_item_recipe_costs WHERE sale_id='${SALE}'`)
        .get() as { n: number }).n,
    ).toBe(1);
    // ...and the voided sale leaves every read model that filters 'posted'.
    expect(
      (db
        .prepare(`SELECT COUNT(*) AS n FROM sales WHERE id='${SALE}' AND status='posted'`)
        .get() as { n: number }).n,
    ).toBe(0);
  });

  it("I leaves a posted sale readable and sealed after its recipe retires", () => {
    db.exec(
      `UPDATE recipes SET status='retired', retired_at='2026-10-27T09:00:00.000Z'
        WHERE id='${RECIPE}'`,
    );
    const row = db
      .prepare(
        `SELECT s.status AS st, s.posted_at AS pa, si.unit_cogs_excl_vat_microcents AS mc,
                si.cogs_source AS src
           FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE s.id='${SALE}'`,
      )
      .get() as { st: string; pa: string; mc: number; src: string };
    expect(row).toMatchObject({ st: "posted", src: "recipe", mc: 220_000 });
    expect(row.pa).toBe("2026-10-26T12:00:00.000Z");
    expect(() =>
      db.exec(`UPDATE sales SET total_incl_vat_cents=1 WHERE id='${SALE}'`),
    ).toThrow(/immutable/);
    expect(() => db.exec(`DELETE FROM sales WHERE id='${SALE}'`)).toThrow(/cannot be deleted/);
  });
});

describe("the reporting consumers", () => {
  it("cannot be shown a malformed sale, because none can exist", () => {
    // STEP 5's reporting check, stated as the invariant the 37 read models
    // depend on. They all filter `status = 'posted'`; what makes that safe is
    // that `status = 'posted'` now implies `posted_at IS NOT NULL`, so the
    // marker they read and the marker the guards read cannot disagree.
    publishedRecipe();
    draftSaleWithRecipeLine();
    evidenceRow();
    postSale();
    insertSaleAs("draft-only", 7020, "draft", null);

    expect(
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM sales
            WHERE (status = 'posted' AND posted_at IS NULL)
               OR (status = 'draft'  AND posted_at IS NOT NULL)`,
        )
        .get() as { n: number }).n,
    ).toBe(0);
    // What a report sees: the posted sale, and only it.
    expect(
      db
        .prepare("SELECT id FROM sales WHERE status='posted' ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual([SALE]);
  });
});
