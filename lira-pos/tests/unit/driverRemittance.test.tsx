// @vitest-environment jsdom
/**
 * WP-7 §4 — recording a driver hand-over, through the real Drivers screen.
 *
 * Since migration 016 a remittance moves DRAWER CASH. That changes what a
 * retry costs: before, re-sending one under a fresh identity double-counted a
 * driver's balance; now it also makes the till expect twice the money that
 * actually arrived, and the shift comes up short by exactly the amount the
 * driver handed in once.
 *
 * So these tests are about the four things that stop that happening:
 *
 *   * ONE identity per hand-over, minted once and reused by every retry;
 *   * the attempt PERSISTED, and proven persisted, before the command is
 *     invoked;
 *   * a synchronous guard against a double submit;
 *   * an unknown outcome resolved by a READ, never by a guess.
 *
 * The backend boundary is mocked; the Rust side of the same guarantees is
 * pinned against a real database in `src-tauri/src/tests/drivers.rs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/lib/i18n";

const postRemittance = vi.fn();
const findLedgerEntry = vi.fn();
const balances = vi.fn();
const listDrivers = vi.fn();
const ledger = vi.fn();
const getOpenShift = vi.fn();
const getCurrentForToday = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []), execute: vi.fn() }));
vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({ storeId: "store-1", userId: "user-1", hydrated: true }),
}));
vi.mock("../../src/db/repos/drivers", () => ({
  driversRepo: {
    postRemittance: (...a: unknown[]) => postRemittance(...a),
    findLedgerEntry: (...a: unknown[]) => findLedgerEntry(...a),
    balances: (...a: unknown[]) => balances(...a),
    list: (...a: unknown[]) => listDrivers(...a),
    ledger: (...a: unknown[]) => ledger(...a),
    balanceFor: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
  },
}));
vi.mock("../../src/db/repos/exchangeRates", () => ({
  exchangeRatesRepo: { getCurrentForToday: (...a: unknown[]) => getCurrentForToday(...a) },
}));
vi.mock("../../src/db/repos/shifts", () => ({
  shiftsRepo: { getOpenShift: (...a: unknown[]) => getOpenShift(...a) },
}));

import Drivers from "../../src/pages/Drivers";

const PENDING_KEY = "lira_pos_pending_remittances";

const ALI = {
  driverId: "drv-ali",
  storeId: "store-1",
  driverName: "Ali",
  isActive: true,
  outstandingCents: 2_000,
  collectedCents: 3_000,
  remittedCents: 1_000,
  returnCreditCents: 0,
  adjustmentCents: 0,
  collectionCount: 2,
  lastActivityAt: "2026-10-21T10:00:00Z",
};

const RATE = {
  id: "rate-today",
  storeId: "store-1",
  effectiveDate: "2026-10-21",
  rateLbpPerUsd: 89_500,
  source: "manual" as const,
  notes: null,
  createdAt: "2026-10-21T00:00:00Z",
};

const SHIFT = { id: "shift-1", storeId: "store-1", status: "open" as const };

async function renderDrivers() {
  const view = render(
    <MemoryRouter>
      <I18nProvider>
        <Drivers />
      </I18nProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Ali")).toBeTruthy());
  return view;
}

/** Open the hand-over form for Ali and type an amount. */
async function openForm(amount = "12.00") {
  fireEvent.click(screen.getByRole("button", { name: /record money in/i }));
  const box = await waitFor(
    () => screen.getByLabelText(/amount in dollars/i) as HTMLInputElement,
  );
  fireEvent.change(box, { target: { value: amount } });
  return box;
}

const recordBtn = () =>
  screen.getAllByRole("button", { name: /^record money in$/i }).slice(-1)[0] as HTMLButtonElement;

function storedAttempts() {
  const raw = localStorage.getItem(PENDING_KEY);
  return raw ? (JSON.parse(raw) as { entryId: string; state: string; request: Record<string, unknown> }[]) : [];
}

