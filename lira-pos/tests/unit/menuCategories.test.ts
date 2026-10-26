import { describe, expect, it } from "vitest";
import {
  MENU_CATEGORIES,
  UNCATEGORIZED_ID,
  categoryOrder,
  isKnownCategory,
  normalizeCategoryId,
  resolveCategory,
  resolveIcon,
} from "../../src/lib/menuCategories";
import {
  MENU_GROUP_ALL,
  MENU_GROUP_OUT_OF_STOCK,
  deriveMenuGroups,
  filterMenuByGroup,
  sortMenu,
} from "../../src/lib/menuGrid";
import type { ProductUom, ProductWithUoms, VatRate } from "../../src/db/types";

/**
 * WP-3 — restaurant menu sections and icons.
 *
 * Migration 013 made `products.category` free text on purpose, so the duplicate
 * problem the brief names — "Drinks" / "drinks" / " Drinks " splitting the grid
 * into three sections — is prevented here rather than by a CHECK constraint
 * that could only reject, never fold. These tests pin that, plus the rule that
 * an existing uncategorised catalogue keeps working untouched.
 */

const VAT: VatRate = {
  id: "vat-11",
  name: "Standard",
  rateBps: 1100,
  isExempt: false,
  effectiveFrom: "2020-01-01",
  effectiveTo: null,
};

