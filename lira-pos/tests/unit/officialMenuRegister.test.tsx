// @vitest-environment jsdom
/**
 * The official menu at the REAL Register: free sauce and dip choices are asked
 * when the item is added and reach the posted line as its kitchen note; paid
 * add-ons are ordinary priced lines; Cancel adds nothing.
 *
 * Asserted on what reaches `salesRepo.post`, the boundary where the sale is
 * decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/lib/i18n";
import type { ProductUom, ProductWithUoms } from "../../src/db/types";

const postSale = vi.fn();
const listEnriched = vi.fn();
const findByScan = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({ storeId: "store-1", userId: "user-1", hydrated: true }),
}));
vi.mock("../../src/db/repos/products", () => ({
  productsRepo: {
    listEnriched: (...a: unknown[]) => listEnriched(...a),
    findByScan: (...a: unknown[]) => findByScan(...a),
  },
}));
vi.mock("../../src/db/repos/exchangeRates", () => ({
  exchangeRatesRepo: {
    getCurrentForToday: vi.fn(async () => ({
      id: "rate-1",
      storeId: "store-1",
      effectiveDate: "2026-11-23",
      rateLbpPerUsd: 89000,
      source: "manual" as const,
      notes: null,
      createdAt: "2026-11-23T00:00:00Z",
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
      openedAt: "2026-11-23T08:00:00Z",
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

function menuItem(id: string, sku: string, name: string, cents: number, category: string): ProductWithUoms {
  const u: ProductUom = {
    id: `${id}-each`,
    productId: id,
    uomCode: "each",
    factor: { num: 1, den: 1 },
    isBase: true,
    isDefaultSale: true,
    isDefaultPurchase: true,
    isActive: true,
    salePriceExclVatCents: null,
    salePriceInclVatCents: null,
  };
  return {
    id,
    storeId: "store-1",
    sku,
    name,
    description: null,
    vatRateId: "vat-11",
    vatPricingMode: "inclusive",
    priceExclVatCents: Math.round((cents * 10000) / 11100),
    priceInclVatCents: cents,
    avgCostExclVatMicrocents: 0,
    avgCostInclVatMicrocents: 0,
    avgCostExclVatCents: 0,
    avgCostInclVatCents: 0,
    quantityOnHand: 0,
    reorderPoint: null,
    isActive: true,
    // The official menu loads prepared items as non-stock.
    isService: true,
    category,
    icon: null,
    costingMethod: "purchase_average" as const,
    standardCostExclVatMicrocents: null,
    standardCostSetAt: null,
    showOnRegister: true,
    allowNegativeStock: false,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
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

const DIPPER = menuItem("p-dipper", "GRZ-BUR-004", "Dipper Chicken", 700, "burgers");
const BOX = menuItem("p-box", "GRZ-CMB-002", "Greaz Box", 1600, "combos");
const DOUBLE = menuItem("p-double", "GRZ-BUR-001", "Double Smash", 700, "burgers");
const BACON = menuItem("p-bacon", "GRZ-ADD-001", "Beef Bacon Add-on", 200, "addons");

type Line = { productId: string; quantityInUom: number; kitchenNote: string | null; lineTotalInclVatCents: number };
const linesOf = (call: number) => postSale.mock.calls[call][0].lines as Line[];

async function renderRegister() {
  render(
    <MemoryRouter>
      <I18nProvider>
        <PosRegister />
      </I18nProvider>
    </MemoryRouter>,
  );
  await screen.findByTitle("Dipper Chicken");
}

/** The MENU TILE for an item — an order line can carry the same title. */
function tile(name: string): HTMLElement {
  const el = screen
    .getAllByTitle(name)
    .find((e) => e.tagName === "BUTTON" && e.className.includes("group/tile"));
  if (!el) throw new Error(`no tile ${name}`);
  return el;
}