beforeEach(() => {
  localStorage.clear();
  postRemittance.mockReset();
  findLedgerEntry.mockReset();
  balances.mockReset();
  listDrivers.mockReset();
  ledger.mockReset();
  getOpenShift.mockReset();
  getCurrentForToday.mockReset();

  balances.mockResolvedValue([ALI]);
  listDrivers.mockResolvedValue([
    { id: "drv-ali", storeId: "store-1", name: "Ali", phone: null, notes: null, isActive: true,
      createdAt: "x", updatedAt: "x" },
  ]);
  ledger.mockResolvedValue([]);
  getOpenShift.mockResolvedValue(SHIFT);
  getCurrentForToday.mockResolvedValue(RATE);
  findLedgerEntry.mockResolvedValue(null);
  postRemittance.mockResolvedValue({
    ledgerEntryId: "entry-1",
    postedAt: "2026-10-21T18:00:00Z",
    newBalanceCents: 800,
    amountCents: -1_200,
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ===========================================================================
// Persistence before the money moves
// ===========================================================================

describe("the hand-over is persisted before it is sent", () => {
  it("has the frozen attempt in storage AT THE MOMENT the command is called", async () => {
    const seen: { attempts: ReturnType<typeof storedAttempts>; sentId: string }[] = [];
    postRemittance.mockImplementation(async (req: { ledgerEntryId: string }) => {
      seen.push({ attempts: storedAttempts(), sentId: req.ledgerEntryId });
      return {
        ledgerEntryId: req.ledgerEntryId,
        postedAt: "2026-10-21T18:00:00Z",
        newBalanceCents: 800,
        amountCents: -1_200,
      };
    });

    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));

    expect(seen).toHaveLength(1);
    expect(seen[0].attempts).toHaveLength(1);
    // The identity in storage IS the identity that was sent, so a replay can
    // reconcile against the entry this very request may have written.
    expect(seen[0].attempts[0].entryId).toBe(seen[0].sentId);
    expect(seen[0].attempts[0].state).toBe("posting");
    expect(seen[0].attempts[0].request.shiftId).toBe("shift-1");
    expect(seen[0].attempts[0].request.receivedNativeUsdCents).toBe(1_200);
  });

  it("REFUSES to send when the attempt cannot be written", async () => {
    await renderDrivers();
    await openForm("12.00");

    const real = Storage.prototype.setItem;
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, k: string, v: string) {
        if (k === PENDING_KEY) throw new Error("QuotaExceededError");
        return real.call(this, k, v);
      });

    fireEvent.click(recordBtn());
    await waitFor(() => expect(screen.getByText(/was NOT sent/i)).toBeTruthy());
    expect(postRemittance).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("REFUSES to send when the store accepts the write but keeps nothing", async () => {
    await renderDrivers();
    await openForm("12.00");

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      /* accepted, silently dropped */
    });
    fireEvent.click(recordBtn());
    await waitFor(() => expect(screen.getByText(/was NOT sent/i)).toBeTruthy());
    expect(postRemittance).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clears the attempt once the hand-over is recorded", async () => {
    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(storedAttempts()).toHaveLength(0));
    // And the operator is told what moved.
    expect(screen.getByText(/recorded \$12\.00 from ali/i)).toBeTruthy();
  });
});

// ===========================================================================
// One identity per hand-over
// ===========================================================================

