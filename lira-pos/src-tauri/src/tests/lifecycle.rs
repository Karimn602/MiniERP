// Layer C — database lifecycle: connection shutdown, WAL checkpointing, and
// what a backup copy actually contains.
//
// Pilot 001 closed the sandbox application gracefully and found `greaz-pos.db-wal`
// and `greaz-pos.db-shm` still on disk, which `docs/BACKUP.md` treats as the
// signature of an unclean exit. These tests establish what is really happening,
// on disposable databases, and pin the behaviour the correction depends on.
//
// The production topology being modelled is TWO pools against ONE file:
//
//   * tauri-plugin-sql's pool — runs the migrations, serves every read, and is
//     closed on `RunEvent::Exit` by the plugin itself (plugin `lib.rs:174`).
//     `TempDb`'s own pool stands in for it here.
//   * Greaz's own `posting::DbState` pool — every transactional write.
//     `TempDb::rival_pool()` stands in for it: same `sqlite://…?mode=rwc` URL,
//     same `SqlitePool::connect`, same pragma.
//
// SQLite checkpoints a WAL and unlinks the sidecars when the LAST connection to
// the file closes. That is the whole mechanism these tests turn on.

use std::path::{Path, PathBuf};

use crate::posting::post_sale_with_pool;
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";

/// Put a disposable database into WAL mode, exactly as the real one gets there.
///
/// Production is in WAL for ONE reason: `src/db/migrate.ts::ensureDbReady` runs
/// `PRAGMA journal_mode = WAL` at startup, and the setting is persisted in the
/// database header. Neither the Rust pool nor sqlx does it — see
/// `sqlx_does_not_open_in_wal_the_frontend_pragma_does`. `TempDb` therefore
/// starts in `delete` mode, so a lifecycle test has to put it where production
/// actually is before any of this is meaningful.
async fn enable_wal(db: &TempDb) {
    use sqlx::Row;
    let mode: String = sqlx::query("PRAGMA journal_mode = WAL")
        .fetch_one(db.pool())
        .await
        .expect("set journal_mode = WAL")
        .try_get(0)
        .expect("decode journal_mode");
    assert_eq!(mode.to_lowercase(), "wal", "the disposable database must be in WAL");
}

/// A store that can post one sale, in WAL mode like production.
async fn store_with_coffee() -> TempDb {
    let db = TempDb::new().await;
    enable_wal(&db).await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            price_excl_vat_cents: 450,
            price_incl_vat_cents: 500,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")
        },
    )
    .await;
    db
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut p = path.to_path_buf().into_os_string();
    p.push(suffix);
    PathBuf::from(p)
}

fn wal_of(path: &Path) -> PathBuf {
    sidecar(path, "-wal")
}

fn shm_of(path: &Path) -> PathBuf {
    sidecar(path, "-shm")
}

/// A disposable path beside the test databases, for copies and snapshots.
fn scratch_path(tag: &str) -> PathBuf {
    let p = std::env::temp_dir()
        .join("greaz-pos-tests")
        .join(format!("{}-{}.db", tag, uuid::Uuid::new_v4()));
    assert_not_production_db(&p);
    p
}

fn forget(path: &Path) {
    for suffix in ["-wal", "-shm", ""] {
        let _ = std::fs::remove_file(sidecar(path, suffix));
    }
}

/// Post one $5.00 sale through the given pool and return its id.
async fn post_one_sale(pool: &sqlx::SqlitePool) -> String {
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(1).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(500)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(pool, payload).await.expect("sale posts");
    sale_id
}

async fn sales_count(pool: &sqlx::SqlitePool) -> i64 {
    use sqlx::Row;
    sqlx::query("SELECT COUNT(*) FROM sales")
        .fetch_one(pool)
        .await
        .expect("count sales")
        .try_get::<i64, _>(0)
        .expect("decode count")
}

/// Open a pool on an arbitrary file the way production opens its own.
async fn open_like_production(path: &Path) -> sqlx::SqlitePool {
    assert_not_production_db(path);
    let url = format!("sqlite://{}?mode=rwc", path.display());
    sqlx::SqlitePool::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("open pool on {}: {e}", path.display()))
}

// ============================================================================
// What the production pool shape actually configures
// ============================================================================

