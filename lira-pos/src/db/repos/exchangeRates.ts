import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import { todayLocalDate } from "../../lib/dates";
import type { ExchangeRate } from "../types";

interface ExchangeRateRow {
  id: string;
  store_id: string;
  effective_date: string;
  rate_lbp_per_usd: number;
  source: "manual" | "api" | "imported";
  notes: string | null;
  created_at: string;
}

function toDomain(r: ExchangeRateRow): ExchangeRate {
  return {
    id: r.id,
    storeId: r.store_id,
    effectiveDate: r.effective_date,
    rateLbpPerUsd: r.rate_lbp_per_usd,
    source: r.source,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export const exchangeRatesRepo = {
  async list(storeId: string, limit = 100): Promise<ExchangeRate[]> {
    const rows = await query<ExchangeRateRow>(
      `SELECT id, store_id, effective_date, rate_lbp_per_usd, source, notes, created_at
       FROM exchange_rates
       WHERE store_id = ?
       ORDER BY effective_date DESC
       LIMIT ?`,
      [storeId, limit],
    );
    return rows.map(toDomain);
  },

  async findById(id: string): Promise<ExchangeRate | null> {
    const rows = await query<ExchangeRateRow>(
      `SELECT id, store_id, effective_date, rate_lbp_per_usd, source, notes, created_at
       FROM exchange_rates WHERE id = ?`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },

  /** Most recent rate AT-OR-BEFORE a given date — what the POS snapshots. */
  async findApplicableOn(storeId: string, date: string): Promise<ExchangeRate | null> {
    const rows = await query<ExchangeRateRow>(
      `SELECT id, store_id, effective_date, rate_lbp_per_usd, source, notes, created_at
       FROM exchange_rates
       WHERE store_id = ? AND effective_date <= ?
       ORDER BY effective_date DESC
       LIMIT 1`,
      [storeId, date],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },

  /**
   * "Get current rate." Throws NO_EXCHANGE_RATE_SET if zero rates exist;
   * the UI catches and routes to the Exchange Rate screen.
   */
  async getCurrentForToday(storeId: string): Promise<ExchangeRate> {
    const rate = await this.findApplicableOn(storeId, todayLocalDate());
    if (!rate) throw new Error("NO_EXCHANGE_RATE_SET");
    return rate;
  },

  /** Upsert by (store_id, effective_date). Preserves existing row id on update. */
  async upsert(args: {
    storeId: string;
    effectiveDate: string;
    rateLbpPerUsd: number;
    source?: "manual" | "api" | "imported";
    notes?: string | null;
    createdByUserId?: string | null;
  }): Promise<{ id: string }> {
    if (!Number.isInteger(args.rateLbpPerUsd) || args.rateLbpPerUsd <= 0) {
      throw new Error(`Invalid rate: ${args.rateLbpPerUsd}`);
    }

    const existing = await query<{ id: string }>(
      `SELECT id FROM exchange_rates
       WHERE store_id = ? AND effective_date = ?`,
      [args.storeId, args.effectiveDate],
    );

    if (existing[0]) {
      await execute(
        `UPDATE exchange_rates
            SET rate_lbp_per_usd = ?, source = ?, notes = ?
          WHERE id = ?`,
        [
          args.rateLbpPerUsd,
          args.source ?? "manual",
          args.notes ?? null,
          existing[0].id,
        ],
      );
      return { id: existing[0].id };
    }

    const id = newId();
    await execute(
      `INSERT INTO exchange_rates
         (id, store_id, effective_date, rate_lbp_per_usd, source, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        args.storeId,
        args.effectiveDate,
        args.rateLbpPerUsd,
        args.source ?? "manual",
        args.notes ?? null,
        args.createdByUserId ?? null,
      ],
    );
    return { id };
  },
};