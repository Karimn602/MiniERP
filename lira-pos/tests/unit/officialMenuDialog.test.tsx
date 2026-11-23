// @vitest-environment jsdom
/**
 * The owner's official-menu dialog: nothing can be loaded until a VAT rate, a
 * pricing side and an explicit confirmation are all given; reconciliation is
 * opt-in; and what is sent is exactly what was chosen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { OfficialMenuDialog } from "../../src/components/OfficialMenuDialog";
import type { OfficialMenuPreview } from "../../src/lib/officialMenu";

const VAT = [
  { id: "vat-11", name: "Standard 11%", rateBps: 1100, isExempt: false, effectiveFrom: "2018-01-01", effectiveTo: null },
  { id: "vat-0", name: "Zero-rated 0%", rateBps: 0, isExempt: false, effectiveFrom: "2018-01-01", effectiveTo: null },
];

const item = (sku: string, name: string, cents: number, category: string, outcome = "create") => ({
  sku,
  name,
  category,
  priceUsdCents: cents,
  description: null,
  icon: "🍔",
  kind: "menu" as const,
  sellable: sku !== "GRZ-DES-001",
  outcome: outcome as "create",
  existing: [] as OfficialMenuPreview["items"][number]["existing"],
});

function preview(): OfficialMenuPreview {
  const soft = item("GRZ-DRK-001", "Soft Drink", 100, "drinks", "name_match");
  soft.existing = [
    {
      productId: "p-old-soft",
      sku: "Item-00007",
      name: "Soft Drink",
      category: null,
      priceInclVatCents: 150,
      priceExclVatCents: 135,
      vatPricingMode: "inclusive",
      isActive: true,
      showOnRegister: true,
    },
  ];
  return {
    catalogLabel: "greaz_menu_reference_v1",
    applied: null,
    items: [
      item("GRZ-BUR-001", "Double Smash", 700, "burgers"),
      soft,
      item("GRZ-DES-001", "Ice Cream Burger", 650, "dessert"),
    ],
    samples: [
      {
        productId: "p-gz-fries",
        sku: "GZ-SID-FRIES",
        name: "Fries",
        category: "sides",
        priceInclVatCents: 300,
        priceExclVatCents: 270,
        vatPricingMode: "inclusive",
        isActive: true,
        showOnRegister: true,
        looksLikeSample: true,
      },
    ],
  };
}

function renderDialog(onApplied = vi.fn()) {
  render(
    <I18nProvider>
      <OfficialMenuDialog storeId="store-1" vatRates={VAT} onClose={vi.fn()} onApplied={onApplied} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "official_menu_preview") return preview();
    if (cmd === "official_menu_apply")
      return {
        createdSkus: ["GRZ-BUR-001", "GRZ-DRK-001", "GRZ-DES-001"],
        skippedExistingSkus: [],
        keptExistingByNameSkus: [],
        hiddenProductIds: ["p-old-soft", "p-gz-fries"],
        record: {
          catalogLabel: "greaz_menu_reference_v1",
          appliedAt: "2026-11-23T10:00:00.000Z",
          appliedByUserId: "owner",
          vatRateId: "vat-11",
          vatRateBps: 1100,
          vatPricingMode: "inclusive",
          created: 3,
          skippedExistingSku: 0,
          keptExistingByName: 0,
          hiddenFromRegister: 2,
        },
      };
    throw new Error(`unexpected ${cmd}`);
  });
});

afterEach(cleanup);

describe("OfficialMenuDialog", () => {
  it("cannot load until the VAT rate, the pricing side and the confirmation are all given", async () => {
    renderDialog();
    await screen.findByTestId("official-menu-row-GRZ-BUR-001");
    const apply = screen.getByTestId("official-menu-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("official-menu-vat"), { target: { value: "vat-11" } });
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("official-menu-mode-exclusive"));
    expect(apply.disabled).toBe(true);
    // The customer-facing consequence is shown before anything is confirmed.
    expect(screen.getByTestId("official-menu-example").textContent).toContain("$7.77");
    fireEvent.click(screen.getByTestId("official-menu-mode-inclusive"));
    expect(screen.getByTestId("official-menu-example").textContent).toContain("pays $7.00");
    fireEvent.click(screen.getByTestId("official-menu-confirm"));
    expect(apply.disabled).toBe(false);
  });

  it("offers no default VAT rate and no default pricing side", async () => {
    renderDialog();
    await screen.findByTestId("official-menu-row-GRZ-BUR-001");
    expect((screen.getByTestId("official-menu-vat") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("official-menu-mode-inclusive") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("official-menu-mode-exclusive") as HTMLInputElement).checked).toBe(false);
  });

  it("sends exactly the reconciliation the owner ticked", async () => {
    const onApplied = vi.fn();
    renderDialog(onApplied);
    await screen.findByTestId("official-menu-row-GRZ-BUR-001");
    expect(screen.getByTestId("official-menu-row-GRZ-DES-001").textContent).toContain("Coming soon");

    fireEvent.change(screen.getByTestId("official-menu-vat"), { target: { value: "vat-11" } });
    fireEvent.click(screen.getByTestId("official-menu-mode-inclusive"));
    fireEvent.click(screen.getByTestId("official-menu-confirm"));
    fireEvent.click(screen.getByTestId("official-menu-replace-GRZ-DRK-001"));
    fireEvent.click(screen.getByTestId("official-menu-hide-p-gz-fries"));
    fireEvent.click(screen.getByTestId("official-menu-apply"));

    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("official_menu_apply", {
      payload: {
        storeId: "store-1",
        vatRateId: "vat-11",
        vatPricingMode: "inclusive",
        taxTreatmentConfirmed: true,
        replaceNameMatches: [{ sku: "GRZ-DRK-001", existingProductIds: ["p-old-soft"] }],
        hideProductIds: ["p-gz-fries"],
        catalogLabel: "greaz_menu_reference_v1",
      },
    });
    expect(await screen.findByTestId("official-menu-applied")).toBeTruthy();
  });

  it("by default replaces and hides nothing", async () => {
    renderDialog();
    await screen.findByTestId("official-menu-row-GRZ-BUR-001");
    fireEvent.change(screen.getByTestId("official-menu-vat"), { target: { value: "vat-0" } });
    fireEvent.click(screen.getByTestId("official-menu-mode-inclusive"));
    fireEvent.click(screen.getByTestId("official-menu-confirm"));
    fireEvent.click(screen.getByTestId("official-menu-apply"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "official_menu_apply",
        expect.objectContaining({
          payload: expect.objectContaining({ replaceNameMatches: [], hideProductIds: [] }),
        }),
      ),
    );
  });

  it("shows a loaded menu as loaded and offers no second load", async () => {
    invokeMock.mockImplementation(async () => ({
      ...preview(),
      applied: {
        catalogLabel: "greaz_menu_reference_v1",
        appliedAt: "2026-11-23T10:00:00.000Z",
        appliedByUserId: "owner",
        vatRateId: "vat-11",
        vatRateBps: 1100,
        vatPricingMode: "inclusive",
        created: 33,
        skippedExistingSku: 0,
        keptExistingByName: 0,
        hiddenFromRegister: 0,
      },
    }));
    renderDialog();
    expect(await screen.findByTestId("official-menu-applied")).toBeTruthy();
    expect(screen.queryByTestId("official-menu-apply")).toBeNull();
    expect(screen.queryByTestId("official-menu-tax")).toBeNull();
  });
});
