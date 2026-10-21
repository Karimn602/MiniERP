// @vitest-environment jsdom
/**
 * WP-1 — the checkout posting lifecycle, driven through the real register.
 *
 * These are the four P1 financial-recovery findings, each exercised as the
 * cashier would hit it:
 *
 *   P1-A  an in-flight or unknown-outcome post must freeze its cart, keep its
 *         identity and its request, and never be re-entered under a new one.
 *   P1-B  a committed sale whose receipt cannot be read is a SUCCESS with a
 *         display problem, not a failure to be rung up again.
 *   P1-C  a replay must carry the shift, rate, cashier and COGS method the
 *         original attempt carried, not today's.
 *   P1-D  a restored cart must not post before its catalog re-check succeeds.
 *
 * The backend boundary is mocked, but nothing financial is: the register builds
 * its own canonical request and these tests assert on exactly the object that
 * reaches `salesRepo.post`. The Rust side of the same guarantees is pinned in
 * `src-tauri/src/tests/sales.rs` against a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/lib/i18n";
import type { ProductUom, ProductWithUoms } from "../../src/db/types";
import { computeSaleLineMath } from "../../src/lib/saleMath";

const postSale = vi.fn();
const findByIdWithDetails = vi.fn();
const listEnriched = vi.fn();
const getOpenShift = vi.fn();
const getCurrentForToday = vi.fn();
const listDrivers = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({ storeId: "store-1", userId: "user-1", hydrated: true }),
}));
vi.mock("../../src/db/repos/products", () => ({
  productsRepo: {
    listEnriched: (...a: unknown[]) => listEnriched(...a),
    findByScan: vi.fn(async () => null),
  },
}));
vi.mock("../../src/db/repos/exchangeRates", () => ({
  exchangeRatesRepo: { getCurrentForToday: (...a: unknown[]) => getCurrentForToday(...a) },
}));
vi.mock("../../src/db/repos/shifts", () => ({
  shiftsRepo: { getOpenShift: (...a: unknown[]) => getOpenShift(...a) },
}));
vi.mock("../../src/db/repos/drivers", () => ({
  driversRepo: { list: (...a: unknown[]) => listDrivers(...a) },
}));
vi.mock("../../src/db/repos/sales", () => ({
  salesRepo: {
    post: (...a: unknown[]) => postSale(...a),
    findByIdWithDetails: (...a: unknown[]) => findByIdWithDetails(...a),
  },
}));

import PosRegister from "../../src/pages/PosRegister";

// --- Fixtures ---------------------------------------------------------------

const OPEN_CARTS_KEY = "lira_pos_open_carts";
const PRICE = 1000;

const RATE_TODAY = {
  id: "rate-today",
  storeId: "store-1",
  effectiveDate: "2026-10-19",
  rateLbpPerUsd: 89000,
  source: "manual" as const,
  notes: null,
  createdAt: "2026-10-19T00:00:00Z",
};

const SHIFT_TODAY = {
  id: "shift-today",
  storeId: "store-1",
  deviceId: null,
  openedByUserId: "user-1",
  closedByUserId: null,
  openedAt: "2026-10-19T08:00:00Z",
  closedAt: null,
  openingCashUsdCents: 10000,
  openingCashLbp: 0,
  closingCashUsdCents: null,
  closingCashLbp: null,
  expectedCashUsdCents: null,
  expectedCashLbp: null,
  varianceUsdCents: null,
  varianceLbp: null,
  status: "open" as const,
  notes: null,
};

function uom(productId: string): ProductUom {
  return {
    id: `${productId}-pcs`,
    productId,
    uomCode: "pcs",
    factor: { num: 1, den: 1 },
    isBase: true,
    isDefaultSale: true,
    isDefaultPurchase: true,
    isActive: true,
    salePriceExclVatCents: null,
    salePriceInclVatCents: null,
  };
}

function burger(inclVatCents = PRICE): ProductWithUoms {
  const u = uom("p-burger");
  return {
    id: "p-burger",
    storeId: "store-1",
    sku: "SKU-BURGER",
    name: "Double Burger",
    description: null,
    vatRateId: "vat-11",
    vatPricingMode: "inclusive",
    priceExclVatCents: Math.round((inclVatCents * 10000) / 11100),
    priceInclVatCents: inclVatCents,
    avgCostExclVatMicrocents: 300_000_000,
    avgCostInclVatMicrocents: 333_000_000,
    avgCostExclVatCents: 300,
    avgCostInclVatCents: 333,
    quantityOnHand: 50,
    reorderPoint: null,
    isActive: true,
    isService: false,
    category: 'burgers',
    icon: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    uoms: [u],
    baseUom: u,
    defaultSaleUom: u,
    primaryBarcode: null,
    vatRate: {
      id: "vat-11",
      name: "Standard 11%",
      rateBps: 1100,
      isExempt: false,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    },
  };
}

function persistedLine(product: ProductWithUoms, qty: number) {
  return {
    draftId: "draft-1",
    product,
    uom: product.defaultSaleUom,
    quantityInUom: qty,
    barcodeUsed: null,
    barcodeType: null,
    math: computeSaleLineMath({
      quantityInUom: qty,
      factor: product.defaultSaleUom.factor,
      vatBps: product.vatRate.rateBps,
      basePriceExclVatCents: product.priceExclVatCents,
      basePriceInclVatCents: product.priceInclVatCents,
      uomOverrideExclVatCents: null,
      uomOverrideInclVatCents: null,
    }),
  };
}

const BLANK = {
  cashUsdInput: "",
  cashLbpInput: "",
  cardUsdInput: "",
  discountPctInput: "",
  discountAmountInput: "",
};

function seedCarts(carts: Record<string, unknown>[]) {
  localStorage.setItem(OPEN_CARTS_KEY, JSON.stringify(carts));
}

function oneCartWithALine(extra: Record<string, unknown> = {}) {
  seedCarts([
    { id: "cart-1", seq: 1, lines: [persistedLine(burger(), 1)], ...BLANK, ...extra },
  ]);
}

/** A persisted attempt in state `posting` — the app died mid-flight. */
function inFlightAttempt(checkoutId: string, over: Record<string, unknown> = {}) {
  const excl = Math.round((PRICE * 10000) / 11100);
  return {
    checkoutId,
    startedAt: "2026-10-18T22:00:00.000Z",
    state: "posting",
    request: {
      saleId: checkoutId,
      storeId: "store-1",
      cashierUserId: "cashier-LAST-NIGHT",
      deviceId: null,
      shiftId: "shift-LAST-NIGHT",
      exchangeRateId: "rate-LAST-NIGHT",
      exchangeRateLbpPerUsd: 86000,
      notes: null,
      cogsMethod: "weighted_average",
      discountCents: 0,
      allowNegativeInventory: false,
      lines: [
        {
          productId: "p-burger",
          productNameSnapshot: "Double Burger",
          productSkuSnapshot: "SKU-BURGER",
          uomCodeSnapshot: "pcs",
          factorNumSnapshot: 1,
          factorDenSnapshot: 1,
          quantityInUom: 1,
          quantityBase: 1,
          unitPriceExclVatCents: excl,
          unitPriceInclVatCents: PRICE,
          vatRateIdSnapshot: "vat-11",
          vatRateBpsSnapshot: 1100,
          lineSubtotalExclVatCents: excl,
          lineVatCents: PRICE - excl,
          lineTotalInclVatCents: PRICE,
          lineDiscountCents: 0,
          barcodeUsedSnapshot: null,
          barcodeTypeSnapshot: null,
          isService: false,
        },
      ],
      payments: [
        {
          method: "cash_usd",
          currency: "USD",
          amountNativeUsdCents: PRICE,
          amountNativeLbp: 0,
          amountUsdCentsEquivalent: PRICE,
          reference: null,
        },
      ],
    },
    ...over,
  };
}

/** The backend's typed refusal envelope — proof that nothing committed. */
const refusal = (message: string) => ({ refused: true, message });

/** A posted sale, as `findByIdWithDetails` returns one. */
function postedSale(id: string, receiptNumber: number) {
  return {
    id,
    storeId: "store-1",
    receiptNumber,
    status: "posted",
    totalInclVatCents: PRICE,
    subtotalExclVatCents: Math.round((PRICE * 10000) / 11100),
    vatTotalCents: PRICE - Math.round((PRICE * 10000) / 11100),
    discountCents: 0,
    postedAt: "2026-10-19T10:00:00Z",
    lines: [],
    payments: [],
  };
}

