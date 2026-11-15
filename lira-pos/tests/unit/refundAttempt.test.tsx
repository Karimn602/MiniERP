// @vitest-environment jsdom
/**
 * Codex V1.1 P0 — a refund's identity must outlive the screen that minted it.
 *
 * The return modal used to hold the credit-memo identity in a `useRef`, so a
 * refund that committed and lost its answer could be re-submitted after a
 * restart under a NEW identity, paying a partly returned sale twice. These
 * tests drive the REAL modal across UNMOUNTS (a remount is what a restart, a
 * lock, a logout and a navigation all look like to it), with the backend
 * mocked at the repo boundary. The backend's own replay contract is pinned in
 * `src-tauri/src/tests/returns.rs`.
 *
 * A test that only retries inside one mounted modal would prove nothing here,
 * so every scenario below unmounts between the lost answer and the recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { PostCreditMemoInput } from "../../src/db/repos/creditMemos";
import {
  PENDING_REFUNDS_KEY,
  beginRefundAttempt,
  clearRefundAttempt,
  isUsableRefundAttempt,
  loadPendingRefunds,
  persistPendingRefunds,
  refundInFlight,
  sendRefundAttempt,
  type RefundStorage,
} from "../../src/lib/refundAttempt";

const postFrozen = vi.fn();
const probeIdentity = vi.fn();
let idCounter = 0;

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []), execute: vi.fn() }));
vi.mock("../../src/db/repos/creditMemos", () => ({
  creditMemosRepo: {
    returnableLines: vi.fn(async () => [LINE]),
    refundAvailability: vi.fn(async () => [CASH_USD]),
    freeze: (input: Record<string, unknown> & { lines: object[]; refunds: object[] }) => ({
      ...input,
      lines: input.lines.map((l) => ({ ...l, creditMemoLineId: `line-${++idCounter}` })),
      refunds: input.refunds.map((r) => ({ ...r, refundId: `leg-${++idCounter}` })),
    }),
    postFrozen: (...a: unknown[]) => postFrozen(...a),
    probeIdentity: (...a: unknown[]) => probeIdentity(...a),
  },
}));
vi.mock("../../src/db/repos/sales", () => ({
  salesRepo: { findById: vi.fn(async () => ({ exchangeRateLbpPerUsd: 89_500 })) },
}));
vi.mock("../../src/db/repos/shifts", () => ({
  shiftsRepo: { getOpenShift: vi.fn(async () => ({ id: "shift-1" })) },
}));
vi.mock("../../src/lib/ids", () => ({ newId: () => `memo-${++idCounter}` }));

import { CreateReturnModal } from "../../src/components/CreateReturnModal";

const LINE = {
  saleItemId: "si-1",
  productId: "p-burger",
  productNameSnapshot: "Burger",
  productSkuSnapshot: null,
  uomCodeSnapshot: "each",
  factorNumSnapshot: 1,
  factorDenSnapshot: 1,
  soldQuantityBase: 3,
  soldQuantityInUom: 3,
  returnedQuantityBase: 0,
  returnedQuantityInUom: 0,
  remainingQuantityBase: 3,
  remainingQuantityInUom: 3,
  unitPriceInclVatCents: 500,
  lineSubtotalExclVatCents: 1351,
  lineVatCents: 149,
  lineTotalInclVatCents: 1500,
  lineDiscountCents: 0,
  vatRateBpsSnapshot: 1100,
  isService: true,
  kitchenNote: null,
};
const CASH_USD = {
  method: "cash_usd",
  currency: "USD",
  availableNative: 1500,
  refundedNative: 0,
  remainingNative: 1500,
};

function mount(userId = "cashier-1") {
  const onPosted = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <I18nProvider>
      <CreateReturnModal
        storeId="store-1"
        userId={userId}
        saleId="sale-1"
        receiptNumber={42}
        saleDateLabel="today"
        onClose={onClose}
        onPosted={onPosted}
      />
    </I18nProvider>,
  );
  return { ...view, onPosted, onClose };
}

async function fillOneBurgerAndSubmit() {
  const qty = await screen.findByRole("spinbutton");
  fireEvent.change(qty, { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Fill" }));
  const submit = screen.getByRole("button", { name: "Post return" });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
}

const pending = () => loadPendingRefunds(localStorage);
const submitButton = () => screen.getByRole("button", { name: "Post return" });

beforeEach(() => {
  localStorage.clear();
  refundInFlight.clear();
  postFrozen.mockReset();
  probeIdentity.mockReset();
  idCounter = 0;
});
afterEach(() => cleanup());

describe("a lost answer BEFORE the commit", () => {
  it("survives a remount, blocks a new return, and re-sends the SAME frozen request", async () => {
    postFrozen.mockRejectedValueOnce(new Error("IPC timed out"));
    probeIdentity.mockResolvedValue(null); // it never committed

    const first = mount();
    await fillOneBurgerAndSubmit();
    await screen.findByText(/did NOT post/);
    // Not shown as a plain failure: the recovery panel, not "Return failed".
    expect(screen.queryByText(/Return failed/)).toBeNull();
    const sent = postFrozen.mock.calls[0][0] as PostCreditMemoInput;
    expect(pending()).toHaveLength(1);
    expect(pending()[0].state).toBe("unknown");
    expect(pending()[0].request).toEqual(sent);

    // RESTART / LOCK / LOGOUT: the modal goes away entirely, and the next
    // person at the till is a different cashier.
    first.unmount();
    postFrozen.mockResolvedValueOnce({ creditMemoNumber: 7 });
    const second = mount("cashier-2");
    expect(await screen.findByTestId("refund-recovery")).toBeTruthy();
    await screen.findByText(/did NOT post/);
    // A new return on this receipt is impossible until it is resolved.
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Send the same return again" }));
    await waitFor(() => expect(second.onPosted).toHaveBeenCalledWith(7));
    const resent = postFrozen.mock.calls[1][0] as PostCreditMemoInput;
    // Byte for byte: same memo id, same line ids, same leg ids, same recorded
    // cashier (the ORIGINAL actor's attribution field), same shift.
    expect(resent).toEqual(sent);
    expect(resent.cashierUserId).toBe("cashier-1");
    expect(pending()).toHaveLength(0);
  });
});

describe("a lost answer AFTER the commit", () => {
  it("is reconciled by identity on remount, and never sent a second time", async () => {
    postFrozen.mockRejectedValueOnce(new Error("window closed"));
    // First probe (inside the failing mount) can't reach the DB either.
    probeIdentity.mockRejectedValueOnce(new Error("db busy"));
    const first = mount();
    await fillOneBurgerAndSubmit();
    await screen.findByText(/could not be read/);
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    first.unmount();

    // After restart the read finds the memo: it DID post.
    probeIdentity.mockResolvedValue({ creditMemoNumber: 9, status: "posted" });
    mount();
    await screen.findByText(/DID post, as credit memo #9/);
    expect(postFrozen).toHaveBeenCalledTimes(1);
    expect(pending()).toHaveLength(0);
    expect(probeIdentity).toHaveBeenLastCalledWith("store-1", "memo-1");
  });
});

describe("a legitimate second partial return", () => {
  it("gets a NEW identity once the first one has resolved", async () => {
    postFrozen
      .mockResolvedValueOnce({ creditMemoNumber: 1 })
      .mockResolvedValueOnce({ creditMemoNumber: 2 });
    const first = mount();
    await fillOneBurgerAndSubmit();
    await waitFor(() => expect(first.onPosted).toHaveBeenCalledWith(1));
    first.unmount();

    const second = mount();
    await fillOneBurgerAndSubmit();
    await waitFor(() => expect(second.onPosted).toHaveBeenCalledWith(2));
    const [a, b] = postFrozen.mock.calls.map((c) => c[0] as PostCreditMemoInput);
    expect(a.creditMemoId).not.toBe(b.creditMemoId);
    expect(pending()).toHaveLength(0);
    expect(probeIdentity).not.toHaveBeenCalled();
  });
});

describe("discarding", () => {
  it("is offered only after a read proved nothing posted, and then frees the receipt", async () => {
    postFrozen.mockRejectedValueOnce(new Error("The drawer does not hold $5.00 in USD cash."));
    probeIdentity.mockResolvedValue(null);
    mount();
    await fillOneBurgerAndSubmit();
    await screen.findByText(/drawer does not hold/);
    fireEvent.click(screen.getByRole("button", { name: /Discard it/ }));
    await waitFor(() => expect(pending()).toHaveLength(0));
    expect(screen.queryByTestId("refund-recovery")).toBeNull();
  });
});

describe("a remount while the request is still on the wire", () => {
  it("shows it as in flight and offers neither a resend nor a discard", async () => {
    let release!: (v: unknown) => void;
    postFrozen.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = mount();
    await fillOneBurgerAndSubmit();
    await waitFor(() => expect(postFrozen).toHaveBeenCalledTimes(1));
    expect(pending()[0].state).toBe("posting"); // persisted BEFORE the invoke
    first.unmount();

    mount();
    await screen.findByText(/still being sent/);
    expect(screen.queryByRole("button", { name: "Send the same return again" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(probeIdentity).not.toHaveBeenCalled();
    release({ creditMemoNumber: 3 });
    // The detached request records its own outcome.
    await waitFor(() => expect(pending()).toHaveLength(0));
  });
});

describe("persist-before-invoke", () => {
  it("refuses to send a return whose attempt cannot be proven stored", async () => {
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === PENDING_REFUNDS_KEY) throw new Error("QuotaExceededError");
      return real.call(this, k, v);
    });
    try {
      mount();
      await fillOneBurgerAndSubmit();
      await screen.findByText(/was NOT sent/);
      expect(postFrozen).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a restart with a persisted 'posting' attempt is treated as unknown and probed", async () => {
    const request = {
      creditMemoId: "memo-old",
      storeId: "store-1",
      originalSaleId: "sale-1",
      shiftId: "shift-1",
      cashierUserId: "cashier-1",
      deviceId: null,
      reason: null,
      notes: null,
      lines: [{ creditMemoLineId: "l1", originalSaleItemId: "si-1", quantityInUom: 1, quantityBase: 1, returnToStock: false }],
      refunds: [{ refundId: "r1", method: "cash_usd", currency: "USD", amountNativeUsdCents: 500, amountNativeLbp: 0, amountUsdCentsEquivalent: 500, reference: null }],
    } as PostCreditMemoInput;
    persistPendingRefunds(localStorage, [
      beginRefundAttempt(request, { receiptNumber: 42, totalUsdCents: 500 }, "2026-11-15T10:00:00Z"),
    ]);
    probeIdentity.mockResolvedValue(null);
    mount();
    await screen.findByText(/did NOT post/);
    expect(probeIdentity).toHaveBeenCalledWith("store-1", "memo-old");
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });
});

/** Make every write of the refund record throw while `on` is true. */
function breakRefundWrites() {
  const ctl = { on: true };
  const real = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    k: string,
    v: string,
  ) {
    if (ctl.on && k === PENDING_REFUNDS_KEY) throw new Error("QuotaExceededError");
    return real.call(this, k, v);
  });
  return { ctl, restore: () => spy.mockRestore() };
}

