// GZ-G2A-P1 — foreign keys are enforced on EVERY writable connection.
//
// THE DEFECT THESE TESTS EXIST FOR
//
// `posting::pool` used to be `SqlitePool::connect(url)` followed by one
// `PRAGMA foreign_keys = ON` executed *through the pool*. `PRAGMA foreign_keys`
// is per-connection and resets to SQLite's default on each new connection,
// while a statement executed through a pool acquires ONE connection — so that
// statement configured whichever connection served it and said nothing about
// the other nine. `shifts.store_id` and `shifts.opened_by_user_id` are both
// `NOT NULL REFERENCES` and `open_shift_tx` inserts without first proving
// either exists, so an orphan shift on a later connection was the reachable
// case.
//
// WHY NO EXISTING TEST CAUGHT IT
//
// `TempDb`'s own pool is `max_connections(1)`, so every posting test ran on the
// one connection the pragma had configured, and `TempDb::rival_pool` carried a
// hand-copied version of the production code under a comment claiming it was
// "configured exactly as `posting::pool` configures production" — which it was,
// bug included. A copy cannot contradict its original. Both now go through
// `posting::open_write_pool`.
//
// WHAT THESE TESTS ASSERT, AND AT WHAT LEVEL
//
// Every assertion here is at the DATABASE level: `PRAGMA foreign_keys` read
// back from each connection, and real constraint-violating INSERTs that SQLite
// itself must refuse. A command that validates an id before inserting would
// pass a command-level test with foreign keys off entirely, so command checks
// are used only as the extra layer in `open_shift_cannot_persist_an_orphan_shift`,
// never as the evidence.
//
// They drive `posting::open_write_pool` — THE function the application opens its
// writable pool with — rather than re-typing its options here.

use sqlx::{Executor, Row};

use crate::posting::{
    close_shift_with_pool, open_shift_with_pool, open_write_pool, post_sale_with_pool,
    CloseShiftPayload, OpenShiftPayload,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SHIFT_T: &str = "00000000-0000-0000-0000-0000000000b1";
const GHOST_STORE: &str = "deadbeef-0000-0000-0000-00000000dead";
const GHOST_USER: &str = "deadbeef-0000-0000-0000-00000000beef";

/// The number of simultaneous connections these tests hold open.
///
/// Three is the minimum that makes the point: one is the connection the old
/// pool-level pragma would have configured, and the others are the ones it
/// never reached.
const CONNECTIONS: usize = 3;

/// Is this error SQLite refusing a foreign key?
///
/// Checked by extended result code 787 (`SQLITE_CONSTRAINT_FOREIGNKEY`) rather
/// than by message text, with the message as a secondary assertion — a code is
/// a contract and a sentence is not.
fn is_foreign_key_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code().map(|c| c.to_string()))
        .map(|c| c == "787")
        .unwrap_or(false)
}

/// A store with stock, on a disposable database.
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

// ---------------------------------------------------------------------------
// A, B, C — a real pool, several connections at once, each one enforcing.
// ---------------------------------------------------------------------------

/// Hold three connections of the production pool open at once and prove each is
/// a distinct live connection with foreign keys enforced.
///
/// Distinctness is proved with `CREATE TEMP TABLE`, which is connection-local in
/// SQLite: each connection creates its own marker and must see its own and only
/// its own. Comparing pool bookkeeping would prove what sqlx believes; comparing
/// temp tables proves what the engine has.
#[tokio::test]
async fn every_concurrent_connection_of_the_write_pool_enforces_foreign_keys() {
    let db = store_with_coffee().await;
    let pool = open_write_pool(db.path())
        .await
        .expect("open the production write pool");

    // A + B. Acquire several connections and keep them all checked out, so they
    // cannot be the same connection handed round.
    let mut held = Vec::new();
    for _ in 0..CONNECTIONS {
        held.push(pool.acquire().await.expect("acquire a pooled connection"));
    }
    assert!(
        pool.size() as usize >= CONNECTIONS,
        "the pool must really hold {CONNECTIONS} connections, it reports {}",
        pool.size()
    );

    for (i, conn) in held.iter_mut().enumerate() {
        conn.execute(format!("CREATE TEMP TABLE marker_{i} (x INTEGER)").as_str())
            .await
            .expect("create a connection-local temp table");
    }
    for (i, conn) in held.iter_mut().enumerate() {
        let names: Vec<String> = sqlx::query(
            "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name LIKE 'marker_%'",
        )
        .fetch_all(&mut **conn)
        .await
        .expect("list this connection's temp tables")
        .iter()
        .map(|r| r.get::<String, _>("name"))
        .collect();
        assert_eq!(
            names,
            vec![format!("marker_{i}")],
            "connection {i} must see only its own temp table — these are not \
             {CONNECTIONS} distinct live connections otherwise"
        );
    }

    // C. Every one of them enforces foreign keys.
    for (i, conn) in held.iter_mut().enumerate() {
        let on: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut **conn)
            .await
            .expect("read PRAGMA foreign_keys");
        assert_eq!(on, 1, "connection {i} has foreign keys OFF");
    }

    drop(held);
    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// D — each connection actually refuses a violating write.
