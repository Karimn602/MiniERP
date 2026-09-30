import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import type {
  CreditMemo,
  CreditMemoLine,
  CreditMemoRefund,
  CreditMemoStatus,
  CreditMemoWithDetails,
  PaymentCurrency,
  PaymentMethod,
  ReturnableLine,
  SaleItem,
  SaleReturnStatus,
} from "../types";

// ---------- Row shapes ----------

interface CreditMemoRow {
  id: string;
  store_id: string;
  original_sale_id: string;
  credit_memo_number: number;
  shift_id: string | null;
  device_id: string | null;
  cashier_user_id: string | null;
  exchange_rate_lbp_per_usd: number;
  exchange_rate_id: string | null;
  reason: string | null;
  subtotal_excl_vat_cents: number;
  vat_total_cents: number;
  discount_cents: number;
  total_incl_vat_cents: number;
  cogs_reversed_cents: number;
  refund_total_usd_cents: number;
  status: CreditMemoStatus;
  created_at: string;
  posted_at: string | null;
  notes: string | null;
}

interface CreditMemoLineRow {
  id: string;
  credit_memo_id: string;
  store_id: string;
  original_sale_item_id: string;
  product_id: string;
  product_name_snapshot: string;
  product_sku_snapshot: string | null;
  vat_rate_id_snapshot: string;
  vat_rate_bps_snapshot: number;
  quantity_base: number;
  quantity_in_uom: number | null;
  uom_code_snapshot: string | null;
  factor_num_snapshot: number | null;
  factor_den_snapshot: number | null;
  unit_price_excl_vat_cents: number;
  unit_price_incl_vat_cents: number;
  line_subtotal_excl_vat_cents: number;
  line_vat_cents: number;
  line_total_incl_vat_cents: number;
  line_discount_cents: number;
  unit_cogs_excl_vat_cents: number;
  line_cogs_excl_vat_cents: number;
  is_service: number;
  return_to_stock: number;
  related_movement_id: string | null;
}

interface CreditMemoRefundRow {
  id: string;
  credit_memo_id: string;
  store_id: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  amount_native_usd_cents: number;
  amount_native_lbp: number;
  amount_usd_cents_equivalent: number;
  reference: string | null;
  created_at: string;
}

// ---------- Mappers ----------

function toCreditMemo(r: CreditMemoRow): CreditMemo {
  return {
    id: r.id,
    storeId: r.store_id,
    originalSaleId: r.original_sale_id,
    creditMemoNumber: r.credit_memo_number,
    shiftId: r.shift_id,
    deviceId: r.device_id,
    cashierUserId: r.cashier_user_id,
    exchangeRateLbpPerUsd: r.exchange_rate_lbp_per_usd,
    exchangeRateId: r.exchange_rate_id,
    reason: r.reason,
    subtotalExclVatCents: r.subtotal_excl_vat_cents,
    vatTotalCents: r.vat_total_cents,
    discountCents: r.discount_cents,
    totalInclVatCents: r.total_incl_vat_cents,
    cogsReversedCents: r.cogs_reversed_cents,
    refundTotalUsdCents: r.refund_total_usd_cents,
    status: r.status,
    createdAt: r.created_at,
    postedAt: r.posted_at,
    notes: r.notes,
  };
}

function toCreditMemoLine(r: CreditMemoLineRow): CreditMemoLine {
  return {
    id: r.id,
    creditMemoId: r.credit_memo_id,
    storeId: r.store_id,
    originalSaleItemId: r.original_sale_item_id,
    productId: r.product_id,
    productNameSnapshot: r.product_name_snapshot,
    productSkuSnapshot: r.product_sku_snapshot,
    vatRateIdSnapshot: r.vat_rate_id_snapshot,
    vatRateBpsSnapshot: r.vat_rate_bps_snapshot,
    quantityBase: r.quantity_base,
    quantityInUom: r.quantity_in_uom,
    uomCodeSnapshot: r.uom_code_snapshot,
    factorNumSnapshot: r.factor_num_snapshot,
    factorDenSnapshot: r.factor_den_snapshot,
    unitPriceExclVatCents: r.unit_price_excl_vat_cents,
    unitPriceInclVatCents: r.unit_price_incl_vat_cents,
    lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
    lineVatCents: r.line_vat_cents,
    lineTotalInclVatCents: r.line_total_incl_vat_cents,
    lineDiscountCents: r.line_discount_cents,
    unitCogsExclVatCents: r.unit_cogs_excl_vat_cents,
    lineCogsExclVatCents: r.line_cogs_excl_vat_cents,
    isService: r.is_service === 1,
    returnToStock: r.return_to_stock === 1,
    relatedMovementId: r.related_movement_id,
  };
}

