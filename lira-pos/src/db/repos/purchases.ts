import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import { suppliersRepo } from "./suppliers";
import type {
  Purchase,
  PurchaseItem,
  PurchaseStatus,
  PurchaseType,
  PurchaseWithLines,
} from "../types";

// ---------- Row shapes ----------

interface PurchaseRow {
  id: string;
  store_id: string;
  supplier_id: string | null;
  purchase_type: PurchaseType;
  supplier_reference: string | null;
  purchase_number: number;
  purchase_date: string;
  subtotal_excl_vat_cents: number;
  vat_total_cents: number;
  total_incl_vat_cents: number;
  status: PurchaseStatus;
  created_by_user_id: string | null;
  device_id: string | null;
  created_at: string;
  posted_at: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  notes: string | null;
}

interface PurchaseItemRow {
  id: string;
  purchase_id: string;
  store_id: string;
  product_id: string;
  product_name_snapshot: string;
  product_sku_snapshot: string | null;
  product_uom_id_snapshot: string | null;
  uom_code_snapshot: string;
  factor_num_snapshot: number;
  factor_den_snapshot: number;
  quantity_in_uom: number;
  quantity_base: number;
  unit_cost_excl_vat_in_uom_cents: number;
  unit_cost_incl_vat_in_uom_cents: number;
  unit_cost_excl_vat_base_cents: number;
  unit_cost_incl_vat_base_cents: number;
  vat_rate_id_snapshot: string;
  vat_rate_bps_snapshot: number;
  line_subtotal_excl_vat_cents: number;
  line_vat_cents: number;
  line_total_incl_vat_cents: number;
  related_movement_id: string | null;
}

function toPurchase(r: PurchaseRow): Purchase {
  return {
    id: r.id,
    storeId: r.store_id,
    supplierId: r.supplier_id,
    purchaseType: r.purchase_type,
    supplierReference: r.supplier_reference,
    purchaseNumber: r.purchase_number,
    purchaseDate: r.purchase_date,
    subtotalExclVatCents: r.subtotal_excl_vat_cents,
    vatTotalCents: r.vat_total_cents,
    totalInclVatCents: r.total_incl_vat_cents,
    status: r.status,
    createdByUserId: r.created_by_user_id,
    deviceId: r.device_id,
    createdAt: r.created_at,
    postedAt: r.posted_at,
    voidedAt: r.voided_at,
    voidedByUserId: r.voided_by_user_id,
    voidReason: r.void_reason,
    notes: r.notes,
  };
}

function toPurchaseItem(r: PurchaseItemRow): PurchaseItem {
  return {
    id: r.id,
    purchaseId: r.purchase_id,
    storeId: r.store_id,
    productId: r.product_id,
    productNameSnapshot: r.product_name_snapshot,
    productSkuSnapshot: r.product_sku_snapshot,
    productUomIdSnapshot: r.product_uom_id_snapshot,
    uomCodeSnapshot: r.uom_code_snapshot,
    factorNumSnapshot: r.factor_num_snapshot,
    factorDenSnapshot: r.factor_den_snapshot,
    quantityInUom: r.quantity_in_uom,
    quantityBase: r.quantity_base,
    unitCostExclVatInUomCents: r.unit_cost_excl_vat_in_uom_cents,
    unitCostInclVatInUomCents: r.unit_cost_incl_vat_in_uom_cents,
    unitCostExclVatBaseCents: r.unit_cost_excl_vat_base_cents,
    unitCostInclVatBaseCents: r.unit_cost_incl_vat_base_cents,
    vatRateIdSnapshot: r.vat_rate_id_snapshot,
    vatRateBpsSnapshot: r.vat_rate_bps_snapshot,
    lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
    lineVatCents: r.line_vat_cents,
    lineTotalInclVatCents: r.line_total_incl_vat_cents,
    relatedMovementId: r.related_movement_id,
  };
}

// ---------- Post payload shape (must match Rust serde camelCase) ----------

export interface PostPurchaseLineInput {
  purchaseItemId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  productUomIdSnapshot: string | null;
  uomCodeSnapshot: string;
  factorNumSnapshot: number;
  factorDenSnapshot: number;
  quantityInUom: number;
  quantityBase: number;
  unitCostExclVatInUomCents: number;
  unitCostInclVatInUomCents: number;
  unitCostExclVatBaseCents: number;
  unitCostInclVatBaseCents: number;
  vatRateIdSnapshot: string;
  vatRateBpsSnapshot: number;
  lineSubtotalExclVatCents: number;
  lineVatCents: number;
  lineTotalInclVatCents: number;
}

export interface PostPurchaseInput {
  purchaseId: string;
  storeId: string;
  supplierId: string | null;
  purchaseType: PurchaseType;
  supplierReference: string | null;
  purchaseDate: string;
  createdByUserId: string | null;
  deviceId: string | null;
  notes: string | null;
  lines: PostPurchaseLineInput[];
}

export interface PostPurchaseResult {
  purchaseId: string;
  purchaseNumber: number;
  postedAt: string;
  movementIds: string[];
  ledgerEntryId: string | null;
}

// ---------- Repo ----------

export const purchasesRepo = {
  async findById(id: string): Promise<Purchase | null> {
    const rows = await query<PurchaseRow>(
      `SELECT * FROM purchases WHERE id = ?`,
      [id],
    );
    return rows[0] ? toPurchase(rows[0]) : null;
  },

  async findByIdWithLines(id: string): Promise<PurchaseWithLines | null> {
    const purchase = await this.findById(id);
    if (!purchase) return null;
    const lineRows = await query<PurchaseItemRow>(
      `SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY created_at ASC`,
      [id],
    );
    const supplier = purchase.supplierId
      ? await suppliersRepo.findById(purchase.supplierId)
      : null;
    return {
      ...purchase,
      lines: lineRows.map(toPurchaseItem),
      supplier,
    };
  },

  async list(args: {
    storeId: string;
    status?: PurchaseStatus;
    limit?: number;
  }): Promise<Purchase[]> {
    const limit = args.limit ?? 100;
    if (args.status) {
      const rows = await query<PurchaseRow>(
        `SELECT * FROM purchases
         WHERE store_id = ? AND status = ?
         ORDER BY COALESCE(posted_at, created_at) DESC
         LIMIT ?`,
        [args.storeId, args.status, limit],
      );
      return rows.map(toPurchase);
    }
    const rows = await query<PurchaseRow>(
      `SELECT * FROM purchases
       WHERE store_id = ?
       ORDER BY COALESCE(posted_at, created_at) DESC
       LIMIT ?`,
      [args.storeId, limit],
    );
    return rows.map(toPurchase);
  },

  /**
   * The hot path. Hands the entire payload to the Rust transactional command.
   * Throws on validation failure or DB error — the transaction rolls back
   * before the error returns.
   */
  async post(input: Omit<PostPurchaseInput, "purchaseId">): Promise<PostPurchaseResult> {
    const purchaseId = newId();
    const payload: PostPurchaseInput = {
      ...input,
      purchaseId,
      lines: input.lines.map((l) => ({
        ...l,
        purchaseItemId: l.purchaseItemId || newId(),
      })),
    };
    return invoke<PostPurchaseResult>("post_purchase", { payload });
  },
};