// ---------------------------------------------------------------------------

/// `PRAGMA foreign_keys = 1` is a claim; a refused INSERT is the behaviour.
///
/// Every connection is asked to write a `shifts` row naming a store and a user
/// that do not exist — the exact orphan the old pool made reachable — and must
/// be refused by the engine with `SQLITE_CONSTRAINT_FOREIGNKEY`.
#[tokio::test]
async fn every_concurrent_connection_refuses_a_foreign_key_violation() {
    let db = store_with_coffee().await;
    let pool = open_write_pool(db.path())
        .await
        .expect("open the production write pool");

    let mut held = Vec::new();
    for _ in 0..CONNECTIONS {
        held.push(pool.acquire().await.expect("acquire a pooled connection"));
    }

    for (i, conn) in held.iter_mut().enumerate() {
        let err = sqlx::query(
            "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                                 opening_cash_usd_cents, opening_cash_lbp, status)
             VALUES (?, ?, ?, '2026-11-07T12:00:00.000Z', 0, 0, 'open')",
        )
        .bind(format!("00000000-0000-0000-0000-00000000fk0{i}"))
        .bind(GHOST_STORE)
        .bind(GHOST_USER)
        .execute(&mut **conn)
        .await
        .expect_err("connection {i} accepted an orphan shift");

        assert!(
            is_foreign_key_violation(&err),
            "connection {i} must refuse with SQLITE_CONSTRAINT_FOREIGNKEY (787), got: {err}"
        );
        assert!(
            err.to_string().contains("FOREIGN KEY constraint failed"),
            "connection {i} error should name the constraint, got: {err}"
        );
    }

    drop(held);

    // Nothing was written by any of them.
    let orphans: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM shifts WHERE store_id = ? OR opened_by_user_id = ?",
    )
    .bind(GHOST_STORE)
    .bind(GHOST_USER)
    .fetch_one(&pool)
    .await
    .expect("count orphan shifts");
    assert_eq!(orphans, 0, "an orphan shift reached the database");

    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// E — released and reused connections still enforce.
// ---------------------------------------------------------------------------

/// A connection returned to the pool and handed out again still enforces.
///
/// This is the half a `.execute(&pool)` pragma could never cover: sqlx reuses
/// pooled connections, and if enforcement were applied once per POOL rather
/// than per CONNECTION, a reused connection would be whatever the previous
/// borrower left it as.
#[tokio::test]
async fn released_and_reacquired_connections_still_enforce_foreign_keys() {
    let db = store_with_coffee().await;
    let pool = open_write_pool(db.path())
        .await
        .expect("open the production write pool");

    for round in 0..3 {
        let mut held = Vec::new();
        for _ in 0..CONNECTIONS {
            held.push(pool.acquire().await.expect("acquire a pooled connection"));
        }
        for (i, conn) in held.iter_mut().enumerate() {
            let on: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&mut **conn)
                .await
                .expect("read PRAGMA foreign_keys");
            assert_eq!(
                on, 1,
                "round {round}, connection {i}: foreign keys OFF after reuse"
            );

            let err = sqlx::query(
                "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                                     opening_cash_usd_cents, opening_cash_lbp, status)
                 VALUES (?, ?, ?, '2026-11-07T12:00:00.000Z', 0, 0, 'open')",
            )
            .bind(format!("00000000-0000-0000-0000-0000000r{round}{i}0"))
            .bind(GHOST_STORE)
            .bind(USER_ID)
            .execute(&mut **conn)
            .await
            .expect_err("a reused connection accepted an orphan shift");
            assert!(
                is_foreign_key_violation(&err),
                "round {round}, connection {i}: expected a foreign-key refusal, got {err}"
            );
        }
        drop(held);
    }

    // A connection whose previous borrower turned enforcement OFF must not come
    // back out of the pool that way. (Nothing in the application does this; the
    // point is that the guarantee is per-connection at establish time, so even
    // deliberate sabotage of one borrow cannot leak into the next connection.)
    {
        let mut conn = pool.acquire().await.expect("acquire");
        conn.execute("PRAGMA foreign_keys = OFF").await.expect("turn it off");
        let off: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut *conn)
            .await
            .expect("read it back");
        assert_eq!(off, 0, "the sabotage must actually have taken effect");
    }
    // Every connection currently in the pool is asked again.
    let mut held = Vec::new();
    for _ in 0..CONNECTIONS {
        held.push(pool.acquire().await.expect("acquire a pooled connection"));
    }
    let mut states = Vec::new();
    for conn in held.iter_mut() {
        states.push(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&mut **conn)
                .await
                .expect("read PRAGMA foreign_keys"),
        );
    }
    drop(held);
    assert!(
        states.iter().all(|&s| s == 1),
        "a connection came back out of the pool with foreign keys OFF: {states:?}. \
         sqlx does not reset session pragmas on release, so enforcement has to be \
         established per connection — which is what this suite protects."
    );

    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// F — the command path Codex named.
