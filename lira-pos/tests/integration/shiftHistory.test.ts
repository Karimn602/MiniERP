/**
 * SQL / read-model integration tests for the SHIFT HISTORY read models
 * (WP-A1): `shiftsRepo.listHistory`, `findHistoryRow` and `getHistoryDetail`.
 *
 * Scope note: repository SQL against node:sqlite with the Tauri SQL plugin
 * mocked out — not an end-to-end Tauri test. See tests/README.md.
 *
 * ## What these tests are really about
 *
 * The figures were never missing. `shifts.expected_cash_*`, `closing_cash_*`
 * and `variance_*` have been columns since migration 001 and immutable since
 * 009; what was missing was any way to read them after the shift closed. So
 * most of what is pinned here is NOT arithmetic — it is that a closed shift's
 * recorded reconciliation comes back EXACTLY as it was written, and that
 * nothing in the read path recomputes, corrects or re-rates it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

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
  RATE_LBP_PER_USD,
  STORE_ID,
  USER_ID,
} from "../helpers/sqlDb";
import { shiftsRepo } from "../../src/db/repos/shifts";

const COFFEE = "prod-coffee";
const DRIVER = "drv-sami";

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedExchangeRate(db);
  seedProduct(db, { id: COFFEE, sku: "SKU-C1", name: "Coffee 250g" });
  seedDriver(db, DRIVER, "Sami");
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

describe("the shift history list", () => {
  it("returns a closed shift with the reconciliation it was closed on", async () => {
    // The whole point of the screen. Before WP-A1 these four figures left the
    // visible application the moment the shift closed.
    seedShift(db, {
      id: "shift-closed",
      status: "closed",
      openingUsdCents: 5_000,
      openingLbp: 1_000_000,
      expectedUsdCents: 12_345,
      expectedLbp: 2_500_000,
      closingUsdCents: 12_300,
      closingLbp: 2_500_000,
    });

    const rows = await shiftsRepo.listHistory({ storeId: STORE_ID });

    expect(rows).toHaveLength(1);
    const s = rows[0].shift;
    expect(s.status).toBe("closed");
    expect(s.openingCashUsdCents).toBe(5_000);
    expect(s.expectedCashUsdCents).toBe(12_345);
    expect(s.closingCashUsdCents).toBe(12_300);
    // −$0.45: short, exactly as recorded. Not recomputed from anything.
    expect(s.varianceUsdCents).toBe(-45);
    expect(s.expectedCashLbp).toBe(2_500_000);
    expect(s.varianceLbp).toBe(0);
  });

  it("names the cashier who opened it and the one who closed it", async () => {
    seedShift(db, { id: "shift-1", status: "closed" });

    const [row] = await shiftsRepo.listHistory({ storeId: STORE_ID });

    // Resolved by join from `users.full_name`; the seeded user is "Owner".
    expect(row.openedByName).toBeTruthy();
    expect(row.closedByName).toBe(row.openedByName);
  });

  it("survives a user row it cannot resolve, rather than dropping the shift", async () => {
    // A LEFT JOIN, deliberately. An inner join would make a shift disappear
    // from its own audit trail because of a reference it does not control —
    // and the shift, not the name, is the thing being accounted for.
    //
    // Inserted in this state rather than updated into it, because migration
    // 009 refuses any UPDATE of a closed shift — which is the invariant the
    // last test in this file pins.
    db.exec(
      `INSERT INTO shifts (id, store_id, opened_by_user_id, closed_by_user_id,
                           opened_at, closed_at, status)
       VALUES ('shift-1', '${STORE_ID}', '${USER_ID}', NULL,
               '2026-03-01T08:00:00.000Z', '2026-03-01T16:00:00.000Z', 'closed')`,
    );

    const [row] = await shiftsRepo.listHistory({ storeId: STORE_ID });
    expect(row.shift.id).toBe("shift-1");
    expect(row.openedByName).toBeTruthy();
    expect(row.closedByName).toBeNull();
  });

  it("includes the OPEN shift, with its reconciliation columns still empty", async () => {
    // Today's shift belongs in its own history, and an open one has nothing
    // recorded yet — which is why the page shows a dash in those columns
    // rather than a running total under a heading that says "at close".
    seedShift(db, { id: "shift-open", openingUsdCents: 2_000 });

    const [row] = await shiftsRepo.listHistory({ storeId: STORE_ID });
    expect(row.shift.status).toBe("open");
    expect(row.shift.expectedCashUsdCents).toBeNull();
    expect(row.shift.closingCashUsdCents).toBeNull();
    expect(row.shift.varianceUsdCents).toBeNull();
  });

  it("lists most recently opened first", async () => {
    seedShift(db, {
      id: "older",
      status: "closed",
      openedAt: "2026-03-01T08:00:00.000Z",
      closedAt: "2026-03-01T16:00:00.000Z",
    });
    seedShift(db, {
      id: "newer",
      status: "closed",
      openedAt: "2026-03-03T08:00:00.000Z",
      closedAt: "2026-03-03T16:00:00.000Z",
    });

    const rows = await shiftsRepo.listHistory({ storeId: STORE_ID });
    expect(rows.map((r) => r.shift.id)).toEqual(["newer", "older"]);
  });

  it("filters by the LOCAL date the shift was opened", async () => {
    // Opened rather than closed: a shift is remembered by the day it started,
    // and an overnight one would otherwise be absent from its own day's list.
    // Local rather than UTC, per `lib/dates.ts` — 06:00Z on the 3rd is the 3rd
    // in Beirut, and the filter is evaluated by SQLite's 'localtime'.
    seedShift(db, {
      id: "march-1",
      status: "closed",
      openedAt: "2026-03-01T09:00:00.000Z",
      closedAt: "2026-03-01T17:00:00.000Z",
    });
    seedShift(db, {
      id: "march-3",
      status: "closed",
      openedAt: "2026-03-03T09:00:00.000Z",
      closedAt: "2026-03-03T17:00:00.000Z",
    });

    expect(
      (await shiftsRepo.listHistory({ storeId: STORE_ID, fromDate: "2026-03-02" })).map(
        (r) => r.shift.id,
      ),
    ).toEqual(["march-3"]);

    expect(
      (await shiftsRepo.listHistory({ storeId: STORE_ID, toDate: "2026-03-02" })).map(
        (r) => r.shift.id,
      ),
    ).toEqual(["march-1"]);

    expect(
      (
        await shiftsRepo.listHistory({
          storeId: STORE_ID,
          fromDate: "2026-03-01",
          toDate: "2026-03-03",
        })
      ).map((r) => r.shift.id),
    ).toEqual(["march-3", "march-1"]);
  });

  it("filters by status when asked", async () => {
    seedShift(db, {
      id: "closed-one",
      status: "closed",
      openedAt: "2026-03-01T08:00:00.000Z",
    });
    seedShift(db, { id: "open-one", openedAt: "2026-03-02T08:00:00.000Z" });

    expect(
      (await shiftsRepo.listHistory({ storeId: STORE_ID, status: "closed" })).map(
        (r) => r.shift.id,
      ),
    ).toEqual(["closed-one"]);
  });

  it("never returns another store's shifts", async () => {
    db.exec(`INSERT INTO stores (id, name) VALUES ('store-2', 'Branch 2')`);
    db.exec(
      `INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status)
       VALUES ('other-store-shift', 'store-2', '${USER_ID}', '2026-03-05T08:00:00.000Z', 'open')`,
    );
    seedShift(db, { id: "mine", openedAt: "2026-03-01T08:00:00.000Z" });

    const rows = await shiftsRepo.listHistory({ storeId: STORE_ID });
    expect(rows.map((r) => r.shift.id)).toEqual(["mine"]);
  });
});

describe("one shift's detail", () => {
  it("reports the sales, tender, returns and drawer movements of THAT shift only", async () => {
    const a = seedShift(db, {
      id: "shift-a",
      status: "closed",
      openingUsdCents: 10_000,
      openedAt: "2026-03-01T08:00:00.000Z",
      closedAt: "2026-03-01T16:00:00.000Z",
      expectedUsdCents: 11_000,
      closingUsdCents: 11_000,
    });
    const b = seedShift(db, { id: "shift-b", openedAt: "2026-03-02T08:00:00.000Z" });

    // Two receipts in A, one in B.
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: a,
      lines: [coffeeLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });
    insertSale(db, {
      postedAt: "2026-03-01T11:00:00.000Z",
      shiftId: a,
      lines: [coffeeLine(1)],
      payments: [{ method: "card_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });
    insertSale(db, {
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: b,
      lines: [coffeeLine(4)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 2_000, usdEquivalent: 2_000 }],
    });

    const detail = await shiftsRepo.getHistoryDetail(a, STORE_ID);
    expect(detail).not.toBeNull();
    expect(detail!.sales.receiptCount).toBe(2);
    expect(detail!.sales.totalInclVatCents).toBe(1_500);
    // The card leg is tender but NOT drawer cash, which is the distinction the
    // drawer figure exists to make.
    expect(detail!.payments.map((p) => p.method).sort()).toEqual(["card_usd", "cash_usd"]);
    expect(detail!.drawer.cashUsdInCents).toBe(1_000);
  });

  it("counts a driver hand-over in THIS shift's drawer, at its native amount", async () => {
    // The WP-7 rule, read back through the history view: a remittance is a
    // drawer event and the NATIVE amount is what the till counts.
    const a = seedShift(db, { id: "shift-a", openingUsdCents: 0 });
    insertDriverLedgerEntry(db, {
      driverId: DRIVER,
      entryType: "remittance",
      amountCents: -1_500,
      entryDate: "2026-03-01",
      postedAt: "2026-03-01T15:00:00.000Z",
      shiftId: a,
      receivedCurrency: "USD",
      receivedNativeUsdCents: 1_500,
    });

    const detail = await shiftsRepo.getHistoryDetail(a, STORE_ID);
    expect(detail!.drawer.driverRemitUsdInCents).toBe(1_500);
    expect(detail!.drawer.driverRemitLbpIn).toBe(0);
  });

  it("counts a cash refund out of THIS shift's drawer", async () => {
    const a = seedShift(db, { id: "shift-a", openingUsdCents: 10_000 });
    const saleId = insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: a,
      lines: [coffeeLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });
    const [itemId] = saleItemIds(db, saleId);
    insertCreditMemo(db, {
      saleId,
      postedAt: "2026-03-01T12:00:00.000Z",
      shiftId: a,
      lines: [
        {
          saleItemId: itemId,
          productId: COFFEE,
          quantityBase: 1,
          subtotalExclVat: 450,
          vat: 50,
          totalInclVat: 500,
        },
      ],
      refunds: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 500, usdEquivalent: 500 }],
    });

    const detail = await shiftsRepo.getHistoryDetail(a, STORE_ID);
    expect(detail!.refunds.memoCount).toBe(1);
    expect(detail!.refunds.totalInclVatCents).toBe(500);
    expect(detail!.drawer.refundUsdOutCents).toBe(500);
    // And the sales figures stay GROSS — returns are their own series, exactly
    // as the live view reads them.
    expect(detail!.sales.totalInclVatCents).toBe(1_000);
  });

  it("returns null for a shift of another store", async () => {
    db.exec(`INSERT INTO stores (id, name) VALUES ('store-2', 'Branch 2')`);
    db.exec(
      `INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status)
       VALUES ('theirs', 'store-2', '${USER_ID}', '2026-03-05T08:00:00.000Z', 'open')`,
    );
    expect(await shiftsRepo.getHistoryDetail("theirs", STORE_ID)).toBeNull();
  });

  it("returns null for a shift that does not exist", async () => {
    expect(await shiftsRepo.getHistoryDetail("no-such-shift", STORE_ID)).toBeNull();
  });
});

describe("a closed shift's reconciliation is history, not a live calculation", () => {
  it("is read from the stored columns, not re-derived from the rows", async () => {
    // THE test this file exists for.
    //
    // The expected-cash formula has changed twice: WP-06 added cash refunds
    // out, WP-7 added driver remittances in. A shift closed before either was
    // closed correctly, on the formula of its day, and migration 009 made the
    // figure immutable. So this fixture states a recorded expectation that
    // today's components do NOT reproduce — the exact shape of a shift closed
    // under an older rule — and the read model must hand back what was
    // written rather than quietly restating the variance the cashier was held
    // to.
    // The shift is OPEN while the hand-over arrives — migration 017 requires
    // that, and it is the real sequence — and is then closed on a figure that
    // did not count it, which is what a shift closed by a pre-WP-7 build looks
    // like.
    const a = seedShift(db, { id: "shift-a", openingUsdCents: 10_000 });
    insertDriverLedgerEntry(db, {
      driverId: DRIVER,
      entryType: "remittance",
      amountCents: -1_500,
      entryDate: "2026-03-01",
      postedAt: "2026-03-01T15:00:00.000Z",
      shiftId: a,
      receivedCurrency: "USD",
      receivedNativeUsdCents: 1_500,
    });
    db.exec(
      `UPDATE shifts
          SET status = 'closed',
              closed_at = '2026-03-01T16:00:00.000Z',
              closed_by_user_id = '${USER_ID}',
              expected_cash_usd_cents = 10000,
              closing_cash_usd_cents = 11500,
              variance_usd_cents = 1500
        WHERE id = '${a}'`,
    );

    const detail = await shiftsRepo.getHistoryDetail(a, STORE_ID);

    // The recorded figures, untouched.
    expect(detail!.row.shift.expectedCashUsdCents).toBe(10_000);
    expect(detail!.row.shift.closingCashUsdCents).toBe(11_500);
    expect(detail!.row.shift.varianceUsdCents).toBe(1_500);

    // And the components are still available, so the screen can SAY that
    // today's formula would make $11,500 of the same rows — rather than
    // silently showing one of the two numbers.
    expect(detail!.drawer.driverRemitUsdInCents).toBe(1_500);
    const recomputed =
      detail!.row.shift.openingCashUsdCents +
      detail!.drawer.cashUsdInCents +
      detail!.drawer.driverRemitUsdInCents -
      detail!.drawer.changeUsdOutCents -
      detail!.drawer.refundUsdOutCents;
    expect(recomputed).toBe(11_500);
    expect(recomputed).not.toBe(detail!.row.shift.expectedCashUsdCents);
  });

  it("uses no current exchange rate: every figure is native or a locked equivalent", async () => {
    // A lira sale's USD equivalent was computed at the rate the SALE locked
    // and is stored on the payment row. Re-rating it would restate a drawer
    // that was counted in notes. The proof: change the store's current rate
    // after the fact and read the shift again — nothing moves.
    const a = seedShift(db, {
      id: "shift-a",
      status: "closed",
      openingLbp: 1_000_000,
      expectedLbp: 5_475_000,
      closingLbp: 5_475_000,
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: a,
      lines: [coffeeLine(10)],
      payments: [
        {
          method: "cash_lbp",
          currency: "LBP",
          nativeLbp: 4_475_000,
          usdEquivalent: 5_000,
        },
      ],
    });

    const before = await shiftsRepo.getHistoryDetail(a, STORE_ID);

    // A new rate, as the shop would enter tomorrow.
    db.exec(
      `INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
       VALUES ('rate-tomorrow', '${STORE_ID}', '2026-06-01', ${RATE_LBP_PER_USD * 2}, 'manual')`,
    );

    const after = await shiftsRepo.getHistoryDetail(a, STORE_ID);

    expect(after!.drawer.cashLbpIn).toBe(before!.drawer.cashLbpIn);
    expect(after!.payments[0].amountUsdCentsEquivalent).toBe(
      before!.payments[0].amountUsdCentsEquivalent,
    );
    expect(after!.row.shift.expectedCashLbp).toBe(5_475_000);
    expect(after!.row.shift.varianceLbp).toBe(0);
  });

  it("stays unchanged after another shift is opened and sales are posted into it", async () => {
    // "A closed shift must remain visible after application restart and after
    // opening another shift" — the restart is the component's problem, but the
    // second half is a read-model guarantee and is pinned here.
    const a = seedShift(db, {
      id: "shift-a",
      status: "closed",
      openingUsdCents: 10_000,
      openedAt: "2026-03-01T08:00:00.000Z",
      closedAt: "2026-03-01T16:00:00.000Z",
      expectedUsdCents: 11_000,
      closingUsdCents: 10_950,
    });
    insertSale(db, {
      postedAt: "2026-03-01T10:00:00.000Z",
      shiftId: a,
      lines: [coffeeLine(2)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 1_000, usdEquivalent: 1_000 }],
    });

    const before = await shiftsRepo.getHistoryDetail(a, STORE_ID);

    // The next day's trade, in its own shift.
    const b = seedShift(db, { id: "shift-b", openedAt: "2026-03-02T08:00:00.000Z" });
    insertSale(db, {
      postedAt: "2026-03-02T10:00:00.000Z",
      shiftId: b,
      lines: [coffeeLine(9)],
      payments: [{ method: "cash_usd", currency: "USD", nativeUsdCents: 4_500, usdEquivalent: 4_500 }],
    });

    const after = await shiftsRepo.getHistoryDetail(a, STORE_ID);

    expect(after!.sales.receiptCount).toBe(before!.sales.receiptCount);
    expect(after!.sales.totalInclVatCents).toBe(before!.sales.totalInclVatCents);
    expect(after!.drawer.cashUsdInCents).toBe(before!.drawer.cashUsdInCents);
    expect(after!.row.shift.varianceUsdCents).toBe(-50);

    // And both shifts are in the list.
    const rows = await shiftsRepo.listHistory({ storeId: STORE_ID });
    expect(rows.map((r) => r.shift.id)).toEqual(["shift-b", "shift-a"]);
  });

  it("cannot be written through this read path, and not by SQL either", async () => {
    // There is no edit control to guard, and no guard is needed: migration
    // 009's trigger refuses the UPDATE outright.
    seedShift(db, {
      id: "shift-a",
      status: "closed",
      expectedUsdCents: 10_000,
      closingUsdCents: 9_000,
    });

    expect(() =>
      db.exec(`UPDATE shifts SET closing_cash_usd_cents = 10000 WHERE id = 'shift-a'`),
    ).toThrow();

    const [row] = await shiftsRepo.listHistory({ storeId: STORE_ID });
    expect(row.shift.closingCashUsdCents).toBe(9_000);
    expect(row.shift.varianceUsdCents).toBe(-1_000);
  });
});
