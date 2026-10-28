/**
 * Migration 021's schema and the recipe read models (WP-B2-A).
 *
 * Scope note, as elsewhere in this directory: this runs the real migration
 * chain and repository SQL against node:sqlite with the Tauri SQL plugin
 * mocked out. It is not an end-to-end Tauri test —
 * `src-tauri/src/tests/recipes.rs` is the authority on what the three commands
 * DO. What is proved HERE is the half that lives in SQL and TypeScript: the
 * constraints and triggers the migration produces, which bind any writer at
 * all, and the read models a screen shows an owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  resetIds,
  seedProduct,
  STORE_ID,
  VAT_STD_ID,
} from "../helpers/sqlDb";
import {
  recipesRepo,
  sameConversion,
  UnsafeConversionError,
} from "../../src/db/repos/recipes";

const BURGER = "prod-burger";
const BUN = "prod-bun";
const PATTY = "prod-patty";
const UNPRICED = "prod-unpriced";

let db: DatabaseSync;

/** A product_uoms row. `seedProduct` does not create one. */
function uom(
  productId: string,
  uomCode: string,
  factorNum: number,
  factorDen: number,
  isBase = false,
): string {
  const id = `uom-${productId}-${uomCode}`;
  db.prepare(
    `INSERT INTO product_uoms
       (id, store_id, product_id, uom_code, factor_num, factor_den,
        is_base, is_default_sale_uom, is_default_purchase_uom, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
  ).run(id, STORE_ID, productId, uomCode, factorNum, factorDen, isBase ? 1 : 0, isBase ? 1 : 0);
  return id;
}

function setAvgCost(productId: string, microcents: number): void {
  db.prepare(
    `UPDATE products
        SET avg_cost_excl_vat_microcents = ?, avg_cost_incl_vat_microcents = ?
      WHERE id = ?`,
  ).run(microcents, microcents, productId);
}

/** A documented cost basis: a `purchase` movement, possibly at zero. */
function purchaseMovement(productId: string, microcents: number): void {
  db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, movement_type, quantity_delta,
        unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
        unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents, posted_at)
     VALUES (?, ?, ?, 'purchase', 10, 0, 0, ?, ?, '2026-10-20T08:00:00.000Z')`,
  ).run(`mv-${productId}-${microcents}`, STORE_ID, productId, microcents, microcents);
}

/**
 * A recipe row, always inserted as a DRAFT.
 *
 * Promoted afterwards by `publish` / `retireRow`, because migration 021's
 * insert guard keys on the parent's status: a recipe written as `active` in its
 * first statement can take no components at all. Every posting command in this
 * codebase builds a draft and promotes it last for the same reason, and a
 * fixture that cheated past it would not be testing the real shape.
 */
function recipe(id: string, productId: string, version: number, yieldBase = 1): string {
  db.prepare(
    `INSERT INTO recipes
       (id, store_id, product_id, version, yield_quantity_base, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`,
  ).run(id, STORE_ID, productId, version, yieldBase);
  return id;
}

function publish(id: string): string {
  db.prepare(
    `UPDATE recipes SET status='active', activated_at='2026-10-26T09:00:00.000Z' WHERE id=?`,
  ).run(id);
  return id;
}

function retireRow(id: string): string {
  publish(id);
  db.prepare(
    `UPDATE recipes SET status='retired', retired_at='2026-10-26T10:00:00.000Z' WHERE id=?`,
  ).run(id);
  return id;
}