// ---------------------------------------------------------------------------

/// `open_shift` cannot persist an orphan shift, on any connection.
///
/// Two layers, and the second is the one that matters: the command refuses, AND
/// the same INSERT issued directly on a pooled connection is refused by SQLite.
/// Without the second, this test would pass with foreign keys off entirely.
#[tokio::test]
async fn open_shift_cannot_persist_an_orphan_shift() {
    let db = store_with_coffee().await;
    let pool = open_write_pool(db.path())
        .await
        .expect("open the production write pool");

    // Warm several connections so the command is not guaranteed the first one.
    {
        let mut held = Vec::new();
        for _ in 0..CONNECTIONS {
            held.push(pool.acquire().await.expect("acquire"));
        }
        drop(held);
    }

    // A store that does not exist.
    let bad_store = open_shift_with_pool(&pool, open_payload(SHIFT_T, GHOST_STORE, USER_ID)).await;
    assert!(
        bad_store.is_err(),
        "open_shift accepted a shift for a store that does not exist: {bad_store:?}"
    );

    // A user that does not exist.
    let bad_user = open_shift_with_pool(&pool, open_payload(SHIFT_T, STORE_ID, GHOST_USER)).await;
    assert!(
        bad_user.is_err(),
        "open_shift accepted a shift opened by a user that does not exist: {bad_user:?}"
    );

    // Both at once.
    let both =
        open_shift_with_pool(&pool, open_payload(SHIFT_T, GHOST_STORE, GHOST_USER)).await;
    assert!(both.is_err(), "open_shift accepted a wholly orphan shift: {both:?}");

    // And nothing is in the table — not the row, not a half of one.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&pool)
        .await
        .expect("count shifts");
    assert_eq!(rows, 0, "an orphan shift was persisted");

    // The engine-level assertion, on every connection, for the same insert the
    // command issues.
    let mut held = Vec::new();
    for _ in 0..CONNECTIONS {
        held.push(pool.acquire().await.expect("acquire"));
    }
    for (i, conn) in held.iter_mut().enumerate() {
        let err = sqlx::query(
            "INSERT INTO shifts (id, store_id, device_id, opened_by_user_id, opened_at,
                                 opening_cash_usd_cents, opening_cash_lbp, status)
             SELECT ?, ?, NULL, ?, '2026-11-07T12:00:00.000Z', 0, 0, 'open'
              WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE store_id = ? AND status = 'open')",
        )
        .bind(format!("00000000-0000-0000-0000-00000000os0{i}"))
        .bind(GHOST_STORE)
        .bind(GHOST_USER)
        .bind(GHOST_STORE)
        .execute(&mut **conn)
        .await
        .expect_err("a connection accepted open_shift's own INSERT with orphan ids");
        assert!(
            is_foreign_key_violation(&err),
            "connection {i}: expected SQLITE_CONSTRAINT_FOREIGNKEY, got {err}"
        );
    }
    drop(held);

    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// G — legitimate work is unaffected.
// ---------------------------------------------------------------------------

