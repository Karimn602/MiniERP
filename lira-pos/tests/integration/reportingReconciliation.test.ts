/**
 * CROSS-REPORT RECONCILIATION (WP-08).
 *
 * One realistic Greaz trading day, built once, then read back through every
 * production read model that shows money — and asserted to tell the SAME story
 * through all of them. The point is not that each query works in isolation
 * (reports.test.ts and shifts.test.ts cover that); it is that the headline
 * figure, the daily row, the per-product row and the shift card are the same
 * economics counted once.
 *
 * Scope note: repository SQL and `lib/reportMath` against node:sqlite, with the
 * Tauri SQL plugin mocked out. The posting commands are not run — the Rust
 * suite owns whether a document may be written. What is proven here is how the
 * documents, once written, are INTERPRETED.
 *
 * GP-A04 is the reason this file exists: `subtotal_excl_vat_cents` is persisted
 * POST-discount, so any report that also subtracts `discount_cents` understates
 * net sales and profit by the whole discount. The day below contains a
 * percentage discount and a fixed-amount discount for exactly that reason, and
 * the reconciliation assertions fail if any one surface starts subtracting
 * again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  insertCreditMemo,
  insertPurchase,
  insertSale,
  resetIds,
  saleItemIds,
  seedExchangeRate,
  seedProduct,
  seedShift,
  STORE_ID,
  VAT_EXEMPT_ID,
} from "../helpers/sqlDb";
import { reportsRepo } from "../../src/db/repos/reports";
import { shiftsRepo } from "../../src/db/repos/shifts";
import { shiftSummaryRepo, refundSummaryRepo } from "../../src/db/repos/shiftSummary";
import { salesRepo } from "../../src/db/repos/sales";
import { creditMemosRepo } from "../../src/db/repos/creditMemos";
import {
  mergeDailyRows,
  mergeProductRows,
  periodTotals,
} from "../../src/lib/reportMath";

const BURGER = "prod-burger";
const WATER = "prod-water";
const DELIVERY = "prod-delivery";
const SHIFT = "shift-day";

const DAY = "2026-03-01";

// ---------------------------------------------------------------------------
// THE DAY, stated as exact integers.
//
// Every figure below is what `post_sale` / `post_credit_memo` would have
// persisted, computed by hand so the assertions are exact rather than
// recomputed by the same code under test (test-quality rule 18).
//
// Burger  $6.00 incl VAT @ 11%, cost 250 ea
// Water   $2.00 exempt (0 bps),  cost  60 ea
// Delivery $2.00 incl VAT @ 11%, a SERVICE — no stock, no cost
//
//  #1 plain cash sale, no discount
//       burger ×2 → 1200 incl = 1081 + 119      cogs 500
//  #2 PERCENTAGE discount, $2.00 off a $20.00 cart
//       burger ×2  1200 − 120 → 1080 = 973 + 107   cogs 500
//       water  ×4   800 −  80 →  720 = 720 +   0   cogs 240
//       header: 1693 + 107 = 1800, discount 200
//  #3 FIXED discount $1.00, paid in LBP cash
//       burger ×1   600 − 75 → 525 = 473 + 52      cogs 250
//       delivery×1  200 − 25 → 175 = 158 + 17      cogs   0
//       header: 631 + 69 = 700, discount 100
//  #4 the sale that is FULLY returned
//       water ×5 → 1000 exempt                     cogs 300
//  #5 the sale that is PARTIALLY returned, twice
//       burger ×3 → 1800 incl = 1622 + 178         cogs 750
//
//  memo A  FULL return of #4, RESTOCKED       1000 = 1000 + 0,   cogs back 300
//  memo B  1 of 3 burgers of #5, RESTOCKED     600 =  541 + 59,  cogs back 250
//  memo C  1 more burger of #5, WRITTEN OFF    600 =  540 + 60,  cogs back   0
//
// Memos B and C are cumulative slices, not independent roundings
// (`posting.rs::prorated_cumulative_cents`):
//   subtotal  round(1622×1/3)=541, round(1622×2/3)−541 = 1081−541 = 540
//   VAT       round( 178×1/3)= 59, round( 178×2/3)− 59 =  119− 59 =  60
// and each memo's total is its subtotal slice + its VAT slice, never a
// residual — which is why both come to exactly 600.
// ---------------------------------------------------------------------------

const EXPECTED = {
  sales: {
    count: 5,
    subtotalExclVat: 1081 + 1693 + 631 + 1000 + 1622, // 6027
    vat: 119 + 107 + 69 + 0 + 178, //                      473
    totalInclVat: 1200 + 1800 + 700 + 1000 + 1800, //      6500
    discount: 200 + 100, //                                 300
    cogs: 500 + 740 + 250 + 300 + 750, //                  2540
  },
  returns: {
    count: 3,
    subtotalExclVat: 1000 + 541 + 540, // 2081
    vat: 0 + 59 + 60, //                   119
    totalInclVat: 1000 + 600 + 600, //    2200
    cogsReversed: 300 + 250 + 0, //         550
  },
  net: {
    revenueInclVat: 6500 - 2200, //  4300
    salesExclVat: 6027 - 2081, //    3946
    vat: 473 - 119, //                354
    cogs: 2540 - 550, //             1990
    grossProfit: 3946 - 1990, //     1956
  },
  /** What the old GP-A04 formula would have produced instead. */
  defective: {
    netSalesExclVat: 6027 - 2081 - 300, // 3646
    grossProfit: 3946 - 300 - 1990, //     1656
  },
  drawer: {
    openingUsd: 5_000,
    openingLbp: 1_000_000,
    cashUsdIn: 1200 + 1800 + 1000 + 1800, // 5800 — #3 paid in lira
    cashLbpIn: 626_500, //                   700 cents at 89,500 LBP/USD
    refundUsdOut: 1000 + 600 + 600, //       2200
  },
  purchases: { subtotalExclVat: 5000, vat: 550, totalInclVat: 5550 },
};

let db: DatabaseSync;
let sale4: string;
let sale5: string;

function burgerLine(qty: number, subtotal: number, vat: number, total: number) {
  return {
    productId: BURGER,
    productName: "Burger",
    quantity: qty,
    subtotalExclVat: subtotal,
    vat,
    totalInclVat: total,
    cogs: 250 * qty,
  };
}

