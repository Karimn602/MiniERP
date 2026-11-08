//! THE FRONTEND'S ONLY DATABASE ACCESS, AND IT IS READ-ONLY BY CONSTRUCTION.
//!
//! WHY THIS MODULE EXISTS
//!
//! Until Gate 2A the renderer held `sql:allow-execute`, which through
//! `src/db/client.ts` meant arbitrary SQL against the live database: a webview
//! that could run `UPDATE products SET price_incl_vat_cents = 1` or
//! `DELETE FROM sale_payments` without calling a single posting command. Every
//! financial guard in this application is a guard on what the POSTING COMMANDS
//! may write; none of them is a guard on what a second writer may do to the
//! same tables. So the renderer was not a read model, it was a second writer.
//!
//! THE TRAP THAT SHAPED THIS MODULE
//!
//! Dropping `sql:allow-execute` and keeping `sql:allow-select` does NOT produce
//! a read-only frontend, and assuming it would is the mistake this module
//! exists to make impossible. tauri-plugin-sql 2.4.0's `select` is, verbatim
//! (`wrapper.rs:214`):
//!
//! ```text
//!     let mut query = sqlx::query(&_query);
//!     ...
//!     let rows = pool.fetch_all(query).await?;
//! ```
//!
//! There is no statement-type check anywhere in that path. `fetch_all` against
//! a read-WRITE pool runs whatever it is given: an `UPDATE` executes and
//! returns zero rows, and `UPDATE ... RETURNING` executes AND returns rows, so
//! it is not even a silent channel — it is a convenient one. `select` was
//! therefore a complete write channel wearing a read name.
//! `tests::sql_boundary` proves this against a real database rather than
//! asserting it from the source.
//!
//! WHAT ACTUALLY ENFORCES READ-ONLY HERE
//!
//! Not the command's name, and not the statement sniffing below. The boundary
//! is the CONNECTION: this pool is opened `read_only(true)`, so SQLite itself
//! refuses every write with `attempt to write a readonly database`. That is a
//! property of the file handle, decided when the connection is opened, and no
//! statement sent afterwards can relax it.
//!
//! Three measures, and it is worth being exact about which of them is load
//! bearing, because two of the three are not:
//!
//!   1. `read_only(true)` — **THE BOUNDARY**, and the only one of the three
//!      that is. SQLite opens the file read-only, so every write fails with
//!      `attempt to write a readonly database` (code 8) regardless of what the
//!      connection is asked to do afterwards.
//!   2. `PRAGMA query_only = ON` on every connection in the pool — a cheap
//!      earlier refusal, and **NOT an independent boundary**. It was described
//!      as one in the first draft of this module and that was wrong: a probe
//!      against a real connection showed `PRAGMA query_only = OFF` SUCCEEDS on
//!      a read-only handle. It does not matter, because the write that follows
//!      still fails on measure 1 — but it means `query_only` must not be
//!      counted as a second line of defence. If measure 1 were ever lost,
//!      measure 2 would not save anything.
//!      (`tests::sql_boundary::query_only_can_be_turned_off_but_writes_still_fail`
//!      pins exactly that, so nobody re-derives the optimistic version.)
//!   3. The statement guard in [`reject_unless_read_only_shape`] — defence in
//!      depth and a clear error message, NOT a security boundary. A statement
//!      sniffer can always be argued with; a read-only file handle cannot. It
//!      is here so that a developer who writes an `UPDATE` by mistake gets a
//!      sentence telling them which command to use, instead of a SQLite error.
//!
//! The guard also refuses `PRAGMA` and `ATTACH`, and for `ATTACH` it is the
//! ONLY control — stated plainly because the alternative was a comfortable
//! guess. A read-only connection ACCEPTS `ATTACH DATABASE`, and once attached
//! that connection may be able to READ the other file. Whether a LATER
//! statement can is not deterministic — an `ATTACH` binds to one connection of
//! the pool and sqlx chooses which connection serves the next query — so
//! pooling is claimed neither as a defence nor as a hole. What the attachment
//! can never do is be WRITTEN: it inherits the read-only handle, so a write to
//! it fails with code 8 like any other. So the residual, if the guard were ever
//! widened, is read access to another SQLite file — never a write to anything.
//!
//! Two things keep `ATTACH` out of reach in practice: the guard refuses any
//! statement that is not a `SELECT`/`WITH`, and `db_select` takes NO database
//! name as a parameter — the path is resolved in Rust from `app_config_dir()`,
//! so there is nothing on the wire to point elsewhere.
//! `tests::sql_boundary::no_other_database_can_be_reached` asserts every clause
//! of this paragraph, including the uncomfortable ones.
//!
//! `PRAGMA journal_mode`, `foreign_keys` and friends are refused for a
//! different reason: they are startup decisions that belong to
//! [`crate::db_init`], not to a caller.
//!
//! WHAT THIS MODULE DOES NOT DO
//!
//! It does not authenticate, and it does not authorize. Any code running in the
//! renderer may still READ anything — costs, margins, takings, every receipt.
//! Closing that is Gate 2 Stage C (move the reads behind per-role commands) and
//! it is deliberately not attempted here. Gate 2A closes the WRITE boundary
//! only, which is the half that can misstate a financial figure.
//!
//! And it protects nothing against someone holding the database FILE. An
//! unencrypted SQLite file under a shared Windows account defeats every control
//! in this process; see `dev/GATE2-SECURITY-DESIGN.md` §1 threat T9.