function toCreditMemoRefund(r: CreditMemoRefundRow): CreditMemoRefund {
  return {
    id: r.id,
    creditMemoId: r.credit_memo_id,
    storeId: r.store_id,
    method: r.method,
    currency: r.currency,
    amountNativeUsdCents: r.amount_native_usd_cents,
    amountNativeLbp: r.amount_native_lbp,
    amountUsdCentsEquivalent: r.amount_usd_cents_equivalent,
    reference: r.reference,
    createdAt: r.created_at,
  };
}

// ---------- Post payload shapes (match Rust camelCase) ----------

export interface PostCreditMemoLineInput {
  creditMemoLineId: string;
  originalSaleItemId: string;
  quantityBase: number;
  quantityInUom: number | null;
  returnToStock: boolean;
}

export interface PostCreditMemoRefundInput {
  refundId: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: number;
  amountNativeLbp: number;
  amountUsdCentsEquivalent: number;
  reference: string | null;
}

export interface PostCreditMemoInput {
  creditMemoId: string;
  storeId: string;
  originalSaleId: string;
  cashierUserId: string | null;
  deviceId: string | null;
  shiftId: string | null;
  exchangeRateId: string;
  exchangeRateLbpPerUsd: number;
  reason: string | null;
  lines: PostCreditMemoLineInput[];
  refunds: PostCreditMemoRefundInput[];
}

export interface PostCreditMemoResult {
  creditMemoId: string;
  creditMemoNumber: number;
  postedAt: string;
  totalInclVatCents: number;
  refundTotalUsdCents: number;
  movementIds: string[];
}

// ---------- Repo ----------