/// Enforcement on every connection breaks nothing that was already valid.
///
/// A shift opens, a sale posts, the shift closes, and master-data rows with
/// correct parents insert — all through the pool that now enforces on every
/// connection, with several connections warmed first.
#[tokio::test]
async fn valid_shifts_sales_and_master_data_still_work() {
    let db = store_with_coffee().await;
    let pool = open_write_pool(db.path())
        .await
        .expect("open the production write pool");

    {
        let mut held = Vec::new();
        for _ in 0..CONNECTIONS {
            held.push(pool.acquire().await.expect("acquire"));
        }
        drop(held);
    }

    // A real shift.
    let snapshot = open_shift_with_pool(&pool, open_payload(SHIFT_T, STORE_ID, USER_ID))
        .await
        .expect("a valid shift must still open");
    assert_eq!(snapshot.status, "open");

    // A real sale into it.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(2)
        .unit_incl(500)
        .build()];
    let mut payload = sale_payload(lines, vec![cash_usd(1_000)]);
    payload.shift_id = Some(SHIFT_T.to_string());
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(&pool, payload)
        .await
        .expect("a valid sale must still post");

    let posted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales WHERE id = ? AND status = 'posted'")
        .bind(&sale_id)
        .fetch_one(&pool)
        .await
        .expect("count the posted sale");
    assert_eq!(posted, 1, "the sale did not post");

    // Master data with correct parents — the shape the admin commands write.
    sqlx::query(
        "INSERT INTO drivers (id, store_id, name, is_active)
         VALUES ('00000000-0000-0000-0000-00000000dr01', ?, 'Ali', 1)",
    )
    .bind(STORE_ID)
    .execute(&pool)
    .await
    .expect("a driver with a real store must insert");
    sqlx::query(
        "INSERT INTO suppliers (id, store_id, name, is_active)
         VALUES ('00000000-0000-0000-0000-00000000su01', ?, 'Beirut Dry Goods', 1)",
    )
    .bind(STORE_ID)
    .execute(&pool)
    .await
    .expect("a supplier with a real store must insert");

    // And the shift closes, reconciliation and all.
    close_shift_with_pool(
        &pool,
        CloseShiftPayload {
            shift_id: SHIFT_T.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 6_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("a valid shift must still close");

    let closed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts WHERE id = ? AND status = 'closed'")
        .bind(SHIFT_T)
        .fetch_one(&pool)
        .await
        .expect("count the closed shift");
    assert_eq!(closed, 1, "the shift did not close");

    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// H — a refused write leaves nothing behind.
// ---------------------------------------------------------------------------

/// A foreign-key refusal inside a transaction leaves no partial financial data.
///
/// The transaction writes one legitimate row, then a violating one. The refusal
/// must abort the whole transaction, so neither row survives — which is the
/// property that makes "the engine refuses it" worth anything: a refusal that
/// left the first half of a document behind would be worse than no refusal.
#[tokio::test]
async fn a_refused_foreign_key_write_leaves_no_partial_data() {
    let db = store_with_coffee().await;
    let pool = open_write_pool(db.path())
        .await
        .expect("open the production write pool");

    let mut tx = pool.begin().await.expect("begin");

    // Legitimate: a driver of the real store.
    sqlx::query(
        "INSERT INTO drivers (id, store_id, name, is_active)
         VALUES ('00000000-0000-0000-0000-00000000dr99', ?, 'Hassan', 1)",
    )
    .bind(STORE_ID)
    .execute(&mut *tx)
    .await
    .expect("the valid row must insert inside the transaction");

    // Violating: a shift for a store that does not exist.
    let err = sqlx::query(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                             opening_cash_usd_cents, opening_cash_lbp, status)
         VALUES ('00000000-0000-0000-0000-00000000sh99', ?, ?, '2026-11-07T12:00:00.000Z', 0, 0, 'open')",
    )
    .bind(GHOST_STORE)
    .bind(USER_ID)
    .execute(&mut *tx)
    .await
    .expect_err("the violating row must be refused");
    assert!(
        is_foreign_key_violation(&err),
        "expected SQLITE_CONSTRAINT_FOREIGNKEY, got {err}"
    );

    // The caller's transaction is abandoned, as a posting command's would be.
    drop(tx);

    let drivers: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM drivers WHERE id = '00000000-0000-0000-0000-00000000dr99'")
            .fetch_one(&pool)
            .await
            .expect("count drivers");
    let shifts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shifts WHERE id = '00000000-0000-0000-0000-00000000sh99'")
            .fetch_one(&pool)
            .await
            .expect("count shifts");
    assert_eq!(drivers, 0, "the legitimate half of a refused transaction survived");
    assert_eq!(shifts, 0, "the violating row survived");

    pool.close().await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// The regression guard on the shape of the fix itself.
// ---------------------------------------------------------------------------

/// Enforcement must be established with the CONNECTION, not run through the
/// pool afterwards.
///
/// This reads the source, which is unusual and deliberate: the two shapes are
/// behaviourally identical on sqlx 0.8 — which defaults this pragma to `ON`
/// (`sqlx-sqlite-0.8.6/src/options/mod.rs:185`), and is why the old code
/// measured correct — so no runtime assertion can tell them apart today. What
/// makes one wrong is that it depends on that default: the moment it changes,
/// or a caller builds the options differently, the pool-level pragma covers one
/// connection of ten and the tests above would start failing in production
/// rather than here. So the structure is pinned where the structure is the risk.
#[test]
fn the_write_pool_sets_foreign_keys_on_the_connection_options() {
    let src = include_str!("../posting.rs");
    let open = src
        .split("pub(crate) async fn open_write_pool")
        .nth(1)
        .expect("open_write_pool must exist");
    let body = open.split("\n/// ").next().unwrap_or(open);

    assert!(
        body.contains(".foreign_keys(true)"),
        "open_write_pool must set .foreign_keys(true) on SqliteConnectOptions"
    );
    assert!(
        body.contains("connect_with"),
        "open_write_pool must use connect_with, so the options reach every connection"
    );
    assert!(
        !src.contains(r#"sqlx::query("PRAGMA foreign_keys = ON;")"#),
        "posting.rs must not configure foreign keys by running a PRAGMA through \
         the pool: that reaches one connection of ten. Set it on the connection \
         options instead."
    );
}

/// What the OLD pool shape actually did, measured rather than assumed.
///
/// This exists because the severity of GZ-G2A-P1 depends on a fact that can
/// only be measured: `SqlitePool::connect(url)` parses the URL into the same
/// `SqliteConnectOptions` that `new()` produces, and sqlx 0.8 seeds that struct
/// with `foreign_keys = ON` (`sqlx-sqlite-0.8.6/src/options/mod.rs:185`), which
/// it then applies while establishing EVERY connection. So the old code's
/// one-time `PRAGMA foreign_keys = ON` through the pool was redundant rather
/// than load-bearing, and enforcement was in fact on for every connection.
///
/// That is worth recording precisely, in both directions:
///
///   * It means no orphan row can have been written by a shipped build on this
///     sqlx version. The defect was LATENT, not live — the audit trail of any
///     existing database is not in question.
///   * It also means the guarantee rested entirely on a library default that
///     nothing in this repository asserted, stated, or would have noticed
///     changing. `foreign_keys(true)` is now explicit in `open_write_pool`, and
///     the suite above holds the behaviour.
///
/// IF THIS TEST EVER FAILS, read it as the alarm it is: sqlx's default has
/// changed, the old shape would now be a live defect, and every hand-rolled
/// pool anywhere in this codebase needs the same explicit treatment
/// `open_write_pool` has.
#[tokio::test]
async fn the_old_pool_shape_was_latently_wrong_not_live_wrong() {
    use sqlx::SqlitePool;

    let db = store_with_coffee().await;

    // The pre-correction construction, verbatim: a URL, the sqlx default pool
    // size, and one pragma executed THROUGH the pool.
    let url = format!("sqlite://{}?mode=rwc", db.path().display());
    let old = SqlitePool::connect(&url).await.expect("open the old-shape pool");
    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(&old)
        .await
        .expect("the old one-time pragma");

    let mut held = Vec::new();
    for _ in 0..CONNECTIONS {
        held.push(old.acquire().await.expect("acquire"));
    }
    let mut states = Vec::new();
    for conn in held.iter_mut() {
        states.push(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&mut **conn)
                .await
                .expect("read PRAGMA foreign_keys"),
        );
    }
    drop(held);

    assert!(
        states.iter().all(|&s| s == 1),
        "MEASURED CHANGE: the old pool shape now leaves connections with foreign \
         keys OFF ({states:?}). sqlx's default must have changed. GZ-G2A-P1 was \
         latent on sqlx 0.8.6; it would now be live, and anything still opening a \
         pool that way is writing orphans. See open_write_pool."
    );

    old.close().await;
    db.cleanup().await.expect("remove TempDb");
}
