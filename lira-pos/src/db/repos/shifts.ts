import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import type { Shift, ShiftStatus, PaymentMethod, PaymentCurrency } from "../types";

// ---------- DB row shape ----------

interface ShiftRow {
  id: string;
  store_id: string;
  device_id: string | null;
  opened_by_user_id: string;
  closed_by_user_id: string | null;
  opened_at: string;
  closed_at: string | null;
  opening_cash_usd_cents: number;
  opening_cash_lbp: number;
  closing_cash_usd_cents: number | null;
  closing_cash_lbp: number | null;
  expected_cash_usd_cents: number | null;
  expected_cash_lbp: number | null;
  variance_usd_cents: number | null;
  variance_lbp: number | null;
  status: ShiftStatus;
  notes: string | null;
}

function toShift(r: ShiftRow): Shift {
  return {
    id: r.id,
    storeId: r.store_id,
    deviceId: r.device_id,
    openedByUserId: r.opened_by_user_id,
    closedByUserId: r.closed_by_user_id,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    openingCashUsdCents: r.opening_cash_usd_cents,
    openingCashLbp: r.opening_cash_lbp,
    closingCashUsdCents: r.closing_cash_usd_cents,
    closingCashLbp: r.closing_cash_lbp,
    expectedCashUsdCents: r.expected_cash_usd_cents,
    expectedCashLbp: r.expected_cash_lbp,
    varianceUsdCents: r.variance_usd_cents,
    varianceLbp: r.variance_lbp,
    status: r.status,
    notes: r.notes,
  };
}

// ---------- Shift summary shapes ----------