async function renderRegister() {
  const view = render(
    <MemoryRouter>
      <I18nProvider>
        <PosRegister />
      </I18nProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: /post sale/i })).toBeTruthy());
  return view;
}

const postButton = () =>
  screen.getByRole("button", { name: /post sale|posting/i }) as HTMLButtonElement;

/**
 * Wait until the register will actually accept a Post.
 *
 * Needed because P1-D genuinely blocks a restored cart until its catalog
 * re-check lands, so a click fired on the first frame is correctly ignored.
 * Tests that are not ABOUT that gate wait for it to open first.
 */
async function awaitReadyToPost() {
  await waitFor(() => expect(postButton().disabled).toBe(false));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  postSale.mockReset();
  findByIdWithDetails.mockReset();
  listEnriched.mockReset();
  getOpenShift.mockReset();
  getCurrentForToday.mockReset();
  listDrivers.mockReset();

  postSale.mockResolvedValue({ saleId: "sale-1", receiptNumber: 1 });
  findByIdWithDetails.mockResolvedValue(postedSale("sale-1", 1));
  listEnriched.mockResolvedValue([burger()]);
  getOpenShift.mockResolvedValue(SHIFT_TODAY);
  getCurrentForToday.mockResolvedValue(RATE_TODAY);
  // The shop's own drivers (WP-6). Active only: a retired driver must never
  // appear in the list an order can be assigned to.
  listDrivers.mockResolvedValue([
    { id: "drv-ali", storeId: "store-1", name: "Ali", phone: null, notes: null, isActive: true,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "drv-hassan", storeId: "store-1", name: "Hassan", phone: null, notes: null, isActive: true,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  ]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ===========================================================================
// P1-A — in flight
// ===========================================================================

describe("while a post is in flight (P1-A)", () => {
  /** A post that never settles until we let it. */
  function pendingPost() {
    let settle!: (v: unknown) => void;
    let fail!: (e: unknown) => void;
    postSale.mockImplementation(
      () =>
        new Promise((res, rej) => {
          settle = res;
          fail = rej;
        }),
    );
    return { settle: (v: unknown) => settle(v), fail: (e: unknown) => fail(e) };
  }

  it("locks the cart against every edit until the outcome is known", async () => {
    oneCartWithALine();
    const p = pendingPost();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    // Lines, tender and discount are all refused while the request is away.
    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    const cashBox = screen.getByLabelText(/cash usd/i) as HTMLInputElement;
    fireEvent.change(cashBox, { target: { value: "50.00" } });
    expect(cashBox.value).toBe("");

    // And the cashier is told why nothing is responding.
    expect(screen.getByText(/sending this payment/i)).toBeTruthy();

    await act(async () => {
      p.settle({ saleId: "sale-1", receiptNumber: 1 });
    });

    // The one request that went out carried one line, as rung.
    expect(postSale).toHaveBeenCalledTimes(1);
    expect(postSale.mock.calls[0][0].lines).toHaveLength(1);
  });

  it("drops rapid repeat presses and F5 instead of posting twice", async () => {
    oneCartWithALine();
    const p = pendingPost();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    fireEvent.click(postButton());
    fireEvent.click(postButton());
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
      fireEvent.keyDown(window, { key: "F5" });
    });

    expect(postSale).toHaveBeenCalledTimes(1);

    await act(async () => {
      p.settle({ saleId: "sale-1", receiptNumber: 1 });
    });
    expect(postSale).toHaveBeenCalledTimes(1);
  });

  it("refuses to clear or discard the cart while the request is on the wire", async () => {
    // The controls are disabled in this window, but the functions behind them
    // must refuse too: throwing the identity away now is the one move that
    // cannot be undone, and the answer may be a second away.
    oneCartWithALine();
    const p = pendingPost();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/sending this payment/i)).toBeTruthy();

    // Every control that would retire the identity is dead in this window.
    const discards = screen.queryAllByRole("button", { name: /discard this attempt/i });
    for (const b of discards) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(b);
    }
    expect(window.confirm).not.toHaveBeenCalled();

    // And the attempt is intact: the response still lands on this cart.
    await act(async () => {
      p.settle({ saleId: "sale-1", receiptNumber: 1 });
    });
    expect(postSale).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/sending this payment/i)).toBeNull());
  });

  it("does not lock or error OTHER carts", async () => {
    seedCarts([
      { id: "cart-1", seq: 1, lines: [persistedLine(burger(), 1)], ...BLANK },
      { id: "cart-2", seq: 2, lines: [], ...BLANK },
    ]);
    const p = pendingPost();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    // Switch to cart 2 and ring something up: it is a different transaction.
    fireEvent.click(screen.getByRole("button", { name: /cart 2/i }));
    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    expect(screen.queryByText(/sending this payment/i)).toBeNull();

    await act(async () => {
      p.settle({ saleId: "sale-1", receiptNumber: 1 });
    });
  });
});

// ===========================================================================
// P1-A — outcome classification
// ===========================================================================

describe("classifying a failed post (P1-A)", () => {
  it("a TYPED refusal frees the cart, because nothing committed", async () => {
    // The backend reached a verdict and rolled back. The cashier may fix the
    // problem and post again — that is not a recovery situation.
    oneCartWithALine();
    postSale.mockRejectedValue(refusal("Insufficient stock for Double Burger."));
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/insufficient stock/i)).toBeTruthy());

    // NOT locked: no unresolved-checkout banner.
    expect(screen.queryByText(/being paid for/i)).toBeNull();
    // And genuinely editable again.
    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    postSale.mockResolvedValue({ saleId: "sale-1", receiptNumber: 1 });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(2));
    expect(postSale.mock.calls[1][0].lines[0].quantityInUom).toBe(2);
  });

  it("reuses the SAME identity after a typed refusal", async () => {
    oneCartWithALine();
    postSale.mockRejectedValue(refusal("Shift is closed."));
    await renderRegister();
    await awaitReadyToPost();
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const firstId = postSale.mock.calls[0][0].saleId;

    postSale.mockResolvedValue({ saleId: firstId, receiptNumber: 1 });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(2));
    // Nothing posted under it, so one corrected checkout is still one checkout.
    expect(postSale.mock.calls[1][0].saleId).toBe(firstId);
  });

  it.each([
    ["a plain Error (IPC/transport)", new Error("IPC channel closed")],
    ["a bare string", "window destroyed"],
    ["an untagged object", { code: 7 }],
    ["undefined", undefined],
    ["a refused:false envelope", { refused: false, message: "not a proof" }],
  ])("treats %s as UNKNOWN and locks the cart", async (_label, thrown) => {
    // The asymmetry is the point: only the backend's own envelope proves a
    // rollback. Everything else may have committed.
    oneCartWithALine();
    postSale.mockRejectedValue(thrown);
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    // Locked: editing is refused.
    const cashBox = screen.getByLabelText(/cash usd/i) as HTMLInputElement;
    fireEvent.change(cashBox, { target: { value: "50.00" } });
    expect(cashBox.value).toBe("");
  });

  it("an unknown outcome keeps its identity and replays it unchanged", async () => {
    oneCartWithALine();
    postSale.mockRejectedValue(new Error("timed out"));
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());
    const sentFirst = postSale.mock.calls[0][0];

    // The retry: same identity, same request, byte for byte.
    postSale.mockResolvedValue({ saleId: sentFirst.saleId, receiptNumber: 42 });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(2));
    const sentAgain = postSale.mock.calls[1][0];
    expect(sentAgain.saleId).toBe(sentFirst.saleId);
    expect(JSON.stringify(sentAgain)).toBe(JSON.stringify(sentFirst));
  });

  it("will not let an unknown outcome be cleared or closed without confirmation", async () => {
    oneCartWithALine();
    postSale.mockRejectedValue(new Error("timed out"));
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderRegister();
    await awaitReadyToPost();
    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    const discards = screen.getAllByRole("button", { name: /discard this attempt/i });
    fireEvent.click(discards[discards.length - 1]);
    expect(String(vi.mocked(window.confirm).mock.calls[0][0])).toMatch(
      /charge the customer twice/i,
    );
    // Declined: still locked.
    expect(screen.getByText(/being paid for/i)).toBeTruthy();
  });
});

// ===========================================================================
// P1-A — reconciliation by identity
// ===========================================================================