function seedPendingAttempt(memoId = "memo-old") {
  const request = {
    creditMemoId: memoId,
    storeId: "store-1",
    originalSaleId: "sale-1",
    shiftId: "shift-1",
    cashierUserId: "cashier-1",
    deviceId: null,
    reason: null,
    notes: null,
    lines: [{ creditMemoLineId: "l1", originalSaleItemId: "si-1", quantityInUom: 1, quantityBase: 1, returnToStock: false }],
    refunds: [{ refundId: "r1", method: "cash_usd", currency: "USD", amountNativeUsdCents: 500, amountNativeLbp: 0, amountUsdCentsEquivalent: 500, reference: null }],
  } as PostCreditMemoInput;
  persistPendingRefunds(localStorage, [
    { ...beginRefundAttempt(request, { receiptNumber: 42, totalUsdCents: 500 }, "2026-11-15T10:00:00Z"), state: "unknown" },
  ]);
}

describe("Codex V1.1 P3 — a record that cannot be removed is never reported as cleared", () => {
  it("a probe that finds it POSTED but cannot clear the record keeps it on screen, then clears on retry", async () => {
    seedPendingAttempt();
    probeIdentity.mockResolvedValue({ creditMemoNumber: 11, status: "posted" });
    const broken = breakRefundWrites();
    try {
      const first = mount();
      await screen.findByText(/DID post, as credit memo #11 .* could not clear its record/);
      expect(screen.queryByText(/DID post, as credit memo #11. It is not to be refunded again/)).toBeNull();
      expect(pending()).toHaveLength(1);
      expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
      // No resend and no discard: it posted.
      expect(screen.queryByRole("button", { name: "Send the same return again" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
      first.unmount();

      // RESTART with storage still broken: same safe state.
      mount();
      await screen.findByText(/could not clear its record/);
      expect(pending()).toHaveLength(1);

      // Storage recovers; "Check again" clears it and only THEN reports success.
      broken.ctl.on = false;
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await screen.findByText(/DID post, as credit memo #11. It is not to be refunded again/);
      expect(pending()).toHaveLength(0);
      expect(screen.queryByTestId("refund-recovery")).toBeNull();
      expect(postFrozen).not.toHaveBeenCalled();
    } finally {
      broken.restore();
    }
  });

  it("a discard whose removal fails says so and keeps the receipt blocked", async () => {
    seedPendingAttempt();
    probeIdentity.mockResolvedValue(null);
    mount();
    await screen.findByText(/did NOT post/);
    const broken = breakRefundWrites();
    try {
      fireEvent.click(screen.getByRole("button", { name: /Discard it/ }));
      await screen.findByText(/Not discarded/);
      expect(pending()).toHaveLength(1);
      expect(screen.getByTestId("refund-recovery")).toBeTruthy();
      expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
      broken.ctl.on = false;
      fireEvent.click(screen.getByRole("button", { name: /Discard it/ }));
      await waitFor(() => expect(pending()).toHaveLength(0));
      expect(screen.queryByTestId("refund-recovery")).toBeNull();
    } finally {
      broken.restore();
    }
  });

  it("a fresh refund that posts but cannot clear its record is not reported as closed, and resolves after a remount", async () => {
    const real = Storage.prototype.setItem;
    let writes = 0;
    // Let the persist-before-invoke write succeed; fail the cleanup write.
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === PENDING_REFUNDS_KEY && ++writes >= 2) throw new Error("disk full");
      return real.call(this, k, v);
    });
    postFrozen.mockResolvedValueOnce({ creditMemoNumber: 12 });
    let first: ReturnType<typeof mount>;
    try {
      first = mount();
      await fillOneBurgerAndSubmit();
      await screen.findByText(/DID post, as credit memo #12 .* could not clear its record/);
      expect(first.onPosted).not.toHaveBeenCalled();
      expect(pending()).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    first.unmount();
    probeIdentity.mockResolvedValue({ creditMemoNumber: 12, status: "posted" });
    mount();
    await screen.findByText(/DID post, as credit memo #12. It is not to be refunded again/);
    expect(pending()).toHaveLength(0);
    expect(postFrozen).toHaveBeenCalledTimes(1);
  });

  it("clearRefundAttempt reports a removal that did not stick", () => {
    seedPendingAttempt("m-1");
    const frozen: RefundStorage = {
      getItem: (k) => localStorage.getItem(k),
      setItem: () => {}, // accepts, keeps nothing
    };
    expect(clearRefundAttempt(frozen, "m-1").ok).toBe(false);
    expect(clearRefundAttempt(localStorage, "m-1").ok).toBe(true);
    expect(pending()).toHaveLength(0);
  });
});

describe("the pure record", () => {
  it("rejects a hand-edited or partial attempt", () => {
    expect(isUsableRefundAttempt({ memoId: "x" })).toBe(false);
    expect(isUsableRefundAttempt(null)).toBe(false);
    const store: RefundStorage = { getItem: () => "{not json", setItem: () => {} };
    expect(loadPendingRefunds(store)).toEqual([]);
  });

  it("a storage that silently drops writes is caught by the read-back", async () => {
    const store: RefundStorage = { getItem: () => null, setItem: () => {} };
    const invoke = vi.fn();
    const attempt = beginRefundAttempt(
      {
        creditMemoId: "m",
        storeId: "s",
        originalSaleId: "x",
        shiftId: "sh",
        cashierUserId: null,
        deviceId: null,
        reason: null,
        notes: null,
        lines: [],
        refunds: [],
      },
      { receiptNumber: 1, totalUsdCents: 1 },
      "now",
    );
    const outcome = await sendRefundAttempt(store, attempt, invoke, { fresh: true });
    expect(outcome.kind).toBe("notSent");
    expect(invoke).not.toHaveBeenCalled();
  });
});
