// @vitest-environment jsdom
/**
 * WP-0 register behaviour — the real page, not its helpers.
 *
 * `discount.test.ts` and `cartRestore.test.ts` pin the arithmetic and the
 * restore policy as pure functions. They cannot catch the defect class that
 * produced BOTH of the findings these tests exist for, which is a correct
 * helper that the page does not consult:
 *
 *   * GZ-WP0-07 — `evaluateDiscountPercent` was written, exported and tested,
 *     and `PosRegister` imported only `percentToDiscountCents` beside it. So
 *     `150` still blanked the amount box in silence and the order still posted
 *     at FULL PRICE with Post Sale and F5 both live.
 *
 *   * GZ-WP0-08 — `revalidateRestoredLines` was correct about prices and was
 *     applied by the page to every restored cart, including one still holding
 *     the `checkoutId` of a payment whose answer never came back. Repricing
 *     that cart breaks the only thing that can reconcile it.
 *
 * Both findings live in the WIRING. So these tests render `PosRegister`, drive
 * it the way a cashier does, and assert on what reaches `salesRepo.post` —
 * which is the actual boundary where money is decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/lib/i18n";
import type { ProductUom, ProductWithUoms } from "../../src/db/types";
import { computeSaleLineMath } from "../../src/lib/saleMath";

// --- Boundaries -------------------------------------------------------------
// Everything the page reaches the database through. `post` is the one that
// matters: these tests are ultimately assertions about its argument.

const postSale = vi.fn();
const listEnriched = vi.fn();

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
  exchangeRatesRepo: {
    getCurrentForToday: vi.fn(async () => ({
      id: "rate-1",
      storeId: "store-1",
      effectiveDate: "2026-10-19",
      rateLbpPerUsd: 89000,
      source: "manual" as const,
      notes: null,
      createdAt: "2026-10-19T00:00:00Z",
    })),
  },
}));

vi.mock("../../src/db/repos/shifts", () => ({
  shiftsRepo: {
    getOpenShift: vi.fn(async () => ({
      id: "shift-1",
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
    })),
  },
}));

vi.mock("../../src/db/repos/sales", () => ({
  salesRepo: {
    post: (...a: unknown[]) => postSale(...a),
    findByIdWithDetails: vi.fn(async () => null),
  },
}));

import PosRegister from "../../src/pages/PosRegister";

// --- Catalog fixture --------------------------------------------------------

const OPEN_CARTS_KEY = "lira_pos_open_carts";

function uom(productId: string, over: Partial<ProductUom> = {}): ProductUom {
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
    ...over,
  };
}

/** A $10.00 incl-VAT burger at 11%, unless told otherwise. */
function burger(inclVatCents = 1000): ProductWithUoms {
  const u = uom("p-burger");
  const vatRate = {
    id: "vat-11",
    name: "Standard 11%",
    rateBps: 1100,
    isExempt: false,
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
  };
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
    vatRate,
  };
}

/** A persisted cart line, exactly as the page writes one to localStorage. */
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

function seedPersistedCart(opts: {
  lines: ReturnType<typeof persistedLine>[];
  checkoutId?: string;
  attempt?: unknown;
}) {
  localStorage.setItem(
    OPEN_CARTS_KEY,
    JSON.stringify([
      {
        id: "cart-1",
        seq: 1,
        lines: opts.lines,
        cashUsdInput: "",
        cashLbpInput: "",
        cardUsdInput: "",
        discountPctInput: "",
        discountAmountInput: "",
        ...(opts.checkoutId ? { checkoutId: opts.checkoutId } : {}),
        ...(opts.attempt
          ? {
              // A frozen attempt carries its own identity, exactly as
              // `runPost` writes both fields together.
              attempt: opts.attempt,
              checkoutId: (opts.attempt as { checkoutId: string }).checkoutId,
            }
          : {}),
      },
    ]),
  );
}

