import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import type {
  Supplier,
  SupplierLedgerEntry,
  SupplierLedgerEntryType,
  SupplierWithBalance,
} from "../types";

interface LedgerRow {
  id: string;
  store_id: string;
  supplier_id: string;
  entry_date: string;
  entry_type: SupplierLedgerEntryType;
  amount_signed_cents: number;
  related_purchase_id: string | null;
  related_payment_id: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  device_id: string | null;
  created_at: string;
  posted_at: string;
}

function toDomain(r: LedgerRow): SupplierLedgerEntry {
  return {
    id: r.id,
    storeId: r.store_id,
    supplierId: r.supplier_id,
    entryDate: r.entry_date,
    entryType: r.entry_type,
    amountSignedCents: r.amount_signed_cents,
    relatedPurchaseId: r.related_purchase_id,
    relatedPaymentId: r.related_payment_id,
    notes: r.notes,
    createdByUserId: r.created_by_user_id,
    deviceId: r.device_id,
    createdAt: r.created_at,
    postedAt: r.posted_at,
  };
}

interface BalanceRow {
  supplier_id: string;
  balance_cents: number | null;
  last_activity_at: string | null;
}

export const supplierLedgerRepo = {
  async listForSupplier(supplierId: string, limit = 200): Promise<SupplierLedgerEntry[]> {
    const rows = await query<LedgerRow>(
      `SELECT * FROM supplier_ledger_entries
       WHERE supplier_id = ?
       ORDER BY entry_date DESC, posted_at DESC
       LIMIT ?`,
      [supplierId, limit],
    );
    return rows.map(toDomain);
  },

  async getBalance(supplierId: string): Promise<number> {
    const rows = await query<{ balance: number | null }>(
      `SELECT COALESCE(SUM(amount_signed_cents), 0) AS balance
         FROM supplier_ledger_entries
        WHERE supplier_id = ?`,
      [supplierId],
    );
    return rows[0]?.balance ?? 0;
  },
  async postEntry(args: {
  storeId: string;
  supplierId: string;
  entryType: SupplierLedgerEntryType;
  amountCents: number;
  entryDate: string;
  paymentReference?: string | null;
  notes?: string | null;
  createdByUserId?: string | null;
  deviceId?: string | null;
}): Promise<{ id: string }> {
  if (!Number.isInteger(args.amountCents) || args.amountCents === 0) {
    throw new Error("Ledger entry amount must be a non-zero integer.");
  }

  const id = newId();

  const noteParts = [
    args.notes?.trim() || null,
    args.paymentReference?.trim()
      ? `ref: ${args.paymentReference.trim()}`
      : null,
  ].filter(Boolean);

  const notes = noteParts.length > 0 ? noteParts.join("\n") : null;

  await execute(
    `INSERT INTO supplier_ledger_entries (
       id, store_id, supplier_id, entry_date, entry_type,
       amount_signed_cents, related_purchase_id, related_payment_id,
       notes, created_by_user_id, device_id, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [
      id,
      args.storeId,
      args.supplierId,
      args.entryDate,
      args.entryType,
      args.amountCents,
      notes,
      args.createdByUserId ?? null,
      args.deviceId ?? null,
    ],
  );

  return { id };
},
  /**
   * Fetch all suppliers with their running balance and last-activity stamp
   * in one query. Used by the Suppliers list page.
   */
  async listBalances(storeId: string): Promise<Map<string, { balanceCents: number; lastActivityAt: string | null }>> {
    const rows = await query<BalanceRow>(
      `SELECT supplier_id,
              COALESCE(SUM(amount_signed_cents), 0) AS balance_cents,
              MAX(posted_at) AS last_activity_at
         FROM supplier_ledger_entries
        WHERE store_id = ?
        GROUP BY supplier_id`,
      [storeId],
    );
    const m = new Map<string, { balanceCents: number; lastActivityAt: string | null }>();
    for (const r of rows) {
      m.set(r.supplier_id, {
        balanceCents: r.balance_cents ?? 0,
        lastActivityAt: r.last_activity_at,
      });
    }
    return m;
  },

  /**
   * Manually record an opening balance for an existing supplier
   * (the amount we already owed them before adopting the app).
   * Single insert — no transaction needed.
   */
  async postOpeningBalance(args: {
    storeId: string;
    supplierId: string;
    entryDate: string;
    amountSignedCents: number;
    notes?: string | null;
    createdByUserId?: string | null;
  }): Promise<void> {
    if (args.amountSignedCents === 0) {
      throw new Error("Opening balance must be non-zero.");
    }
    await execute(
      `INSERT INTO supplier_ledger_entries
         (id, store_id, supplier_id, entry_date, entry_type,
          amount_signed_cents, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, 'opening_balance', ?, ?, ?)`,
      [
        newId(),
        args.storeId,
        args.supplierId,
        args.entryDate,
        args.amountSignedCents,
        args.notes ?? null,
        args.createdByUserId ?? null,
      ],
    );
  },
};

/**
 * Convenience: zip suppliers with their balance from one round-trip.
 */
export async function decorateSuppliersWithBalances(
  storeId: string,
  suppliers: Supplier[],
): Promise<SupplierWithBalance[]> {
  const balances = await supplierLedgerRepo.listBalances(storeId);
  return suppliers.map((s) => {
    const b = balances.get(s.id);
    return {
      ...s,
      balanceCents: b?.balanceCents ?? 0,
      lastActivityAt: b?.lastActivityAt ?? null,
    };
  });
}