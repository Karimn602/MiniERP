// @vitest-environment jsdom
/**
 * SHIFT HISTORY — LATEST-REQUEST-ONLY (Codex WP-A finding 1)
 *
 * Both loaders on this panel are async, and both are re-run by ordinary
 * interaction: a date typed into a filter, a store switched under the panel,
 * a row clicked and then another. Two answers are therefore in flight at once
 * routinely, and nothing promises they come back in the order they were
 * asked. The panel used to write whichever landed last into state, so the
 * SLOWER of two answers won.
 *
 * These tests resolve the responses DELIBERATELY OUT OF ORDER, through
 * deferred promises the test itself controls, so the race is not a timing
 * accident that might or might not reproduce: each case fails against the
 * unguarded loaders and passes against the generation-guarded ones.
 *
 * Nothing here writes. The panel is read-only by construction — but the
 * figures it reads are the cash reconciliation a cashier was held to, and
 * showing the wrong shift's is a reporting error of the same family as
 * getting the arithmetic wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { ShiftHistoryDetail, ShiftHistoryRow } from "../../src/db/repos/shifts";

const listHistory = vi.fn();
const getHistoryDetail = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/db/repos/shifts", () => ({
  shiftsRepo: {
    listHistory: (...a: unknown[]) => listHistory(...a),
    getHistoryDetail: (...a: unknown[]) => getHistoryDetail(...a),
  },
}));

import { ShiftHistoryPanel } from "../../src/components/ShiftHistoryPanel";

// --- A promise the test resolves, when and in whatever order it likes -------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing in these tests asserts on an unhandled rejection; the loader's own
  // catch is the handler under test.
  return { promise, resolve, reject };
}

/** Let the microtask queue drain so a settled promise's continuation has run. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// --- Fixtures ---------------------------------------------------------------

function shift(id: string) {
  return {
    id,
    storeId: "store-1",
    deviceId: null,
    openedByUserId: "u-1",
    closedByUserId: "u-1",
    openedAt: "2026-10-20T08:00:00Z",
    closedAt: "2026-10-20T20:00:00Z",
    openingCashUsdCents: 10000,
    openingCashLbp: 0,
    closingCashUsdCents: 15000,
    closingCashLbp: 0,
    expectedCashUsdCents: 15000,
    expectedCashLbp: 0,
    varianceUsdCents: 0,
    varianceLbp: 0,
    status: "closed" as const,
    notes: null,
  };
}

function row(id: string, cashier: string): ShiftHistoryRow {
  return {
    shift: shift(id),
    openedByName: cashier,
    closedByName: cashier,
  } as ShiftHistoryRow;
}

function detail(id: string, cashier: string): ShiftHistoryDetail {
  return {
    row: row(id, cashier),
    sales: {
      receiptCount: 1,
      totalInclVatCents: 1000,
      subtotalExclVatCents: 901,
      discountCents: 0,
      vatTotalCents: 99,
      netSalesExclVatCents: 901,
    },
    payments: [],
    refunds: {
      memoCount: 0,
      subtotalExclVatCents: 0,
      vatTotalCents: 0,
      totalInclVatCents: 0,
      cogsReversedCents: 0,
    },
    refundRows: [],
    drawer: {
      cashUsdInCents: 5000,
      cashLbpIn: 0,
      changeUsdOutCents: 0,
      changeLbpOut: 0,
      refundUsdOutCents: 0,
      refundLbpOut: 0,
      driverRemitUsdInCents: 0,
      driverRemitLbpIn: 0,
    },
  } as ShiftHistoryDetail;
}

function renderPanel(storeId = "store-1") {
  return render(
    <I18nProvider>
      <ShiftHistoryPanel storeId={storeId} />
    </I18nProvider>,
  );
}

const fromFilter = () =>
  screen.getByText(/^From$/i).closest("label")!.querySelector("input")!;

beforeEach(() => {
  listHistory.mockReset();
  getHistoryDetail.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ===========================================================================
// The LIST
// ===========================================================================

describe("the shift-history LIST accepts only the answer it is still waiting for", () => {
  it("an older filtered response cannot replace a newer one", async () => {
    const first = deferred<ShiftHistoryRow[]>();
    const second = deferred<ShiftHistoryRow[]>();
    listHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    renderPanel();
    // The unfiltered list is in flight. The cashier now types a date, which
    // asks a different question of the same table.
    fireEvent.change(fromFilter(), { target: { value: "2026-10-21" } });
    await flush();
    expect(listHistory).toHaveBeenCalledTimes(2);

    // The NEW query answers first...
    second.resolve([row("s-filtered", "Zeina")]);
    await flush();
    expect(screen.getByText("Zeina")).toBeTruthy();

    // ...and the OLD one answers afterwards, as a slow query does.
    first.resolve([row("s-unfiltered", "Ali")]);
    await flush();

    expect(screen.queryByText("Ali")).toBeNull();
    expect(screen.getByText("Zeina")).toBeTruthy();
  });

  it("an older response cannot clear the spinner of a newer one", async () => {
    const first = deferred<ShiftHistoryRow[]>();
    const second = deferred<ShiftHistoryRow[]>();
    listHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    renderPanel();
    fireEvent.change(fromFilter(), { target: { value: "2026-10-21" } });
    await flush();

    // The superseded request lands. It must not say "loaded" over a list that
    // is still being fetched.
    first.resolve([row("s-unfiltered", "Ali")]);
    await flush();
    expect(screen.getByText(/loading/i)).toBeTruthy();

    second.resolve([row("s-filtered", "Zeina")]);
    await flush();
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(screen.getByText("Zeina")).toBeTruthy();
  });

  it("an older FAILURE cannot post an error over a newer successful list", async () => {
    const first = deferred<ShiftHistoryRow[]>();
    const second = deferred<ShiftHistoryRow[]>();
    listHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    renderPanel();
    fireEvent.change(fromFilter(), { target: { value: "2026-10-21" } });
    await flush();

    second.resolve([row("s-filtered", "Zeina")]);
    await flush();

    first.reject(new Error("database is locked"));
    await flush();

    expect(screen.queryByText(/database is locked/i)).toBeNull();
    expect(screen.getByText("Zeina")).toBeTruthy();
  });

  it("a store change never shows the previous store's history", async () => {
    const first = deferred<ShiftHistoryRow[]>();
    const second = deferred<ShiftHistoryRow[]>();
    listHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const view = renderPanel("store-1");
    view.rerender(
      <I18nProvider>
        <ShiftHistoryPanel storeId="store-2" />
      </I18nProvider>,
    );
    await flush();

    second.resolve([row("s-store-2", "Zeina")]);
    await flush();
    first.resolve([row("s-store-1", "Ali")]);
    await flush();

    expect(screen.queryByText("Ali")).toBeNull();
    expect(screen.getByText("Zeina")).toBeTruthy();
    expect(listHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ storeId: "store-2" }),
    );
  });

  it("writes nothing after the panel has unmounted", async () => {
    const pending = deferred<ShiftHistoryRow[]>();
    listHistory.mockReturnValue(pending.promise);

    const view = renderPanel();
    view.unmount();

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    pending.resolve([row("s-1", "Ali")]);
    await flush();
    spy.mockRestore();

    // React warns on a state update from an unmounted tree; the guard means
    // there is no update for it to warn about.
    expect(errors).toEqual([]);
  });
});

// ===========================================================================
// The DETAIL
// ===========================================================================

describe("the shift-history DETAIL accepts only the answer for the row that is open", () => {
  async function listed() {
    listHistory.mockResolvedValue([row("s-1", "Ali"), row("s-2", "Zeina")]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("Ali")).toBeTruthy());
  }

  it("an older shift's detail cannot land under a newly selected shift", async () => {
    await listed();

    const slow = deferred<ShiftHistoryDetail | null>();
    const fast = deferred<ShiftHistoryDetail | null>();
    getHistoryDetail.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    fireEvent.click(screen.getByText("Ali"));
    await flush();
    fireEvent.click(screen.getByText("Zeina"));
    await flush();

    expect(getHistoryDetail).toHaveBeenNthCalledWith(1, "s-1", "store-1");
    expect(getHistoryDetail).toHaveBeenNthCalledWith(2, "s-2", "store-1");

    // The second click's answer arrives first and is shown.
    fast.resolve(detail("s-2", "Zeina"));
    await flush();
    const openRows = document.querySelectorAll("tbody tr");
    expect(openRows.length).toBeGreaterThan(0);
    const bodyAfterFast = document.body.textContent ?? "";

    // The first click's answer arrives late, for a row nobody has open. The
    // rendered detail must not change at all.
    slow.resolve(detail("s-1", "Ali"));
    await flush();

    expect(document.body.textContent).toBe(bodyAfterFast);
  });

  it("a detail that arrives after the row was collapsed does not reopen it", async () => {
    await listed();

    const pending = deferred<ShiftHistoryDetail | null>();
    getHistoryDetail.mockReturnValueOnce(pending.promise);

    fireEvent.click(screen.getByText("Ali"));
    await flush();
    const whileOpen = document.body.textContent ?? "";

    // Clicking the same row again collapses it while its answer is in flight.
    fireEvent.click(screen.getByText("Ali"));
    await flush();
    const whileClosed = document.body.textContent ?? "";
    expect(whileClosed).not.toBe(whileOpen);

    pending.resolve(detail("s-1", "Ali"));
    await flush();

    expect(document.body.textContent).toBe(whileClosed);
  });

  it("a filter change retires an in-flight detail instead of showing it under the new list", async () => {
    await listed();

    const pending = deferred<ShiftHistoryDetail | null>();
    getHistoryDetail.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByText("Ali"));
    await flush();

    listHistory.mockResolvedValue([row("s-3", "Rami")]);
    fireEvent.change(fromFilter(), { target: { value: "2026-10-22" } });
    await flush();
    const afterFilter = document.body.textContent ?? "";

    pending.resolve(detail("s-1", "Ali"));
    await flush();

    expect(document.body.textContent).toBe(afterFilter);
    expect(screen.queryByText("Ali")).toBeNull();
  });

  it("resolving after the panel is gone updates nothing and throws nothing", async () => {
    await listed();

    const pending = deferred<ShiftHistoryDetail | null>();
    getHistoryDetail.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByText("Ali"));
    await flush();

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    cleanup();
    pending.resolve(detail("s-1", "Ali"));
    await flush();
    spy.mockRestore();

    expect(errors).toEqual([]);
  });
});