/** Render the register and wait for its menu, rate and shift to land. */
async function renderRegister() {
  // The REAL provider and the REAL English dictionary. Stubbing `t` would let
  // a refusal "appear" as a bare key and still pass, and these tests exist to
  // prove the cashier can read the refusal.
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

const postButton = () => screen.getByRole("button", { name: /post sale/i }) as HTMLButtonElement;
const pctBox = () => screen.getByLabelText("Discount %") as HTMLInputElement;
const amountBox = () => screen.getByLabelText("Discount USD") as HTMLInputElement;

beforeEach(() => {
  // jsdom implements no layout, so it ships no `scrollIntoView`. The register
  // scrolls a discount refusal into view (GZ-WP0-03), and that call reaching an
  // undefined method would fail the very tests that assert the refusal appears.
  Element.prototype.scrollIntoView = vi.fn();

  localStorage.clear();
  postSale.mockReset();
  postSale.mockResolvedValue({ saleId: "sale-1", receiptNumber: 1 });
  listEnriched.mockReset();
  listEnriched.mockResolvedValue([burger()]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ===========================================================================
// GZ-WP0-07 — an unusable percentage is visible and blocks the sale
// ===========================================================================

describe("discount percentage, in the register (GZ-WP0-07)", () => {
  /** Put a $10.00 burger in the cart and open the discount panel. */
  async function cartWithOneBurger() {
    seedPersistedCart({ lines: [persistedLine(burger(), 1)] });
    await renderRegister();
    // The discount controls are folded away until asked for.
    fireEvent.click(screen.getByRole("button", { name: /\+ discount/i }));
    return pctBox();
  }

  it("accepts a sane percentage, applies it, and still allows posting", async () => {
    const box = await cartWithOneBurger();
    fireEvent.change(box, { target: { value: "10" } });

    // The derived cash lands in the amount box and the sale is postable.
    expect(amountBox().value).toBe("1.00");
    expect(postButton().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].discountCents).toBe(100);
  });

  it.each([
    ["150", /more than the whole order/i],
    ["1000", /more than the whole order/i],
    ["abc", /not a percentage/i],
    ["12abc", /not a percentage/i],
    ["-5", /not a percentage/i],
  ])("refuses %s out loud and blocks Post Sale", async (typed, expected) => {
    const box = await cartWithOneBurger();
    fireEvent.change(box, { target: { value: typed } });

    // 1. The cashier can SEE it. This is the whole finding: the old code
    //    blanked the amount box and said nothing at all.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(expected);
    expect(alert.textContent).toMatch(/nothing has been applied/i);

    // 2. The typed text is still on screen, so the message describes the cart
    //    the cashier is actually looking at.
    expect(pctBox().value).toBe(typed);

    // 3. Post Sale is dead.
    expect(postButton().disabled).toBe(true);
    fireEvent.click(postButton());
    expect(postSale).not.toHaveBeenCalled();
  });

  it.each([["150"], ["abc"]])("blocks the F5 shortcut too, for %s", async (typed) => {
    const box = await cartWithOneBurger();
    fireEvent.change(box, { target: { value: typed } });

    // F5 is the cashier's habitual gesture and bypasses the button entirely,
    // so a disabled button is not on its own a fix.
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    expect(postSale).not.toHaveBeenCalled();
  });

  it("posts at full price only once the percentage is actually cleared", async () => {
    const box = await cartWithOneBurger();
    fireEvent.change(box, { target: { value: "150" } });
    expect(postButton().disabled).toBe(true);

    fireEvent.change(box, { target: { value: "" } });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(postButton().disabled).toBe(false);
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    // Full price, deliberately and visibly — not as the silent outcome of an
    // unusable discount.
    expect(postSale.mock.calls[0][0].discountCents).toBe(0);
  });

  it("refuses 100% by the one-cent floor, naming the amount", async () => {
    const box = await cartWithOneBurger();
    fireEvent.change(box, { target: { value: "100" } });

    // A legal percentage, refused downstream for leaving nothing on the total.
    expect(screen.getByRole("alert").textContent).toMatch(/\$0\.01/);
    expect(postButton().disabled).toBe(true);
  });

  it("refuses a percentage worth less than a cent", async () => {
    const box = await cartWithOneBurger();
    fireEvent.change(box, { target: { value: "0.001" } });

    expect(screen.getByRole("alert").textContent).toMatch(/less than one cent/i);
    expect(postButton().disabled).toBe(true);
    expect(postSale).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GZ-WP0-08 / P1-A / P1-C — restored carts, frozen attempts, and replay
// ===========================================================================
//
// Three kinds of restored cart, and they must be told apart:
//
//   1. ORDINARY — no checkout has been attempted. Re-priced against today's
//      catalog and fully editable (GZ-WP0-05).
//   2. FROZEN ATTEMPT — WP-1 wrote the complete canonical request before
//      invoking the backend. Locked, and replayable exactly as sent, which is
//      what reconciles a lost response.
//   3. LEGACY — a bare `checkoutId` from a build that stored no request. Still
//      locked (the identity may name a committed sale) but NOT replayable:
//      rebuilding the request from the cart plus today's shift and rate is
//      precisely the P1-C defect. Reconciliation by identity is the only move.

const OLD_PRICE = 1000; // what the cart was rung at
const NEW_PRICE = 1200; // what the catalog says now

/** A complete frozen attempt, as `runPost` writes one before invoking. */
function frozenAttempt(
  checkoutId: string,
  over: Partial<{ unitPriceInclVatCents: number; shiftId: string; rateId: string }> = {},
) {
  const unit = over.unitPriceInclVatCents ?? OLD_PRICE;
  return {
    checkoutId,
    startedAt: "2026-10-19T09:00:00.000Z",
    state: "posting" as const,
    request: {
      saleId: checkoutId,
      storeId: "store-1",
      cashierUserId: "user-1",
      deviceId: null,
      // Deliberately NOT today's shift or rate: the whole point of freezing is
      // that these travel with the attempt (P1-C).
      shiftId: over.shiftId ?? "shift-FROM-YESTERDAY",
      exchangeRateId: over.rateId ?? "rate-FROM-YESTERDAY",
      exchangeRateLbpPerUsd: 86000,
      notes: null,
      cogsMethod: "last_purchase" as const,
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
          unitPriceExclVatCents: Math.round((unit * 10000) / 11100),
          unitPriceInclVatCents: unit,
          vatRateIdSnapshot: "vat-11",
          vatRateBpsSnapshot: 1100,
          lineSubtotalExclVatCents: Math.round((unit * 10000) / 11100),
          lineVatCents: unit - Math.round((unit * 10000) / 11100),
          lineTotalInclVatCents: unit,
          lineDiscountCents: 0,
          barcodeUsedSnapshot: null,
          barcodeTypeSnapshot: null,
          isService: false,
        },
      ],
      payments: [
        {
          method: "cash_usd" as const,
          currency: "USD" as const,
          amountNativeUsdCents: unit,
          amountNativeLbp: 0,
          amountUsdCentsEquivalent: unit,
          reference: null,
        },
      ],
    },
  };
}

describe("ordinary restored carts (GZ-WP0-05)", () => {
  it("re-prices an ordinary saved cart and says so", async () => {
    seedPersistedCart({ lines: [persistedLine(burger(OLD_PRICE), 1)] });
    listEnriched.mockResolvedValue([burger(NEW_PRICE)]);
    await renderRegister();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/re-checked it against today/i),
    );
    expect(screen.getByRole("status").textContent).toMatch(/\$10\.00/);
    expect(screen.getByRole("status").textContent).toMatch(/\$12\.00/);

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].lines[0].unitPriceInclVatCents).toBe(NEW_PRICE);
  });

  it("leaves an ordinary saved cart editable", async () => {
    seedPersistedCart({ lines: [persistedLine(burger(OLD_PRICE), 1)] });
    listEnriched.mockResolvedValue([burger(NEW_PRICE)]);
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].lines[0].quantityInUom).toBe(2);
  });
});

