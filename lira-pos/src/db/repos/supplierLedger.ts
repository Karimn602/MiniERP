import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
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
  amount_cents: number;
  related_purchase_id: string | null;
  payment_reference: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  device_id: string | null;
  posted_at: string;
}

interface PostSupplierLedgerResult {
  ledgerEntryId: string;
  postedAt: string;
  newBalanceCents: number;
}

function toDomain(r: LedgerRow): SupplierLedgerEntry {
  return {
    id: r.id,
    storeId: r.store_id,
    supplierId: r.supplier_id,
    entryDate: r.entry_date,
    entryType: r.entry_type,
    amountSignedCents: r.amount_cents,
    relatedPurchaseId: r.related_purchase_id,
    relatedPaymentId: r.payment_reference,
    notes: r.notes,
    createdByUserId: r.created_by_user_id,
    deviceId: r.device_id,
    createdAt: r.posted_at,
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
      `SELECT * FROM supplier_ledger
       WHERE supplier_id = ?
       ORDER BY entry_date DESC, posted_at DESC
       LIMIT ?`,
      [supplierId, limit],
    );
    return rows.map(toDomain);
  },

  async getBalance(supplierId: string): Promise<number> {
    const rows = await query<{ balance: number | null }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS balance
         FROM supplier_ledger
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

    const ledgerEntryId = newId();

    const result = await invoke<PostSupplierLedgerResult>("post_supplier_payment", {
      payload: {
        ledgerEntryId,
        storeId: args.storeId,
        supplierId: args.supplierId,
        entryType: args.entryType,
        amountCents: args.amountCents,
        entryDate: args.entryDate,
        paymentReference: args.paymentReference?.trim() || null,
        notes: args.notes?.trim() || null,
        createdByUserId: args.createdByUserId ?? null,
        deviceId: args.deviceId ?? null,
      },
    });

    return { id: result.ledgerEntryId };
  },

  async listBalances(
    storeId: string,
  ): Promise<Map<string, { balanceCents: number; lastActivityAt: string | null }>> {
    const rows = await query<BalanceRow>(
      `SELECT supplier_id,
              COALESCE(SUM(amount_cents), 0) AS balance_cents,
              MAX(posted_at) AS last_activity_at
         FROM supplier_ledger
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

  async postOpeningBalance(args: {
    storeId: string;
    supplierId: string;
    entryDate: string;
    amountSignedCents: number;
    notes?: string | null;
    createdByUserId?: string | null;
  }): Promise<void> {
    await this.postEntry({
      storeId: args.storeId,
      supplierId: args.supplierId,
      entryType: "opening_balance",
      amountCents: args.amountSignedCents,
      entryDate: args.entryDate,
      notes: args.notes ?? null,
      createdByUserId: args.createdByUserId ?? null,
      deviceId: null,
    });
  },
};

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