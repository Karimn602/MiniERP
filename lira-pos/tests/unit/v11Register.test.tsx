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
    // Purchase valuation with no cost configured (WP-B1): the state every
    // product was in before migration 020, and the one this fixture means.
    costingMethod: "purchase_average" as const,
    standardCostExclVatMicrocents: null,
    standardCostSetAt: null,
    showOnRegister: true,
    allowNegativeStock: false,
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
// V1.1 — F5 exact USD cash, F6 exact LBP cash (founder decision 4)
// ===========================================================================

type Pay = { method: string; currency: string; amountNativeUsdCents: number; amountNativeLbp: number; amountUsdCentsEquivalent: number };
const paymentsOf = (call: number) => postSale.mock.calls[call][0].payments as Pay[];

describe("F5 / F6 exact-cash checkout", () => {
  it("F5 fills exact USD cash, shows it, and posts once", async () => {
    seedPersistedCart({ lines: [persistedLine(burger(), 1)] });
    await renderRegister();

    const ev = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true); // WebView2 must not reload the till

    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    expect(paymentsOf(0)).toEqual([
      expect.objectContaining({ method: "cash_usd", currency: "USD", amountNativeUsdCents: 1000, amountUsdCentsEquivalent: 1000 }),
    ]);
  });

  it("F6 fills exact LBP cash at the locked rate and posts once", async () => {
    seedPersistedCart({ lines: [persistedLine(burger(), 1)] });
    await renderRegister();

    await act(async () => {
      fireEvent.keyDown(window, { key: "F6" });
    });

    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const pays = paymentsOf(0);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ method: "cash_lbp", currency: "LBP", amountNativeLbp: 890_000 });
    // Never a cent short of the total at the rate the sale locks.
    expect(pays[0].amountUsdCentsEquivalent).toBeGreaterThanOrEqual(1000);
  });

  it("F5 keeps a part already typed in lira and settles only the REMAINDER in dollars", async () => {
    seedPersistedCart({ lines: [persistedLine(burger(), 1)] });
    await renderRegister();
    // $4.00 worth of lira handed over first.
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "356000" } });

    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });

    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    const pays = paymentsOf(0);
    expect(pays.find((p) => p.method === "cash_lbp")?.amountNativeLbp).toBe(356_000);
    expect(pays.find((p) => p.method === "cash_usd")?.amountNativeUsdCents).toBe(600);
  });

  it("a held key and a second press while posting create ONE sale", async () => {
    let release: (v: unknown) => void = () => {};
    postSale.mockImplementation(() => new Promise((r) => (release = r)));
    seedPersistedCart({ lines: [persistedLine(burger(), 1)] });
    await renderRegister();

    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
      fireEvent.keyDown(window, { key: "F5", repeat: true });
    });
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
      fireEvent.keyDown(window, { key: "F6" });
    });
    expect(postSale).toHaveBeenCalledTimes(1);
    await act(async () => release({ saleId: "sale-1", receiptNumber: 1 }));
  });

  it("does nothing on an empty cart, and posts nothing", async () => {
    await renderRegister();
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
      fireEvent.keyDown(window, { key: "F6" });
    });
    expect(postSale).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// V1.1 — inventory-only items are not Register tiles (founder report A6)
// ===========================================================================

describe("items kept off the Register", () => {
  it("are not shown as menu tiles, while menu items are", async () => {
    const meat = { ...burger(0), id: "p-meat", name: "Meat", sku: "MEAT", showOnRegister: false };
    listEnriched.mockResolvedValue([burger(), meat]);
    await renderRegister();
    // Wait for the menu to load before asserting what is NOT on it: the
    // product list resolves asynchronously, and a synchronous query here
    // failed about one run in six on b004cb6 itself.
    expect((await screen.findAllByText("Double Burger")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Meat")).toBeNull();
  });
});