describe("reconciling an unknown outcome (P1-A)", () => {
  async function reachUnknown() {
    oneCartWithALine();
    postSale.mockRejectedValue(new Error("no response"));
    await renderRegister();
    await awaitReadyToPost();
    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());
    return postSale.mock.calls[0][0].saleId as string;
  }

  it("finds the committed sale and shows its receipt, writing nothing", async () => {
    const id = await reachUnknown();
    findByIdWithDetails.mockResolvedValue(postedSale(id, 77));

    fireEvent.click(screen.getByRole("button", { name: /check this order/i }));

    await waitFor(() => expect(findByIdWithDetails).toHaveBeenCalledWith(id));
    // The lock is released and the cart cleared, because the sale is done.
    await waitFor(() => expect(screen.queryByText(/being paid for/i)).toBeNull());
    // Crucially: no second post.
    expect(postSale).toHaveBeenCalledTimes(1);
  });

  it("reports NOT COMMITTED when no sale carries that identity", async () => {
    await reachUnknown();
    findByIdWithDetails.mockResolvedValue(null);

    fireEvent.click(screen.getByRole("button", { name: /check this order/i }));
    await waitFor(() =>
      expect(screen.getByText(/did NOT go through/i)).toBeTruthy(),
    );
    // Still locked until the cashier acts, and still replayable.
    expect(screen.getByText(/being paid for/i)).toBeTruthy();
    expect(postSale).toHaveBeenCalledTimes(1);
  });

  it("proves NOTHING when the probe itself fails, and stays locked", async () => {
    await reachUnknown();
    findByIdWithDetails.mockRejectedValue(new Error("database locked"));

    fireEvent.click(screen.getByRole("button", { name: /check this order/i }));
    await waitFor(() =>
      expect(screen.getByText(/nothing is confirmed either way/i)).toBeTruthy(),
    );
    expect(screen.getByText(/being paid for/i)).toBeTruthy();
  });
});

// ===========================================================================
// P1-B — a committed sale whose receipt will not load
// ===========================================================================

