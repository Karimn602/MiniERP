//! GATE 2A — the frontend database write boundary.
//!
//! Every test here runs against a brand-new disposable `TempDb`. No protected
//! database is opened; `test_support::assert_not_production_db` is the
//! structural guarantee of that and it is checked for every temporary file.
//!
//! The file is in two halves and the first one matters as much as the second.
//!
//! PART 1 proves the TRAP: tauri-plugin-sql's `select` is a complete write
//! channel, so dropping `sql:allow-execute` while keeping `sql:allow-select`
//! would have produced no boundary at all. This is asserted against a real
//! database rather than read off the plugin's source, because the whole point
//! of Gate 2A's Part B was not to take that on trust.
//!
//! PART 2 proves the FIX: the pool `read_api` actually opens refuses every
//! write at the engine, and the financial rows a cashier would want to move
//! are still exactly where they were afterwards.

use serde_json::{json, Value};
use sqlx::Executor;

use crate::read_api::{open_read_only_pool, run_select};
use crate::test_support::{close_sqlite_pool_checked, TempDb};

const P_COFFEE: &str = "11111111-1111-1111-1111-111111111111";
const STORE: &str = "00000000-0000-0000-0000-000000000001";

/// One stocked product with a price worth attacking.
async fn store_with_a_priced_product() -> TempDb {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO products
           (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
            price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand,
            is_active, is_service)
         VALUES ('{P_COFFEE}', '{STORE}', 'SKU-COF', 'Coffee 250g',
                 '00000000-0000-0000-0000-000000000010', 'inclusive',
                 900, 999, 10, 1, 0)"
    ))
    .await;
    db
}

async fn price(db: &TempDb) -> i64 {
    db.scalar_i64(&format!(
        "SELECT price_incl_vat_cents FROM products WHERE id = '{P_COFFEE}'"
    ))
    .await
}

// ===========================================================================
// PART 1 — the trap. `select` was never read-only.
// ===========================================================================

/// THE FINDING THAT SHAPED GATE 2A.
///
/// tauri-plugin-sql 2.4.0 implements the `select` command as
/// `sqlx::query(sql).fetch_all(pool)` against the read-WRITE pool, with no
/// statement-type check anywhere in the path (`wrapper.rs:214`). This test
/// performs exactly that call with an `UPDATE` and shows the row changes.
///
/// So the obvious hardening — "remove `sql:allow-execute`, keep
/// `sql:allow-select`" — would have left a complete write channel in place
/// behind a read-only-sounding name. That is why `read_api` exists and why the
/// capability file now grants no `sql:*` permission at all.
#[tokio::test]
async fn the_plugins_select_is_a_write_channel_which_is_why_allow_select_was_dropped() {
    let db = store_with_a_priced_product().await;
    assert_eq!(price(&db).await, 999);

    // Verbatim the shape of tauri-plugin-sql's `select`.
    let rows = db
        .pool()
        .fetch_all(sqlx::query(&format!(
            "UPDATE products SET price_incl_vat_cents = 1 WHERE id = '{P_COFFEE}'"
        )))
        .await
        .expect("fetch_all on an UPDATE does not even error");

    assert!(
        rows.is_empty(),
        "an UPDATE returns no rows, so a caller sees a successful empty read"
    );
    assert_eq!(
        price(&db).await,
        1,
        "`select` executed the UPDATE: it was a write channel, not a read one"
    );

    db.cleanup().await.expect("cleanup");
}

/// And it is not even a silent channel: `RETURNING` makes it a convenient one.
#[tokio::test]
async fn select_with_returning_both_mutates_and_reports() {
    let db = store_with_a_priced_product().await;

    let rows = db
        .pool()
        .fetch_all(sqlx::query(&format!(
            "UPDATE products SET price_incl_vat_cents = 7
              WHERE id = '{P_COFFEE}' RETURNING price_incl_vat_cents"
        )))
        .await
        .expect("UPDATE ... RETURNING through a select-shaped call");

    assert_eq!(rows.len(), 1, "RETURNING hands the new value straight back");
    assert_eq!(price(&db).await, 7);

    db.cleanup().await.expect("cleanup");
}

// ===========================================================================
// PART 2 — the fix. The read-only pool refuses writes at the engine.
// ===========================================================================

