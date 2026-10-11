import { describe, expect, it } from "vitest";
import {
  MENU_GROUP_ALL,
  MENU_GROUP_OUT_OF_STOCK,
  deriveMenuGroups,
  filterMenu,
  filterMenuByGroup,
  isMenuOutOfStock,
  isMenuSellable,
  menuTilePriceInclVatCents,
  sortMenu,
} from "../../src/lib/menuGrid";
import { computeSaleLineMath } from "../../src/lib/saleMath";
import type { ProductUom, ProductWithUoms, VatRate } from "../../src/db/types";

// ---------------------------------------------------------------------------
// Fixtures. Fully typed on purpose — no `as` casts. A cast here would have hidden
// the very thing these tests are about: that the helpers read real
// `ProductWithUoms` fields (the default sale UoM's factor and price override)
// rather than fields that happen to exist on a loose object literal.
// ---------------------------------------------------------------------------

const VAT_11: VatRate = {
  id: "vat-11",
  name: "Standard 11%",
  rateBps: 1100,
  isExempt: false,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};

/** A sale UoM. `over` sets a per-UoM [excl, incl] price override. */
function uom(code: string, num: number, den: number, over?: [number, number]): ProductUom {
  return {
    id: `uom-${code}-${num}-${den}`,
    productId: "p",
    uomCode: code,
    factor: { num, den },
    isBase: num === 1 && den === 1,
    isDefaultSale: true,
    isDefaultPurchase: false,
    isActive: true,
    salePriceExclVatCents: over ? over[0] : null,
    salePriceInclVatCents: over ? over[1] : null,
  };
}

/** $9.99 incl-VAT, 10 on hand, one "each" sale UoM, no barcode. */
function product(over: Partial<ProductWithUoms> & { name: string }): ProductWithUoms {
  const base = uom("each", 1, 1);
  return {
    id: `id-${over.name}`,
    storeId: "store-1",
    sku: null,
    description: null,
    vatRateId: VAT_11.id,
    vatPricingMode: "inclusive",
    priceExclVatCents: 900,
    priceInclVatCents: 999,
    avgCostExclVatMicrocents: 0,
    avgCostInclVatMicrocents: 0,
    avgCostExclVatCents: 0,
    avgCostInclVatCents: 0,
    quantityOnHand: 10,
    reorderPoint: null,
    isActive: true,
    isService: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    uoms: [base],
    baseUom: base,
    defaultSaleUom: base,
    primaryBarcode: null,
    vatRate: VAT_11,
    ...over,
  };
}

describe("isMenuSellable", () => {
  it("offers an active product", () => {
    expect(isMenuSellable(product({ name: "Double" }))).toBe(true);
  });

  it("hides an inactive product", () => {
    expect(isMenuSellable(product({ name: "Retired Wrap", isActive: false }))).toBe(false);
  });

  it("offers a service, which has no stock to move", () => {
    expect(isMenuSellable(product({ name: "Delivery", isService: true }))).toBe(true);
  });

  // The regression this whole pass turns on: a burger has no barcode, and the
  // register used to refuse any non-service product without one.
  it("offers a stocked product that has no barcode at all", () => {
    const burger = product({ name: "Triple", primaryBarcode: null });
    expect(burger.primaryBarcode).toBeNull();
    expect(isMenuSellable(burger)).toBe(true);
  });
});

describe("menuTilePriceInclVatCents", () => {
  it("shows the product's own incl-VAT price when the UoM has no override", () => {
    expect(menuTilePriceInclVatCents(product({ name: "Fries" }))).toBe(999);
  });

  it("honours a per-UoM price override on the default sale UoM", () => {
    const sixPack = uom("sixpack", 6, 1, [4500, 4995]);
    const p = product({ name: "Soft Drink 6-pack", defaultSaleUom: sixPack, uoms: [sixPack] });
    expect(menuTilePriceInclVatCents(p)).toBe(4995);
  });

  // The tile and the cart line must never print different numbers.
  it("equals the unit price the cart computes for one unit", () => {
    const sixPack = uom("sixpack", 6, 1, [4500, 4995]);
    const p = product({ name: "Soft Drink 6-pack", defaultSaleUom: sixPack, uoms: [sixPack] });
    const cartUnitPrice = computeSaleLineMath({
      quantityInUom: 1,
      factor: p.defaultSaleUom.factor,
      vatBps: p.vatRate.rateBps,
      basePriceExclVatCents: p.priceExclVatCents,
      basePriceInclVatCents: p.priceInclVatCents,
      uomOverrideExclVatCents: p.defaultSaleUom.salePriceExclVatCents,
      uomOverrideInclVatCents: p.defaultSaleUom.salePriceInclVatCents,
    }).unitPriceInclVatCents;

    expect(menuTilePriceInclVatCents(p)).toBe(cartUnitPrice);
  });
});

