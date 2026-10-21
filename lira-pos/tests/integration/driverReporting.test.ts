/**
 * DRIVER REPORTING RECONCILIATION (WP-6).
 *
 * One realistic Greaz trading day — some counter trade, some WhatsApp
 * deliveries carried by two drivers, one return, one partial settlement and
 * one full one — read back through every production read model that shows the
 * delivery side, and asserted to tell the SAME story through all of them.
 *
 * Three reconciliations are the point of the file, and each is a way the
 * feature could have gone wrong silently:
 *
 *   1. SALES BY CHANNEL still sums to total posted sales. Adding a column to
 *      `sales` must not change what the sales reports mean.
 *   2. THE DELIVERY FEE IS IN NO REVENUE FIGURE. It is the driver's income;
 *      the whole accounting boundary rests on it never being counted as Greaz's.
 *   3. DRIVER REMITTANCES ARE NOT SALES. The revenue was recognised when the
 *      order posted, so a report that summed the cash coming back alongside it
 *      would count every delivery twice.
 *
 * Scope note, as `reportingReconciliation.test.ts`: repository SQL against
 * node:sqlite with the Tauri SQL plugin mocked out. The posting commands are
 * not run — `src-tauri/src/tests/drivers.rs` owns whether a document may be
 * written. What is proven here is how the documents, once written, are READ.
 *
 * The real migrations are applied, so migration 015's CHECKs and its
 * sign-discipline trigger are live against every fixture insert below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  insertCreditMemo,
  insertDriverLedgerEntry,
  insertSale,
  resetIds,
  saleItemIds,
  seedDriver,
  seedExchangeRate,
  seedProduct,
  seedShift,
  STORE_ID,
  RATE_ID,
  RATE_LBP_PER_USD,
} from "../helpers/sqlDb";
import { reportsRepo } from "../../src/db/repos/reports";
import { driversRepo } from "../../src/db/repos/drivers";
import { buildChannelMix } from "../../src/lib/salesChannel";
import { summariseDrivers } from "../../src/lib/driverCollection";

const P_BURGER = "00000000-0000-0000-0000-0000000000f1";
const ALI = "00000000-0000-0000-0000-00000000da01";
const HASSAN = "00000000-0000-0000-0000-00000000da02";
const SHIFT = "00000000-0000-0000-0000-00000000fa01";

const DAY = "2026-10-21";
const FROM = DAY;
const TO = DAY;
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

let db: DatabaseSync;

/**
 * The day.
 *
 *   Counter : 1 burger, $10.00, cash.                      → $10.00
 *   Ali     : 2 burgers, $20.00, driver collection, $3 fee  → $20.00 owed
 *   Ali     : 1 burger,  $10.00, driver collection, $2 fee  → $10.00 owed
 *   Hassan  : 1 burger,  $10.00, driver collection, $4 fee  → $10.00 owed
 *
 * Then: one burger comes back off Ali's first order ($10.00 credited to him),
 * Ali hands over $15.00, and Hassan hands over all $10.00 of his.
 *
 * So Ali: 30 collected − 10 returned − 15 remitted = $5.00 still out.
 *    Hassan: 10 collected − 10 remitted = nil.
 *    Fees kept by the drivers: $5.00 Ali, $4.00 Hassan — Greaz's revenue: none.
 */
