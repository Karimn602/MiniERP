/**
 * SQL / read-model integration tests for the inventory-valuation query,
 * `db/repos/products.ts::listForValuation` (WP-03, GP-A03).
 *
 * This query is the read model that puts a dollar value on the shelf, and it is
 * the one place outside the posting commands where a unit cost is multiplied by
 * a quantity. If it reads the rounded cents mirror instead of the microcent
 * rate, a store whose ingredients are stocked in grams values its entire
 * inventory at $0.00 — the reporting half of GP-A03.
 *
 * Scope note: this runs repository SQL against node:sqlite with the Tauri SQL
 * plugin mocked out. It is not an end-to-end Tauri test — see tests/README.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  insertPurchase,
  resetIds,
  seedProduct,
  seedProductCost,
} from "../helpers/sqlDb";
import { productsRepo } from "../../src/db/repos/products";
import { extendedCostCents } from "../../src/lib/cost";

const FLOUR = "prod-flour";
const COFFEE = "prod-coffee";

/** $0.0025 per gram — the per-base rate of $2.50/kg. */
const FLOUR_PER_GRAM = 250_000;

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedProduct(db, { id: FLOUR, sku: "SKU-F1", name: "Flour" });
  seedProduct(db, { id: COFFEE, sku: "SKU-C1", name: "Coffee" });
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

describe("listForValuation", () => {
  it("returns the average cost as a microcent rate, not a rounded amount", async () => {
    seedProductCost(db, {
      productId: FLOUR,
      quantityOnHand: 20_000,
      avgCostExclVatMicrocents: FLOUR_PER_GRAM,
    });

    const rows = await productsRepo.listForValuation(
      "00000000-0000-0000-0000-000000000001",
    );
    const flour = rows.find((r) => r.productId === FLOUR)!;

    expect(flour.avgCostExclVatMicrocents).toBe(FLOUR_PER_GRAM);
    expect(flour.quantityOnHand).toBe(20_000);
    // 20,000 g at $0.0025/g is the $50.00 that was paid for it.
    expect(
      extendedCostCents(flour.avgCostExclVatMicrocents, flour.quantityOnHand),
    ).toBe(5_000);
  });

  it("carries a whole-cent cost through unchanged", async () => {
    seedProductCost(db, {
      productId: COFFEE,
      quantityOnHand: 40,
      avgCostExclVatMicrocents: 237_000_000, // $2.37/piece
    });

    const rows = await productsRepo.listForValuation(
      "00000000-0000-0000-0000-000000000001",
    );
    const coffee = rows.find((r) => r.productId === COFFEE)!;

    expect(coffee.avgCostExclVatMicrocents).toBe(237_000_000);
    expect(extendedCostCents(coffee.avgCostExclVatMicrocents, 40)).toBe(9_480);
  });

  it("reads the last purchase cost at full precision, newest posted purchase first", async () => {
    seedProductCost(db, {
      productId: FLOUR,
      quantityOnHand: 20_000,
      avgCostExclVatMicrocents: FLOUR_PER_GRAM,
    });
    // Lines are passed to `insertPurchase` rather than attached afterwards:
    // since migration 012 a posted purchase takes no further lines, so the
    // fixture builds each document as a draft and promotes it, exactly as
    // `post_purchase` does.
    insertPurchase(db, {
      purchaseDate: "2026-03-01",
      subtotalExclVat: 5_000,
      vat: 550,
      lines: [
        {
          productId: FLOUR,
          productName: "Flour",
          quantityBase: 20_000,
          unitCostExclVatBaseMicrocents: FLOUR_PER_GRAM,
        },
      ],
    });
    insertPurchase(db, {
      purchaseDate: "2026-03-05",
      subtotalExclVat: 8_200,
      vat: 902,
      lines: [
        {
          productId: FLOUR,
          productName: "Flour",
          quantityBase: 20_000,
          unitCostExclVatBaseMicrocents: 410_000, // $0.0041/g
        },
      ],
    });

    const rows = await productsRepo.listForValuation(
      "00000000-0000-0000-0000-000000000001",
    );
    const flour = rows.find((r) => r.productId === FLOUR)!;

    expect(flour.lastPurchaseCostExclVatMicrocents).toBe(410_000);
    // The valuation difference the Inventory page shows is real money: 20,000 g
    // at $0.0041 against $0.0025 is $82.00 against $50.00.
    expect(extendedCostCents(flour.lastPurchaseCostExclVatMicrocents!, 20_000)).toBe(8_200);
  });

  it("reports a missing last purchase cost as null rather than zero", async () => {
    seedProductCost(db, {
      productId: FLOUR,
      quantityOnHand: 20_000,
      avgCostExclVatMicrocents: FLOUR_PER_GRAM,
    });

    const rows = await productsRepo.listForValuation(
      "00000000-0000-0000-0000-000000000001",
    );
    const flour = rows.find((r) => r.productId === FLOUR)!;

    // A product with no purchase history has no last-purchase cost. The
    // distinction matters: null means "unknown", 0 would mean "free".
    expect(flour.lastPurchaseCostExclVatMicrocents).toBeNull();
  });
});