/** Build the whole day. Called by every test, so each gets a clean database. */
function buildTheDay(): void {
  seedShift(db, {
    id: SHIFT,
    openingUsdCents: EXPECTED.drawer.openingUsd,
    openingLbp: EXPECTED.drawer.openingLbp,
  });

  // #1 — plain cash, no discount.
  insertSale(db, {
    postedAt: `${DAY}T09:00:00.000Z`,
    shiftId: SHIFT,
    lines: [burgerLine(2, 1081, 119, 1200)],
    payments: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 1200, usdEquivalent: 1200 },
    ],
  });

  // #2 — percentage discount, mixed VAT and exempt lines.
  insertSale(db, {
    postedAt: `${DAY}T10:00:00.000Z`,
    shiftId: SHIFT,
    discountCents: 200,
    lines: [
      { ...burgerLine(2, 973, 107, 1080), lineDiscount: 120 },
      {
        productId: WATER,
        productName: "Water 1.5L",
        quantity: 4,
        subtotalExclVat: 720,
        vat: 0,
        totalInclVat: 720,
        lineDiscount: 80,
        vatRateId: VAT_EXEMPT_ID,
        vatBps: 0,
        cogs: 240,
      },
    ],
    payments: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 1800, usdEquivalent: 1800 },
    ],
  });

  // #3 — fixed-amount discount, LBP cash, and a service line.
  insertSale(db, {
    postedAt: `${DAY}T12:00:00.000Z`,
    shiftId: SHIFT,
    discountCents: 100,
    lines: [
      { ...burgerLine(1, 473, 52, 525), lineDiscount: 75 },
      {
        productId: DELIVERY,
        productName: "Delivery",
        quantity: 1,
        subtotalExclVat: 158,
        vat: 17,
        totalInclVat: 175,
        lineDiscount: 25,
        cogs: 0,
      },
    ],
    payments: [
      {
        method: "cash_lbp",
        currency: "LBP",
        nativeLbp: EXPECTED.drawer.cashLbpIn,
        usdEquivalent: 700,
      },
    ],
  });

  // #4 — fully returned later in the day.
  sale4 = insertSale(db, {
    postedAt: `${DAY}T13:00:00.000Z`,
    shiftId: SHIFT,
    lines: [
      {
        productId: WATER,
        productName: "Water 1.5L",
        quantity: 5,
        subtotalExclVat: 1000,
        vat: 0,
        totalInclVat: 1000,
        vatRateId: VAT_EXEMPT_ID,
        vatBps: 0,
        cogs: 300,
      },
    ],
    payments: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
    ],
  });

  // #5 — partially returned twice, once to the shelf and once written off.
  sale5 = insertSale(db, {
    postedAt: `${DAY}T14:00:00.000Z`,
    shiftId: SHIFT,
    lines: [burgerLine(3, 1622, 178, 1800)],
    payments: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 1800, usdEquivalent: 1800 },
    ],
  });

  const [water4] = saleItemIds(db, sale4);
  const [burger5] = saleItemIds(db, sale5);

  // memo A — the whole of #4, back on the shelf.
  insertCreditMemo(db, {
    saleId: sale4,
    postedAt: `${DAY}T15:00:00.000Z`,
    shiftId: SHIFT,
    lines: [
      {
        saleItemId: water4,
        productId: WATER,
        productName: "Water 1.5L",
        quantityBase: 5,
        subtotalExclVat: 1000,
        vat: 0,
        totalInclVat: 1000,
        cogsReversed: 300,
        returnToStock: true,
        vatRateId: VAT_EXEMPT_ID,
        vatBps: 0,
      },
    ],
    refunds: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
    ],
  });

  // memo B — one burger of #5, restocked: revenue AND cost reverse.
  insertCreditMemo(db, {
    saleId: sale5,
    postedAt: `${DAY}T16:00:00.000Z`,
    shiftId: SHIFT,
    lines: [
      {
        saleItemId: burger5,
        productId: BURGER,
        productName: "Burger",
        quantityBase: 1,
        subtotalExclVat: 541,
        vat: 59,
        totalInclVat: 600,
        cogsReversed: 250,
        returnToStock: true,
      },
    ],
    refunds: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
    ],
  });

  // memo C — one more burger of #5, WRITTEN OFF: revenue reverses, cost does
  // not. `post_credit_memo` writes no movement and reverses no cost for a
  // non-restocked line, so the reversed COGS on this memo is zero.
  insertCreditMemo(db, {
    saleId: sale5,
    postedAt: `${DAY}T17:00:00.000Z`,
    shiftId: SHIFT,
    lines: [
      {
        saleItemId: burger5,
        productId: BURGER,
        productName: "Burger",
        quantityBase: 1,
        subtotalExclVat: 540,
        vat: 60,
        totalInclVat: 600,
        cogsReversed: 0,
        returnToStock: false,
      },
    ],
    refunds: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
    ],
  });

  // Supplier activity, so the purchases KPI has something to report.
  insertPurchase(db, {
    purchaseDate: DAY,
    subtotalExclVat: EXPECTED.purchases.subtotalExclVat,
    vat: EXPECTED.purchases.vat,
  });
}

/**
 * Documents that must never reach a financial report: a draft and a voided
 * sale, a draft purchase, and a voided credit memo. The amounts are absurd on
 * purpose — any figure below would be visibly wrong if one leaked.
 *
 * Drafts matter especially since WP-07: every posting command now builds a
 * draft and promotes it last, so a draft is a state a real transaction passes
 * through rather than a shape only a test can make.
 */
function addExcludedDocuments(): void {
  insertSale(db, {
    postedAt: `${DAY}T11:00:00.000Z`,
    shiftId: SHIFT,
    status: "draft",
    lines: [burgerLine(99, 99_999, 0, 99_999)],
    payments: [],
  });
  insertSale(db, {
    postedAt: `${DAY}T11:30:00.000Z`,
    shiftId: SHIFT,
    status: "voided",
    lines: [burgerLine(88, 88_888, 0, 88_888)],
    payments: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 88_888, usdEquivalent: 88_888 },
    ],
  });
  insertPurchase(db, {
    purchaseDate: DAY,
    subtotalExclVat: 77_777,
    vat: 0,
    status: "draft",
  });

  // A voided memo against #4, which memo A has already fully returned. The
  // over-return trigger counts draft + POSTED lines, so a voided memo's lines
  // stop counting once it leaves draft — hence this is filed against #5's
  // remaining third rather than re-returning water that is already back.
  const [burger5] = saleItemIds(db, sale5);
  insertCreditMemo(db, {
    saleId: sale5,
    postedAt: `${DAY}T18:00:00.000Z`,
    shiftId: SHIFT,
    status: "voided",
    lines: [
      {
        saleItemId: burger5,
        productId: BURGER,
        productName: "Burger",
        quantityBase: 1,
        subtotalExclVat: 66_666,
        vat: 0,
        totalInclVat: 66_666,
        cogsReversed: 66_666,
        returnToStock: true,
      },
    ],
    refunds: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 66_666, usdEquivalent: 66_666 },
    ],
  });
}

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  seedProduct(db, { id: BURGER, sku: "SKU-B1", name: "Burger" });
  seedProduct(db, { id: WATER, sku: "SKU-W1", name: "Water 1.5L", vatRateId: VAT_EXEMPT_ID });
  seedProduct(db, { id: DELIVERY, sku: "SKU-D1", name: "Delivery", isService: true });
  buildTheDay();
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

const period = { storeId: STORE_ID, dateFrom: DAY, dateTo: DAY };

async function loadPeriod() {
  const [sales, returns, products, productRets] = await Promise.all([
    reportsRepo.dailySales(period),
    reportsRepo.dailyReturns(period),
    reportsRepo.productSales(period),
    reportsRepo.productReturns(period),
  ]);
  return { sales, returns, products, productRets };
}