use serde_json::{Map, Number, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, SqlitePool, ValueRef};
use tauri::State;
use tokio::sync::Mutex;

/// The lazily-opened READ-ONLY pool, held in Tauri managed state.
///
/// Separate from [`crate::posting::DbState`] on purpose: that one is the
/// read-write pool the posting commands share, and the whole point here is
/// that the frontend never touches it.
pub struct ReadPool {
    /// Crate-visible so `tests::startup_gate` can assert that a refused
    /// startup leaves NO read pool behind, which is a property of this field
    /// rather than of anything observable through the command.
    pub(crate) pool: Mutex<Option<SqlitePool>>,
}

impl ReadPool {
    pub fn new() -> Self {
        Self {
            pool: Mutex::new(None),
        }
    }
}

impl Default for ReadPool {
    fn default() -> Self {
        Self::new()
    }
}

/// Open (once) the read-only pool over the one production database.
///
/// Ordering note, and it is load-bearing: a READ-ONLY connection to a database
/// in WAL mode needs the `-shm` file, and cannot create it. After a clean
/// shutdown both companions are gone (that is exactly what makes the Gate 1
/// backup procedure work), so opening read-only FIRST on a fresh launch can
/// fail with `unable to open database file`. We therefore ensure the read-write
/// pool exists first — it creates the companions — and only then open
/// read-only. `crate::db_init` already opens a read-write connection during
/// setup, so in the running application this is belt and braces; it matters for
/// tests and for any future entry point that reaches a command before setup.
async fn read_pool(
    app: &tauri::AppHandle,
    db_state: &State<'_, crate::posting::DbState>,
    read_state: &State<'_, ReadPool>,
) -> Result<SqlitePool, String> {
    let path = crate::posting::resolve_db_path(app)?;
    read_pool_for_state(db_state, read_state, &path).await
}

/// [`read_pool`] without the `AppHandle`, so `tests::startup_gate` can drive
/// the real read path against a real database.
///
/// GATED, and gated BEFORE the cache is consulted. A read is not harmless after
/// a failed startup: `ensureDbReady` is a read, every repo is a read, and a
/// renderer that could still read would show a till full of figures from a
/// database the application has refused to trade on. The refusal it returns is
/// the operator-facing message itself, which is how it reaches the screen.
pub(crate) async fn read_pool_for_state(
    db_state: &crate::posting::DbState,
    read_state: &ReadPool,
    path: &std::path::Path,
) -> Result<SqlitePool, String> {
    db_state.ensure_trading_allowed().await?;

    {
        let guard = read_state.pool.lock().await;
        if let Some(p) = &*guard {
            return Ok(p.clone());
        }
    }

    // Make sure the WAL companions exist before asking for a read-only handle.
    crate::posting::pool_for_state(db_state, path).await?;

    let p = open_read_only_pool(path).await?;

    let mut guard = read_state.pool.lock().await;
    if let Some(existing) = &*guard {
        // Another task won the race; keep theirs and drop ours.
        let ours = p.clone();
        let winner = existing.clone();
        drop(guard);
        ours.close().await;
        return Ok(winner);
    }
    *guard = Some(p.clone());
    Ok(p)
}