describe("receipt loading is not part of posting (P1-B)", () => {
  it("reports SUCCESS with the receipt number when the receipt query throws", async () => {
    oneCartWithALine();
    postSale.mockResolvedValue({ saleId: "sale-xyz", receiptNumber: 501 });
    findByIdWithDetails.mockRejectedValue(new Error("no such column"));
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());

    // Posted. The cashier is given the receipt number and told NOT to re-ring.
    await waitFor(() => expect(screen.getByText(/receipt #501/i)).toBeTruthy());
    expect(screen.getByText(/do not ring this order up again/i)).toBeTruthy();
    // It is a status, not an alert: nothing is wrong with the sale.
    expect(screen.queryByText(/being paid for/i)).toBeNull();
  });

  it("clears the cart on a committed sale even if the receipt fails", async () => {
    oneCartWithALine();
    postSale.mockResolvedValue({ saleId: "sale-xyz", receiptNumber: 501 });
    findByIdWithDetails.mockRejectedValue(new Error("boom"));
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/receipt #501/i)).toBeTruthy());

    // The basket is gone — the sale took it — so a second press cannot
    // re-post it. This is what stops a receipt failure becoming a double sale.
    fireEvent.click(postButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(postSale).toHaveBeenCalledTimes(1);
  });

  it("retries the receipt read without touching the sale", async () => {
    oneCartWithALine();
    postSale.mockResolvedValue({ saleId: "sale-xyz", receiptNumber: 501 });
    findByIdWithDetails.mockRejectedValueOnce(new Error("boom"));
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/receipt #501/i)).toBeTruthy());

    findByIdWithDetails.mockResolvedValue(postedSale("sale-xyz", 501));
    fireEvent.click(screen.getByRole("button", { name: /show receipt/i }));

    await waitFor(() => expect(findByIdWithDetails).toHaveBeenCalledTimes(2));
    expect(postSale).toHaveBeenCalledTimes(1);
  });

  it("says so, without alarm, when the sale posted but has no findable receipt", async () => {
    oneCartWithALine();
    postSale.mockResolvedValue({ saleId: "sale-xyz", receiptNumber: 7 });
    findByIdWithDetails.mockResolvedValue(null);
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/receipt #7/i)).toBeTruthy());
    expect(postSale).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// P1-C — restart recovery carries the whole original request
// ===========================================================================

describe("restart recovery (P1-C)", () => {
  it("promotes a persisted in-flight attempt to an unknown outcome", async () => {
    // The app died with a request on the wire. On restart that is an unknown
    // outcome, not a post still running — so no spinner, and a locked cart.
    oneCartWithALine({ attempt: inFlightAttempt("ck-night"), checkoutId: "ck-night" });
    await renderRegister();
    await awaitReadyToPost();

    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());
    expect(screen.queryByText(/sending this payment/i)).toBeNull();
  });

  it("replays last night's shift, rate, cashier and COGS method", async () => {
    // Today's context is shift-today / rate-today / user-1, and the attempt's
    // is none of those. Every one is compared on replay.
    oneCartWithALine({ attempt: inFlightAttempt("ck-night"), checkoutId: "ck-night" });
    await renderRegister();
    await awaitReadyToPost();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    postSale.mockResolvedValue({ saleId: "ck-night", receiptNumber: 9 });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(sent.saleId).toBe("ck-night");
    expect(sent.shiftId).toBe("shift-LAST-NIGHT");
    expect(sent.exchangeRateId).toBe("rate-LAST-NIGHT");
    expect(sent.exchangeRateLbpPerUsd).toBe(86000);
    expect(sent.cashierUserId).toBe("cashier-LAST-NIGHT");
    expect(sent.cogsMethod).toBe("weighted_average");
  });

  it("replays even with NO open shift and NO exchange rate today", async () => {
    // The morning after, before anyone opens a shift or enters a rate — which
    // is exactly when last night's unresolved checkout is on the screen. The
    // replay needs neither, because its request is frozen.
    oneCartWithALine({ attempt: inFlightAttempt("ck-night"), checkoutId: "ck-night" });
    getOpenShift.mockResolvedValue(null);
    getCurrentForToday.mockRejectedValue(new Error("NO_EXCHANGE_RATE_SET"));
    await renderRegister();
    await awaitReadyToPost();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    postSale.mockResolvedValue({ saleId: "ck-night", receiptNumber: 9 });
    expect(postButton().disabled).toBe(false);
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].shiftId).toBe("shift-LAST-NIGHT");
  });

  it("can reconcile with no open shift today, writing nothing", async () => {
    oneCartWithALine({ attempt: inFlightAttempt("ck-night"), checkoutId: "ck-night" });
    getOpenShift.mockResolvedValue(null);
    findByIdWithDetails.mockResolvedValue(postedSale("ck-night", 31));
    await renderRegister();
    await awaitReadyToPost();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /check this order/i }));
    await waitFor(() => expect(findByIdWithDetails).toHaveBeenCalledWith("ck-night"));
    expect(postSale).not.toHaveBeenCalled();
  });

  it("ignores a malformed persisted attempt rather than replaying nonsense", async () => {
    // Storage is not a trusted input. An attempt that cannot be replayed
    // canonically must not pretend it can.
    oneCartWithALine({
      attempt: { checkoutId: "ck-bad", state: "unknown", request: { saleId: "MISMATCH" } },
      checkoutId: "ck-bad",
    });
    await renderRegister();
    await awaitReadyToPost();

    // Still locked — the bare `checkoutId` makes it a legacy unresolved cart —
    // but it refuses to be re-sent.
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());
    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/cannot be sent again/i)).toBeTruthy());
    expect(postSale).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// P1-D — no posting before revalidation
// ===========================================================================

describe("restored carts await revalidation (P1-D)", () => {
  it("blocks Post Sale and F5 while the catalog is still loading", async () => {
    oneCartWithALine();
    let release!: (v: unknown) => void;
    listEnriched.mockImplementation(() => new Promise((res) => (release = res)));
    await renderRegister();

    expect(screen.getByText(/checking this saved order/i)).toBeTruthy();
    expect(postButton().disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    expect(postSale).not.toHaveBeenCalled();

    await act(async () => {
      release([burger()]);
    });
    await waitFor(() => expect(postButton().disabled).toBe(false));
  });

  it("blocks posting with a visible retry when the catalog load FAILS", async () => {
    oneCartWithALine();
    listEnriched.mockRejectedValue(new Error("catalog unavailable"));
    await renderRegister();

    await waitFor(() =>
      expect(screen.getByText(/prices could not be re-checked/i)).toBeTruthy(),
    );
    expect(postButton().disabled).toBe(true);
    fireEvent.click(postButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(postSale).not.toHaveBeenCalled();

    // Retryable, and posting opens up once it succeeds.
    listEnriched.mockResolvedValue([burger()]);
    fireEvent.click(screen.getByRole("button", { name: /retry menu/i }));
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
  });

  it("does not block a cart rung up in THIS session", async () => {
    // Nothing was restored, so there is nothing to re-check.
    seedCarts([{ id: "cart-1", seq: 1, lines: [], ...BLANK }]);
    await renderRegister();

    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    expect(screen.queryByText(/checking this saved order/i)).toBeNull();
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
  });

  it("does not block the REPLAY of a frozen attempt on a failed catalog", async () => {
    // P1-D must not disable P1-A's recovery: the frozen request depends on no
    // catalog, so a menu failure is irrelevant to it.
    oneCartWithALine({ attempt: inFlightAttempt("ck-night"), checkoutId: "ck-night" });
    listEnriched.mockRejectedValue(new Error("catalog unavailable"));
    await renderRegister();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    expect(screen.queryByText(/prices could not be re-checked/i)).toBeNull();
    postSale.mockResolvedValue({ saleId: "ck-night", receiptNumber: 9 });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
  });
});


// ===========================================================================
// WP-4 — the order channel, in the register
// ===========================================================================

describe("order channel (WP-4)", () => {
  const counterBtn = () => screen.getByRole("button", { name: /^counter$/i }) as HTMLButtonElement;
  // Relabelled "Delivery" by WP-6 — the founder's orders arrive on WhatsApp,
  // not through an online platform. The STORED value is still
  // `online_delivery`, which is the point of the distinction: the label is
  // presentation, the channel is a reporting dimension with history behind it.
  const onlineBtn = () =>
    screen.getByRole("button", { name: /^delivery$/i }) as HTMLButtonElement;

  /**
   * Switch to Delivery AND assign a driver.
   *
   * Since WP-7 a delivery order cannot post without one, so every channel test
   * below goes through this. The channel is still the thing under test; the
   * driver is what makes the order postable at all.
   */
  async function goDelivery(driver = "drv-ali") {
    fireEvent.click(onlineBtn());
    const select = await waitFor(
      () => screen.getByLabelText(/^driver$/i) as HTMLSelectElement,
    );
    fireEvent.change(select, { target: { value: driver } });
  }

  it("defaults a cart to Counter and posts it as Counter", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    expect(counterBtn().getAttribute("aria-pressed")).toBe("true");
    expect(onlineBtn().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].channel).toBe("counter");
  });

  it("posts an Online order as online_delivery", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    await goDelivery();
    expect(onlineBtn().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].channel).toBe("online_delivery");
  });

  it("invents no PLATFORM leg for a delivery order", async () => {
    // The channel is still not a payment method. A delivery order is settled by
    // its driver collecting — one leg, for the food — and nothing is invented
    // because of where the order came from: no platform account, no commission,
    // no third-party receivable. That design was cancelled, not deferred.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    await goDelivery();
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(sent.payments).toHaveLength(1);
    expect(sent.payments[0].method).toBe("driver_collection");
    expect(sent.payments[0].amountNativeUsdCents).toBe(PRICE);
    // And nothing settles it at the till.
    expect(
      sent.payments.some((p: { method: string }) => p.method.startsWith("cash_")),
    ).toBe(false);
  });

  it("keeps a channel per cart, independently", async () => {
    seedCarts([
      { id: "cart-1", seq: 1, lines: [persistedLine(burger(), 1)], ...BLANK },
      { id: "cart-2", seq: 2, lines: [persistedLine(burger(), 1)], ...BLANK },
    ]);
    await renderRegister();
    await awaitReadyToPost();

    // Cart 1 becomes a delivery order.
    await goDelivery();
    expect(onlineBtn().getAttribute("aria-pressed")).toBe("true");

    // Cart 2 is untouched and still a counter order.
    fireEvent.click(screen.getByRole("button", { name: /cart 2/i }));
    expect(counterBtn().getAttribute("aria-pressed")).toBe("true");

    // And switching back finds cart 1 as it was left.
    fireEvent.click(screen.getByRole("button", { name: /cart 1/i }));
    expect(onlineBtn().getAttribute("aria-pressed")).toBe("true");
  });

  it("survives a restart", async () => {
    // Persisted with the cart, like the lines and the tender. The driver comes
    // back with it, which is what makes the order postable at all since WP-7.
    oneCartWithALine({ channel: "online_delivery", driverId: "drv-ali" });
    await renderRegister();
    await awaitReadyToPost();

    expect(onlineBtn().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].channel).toBe("online_delivery");
  });

  it("treats an unrecognised persisted channel as Counter", async () => {
    oneCartWithALine({ channel: "pigeon-post" });
    await renderRegister();
    await awaitReadyToPost();

    expect(counterBtn().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].channel).toBe("counter");
  });

  it("CANNOT be changed once a posting attempt is open (P1-A)", async () => {
    // Posts a delivery order first, so it assigns a driver like any other.
    // The channel is part of the frozen canonical request, so changing it
    // mid-flight would make the retry a conflict. It is refused at the same
    // choke point as a line or a tender, and the control is disabled.
    oneCartWithALine();
    let settle!: (v: unknown) => void;
    postSale.mockImplementation(() => new Promise((res) => (settle = res)));
    await renderRegister();
    await awaitReadyToPost();

    await goDelivery();
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    expect(counterBtn().disabled).toBe(true);
    fireEvent.click(counterBtn());
    expect(onlineBtn().getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      settle({ saleId: "sale-1", receiptNumber: 1 });
    });
    expect(postSale.mock.calls[0][0].channel).toBe("online_delivery");
  });

  it("replays an unresolved order under its ORIGINAL channel", async () => {
    oneCartWithALine();
    postSale.mockRejectedValue(new Error("no response"));
    await renderRegister();
    await awaitReadyToPost();

    await goDelivery();
    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());
    expect(postSale.mock.calls[0][0].channel).toBe("online_delivery");

    // The cart is locked, so the channel cannot be switched before the retry —
    // and the retry carries what was sent.
    expect(counterBtn().disabled).toBe(true);
    postSale.mockResolvedValue({ saleId: postSale.mock.calls[0][0].saleId, receiptNumber: 5 });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(2));
    expect(postSale.mock.calls[1][0].channel).toBe("online_delivery");
  });

  it("starts the next order at Counter after an online one posts", async () => {
    // A cleared cart is a new transaction, and the next customer is at the
    // counter until someone says otherwise.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    await goDelivery();
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(counterBtn().getAttribute("aria-pressed")).toBe("true"));
  });
});


// ===========================================================================
// WP-3 F — the menu grid on a working till
// ===========================================================================

