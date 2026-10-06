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

// `openShift` / `closeShift` are Rust commands since WP-04, so the repo's job
// there is the wire format. `invoke` is mocked to observe it; nothing in this
// file exercises the posting logic itself (that is the Rust suite's).
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

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
  invokeMock.mockReset();
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
    // One open shift per store since migration 009, so the second is the
    // store's previous, already-closed shift.
    seedShift(db, { id: SHIFT_B, status: "closed" });

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
  // GP-A04 — report / shift discount double subtraction.  FIXED in WP-08.
  //
  // PosRegister sends POST-discount line values (see PosRegister.tsx, which
  // calls postDiscountLineTotals before building the payload), so
  // `sales.subtotal_excl_vat_cents` is ALREADY net of the discount.
  //
  // shifts.ts:getSalesSummary and shiftSummary.ts:salesSummary both computed
  //     netSalesExclVatCents = subtotal_excl_vat_cents - discount_cents
  // which subtracted the same discount a second time. Net sales — and any
  // margin derived from it — were understated by the discount amount.
  //
  // Both now return the persisted subtotal unmodified. Restoring either
  // subtraction must fail this test and its twin below.
  // -------------------------------------------------------------------
  it("GP-A04: does not subtract the discount twice", async () => {
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
    // 811, not 811 − 100 = 711. The discount is already out of the subtotal.
    expect(s.netSalesExclVatCents).toBe(811);
    // And it is still reportable on its own.
    expect(s.discountCents).toBe(100);
    // The header invariant the whole vocabulary rests on.
    expect(s.subtotalExclVatCents + s.vatTotalCents).toBe(s.totalInclVatCents);
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
    seedShift(db, { id: SHIFT_B, status: "closed" });
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

describe("getDrawerExpectation", () => {
  // The read-model mirror of what `close_shift` computes in its transaction.
  // The authoritative calculation and its own tests live in the Rust suite
  // (src-tauri/src/tests/shifts.rs); these prove the SQL the Shift page shows a
  // cashier while they are counting cannot disagree with it.

  it("counts cash in and change out, per currency", async () => {
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

    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT_A, STORE_ID);
    expect(drawer.cashUsdInCents).toBe(2000);
    expect(drawer.changeUsdOutCents).toBe(1000);
    expect(drawer.cashLbpIn).toBe(300_000);
    expect(drawer.changeLbpOut).toBe(100_000);

    // Expected, as the page renders it: opening + in − out, per currency.
    const shift = (await shiftsRepo.getOpenShift(STORE_ID))!;
    expect(shift.openingCashUsdCents + drawer.cashUsdInCents - drawer.changeUsdOutCents).toBe(
      11_000,
    );
    expect(shift.openingCashLbp + drawer.cashLbpIn - drawer.changeLbpOut).toBe(700_000);
  });

  it("excludes card tenders from physical cash in both directions", async () => {
    seedShift(db, { id: SHIFT_A, openingUsdCents: 1_000 });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(20)],
      payments: [
        { method: "card_usd", currency: "USD", nativeUsdCents: 10_000, usdEquivalent: 10_000 },
      ],
    });

    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT_A, STORE_ID);
    expect(drawer.cashUsdInCents).toBe(0);
    expect(drawer.changeUsdOutCents).toBe(0);
  });

  it("ignores change recorded on a card row by an older release (GZ-HI-04)", async () => {
    // `post_sale` refuses to write this now, but a database written before
    // WP-04 can hold it. Such a row must not go on making the till look short.
    seedShift(db, { id: SHIFT_A, openingUsdCents: 1_000 });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        {
          method: "card_usd",
          currency: "USD",
          nativeUsdCents: 1_200,
          usdEquivalent: 1_200,
          changeUsdCents: 200, // the GZ-HI-04 row
        },
      ],
    });

    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT_A, STORE_ID);
    expect(drawer.changeUsdOutCents).toBe(0);
    expect(drawer.cashUsdInCents).toBe(0);
  });

  it("allocates mixed cash/card change against the cash row only", async () => {
    seedShift(db, { id: SHIFT_A, openingUsdCents: 0 });
    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_A,
      lines: [coffeeLine(2)],
      payments: [
        { method: "card_usd", currency: "USD", nativeUsdCents: 600, usdEquivalent: 600 },
        {
          method: "cash_usd",
          currency: "USD",
          nativeUsdCents: 900,
          usdEquivalent: 900,
          changeUsdCents: 500,
        },
      ],
    });

    const drawer = await shiftsRepo.getDrawerExpectation(SHIFT_A, STORE_ID);
    expect(drawer.cashUsdInCents).toBe(900);
    expect(drawer.changeUsdOutCents).toBe(500);
    // The till nets $4.00 — the cash part of the bill, not the $10.00 total.
    expect(drawer.cashUsdInCents - drawer.changeUsdOutCents).toBe(400);
  });

  it("is scoped to one shift and to posted sales", async () => {
    seedShift(db, { id: SHIFT_A });
    seedShift(db, { id: SHIFT_B, status: "closed" });

    insertSale(db, {
      postedAt: "2026-03-01T09:00:00.000Z",
      shiftId: SHIFT_B,
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 1000, usdEquivalent: 1000 },
      ],
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: SHIFT_A,
      status: "voided",
      lines: [coffeeLine(2)],
      payments: [
        { method: "cash_usd", currency: "USD", nativeUsdCents: 5000, usdEquivalent: 5000 },
      ],
    });

    // Since WP-06 the figure also carries the cash-refund terms, which are
    // zero here because this shift has no credit memos.
    expect(await shiftsRepo.getDrawerExpectation(SHIFT_A, STORE_ID)).toEqual({
      cashUsdInCents: 0,
      cashLbpIn: 0,
      changeUsdOutCents: 0,
      changeLbpOut: 0,
      refundUsdOutCents: 0,
      refundLbpOut: 0,
    });
  });

  it("returns zeros for a shift that has taken nothing", async () => {
    seedShift(db, { id: SHIFT_A, openingUsdCents: 5_000 });
    expect(await shiftsRepo.getDrawerExpectation(SHIFT_A, STORE_ID)).toEqual({
      cashUsdInCents: 0,
      cashLbpIn: 0,
      changeUsdOutCents: 0,
      changeLbpOut: 0,
      refundUsdOutCents: 0,
      refundLbpOut: 0,
    });
  });
});