/// Open the read-only pool the way the command does, over a TempDb.
///
/// The read-write `TempDb` pool stays open for the lifetime of the test, which
/// is what keeps the WAL companions present — a read-only connection cannot
/// create them. That mirrors the running application, where the posting pool is
/// opened before any command can be served (`read_api::read_pool` makes that
/// ordering explicit).
async fn read_only_over(db: &TempDb) -> sqlx::SqlitePool {
    open_read_only_pool(db.path())
        .await
        .expect("the read-only pool opens over an existing database")
}

#[tokio::test]
async fn an_arbitrary_update_is_refused_and_the_price_does_not_move() {
    let db = store_with_a_priced_product().await;
    let ro = read_only_over(&db).await;

    let err = run_select(
        &ro,
        &format!("UPDATE products SET price_incl_vat_cents = 1 WHERE id = '{P_COFFEE}'"),
        vec![],
    )
    .await
    .expect_err("an UPDATE must be refused");
    assert!(
        err.contains("SELECT statements only"),
        "refused by the shape guard, with a message that says what to do: {err}"
    );

    assert_eq!(price(&db).await, 999, "the price is untouched");

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    db.cleanup().await.expect("cleanup");
}

/// THE IMPORTANT ONE: the guard is not the boundary, the CONNECTION is.
///
/// `run_select` is bypassed entirely here and the write is pushed straight at
/// the read-only pool, exactly as the plugin's `select` would have done. SQLite
/// itself refuses it. That is what makes the boundary a property of the engine
/// rather than of a string check somebody could widen.
#[tokio::test]
async fn the_connection_refuses_writes_even_with_the_shape_guard_bypassed() {
    let db = store_with_a_priced_product().await;
    let ro = read_only_over(&db).await;

    for sql in [
        format!("UPDATE products SET price_incl_vat_cents = 1 WHERE id = '{P_COFFEE}'"),
        format!("DELETE FROM products WHERE id = '{P_COFFEE}'"),
        "INSERT INTO users (id, store_id, full_name, role) \
         VALUES ('u-evil', '00000000-0000-0000-0000-000000000001', 'Evil', 'owner')"
            .to_string(),
        "UPDATE users SET role = 'owner'".to_string(),
        "DROP TABLE sale_payments".to_string(),
        format!(
            "UPDATE products SET price_incl_vat_cents = 2 WHERE id = '{P_COFFEE}' \
             RETURNING price_incl_vat_cents"
        ),
        // `PRAGMA query_only = OFF` is deliberately NOT in this list: the
        // connection accepts it. See
        // `query_only_can_be_turned_off_but_writes_still_fail` for what that
        // does and does not mean.
    ] {
        let result = ro.fetch_all(sqlx::query(&sql)).await;
        assert!(
            result.is_err(),
            "the read-only connection must refuse: {sql}"
        );
    }

    assert_eq!(
        price(&db).await,
        999,
        "no attack moved the price, including the RETURNING one"
    );

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    db.cleanup().await.expect("cleanup");
}

/// `PRAGMA query_only = OFF` SUCCEEDS on a read-only connection — and the
/// write still fails.
///
/// This test exists to stop a comfortable assumption coming back. The first
/// draft of `read_api` called `query_only` a second, independent boundary; it
/// is not one, because it can simply be switched off. What makes that
/// harmless is `read_only(true)`: the file handle itself cannot write, so the
/// pragma buys the caller nothing.
///
/// Both halves are asserted on ONE PINNED CONNECTION, so there is no question
/// of the pragma and the write landing on different members of the pool and
/// the result being an accident of pooling.
#[tokio::test]
async fn query_only_can_be_turned_off_but_writes_still_fail() {
    let db = store_with_a_priced_product().await;
    let ro = read_only_over(&db).await;

    let mut conn = ro.acquire().await.expect("acquire one connection");

    let pragma_err = conn
        .fetch_all(sqlx::query("PRAGMA query_only = OFF"))
        .await
        .err()
        .map(|e| e.to_string());
    assert!(
        pragma_err.is_none(),
        "SQLite accepts this on a read-only handle, so query_only is NOT a \
         boundary; got: {pragma_err:?}"
    );

    let write_err = conn
        .fetch_all(sqlx::query(&format!(
            "UPDATE products SET price_incl_vat_cents = 5 WHERE id = '{P_COFFEE}'"
        )))
        .await
        .err()
        .map(|e| e.to_string())
        .expect("but the write is still refused, by read_only(true)");
    assert!(
        write_err.contains("readonly database"),
        "refused by the file handle, not by the pragma: {write_err}"
    );
    drop(conn);

    assert_eq!(price(&db).await, 999, "the price did not move");

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    db.cleanup().await.expect("cleanup");
}