/// WHERE WAL ACTUALLY COMES FROM — and it is not the Rust side.
///
/// `posting::pool` opens `sqlite://<path>?mode=rwc` through `SqlitePool::connect`
/// and sets only `PRAGMA foreign_keys`. That connection opens the file in
/// SQLite's default `delete` journal mode. The live database is in WAL purely
/// because `src/db/migrate.ts` issues `PRAGMA journal_mode = WAL` from the
/// frontend at startup, and WAL is persisted in the file header — after which
/// every later connection, Rust or JavaScript, inherits it.
///
/// This matters twice over. It is why the Rust test suite has never exercised
/// WAL at all, and it is why a hypothetical headless or Rust-only entry point
/// would silently run without it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlx_does_not_open_in_wal_the_frontend_pragma_does() {
    use sqlx::Row;
    let db = TempDb::new().await;

    let before: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(db.pool())
        .await
        .expect("read journal_mode")
        .try_get(0)
        .expect("decode");
    assert_eq!(
        before.to_lowercase(),
        "delete",
        "sqlx does NOT open Greaz's database in WAL; only migrate.ts does"
    );

    // What the frontend does at startup.
    enable_wal(&db).await;

    // A NEW pool, opened exactly as `posting::pool` opens production, inherits
    // WAL from the file header.
    let rival = db.rival_pool().await;
    let after: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&rival)
        .await
        .expect("read journal_mode")
        .try_get(0)
        .expect("decode");
    assert_eq!(after.to_lowercase(), "wal", "WAL persists in the header for every later pool");

    let fk: i64 = sqlx::query("PRAGMA foreign_keys")
        .fetch_one(&rival)
        .await
        .expect("read foreign_keys")
        .try_get(0)
        .expect("decode");
    assert_eq!(fk, 1, "foreign keys are enforced on the production pool shape");

    rival.close().await;
}

// ============================================================================
// The reproduction: one pool closing is not enough
// ============================================================================

/// THE PILOT 001 DEFECT, reproduced.
///
/// Closing the plugin's pool while Greaz's own pool is still open leaves the
/// WAL and SHM on disk — which is exactly what an operator sees after closing
/// the application, and exactly what `BACKUP.md` tells them means a crash.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_only_the_plugin_pool_leaves_the_wal_behind() {
    let db = store_with_coffee().await;
    let path = db.path().to_path_buf();

    // Greaz's own posting pool, opened as production opens it.
    let greaz_pool = db.rival_pool().await;
    post_one_sale(&greaz_pool).await;

    assert!(wal_of(&path).exists(), "a live WAL exists while connections are open");

    // The plugin's Exit handler closes ITS pool. Greaz's pool is untouched.
    db.pool().close().await;

    assert!(
        wal_of(&path).exists(),
        "REPRODUCED: the WAL survives because Greaz's own pool is still open"
    );
    assert!(shm_of(&path).exists(), "REPRODUCED: the SHM survives too");

    // Closing the remaining pool is what actually checkpoints.
    greaz_pool.close().await;

    assert!(
        !wal_of(&path).exists(),
        "FIX MECHANISM: closing the last pool checkpoints and unlinks the WAL"
    );
    assert!(!shm_of(&path).exists(), "FIX MECHANISM: the SHM is unlinked too");
}

/// With every pool closed, the committed sale is in the main file — so a
/// single-file copy is complete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_every_pool_folds_committed_sales_into_the_main_file() {
    let db = store_with_coffee().await;
    let path = db.path().to_path_buf();

    let greaz_pool = db.rival_pool().await;
    let sale_id = post_one_sale(&greaz_pool).await;

    greaz_pool.close().await;
    db.pool().close().await;

    assert!(!wal_of(&path).exists(), "clean shutdown leaves no WAL");

    // Copy ONLY the main file, as BACKUP.md instructs, and read it back.
    let copy = scratch_path("backup-after-clean-shutdown");
    std::fs::copy(&path, &copy).expect("copy the database file");

    let restored = open_like_production(&copy).await;
    assert_eq!(sales_count(&restored).await, 1, "the sale survived a single-file copy");

    use sqlx::Row;
    let found: i64 = sqlx::query("SELECT COUNT(*) FROM sales WHERE id = ?")
        .bind(&sale_id)
        .fetch_one(&restored)
        .await
        .expect("look up the sale")
        .try_get(0)
        .expect("decode");
    assert_eq!(found, 1, "it is the same sale, by id");

    let integrity: String = sqlx::query("PRAGMA integrity_check")
        .fetch_one(&restored)
        .await
        .expect("integrity_check")
        .try_get(0)
        .expect("decode");
    assert_eq!(integrity, "ok");

    restored.close().await;
    forget(&copy);
}