describe("shiftSummaryRepo (date-scoped day summary)", () => {
  it("summarises every posted sale on a local date, across shifts", async () => {
    seedShift(db, { id: SHIFT_A });
    seedShift(db, { id: SHIFT_B, status: "closed" });
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

  // GP-A04 — same defect as above, via the date-scoped summary. FIXED in
  // WP-08. See the comment on the shiftsRepo test for the full explanation.
  it("GP-A04: does not subtract the discount twice", async () => {
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
    expect(summary.subtotalExclVatCents).toBe(811);
    // 811, not 811 − 100 = 711.
    expect(summary.netSalesExclVatCents).toBe(811);
    expect(summary.discountCents).toBe(100);
    expect(summary.subtotalExclVatCents + summary.vatTotalCents).toBe(
      summary.totalInclVatCents,
    );
  });
});

describe("the shift lifecycle commands", () => {
  // `openShift` and `closeShift` are transactional Rust commands since WP-04
  // (GZ-HI-03); their behaviour is proven in src-tauri/src/tests/shifts.rs.
  // What the TypeScript layer still owns is the WIRE: the command name and the
  // camelCase payload keys that `#[serde(rename_all = "camelCase")]` expects.
  // A renamed field here fails silently at runtime, so it is pinned.

  it("sends open_shift a payload with a generated shift id", async () => {
    invokeMock.mockResolvedValueOnce({ id: "generated", status: "open" });

    await shiftsRepo.openShift({
      storeId: STORE_ID,
      userId: USER_ID,
      openingCashUsdCents: 10_000,
      openingCashLbp: 500_000,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("open_shift");
    const payload = (args as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({
      storeId: STORE_ID,
      openedByUserId: USER_ID,
      deviceId: null,
      openingCashUsdCents: 10_000,
      openingCashLbp: 500_000,
      notes: null,
    });
    // The client owns the identity, so the backend's INSERT needs no round trip
    // to mint one.
    expect(typeof payload.shiftId).toBe("string");
    expect(payload.shiftId).not.toBe("");
  });

  it("sends close_shift the counted cash and the closing user", async () => {
    invokeMock.mockResolvedValueOnce({ id: SHIFT_A, status: "closed" });

    await shiftsRepo.closeShift({
      shiftId: SHIFT_A,
      storeId: STORE_ID,
      userId: USER_ID,
      closingCashUsdCents: 11_000,
      closingCashLbp: 700_000,
    });

    expect(invokeMock).toHaveBeenCalledWith("close_shift", {
      payload: {
        shiftId: SHIFT_A,
        storeId: STORE_ID,
        closedByUserId: USER_ID,
        closingCashUsdCents: 11_000,
        closingCashLbp: 700_000,
      },
    });
  });

  it("surfaces the backend's refusal rather than swallowing it", async () => {
    // The backend owns the decision now; the UI shows what it says.
    invokeMock.mockRejectedValueOnce(
      new Error("A shift is already open for this store. Close it before opening a new one."),
    );

    await expect(
      shiftsRepo.openShift({
        storeId: STORE_ID,
        userId: USER_ID,
        openingCashUsdCents: 0,
        openingCashLbp: 0,
      }),
    ).rejects.toThrow(/already open/);
  });
});
