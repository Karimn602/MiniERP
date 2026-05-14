import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import type { InventoryMovement, MovementType } from "../types";

interface MovementRow {
  id: string;
  store_id: string;
  product_id: string;
  movement_type: MovementType;
  quantity_delta: number;
  unit_cost_excl_vat_cents: number;
  unit_cost_incl_vat_cents: number;
  related_sale_id: string | null;
  related_sale_item_id: string | null;
  related_purchase_id: string | null;
  related_purchase_item_id: string | null;
  supplier_reference: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  device_id: string | null;
  posted_at: string;
  quantity_in_uom: number | null;
  uom_code_snapshot: string | null;
  factor_num_snapshot: number | null;
  factor_den_snapshot: number | null;
}

function toDomain(r: MovementRow): InventoryMovement {
  return {
    id: r.id,
    storeId: r.store_id,
    productId: r.product_id,
    movementType: r.movement_type,
    quantityDelta: r.quantity_delta,
    unitCostExclVatCents: r.unit_cost_excl_vat_cents,
    unitCostInclVatCents: r.unit_cost_incl_vat_cents,
    relatedSaleId: r.related_sale_id,
    relatedSaleItemId: r.related_sale_item_id,
    relatedPurchaseId: r.related_purchase_id,
    relatedPurchaseItemId: r.related_purchase_item_id,
    supplierReference: r.supplier_reference,
    notes: r.notes,
    createdByUserId: r.created_by_user_id,
    deviceId: r.device_id,
    postedAt: r.posted_at,
    quantityInUom: r.quantity_in_uom,
    uomCodeSnapshot: r.uom_code_snapshot,
    factorNumSnapshot: r.factor_num_snapshot,
    factorDenSnapshot: r.factor_den_snapshot,
  };
}

// ---------- Adjustment payload (matches Rust) ----------

export interface PostAdjustmentLineInput {
  movementId: string;
  productId: string;
  uomCodeSnapshot: string;
  factorNumSnapshot: number;
  factorDenSnapshot: number;
  quantityInUomSigned: number;
  quantityBaseSigned: number;
}

export interface PostAdjustmentInput {
  storeId: string;
  createdByUserId: string | null;
  deviceId: string | null;
  reason: string;
  lines: PostAdjustmentLineInput[];
}

export interface PostAdjustmentResult {
  movementIds: string[];
}

export const movementsRepo = {
  async listForProduct(productId: string, limit = 100): Promise<InventoryMovement[]> {
    const rows = await query<MovementRow>(
      `SELECT * FROM inventory_movements
       WHERE product_id = ?
       ORDER BY posted_at DESC
       LIMIT ?`,
      [productId, limit],
    );
    return rows.map(toDomain);
  },

  async listRecent(args: {
    storeId: string;
    movementType?: MovementType;
    limit?: number;
  }): Promise<InventoryMovement[]> {
    const limit = args.limit ?? 100;
    if (args.movementType) {
      const rows = await query<MovementRow>(
        `SELECT * FROM inventory_movements
         WHERE store_id = ? AND movement_type = ?
         ORDER BY posted_at DESC
         LIMIT ?`,
        [args.storeId, args.movementType, limit],
      );
      return rows.map(toDomain);
    }
    const rows = await query<MovementRow>(
      `SELECT * FROM inventory_movements
       WHERE store_id = ?
       ORDER BY posted_at DESC
       LIMIT ?`,
      [args.storeId, limit],
    );
    return rows.map(toDomain);
  },

  async postAdjustment(
    input: Omit<PostAdjustmentInput, "lines"> & {
      lines: Omit<PostAdjustmentLineInput, "movementId">[];
    },
  ): Promise<PostAdjustmentResult> {
    const payload: PostAdjustmentInput = {
      ...input,
      lines: input.lines.map((l) => ({ ...l, movementId: newId() })),
    };
    return invoke<PostAdjustmentResult>("post_adjustment", { payload });
  },
};