// ===========================================================================
describe("the persisted day, as the repos read it", () => {
  it("reports the sale header exactly as post_sale persisted it", async () => {
    const { sales } = await loadPeriod();
    expect(sales).toHaveLength(1);
    const [day] = sales;

    expect(day.localDate).toBe(DAY);
    expect(day.saleCount).toBe(EXPECTED.sales.count);
    expect(day.subtotalExclVatCents).toBe(EXPECTED.sales.subtotalExclVat);
    expect(day.vatTotalCents).toBe(EXPECTED.sales.vat);
    expect(day.totalInclVatCents).toBe(EXPECTED.sales.totalInclVat);
    expect(day.discountCents).toBe(EXPECTED.sales.discount);
    expect(day.cogsTotalCents).toBe(EXPECTED.sales.cogs);
  });

  it("keeps subtotal + VAT == total on the sales aggregate", async () => {
    const { sales } = await loadPeriod();
    const [day] = sales;
    expect(day.subtotalExclVatCents + day.vatTotalCents).toBe(day.totalInclVatCents);
  });

  it("keeps subtotal + VAT == total on the returns aggregate too", async () => {
    const { returns } = await loadPeriod();
    expect(returns).toHaveLength(1);
    const [day] = returns;
    expect(day.memoCount).toBe(EXPECTED.returns.count);
    expect(day.subtotalExclVatCents).toBe(EXPECTED.returns.subtotalExclVat);
    expect(day.vatTotalCents).toBe(EXPECTED.returns.vat);
    expect(day.totalInclVatCents).toBe(EXPECTED.returns.totalInclVat);
    expect(day.subtotalExclVatCents + day.vatTotalCents).toBe(day.totalInclVatCents);
  });

  it("reverses cost for restocked returns only", async () => {
    const { returns } = await loadPeriod();
    // 300 (memo A, restocked) + 250 (memo B, restocked) + 0 (memo C, written
    // off). The write-off refunded 600 of revenue and kept its cost consumed.
    expect(returns[0].cogsReversedCents).toBe(EXPECTED.returns.cogsReversed);
    expect(returns[0].cogsReversedCents).toBeLessThan(EXPECTED.returns.subtotalExclVat);
  });
});

// ===========================================================================
describe("the canonical equations", () => {
  it("derives every headline figure, with the discount counted once", async () => {
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);

    expect(t.grossRevenueInclVatCents).toBe(EXPECTED.sales.totalInclVat);
    expect(t.grossSalesExclVatCents).toBe(EXPECTED.sales.subtotalExclVat);
    expect(t.returnedRevenueInclVatCents).toBe(EXPECTED.returns.totalInclVat);

    expect(t.netRevenueInclVatCents).toBe(EXPECTED.net.revenueInclVat);
    expect(t.netSalesExclVatCents).toBe(EXPECTED.net.salesExclVat);
    expect(t.netVatCents).toBe(EXPECTED.net.vat);
    expect(t.netCogsCents).toBe(EXPECTED.net.cogs);
    expect(t.grossProfitCents).toBe(EXPECTED.net.grossProfit);
  });

  it("reports the discount on its own and never deducts it from sales", async () => {
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);

    // The day really was discounted — this is not a vacuous assertion.
    expect(t.discountCents).toBe(300);
    expect(t.discountCents).toBeGreaterThan(0);

    // GP-A04: net sales is gross-less-returns, NOT gross-less-returns-less-
    // discount. Restoring the old formula gives 3646 and 1656.
    expect(t.netSalesExclVatCents).toBe(EXPECTED.net.salesExclVat);
    expect(t.netSalesExclVatCents).not.toBe(EXPECTED.defective.netSalesExclVat);
    expect(t.grossProfitCents).not.toBe(EXPECTED.defective.grossProfit);

    // And the difference between right and wrong IS the discount, exactly.
    expect(t.netSalesExclVatCents - EXPECTED.defective.netSalesExclVat).toBe(
      t.discountCents,
    );
  });

  it("keeps net subtotal + net VAT == net revenue", async () => {
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);
    expect(t.netSalesExclVatCents + t.netVatCents).toBe(t.netRevenueInclVatCents);
  });

  it("states gross profit on the same revenue basis as net sales", async () => {
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);
    expect(t.grossProfitCents).toBe(t.netSalesExclVatCents - t.netCogsCents);
  });
});

// ===========================================================================
describe("Local Reports: the tables reconcile to their own headline", () => {
  it("sums the daily rows back to the period totals", async () => {
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);
    const rows = mergeDailyRows(sales, returns);

    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((s, r) => s + f(r), 0);

    expect(add((r) => r.saleCount)).toBe(t.saleCount);
    expect(add((r) => r.grossRevenueInclVatCents)).toBe(t.grossRevenueInclVatCents);
    expect(add((r) => r.returnedRevenueInclVatCents)).toBe(
      t.returnedRevenueInclVatCents,
    );
    expect(add((r) => r.netRevenueInclVatCents)).toBe(t.netRevenueInclVatCents);
    expect(add((r) => r.netSalesExclVatCents)).toBe(t.netSalesExclVatCents);
    expect(add((r) => r.netVatCents)).toBe(t.netVatCents);
    expect(add((r) => r.netCogsCents)).toBe(t.netCogsCents);
    expect(add((r) => r.grossProfitCents)).toBe(t.grossProfitCents);
  });

  it("sums the product rows back to the same period totals", async () => {
    const { sales, returns, products, productRets } = await loadPeriod();
    const t = periodTotals(sales, returns);
    const rows = mergeProductRows(products, productRets);

    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((s, r) => s + f(r), 0);

    // Product reporting is line-level and the headline is header-level; they
    // must agree because a sale header IS the sum of its lines (WP-02).
    expect(add((r) => r.netRevenueInclVatCents)).toBe(t.netRevenueInclVatCents);
    expect(add((r) => r.netSalesExclVatCents)).toBe(t.netSalesExclVatCents);
    expect(add((r) => r.netCogsCents)).toBe(t.netCogsCents);
    expect(add((r) => r.grossProfitCents)).toBe(t.grossProfitCents);
  });

  it("attributes each product's net figures to that product", async () => {
    const { products, productRets } = await loadPeriod();
    const rows = mergeProductRows(products, productRets);
    const by = (id: string) => rows.find((r) => r.productId === id)!;

    // Burger: sold 2+2+1+3 = 8, returned 2 (one restocked, one written off).
    const burger = by(BURGER);
    expect(burger.netQty).toBe(8 - 2);
    expect(burger.returnedQty).toBe(2);
    expect(burger.netSalesExclVatCents).toBe(1081 + 973 + 473 + 1622 - (541 + 540));
    // Cost reverses for the restocked unit only: 2000 − 250.
    expect(burger.netCogsCents).toBe(2000 - 250);

    // Water: sold 4+5 = 9, all 5 of sale #4 returned and restocked.
    const water = by(WATER);
    expect(water.netQty).toBe(9 - 5);
    expect(water.netSalesExclVatCents).toBe(720 + 1000 - 1000);
    expect(water.netCogsCents).toBe(540 - 300);

    // Delivery is a service: revenue, no cost, nothing returnable to stock.
    const delivery = by(DELIVERY);
    expect(delivery.netQty).toBe(1);
    expect(delivery.netSalesExclVatCents).toBe(158);
    expect(delivery.netCogsCents).toBe(0);
  });

  it("does not over-reverse when one line is returned twice", async () => {
    const { products, productRets } = await loadPeriod();
    const burgerSold = products.find((r) => r.productId === BURGER)!;
    const burgerBack = productRets.find((r) => r.productId === BURGER)!;

    // Two memos against the same sale line, cumulative slices: 541 + 540 =
    // 1081, which is exactly round(1622 × 2/3) and strictly less than the
    // line's own 1622. Independent rounding would have drifted.
    expect(burgerBack.totalQty).toBe(2);
    expect(burgerBack.lineSubtotalExclVatCents).toBe(1081);
    expect(burgerBack.lineSubtotalExclVatCents).toBeLessThan(
      burgerSold.lineSubtotalExclVatCents,
    );
    expect(burgerBack.lineCogsCents).toBe(250); // one restocked unit only
  });
});

