import { invoke } from "@tauri-apps/api/core";

import { query } from "../client";
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

  /**
   * Upsert by (store_id, effective_date). Preserves the existing row id.
   *
   * Goes through `exchange_rate_save` (Gate 2A). This used to be a SELECT and
   * then an UPDATE-or-INSERT as three separate round trips from here, which is
   * two problems in one: the read and the write could interleave with another
   * caller and race on the unique index, and - the reason it had to move - the
   * renderer could write the very row `post_sale` validates a sale's locked
   * rate against. The validator and its reference sat on the same side of the
   * boundary, so a favourable rate could be typed in and every check would
   * still pass. The backend now resolves and writes it in ONE transaction.
   *
   * Refusals arrive as stable codes: EXCHANGE_RATE_MUST_BE_POSITIVE,
   * EXCHANGE_RATE_OUT_OF_RANGE, EXCHANGE_RATE_BAD_EFFECTIVE_DATE,
   * EXCHANGE_RATE_BAD_SOURCE, UNKNOWN_STORE.
   */
  async upsert(args: {
    storeId: string;
    effectiveDate: string;
    rateLbpPerUsd: number;
    source?: "manual" | "api" | "imported";
    notes?: string | null;
    createdByUserId?: string | null;
  }): Promise<{ id: string }> {
    // Kept here as well as in Rust: a local throw gives the Exchange Rate
    // screen an immediate, specific message. It is not a guarantee about
    // anything - the backend refuses the same figure again.
    if (!Number.isInteger(args.rateLbpPerUsd) || args.rateLbpPerUsd <= 0) {
      throw new Error(`Invalid rate: ${args.rateLbpPerUsd}`);
    }

    const id = await invoke<string>("exchange_rate_save", {
      args: {
        id: newId(),
        storeId: args.storeId,
        effectiveDate: args.effectiveDate,
        rateLbpPerUsd: args.rateLbpPerUsd,
        source: args.source ?? "manual",
        notes: args.notes ?? null,
        createdByUserId: args.createdByUserId ?? null,
      },
    });
    return { id };
  },
};