function componentRow(
  recipeId: string,
  componentProductId: string,
  num: number,
  den: number,
  uomCode: string,
  factorNum: number,
  factorDen: number,
  wasteBps = 0,
): void {
  db.prepare(
    `INSERT INTO recipe_components
       (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
        uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot,
        waste_bps, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    `rc-${recipeId}-${componentProductId}`,
    recipeId,
    STORE_ID,
    componentProductId,
    num,
    den,
    uomCode,
    `uom-${componentProductId}-${uomCode}`,
    factorNum,
    factorDen,
    wasteBps,
  );
}

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedProduct(db, { id: BURGER, sku: "SKU-BRG", name: "Greaz Burger", isService: true });
  uom(BURGER, "each", 1, 1, true);
  seedProduct(db, { id: BUN, sku: "SKU-BUN", name: "Burger bun" });
  uom(BUN, "each", 1, 1, true);
  setAvgCost(BUN, 220_000);
  purchaseMovement(BUN, 220_000);
  seedProduct(db, { id: PATTY, sku: "SKU-PTY", name: "Beef patty mince" });
  uom(PATTY, "g", 1, 1, true);
  uom(PATTY, "kg", 1_000, 1);
  setAvgCost(PATTY, 8_500);
  purchaseMovement(PATTY, 8_500);
  seedProduct(db, { id: UNPRICED, sku: "SKU-UNP", name: "Mystery pickle" });
  uom(UNPRICED, "each", 1, 1, true);
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

// ===========================================================================
// 1. The schema migration 021 produces
// ===========================================================================

describe("migration 021 schema", () => {
  it("creates both tables, empty — a migration is not a fixture", () => {
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM recipes").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM recipe_components").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it("gives a product one active and one draft version at most", () => {
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ux_recipes%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("ux_recipes_product_version");
    expect(names).toContain("ux_recipes_one_active");
    expect(names).toContain("ux_recipes_one_draft");
  });

  it("bounds every numeric part, which is half of the overflow proof", () => {
    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get("recipe_components") as { sql: string }
    ).sql;
    expect(sql).toContain("quantity_num <= 1000000");
    expect(sql).toContain("quantity_den <= 1000000");
    expect(sql).toContain("factor_num_snapshot <= 1000000");
    expect(sql).toContain("waste_bps < 10000");

    const header = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get("recipes") as { sql: string }
    ).sql;
    expect(header).toContain("yield_quantity_base <= 1000000");
  });

  it("stores the conversion as a NOT NULL snapshot with a restricting key", () => {
    const cols = db
      .prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('recipe_components')`)
      .all() as { name: string; nn: number }[];
    for (const needed of [
      "product_uom_id_snapshot",
      "factor_num_snapshot",
      "factor_den_snapshot",
    ]) {
      expect(cols.find((c) => c.name === needed)?.nn).toBe(1);
    }
    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get("recipe_components") as { sql: string }
    ).sql;
    expect(sql).toContain("REFERENCES product_uoms(id) ON DELETE RESTRICT");
  });
});

// ===========================================================================
// 2. The lifecycle, as table CHECKs
// ===========================================================================