describe("menu sections and the cart (WP-3)", () => {
  /** A two-section menu, so the chip row actually renders. */
  function twoSectionMenu() {
    const fries: ProductWithUoms = {
      ...burger(300),
      id: "p-fries",
      sku: "SKU-FRIES",
      name: "Fries",
      description: null,
      category: "sides",
      icon: null,
      uoms: [{ ...uom("p-fries"), productId: "p-fries", id: "p-fries-pcs" }],
      baseUom: { ...uom("p-fries"), productId: "p-fries", id: "p-fries-pcs" },
      defaultSaleUom: { ...uom("p-fries"), productId: "p-fries", id: "p-fries-pcs" },
    };
    listEnriched.mockResolvedValue([burger(), fries]);
  }

  it("shows a chip per occupied section, with All first", async () => {
    seedCarts([{ id: "cart-1", seq: 1, lines: [], ...BLANK }]);
    twoSectionMenu();
    await renderRegister();

    await waitFor(() => expect(screen.getByRole("button", { name: /burgers/i })).toBeTruthy());
    expect(screen.getByRole("button", { name: /sides/i })).toBeTruthy();
  });

  it("does NOT lose the cart when the section changes", async () => {
    // The explicit WP-3 requirement. The chips filter a VIEW; the cart is
    // state. A cashier part-way through an order has to be able to go to
    // Drinks for the customer's cola without losing the burger.
    seedCarts([{ id: "cart-1", seq: 1, lines: [], ...BLANK }]);
    twoSectionMenu();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("button", { name: /sides/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));

    // Switch section, add from it, switch back.
    fireEvent.click(screen.getByRole("button", { name: /sides/i }));
    expect(screen.queryByRole("button", { name: /double burger/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^fries/i }));
    fireEvent.click(screen.getByRole("button", { name: /burgers/i }));

    // BOTH lines are still on the order, and it posts as one sale.
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.lines).toHaveLength(2);
    expect(sent.lines.map((l: { productId: string }) => l.productId).sort()).toEqual([
      "p-burger",
      "p-fries",
    ]);
  });

  it("keeps the section selection out of the cart entirely", async () => {
    // Belt and braces on the same point: the selected chip is not persisted
    // with the cart and changing it writes nothing to the order.
    seedCarts([{ id: "cart-1", seq: 1, lines: [], ...BLANK }]);
    twoSectionMenu();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("button", { name: /sides/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    const before = localStorage.getItem(OPEN_CARTS_KEY);
    fireEvent.click(screen.getByRole("button", { name: /sides/i }));
    expect(localStorage.getItem(OPEN_CARTS_KEY)).toBe(before);
  });

  it("shows a product's description on its tile", async () => {
    // The `meta` slot, fed from `products.description` — the "2 patties" line
    // a cashier is asked about.
    seedCarts([{ id: "cart-1", seq: 1, lines: [], ...BLANK }]);
    const described = { ...burger(), description: "2 patties" };
    listEnriched.mockResolvedValue([described]);
    await renderRegister();

    await waitFor(() => expect(screen.getByText("2 patties")).toBeTruthy());
  });
});

// ===========================================================================
// P1-E — the attempt is DURABLE BEFORE the request is on the wire
//
// The first four findings all assume the frozen attempt is actually in storage
// by the time `post_sale` can commit. It was not: `runPost` queued a React
// state update and let a `useEffect` mirror it, while `salesRepo.post` was
// dispatched synchronously before the component ever re-rendered. So the
// ordering was inverted, and a quota failure on the mirror was swallowed.
//
// These tests pin BOTH halves at the component boundary — the real register,
// the real storage, the real click — because that inversion is invisible from
// a unit test of either side alone: `lib/cartStore.ts` writes correctly when
// it is called, and `lib/postAttempt.ts` freezes correctly when it is asked.
// Only the register decides what happens first.
// ===========================================================================

describe("the attempt is persisted before the request is sent (P1-E)", () => {
  /** The attempt stored against a cart right now, or null. */
  function storedAttempt(cartId = "cart-1") {
    const raw = localStorage.getItem(OPEN_CARTS_KEY);
    if (!raw) return null;
    const carts = JSON.parse(raw) as { id: string; attempt?: unknown }[];
    return carts.find((c) => c.id === cartId)?.attempt ?? null;
  }

  it("has the frozen attempt in storage AT THE MOMENT post_sale is called", async () => {
    // The ordering assertion, and the one the old code failed. The mock runs
    // synchronously inside `salesRepo.post`, so what it sees in localStorage is
    // the state of the store at the instant the request went out — not after
    // React had a chance to commit and flush its effects.
    const seenAtInvoke: { attempt: unknown; sentSaleId: string }[] = [];
    postSale.mockImplementation(async (payload: { saleId: string }) => {
      seenAtInvoke.push({ attempt: storedAttempt(), sentSaleId: payload.saleId });
      return { saleId: payload.saleId, receiptNumber: 7 };
    });

    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    fireEvent.click(postButton());

    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(seenAtInvoke).toHaveLength(1);

    const seen = seenAtInvoke[0].attempt as {
      checkoutId: string;
      state: string;
      request: { saleId: string; lines: unknown[]; payments: unknown[] };
    } | null;

    // Present, not merely queued.
    expect(seen).not.toBeNull();
    // And it is the identity that was actually sent, so a replay of the stored
    // attempt reconciles against the sale this very request may have committed.
    expect(seen!.checkoutId).toBe(seenAtInvoke[0].sentSaleId);
    expect(seen!.request.saleId).toBe(seenAtInvoke[0].sentSaleId);
    // The complete frozen request, not a stub to be rebuilt from live state.
    expect(seen!.state).toBe("posting");
    expect(seen!.request.lines).toHaveLength(1);
    expect(seen!.request.payments).toHaveLength(1);
  });

  it("stores the request byte-for-byte as it is sent", async () => {
    // Whatever is frozen must be what the backend compared, or the retry is a
    // conflict rather than a reconciliation.
    let storedAtInvoke: string | null = null;
    postSale.mockImplementation(async (payload: { saleId: string }) => {
      storedAtInvoke = JSON.stringify(storedAttempt());
      return { saleId: payload.saleId, receiptNumber: 8 };
    });

    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const frozen = JSON.parse(storedAtInvoke!).request;
    const sent = postSale.mock.calls[0][0];
    // `salesRepo.post` mints child ids per call and the backend excludes them
    // from the canonical comparison, so they are the one legitimate difference.
    const strip = (r: Record<string, unknown>) => ({
      ...r,
      lines: (r.lines as Record<string, unknown>[]).map(({ saleItemId: _s, ...l }) => l),
      payments: (r.payments as Record<string, unknown>[]).map(({ paymentId: _p, ...p }) => p),
    });
    expect(strip(frozen)).toEqual(strip(sent));
  });

  it("REFUSES to post when the attempt cannot be written", async () => {
    // Quota, the overwhelmingly common case. The till must not take a payment
    // it may be unable to recognise again.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    const real = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, k: string, v: string) {
        if (k === OPEN_CARTS_KEY) {
          const e = new Error("QuotaExceededError");
          e.name = "QuotaExceededError";
          throw e;
        }
        return real.call(this, k, v);
      });

    fireEvent.click(postButton());

    // The refusal is visible to the cashier, and says NOTHING was charged.
    await waitFor(() => expect(screen.getByText(/was NOT sent/i)).toBeTruthy());
    // And no request was ever dispatched.
    expect(postSale).not.toHaveBeenCalled();

    setItem.mockRestore();
  });

  it("leaves the cart EDITABLE after refusing, because nothing was sent", async () => {
    // The opposite of the unknown-outcome path. There is no identity to
    // reconcile and no sale that might exist, so locking the cart behind a
    // reconciliation offer would strand a perfectly good order.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((k: string) => {
      if (k === OPEN_CARTS_KEY) throw new Error("QuotaExceededError");
    });
    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/was NOT sent/i)).toBeTruthy());
    setItem.mockRestore();

    // Storage works again; the same cart posts normally on the next press.
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
  });

  it("REFUSES when the write is accepted but the store does not keep it", async () => {
    // A store disabled by policy, or a privacy mode, can accept a write and
    // hold nothing. `setItem` never throws, so only a read-back catches it —
    // and this is the case a try/catch around the write cannot see.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      /* accepted, and silently dropped */
    });

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/was NOT sent/i)).toBeTruthy());
    expect(postSale).not.toHaveBeenCalled();

    setItem.mockRestore();
  });

  it("REFUSES when the record lands but the attempt is not in it", async () => {
    // A storage layer that rewrites what it is given — truncating it, keeping
    // an older copy, dropping a field — leaves something in the store that is
    // not what was written. The record here is still valid JSON and still the
    // right shape, so nothing but the read-back comparison notices.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    const real = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, k: string, v: string) {
        if (k === OPEN_CARTS_KEY) {
          // Keep the carts, drop the attempt — the record is valid JSON and
          // the right shape, so nothing but the identity check notices.
          const carts = (JSON.parse(v) as Record<string, unknown>[]).map(
            ({ attempt: _a, ...c }) => c,
          );
          return real.call(this, k, JSON.stringify(carts));
        }
        return real.call(this, k, v);
      });

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/was NOT sent/i)).toBeTruthy());
    expect(postSale).not.toHaveBeenCalled();

    setItem.mockRestore();
  });

  it("a REPLAY still sends the stored attempt when storage has since failed", async () => {
    // Once an attempt is durable, a later storage failure must not block the
    // retry: the identity is already committed and the sale may already exist,
    // so refusing to re-send would leave it unreconcilable. The pre-write guard
    // is on the FIRST attempt only.
    oneCartWithALine({ attempt: inFlightAttempt("checkout-replay") });
    await renderRegister();
    await awaitReadyToPost();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((k: string) => {
      if (k === OPEN_CARTS_KEY) throw new Error("QuotaExceededError");
    });

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].saleId).toBe("checkout-replay");

    setItem.mockRestore();
  });
});