/// Financial rows specifically: the ones a cashier has a motive to move.
#[tokio::test]
async fn posted_financial_rows_cannot_be_touched_through_the_read_interface() {
    let db = store_with_a_priced_product().await;
    crate::test_support::seed_exchange_rate(&db).await;
    let ro = read_only_over(&db).await;

    let rate_before = db
        .scalar_i64("SELECT rate_lbp_per_usd FROM exchange_rates LIMIT 1")
        .await;

    for sql in [
        "UPDATE exchange_rates SET rate_lbp_per_usd = 1",
        "UPDATE sales SET total_incl_vat_cents = 0",
        "DELETE FROM sale_payments",
        "UPDATE sale_items SET unit_cogs_excl_vat_microcents = 0",
        "DELETE FROM inventory_movements",
        "UPDATE shifts SET expected_cash_usd_cents = 0",
        "UPDATE driver_ledger SET amount_cents = 0",
        "UPDATE supplier_ledger SET amount_cents = 0",
    ] {
        assert!(
            run_select(&ro, sql, vec![]).await.is_err(),
            "refused through run_select: {sql}"
        );
        assert!(
            ro.fetch_all(sqlx::query(sql)).await.is_err(),
            "refused by the connection too: {sql}"
        );
    }

    assert_eq!(
        db.scalar_i64("SELECT rate_lbp_per_usd FROM exchange_rates LIMIT 1")
            .await,
        rate_before,
        "the exchange rate post_sale validates against is unchanged"
    );
    assert_eq!(price(&db).await, 999);

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    db.cleanup().await.expect("cleanup");
}

/// A read interface that refused legitimate reads would be useless rather than
/// secure, so: the shapes the application actually uses still work, and the
/// JSON comes back in the shape `src/db/client.ts` promises its callers.
#[tokio::test]
async fn legitimate_reads_still_work_and_keep_their_types() {
    let db = store_with_a_priced_product().await;
    let ro = read_only_over(&db).await;

    let rows = run_select(
        &ro,
        "SELECT id, name, price_incl_vat_cents, is_active, avg_cost_excl_vat_microcents
           FROM products WHERE id = ? AND is_active = ?",
        vec![json!(P_COFFEE), json!(1)],
    )
    .await
    .expect("a parameterised SELECT works");

    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r["id"], Value::String(P_COFFEE.to_string()));
    assert_eq!(r["name"], Value::String("Coffee 250g".to_string()));
    // Integer money must arrive as an integer, not 999.0 — the whole of
    // `lib/money.ts` depends on that.
    assert_eq!(r["price_incl_vat_cents"], json!(999));
    assert!(r["price_incl_vat_cents"].is_i64());
    assert_eq!(r["is_active"], json!(1));
    assert_eq!(r["avg_cost_excl_vat_microcents"], json!(0));

    // NULL stays null rather than becoming 0 or "".
    let nulls = run_select(
        &ro,
        "SELECT description, category, icon FROM products WHERE id = ?",
        vec![json!(P_COFFEE)],
    )
    .await
    .expect("nullable columns read back");
    assert_eq!(nulls[0]["description"], Value::Null);
    assert_eq!(nulls[0]["category"], Value::Null);

    // Aggregates, joins and CTEs — the report shapes.
    // Scoped by id: a freshly migrated database already holds migration 003's
    // three demo products (deactivated by 019, but still rows), so an
    // unscoped COUNT here would be asserting the demo catalogue rather than
    // the read path.
    let agg = run_select(
        &ro,
        "SELECT COUNT(*) AS n, COALESCE(SUM(price_incl_vat_cents), 0) AS total
           FROM products WHERE id = ?",
        vec![json!(P_COFFEE)],
    )
    .await
    .expect("aggregate");
    assert_eq!(agg[0]["n"], json!(1));
    assert_eq!(agg[0]["total"], json!(999));

    let cte = run_select(
        &ro,
        "WITH p AS (SELECT id, name FROM products WHERE id = ?) SELECT name FROM p",
        vec![json!(P_COFFEE)],
    )
    .await
    .expect("a CTE is a read and is allowed");
    assert_eq!(cte.len(), 1);

    // A NULL parameter binds as NULL rather than the string "null".
    let bound_null = run_select(
        &ro,
        "SELECT COUNT(*) AS n FROM products WHERE id = ? AND description IS ?",
        vec![json!(P_COFFEE), Value::Null],
    )
    .await
    .expect("null bind");
    assert_eq!(bound_null[0]["n"], json!(1));

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    db.cleanup().await.expect("cleanup");
}