async function postWithF5() {
  await act(async () => {
    fireEvent.keyDown(window, { key: "F5" });
  });
  await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  postSale.mockReset();
  postSale.mockResolvedValue({ saleId: "sale-1", receiptNumber: 1 });
  listEnriched.mockReset();
  listEnriched.mockResolvedValue([DIPPER, BOX, DOUBLE, BACON]);
  findByScan.mockReset();
  findByScan.mockResolvedValue(null);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("official menu choices at the Register", () => {
  it("asks for the Dipper Chicken sauce and posts it as the line's kitchen note", async () => {
    await renderRegister();
    fireEvent.click(tile("Dipper Chicken"));
    expect(screen.getByTestId("menu-choice-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("menu-choice-Buffalo"));
    expect(screen.queryByTestId("menu-choice-dialog")).toBeNull();

    await postWithF5();
    expect(linesOf(0)).toEqual([
      expect.objectContaining({ productId: "p-dipper", kitchenNote: "Sauce: Buffalo", lineTotalInclVatCents: 700 }),
    ]);
  });

  it("keeps two different sauces on two lines and merges the same sauce", async () => {
    await renderRegister();
    for (const sauce of ["Buffalo", "BBQ", "Buffalo"]) {
      fireEvent.click(tile("Dipper Chicken"));
      fireEvent.click(screen.getByTestId(`menu-choice-${sauce}`));
    }
    await postWithF5();
    const lines = linesOf(0);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.kitchenNote === "Sauce: Buffalo")?.quantityInUom).toBe(2);
    expect(lines.find((l) => l.kitchenNote === "Sauce: BBQ")?.quantityInUom).toBe(1);
  });

  it("needs exactly three Greaz Box dips, allows repeats, and adds no charge", async () => {
    await renderRegister();
    fireEvent.click(tile("Greaz Box"));
    const add = screen.getByTestId("menu-choice-add") as HTMLButtonElement;
    fireEvent.click(screen.getByTestId("menu-choice-plus-BBQ"));
    fireEvent.click(screen.getByTestId("menu-choice-plus-BBQ"));
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("menu-choice-plus-Buffalo"));
    expect(add.disabled).toBe(false);
    // A fourth is not offered.
    expect((screen.getByTestId("menu-choice-plus-Honey mustard") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(add);

    await postWithF5();
    expect(linesOf(0)).toEqual([
      expect.objectContaining({ productId: "p-box", kitchenNote: "Dips: Buffalo, BBQ ×2", lineTotalInclVatCents: 1600 }),
    ]);
  });

  it("nothing posts while a choice is open, and the item joins only after it is answered", async () => {
    await renderRegister();
    fireEvent.click(tile("Double Smash"));
    fireEvent.click(tile("Dipper Chicken"));
    expect(screen.getByTestId("menu-choice-dialog")).toBeTruthy();
    // F5 and F6 with the dialog open: the Dipper is not in the cart yet, so
    // posting now would settle the order without it (Codex review, P0).
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
      fireEvent.keyDown(window, { key: "F6" });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(postSale).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("menu-choice-BBQ"));
    await postWithF5();
    expect(linesOf(0).map((l) => [l.productId, l.kitchenNote])).toEqual([
      ["p-double", null],
      ["p-dipper", "Sauce: BBQ"],
    ]);
  });

  it("a choice item tapped while the order is posting is not carried into the next order", async () => {
    let release: (v: unknown) => void = () => {};
    postSale.mockImplementation(() => new Promise((r) => (release = r)));
    await renderRegister();
    fireEvent.click(tile("Double Smash"));
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));

    // Mid-post: no choice is asked for a cart that cannot take a line.
    fireEvent.click(tile("Dipper Chicken"));
    expect(screen.queryByTestId("menu-choice-dialog")).toBeNull();

    await act(async () => release({ saleId: "sale-1", receiptNumber: 1 }));
    expect(linesOf(0).map((l) => l.productId)).toEqual(["p-double"]);
    // The next customer's cart is empty: F5 has nothing to post.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.keyDown(window, { key: "F5" });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(postSale).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("menu-choice-dialog")).toBeNull();
  });

  it("a scan that resolves after its order has posted is not added to the next order", async () => {
    let releasePost: (v: unknown) => void = () => {};
    postSale.mockImplementation(() => new Promise((r) => (releasePost = r)));
    let resolveScan: (v: unknown) => void = () => {};
    findByScan.mockImplementation(() => new Promise((r) => (resolveScan = r)));
    await renderRegister();
    fireEvent.click(tile("Double Smash"));

    // Scan a Dipper; the lookup is still out when the order is posted.
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    const input = await screen.findByPlaceholderText(/barcode/i);
    fireEvent.change(input, { target: { value: "2000000000001" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    await waitFor(() => expect(postSale).toHaveBeenCalledTimes(1));
    await act(async () => releasePost({ saleId: "sale-1", receiptNumber: 1 }));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    // The answer arrives for an order that no longer exists.
    await act(async () =>
      resolveScan({
        product: DIPPER,
        resolvedUom: DIPPER.defaultSaleUom,
        matchedBarcode: { barcode: "2000000000001", barcodeType: "EAN13" },
      }),
    );
    expect(screen.queryByTestId("menu-choice-dialog")).toBeNull();
    expect(linesOf(0).map((l) => l.productId)).toEqual(["p-double"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(postSale).toHaveBeenCalledTimes(1);
  });

  it("Cancel adds nothing", async () => {
    await renderRegister();
    fireEvent.click(tile("Greaz Box"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByTestId("menu-choice-dialog")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    expect(postSale).not.toHaveBeenCalled();
  });

  it("an item with no choice and a paid add-on are added directly, each at its own price", async () => {
    await renderRegister();
    fireEvent.click(tile("Double Smash"));
    fireEvent.click(tile("Beef Bacon Add-on"));
    expect(screen.queryByTestId("menu-choice-dialog")).toBeNull();
    await postWithF5();
    expect(linesOf(0).map((l) => [l.productId, l.kitchenNote, l.lineTotalInclVatCents])).toEqual([
      ["p-double", null, 700],
      ["p-bacon", null, 200],
    ]);
  });

  it("does not show the owner's menu prompt to a session that is not the owner", async () => {
    await renderRegister();
    expect(screen.queryByTestId("official-menu-prompt")).toBeNull();
  });
});