function buildTheDay() {
  seedExchangeRate(db);
  seedShift(db, { id: SHIFT, openingUsdCents: 0, openingLbp: 0 });
  seedProduct(db, { id: P_BURGER, sku: "SKU-F1", name: "Double Burger" });
  seedDriver(db, ALI, "Ali");
  seedDriver(db, HASSAN, "Hassan");

  const burger = (qty: number) => ({
    productId: P_BURGER,
    productName: "Double Burger",
    quantity: qty,
    subtotalExclVat: 901 * qty,
    vat: 99 * qty,
    totalInclVat: 1_000 * qty,
    cogs: 300 * qty,
  });

  insertSale(db, {
    postedAt: at("09:00"),
    shiftId: SHIFT,
    lines: [burger(1)],
    payments: [
      { method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 },
    ],
  });

  const aliFirst = insertSale(db, {
    postedAt: at("10:00"),
    shiftId: SHIFT,
    channel: "online_delivery",
    driverId: ALI,
    deliveryFeeCents: 300,
    lines: [burger(2)],
    payments: [
      {
        method: "driver_collection",
        currency: "USD",
        nativeUsdCents: 2_000,
        usdEquivalent: 2_000,
      },
    ],
  });

  insertSale(db, {
    postedAt: at("11:00"),
    shiftId: SHIFT,
    channel: "online_delivery",
    driverId: ALI,
    deliveryFeeCents: 200,
    lines: [burger(1)],
    payments: [
      {
        method: "driver_collection",
        currency: "USD",
        nativeUsdCents: 1_000,
        usdEquivalent: 1_000,
      },
    ],
  });

  const hassanOrder = insertSale(db, {
    postedAt: at("12:00"),
    shiftId: SHIFT,
    channel: "online_delivery",
    driverId: HASSAN,
    deliveryFeeCents: 400,
    lines: [burger(1)],
    payments: [
      {
        method: "driver_collection",
        currency: "USD",
        nativeUsdCents: 1_000,
        usdEquivalent: 1_000,
      },
    ],
  });

  // The receivables each delivery order raised.
  insertDriverLedgerEntry(db, {
    driverId: ALI,
    entryType: "collection",
    amountCents: 2_000,
    entryDate: DAY,
    postedAt: at("10:00"),
    relatedSaleId: aliFirst,
  });
  insertDriverLedgerEntry(db, {
    driverId: ALI,
    entryType: "collection",
    amountCents: 1_000,
    entryDate: DAY,
    postedAt: at("11:00"),
    relatedSaleId: saleIdOfSecondAliOrder(),
  });
  insertDriverLedgerEntry(db, {
    driverId: HASSAN,
    entryType: "collection",
    amountCents: 1_000,
    entryDate: DAY,
    postedAt: at("12:00"),
    relatedSaleId: hassanOrder,
  });

  // One burger comes back off Ali's first order, credited against HIM: he is
  // holding the money being refunded, so no drawer figure moves.
  const memoId = insertCreditMemo(db, {
    saleId: aliFirst,
    postedAt: at("13:00"),
    shiftId: SHIFT,
    lines: [
      {
        saleItemId: saleItemIds(db, aliFirst)[0],
        productId: P_BURGER,
        quantityBase: 1,
        subtotalExclVat: 901,
        vat: 99,
        totalInclVat: 1_000,
        cogsReversed: 300,
        returnToStock: true,
      },
    ],
    refunds: [
      {
        method: "driver_collection",
        currency: "USD",
        nativeUsdCents: 1_000,
        usdEquivalent: 1_000,
      },
    ],
  });
  insertDriverLedgerEntry(db, {
    driverId: ALI,
    entryType: "return_credit",
    amountCents: -1_000,
    entryDate: DAY,
    postedAt: at("13:00"),
    relatedCreditMemoId: memoId,
  });

  // Settlements: Ali partially, Hassan in full.
  insertDriverLedgerEntry(db, {
    driverId: ALI,
    entryType: "remittance",
    amountCents: -1_500,
    entryDate: DAY,
    postedAt: at("18:00"),
    receivedCurrency: "USD",
    receivedNativeUsdCents: 1_500,
    shiftId: SHIFT,
  });
  insertDriverLedgerEntry(db, {
    driverId: HASSAN,
    entryType: "remittance",
    amountCents: -1_000,
    entryDate: DAY,
    postedAt: at("18:30"),
    receivedCurrency: "LBP",
    receivedNativeLbp: 895_000,
    exchangeRateId: RATE_ID,
    exchangeRateLbpPerUsd: RATE_LBP_PER_USD,
    shiftId: SHIFT,
  });

  return { aliFirst, hassanOrder, memoId };
}

/** The second Ali order's id — the third sale inserted. */
function saleIdOfSecondAliOrder(): string {
  const row = db
    .prepare(
      `SELECT id FROM sales
        WHERE driver_id = ? AND total_incl_vat_cents = 1000
        ORDER BY posted_at LIMIT 1`,
    )
    .get(ALI) as { id: string };
  return row.id;
}

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
});

