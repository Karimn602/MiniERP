/**
 * SQL / read-model integration tests for `db/repos/shifts.ts` and
 * `db/repos/shiftSummary.ts`.
 *
 * Scope note: repository SQL against node:sqlite with the Tauri SQL plugin
 * mocked out — not an end-to-end Tauri test. See tests/README.md.
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
  seedShift,
  RATE_LBP_PER_USD,
  STORE_ID,
  USER_ID,
} from "../helpers/sqlDb";
import { shiftsRepo } from "../../src/db/repos/shifts";
import { shiftSummaryRepo } from "../../src/db/repos/shiftSummary";

const COFFEE = "prod-coffee";
const SHIFT_A = "shift-a";
const SHIFT_B = "shift-b";

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  seedProduct(db, { id: COFFEE, sku: "SKU-C1", name: "Coffee 250g" });
});

afterEach(() => {
  setTestDb(null);
  db.close();
});

/** qty × $5.00 incl VAT at 11%. */
function coffeeLine(qty: number) {
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

describe("getSalesSummary", () => {
  it("is scoped to one shift", async () => {
    seedShift(db, { id: SHIFT_A });
    seedShift(db, { id: SHIFT_B });

    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [],
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(3)],
      payments: [],
    });
    insertSale(db, {
      postedAt: "2026-03-01T11:00:00.000Z",
      shiftId: SHIFT_B,
      lines: [coffeeLine(10)],
      payments: [],
    });

    const a = await shiftsRepo.getSalesSummary(SHIFT_A, STORE_ID);
    expect(a.receiptCount).toBe(2);
    expect(a.totalInclVatCents).toBe(2500);
    expect(a.subtotalExclVatCents + a.vatTotalCents).toBe(a.totalInclVatCents);

    const b = await shiftsRepo.getSalesSummary(SHIFT_B, STORE_ID);
    expect(b.receiptCount).toBe(1);
    expect(b.totalInclVatCents).toBe(5000);
  });

  it("returns zeros for a shift with no sales", async () => {
    seedShift(db, { id: SHIFT_A });
    const s = await shiftsRepo.getSalesSummary(SHIFT_A, STORE_ID);
    expect(s.receiptCount).toBe(0);
    expect(s.totalInclVatCents).toBe(0);
    expect(s.vatTotalCents).toBe(0);
  });

  it("excludes non-posted sales", async () => {
    seedShift(db, { id: SHIFT_A });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [],
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [],
      status: "voided",
    });

    const s = await shiftsRepo.getSalesSummary(SHIFT_A, STORE_ID);
    expect(s.receiptCount).toBe(1);
  });

  it("reports net sales equal to the (already-net) subtotal when nothing is discounted", async () => {
    seedShift(db, { id: SHIFT_A });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [],
    });

    const s = await shiftsRepo.getSalesSummary(SHIFT_A, STORE_ID);
    expect(s.discountCents).toBe(0);
    expect(s.netSalesExclVatCents).toBe(s.subtotalExclVatCents);
  });

  // -------------------------------------------------------------------
  // GP-A04 — report / shift discount double subtraction.  Owner: WP-08
  //
  // PosRegister sends POST-discount line values (see PosRegister.tsx, which
  // calls postDiscountLineTotals before building the payload), so
  // `sales.subtotal_excl_vat_cents` is ALREADY net of the discount.
  //
  // shifts.ts:getSalesSummary and shiftSummary.ts:salesSummary both compute
  //     netSalesExclVatCents = subtotal_excl_vat_cents - discount_cents
  // which subtracts the same discount a second time. Net sales — and any
  // margin derived from it — are understated by the discount amount.
  //
  // WP-08 owns the fix (either stop subtracting, or persist pre-discount
  // line values). Enable both skipped tests then.
  // -------------------------------------------------------------------
  it.skip("GP-A04 (WP-08): does not subtract the discount twice", async () => {
    seedShift(db, { id: SHIFT_A });
    // A $10.00 cart discounted by $1.00: lines are persisted at $9.00.
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
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

    const s = await shiftsRepo.getSalesSummary(SHIFT_A, STORE_ID);
    expect(s.subtotalExclVatCents).toBe(811);
    expect(s.netSalesExclVatCents).toBe(
      811, // today this returns 711 — the discount is removed twice
    );
  });
});

describe("getPaymentBreakdown", () => {
  it("groups tenders by method and currency", async () => {
    seedShift(db, { id: SHIFT_A });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
      ],
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
        { method: "card_usd", currency: "USD", nativeUsdCents: 400, usdEquivalent: 400 },
      ],
    });

    const rows = await shiftsRepo.getPaymentBreakdown(SHIFT_A, STORE_ID);
    const cash = rows.find((r) => r.method === "cash_usd")!;
    const card = rows.find((r) => r.method === "card_usd")!;

    expect(cash.amountNativeUsdCents).toBe(1600);
    expect(card.amountNativeUsdCents).toBe(400);
    expect(rows.reduce((s, r) => s + r.amountUsdCentsEquivalent, 0)).toBe(2000);
  });

  it("keeps LBP tenders in their own currency alongside the USD equivalent", async () => {
    seedShift(db, { id: SHIFT_A });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        {
          method: "cash_lbp",
          currency: "LBP",
          nativeLbp: 895_000,
          usdEquivalent: 1000,
          changeLbp: 0,
        },
      ],
    });

    const [row] = await shiftsRepo.getPaymentBreakdown(SHIFT_A, STORE_ID);
    expect(row.currency).toBe("LBP");
    expect(row.amountNativeLbp).toBe(895_000);
    expect(row.amountUsdCentsEquivalent).toBe(1000);
    expect(row.amountNativeUsdCents).toBe(0);
    // Sanity-check the fixture against the locked rate.
    expect(Math.round((895_000 * 100) / RATE_LBP_PER_USD)).toBe(1000);
  });

  it("does not leak another shift's tenders", async () => {
    seedShift(db, { id: SHIFT_A });
    seedShift(db, { id: SHIFT_B });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_B,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
      ],
    });

    expect(await shiftsRepo.getPaymentBreakdown(SHIFT_A, STORE_ID)).toEqual([]);
  });
});

