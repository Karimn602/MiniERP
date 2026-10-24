/**
 * A FRESH INSTALLATION SELLS NOTHING IT WAS NOT GIVEN (Codex WP-A finding 6)
 *
 * Migration 003 inserts three products — "Coffee 250g", "Bottled Water 1.5L"
 * and "Wholesale Olive Oil 5L" — plus four barcodes, directly into every
 * database the application creates. Its own header says why: "so dev
 * environments come up with usable data". But a migration is not a
 * development fixture. It runs on every installation, so a restaurant
 * opening Greaz for the first time was handed three sellable grocery items,
 * on the register's menu grid, scannable and rung up onto a customer's
 * receipt.
 *
 * Migration 019 retires them — by primary key, deactivating rather than
 * deleting, and only while the row has never been transacted. This file is
 * the assertion from the OUTSIDE: not "did the UPDATE run" (the Rust suite
 * covers that against the real migrator) but "what would the register show a
 * shop on its first morning", asked through the same SQL the repositories
 * use.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqlTestDb, STORE_ID } from "../helpers/sqlDb";

let db: DatabaseSync;

/** The three ids migration 003 seeds. */
const DEMO_IDS = [
  "00000000-0000-0000-0000-0000000000d1",
  "00000000-0000-0000-0000-0000000000d2",
  "00000000-0000-0000-0000-0000000000d3",
];

function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function count(sql: string, params: unknown[] = []): number {
  const r = rows<{ n: number }>(sql, params)[0];
  return Number(r?.n ?? 0);
}

beforeEach(() => {
  db = createSqlTestDb();
});

afterEach(() => {
  db.close();
});

describe("a virgin production database", () => {
  it("offers no sellable product at all", () => {
    expect(count("SELECT COUNT(*) AS n FROM products WHERE is_active = 1")).toBe(0);
  });

  it("shows nothing on the menu grid the register reads", () => {
    // The register's own filter: `productsRepo.listEnriched` selects active
    // products for the store. This is that query, reduced to its predicate.
    const menu = rows(
      `SELECT id, name FROM products
        WHERE store_id = ? AND is_active = 1
        ORDER BY name`,
      [STORE_ID],
    );
    expect(menu).toEqual([]);
  });

  it("resolves no demo barcode to a sellable product", () => {
    // `findByScan` joins the barcode to its product and requires the product
    // to be active, so a leftover barcode row cannot put one in a cart.
    const scannable = count(
      `SELECT COUNT(*) AS n
         FROM product_barcodes pb
         JOIN products p ON p.id = pb.product_id
        WHERE pb.is_active = 1 AND p.is_active = 1`,
    );
    expect(scannable).toBe(0);
  });

  it("keeps the rows themselves, because deactivating is not deleting", () => {
    // A product is referenced by every document that ever used it. Deleting
    // one is how an audit trail loses a line; this migration never does.
    const placeholders = DEMO_IDS.map(() => "?").join(",");
    expect(
      count(`SELECT COUNT(*) AS n FROM products WHERE id IN (${placeholders})`, DEMO_IDS),
    ).toBe(3);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id IN (${placeholders})`,
        DEMO_IDS,
      ),
    ).toBe(4);
  });

  it("has an empty ledger, drawer and sales history to match", () => {
    // The rest of what "virgin" means, asserted so a future migration that
    // seeds something sellable in another table fails here too.
    for (const table of [
      "sales",
      "sale_items",
      "sale_payments",
      "purchases",
      "supplier_ledger",
      "driver_ledger",
      "inventory_movements",
      "shifts",
      "sales_credit_memos",
    ]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
    }
  });
});
