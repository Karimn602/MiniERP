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
  RefundAvailability,
  RefundMethod,
  ReturnableLine,
  SaleReturnStatus,
} from "../types";

/**
 * Sales returns / credit memos — READ-ONLY queries plus the one posting call.
 *
 * Everything in this file either reads what `post_credit_memo` wrote or asks
 * it to write. Nothing here computes a refund amount: the per-line proration,
 * the VAT and discount reversal, the COGS basis, the tender caps and the
 * drawer check all live in `posting.rs`, inside one transaction, because they
 * all depend on history that can change between a screen rendering and a
 * cashier pressing Refund.
 *
 * The figures the Create Return screen shows — remaining quantity, remaining
 * refundable per method — are computed by the SAME SQL the backend uses, so
 * the preview cannot disagree with the rule. They are still only a preview:
 * the backend re-derives them inside the posting transaction and refuses
 * anything that no longer holds.
 */

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
  quantity_in_uom: number;
  uom_code_snapshot: string | null;
  factor_num_snapshot: number | null;
  factor_den_snapshot: number | null;
  unit_price_excl_vat_cents: number;
  unit_price_incl_vat_cents: number;
  line_subtotal_excl_vat_cents: number;
  line_vat_cents: number;
  line_total_incl_vat_cents: number;
  line_discount_cents: number;
  unit_cogs_excl_vat_microcents: number;
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
  method: RefundMethod;
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
    unitCogsExclVatMicrocents: r.unit_cogs_excl_vat_microcents,
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

// ---------- Post payload shapes ----------

export interface PostCreditMemoLineInput {
  creditMemoLineId: string;
  originalSaleItemId: string;
  /** The returned quantity in the ORIGINAL line's own unit of measure. */
  quantityInUom: number;
  /** A cross-check only; the backend derives this from the original factor. */
  quantityBase: number;
  returnToStock: boolean;
}

export interface PostCreditMemoRefundInput {
  refundId: string;
  method: RefundMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: number;
  amountNativeLbp: number;
  /** A cross-check only; the backend derives this at the sale's locked rate. */
  amountUsdCentsEquivalent: number;
  reference: string | null;
}

export interface PostCreditMemoInput {
  creditMemoId: string;
  storeId: string;
  originalSaleId: string;
  /**
   * REQUIRED. `post_credit_memo` refuses a new return that does not name an
   * open shift of its store — a refund moves the drawer, so it belongs to a
   * shift. `sales_credit_memos.shift_id` itself stays nullable so a replay can
   * still resolve after its shift has closed.
   */
  shiftId: string;
  cashierUserId: string | null;
  deviceId: string | null;
  reason: string | null;
  notes: string | null;
  lines: PostCreditMemoLineInput[];
  refunds: PostCreditMemoRefundInput[];
}

export interface PostCreditMemoResult {
  creditMemoId: string;
  creditMemoNumber: number;
  postedAt: string;
  movementIds: string[];
  subtotalExclVatCents: number;
  vatTotalCents: number;
  discountCents: number;
  totalInclVatCents: number;
  cogsReversedCents: number;
  refundTotalUsdCents: number;
}

// ---------- Repo ----------

