/**
 * STAGE C — THE EXPLICIT COLUMN LISTS NAME REAL COLUMNS, AND THE CASHIER'S
 * LISTS NAME NO CONFIDENTIAL ONE.
 *
 * `src/db/projection.ts` replaced `SELECT *` on every cashier-reachable read of
 * `products`, `sales`, `sale_items` and `shifts`. Two ways that can go wrong
 * that only a real schema can catch:
 *
 *   1. a misspelt column, which would fail the read at the till; and
 *   2. a column the backend's cashier authorizer refuses left in a PUBLIC list,
 *      which would make the cashier's whole read fail — the barcode scan, the
 *      receipt, the shift screen.
 *
 * (2) mirrors `src-tauri/src/read_guard.rs`'s cashier rule — any column whose
 * name contains `cost`, `cogs` or `variance`, plus `shifts.expected_cash_*`.
 * The authority is the Rust authorizer and its own tests; this file keeps the
 * frontend's lists from drifting into a refusal.
 *
 * And (3): the two lists together are EXACTLY the table's columns, so a column
 * a migration adds is a decision somebody has to make here, not a field that
 * silently stops reaching the screen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqlTestDb } from "../helpers/sqlDb";
import {
  PRODUCT_CONFIDENTIAL_COLUMNS,
  PRODUCT_PUBLIC_COLUMNS,
  SALE_CONFIDENTIAL_COLUMNS,
  SALE_ITEM_CONFIDENTIAL_COLUMNS,
  SALE_ITEM_PUBLIC_COLUMNS,
  SALE_PUBLIC_COLUMNS,
  SHIFT_CONFIDENTIAL_COLUMNS,
  SHIFT_PUBLIC_COLUMNS,
} from "../../src/db/projection";

let db: DatabaseSync;
beforeEach(() => {
  db = createSqlTestDb();
});
afterEach(() => {
  db.close();
});

function columnsOf(table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  ).map((r) => r.name);
}

const cashierRefuses = (table: string, column: string) =>
  /cost|cogs|variance/i.test(column) ||
  (table === "shifts" && /^(expected|closing)_cash_/.test(column));

const CASES: [string, readonly string[], readonly string[]][] = [
  ["products", PRODUCT_PUBLIC_COLUMNS, PRODUCT_CONFIDENTIAL_COLUMNS],
  ["sales", SALE_PUBLIC_COLUMNS, SALE_CONFIDENTIAL_COLUMNS],
  ["sale_items", SALE_ITEM_PUBLIC_COLUMNS, SALE_ITEM_CONFIDENTIAL_COLUMNS],
  ["shifts", SHIFT_PUBLIC_COLUMNS, SHIFT_CONFIDENTIAL_COLUMNS],
];

describe.each(CASES)("%s", (table, pub, conf) => {
  it("names only columns the migrated schema has", () => {
    const actual = new Set(columnsOf(table));
    for (const c of [...pub, ...conf]) expect(actual, `${table}.${c}`).toContain(c);
  });

  it("puts no column the cashier authorizer refuses in the public list", () => {
    for (const c of pub) expect(cashierRefuses(table, c), `${table}.${c}`).toBe(false);
  });

  it("covers every column of the table, so a new one is a decision", () => {
    const listed = new Set([...pub, ...conf]);
    const missing = columnsOf(table).filter((c) => !listed.has(c));
    // `sale_items.created_at` and similar housekeeping are allowed to be
    // omitted only if listed here explicitly.
    const deliberatelyOmitted: Record<string, string[]> = {
      sale_items: ["created_at"],
    };
    expect(missing.filter((c) => !(deliberatelyOmitted[table] ?? []).includes(c))).toEqual(
      [],
    );
  });

  it("the public list runs as a query against the real schema", () => {
    expect(() => db.prepare(`SELECT ${pub.join(", ")} FROM ${table} LIMIT 0`).all()).not.toThrow();
  });
});
