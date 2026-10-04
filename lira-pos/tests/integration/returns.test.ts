/**
 * SQL / read-model integration tests for sales returns (WP-06, GP-A08).
 *
 * Scope note: this runs repository SQL against node:sqlite with the Tauri SQL
 * plugin mocked out. It is not an end-to-end Tauri test, and it does NOT run
 * `post_credit_memo` — the authority on posting behaviour is the Rust suite in
 * `src-tauri/src/tests/returns.rs`. What lives here is the read side: the
 * queries the Returns page, the Create Return screen, the shift summary and the
 * daily reports run, including the ones that must agree with the backend's own
 * definitions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  insertCreditMemo,
  insertSale,
  resetIds,
  saleItemIds,
  seedExchangeRate,
  seedProduct,
  seedShift,
  RATE_LBP_PER_USD,
  STORE_ID,
  VAT_EXEMPT_ID,
} from "../helpers/sqlDb";
import { creditMemosRepo } from "../../src/db/repos/creditMemos";
import { reportsRepo } from "../../src/db/repos/reports";
import { shiftsRepo } from "../../src/db/repos/shifts";
import { refundSummaryRepo } from "../../src/db/repos/shiftSummary";

const COFFEE = "prod-coffee";
const WATER = "prod-water";
const DELIVERY = "prod-delivery";
const SHIFT = "shift-1";

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  seedProduct(db, { id: COFFEE, sku: "SKU-C1", name: "Coffee 250g" });
  seedProduct(db, { id: WATER, sku: "SKU-W1", name: "Water 1.5L", vatRateId: VAT_EXEMPT_ID });
  seedProduct(db, { id: DELIVERY, sku: "SKU-D1", name: "Delivery", isService: true });
  seedShift(db, { id: SHIFT, openingUsdCents: 5_000, openingLbp: 1_000_000 });
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

/** One 11% coffee line: qty × $5.00 incl. */
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

/** An exempt line: qty × $3.00, no VAT. */
function waterLine(qty = 2) {
  const total = 300 * qty;
  return {
    productId: WATER,
    productName: "Water 1.5L",
    quantity: qty,
    subtotalExclVat: total,
    vat: 0,
    totalInclVat: total,
    cogs: 100 * qty,
    vatRateId: VAT_EXEMPT_ID,
    vatBps: 0,
  };
}

/** A stock movement for a sale line, so the read models know it moved stock. */
function insertSaleMovement(saleId: string, saleItemId: string, productId: string, qty: number) {
  db.prepare(
    `INSERT INTO inventory_movements (
       id, store_id, product_id, movement_type, quantity_delta,
       related_sale_id, related_sale_item_id, posted_at
     ) VALUES (?, ?, ?, 'sale', ?, ?, ?, '2026-03-01T10:00:00.000Z')`,
  ).run(`mov-${saleItemId}`, STORE_ID, productId, -qty, saleId, saleItemId);
}

// ============================================================================
// Return status — derived, never written onto the sale
// ============================================================================

describe("returnStatusForStore", () => {
  it("reports none, partial and full from the credit-memo lines alone", () => {
    const untouched = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });
    const partly = insertSale(db, {
      postedAt: "2026-03-01T11:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(4)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2_000, usdEquivalent: 2_000 }],
    });
    const wholly = insertSale(db, {
      postedAt: "2026-03-01T12:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(1)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });

    insertCreditMemo(db, {
      saleId: partly,
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: saleItemIds(db, partly)[0],
          productId: COFFEE,
          quantityBase: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogsReversed: 200,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });
    insertCreditMemo(db, {
      saleId: wholly,
      postedAt: "2026-03-02T11:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: saleItemIds(db, wholly)[0],
          productId: COFFEE,
          quantityBase: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogsReversed: 200,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });

    return creditMemosRepo.returnStatusForStore(STORE_ID).then((statuses) => {
      expect(statuses.get(untouched)).toBe("none");
      expect(statuses.get(partly)).toBe("partial");
      expect(statuses.get(wholly)).toBe("full");

      // And nothing was written onto the sales themselves.
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM sales WHERE sale_type <> 'normal' OR original_sale_id IS NOT NULL")
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });
  });

  it("ignores a voided credit memo", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });
    insertCreditMemo(db, {
      saleId: sale,
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: SHIFT,
      status: "voided",
      lines: [
        {
          saleItemId: saleItemIds(db, sale)[0],
          productId: COFFEE,
          quantityBase: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1_000,
          cogsReversed: 400,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });

    const statuses = await creditMemosRepo.returnStatusForStore(STORE_ID);
    expect(statuses.get(sale)).toBe("none");
  });
});

