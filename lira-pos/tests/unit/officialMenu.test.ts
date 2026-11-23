import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import catalog from "../../src/catalog/greaz-menu-v1.json";
import {
  choiceGroupsForSku,
  choiceNoteFor,
  combinedChoiceNote,
  isChoiceComplete,
  OFFICIAL_MENU_LABEL,
} from "../../src/lib/officialMenu";
import { MENU_CATEGORIES, isKnownCategory, isSafeIcon } from "../../src/lib/menuCategories";

/**
 * The bundled catalog is the founder's transcription, byte for byte. Its hash
 * is pinned so a change to the menu is a deliberate, reviewed act: change the
 * file, then this constant, in the same commit.
 */
const CATALOG_SHA256 = "8a2fc1c6d6da8603b527ff1d492c75c647461522f30b957823de72c0947886dd";

const SECTION_IDS: Record<string, string> = {
  Burgers: "burgers",
  Wraps: "wraps",
  Fries: "fries",
  Appetizers: "appetizers",
  Combos: "combos",
  Drinks: "drinks",
  Dessert: "dessert",
  "Add-ons": "addons",
  "Combo Upgrades": "upgrades",
};

describe("the bundled official menu", () => {
  it("is the approved file, unchanged", () => {
    const bytes = readFileSync(new URL("../../src/catalog/greaz-menu-v1.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(CATALOG_SHA256);
    expect(catalog.schema_label).toBe(OFFICIAL_MENU_LABEL);
  });

  it("has 27 menu items, 4 add-ons, 2 upgrades, 9 sections and 3 choice groups", () => {
    const kinds = catalog.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "menu")).toHaveLength(27);
    expect(kinds.filter((k) => k === "add_on")).toHaveLength(4);
    expect(kinds.filter((k) => k === "upgrade")).toHaveLength(2);
    expect(catalog.categories).toHaveLength(9);
    expect(catalog.choice_groups).toHaveLength(3);
    expect(new Set(catalog.items.map((i) => i.sku)).size).toBe(catalog.items.length);
    expect(catalog.items.filter((i) => i.status === "coming_soon").map((i) => i.sku)).toEqual(["GRZ-DES-001"]);
    expect(catalog.items.every((i) => i.barcode === null)).toBe(true);
  });

  it("maps every section to a known Register tab, in the printed menu's order", () => {
    const ids = catalog.categories.map((c) => SECTION_IDS[c.name]);
    expect(ids.every((id) => isKnownCategory(id))).toBe(true);
    const order = MENU_CATEGORIES.map((c) => c.id).filter((id) => ids.includes(id));
    expect(order).toEqual(ids);
  });

  it("gives every item a glyph the icon field accepts", () => {
    for (const i of catalog.items) expect(isSafeIcon(i.icon_suggestion), i.sku).toBe(true);
  });
});

describe("menu choices", () => {
  it("are found by SKU for exactly the three items that have them", () => {
    const withChoices = catalog.items.filter((i) => choiceGroupsForSku(i.sku).length > 0).map((i) => i.sku);
    expect(withChoices).toEqual(["GRZ-BUR-004", "GRZ-FRY-005", "GRZ-CMB-002"]);
    expect(choiceGroupsForSku("grz-bur-004")).toHaveLength(1);
    expect(choiceGroupsForSku(null)).toEqual([]);
    expect(choiceGroupsForSku("Item-00001")).toEqual([]);
  });

  it("write a stable kitchen note in the menu's option order", () => {
    const [dipper] = choiceGroupsForSku("GRZ-BUR-004");
    expect(dipper.options).toEqual(["Buffalo", "BBQ"]);
    expect(choiceNoteFor(dipper, { BBQ: 1 })).toBe("Sauce: BBQ");

    const [box] = choiceGroupsForSku("GRZ-CMB-002");
    expect(box.selectionCount).toBe(3);
    expect(box.repeatAllowed).toBe(true);
    expect(choiceNoteFor(box, { BBQ: 2, "Honey mustard": 1 })).toBe("Dips: Honey mustard, BBQ ×2");
    expect(choiceNoteFor(box, { "Honey mustard": 1, BBQ: 2 })).toBe("Dips: Honey mustard, BBQ ×2");
    expect(combinedChoiceNote([box], { greaz_box_dips: { Buffalo: 3 } })).toBe("Dips: Buffalo ×3");
  });

  it("are complete only at exactly the stated count of known options", () => {
    const [box] = choiceGroupsForSku("GRZ-CMB-002");
    expect(isChoiceComplete(box, { BBQ: 2 })).toBe(false);
    expect(isChoiceComplete(box, { BBQ: 2, Buffalo: 1 })).toBe(true);
    expect(isChoiceComplete(box, { BBQ: 4 })).toBe(false);
    expect(isChoiceComplete(box, { Ketchup: 3 })).toBe(false);
    expect(isChoiceComplete({ ...box, repeatAllowed: false }, { BBQ: 2, Buffalo: 1 })).toBe(false);
  });
});