/// The read interface names no database: the path is resolved in Rust from
/// `app_config_dir()`, so there is no parameter through which a caller could
/// ask for another file. `ATTACH` is the one statement that could reach around
/// that, and it is now refused by BOTH layers.
///
/// GZ-A0 CHANGED THE SECOND HALF OF THIS TEST, and the change is a
/// strengthening rather than an adjustment. Gate 2A recorded an honest
/// residual here: the statement guard was the ONLY thing refusing `ATTACH`, and
/// a read-only connection reached out-of-band would accept one and read the
/// other file. The confidentiality authorizer installed by `read_guard` denies
/// `SQLITE_ATTACH` outright, so that residual is closed and the second half of
/// this test now asserts the refusal instead of documenting the gap. The
/// original assertions are kept in the comments below, because what a test used
/// to prove is part of why it looks the way it does.
#[tokio::test]
async fn no_other_database_can_be_reached() {
    let db = store_with_a_priced_product().await;
    let other = TempDb::new().await;
    let ro = read_only_over(&db).await;

    let attach = format!("ATTACH DATABASE '{}' AS other", other.path().display());

    // Layer one: the statement guard refuses the shape, with a readable message.
    let err = run_select(&ro, &attach, vec![])
        .await
        .expect_err("ATTACH must be refused");
    assert!(
        err.contains("SELECT statements only"),
        "refused by the shape guard: {err}"
    );

    // Nothing was attached, so the other database is not even nameable.
    let unreachable = run_select(&ro, "SELECT COUNT(*) AS n FROM other.products", vec![])
        .await
        .expect_err("the other database is not attached, so it cannot be read");
    assert!(
        unreachable.contains("no such table"),
        "unreachable because no ATTACH ever ran: {unreachable}"
    );

    // ---------------------------------------------------------------------
    // Layer two, out-of-band: what the CONNECTION permits. Until GZ-A0 this
    // was MORE than the guard did, and it was documented as a residual:
    //
    //     assert!(conn.fetch_all(sqlx::query(&attach)).await.is_ok(),
    //             "a read-only connection accepts ATTACH");
    //     assert!(conn.fetch_all(sqlx::query(
    //         "SELECT COUNT(*) FROM other.products")).await.is_ok(),
    //             "the attached file is readable on the connection that attached it");
    //
    // Both of those are now false, which is the point of the change. The
    // confidentiality authorizer denies SQLITE_ATTACH, so the renderer's read
    // channel cannot reach another file even if the statement guard were
    // removed tomorrow.
    // ---------------------------------------------------------------------

    // Still on ONE PINNED CONNECTION. An ATTACH binds to a single connection
    // and sqlx chooses which connection serves the next statement, so going
    // through the pool gives a non-deterministic answer — both outcomes were
    // observed while writing the Gate 2A version of this test. Pinning is what
    // makes the claim checkable rather than lucky.
    let mut conn = ro.acquire().await.expect("acquire one connection");

    // THE RESIDUAL IS CLOSED. The authorizer refuses the attach itself, so
    // there is never an attached database to read from.
    let denied = conn
        .fetch_all(sqlx::query(&attach))
        .await
        .err()
        .map(|e| e.to_string())
        .expect(
            "GZ-A0: the confidentiality authorizer must refuse ATTACH on a              renderer read connection, with or without the shape guard",
        );
    assert!(
        denied.to_ascii_lowercase().contains("not authorized")
            || denied.to_ascii_lowercase().contains("prohibited"),
        "refused by the authorizer rather than by something else: {denied}"
    );

    // And nothing is reachable under that name, because nothing was attached.
    assert!(
        conn.fetch_all(sqlx::query("SELECT COUNT(*) FROM other.products"))
            .await
            .is_err(),
        "no database was attached, so `other` must not resolve"
    );

    // The write clause still holds for the same reason it always did: the
    // handle cannot write. Asserted against `main`, since there is no attached
    // database left to try it on.
    let write_main = conn
        .fetch_all(sqlx::query("UPDATE products SET name = 'x'"))
        .await
        .err()
        .map(|e| e.to_string())
        .expect("writing through the read-only handle must not succeed");
    assert!(
        write_main.contains("readonly database"),
        "the read-only handle is still the integrity boundary: {write_main}"
    );
    drop(conn);

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    other.cleanup().await.expect("cleanup other");
    db.cleanup().await.expect("cleanup");
}

