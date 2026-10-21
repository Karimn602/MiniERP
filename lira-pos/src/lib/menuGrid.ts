/**
 * Menu-grid presentation helpers — pure, no React, no DB.
 *
 * Greaz is a quick-service burger shop: the cashier clicks the item the
 * customer ordered. These helpers decide what appears on that grid, what price
 * is printed on a tile, and which tiles are click-dead — and nothing else. No
 * posting payload, no cart mutation and no cost/VAT convention lives here; the
 * register still owns all of that.
 *
 * The one rule worth stating: a tile's price is computed through
 * `computeSaleLineMath` at quantity 1, the SAME function the cart line uses.
 * Reading `priceInclVatCents` off the product directly would have been shorter
 * and wrong — a product with a per-UoM price override on its default sale UoM
 * would advertise one price on the tile and ring up another in the cart, and
 * the cashier would be arguing with a customer about a number the screen told
 * them. There is one price path, so they cannot disagree.
 */

import type { ProductWithUoms } from "../db/types";
import { computeSaleLineMath } from "./saleMath";
import type { UsdCents } from "./money";
import {
  MENU_CATEGORIES,
  UNCATEGORIZED_ID,
  categoryOrder,
  resolveCategory,
} from "./menuCategories";

/**
 * May this product be offered as a menu tile?
 *
 * Deliberately just "is it active". Note what is NOT here: the register's old
 * `primaryBarcode !== null` gate. That was a retail "barcode-first" catalog
 * policy, and a burger has no barcode — see the note on
 * `PosRegister.addProductToCart` for why it was relaxed rather than worked
 * around here. Services are explicitly welcome: a service is a perfectly good
 * sale line, it simply moves no stock.
 */
export function isMenuSellable(product: ProductWithUoms): boolean {
  return product.isActive;
}

/**
 * The price to print on the tile, in USD cents including VAT.
 *
 * Including VAT because that is the number the customer hands money for, and
 * the number the cart's own unit-price column shows.
 */
export function menuTilePriceInclVatCents(product: ProductWithUoms): UsdCents {
  return computeSaleLineMath({
    quantityInUom: 1,
    factor: product.defaultSaleUom.factor,
    vatBps: product.vatRate.rateBps,
    basePriceExclVatCents: product.priceExclVatCents,
    basePriceInclVatCents: product.priceInclVatCents,
    uomOverrideExclVatCents: product.defaultSaleUom.salePriceExclVatCents,
    uomOverrideInclVatCents: product.defaultSaleUom.salePriceInclVatCents,
  }).unitPriceInclVatCents;
}

/**
 * Would adding ONE of this product be refused for want of stock?
 *
 * Mirrors the quantity-1 arm of the register's own stock cap, so a tile is
 * greyed out for exactly the reason a click would have been rejected. Showing
 * the tile greyed rather than hiding it is the point: "Fries, out of stock" is
 * an answer a cashier can give the customer, whereas a silently absent tile
 * looks like a broken till.
 *
 * Services never run out. Neither does anything when the operator has turned
 * on negative inventory, which is exactly what that setting means.
 */
export function isMenuOutOfStock(
  product: ProductWithUoms,
  allowNegativeInventory: boolean,
): boolean {
  if (allowNegativeInventory) return false;
  if (product.isService) return false;
  const { num, den } = product.defaultSaleUom.factor;
  const oneUnitBase = (1 * num) / den;
  return oneUnitBase > product.quantityOnHand;
}

/**
 * Narrow the menu by a cashier-typed term, matching name first then SKU.
 *
 * Client-side over the already-loaded menu, so it is instant and needs no
 * round trip — the cashier is filtering a wall of ~30 burgers, not querying a
 * 10,000-SKU catalog. A blank or whitespace term returns the list unchanged
 * (not an empty grid), and matching is case- and accent-insensitive on the
 * caller's locale rules only insofar as `toLowerCase` provides it.
 */
export function filterMenu(
  products: ProductWithUoms[],
  term: string,
): ProductWithUoms[] {
  const q = term.trim().toLowerCase();
  if (q === "") return products;
  return products.filter((p) => {
    if (p.name.toLowerCase().includes(q)) return true;
    return p.sku !== null && p.sku.toLowerCase().includes(q);
  });
}

/**
 * The menu in the order it should be shown: by name, case-insensitively.
 *
 * `productsRepo.list` already orders by name, but SQLite's default `ORDER BY`
 * on TEXT is byte-wise, so "fries" sorts after "Wings". Re-sorting here keeps
 * the grid in the order a human reads it. Returns a new array; the input is
 * left alone.
 */
