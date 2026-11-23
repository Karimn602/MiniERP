/**
 * Greaz's official menu — the frontend half.
 *
 * `src/catalog/greaz-menu-v1.json` is the founder's transcription of the
 * printed menu, bundled unchanged. The Rust side compiles the same file in
 * (`official_menu.rs`) and is the only thing that WRITES products from it; this
 * module offers the owner's preview/apply commands and reads the catalog's
 * three sauce/dip CHOICE GROUPS for the Register.
 *
 * ## Choices are kitchen instructions, not a modifier engine
 *
 * Every choice on the printed menu is free ("Dipper Chicken: Buffalo or BBQ",
 * "Greaz Box: 3 dips"), so a choice changes what the kitchen makes and never
 * what the customer pays. That is exactly what a line's kitchen note already
 * is (WP-A2): a per-line snapshot on `sale_items`, printed on the kitchen
 * ticket, compared on replay, sealed when the sale posts, carrying no money.
 * So the Register asks for the choice when the item is added and writes it
 * INTO the note ("Sauce: Buffalo"). Nothing new reaches `post_sale`.
 *
 * Everything that DOES cost money — the four add-ons and the two combo
 * upgrades — is a priced product of its own and is rung up as its own line, so
 * a charge can never be lost inside free text.
 *
 * The choices are keyed by SKU, because that is the identity the catalog
 * gives an item. An owner who changes one of the three SKUs in Products turns
 * that item's prompt off; the item still sells, and the note can still be
 * typed by hand.
 */
import { invoke } from "@tauri-apps/api/core";
import catalog from "../catalog/greaz-menu-v1.json";

/** The catalog version this build carries. Mirrors `official_menu::CATALOG_LABEL`. */
export const OFFICIAL_MENU_LABEL = "greaz_menu_reference_v1";

// ─── Choice groups ───────────────────────────────────────────────────────────

export interface MenuChoiceGroup {
  id: string;
  label: string;
  options: string[];
  /** How many picks the item comes with. */
  selectionCount: number;
  /**
   * Whether the same option may be picked twice. The menu does not say for the
   * Greaz Box ("repeat_allowed": "not specified"), so repeats are ALLOWED —
   * the dips are free, so permitting a repeat can cost nobody anything, while
   * refusing one could stop a legitimate order. Pending the restaurant's
   * confirmation.
   */
  repeatAllowed: boolean;
}

interface RawGroup {
  id: string;
  label: string;
  options: string[];
  selection_count: number;
  repeat_allowed?: string | boolean;
}

const GROUPS: ReadonlyMap<string, MenuChoiceGroup> = new Map(
  (catalog.choice_groups as RawGroup[]).map((g) => [
    g.id,
    {
      id: g.id,
      label: g.label,
      options: g.options,
      selectionCount: g.selection_count,
      repeatAllowed: g.repeat_allowed !== false,
    },
  ]),
);

const GROUPS_BY_SKU: ReadonlyMap<string, MenuChoiceGroup[]> = new Map(
  (catalog.items as { sku: string; choice_group_ids?: string[] }[])
    .filter((i) => (i.choice_group_ids ?? []).length > 0)
    .map((i) => [
      i.sku.toUpperCase(),
      (i.choice_group_ids ?? []).map((id) => GROUPS.get(id)!).filter(Boolean),
    ]),
);

/** The choices an item must be rung up with, by its SKU. Empty for most items. */
export function choiceGroupsForSku(sku: string | null | undefined): MenuChoiceGroup[] {
  if (!sku) return [];
  return GROUPS_BY_SKU.get(sku.trim().toUpperCase()) ?? [];
}

/** Picks per option, e.g. `{ BBQ: 2, Buffalo: 1 }`. */
export type ChoicePicks = Record<string, number>;

export function pickCount(picks: ChoicePicks): number {
  return Object.values(picks).reduce((a, b) => a + b, 0);
}