function uom(): ProductUom {
  return {
    id: "u1",
    productId: "p",
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

function product(
  name: string,
  category: string | null,
  over: Partial<ProductWithUoms> = {},
): ProductWithUoms {
  const u = uom();
  return {
    id: `id-${name}`,
    storeId: "s1",
    sku: null,
    name,
    description: null,
    vatRateId: VAT.id,
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
    category,
    icon: null,
    // Purchase valuation with no cost configured (WP-B1): the state every
    // product was in before migration 020, and the one this fixture means.
    costingMethod: "purchase_average" as const,
    standardCostExclVatMicrocents: null,
    standardCostSetAt: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    uoms: [u],
    baseUom: u,
    defaultSaleUom: u,
    primaryBarcode: null,
    vatRate: VAT,
    ...over,
  };
}

describe("normalizeCategoryId — one section, however it is typed", () => {
  it.each([
    ["Drinks", "drinks"],
    ["drinks", "drinks"],
    [" Drinks ", "drinks"],
    ["DRINKS", "drinks"],
    ["  dRiNkS\t", "drinks"],
  ])("folds %s to %s", (raw, expected) => {
    // The duplicate-section hazard of a free-text column, closed at the only
    // boundary that writes it.
    expect(normalizeCategoryId(raw)).toBe(expected);
  });

  it("collapses internal whitespace rather than making a new section", () => {
    expect(normalizeCategoryId("hot  drinks")).toBe("hot drinks");
  });

  it("treats absent, blank and whitespace alike as NO section", () => {
    // `null`, not "uncategorized": the column says "no section" with NULL, and
    // a sentinel string would be indistinguishable from a real section someone
    // happened to name that.
    for (const v of [null, undefined, "", "   ", "\t\n"]) {
      expect(normalizeCategoryId(v)).toBeNull();
    }
  });
});

describe("resolveCategory — a product is always showable", () => {
  it("resolves each known section to itself", () => {
    for (const c of MENU_CATEGORIES) {
      expect(resolveCategory(c.id).id).toBe(c.id);
    }
  });

  it("resolves a differently-cased value to the same section", () => {
    expect(resolveCategory(" BURGERS ").id).toBe("burgers");
  });

  it.each([[null], [undefined], [""], ["nonsense"], ["breakfast"]])(
    "buckets %s as uncategorised instead of hiding it",
    (raw) => {
      // A grid that hid what it could not classify would hide stock the shop
      // is trying to sell.
      expect(resolveCategory(raw).id).toBe(UNCATEGORIZED_ID);
    },
  );

  it("agrees with isKnownCategory", () => {
    expect(isKnownCategory("Drinks")).toBe(true);
    expect(isKnownCategory("breakfast")).toBe(false);
    expect(isKnownCategory(null)).toBe(false);
  });
});

describe("resolveIcon — the product's own, else its section's", () => {
  it("prefers the product icon", () => {
    expect(resolveIcon("🥓", "burgers")).toBe("🥓");
  });

  it("falls back to the section glyph when there is none", () => {
    expect(resolveIcon(null, "drinks")).toBe(resolveCategory("drinks").fallbackIcon);
    expect(resolveIcon(undefined, "sides")).toBe(resolveCategory("sides").fallbackIcon);
  });

  it("treats a blank icon as absent rather than rendering an empty tile", () => {
    expect(resolveIcon("   ", "wraps")).toBe(resolveCategory("wraps").fallbackIcon);
  });

  it("always returns something, even with nothing to go on", () => {
    expect(resolveIcon(null, null).length).toBeGreaterThan(0);
  });

  it("never infers an icon from the product NAME", () => {
    // The obvious shortcut, and wrong: it breaks on a rename, breaks in
    // another language, and mislabels anything whose name contains another
    // item's word. Only the explicit fields are consulted.
    expect(resolveIcon(null, "drinks")).not.toBe(resolveCategory("burgers").fallbackIcon);
  });
});

describe("deriveMenuGroups — real sections (WP-3)", () => {
  const menu = [
    product("Double Burger", "burgers"),
    product("Chicken Burger", "burgers"),
    product("Beef Wrap", "wraps"),
    product("Cola", "drinks"),
  ];

  it("offers All plus one chip per occupied section", () => {
    const groups = deriveMenuGroups(menu, false);
    expect(groups.map((g) => g.id)).toEqual([MENU_GROUP_ALL, "burgers", "wraps", "drinks"]);
  });

  it("counts each section, and All counts everything", () => {
    const groups = deriveMenuGroups(menu, false);
    expect(groups.find((g) => g.id === MENU_GROUP_ALL)!.count).toBe(4);
    expect(groups.find((g) => g.id === "burgers")!.count).toBe(2);
    expect(groups.find((g) => g.id === "wraps")!.count).toBe(1);
  });

  it("omits a section nothing is in", () => {
    // A burger shop that sells no sides shows no Sides chip filtering to an
    // empty grid.
    expect(deriveMenuGroups(menu, false).map((g) => g.id)).not.toContain("sides");
  });

  it("orders sections by the MENU, not alphabetically or by count", () => {
    const groups = deriveMenuGroups(
      [product("Cola", "drinks"), product("Fries", "sides"), product("Burger", "burgers")],
      false,
    );
    expect(groups.map((g) => g.id)).toEqual([MENU_GROUP_ALL, "burgers", "sides", "drinks"]);
  });

  it("shows NO section chips when nothing is categorised", () => {
    // An existing catalogue predating migration 013 looks exactly as it did:
    // a lone "Other" chip beside "All" would filter to the identical grid.
    const groups = deriveMenuGroups([product("A", null), product("B", null)], false);
    expect(groups.map((g) => g.id)).toEqual([MENU_GROUP_ALL]);
  });

  it("does show Other when it sits BESIDE real sections", () => {
    const groups = deriveMenuGroups([product("Burger", "burgers"), product("Mystery", null)], false);
    expect(groups.map((g) => g.id)).toEqual([MENU_GROUP_ALL, "burgers", UNCATEGORIZED_ID]);
  });

  it("keeps Out of stock, after the sections", () => {
    // WP-3 was not a licence to remove it: it answers a different question.
    const groups = deriveMenuGroups(
      [product("Burger", "burgers"), product("Fries", "sides", { quantityOnHand: 0 })],
      false,
    );
    expect(groups.map((g) => g.id)).toEqual([
      MENU_GROUP_ALL,
      "burgers",
      "sides",
      MENU_GROUP_OUT_OF_STOCK,
    ]);
  });

  it("counts a mis-typed category under the chip that will show it", () => {
    const groups = deriveMenuGroups(
      [product("Burger", "burgers"), product("Odd", "breakfast")],
      false,
    );
    // The chip's number matches the tiles behind it, which counting the raw
    // column would not have done.
    expect(groups.find((g) => g.id === UNCATEGORIZED_ID)!.count).toBe(1);
  });
});

describe("filterMenuByGroup — the tiles behind a chip", () => {
  const menu = [
    product("Double Burger", "burgers"),
    product("Beef Wrap", "wraps"),
    product("Cola", "drinks", { quantityOnHand: 0 }),
    product("Mystery", null),
  ];

  it("narrows to one section", () => {
    expect(filterMenuByGroup(menu, "burgers", false).map((p) => p.name)).toEqual([
      "Double Burger",
    ]);
  });

  it("matches a differently-cased stored value", () => {
    const odd = [product("Shake", " DRINKS ")];
    expect(filterMenuByGroup(odd, "drinks", false)).toHaveLength(1);
  });

  it("puts an unrecognised category under Other", () => {
    const menuPlus = [...menu, product("Pancakes", "breakfast")];
    expect(filterMenuByGroup(menuPlus, UNCATEGORIZED_ID, false).map((p) => p.name)).toEqual([
      "Mystery",
      "Pancakes",
    ]);
  });

  it("still returns everything for All and for an unknown chip", () => {
    expect(filterMenuByGroup(menu, MENU_GROUP_ALL, false)).toHaveLength(4);
    // A stale selected chip must never leave the cashier staring at nothing.
    expect(filterMenuByGroup(menu, "a-chip-that-went-away", false)).toHaveLength(4);
  });

  it("still filters Out of stock", () => {
    expect(filterMenuByGroup(menu, MENU_GROUP_OUT_OF_STOCK, false).map((p) => p.name)).toEqual([
      "Cola",
    ]);
  });
});

describe("sortMenu — section first, then name", () => {
  it("groups the board the way it is read", () => {
    const sorted = sortMenu([
      product("Cola", "drinks"),
      product("Zinger Wrap", "wraps"),
      product("Chicken Burger", "burgers"),
      product("Fries", "sides"),
      product("Double Burger", "burgers"),
    ]);
    expect(sorted.map((p) => p.name)).toEqual([
      "Chicken Burger",
      "Double Burger",
      "Zinger Wrap",
      "Fries",
      "Cola",
    ]);
  });

  it("is plain alphabetical when nothing is categorised", () => {
    // Exactly the previous behaviour, so an uncategorised catalogue is
    // unaffected by this change.
    const sorted = sortMenu([product("Cola", null), product("Apple", null), product("Beef", null)]);
    expect(sorted.map((p) => p.name)).toEqual(["Apple", "Beef", "Cola"]);
  });

  it("puts uncategorised items last", () => {
    const sorted = sortMenu([product("Mystery", null), product("Burger", "burgers")]);
    expect(sorted.map((p) => p.name)).toEqual(["Burger", "Mystery"]);
  });

  it("orders by section even when the stored case differs", () => {
    const sorted = sortMenu([product("Cola", "DRINKS"), product("Burger", " burgers ")]);
    expect(sorted.map((p) => p.name)).toEqual(["Burger", "Cola"]);
  });
});

describe("categoryOrder", () => {
  it("follows MENU_CATEGORIES", () => {
    expect(categoryOrder("burgers")).toBeLessThan(categoryOrder("drinks"));
    expect(categoryOrder("drinks")).toBeLessThan(categoryOrder(null));
  });
});