// ===========================================================================
// WP-6 — Greaz driver collection, through the real register
//
// A WhatsApp order is rung up like any other, assigned to one of the shop's
// own drivers, given a delivery charge, and confirmed with a DRIVER COLLECTION
// tender rather than cash. These tests assert on the exact payload that
// reaches `salesRepo.post`, because that payload is what raises the
// receivable — and on the three things that must not happen: the fee becoming
// revenue, the order becoming drawer cash, and a receivable with nobody to owe
// it.
//
// The Rust side of the same guarantees is pinned against a real database in
// `src-tauri/src/tests/drivers.rs`.
// ===========================================================================

describe("driver collection (WP-6)", () => {
  const counterBtn = () => screen.getByRole("button", { name: /^counter$/i }) as HTMLButtonElement;
  const deliveryBtn = () =>
    screen.getByRole("button", { name: /^delivery$/i }) as HTMLButtonElement;
  const driverSelect = () => screen.getByLabelText(/^driver$/i) as HTMLSelectElement;
  const feeInput = () => screen.getByLabelText(/delivery charge/i) as HTMLInputElement;
  // A statement of the tender, not a control: a WhatsApp order is settled by
  // its driver collecting and the cashier gets no choice about it (WP-7 SS3).
  const collectTender = () => screen.getByTestId("driver-collection-tender");
  /** Is this order driver-collected? Derived in the register, read here. */
  const isDriverCollected = () => collectTender().getAttribute("data-active") === "true";

  /** Switch to delivery, pick Ali, and type a fee. */
  async function setUpDelivery(fee = "3.00", driver = "drv-ali") {
    fireEvent.click(deliveryBtn());
    await waitFor(() => expect(driverSelect()).toBeTruthy());
    fireEvent.change(driverSelect(), { target: { value: driver } });
    fireEvent.change(feeInput(), { target: { value: fee } });
  }

  it("shows no driver controls on a counter order", async () => {
    // A driver and a delivery charge mean nothing at the counter, and
    // `post_sale` refuses them there.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    expect(counterBtn().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText(/^driver$/i)).toBeNull();
    expect(screen.queryByLabelText(/delivery charge/i)).toBeNull();
  });

  it("posts the food as the sale and the fee BESIDE it", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");

    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(sent.channel).toBe("online_delivery");
    expect(sent.driverId).toBe("drv-ali");
    expect(sent.deliveryFeeCents).toBe(300);

    // The tender settles the FOOD, and the fee is nowhere in it: the driver
    // keeps the fee, so claiming it would be claiming money the shop agreed
    // is his.
    expect(sent.payments).toHaveLength(1);
    expect(sent.payments[0].method).toBe("driver_collection");
    expect(sent.payments[0].amountUsdCentsEquivalent).toBe(PRICE);
    expect(sent.payments[0].amountNativeUsdCents).toBe(PRICE);

    // And the line total is untouched by the fee.
    expect(sent.lines[0].lineTotalInclVatCents).toBe(PRICE);
  });

  it("shows the food, the fee and what the customer pays as three figures", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");

    // $10.00 of food, $3.00 of delivery, $13.00 out of the customer's pocket.
    expect(screen.getByText(/food \(shop receipt\)/i)).toBeTruthy();
    expect(screen.getByText(/driver delivery fee/i)).toBeTruthy();
    expect(screen.getByText(/customer pays driver/i)).toBeTruthy();
    expect(screen.getByText("$13.00")).toBeTruthy();
  });

  it("tenders NO cash for a driver-collected order", async () => {
    // The auto-pay path would otherwise invent a `cash_usd` row for the full
    // amount — money in a drawer that never received any.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("2.50");
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(
      sent.payments.some((p: { method: string }) => p.method.startsWith("cash_")),
    ).toBe(false);
    expect(sent.payments.every((p: { method: string }) => p.method === "driver_collection")).toBe(
      true,
    );
  });

  it("retires any typed tender when the driver takes over, rather than dropping it silently", async () => {
    // The posting path emits ONE driver_collection leg and nothing else, so
    // cash left in those boxes would never reach the receipt. Money shown on
    // screen that the sale does not record is the defect; clearing it, and
    // closing the boxes, is the fix.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    const cashBox = screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement;
    fireEvent.change(cashBox, { target: { value: "5.00" } });
    expect(cashBox.value).toBe("5.00");

    await setUpDelivery("3.00");

    // Cleared, closed, and explained.
    await waitFor(() => expect((screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/nothing is taken at the till/i)).toBeTruthy();

    // And the posted tender is the driver leg alone, for the food total.
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.payments).toHaveLength(1);
    expect(sent.payments[0].method).toBe("driver_collection");
    expect(sent.payments[0].amountUsdCentsEquivalent).toBe(PRICE);
  });

  it("reopens the tender boxes when the driver is unassigned", async () => {
    // There is no way to switch the collection off while a driver is assigned —
    // a WhatsApp order is settled by its driver, full stop. Unassigning him is
    // what hands the order back to the till, and the boxes open again with it.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");
    expect((screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement).disabled).toBe(
      true,
    );

    fireEvent.change(driverSelect(), { target: { value: "" } });
    expect((screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText(/nothing is taken at the till/i)).toBeNull();
  });

  it("REFUSES to post a driver collection with no driver chosen", async () => {
    // A receivable has to be owed by somebody.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(deliveryBtn());
    await waitFor(() => expect(driverSelect()).toBeTruthy());
    // The tender reads inactive until a driver is named, and the order cannot
    // post at all — so an unowed receivable is unreachable, and so is the
    // auto-pay cash row that an unassigned delivery order used to fall through
    // to.
    expect(isDriverCollected()).toBe(false);
    await waitFor(() =>
      expect(screen.getByText(/choose the driver who is taking this order/i)).toBeTruthy(),
    );
    expect(postButton().disabled).toBe(true);

    // Typing a fee does not change the verdict: the missing driver is the
    // thing to report, and it is reported before anything about the charge.
    fireEvent.change(feeInput(), { target: { value: "3.00" } });
    await waitFor(() =>
      expect(screen.getByText(/choose the driver who is taking this order/i)).toBeTruthy(),
    );
    expect(postButton().disabled).toBe(true);
    fireEvent.click(postButton());
    expect(postSale).not.toHaveBeenCalled();
  });

  it("REFUSES to post an unreadable delivery charge", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.456");

    await waitFor(() => expect(screen.getByText(/as an amount/i)).toBeTruthy());
    expect(postButton().disabled).toBe(true);
    fireEvent.click(postButton());
    expect(postSale).not.toHaveBeenCalled();
  });

  it("posts a delivery order with a FREE delivery", async () => {
    // Rung up before the charge is agreed, which is the common case.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("");
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].deliveryFeeCents).toBe(0);
  });

  it("ALWAYS settles a delivery order through its driver, never as cash", async () => {
    // The replacement for the old "prepaid delivery" case, whose premise WP-7
    // removed. The confirmed workflow has one shape: the driver collects. So
    // there is no way to ring up a WhatsApp order and have the till take the
    // money, which is what the auto-pay path would otherwise do with a blank
    // tender.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");

    expect(isDriverCollected()).toBe(true);
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(sent.driverId).toBe("drv-ali");
    expect(sent.deliveryFeeCents).toBe(300);
    expect(sent.payments).toHaveLength(1);
    expect(sent.payments[0].method).toBe("driver_collection");
    expect(
      sent.payments.some((p: { method: string }) => p.method.startsWith("cash_")),
    ).toBe(false);
  });

  it("clears the driver and fee when the order goes back to Counter", async () => {
    // Otherwise the cart would carry a driver into a counter sale, which the
    // backend refuses — and rightly.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");

    fireEvent.click(counterBtn());
    expect(screen.queryByLabelText(/^driver$/i)).toBeNull();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.channel).toBe("counter");
    expect(sent.driverId).toBeNull();
    expect(sent.deliveryFeeCents).toBe(0);
    expect(sent.payments[0].method).toBe("cash_usd");
  });

  it("drops the collection tender when the driver is unassigned", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("0");
    expect(isDriverCollected()).toBe(true);

    fireEvent.change(driverSelect(), { target: { value: "" } });
    expect(isDriverCollected()).toBe(false);
    // And the order stops being postable, rather than quietly becoming cash.
    await waitFor(() => expect(postButton().disabled).toBe(true));
    fireEvent.click(postButton());
    expect(postSale).not.toHaveBeenCalled();
  });

  it("keeps the driver and fee per cart, independently", async () => {
    seedCarts([
      { id: "cart-1", seq: 1, lines: [persistedLine(burger(), 1)], ...BLANK },
      { id: "cart-2", seq: 2, lines: [persistedLine(burger(), 1)], ...BLANK },
    ]);
    await renderRegister();
    await awaitReadyToPost();

    await setUpDelivery("4.00", "drv-hassan");
    fireEvent.click(screen.getByRole("button", { name: /cart 2/i }));
    expect(screen.queryByLabelText(/^driver$/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /cart 1/i }));
    await waitFor(() => expect(driverSelect().value).toBe("drv-hassan"));
    expect(feeInput().value).toBe("4.00");
  });

  it("survives a restart with the driver, the fee and the tender intact", async () => {
    seedCarts([
      {
        id: "cart-1",
        seq: 1,
        lines: [persistedLine(burger(), 1)],
        ...BLANK,
        channel: "online_delivery",
        driverId: "drv-ali",
        deliveryFeeInput: "3.00",
        driverCollect: true,
      },
    ]);
    await renderRegister();
    await awaitReadyToPost();

    expect(driverSelect().value).toBe("drv-ali");
    expect(feeInput().value).toBe("3.00");
    expect(isDriverCollected()).toBe(true);

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.driverId).toBe("drv-ali");
    expect(sent.deliveryFeeCents).toBe(300);
    expect(sent.payments[0].method).toBe("driver_collection");
  });

  it("will not post a persisted DELIVERY cart that has no driver", async () => {
    // A cart hand-edited, or written by an older build that allowed it. It must
    // not post at all: under WP-7 a delivery order needs a driver, and the old
    // behaviour here was the dangerous one — the blank tender fell through to
    // the auto-pay path and the order posted as cashier cash, putting money in
    // a drawer nobody had handed anything to.
    seedCarts([
      {
        id: "cart-1",
        seq: 1,
        lines: [persistedLine(burger(), 1)],
        ...BLANK,
        channel: "online_delivery",
        driverId: null,
        driverCollect: true,
      },
    ]);
    await renderRegister();
    // Deliberately NOT `awaitReadyToPost()`: this cart must never become
    // postable, so waiting for that is waiting for the defect.
    await waitFor(() =>
      expect(screen.getByText(/choose the driver who is taking this order/i)).toBeTruthy(),
    );
    expect(isDriverCollected()).toBe(false);
    expect(postButton().disabled).toBe(true);
    fireEvent.click(postButton());
    expect(postSale).not.toHaveBeenCalled();

    // Assigning one makes it postable, as a driver collection.
    fireEvent.change(driverSelect(), { target: { value: "drv-hassan" } });
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].payments[0].method).toBe("driver_collection");
    expect(postSale.mock.calls[0][0].driverId).toBe("drv-hassan");
  });

  it("CANNOT change the driver once a posting attempt is open (P1-A)", async () => {
    // The driver is part of the frozen canonical request: the receivable a
    // retry raises must be owed by the driver the cashier chose.
    oneCartWithALine({ attempt: inFlightAttempt("ck-driver") });
    await renderRegister();
    await awaitReadyToPost();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    // Visible, so the cashier can see what the unresolved order was, but not
    // editable.
    expect(deliveryBtn().disabled).toBe(true);
  });

  it("freezes the driver and fee into the attempt before posting", async () => {
    // The P1-E guarantee, for the delivery fields specifically: whatever is
    // replayed must carry the same driver, or the backend refuses it as a
    // conflict and the receivable is unreconcilable.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");

    let frozen: { driverId?: string; deliveryFeeCents?: number } | null = null;
    postSale.mockImplementation(async (payload: { saleId: string }) => {
      const raw = localStorage.getItem(OPEN_CARTS_KEY)!;
      const carts = JSON.parse(raw) as {
        id: string;
        attempt?: { request: { driverId?: string; deliveryFeeCents?: number } };
      }[];
      frozen = carts.find((c) => c.id === "cart-1")?.attempt?.request ?? null;
      return { saleId: payload.saleId, receiptNumber: 11 };
    });

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(frozen).not.toBeNull();
    expect(frozen!.driverId).toBe("drv-ali");
    expect(frozen!.deliveryFeeCents).toBe(300);
  });

  it("reports a driver list that could not be read, and keeps counter trade working", async () => {
    // Counter orders must not go down because the driver table is unreadable.
    listDrivers.mockRejectedValueOnce(new Error("DB locked"));
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(deliveryBtn());
    await waitFor(() =>
      expect(screen.getByText(/driver list could not be loaded/i)).toBeTruthy(),
    );

    // And a counter sale still posts.
    fireEvent.click(counterBtn());
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].channel).toBe("counter");
  });
});