describe("a frozen checkout attempt (P1-A / P1-C)", () => {
  function seedFrozen(over?: Parameters<typeof frozenAttempt>[1]) {
    seedPersistedCart({
      lines: [persistedLine(burger(OLD_PRICE), 1)],
      attempt: frozenAttempt("checkout-abc", over),
    });
    listEnriched.mockResolvedValue([burger(NEW_PRICE)]);
  }

  it("is not re-priced, and replays the request exactly as it was sent", async () => {
    seedFrozen();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));
    // Not the dismissible re-price notice.
    expect(screen.queryByText(/re-checked it against today/i)).toBeNull();

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.saleId).toBe("checkout-abc");
    expect(sent.lines[0].unitPriceInclVatCents).toBe(OLD_PRICE);
    expect(sent.lines[0].quantityInUom).toBe(1);
  });

  it("replays YESTERDAY's shift, rate and COGS method, not today's (P1-C)", async () => {
    // The register's live context is shift-1 / rate-1 (the mocks at the top).
    // Every one of these is compared on replay, so a retry that picked them up
    // from today would be a conflict against the sale that committed.
    seedFrozen();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.shiftId).toBe("shift-FROM-YESTERDAY");
    expect(sent.exchangeRateId).toBe("rate-FROM-YESTERDAY");
    expect(sent.exchangeRateLbpPerUsd).toBe(86000);
    expect(sent.cashierUserId).toBe("user-1");
  });

  it("refuses every edit, so the frozen request cannot drift", async () => {
    seedFrozen();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    const cashBox = screen.getByLabelText(/cash usd/i) as HTMLInputElement;
    fireEvent.change(cashBox, { target: { value: "99.00" } });
    expect(cashBox.value).toBe("");

    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.lines).toHaveLength(1);
    expect(sent.lines[0].quantityInUom).toBe(1);
    expect(sent.payments[0].amountNativeUsdCents).toBe(OLD_PRICE);
  });

  it("stays locked even when the catalog fails to load", async () => {
    seedPersistedCart({
      lines: [persistedLine(burger(OLD_PRICE), 1)],
      attempt: frozenAttempt("checkout-abc"),
    });
    listEnriched.mockRejectedValue(new Error("catalog unavailable"));
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    const cashBox = screen.getByLabelText(/cash usd/i) as HTMLInputElement;
    fireEvent.change(cashBox, { target: { value: "99.00" } });
    expect(cashBox.value).toBe("");

    // And the retry still works: the frozen request depends on no catalog.
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(postSale.mock.calls[0][0].saleId).toBe("checkout-abc");
  });

  it("will not let the rail's Clear quietly retire the identity", async () => {
    seedFrozen();
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    expect(screen.queryByRole("button", { name: /^clear cart$/i })).toBeNull();
    const discards = screen.getAllByRole("button", { name: /discard this attempt/i });
    fireEvent.click(discards[discards.length - 1]);

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(window.confirm).mock.calls[0][0])).toMatch(
      /charge the customer twice/i,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i);
  });

  it("will not let Close quietly retire the identity either", async () => {
    const blank = {
      cashUsdInput: "",
      cashLbpInput: "",
      cardUsdInput: "",
      discountPctInput: "",
      discountAmountInput: "",
    };
    localStorage.setItem(
      OPEN_CARTS_KEY,
      JSON.stringify([
        {
          id: "cart-1",
          seq: 1,
          lines: [persistedLine(burger(OLD_PRICE), 1)],
          attempt: frozenAttempt("checkout-abc"),
          ...blank,
        },
        { id: "cart-2", seq: 2, lines: [], ...blank },
      ]),
    );
    listEnriched.mockResolvedValue([burger(NEW_PRICE)]);
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    fireEvent.click(screen.getAllByRole("button", { name: /close cart/i })[0]);
    const asked = String(vi.mocked(window.confirm).mock.calls[0][0]);
    expect(asked).toMatch(/charge the customer twice/i);
    expect(asked).not.toMatch(/close it and discard them/i);
    expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i);
  });

  it("frees the cart only when the attempt is explicitly discarded", async () => {
    seedFrozen();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    const discards = screen.getAllByRole("button", { name: /discard this attempt/i });
    fireEvent.click(discards[0]);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/being paid for/i)).toBeNull());

    // A fresh basket is a NEW transaction: today's price, a new identity.
    fireEvent.click(screen.getByRole("button", { name: /double burger/i }));
    fireEvent.click(postButton());
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const sent = postSale.mock.calls[0][0];
    expect(sent.saleId).not.toBe("checkout-abc");
    expect(sent.lines[0].unitPriceInclVatCents).toBe(NEW_PRICE);
  });
});