// ============================================================================
// Returnable lines — the same subtraction the backend bounds a return by
// ============================================================================

describe("returnableLines", () => {
  it("states sold, returned and remaining, and counts only posted memos", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(4), waterLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2_600, usdEquivalent: 2_600 }],
    });
    const [coffeeItem, waterItem] = saleItemIds(db, sale);
    insertSaleMovement(sale, coffeeItem, COFFEE, 4);
    insertSaleMovement(sale, waterItem, WATER, 2);

    insertCreditMemo(db, {
      saleId: sale,
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: coffeeItem,
          productId: COFFEE,
          quantityBase: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogsReversed: 200,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });

    const lines = await creditMemosRepo.returnableLines({ storeId: STORE_ID, saleId: sale });
    expect(lines).toHaveLength(2);

    const coffee = lines.find((l) => l.productId === COFFEE)!;
    expect(coffee.soldQuantityBase).toBe(4);
    expect(coffee.returnedQuantityBase).toBe(1);
    expect(coffee.remainingQuantityBase).toBe(3);
    expect(coffee.lineTotalInclVatCents).toBe(2_000);
    expect(coffee.isService).toBe(false);

    const water = lines.find((l) => l.productId === WATER)!;
    expect(water.returnedQuantityBase).toBe(0);
    expect(water.remainingQuantityBase).toBe(2);
    expect(water.vatRateBpsSnapshot).toBe(0);
  });

  it("marks a line that moved no stock as a service, from the sale's own movements", async () => {
    // The backend decides restockability from whether the SALE produced a
    // movement, not from `products.is_service` as it reads today — so this
    // query must do the same, or the screen would offer a restock the command
    // refuses.
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        coffeeLine(1),
        {
          productId: DELIVERY,
          productName: "Delivery",
          quantity: 1,
          subtotalExclVat: 1_000,
          vat: 110,
          totalInclVat: 1_110,
          cogs: 0,
        },
      ],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_610, usdEquivalent: 1_610 }],
    });
    const [coffeeItem] = saleItemIds(db, sale);
    // Only the stocked line gets a movement — exactly as `post_sale` writes it.
    insertSaleMovement(sale, coffeeItem, COFFEE, 1);

    const lines = await creditMemosRepo.returnableLines({ storeId: STORE_ID, saleId: sale });
    expect(lines.find((l) => l.productId === COFFEE)!.isService).toBe(false);
    expect(lines.find((l) => l.productId === DELIVERY)!.isService).toBe(true);
  });

  it("reclassifying the product does not change a historical line", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(1)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });
    const [item] = saleItemIds(db, sale);
    insertSaleMovement(sale, item, COFFEE, 1);

    // The shop decides coffee is a service from now on. The goods that already
    // left the shelf still left it.
    db.prepare("UPDATE products SET is_service = 1 WHERE id = ?").run(COFFEE);

    const lines = await creditMemosRepo.returnableLines({ storeId: STORE_ID, saleId: sale });
    expect(lines[0].isService).toBe(false);
  });
});

// ============================================================================
// Refund availability — the per-(method, currency) cap, net of change
// ============================================================================

