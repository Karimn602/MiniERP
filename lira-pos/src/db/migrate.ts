import { getDb } from "./client";

/**
 * Frontend-side migration verification.
 *
 * The HEAVY lifting (creating tables on first launch) is done by the Rust
 * side via tauri-plugin-sql's `add_migrations`. This function exists to:
 *   1. Confirm the DB opened successfully on app startup.
 *   2. Apply quick PRAGMAs that the plugin doesn't set for us.
 *   3. Be the future home for any frontend-only post-migration steps.
 */
export async function ensureDbReady(): Promise<void> {
  const db = await getDb();
  // Foreign keys are OFF by default in SQLite — turn them on per-connection.
  await db.execute("PRAGMA foreign_keys = ON;");
  // Write-Ahead Logging: faster writes, safer crashes.
  await db.execute("PRAGMA journal_mode = WAL;");
  // Sanity probe: pull the schema_version the plugin maintains.
  const rows = await db.select<{ version: number }[]>(
    "SELECT MAX(version) AS version FROM _sqlx_migrations",
  );
  console.info("[db] ready, schema version:", rows[0]?.version);
}