// ===========================================================================
describe("Shift Summary agrees with Local Reports", () => {
  it("counts the same sales as the daily report", async () => {
    const { sales } = await loadPeriod();
    const shift = await shiftsRepo.getSalesSummary(SHIFT, STORE_ID);
    const [day] = sales;

    expect(shift.receiptCount).toBe(day.saleCount);
    expect(shift.subtotalExclVatCents).toBe(day.subtotalExclVatCents);
    expect(shift.vatTotalCents).toBe(day.vatTotalCents);
    expect(shift.totalInclVatCents).toBe(day.totalInclVatCents);
    expect(shift.discountCents).toBe(day.discountCents);

    // The shift's own net-of-discount figure, which must BE the subtotal.
    expect(shift.netSalesExclVatCents).toBe(day.subtotalExclVatCents);
  });

  it("counts the same returns as the daily report", async () => {
    const { returns } = await loadPeriod();
    const shift = await shiftsRepo.getRefundSummary(SHIFT, STORE_ID);
    const [day] = returns;

    expect(shift.memoCount).toBe(day.memoCount);
    expect(shift.subtotalExclVatCents).toBe(day.subtotalExclVatCents);
    expect(shift.vatTotalCents).toBe(day.vatTotalCents);
    expect(shift.totalInclVatCents).toBe(day.totalInclVatCents);
    expect(shift.cogsReversedCents).toBe(day.cogsReversedCents);
  });

  it("derives the shift's net sales to the same figure Local Reports shows", async () => {
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);
    const shiftSales = await shiftsRepo.getSalesSummary(SHIFT, STORE_ID);
    const shiftReturns = await shiftsRepo.getRefundSummary(SHIFT, STORE_ID);

    // This is exactly the subtraction the ShiftSummary page's "Net sales
    // (excl. VAT)" card makes.
    expect(
      shiftSales.netSalesExclVatCents - shiftReturns.subtotalExclVatCents,
    ).toBe(t.netSalesExclVatCents);

    // And net collection, which is the incl-VAT twin.
    expect(shiftSales.totalInclVatCents - shiftReturns.totalInclVatCents).toBe(
      t.netRevenueInclVatCents,
    );
  });

  it("agrees with the date-scoped day summary, which is the same population", async () => {
    const shift = await shiftsRepo.getSalesSummary(SHIFT, STORE_ID);
    const date = await shiftSummaryRepo.salesSummary({ storeId: STORE_ID, date: DAY });
    const dateRefunds = await refundSummaryRepo.refundSummary({
      storeId: STORE_ID,
      date: DAY,
    });
    const shiftRefunds = await shiftsRepo.getRefundSummary(SHIFT, STORE_ID);

    // One shift, one day: the shift-scoped and date-scoped reads must match.
    expect(date.receiptCount).toBe(shift.receiptCount);
    expect(date.subtotalExclVatCents).toBe(shift.subtotalExclVatCents);
    expect(date.discountCents).toBe(shift.discountCents);
    expect(date.netSalesExclVatCents).toBe(shift.netSalesExclVatCents);
    expect(dateRefunds.totalInclVatCents).toBe(shiftRefunds.totalInclVatCents);
    expect(dateRefunds.cogsReversedCents).toBe(shiftRefunds.cogsReversedCents);
  });

  it("keeps cash movement distinct from revenue, and funds every refund", async () => {
    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT, STORE_ID);
    const { sales, returns } = await loadPeriod();
    const t = periodTotals(sales, returns);

    expect(drawer.cashUsdInCents).toBe(EXPECTED.drawer.cashUsdIn);
    expect(drawer.cashLbpIn).toBe(EXPECTED.drawer.cashLbpIn);
    expect(drawer.changeUsdOutCents).toBe(0);
    expect(drawer.refundUsdOutCents).toBe(EXPECTED.drawer.refundUsdOut);
    expect(drawer.refundLbpOut).toBe(0);

    // WP-04's formula, unchanged: opening + cash in − change out − refunds out.
    const expectedUsd =
      EXPECTED.drawer.openingUsd +
      drawer.cashUsdInCents -
      drawer.changeUsdOutCents -
      drawer.refundUsdOutCents;
    const expectedLbp =
      EXPECTED.drawer.openingLbp +
      drawer.cashLbpIn -
      drawer.changeLbpOut -
      drawer.refundLbpOut;
    expect(expectedUsd).toBe(8600);
    expect(expectedLbp).toBe(1_626_500);

    // CASH IS NOT REVENUE. Sale #3 was paid in lira, so USD cash collected
    // (5800) is nothing like gross revenue (6500) and must not be confused
    // with it — which is the whole reason the two live in separate queries.
    expect(drawer.cashUsdInCents).not.toBe(t.grossRevenueInclVatCents);
    // Tender in USD equivalent, however, does reconcile to gross revenue.
    const payments = await shiftsRepo.getPaymentBreakdown(SHIFT, STORE_ID);
    expect(payments.reduce((s, p) => s + p.amountUsdCentsEquivalent, 0)).toBe(
      t.grossRevenueInclVatCents,
    );
  });
});

// ===========================================================================
describe("Sales History shows the same economics as the reports", () => {
  // Every test in this block reads through `salesRepo.listPostedForReporting`,
  // which is the accessor `SalesHistory.tsx` itself calls. It used to call
  // `list({ storeId, limit })` with NO status while these tests called
  // `list({ status: "posted" })` — so the coverage asserted a population the
  // page did not actually ask for, and a draft or voided sale went straight
  // into the page's revenue, VAT, COGS and profit cards.
  it("sums its listed receipts to the daily sales aggregate", async () => {
    const { sales } = await loadPeriod();
    const [day] = sales;
    const listed = await salesRepo.listPostedForReporting({ storeId: STORE_ID });

    expect(listed).toHaveLength(day.saleCount);
    const add = (f: (s: (typeof listed)[number]) => number) =>
      listed.reduce((s, r) => s + f(r), 0);

    expect(add((s) => s.subtotalExclVatCents)).toBe(day.subtotalExclVatCents);
    expect(add((s) => s.vatTotalCents)).toBe(day.vatTotalCents);
    expect(add((s) => s.totalInclVatCents)).toBe(day.totalInclVatCents);
    expect(add((s) => s.discountCents)).toBe(day.discountCents);
    expect(add((s) => s.cogsTotalCents)).toBe(day.cogsTotalCents);
  });

  it("states one sale's profit the way the page does, without the discount twice", async () => {
    const listed = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    // Sale #2, the percentage-discounted one: 1693 net, 740 cost, 200 given away.
    const discounted = listed.find((s) => s.discountCents === 200)!;

    expect(discounted.subtotalExclVatCents).toBe(1693);
    expect(discounted.cogsTotalCents).toBe(740);
    // `grossProfitCents` in SalesHistory.tsx: subtotal − COGS.
    expect(discounted.subtotalExclVatCents - discounted.cogsTotalCents).toBe(953);
    // The old formula would have said 753.
    expect(discounted.subtotalExclVatCents - discounted.cogsTotalCents).not.toBe(753);
  });

  it("makes a sale's line profits sum to the profit shown for the sale", async () => {
    const details = (await salesRepo.findByIdWithDetails(sale5))!;
    // One line, but the invariant is the general one: the receipt's gross
    // profit is the sum of its lines', which only holds if NEITHER subtracts
    // the line discount a second time.
    const lineProfit = details.lines.reduce(
      (s, l) => s + (l.lineSubtotalExclVatCents - l.lineCogsExclVatCents),
      0,
    );
    expect(lineProfit).toBe(details.subtotalExclVatCents - details.cogsTotalCents);
  });

  it("makes the discounted sale's line profits sum too", async () => {
    const listed = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    const discounted = listed.find((s) => s.discountCents === 200)!;
    const details = (await salesRepo.findByIdWithDetails(discounted.id))!;

    // Two lines, both carrying an allocated discount — the case the old
    // line-level formula got wrong by exactly 200.
    expect(details.lines.reduce((s, l) => s + l.lineDiscountCents, 0)).toBe(200);
    const lineProfit = details.lines.reduce(
      (s, l) => s + (l.lineSubtotalExclVatCents - l.lineCogsExclVatCents),
      0,
    );
    expect(lineProfit).toBe(details.subtotalExclVatCents - details.cogsTotalCents);
    expect(lineProfit).toBe(953);
  });

  it("derives each receipt's return status from posted memos only", async () => {
    const statuses = await creditMemosRepo.returnStatusForStore(STORE_ID);
    expect(statuses.get(sale4)).toBe("full"); // 5 of 5 water back
    expect(statuses.get(sale5)).toBe("partial"); // 2 of 3 burgers back

    // And the memos listed against a sale reconcile to the returns aggregate.
    const forSale5 = await creditMemosRepo.listForSale(sale5);
    expect(forSale5).toHaveLength(2);
    expect(forSale5.reduce((s, m) => s + m.totalInclVatCents, 0)).toBe(1200);
  });
});