describe("identity and retries", () => {
  it("re-sends the SAME identity after an unknown outcome", async () => {
    postRemittance.mockRejectedValueOnce(new Error("window torn down"));
    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());

    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());
    const firstId = postRemittance.mock.calls[0][0].ledgerEntryId;
    expect(storedAttempts()[0].entryId).toBe(firstId);

    fireEvent.click(screen.getByRole("button", { name: /send again/i }));
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(2));
    expect(postRemittance.mock.calls[1][0].ledgerEntryId).toBe(firstId);
  });

  it("replays the FROZEN request, not whatever the form says now", async () => {
    // The backend refuses a replay whose content differs, so rebuilding the
    // request from current state is how a retry becomes a conflict.
    postRemittance.mockRejectedValueOnce(new Error("no answer"));
    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());

    const sentFirst = postRemittance.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: /send again/i }));
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(2));
    expect(postRemittance.mock.calls[1][0]).toEqual(sentFirst);
  });

  it("drops a second submit in the same frame", async () => {
    // `submitting` is React state and invisible to a handler that runs before
    // the rerender. A double-click must not launch two hand-overs.
    let release: (v: unknown) => void = () => {};
    postRemittance.mockImplementation(() => new Promise((r) => (release = r)));

    await renderDrivers();
    await openForm("12.00");
    const btn = recordBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));
    release({
      ledgerEntryId: postRemittance.mock.calls[0][0].ledgerEntryId,
      postedAt: "x",
      newBalanceCents: 800,
      amountCents: -1_200,
    });
  });

  it("gives two SEPARATE hand-overs two identities", async () => {
    // A driver really can hand over $12.00 twice. Identity, not amount,
    // decides — so these must not collide.
    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));

    await openForm("8.00");
    fireEvent.click(recordBtn());
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(2));

    expect(postRemittance.mock.calls[0][0].ledgerEntryId).not.toBe(
      postRemittance.mock.calls[1][0].ledgerEntryId,
    );
  });
});

// ===========================================================================
// Restart recovery, and resolving an unknown outcome by reading
// ===========================================================================

