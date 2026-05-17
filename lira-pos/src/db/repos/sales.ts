import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import type {
  PaymentCurrency,
  PaymentMethod,
  Sale,
  SaleItem,
  SalePayment,
  SaleStatus,
  SaleType,
  SaleWithDetails,
} from "../types";

// ---------- Row shapes ----------

interface SaleRow {
  id: string;
  store_id: string;
  shift_id: string | null;
  device_id: string | null;
  cashier_user_id: string | null;
  receipt_number: number;
  exchange_rate_lbp_per_usd: number;
  exchange_rate_id: string | null;
  subtotal_excl_vat_cents: number;
  vat_total_cents: number;
  total_incl_vat_cents: number;
  discount_cents: number;
  cogs_total_cents: number;
  sale_type: SaleType;
  original_sale_id: string | null;
  status: SaleStatus;
  created_at: string;
  posted_at: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  notes: string | null;
}

interface SaleItemRow {
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
}

interface SalePaymentRow {
  id: string;
  sale_id: string;
  store_id: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  amount_native_usd_cents: number;
  amount_native_lbp: number;
  amount_usd_cents_equivalent: number;
  change_given_usd_cents: number;
  change_given_lbp: number;
  reference: string | null;
  created_at: string;
}

// ---------- Mappers ----------

function toSale(r: SaleRow): Sale {
  return {
    id: r.id,
    storeId: r.store_id,
    shiftId: r.shift_id,
    deviceId: r.device_id,
    cashierUserId: r.cashier_user_id,
    receiptNumber: r.receipt_number,
    exchangeRateLbpPerUsd: r.exchange_rate_lbp_per_usd,
    exchangeRateId: r.exchange_rate_id,
    subtotalExclVatCents: r.subtotal_excl_vat_cents,
    vatTotalCents: r.vat_total_cents,
    totalInclVatCents: r.total_incl_vat_cents,
    discountCents: r.discount_cents,
    cogsTotalCents: r.cogs_total_cents,
    saleType: r.sale_type,
    originalSaleId: r.original_sale_id,
    status: r.status,
    createdAt: r.created_at,
    postedAt: r.posted_at,
    voidedAt: r.voided_at,
    voidedByUserId: r.voided_by_user_id,
    voidReason: r.void_reason,
    notes: r.notes,
  };
}

function toSaleItem(r: SaleItemRow): SaleItem {
  return {
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
}

function toSalePayment(r: SalePaymentRow): SalePayment {
  return {
    id: r.id,
    saleId: r.sale_id,
    storeId: r.store_id,
    method: r.method,
    currency: r.currency,
    amountNativeUsdCents: r.amount_native_usd_cents,
    amountNativeLbp: r.amount_native_lbp,
    amountUsdCentsEquivalent: r.amount_usd_cents_equivalent,
    changeGivenUsdCents: r.change_given_usd_cents,
    changeGivenLbp: r.change_given_lbp,
    reference: r.reference,
    createdAt: r.created_at,
  };
}

// ---------- Post payload shapes ----------

export interface PostSaleLineInput {
  saleItemId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;

  uomCodeSnapshot: string;
  factorNumSnapshot: number;
  factorDenSnapshot: number;

  quantityInUom: number;
  quantityBase: number;

  unitPriceExclVatCents: number;
  unitPriceInclVatCents: number;

  vatRateIdSnapshot: string;
  vatRateBpsSnapshot: number;

  lineSubtotalExclVatCents: number;
  lineVatCents: number;
  lineTotalInclVatCents: number;

  barcodeUsedSnapshot: string | null;
  barcodeTypeSnapshot: string | null;

  isService: boolean;
}

export interface PostSalePaymentInput {
  paymentId: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: number;
  amountNativeLbp: number;
  amountUsdCentsEquivalent: number;
  reference: string | null;
}

export interface PostSaleInput {
  saleId: string;
  storeId: string;
  cashierUserId: string | null;
  deviceId: string | null;
  shiftId: string | null;
  exchangeRateId: string;
  exchangeRateLbpPerUsd: number;
  notes: string | null;
  lines: PostSaleLineInput[];
  payments: PostSalePaymentInput[];
}

export interface PostSaleResult {
  saleId: string;
  receiptNumber: number;
  postedAt: string;
  movementIds: string[];
  changeTotalUsdCents: number;
}

// ---------- Repo ----------

export const salesRepo = {
  async findById(id: string): Promise<Sale | null> {
    const rows = await query<SaleRow>(`SELECT * FROM sales WHERE id = ?`, [id]);
    return rows[0] ? toSale(rows[0]) : null;
  },

  async findByIdWithDetails(id: string): Promise<SaleWithDetails | null> {
    const sale = await this.findById(id);

    if (!sale) return null;

    const [lineRows, paymentRows] = await Promise.all([
      query<SaleItemRow>(
        `SELECT * FROM sale_items WHERE sale_id = ? ORDER BY created_at ASC`,
        [id],
      ),
      query<SalePaymentRow>(
        `SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY created_at ASC`,
        [id],
      ),
    ]);

    return {
      ...sale,
      lines: lineRows.map(toSaleItem),
      payments: paymentRows.map(toSalePayment),
    };
  },

  async list(args: {
    storeId: string;
    status?: SaleStatus;
    limit?: number;
  }): Promise<Sale[]> {
    const limit = args.limit ?? 100;

    if (args.status) {
      const rows = await query<SaleRow>(
        `SELECT * FROM sales
         WHERE store_id = ? AND status = ?
         ORDER BY COALESCE(posted_at, created_at) DESC
         LIMIT ?`,
        [args.storeId, args.status, limit],
      );

      return rows.map(toSale);
    }

    const rows = await query<SaleRow>(
      `SELECT * FROM sales
       WHERE store_id = ?
       ORDER BY COALESCE(posted_at, created_at) DESC
       LIMIT ?`,
      [args.storeId, limit],
    );

    return rows.map(toSale);
  },

async post(
  input: Omit<PostSaleInput, "saleId" | "lines" | "payments"> & {
    lines: Omit<PostSaleLineInput, "saleItemId">[];
    payments: Omit<PostSalePaymentInput, "paymentId">[];
  },
): Promise<PostSaleResult> {
    const saleId = newId();

    const payload: PostSaleInput = {
      ...input,
      saleId,
      lines: input.lines.map((l) => ({ ...l, saleItemId: newId() })),
      payments: input.payments.map((p) => ({ ...p, paymentId: newId() })),
    };

    return invoke<PostSaleResult>("post_sale", { payload });
  },
};