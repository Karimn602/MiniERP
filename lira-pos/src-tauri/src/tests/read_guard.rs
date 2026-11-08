//! GZ-A0 — the renderer read channel's CONFIDENTIALITY boundary.
//!
//! Gate 2A proved the renderer cannot WRITE. These tests prove it cannot READ a
//! credential, which is a different property and was not previously true.
//!
//! Everything here runs against a brand-new disposable `TempDb` carrying
//! SYNTHETIC credential material. No protected database is opened, and no real
//! credential exists yet — that is the point of the ordering: the boundary ships
//! before migration 023 puts a real Argon2id hash behind it.
//!
//! The adversary modelled is the one the threat model names: somebody with the
//! webview's own read channel and a free hand with SQL. So the queries below are
//! not polite. Each one is a different SPELLING of "give me the hash", and the
//! reason they all fail is that SQLite's authorizer sees resolved names rather
//! than text — which is the single claim this file exists to verify rather than
//! assume.

use serde_json::{json, Value};
use sqlx::Executor;

use crate::read_api::{open_read_only_pool, run_select};
use crate::test_support::{close_sqlite_pool_checked, TempDb};

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";

/// A value chosen so that a leak is detectable by SEARCHING THE OUTPUT, not
/// only by a query failing. If this string ever appears in a `db_select`
/// result, something has leaked regardless of which assertion noticed.
const SECRET: &str = "GZ-A0-SYNTHETIC-SECRET-argon2id-DO-NOT-LEAK";
const RECOVERY_SECRET: &str = "GZ-A0-SYNTHETIC-RECOVERY-CODE-DO-NOT-LEAK";
const ENROLLMENT_SECRET: &str = "GZ-A0-SYNTHETIC-ENROLLMENT-CODE-DO-NOT-LEAK";

/// A disposable database carrying SYNTHETIC credentials in the real migration
/// 023 schema.
///
/// When GZ-A0 was written 023 did not exist, and this harness created the
/// columns and tables by hand — which was the point: the policy is by NAME, so
/// the boundary could be proven against the schema it protects before that
/// schema existed. Now that 023 has landed the harness uses the real thing, so
/// these tests exercise the actual credential store rather than a replica of
/// it. The policy did not change; only the fixture did.
async fn db_with_synthetic_credentials() -> TempDb {
    let db = TempDb::new().await;

    db.exec(&format!(
        "UPDATE users
            SET pin_hash = '{SECRET}',
                credential_algo = 'argon2id',
                credential_version = 1,
                credential_set_at = '2026-11-08T00:00:00.000Z',
                failed_attempts = 3,
                locked_until = '2026-11-08T01:00:00.000Z',
                must_change_pin = 1
          WHERE id = '{OWNER}'"
    ))
    .await;

    db.exec(&format!(
        "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at)
         VALUES ('rec-1', '{STORE}', '{RECOVERY_SECRET}', 'argon2id',
                 '2026-11-08T00:00:00.000Z')"
    ))
    .await;

    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, detail)
         VALUES ('aud-1', '{STORE}', '2026-11-08T00:00:00.000Z', 'login_failed',
                 '{OWNER}', 'three attempts from the counter')"
    ))
    .await;

    // The enrollment row 023 seeds carries the hash of the one-time
    // installation code, so it is protected too. Give it one, so the test
    // battery below has something to try to read.
    db.exec(&format!(
        "UPDATE auth_enrollment
            SET enrollment_code_hash = '{ENROLLMENT_SECRET}',
                enrollment_code_algo = 'argon2id',
                enrollment_code_issued_at = '2026-11-08T00:00:00.000Z',
                enrollment_code_expires_at = '2026-11-09T00:00:00.000Z'
          WHERE store_id = '{STORE}'"
    ))
    .await;

    db
}

/// Every query the renderer could send, as the renderer sends it.
async fn renderer_read(
    pool: &sqlx::SqlitePool,
    sql: &str,
) -> Result<Vec<serde_json::Map<String, Value>>, String> {
    run_select(pool, sql, vec![]).await
}

/// Assert a query is REFUSED and that nothing resembling a secret came back.
async fn must_be_refused(pool: &sqlx::SqlitePool, sql: &str) {
    match renderer_read(pool, sql).await {
        Ok(rows) => {
            let dump = format!("{rows:?}");
            panic!(
                "CONFIDENTIALITY BREACH — this query was answered when it should \
                 have been refused:\n  {sql}\nrows: {dump}"
            );
        }
        Err(e) => {
            assert!(
                !e.contains(SECRET) && !e.contains(RECOVERY_SECRET) && !e.contains(ENROLLMENT_SECRET),
                "the refusal for `{sql}` leaked the secret in its own error message: {e}"
            );
        }
    }
}

/// Assert a query is ANSWERED, and that the answer carries no secret.
async fn must_be_answered(pool: &sqlx::SqlitePool, sql: &str) -> Vec<serde_json::Map<String, Value>> {
    match renderer_read(pool, sql).await {
        Ok(rows) => {
            let dump = format!("{rows:?}");
            assert!(
                !dump.contains(SECRET) && !dump.contains(RECOVERY_SECRET) && !dump.contains(ENROLLMENT_SECRET),
                "an ALLOWED query returned a secret:\n  {sql}\nrows: {dump}"
            );
            rows
        }
        Err(e) => panic!(
            "an ordinary business read was refused — the boundary is over-broad:\n  \
             {sql}\nerror: {e}"
        ),
    }
}

