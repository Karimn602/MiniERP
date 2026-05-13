import { query } from "../client";
import type { UnitOfMeasure } from "../types";

interface UomRow {
  code: string;
  name: string;
  category: "count" | "weight" | "volume" | "length" | "other";
  symbol: string;
  is_active: number;
}

function toDomain(row: UomRow): UnitOfMeasure {
  return {
    code: row.code,
    name: row.name,
    category: row.category,
    symbol: row.symbol,
    isActive: row.is_active === 1,
  };
}

export const uomsRepo = {
  async listActive(): Promise<UnitOfMeasure[]> {
    const rows = await query<UomRow>(
      `SELECT code, name, category, symbol, is_active
       FROM units_of_measure
       WHERE is_active = 1
       ORDER BY category, name`,
    );
    return rows.map(toDomain);
  },

  async findByCode(code: string): Promise<UnitOfMeasure | null> {
    const rows = await query<UomRow>(
      `SELECT code, name, category, symbol, is_active
       FROM units_of_measure WHERE code = ?`,
      [code],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },
};