describe("isMenuOutOfStock", () => {
  it("is in stock when quantity covers one sale unit", () => {
    expect(isMenuOutOfStock(product({ name: "Wings", quantityOnHand: 1 }), false)).toBe(false);
  });

  it("is out of stock at zero on hand", () => {
    expect(isMenuOutOfStock(product({ name: "Wings", quantityOnHand: 0 }), false)).toBe(true);
  });

  it("is out of stock when already negative", () => {
    expect(isMenuOutOfStock(product({ name: "Wings", quantityOnHand: -3 }), false)).toBe(true);
  });

  it("accounts for a multi-unit sale UoM: 6 on hand cannot make a 12-pack", () => {
    const dozen = uom("dozen", 12, 1);
    const p = product({ name: "Cheese Balls", defaultSaleUom: dozen, uoms: [dozen], quantityOnHand: 6 });
    expect(isMenuOutOfStock(p, false)).toBe(true);
  });

  it("a service never runs out", () => {
    const p = product({ name: "Delivery", isService: true, quantityOnHand: 0 });
    expect(isMenuOutOfStock(p, false)).toBe(false);
  });

  it("nothing is out of stock once negative inventory is allowed", () => {
    const p = product({ name: "Wings", quantityOnHand: -3 });
    expect(isMenuOutOfStock(p, true)).toBe(false);
  });
});

describe("filterMenu", () => {
  const menu = [
    product({ name: "Double" }),
    product({ name: "Chicken Burger" }),
    product({ name: "Chili Fries", sku: "APP-02" }),
    product({ name: "Onion Rings" }),
  ];

  it("returns the whole menu for a blank term", () => {
    expect(filterMenu(menu, "")).toHaveLength(4);
    expect(filterMenu(menu, "   ")).toHaveLength(4);
  });

  it("matches on a name substring, case-insensitively", () => {
    expect(filterMenu(menu, "chi").map((p) => p.name)).toEqual([
      "Chicken Burger",
      "Chili Fries",
    ]);
  });

  it("matches on SKU", () => {
    expect(filterMenu(menu, "app-02").map((p) => p.name)).toEqual(["Chili Fries"]);
  });

  it("returns nothing for a term that matches nothing", () => {
    expect(filterMenu(menu, "pizza")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const before = menu.map((p) => p.name);
    filterMenu(menu, "chi");
    expect(menu.map((p) => p.name)).toEqual(before);
  });
});

describe("sortMenu", () => {
  it("orders by name ignoring case, unlike SQLite's byte-wise ORDER BY", () => {
    const menu = [
      product({ name: "Wings" }),
      product({ name: "fries" }),
      product({ name: "Boneless" }),
    ];
    expect(sortMenu(menu).map((p) => p.name)).toEqual(["Boneless", "fries", "Wings"]);
  });

  it("does not mutate the input", () => {
    const menu = [product({ name: "Wings" }), product({ name: "Boneless" })];
    sortMenu(menu);
    expect(menu.map((p) => p.name)).toEqual(["Wings", "Boneless"]);
  });
});

describe("deriveMenuGroups", () => {
  it("offers only All when everything is in stock, so the row can be hidden", () => {
    const menu = [product({ name: "Double" }), product({ name: "Fries" })];
    const groups = deriveMenuGroups(menu, false);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(MENU_GROUP_ALL);
    expect(groups[0].count).toBe(2);
  });

  it("adds an Out of stock chip, counted, once something has run out", () => {
    const menu = [
      product({ name: "Double" }),
      product({ name: "Fries", quantityOnHand: 0 }),
      product({ name: "Wings", quantityOnHand: 0 }),
    ];
    const groups = deriveMenuGroups(menu, false);
    expect(groups.map((g) => g.id)).toEqual([MENU_GROUP_ALL, MENU_GROUP_OUT_OF_STOCK]);
    expect(groups[0].count).toBe(3);
    expect(groups[1].count).toBe(2);
  });

  it("drops the Out of stock chip when negative inventory is allowed", () => {
    const menu = [product({ name: "Fries", quantityOnHand: 0 })];
    expect(deriveMenuGroups(menu, true)).toHaveLength(1);
  });
});

describe("filterMenuByGroup", () => {
  const menu = [
    product({ name: "Double" }),
    product({ name: "Fries", quantityOnHand: 0 }),
  ];

  it("All returns the whole menu", () => {
    expect(filterMenuByGroup(menu, MENU_GROUP_ALL, false)).toHaveLength(2);
  });

  it("Out of stock returns only what has run out", () => {
    expect(filterMenuByGroup(menu, MENU_GROUP_OUT_OF_STOCK, false).map((p) => p.name)).toEqual([
      "Fries",
    ]);
  });

  // A stale chip must never strand the cashier on an empty grid.
  it("an unknown group falls back to the whole menu rather than nothing", () => {
    expect(filterMenuByGroup(menu, "burgers-from-a-future-schema", false)).toHaveLength(2);
  });
});
