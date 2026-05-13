import { query } from "../client";
import type { VatRate } from "../types";

interface VatRateRow {
  id: string;
  name: string;
  rate_bps: number;
  is_exempt: number;
  effective_from: string;
  effective_to: string | null;
}

function toDomain(row: VatRateRow): VatRate {
  return {
    id: row.id,
    name: row.name,
    rateBps: row.rate_bps,
    isExempt: row.is_exempt === 1,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

/**
 * VAT rates repo. Rates are append-only in practice (when the law changes,
 * INSERT a new row and set effective_to on the old one). No update/delete here.
 */
export const vatRatesRepo = {
  async listActive(): Promise<VatRate[]> {
    const rows = await query<VatRateRow>(
      `SELECT id, name, rate_bps, is_exempt, effective_from, effective_to
       FROM vat_rates
       WHERE effective_to IS NULL OR effective_to >= date('now')
       ORDER BY effective_from DESC, name`,
    );
    return rows.map(toDomain);
  },

  async findById(id: string): Promise<VatRate | null> {
    const rows = await query<VatRateRow>(
      `SELECT id, name, rate_bps, is_exempt, effective_from, effective_to
       FROM vat_rates WHERE id = ?`,
      [id],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },

  /**
   * Get the rate applicable at a given date. Phase 1 just returns by id and
   * verifies temporal validity; "rate lineage" (same logical rate, different
   * versions over time) comes in Phase 5 when we actually change a rate.
   */
  async findApplicableAt(date: string, ratePrototypeId: string): Promise<VatRate | null> {
    const rate = await this.findById(ratePrototypeId);
    if (!rate) return null;
    if (rate.effectiveFrom > date) return null;
    if (rate.effectiveTo !== null && rate.effectiveTo <= date) return null;
    return rate;
  },
};