/// Open a READ-ONLY pool over one SQLite file.
///
/// Extracted so the security tests build the pool the same way the command
/// does, rather than a lookalike that could drift from it. If this function is
/// ever relaxed, `tests::sql_boundary` fails — which is the point.
pub(crate) async fn open_read_only_pool(
    path: &std::path::Path,
) -> Result<SqlitePool, String> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        // Never create: if the file is not there, something is wrong and
        // conjuring an empty database is the worst available answer.
        .create_if_missing(false)
        // (1) THE BOUNDARY. Engine-enforced, and no statement can relax it.
        .read_only(true)
        // (2) A second, independent refusal on every connection in the pool.
        .pragma("query_only", "ON")
        // Parity with the read-write pool. Harmless on a read-only handle; kept
        // so a read that joins across a foreign key behaves identically.
        .foreign_keys(true);

    SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .map_err(|e| {
            format!(
                "failed to open the read-only pool at {}: {e}",
                path.display()
            )
        })
}

/// The whole body of [`db_select`] except resolving the pool.
///
/// Separated so the tests drive the real guard and the real binding and
/// decoding against a real database, without a Tauri runtime.
pub(crate) async fn run_select(
    pool: &SqlitePool,
    sql: &str,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    reject_unless_read_only_shape(sql)?;

    let mut q = sqlx::query(sql);
    for v in params {
        q = match v {
            Value::Null => q.bind(None::<String>),
            Value::Bool(b) => q.bind(i64::from(b)),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    q.bind(i)
                } else {
                    q.bind(n.as_f64().unwrap_or_default())
                }
            }
            Value::String(s) => q.bind(s),
            // Arrays and objects are not SQLite values. Bound as their JSON
            // text, which is what tauri-plugin-sql did, so no caller changes
            // behaviour in this release.
            other => q.bind(other.to_string()),
        };
    }

    let rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut obj = Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let name = col.name();
            obj.insert(name.to_string(), column_to_json(row, i, name)?);
        }
        out.push(obj);
    }
    Ok(out)
}

/// Close the read-only pool on application exit.
///
/// This is NOT housekeeping. SQLite folds the WAL back into the main database
/// and removes `-wal` / `-shm` when the LAST connection closes, and
/// `docs/BACKUP.md` step 3 has the operator read the absence of those two files
/// as the signal that `greaz-pos.db` is complete and safe to copy. A pool left
/// open here would leave the companions behind on every clean shutdown and
/// break that signal — the exact defect `lib.rs::close_db_pool_on_exit` was
/// written to fix for the posting pool. Adding a third pool without closing it
/// would have reintroduced it.
pub(crate) async fn close_read_pool(read_state: &ReadPool) {
    let mut guard = read_state.pool.lock().await;
    if let Some(p) = guard.take() {
        p.close().await;
    }
}

/// Reject anything that is not shaped like a read.
///
/// DEFENCE IN DEPTH, NOT THE BOUNDARY — see the module header. Every read in
/// the application is a plain `SELECT` (checked across all of `src/db/repos`),
/// and `WITH` is allowed so a future common-table expression needs no change
/// here.
fn reject_unless_read_only_shape(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim_start();

    // Strip leading SQL comments so `/* hi */ UPDATE ...` cannot walk past the
    // keyword check. (It would still be refused by the connection, but a guard
    // that is trivially side-stepped teaches the wrong lesson.)
    let mut rest = trimmed;
    loop {
        let before = rest;
        rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map(|(_, t)| t).unwrap_or("");
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map(|(_, t)| t).unwrap_or("");
        }
        if rest == before {
            break;
        }
    }

    let head = rest
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_ascii_uppercase();

    if head != "SELECT" && head != "WITH" {
        return Err(format!(
            "db_select accepts SELECT statements only, and this one begins \
             \"{head}\". The frontend has no write access to the database: \
             every write goes through its own Rust command. If you need one \
             that does not exist yet, add the command — do not widen this one."
        ));
    }

    // One statement per call. sqlx prepares only the first statement anyway and
    // the connection is read-only, so this is about clarity rather than
    // protection: a caller stacking statements has misunderstood something.
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = rest.chars().peekable();
    let mut tail_after_semicolon = false;
    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ';' if !in_single && !in_double => {
                if chars.clone().any(|c| !c.is_whitespace()) {
                    tail_after_semicolon = true;
                }
                break;
            }
            _ => {}
        }
    }
    if tail_after_semicolon {
        return Err(
            "db_select accepts exactly one statement per call; this request \
             contains more than one."
                .to_string(),
        );
    }

    Ok(())
}