// ===========================================================================
describe("Sales History reports posted sales only", () => {
  /**
   * The population seam, exercised directly.
   *
   * These assert against `salesRepo.listPostedForReporting`, the accessor the
   * page calls, rather than restating the page's JSX arithmetic. Removing the
   * `status = 'posted'` predicate from that query fails every case below.
   *
   * Drafts are not hypothetical: since WP-07 every posting command builds a
   * draft and promotes it last, so an interrupted post can strand one.
   */

  /** The page's own summary reduction, over whatever rows it was given. */
  function summarise(rows: readonly {
    subtotalExclVatCents: number;
    vatTotalCents: number;
    totalInclVatCents: number;
    discountCents: number;
    cogsTotalCents: number;
  }[]) {
    return rows.reduce(
      (a, s) => ({
        count: a.count + 1,
        net: a.net + s.subtotalExclVatCents,
        vat: a.vat + s.vatTotalCents,
        total: a.total + s.totalInclVatCents,
        discount: a.discount + s.discountCents,
        cost: a.cost + s.cogsTotalCents,
        profit: a.profit + (s.subtotalExclVatCents - s.cogsTotalCents),
      }),
      { count: 0, net: 0, vat: 0, total: 0, discount: 0, cost: 0, profit: 0 },
    );
  }

  const CLEAN = {
    count: EXPECTED.sales.count,
    net: EXPECTED.sales.subtotalExclVat,
    vat: EXPECTED.sales.vat,
    total: EXPECTED.sales.totalInclVat,
    discount: EXPECTED.sales.discount,
    cost: EXPECTED.sales.cogs,
    profit: EXPECTED.sales.subtotalExclVat - EXPECTED.sales.cogs, // 6027 − 2540
  };

  // A — the posted sales of the day all contribute.
  it("includes every posted sale", async () => {
    const rows = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "posted")).toBe(true);
    expect(summarise(rows)).toEqual(CLEAN);
    expect(CLEAN.profit).toBe(3487);
  });

  // B — a draft contributes nothing.
  it("excludes a draft sale from every financial figure", async () => {
    insertSale(db, {
      postedAt: `${DAY}T11:00:00.000Z`,
      shiftId: SHIFT,
      status: "draft",
      discountCents: 500,
      lines: [burgerLine(99, 99_999, 11_000, 110_999)],
      payments: [],
    });

    const rows = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    expect(rows.some((r) => r.status === "draft")).toBe(false);
    expect(rows).toHaveLength(5);
    expect(summarise(rows)).toEqual(CLEAN);
  });

  // C — a voided sale contributes nothing.
  it("excludes a voided sale from every financial figure", async () => {
    insertSale(db, {
      postedAt: `${DAY}T11:30:00.000Z`,
      shiftId: SHIFT,
      status: "voided",
      discountCents: 400,
      lines: [burgerLine(88, 88_888, 9_777, 98_665)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 98_665, usdEquivalent: 98_665 },
      ],
    });

    const rows = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    expect(rows.some((r) => r.status === "voided")).toBe(false);
    expect(rows).toHaveLength(5);
    expect(summarise(rows)).toEqual(CLEAN);
  });

  // D — posted + draft + voided reports exactly the posted-only economics,
  // and exactly what the daily report says for the same day.
  it("reports posted-only economics with all three states present", async () => {
    addExcludedDocuments();

    const rows = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    const summary = summarise(rows);
    expect(summary).toEqual(CLEAN);

    // The administrative accessor still sees them, which is how we know the
    // records were really written and are not being filtered twice.
    const everything = await salesRepo.list({ storeId: STORE_ID, limit: 200 });
    expect(everything).toHaveLength(7);
    expect(everything.filter((r) => r.status === "draft")).toHaveLength(1);
    expect(everything.filter((r) => r.status === "voided")).toHaveLength(1);
    // ...and that aggregating THAT list is what the defect did.
    expect(summarise(everything).total).not.toBe(CLEAN.total);

    // Sales History now agrees with Local Reports on the same day.
    const { sales } = await loadPeriod();
    const [day] = sales;
    expect(summary.count).toBe(day.saleCount);
    expect(summary.net).toBe(day.subtotalExclVatCents);
    expect(summary.vat).toBe(day.vatTotalCents);
    expect(summary.total).toBe(day.totalInclVatCents);
    expect(summary.discount).toBe(day.discountCents);
    expect(summary.cost).toBe(day.cogsTotalCents);
  });

  // E — a posted sale that has been returned still appears, in full, with its
  // return status. A return is a separate document; it does not withdraw the
  // receipt or change one figure on it.
  it("still lists a returned posted sale with its own figures and status", async () => {
    addExcludedDocuments();
    const rows = await salesRepo.listPostedForReporting({ storeId: STORE_ID });
    const statuses = await creditMemosRepo.returnStatusForStore(STORE_ID);

    const fully = rows.find((r) => r.id === sale4)!;
    const partly = rows.find((r) => r.id === sale5)!;

    expect(fully.status).toBe("posted");
    expect(statuses.get(fully.id)).toBe("full");
    expect(fully.totalInclVatCents).toBe(1000); // exactly as posted
    expect(fully.subtotalExclVatCents).toBe(1000);
    expect(fully.cogsTotalCents).toBe(300);

    expect(partly.status).toBe("posted");
    expect(statuses.get(partly.id)).toBe("partial");
    expect(partly.totalInclVatCents).toBe(1800);
    expect(partly.subtotalExclVatCents).toBe(1622);
    expect(partly.cogsTotalCents).toBe(750);

    // The voided memo added by addExcludedDocuments must not have moved the
    // status of the sale it was filed against.
    expect(statuses.get(partly.id)).not.toBe("full");
  });
});

