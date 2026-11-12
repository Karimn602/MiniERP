// GZ-WAL-01 — database startup validation fails CLOSED.
//
// THE DEFECT THESE TESTS EXIST FOR
//
// Gate 2A moved `PRAGMA journal_mode = WAL` out of the renderer and into
// `db_init`, and left the failure handling as it found it. `lib.rs` matched on
// the result and, for BOTH bad outcomes — an `Err`, or an `Ok` reporting a
// journal mode that is not `wal` — printed one line to `stderr` and carried on
// into an ordinary launch:
//
//     Ok(mode) => eprintln!("[db] journal_mode is {mode}, expected wal: ...")
//     Err(e)   => eprintln!("[db] startup PRAGMA failed: {e}")
//
// So Greaz would open the till, take an evening's money, and be running on a
// database the documented backup procedure no longer describes — with nothing
// on screen to say so. `docs/BACKUP.md` step 3 has the operator read the
// ABSENCE of `greaz-pos.db-wal` / `-shm` after a clean close as proof that the
// main file holds everything. In any other journal mode those files never
// appear at all, so the operator's check passes over a copy nobody has
// verified, every single time.
//
// WHAT "FAILS CLOSED" MEANS HERE, AND WHERE IT IS ENFORCED
//
// Not in twenty-one commands. `DbState` carries a three-state startup gate and
// `posting::pool_for_state` consults it BEFORE the lazy open, so a refused
// startup has no pool and cannot conjure one. Every writable command in the
// application acquires the shared pool through that function, and the
// renderer's only read channel goes through `read_api::read_pool_for_state`,
// which consults the same gate before even looking at its cache.
//
// WHAT THESE TESTS DRIVE
//
// `db_init::verify_database_ready` — the production validation function — and
// `posting::pool_for_state` / `read_api::read_pool_for_state` — the production
// pool accessors. Not re-typed imitations of them. Every database is a fresh
// disposable file under the OS temp directory; `TempDb` refuses to open
// anything named like the production database (`assert_not_production_db`), and
// the two tests that build a pool by path assert that guard themselves before
// doing so.

use crate::posting::{
    close_shift_with_pool, open_shift_with_pool, post_sale_with_pool, pool_for_startup_validation,
    pool_for_state, CloseShiftPayload, DbState, OpenShiftPayload, StartupStatus,
};
use crate::read_api::{read_pool_for_state, run_select, ReadPool};

/// A session that is signed in, so these tests exercise the STARTUP gate rather
/// than Stage A.1's session gate.
///
/// `pool_for_state` now consults two gates in order — startup, then session —
/// and every test in this file predates the second one and is about the first.
/// Giving each of them an open session keeps each test measuring exactly what
/// it was written to measure; the session gate has its own file.
async fn signed_in() -> crate::auth::SessionState {
    let sessions = crate::auth::SessionState::new();
    sessions
        .open_for_tests(
            "00000000-0000-0000-0000-000000000002",
            "00000000-0000-0000-0000-000000000001",
            crate::auth::Role::Owner,
        )
        .await;
    sessions
}

use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SHIFT_W: &str = "00000000-0000-0000-0000-0000000000b9";

fn open_payload(shift_id: &str, store_id: &str, user_id: &str) -> OpenShiftPayload {
    OpenShiftPayload {
        shift_id: shift_id.to_string(),
        store_id: store_id.to_string(),
        opened_by_user_id: user_id.to_string(),
        device_id: None,
        opening_cash_usd_cents: 5_000,
        opening_cash_lbp: 0,
        notes: None,
    }
}

async fn store_with_coffee() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 1_000,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db
}

/// The journal mode a file is really in, read the way production reads it.
async fn mode_of(db: &TempDb) -> String {
    crate::db_init::journal_mode_on_a_fresh_connection(db.path())
        .await
        .expect("read the journal mode back")
}

fn sidecar(db: &TempDb, suffix: &str) -> std::path::PathBuf {
    let mut name = db.path().file_name().unwrap().to_os_string();
    name.push(suffix);
    db.path().with_file_name(name)
}

// ============================================================================
// 1. The success path — and it ends in WAL, verified independently
// ============================================================================

