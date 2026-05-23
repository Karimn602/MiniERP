import { query, execute } from "../client";
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

  async openShift(args: {
    storeId: string;
    userId: string;
    openingCashUsdCents: number;
    openingCashLbp: number;
  }): Promise<Shift> {
    const existing = await this.getOpenShift(args.storeId);
    if (existing) {
      throw new Error("A shift is already open. Close it before opening a new one.");
    }
    const id = newId();
    await execute(
      `INSERT INTO shifts (
         id, store_id, opened_by_user_id,
         opening_cash_usd_cents, opening_cash_lbp,
         status
       ) VALUES (?, ?, ?, ?, ?, 'open')`,
      [id, args.storeId, args.userId, args.openingCashUsdCents, args.openingCashLbp],
    );
    const rows = await query<ShiftRow>(`SELECT * FROM shifts WHERE id = ?`, [id]);
    if (!rows[0]) throw new Error("Failed to read newly opened shift.");
    return toShift(rows[0]);
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

  async closeShift(args: {
    shiftId: string;
    storeId: string;
    userId: string;
    closingCashUsdCents: number;
    closingCashLbp: number;
  }): Promise<Shift> {
    // Read opening cash + verify status
    const shiftRows = await query<ShiftRow>(
      `SELECT * FROM shifts WHERE id = ? AND store_id = ? AND status = 'open'`,
      [args.shiftId, args.storeId],
    );
    const shift = shiftRows[0];
    if (!shift) throw new Error("No open shift found — it may already be closed.");

    // Aggregate drawer cash from all posted sales in this shift
    interface DrawerRow {
      cash_usd_received: number;
      cash_lbp_received: number;
      change_usd: number;
      change_lbp: number;
    }
    const drawerRows = await query<DrawerRow>(
      `SELECT
         COALESCE(SUM(CASE WHEN sp.method = 'cash_usd' THEN sp.amount_native_usd_cents ELSE 0 END), 0) AS cash_usd_received,
         COALESCE(SUM(CASE WHEN sp.method = 'cash_lbp' THEN sp.amount_native_lbp        ELSE 0 END), 0) AS cash_lbp_received,
         COALESCE(SUM(sp.change_given_usd_cents), 0) AS change_usd,
         COALESCE(SUM(sp.change_given_lbp),       0) AS change_lbp
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       WHERE s.store_id = ?
         AND s.shift_id = ?
         AND s.status = 'posted'`,
      [args.storeId, args.shiftId],
    );
    const d = drawerRows[0] ?? {
      cash_usd_received: 0,
      cash_lbp_received: 0,
      change_usd: 0,
      change_lbp: 0,
    };

    // expected = opening + received − change given back
    const expectedUsd =
      shift.opening_cash_usd_cents + d.cash_usd_received - d.change_usd;
    const expectedLbp =
      shift.opening_cash_lbp + d.cash_lbp_received - d.change_lbp;
    const varianceUsd = args.closingCashUsdCents - expectedUsd;
    const varianceLbp = args.closingCashLbp - expectedLbp;

    const now = new Date().toISOString();
    await execute(
      `UPDATE shifts SET
         status                 = 'closed',
         closed_at              = ?,
         closed_by_user_id      = ?,
         closing_cash_usd_cents = ?,
         closing_cash_lbp       = ?,
         expected_cash_usd_cents = ?,
         expected_cash_lbp      = ?,
         variance_usd_cents     = ?,
         variance_lbp           = ?
       WHERE id = ? AND store_id = ? AND status = 'open'`,
      [
        now,
        args.userId,
        args.closingCashUsdCents,
        args.closingCashLbp,
        expectedUsd,
        expectedLbp,
        varianceUsd,
        varianceLbp,
        args.shiftId,
        args.storeId,
      ],
    );

    const updatedRows = await query<ShiftRow>(
      `SELECT * FROM shifts WHERE id = ?`,
      [args.shiftId],
    );
    if (!updatedRows[0]) throw new Error("Failed to read closed shift.");
    return toShift(updatedRows[0]);
  },
};
