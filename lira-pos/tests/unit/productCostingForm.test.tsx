// @vitest-environment jsdom
/**
 * THE PRODUCTS FORM'S COSTING SECTION (WP-B1)
 *
 * The owner's whole interface to manual costing is one select and one field,
 * so what this file pins is that the field reaches `productsRepo.save` as a
 * microcent RATE, that the three refusals happen before a round trip, and that
 * a stored cost loads back into the box it was typed in.
 *
 * Deliberately NOT asserted here: anything about what the database ends up
 * holding. `save_product` in Rust is the only thing that writes a product, and
 * a frontend test asserting on its own state would prove nothing about
 * persistence — the same division WP-A's import-dialog test states. The
 * persistence layer is `src-tauri/src/tests/standard_cost.rs`, and the
 * engine-level guards are in `tests/integration/standardCosting.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { ProductUom, ProductWithUoms, UnitOfMeasure, VatRate } from "../../src/db/types";

const save = vi.fn();
const listEnriched = vi.fn();
const findByIdEnriched = vi.fn();
const nextAutoSku = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({ storeId: "store-1", hydrated: true }),
}));
vi.mock("../../src/db/repos/products", () => ({
  productsRepo: {
    save: (...a: unknown[]) => save(...a),
    listEnriched: (...a: unknown[]) => listEnriched(...a),
    findByIdEnriched: (...a: unknown[]) => findByIdEnriched(...a),
    nextAutoSku: (...a: unknown[]) => nextAutoSku(...a),
  },
  // All three error classes the page's catch block tests with `instanceof`.
  // Omitting one makes `e instanceof undefined` throw INSIDE the catch, which
  // swallows the real error and renders no message at all — a harness defect
  // that looks exactly like a missing validation.
  DuplicateSkuError: class extends Error {},
  DuplicateBarcodeError: class extends Error {},
  StockedToServiceError: class extends Error {},
}));
vi.mock("../../src/db/repos/vatRates", () => ({
  vatRatesRepo: { listActive: async () => [VAT] },
}));
vi.mock("../../src/db/repos/uoms", () => ({
  uomsRepo: { listActive: async () => [EACH] },
}));
vi.mock("../../src/components/BarcodeManager", () => ({
  BarcodeManager: () => null,
}));
// WP-B2-B: whether the item has a PUBLISHED recipe is one of the two
// conditions the form checks before a round trip, so the harness has to be
// able to answer it both ways.
const recipeSummaries = vi.fn();
vi.mock("../../src/db/repos/recipes", () => ({
  recipesRepo: {
    summaries: (...a: unknown[]) => recipeSummaries(...a),
  },
}));
vi.mock("../../src/components/ProductImportDialog", () => ({
  ProductImportDialog: () => null,
}));

const VAT: VatRate = {
  id: "vat-11",
  name: "Standard 11%",
  rateBps: 1100,
  isExempt: false,
  effectiveFrom: "2020-01-01",
  effectiveTo: null,
};

const EACH: UnitOfMeasure = {
  code: "each",
  name: "Each",
  category: "count",
  symbol: "ea",
  isActive: true,
};

const BASE_UOM: ProductUom = {
  id: "uom-1",
  productId: "prod-burger",
  uomCode: "each",
  factor: { num: 1, den: 1 },
  isBase: true,
  isDefaultSale: true,
  isDefaultPurchase: true,
  isActive: true,
  salePriceExclVatCents: null,
  salePriceInclVatCents: null,
};

/** A manual-costed menu item, as the list and the form would load it. */
function burger(over: Partial<ProductWithUoms> = {}): ProductWithUoms {
  return {
    id: "prod-burger",
    storeId: "store-1",
    sku: "SKU-B1",
    name: "Greaz Burger",
    description: null,
    vatRateId: VAT.id,
    vatPricingMode: "inclusive",
    priceExclVatCents: 1000,
    priceInclVatCents: 1110,
    avgCostExclVatMicrocents: 0,
    avgCostInclVatMicrocents: 0,
    avgCostExclVatCents: 0,
    avgCostInclVatCents: 0,
    quantityOnHand: 0,
    reorderPoint: null,
    isActive: true,
    isService: true,
    category: null,
    icon: null,
    costingMethod: "standard",
    standardCostExclVatMicrocents: 185_000_000,
    standardCostSetAt: "2026-10-25T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    vatRate: VAT,
    uoms: [BASE_UOM],
    baseUom: BASE_UOM,
    defaultSaleUom: BASE_UOM,
    primaryBarcode: null,
    ...over,
  };
}