describe("recipe lifecycle constraints", () => {
  it("a draft carries neither timestamp", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base,
             status, activated_at) VALUES ('bad', ?, ?, 1, 1, 'draft', '2026-01-01')`,
        )
        .run(STORE_ID, BURGER),
    ).toThrow();
  });

  it("an active version carries its activation and no retirement", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base,
             status) VALUES ('bad', ?, ?, 1, 1, 'active')`,
        )
        .run(STORE_ID, BURGER),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base,
             status, activated_at, retired_at)
           VALUES ('bad', ?, ?, 1, 1, 'active', '2026-01-01', '2026-02-01')`,
        )
        .run(STORE_ID, BURGER),
    ).toThrow();
  });

  it("a RETIRED version keeps its activation history", () => {
    // Retiring records when a version stopped being authoritative WITHOUT
    // erasing when it started, and a version that never published cannot be
    // retired at all.
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base,
             status, retired_at) VALUES ('bad', ?, ?, 1, 1, 'retired', '2026-02-01')`,
        )
        .run(STORE_ID, BURGER),
    ).toThrow();

    retireRow(recipe("r-ok", BURGER, 1));
    const row = db
      .prepare(`SELECT activated_at AS a, retired_at AS r FROM recipes WHERE id='r-ok'`)
      .get() as { a: string | null; r: string | null };
    expect(row.a).not.toBeNull();
    expect(row.r).not.toBeNull();
  });

  it("allows only one active and only one draft per product", () => {
    publish(recipe("r1", BURGER, 1));
    // A second ACTIVE version is refused by the partial index.
    expect(() => publish(recipe("r2", BURGER, 2))).toThrow();
    // r2 is still a draft, and a second DRAFT is refused as well, so "edit the
    // recipe" cannot accumulate rival drafts for the editor to choose between.
    expect(() => recipe("r3", BURGER, 3)).toThrow();

    // RETIRED versions accumulate freely: history is not capped.
    db.exec(`DELETE FROM recipes WHERE id='r2'`);
    db.exec(
      `UPDATE recipes SET status='retired', retired_at='2026-10-26T11:00:00.000Z' WHERE id='r1'`,
    );
    retireRow(recipe("r4", BURGER, 4));
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM recipes WHERE status='retired'`)
          .get() as { n: number }
      ).n,
    ).toBe(2);
  });

  it("refuses every illegal transition", () => {
    recipe("rd", BURGER, 1);
    expect(() =>
      db.exec(`UPDATE recipes SET status='retired', retired_at='2026-01-01' WHERE id='rd'`),
    ).toThrow(/never activated/);

    publish(recipe("ra", PATTY, 1));
    expect(() => db.exec(`UPDATE recipes SET status='draft' WHERE id='ra'`)).toThrow(
      /cannot return to draft/,
    );
    expect(() =>
      db.exec(`UPDATE recipes SET activated_at='2020-01-01' WHERE id='ra'`),
    ).toThrow(/written once/);
    expect(() => db.exec(`UPDATE recipes SET yield_quantity_base=9 WHERE id='ra'`)).toThrow(
      /part of what was published/,
    );

    retireRow(recipe("rr", BUN, 1));
    expect(() => db.exec(`UPDATE recipes SET status='active' WHERE id='rr'`)).toThrow(
      /cannot be activated again/,
    );
  });

  it("never deletes a published version, and allows deleting a draft", () => {
    publish(recipe("rp", BURGER, 1));
    expect(() => db.exec(`DELETE FROM recipes WHERE id='rp'`)).toThrow(/never deleted/);
    recipe("rdr", PATTY, 1);
    db.exec(`DELETE FROM recipes WHERE id='rdr'`);
  });
});

// ===========================================================================
// 3. A published recipe's lines are frozen
// ===========================================================================

describe("published recipe immutability", () => {
  beforeEach(() => {
    recipe("pub", BURGER, 1);
    componentRow("pub", BUN, 1, 1, "each", 1, 1);
    publish("pub");
  });

  it("takes no new ingredient, and no edit or removal of an existing one", () => {
    expect(() => componentRow("pub", PATTY, 150, 1, "g", 1, 1)).toThrow(
      /takes no new ingredient/,
    );
    expect(() =>
      db.exec(`UPDATE recipe_components SET quantity_num=99 WHERE recipe_id='pub'`),
    ).toThrow(/frozen/);
    expect(() => db.exec(`DELETE FROM recipe_components WHERE recipe_id='pub'`)).toThrow(
      /cannot be removed/,
    );
  });

  it("refuses reparenting in BOTH directions", () => {
    // `recipe_id` is an ordinary updatable column; a one-sided check on the
    // OLD parent would let a line be moved out of a draft and into something
    // published. Migration 012's lesson.
    recipe("dr", PATTY, 1);
    componentRow("dr", UNPRICED, 1, 1, "each", 1, 1);
    expect(() =>
      db.exec(`UPDATE recipe_components SET recipe_id='pub' WHERE recipe_id='dr'`),
    ).toThrow(/stays with the recipe|frozen/);
    expect(() =>
      db.exec(`UPDATE recipe_components SET recipe_id='dr' WHERE recipe_id='pub'`),
    ).toThrow(/stays with the recipe|frozen/);
  });
});

// ===========================================================================
// 4. Coherence: store, eligibility, unit
// ===========================================================================

describe("recipe component coherence", () => {
  it("refuses a conversion the ingredient's unit does not have", () => {
    // The database decides the conversion (GP-A02), in SQL as well as in the
    // command, so a row written by any other path is refused too.
    recipe("r", BURGER, 1);
    expect(() => componentRow("r", BUN, 1, 1, "each", 77, 1)).toThrow(
      /must be that unit/,
    );
  });

  it("refuses a unit the ingredient does not have at all", () => {
    recipe("r", BURGER, 1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipe_components
             (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
              uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot)
           VALUES ('x', 'r', ?, ?, 1, 1, 'kg', 'uom-prod-bun-each', 1, 1)`,
        )
        .run(STORE_ID, BUN),
    ).toThrow();
  });

  it("refuses self-reference and an inactive ingredient", () => {
    recipe("r", BURGER, 1);
    expect(() => componentRow("r", BURGER, 1, 1, "each", 1, 1)).toThrow(
      /cannot contain the product it makes/,
    );
    db.exec(`UPDATE products SET is_active = 0 WHERE id = '${BUN}'`);
    expect(() => componentRow("r", BUN, 1, 1, "each", 1, 1)).toThrow(/inactive product/);
  });

  it("enforces one level of composition in both directions", () => {
    // A cycle is INEXPRESSIBLE rather than detectable.
    recipe("sub", PATTY, 1);
    recipe("top", BURGER, 1);
    expect(() => componentRow("top", PATTY, 150, 1, "g", 1, 1)).toThrow(
      /one level of composition/,
    );

    componentRow("top", BUN, 1, 1, "each", 1, 1);
    expect(() => recipe("bunrecipe", BUN, 1)).toThrow(
      /ingredient of another recipe/,
    );
  });

  it("refuses the same ingredient twice in one recipe", () => {
    recipe("r", BURGER, 1);
    componentRow("r", BUN, 1, 1, "each", 1, 1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipe_components
             (id, recipe_id, store_id, component_product_id, quantity_num, quantity_den,
              uom_code, product_uom_id_snapshot, factor_num_snapshot, factor_den_snapshot)
           VALUES ('dup', 'r', ?, ?, 2, 1, 'each', 'uom-prod-bun-each', 1, 1)`,
        )
        .run(STORE_ID, BUN),
    ).toThrow();
  });
});

// ===========================================================================
// 5. Read models
// ===========================================================================

describe("recipesRepo read models", () => {
  it("lists versions newest first with their components and resolved rates", async () => {
    recipe("v1", BURGER, 1);
    componentRow("v1", BUN, 1, 1, "each", 1, 1);
    retireRow("v1");
    recipe("v2", BURGER, 2);
    componentRow("v2", BUN, 1, 1, "each", 1, 1);
    componentRow("v2", PATTY, 3, 20, "kg", 1_000, 1, 500);
    publish("v2");

    const rows = await recipesRepo.listForProduct({ storeId: STORE_ID, productId: BURGER });
    expect(rows.map((r) => r.version)).toEqual([2, 1]);

    const active = rows[0]!;
    expect(active.status).toBe("active");
    expect(active.activatedAt).not.toBeNull();
    expect(active.retiredAt).toBeNull();
    expect(active.components).toHaveLength(2);

    const patty = active.components.find((c) => c.componentProductId === PATTY)!;
    expect(patty.quantity).toEqual({ num: 3, den: 20 });
    expect(patty.uomCode).toBe("kg");
    expect(patty.factorNum).toBe(1_000);
    expect(patty.wasteBps).toBe(500);
    expect(patty.unitCostExclVatMicrocents).toBe(8_500);
    expect(patty.costSource).toBe("purchase_average");
    expect(patty.conversionDrifted).toBe(false);

    const retired = rows[1]!;
    expect(retired.retiredAt).not.toBeNull();
    expect(retired.activatedAt).not.toBeNull();
  });

  it("reports an UNDOCUMENTED zero as no cost, and a documented one as zero", async () => {
    // MISSING EVIDENCE IS NOT A LEGITIMATE ZERO. The same predicate WP-B1's
    // P1-A correction established, reused here rather than re-decided.
    const free = "prod-free";
    seedProduct(db, { id: free, sku: "SKU-FREE", name: "Promo napkin" });
    uom(free, "each", 1, 1, true);
    purchaseMovement(free, 0);

    recipe("r", BURGER, 1);
    componentRow("r", UNPRICED, 1, 1, "each", 1, 1);
    componentRow("r", free, 1, 1, "each", 1, 1);

    const [row] = await recipesRepo.listForProduct({
      storeId: STORE_ID,
      productId: BURGER,
    });
    const missing = row!.components.find((c) => c.componentProductId === UNPRICED)!;
    const documented = row!.components.find((c) => c.componentProductId === free)!;
    expect(missing.unitCostExclVatMicrocents).toBeNull();
    expect(documented.unitCostExclVatMicrocents).toBe(0);
  });

  it("honours a manual-costed non-stock ingredient", async () => {
    const spice = "prod-spice";
    seedProduct(db, { id: spice, sku: "SKU-SPC", name: "House spice", isService: true });
    uom(spice, "each", 1, 1, true);
    db.exec(
      `UPDATE products SET costing_method='standard',
         standard_cost_excl_vat_microcents = 45000 WHERE id='${spice}'`,
    );
    recipe("r", BURGER, 1);
    componentRow("r", spice, 2, 1, "each", 1, 1);

    const [row] = await recipesRepo.listForProduct({
      storeId: STORE_ID,
      productId: BURGER,
    });
    const c = row!.components[0]!;
    expect(c.unitCostExclVatMicrocents).toBe(45_000);
    expect(c.costSource).toBe("standard");
  });

  it("SEES conversion drift without being changed by it", async () => {
    // The published recipe's physical quantities are its own snapshot, so an
    // edited factor restates nothing. What remains is that the recipe and the
    // catalogue can disagree, and a disagreement the owner can see is a
    // decision they can make.
    recipe("r", BURGER, 1);
    componentRow("r", PATTY, 3, 20, "kg", 1_000, 1);
    publish("r");
    db.exec(
      `UPDATE product_uoms SET factor_num = 1200 WHERE product_id='${PATTY}' AND uom_code='kg'`,
    );

    const [row] = await recipesRepo.listForProduct({
      storeId: STORE_ID,
      productId: BURGER,
    });
    const c = row!.components[0]!;
    expect(c.factorNum).toBe(1_000);
    expect(c.catalogFactorNum).toBe(1_200);
    expect(c.conversionDrifted).toBe(true);
  });

  it("summarises the whole catalogue in one query", async () => {
    retireRow(recipe("a", BURGER, 1));
    publish(recipe("b", BURGER, 2));
    recipe("c", PATTY, 1);

    const map = await recipesRepo.summaries(STORE_ID);
    expect(map.get(BURGER)).toMatchObject({
      hasDraft: false,
      hasActive: true,
      activeVersion: 2,
      retiredCount: 1,
    });
    expect(map.get(PATTY)).toMatchObject({ hasDraft: true, hasActive: false });
    expect(map.has(BUN)).toBe(false);
  });

  it("offers only ELIGIBLE ingredients, with their units and rates", async () => {
    const picks = await recipesRepo.eligibleIngredients({
      storeId: STORE_ID,
      excludeProductId: BURGER,
    });
    const ids = picks.map((p) => p.productId);
    expect(ids).toContain(BUN);
    expect(ids).toContain(PATTY);
    expect(ids).not.toContain(BURGER);

    const patty = picks.find((p) => p.productId === PATTY)!;
    expect(patty.uoms.map((u) => u.uomCode).sort()).toEqual(["g", "kg"]);
    expect(patty.uoms.find((u) => u.uomCode === "kg")?.factorNum).toBe(1_000);
    expect(patty.unitCostExclVatMicrocents).toBe(8_500);

    const unpriced = picks.find((p) => p.productId === UNPRICED)!;
    expect(unpriced.unitCostExclVatMicrocents).toBeNull();
  });

  it("excludes a product that owns a recipe, and an inactive one", async () => {
    // The one-level rule applied to the PICKER, so the owner is not offered
    // something the engine would then refuse. The engine refuses it anyway — a
    // picker is a convenience, never a guard.
    recipe("r", PATTY, 1);
    db.exec(`UPDATE products SET is_active = 0 WHERE id = '${UNPRICED}'`);

    const picks = await recipesRepo.eligibleIngredients({
      storeId: STORE_ID,
      excludeProductId: BURGER,
    });
    const ids = picks.map((p) => p.productId);
    expect(ids).not.toContain(PATTY);
    expect(ids).not.toContain(UNPRICED);
    expect(ids).toContain(BUN);
  });
});

// ===========================================================================
// 6. The WP-B2-A boundary
// ===========================================================================

describe("the WP-B2-A boundary", () => {
  it("still refuses costing_method = 'recipe'", () => {
    // Migration 020's refusal STANDS. Creating the recipe tables must not, by
    // itself, make recipe costing selectable; WP-B2-B replaces that trigger
    // pair in the same migration that teaches post_sale.
    recipe("r", BURGER, 1);
    componentRow("r", BUN, 1, 1, "each", 1, 1);
    publish("r");
    expect(() =>
      db.exec(`UPDATE products SET costing_method='recipe' WHERE id='${BURGER}'`),
    ).toThrow(/not implemented/);
  });

  it("writes no inventory movement and moves no stock", () => {
    // Asserted, not assumed. Ingredient consumption is WP-B3.
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM inventory_movements").get() as { n: number }
    ).n;
    const qty = (
      db.prepare(`SELECT quantity_on_hand AS q FROM products WHERE id='${BUN}'`).get() as {
        q: number;
      }
    ).q;

    recipe("r", BURGER, 1);
    componentRow("r", BUN, 1, 1, "each", 1, 1);
    publish("r");

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM inventory_movements").get() as { n: number })
        .n,
    ).toBe(before);
    expect(
      (
        db.prepare(`SELECT quantity_on_hand AS q FROM products WHERE id='${BUN}'`).get() as {
          q: number;
        }
      ).q,
    ).toBe(qty);
  });

  it("adds no column to sale_items or products", () => {
    for (const [table, column] of [
      ["sale_items", "cogs_recipe_id"],
      ["sale_items", "cogs_recipe_version"],
      ["products", "recipe_id"],
    ] as const) {
      const found = db
        .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`)
        .get(column) as { n: number };
      expect(found.n).toBe(0);
    }
  });
});

