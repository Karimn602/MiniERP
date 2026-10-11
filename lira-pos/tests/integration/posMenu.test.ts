/**
 * SQL / read-model integration tests for the POS Register's MENU GRID source —
 * `db/repos/products.ts::listEnriched` composed with the pure helpers in
 * `lib/menuGrid.ts` (Greaz restaurant-first UX pass).
 *
 * The rule under test is the one the pass turns on: a quick-service menu item
 * has NO BARCODE. The register used to refuse any non-service product whose
 * `primaryBarcode` was null, by every path — tile, search and scan alike — so a
 * burger could not be rung up at all. These tests pin the menu down against the
 * real schema and the real query, not a hand-built object: a regression that
 * reintroduced a barcode requirement, or that let an inactive product onto the
 * grid, would fail here.
 *
 * Scope note: this runs repository SQL against node:sqlite with the Tauri SQL
 * plugin mocked out. It is not an end-to-end Tauri test — see tests/README.md.
 * No posting command runs; nothing here asserts anything about how a sale posts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import { STORE_ID, createSqlTestDb, resetIds, seedProduct } from "../helpers/sqlDb";
import { productsRepo } from "../../src/db/repos/products";
import {
  filterMenu,
  isMenuOutOfStock,
  isMenuSellable,
  menuTilePriceInclVatCents,
  sortMenu,
} from "../../src/lib/menuGrid";

let db: DatabaseSync;

/**
 * Give a product the two UoM rows `productsRepo.enrich` insists on: a base row
 * and a default-sale row (here the same "each" row, which is what the catalog
 * writes for a simple menu item). Deliberately adds NO barcode.
 */
function seedEachUom(productId: string): void {
  db.prepare(
    `INSERT INTO product_uoms (
       id, store_id, product_id, uom_code, factor_num, factor_den,
       is_base, is_default_sale_uom, is_default_purchase_uom, is_active
     ) VALUES (?, ?, ?, 'each', 1, 1, 1, 1, 1, 1)`,
  ).run(`uom-${productId}`, STORE_ID, productId);
}

/** A menu item: active, stocked, priced, and with no barcode anywhere. */
function seedMenuItem(
  productId: string,
  name: string,
  opts: { isService?: boolean; isActive?: boolean; quantityOnHand?: number } = {},
): void {
  seedProduct(db, { id: productId, sku: `SKU-${productId}`, name, isService: opts.isService });
  seedEachUom(productId);
  if (opts.isActive === false) {
    db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(productId);
  }
  if (opts.quantityOnHand !== undefined) {
    db.prepare("UPDATE products SET quantity_on_hand = ? WHERE id = ?").run(
      opts.quantityOnHand,
      productId,
    );
  }
}

async function loadMenu() {
  const rows = await productsRepo.listEnriched({ storeId: STORE_ID });
  return sortMenu(rows.filter(isMenuSellable));
}

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  // Migration 003 seeds demo products; drop them so each test sees only its own
  // menu. Deleting the UoM/barcode children first keeps foreign keys happy.
  db.exec("DELETE FROM product_barcodes");
  db.exec("DELETE FROM product_uoms");
  db.exec("DELETE FROM products");
});

describe("the menu grid's source", () => {
  it("offers a stocked item that has no barcode at all — the burger case", async () => {
    seedMenuItem("p-double", "Double");

    const barcodes = db.prepare("SELECT count(*) AS n FROM product_barcodes").get() as {
      n: number;
    };
    expect(barcodes.n).toBe(0);

    const menu = await loadMenu();
    expect(menu.map((p) => p.name)).toEqual(["Double"]);
    expect(menu[0].primaryBarcode).toBeNull();
    expect(isMenuSellable(menu[0])).toBe(true);
  });

  it("prices a tile from the product's incl-VAT price", async () => {
    seedMenuItem("p-fries", "Fries");
    const menu = await loadMenu();
    // seedProduct writes 450 excl / 500 incl.
    expect(menuTilePriceInclVatCents(menu[0])).toBe(500);
  });

  it("keeps an inactive product off the grid", async () => {
    seedMenuItem("p-live", "Chicken Burger");
    seedMenuItem("p-dead", "Discontinued Wrap", { isActive: false });

    const menu = await loadMenu();
    expect(menu.map((p) => p.name)).toEqual(["Chicken Burger"]);
  });

  it("offers a service with no barcode and never calls it out of stock", async () => {
    seedMenuItem("p-delivery", "Delivery", { isService: true, quantityOnHand: 0 });

    const menu = await loadMenu();
    expect(menu.map((p) => p.name)).toEqual(["Delivery"]);
    expect(isMenuOutOfStock(menu[0], false)).toBe(false);
  });

  it("marks a stocked item out of stock at zero, and not when negative stock is allowed", async () => {
    seedMenuItem("p-wings", "Wings", { quantityOnHand: 0 });

    const menu = await loadMenu();
    expect(isMenuOutOfStock(menu[0], false)).toBe(true);
    expect(isMenuOutOfStock(menu[0], true)).toBe(false);
  });

  it("orders a real menu the way a human reads it, not byte-wise", async () => {
    seedMenuItem("p-1", "Wings");
    seedMenuItem("p-2", "fries");
    seedMenuItem("p-3", "Boneless");

    const menu = await loadMenu();
    expect(menu.map((p) => p.name)).toEqual(["Boneless", "fries", "Wings"]);
  });

  it("filters a loaded menu by name without another query", async () => {
    seedMenuItem("p-1", "Chicken Burger");
    seedMenuItem("p-2", "Chili Fries");
    seedMenuItem("p-3", "Onion Rings");

    const menu = await loadMenu();
    expect(filterMenu(menu, "chi").map((p) => p.name)).toEqual([
      "Chicken Burger",
      "Chili Fries",
    ]);
    expect(filterMenu(menu, "").map((p) => p.name)).toEqual([
      "Chicken Burger",
      "Chili Fries",
      "Onion Rings",
    ]);
  });

  it("still resolves a barcode scan for a packaged product that does have one", async () => {
    seedMenuItem("p-water", "Water");
    // `lookup_value` is the normalised scan key (TRIM + UPPER), written by the
    // catalog command rather than generated, so the fixture supplies it the same
    // way migration 002 does.
    db.prepare(
      `INSERT INTO product_barcodes (
         id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active
       ) VALUES ('bc-water', ?, 'p-water', '5281234567890', '5281234567890', 'EAN13', 1, 1)`,
    ).run(STORE_ID);

    // The tile path and the scan path reach the same product.
    const menu = await loadMenu();
    expect(menu.map((p) => p.name)).toEqual(["Water"]);

    const hit = await productsRepo.findByScan(STORE_ID, "5281234567890");
    expect(hit).not.toBeNull();
    expect(hit!.product.id).toBe("p-water");
  });
});