async function renderProducts(products: ProductWithUoms[], publishedRecipe = false) {
  // `summaries` returns a MAP keyed by product id, which is what the page
  // calls `.get` on. An array here renders as a crash, not as "no recipe".
  recipeSummaries.mockResolvedValue(
    new Map(
      publishedRecipe
        ? [
            [
              "prod-burger",
              {
                productId: "prod-burger",
                hasDraft: false,
                hasActive: true,
                activeVersion: 1,
                retiredCount: 0,
              },
            ],
          ]
        : [],
    ),
  );
  listEnriched.mockResolvedValue(products);
  findByIdEnriched.mockResolvedValue(products[0] ?? null);
  nextAutoSku.mockResolvedValue("SKU-AUTO");
  save.mockResolvedValue(products[0] ?? burger());

  const { default: Products } = await import("../../src/pages/Products");
  const { createElement } = await import("react");
  render(createElement(I18nProvider, null, createElement(Products)));
  await waitFor(() => expect(listEnriched).toHaveBeenCalled());
}

/** Open the form on the one product in the list. */
async function openEdit() {
  const edit = await screen.findByRole("button", { name: /^edit$/i });
  fireEvent.click(edit);
  await screen.findByText("Costing");
}

function costingSelect(): HTMLSelectElement {
  // The one select whose options are the costing methods.
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === "standard"),
  );
  if (!found) throw new Error("costing method select not found");
  return found;
}

function manualCostField(): HTMLInputElement {
  return screen.getByLabelText(/Cost per unit, excluding VAT/i) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("the costing section", () => {
  it("offers all three costing methods", async () => {
    // WP-B2-B made `recipe` selectable. Its two conditions — a non-stock item
    // and a published recipe — are checked when the form is SAVED and stated
    // inline beneath the select, not by hiding the option: an owner who cannot
    // find the setting cannot be told why it does not apply.
    await renderProducts([burger()]);
    await openEdit();

    const values = Array.from(costingSelect().options).map((o) => o.value);
    expect(values).toEqual(["purchase_average", "standard", "recipe"]);
  });

  it("loads a stored cost back into the field it was typed in", async () => {
    // Formatted from the microcent RATE, never from the rounded cents mirror:
    // reading the mirror back and saving it would destroy a sub-cent cost on
    // any unrelated edit.
    await renderProducts([burger()]);
    await openEdit();

    expect(costingSelect().value).toBe("standard");
    expect(manualCostField().value).toBe("1.85");
  });

  it("loads a SUB-CENT cost without rounding it to nothing", async () => {
    await renderProducts([burger({ standardCostExclVatMicrocents: 250_000 })]);
    await openEdit();
    expect(manualCostField().value).toBe("0.0025");
  });

  it("shows an empty field, not a zero, when no cost is configured", async () => {
    // Blank means "not configured". A pre-filled 0.00 would answer the
    // question on the owner's behalf.
    await renderProducts([
      burger({ costingMethod: "standard", standardCostExclVatMicrocents: null }),
    ]);
    await openEdit();
    expect(manualCostField().value).toBe("");
  });

  it("hides the cost field on purchase valuation", async () => {
    await renderProducts([
      burger({ costingMethod: "purchase_average", standardCostExclVatMicrocents: null }),
    ]);
    await openEdit();
    expect(screen.queryByLabelText(/Cost per unit, excluding VAT/i)).toBeNull();
  });

  it("states the cost status in words, so a stated zero reads differently from a gap", async () => {
    await renderProducts([
      burger({ costingMethod: "standard", standardCostExclVatMicrocents: 0 }),
    ]);
    await openEdit();
    expect(screen.getByText(/Manual cost set to zero \(deliberate\)/i)).toBeTruthy();
  });

  it("warns on a stocked item BEFORE the save is attempted", async () => {
    // The restriction stated where it is reachable, rather than only in the
    // error a round trip would return.
    await renderProducts([
      burger({ isService: false, costingMethod: "purchase_average", standardCostExclVatMicrocents: null }),
    ]);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "standard" } });
    expect(screen.getByText(/non-stock items only/i)).toBeTruthy();
  });
});