afterEach(() => {
  setTestDb(null);
  db.close();
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. The channel report still reconciles to posted sales
// ===========================================================================

describe("sales by channel, with delivery orders in the day", () => {
  it("sums to the period's total posted sales", async () => {
    buildTheDay();
    const rows = await reportsRepo.salesByChannel({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const mix = buildChannelMix(rows);

    const counter = mix.byChannel.find((c) => c.channel === "counter")!;
    const delivery = mix.byChannel.find((c) => c.channel === "online_delivery")!;

    expect(counter.orderCount).toBe(1);
    expect(counter.grossInclVatCents).toBe(1_000);
    expect(delivery.orderCount).toBe(3);
    expect(delivery.grossInclVatCents).toBe(4_000);

    // The parts are the whole.
    expect(mix.totalOrders).toBe(4);
    expect(mix.totalGrossInclVatCents).toBe(5_000);

    // And they agree with the daily series, which is what the headline KPI and
    // the daily table are built from.
    const daily = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const dailyGross = daily.reduce((s, r) => s + r.totalInclVatCents, 0);
    expect(mix.totalGrossInclVatCents).toBe(dailyGross);
  });

  it("attributes the refund to the DELIVERY channel that earned it", async () => {
    buildTheDay();
    const rows = await reportsRepo.salesByChannel({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const mix = buildChannelMix(rows);
    const delivery = mix.byChannel.find((c) => c.channel === "online_delivery")!;
    const counter = mix.byChannel.find((c) => c.channel === "counter")!;

    expect(delivery.refundedInclVatCents).toBe(1_000);
    expect(counter.refundedInclVatCents).toBe(0);
    expect(delivery.netInclVatCents).toBe(3_000);
    expect(mix.totalNetInclVatCents).toBe(4_000);
  });

  it("puts NO delivery fee in any revenue figure", async () => {
    // The accounting boundary, asserted directly. $9.00 of delivery charges
    // were agreed on the day and Greaz's revenue is $50.00, not $59.00.
    buildTheDay();
    const rows = await reportsRepo.salesByChannel({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const mix = buildChannelMix(rows);

    const feesCharged = db
      .prepare(`SELECT COALESCE(SUM(delivery_fee_cents), 0) AS f FROM sales`)
      .get() as { f: number };
    expect(feesCharged.f).toBe(900);
    expect(mix.totalGrossInclVatCents).toBe(5_000);
  });
});

// ===========================================================================
// 2. The driver report
// ===========================================================================

describe("driverSettlements", () => {
  it("reports what each driver collected, returned, remitted and still owes", async () => {
    buildTheDay();
    const rows = await reportsRepo.driverSettlements({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });

    const ali = rows.find((r) => r.driverId === ALI)!;
    expect(ali.driverName).toBe("Ali");
    expect(ali.orderCount).toBe(2);
    expect(ali.collectedCents).toBe(3_000);
    expect(ali.returnCreditCents).toBe(1_000);
    expect(ali.remittedCents).toBe(1_500);
    expect(ali.outstandingCents).toBe(500);
    // His own income, over the period. Not in the figures above it.
    expect(ali.deliveryFeesCents).toBe(500);

    const hassan = rows.find((r) => r.driverId === HASSAN)!;
    expect(hassan.orderCount).toBe(1);
    expect(hassan.collectedCents).toBe(1_000);
    expect(hassan.remittedCents).toBe(1_000);
    expect(hassan.outstandingCents).toBe(0);
    expect(hassan.deliveryFeesCents).toBe(400);
  });

  it("has every balance equal to its own movements", async () => {
    // `summariseDrivers` re-derives each balance from its components and names
    // any row that disagrees. A non-empty list here would mean the report shows
    // a balance its own columns do not add up to.
    buildTheDay();
    const rows = await reportsRepo.driverSettlements({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const totals = summariseDrivers(rows);

    expect(totals.unreconciled).toEqual([]);
    expect(totals.collectedCents).toBe(4_000);
    expect(totals.remittedCents).toBe(2_500);
    expect(totals.returnCreditCents).toBe(1_000);
    expect(totals.outstandingCents).toBe(500);
    expect(totals.deliveryFeesCents).toBe(900);
  });

  it("reconciles total receivables to delivery food sales less returns and settlements", async () => {
    // The end-to-end identity for the whole feature:
    //
    //   delivery food sold − returned − handed back = still in drivers' pockets
    buildTheDay();
    const channel = buildChannelMix(
      await reportsRepo.salesByChannel({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }),
    );
    const delivery = channel.byChannel.find((c) => c.channel === "online_delivery")!;
    const totals = summariseDrivers(
      await reportsRepo.driverSettlements({ storeId: STORE_ID, dateFrom: FROM, dateTo: TO }),
    );

    // Every delivery order on this day was collected for by a driver, so the
    // food sold IS what was collected.
    expect(totals.collectedCents).toBe(delivery.grossInclVatCents);
    expect(totals.returnCreditCents).toBe(delivery.refundedInclVatCents);
    expect(
      totals.collectedCents - totals.returnCreditCents - totals.remittedCents,
    ).toBe(totals.outstandingCents);
  });

  it("keeps a driver with a balance but no orders this period", async () => {
    // A balance missing from its own report is how a shop's money goes astray.
    buildTheDay();
    const rows = await reportsRepo.driverSettlements({
      storeId: STORE_ID,
      // A later period, in which nobody delivered anything.
      dateFrom: "2026-10-22",
      dateTo: "2026-10-22",
    });
    const ali = rows.find((r) => r.driverId === ALI)!;
    expect(ali.orderCount).toBe(0);
    expect(ali.deliveryFeesCents).toBe(0);
    // The balance is LIFETIME and still shows.
    expect(ali.outstandingCents).toBe(500);
  });
});

// ===========================================================================
// 3. Remittances are not sales
// ===========================================================================

describe("driverRemittances", () => {
  it("reports the cash that came back, in the currency it came back in", async () => {
    buildTheDay();
    const rows = await reportsRepo.driverRemittances({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });

    const ali = rows.find((r) => r.driverId === ALI)!;
    expect(ali.remittanceCount).toBe(1);
    expect(ali.usdCents).toBe(1_500);
    expect(ali.lbp).toBe(0);
    expect(ali.totalUsdEquivalentCents).toBe(1_500);

    const hassan = rows.find((r) => r.driverId === HASSAN)!;
    // Handed over in lira; the USD equivalent was derived at the rate on
    // record when the row was written, and the lira is still on the row.
    expect(hassan.lbp).toBe(895_000);
    expect(hassan.usdCents).toBe(0);
    expect(hassan.totalUsdEquivalentCents).toBe(1_000);
  });

  it("is NOT counted as sales revenue", async () => {
    // The double-counting guard. $25.00 of cash came back from drivers, and the
    // period's sales are $50.00 — not $75.00.
    buildTheDay();
    const remittances = await reportsRepo.driverRemittances({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const remitted = remittances.reduce((s, r) => s + r.totalUsdEquivalentCents, 0);
    expect(remitted).toBe(2_500);

    const daily = await reportsRepo.dailySales({
      storeId: STORE_ID,
      dateFrom: FROM,
      dateTo: TO,
    });
    const gross = daily.reduce((s, r) => s + r.totalInclVatCents, 0);
    expect(gross).toBe(5_000);

    // And the sales series knows nothing about the ledger: no join, no term.
    const salesCount = db.prepare(`SELECT COUNT(*) AS n FROM sales`).get() as { n: number };
    expect(salesCount.n).toBe(4);
  });

  it("reports nothing for a period with no settlements", async () => {
    buildTheDay();
    const rows = await reportsRepo.driverRemittances({
      storeId: STORE_ID,
      dateFrom: "2026-10-22",
      dateTo: "2026-10-22",
    });
    expect(rows).toEqual([]);
  });
});

// ===========================================================================
// 4. Source-level traceability
// ===========================================================================

describe("traceability", () => {
  it("links every receivable to the receipt that raised it", async () => {
    const { aliFirst } = buildTheDay();
    const entry = await driversRepo.collectionForSale(aliFirst);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("collection");
    expect(entry!.driverId).toBe(ALI);
    expect(entry!.amountCents).toBe(2_000);
  });

  it("links the return credit to the credit memo that caused it", async () => {
    const { memoId } = buildTheDay();
    const ledger = await driversRepo.ledger({ driverId: ALI });
    const credit = ledger.find((e) => e.entryType === "return_credit")!;
    expect(credit.relatedCreditMemoId).toBe(memoId);
    expect(credit.relatedSaleId).toBeNull();
    expect(credit.amountCents).toBe(-1_000);
  });

  it("gives the settlement history newest first, with the currency received", async () => {
    buildTheDay();
    const ledger = await driversRepo.ledger({ driverId: HASSAN });
    expect(ledger[0].entryType).toBe("remittance");
    expect(ledger[0].receivedCurrency).toBe("LBP");
    expect(ledger[0].receivedNativeLbp).toBe(895_000);
    expect(ledger[1].entryType).toBe("collection");
  });

  it("shows the balance the view reports through the repo too", async () => {
    buildTheDay();
    const balance = await driversRepo.balanceFor(ALI);
    expect(balance!.outstandingCents).toBe(500);
    expect(balance!.collectionCount).toBe(2);

    const list = await driversRepo.balances({ storeId: STORE_ID });
    // Ordered by what is outstanding, descending: the urgent question first.
    expect(list[0].driverId).toBe(ALI);
  });
});
