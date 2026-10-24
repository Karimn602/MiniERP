/**
 * Restaurant menu sections — the canonical list, and the one place that
 * normalises them.
 *
 * ## Stable id, localized label
 *
 * `products.category` stores an ID (`"burgers"`), never a label. The label is
 * looked up per language, so switching the register to Arabic re-labels the
 * chips without touching a single product row — and an Arabic-speaking manager
 * categorising a product writes the same id an English-speaking one would.
 * Storing "Burgers" would have made the section name a translation decision
 * frozen into master data.
 *
 * ## Why normalisation lives here and not in a CHECK constraint
 *
 * Migration 013 leaves `category` free-text on purpose: a restaurant's menu
 * sections change far more often than its schema should, and a CHECK listing
 * them would make adding "Breakfast" a migration. The real hazard of a
 * free-text column is the one the brief names — "Drinks", "drinks" and
 * " Drinks " becoming three sections that split the grid — and a CHECK cannot
 * fix that either, because it can only reject, not fold.
 *
 * So the column is narrow and this module is the gate: everything that WRITES
 * a category passes through `normalizeCategoryId`, which trims, lowercases and
 * collapses whitespace, and everything that READS one passes through
 * `resolveCategory`, which maps an unknown or absent value onto the
 * uncategorised bucket rather than inventing a chip for it. A row hand-edited
 * in SQL to `"  DRINKS "` therefore still groups under Drinks.
 */

/** A menu section as the UI needs it. */
export interface MenuCategory {
  /** The value stored in `products.category`. Stable, never translated. */
  id: string;
  /** i18n key for the chip and the editor dropdown. */
  labelKey: string;
  /**
   * Fallback glyph for a product in this section that has no icon of its own.
   *
   * Decorative only, and never the authority for what a product IS. Matching
   * on product NAMES to choose a picture — the obvious shortcut — breaks the
   * moment a shop renames an item or sells in another language, and it quietly
   * mislabels anything whose name happens to contain another item's word.
   */
  fallbackIcon: string;
}

/** The section every product without a usable category falls into. */
export const UNCATEGORIZED_ID = "uncategorized";

/**
 * The sections, in menu order — which is the order a customer reads a menu
 * board, not alphabetical. Mains first, then the things added to them, then
 * drinks.
 */
export const MENU_CATEGORIES: readonly MenuCategory[] = [
  { id: "burgers", labelKey: "menuCategory.burgers", fallbackIcon: "🍔" },
  { id: "wraps", labelKey: "menuCategory.wraps", fallbackIcon: "🌯" },
  { id: "sides", labelKey: "menuCategory.sides", fallbackIcon: "🍟" },
  { id: "addons", labelKey: "menuCategory.addons", fallbackIcon: "➕" },
  { id: "drinks", labelKey: "menuCategory.drinks", fallbackIcon: "🥤" },
  { id: UNCATEGORIZED_ID, labelKey: "menuCategory.uncategorized", fallbackIcon: "🍽️" },
] as const;

const BY_ID = new Map(MENU_CATEGORIES.map((c) => [c.id, c]));

/**
 * The canonical form of a typed or imported category, or `null` for none.
 *
 * `null` rather than `"uncategorized"`: the column's own way of saying
 * "no section" is NULL, and writing a sentinel string would make
 * "deliberately uncategorised" indistinguishable from a section someone
 * happened to name that. Reading is where the two converge.
 */
export function normalizeCategoryId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const id = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!id) return null;
  // An alias table is deliberately absent: the editor offers a fixed list, so
  // the only way to get a non-listed value is a hand edit or an import, and
  // those are better surfaced as "uncategorised" than silently guessed at.
  return id;
}

/** Is this one of the sections the application knows how to show? */
export function isKnownCategory(id: string | null | undefined): boolean {
  const n = normalizeCategoryId(id);
  return n !== null && BY_ID.has(n);
}

/**
 * The section a product belongs to for display.
 *
 * Never returns null and never throws: an absent, blank or unrecognised value
 * resolves to the uncategorised section. A product must always be sellable,
 * and a grid that hid anything it could not classify would hide stock the shop
 * is trying to sell.
 */
export function resolveCategory(raw: string | null | undefined): MenuCategory {
  const n = normalizeCategoryId(raw);
  return (n !== null ? BY_ID.get(n) : undefined) ?? BY_ID.get(UNCATEGORIZED_ID)!;
}

/**
 * The glyph to show for a product: its own, else its section's.
 *
 * A blank or whitespace-only `icon` counts as absent, so a product whose icon
 * field was cleared falls back rather than rendering an empty box.
 */
export function resolveIcon(
  icon: string | null | undefined,
  category: string | null | undefined,
): string {
  const own = icon?.trim();
  return own ? own : resolveCategory(category).fallbackIcon;
}

/** Sort key placing a product's section in menu order. */
export function categoryOrder(raw: string | null | undefined): number {
  const id = resolveCategory(raw).id;
  const i = MENU_CATEGORIES.findIndex((c) => c.id === id);
  return i < 0 ? MENU_CATEGORIES.length : i;
}

/**
 * The most code points a tile glyph may be (WP-A5).
 *
 * An icon is ONE glyph in a 27px corner slot. Four code points is generous for
 * that — a plain emoji is one, a national flag two, a skin-toned or
 * profession emoji up to four — and it is the bound that stops the column
 * being used as a second name field, which is what an unbounded "icon" string
 * becomes the first time somebody imports a spreadsheet.
 */
export const ICON_MAX_CODE_POINTS = 4;

/**
 * Is this a safe value to store as a product's tile glyph?
 *
 * The column is NEVER parsed, matched or used to infer anything (migration
 * 013 says so), so "safe" here is not about semantics. It is about three real
 * hazards of accepting free text from a spreadsheet:
 *
 *   * LENGTH. A 60-character "icon" does not render as a glyph; it renders as
 *     a broken tile. Bounded above.
 *
 *   * CONTROL AND BIDI CHARACTERS. A zero-width joiner inside an emoji is
 *     legitimate and is allowed; a bare directional OVERRIDE (U+202E and
 *     friends) is not, because it reverses the rendering of everything after
 *     it — in a UI that is already bidirectional, one of those in a product
 *     tile silently garbles the names beside it.
 *
 *   * MARKUP AND FORMULA LEAD-INS. `<`, `>`, `&` and a leading `=`, `+` or
 *     `@` are refused. React escapes markup, so this is not an XSS fix and is
 *     not claimed as one — it is that a cell starting with `=` is a FORMULA to
 *     every spreadsheet that reads the catalogue back out, and a glyph field
 *     is never legitimately any of these characters.
 *
 * Returns true for a blank value: no icon is always valid, and the category's
 * own glyph is used instead.
 */
export function isSafeIcon(raw: string | null | undefined): boolean {
  const icon = raw?.trim() ?? "";
  if (icon === "") return true;
  if ([...icon].length > ICON_MAX_CODE_POINTS) return false;
  for (const ch of icon) {
    const cp = ch.codePointAt(0)!;
    // C0 and C1 controls, and DEL.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
    // Bidi overrides and isolates. U+200D (ZWJ) is deliberately NOT here: it
    // is how a composite emoji is built.
    if (cp >= 0x202a && cp <= 0x202e) return false;
    if (cp >= 0x2066 && cp <= 0x2069) return false;
    if ("<>&".includes(ch)) return false;
  }
  return !"=+@".includes(icon[0]);
}