export interface ShiftSalesSummary {
  receiptCount: number;
  totalInclVatCents: number;
  subtotalExclVatCents: number;
  discountCents: number;
  vatTotalCents: number;
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

/**
 * The cash movements that actually passed through one shift's drawer, stated
 * per currency in that currency's own unit (USD cents / whole lira). Card,
 * transfer and wallet tenders are absent by construction: they never reach the
 * till.
 */
export interface ShiftDrawerExpectation {
  cashUsdInCents: number;
  cashLbpIn: number;
  changeUsdOutCents: number;
  changeLbpOut: number;
}

// ---------- Repo ----------

export const shiftsRepo = {
  async getOpenShift(storeId: string): Promise<Shift | null> {
    const rows = await query<ShiftRow>(
      `SELECT * FROM shifts
       WHERE store_id = ? AND status = 'open'
       ORDER BY opened_at DESC
       LIMIT 1`,
      [storeId],
    );
    return rows[0] ? toShift(rows[0]) : null;
  },

  /**
   * Open a shift for this store.
   *
   * Transactional, in Rust (WP-04, GZ-HI-03). This used to read "is anything
   * open?" and then INSERT as two separate statements dispatched across
   * tauri-plugin-sql's connection pool, so two tabs or a double-click could
   * both see nothing open and both insert — after which `getOpenShift`'s
   * `LIMIT 1` quietly hid one of the two drawers. `open_shift` decides it in
   * one statement inside one transaction, with
   * `ux_shifts_one_open_per_store` (migration 009) as the engine-level
   * backstop. A conflicting open fails with the backend's message; surface it.
   *
   * The returned shift is the row the command committed, so there is no
   * follow-up SELECT that could observe a different state.
   */
  async openShift(args: {
    storeId: string;
    userId: string;
    openingCashUsdCents: number;
    openingCashLbp: number;
    deviceId?: string | null;
    notes?: string | null;
  }): Promise<Shift> {
    return invoke<Shift>("open_shift", {
      payload: {
        shiftId: newId(),
        storeId: args.storeId,
        openedByUserId: args.userId,
        deviceId: args.deviceId ?? null,
        openingCashUsdCents: args.openingCashUsdCents,
        openingCashLbp: args.openingCashLbp,
        notes: args.notes ?? null,
      },
    });
  },

  async getSalesSummary(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftSalesSummary> {
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
         AND shift_id = ?
         AND status = 'posted'`,
      [storeId, shiftId],
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
      netSalesExclVatCents: r.subtotal_excl_vat_cents - r.discount_cents,
    };
  },

  async getPaymentBreakdown(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftPaymentRow[]> {
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
         AND s.shift_id = ?
         AND s.status = 'posted'
       GROUP BY sp.method, sp.currency
       ORDER BY sp.method, sp.currency`,
      [storeId, shiftId],
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

  /**
   * The cash this shift's drawer should be holding, from actual
   * drawer-affecting events only.
   *
   * A READ-ONLY MIRROR of the figure `close_shift` computes and stores. The
   * authoritative calculation is `posting.rs::drawer_cash_for_shift`, run inside
   * the closing transaction; this query exists so the Shift page can show a
   * live "expected" and a live variance while the cashier is still counting,
   * and it is deliberately the same SQL so the preview cannot disagree with
   * the figure that gets persisted.
   *
   * Only `cash_usd` and `cash_lbp` tenders move physical money, so only they
   * appear — in both the money-in and the change-out term. Filtering the change
   * term by method is the GZ-HI-04 correction: a card row that carries change
   * (which `post_sale` now refuses to write, but an older release did) must not
   * make the till look short.
   */
  async getDrawerExpectation(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftDrawerExpectation> {
    interface Row {
      cash_usd_in: number;
      cash_lbp_in: number;
      change_usd_out: number;
      change_lbp_out: number;
    }
    const rows = await query<Row>(
      `SELECT
         COALESCE(SUM(CASE WHEN sp.method = 'cash_usd'
                           THEN sp.amount_native_usd_cents ELSE 0 END), 0) AS cash_usd_in,
         COALESCE(SUM(CASE WHEN sp.method = 'cash_lbp'
                           THEN sp.amount_native_lbp ELSE 0 END), 0)       AS cash_lbp_in,
         COALESCE(SUM(CASE WHEN sp.method IN ('cash_usd','cash_lbp')
                           THEN sp.change_given_usd_cents ELSE 0 END), 0)  AS change_usd_out,
         COALESCE(SUM(CASE WHEN sp.method IN ('cash_usd','cash_lbp')
                           THEN sp.change_given_lbp ELSE 0 END), 0)        AS change_lbp_out
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       WHERE s.store_id = ?
         AND s.shift_id = ?
         AND s.status = 'posted'`,
      [storeId, shiftId],
    );
    const r = rows[0] ?? {
      cash_usd_in: 0,
      cash_lbp_in: 0,
      change_usd_out: 0,
      change_lbp_out: 0,
    };
    return {
      cashUsdInCents: r.cash_usd_in,
      cashLbpIn: r.cash_lbp_in,
      changeUsdOutCents: r.change_usd_out,
      changeLbpOut: r.change_lbp_out,
    };
  },

  /**
   * Close a shift: count the drawer, reconcile it, lock it.
   *
   * Transactional, in Rust (WP-04, GZ-HI-03). This used to read the shift,
   * aggregate the till, UPDATE, and re-read as four separate statements, so a
   * sale could land between the aggregate and the UPDATE and end up inside a
   * shift whose stored snapshot does not include it. `close_shift` does all of
   * it in one transaction, so the figures written ARE the state that was marked
   * closed.
   *
   * Closing twice is refused — the counted cash and variance of a closed shift
   * are final, and `trg_shifts_no_update_after_close` (migration 009) enforces
   * that against any caller. The returned shift is the committed row.
   */
  async closeShift(args: {
    shiftId: string;
    storeId: string;
    userId: string;
    closingCashUsdCents: number;
    closingCashLbp: number;
  }): Promise<Shift> {
    return invoke<Shift>("close_shift", {
      payload: {
        shiftId: args.shiftId,
        storeId: args.storeId,
        closedByUserId: args.userId,
        closingCashUsdCents: args.closingCashUsdCents,
        closingCashLbp: args.closingCashLbp,
      },
    });
  },
};
