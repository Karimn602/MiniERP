/**
 * Drivers and the driver clearing subledger (WP-6).
 *
 * Reads, plus the two single-row master-data writes. Shaped after
 * `suppliers.ts` and `supplierLedger.ts`, because a driver is the same kind of
 * thing pointing the other way: a party the shop runs a balance with.
 *
 * ## Why the master writes are TypeScript and the ledger write is not
 *
 * Saving a driver is ONE row in ONE table, so a single `INSERT`/`UPDATE` is
 * already atomic and there is nothing for a transaction to protect — the same
 * reason `suppliers.ts` writes its own rows. A LEDGER entry is different: it
 * has to be decided against a balance read in the same transaction that writes
 * it, or two remittances could both spend one outstanding amount. So
 * `postRemittance` is an `invoke` into `post_driver_remittance`, and this
 * module never inserts into `driver_ledger` itself.
 *
 * Nothing here computes a balance either. `driver_balances` is a view over the
 * ledger, so the figure the screen shows and the figure the command enforces
 * come from the same rows.
 */

import { invoke } from "@tauri-apps/api/core";
import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import type {
  Driver,
  DriverBalance,
  DriverLedgerEntry,
  DriverLedgerEntryType,
  PaymentCurrency,
} from "../types";

interface DriverRow {
  id: string;
  store_id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface BalanceRow {
  driver_id: string;
  store_id: string;
  driver_name: string;
  is_active: number;
  outstanding_cents: number;
  collected_cents: number;
  remitted_cents: number;
  return_credit_cents: number;
  adjustment_cents: number;
  collection_count: number;
  last_activity_at: string | null;
}

interface LedgerRow {
  id: string;
  store_id: string;
  driver_id: string;
  entry_type: DriverLedgerEntryType;
  amount_cents: number;
  entry_date: string;
  notes: string | null;
  related_sale_id: string | null;
  related_credit_memo_id: string | null;
  received_currency: PaymentCurrency | null;
  received_native_usd_cents: number;
  received_native_lbp: number;
  exchange_rate_id: string | null;
  exchange_rate_lbp_per_usd: number | null;
  reference: string | null;
  shift_id: string | null;
  created_by_user_id: string | null;
  device_id: string | null;
  posted_at: string;
}

function toDriver(r: DriverRow): Driver {
  return {
    id: r.id,
    storeId: r.store_id,
    name: r.name,
    phone: r.phone,
    notes: r.notes,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toBalance(r: BalanceRow): DriverBalance {
  return {
    driverId: r.driver_id,
    storeId: r.store_id,
    driverName: r.driver_name,
    isActive: r.is_active === 1,
    outstandingCents: r.outstanding_cents,
    collectedCents: r.collected_cents,
    remittedCents: r.remitted_cents,
    returnCreditCents: r.return_credit_cents,
    adjustmentCents: r.adjustment_cents,
    collectionCount: r.collection_count,
    lastActivityAt: r.last_activity_at,
  };
}

function toEntry(r: LedgerRow): DriverLedgerEntry {
  return {
    id: r.id,
    storeId: r.store_id,
    driverId: r.driver_id,
    entryType: r.entry_type,
    amountCents: r.amount_cents,
    entryDate: r.entry_date,
    notes: r.notes,
    relatedSaleId: r.related_sale_id,
    relatedCreditMemoId: r.related_credit_memo_id,
    receivedCurrency: r.received_currency,
    receivedNativeUsdCents: r.received_native_usd_cents,
    receivedNativeLbp: r.received_native_lbp,
    exchangeRateId: r.exchange_rate_id,
    exchangeRateLbpPerUsd: r.exchange_rate_lbp_per_usd,
    reference: r.reference,
    shiftId: r.shift_id,
    createdByUserId: r.created_by_user_id,
    deviceId: r.device_id,
    postedAt: r.posted_at,
  };
}

export interface PostDriverRemittanceResult {
  ledgerEntryId: string;
  postedAt: string;
  newBalanceCents: number;
  /** As stored: negative for a remittance. */
  amountCents: number;
}

export const driversRepo = {
  /** Active drivers by default — who the cashier may assign an order to. */
  async list(args: {
    storeId: string;
    includeInactive?: boolean;
  }): Promise<Driver[]> {
    const rows = await query<DriverRow>(
      `SELECT * FROM drivers
        WHERE store_id = ? ${args.includeInactive ? "" : "AND is_active = 1"}
        ORDER BY name`,
      [args.storeId],
    );
    return rows.map(toDriver);
  },

  async findById(id: string): Promise<Driver | null> {
    const rows = await query<DriverRow>(`SELECT * FROM drivers WHERE id = ?`, [id]);
    return rows[0] ? toDriver(rows[0]) : null;
  },

  /**
   * Every driver with his balance, including those at zero.
   *
   * A retired driver is included when he still owes something, however the
   * caller asked: hiding a balance because the person was deactivated is how
   * the shop's money goes missing from its own screen. Being retired stops new
   * orders, not settlement of old ones.
   */
  async balances(args: {
    storeId: string;
    includeInactive?: boolean;
  }): Promise<DriverBalance[]> {
    const rows = await query<BalanceRow>(
      `SELECT * FROM driver_balances
        WHERE store_id = ?
          ${args.includeInactive ? "" : "AND (is_active = 1 OR outstanding_cents <> 0)"}
        ORDER BY outstanding_cents DESC, driver_name`,
      [args.storeId],
    );
    return rows.map(toBalance);
  },

  async balanceFor(driverId: string): Promise<DriverBalance | null> {
    const rows = await query<BalanceRow>(
      `SELECT * FROM driver_balances WHERE driver_id = ?`,
      [driverId],
    );
    return rows[0] ? toBalance(rows[0]) : null;
  },

  /**
   * One driver's ledger, newest first — the settlement history, with every row
   * traceable to the receipt or credit memo behind it.
   */
  async ledger(args: { driverId: string; limit?: number }): Promise<DriverLedgerEntry[]> {
    const rows = await query<LedgerRow>(
      `SELECT * FROM driver_ledger
        WHERE driver_id = ?
        ORDER BY posted_at DESC, rowid DESC
        LIMIT ?`,
      [args.driverId, args.limit ?? 200],
    );
    return rows.map(toEntry);
  },

  /**
   * The receivable a single receipt raised, if any. Source-level traceability
   * in the other direction: from the order to the balance it moved.
   */
  async collectionForSale(saleId: string): Promise<DriverLedgerEntry | null> {
    const rows = await query<LedgerRow>(
      `SELECT * FROM driver_ledger WHERE related_sale_id = ?`,
      [saleId],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  },

  /**
   * Does a ledger entry exist under this identity?
   *
   * The read-only probe that resolves an UNKNOWN remittance outcome.
   * `post_driver_remittance` consumes an identity on exactly one commit, so a
   * row under that id proves the hand-over posted and the absence of one
   * proves it had not, as of this read. Nothing here writes, which is what
   * makes it safe to offer as the first action on an unresolved remittance.
   */
  async findLedgerEntry(entryId: string): Promise<DriverLedgerEntry | null> {
    const rows = await query<LedgerRow>(`SELECT * FROM driver_ledger WHERE id = ?`, [entryId]);
    return rows[0] ? toEntry(rows[0]) : null;
  },

  // -------------------------------------------------------------------------
  // Master data
  // -------------------------------------------------------------------------

  async create(args: {
    storeId: string;
    name: string;
    phone?: string | null;
    notes?: string | null;
  }): Promise<string> {
    const id = newId();
    await execute(
      `INSERT INTO drivers (id, store_id, name, phone, notes) VALUES (?, ?, ?, ?, ?)`,
      [id, args.storeId, args.name.trim(), args.phone?.trim() || null, args.notes?.trim() || null],
    );
    return id;
  },

  async update(args: {
    id: string;
    name: string;
    phone?: string | null;
    notes?: string | null;
  }): Promise<void> {
    await execute(
      `UPDATE drivers
          SET name = ?, phone = ?, notes = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [args.name.trim(), args.phone?.trim() || null, args.notes?.trim() || null, args.id],
    );
  },

  /**
   * Retire or reinstate a driver. Never a delete: his name is on posted
   * receipts and on ledger rows, and the foreign keys are RESTRICT so that is
   * structural rather than a convention.
   */
  async setActive(id: string, isActive: boolean): Promise<void> {
    await execute(
      `UPDATE drivers
          SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [isActive ? 1 : 0, id],
    );
  },

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /**
   * Record a driver handing money over, or a signed-off correction.
   *
   * Goes through `post_driver_remittance` so the balance is read inside the
   * transaction that writes the row — which is what makes over-settlement and
   * duplicate submission impossible rather than unlikely. `ledgerEntryId` is
   * the REMITTANCE IDENTITY: mint it once per hand-over and reuse it on every
   * retry, so a lost answer reconciles to the row that posted instead of
   * paying twice.
   */
  async postRemittance(input: {
    ledgerEntryId: string;
    storeId: string;
    driverId: string;
    entryType: "remittance" | "adjustment";
    entryDate: string;
    notes?: string | null;
    /** Remittance: the cash that physically arrived, in its own unit. */
    receivedCurrency?: PaymentCurrency | null;
    receivedNativeUsdCents?: number;
    receivedNativeLbp?: number;
    /** Required for a lira remittance, forbidden otherwise. */
    exchangeRateId?: string | null;
    exchangeRateLbpPerUsd?: number | null;
    /** Adjustment only: the explicit direction and a positive magnitude. */
    direction?: "increase" | "decrease" | null;
    amountMagnitudeCents?: number;
    reference?: string | null;
    shiftId?: string | null;
    createdByUserId?: string | null;
    deviceId?: string | null;
  }): Promise<PostDriverRemittanceResult> {
    return invoke<PostDriverRemittanceResult>("post_driver_remittance", {
      payload: {
        receivedNativeUsdCents: 0,
        receivedNativeLbp: 0,
        amountMagnitudeCents: 0,
        ...input,
      },
    });
  },
};