describe("refundAvailability", () => {
  it("is net of the change the sale gave, and net of earlier refunds", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(4)],
      payments: [
        // $12.00 of cash against $10.00 due on this leg, $2.00 handed back.
        {
          method: "cash_usd",
          currency: "USD",
          nativeUsdCents: 1_200,
          usdEquivalent: 1_200,
          changeUsdCents: 200,
        },
        { method: "card_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 },
      ],
    });
    const [item] = saleItemIds(db, sale);

    let availability = await creditMemosRepo.refundAvailability({
      storeId: STORE_ID,
      saleId: sale,
    });
    const cash = availability.find((a) => a.method === "cash_usd")!;
    expect(cash.availableNative).toBe(1_000);
    expect(cash.refundedNative).toBe(0);
    expect(cash.remainingNative).toBe(1_000);
    expect(availability.find((a) => a.method === "card_usd")!.remainingNative).toBe(1_000);

    insertCreditMemo(db, {
      saleId: sale,
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: item,
          productId: COFFEE,
          quantityBase: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1_000,
          cogsReversed: 400,
        },
      ],
      refunds: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
        { method: "card_usd", currency: "USD", nativeUsdCents: 400, usdEquivalent: 400 },
      ],
    });

    availability = await creditMemosRepo.refundAvailability({ storeId: STORE_ID, saleId: sale });
    expect(availability.find((a) => a.method === "cash_usd")!.remainingNative).toBe(400);
    expect(availability.find((a) => a.method === "card_usd")!.remainingNative).toBe(600);
  });

  it("states a lira tender in lira, not in its USD equivalent", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(2)],
      payments: [
        {
          method: "cash_lbp",
          currency: "LBP",
          nativeLbp: 895_000,
          usdEquivalent: 1_000,
        },
      ],
    });
    const availability = await creditMemosRepo.refundAvailability({
      storeId: STORE_ID,
      saleId: sale,
    });
    expect(availability).toHaveLength(1);
    expect(availability[0].currency).toBe("LBP");
    expect(availability[0].remainingNative).toBe(895_000);
    // Sanity: the fixture's lira really is $10.00 at the locked rate.
    expect(Math.round((895_000 * 100) / RATE_LBP_PER_USD)).toBe(1_000);
  });

  it("offers no method the sale never used, and never store credit", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(2)],
      payments: [
        { method: "card_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 },
        // Schema-legal on a sale (migration 001), but never refundable: there
        // is no customer-credit ledger to put the liability in.
        { method: "store_credit", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 },
      ],
    });
    const availability = await creditMemosRepo.refundAvailability({
      storeId: STORE_ID,
      saleId: sale,
    });
    expect(availability.map((a) => a.method)).toEqual(["card_usd"]);
  });
});

// ============================================================================
// The memo read models
// ============================================================================

describe("list / findByIdWithDetails / listForSale", () => {
  it("returns a memo in full, with the receipt it reverses", async () => {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(2), waterLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_600, usdEquivalent: 1_600 }],
    });
    const [coffeeItem, waterItem] = saleItemIds(db, sale);
    const memoId = insertCreditMemo(db, {
      saleId: sale,
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: SHIFT,
      reason: "Damaged in the bag",
      lines: [
        {
          saleItemId: coffeeItem,
          productId: COFFEE,
          productName: "Coffee 250g",
          quantityBase: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1_000,
          cogsReversed: 400,
        },
        {
          saleItemId: waterItem,
          productId: WATER,
          productName: "Water 1.5L",
          quantityBase: 1,
          subtotalExclVat: 300,
          vat: 0,
          totalInclVat: 300,
          cogsReversed: 100,
          returnToStock: false,
          vatRateId: VAT_EXEMPT_ID,
          vatBps: 0,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_300, usdEquivalent: 1_300 }],
    });

    const memo = await creditMemosRepo.findByIdWithDetails(memoId);
    expect(memo).not.toBeNull();
    expect(memo!.originalReceiptNumber).toBe(1);
    expect(memo!.totalInclVatCents).toBe(1_300);
    expect(memo!.vatTotalCents).toBe(100);
    expect(memo!.refundTotalUsdCents).toBe(1_300);
    // Only the restocked line reversed cost.
    expect(memo!.cogsReversedCents).toBe(400);
    expect(memo!.lines).toHaveLength(2);
    expect(memo!.lines.find((l) => l.productId === WATER)!.returnToStock).toBe(false);
    expect(memo!.lines.find((l) => l.productId === WATER)!.lineCogsExclVatCents).toBe(0);
    expect(memo!.refunds).toHaveLength(1);

    const listed = await creditMemosRepo.list({ storeId: STORE_ID });
    expect(listed).toHaveLength(1);
    expect(listed[0].creditMemoNumber).toBe(1);
    expect(listed[0].originalReceiptNumber).toBe(1);

    const forSale = await creditMemosRepo.listForSale(sale);
    expect(forSale.map((m) => m.id)).toEqual([memoId]);
  });
});