describe("recovery", () => {
  /** A persisted attempt in state `posting` — the window died mid-flight. */
  function seedPending(entryId = "entry-stale") {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify([
        {
          entryId,
          driverId: "drv-ali",
          startedAt: "2026-10-21T17:00:00.000Z",
          state: "posting",
          request: {
            ledgerEntryId: entryId,
            storeId: "store-1",
            driverId: "drv-ali",
            entryType: "remittance",
            entryDate: "2026-10-21",
            receivedCurrency: "USD",
            receivedNativeUsdCents: 1_500,
            receivedNativeLbp: 0,
            shiftId: "shift-OLD",
            createdByUserId: "user-1",
          },
        },
      ]),
    );
  }

  it("promotes a persisted in-flight hand-over to an unknown outcome", async () => {
    seedPending();
    await renderDrivers();
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());
    expect(screen.getByText(/closed while this hand-over/i)).toBeTruthy();
    // No request was re-sent on its own.
    expect(postRemittance).not.toHaveBeenCalled();
  });

  it("resolves a recovered hand-over by READING, and writes nothing", async () => {
    seedPending();
    findLedgerEntry.mockResolvedValue({ id: "entry-stale", amountCents: -1_500 });
    await renderDrivers();
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /check this hand-over/i }));
    await waitFor(() => expect(screen.getByText(/it was recorded/i)).toBeTruthy());

    expect(findLedgerEntry).toHaveBeenCalledWith("entry-stale");
    expect(postRemittance).not.toHaveBeenCalled();
    await waitFor(() => expect(storedAttempts()).toHaveLength(0));
  });

  it("reports NOT RECORDED when no entry carries that identity", async () => {
    seedPending();
    findLedgerEntry.mockResolvedValue(null);
    await renderDrivers();
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /check this hand-over/i }));
    await waitFor(() => expect(screen.getByText(/was NOT recorded/i)).toBeTruthy());
    // Still on screen: it is now safe to send, but that is the operator's call.
    expect(storedAttempts()).toHaveLength(1);
  });

  it("proves NOTHING when the check itself fails", async () => {
    seedPending();
    findLedgerEntry.mockRejectedValue(new Error("database locked"));
    await renderDrivers();
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /check this hand-over/i }));
    await waitFor(() =>
      expect(screen.getByText(/could not be completed/i)).toBeTruthy(),
    );
    expect(storedAttempts()).toHaveLength(1);
  });

  it("replays a recovered hand-over under its ORIGINAL shift, not today's", async () => {
    // The request is frozen, so the shift it names is the one the cash landed
    // in — even after a restart, and even once that shift has been closed.
    seedPending();
    await renderDrivers();
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /send again/i }));
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));
    expect(postRemittance.mock.calls[0][0].shiftId).toBe("shift-OLD");
    expect(postRemittance.mock.calls[0][0].ledgerEntryId).toBe("entry-stale");
  });

  it("ignores a malformed persisted attempt rather than replaying nonsense", async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify([{ entryId: "broken", driverId: "drv-ali", state: "posting" }]),
    );
    await renderDrivers();
    expect(screen.queryByText(/outcome unknown/i)).toBeNull();
  });

  it("discards a recovered hand-over only after confirming", async () => {
    seedPending();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderDrivers();
    await waitFor(() => expect(screen.getByText(/outcome unknown/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(storedAttempts()).toHaveLength(1);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    await waitFor(() => expect(storedAttempts()).toHaveLength(0));
  });
});

// ===========================================================================
// The shift, the cap, and the currency
// ===========================================================================

describe("what the screen refuses", () => {
  it("REFUSES a hand-over with no open shift", async () => {
    // A remittance is drawer cash, so there has to be a drawer to put it in.
    getOpenShift.mockResolvedValue(null);
    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());

    await waitFor(() => expect(screen.getByText(/no shift is open/i)).toBeTruthy());
    expect(postRemittance).not.toHaveBeenCalled();
    expect(storedAttempts()).toHaveLength(0);
  });

  it("REFUSES more than the driver is holding, before sending anything", async () => {
    await renderDrivers();
    await openForm("25.00"); // he holds $20.00
    await waitFor(() =>
      expect(screen.getByText(/more than he is holding/i)).toBeTruthy(),
    );
    expect(recordBtn().disabled).toBe(true);
    fireEvent.click(recordBtn());
    expect(postRemittance).not.toHaveBeenCalled();
  });

  it("accepts a PARTIAL hand-over", async () => {
    await renderDrivers();
    await openForm("5.00");
    expect(recordBtn().disabled).toBe(false);
    fireEvent.click(recordBtn());
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));
    expect(postRemittance.mock.calls[0][0].receivedNativeUsdCents).toBe(500);
  });

  it("sends a lira hand-over in LIRA, with the rate on record", async () => {
    await renderDrivers();
    fireEvent.click(screen.getByRole("button", { name: /record money in/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^LBP$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^LBP$/ }));

    const box = screen.getByLabelText(/amount in lira/i) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "447500" } });
    await waitFor(() => expect(recordBtn().disabled).toBe(false));
    fireEvent.click(recordBtn());
    await waitFor(() => expect(postRemittance).toHaveBeenCalledTimes(1));

    const sent = postRemittance.mock.calls[0][0];
    expect(sent.receivedCurrency).toBe("LBP");
    expect(sent.receivedNativeLbp).toBe(447_500);
    expect(sent.receivedNativeUsdCents).toBe(0);
    expect(sent.exchangeRateId).toBe("rate-today");
    expect(sent.exchangeRateLbpPerUsd).toBe(89_500);
  });

  it("will not take lira with no rate on record", async () => {
    getCurrentForToday.mockRejectedValue(new Error("NO_EXCHANGE_RATE_SET"));
    await renderDrivers();
    fireEvent.click(screen.getByRole("button", { name: /record money in/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^LBP$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^LBP$/ }));

    await waitFor(() =>
      expect(screen.getByText(/no exchange rate on record/i)).toBeTruthy(),
    );
    const box = screen.getByLabelText(/amount in lira/i) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "447500" } });
    expect(recordBtn().disabled).toBe(true);
  });

  it("shows the backend's own refusal verbatim", async () => {
    // The backend reads the balance inside its own transaction and is the
    // authority on the cap. Its sentence is the one the operator needs.
    postRemittance.mockRejectedValue(
      new Error("A remittance of 2500 cents is more than the 2000 cents Ali is holding."),
    );
    await renderDrivers();
    await openForm("12.00");
    fireEvent.click(recordBtn());
    // Shown in the form and echoed on the unresolved panel, so both count.
    await waitFor(() =>
      expect(screen.getAllByText(/more than the 2000 cents/i).length).toBeGreaterThan(0),
    );
  });
});