/// Validation passes on a complete database, and the database really is in WAL.
///
/// The first assertion matters as much as the last: a fresh `TempDb` is NOT in
/// WAL (sqlx does not ask, which is the whole reason `db_init` exists), so this
/// measures a change rather than a pre-existing state.
#[tokio::test]
async fn a_complete_database_passes_validation_and_ends_in_wal() {
    let db = TempDb::new().await;

    assert_ne!(
        mode_of(&db).await,
        "wal",
        "a fresh sqlx database must not already be in WAL, or this test proves nothing"
    );

    let observed = crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect("a fully migrated database must pass startup validation");

    assert_eq!(observed, "wal", "validation must report the verified mode");
    assert_eq!(
        mode_of(&db).await,
        "wal",
        "the mode must be persisted in the file header, not just reported"
    );
    // And the companion the whole backup procedure is written around appears
    // once something is written. Switching the mode alone need not create it;
    // a committed transaction must.
    db.exec("INSERT INTO stores (id, name) VALUES ('00000000-0000-0000-0000-00000000wal', 'WAL probe')")
        .await;
    assert!(
        sidecar(&db, "-wal").exists(),
        "a live WAL database must have its -wal companion once it has been written to"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// Validation is idempotent: a second launch on an already-WAL database passes
/// without doing anything.
#[tokio::test]
async fn validation_passes_again_on_a_database_already_in_wal() {
    let db = TempDb::new().await;

    crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect("first launch");
    let second = crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect("second launch on the same file");

    assert_eq!(second, "wal");
    db.cleanup().await.expect("remove TempDb");
}

// ============================================================================
// 2. Migration / schema failures
// ============================================================================

/// A database stopped short of this build's schema is refused.
///
/// This is the shape a half-finished migration run, or a database last opened
/// by an older release, actually arrives in. The second assertion is the one
/// that matters for the operator: because the schema check runs FIRST, a
/// refused database is not also left half-reconfigured — its journal mode is
/// exactly as it was found.
#[tokio::test]
async fn validation_refuses_a_database_stopped_short_of_the_current_schema() {
    let db = TempDb::at_schema_version(latest_migration_version() - 1).await;
    let before = mode_of(&db).await;

    let err = crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect_err("an incomplete schema must be refused");

    assert!(
        err.contains("incomplete"),
        "the refusal must say the schema is incomplete: {err}"
    );
    assert!(
        err.contains(&format!("{}", latest_migration_version())),
        "the refusal must name the missing migration: {err}"
    );
    assert_eq!(
        mode_of(&db).await,
        before,
        "a refused database must not have been reconfigured on the way out"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A database whose migration history records a FAILURE is refused, by number.
#[tokio::test]
async fn validation_refuses_a_database_with_a_migration_recorded_as_failed() {
    let db = TempDb::new().await;
    db.exec("UPDATE _sqlx_migrations SET success = 0 WHERE version = 12")
        .await;

    let err = crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect_err("a failed migration must be refused");

    assert!(
        err.contains("FAILED"),
        "the refusal must name the failure: {err}"
    );
    assert!(
        err.contains("12"),
        "the refusal must name the migration: {err}"
    );
    assert!(
        err.contains("restored from a backup"),
        "the refusal must tell the operator what to do: {err}"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A file with no migration history at all is refused, and is not "fixed".
///
/// `TempDb::empty()` is a real SQLite file with no `_sqlx_migrations` table —
/// which is what an empty or foreign file looks like. The refusal must not be a
/// raw sqlx "no such table" error, because that is what the operator would be
/// reading off the screen.
#[tokio::test]
async fn validation_refuses_a_database_with_no_migration_history() {
    let db = TempDb::empty().await;

    let err = crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect_err("a database with no schema must be refused");

    assert!(
        err.contains("_sqlx_migrations"),
        "the refusal must say what is missing: {err}"
    );
    assert!(
        err.contains("no migration history"),
        "the refusal must be in words, not a raw sqlx error: {err}"
    );
    assert!(
        err.contains(&format!("{}", migration_count())),
        "the refusal must say how many migrations were expected: {err}"
    );

    db.cleanup().await.expect("remove TempDb");
}

// ============================================================================
// 3. WAL unavailable — a refusal, never a fallback
// ============================================================================

/// Every journal mode that is not `wal` is refused, and the refusal explains
/// itself in terms of the backup procedure.
///
/// `delete` is the one that matters: it is SQLite's default, so it is what a
/// database lands in when nobody asks for WAL, and it is the mode a "sensible"
/// fallback would have chosen.
#[test]
fn a_journal_mode_that_is_not_wal_is_refused_rather_than_accepted() {
    for mode in ["delete", "truncate", "persist", "memory", "off", ""] {
        let err = crate::db_init::require_wal(mode, "a connection reports")
            .expect_err("only wal may pass");
        assert!(
            err.contains("not in WAL journal mode"),
            "{mode}: {err}"
        );
        assert!(
            err.contains("backup"),
            "{mode}: the refusal must say why WAL is required: {err}"
        );
    }

    crate::db_init::require_wal("wal", "a connection reports").expect("wal must pass");
}

/// WAL that cannot be ESTABLISHED is refused by the real validation path.
///
/// Simulated the way it actually happens: another connection is holding the
/// database, which is the "a second copy of Greaz is already running" case the
/// refusal text names. SQLite will not switch journal mode out from under a
/// rival transaction, so the attempt either errors or leaves the mode alone —
/// and both outcomes have to be a refusal, never a shrug. Which of the two
/// occurs is SQLite's business, so this asserts the refusal rather than the
/// mechanism, and then proves the file was left in its original mode.
#[tokio::test]
async fn validation_refuses_when_wal_cannot_be_established() {
    let db = TempDb::new().await;
    assert_eq!(mode_of(&db).await, "delete", "precondition");

    // A rival holding a write transaction on the same file.
    let rival = db.rival_pool().await;
    let mut held = rival.acquire().await.expect("rival connection");
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *held)
        .await
        .expect("rival opens a transaction");
    // A SHARED read lock rather than an exclusive one, deliberately: an
    // exclusive lock makes even reading the schema catalogue fail, so the
    // refusal would be about something else and the test would prove something
    // else. With a shared lock everything is readable and the journal-mode
    // switch is the one operation that cannot happen — which is the state being
    // simulated.
    sqlx::query("SELECT COUNT(*) FROM stores")
        .fetch_one(&mut *held)
        .await
        .expect("rival takes a shared read lock");

    let outcome = crate::db_init::verify_database_ready(db.pool(), db.path()).await;

    assert!(
        outcome.is_err(),
        "WAL could not be established, so startup must be refused, got {outcome:?}"
    );
    let err = outcome.unwrap_err();
    // Observed on sqlx 0.8.6 / SQLite:
    //   PRAGMA journal_mode = WAL failed: error returned from database:
    //   (code: 5) database is locked
    // The step is what is pinned, not the engine's wording: if SQLite ever
    // answers by leaving the mode alone instead of erroring, the other branch
    // of this assertion catches it and the refusal still stands.
    assert!(
        err.contains("PRAGMA journal_mode = WAL failed")
            || err.contains("not in WAL journal mode"),
        "the refusal must come from the journal-mode step: {err}"
    );

    sqlx::query("ROLLBACK")
        .execute(&mut *held)
        .await
        .expect("release the rival lock");
    drop(held);

    assert_eq!(
        mode_of(&db).await,
        "delete",
        "a refused attempt must not have silently settled for another mode"
    );

    rival.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ============================================================================
// 4. No trading in the failed state
// ============================================================================

/// A failed startup refuses every request for the writable pool, and opens
/// nothing.
///
/// The path is deliberately one that does not exist. `open_write_pool` carries
/// `create_if_missing(true)`, so if the gate were checked after the open — or
/// not at all — this would CREATE a database. That the file is still absent
/// afterwards is the proof that the refusal happens first.
#[tokio::test]
async fn a_failed_startup_refuses_the_write_pool_and_creates_nothing() {
    let state = DbState::new();
    state.mark_startup_failed("TEST FAULT: journal mode is delete").await;

    let ghost = std::env::temp_dir()
        .join("greaz-pos-tests")
        .join(format!("never-created-{}.db", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(ghost.parent().unwrap()).expect("temp dir");
    assert_not_production_db(&ghost);
    assert!(!ghost.exists(), "precondition");

    let err = pool_for_state(&state, &signed_in().await, &ghost)
        .await
        .expect_err("a failed startup must refuse the pool");

    assert_eq!(
        err, "TEST FAULT: journal mode is delete",
        "the refusal must be the operator-facing fault, so it reaches the screen"
    );
    assert!(
        !ghost.exists(),
        "the gate must be checked BEFORE the lazy open: a database was created"
    );
    assert!(
        state.pool.lock().await.is_none(),
        "no pool may be cached in the failed state"
    );
}

/// A startup that has not finished refuses too. Closed until proven open.
#[tokio::test]
async fn a_pending_startup_refuses_trading() {
    let state = DbState::new();
    assert_eq!(state.startup_status().await, StartupStatus::Pending);

    let db = TempDb::new().await;
    let err = pool_for_state(&state, &signed_in().await, db.path())
        .await
        .expect_err("pending must refuse as firmly as failed");
    assert!(
        err.contains("still checking the database"),
        "pending needs words of its own: {err}"
    );
    assert!(state.pool.lock().await.is_none());

    db.cleanup().await.expect("remove TempDb");
}

/// The renderer's read channel is gated as well, and gated before its cache.
///
/// A read is not harmless after a refused startup: `ensureDbReady` is a read,
/// every repo is a read, and a renderer that could still read would fill the
/// till with figures from a database the application has refused to trade on.
#[tokio::test]
async fn a_failed_startup_refuses_the_renderer_read_channel_too() {
    let db = TempDb::new().await;
    let state = DbState::new();
    let reads = ReadPool::new();

    // Pending first.
    let pending = read_pool_for_state(&state, &signed_in().await, &reads, db.path())
        .await
        .expect_err("pending must refuse the read channel");
    assert!(pending.contains("still checking the database"), "{pending}");

    state
        .mark_startup_failed("TEST FAULT: the schema is incomplete")
        .await;
    let failed = read_pool_for_state(&state, &signed_in().await, &reads, db.path())
        .await
        .expect_err("a failed startup must refuse the read channel");
    assert_eq!(failed, "TEST FAULT: the schema is incomplete");

    assert!(
        reads.pool.lock().await.is_none(),
        "no read pool may be opened in the failed state"
    );
    assert!(
        state.pool.lock().await.is_none(),
        "and the read path must not have opened the write pool either"
    );

    db.cleanup().await.expect("remove TempDb");
}

// ============================================================================
// 5. A validated startup still trades normally
// ============================================================================

/// The gate is not a brake. A validated startup opens the pool, and the real
/// commands post through it exactly as before.
///
/// This is the half that makes the correction safe to ship: a fail-closed check
/// that also fails on a healthy database is worse than the defect.
#[tokio::test]
async fn a_validated_startup_trades_normally() {
    let db = store_with_coffee().await;
    assert_not_production_db(db.path());

    let state = DbState::new();
    let observed = crate::db_init::verify_database_ready(db.pool(), db.path())
        .await
        .expect("validation must pass");
    assert_eq!(observed, "wal");
    state.mark_startup_ready().await;
    assert_eq!(state.startup_status().await, StartupStatus::Ready);

    let pool = pool_for_state(&state, &signed_in().await, db.path())
        .await
        .expect("a validated startup must hand out the pool");

    let snapshot = open_shift_with_pool(&pool, open_payload(SHIFT_W, STORE_ID, USER_ID))
        .await
        .expect("a shift must still open");
    assert_eq!(snapshot.status, "open");

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(2)
        .unit_incl(500)
        .build()];
    let mut payload = sale_payload(lines, vec![cash_usd(1_000)]);
    payload.shift_id = Some(SHIFT_W.to_string());
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(&pool, payload)
        .await
        .expect("a sale must still post");

    let posted: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sales WHERE id = ? AND status = 'posted'")
            .bind(&sale_id)
            .fetch_one(&pool)
            .await
            .expect("count the posted sale");
    assert_eq!(posted, 1);

    close_shift_with_pool(
        &pool,
        CloseShiftPayload {
            shift_id: SHIFT_W.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 6_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("the shift must still close");

    // And the renderer can read, through its own read-only pool.
    let reads = ReadPool::new();
    let read_pool = read_pool_for_state(&state, &signed_in().await, &reads, db.path())
        .await
        .expect("a validated startup must hand out the read pool");
    let rows = run_select(
        &read_pool,
        "SELECT COUNT(*) AS n FROM sales WHERE status = 'posted'",
        vec![],
    )
    .await
    .expect("the renderer must still be able to read");
    assert_eq!(rows[0]["n"], serde_json::json!(1));

    read_pool.close().await;
    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ============================================================================
// 6. Resource cleanup
// ============================================================================

/// The pool opened to VALIDATE the database is released when validation fails,
/// and cannot be re-acquired afterwards.
///
/// This is the sequence `lib.rs` performs: validate (which opens the pool),
/// shut the gate, release. The order is the point — releasing first and gating
/// second would leave a window in which the next caller re-opens the file the
/// application has just decided to let go of.
#[tokio::test]
async fn a_failed_startup_releases_the_pool_it_opened_to_validate() {
    let db = TempDb::at_schema_version(latest_migration_version() - 1).await;

    let state = DbState::new();
    let pool = pool_for_startup_validation(&state, db.path())
        .await
        .expect("validation opens the pool first");
    assert!(
        state.pool.lock().await.is_some(),
        "the validation pool must be held while validating"
    );

    let fault = crate::db_init::verify_database_ready(&pool, db.path())
        .await
        .expect_err("this database must fail validation");

    // Exactly what the setup hook does, in exactly that order.
    state.mark_startup_failed(crate::db_init::fatal_startup_message(&fault)).await;
    state.close_pool().await;

    assert!(
        state.pool.lock().await.is_none(),
        "the pool must be released, not merely closed and kept"
    );
    let err = pool_for_state(&state, &signed_in().await, db.path())
        .await
        .expect_err("and it must not come back");
    assert!(err.contains("GREAZ CANNOT TRADE"), "{err}");
    assert!(
        err.contains("Do not take payments"),
        "the operator needs the instruction, not the diagnosis: {err}"
    );

    db.cleanup().await.expect("remove TempDb");
}

// ============================================================================
// 7. The gate cannot be bypassed — source shape
// ============================================================================

/// The structural guarantees this correction rests on, asserted against the
/// source rather than assumed.
///
/// These are shape assertions on purpose. "No command can trade after a failed
/// startup" is a property of there being exactly ONE ungated way to open the
/// database and exactly one caller of it; that is a statement about the code,
/// and the honest way to pin it is to read the code. The behavioural half is
/// above.
#[test]
fn the_startup_gate_cannot_be_bypassed() {
    let posting = include_str!("../posting.rs");
    let read_api = include_str!("../read_api.rs");
    let db_init = include_str!("../db_init.rs");
    let lib = include_str!("../lib.rs");

    // 1. The gated accessor consults the gate BEFORE the opener.
    let gated = posting
        .split("pub(crate) async fn pool_for_state(")
        .nth(1)
        .expect("pool_for_state must exist");
    let check = gated
        .find("ensure_trading_allowed")
        .expect("pool_for_state must consult the gate");
    let open = gated
        .find("pool_for_startup_validation(")
        .expect("pool_for_state must delegate the open");
    assert!(
        check < open,
        "the gate must be checked before the pool is opened"
    );

    // 2. The ungated opener has exactly one non-test caller: db_init.
    for (name, src) in [
        ("read_api.rs", read_api),
        ("lib.rs", lib),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        ("admin.rs", include_str!("../admin.rs")),
    ] {
        assert!(
            !src.contains("pool_for_startup_validation"),
            "{name} must not open the database before the gate is decided"
        );
    }
    assert_eq!(
        db_init.matches("pool_for_startup_validation(").count(),
        1,
        "db_init is the one place that may open the database ungated, once"
    );

    // 3. The read channel is gated too, before its cache is consulted.
    let read_fn = read_api
        .split("pub(crate) async fn read_pool_for_state(")
        .nth(1)
        .expect("read_pool_for_state must exist");
    let read_check = read_fn
        .find("ensure_trading_allowed")
        .expect("the read path must consult the gate");
    // Stage C: the cache is a per-TIER slot, chosen before it is consulted.
    let read_cache = read_fn
        .find("slot.lock()")
        .expect("the read path has a cache");
    assert!(
        read_check < read_cache,
        "the gate must be checked before the cached read pool is handed back"
    );
    let read_tier = read_fn
        .find("authz::read_tier(")
        .expect("the read path must resolve the caller's tier");
    assert!(
        read_tier < read_cache,
        "the tier must be decided before a cached pool is handed back, or a \
         cashier could be handed the staff pool another read opened"
    );

    // 4. `lib.rs` shuts the gate and releases the pools on failure, and no
    //    longer carries on regardless.
    assert!(
        lib.contains("mark_startup_failed"),
        "a failed startup must shut the gate"
    );
    assert!(
        lib.contains("release_pools_after_failed_startup"),
        "a failed startup must release the pools"
    );
    assert!(
        lib.contains("mark_startup_ready"),
        "a validated startup must open the gate"
    );
    assert!(
        !lib.contains("ensure_production_pragmas"),
        "the old set-and-log entry point must be gone, not merely unused"
    );
    assert!(
        !lib.contains(r#".expect("error while building tauri application")"#),
        "a plugin-side migration failure must be reported, not panicked"
    );

    // 5. There is no fallback to another journal mode anywhere in the path.
    assert_eq!(
        db_init
            .matches(r#"sqlx::query("PRAGMA journal_mode = WAL")"#)
            .count(),
        1,
        "exactly one journal-mode statement in the whole startup path"
    );
    for forbidden in [
        "journal_mode = DELETE",
        "journal_mode = delete",
        "journal_mode = TRUNCATE",
        "journal_mode = PERSIST",
        "journal_mode = OFF",
    ] {
        assert!(
            !db_init.contains(forbidden),
            "startup must never fall back to another journal mode: found {forbidden}"
        );
    }

    // 6. The journal mode is verified on a connection that did not set it.
    let verify = db_init
        .split("pub(crate) async fn verify_database_ready(")
        .nth(1)
        .expect("verify_database_ready must exist");
    assert!(
        verify.contains("journal_mode_on_a_fresh_connection"),
        "the mode must be read back independently, not taken from the SET"
    );
    let set_at = verify.find("PRAGMA journal_mode = WAL").expect("the SET");
    let read_at = verify
        .find("journal_mode_on_a_fresh_connection")
        .expect("the independent read");
    assert!(set_at < read_at, "set, then verify");
}

/// The schema is proven before the journal mode is touched.
///
/// Ordering with a reason: an incomplete database must be refused for what is
/// actually wrong with it, and must not be reconfigured on the way out. Pinned
/// behaviourally in
/// `validation_refuses_a_database_stopped_short_of_the_current_schema`, and
/// structurally here.
#[test]
fn the_schema_is_checked_before_the_journal_mode() {
    let db_init = include_str!("../db_init.rs");
    let verify = db_init
        .split("pub(crate) async fn verify_database_ready(")
        .nth(1)
        .expect("verify_database_ready must exist");

    let migrations_at = verify
        .find("require_complete_migrations")
        .expect("the schema check");
    let pragma_at = verify
        .find("PRAGMA journal_mode = WAL")
        .expect("the journal mode statement");
    assert!(migrations_at < pragma_at);
}

/// Every migration this build registers is what validation demands — not a
/// number typed into `db_init`.
#[tokio::test]
async fn validation_demands_exactly_this_builds_migration_list() {
    let db = TempDb::new().await;

    // The list is the source of truth on both sides.
    assert_eq!(crate::migrations().len() as i64, migration_count());

    crate::db_init::require_complete_migrations(db.pool())
        .await
        .expect("a fully migrated database satisfies the list");

    // Remove the newest one's history row: the database still has the schema,
    // but it can no longer PROVE it, which is the honest answer.
    db.exec(&format!(
        "DELETE FROM _sqlx_migrations WHERE version = {}",
        latest_migration_version()
    ))
    .await;

    let err = crate::db_init::require_complete_migrations(db.pool())
        .await
        .expect_err("an unprovable schema must be refused");
    assert!(err.contains("incomplete"), "{err}");

    db.cleanup().await.expect("remove TempDb");
}