describe("what the form saves", () => {
  it("sends the typed cost as a microcent rate", async () => {
    await renderProducts([burger()]);
    await openEdit();

    fireEvent.change(manualCostField(), { target: { value: "2.60" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      costingMethod: "standard",
      standardCostExclVatMicrocents: 260_000_000,
    });
  });

  it("sends a deliberate zero as 0, which is not the same as omitting it", async () => {
    await renderProducts([burger()]);
    await openEdit();

    fireEvent.change(manualCostField(), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]?.standardCostExclVatMicrocents).toBe(0);
  });

  it("refuses a half-typed cost instead of reading its numeric prefix", async () => {
    // `parseFloat("2abc")` is 2. A typo that saves as a plausible wrong cost
    // is worse than one that is refused, because the margin looks fine.
    await renderProducts([burger()]);
    await openEdit();

    fireEvent.change(manualCostField(), { target: { value: "2abc" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/That is not a cost/i)).toBeTruthy());
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses manual cost with a blank figure rather than defaulting it to zero", async () => {
    await renderProducts([burger()]);
    await openEdit();

    fireEvent.change(manualCostField(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/needs a figure/i)).toBeTruthy());
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses manual cost on a stocked product", async () => {
    await renderProducts([
      burger({ isService: false, costingMethod: "purchase_average", standardCostExclVatMicrocents: null }),
    ]);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "standard" } });
    fireEvent.change(manualCostField(), { target: { value: "1.85" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(screen.getAllByText(/non-stock items only/i).length).toBeGreaterThan(0),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("sends purchase valuation explicitly when the owner switches back", async () => {
    // An explicit switch is a WRITE, not an omission: the payload always
    // states the method so a change away from manual cost takes effect.
    await renderProducts([burger()]);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "purchase_average" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]?.costingMethod).toBe("purchase_average");
  });
});


// ---------------------------------------------------------------------------
// Recipe costing (WP-B2-B)
//
// The option is OFFERED unconditionally and REFUSED conditionally, which is a
// deliberate choice: hiding a setting from an owner who does not qualify for
// it leaves them with no way to find out why. Both conditions are stated
// inline, beneath the select, and again as a refusal if they try to save.
// ---------------------------------------------------------------------------

describe("recipe costing in the form", () => {
  it("explains what is missing when there is no published recipe", async () => {
    await renderProducts([burger()], false);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "recipe" } });

    expect(
      await screen.findByText(/Recipe costing needs a published recipe/i),
    ).toBeTruthy();
  });

  it("refuses to save without one, before any round trip", async () => {
    await renderProducts([burger()], false);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "recipe" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(
        screen.getAllByText(/Recipe costing needs a published recipe/i).length,
      ).toBeGreaterThan(0);
    });
    // THE assertion: nothing was sent. A refusal that still calls the command
    // is not a refusal, it is a race.
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses it for a stocked item, for the Manual Cost reason", async () => {
    // A recipe-derived rate on a stocked line would be stamped onto the sale's
    // inventory movement while the pool those goods left says something else.
    await renderProducts([burger({ isService: false })], true);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "recipe" } });

    expect(
      await screen.findByText(/Recipe costing applies to non-stock items only/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(
        screen.getAllByText(/Recipe costing applies to non-stock items only/i).length,
      ).toBeGreaterThan(0);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("sends the method through once both conditions are met", async () => {
    await renderProducts([burger()], true);
    await openEdit();

    fireEvent.change(costingSelect(), { target: { value: "recipe" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const sent = save.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ costingMethod: "recipe" });

    // A previously typed Manual Cost is carried through rather than wiped,
    // which is the behaviour switching to purchase valuation already has: the
    // figure is INERT under `recipe` (nothing reads it, and 022's trigger only
    // requires it when the method is `standard`), and destroying it would lose
    // the owner's number the moment they tried the other setting.
    expect(sent.standardCostExclVatMicrocents).toBe(185_000_000);

    // And NO recipe, ingredient or rate rides along: the cost is resolved in
    // the posting transaction from the database, and there is no field for one
    // on this payload. This assertion is the one that must never be relaxed.
    for (const key of Object.keys(sent)) {
      expect(key).not.toMatch(/recipe|ingredient|component/i);
    }
  });

  it("loads a recipe-costed product back as recipe-costed", async () => {
    // Before WP-B2-B the form read the stored method as
    // `=== "standard" ? "standard" : "purchase_average"`, which would now
    // silently rewrite a recipe-costed item to purchase valuation on any
    // unrelated edit of it.
    await renderProducts(
      [burger({ costingMethod: "recipe", standardCostExclVatMicrocents: null })],
      true,
    );
    await openEdit();

    expect(costingSelect().value).toBe("recipe");
  });
});