// ============================================================================
// Reports — additive, gross stays gross
// ============================================================================

describe("reportsRepo returns series", () => {
  function twoDaysOfTrade() {
    const saleA = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(4)], // 1800 + 200 = 2000, cogs 800
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2_000, usdEquivalent: 2_000 }],
    });
    const saleB = insertSale(db, {
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [waterLine(2)], // 600 exempt, cogs 200
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 }],
    });
    return { saleA, saleB };
  }

  it("groups returns by local date without touching the sales series", async () => {
    const { saleA, saleB } = twoDaysOfTrade();
    const [coffeeItem] = saleItemIds(db, saleA);
    const [waterItem] = saleItemIds(db, saleB);

    insertCreditMemo(db, {
      saleId: saleA,
      postedAt: "2026-03-02T09:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: coffeeItem,
          productId: COFFEE,
          quantityBase: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1_000,
          cogsReversed: 400,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });
    insertCreditMemo(db, {
      saleId: saleB,
      postedAt: "2026-03-02T12:00:00.000Z",
      shiftId: SHIFT,
      // Written off: the money comes back, the cost stays consumed.
      lines: [
        {
          saleItemId: waterItem,
          productId: WATER,
          quantityBase: 1,
          subtotalExclVat: 300,
          vat: 0,
          totalInclVat: 300,
          cogsReversed: 100,
          returnToStock: false,
          vatRateId: VAT_EXEMPT_ID,
          vatBps: 0,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 300, usdEquivalent: 300 }],
    });

    const args = { storeId: STORE_ID, dateFrom: "2026-03-01", dateTo: "2026-03-02" };

    // The sales series is untouched — the same gross figures as before WP-06.
    const sales = await reportsRepo.dailySales(args);
    expect(sales.map((r) => [r.localDate, r.totalInclVatCents, r.cogsTotalCents])).toEqual([
      ["2026-03-01", 2_000, 800],
      ["2026-03-02", 600, 200],
    ]);

    const returns = await reportsRepo.dailyReturns(args);
    expect(returns).toHaveLength(1);
    expect(returns[0].localDate).toBe("2026-03-02");
    expect(returns[0].memoCount).toBe(2);
    expect(returns[0].totalInclVatCents).toBe(1_300);
    expect(returns[0].vatTotalCents).toBe(100);
    expect(returns[0].cogsReversedCents).toBe(400);

    // The profit arithmetic the page performs, for the whole period:
    //   net sales  = (1802 + 600) − (900 + 300)   = 1202
    //   net COGS   = (800 + 200)  − 400           =  600
    //   net profit =                                 602
    //
    // The 400 is the whole point: the coffee came back and gave its cost
    // back with it, while the written-off water gave the money back and kept
    // its cost consumed.
    const grossNet = sales.reduce((s, r) => s + r.subtotalExclVatCents, 0);
    const grossCogs = sales.reduce((s, r) => s + r.cogsTotalCents, 0);
    const returnedNet = returns.reduce((s, r) => s + r.subtotalExclVatCents, 0);
    const reversedCogs = returns.reduce((s, r) => s + r.cogsReversedCents, 0);
    expect(grossNet - returnedNet).toBe(1_202);
    expect(grossCogs - reversedCogs).toBe(600);
    expect(grossNet - returnedNet - (grossCogs - reversedCogs)).toBe(602);
  });

  it("nets returns off a product's own row, cost only where the goods came back", async () => {
    const { saleA, saleB } = twoDaysOfTrade();
    const [coffeeItem] = saleItemIds(db, saleA);
    const [waterItem] = saleItemIds(db, saleB);

    insertCreditMemo(db, {
      saleId: saleA,
      postedAt: "2026-03-02T09:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: coffeeItem,
          productId: COFFEE,
          quantityBase: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogsReversed: 200,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });
    insertCreditMemo(db, {
      saleId: saleB,
      postedAt: "2026-03-02T12:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: waterItem,
          productId: WATER,
          quantityBase: 1,
          subtotalExclVat: 300,
          vat: 0,
          totalInclVat: 300,
          cogsReversed: 100,
          returnToStock: false,
          vatRateId: VAT_EXEMPT_ID,
          vatBps: 0,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 300, usdEquivalent: 300 }],
    });

    const args = { storeId: STORE_ID, dateFrom: "2026-03-01", dateTo: "2026-03-02" };
    const returns = await reportsRepo.productReturns(args);

    const coffee = returns.find((r) => r.productId === COFFEE)!;
    expect(coffee.totalQty).toBe(1);
    expect(coffee.lineTotalInclVatCents).toBe(500);
    expect(coffee.lineCogsCents).toBe(200);

    const water = returns.find((r) => r.productId === WATER)!;
    expect(water.totalQty).toBe(1);
    expect(water.lineTotalInclVatCents).toBe(300);
    // A written-off return reverses no cost, so the product's margin on those
    // units is lost rather than restored.
    expect(water.lineCogsCents).toBe(0);
  });

  it("counts only posted memos", async () => {
    const { saleA } = twoDaysOfTrade();
    const [coffeeItem] = saleItemIds(db, saleA);
    insertCreditMemo(db, {
      saleId: saleA,
      postedAt: "2026-03-01T12:00:00.000Z",
      shiftId: SHIFT,
      status: "voided",
      lines: [
        {
          saleItemId: coffeeItem,
          productId: COFFEE,
          quantityBase: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
          cogsReversed: 200,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });

    const args = { storeId: STORE_ID, dateFrom: "2026-03-01", dateTo: "2026-03-02" };
    expect(await reportsRepo.dailyReturns(args)).toEqual([]);
    expect(await reportsRepo.productReturns(args)).toEqual([]);
  });
});

