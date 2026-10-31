// @vitest-environment jsdom
/**
 * THE RECIPE EDITOR (WP-B2-A)
 *
 * What this pins is the editor's behaviour as an INTERFACE: that a typed
 * quantity reaches the preview exactly, that an ingredient with no cost on
 * file is named rather than silently costed at zero, that publishing is
 * refused while one is, and that every string it shows exists in both
 * languages.
 *
 * Deliberately NOT asserted here: anything about what the database ends up
 * holding. `src-tauri/src/recipes.rs` is the only thing that writes a recipe,
 * and `src-tauri/src/tests/recipes.rs` is the authority on what it does. The
 * same division `productCostingForm.test.tsx` states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";

const eligibleIngredients = vi.fn();
const listForProduct = vi.fn();
const saveDraft = vi.fn();
const activate = vi.fn();
const retire = vi.fn();
const newRecipeId = vi.fn(() => "recipe-new");

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../src/db/repos/recipes", () => ({
  recipesRepo: {
    eligibleIngredients: (...a: unknown[]) => eligibleIngredients(...a),
    listForProduct: (...a: unknown[]) => listForProduct(...a),
    saveDraft: (...a: unknown[]) => saveDraft(...a),
    activate: (...a: unknown[]) => activate(...a),
    retire: (...a: unknown[]) => retire(...a),
    newRecipeId: () => newRecipeId(),
  },
}));

import { RecipeEditor } from "../../src/components/RecipeEditor";

const BUN = {
  productId: "p-bun",
  name: "Burger bun",
  sku: "SKU-BUN",
  uoms: [{ uomCode: "each", factorNum: 1, factorDen: 1, isBase: true }],
  // $0.22 each.
  unitCostExclVatMicrocents: 22_000_000,
  costSource: "purchase_average" as const,
};

const PATTY = {
  productId: "p-patty",
  name: "Beef patty mince",
  sku: "SKU-PTY",
  uoms: [
    { uomCode: "g", factorNum: 1, factorDen: 1, isBase: true },
    { uomCode: "kg", factorNum: 1_000, factorDen: 1, isBase: false },
  ],
  // $0.0085 per gram — a sub-cent RATE, which is why costs are microcents.
  unitCostExclVatMicrocents: 850_000,
  costSource: "purchase_average" as const,
};

/** No cost on file at all. `null` is not zero. */
const PICKLE = {
  productId: "p-pickle",
  name: "Mystery pickle",
  sku: "SKU-UNP",
  uoms: [{ uomCode: "each", factorNum: 1, factorDen: 1, isBase: true }],
  unitCostExclVatMicrocents: null,
  costSource: "purchase_average" as const,
};

function renderEditor(onChanged = vi.fn()) {
  return render(
    <I18nProvider>
      <RecipeEditor
        storeId="store-1"
        productId="p-burger"
        productName="Greaz Burger"
        baseUomCode="each"
        onClose={vi.fn()}
        onChanged={onChanged}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  eligibleIngredients.mockResolvedValue([BUN, PATTY, PICKLE]);
  listForProduct.mockResolvedValue([]);
  saveDraft.mockResolvedValue({
    recipeId: "recipe-new",
    version: 1,
    perBaseUnitMicrocents: 149_500_000,
    batchMicrocents: 149_500_000,
    uncostedComponents: [],
  });
});

afterEach(cleanup);

/** Add a line and set its ingredient, quantity and unit. */
async function addLine(index: number, productId: string, qty: string, uom?: string) {
  fireEvent.click(await screen.findByText("Add ingredient"));
  const selects = screen.getAllByRole("combobox");
  // Two selects per line: ingredient, then unit.
  fireEvent.change(selects[index * 2]!, { target: { value: productId } });
  const quantities = screen.getAllByLabelText("Quantity");
  fireEvent.change(quantities[index]!, { target: { value: qty } });
  if (uom) {
    const unitSelects = screen.getAllByRole("combobox");
    fireEvent.change(unitSelects[index * 2 + 1]!, { target: { value: uom } });
  }
}