/** Exactly the stated number of picks, and no repeat where none is allowed. */
export function isChoiceComplete(group: MenuChoiceGroup, picks: ChoicePicks): boolean {
  if (pickCount(picks) !== group.selectionCount) return false;
  if (!group.repeatAllowed && Object.values(picks).some((n) => n > 1)) return false;
  return Object.keys(picks).every((k) => group.options.includes(k));
}

/**
 * The kitchen-note text for one completed choice.
 *
 * "Sauce: Buffalo" for a single pick; "Dips: BBQ ×2, Buffalo" for several, in
 * the menu's own option order so the same picks always produce the same text —
 * which is what lets two identical Greaz Boxes merge onto one line.
 */
export function choiceNoteFor(group: MenuChoiceGroup, picks: ChoicePicks): string {
  const prefix = group.selectionCount > 1 ? "Dips" : "Sauce";
  const parts = group.options
    .filter((o) => (picks[o] ?? 0) > 0)
    .map((o) => ((picks[o] ?? 0) > 1 ? `${o} ×${picks[o]}` : o));
  return `${prefix}: ${parts.join(", ")}`;
}

/** Several groups' notes on one line, in the item's own group order. */
export function combinedChoiceNote(
  groups: MenuChoiceGroup[],
  picks: Record<string, ChoicePicks>,
): string {
  return groups.map((g) => choiceNoteFor(g, picks[g.id] ?? {})).join("; ");
}

// ─── Owner commands ──────────────────────────────────────────────────────────

export interface ExistingMenuProduct {
  productId: string;
  sku: string | null;
  name: string;
  category: string | null;
  priceInclVatCents: number;
  priceExclVatCents: number;
  vatPricingMode: "inclusive" | "exclusive";
  isActive: boolean;
  showOnRegister: boolean;
}

export type MenuItemOutcome = "create" | "sku_exists" | "name_match";

export interface OfficialMenuPreviewItem {
  sku: string;
  name: string;
  category: string;
  priceUsdCents: number;
  description: string | null;
  icon: string;
  kind: "menu" | "add_on" | "upgrade";
  sellable: boolean;
  outcome: MenuItemOutcome;
  existing: ExistingMenuProduct[];
}

export interface OfficialMenuSample extends ExistingMenuProduct {
  looksLikeSample: boolean;
}

export interface OfficialMenuRecord {
  catalogLabel: string;
  appliedAt: string;
  appliedByUserId: string;
  vatRateId: string;
  vatRateBps: number;
  vatPricingMode: "inclusive" | "exclusive";
  created: number;
  skippedExistingSku: number;
  keptExistingByName: number;
  hiddenFromRegister: number;
}

export interface OfficialMenuPreview {
  catalogLabel: string;
  applied: OfficialMenuRecord | null;
  items: OfficialMenuPreviewItem[];
  samples: OfficialMenuSample[];
}

export interface ApplyOfficialMenuArgs {
  storeId: string;
  vatRateId: string;
  vatPricingMode: "inclusive" | "exclusive";
  taxTreatmentConfirmed: boolean;
  /** Each with the exact existing products the owner reviewed; the backend
   *  refuses if that set has changed since the preview. */
  replaceNameMatches: { sku: string; existingProductIds: string[] }[];
  hideProductIds: string[];
}

export interface ApplyOfficialMenuResult {
  createdSkus: string[];
  skippedExistingSkus: string[];
  keptExistingByNameSkus: string[];
  hiddenProductIds: string[];
  record: OfficialMenuRecord;
}

export function previewOfficialMenu(storeId: string): Promise<OfficialMenuPreview> {
  return invoke<OfficialMenuPreview>("official_menu_preview", { storeId });
}

export function applyOfficialMenu(args: ApplyOfficialMenuArgs): Promise<ApplyOfficialMenuResult> {
  return invoke<ApplyOfficialMenuResult>("official_menu_apply", {
    payload: { ...args, catalogLabel: OFFICIAL_MENU_LABEL },
  });
}
