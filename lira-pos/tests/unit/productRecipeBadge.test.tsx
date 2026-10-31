// @vitest-environment jsdom
/**
 * THE PRODUCTS LIST'S RECIPE BADGE (WP-B2-A, GZ-B2A-P2-C)
 *
 * A summary row exists for any product with recipe HISTORY, not only for one
 * with an authoritative recipe. The first version of the badge read "not a
 * draft" as "active", so a product whose only recipes were RETIRED showed a
 * green `v` badge with a blank version after it — a badge asserting something
 * the data does not say, which is the defect this file exists to keep fixed.
 *
 * Four states, four outcomes, and the fourth is "no badge".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type {
  ProductUom,
  ProductWithUoms,
  UnitOfMeasure,
  VatRate,
} from "../../src/db/types";
import type { RecipeSummary } from "../../src/db/repos/recipes";

const listEnriched = vi.fn();
const findByIdEnriched = vi.fn();
const nextAutoSku = vi.fn();
const summaries = vi.fn();

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({ storeId: "store-1", hydrated: true }),
}));
vi.mock("../../src/db/repos/products", () => ({
  productsRepo: {
    save: vi.fn(),
    listEnriched: (...a: unknown[]) => listEnriched(...a),
    findByIdEnriched: (...a: unknown[]) => findByIdEnriched(...a),
    nextAutoSku: (...a: unknown[]) => nextAutoSku(...a),
  },
  DuplicateSkuError: class extends Error {},
  DuplicateBarcodeError: class extends Error {},
  StockedToServiceError: class extends Error {},
}));
vi.mock("../../src/db/repos/recipes", () => ({
  recipesRepo: {
    summaries: (...a: unknown[]) => summaries(...a),
    newRecipeId: () => "recipe-new",
    listForProduct: vi.fn(async () => []),
    eligibleIngredients: vi.fn(async () => []),
    saveDraft: vi.fn(),
    activate: vi.fn(),
    retire: vi.fn(),
  },
}));
vi.mock("../../src/db/repos/vatRates", () => ({
  vatRatesRepo: { listActive: async () => [VAT] },
}));
vi.mock("../../src/db/repos/uoms", () => ({
  uomsRepo: { listActive: async () => [EACH] },
}));
vi.mock("../../src/components/BarcodeManager", () => ({ BarcodeManager: () => null }));
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

function uom(productId: string): ProductUom {
  return {
    id: `uom-${productId}`,
    productId,
    uomCode: "each",
    factor: { num: 1, den: 1 },
    isBase: true,
    isDefaultSale: true,
    isDefaultPurchase: true,
    isActive: true,
    salePriceExclVatCents: null,
    salePriceInclVatCents: null,
  };
}

function item(id: string, name: string): ProductWithUoms {
  const u = uom(id);
  return {
    id,
    storeId: "store-1",
    sku: `SKU-${id}`,
    name,
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
    costingMethod: "purchase_average",
    standardCostExclVatMicrocents: null,
    standardCostSetAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    vatRate: VAT,
    uoms: [u],
    baseUom: u,
    defaultSaleUom: u,
    primaryBarcode: null,
  };
}

function summary(over: Partial<RecipeSummary> & { productId: string }): RecipeSummary {
  return {
    hasDraft: false,
    hasActive: false,
    activeVersion: null,
    retiredCount: 0,
    activeYieldQuantityBase: null,
    activeCostPerBaseUnitMicrocents: null,
    ...over,
  };
}

async function renderProducts(
  products: ProductWithUoms[],
  rows: RecipeSummary[],
) {
  listEnriched.mockResolvedValue(products);
  findByIdEnriched.mockResolvedValue(products[0] ?? null);
  nextAutoSku.mockResolvedValue("SKU-AUTO");
  summaries.mockResolvedValue(new Map(rows.map((r) => [r.productId, r])));

  const { default: Products } = await import("../../src/pages/Products");
  const { createElement } = await import("react");
  render(createElement(I18nProvider, null, createElement(Products)));
  await waitFor(() => expect(listEnriched).toHaveBeenCalled());
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("the recipe badge on a product row", () => {
  it("shows the published version when one is active", async () => {
    await renderProducts(
      [item("p-active", "Published burger")],
      [summary({ productId: "p-active", hasActive: true, activeVersion: 2 })],
    );
    expect(await screen.findByText("v2")).toBeTruthy();
    expect(screen.queryByText("draft")).toBeNull();
    expect(screen.queryByText("retired")).toBeNull();
  });

  it("shows RETIRED, not a blank active version, when only retired exist", async () => {
    // The defect. `hasActive` is false and `activeVersion` is null, and the
    // old branch printed `t("recipes.badgeActive", { version: "" })` in the
    // good-news colour.
    await renderProducts(
      [item("p-retired", "Retired burger")],
      [summary({ productId: "p-retired", retiredCount: 2 })],
    );
    expect(await screen.findByText("retired")).toBeTruthy();
    expect(screen.queryByText("v")).toBeNull();
    expect(screen.queryByText("v2")).toBeNull();
    expect(screen.queryByText("draft")).toBeNull();
  });

  it("shows DRAFT when an unpublished draft exists beside retired history", async () => {
    await renderProducts(
      [item("p-draft", "Drafting burger")],
      [summary({ productId: "p-draft", hasDraft: true, retiredCount: 1 })],
    );
    expect(await screen.findByText("draft")).toBeTruthy();
    expect(screen.queryByText("retired")).toBeNull();
  });

  it("prefers the ACTIVE version when a draft sits beside it", async () => {
    // Both are true while the owner edits a published recipe, and the active
    // one is what the item is costed by, so it is what the row states.
    await renderProducts(
      [item("p-both", "Both burger")],
      [
        summary({
          productId: "p-both",
          hasActive: true,
          activeVersion: 3,
          hasDraft: true,
        }),
      ],
    );
    expect(await screen.findByText("v3")).toBeTruthy();
    expect(screen.queryByText("draft")).toBeNull();
  });

  it("shows NO badge for a product with no recipe history at all", async () => {
    await renderProducts([item("p-none", "Plain burger")], []);
    await waitFor(() => expect(screen.getByText("Plain burger")).toBeTruthy());
    expect(screen.queryByText("draft")).toBeNull();
    expect(screen.queryByText("retired")).toBeNull();
    expect(screen.queryByText(/^v\d*$/)).toBeNull();
    // The action itself is still offered, because every item may acquire one.
    expect(screen.getByRole("button", { name: "Recipe" })).toBeTruthy();
  });

  it("shows nothing active for a summary row that is somehow empty", async () => {
    // Defensive: a row with no draft, no active and no retired history says
    // nothing, and the badge says nothing back rather than guessing.
    await renderProducts(
      [item("p-empty", "Empty summary")],
      [summary({ productId: "p-empty" })],
    );
    await waitFor(() => expect(screen.getByText("Empty summary")).toBeTruthy());
    expect(screen.queryByText("retired")).toBeNull();
    expect(screen.queryByText("draft")).toBeNull();
  });
});

// ===========================================================================
// WP-B2-B P2 — THE COST CELL ON A RECIPE-COSTED ROW
//
// The defect: `effectiveUnitCostMicrocents` and `costConfigurationStatus` had
// no `recipe` branch, so a correctly configured recipe-costed burger fell
// through to a stocked product's zero average and the list printed "—" over
// the word "None" — the catalogue telling the owner nobody had costed the one
// item they had built a recipe for. The source label was computed inline from
// a two-branch ternary with no recipe arm at all.
// ===========================================================================

function recipeItem(id: string, name: string): ProductWithUoms {
  return { ...item(id, name), costingMethod: "recipe" };
}

describe("the cost cell on a recipe-costed product row", () => {
  it("prints the recipe's estimated rate and names the recipe as the source", async () => {
    await renderProducts(
      [recipeItem("p-recipe", "Recipe burger")],
      [
        summary({
          productId: "p-recipe",
          hasActive: true,
          activeVersion: 1,
          activeYieldQuantityBase: 1,
          activeCostPerBaseUnitMicrocents: 173_875_000,
        }),
      ],
    );
    expect(await screen.findByText("$1.73875")).toBeTruthy();
    // The source label under the figure now says Recipe. Before the
    // correction it said "None" — the catalogue telling the owner nobody had
    // costed the one item they had built a recipe for. The row's own Recipe
    // BUTTON carries a version badge, so it is addressed by role and the
    // label by text.
    expect(screen.getAllByText("Recipe")).toHaveLength(2);
    // And it says what kind of figure it is, on the row rather than only in a
    // panel the owner may never open.
    expect(screen.getByText("estimated from the recipe")).toBeTruthy();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByText("Purchases")).toBeNull();
  });

  it("says NOTHING rather than zero when no recipe is published", async () => {
    // `recipe_missing`: the item cannot be sold at all, so a figure here would
    // be worse than a dash.
    await renderProducts(
      [recipeItem("p-norecipe", "Unpublished burger")],
      [summary({ productId: "p-norecipe" })],
    );
    expect(await screen.findByText("None")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("estimated from the recipe")).toBeNull();
  });

  it("says nothing when the recipe exists but an ingredient has no cost", async () => {
    // `recipe_uncosted`: a different problem with a different remedy, and
    // never a zero, which would print a 100% margin.
    await renderProducts(
      [recipeItem("p-uncosted", "Uncostable burger")],
      [
        summary({
          productId: "p-uncosted",
          hasActive: true,
          activeVersion: 1,
          activeYieldQuantityBase: 1,
          activeCostPerBaseUnitMicrocents: null,
        }),
      ],
    );
    expect(await screen.findByText("None")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("ignores an inert Manual Cost left on a recipe-costed row", async () => {
    // A previously typed Manual Cost is carried through rather than wiped, so
    // it is still in the row — and it must never be printed as the item's
    // cost while the method says `recipe`.
    await renderProducts(
      [
        {
          ...recipeItem("p-inert", "Switched burger"),
          standardCostExclVatMicrocents: 999_000_000,
        },
      ],
      [
        summary({
          productId: "p-inert",
          hasActive: true,
          activeVersion: 1,
          activeYieldQuantityBase: 1,
          activeCostPerBaseUnitMicrocents: 173_875_000,
        }),
      ],
    );
    expect(await screen.findByText("$1.73875")).toBeTruthy();
    expect(screen.queryByText("$9.99")).toBeNull();
  });

  it("leaves a purchase-valued row exactly as it was", async () => {
    // The control. Nothing about the other two methods changed.
    await renderProducts(
      [
        {
          ...item("p-stock", "Coffee 250g"),
          isService: false,
          avgCostExclVatMicrocents: 200_000_000,
        },
      ],
      [],
    );
    expect(await screen.findByText("$2.00")).toBeTruthy();
    expect(screen.getByText("Purchases")).toBeTruthy();
  });
});
