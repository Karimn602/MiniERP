# Greaz official menu

Greaz POS ships with the restaurant's own printed menu built in. On a new
installation the owner loads it in one step after enrollment; nobody types 27
products by hand.

## What is in it

`src/catalog/greaz-menu-v1.json`, version `greaz_menu_reference_v1`: the
founder's structured transcription of the printed Greaz menu, bundled **byte for
byte** (SHA-256 `8a2fc1c6d6da8603b527ff1d492c75c647461522f30b957823de72c0947886dd`).
It is compiled into the application, so the menu a build offers is the menu
that was reviewed for that build.

| Section | Items | |
|---|---|---|
| Burgers | 7 | Double Smash $7.00 … Triple Smushroom $10.50 |
| Wraps | 4 | includes **OG Chicken** (`GRZ-WRP-002`), a separate product from the OG Chicken burger (`GRZ-BUR-003`) |
| Fries | 6 | |
| Appetizers | 5 | |
| Combos | 2 | Chicken Strips Combo $9.00, Greaz Box $16.00 |
| Drinks | 2 | Soft Drink $1.00, Water $0.50 |
| Dessert | 1 | Ice Cream Burger $6.50 — **Coming Soon, not sold** |
| Add-ons | 4 | Beef Bacon $2.00, Mozzarella Patty $2.00, Red Cheddar Slice $0.50, Swiss Cheese $0.50 |
| Combo upgrades | 2 | Fries + Soft Drink $3.00, Curly Fries + Soft Drink $4.50 |

27 menu items + 4 add-ons + 2 upgrades = 33 products, every one with a unique
SKU, a description where the menu has one, and a tile icon. No barcodes.

## Loading it (owner only)

1. Enroll the owner as usual.
2. The Register shows **"Greaz's official menu has not been loaded yet"** —
   to the owner only. Choose **Review and load the menu** (also on Products →
   **Official menu**).
3. Review the 33 items, then make the one decision the printed menu does not
   make: **the tax treatment**. Choose the VAT rate, whether the printed prices
   already include VAT or have it added on top, and tick the confirmation. The
   dialog shows what a customer would pay for a Double Smash under your choice.
   Nothing is pre-selected, and **Load the menu** stays disabled until all three
   are given.
4. Load. The items appear on the Register at once, in the printed menu's
   section order.

It loads **once**. A second load is refused; change items from Products after
that. Nothing about it runs when the application starts.

### On a database that already has products

The same dialog previews what will happen to each item, and changes nothing you
do not tick:

- **Same SKU already exists** — left exactly as it is; not overwritten.
- **Same name already on the Register** (e.g. an old "Soft Drink") — kept, and
  the official item is not added, so the Register does not show the same thing
  twice. Tick **Replace** to add the official item and take the old one off the
  Register instead.
- **Other items on the Register** that are not on the official menu (old
  samples) — listed; tick any to take them off the Register. "Tick all marked as
  samples" selects the ones whose SKU starts `GZ-` or `DEMO-`.

Taking an item off the Register **does not delete or deactivate it**: it keeps
its sales, stock, recipes and history, stays purchasable and countable, and can
be shown again from Products. Ingredients (anything used in a recipe, or
already kept off the Register) are never offered. No staff account, shift,
sale, purchase, recipe, stock figure, price or VAT setting of an existing item
is written.

## How the items are set up

- **Non-stock menu items** (`is_service = 1`). A burger is made to order, never
  received on a purchase; as a stocked item with nothing on hand it could not be
  sold at all. Ingredients stay separate: create them in Products with
  "Sold at the Register: inventory only" and receive them on purchases.
- **No cost and no recipe.** Sales of these items show as *cost not configured*
  in the profit reports' coverage panel until a recipe is published with real
  ingredient quantities and purchase costs. No cost is invented.
- **Price** — the printed figure is the authoritative side of the VAT pair you
  chose; the other side is derived with the application's own VAT rounding.
- **The Ice Cream Burger** is created but kept off the Register; the backend
  refuses to sell it. Turn on "Sold at the Register" in Products when it
  launches.

## Sauces, dips, add-ons and upgrades at the Register

The POS has no modifier engine and this work does not add one. Instead:

- **Free choices are asked when the item is added**, and recorded as the line's
  kitchen instruction, which prints on the kitchen ticket and is kept on the
  sale:
  - Dipper Chicken → Buffalo or BBQ → `Sauce: Buffalo`
  - Chicken Loaded Fries → BBQ or Buffalo → `Sauce: BBQ`
  - Greaz Box → exactly three dips from Honey mustard, Buffalo, BBQ →
    `Dips: Honey mustard, BBQ ×2`
  Cancel adds nothing. Two of the same item with the same choice share a line;
  a different choice is a separate line.
- **Everything that costs money is its own priced line.** Add-ons and combo
  upgrades are tiles in their own sections ("Add-ons", "Combo upgrades"), rung
  up after the item they go with. A charge can never disappear into a note.

Limitation, stated: an add-on or upgrade line is not linked to the item it
modifies. The kitchen ticket lists it as its own line.

## Still to be confirmed by the restaurant

These are owner decisions the menu does not settle; the application takes the
permissive reading and changes no money because of it:

- The VAT rate and whether printed prices include VAT (chosen at load time).
- Which items the combo upgrades apply to — any item can currently be rung with one.
- Whether Greaz Box dips may repeat — currently **allowed** (the dips are free).
- Which items the add-ons apply to — currently any.
- Soft-drink flavours, and whether soft drinks should be stock-tracked —
  currently one non-stock "Soft Drink"; the flavour can go in the kitchen note.
- Whether any other item is temporarily unavailable.

## Production and Training

Both editions are built from the same source and carry the same catalog. Each
loads it into its **own** database (`%APPDATA%\com.greazlb.pos\` and
`%APPDATA%\com.greazlb.pos.training\`); loading it in one does nothing to the
other.

## For developers

- Rust: `src-tauri/src/official_menu.rs` — `official_menu_preview`,
  `official_menu_apply`, `Operation::ApplyOfficialMenu` (owner only, checked at
  the boundary and inside the transaction). Tests:
  `src-tauri/src/tests/official_menu.rs`.
- Frontend: `src/lib/officialMenu.ts`, `src/components/OfficialMenuDialog.tsx`,
  `src/components/pos/OfficialMenuPrompt.tsx`,
  `src/components/pos/MenuChoiceDialog.tsx`. Tests:
  `tests/unit/officialMenu*.test.ts(x)`.
- Changing the menu: replace the JSON (new file and label for a new version),
  update the pinned hash in `tests/unit/officialMenu.test.ts`, and the expected
  table in the Rust test. The marker key is per version, but what a second
  version should do in a store that loaded the first (price changes, removed
  items) is NOT designed: this load only ever adds missing SKUs. Design that
  before shipping a v2.
