//! Startup database initialisation, and the gate that makes it mandatory.
//!
//! WHAT MOVED HERE, AND WHY IT HAD TO
//!
//! `src/db/migrate.ts::ensureDbReady` used to issue two PRAGMAs through the SQL
//! plugin's `execute`:
//!
//! ```text
//!     PRAGMA foreign_keys = ON;
//!     PRAGMA journal_mode = WAL;
//! ```
//!
//! Gate 2A removed the renderer's `sql:allow-execute` permission, so it has no
//! channel for either — and one of them is not a preference.
//! `journal_mode = WAL` is persisted in the database header and the ENTIRE
//! Gate 1 backup procedure is built on it: the operator reads the absence of
//! `greaz-pos.db-wal` / `-shm` after a clean close as the signal that the main
//! file is complete and safe to copy. A build that quietly stopped opening in
//! WAL would not look broken; it would just change what those files mean, and
//! `docs/BACKUP.md` would be describing a different application.
//!
//! `tests::lifecycle::sqlx_does_not_open_in_wal_the_frontend_pragma_does` is
//! the test that pinned this down in the first place: sqlx does NOT open SQLite
//! in WAL, so somebody has to ask. Until Gate 2A that somebody was the
//! frontend. Now it is here, which is where it should always have been — the
//! journal mode of the shop's database is not a decision for a webview.
//!
//! WHAT THIS WORK PACKAGE CHANGED: THE FAILURE BEHAVIOUR
//!
//! Gate 2A moved the statement and left its failure handling as it found it.
//! `lib.rs` matched on the result and, for both bad outcomes — an `Err`, or an
//! `Ok` reporting a journal mode that is not `wal` — printed a line to `stderr`
//! and carried on into trading mode. Independent review called that out, and it
//! was right to. The reasoning behind it ("the till must still open") is a real
//! concern on a shop floor, but the consequence is the worse of the two: Greaz
//! would take an evening's money onto a database whose backup procedure no
//! longer describes it, with nothing on screen to say so, and the operator
//! would copy a main file that was never the whole story. A till that refuses
//! to open costs a bad evening; a till that trades onto an unbackupable
//! database loses the record of one.
//!
//! So startup validation now FAILS CLOSED, in three parts:
//!
//! 1. [`verify_database_ready`] proves the schema is completely applied and
//!    that the journal mode really is `wal`, verified on a connection that did
//!    not issue the statement.
//! 2. On any failure `lib.rs` shuts [`crate::posting::DbState`]'s startup gate
//!    and releases the pools. The gate is checked before any pool is opened,
//!    so no sale, refund, shift, catalog, recipe or administrative command can
//!    run, and the renderer's `db_select` cannot read either.
//! 3. The renderer's boot probe (`ensureDbReady`) is therefore refused with the
//!    operator-facing text from [`fatal_startup_message`], which `App.tsx`
//!    already renders on its "Startup failed" screen. That screen IS the
//!    message; there is no second piece of UI to build.
//!
//! There is deliberately NO fallback to another journal mode. Falling back to
//! `delete` would leave a database that works perfectly and silently violates
//! the backup procedure — exactly the state this correction exists to make
//! unreachable.
//!
//! ORDERING
//!
//! tauri-plugin-sql runs the migrations during its own `setup`, from the
//! `preload` list in `tauri.conf.json`, which happens before the application
//! `setup` hook that calls [`initialize_database`]. That is the same order as
//! before: `ensureDbReady` also ran after `Database.load()` had migrated. So on
//! a first launch the migrations apply in SQLite's default journal mode and the
//! database is switched to WAL immediately afterwards, exactly as it always
//! was. `journal_mode` persists in the header, so every later launch is already
//! in WAL and the statement is a no-op that returns `"wal"`.
//!
//! A failure INSIDE the plugin's setup — the preload connection, or a migration
//! that errors or whose checksum has changed — surfaces earlier still, out of
//! `tauri::Builder::build()`. `lib.rs` handles that case explicitly rather than
//! leaving it to `.expect()`; see the comment there.
//!
//! `PRAGMA foreign_keys` is deliberately NOT set here. It is per-CONNECTION and
//! not persistent, so a single statement at startup would only ever configure
//! one connection of one pool — the GZ-G2A-P1 defect in miniature. Each pool
//! asks for it where its connections are established, through
//! `SqliteConnectOptions::foreign_keys(true)`: `posting::open_write_pool` for
//! the pool every transactional command shares, and
//! `read_api::open_read_only_pool` for the renderer's read pool.

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row, SqlitePool};

