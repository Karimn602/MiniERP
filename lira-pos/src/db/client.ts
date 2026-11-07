import { invoke } from "@tauri-apps/api/core";

/**
 * The frontend's database access. READ-ONLY, and not by convention.
 *
 * WHAT CHANGED IN GATE 2A
 *
 * This module used to hold a `@tauri-apps/plugin-sql` handle and export both
 * `query()` and `execute()`. The capability file granted `sql:allow-execute`,
 * so `execute()` meant arbitrary SQL against the live database: any code in
 * this webview could run `UPDATE products SET price_incl_vat_cents = 1` or
 * `DELETE FROM sale_payments` without going near a posting command. Every
 * financial guard in this application constrains what the POSTING COMMANDS may
 * write; none of them constrains a second writer on the same tables. So the
 * frontend was not a read model, it was a second writer.
 *
 * `execute()` is gone — deleted rather than deprecated, so there is nothing to
 * call by accident and `tsc` finds every remaining caller. Writes go through
 * their own Rust command: see `src-tauri/src/admin.rs` for the master-data
 * ones and `src-tauri/src/posting.rs` for the financial documents.
 *
 * WHY `query()` IS NOT JUST THE PLUGIN'S SELECT
 *
 * Because the plugin's `select` is not read-only. tauri-plugin-sql 2.4.0
 * implements it as `sqlx::query(sql).fetch_all(pool)` against the read-WRITE
 * pool, with no statement-type check anywhere in the path — so an `UPDATE`
 * handed to `select` executes and returns zero rows, and
 * `UPDATE ... RETURNING` executes and returns rows. Dropping
 * `sql:allow-execute` while keeping `sql:allow-select` would therefore have
 * changed nothing at all. The capability now grants no `sql:*` permission;
 * `query()` invokes `db_select`, which runs against a pool opened
 * `read_only(true)`, so SQLite itself refuses every write.
 *
 * The signature and the row shape are unchanged, which is what kept Gate 2A
 * small: all ~65 call sites across `src/db/repos` work exactly as before.
 */

/**
 * Run one SELECT and return typed rows.
 *
 * Example:
 *   const rows = await query<{ id: string; name: string }>(
 *     "SELECT id, name FROM products WHERE is_active = ?", [1]
 *   );
 *
 * Only `SELECT` (and `WITH ... SELECT`) is accepted. The backend refuses any
 * other statement shape, including `PRAGMA`, and would refuse a write even if
 * the shape check were removed, because the connection cannot write.
 */
export async function query<T = unknown>(
  sql: string,
  bindings: unknown[] = [],
): Promise<T[]> {
  return invoke<T[]>("db_select", { sql, params: bindings });
}
