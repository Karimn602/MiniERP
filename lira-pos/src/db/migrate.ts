import { query } from "./client";

/**
 * Frontend-side startup probe.
 *
 * WHAT THIS USED TO DO, AND WHY IT NO LONGER DOES IT
 *
 * This function used to issue two PRAGMAs through the SQL plugin:
 * `foreign_keys = ON` and `journal_mode = WAL`. Gate 2A removed the renderer's
 * `sql:allow-execute` permission, so it has no channel for either - and
 * `journal_mode = WAL` was never a frontend decision in the first place. It is
 * persisted in the database header and the whole Gate 1 backup procedure rests
 * on it: the operator reads the absence of `greaz-pos.db-wal` / `-shm` after a
 * clean close as the signal that the main file is complete and safe to copy.
 * That now happens in `src-tauri/src/db_init.rs`, during application setup, on
 * the trusted side of the boundary.
 *
 * The migrations themselves have not moved house - they were always applied by
 * tauri-plugin-sql on the Rust side - but they are now triggered by the
 * `preload` entry in `tauri.conf.json` during Rust setup rather than by a
 * `Database.load()` call from here.
 *
 * What is left is what the name always promised: a read-only confirmation that
 * the database is open and at the schema version this build expects.
 */
export async function ensureDbReady(): Promise<void> {
  const rows = await query<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM _sqlx_migrations",
  );
  const version = rows[0]?.version ?? null;
  if (version === null) {
    throw new Error(
      "The database reports no applied migrations. The schema is not ready, " +
        "so nothing here can be trusted to read or write correctly.",
    );
  }
  console.info("[db] ready, schema version:", version);
}