describe("the recipe editor", () => {
  it("says what publishing does, and what it does NOT do", async () => {
    // The WP-B2-B boundary, where the operator can see it. Publishing alone
    // changes no cost — the ITEM has to be set to Recipe cost — and a recipe
    // COGS figure is an estimate from the recipe, not evidence that any
    // ingredient was counted out of stock. A screen that implies either would
    // be claiming an inventory guarantee B2-B does not make.
    renderEditor();
    expect(
      await screen.findByText(/set this item.s costing to Recipe cost to use it/),
    ).toBeTruthy();
    expect(
      screen.getByText(/no ingredient is counted out of stock/),
    ).toBeTruthy();
  });

  it("costs a typed quantity exactly, sub-cent rate and all", async () => {
    renderEditor();
    await addLine(0, "p-bun", "1");
    await addLine(1, "p-patty", "150", "g");

    // $0.22 + 150 x $0.0085 = 149,500,000 microcents = $1.495.
    await waitFor(() => {
      expect(screen.getByText("$1.495")).toBeTruthy();
    });
  });

  it("honours a FRACTION and a decimal, which a sale quantity could not", async () => {
    renderEditor();
    await addLine(0, "p-patty", "0.15", "kg");
    // 0.15 kg = 150 g at 850,000 = 127,500,000 microcents = $1.275.
    await waitFor(() => expect(screen.getByText("$1.275")).toBeTruthy());

    fireEvent.change(screen.getAllByLabelText("Quantity")[0]!, {
      target: { value: "1/3" },
    });
    // 1/3 kg = 1000/3 g at 850,000 = 283,333,333.33 -> 283,333,333 microcents.
    await waitFor(() => expect(screen.getByText("$2.83333333")).toBeTruthy());
  });

  it("refuses a numeric PREFIX instead of costing it", async () => {
    // `parseFloat("150g")` is 150, and a quantity that costs plausibly wrong
    // is worse than one that is refused.
    renderEditor();
    await addLine(0, "p-bun", "1abc");
    await waitFor(() => {
      expect(screen.getByText(/is not a quantity/)).toBeTruthy();
    });
    expect(screen.getByText("Save draft").closest("button")!.disabled).toBe(true);
  });

  it("NAMES an ingredient with no cost on file rather than costing it at zero", async () => {
    renderEditor();
    await addLine(0, "p-bun", "1");
    await addLine(1, "p-pickle", "2");

    await waitFor(() => {
      expect(screen.getByText(/Mystery pickle has no cost on file/)).toBeTruthy();
    });
    // And the line itself says so, where the owner is looking.
    expect(screen.getAllByText(/No cost yet/).length).toBeGreaterThan(0);
  });

  it("still lets an incomplete recipe be SAVED as a draft", async () => {
    // The owner has to be able to build the recipe and see what is missing.
    // Only PUBLISHING is refused, and the engine refuses that too.
    saveDraft.mockResolvedValue({
      recipeId: "recipe-new",
      version: 1,
      perBaseUnitMicrocents: null,
      batchMicrocents: null,
      uncostedComponents: ["Mystery pickle"],
    });
    renderEditor();
    await addLine(0, "p-pickle", "2");

    const save = screen.getByText("Save draft").closest("button")!;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/cannot be published yet/)).toBeTruthy();
  });

  it("sends the quantity to the command as an exact reduced fraction", async () => {
    renderEditor();
    await addLine(0, "p-bun", "0.5");
    fireEvent.click(screen.getByText("Save draft"));

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    const payload = saveDraft.mock.calls[0]![0] as {
      recipeId: string;
      yieldQuantityBase: number;
      components: { quantity: { num: number; den: number }; wasteBps: number }[];
    };
    expect(payload.components[0]!.quantity).toEqual({ num: 1, den: 2 });
    expect(payload.components[0]!.wasteBps).toBe(0);
    expect(payload.yieldQuantityBase).toBe(1);
    // The identity is minted ONCE and re-used, so a second save replaces the
    // same draft rather than racing the one-draft index with a new id.
    expect(payload.recipeId).toBe("recipe-new");
  });

  it("turns a typed waste percentage into basis points", async () => {
    renderEditor();
    await addLine(0, "p-bun", "1");
    fireEvent.change(screen.getAllByLabelText("Waste")[0]!, { target: { value: "12.5" } });
    fireEvent.click(screen.getByText("Save draft"));

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    const payload = saveDraft.mock.calls[0]![0] as {
      components: { wasteBps: number }[];
    };
    expect(payload.components[0]!.wasteBps).toBe(1_250);
  });

  it("divides a batch by its yield, so a sauce pot costs per portion", async () => {
    renderEditor();
    await addLine(0, "p-patty", "500", "g");
    fireEvent.change(screen.getByLabelText("One batch makes (in each)"), {
      target: { value: "20" },
    });
    // 500 g x $0.0085 = 425,000,000 mc over 20 portions = 21,250,000 mc.
    await waitFor(() => expect(screen.getByText("$0.2125")).toBeTruthy());
    expect(screen.getByText(/Whole batch: \$4\.25/)).toBeTruthy();
  });

  it("refuses a yield that is not a whole number of at least one", async () => {
    renderEditor();
    await addLine(0, "p-bun", "1");
    fireEvent.change(screen.getByLabelText("One batch makes (in each)"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(screen.getByText(/batch yield must be a whole number/)).toBeTruthy(),
    );
    expect(screen.getByText("Save draft").closest("button")!.disabled).toBe(true);
  });

  it("warns that editing a published recipe creates a new version", async () => {
    listForProduct.mockResolvedValue([
      {
        id: "recipe-v1",
        storeId: "store-1",
        productId: "p-burger",
        version: 1,
        yieldQuantityBase: 1,
        status: "active",
        activatedAt: "2026-10-26T09:00:00.000Z",
        retiredAt: null,
        notes: null,
        createdAt: "2026-10-26T08:00:00.000Z",
        components: [
          {
            id: "rc-1",
            componentProductId: "p-bun",
            componentName: "Burger bun",
            componentSku: "SKU-BUN",
            quantity: { num: 1, den: 1 },
            uomCode: "each",
            factorNum: 1,
            factorDen: 1,
            catalogFactorNum: 1,
            catalogFactorDen: 1,
            conversionDrifted: false,
            wasteBps: 0,
            sortOrder: 0,
            unitCostExclVatMicrocents: 22_000_000,
            costSource: "purchase_average",
            componentIsActive: true,
          },
        ],
      },
    ]);
    renderEditor();

    // The published version's lines are loaded so the owner edits from what is
    // live rather than from an empty sheet...
    await waitFor(() => expect(screen.getByText("Published")).toBeTruthy());
    expect((screen.getAllByLabelText("Quantity")[0] as HTMLInputElement).value).toBe("1");
    // ...and the panel says what saving will actually do.
    expect(screen.getByText(/saving creates version 2 as a new draft/)).toBeTruthy();
    // A fresh identity is minted for it, not the published one's.
    expect(newRecipeId).toHaveBeenCalled();
  });

  it("publishes through the command, never from its own preview", async () => {
    listForProduct.mockResolvedValue([
      {
        id: "recipe-new",
        storeId: "store-1",
        productId: "p-burger",
        version: 1,
        yieldQuantityBase: 1,
        status: "draft",
        activatedAt: null,
        retiredAt: null,
        notes: null,
        createdAt: "2026-10-26T08:00:00.000Z",
        components: [],
      },
    ]);
    activate.mockResolvedValue({
      recipeId: "recipe-new",
      version: 1,
      activatedAt: "2026-10-26T09:00:00.000Z",
      retiredRecipeId: null,
      perBaseUnitMicrocents: 149_500_000,
    });
    const onChanged = vi.fn();
    renderEditor(onChanged);
    await addLine(0, "p-bun", "1");

    fireEvent.click(screen.getByText("Save and publish"));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    // Saved first, then published — the draft the command publishes is the one
    // it has just been given.
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]![0]).toEqual({
      storeId: "store-1",
      recipeId: "recipe-new",
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("surfaces an engine refusal verbatim instead of its own verdict", async () => {
    // The preview is not an authority. When Rust refuses, the operator reads
    // what Rust said.
    saveDraft.mockRejectedValue(
      new Error('This recipe cannot be published yet: "Mystery pickle" has no cost.'),
    );
    renderEditor();
    await addLine(0, "p-bun", "1");
    fireEvent.click(screen.getByText("Save draft"));
    expect(await screen.findByText(/cannot be published yet/)).toBeTruthy();
  });
});