// ============================================================================
// The shift: refunds, and the drawer they come out of
// ============================================================================

describe("shift refunds and drawer", () => {
  function shiftWithTradeAndRefunds() {
    const sale = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT,
      lines: [coffeeLine(8)], // $40.00
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 2_000, usdEquivalent: 2_000 },
        { method: "card_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 },
        { method: "cash_lbp", currency: "LBP", nativeLbp: 895_000, usdEquivalent: 1_000 },
      ],
    });
    const [item] = saleItemIds(db, sale);

    insertCreditMemo(db, {
      saleId: sale,
      postedAt: "2026-03-01T15:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: item,
          productId: COFFEE,
          quantityBase: 3,
          subtotalExclVat: 1_351,
          vat: 149,
          totalInclVat: 1_500,
          cogsReversed: 600,
        },
      ],
      refunds: [
        // Cash out of the till, a card that never touches it, and lira.
        { method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 },
        { method: "card_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 },
        { method: "cash_lbp", currency: "LBP", nativeLbp: 447_500, usdEquivalent: 500 },
      ],
    });
    return sale;
  }

  it("subtracts cash refunds from the expected drawer and leaves cards alone", async () => {
    shiftWithTradeAndRefunds();
    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT, STORE_ID);

    expect(drawer.cashUsdInCents).toBe(2_000);
    expect(drawer.cashLbpIn).toBe(895_000);
    expect(drawer.changeUsdOutCents).toBe(0);
    // Only the two CASH legs appear; the $5.00 card refund does not.
    expect(drawer.refundUsdOutCents).toBe(500);
    expect(drawer.refundLbpOut).toBe(447_500);

    // The figure the page shows, and the one `close_shift` persists:
    //   $50.00 float + $20.00 cash in − $5.00 cash refunded = $65.00
    expect(5_000 + drawer.cashUsdInCents - drawer.changeUsdOutCents - drawer.refundUsdOutCents)
      .toBe(6_500);
    expect(1_000_000 + drawer.cashLbpIn - drawer.changeLbpOut - drawer.refundLbpOut)
      .toBe(1_447_500);
  });

  it("summarises the shift's refunds without restating its sales", async () => {
    shiftWithTradeAndRefunds();

    const sales = await shiftsRepo.getSalesSummary(SHIFT, STORE_ID);
    const refunds = await shiftsRepo.getRefundSummary(SHIFT, STORE_ID);

    // The sales side is GROSS and unchanged: one receipt, $40.00.
    expect(sales.receiptCount).toBe(1);
    expect(sales.totalInclVatCents).toBe(4_000);

    expect(refunds.memoCount).toBe(1);
    expect(refunds.totalInclVatCents).toBe(1_500);
    expect(refunds.vatTotalCents).toBe(149);
    expect(refunds.cogsReversedCents).toBe(600);

    // Net collection is the visible subtraction the page makes.
    expect(sales.totalInclVatCents - refunds.totalInclVatCents).toBe(2_500);
  });

  it("breaks the refunds down by the method the money went back on", async () => {
    shiftWithTradeAndRefunds();
    const rows = await shiftsRepo.getRefundBreakdown(SHIFT, STORE_ID);

    expect(rows).toHaveLength(3);
    const byMethod = new Map(rows.map((r) => [r.method, r]));
    expect(byMethod.get("cash_usd")!.amountNativeUsdCents).toBe(500);
    expect(byMethod.get("card_usd")!.amountNativeUsdCents).toBe(500);
    expect(byMethod.get("cash_lbp")!.amountNativeLbp).toBe(447_500);
    expect(byMethod.get("cash_lbp")!.amountUsdCentsEquivalent).toBe(500);
    expect(rows.reduce((s, r) => s + r.amountUsdCentsEquivalent, 0)).toBe(1_500);
  });

  it("gives the same refund totals for a whole local day", async () => {
    shiftWithTradeAndRefunds();
    const day = await refundSummaryRepo.refundSummary({
      storeId: STORE_ID,
      date: "2026-03-01",
    });
    expect(day.memoCount).toBe(1);
    expect(day.totalInclVatCents).toBe(1_500);
    expect(day.vatTotalCents).toBe(149);
    expect(day.cogsReversedCents).toBe(600);

    // And nothing on another day.
    expect(
      (await refundSummaryRepo.refundSummary({ storeId: STORE_ID, date: "2026-03-02" }))
        .memoCount,
    ).toBe(0);
  });

  it("attributes a refund to its own shift, not to whichever is open", async () => {
    // A refund of yesterday's sale, processed in today's shift. Yesterday's
    // drawer is already counted and must not move.
    const yesterday = seedShift(db, { id: "shift-0", status: "closed" });
    const sale = insertSale(db, {
      postedAt: "2026-02-28T10:00:00.000Z",
      shiftId: yesterday,
      lines: [coffeeLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });
    const [item] = saleItemIds(db, sale);
    insertCreditMemo(db, {
      saleId: sale,
      postedAt: "2026-03-01T11:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: item,
          productId: COFFEE,
          quantityBase: 2,
          subtotalExclVat: 900,
          vat: 100,
          totalInclVat: 1_000,
          cogsReversed: 400,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });

    const old = await shiftsRepo.getDrawerExpectation(yesterday, STORE_ID);
    expect(old.cashUsdInCents).toBe(1_000);
    expect(old.refundUsdOutCents).toBe(0);

    const today = await shiftsRepo.getDrawerExpectation(SHIFT, STORE_ID);
    expect(today.cashUsdInCents).toBe(0);
    expect(today.refundUsdOutCents).toBe(1_000);
  });
});