/// Shown when something asks for the database before validation has finished.
///
/// Not reachable from the running application — the setup hook blocks before
/// the run loop starts and before the webview loads — but the gate refuses
/// `Pending` as firmly as `Failed`, and a refusal needs words.
pub(crate) const STARTUP_NOT_COMPLETE: &str =
    "Greaz is still checking the database, so nothing can be read or written yet. \
     If this does not clear in a moment, close Greaz completely and open it again.";

/// Wrap a technical reason in something an operator can act on.
///
/// This string is what the cashier sees, verbatim, on `App.tsx`'s "Startup
/// failed" screen, and it is also what goes to `stderr`. It names the one thing
/// that matters (do not take payments), the one thing that usually fixes it
/// (close it properly and reopen), and the one thing that must not be done
/// (deleting the database files to make the message go away).
pub(crate) fn fatal_startup_message(reason: &str) -> String {
    format!(
        "GREAZ CANNOT TRADE — the database did not start up correctly.\n\
         \n\
         {reason}\n\
         \n\
         WHAT TO DO NOW\n\
         1. Do not take payments on this machine while this message is showing.\n\
         2. Close Greaz completely. Make sure no second copy of it is still\n\
         \x20  running, then open it again.\n\
         3. If this message comes back, write it down exactly and get help\n\
         \x20  before trading.\n\
         4. Do NOT delete greaz-pos.db, greaz-pos.db-wal or greaz-pos.db-shm.\n\
         \x20  Those files are the shop's records, and the last two are part of\n\
         \x20  the database rather than scratch files.\n\
         \n\
         Nothing is being recorded while this message is showing: sales, refunds,\n\
         shifts and administrative changes are all refused until the database\n\
         starts up correctly."
    )
}

/// Validate the production database, and report the journal mode it is in.
///
/// Called once, from `lib.rs`'s setup hook. `Ok` is the ONLY outcome that opens
/// the startup gate; every `Err` is a refusal to trade.
pub(crate) async fn initialize_database(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, crate::posting::DbState>,
) -> Result<String, String> {
    let path = crate::posting::resolve_db_path(app)?;
    // The one ungated open in the application. It is what decides the gate.
    let pool = crate::posting::pool_for_startup_validation(state, &path).await?;
    verify_database_ready(&pool, &path).await
}

/// Everything [`initialize_database`] checks, against a pool and a path.
///
/// Separated from the Tauri plumbing so `tests::startup_gate` drives the REAL
/// validation against real disposable databases — a complete one, one stopped
/// short of the current schema, one with a migration recorded as failed, and
/// one with no migration history at all — rather than a re-typed imitation of
/// it.
///
/// Returns the journal mode as independently observed, which is always `"wal"`
/// on success.
pub(crate) async fn verify_database_ready(
    pool: &SqlitePool,
    path: &std::path::Path,
) -> Result<String, String> {
    require_complete_migrations(pool).await?;

    // Persisted in the database header, so this is idempotent and cheap after
    // the first launch. It returns the resulting mode as a row.
    let set: String = sqlx::query("PRAGMA journal_mode = WAL")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("PRAGMA journal_mode = WAL failed: {e}"))?
        .try_get(0)
        .map_err(|e| format!("cannot read the resulting journal_mode: {e}"))?;
    require_wal(
        &set.to_ascii_lowercase(),
        "the statement that sets it reported",
    )?;

    // AND VERIFY IT INDEPENDENTLY. The statement above reports what the
    // connection that issued it believes; this reads the mode back on a
    // connection that did not, which is what proves the change reached the
    // file header rather than one session. A SET that reports `wal` while a
    // fresh connection reports something else is precisely the silent state
    // the backup procedure cannot survive.
    let observed = journal_mode_on_a_fresh_connection(path).await?;
    require_wal(&observed, "a second, independent connection reports")?;

    Ok(observed)
}

/// The only place that decides what an acceptable journal mode is.
///
/// Note what this does NOT do: it does not try another mode, and nothing else
/// in this module issues a `journal_mode` statement at all. A silent fall back
/// to `delete` would produce a database that trades perfectly and cannot be
/// backed up by the documented procedure.
pub(crate) fn require_wal(mode: &str, what: &str) -> Result<(), String> {
    if mode == "wal" {
        return Ok(());
    }
    Err(format!(
        "The database is not in WAL journal mode: {what} `{mode}`. Greaz will \
         not trade in any other journal mode, because the documented backup \
         procedure reads the absence of greaz-pos.db-wal and greaz-pos.db-shm \
         after a clean close as proof that the main file holds everything. In \
         `{mode}` those files never appear at all, so that check would pass \
         over a copy nobody has verified. The usual cause is a second copy of \
         Greaz holding the same database open."
    ))
}