// ===========================================================================
// PART 1 — every spelling of "give me the hash"
// ===========================================================================

/// THE HEADLINE. Thirteen different ways of asking, all refused.
///
/// This is one test rather than thirteen on purpose: the claim is about the
/// MECHANISM, and a mechanism that resolves names before the policy runs either
/// covers all of these or none of them. Listing them separately would suggest
/// thirteen independent guards, which would be the regex design this one
/// replaces.
#[tokio::test]
async fn no_spelling_of_the_credential_query_is_answered() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    for sql in [
        // Direct.
        "SELECT pin_hash FROM users",
        // Every column, including the one that must not come.
        "SELECT * FROM users",
        // Table alias, qualified column.
        "SELECT u.pin_hash FROM users u",
        // Alias star.
        "SELECT u.* FROM users u",
        // Column alias, to see whether the OUTPUT name is what is checked.
        "SELECT pin_hash AS harmless_looking_name FROM users",
        // Quoted identifiers, three dialects SQLite accepts.
        "SELECT \"pin_hash\" FROM \"users\"",
        "SELECT [pin_hash] FROM [users]",
        "SELECT `pin_hash` FROM `users`",
        // Identifier case. SQLite's identifiers are case-insensitive, so the
        // policy must be too.
        "SELECT PIN_HASH FROM USERS",
        "SELECT PiN_hAsH FROM UsErS",
        // A CTE, so the read happens one level down.
        "WITH leaked AS (SELECT pin_hash FROM users) SELECT * FROM leaked",
        // A scalar subquery in the select list.
        "SELECT (SELECT pin_hash FROM users LIMIT 1) AS h",
        // A subquery in FROM.
        "SELECT h FROM (SELECT pin_hash AS h FROM users)",
        // A join, where the protected column is incidental to the query's shape.
        "SELECT s.id, u.pin_hash FROM shifts s LEFT JOIN users u ON u.id = s.opened_by_user_id",
        // COMPUTED — never returns the value itself, only facts about it.
        // Refused anyway: an oracle that answers "how long is the hash" or
        // "what is its first character" is a hash extractor given enough
        // queries, which is exactly the attack a NULL substitution would allow.
        "SELECT length(pin_hash) FROM users",
        "SELECT substr(pin_hash, 1, 1) FROM users",
        "SELECT CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END FROM users",
        "SELECT count(*) FROM users WHERE pin_hash IS NOT NULL",
        "SELECT count(*) FROM users WHERE pin_hash LIKE 'GZ-A0%'",
        "SELECT id FROM users ORDER BY pin_hash",
        "SELECT id FROM users GROUP BY pin_hash",
        "SELECT max(pin_hash) FROM users",
    ] {
        must_be_refused(&pool, sql).await;
    }

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// Every other protected credential column, driven from the POLICY ITSELF.
///
/// Reading the list out of `read_guard` rather than re-typing it here is what
/// stops the test and the policy drifting apart: a column added to the policy
/// without a test is impossible, because this test enumerates the policy.
#[tokio::test]
async fn every_protected_column_in_the_policy_is_actually_unreadable() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    let policy = crate::read_guard::policy_for_tests();
    let tables = policy.tables;
    let columns = policy.must_never_be_readable;
    assert!(!columns.is_empty(), "the column policy is empty");
    assert!(!tables.is_empty(), "the table policy is empty");

    for (table, column) in columns {
        must_be_refused(&pool, &format!("SELECT {column} FROM {table}")).await;
        must_be_refused(&pool, &format!("SELECT t.{column} FROM {table} t")).await;
        must_be_refused(
            &pool,
            &format!("WITH x AS (SELECT {column} FROM {table}) SELECT * FROM x"),
        )
        .await;
    }

    for table in tables {
        // A protected TABLE is protected in full — not column by column, and
        // not merely for the columns that hold the secret. `count(*)` is
        // included because row counts are the one read that does not name a
        // column, so it is where a column-only policy would leak.
        //
        // Every name in the policy is asserted, including the reflecting
        // surfaces that may not exist on this database. A read of a table that
        // does not exist fails either way, so those names are also covered
        // behaviourally by `dbstat_cannot_be_used_to_count_a_protected_table`,
        // which uses the one that IS compiled in.
        must_be_refused(&pool, &format!("SELECT * FROM {table}")).await;
        must_be_refused(&pool, &format!("SELECT count(*) FROM {table}")).await;
        must_be_refused(&pool, &format!("SELECT 1 FROM {table}")).await;
    }

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// A VIEW is the interesting case, because a view is the one construct that
/// could put a protected column behind a name the policy has never heard of.
///
/// It cannot. SQLite authorizes the read of the UNDERLYING table when the view
/// is used, passing the view's name as the fourth argument — so the policy sees
/// `users.pin_hash` and refuses, and the view's own name is irrelevant. The view
/// is created through the WRITE pool here because the renderer cannot create
/// one; the test is about reading a view that already exists, which is the
/// reachable case (a previous build, a support script, or a future feature).
#[tokio::test]
async fn a_view_cannot_launder_a_protected_column() {
    let db = db_with_synthetic_credentials().await;
    db.exec("CREATE VIEW innocent_staff AS SELECT id, full_name, pin_hash AS token FROM users")
        .await;
    db.exec("CREATE VIEW doubly_innocent AS SELECT token FROM innocent_staff")
        .await;
    db.exec("CREATE VIEW recovery_peek AS SELECT code_hash FROM owner_recovery")
        .await;

    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    must_be_refused(&pool, "SELECT * FROM innocent_staff").await;
    must_be_refused(&pool, "SELECT token FROM innocent_staff").await;
    must_be_refused(&pool, "SELECT * FROM doubly_innocent").await;
    must_be_refused(&pool, "SELECT * FROM recovery_peek").await;

    // And the harmless half of the same view is still refused, because the
    // view's definition reads the protected column whatever the caller selects
    // from it. That is a real functional cost of the boundary and it is the
    // right trade: a view over a secret is a view nobody should have made.
    must_be_refused(&pool, "SELECT id, full_name FROM innocent_staff").await;

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// Attaching a second database is refused, so a COPY of the protected tables
/// cannot be read under another database name.
#[tokio::test]
async fn another_database_cannot_be_attached_and_read() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    // The statement guard refuses this shape first — it is not a SELECT — which
    // is the layer that produces the readable message. The authorizer is the
    // layer that would refuse it if the shape guard were ever relaxed, and
    // `read_guard`'s own unit coverage is where that is pinned. Here we simply
    // assert the channel does not attach anything.
    let path = db.path().display().to_string().replace('\\', "/");
    must_be_refused(&pool, &format!("ATTACH DATABASE '{path}' AS copycat")).await;
    must_be_refused(
        &pool,
        &format!("SELECT 1; ATTACH DATABASE '{path}' AS copycat"),
    )
    .await;

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

// ===========================================================================
// PART 2 — the application still works
// ===========================================================================

/// The boundary is worth nothing if it breaks the till, so this is asserted as
/// firmly as the refusals: the reads the application actually performs.
///
/// `users` in particular must stay USABLE. `shiftsRepo.listHistory` joins it for
/// `full_name` so a closed shift can name who opened and closed it, and the
/// login screen Stage A.1 adds needs id, name and role. A policy that protected
/// the whole row would have broken both.
#[tokio::test]
async fn ordinary_business_reads_are_unaffected() {
    let db = db_with_synthetic_credentials().await;
    crate::test_support::activate_demo_catalogue(&db).await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    // The users row, minus the credential.
    let rows = must_be_answered(
        &pool,
        "SELECT id, store_id, full_name, role, active, created_at FROM users",
    )
    .await;
    assert!(!rows.is_empty(), "the owner row should still be readable");
    assert_eq!(
        rows[0].get("full_name").and_then(Value::as_str),
        Some("Owner")
    );

    // Counting users does not name a column, so it is the case a column-only
    // policy gets wrong in the other direction — it must still be ALLOWED.
    let counted = must_be_answered(&pool, "SELECT count(*) AS n FROM users").await;
    assert_eq!(counted[0].get("n").and_then(Value::as_i64), Some(1));

    // The shift-history join, as `shifts.ts` actually writes it.
    must_be_answered(
        &pool,
        "SELECT s.id, uo.full_name AS opened_by_name, uc.full_name AS closed_by_name
           FROM shifts s
           LEFT JOIN users uo ON uo.id = s.opened_by_user_id
           LEFT JOIN users uc ON uc.id = s.closed_by_user_id",
    )
    .await;

    // A representative slice of the real read surface, including the `SELECT *`
    // shapes the repos use on other tables and the cost columns reporting needs.
    for sql in [
        "SELECT * FROM products",
        "SELECT id, sku, name, price_incl_vat_cents, avg_cost_excl_vat_microcents FROM products",
        "SELECT * FROM product_uoms",
        "SELECT * FROM product_barcodes",
        "SELECT * FROM vat_rates",
        "SELECT * FROM exchange_rates",
        "SELECT * FROM stores",
        "SELECT * FROM sales",
        "SELECT * FROM sale_items",
        "SELECT * FROM sale_payments",
        "SELECT * FROM sales_credit_memos",
        "SELECT * FROM inventory_movements",
        "SELECT * FROM shifts",
        "SELECT * FROM suppliers",
        "SELECT * FROM supplier_ledger",
        "SELECT * FROM purchases",
        "SELECT * FROM drivers",
        "SELECT * FROM driver_ledger",
        "SELECT * FROM driver_balances",
        "SELECT * FROM recipes",
        "SELECT * FROM recipe_components",
        "SELECT * FROM sale_item_recipe_costs",
        "SELECT * FROM app_settings",
        "SELECT * FROM units_of_measure",
        "SELECT version FROM _sqlx_migrations ORDER BY version DESC LIMIT 1",
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        // An aggregate, to prove SQL functions are still permitted.
        "SELECT count(*) AS n, sum(price_incl_vat_cents) AS t FROM products",
    ] {
        must_be_answered(&pool, sql).await;
    }

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// Parameter binding is unaffected: the authorizer runs at compile time and the
/// bound values are not part of the decision.
#[tokio::test]
async fn bound_parameters_still_work_and_cannot_smuggle_a_column_name() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    let rows = run_select(
        &pool,
        "SELECT id, full_name FROM users WHERE store_id = ? AND active = ?",
        vec![json!(STORE), json!(1)],
    )
    .await
    .expect("a parameterised business read should still work");
    assert_eq!(rows.len(), 1);

    // A column name cannot arrive as a parameter — SQLite binds VALUES, not
    // identifiers — so this returns the literal string, not the hash. Asserted
    // because "pass the column name as a parameter" is the first thing an
    // attacker tries against a name-based policy.
    let rows = run_select(&pool, "SELECT ? AS maybe FROM users", vec![json!("pin_hash")])
        .await
        .expect("binding a string is just a string");
    assert_eq!(
        rows[0].get("maybe").and_then(Value::as_str),
        Some("pin_hash")
    );

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

// ===========================================================================
// PART 3 — the boundary covers the whole pool, for its whole life
// ===========================================================================

/// One connection serving many statements keeps the authorizer.
///
/// A policy installed per-connection rather than per-statement has to survive
/// reuse, and the failure mode would be a boundary that holds for the first
/// query on a connection and not the second.
#[tokio::test]
async fn a_reused_connection_keeps_the_boundary() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    for round in 0..8 {
        must_be_answered(&pool, "SELECT id, full_name FROM users").await;
        must_be_refused(&pool, "SELECT pin_hash FROM users").await;
        must_be_answered(&pool, "SELECT count(*) AS n FROM products").await;
        must_be_refused(&pool, "SELECT * FROM owner_recovery").await;
        assert!(round < 8);
    }

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// EVERY connection in the pool is covered, including the ones created when the
/// pool GROWS.
///
/// The pool is opened with `max_connections(4)` and only one connection is
/// established eagerly; the other three are created later, on demand. If the
/// authorizer were installed only where the pool is opened rather than in
/// `after_connect`, those three would be uncovered — and they are the ones a
/// busy till actually uses. Forcing concurrency is how that is demonstrated
/// rather than assumed.
#[tokio::test]
async fn every_connection_the_pool_grows_is_covered() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    // Hold several connections busy at once so the pool must establish new
    // ones, then ask each of them for the hash.
    let mut handles = Vec::new();
    for _ in 0..8 {
        let p = pool.clone();
        handles.push(tokio::spawn(async move {
            // A slow-ish permitted read first, to keep the connection occupied
            // while its siblings are being established.
            let _ = run_select(&p, "SELECT count(*) AS n FROM sqlite_master", vec![]).await;
            run_select(&p, "SELECT pin_hash FROM users", vec![]).await
        }));
    }

    for h in handles {
        let result = h.await.expect("task");
        assert!(
            result.is_err(),
            "a connection created under load answered a protected read: {result:?}"
        );
    }

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// Two independent pools against the same file are both covered — the state is
/// per-connection and nothing is shared or cached between pools.
#[tokio::test]
async fn a_second_pool_on_the_same_file_is_covered_too() {
    let db = db_with_synthetic_credentials().await;
    let first = open_read_only_pool(db.path()).await.expect("first pool");
    let second = open_read_only_pool(db.path()).await.expect("second pool");

    must_be_refused(&first, "SELECT pin_hash FROM users").await;
    must_be_refused(&second, "SELECT pin_hash FROM users").await;
    must_be_answered(&first, "SELECT id FROM users").await;
    must_be_answered(&second, "SELECT id FROM users").await;

    close_sqlite_pool_checked(&first, "first pool").await.unwrap();
    close_sqlite_pool_checked(&second, "second pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// INSTALLATION FAILURE FAILS CLOSED.
///
/// The install routine does not trust `sqlite3_set_authorizer`'s return code: it
/// makes the connection prove, on itself, that a protected read is refused AND
/// an ordinary read is allowed. This drives the second proof into failure — an
/// un-migrated database has no `users` table, so the permitted-read probe cannot
/// succeed — and asserts the POOL IS NOT CREATED.
///
/// That is the behaviour that matters: if the boundary cannot be demonstrated,
/// the renderer gets no read channel at all rather than an unprotected one.
#[tokio::test]
async fn a_connection_that_cannot_prove_the_boundary_is_refused() {
    let db = TempDb::empty().await;

    let outcome = open_read_only_pool(db.path()).await;
    assert!(
        outcome.is_err(),
        "a read pool was opened on a connection that could not demonstrate the \
         confidentiality boundary — this is the fail-OPEN case and must not happen"
    );

    db.cleanup().await.unwrap();
}

// ===========================================================================
// PART 4 — what the boundary is NOT, stated as tests
// ===========================================================================

/// The authorizer is not what refuses writes, and this file does not pretend
/// otherwise. `read_only(true)` is still the integrity boundary, and it is still
/// there — asserted so that a future change to `read_guard` cannot quietly take
/// credit for Gate 2A's property while weakening it.
#[tokio::test]
async fn mutations_are_still_refused_by_the_read_only_handle() {
    let db = db_with_synthetic_credentials().await;
    let pool = open_read_only_pool(db.path()).await.expect("read pool");

    // Through the statement guard, as the renderer would reach it.
    for sql in [
        "UPDATE users SET pin_hash = 'mine' WHERE id = '00000000-0000-0000-0000-000000000002'",
        "UPDATE users SET role = 'owner'",
        "DELETE FROM owner_recovery",
        "INSERT INTO users (id, store_id, full_name, role) VALUES ('x','y','Z','owner')",
        "DROP TABLE owner_recovery",
    ] {
        must_be_refused(&pool, sql).await;
    }

    // And past it: the handle itself refuses, which is the actual boundary.
    for sql in [
        "UPDATE users SET pin_hash = 'mine'",
        "UPDATE users SET role = 'owner' RETURNING id",
        "DELETE FROM auth_audit",
    ] {
        let direct = pool.execute(sql).await;
        assert!(
            direct.is_err(),
            "a write reached the read-only handle: {sql} -> {direct:?}"
        );
    }

    // Nothing moved.
    let still = db
        .scalar_string("SELECT pin_hash FROM users WHERE id = '00000000-0000-0000-0000-000000000002'")
        .await;
    assert_eq!(still, SECRET, "the synthetic credential was modified");
    assert_eq!(db.count("SELECT count(*) AS n FROM owner_recovery").await, 1);

    close_sqlite_pool_checked(&pool, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// TRUSTED RUST STILL REACHES THE SECRET — which is the other half of the
/// design and would be easy to break by putting the authorizer in the wrong
/// place.
///
/// The authorizer belongs on the RENDERER-facing read pool only. Stage A.1's
/// authentication code verifies credentials through the write pool, which
/// carries no authorizer, so this asserts that path still works. A boundary that
/// also blinded the login code would be a boundary nobody could ship.
#[tokio::test]
async fn trusted_rust_can_still_read_the_credential_it_must_verify() {
    let db = db_with_synthetic_credentials().await;

    // The write pool — `posting::open_write_pool`, the one every command uses.
    let write = crate::posting::open_write_pool(db.path())
        .await
        .expect("write pool");

    let hash: String = sqlx::query_scalar(
        "SELECT pin_hash FROM users WHERE id = '00000000-0000-0000-0000-000000000002'",
    )
    .fetch_one(&write)
    .await
    .expect("trusted Rust must be able to read the credential it verifies against");
    assert_eq!(hash, SECRET);

    let recovery: String = sqlx::query_scalar("SELECT code_hash FROM owner_recovery")
        .fetch_one(&write)
        .await
        .expect("trusted Rust must be able to read the recovery hash");
    assert_eq!(recovery, RECOVERY_SECRET);

    // The renderer's pool, on the very same file, cannot.
    let read = open_read_only_pool(db.path()).await.expect("read pool");
    must_be_refused(&read, "SELECT pin_hash FROM users").await;
    must_be_refused(&read, "SELECT code_hash FROM owner_recovery").await;

    close_sqlite_pool_checked(&read, "read pool").await.unwrap();
    close_sqlite_pool_checked(&write, "write pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// WHAT THE REFUSAL ACTUALLY SAYS, and that it is the AUTHORIZER saying it.
///
/// Every refusal above is asserted as "this query was not answered", which on
/// its own would also pass if the query failed for an unrelated reason — a
/// missing column, a typo, a locked database. So the mechanism is pinned twice
/// here, and the second way is the one that cannot be fooled:
///
///   1. The observed message is recorded, so a future SQLite that changes its
///      refusal wording is noticed rather than silently reclassified.
///   2. THE COUNTERFACTUAL. The identical statement is run on a pool that
///      differs from the read pool in exactly one respect — no authorizer — and
///      it SUCCEEDS and returns the secret. That is what proves the refusal is
///      caused by this module and by nothing else.
#[tokio::test]
async fn the_refusal_comes_from_the_authorizer_and_not_from_something_else() {
    let db = db_with_synthetic_credentials().await;

    let read = open_read_only_pool(db.path()).await.expect("read pool");
    let refusal = renderer_read(&read, "SELECT pin_hash FROM users")
        .await
        .expect_err("must be refused");

    // (1) The engine's own authorizer wording, as observed on sqlite bundled
    // with libsqlite3-sys 0.30.1: "access to users.pin_hash is prohibited".
    let lowered = refusal.to_ascii_lowercase();
    assert!(
        lowered.contains("prohibited"),
        "the refusal does not look like an authorizer denial, so these tests may          be passing for the wrong reason. Observed: {refusal}"
    );
    assert!(
        lowered.contains("pin_hash"),
        "the refusal does not name the protected column. Observed: {refusal}"
    );

    // (2) The counterfactual: same file, same statement, no authorizer.
    let unguarded = crate::posting::open_write_pool(db.path())
        .await
        .expect("write pool");
    let leaked: String = sqlx::query_scalar("SELECT pin_hash FROM users WHERE pin_hash IS NOT NULL")
        .fetch_one(&unguarded)
        .await
        .expect("without the authorizer this statement is perfectly valid");
    assert_eq!(
        leaked, SECRET,
        "the counterfactual did not return the secret, so the comparison proves nothing"
    );

    // And the same for every spelling, so the headline test is known to be
    // exercising a real denial in each case rather than a schema accident.
    for sql in [
        "SELECT * FROM users",
        "SELECT u.pin_hash FROM users u",
        "WITH leaked AS (SELECT pin_hash FROM users) SELECT * FROM leaked",
        "SELECT length(pin_hash) FROM users",
        "SELECT code_hash FROM owner_recovery",
        "SELECT count(*) FROM auth_audit",
        "SELECT failed_attempts FROM users",
    ] {
        assert!(
            renderer_read(&read, sql).await.is_err(),
            "not refused: {sql}"
        );
        assert!(
            sqlx::query(sql).fetch_all(&unguarded).await.is_ok(),
            "the counterfactual failed for `{sql}`, so its refusal above may not              be the authorizer's doing"
        );
    }

    close_sqlite_pool_checked(&read, "read pool").await.unwrap();
    close_sqlite_pool_checked(&unguarded, "write pool").await.unwrap();
    db.cleanup().await.unwrap();
}

// ===========================================================================
// PART 4b — the two findings independent review raised against the first draft
// ===========================================================================

/// GZ-A0-P1 (independent review). `dbstat` reflects the CONTENT of other
/// tables, so naming only the protected table left its row count readable.
///
/// `libsqlite3-sys 0.30.1` compiles the amalgamation with
/// `-DSQLITE_ENABLE_DBSTAT_VTAB` (build.rs:126), so this is not hypothetical on
/// this build: `dbstat` exists on every connection. A query against it is
/// authorized as a read of `dbstat` and never as a read of the table it reports
/// on, so the first draft of the policy allowed
///
/// ```sql
///     SELECT sum(ncell) FROM dbstat WHERE name = 'owner_recovery'
/// ```
///
/// to return the exact number of recovery rows, plus page counts and payload
/// sizes that disclose how much is stored and when it last changed. For
/// `auth_audit` the same query counts failed logins — precisely what somebody
/// probing a PIN wants to know is not being recorded.
///
/// The correction denies the reflecting surfaces as TABLES. This test drives the
/// actual leak rather than asserting the list, and it proves `dbstat` is
/// unavailable for the unprotected tables too: nothing in the application reads
/// it, and a per-name policy INSIDE `dbstat` would be a second, weaker copy of
/// this one.
#[tokio::test]
async fn dbstat_cannot_be_used_to_count_a_protected_table() {
    let db = db_with_synthetic_credentials().await;

    // First, prove the surface really is present on this build, through a pool
    // with no authorizer. Without this the test could pass merely because
    // `dbstat` does not exist, which would prove nothing.
    let unguarded = crate::posting::open_write_pool(db.path())
        .await
        .expect("write pool");
    let reflected: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(ncell), 0) FROM dbstat WHERE name = 'owner_recovery'",
    )
    .fetch_one(&unguarded)
    .await
    .expect("dbstat must be compiled in for this test to be meaningful");
    assert!(
        reflected >= 1,
        "dbstat did not reflect the protected table's row, so this test is not \
         exercising the leak it was written for (got {reflected})"
    );

    // Now the renderer's channel: every route through the reflecting surfaces
    // is refused.
    let read = open_read_only_pool(db.path()).await.expect("read pool");
    for sql in [
        "SELECT sum(ncell) FROM dbstat WHERE name = 'owner_recovery'",
        "SELECT sum(ncell) FROM dbstat WHERE name = 'auth_audit'",
        "SELECT * FROM dbstat",
        "SELECT name, pageno, pagetype, ncell, payload FROM dbstat",
        "SELECT count(*) FROM dbstat",
        "SELECT d.ncell FROM dbstat d WHERE d.name LIKE 'owner%'",
        "WITH x AS (SELECT * FROM dbstat) SELECT sum(ncell) FROM x",
        "SELECT sum(payload) FROM dbstat",
        // The statistics tables are the same class. ANALYZE has not run here so
        // they may not exist; the assertion is that they are unreadable either
        // way, which is what a name-based denial gives.
        "SELECT * FROM sqlite_stat1",
        "SELECT * FROM sqlite_stat4",
    ] {
        must_be_refused(&read, sql).await;
    }

    close_sqlite_pool_checked(&read, "read pool").await.unwrap();
    close_sqlite_pool_checked(&unguarded, "write pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// GZ-A0-P2 (independent review). A GENERATED COLUMN can launder a protected
/// value past a denylist, which is why the policy is now an allowlist.
///
/// SQLite authorizes a read of the generated column and does NOT issue a second
/// `SQLITE_READ` for the column its expression reads, so under the first
/// draft's denylist
///
/// ```sql
///     ALTER TABLE users ADD COLUMN whoops TEXT GENERATED ALWAYS AS (pin_hash)
/// ```
///
/// made the credential readable under a name the policy had never heard of. No
/// such column exists in this schema; the defect was that its arrival would
/// have been SILENT.
///
/// This test creates exactly that column and proves it is denied — not because
/// it is listed anywhere, but because it is not on the `users` allowlist. The
/// same assertion covers the ordinary case of a future migration adding a
/// column nobody thought about, which is the behaviour the inversion is for.
#[tokio::test]
async fn a_generated_column_cannot_launder_the_credential() {
    let db = db_with_synthetic_credentials().await;

    // A STORED generated column cannot be added by ALTER TABLE in SQLite, but a
    // VIRTUAL one can — and virtual is the dangerous case, because it is
    // computed on read.
    db.exec("ALTER TABLE users ADD COLUMN whoops TEXT GENERATED ALWAYS AS (pin_hash) VIRTUAL")
        .await;
    db.exec(
        "ALTER TABLE users ADD COLUMN whoops_prefix TEXT
           GENERATED ALWAYS AS (substr(pin_hash, 1, 8)) VIRTUAL",
    )
    .await;
    // A column that is merely NEW, carrying nothing secret, to show the
    // allowlist denies by default rather than by cleverness.
    db.exec("ALTER TABLE users ADD COLUMN future_feature_flag INTEGER DEFAULT 0")
        .await;

    // Prove the laundering works where there is no authorizer, or the test
    // proves nothing.
    let unguarded = crate::posting::open_write_pool(db.path())
        .await
        .expect("write pool");
    let laundered: String = sqlx::query_scalar("SELECT whoops FROM users WHERE whoops IS NOT NULL")
        .fetch_one(&unguarded)
        .await
        .expect("a virtual generated column does return the value it computes");
    assert_eq!(
        laundered, SECRET,
        "the generated column did not launder the secret, so this test is not \
         exercising the defect it was written for"
    );

    // The renderer's channel denies all of them.
    let read = open_read_only_pool(db.path()).await.expect("read pool");
    for sql in [
        "SELECT whoops FROM users",
        "SELECT whoops_prefix FROM users",
        "SELECT u.whoops FROM users u",
        "SELECT length(whoops) FROM users",
        "WITH x AS (SELECT whoops FROM users) SELECT * FROM x",
        "SELECT count(*) FROM users WHERE whoops IS NOT NULL",
        // Deny-by-default: a harmless new column is refused too, until somebody
        // adds it to the allowlist on purpose. That is the trade this inversion
        // makes and it is the right way round.
        "SELECT future_feature_flag FROM users",
    ] {
        must_be_refused(&read, sql).await;
    }

    // And the identity columns still work, so the allowlist is not a wall.
    must_be_answered(&read, "SELECT id, full_name, role, active FROM users").await;
    must_be_answered(&read, "SELECT count(*) AS n FROM users").await;

    // THE PRECISION POINT independent review raised: permitting the EMPTY
    // column name (SQLite's signal for a read that extracts no column, which is
    // what `count(*)` compiles to) is not the same as permitting the rowid. An
    // explicit rowid is a real column name, is not on the allowlist, and is
    // denied. Pinned here so the distinction cannot be lost to a future tidy-up
    // of that branch.
    for sql in [
        "SELECT rowid FROM users",
        "SELECT _rowid_ FROM users",
        "SELECT oid FROM users",
        "SELECT u.rowid FROM users u",
    ] {
        must_be_refused(&read, sql).await;
    }

    close_sqlite_pool_checked(&read, "read pool").await.unwrap();
    close_sqlite_pool_checked(&unguarded, "write pool").await.unwrap();
    db.cleanup().await.unwrap();
}

/// The extension loader is refused.
///
/// `-DSQLITE_ENABLE_LOAD_EXTENSION=1` is compiled in (`libsqlite3-sys`
/// build.rs:131). The SQL function is supposed to stay inert until a connection
/// opts in through `sqlite3_db_config`, which this application never does — but
/// `load_extension()` succeeding means arbitrary native code running inside the
/// POS process, so the default is asserted rather than assumed and the
/// authorizer denies the function by name as well.
#[tokio::test]
async fn the_extension_loader_is_refused() {
    let db = db_with_synthetic_credentials().await;
    let read = open_read_only_pool(db.path()).await.expect("read pool");

    for sql in [
        "SELECT load_extension('evil')",
        "SELECT load_extension('evil', 'entry')",
        "SELECT id FROM users WHERE load_extension('evil') IS NULL",
    ] {
        must_be_refused(&read, sql).await;
    }

    close_sqlite_pool_checked(&read, "read pool").await.unwrap();
    db.cleanup().await.unwrap();
}

// ===========================================================================
// PART 5 — structural guards
// ===========================================================================

/// The policy must actually name the credential columns. A policy that silently
/// lost `pin_hash` would leave every test above passing for the wrong reason —
/// `must_be_refused` would still fail the build, but only because the column
/// does not exist on some other database. This pins the names.
#[test]
fn the_policy_names_the_credential_and_the_recovery_table() {
    let policy = crate::read_guard::policy_for_tests();

    assert!(
        policy.must_never_be_readable.contains(&("users", "pin_hash")),
        "the credential hash column is not in the policy"
    );
    for t in ["owner_recovery", "auth_audit"] {
        assert!(policy.tables.contains(&t), "{t} is not a protected table");
    }

    // The rate-limit state is protected too — see `read_guard`'s note on why
    // reading it is an attack and not merely untidy.
    for c in ["failed_attempts", "locked_until"] {
        assert!(
            policy.must_never_be_readable.contains(&("users", c)),
            "users.{c} is not in the policy"
        );
    }

    // THE REFLECTING SURFACES. Found by independent review: `dbstat` is
    // compiled in (`libsqlite3-sys` build.rs:126) and reports the row count and
    // payload sizes of any table by name, so a policy that named only
    // `owner_recovery` left its row count readable.
    for t in [
        "dbstat",
        "sqlite_stat1",
        "sqlite_stat4",
        "sqlite_dbpage",
        "sqlite_dbdata",
    ] {
        assert!(
            policy.tables.contains(&t),
            "{t} reflects the content of other tables and must be denied"
        );
    }

    assert!(
        policy.functions.contains(&"load_extension"),
        "the extension loader must be denied: its success is native code          execution inside the POS process"
    );
}

/// THE ENFORCEMENT IS AN ALLOWLIST, and the two lists may not contradict each
/// other.
///
/// `MUST_NEVER_BE_READABLE` is documentation and a test fixture;
/// `COLUMN_ALLOWLIST` is what the authorizer consults. An edit that added
/// `pin_hash` to the allowlist would pass every behavioural test in this file
/// by making the leak legal, so the two are cross-checked here. This is the
/// assertion that cannot be satisfied by weakening the policy.
#[test]
fn nothing_that_must_never_be_readable_is_on_the_allowlist() {
    let policy = crate::read_guard::policy_for_tests();

    for (table, column) in policy.must_never_be_readable {
        for (allow_table, allowed) in policy.allowlist {
            if !table.eq_ignore_ascii_case(allow_table) {
                continue;
            }
            for candidate in *allowed {
                assert!(
                    !column.eq_ignore_ascii_case(candidate),
                    "{table}.{column} is on the readable allowlist and must not be"
                );
            }
        }
    }

    // And `users` must actually BE allowlisted, or the credential columns are
    // protected by nothing at all.
    assert!(
        policy
            .allowlist
            .iter()
            .any(|(t, _)| t.eq_ignore_ascii_case("users")),
        "`users` is no longer column-allowlisted, so a new or generated column          on it would be readable by the renderer"
    );
}

/// `SELECT *` on `users` is now refused, so nothing in the frontend may rely on
/// it. Asserted against the source because it is a property of the whole read
/// surface, not of any one query: a repo that acquired `SELECT * FROM users`
/// would break at runtime on a screen nobody tests, which is the worst place to
/// find out.
#[test]
fn no_frontend_read_selects_every_column_of_users() {
    let mut offenders = Vec::new();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("lira-pos")
        .join("src");

    fn walk(dir: &std::path::Path, offenders: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, offenders);
                continue;
            }
            let is_source = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e, "ts" | "tsx"));
            if !is_source {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let lowered = text.to_ascii_lowercase();
            for needle in ["select * from users", "select u.* from users"] {
                if lowered.contains(needle) {
                    offenders.push(format!("{} contains `{needle}`", path.display()));
                }
            }
        }
    }

    walk(&root, &mut offenders);
    assert!(
        offenders.is_empty(),
        "the read boundary refuses every column of `users`, so these must name \
         their columns instead:\n{}",
        offenders.join("\n")
    );
}

/// The authorizer must be installed where EVERY connection passes, not where the
/// pool happens to be opened. `after_connect` is that place, and this pins it,
/// because moving the call out of the hook would leave the grown connections
/// uncovered and `every_connection_the_pool_grows_is_covered` is the only other
/// thing that would notice.
#[test]
fn the_authorizer_is_installed_on_the_connect_hook() {
    let src = include_str!("../read_api.rs");
    assert!(
        src.contains(".after_connect("),
        "the read pool no longer installs anything per-connection"
    );
    assert!(
        src.contains("read_guard::install"),
        "the read pool no longer installs the confidentiality authorizer"
    );
    assert!(
        src.contains(".read_only(true)"),
        "the read pool lost `read_only(true)` — the integrity boundary"
    );
}

/// `SQLITE_IGNORE` must never appear in the policy. It would make a protected
/// read SUCCEED with NULL, which is indistinguishable from "no credential is
/// set" and would turn the boundary into an oracle.
#[test]
fn the_policy_denies_rather_than_substituting_null() {
    let src = include_str!("../read_guard.rs");
    let code = src
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.starts_with("//") && !t.starts_with("///") && !t.starts_with("//!")
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !code.contains("SQLITE_IGNORE"),
        "the authorizer returns SQLITE_IGNORE somewhere; a protected read must be \
         REFUSED, not answered with NULL"
    );
    assert!(
        code.contains("SQLITE_DENY"),
        "the authorizer never denies anything"
    );
}