/// Decode one column of one row into JSON.
///
/// Tried most specific first so an INTEGER stays an integer rather than
/// arriving in JavaScript as `1.0` — the money in this application is integer
/// cents and integer lira, and a float round trip is exactly what
/// `src/lib/money.ts` exists to avoid.
fn column_to_json(row: &SqliteRow, i: usize, name: &str) -> Result<Value, String> {
    let raw = row
        .try_get_raw(i)
        .map_err(|e| format!("cannot read column \"{name}\": {e}"))?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    if let Ok(v) = row.try_get::<i64, _>(i) {
        return Ok(Value::Number(Number::from(v)));
    }
    if let Ok(v) = row.try_get::<f64, _>(i) {
        return Ok(Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null));
    }
    if let Ok(v) = row.try_get::<String, _>(i) {
        return Ok(Value::String(v));
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(i) {
        return Ok(Value::Array(
            v.into_iter().map(|b| Value::Number(Number::from(b))).collect(),
        ));
    }
    Err(format!(
        "column \"{name}\" holds a value this read interface cannot represent"
    ))
}

/// Run one SELECT and return its rows as JSON objects.
///
/// Replaces tauri-plugin-sql's `select` for the frontend. The shape of the
/// result is deliberately identical — an array of column-name-keyed objects —
/// so `src/db/client.ts::query` is a drop-in change and the ~65 call sites
/// across `src/db/repos` need no edits at all. That is what keeps Gate 2A a
/// bounded piece of work rather than a rewrite of every report.
#[tauri::command]
pub async fn db_select(
    app: tauri::AppHandle,
    db_state: State<'_, crate::posting::DbState>,
    read_state: State<'_, ReadPool>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    // The shape guard runs first so a mistaken write gets a useful sentence
    // rather than a SQLite error, but it is the pool that enforces read-only.
    let pool = read_pool(&app, &db_state, &read_state).await?;
    run_select(&pool, &sql, params).await
}

#[cfg(test)]
mod shape_guard_tests {
    use super::reject_unless_read_only_shape as check;

    #[test]
    fn plain_selects_and_ctes_are_accepted() {
        assert!(check("SELECT 1").is_ok());
        assert!(check("  select * from products ").is_ok());
        assert!(check("\n\tSELECT a FROM b WHERE c = ?").is_ok());
        assert!(check("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
        assert!(check("SELECT ';' AS semicolon_in_a_string").is_ok());
        assert!(check("SELECT 1;").is_ok());
        assert!(check("SELECT 1;   \n ").is_ok());
    }

    #[test]
    fn every_mutating_shape_is_refused() {
        for sql in [
            "UPDATE products SET price_incl_vat_cents = 1",
            "update products set price_incl_vat_cents = 1",
            "DELETE FROM sale_payments",
            "INSERT INTO users (id) VALUES ('x')",
            "REPLACE INTO products (id) VALUES ('x')",
            "DROP TABLE sales",
            "ALTER TABLE sales ADD COLUMN x TEXT",
            "CREATE TABLE evil (x TEXT)",
            "VACUUM",
            "ATTACH DATABASE 'other.db' AS other",
            "UPDATE products SET name = 'x' RETURNING id",
            "   \n  UPDATE products SET name = 'x'",
            "/* comment */ UPDATE products SET name = 'x'",
            "-- comment\nUPDATE products SET name = 'x'",
        ] {
            assert!(check(sql).is_err(), "must refuse: {sql}");
        }
    }

    #[test]
    fn pragmas_are_refused_so_query_only_cannot_be_turned_off() {
        assert!(check("PRAGMA query_only = OFF").is_err());
        assert!(check("pragma journal_mode = DELETE").is_err());
        assert!(check("PRAGMA foreign_keys = OFF").is_err());
    }

    #[test]
    fn stacked_statements_are_refused() {
        assert!(check("SELECT 1; UPDATE products SET name = 'x'").is_err());
        assert!(check("SELECT 1 ; DELETE FROM sales").is_err());
    }
}
