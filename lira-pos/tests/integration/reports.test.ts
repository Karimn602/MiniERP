/**
 * SQL / read-model integration tests for `db/repos/reports.ts`.
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
  insertSale,
  resetIds,
  seedExchangeRate,
  seedProduct,
  STORE_ID,
  VAT_EXEMPT_ID,
} from "../helpers/sqlDb";
import { reportsRepo } from "../../src/db/repos/reports";

const COFFEE = "prod-coffee";
const WATER = "prod-water";

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  seedProduct(db, { id: COFFEE, sku: "SKU-C1", name: "Coffee 250g" });
  seedProduct(db, { id: WATER, sku: "SKU-W1", name: "Water 1.5L", vatRateId: VAT_EXEMPT_ID });
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

/** One 11% line: 2 × $5.00 incl → 900 excl + 100 VAT = 1000. */
function coffeeLine(qty = 2) {
  const total = 500 * qty;
  const subtotal = Math.round((total * 10_000) / 11_100);
  return {
    productId: COFFEE,
    productName: "Coffee 250g",
    quantity: qty,
    subtotalExclVat: subtotal,
    vat: total - subtotal,
    totalInclVat: total,
    cogs: 200 * qty,
  };
}

describe("dailySales", () => {
  it("groups by local date and sums the header columns", () => {
    insertSale(db, { postedAt: "2026-03-01T09:00:00.000Z", lines: [coffeeLine(2)], payments: [] });
    insertSale(db, { postedAt: "2026-03-01T17:30:00.000Z", lines: [coffeeLine(4)], payments: [] });
    insertSale(db, { postedAt: "2026-03-02T11:00:00.000Z", lines: [coffeeLine(1)], payments: [] });

    return reportsRepo
      .dailySales({ storeId: STORE_ID, dateFrom: "2026-03-01", dateTo: "2026-03-02" })
      .then((rows) => {
        expect(rows).toHaveLength(2);
        expect(rows[0].localDate).toBe("2026-03-01");
        expect(rows[0].saleCount).toBe(2);
        expect(rows[0].totalInclVatCents).toBe(1000 + 2000);
        expect(rows[0].cogsTotalCents).toBe(400 + 800);
        expect(rows[1].localDate).toBe("2026-03-02");
        expect(rows[1].saleCount).toBe(1);
        expect(rows[1].totalInclVatCents).toBe(500);
      });
  });

  it("keeps each day's subtotal + VAT equal to its total", async () => {
    insertSale(db, { postedAt: "2026-03-01T09:00:00.000Z", lines: [coffeeLine(3)], payments: [] });
    insertSale(db, { postedAt: "2026-03-01T12:00:00.000Z", lines: [coffeeLine(7)], payments: [] });

    const [day] = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });
    expect(day.subtotalExclVatCents + day.vatTotalCents).toBe(day.totalInclVatCents);
  });

  it("excludes draft and voided sales", async () => {
    insertSale(db, { postedAt: "2026-03-01T09:00:00.000Z", lines: [coffeeLine(2)], payments: [] });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      lines: [coffeeLine(2)],
      payments: [],
      status: "draft",
    });
    insertSale(db, {
      postedAt: "2026-03-01T11:00:00.000Z",
      lines: [coffeeLine(2)],
      payments: [],
      status: "voided",
    });

    const [day] = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });
    expect(day.saleCount).toBe(1);
    expect(day.totalInclVatCents).toBe(1000);
  });

  it("respects the date window at both ends", async () => {
    insertSale(db, { postedAt: "2026-02-28T23:00:00.000Z", lines: [coffeeLine(1)], payments: [] });
    insertSale(db, { postedAt: "2026-03-01T00:30:00.000Z", lines: [coffeeLine(1)], payments: [] });
    insertSale(db, { postedAt: "2026-03-01T23:30:00.000Z", lines: [coffeeLine(1)], payments: [] });
    insertSale(db, { postedAt: "2026-03-02T01:00:00.000Z", lines: [coffeeLine(1)], payments: [] });

    const rows = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].saleCount).toBe(2);
  });

  it("returns nothing for a period with no sales", async () => {
    const rows = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    expect(rows).toEqual([]);
  });

  it("reports the header discount alongside the already-net totals", async () => {
    // post_sale stores POST-discount line values plus the header discount.
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      discountCents: 100,
      lines: [
        {
          productId: COFFEE,
          productName: "Coffee 250g",
          quantity: 2,
          subtotalExclVat: 811,
          vat: 89,
          totalInclVat: 900,
          lineDiscount: 100,
          cogs: 400,
        },
      ],
      payments: [],
    });

    const [day] = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });
    expect(day.discountCents).toBe(100);
    expect(day.totalInclVatCents).toBe(900);
    expect(day.subtotalExclVatCents + day.vatTotalCents).toBe(day.totalInclVatCents);
  });
});