/// Read `journal_mode` on a brand-new connection of its own.
///
/// Writable rather than read-only on purpose: a READ-ONLY connection to a
/// WAL database needs the `-shm` file and cannot create it (see the ordering
/// note in `read_api::read_pool`), so a read-only probe could fail for a reason
/// that has nothing to do with the question being asked. This connection is
/// opened, asked one thing and closed; `create_if_missing(false)` means it can
/// never bring a database into existence to answer about.
pub(crate) async fn journal_mode_on_a_fresh_connection(
    path: &std::path::Path,
) -> Result<String, String> {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .connect()
        .await
        .map_err(|e| {
            format!(
                "cannot reopen {} to verify its journal mode: {e}",
                path.display()
            )
        })?;

    let mode: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| format!("cannot read journal_mode back: {e}"))?
        .try_get(0)
        .map_err(|e| format!("cannot decode journal_mode: {e}"))?;

    // Best effort: the answer is already in hand, and a failure to close this
    // one short-lived connection must not be reported as a startup fault.
    let _ = conn.close().await;

    Ok(mode.to_ascii_lowercase())
}

/// Every migration this build registers must be applied, and successfully.
///
/// WHY THIS IS CHECKED HERE AS WELL AS BY THE PLUGIN. tauri-plugin-sql runs the
/// migrations inside its own setup and a failure there aborts
/// `tauri::Builder::build()`, so the common case is already fail-closed. This
/// catches the state that reaches us from somewhere else: a database migrated
/// by a different build, one whose migration run was interrupted, or one that
/// recorded a failure. The alternative is a POS that opens on a schema missing
/// the triggers every financial invariant in this project is enforced by —
/// usable, and wrong in ways nothing on screen would show.
///
/// A database carrying migrations BEYOND this build's list is deliberately not
/// refused here. That is a downgrade, it is a different question, and inventing
/// a policy for it would be a new rule rather than a correction.
pub(crate) async fn require_complete_migrations(pool: &SqlitePool) -> Result<(), String> {
    let expected: Vec<i64> = crate::migrations().iter().map(|m| m.version).collect();

    let history_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master \
         WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| format!("cannot read the database's schema catalogue: {e}"))?;

    if history_exists == 0 {
        return Err(format!(
            "The database has no migration history at all: the \
             _sqlx_migrations table is missing, so none of the {} migrations \
             this version of Greaz needs has been applied. Either the file is \
             not a Greaz database, or it was created and never set up.",
            expected.len()
        ));
    }

    let failed: Vec<i64> = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = 0 ORDER BY version",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("cannot read the migration history: {e}"))?;

    if !failed.is_empty() {
        return Err(format!(
            "The database records migration(s) {failed:?} as having FAILED. \
             The schema is half-applied, so the financial rules Greaz relies \
             on are not all in place. This database has to be restored from a \
             backup rather than traded on."
        ));
    }

    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success = 1")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("cannot read the migration history: {e}"))?;

    let missing: Vec<i64> = expected
        .iter()
        .copied()
        .filter(|v| !applied.contains(v))
        .collect();

    if !missing.is_empty() {
        return Err(format!(
            "The database schema is incomplete: migration(s) {missing:?} of \
             the {} this version of Greaz needs have not been applied. Some of \
             the rules that protect sales, stock and cost figures are \
             therefore missing from this database.",
            expected.len()
        ));
    }

    Ok(())
}

/// Let go of every pool this process opened, after startup has been refused.
///
/// ORDER IS THE SAME AS THE EXIT PATH AND FOR THE SAME REASON: only a
/// connection that may WRITE can run SQLite's final checkpoint, so the
/// read-only pool is retired first and a writable one last. In practice the
/// read-only pool has never been opened at this point, because nothing has
/// been able to read yet; it is closed anyway, because a cleanup that depends
/// on knowing which handles happen to exist is a cleanup that breaks later.
///
/// What this does NOT do is remove `-wal` / `-shm` immediately:
/// tauri-plugin-sql still holds its own preload pool, and SQLite only
/// checkpoints when the LAST connection closes. The plugin releases it on
/// `RunEvent::Exit`, and because ours are already gone by then its writable
/// connection is the last one — so a refused startup followed by a clean close
/// still leaves one self-contained file, which is what `docs/BACKUP.md` step 3
/// depends on. Pinned by
/// `tests::startup_gate::a_refused_startup_still_leaves_one_self_contained_file`.
pub(crate) async fn release_pools_after_failed_startup(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, crate::posting::DbState>,
) {
    use tauri::Manager;

    crate::read_api::close_read_pool(&app.state::<crate::read_api::ReadPool>()).await;
    state.close_pool().await;
}
