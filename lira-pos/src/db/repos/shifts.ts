import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import { newId } from "../../lib/ids";
import type {
  Shift,
  ShiftStatus,
  PaymentMethod,
  PaymentCurrency,
  RefundMethod,
} from "../types";
import {
  SHIFT_CONFIDENTIAL_COLUMNS,
  SHIFT_PUBLIC_COLUMNS,
  costsVisible,
  projection,
} from "../projection";

/** Shift columns this session may read (Stage C). Never `*`. */
const shiftCols = (alias: string | null = null) =>
  projection(alias, SHIFT_PUBLIC_COLUMNS, SHIFT_CONFIDENTIAL_COLUMNS);

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
    closingCashUsdCents: r.closing_cash_usd_cents ?? null,
    closingCashLbp: r.closing_cash_lbp ?? null,
    // `?? null`: absent on a cashier's read (Stage C), and an open shift has
    // none stored anyway.
    expectedCashUsdCents: r.expected_cash_usd_cents ?? null,
    expectedCashLbp: r.expected_cash_lbp ?? null,
    varianceUsdCents: r.variance_usd_cents ?? null,
    varianceLbp: r.variance_lbp ?? null,
    status: r.status,
    notes: r.notes,
  };
}

// ---------- Shift summary shapes ----------

/**
 * One shift's posted SALES, stated in the canonical reporting vocabulary
 * (tests/README.md › "Canonical reporting vocabulary").
 *
 * Every figure here is POST-DISCOUNT and BEFORE RETURNS, because that is what
 * `sales` persists: `post_sale` sums the lines PosRegister already discounted
 * (`lib/discount.ts::postDiscountLineTotals`), so the header satisfies
 * `subtotal + VAT == total` with the discount already taken out. Returns are
 * their own documents and come from `getRefundSummary`, which the page
 * subtracts with both figures on screen.
 *
 * `netSalesExclVatCents` is therefore net OF THE DISCOUNT, not of returns —
 * and it is exactly `subtotalExclVatCents`. It used to be
 * `subtotal − discount`, which removed the same discount a second time
 * (GP-A04): an $8.11-net sale discounted by $1.00 reported $7.11 of net sales
 * and a margin short by the whole discount. `discountCents` stays as its own
 * INFORMATIONAL figure — what the shop gave away — and is never subtracted
 * from a sales total again.
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
  /** Cash handed back on this shift's posted credit memos (WP-06). */
  refundUsdOutCents: number;
  refundLbpOut: number;
  /**
   * Cash a DRIVER handed in during this shift (WP-7).
   *
   * The NATIVE amount, not the USD equivalent: this figure is compared against
   * physical dollars in a drawer, and converting a lira hand-over into it would
   * make the till expect notes nobody put there. The lira term below is the
   * lira half of the same rows.
   */
  driverRemitUsdInCents: number;
  driverRemitLbpIn: number;
}

/**
 * What one shift refunded, and how.
 *
 * Deliberately NOT folded into `ShiftSalesSummary`: a refund is not a negative
 * sale, so `receiptCount` and the sales totals stay GROSS and the shift screen
 * shows returns on a line of their own. Net collection is then a subtraction
 * the page makes with both figures visible, rather than a number that quietly
 * means something different than it did before.
 */
export interface ShiftRefundSummary {
  memoCount: number;
  subtotalExclVatCents: number;
  vatTotalCents: number;
  totalInclVatCents: number;
  cogsReversedCents: number;
}

export interface ShiftRefundRow {
  method: RefundMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: number;
  amountNativeLbp: number;
  amountUsdCentsEquivalent: number;
}


// ---------- Shift history (WP-A1) ----------

/**
 * One row of the shift-history list: the shift as it was RECORDED, plus the
 * names of the people who opened and closed it.
 *
 * `shift` is the stored row and nothing else. In particular
 * `expectedCashUsdCents`, `closingCash*` and `variance*` are the figures
 * `close_shift` computed INSIDE the closing transaction and wrote once; this
 * repo never recomputes them, and migration 009's
 * `trg_shifts_no_update_after_close` means nothing else can either. A closed
 * shift's reconciliation is a historical statement about a drawer that was
 * counted on a particular evening, not a figure that should move because
 * something was posted, corrected or re-rated afterwards.
 *
 * The names are resolved by JOIN rather than stored: `users.full_name` is
 * master data and a shift records the user ID. A cashier renamed since will
 * show under the new name, which is the right answer for "who was on the
 * till" — it is the same person.
 */
export interface ShiftHistoryRow {
  shift: Shift;
  openedByName: string | null;
  closedByName: string | null;
}

/**
 * Everything the history detail view shows for ONE shift, read once.
 *
 * Deliberately assembled from the SAME shift-scoped accessors the live Current
 * Shift view uses, rather than from a second set of history queries. Two
 * query paths for one set of figures is how a screen comes to disagree with
 * itself — which is exactly the defect WP-7 found between `ShiftSummary` and
 * `close_shift` — so there is one definition per figure and the only
 * difference between a live shift and a closed one is which `shiftId` is
 * passed.
 *
 * Every figure here is derived from amounts PERSISTED in each row's own
 * currency: native cash in `sale_payments` / `sales_credit_memo_refunds` /
 * `driver_ledger`, and USD equivalents that were computed at the rate the
 * document locked. No current exchange rate is read anywhere in this file, so
 * a historical shift cannot be re-stated by today's rate.
 */