// ===========================================================================
// P1-F — no other writer may undo the verified pre-dispatch write
//
// P1-E proved the attempt is in storage at the instant `post_sale` is called.
// This proves it STAYS there while the request is on the wire, against the
// register's own whole-array writers — the restored-cart revalidation effect
// (which reads `carts` outside its dependency array) and `closeCart` (which
// captures `carts` and then blocks on `window.confirm`).
//
// Both used to assign a snapshot wholesale. Both now merge by id, and the
// mirror write is refused outright if it would drop a live attempt
// (`lib/cartStore.ts`), so the proof cannot be undone by a writer that knows
// nothing about checkouts.
// ===========================================================================

describe("a verified attempt survives every other writer (P1-F)", () => {
  function storedAttemptFor(cartId: string) {
    const raw = localStorage.getItem(OPEN_CARTS_KEY);
    if (!raw) return null;
    const carts = JSON.parse(raw) as { id: string; attempt?: { checkoutId: string } }[];
    return carts.find((c) => c.id === cartId)?.attempt ?? null;
  }

  it("survives another cart being CLOSED while the request is on the wire", async () => {
    // `closeCart` captures `carts`, then blocks on a confirm dialog. By the
    // time the cashier answers, the snapshot can be older than the attempt.
    let release: (v: unknown) => void = () => {};
    postSale.mockImplementation(() => new Promise((r) => (release = r)));

    seedCarts([
      { id: "cart-1", seq: 1, lines: [persistedLine(burger(), 1)], ...BLANK },
      { id: "cart-2", seq: 2, lines: [persistedLine(burger(), 1)], ...BLANK },
    ]);
    await renderRegister();
    await awaitReadyToPost();

    // Post cart 1 and leave it in flight.
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const live = storedAttemptFor("cart-1") as { checkoutId: string } | null;
    expect(live).not.toBeNull();

    // Now close cart 2.
    fireEvent.click(screen.getByRole("button", { name: /cart 2/i }));
    const closers = screen.getAllByRole("button", { name: /close|×/i });
    for (const b of closers) fireEvent.click(b);

    // Cart 1's attempt is untouched, identity and all.
    await waitFor(() =>
      expect((storedAttemptFor("cart-1") as { checkoutId: string } | null)?.checkoutId).toBe(
        live!.checkoutId,
      ),
    );

    release({ saleId: live!.checkoutId, receiptNumber: 3 });
  });

  it("survives a catalog revalidation pass that reprices the OTHER cart", async () => {
    // The revalidation effect computes a whole `carts` array from a snapshot
    // and used to assign it. A cart that acquired an attempt in the meantime
    // would have lost it.
    let release: (v: unknown) => void = () => {};
    postSale.mockImplementation(() => new Promise((r) => (release = r)));

    seedCarts([
      { id: "cart-1", seq: 1, lines: [persistedLine(burger(), 1)], ...BLANK },
      { id: "cart-2", seq: 2, lines: [persistedLine(burger(), 1)], ...BLANK },
    ]);
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const live = storedAttemptFor("cart-1") as { checkoutId: string } | null;
    expect(live).not.toBeNull();

    // The catalog comes back with a different price, which is what makes the
    // revalidation pass rewrite carts at all.
    listEnriched.mockResolvedValue([burger(1500)]);
    await act(async () => {
      await Promise.resolve();
    });

    expect((storedAttemptFor("cart-1") as { checkoutId: string } | null)?.checkoutId).toBe(
      live!.checkoutId,
    );

    release({ saleId: live!.checkoutId, receiptNumber: 4 });
  });

  it("lets a SETTLED attempt leave storage, so a restart does not re-offer it", async () => {
    // The barrier must not become a leak: once a sale commits, the attempt is
    // retired deliberately and has to go. Otherwise the cart comes back
    // offering reconciliation for a sale that is already settled.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(storedAttemptFor("cart-1")).toBeNull());
  });

  it("lets a REFUSED attempt leave storage, because nothing committed", async () => {
    postSale.mockRejectedValue(refusal("Line 1: price changed"));
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/price changed/i)).toBeTruthy());
    await waitFor(() => expect(storedAttemptFor("cart-1")).toBeNull());
  });

  it("KEEPS an unknown-outcome attempt in storage for recovery", async () => {
    // The opposite case, and the one the barrier exists for: no verdict
    // reached us, the sale may exist, and the identity is the only way to find
    // out. It must still be there after a restart.
    postSale.mockRejectedValue(new Error("window torn down"));
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());

    const kept = storedAttemptFor("cart-1") as { checkoutId: string; state: string } | null;
    expect(kept).not.toBeNull();
    expect(kept!.state).toBe("unknown");
  });
});