/// THE CORRECTION, and the fact that its ordering does not matter.
///
/// On exit, two independent handlers now close a pool each: tauri-plugin-sql's
/// own, and `lib.rs::close_db_pool_on_exit` for Greaz's posting pool. Tauri does
/// not promise which runs first, and it does not need to — whichever closes last
/// is the one that triggers SQLite's checkpoint. Both orders are exercised here
/// so the correction cannot be made order-dependent by a later change.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_exit_sequence_leaves_one_self_contained_file_in_either_order() {
    for greaz_closes_first in [true, false] {
        let db = store_with_coffee().await;
        let path = db.path().to_path_buf();
        let greaz_pool = db.rival_pool().await;
        let sale_id = post_one_sale(&greaz_pool).await;

        if greaz_closes_first {
            greaz_pool.close().await;
            db.pool().close().await;
        } else {
            db.pool().close().await;
            greaz_pool.close().await;
        }

        assert!(
            !wal_of(&path).exists(),
            "no WAL remains (greaz_closes_first = {greaz_closes_first})"
        );
        assert!(
            !shm_of(&path).exists(),
            "no SHM remains (greaz_closes_first = {greaz_closes_first})"
        );

        // And the sale is genuinely in the single remaining file.
        let copy = scratch_path("exit-order");
        std::fs::copy(&path, &copy).expect("copy the database file");
        let restored = open_like_production(&copy).await;

        use sqlx::Row;
        let found: i64 = sqlx::query("SELECT COUNT(*) FROM sales WHERE id = ?")
            .bind(&sale_id)
            .fetch_one(&restored)
            .await
            .expect("look up the sale")
            .try_get(0)
            .expect("decode");
        assert_eq!(found, 1, "the sale is in the main file either way");

        restored.close().await;
        forget(&copy);
    }
}

// ============================================================================
// Why the current instruction is dangerous
// ============================================================================

/// The hazard `BACKUP.md` warns about, made concrete and deterministic.
///
/// Autocheckpointing is switched off so the outcome does not depend on how many
/// pages happen to have accumulated. That is not cheating: it is precisely why
/// the hazard is dangerous in the field — whether the sale is in the main file
/// or only in the WAL is a timing accident the operator cannot see.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copying_only_the_main_file_while_the_wal_is_live_loses_the_sale() {
    let db = store_with_coffee().await;
    let path = db.path().to_path_buf();

    let greaz_pool = db.rival_pool().await;
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&greaz_pool)
        .await
        .expect("pin the WAL open for a deterministic result");

    let before = sales_count(&greaz_pool).await;
    post_one_sale(&greaz_pool).await;
    assert_eq!(sales_count(&greaz_pool).await, before + 1, "the sale is committed and visible");

    // The operator copies the single file while the app is still open.
    let copy = scratch_path("backup-taken-live");
    std::fs::copy(&path, &copy).expect("copy the database file");

    let restored = open_like_production(&copy).await;
    assert_eq!(
        sales_count(&restored).await,
        before,
        "THE HAZARD: the copy is missing a committed sale that the app reported as posted"
    );
    restored.close().await;
    forget(&copy);

    greaz_pool.close().await;
}

// ============================================================================
// A residual WAL is not corruption
// ============================================================================

/// Abnormal termination — the process dies with its connections open, leaving
/// the triple on disk. Reopening replays the WAL; nothing is lost or corrupt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_abandoned_wal_replays_on_the_next_open_and_is_not_corruption() {
    let db = store_with_coffee().await;
    let path = db.path().to_path_buf();

    let greaz_pool = db.rival_pool().await;
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&greaz_pool)
        .await
        .expect("keep the commit in the WAL");
    let sale_id = post_one_sale(&greaz_pool).await;

    // Snapshot the on-disk state a killed process would leave: db + wal + shm,
    // copied together, with the connections still open.
    let crashed = scratch_path("crashed-triple");
    std::fs::copy(&path, &crashed).expect("copy db");
    std::fs::copy(wal_of(&path), wal_of(&crashed)).expect("copy wal");
    if shm_of(&path).exists() {
        std::fs::copy(shm_of(&path), shm_of(&crashed)).expect("copy shm");
    }

    // Reopening recovers it.
    let recovered = open_like_production(&crashed).await;

    use sqlx::Row;
    let found: i64 = sqlx::query("SELECT COUNT(*) FROM sales WHERE id = ?")
        .bind(&sale_id)
        .fetch_one(&recovered)
        .await
        .expect("look up the sale")
        .try_get(0)
        .expect("decode");
    assert_eq!(found, 1, "the committed sale replayed out of the abandoned WAL");

    let integrity: String = sqlx::query("PRAGMA integrity_check")
        .fetch_one(&recovered)
        .await
        .expect("integrity_check")
        .try_get(0)
        .expect("decode");
    assert_eq!(integrity, "ok", "a residual WAL is not corruption");

    let fk_violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&recovered)
        .await
        .expect("foreign_key_check");
    assert!(fk_violations.is_empty(), "no foreign-key violations after recovery");

    recovered.close().await;
    forget(&crashed);
    greaz_pool.close().await;
}

// ============================================================================
// A backup that does not require the app to be closed
// ============================================================================