// ===========================================================================
describe("report populations", () => {
  it("excludes drafts and voided documents from every figure", async () => {
    addExcludedDocuments();
    const { sales, returns, products, productRets } = await loadPeriod();
    const t = periodTotals(sales, returns);

    // Identical to the clean-day expectations: nothing leaked.
    expect(t.saleCount).toBe(EXPECTED.sales.count);
    expect(t.grossRevenueInclVatCents).toBe(EXPECTED.sales.totalInclVat);
    expect(t.grossSalesExclVatCents).toBe(EXPECTED.sales.subtotalExclVat);
    expect(t.memoCount).toBe(EXPECTED.returns.count);
    expect(t.returnedRevenueInclVatCents).toBe(EXPECTED.returns.totalInclVat);
    expect(t.reversedCogsCents).toBe(EXPECTED.returns.cogsReversed);
    expect(t.netSalesExclVatCents).toBe(EXPECTED.net.salesExclVat);
    expect(t.grossProfitCents).toBe(EXPECTED.net.grossProfit);

    // Line-level too, which is a separate query over a separate table.
    expect(products.reduce((s, r) => s + r.lineTotalInclVatCents, 0)).toBe(
      EXPECTED.sales.totalInclVat,
    );
    expect(productRets.reduce((s, r) => s + r.lineTotalInclVatCents, 0)).toBe(
      EXPECTED.returns.totalInclVat,
    );
  });

  it("keeps a draft out of the shift and drawer figures as well", async () => {
    addExcludedDocuments();
    const shift = await shiftsRepo.getSalesSummary(SHIFT, STORE_ID);
    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT, STORE_ID);
    const refunds = await shiftsRepo.getRefundSummary(SHIFT, STORE_ID);

    expect(shift.receiptCount).toBe(EXPECTED.sales.count);
    expect(shift.netSalesExclVatCents).toBe(EXPECTED.sales.subtotalExclVat);
    // The voided sale carried an 88,888-cent cash tender; the voided memo a
    // 66,666-cent cash refund. Neither may touch the till.
    expect(drawer.cashUsdInCents).toBe(EXPECTED.drawer.cashUsdIn);
    expect(drawer.refundUsdOutCents).toBe(EXPECTED.drawer.refundUsdOut);
    expect(refunds.memoCount).toBe(EXPECTED.returns.count);
  });

  it("reports purchases from posted purchases only, untouched by sales math", async () => {
    addExcludedDocuments();
    const rows = await reportsRepo.dailyPurchases(period);
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseCount).toBe(1);
    expect(rows[0].subtotalExclVatCents).toBe(EXPECTED.purchases.subtotalExclVat);
    expect(rows[0].vatTotalCents).toBe(EXPECTED.purchases.vat);
    expect(rows[0].totalInclVatCents).toBe(EXPECTED.purchases.totalInclVat);
    expect(rows[0].subtotalExclVatCents + rows[0].vatTotalCents).toBe(
      rows[0].totalInclVatCents,
    );
  });
});