export function sortMenu(products: ProductWithUoms[]): ProductWithUoms[] {
  // Section first, then name within it. On the "All" chip — the view the
  // cashier spends the day on — that groups burgers together, then wraps, then
  // sides, which is how a menu board reads and how an order is called. A flat
  // alphabetical list interleaved them, so "Cheese Fries" sat between two
  // burgers and the eye had to search rather than scan.
  //
  // Ties fall back to the name comparison that was here before, so a shop that
  // has categorised nothing gets exactly the previous ordering.
  return products.slice().sort((a, b) => {
    const section = categoryOrder(a.category) - categoryOrder(b.category);
    if (section !== 0) return section;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// ---------------------------------------------------------------------------
// Category / group chips
// ---------------------------------------------------------------------------

/** One chip in the menu's group row. */
export interface MenuGroup {
  id: string;
  /** i18n key for the chip label. */
  labelKey: string;
  count: number;
}

export const MENU_GROUP_ALL = "all";
export const MENU_GROUP_OUT_OF_STOCK = "out-of-stock";

/**
 * The chips to show above the grid.
 *
 * Now the real menu sections, which migration 013 made possible by adding
 * `products.category`. The seam this function was written around is the one it
 * now uses: the shape of the return value has not changed, so the chip row,
 * the filtering and the grid needed nothing.
 *
 * Three rules worth stating, because each is a decision:
 *
 *   * A section appears ONLY if something in the menu is in it. A burger till
 *     that sells no wraps does not show a Wraps chip that filters to an empty
 *     grid, and a shop that has categorised nothing sees no section chips at
 *     all rather than a lone "Uncategorised".
 *
 *   * Sections come in MENU order, from `MENU_CATEGORIES` — the order a
 *     customer reads a board, mains before extras before drinks — not
 *     alphabetical and not by count. Uncategorised is last, always, because it
 *     is a holding pen rather than a section.
 *
 *   * "Out of stock" stays, and stays AFTER the sections. It answers a
 *     different question from "where is this on the menu" ("what can I not
 *     sell right now"), and WP-3 was not a licence to remove it.
 *
 * `All` is always first and always counts the whole sellable menu, so there is
 * always a way back to everything.
 */
export function deriveMenuGroups(
  products: ProductWithUoms[],
  allowNegativeInventory: boolean,
): MenuGroup[] {
  const groups: MenuGroup[] = [
    { id: MENU_GROUP_ALL, labelKey: "pos.groupAll", count: products.length },
  ];

  // Counted by RESOLVED section, so a product whose category was hand-edited
  // to something unknown is counted under Uncategorised — the same bucket the
  // grid will show it in. Counting the raw column instead would produce a chip
  // whose number did not match the tiles behind it.
  const counts = new Map<string, number>();
  for (const p of products) {
    const id = resolveCategory(p.category).id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // A menu whose only "section" is Uncategorised has no sections to choose
  // between, so it gets none — a lone "Other" chip beside "All" would filter
  // to the identical grid. This is also what keeps a catalogue that predates
  // migration 013 looking exactly as it did.
  const sectioned = MENU_CATEGORIES.filter((c) => (counts.get(c.id) ?? 0) > 0);
  const onlyUncategorized =
    sectioned.length === 1 && sectioned[0].id === UNCATEGORIZED_ID;

  if (!onlyUncategorized) {
    for (const category of sectioned) {
      groups.push({
        id: category.id,
        labelKey: category.labelKey,
        count: counts.get(category.id) ?? 0,
      });
    }
  }

  const outCount = products.filter((p) => isMenuOutOfStock(p, allowNegativeInventory)).length;
  if (outCount > 0) {
    groups.push({
      id: MENU_GROUP_OUT_OF_STOCK,
      labelKey: "pos.groupOutOfStock",
      count: outCount,
    });
  }

  return groups;
}

/**
 * Narrow the menu to one group. An unknown group id falls through to the whole
 * menu rather than an empty grid — a stale selected chip must never leave a
 * cashier staring at nothing sellable.
 */
export function filterMenuByGroup(
  products: ProductWithUoms[],
  groupId: string,
  allowNegativeInventory: boolean,
): ProductWithUoms[] {
  if (groupId === MENU_GROUP_OUT_OF_STOCK) {
    return products.filter((p) => isMenuOutOfStock(p, allowNegativeInventory));
  }
  if (groupId === MENU_GROUP_ALL) return products;

  // Matched on the RESOLVED section, so the tiles behind a chip are exactly
  // the ones it counted. An unknown group id still falls through to the whole
  // menu below rather than to an empty grid.
  const known = MENU_CATEGORIES.some((c) => c.id === groupId);
  if (known) return products.filter((p) => resolveCategory(p.category).id === groupId);

  return products;
}