/// `VACUUM INTO` takes a consistent snapshot of a LIVE database, WAL commits
/// included, in one statement and one file — no sidecars to carry, nothing to
/// delete, and no instruction to staff about WAL files.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vacuum_into_snapshots_a_live_database_including_wal_commits() {
    let db = store_with_coffee().await;

    let greaz_pool = db.rival_pool().await;
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&greaz_pool)
        .await
        .expect("keep the commit in the WAL");
    let sale_id = post_one_sale(&greaz_pool).await;

    // Taken while every connection is still open and serving.
    let snapshot = scratch_path("vacuum-into-snapshot");
    sqlx::query(&format!("VACUUM INTO '{}'", snapshot.display()))
        .execute(&greaz_pool)
        .await
        .expect("VACUUM INTO must succeed against a live database");

    assert!(!wal_of(&snapshot).exists(), "the snapshot is a single self-contained file");

    let restored = open_like_production(&snapshot).await;

    use sqlx::Row;
    let found: i64 = sqlx::query("SELECT COUNT(*) FROM sales WHERE id = ?")
        .bind(&sale_id)
        .fetch_one(&restored)
        .await
        .expect("look up the sale")
        .try_get(0)
        .expect("decode");
    assert_eq!(found, 1, "the WAL-resident sale IS in the snapshot");

    let integrity: String = sqlx::query("PRAGMA integrity_check")
        .fetch_one(&restored)
        .await
        .expect("integrity_check")
        .try_get(0)
        .expect("decode");
    assert_eq!(integrity, "ok");

    restored.close().await;
    forget(&snapshot);
    greaz_pool.close().await;
}

// ============================================================================
// Full restore rehearsal — a backup is not qualified until it is restored
// ============================================================================

/// Take a backup the documented way, restore it into a disposable location, and
/// prove every financial artefact survived: the sale, both payment legs, the
/// inventory movement, and the receipt-number counter.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_backup_preserves_sales_payment_legs_movements_and_counters() {
    use sqlx::Row;

    let db = store_with_coffee().await;
    let path = db.path().to_path_buf();
    let greaz_pool = db.rival_pool().await;

    // A split-tender sale: two payment legs, like the Pilot 001 transaction.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(2).unit_incl(500).build()];
    let payload = sale_payload(lines, vec![cash_usd(500), cash_lbp(500 * RATE_LBP_PER_USD / 100)]);
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(&greaz_pool, payload).await.expect("sale posts");
    let receipt_number = result.receipt_number;

    // Shut down in order, then copy the single file.
    greaz_pool.close().await;
    db.pool().close().await;
    assert!(!wal_of(&path).exists(), "clean shutdown leaves one self-contained file");

    let backup = scratch_path("restore-rehearsal");
    std::fs::copy(&path, &backup).expect("copy the database file");

    // Restore into a disposable location and verify everything.
    let restored = open_like_production(&backup).await;

    let integrity: String = sqlx::query("PRAGMA integrity_check")
        .fetch_one(&restored)
        .await
        .expect("integrity_check")
        .try_get(0)
        .expect("decode");
    assert_eq!(integrity, "ok");

    let fk = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&restored)
        .await
        .expect("foreign_key_check");
    assert!(fk.is_empty(), "no foreign-key violations in the restored database");

    let legs: i64 = sqlx::query("SELECT COUNT(*) FROM sale_payments WHERE sale_id = ?")
        .bind(&sale_id)
        .fetch_one(&restored)
        .await
        .expect("count legs")
        .try_get(0)
        .expect("decode");
    assert_eq!(legs, 2, "both payment legs survived the restore");

    let movements: i64 =
        sqlx::query("SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id = ?")
            .bind(&sale_id)
            .fetch_one(&restored)
            .await
            .expect("count movements")
            .try_get(0)
            .expect("decode");
    assert_eq!(movements, 1, "the inventory movement survived the restore");

    let persisted_receipt: i64 = sqlx::query("SELECT receipt_number FROM sales WHERE id = ?")
        .bind(&sale_id)
        .fetch_one(&restored)
        .await
        .expect("read receipt number")
        .try_get(0)
        .expect("decode");
    assert_eq!(persisted_receipt, receipt_number as i64, "the receipt number survived");

    // The counter continues from the restored state rather than colliding.
    let next = post_one_sale(&restored).await;
    let next_receipt: i64 = sqlx::query("SELECT receipt_number FROM sales WHERE id = ?")
        .bind(&next)
        .fetch_one(&restored)
        .await
        .expect("read next receipt number")
        .try_get(0)
        .expect("decode");
    assert_eq!(
        next_receipt,
        receipt_number as i64 + 1,
        "the restored database continues the receipt sequence"
    );

    restored.close().await;
    forget(&backup);
}