export const creditMemosRepo = {
  async post(
    input: Omit<PostCreditMemoInput, "creditMemoId" | "lines" | "refunds"> & {
      lines: Omit<PostCreditMemoLineInput, "creditMemoLineId">[];
      refunds: Omit<PostCreditMemoRefundInput, "refundId">[];
    },
  ): Promise<PostCreditMemoResult> {
    const payload: PostCreditMemoInput = {
      ...input,
      creditMemoId: newId(),
      lines: input.lines.map((l) => ({ ...l, creditMemoLineId: newId() })),
      refunds: input.refunds.map((r) => ({ ...r, refundId: newId() })),
    };
    return invoke<PostCreditMemoResult>("post_credit_memo", { payload });
  },

  // Returnable quantity per original sale line: sold − already-returned. Also
  // flags service lines (no 'sale' movement was created → no restock).
  async getReturnableForSale(saleId: string): Promise<ReturnableLine[]> {
    interface Row {
      id: string;
      sale_id: string;
      store_id: string;
      product_id: string;
      product_name_snapshot: string;
      product_sku_snapshot: string | null;
      vat_rate_id_snapshot: string;
      vat_rate_bps_snapshot: number;
      quantity: number;
      unit_price_excl_vat_cents: number;
      unit_price_incl_vat_cents: number;
      line_subtotal_excl_vat_cents: number;
      line_vat_cents: number;
      line_total_incl_vat_cents: number;
      line_discount_cents: number;
      unit_cogs_excl_vat_cents: number;
      line_cogs_excl_vat_cents: number;
      barcode_used_snapshot: string | null;
      barcode_type_snapshot: string | null;
      quantity_in_uom: number | null;
      uom_code_snapshot: string | null;
      factor_num_snapshot: number | null;
      factor_den_snapshot: number | null;
      returned_qty_base: number;
      sale_movement_count: number;
    }

    const rows = await query<Row>(
      `SELECT
         si.*,
         COALESCE((
           SELECT SUM(l.quantity_base)
           FROM sales_credit_memo_lines l
           JOIN sales_credit_memos m ON m.id = l.credit_memo_id
           WHERE l.original_sale_item_id = si.id AND m.status = 'posted'
         ), 0) AS returned_qty_base,
         (
           SELECT COUNT(*)
           FROM inventory_movements im
           WHERE im.related_sale_item_id = si.id AND im.movement_type = 'sale'
         ) AS sale_movement_count
       FROM sale_items si
       WHERE si.sale_id = ?
       ORDER BY si.created_at ASC`,
      [saleId],
    );

    return rows.map((r) => {
      const saleItem: SaleItem = {
        id: r.id,
        saleId: r.sale_id,
        storeId: r.store_id,
        productId: r.product_id,
        productNameSnapshot: r.product_name_snapshot,
        productSkuSnapshot: r.product_sku_snapshot,
        vatRateIdSnapshot: r.vat_rate_id_snapshot,
        vatRateBpsSnapshot: r.vat_rate_bps_snapshot,
        quantity: r.quantity,
        unitPriceExclVatCents: r.unit_price_excl_vat_cents,
        unitPriceInclVatCents: r.unit_price_incl_vat_cents,
        lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
        lineVatCents: r.line_vat_cents,
        lineTotalInclVatCents: r.line_total_incl_vat_cents,
        lineDiscountCents: r.line_discount_cents,
        unitCogsExclVatCents: r.unit_cogs_excl_vat_cents,
        lineCogsExclVatCents: r.line_cogs_excl_vat_cents,
        barcodeUsedSnapshot: r.barcode_used_snapshot,
        barcodeTypeSnapshot: r.barcode_type_snapshot,
        quantityInUom: r.quantity_in_uom,
        uomCodeSnapshot: r.uom_code_snapshot,
        factorNumSnapshot: r.factor_num_snapshot,
        factorDenSnapshot: r.factor_den_snapshot,
      };
      const returnedQtyBase = r.returned_qty_base;
      return {
        saleItem,
        soldQtyBase: r.quantity,
        returnedQtyBase,
        returnableQtyBase: Math.max(0, r.quantity - returnedQtyBase),
        isService: r.sale_movement_count === 0,
      };
    });
  },

  // Aggregate return status for a set of sales, for list badges.
  async getReturnStatusForSales(
    saleIds: string[],
  ): Promise<Record<string, SaleReturnStatus>> {
    const result: Record<string, SaleReturnStatus> = {};
    if (saleIds.length === 0) return result;

    interface Row {
      sale_id: string;
      sold_qty: number;
      returned_qty: number;
    }
    const placeholders = saleIds.map(() => "?").join(",");
    const rows = await query<Row>(
      `SELECT
         si.sale_id AS sale_id,
         SUM(si.quantity) AS sold_qty,
         COALESCE(SUM((
           SELECT COALESCE(SUM(l.quantity_base), 0)
           FROM sales_credit_memo_lines l
           JOIN sales_credit_memos m ON m.id = l.credit_memo_id
           WHERE l.original_sale_item_id = si.id AND m.status = 'posted'
         )), 0) AS returned_qty
       FROM sale_items si
       WHERE si.sale_id IN (${placeholders})
       GROUP BY si.sale_id`,
      saleIds,
    );

    for (const id of saleIds) result[id] = "none";
    for (const r of rows) {
      if (r.returned_qty <= 0) result[r.sale_id] = "none";
      else if (r.returned_qty >= r.sold_qty) result[r.sale_id] = "full";
      else result[r.sale_id] = "partial";
    }
    return result;
  },

  async listByStore(storeId: string, limit = 200): Promise<CreditMemo[]> {
    const rows = await query<CreditMemoRow>(
      `SELECT * FROM sales_credit_memos
       WHERE store_id = ?
       ORDER BY COALESCE(posted_at, created_at) DESC
       LIMIT ?`,
      [storeId, limit],
    );
    return rows.map(toCreditMemo);
  },

  async listByStoreWithSale(
    storeId: string,
    limit = 200,
  ): Promise<{ memo: CreditMemo; originalReceiptNumber: number | null }[]> {
    const rows = await query<CreditMemoRow & { original_receipt_number: number | null }>(
      `SELECT cm.*, s.receipt_number AS original_receipt_number
       FROM sales_credit_memos cm
       LEFT JOIN sales s ON s.id = cm.original_sale_id
       WHERE cm.store_id = ?
       ORDER BY COALESCE(cm.posted_at, cm.created_at) DESC
       LIMIT ?`,
      [storeId, limit],
    );
    return rows.map((r) => ({
      memo: toCreditMemo(r),
      originalReceiptNumber: r.original_receipt_number,
    }));
  },

  async findById(id: string): Promise<CreditMemo | null> {
    const rows = await query<CreditMemoRow>(
      `SELECT * FROM sales_credit_memos WHERE id = ?`,
      [id],
    );
    return rows[0] ? toCreditMemo(rows[0]) : null;
  },

  async findByIdWithDetails(id: string): Promise<CreditMemoWithDetails | null> {
    const memo = await this.findById(id);
    if (!memo) return null;

    const [lineRows, refundRows] = await Promise.all([
      query<CreditMemoLineRow>(
        `SELECT * FROM sales_credit_memo_lines WHERE credit_memo_id = ? ORDER BY created_at ASC`,
        [id],
      ),
      query<CreditMemoRefundRow>(
        `SELECT * FROM sales_credit_memo_refunds WHERE credit_memo_id = ? ORDER BY created_at ASC`,
        [id],
      ),
    ]);

    return {
      ...memo,
      lines: lineRows.map(toCreditMemoLine),
      refunds: refundRows.map(toCreditMemoRefund),
    };
  },

  async listForSale(saleId: string): Promise<CreditMemo[]> {
    const rows = await query<CreditMemoRow>(
      `SELECT * FROM sales_credit_memos
       WHERE original_sale_id = ?
       ORDER BY COALESCE(posted_at, created_at) DESC`,
      [saleId],
    );
    return rows.map(toCreditMemo);
  },
};