describe("productSales", () => {
  it("aggregates quantity and money per product across sales", async () => {
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      lines: [
        coffeeLine(2),
        {
          productId: WATER,
          productName: "Water 1.5L",
          quantity: 5,
          subtotalExclVat: 500,
          vat: 0,
          totalInclVat: 500,
          vatRateId: VAT_EXEMPT_ID,
          vatBps: 0,
          cogs: 150,
        },
      ],
      payments: [],
    });
    insertSale(db, { postedAt: "2026-03-01T14:00:00.000Z", lines: [coffeeLine(3)], payments: [] });

    const rows = await reportsRepo.productSales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });

    const coffee = rows.find((r) => r.productId === COFFEE)!;
    const water = rows.find((r) => r.productId === WATER)!;

    expect(coffee.totalQty).toBe(5);
    expect(coffee.lineTotalInclVatCents).toBe(1000 + 1500);
    expect(coffee.lineCogsCents).toBe(400 + 600);
    expect(water.totalQty).toBe(5);
    expect(water.lineTotalInclVatCents).toBe(500);
  });

  it("orders by revenue, highest first", async () => {
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      lines: [
        coffeeLine(1),
        {
          productId: WATER,
          productName: "Water 1.5L",
          quantity: 50,
          subtotalExclVat: 5000,
          vat: 0,
          totalInclVat: 5000,
          vatRateId: VAT_EXEMPT_ID,
          vatBps: 0,
        },
      ],
      payments: [],
    });

    const rows = await reportsRepo.productSales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });
    expect(rows[0].productId).toBe(WATER);
  });

  it("reconciles to the daily header totals", async () => {
    insertSale(db, { postedAt: "2026-03-01T09:00:00.000Z", lines: [coffeeLine(2)], payments: [] });
    insertSale(db, { postedAt: "2026-03-01T10:00:00.000Z", lines: [coffeeLine(9)], payments: [] });

    const [day] = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });
    const products = await reportsRepo.productSales({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-01",
    });

    const productTotal = products.reduce((s, r) => s + r.lineTotalInclVatCents, 0);
    expect(productTotal).toBe(day.totalInclVatCents);
    const productCogs = products.reduce((s, r) => s + r.lineCogsCents, 0);
    expect(productCogs).toBe(day.cogsTotalCents);
  });
});

describe("dailyPurchases", () => {
  it("groups by purchase date and reconciles subtotal + VAT", async () => {
    insertPurchase(db, { purchaseDate: "2026-03-01", subtotalExclVat: 2000, vat: 220 });
    insertPurchase(db, { purchaseDate: "2026-03-01", subtotalExclVat: 1000, vat: 110 });
    insertPurchase(db, { purchaseDate: "2026-03-05", subtotalExclVat: 500, vat: 55 });

    const rows = await reportsRepo.dailyPurchases({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-05",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].localDate).toBe("2026-03-01");
    expect(rows[0].purchaseCount).toBe(2);
    expect(rows[0].subtotalExclVatCents).toBe(3000);
    expect(rows[0].vatTotalCents).toBe(330);
    expect(rows[0].totalInclVatCents).toBe(3330);
    expect(rows[0].subtotalExclVatCents + rows[0].vatTotalCents).toBe(rows[0].totalInclVatCents);
  });

  it("excludes drafts and respects the window", async () => {
    insertPurchase(db, { purchaseDate: "2026-03-01", subtotalExclVat: 100, vat: 11 });
    insertPurchase(db, {
      purchaseDate: "2026-03-01",
      subtotalExclVat: 999,
      vat: 0,
      status: "draft",
    });
    insertPurchase(db, { purchaseDate: "2026-04-01", subtotalExclVat: 777, vat: 0 });

    const rows = await reportsRepo.dailyPurchases({
      storeId: STORE_ID,
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseCount).toBe(1);
    expect(rows[0].subtotalExclVatCents).toBe(100);
  });
});