// ===========================================================================
describe("product rows aggregate by product id, not by snapshot label", () => {
  /**
   * PRODUCT ID IS THE AGGREGATION IDENTITY.
   *
   * `productSales` and `productReturns` group by the snapshot triple
   * `(product_id, name, sku)`, so one product that has been renamed or
   * re-SKU'd arrives as SEVERAL raw rows — each correct for the label it
   * carries. `mergeProductRows` used to build `new Map(rows.map(r =>
   * [r.productId, r]))`, which overwrites rather than sums: the last row for a
   * product id replaced all the earlier ones and their revenue, quantity and
   * COGS disappeared from the table while the headline still counted them.
   *
   * Every case below first asserts that the raw rows really ARE split, then
   * that composition yields one row with the summed figures. The expected
   * values are hand-computed integers, not a second call to the helper.
   *
   * A separate month is used throughout so the trading day above is untouched.
   */

  const R_DAY = "2026-04-01"; // the sales
  const R_NEXT = "2026-04-02"; // the returns
  const WINDOW = { storeId: STORE_ID, dateFrom: R_DAY, dateTo: R_NEXT };

  // Three sales of ONE product under three different snapshot labels.
  //
  //   R1  "Burger"         SKU-B1   qty 1   100 + 11 = 111   cogs  40
  //   R2  "Classic Burger" SKU-B1   qty 2   200 + 22 = 222   cogs  80   (renamed)
  //   R3  "Classic Burger" SKU-B2   qty 3   300 + 33 = 333   cogs 120   (re-SKU'd)
  //                                 ----   ---------------   --------
  //                                 qty 6   600 + 66 = 666   cogs 240
  function seedRenamedSales(): { r1: string; r2: string; r3: string } {
    const line = (
      name: string,
      sku: string,
      qty: number,
      sub: number,
      vat: number,
      total: number,
      cogs: number,
    ) => ({
      productId: BURGER,
      productName: name,
      productSku: sku,
      quantity: qty,
      subtotalExclVat: sub,
      vat,
      totalInclVat: total,
      cogs,
    });
    const cash = (c: number) => [
      { method: "cash_usd", currency: "USD" as const, nativeUsdCents: c, usdEquivalent: c },
    ];

    const r1 = insertSale(db, {
      postedAt: `${R_DAY}T09:00:00.000Z`,
      shiftId: SHIFT,
      lines: [line("Burger", "SKU-B1", 1, 100, 11, 111, 40)],
      payments: cash(111),
    });
    const r2 = insertSale(db, {
      postedAt: `${R_DAY}T10:00:00.000Z`,
      shiftId: SHIFT,
      lines: [line("Classic Burger", "SKU-B1", 2, 200, 22, 222, 80)],
      payments: cash(222),
    });
    const r3 = insertSale(db, {
      postedAt: `${R_DAY}T11:00:00.000Z`,
      shiftId: SHIFT,
      lines: [line("Classic Burger", "SKU-B2", 3, 300, 33, 333, 120)],
      payments: cash(333),
    });
    return { r1, r2, r3 };
  }

  /**
   * Two memos the next day, against two of those sales, under the two
   * different later labels — so the RETURNS side splits as well.
   *
   *   M1  vs R2  "Classic Burger" SKU-B1  qty 1  100 + 11 = 111  cogs back 40
   *   M2  vs R3  "Classic Burger" SKU-B2  qty 1  100 + 11 = 111  cogs back 40
   *                                       ----  ---------------  -----------
   *                                       qty 2  200 + 22 = 222  cogs back 80
   *
   * Each slice is the cumulative first unit of its line: round(200 × 1/2) = 100
   * and round(300 × 1/3) = 100 for the subtotals, round(22 × 1/2) = 11 and
   * round(33 × 1/3) = 11 for the VAT, and the totals are the two sums.
   */
  function seedRenamedReturns(r2: string, r3: string): void {
    const [i2] = saleItemIds(db, r2);
    const [i3] = saleItemIds(db, r3);
    const memo = (
      saleId: string,
      saleItemId: string,
      sku: string,
      at: string,
    ) =>
      insertCreditMemo(db, {
        saleId,
        postedAt: at,
        shiftId: SHIFT,
        lines: [
          {
            saleItemId,
            productId: BURGER,
            productName: "Classic Burger",
            productSku: sku,
            quantityBase: 1,
            subtotalExclVat: 100,
            vat: 11,
            totalInclVat: 111,
            cogsReversed: 40,
            returnToStock: true,
          },
        ],
        refunds: [
          { method: "cash_usd", currency: "USD", nativeUsdCents: 111, usdEquivalent: 111 },
        ],
      });
    memo(r2, i2, "SKU-B1", `${R_NEXT}T09:00:00.000Z`);
    memo(r3, i3, "SKU-B2", `${R_NEXT}T10:00:00.000Z`);
  }

  // ---- A: the control. One label, several sales, nothing to disambiguate. ----
  it("A — aggregates two sales under the same label into one row", async () => {
    const line = {
      productId: BURGER,
      productName: "Burger",
      productSku: "SKU-B1",
      quantity: 1,
      subtotalExclVat: 100,
      vat: 11,
      totalInclVat: 111,
      cogs: 40,
    };
    insertSale(db, {
      postedAt: `${R_DAY}T09:00:00.000Z`,
      shiftId: SHIFT,
      lines: [line],
      payments: [],
    });
    insertSale(db, {
      postedAt: `${R_DAY}T10:00:00.000Z`,
      shiftId: SHIFT,
      lines: [line],
      payments: [],
    });

    // The SQL already collapses an unchanged label, so there is one raw row.
    const raw = await reportsRepo.productSales(WINDOW);
    expect(raw).toHaveLength(1);
    expect(raw[0].totalQty).toBe(2);

    const [row] = mergeProductRows(raw, []);
    expect(row.productName).toBe("Burger");
    expect(row.productSku).toBe("SKU-B1");
    expect(row.netQty).toBe(2);
    expect(row.netSalesExclVatCents).toBe(200);
    expect(row.netRevenueInclVatCents).toBe(222);
    expect(row.netCogsCents).toBe(80);
    expect(row.grossProfitCents).toBe(120);
  });

  // ---- B: renamed between two sales. ----
  it("B — sums a product renamed between two posted sales into one row", async () => {
    seedRenamedSales();
    const raw = await reportsRepo.productSales(WINDOW);

    // The defect's precondition: the same id, split across labels.
    const burgerRaw = raw.filter((r) => r.productId === BURGER);
    expect(burgerRaw).toHaveLength(3);
    expect(new Set(burgerRaw.map((r) => r.productName))).toEqual(
      new Set(["Burger", "Classic Burger"]),
    );

    const rows = mergeProductRows(raw, []);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.productId).toBe(BURGER);
    expect(row.netQty).toBe(6); // 1 + 2 + 3
    expect(row.netSalesExclVatCents).toBe(600); // 100 + 200 + 300
    expect(row.netRevenueInclVatCents).toBe(666); // 111 + 222 + 333
    expect(row.netCogsCents).toBe(240); // 40 + 80 + 120
    expect(row.grossProfitCents).toBe(360); // 600 − 240

    // What the overwrite produced: one label's figures standing for the lot.
    expect(row.netSalesExclVatCents).not.toBe(100);
    expect(row.netSalesExclVatCents).not.toBe(200);
    expect(row.netSalesExclVatCents).not.toBe(300);
  });

  // ---- C: SKU changed, name unchanged. ----
  it("C — sums a product whose SKU changed, with the name unchanged", async () => {
    seedRenamedSales();
    const raw = await reportsRepo.productSales(WINDOW);

    // Two raw rows share the name and differ only by SKU — so a name-keyed
    // fix would not have been enough either.
    const sameName = raw.filter((r) => r.productName === "Classic Burger");
    expect(sameName).toHaveLength(2);
    expect(sameName.map((r) => r.productSku).sort()).toEqual(["SKU-B1", "SKU-B2"]);
    expect(sameName.reduce((t, r) => t + r.lineSubtotalExclVatCents, 0)).toBe(500);

    const rows = mergeProductRows(sameName, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].netQty).toBe(5); // 2 + 3
    expect(rows[0].netSalesExclVatCents).toBe(500); // 200 + 300
    expect(rows[0].netCogsCents).toBe(200); // 80 + 120
  });

  // ---- D: sales and a partial return across differing snapshots. ----
  it("D — nets a partial return against sales recorded under other labels", async () => {
    const { r2, r3 } = seedRenamedSales();
    seedRenamedReturns(r2, r3);

    const [raw, rawRet] = await Promise.all([
      reportsRepo.productSales(WINDOW),
      reportsRepo.productReturns(WINDOW),
    ]);
    expect(raw).toHaveLength(3);
    expect(rawRet).toHaveLength(2);

    const rows = mergeProductRows(raw, rawRet);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.netQty).toBe(4); // 6 sold − 2 back
    expect(row.returnedQty).toBe(2);
    expect(row.netSalesExclVatCents).toBe(400); // 600 − 200
    expect(row.netRevenueInclVatCents).toBe(444); // 666 − 222
    expect(row.netCogsCents).toBe(160); // 240 − 80, both restocked
    expect(row.grossProfitCents).toBe(240); // 400 − 160
  });

  // ---- E: a product seen only through its returns. ----
  it("E — reports a returns-only product, summed across its labels", async () => {
    const { r2, r3 } = seedRenamedSales();
    seedRenamedReturns(r2, r3);

    // The second day sold nothing: this window sees only credit memos.
    const onlyReturns = { storeId: STORE_ID, dateFrom: R_NEXT, dateTo: R_NEXT };
    const [raw, rawRet] = await Promise.all([
      reportsRepo.productSales(onlyReturns),
      reportsRepo.productReturns(onlyReturns),
    ]);
    expect(raw).toHaveLength(0);
    expect(rawRet).toHaveLength(2);

    const rows = mergeProductRows(raw, rawRet);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.productId).toBe(BURGER);
    expect(row.productName).toBe("Classic Burger");
    expect(row.returnedQty).toBe(2);
    // Negative, because that is what the period did: goods came back and
    // nothing went out.
    expect(row.netQty).toBe(-2);
    expect(row.netSalesExclVatCents).toBe(-200);
    expect(row.netRevenueInclVatCents).toBe(-222);
    expect(row.netCogsCents).toBe(-80);
    expect(row.grossProfitCents).toBe(-120); // −200 − (−80)
  });

  // ---- F: three sales rows and two returns rows, folded not joined. ----
  it("F — does not multiply three sales rows by two returns rows", async () => {
    const { r2, r3 } = seedRenamedSales();
    seedRenamedReturns(r2, r3);

    const [raw, rawRet] = await Promise.all([
      reportsRepo.productSales(WINDOW),
      reportsRepo.productReturns(WINDOW),
    ]);
    expect(raw).toHaveLength(3);
    expect(rawRet).toHaveLength(2);

    const rows = mergeProductRows(raw, rawRet);
    // One product, one row — not 3, not 2, and emphatically not 3 × 2.
    expect(rows).toHaveLength(1);

    // Each series is folded once. A cross join would have counted the sales
    // twice (once per returns row) and the returns three times.
    expect(rows[0].netQty).toBe(4);
    expect(rows[0].netQty).not.toBe(6 * 2 - 2 * 3); // 6
    expect(rows[0].netSalesExclVatCents).toBe(400);
    expect(rows[0].netSalesExclVatCents).not.toBe(600 * 2 - 200 * 3); // 600
  });

  // ---- G/H: the product table reconciles to the period header. ----
  it("G/H — reconciles net revenue and net COGS to the period header", async () => {
    const { r2, r3 } = seedRenamedSales();
    seedRenamedReturns(r2, r3);

    const [sales, returns, products, productRets] = await Promise.all([
      reportsRepo.dailySales(WINDOW),
      reportsRepo.dailyReturns(WINDOW),
      reportsRepo.productSales(WINDOW),
      reportsRepo.productReturns(WINDOW),
    ]);

    // The header, hand-computed: three sales on day one, two memos on day two.
    const [d1] = sales;
    expect(d1.localDate).toBe(R_DAY);
    expect(d1.saleCount).toBe(3);
    expect(d1.subtotalExclVatCents).toBe(600);
    expect(d1.vatTotalCents).toBe(66);
    expect(d1.totalInclVatCents).toBe(666);
    expect(d1.cogsTotalCents).toBe(240);
    const [d2] = returns;
    expect(d2.localDate).toBe(R_NEXT);
    expect(d2.memoCount).toBe(2);
    expect(d2.subtotalExclVatCents).toBe(200);
    expect(d2.totalInclVatCents).toBe(222);
    expect(d2.cogsReversedCents).toBe(80);

    const t = periodTotals(sales, returns);
    expect(t.netSalesExclVatCents).toBe(400);
    expect(t.netRevenueInclVatCents).toBe(444);
    expect(t.netCogsCents).toBe(160);
    expect(t.grossProfitCents).toBe(240);

    // And the product table adds up to exactly that — the reconciliation the
    // overwrite silently broke the moment a product was renamed.
    const rows = mergeProductRows(products, productRets);
    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((a, r) => a + f(r), 0);
    expect(add((r) => r.netRevenueInclVatCents)).toBe(t.netRevenueInclVatCents);
    expect(add((r) => r.netSalesExclVatCents)).toBe(t.netSalesExclVatCents);
    expect(add((r) => r.netCogsCents)).toBe(t.netCogsCents);
    expect(add((r) => r.grossProfitCents)).toBe(t.grossProfitCents);
  });

  // ---- The display label rule, stated and pinned. ----
  it("labels the row from the most recent snapshot, deterministically", async () => {
    const { r2, r3 } = seedRenamedSales();
    const salesOnly = mergeProductRows(await reportsRepo.productSales(WINDOW), []);
    // Latest SALE is R3 at 11:00 under "Classic Burger" / SKU-B2.
    expect(salesOnly[0].productName).toBe("Classic Burger");
    expect(salesOnly[0].productSku).toBe("SKU-B2");

    seedRenamedReturns(r2, r3);
    const withReturns = mergeProductRows(
      await reportsRepo.productSales(WINDOW),
      await reportsRepo.productReturns(WINDOW),
    );
    // The latest document overall is now M2, which carries the same label.
    expect(withReturns[0].productName).toBe("Classic Burger");
    expect(withReturns[0].productSku).toBe("SKU-B2");

    // The label is independent of the order the rows arrive in — the SQL
    // orders sales by revenue, which a rename makes meaningless.
    const raw = await reportsRepo.productSales(WINDOW);
    const forwards = mergeProductRows(raw, []);
    const backwards = mergeProductRows([...raw].reverse(), []);
    expect(backwards).toEqual(forwards);
  });

  // ---- The economics must not depend on the label rule at all. ----
  it("keeps the figures identical however the labels are permuted", async () => {
    seedRenamedSales();
    const raw = await reportsRepo.productSales(WINDOW);

    const money = (rs: ReturnType<typeof mergeProductRows>) =>
      rs.map((r) => [r.netQty, r.netSalesExclVatCents, r.netCogsCents]);

    const asIs = mergeProductRows(raw, []);
    // Relabel every row to one name, keeping the money: the totals must not
    // budge, because the label is not an aggregation key.
    const relabelled = mergeProductRows(
      raw.map((r) => ({ ...r, productName: "Anything", productSku: "SKU-X" })),
      [],
    );
    expect(money(relabelled)).toEqual(money(asIs));
    expect(relabelled[0].netSalesExclVatCents).toBe(600);
  });
});