export const creditMemosRepo = {
  /** Posted credit memos, newest first, with the receipt each one reverses. */
  async list(args: { storeId: string; limit?: number }): Promise<
    (CreditMemo & { originalReceiptNumber: number | null })[]
  > {
    const rows = await query<CreditMemoRow & { original_receipt_number: number | null }>(
      `SELECT m.*, s.receipt_number AS original_receipt_number
         FROM sales_credit_memos m
         LEFT JOIN sales s ON s.id = m.original_sale_id
        WHERE m.store_id = ?
        ORDER BY COALESCE(m.posted_at, m.created_at) DESC
        LIMIT ?`,
      [args.storeId, args.limit ?? 200],
    );
    return rows.map((r) => ({
      ...toCreditMemo(r),
      originalReceiptNumber: r.original_receipt_number,
    }));
  },

  async findByIdWithDetails(id: string): Promise<CreditMemoWithDetails | null> {
    const headers = await query<CreditMemoRow & { original_receipt_number: number | null }>(
      `SELECT m.*, s.receipt_number AS original_receipt_number
         FROM sales_credit_memos m
         LEFT JOIN sales s ON s.id = m.original_sale_id
        WHERE m.id = ?`,
      [id],
    );
    const header = headers[0];
    if (!header) return null;

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
      ...toCreditMemo(header),
      originalReceiptNumber: header.original_receipt_number,
      lines: lineRows.map(toCreditMemoLine),
      refunds: refundRows.map(toCreditMemoRefund),
    };
  },

  /** Every posted memo of one sale, for the receipt's own history. */
  async listForSale(saleId: string): Promise<CreditMemo[]> {
    const rows = await query<CreditMemoRow>(
      `SELECT * FROM sales_credit_memos
        WHERE original_sale_id = ? AND status = 'posted'
        ORDER BY credit_memo_number ASC`,
      [saleId],
    );
    return rows.map(toCreditMemo);
  },

  /**
   * How much of each sale has come back, DERIVED by comparing sold quantity
   * against the quantity posted credit memos have returned.
   *
   * The sale is never marked. `sales.sale_type` and `sales.original_sale_id`
   * stay exactly as migration 001 left them (see migration 011's preamble), so
   * this query is the only thing that knows a receipt has been returned.
   */
  async returnStatusForStore(
    storeId: string,
    limit = 500,
  ): Promise<Map<string, SaleReturnStatus>> {
    const rows = await query<{ sale_id: string; sold: number; returned: number }>(
      `SELECT si.sale_id                                AS sale_id,
              SUM(si.quantity)                          AS sold,
              COALESCE(SUM(ret.returned), 0)            AS returned
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN (
               SELECT l.original_sale_item_id AS sale_item_id,
                      SUM(l.quantity_base)    AS returned
                 FROM sales_credit_memo_lines l
                 JOIN sales_credit_memos m ON m.id = l.credit_memo_id
                WHERE m.status = 'posted'
                GROUP BY l.original_sale_item_id
         ) ret ON ret.sale_item_id = si.id
        WHERE s.store_id = ? AND s.status = 'posted'
        GROUP BY si.sale_id
        LIMIT ?`,
      [storeId, limit],
    );

    const out = new Map<string, SaleReturnStatus>();
    for (const r of rows) {
      out.set(
        r.sale_id,
        r.returned <= 0 ? "none" : r.returned >= r.sold ? "full" : "partial",
      );
    }
    return out;
  },

  /**
   * The lines of one sale with what is still returnable on each.
   *
   * `remaining_base` is the figure `post_credit_memo` bounds a return by, and
   * this is the same subtraction — sold minus the sum over POSTED memo lines.
   * `is_service` is read the way the backend reads it: from whether the sale
   * line produced a stock movement, not from `products.is_service` as it
   * stands today, because whether these goods ever left the shelf is a fact
   * about that sale.
   */
  async returnableLines(args: {
    storeId: string;
    saleId: string;
  }): Promise<ReturnableLine[]> {
    const rows = await query<{
      sale_item_id: string;
      product_id: string;
      product_name_snapshot: string;
      product_sku_snapshot: string | null;
      uom_code_snapshot: string | null;
      factor_num_snapshot: number;
      factor_den_snapshot: number;
      sold_base: number;
      sold_in_uom: number;
      returned_base: number;
      returned_in_uom: number;
      unit_price_incl_vat_cents: number;
      line_subtotal_excl_vat_cents: number;
      line_vat_cents: number;
      line_total_incl_vat_cents: number;
      line_discount_cents: number;
      vat_rate_bps_snapshot: number;
      moved_stock: number;
    }>(
      `SELECT si.id                                   AS sale_item_id,
              si.product_id,
              si.product_name_snapshot,
              si.product_sku_snapshot,
              si.uom_code_snapshot,
              COALESCE(si.factor_num_snapshot, 1)     AS factor_num_snapshot,
              COALESCE(si.factor_den_snapshot, 1)     AS factor_den_snapshot,
              si.quantity                             AS sold_base,
              COALESCE(si.quantity_in_uom, si.quantity) AS sold_in_uom,
              COALESCE((
                SELECT SUM(l.quantity_base) FROM sales_credit_memo_lines l
                  JOIN sales_credit_memos m ON m.id = l.credit_memo_id
                 WHERE l.original_sale_item_id = si.id AND m.status = 'posted'
              ), 0)                                   AS returned_base,
              COALESCE((
                SELECT SUM(l.quantity_in_uom) FROM sales_credit_memo_lines l
                  JOIN sales_credit_memos m ON m.id = l.credit_memo_id
                 WHERE l.original_sale_item_id = si.id AND m.status = 'posted'
              ), 0)                                   AS returned_in_uom,
              si.unit_price_incl_vat_cents,
              si.line_subtotal_excl_vat_cents,
              si.line_vat_cents,
              si.line_total_incl_vat_cents,
              si.line_discount_cents,
              si.vat_rate_bps_snapshot,
              CASE WHEN EXISTS (
                SELECT 1 FROM inventory_movements im
                 WHERE im.related_sale_item_id = si.id AND im.movement_type = 'sale'
              ) THEN 1 ELSE 0 END                     AS moved_stock
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
        WHERE si.sale_id = ? AND s.store_id = ?
        ORDER BY si.created_at ASC`,
      [args.saleId, args.storeId],
    );

    return rows.map((r) => ({
      saleItemId: r.sale_item_id,
      productId: r.product_id,
      productNameSnapshot: r.product_name_snapshot,
      productSkuSnapshot: r.product_sku_snapshot,
      uomCodeSnapshot: r.uom_code_snapshot,
      factorNumSnapshot: r.factor_num_snapshot,
      factorDenSnapshot: r.factor_den_snapshot,
      soldQuantityBase: r.sold_base,
      soldQuantityInUom: r.sold_in_uom,
      returnedQuantityBase: r.returned_base,
      returnedQuantityInUom: r.returned_in_uom,
      remainingQuantityBase: r.sold_base - r.returned_base,
      remainingQuantityInUom: r.sold_in_uom - r.returned_in_uom,
      unitPriceInclVatCents: r.unit_price_incl_vat_cents,
      lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
      lineVatCents: r.line_vat_cents,
      lineTotalInclVatCents: r.line_total_incl_vat_cents,
      lineDiscountCents: r.line_discount_cents,
      vatRateBpsSnapshot: r.vat_rate_bps_snapshot,
      isService: r.moved_stock === 0,
    }));
  },

  /**
   * What a sale may still be refunded through, per (method, currency).
   *
   * The SAME subtraction `post_credit_memo` performs: the net native amount
   * each method collected — net of any change it handed back — less what
   * posted memos have already returned through it. `store_credit` is filtered
   * out because a refund can never use it.
   */
  async refundAvailability(args: {
    storeId: string;
    saleId: string;
  }): Promise<RefundAvailability[]> {
    const rows = await query<{
      method: RefundMethod;
      currency: PaymentCurrency;
      available_native: number;
      refunded_native: number;
    }>(
      `SELECT sp.method,
              sp.currency,
              COALESCE(SUM(CASE WHEN sp.currency = 'USD'
                                THEN sp.amount_native_usd_cents - sp.change_given_usd_cents
                                ELSE sp.amount_native_lbp - sp.change_given_lbp END), 0)
                AS available_native,
              COALESCE((
                SELECT SUM(CASE WHEN r.currency = 'USD'
                                THEN r.amount_native_usd_cents
                                ELSE r.amount_native_lbp END)
                  FROM sales_credit_memo_refunds r
                  JOIN sales_credit_memos m ON m.id = r.credit_memo_id
                 WHERE m.original_sale_id = sp.sale_id AND m.status = 'posted'
                   AND r.method = sp.method AND r.currency = sp.currency
              ), 0) AS refunded_native
         FROM sale_payments sp
        WHERE sp.sale_id = ? AND sp.store_id = ? AND sp.method <> 'store_credit'
        GROUP BY sp.method, sp.currency
        ORDER BY sp.method, sp.currency`,
      [args.saleId, args.storeId],
    );

    return rows
      .map((r) => ({
        method: r.method,
        currency: r.currency,
        availableNative: r.available_native,
        refundedNative: r.refunded_native,
        remainingNative: r.available_native - r.refunded_native,
      }))
      .filter((a) => a.availableNative > 0);
  },

  /**
   * Post a return.
   *
   * `creditMemoId` is the RETURN IDENTITY and the caller owns it: issue one
   * per return attempt and pass the same value for every retry of that
   * attempt. `post_credit_memo` is idempotent on it — replaying a posted
   * identity returns that memo instead of refunding the customer twice — so a
   * double-click or a resend after an answer the client never saw is safe. A
   * genuinely separate second return needs a new id.
   *
   * Line and refund identifiers are minted here because a replay never reaches
   * the insert path: the return identity alone decides what is the same return.
   */
  async post(
    input: Omit<PostCreditMemoInput, "lines" | "refunds"> & {
      lines: Omit<PostCreditMemoLineInput, "creditMemoLineId">[];
      refunds: Omit<PostCreditMemoRefundInput, "refundId">[];
    },
  ): Promise<PostCreditMemoResult> {
    const payload: PostCreditMemoInput = {
      ...input,
      lines: input.lines.map((l) => ({ ...l, creditMemoLineId: newId() })),
      refunds: input.refunds.map((r) => ({ ...r, refundId: newId() })),
    };
    return invoke<PostCreditMemoResult>("post_credit_memo", { payload });
  },
};
