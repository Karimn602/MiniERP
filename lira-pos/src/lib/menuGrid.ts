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
  return products
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
 * THIS IS NOT "Burgers / Wraps / Drinks", and it cannot be yet. `products` has
 * no category, group or department column — the only `category` in the whole
 * schema is `units_of_measure.category` (count/weight/volume/length), which
 * classifies units, not food. Real menu sections need one nullable `category`
 * column plus a field on the Products page, which is a migration, and migrations
 * are out of scope for a visual pass. Inventing them in localStorage instead
 * would scatter master data per-device, so that was rejected too.
 *
 * What this returns is therefore an honest grouping over data that DOES exist,
 * and it earns its place on a burger till: "All", plus "Out of stock" when
 * something has actually run out — the question a cashier asks the screen most
 * often after "how much". When nothing is out, there is one group and the caller
 * hides the row rather than showing a lone chip that filters nothing.
 *
 * The shape is the seam: the day a `category` column lands, this function grows
 * one chip per distinct value and the chip row, the filtering and the grid all
 * work unchanged.
 */
export function deriveMenuGroups(
  products: ProductWithUoms[],
  allowNegativeInventory: boolean,
): MenuGroup[] {
  const groups: MenuGroup[] = [
    { id: MENU_GROUP_ALL, labelKey: "pos.groupAll", count: products.length },
  ];

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
  return products;
}