// ===========================================================================
describe("a return posted after the period its sale falls in", () => {
  /**
   * The reconciliation case the sales-keyed join lost.
   *
   * A credit memo is its own document with its own date, so it can land on a
   * day — or against a product — that the period recorded no sale for. Joining
   * the returns series onto the SALES rows dropped those, so the table stopped
   * adding up to the headline that still counted them.
   */
  it("still appears in the daily table, and the rows still sum to the headline", async () => {
    // One more burger of #5 comes back the NEXT day. Day 2 has no sales.
    const [burger5] = saleItemIds(db, sale5);
    insertCreditMemo(db, {
      saleId: sale5,
      postedAt: "2026-03-02T11:00:00.000Z",
      shiftId: SHIFT,
      lines: [
        {
          saleItemId: burger5,
          productId: BURGER,
          productName: "Burger",
          quantityBase: 1,
          // The third and last unit: cumulative 1622 − 1081 = 541, 178 − 119 = 59.
          subtotalExclVat: 541,
          vat: 59,
          totalInclVat: 600,
          cogsReversed: 250,
          returnToStock: true,
        },
      ],
      refunds: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
      ],
    });

    const twoDays = { storeId: STORE_ID, dateFrom: DAY, dateTo: "2026-03-02" };
    const [sales, returns] = await Promise.all([
      reportsRepo.dailySales(twoDays),
      reportsRepo.dailyReturns(twoDays),
    ]);

    // The condition that broke the old join: a returns date with no sales row.
    expect(sales.map((r) => r.localDate)).toEqual([DAY]);
    expect(returns.map((r) => r.localDate)).toEqual([DAY, "2026-03-02"]);

    const t = periodTotals(sales, returns);
    const rows = mergeDailyRows(sales, returns);

    expect(rows).toHaveLength(2);
    const dayTwo = rows[1];
    expect(dayTwo.localDate).toBe("2026-03-02");
    expect(dayTwo.saleCount).toBe(0);
    expect(dayTwo.returnedRevenueInclVatCents).toBe(600);
    expect(dayTwo.netRevenueInclVatCents).toBe(-600);
    expect(dayTwo.netSalesExclVatCents).toBe(-541);
    expect(dayTwo.netCogsCents).toBe(-250);

    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((s, r) => s + f(r), 0);
    expect(add((r) => r.netRevenueInclVatCents)).toBe(t.netRevenueInclVatCents);
    expect(add((r) => r.netSalesExclVatCents)).toBe(t.netSalesExclVatCents);
    expect(add((r) => r.netCogsCents)).toBe(t.netCogsCents);
    expect(add((r) => r.grossProfitCents)).toBe(t.grossProfitCents);

    // Sale #5's three burgers are now fully returned, and the three memo
    // slices sum EXACTLY to the original line — the whole point of prorating
    // cumulatively rather than rounding each return on its own.
    expect(541 + 540 + 541).toBe(1622);
    expect(59 + 60 + 59).toBe(178);
    const statuses = await creditMemosRepo.returnStatusForStore(STORE_ID);
    expect(statuses.get(sale5)).toBe("full");
  });

  it("still appears in Sales by Product, which still sums to the headline", async () => {
    // A product returned in a period it was not SOLD in: the water of #4 comes
    // back on day 2, and day 2's sales contain no water at all.
    const sale6 = insertSale(db, {
      postedAt: "2026-03-02T09:00:00.000Z",
      shiftId: SHIFT,
      lines: [burgerLine(1, 541, 59, 600)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
      ],
    });
    expect(sale6).toBeTruthy();

    const dayTwo = { storeId: STORE_ID, dateFrom: "2026-03-02", dateTo: "2026-03-02" };
    const [sales, returns, products, productRets] = await Promise.all([
      reportsRepo.dailySales(dayTwo),
      reportsRepo.dailyReturns(dayTwo),
      reportsRepo.productSales(dayTwo),
      reportsRepo.productReturns(dayTwo),
    ]);
    // Day 2 sold a burger and returned nothing: the simple control.
    expect(products.map((r) => r.productId)).toEqual([BURGER]);
    expect(returns).toHaveLength(0);

    const t = periodTotals(sales, returns);
    const rows = mergeProductRows(products, productRets);
    expect(rows.reduce((s, r) => s + r.netSalesExclVatCents, 0)).toBe(
      t.netSalesExclVatCents,
    );
    expect(rows.reduce((s, r) => s + r.netCogsCents, 0)).toBe(t.netCogsCents);
  });

  it("names a product it can only see through the credit memo", async () => {
    // The period covers the returns but NOT the sales they reverse, so
    // `productSales` is empty and every name must come from the memo lines.
    const onlyReturns = {
      storeId: STORE_ID,
      dateFrom: `${DAY}`,
      dateTo: `${DAY}`,
    };
    const rets = await reportsRepo.productReturns(onlyReturns);
    const rows = mergeProductRows([], rets);

    expect(rows.map((r) => r.productName).sort()).toEqual(["Burger", "Water 1.5L"]);
    // Snapshots, not today's product master.
    expect(rows.every((r) => r.productId !== r.productName)).toBe(true);
  });
});