// ===========================================================================
// 7. DIRECT-SQL ATTACKS (GZ-B2A-P1-A and GZ-B2A-P1-B)
//
// Every test here writes SQL and uses no command, because that is the whole
// finding: the first version of migration 021 put its coherence rules on
// INSERT only and its header-identity rules behind `status <> 'draft'`, and
// both describe what the SAVE COMMAND does rather than what the DATABASE
// allows. The shape a table accepts is the shape it holds.
// ===========================================================================

describe("direct SQL cannot make a DRAFT component incoherent (P1-A)", () => {
  beforeEach(() => {
    recipe("d", BURGER, 1);
    componentRow("d", BUN, 1, 1, "each", 1, 1);
  });

  it("refuses an inflated conversion snapshot — the reported scenario", () => {
    expect(() =>
      db.exec(
        `UPDATE recipe_components SET factor_num_snapshot = 1000000 WHERE recipe_id='d'`,
      ),
    ).toThrow(/must be that unit/);
    expect(
      (
        db
          .prepare(`SELECT factor_num_snapshot AS f FROM recipe_components WHERE recipe_id='d'`)
          .get() as { f: number }
      ).f,
    ).toBe(1);
  });

  it("refuses a snapshot re-pointed at another product's unit row", () => {
    expect(() =>
      db.exec(
        `UPDATE recipe_components
            SET product_uom_id_snapshot = 'uom-${PATTY}-g'
          WHERE recipe_id='d'`,
      ),
    ).toThrow(/must be that unit/);
  });

  it("refuses a unit code the snapshot row does not carry", () => {
    expect(() =>
      db.exec(`UPDATE recipe_components SET uom_code = 'kg' WHERE recipe_id='d'`),
    ).toThrow(/must be that unit/);
  });

  it("refuses self-reference, an ineligible ingredient and a foreign store", () => {
    expect(() =>
      db.exec(
        `UPDATE recipe_components SET component_product_id = '${BURGER}' WHERE recipe_id='d'`,
      ),
    ).toThrow(/cannot contain the product it makes/);

    db.exec(`UPDATE products SET is_active = 0 WHERE id = '${PATTY}'`);
    expect(() =>
      db.exec(
        `UPDATE recipe_components
            SET component_product_id = '${PATTY}', uom_code = 'g',
                product_uom_id_snapshot = 'uom-${PATTY}-g'
          WHERE recipe_id='d'`,
      ),
    ).toThrow(/inactive product/);
    db.exec(`UPDATE products SET is_active = 1 WHERE id = '${PATTY}'`);

    db.exec(
      `INSERT INTO stores (id, name, default_currency) VALUES ('store-x', 'X', 'USD')`,
    );
    expect(() =>
      db.exec(`UPDATE recipe_components SET store_id = 'store-x' WHERE recipe_id='d'`),
    ).toThrow();
  });

  it("refuses an ingredient that owns a recipe of its own", () => {
    recipe("sub", PATTY, 1);
    expect(() =>
      db.exec(
        `UPDATE recipe_components
            SET component_product_id = '${PATTY}', uom_code = 'g',
                product_uom_id_snapshot = 'uom-${PATTY}-g'
          WHERE recipe_id='d'`,
      ),
    ).toThrow(/one level of composition/);
  });

  it("holds the numeric bounds on UPDATE, as the table's own CHECKs", () => {
    for (const sql of [
      `UPDATE recipe_components SET quantity_num = 0 WHERE recipe_id='d'`,
      `UPDATE recipe_components SET quantity_den = 0 WHERE recipe_id='d'`,
      `UPDATE recipe_components SET quantity_num = 1000001 WHERE recipe_id='d'`,
      `UPDATE recipe_components SET waste_bps = 10000 WHERE recipe_id='d'`,
      `UPDATE recipe_components SET waste_bps = -1 WHERE recipe_id='d'`,
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/CHECK constraint failed/);
    }
  });

  it("refuses moving a line to another recipe at all", () => {
    recipe("d2", PATTY, 1);
    expect(() =>
      db.exec(`UPDATE recipe_components SET recipe_id='d2' WHERE recipe_id='d'`),
    ).toThrow(/stays with the recipe/);
  });

  it("STILL allows a legitimate draft edit", () => {
    // The guards must not cost the owner the ability to edit a draft.
    db.exec(
      `UPDATE recipe_components SET quantity_num = 3, quantity_den = 2, waste_bps = 250
        WHERE recipe_id='d'`,
    );
    db.exec(
      `UPDATE recipe_components
          SET component_product_id = '${PATTY}', uom_code = 'kg',
              product_uom_id_snapshot = 'uom-${PATTY}-kg',
              factor_num_snapshot = 1000, factor_den_snapshot = 1
        WHERE recipe_id='d'`,
    );
    db.exec(`UPDATE recipes SET yield_quantity_base = 4, notes = 'edited' WHERE id='d'`);
    const row = db
      .prepare(
        `SELECT quantity_num AS n, quantity_den AS d, waste_bps AS w, uom_code AS u
           FROM recipe_components WHERE recipe_id='d'`,
      )
      .get() as { n: number; d: number; w: number; u: string };
    expect(row).toEqual({ n: 3, d: 2, w: 250, u: "kg" });
  });
});

