import Database from "@tauri-apps/plugin-sql";

/**
 * Singleton SQLite connection.
 *
 * The Tauri SQL plugin opens the DB lazily on first `load()` and reuses
 * the same connection across the app's lifetime. We wrap it in a promise
 * so concurrent callers during startup all await the same handle.
 *
 * The "sqlite:" prefix tells the plugin to use the bundled SQLite driver
 * and resolve the file path to the app's data directory automatically.
 */
const DB_URL = "sqlite:lira-pos.db";

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}

/**
 * Convenience for SELECT queries. Returns typed rows.
 * Example:
 *   const rows = await query<{ id: string; name: string }>(
 *     "SELECT id, name FROM products WHERE active = ?", [1]
 *   );
 */
export async function query<T = unknown>(
  sql: string,
  bindings: unknown[] = [],
): Promise<T[]> {
  const db = await getDb();
  return db.select<T[]>(sql, bindings);
}

/**
 * Convenience for INSERT/UPDATE/DELETE. Returns rowsAffected + lastInsertId.
 * Note: with UUID PKs we generally ignore lastInsertId.
 */
export async function execute(
  sql: string,
  bindings: unknown[] = [],
) {
  const db = await getDb();
  return db.execute(sql, bindings);
}