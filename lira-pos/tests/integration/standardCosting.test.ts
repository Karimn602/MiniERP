/**
 * SQL / read-model integration tests for manual standard costing (WP-B1,
 * migration 020).
 *
 * Scope note: this runs the real migration chain and repository SQL against
 * node:sqlite with the Tauri SQL plugin mocked out. It is not an end-to-end
 * Tauri test — `src-tauri/src/tests/standard_cost.rs` is the authority on what
 * `post_sale` and `save_product` do. What is proved HERE is the half that
 * lives in TypeScript: the schema the migration produces, the engine guards
 * that bind any writer, and the read models a screen shows an owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  insertSale,
  resetIds,
  seedExchangeRate,
  seedProduct,
  STORE_ID,
} from "../helpers/sqlDb";
import { reportsRepo } from "../../src/db/repos/reports";
import { productsRepo } from "../../src/db/repos/products";
import { costCoverage } from "../../src/lib/reportMath";

const BURGER = "prod-burger";
const COFFEE = "prod-coffee";

const FROM = "2026-10-01";
const TO = "2026-10-31";

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  // A prepared menu item: a SERVICE, which is what manual cost is for.
  seedProduct(db, { id: BURGER, sku: "SKU-B1", name: "Greaz Burger", isService: true });
  seedProduct(db, { id: COFFEE, sku: "SKU-C1", name: "Coffee 250g" });
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

function setManualCost(productId: string, microcents: number): void {
  db.prepare(
    `UPDATE products
        SET costing_method = 'standard',
            standard_cost_excl_vat_microcents = ?,
            standard_cost_set_at = '2026-10-25T00:00:00.000Z'
      WHERE id = ? AND store_id = ?`,
  ).run(microcents, productId, STORE_ID);
}

/** One burger line: $10.00 net + $1.10 VAT, costed at `cogs` cents. */
function burgerLine(cogs: number, source: "standard" | "uncosted" | null) {
  return {
    productId: BURGER,
    productName: "Greaz Burger",
    quantity: 1,
    subtotalExclVat: 1000,
    vat: 110,
    totalInclVat: 1110,
    cogs,
    cogsSource: source,
  };
}

// ===========================================================================
// 1. The schema migration 020 produces
// ===========================================================================