// ===========================================================================
// WP-7 item 7 — the UI/backend tender gap cannot reach the cashier
//
// `post_sale` still ACCEPTS a delivery order settled by cash or card alongside
// a driver: it validates coherence, not workflow, and a part-prepaid delivery
// is a legitimate financial shape. The UI, since WP-7, permits only one shape —
// a driver collection — because that is the confirmed process.
//
// A gap like that is only safe if no cashier-facing path reaches the permissive
// side. These tests walk the ways a cart could carry cash into a delivery
// order and assert that none of them posts one.
// ===========================================================================

describe("no cashier path can settle a delivery order at the till (WP-7 item 7)", () => {
  // Local copies: this block sits outside the WP-6 describe that owns them.
  const counterBtn = () => screen.getByRole("button", { name: /^counter$/i }) as HTMLButtonElement;
  const deliveryBtn = () =>
    screen.getByRole("button", { name: /^delivery$/i }) as HTMLButtonElement;
  const driverSelect = () => screen.getByLabelText(/^driver$/i) as HTMLSelectElement;
  const isDriverCollected = () =>
    screen.getByTestId("driver-collection-tender").getAttribute("data-active") === "true";

  async function setUpDelivery(fee = "3.00", driver = "drv-ali") {
    fireEvent.click(deliveryBtn());
    await waitFor(() => expect(driverSelect()).toBeTruthy());
    fireEvent.change(driverSelect(), { target: { value: driver } });
    fireEvent.change(screen.getByLabelText(/delivery charge/i), { target: { value: fee } });
  }

  it("ignores cash a cart was PERSISTED with", async () => {
    // The dangerous shape: a cart parked as a counter order with cash typed in,
    // then switched to delivery after a restart. The inputs are restored from
    // storage, so clearing them on assignment is not enough on its own —
    // `buildFrozenRequest` must not read them at all.
    seedCarts([
      {
        id: "cart-1",
        seq: 1,
        lines: [persistedLine(burger(), 1)],
        ...BLANK,
        cashUsdInput: "10.00",
        cardUsdInput: "5.00",
        channel: "online_delivery",
        driverId: "drv-ali",
      },
    ]);
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(sent.payments).toHaveLength(1);
    expect(sent.payments[0].method).toBe("driver_collection");
    expect(sent.payments[0].amountUsdCentsEquivalent).toBe(PRICE);
    // Not a cent of the persisted cash or card reached the wire.
    expect(
      sent.payments.some((p: { method: string }) => p.method !== "driver_collection"),
    ).toBe(false);
  });

  it("clears typed cash the moment a driver is assigned", async () => {
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.change(screen.getByLabelText(/^cash usd received$/i), {
      target: { value: "10.00" },
    });
    fireEvent.click(deliveryBtn());
    await waitFor(() => expect(driverSelect()).toBeTruthy());
    fireEvent.change(driverSelect(), { target: { value: "drv-ali" } });

    expect((screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement).value).toBe("");
  });

  it("offers no control that could add a till tender to a delivery order", async () => {
    // Both cash boxes are closed, and there is no toggle to reopen them while a
    // driver is assigned. The tender is stated, not chosen.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");

    expect((screen.getByLabelText(/^cash usd received$/i) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText(/cash lbp received/i) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: /driver collects/i })).toBeNull();
    expect(isDriverCollected()).toBe(true);
  });

  it("posts a COUNTER order from the same cart as ordinary cash", async () => {
    // The control: the permissive backend is reachable for counter trade,
    // which is exactly where cash belongs. The gap costs counter sales nothing.
    oneCartWithALine();
    await renderRegister();
    await awaitReadyToPost();
    await setUpDelivery("3.00");
    fireEvent.click(counterBtn());

    fireEvent.change(screen.getByLabelText(/^cash usd received$/i), {
      target: { value: "10.00" },
    });
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    const sent = postSale.mock.calls[0][0];
    expect(sent.channel).toBe("counter");
    expect(sent.driverId).toBeNull();
    expect(sent.payments[0].method).toBe("cash_usd");
  });
});

// ===========================================================================
// GZ-P1-2 at the component boundary — the register's side of the contract
//
// The two defects themselves are staged in `cartStore.test.ts`, where a stale
// write can be constructed directly: an older-but-valid attempt arriving for a
// cart whose storage holds a newer one, and a retirement permission outliving
// the identity it was granted for. React will not reorder its own effects on
// demand, and inventing a way to make it would be testing the mock.
//
// What belongs HERE is the wiring those unit rules depend on: the register must
// mint a retirement permission that names the identity it retired, or the
// barrier it now faces would never let a settled attempt out of storage — and a
// cart would come back from every restart looking like an unresolved checkout
// for a sale that is already banked.
// ===========================================================================

describe("retirement and re-checkout carry their identity (GZ-P1-2)", () => {
  function storedAttemptRow(cartId = "cart-1") {
    const raw = localStorage.getItem(OPEN_CARTS_KEY);
    if (!raw) return null;
    const carts = JSON.parse(raw) as { id: string; attempt?: { checkoutId: string; state: string } }[];
    return carts.find((c) => c.id === cartId)?.attempt ?? null;
  }

  it("lets a COMMITTED checkout's attempt leave storage", async () => {
    // The permission path, end to end. If the register minted a permission the
    // barrier did not recognise, this attempt would be stuck in the record for
    // ever and the next restart would offer to reconcile a settled sale.
    oneCartWithALine();
    postSale.mockResolvedValue({ saleId: "sale-1", receiptNumber: 1 });
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(storedAttemptRow()).toBeNull());
  });

  it("persists the SECOND checkout's own identity, not the first one's", async () => {
    // Two sales in a row on one cart. The identity in storage must be the one
    // on the wire at each step: that is the whole point of the record.
    oneCartWithALine();
    postSale.mockResolvedValue({ saleId: "sale-1", receiptNumber: 1 });
    await renderRegister();
    await awaitReadyToPost();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const firstId = postSale.mock.calls[0][0].saleId;

    // Ring the next customer and let this one's outcome go UNKNOWN, so its
    // attempt stays in storage where it can be inspected.
    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    postSale.mockRejectedValue(new Error("timed out"));
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(2));

    const secondId = postSale.mock.calls[1][0].saleId;
    expect(secondId).not.toBe(firstId);
    await waitFor(() => expect(storedAttemptRow()?.checkoutId).toBe(secondId));
  });

  it("keeps a restored attempt UNKNOWN across a replay, and replays the same identity", async () => {
    // Restart recovery plus idempotent replay. The persisted attempt is
    // promoted to "outcome unknown" on boot; the replay must send that identity
    // unchanged, and the record must still say "unknown" afterwards — the flag
    // is what makes the cart offer reconciliation rather than a blind re-ring.
    oneCartWithALine({ attempt: inFlightAttempt("ck-night"), checkoutId: "ck-night" });
    postSale.mockRejectedValue(new Error("still no answer"));
    await renderRegister();
    await awaitReadyToPost();
    await waitFor(() => expect(screen.getByText(/being paid for/i)).toBeTruthy());
    await waitFor(() => expect(storedAttemptRow()?.state).toBe("unknown"));

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].saleId).toBe("ck-night");

    // Still unknown, still the same identity: the replay's own failure updated
    // the message, and no writer put the record back to "posting".
    await waitFor(() => expect(storedAttemptRow()?.state).toBe("unknown"));
    expect(storedAttemptRow()?.checkoutId).toBe("ck-night");
  });
});
