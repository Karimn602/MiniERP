//! Startup database initialisation, moved out of the renderer by Gate 2A.
//!
//! WHAT MOVED, AND WHY IT HAD TO
//!
//! `src/db/migrate.ts::ensureDbReady` used to issue two PRAGMAs through the SQL
//! plugin's `execute`:
//!
//! ```text
//!     PRAGMA foreign_keys = ON;
//!     PRAGMA journal_mode = WAL;
//! ```
//!
//! Gate 2A removes `sql:allow-execute` from the renderer, so those two
//! statements no longer have a channel — and one of them is not a preference.
//! `journal_mode = WAL` is persisted in the database header and the ENTIRE
//! Gate 1 backup procedure is built on it: the operator reads the absence of
//! `greaz-pos.db-wal` / `-shm` after a clean close as the signal that the main
//! file is complete and safe to copy. A build that quietly stopped opening in
//! WAL would not look broken; it would just change what those files mean, and
//! `docs/BACKUP.md` would be describing a different application.
//!
//! `lifecycle.rs::sqlx_does_not_open_in_wal_the_frontend_pragma_does` is the
//! test that pinned this down in the first place: sqlx does NOT open SQLite in
//! WAL, so somebody has to ask. Until now that somebody was the frontend. Now
//! it is here, which is where it should always have been — the journal mode of
//! the shop's database is not a decision for a webview.
//!
//! ORDERING
//!
//! tauri-plugin-sql runs the migrations during its own `setup`, from the
//! `preload` list in `tauri.conf.json`, which happens before the application
//! `setup` hook that calls [`ensure_production_pragmas`]. That is the same
//! order as before: `ensureDbReady` also ran after `Database.load()` had
//! migrated. So on a first launch the migrations apply in SQLite's default
//! journal mode and the database is switched to WAL immediately afterwards,
//! exactly as it always was. `journal_mode` persists in the header, so every
//! later launch is already in WAL and the statement is a no-op that returns
//! `"wal"`.
//!
//! `PRAGMA foreign_keys` is deliberately NOT set here. It is per-CONNECTION,
//! not persistent, so a single statement at startup would only ever configure
//! one connection of one pool. Each pool asks for it where it is opened:
//! `posting::pool` for the read-write pool the posting commands share, and
//! `read_api` through `SqliteConnectOptions::foreign_keys(true)` for the
//! read-only pool. See the note in the Gate 2A report about the pre-existing
//! narrowness of the posting pool's version — it is unchanged here on purpose,
//! because widening it is a behavioural change to posting and not a security
//! boundary.

use sqlx::Row;

/// Put the production database into the journal mode the backup procedure
/// assumes, and report what it is actually in.
///
/// Returns the resulting `journal_mode`. A caller that gets back anything but
/// `"wal"` should treat it as a startup fault rather than a cosmetic one: the
/// documented backup procedure no longer describes the running application.
pub(crate) async fn ensure_production_pragmas(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, crate::posting::DbState>,
) -> Result<String, String> {
    let pool = crate::posting::pool(app, state).await?;

    // Persisted in the database header, so this is idempotent and cheap after
    // the first launch. It returns the resulting mode as a row.
    let mode: String = sqlx::query("PRAGMA journal_mode = WAL")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("PRAGMA journal_mode = WAL failed: {e}"))?
        .try_get(0)
        .map_err(|e| format!("cannot read the resulting journal_mode: {e}"))?;

    Ok(mode.to_ascii_lowercase())
}