describe("migration 020 schema", () => {
  it("defaults every product to today's behaviour with no cost configured", () => {
    // Additive means nothing changes meaning on upgrade. The default is the
    // weighted-average / last-purchase resolution `post_sale` already
    // performed, and NULL means nobody has stated a cost — which is NOT zero.
    const rows = db
      .prepare(
        `SELECT costing_method, standard_cost_excl_vat_microcents AS cost,
                standard_cost_set_at AS setAt
           FROM products`,
      )
      .all() as { costing_method: string; cost: number | null; setAt: string | null }[];

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.costing_method).toBe("purchase_average");
      expect(r.cost).toBeNull();
      expect(r.setAt).toBeNull();
    }
  });

  it("states the whole costing domain in the CHECK, including the unimplemented one", () => {
    // `recipe` is listed so that shipping WP-B2 needs no `products` table
    // rebuild — SQLite cannot ALTER a CHECK, and that table is referenced by
    // every posted document family.
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='products'`)
      .get() as { sql: string };
    expect(sql.sql).toContain("'purchase_average'");
    expect(sql.sql).toContain("'standard'");
    expect(sql.sql).toContain("'recipe'");
  });

  it("leaves cogs_source nullable, because no posted line is rewritten", () => {
    const col = db
      .prepare(`SELECT "notnull" AS nn, type FROM pragma_table_info('sale_items') WHERE name='cogs_source'`)
      .get() as { nn: number; type: string };
    expect(col.nn).toBe(0);
    expect(col.type).toBe("TEXT");
  });
});

// ===========================================================================
// 2. The engine guards, against any writer
// ===========================================================================

describe("migration 020 coherence guards", () => {
  it("refuses Manual Cost with no figure", () => {
    expect(() =>
      db
        .prepare(`UPDATE products SET costing_method='standard' WHERE id=?`)
        .run(BURGER),
    ).toThrow(/needs a cost/i);
  });

  it("refuses Manual Cost on a stocked product", () => {
    // A stocked line's COGS rate is also stamped onto the sale's inventory
    // movement, so a typed rate there would make the stock ledger and the
    // P&L disagree with no document between them — permanently, because
    // `inventory_movements` is append-only.
    expect(() =>
      db
        .prepare(
          `UPDATE products
              SET costing_method='standard', standard_cost_excl_vat_microcents=185000000
            WHERE id=?`,
        )
        .run(COFFEE),
    ).toThrow(/non-stock/i);
  });

  it("refuses recipe costing for an item with no published recipe", () => {
    // WP-B2-B (migration 022) replaced 020's blanket refusal with a
    // conditional one. This fixture publishes no recipe, so the condition
    // fails and the method is still refused — now for a reason the operator
    // can act on rather than because the feature does not exist.
    expect(() =>
      db.prepare(`UPDATE products SET costing_method='recipe' WHERE id=?`).run(BURGER),
    ).toThrow(/published recipe/i);
  });

  it("refuses a negative manual cost", () => {
    expect(() =>
      db
        .prepare(
          `UPDATE products
              SET costing_method='standard', standard_cost_excl_vat_microcents=-1
            WHERE id=?`,
        )
        .run(BURGER),
    ).toThrow();
  });

  it("accepts a deliberate zero on a non-stock item", () => {
    expect(() => setManualCost(BURGER, 0)).not.toThrow();
    const row = db
      .prepare(`SELECT standard_cost_excl_vat_microcents AS c FROM products WHERE id=?`)
      .get(BURGER) as { c: number };
    expect(row.c).toBe(0);
  });

  it("lets a stated cost stay on a product switched back to purchase valuation", () => {
    // Clearing a stated cost is the owner's call, not a consequence of
    // switching a switch: discarding it would lose an assertion they may want
    // back. The figure is simply not read any more.
    setManualCost(BURGER, 185_000_000);
    db.prepare(`UPDATE products SET costing_method='purchase_average' WHERE id=?`).run(BURGER);
    const row = db
      .prepare(
        `SELECT costing_method AS m, standard_cost_excl_vat_microcents AS c
           FROM products WHERE id=?`,
      )
      .get(BURGER) as { m: string; c: number };
    expect(row.m).toBe("purchase_average");
    expect(row.c).toBe(185_000_000);
  });

  it("still allows the stock and cost updates every sale and purchase make", () => {
    // The guards fire on every `products` UPDATE, including the ones the
    // posting commands make. A coherent row must stay writable or the till
    // stops.
    setManualCost(BURGER, 185_000_000);
    expect(() =>
      db.prepare(`UPDATE products SET quantity_on_hand = quantity_on_hand - 1 WHERE id=?`).run(COFFEE),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(`UPDATE products SET avg_cost_excl_vat_microcents = 200000000 WHERE id=?`)
        .run(COFFEE),
    ).not.toThrow();
    expect(() =>
      db.prepare(`UPDATE products SET name = 'Greaz Burger Deluxe' WHERE id=?`).run(BURGER),
    ).not.toThrow();
  });
});

// ===========================================================================
// 3. The product read model
// ===========================================================================

describe("productsRepo read model", () => {
  it("surfaces the costing configuration a screen needs", async () => {
    setManualCost(BURGER, 185_000_000);
    const product = await productsRepo.findById(BURGER);
    expect(product).not.toBeNull();
    expect(product?.costingMethod).toBe("standard");
    expect(product?.standardCostExclVatMicrocents).toBe(185_000_000);
    expect(product?.standardCostSetAt).toBe("2026-10-25T00:00:00.000Z");
  });

  it("reads an unconfigured product as purchase valuation with a NULL cost", async () => {
    const product = await productsRepo.findById(COFFEE);
    expect(product?.costingMethod).toBe("purchase_average");
    expect(product?.standardCostExclVatMicrocents).toBeNull();
    expect(product?.standardCostSetAt).toBeNull();
  });
});

// ===========================================================================
// 4. The sale-line read model
// ===========================================================================

describe("salesRepo read model", () => {
  it("carries each line's cost provenance", async () => {
    const { salesRepo } = await import("../../src/db/repos/sales");
    const saleId = insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [burgerLine(185, "standard")],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1110, usdEquivalent: 1110 }],
    });

    const sale = await salesRepo.findByIdWithDetails(saleId);
    expect(sale?.lines[0]?.cogsSource).toBe("standard");
    expect(sale?.lines[0]?.lineCogsExclVatCents).toBe(185);
  });

  it("reads a line posted before migration 020 as having no source", async () => {
    const { salesRepo } = await import("../../src/db/repos/sales");
    const saleId = insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [burgerLine(0, null)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1110, usdEquivalent: 1110 }],
    });

    const sale = await salesRepo.findByIdWithDetails(saleId);
    expect(sale?.lines[0]?.cogsSource).toBeNull();
  });
});

// ===========================================================================
// 5. Cost coverage
// ===========================================================================

describe("reportsRepo.cogsCoverage", () => {
  it("buckets posted lines by how they were costed", async () => {
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [
        burgerLine(185, "standard"),
        {
          productId: COFFEE,
          productName: "Coffee 250g",
          quantity: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1000,
          cogs: 400,
          cogsSource: "purchase_average" as const,
        },
      ],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2110, usdEquivalent: 2110 }],
    });

    const rows = await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO });
    const bySource = new Map(rows.map((r) => [r.source, r]));

    expect(bySource.get("standard")).toMatchObject({
      lineCount: 1,
      totalQty: 1,
      lineSubtotalExclVatCents: 1000,
      lineCogsExclVatCents: 185,
      zeroRateLineCount: 0,
    });
    expect(bySource.get("purchase_average")).toMatchObject({
      lineCount: 1,
      totalQty: 2,
      lineSubtotalExclVatCents: 900,
      lineCogsExclVatCents: 400,
    });
  });

  it("counts a legacy line under a null source rather than dropping it", async () => {
    // Dropping it would silently shrink the denominator a coverage percentage
    // is taken over, which is worse than reporting it as unexplainable.
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [burgerLine(0, null)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1110, usdEquivalent: 1110 }],
    });

    const rows = await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBeNull();
    expect(rows[0]?.zeroRateLineCount).toBe(1);
    // And the bucket reports how much of itself actually bears a cost, which
    // for a zero-COGS legacy line is none of it.
    expect(rows[0]?.costBearingLineCount).toBe(0);
    expect(rows[0]?.costBearingSubtotalExclVatCents).toBe(0);
  });

  it("splits the legacy bucket by whether the posted COGS is actually there", async () => {
    // WP-B1 P1-B. Migration 020 leaves every pre-existing line's provenance
    // NULL, and that is the truth about it — but the COGS figure it was posted
    // with is sitting in the row and is already inside the gross-profit number
    // this panel qualifies. One bucket, two populations, and the bucket says
    // how big each is.
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [
        // Posted with a real cost, before the column existed.
        {
          productId: COFFEE,
          productName: "Coffee 250g",
          quantity: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogs: 200,
          cogsSource: null,
        },
        // And a prepared item nothing could value: zero, and indeterminate.
        burgerLine(0, null),
      ],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1610, usdEquivalent: 1610 }],
    });

    const rows = await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: null,
      lineCount: 2,
      lineSubtotalExclVatCents: 1450,
      lineCogsExclVatCents: 200,
      zeroRateLineCount: 1,
      costBearingLineCount: 1,
      costBearingSubtotalExclVatCents: 450,
    });

    const summary = costCoverage(rows);
    // The cost-bearing legacy line is NOT reported as missing a cost, and NOT
    // given a provenance it does not have.
    expect(summary.costBearingRevenueExclVatCents).toBe(450);
    expect(summary.legacyCostedRevenueExclVatCents).toBe(450);
    expect(summary.verifiedSourceRevenueExclVatCents).toBe(0);
    expect(summary.documentedRevenueExclVatCents).toBe(0);
    expect(summary.estimatedRevenueExclVatCents).toBe(0);
    // The zero one is, because nothing distinguishes "free" from "unstated".
    expect(summary.legacyUncostedRevenueExclVatCents).toBe(1000);
    expect(summary.missingCostRevenueExclVatCents).toBe(1000);
    expect(summary.hasMissingCost).toBe(true);
    expect(summary.hasUnknownSource).toBe(true);
  });

  it("raises NO overstatement warning for a legacy period that was fully costed", async () => {
    // The warning the P1-B defect produced: every NULL-provenance line was
    // reported as uncosted, so a shop whose history was costed throughout was
    // told its gross profit was overstated when the arithmetic was complete.
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [
        {
          productId: COFFEE,
          productName: "Coffee 250g",
          quantity: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1000,
          cogs: 400,
          cogsSource: null,
        },
      ],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 }],
    });

    const summary = costCoverage(
      await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }),
    );
    expect(summary.hasMissingCost).toBe(false);
    expect(summary.missingCostRevenueExclVatCents).toBe(0);
    expect(summary.costBearingRevenueFraction).toBe(1);
    // It is still unverifiable, and that note is shown instead.
    expect(summary.hasUnknownSource).toBe(true);
    expect(summary.verifiedSourceRevenueFraction).toBe(0);
  });

  it("does not rewrite a legacy line to say where its cost came from", async () => {
    // Belt and braces on requirement 3: reporting reads, and reads only.
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [
        {
          productId: COFFEE,
          productName: "Coffee 250g",
          quantity: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogs: 200,
          cogsSource: null,
        },
      ],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });

    costCoverage(await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }));

    const after = db
      .prepare(
        `SELECT cogs_source AS src, unit_cogs_excl_vat_microcents AS rate,
                line_cogs_excl_vat_cents AS amount FROM sale_items`,
      )
      .all() as { src: string | null; rate: number; amount: number }[];
    expect(after).toEqual([{ src: null, rate: 200_000_000, amount: 200 }]);
  });

  it("separates a DELIBERATE zero from an uncosted one", async () => {
    // The pair of rows this whole feature exists to keep apart. Both carry a
    // zero rate; only one of them is an answer.
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [burgerLine(0, "standard"), burgerLine(0, "uncosted")],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2220, usdEquivalent: 2220 }],
    });

    const rows = await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO });
    const bySource = new Map(rows.map((r) => [r.source, r]));
    expect(bySource.get("standard")?.zeroRateLineCount).toBe(1);
    expect(bySource.get("uncosted")?.zeroRateLineCount).toBe(1);

    const summary = costCoverage(rows);
    expect(summary.costBearingRevenueExclVatCents).toBe(1000);
    expect(summary.verifiedSourceRevenueExclVatCents).toBe(1000);
    expect(summary.uncostedRevenueExclVatCents).toBe(1000);
    expect(summary.missingCostRevenueExclVatCents).toBe(1000);
    expect(summary.hasMissingCost).toBe(true);
    // Neither of them is legacy, so there is nothing of unknown source here.
    expect(summary.hasUnknownSource).toBe(false);
  });

  it("counts only POSTED sales, like every other report", async () => {
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      status: "voided",
      lines: [burgerLine(185, "standard")],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1110, usdEquivalent: 1110 }],
    });

    const rows = await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO });
    expect(rows).toHaveLength(0);
  });

  it("respects the period window", async () => {
    insertSale(db, {
      postedAt: "2026-09-30T12:00:00.000Z",
      lines: [burgerLine(185, "standard")],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1110, usdEquivalent: 1110 }],
    });

    expect(
      await reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }),
    ).toHaveLength(0);
  });

  it("reconciles to the period's gross figures, so the panel cannot disagree with the KPIs", async () => {
    // The buckets are the SAME posted lines `productSales` sums, scoped the
    // same way. If they stopped adding up, the coverage panel would be
    // qualifying a gross-profit figure it did not describe.
    insertSale(db, {
      postedAt: "2026-10-10T12:00:00.000Z",
      lines: [
        burgerLine(185, "standard"),
        {
          productId: COFFEE,
          productName: "Coffee 250g",
          quantity: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1000,
          cogs: 400,
          cogsSource: "purchase_average" as const,
        },
      ],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2110, usdEquivalent: 2110 }],
    });

    const [coverage, products] = await Promise.all([
      reportsRepo.cogsCoverage({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }),
      reportsRepo.productSales({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }),
    ]);

    const summary = costCoverage(coverage);
    const productRevenue = products.reduce((s, r) => s + r.lineSubtotalExclVatCents, 0);
    const productCogs = products.reduce((s, r) => s + r.lineCogsCents, 0);

    expect(summary.totalRevenueExclVatCents).toBe(productRevenue);
    expect(
      coverage.reduce((s, r) => s + r.lineCogsExclVatCents, 0),
    ).toBe(productCogs);
  });
});