export interface ShiftHistoryDetail {
  row: ShiftHistoryRow;
  sales: ShiftSalesSummary;
  payments: ShiftPaymentRow[];
  refunds: ShiftRefundSummary;
  refundRows: ShiftRefundRow[];
  drawer: ShiftDrawerExpectation;
}

// ---------- Repo ----------

export const shiftsRepo = {
  async getOpenShift(storeId: string): Promise<Shift | null> {
    const rows = await query<ShiftRow>(
      `SELECT ${shiftCols()} FROM shifts
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


  /**
   * The store's shifts, most recent first — the SHIFT HISTORY list (WP-A1).
   *
   * Why this exists: until now the Shift screen could show the open shift or
   * the form to open one, and nothing else. The moment a shift was closed its
   * entire reconciliation — the counted cash, the expected cash, the variance
   * the cashier was held to — left the visible application. The figures were
   * never lost (they are columns on `shifts`, immutable since migration 009),
   * but a figure nobody can read is not an audit trail.
   *
   * Read-only by construction: this method SELECTs, and a closed shift cannot
   * be written by anything anyway. There is no "edit shift" path to guard.
   *
   * `status` defaults to every state rather than to `'closed'`: the open shift
   * belongs in its own history as today's row, and a `'voided'` one (the third
   * value the CHECK allows, which nothing writes today) must not vanish from a
   * list whose purpose is accountability.
   *
   * Date filtering is on the LOCAL calendar date a shift was OPENED, via
   * `date(opened_at, 'localtime')` — the convention `reports.ts` and
   * `shiftSummary.ts` already use, and the one `lib/dates.ts` argues for: a
   * shift that opened at 00:30 Beirut belongs to that day in Beirut. Opened
   * rather than closed, because that is the day the shift is remembered by,
   * and an overnight shift would otherwise appear on the next day's list and
   * be absent from its own.
   */
  async listHistory(args: {
    storeId: string;
    /** Inclusive local-date lower bound (YYYY-MM-DD). */
    fromDate?: string;
    /** Inclusive local-date upper bound (YYYY-MM-DD). */
    toDate?: string;
    status?: ShiftStatus;
    limit?: number;
  }): Promise<ShiftHistoryRow[]> {
    interface Row extends ShiftRow {
      opened_by_name: string | null;
      closed_by_name: string | null;
    }

    const where: string[] = ["s.store_id = ?"];
    const params: unknown[] = [args.storeId];
    if (args.status) {
      where.push("s.status = ?");
      params.push(args.status);
    }
    if (args.fromDate) {
      where.push("date(s.opened_at, 'localtime') >= ?");
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push("date(s.opened_at, 'localtime') <= ?");
      params.push(args.toDate);
    }
    params.push(args.limit ?? 100);

    const rows = await query<Row>(
      `SELECT ${shiftCols("s")},
              uo.full_name AS opened_by_name,
              uc.full_name AS closed_by_name
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE ${where.join(" AND ")}
        ORDER BY s.opened_at DESC
        LIMIT ?`,
      params,
    );

    return rows.map((r) => ({
      shift: toShift(r),
      openedByName: r.opened_by_name,
      closedByName: r.closed_by_name,
    }));
  },

  /** One shift by id, with the names, or null. Scoped to its store. */
  async findHistoryRow(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftHistoryRow | null> {
    interface Row extends ShiftRow {
      opened_by_name: string | null;
      closed_by_name: string | null;
    }
    const rows = await query<Row>(
      `SELECT ${shiftCols("s")},
              uo.full_name AS opened_by_name,
              uc.full_name AS closed_by_name
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE s.id = ? AND s.store_id = ?
        LIMIT 1`,
      [shiftId, storeId],
    );
    const r = rows[0];
    return r
      ? {
          shift: toShift(r),
          openedByName: r.opened_by_name,
          closedByName: r.closed_by_name,
        }
      : null;
  },

  /**
   * Everything one shift's detail view shows, in one call (WP-A1).
   *
   * Composed from the EXISTING shift-scoped accessors — the same five the live
   * Current Shift view calls — so a closed shift and an open one are read by
   * one set of definitions. Nothing here is history-specific arithmetic; the
   * only difference is the id.
   */
  async getHistoryDetail(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftHistoryDetail | null> {
    const row = await this.findHistoryRow(shiftId, storeId);
    if (!row) return null;

    const [sales, payments, refunds, refundRows, drawer] = await Promise.all([
      this.getSalesSummary(shiftId, storeId),
      this.getPaymentBreakdown(shiftId, storeId),
      this.getRefundSummary(shiftId, storeId),
      this.getRefundBreakdown(shiftId, storeId),
      this.getDrawerExpectation(shiftId, storeId),
    ]);

    return { row, sales, payments, refunds, refundRows, drawer };
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
      // The persisted subtotal IS the post-discount figure (GP-A04). Do not
      // subtract `discount_cents` here: it is already out of this number.
      netSalesExclVatCents: r.subtotal_excl_vat_cents,
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
   * appear — in the money-in term, in the change-out term, and (since WP-06)
   * in the refund-out term. Filtering the change term by method is the
   * GZ-HI-04 correction: a card row that carries change (which `post_sale` now
   * refuses to write, but an older release did) must not make the till look
   * short. The refund term is filtered the same way, so a card refund cannot
   * either.
   */
  async getDrawerExpectation(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftDrawerExpectation> {
    interface TenderRow {
      cash_usd_in: number;
      cash_lbp_in: number;
      change_usd_out: number;
      change_lbp_out: number;
    }
    interface RefundRow {
      refund_usd_out: number;
      refund_lbp_out: number;
    }
    interface RemitRow {
      remit_usd_in: number;
      remit_lbp_in: number;
    }

    // Two statements, not a join: one sale can carry several tenders and one
    // return several refund legs, so joining them would multiply each against
    // the other. `posting.rs::drawer_cash_for_shift` is shaped the same way,
    // and for the same reason.
    const [tenderRows, refundRows, remitRows] = await Promise.all([
      query<TenderRow>(
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
      ),
      query<RefundRow>(
        `SELECT
           COALESCE(SUM(CASE WHEN r.method = 'cash_usd'
                             THEN r.amount_native_usd_cents ELSE 0 END), 0) AS refund_usd_out,
           COALESCE(SUM(CASE WHEN r.method = 'cash_lbp'
                             THEN r.amount_native_lbp ELSE 0 END), 0)       AS refund_lbp_out
         FROM sales_credit_memo_refunds r
         JOIN sales_credit_memos m ON m.id = r.credit_memo_id
         WHERE m.store_id = ?
           AND m.shift_id = ?
           AND m.status = 'posted'`,
        [storeId, shiftId],
      ),
      // A third statement, for the same reason the refunds are a second one:
      // one shift can hold many tenders, many refund legs and many hand-overs,
      // and joining them would multiply each against the others.
      query<RemitRow>(
        `SELECT
           COALESCE(SUM(received_native_usd_cents), 0) AS remit_usd_in,
           COALESCE(SUM(received_native_lbp), 0)       AS remit_lbp_in
         FROM driver_ledger
         WHERE store_id = ?
           AND shift_id = ?
           AND entry_type = 'remittance'`,
        [storeId, shiftId],
      ),
    ]);

    const t = tenderRows[0] ?? {
      cash_usd_in: 0,
      cash_lbp_in: 0,
      change_usd_out: 0,
      change_lbp_out: 0,
    };
    const r = refundRows[0] ?? { refund_usd_out: 0, refund_lbp_out: 0 };
    const d = remitRows[0] ?? { remit_usd_in: 0, remit_lbp_in: 0 };

    return {
      cashUsdInCents: t.cash_usd_in,
      cashLbpIn: t.cash_lbp_in,
      changeUsdOutCents: t.change_usd_out,
      changeLbpOut: t.change_lbp_out,
      refundUsdOutCents: r.refund_usd_out,
      refundLbpOut: r.refund_lbp_out,
      driverRemitUsdInCents: d.remit_usd_in,
      driverRemitLbpIn: d.remit_lbp_in,
    };
  },

  /** What this shift refunded, as its own figures. */
  async getRefundSummary(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftRefundSummary> {
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
         ${costsVisible() ? "COALESCE(SUM(cogs_reversed_cents), 0)" : "0"} AS cogs_reversed_cents
       FROM sales_credit_memos
       WHERE store_id = ? AND shift_id = ? AND status = 'posted'`,
      [storeId, shiftId],
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

  /** This shift's refunds, by the method the money went back on. */
  async getRefundBreakdown(
    shiftId: string,
    storeId: string,
  ): Promise<ShiftRefundRow[]> {
    interface Row {
      method: RefundMethod;
      currency: PaymentCurrency;
      amount_native_usd_cents: number;
      amount_native_lbp: number;
      amount_usd_cents_equivalent: number;
    }
    const rows = await query<Row>(
      `SELECT
         r.method,
         r.currency,
         COALESCE(SUM(r.amount_native_usd_cents), 0)     AS amount_native_usd_cents,
         COALESCE(SUM(r.amount_native_lbp), 0)           AS amount_native_lbp,
         COALESCE(SUM(r.amount_usd_cents_equivalent), 0) AS amount_usd_cents_equivalent
       FROM sales_credit_memo_refunds r
       JOIN sales_credit_memos m ON m.id = r.credit_memo_id
       WHERE m.store_id = ? AND m.shift_id = ? AND m.status = 'posted'
       GROUP BY r.method, r.currency
       ORDER BY r.method, r.currency`,
      [storeId, shiftId],
    );
    return rows.map((r) => ({
      method: r.method,
      currency: r.currency,
      amountNativeUsdCents: r.amount_native_usd_cents,
      amountNativeLbp: r.amount_native_lbp,
      amountUsdCentsEquivalent: r.amount_usd_cents_equivalent,
    }));
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