/// A read-only pool must not create a database. Otherwise a wrong path would
/// silently produce an empty shop instead of an error.
#[tokio::test]
async fn the_read_pool_refuses_to_conjure_a_missing_database() {
    let dir = std::env::temp_dir().join(format!("greaz-g2a-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let missing = dir.join("not-there.db");

    let err = open_read_only_pool(&missing)
        .await
        .expect_err("opening a database that does not exist must fail");
    assert!(
        err.contains("read-only pool"),
        "and say which pool failed: {err}"
    );
    assert!(
        !missing.exists(),
        "and must not have created the file on the way"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// WAL initialisation, which the Gate 1 backup procedure depends on, still
/// happens — and it is now Rust's job (`db_init`) rather than the frontend's.
///
/// The read-only pool can read a WAL database, which is the half that was not
/// obvious: a read-only connection cannot CREATE the `-shm` file, so this only
/// works because a read-write pool is open first. `read_api::read_pool`
/// enforces that ordering in the application; here the `TempDb` pool is it.
#[tokio::test]
async fn a_wal_database_is_readable_through_the_read_only_pool() {
    let db = store_with_a_priced_product().await;
    db.exec("PRAGMA journal_mode = WAL").await;
    assert_eq!(
        db.scalar_string("PRAGMA journal_mode").await.to_lowercase(),
        "wal"
    );

    // A committed write that is still in the WAL.
    db.exec(&format!(
        "UPDATE products SET price_incl_vat_cents = 1250 WHERE id = '{P_COFFEE}'"
    ))
    .await;

    let ro = read_only_over(&db).await;
    let rows = run_select(
        &ro,
        "SELECT price_incl_vat_cents AS p FROM products WHERE id = ?",
        vec![json!(P_COFFEE)],
    )
    .await
    .expect("read a WAL database read-only");
    assert_eq!(
        rows[0]["p"],
        json!(1250),
        "and see the WAL-resident commit, not a stale main-file value"
    );

    close_sqlite_pool_checked(&ro, "read-only pool").await.expect("close");
    db.cleanup().await.expect("cleanup");
}

/// The capability file IS the boundary declaration, so it is asserted as data.
///
/// Any `sql:*` permission here hands the renderer a pool it can write through —
/// `sql:allow-select` included, as PART 1 proves. A test that reads the shipped
/// JSON is the cheapest possible guard against that line coming back during a
/// merge.
#[test]
fn the_capability_file_grants_the_renderer_no_sql_access() {
    let raw = include_str!("../../capabilities/default.json");
    let cfg: serde_json::Value = serde_json::from_str(raw).expect("capability JSON parses");

    let perms = cfg["permissions"]
        .as_array()
        .expect("permissions is an array");
    let names: Vec<&str> = perms.iter().filter_map(|p| p.as_str()).collect();

    for forbidden in [
        "sql:default",
        "sql:allow-execute",
        "sql:allow-select",
        "sql:allow-load",
        "sql:allow-close",
    ] {
        assert!(
            !names.contains(&forbidden),
            "capabilities/default.json must not grant {forbidden}: the renderer \
             would have a writable pool again. Reads go through db_select."
        );
    }
    assert!(
        !names.iter().any(|n| n.starts_with("sql:")),
        "no sql:* permission at all, found: {names:?}"
    );
    assert!(
        names.contains(&"core:default"),
        "core:default is still needed for invoke"
    );
}

/// There must be no second way in from TypeScript either: the capability is
/// moot if the frontend still ships a raw-write helper.
#[test]
fn the_frontend_client_exposes_no_write_helper() {
    let client = include_str!("../../../src/db/client.ts");
    assert!(
        !client.contains("export async function execute"),
        "src/db/client.ts must not export a write helper"
    );
    // The word appears in the module's own history note, so the assertion is
    // about an IMPORT, not a mention.
    assert!(
        !client.contains("from \"@tauri-apps/plugin-sql\""),
        "src/db/client.ts must not import the SQL plugin"
    );
    assert!(
        !client.contains("Database.load"),
        "src/db/client.ts must not open a plugin database handle"
    );
    assert!(
        client.contains("db_select"),
        "reads must go through the db_select command"
    );
}
