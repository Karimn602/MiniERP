import { query } from "../client";
import type { PaymentMethod, PaymentCurrency } from "../types";

function utcFrom(localDate: string): string {
  return new Date(`${localDate}T00:00:00`).toISOString();
}

function utcTo(localDate: string): string {
  return new Date(`${localDate}T23:59:59.999`).toISOString();
}

/**
 * Every posted sale on one local date, across shifts — the date-scoped twin of
 * `shiftsRepo.getSalesSummary`, and the same vocabulary.
 *
 * POST-DISCOUNT and BEFORE RETURNS, for the reason given there: `sales` stores
 * line values the register already discounted, so the header discount is
 * informational and must never be subtracted again. Returns come from
 * `refundSummaryRepo.refundSummary` below.
 */
export interface ShiftSalesSummary {
  receiptCount: number;
  totalInclVatCents: number;
  subtotalExclVatCents: number;
  /** Informational: already deducted from every other figure here. */
  discountCents: number;
  vatTotalCents: number;
  /** Post-discount revenue excl. VAT, before returns. */
  netSalesExclVatCents: number;
}

export interface ShiftPaymentRow {
  method: PaymentMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: number;
  amountNativeLbp: number;
  amountUsdCentsEquivalent: number;
  changeGivenUsdCents: number;
  changeGivenLbp: number;
}

export const shiftSummaryRepo = {
  async salesSummary(args: {
    storeId: string;
    date: string;
  }): Promise<ShiftSalesSummary> {
    interface Row {
      receipt_count: number;
      total_incl_vat_cents: number;
      subtotal_excl_vat_cents: number;
      discount_cents: number;
      vat_total_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         COUNT(*) AS receipt_count,
         COALESCE(SUM(total_incl_vat_cents), 0)    AS total_incl_vat_cents,
         COALESCE(SUM(subtotal_excl_vat_cents), 0) AS subtotal_excl_vat_cents,
         COALESCE(SUM(discount_cents), 0)           AS discount_cents,
         COALESCE(SUM(vat_total_cents), 0)          AS vat_total_cents
       FROM sales
       WHERE store_id = ?
         AND status = 'posted'
         AND posted_at >= ?
         AND posted_at <= ?`,
      [args.storeId, utcFrom(args.date), utcTo(args.date)],
    );

    const r = rows[0] ?? {
      receipt_count: 0,
      total_incl_vat_cents: 0,
      subtotal_excl_vat_cents: 0,
      discount_cents: 0,
      vat_total_cents: 0,
    };

    return {
      receiptCount: r.receipt_count,
      totalInclVatCents: r.total_incl_vat_cents,
      subtotalExclVatCents: r.subtotal_excl_vat_cents,
      discountCents: r.discount_cents,
      vatTotalCents: r.vat_total_cents,
      // GP-A04: the persisted subtotal is ALREADY net of the discount.
      netSalesExclVatCents: r.subtotal_excl_vat_cents,
    };
  },

  async paymentBreakdown(args: {
    storeId: string;
    date: string;
  }): Promise<ShiftPaymentRow[]> {
    interface Row {
      method: PaymentMethod;
      currency: PaymentCurrency;
      amount_native_usd_cents: number;
      amount_native_lbp: number;
      amount_usd_cents_equivalent: number;
      change_given_usd_cents: number;
      change_given_lbp: number;
    }

    const rows = await query<Row>(
      `SELECT
         sp.method,
         sp.currency,
         COALESCE(SUM(sp.amount_native_usd_cents), 0)     AS amount_native_usd_cents,
         COALESCE(SUM(sp.amount_native_lbp), 0)           AS amount_native_lbp,
         COALESCE(SUM(sp.amount_usd_cents_equivalent), 0) AS amount_usd_cents_equivalent,
         COALESCE(SUM(sp.change_given_usd_cents), 0)      AS change_given_usd_cents,
         COALESCE(SUM(sp.change_given_lbp), 0)            AS change_given_lbp
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       WHERE s.store_id = ?
         AND s.status = 'posted'
         AND s.posted_at >= ?
         AND s.posted_at <= ?
       GROUP BY sp.method, sp.currency
       ORDER BY sp.method, sp.currency`,
      [args.storeId, utcFrom(args.date), utcTo(args.date)],
    );

    return rows.map((r) => ({
      method: r.method,
      currency: r.currency,
      amountNativeUsdCents: r.amount_native_usd_cents,
      amountNativeLbp: r.amount_native_lbp,
      amountUsdCentsEquivalent: r.amount_usd_cents_equivalent,
      changeGivenUsdCents: r.change_given_usd_cents,
      changeGivenLbp: r.change_given_lbp,
    }));
  },
};

/**
 * Refunds for one local day — the date-scoped twin of
 * `shiftsRepo.getRefundSummary`.
 *
 * ADDITIVE, like every other returns read model: `salesSummary` above stays
 * BEFORE RETURNS and keeps meaning exactly what it meant before WP-06, and a
 * caller that wants net collection subtracts these with both figures on
 * screen. `netSalesExclVatCents` is net of the DISCOUNT only; WP-08 corrected
 * that formula (GP-A04) and deliberately did not fold returns into it.
 */
export interface DayRefundSummary {
  memoCount: number;
  subtotalExclVatCents: number;
  vatTotalCents: number;
  totalInclVatCents: number;
  cogsReversedCents: number;
}

export const refundSummaryRepo = {
  async refundSummary(args: {
    storeId: string;
    date: string;
  }): Promise<DayRefundSummary> {
    interface Row {
      memo_count: number;
      subtotal_excl_vat_cents: number;
      vat_total_cents: number;
      total_incl_vat_cents: number;
      cogs_reversed_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         COUNT(*) AS memo_count,
         COALESCE(SUM(subtotal_excl_vat_cents), 0) AS subtotal_excl_vat_cents,
         COALESCE(SUM(vat_total_cents), 0)         AS vat_total_cents,
         COALESCE(SUM(total_incl_vat_cents), 0)    AS total_incl_vat_cents,
         COALESCE(SUM(cogs_reversed_cents), 0)     AS cogs_reversed_cents
       FROM sales_credit_memos
       WHERE store_id = ?
         AND status = 'posted'
         AND posted_at >= ?
         AND posted_at <= ?`,
      [args.storeId, utcFrom(args.date), utcTo(args.date)],
    );

    const r = rows[0] ?? {
      memo_count: 0,
      subtotal_excl_vat_cents: 0,
      vat_total_cents: 0,
      total_incl_vat_cents: 0,
      cogs_reversed_cents: 0,
    };

    return {
      memoCount: r.memo_count,
      subtotalExclVatCents: r.subtotal_excl_vat_cents,
      vatTotalCents: r.vat_total_cents,
      totalInclVatCents: r.total_incl_vat_cents,
      cogsReversedCents: r.cogs_reversed_cents,
    };
  },
};