describe("direct SQL cannot re-point a DRAFT header (P1-B)", () => {
  beforeEach(() => {
    recipe("d", BURGER, 1);
    componentRow("d", BUN, 1, 1, "each", 1, 1);
    db.exec(
      `INSERT INTO stores (id, name, default_currency) VALUES ('store-b', 'Branch B', 'USD')`,
    );
    db.prepare(
      `INSERT INTO products
         (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
          price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand, is_service)
       VALUES ('b-side', 'store-b', 'SKU-B-SIDE', 'Branch B side', ?, 'inclusive',
               100, 111, 0, 1)`,
    ).run(VAT_STD_ID);
  });

  it("freezes id, store_id, product_id and version from CREATION", () => {
    for (const sql of [
      `UPDATE recipes SET product_id = '${PATTY}' WHERE id='d'`,
      `UPDATE recipes SET version = 9 WHERE id='d'`,
      `UPDATE recipes SET id = 'stolen' WHERE id='d'`,
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/fixed when it is created/);
    }
    // Across stores two rules fire at once and SQLite does not define which
    // BEFORE UPDATE trigger goes first; either refusal is the right outcome.
    for (const sql of [
      `UPDATE recipes SET store_id = 'store-b' WHERE id='d'`,
      `UPDATE recipes SET product_id = 'b-side' WHERE id='d'`,
    ]) {
      expect(() => db.exec(sql), sql).toThrow(
        /fixed when it is created|same store as the item/,
      );
    }
    const row = db
      .prepare(`SELECT store_id AS s, product_id AS p FROM recipes WHERE id='d'`)
      .get() as { s: string; p: string };
    expect(row).toEqual({ s: STORE_ID, p: BURGER });
  });

  it("refuses a header whose store is not its product's store, on INSERT", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipes (id, store_id, product_id, version, yield_quantity_base, status)
           VALUES ('mismatch', 'store-b', ?, 1, 1, 'draft')`,
        )
        .run(BURGER),
    ).toThrow(/same store as the item it makes/);
  });

  it("protects notes and created_at after publication (P2-A)", () => {
    publish("d");
    for (const sql of [
      `UPDATE recipes SET notes = 'rewritten' WHERE id='d'`,
      `UPDATE recipes SET created_at = '2020-01-01T00:00:00.000Z' WHERE id='d'`,
      `UPDATE recipes SET yield_quantity_base = 9 WHERE id='d'`,
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/part of what was published/);
    }
  });

  it("refuses a retirement that precedes its activation (P2-A)", () => {
    publish("d");
    expect(() =>
      db.exec(
        `UPDATE recipes SET status='retired', retired_at='2020-01-01T00:00:00.000Z'
          WHERE id='d'`,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(
      (db.prepare(`SELECT status AS s FROM recipes WHERE id='d'`).get() as { s: string }).s,
    ).toBe("active");
  });
});

// ===========================================================================
// 8. Conversion-drift reporting (P2-B)
// ===========================================================================

describe("conversion state", () => {
  it("is EXACT past Number.MAX_SAFE_INTEGER, where cross-multiplication was not", () => {
    // `product_uoms` bounds a factor at nothing more than `> 0`, so a factor
    // from an importer or a future screen can produce a cross-product above
    // 9,007,199,254,740,991 — where `number` multiplication silently stops
    // being exact. These pairs are the proof that BigInt removed the ceiling.
    const big = 3_000_000_000; // 3e9; cross-products here are ~9e18
    expect(sameConversion(big, 1, big * 2, 2)).toBe(true);
    expect(sameConversion(big, 3, big * 2, 6)).toBe(true);

    // Two conversions that differ by ONE in the last place, whose cross
    // products are both far above MAX_SAFE_INTEGER and only 3e9 apart. As
    // doubles both products round to the same value and the old comparison
    // called them equal; in BigInt they are not.
    const a = Number.MAX_SAFE_INTEGER; // 9007199254740991
    expect(sameConversion(a, 1, a, 1)).toBe(true);
    expect(sameConversion(a, 1, a - 1, 1)).toBe(false);
    expect(sameConversion(a, 3, a - 1, 3)).toBe(false);

    // THE DEMONSTRATOR. All four parts are safe integers, so nothing is lost
    // on the way in, and yet:
    //
    //   number: 9007199254740991 * 3 === 6755399441055743 * 4   -> TRUE
    //   exact:  27021597764222973  !==  27021597764222972       -> FALSE
    //
    // The two cross-products differ by one and both round to the same double,
    // so `number` arithmetic called two different conversions equal. BigInt
    // does not.
    expect(sameConversion(9_007_199_254_740_991, 4, 6_755_399_441_055_743, 3)).toBe(false);
    expect(
      9_007_199_254_740_991 * 3 === 6_755_399_441_055_743 * 4,
      "if this ever becomes false, Number arithmetic has changed and the fixture is stale",
    ).toBe(true);
  });

  it("REFUSES a factor that reached JavaScript without its precision", () => {
    // BigInt cannot fix an input that was already wrong: `Number` cannot
    // represent 2^53 + 1, so `BigInt(thatNumber)` is a large, exact, WRONG
    // value. A precise-looking answer to a question the data can no longer be
    // asked is worse than a refusal.
    const unsafe = Number.MAX_SAFE_INTEGER + 2; // 9007199254740993 -> ...92
    expect(() => sameConversion(unsafe, 1, 1, 1)).toThrow(UnsafeConversionError);
    expect(() => sameConversion(1, unsafe, 1, 1)).toThrow(UnsafeConversionError);
    expect(() => sameConversion(1, 1, unsafe, 1)).toThrow(UnsafeConversionError);
    expect(() => sameConversion(1, 1, 1.5, 1)).toThrow(UnsafeConversionError);
    expect(() => sameConversion(1, 1, Number.NaN, 1)).toThrow(UnsafeConversionError);
    expect(() => sameConversion(1, 1, Number.POSITIVE_INFINITY, 1)).toThrow(
      UnsafeConversionError,
    );
  });

  it("cannot even be reached through node:sqlite, which refuses the decode", async () => {
    // Where the precision guard sits in the stack, stated honestly rather than
    // asserted as a live path.
    //
    // `node:sqlite` THROWS on reading an integer it cannot represent exactly
    // ("Value is too large to be represented as a JavaScript number"), so
    // through THIS driver an unsafe factor never reaches `sameConversion` at
    // all. The production driver is `tauri-plugin-sql`, which returns rows as
    // JSON and does lose precision silently on a value like this — so the
    // guard is defence in depth for the driver the shop actually runs, and
    // unreachable for the one the tests run. Both facts are worth pinning:
    // this test proves the test driver's refusal, and the unit test above
    // proves the guard itself.
    recipe("r", BURGER, 1);
    componentRow("r", PATTY, 3, 20, "kg", 1_000, 1);
    publish("r");
    db.exec(
      `UPDATE product_uoms SET factor_num = 9007199254740993
        WHERE product_id='${PATTY}' AND uom_code='kg'`,
    );

    await expect(
      recipesRepo.listForProduct({ storeId: STORE_ID, productId: BURGER }),
    ).rejects.toThrow(/too large to be represented/);

    // And the published snapshot is still exactly what was published.
    const stored = db
      .prepare(
        `SELECT factor_num_snapshot AS n, factor_den_snapshot AS d
           FROM recipe_components WHERE recipe_id='r'`,
      )
      .get() as { n: number; d: number };
    expect(stored).toEqual({ n: 1_000, d: 1 });
  });

  it("compares equivalent rationals as EQUAL, in integers", () => {
    // `1000/1` and `2000/2` are one conversion. Comparing them as
    // floating-point quotients would make the warning appear and disappear
    // with the arithmetic rather than with the data.
    expect(sameConversion(1_000, 1, 2_000, 2)).toBe(true);
    expect(sameConversion(1, 3, 100_000, 300_000)).toBe(true);
    expect(sameConversion(1_000, 1, 1_200, 1)).toBe(false);
    expect(sameConversion(1, 1, 1, 2)).toBe(false);
    // The widest pair migration 021 admits, still exact as a Number.
    expect(sameConversion(1_000_000, 1_000_000, 1, 1)).toBe(true);
  });

  it("reports an equivalent-but-differently-written factor as CURRENT", async () => {
    recipe("r", BURGER, 1);
    componentRow("r", PATTY, 3, 20, "kg", 1_000, 1);
    publish("r");
    db.exec(
      `UPDATE product_uoms SET factor_num = 2000, factor_den = 2
        WHERE product_id='${PATTY}' AND uom_code='kg'`,
    );

    const [row] = await recipesRepo.listForProduct({
      storeId: STORE_ID,
      productId: BURGER,
    });
    expect(row!.components[0]!.conversionState).toBe("current");
    expect(row!.components[0]!.conversionDrifted).toBe(false);
  });

  it("reports a genuinely changed factor as DRIFTED", async () => {
    recipe("r", BURGER, 1);
    componentRow("r", PATTY, 3, 20, "kg", 1_000, 1);
    publish("r");
    db.exec(
      `UPDATE product_uoms SET factor_num = 1200 WHERE product_id='${PATTY}' AND uom_code='kg'`,
    );

    const [row] = await recipesRepo.listForProduct({
      storeId: STORE_ID,
      productId: BURGER,
    });
    expect(row!.components[0]!.conversionState).toBe("drifted");
    expect(row!.components[0]!.factorNum).toBe(1_000);
  });

  it("reports a DEACTIVATED or deleted unit as UNAVAILABLE, not healthy", async () => {
    // The P2-B defect. A `LEFT JOIN` miss leaves both catalogue columns NULL,
    // and the old boolean read that as "no disagreement" — i.e. healthy —
    // when it is the worse of the two problems: the recipe cannot be re-saved
    // against a unit that is not there.
    recipe("r", BURGER, 1);
    componentRow("r", PATTY, 3, 20, "kg", 1_000, 1);
    publish("r");
    db.exec(
      `UPDATE product_uoms SET is_active = 0 WHERE product_id='${PATTY}' AND uom_code='kg'`,
    );

    const [row] = await recipesRepo.listForProduct({
      storeId: STORE_ID,
      productId: BURGER,
    });
    const c = row!.components[0]!;
    expect(c.conversionState).toBe("unavailable");
    expect(c.conversionDrifted).toBe(true);
    // And the PUBLISHED snapshot is untouched by any of it.
    expect(c.factorNum).toBe(1_000);
    expect(c.factorDen).toBe(1);
  });
});
