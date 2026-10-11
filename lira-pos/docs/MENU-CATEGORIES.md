# Greaz POS — menu categories, and why the register has none

Status: **known limitation, deliberately not fixed in the appearance work.**

## What the approved design shows

`design-references/greaz-theme-references/` — the prototype and both 1366×768
screenshots — puts a row of named section chips above the menu grid:

> ALL · BURGERS · SIDES · WRAPS · ADD-ONS · DRINKS

`greaz_menu_design_fixture.json` carries the same five categories across its 17
items, and the printed Greaz menu is organised that way too.

## What the application can actually do

**There is no category column.** `products` has no `category`, `group`,
`section` or `department` field, and the only `category` anywhere in the schema
is `units_of_measure.category`, which classifies units (count / weight / volume
/ length) and has nothing to do with food.

So the register derives its chips from data that does exist
(`src/lib/menuGrid.ts::deriveMenuGroups`):

- **All** — every sellable item.
- **Out of stock** — shown only when something has actually run out, which is
  the question a cashier asks the screen most often after "how much".

When nothing is out of stock there is one group, and the chip row hides itself
rather than showing a lone control that filters nothing.

## Why it was not added

Named sections need a nullable `category` column on `products`, a field on the
Products page to set it, and a migration. The appearance work was scoped to the
front end, and migrations were explicitly out of scope. The alternative —
keeping categories in `localStorage` — was rejected outright: that scatters
master data per device, so two terminals would disagree about what a Double
Burger is.

## The seam

`deriveMenuGroups` already returns `{ id, labelKey, count }[]` and
`filterMenuByGroup` already narrows by id. The chip row, the filtering and the
grid are written against that shape and nothing else. The day a `category`
column lands, those two functions grow one chip per distinct value and
**everything downstream works unchanged** — no layout work, no new component.

The design-only preview (`src/preview/`, served from `preview.html`, never
shipped) hard-codes the five fixture categories so the approved layout can be
judged on a full menu. That is presentation data for a mockup; it creates no
product, no UoM and no catalog row, and it is not an importer payload.

## Note for whoever picks this up

Do not surface this limitation on the register itself. It was briefly explained
in a footnote under the menu grid, and that was wrong: a cashier mid-service
cannot act on it, and a schema caveat printed on a till screen is developer
chatter in the one place that should only ever carry the order. It lives here
instead.