describe("a LEGACY unresolved cart — identity but no frozen request (P1-C)", () => {
  function seedLegacy() {
    seedPersistedCart({
      lines: [persistedLine(burger(OLD_PRICE), 1)],
      checkoutId: "legacy-abc",
    });
    listEnriched.mockResolvedValue([burger(NEW_PRICE)]);
  }

  it("is locked and not re-priced", async () => {
    seedLegacy();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));
    expect(screen.queryByText(/re-checked it against today/i)).toBeNull();

    const cashBox = screen.getByLabelText(/cash usd/i) as HTMLInputElement;
    fireEvent.change(cashBox, { target: { value: "5.00" } });
    expect(cashBox.value).toBe("");
  });

  it("REFUSES to be re-sent, because its canonical request is unrecoverable", async () => {
    // This is the P1-C rule at its sharpest. The old register would happily
    // have rebuilt a payload from the cart plus today's shift and rate and
    // sent it under this identity — which is either a conflict or, worse, a
    // second sale on different terms.
    seedLegacy();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));

    fireEvent.click(postButton());
    await waitFor(() =>
      expect(screen.getByText(/cannot be sent again/i)).toBeTruthy(),
    );
    expect(postSale).not.toHaveBeenCalled();
  });

  it("tells the cashier to reconcile instead of replaying", async () => {
    seedLegacy();
    await renderRegister();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being paid for/i));
    expect(screen.getByRole("alert").textContent).toMatch(/older version/i);
    expect(screen.getByRole("button", { name: /check this order/i })).toBeTruthy();
  });
});
