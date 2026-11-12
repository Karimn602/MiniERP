import { useSession } from "../state/session";

/**
 * EXPLICIT COLUMN LISTS, AND WHICH OF THEM A ROLE MAY ASK FOR (Stage C).
 *
 * A cashier's `db_select` is compiled on a read connection whose SQLite
 * authorizer REFUSES every cost, COGS and variance column (see
 * `src-tauri/src/read_guard.rs`). That refusal is the boundary; this module is
 * not. What this module does is keep the cashier's own screens from ASKING for
 * a refused column — a `SELECT *` over `products` would be refused whole, and
 * a refused catalogue read is a till that cannot scan a barcode.
 *
 * So each confidential table's reads are spelled as two lists: the columns any
 * signed-in role may read, and the confidential ones, which are appended only
 * when the session's role can see them. If this module were wrong in the
 * permissive direction, the backend would refuse the read; it can never make a
 * figure visible that the backend would not serve.
 *
 * Unknown role (no session yet) appends the confidential columns: a renderer
 * with no session gets no read channel at all, and the node test harness,
 * which has no session, reads the database directly.
 */
export function costsVisible(): boolean {
  const role = useSession.getState().status?.session?.role;
  return role !== "cashier";
}

/** `alias.col, alias.col, ...` — public columns, plus confidential ones if visible. */
export function projection(
  alias: string | null,
  publicColumns: readonly string[],
  confidentialColumns: readonly string[],
): string {
  const cols = costsVisible()
    ? [...publicColumns, ...confidentialColumns]
    : [...publicColumns];
  return cols.map((c) => (alias ? `${alias}.${c}` : c)).join(", ");
}

// ---------- products ----------

export const PRODUCT_PUBLIC_COLUMNS = [
  "id",
  "store_id",
  "sku",
  "name",
  "description",
  "vat_rate_id",
  "vat_pricing_mode",
  "price_excl_vat_cents",
  "price_incl_vat_cents",
  "quantity_on_hand",
  "reorder_point",
  "is_active",
  "is_service",
  "category",
  "icon",
  "created_at",
  "updated_at",
] as const;

export const PRODUCT_CONFIDENTIAL_COLUMNS = [
  "avg_cost_excl_vat_cents",
  "avg_cost_incl_vat_cents",
  "avg_cost_excl_vat_microcents",
  "avg_cost_incl_vat_microcents",
  "costing_method",
  "standard_cost_excl_vat_microcents",
  "standard_cost_set_at",
] as const;

// ---------- sales ----------

export const SALE_PUBLIC_COLUMNS = [
  "id",
  "store_id",
  "shift_id",
  "device_id",
  "cashier_user_id",
  "receipt_number",
  "exchange_rate_lbp_per_usd",
  "exchange_rate_id",
  "subtotal_excl_vat_cents",
  "vat_total_cents",
  "total_incl_vat_cents",
  "discount_cents",
  "sale_type",
  "original_sale_id",
  "status",
  "created_at",
  "posted_at",
  "voided_at",
  "voided_by_user_id",
  "void_reason",
  "notes",
  "channel",
  "driver_id",
  "delivery_fee_cents",
] as const;

export const SALE_CONFIDENTIAL_COLUMNS = ["cogs_total_cents", "cogs_method"] as const;

export const SALE_ITEM_PUBLIC_COLUMNS = [
  "id",
  "sale_id",
  "store_id",
  "product_id",
  "product_name_snapshot",
  "product_sku_snapshot",
  "vat_rate_id_snapshot",
  "vat_rate_bps_snapshot",
  "quantity",
  "unit_price_excl_vat_cents",
  "unit_price_incl_vat_cents",
  "line_subtotal_excl_vat_cents",
  "line_vat_cents",
  "line_total_incl_vat_cents",
  "line_discount_cents",
  "barcode_used_snapshot",
  "barcode_type_snapshot",
  "quantity_in_uom",
  "uom_code_snapshot",
  "factor_num_snapshot",
  "factor_den_snapshot",
  "kitchen_note",
  "recipe_id",
  "recipe_version",
] as const;

export const SALE_ITEM_CONFIDENTIAL_COLUMNS = [
  "unit_cogs_excl_vat_cents",
  "unit_cogs_excl_vat_microcents",
  "line_cogs_excl_vat_cents",
  "cogs_source",
] as const;

// ---------- shifts ----------

export const SHIFT_PUBLIC_COLUMNS = [
  "id",
  "store_id",
  "device_id",
  "opened_by_user_id",
  "closed_by_user_id",
  "opened_at",
  "closed_at",
  "opening_cash_usd_cents",
  "opening_cash_lbp",
  "status",
  "notes",
] as const;

/**
 * A closed shift's stored reconciliation: what was counted, what was expected,
 * and the difference. Supervisory, like the history panel. The COUNT is here
 * too, because with it a variance is one subtraction from readable tender rows.
 */
export const SHIFT_CONFIDENTIAL_COLUMNS = [
  "closing_cash_usd_cents",
  "closing_cash_lbp",
  "expected_cash_usd_cents",
  "expected_cash_lbp",
  "variance_usd_cents",
  "variance_lbp",
] as const;