describe("closeShift", () => {
  it("computes expected drawer cash as opening + received − change", async () => {
    seedShift(db, { id: SHIFT_A, openingUsdCents: 10_000, openingLbp: 500_000 });

    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        {
          method: "cash_usd",
          currency: "USD",
          nativeUsdCents: 2000,
          usdEquivalent: 2000,
          changeUsdCents: 1000,
        },
      ],
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(4)],
      payments: [
        {
          method: "cash_lbp",
          currency: "LBP",
          nativeLbp: 300_000,
          usdEquivalent: 335,
          changeLbp: 100_000,
        },
      ],
    });

    // Expected: USD 10,000 + 2,000 − 1,000 = 11,000
    //           LBP 500,000 + 300,000 − 100,000 = 700,000
    const closed = await shiftsRepo.closeShift({
      shiftId: SHIFT_A,
      storeId: STORE_ID,
      userId: USER_ID,
      closingCashUsdCents: 11_000,
      closingCashLbp: 700_000,
    });

    expect(closed.expectedCashUsdCents).toBe(11_000);
    expect(closed.expectedCashLbp).toBe(700_000);
    expect(closed.varianceUsdCents).toBe(0);
    expect(closed.varianceLbp).toBe(0);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeTruthy();
  });

  it("reports a short drawer as a negative variance and an over drawer as positive", async () => {
    seedShift(db, { id: SHIFT_A, openingUsdCents: 5_000 });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
      ],
    });

    const short = await shiftsRepo.closeShift({
      shiftId: SHIFT_A,
      storeId: STORE_ID,
      userId: USER_ID,
      closingCashUsdCents: 5_950, // $0.50 missing
      closingCashLbp: 0,
    });
    expect(short.expectedCashUsdCents).toBe(6_000);
    expect(short.varianceUsdCents).toBe(-50);

    seedShift(db, { id: SHIFT_B, openingUsdCents: 0 });
    const over = await shiftsRepo.closeShift({
      shiftId: SHIFT_B,
      storeId: STORE_ID,
      userId: USER_ID,
      closingCashUsdCents: 25,
      closingCashLbp: 0,
    });
    expect(over.expectedCashUsdCents).toBe(0);
    expect(over.varianceUsdCents).toBe(25);
  });

  it("counts only cash — card tenders never reach the drawer", async () => {
    seedShift(db, { id: SHIFT_A, openingUsdCents: 1_000 });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(20)],
      payments: [
        { method: "card_usd", currency: "USD", nativeUsdCents: 10_000, usdEquivalent: 10_000 },
      ],
    });

    const closed = await shiftsRepo.closeShift({
      shiftId: SHIFT_A,
      storeId: STORE_ID,
      userId: USER_ID,
      closingCashUsdCents: 1_000,
      closingCashLbp: 0,
    });
    expect(closed.expectedCashUsdCents).toBe(1_000);
    expect(closed.varianceUsdCents).toBe(0);
  });

  it("refuses to close a shift that is not open", async () => {
    seedShift(db, { id: SHIFT_A });
    await shiftsRepo.closeShift({
      shiftId: SHIFT_A,
      storeId: STORE_ID,
      userId: USER_ID,
      closingCashUsdCents: 0,
      closingCashLbp: 0,
    });

    await expect(
      shiftsRepo.closeShift({
        shiftId: SHIFT_A,
        storeId: STORE_ID,
        userId: USER_ID,
        closingCashUsdCents: 0,
        closingCashLbp: 0,
      }),
    ).rejects.toThrow(/No open shift/);
  });
});

describe("shiftSummaryRepo (date-scoped day summary)", () => {
  it("summarises every posted sale on a local date, across shifts", async () => {
    seedShift(db, { id: SHIFT_A });
    seedShift(db, { id: SHIFT_B });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
      ],
    });
    insertSale(db, {
      postedAt: "2026-03-01T20:00:00.000Z",
      shiftId: SHIFT_B,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
      ],
    });
    insertSale(db, {
      postedAt: "2026-03-02T09:00:00.000Z",
      shiftId: SHIFT_B,
      lines: [coffeeLine(2)],
      payments: [],
    });

    const summary = await shiftSummaryRepo.salesSummary({ storeId: STORE_ID, date: "2026-03-01" });
    expect(summary.receiptCount).toBe(2);
    expect(summary.totalInclVatCents).toBe(2000);
    expect(summary.subtotalExclVatCents + summary.vatTotalCents).toBe(summary.totalInclVatCents);

    const payments = await shiftSummaryRepo.paymentBreakdown({
      storeId: STORE_ID,
      date: "2026-03-01",
    });
    expect(payments).toHaveLength(1);
    expect(payments[0].amountUsdCentsEquivalent).toBe(2000);
  });

  // GP-A04 (WP-08) — same defect as above, via the date-scoped summary.
  // See the comment on the shiftsRepo test for the full explanation.
  it.skip("GP-A04 (WP-08): does not subtract the discount twice", async () => {
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

    const summary = await shiftSummaryRepo.salesSummary({ storeId: STORE_ID, date: "2026-03-01" });
    expect(summary.netSalesExclVatCents).toBe(811); // today: 711
  });
});
