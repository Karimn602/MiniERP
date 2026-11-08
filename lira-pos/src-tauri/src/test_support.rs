// src-tauri/src/test_support.rs
//
// WP-01 test harness. Compiled only under `cfg(test)`.
//
// Every test gets its own brand-new SQLite FILE in the OS temp directory, with
// the application's real migration list applied through sqlx's real migration
// runner (the same `Migrator::run` path tauri-plugin-sql uses). The file is
// deleted when the guard drops.
//
// Safety: `TempDb` refuses to open anything named like the production database
// or living outside the OS temp directory. See `assert_not_production_db`.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use crate::cost::{cents_to_microcents, microcents_to_cents};
use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use tauri_plugin_sql::{Migration, MigrationKind};

/// The production database filename. Tests must never open it.
pub const PRODUCTION_DB_FILENAME: &str = "greaz-pos.db";

/// Directory that holds every temporary test database.
fn test_db_root() -> PathBuf {
    std::env::temp_dir().join("greaz-pos-tests")
}

/// Hard guard: panics if `path` could possibly be the developer's real database.
///
/// Checked on every temp-DB creation, so wiring a test to the production file
/// fails loudly instead of mutating real data.
pub fn assert_not_production_db(path: &Path) {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert_ne!(
        name, PRODUCTION_DB_FILENAME,
        "refusing to open the production database from a test: {}",
        path.display()
    );
    assert!(
        !name.contains("greaz-pos.db"),
        "refusing to open a production-looking database from a test: {}",
        path.display()
    );
    let root = test_db_root();
    assert!(
        path.starts_with(&root),
        "test databases must live under {}, got {}",
        root.display(),
        path.display()
    );
}

/// Translate the application's migration list into sqlx migrations exactly the
/// way tauri-plugin-sql's `MigrationList::resolve` does: `Up` migrations only,
/// `MigrationType::ReversibleUp`, `no_tx = false`.
fn to_sqlx_migrations(list: Vec<Migration>) -> Vec<SqlxMigration> {
    list.into_iter()
        .filter(|m| matches!(m.kind, MigrationKind::Up))
        .map(|m| {
            SqlxMigration::new(
                m.version,
                m.description.into(),
                MigrationType::ReversibleUp,
                m.sql.into(),
                false,
            )
        })
        .collect()
}

/// A `Migrator` over the application's real migration list. Equivalent to the
/// `Migrator::new(migration_list)` that tauri-plugin-sql builds at startup.
pub fn app_migrator() -> Migrator {
    Migrator {
        migrations: Cow::Owned(to_sqlx_migrations(crate::migrations())),
        ..Migrator::DEFAULT
    }
}

/// A `Migrator` over the application's migration list truncated at
/// `max_version` — the schema a database created by an EARLIER release is
/// sitting on. Used to prove that an upgrade migration applies to, and
/// correctly backfills, a real pre-existing database rather than only a virgin
/// one. The migrations themselves are the application's own, resolved exactly as
/// `app_migrator` resolves them.
pub fn app_migrator_through(max_version: i64) -> Migrator {
    let list: Vec<Migration> = crate::migrations()
        .into_iter()
        .filter(|m| m.version <= max_version)
        .collect();
    assert!(
        !list.is_empty(),
        "no migration at or below version {max_version}"
    );
    Migrator {
        migrations: Cow::Owned(to_sqlx_migrations(list)),
        ..Migrator::DEFAULT
    }
}

/// The highest migration version the application ships, and how many there
/// are, derived from the real list in `lib.rs`.
///
/// Every "this database is fully migrated" assertion goes through these rather
/// than through a literal, so adding a migration means editing one list and not
/// every test that happens to check the migrator reached the end.
pub fn latest_migration_version() -> i64 {
    crate::migrations()
        .iter()
        .map(|m| m.version)
        .max()
        .expect("the application ships at least one migration")
}

pub fn migration_count() -> i64 {
    crate::migrations().len() as i64
}

/// A disposable SQLite database for one test.
///
/// The pool is held in an `Option` so explicit cleanup can await every raw
/// connection close before unlinking anything. If a test relies on `Drop`, the
/// pool is transferred to a bounded set of dedicated async cleanup workers;
/// the originating test worker waits for only its own jobs as it exits.
pub struct TempDb {
    pool: Option<SqlitePool>,
    path: PathBuf,
    cleanup_state: Arc<CleanupState>,
}

struct CleanupJob {
    pool: SqlitePool,
    path: PathBuf,
    state: Arc<CleanupState>,
}

#[derive(Default)]
struct CleanupProgress {
    pending: usize,
    failures: Vec<String>,
}

#[derive(Default)]
struct CleanupState {
    progress: Mutex<CleanupProgress>,
    changed: Condvar,
}

struct CleanupBarrier {
    state: Arc<CleanupState>,
}

thread_local! {
    static CLEANUP_BARRIER: CleanupBarrier = CleanupBarrier {
        state: Arc::new(CleanupState::default()),
    };
}

impl Drop for CleanupBarrier {
    fn drop(&mut self) {
        let progress = self
            .state
            .progress
            .lock()
            .expect("TempDb cleanup state lock");
        let (mut progress, timeout) = self
            .state
            .changed
            .wait_timeout_while(progress, Duration::from_secs(30), |state| state.pending > 0)
            .expect("wait for TempDb cleanup");
        if timeout.timed_out() && progress.pending > 0 {
            eprintln!(
                "TEMPDB CLEANUP BARRIER TIMED OUT with {} database(s) still pending",
                progress.pending
            );
        }
        let failures = std::mem::take(&mut progress.failures);
        if !failures.is_empty() {
            eprintln!(
                "TEMPDB CLEANUP BARRIER RECORDED {} FAILURE(S):\n{}",
                failures.len(),
                failures.join("\n")
            );
        }
    }
}

impl TempDb {
    /// Create a fresh database file and apply every application migration.
    pub async fn new() -> Self {
        let db = Self::empty().await;
        app_migrator()
            .run(db.pool())
            .await
            .expect("application migrations must apply to a virgin database");
        db
    }

    /// Create a fresh database file carrying only the migrations up to
    /// `max_version` — i.e. a database as an older release left it. Call
    /// `migrate_again()` afterwards to run the remaining migrations through the
    /// real runner, which is what a user's upgrade actually does.
    pub async fn at_schema_version(max_version: i64) -> Self {
        let db = Self::empty().await;
        app_migrator_through(max_version)
            .run(db.pool())
            .await
            .unwrap_or_else(|e| panic!("migrations 1..={max_version} must apply: {e}"));
        db
    }

    /// Create a fresh database file with NO migrations applied.
    pub async fn empty() -> Self {
        // Associate this database with the worker that created it. When that
        // worker exits, it waits only for its own cleanup jobs, never for jobs
        // belonging to concurrently running tests.
        let cleanup_state = CLEANUP_BARRIER.with(|barrier| Arc::clone(&barrier.state));

        let root = test_db_root();
        std::fs::create_dir_all(&root).expect("create temp test-db directory");
        let path = root.join(format!("{}.db", uuid::Uuid::new_v4()));
        assert_not_production_db(&path);

        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);

        // One connection: a temp file database plus single-connection access is
        // the most deterministic representation of the app's transactional use.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open temporary sqlite database");

        // No pool-level `PRAGMA foreign_keys` here, and none in production
        // either since the GZ-G2A-P1 correction: the pragma is per-connection
        // and `foreign_keys(true)` above applies it while each connection is
        // established. Executing it through a pool would configure only
        // whichever connection served the statement.

        Self {
            pool: Some(pool),
            path,
            cleanup_state,
        }
    }

    /// The connection pool for this test's database.
    pub fn pool(&self) -> &SqlitePool {
        self.pool.as_ref().expect("pool is live until drop")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Close every owned SQLite connection and remove this disposable database.
    ///
    /// Tests which need to observe the post-shutdown filesystem should call this
    /// explicitly. Ordinary tests may rely on `Drop`, which transfers the same
    /// work to a dedicated asynchronous cleanup runtime.
    pub async fn cleanup(mut self) -> Result<(), String> {
        let pool = self.pool.take().expect("pool is live until cleanup");
        cleanup_database(pool, self.path.clone()).await
    }

    /// A SECOND, independent connection pool against the same database file.
    ///
    /// For the WP-04 concurrency tests. `TempDb`'s own pool holds a single
    /// connection, which is the most deterministic shape for a posting test but
    /// serialises everything before SQLite ever sees it — so two "simultaneous"
    /// commands on it could never actually contend. A separate pool contends for
    /// real, through the engine.
    ///
    /// Built by `posting::open_write_pool` — THE production function, called
    /// rather than imitated.
    ///
    /// It used to hand-copy production's connection SQL, under a comment
    /// claiming it was "configured exactly as `posting::pool` configures
    /// production". That was true, and it is why GZ-G2A-P1 went unnoticed for
    /// as long as it did: production ran one `PRAGMA foreign_keys = ON` through
    /// a ten-connection pool, this copy did the same, and the copy could never
    /// contradict the original. A test helper that re-types the code under test
    /// proves the helper correct and nothing else, so this one now calls it.
    ///
    /// Nothing is made more forgiving than the real application, so a lock
    /// error a test sees here is one a cashier could see.
    pub async fn rival_pool(&self) -> SqlitePool {
        assert_not_production_db(&self.path);
        crate::posting::open_write_pool(&self.path)
            .await
            .unwrap_or_else(|e| panic!("open rival pool on {}: {e}", self.path.display()))
    }

    /// Re-run the migrator against this database (idempotency checks).
    pub async fn migrate_again(&self) -> Result<(), sqlx::migrate::MigrateError> {
        app_migrator().run(self.pool()).await
    }

    /// Advance this database to `max_version` and no further.
    ///
    /// `migrate_again` runs everything the application ships, which is right
    /// for an upgrade test and wrong for a BOUNDARY one: an assertion that
    /// migration N does not, by itself, relax a rule has to stop at N, or it
    /// silently becomes an assertion about N+1 the day N+1 arrives. That is
    /// exactly what would have happened to
    /// `migration_021_leaves_the_recipe_costing_refusal_in_place` when 022
    /// landed.
    pub async fn migrate_through(
        &self,
        max_version: i64,
    ) -> Result<(), sqlx::migrate::MigrateError> {
        app_migrator_through(max_version).run(self.pool()).await
    }

    // ---- small query helpers ----

    pub async fn scalar_i64(&self, sql: &str) -> i64 {
        sqlx::query(sql)
            .fetch_one(self.pool())
            .await
            .unwrap_or_else(|e| panic!("query failed: {sql}\n{e}"))
            .try_get::<i64, _>(0)
            .expect("decode i64")
    }

    pub async fn scalar_string(&self, sql: &str) -> String {
        sqlx::query(sql)
            .fetch_one(self.pool())
            .await
            .unwrap_or_else(|e| panic!("query failed: {sql}\n{e}"))
            .try_get::<String, _>(0)
            .expect("decode String")
    }

    pub async fn count(&self, sql: &str) -> i64 {
        self.scalar_i64(sql).await
    }

    /// Run arbitrary SQL, returning the driver error if any (for trigger tests).
    pub async fn try_exec(&self, sql: &str) -> Result<(), sqlx::Error> {
        sqlx::query(sql).execute(self.pool()).await.map(|_| ())
    }

    /// Run a statement that a trigger or constraint MUST refuse, and return
    /// the engine's message so a test can assert WHICH rule fired.
    ///
    /// A refusal test that only checks `is_err` passes when the statement
    /// fails for the wrong reason, which is how a guard comes to be believed
    /// in without being there.
    pub async fn exec_err(&self, sql: &str) -> String {
        match self.try_exec(sql).await {
            Ok(()) => panic!("this statement should have been refused: {sql}"),
            Err(e) => e.to_string(),
        }
    }

    pub async fn exec(&self, sql: &str) {
        self.try_exec(sql)
            .await
            .unwrap_or_else(|e| panic!("exec failed: {sql}\n{e}"));
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let Some(pool) = self.pool.take() else {
            return;
        };

        let path = self.path.clone();
        let job = CleanupJob {
            pool,
            path: path.clone(),
            state: Arc::clone(&self.cleanup_state),
        };
        self.cleanup_state
            .progress
            .lock()
            .expect("TempDb cleanup state lock")
            .pending += 1;
        if let Err(error) = cleanup_sender().send(job) {
            let job = error.0;
            let failure = format!(
                "TEMPDB CLEANUP NOT QUEUED; preserving diagnostic files at {}",
                path.display()
            );
            // Never unlink while the unclosed pool may still own file handles.
            drop(job.pool);
            finish_cleanup(&job.state, &path, Err(failure.clone()));
            eprintln!("{failure}");
        }
    }
}

fn finish_cleanup(state: &CleanupState, path: &Path, result: Result<(), String>) {
    let mut progress = state.progress.lock().expect("TempDb cleanup state lock");
    if let Err(error) = result {
        progress
            .failures
            .push(format!("{}: {error}", path.display()));
    }
    progress.pending = progress
        .pending
        .checked_sub(1)
        .expect("TempDb cleanup completion must have a pending job");
    state.changed.notify_all();
}

fn cleanup_sender() -> &'static mpsc::Sender<CleanupJob> {
    static CLEANUP: OnceLock<mpsc::Sender<CleanupJob>> = OnceLock::new();
    CLEANUP.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<CleanupJob>();
        let rx = Arc::new(Mutex::new(rx));
        for worker in 1..=4 {
            let rx = Arc::clone(&rx);
            std::thread::Builder::new()
                .name(format!("greaz-test-db-cleanup-{worker}"))
                .spawn(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("build TempDb cleanup runtime");
                    loop {
                        let job = {
                            let receiver = rx.lock().expect("TempDb cleanup receiver lock");
                            receiver.recv()
                        };
                        let Ok(job) = job else {
                            break;
                        };
                        let path = job.path.clone();
                        let result = runtime.block_on(cleanup_database(job.pool, job.path));
                        if let Err(error) = &result {
                            eprintln!(
                                "TEMPDB CLEANUP FAILED; preserving diagnostic files at {}: {error}",
                                path.display()
                            );
                        }
                        finish_cleanup(&job.state, &path, result);
                    }
                })
                .expect("spawn TempDb cleanup worker");
        }
        tx
    })
}

/// Close every raw connection in a pool while retaining SQLx's close result.
///
/// `Pool::close()` intentionally discards `Connection::close()` errors. A
/// disposable test pool has no outstanding borrowers once its `TempDb` drops,
/// so each current connection can instead be acquired and closed explicitly.
/// This exposes worker crashes (including a panic from `sqlite3_close`) before
/// any database, WAL, or SHM file is removed.
pub async fn close_sqlite_pool_checked(pool: &SqlitePool, what: &str) -> Result<(), String> {
    let connection_count = pool.size();
    let mut explicitly_closed = 0;
    while pool.size() > 0 {
        let size_before_acquire = pool.size();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let connection = loop {
            if pool.size() == 0 {
                // The last connection can finish its asynchronous return and
                // close between the outer condition and this acquisition.
                break None;
            }
            if let Some(connection) = pool.try_acquire() {
                break Some(connection);
            }
            if pool.size() < size_before_acquire {
                // SQLx may already be asynchronously closing a connection that
                // was returning to the pool when TempDb dropped. It is no
                // longer owned by this pool, so there is nothing left to
                // acquire or remove before continuing.
                break None;
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "{what}: timed out acquiring connection {}/{} for checked close (pool size={}, idle={})",
                    explicitly_closed + 1,
                    connection_count,
                    pool.size(),
                    pool.num_idle()
                ));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        let Some(connection) = connection else {
            continue;
        };
        connection.close().await.map_err(|error| {
            format!(
                "{what}: raw SQLite connection {}/{} failed to close: {error}",
                explicitly_closed + 1,
                connection_count
            )
        })?;
        explicitly_closed += 1;
    }

    // Marks the now-empty pool closed. There are no raw close errors left for
    // this call to suppress.
    pool.close().await;
    Ok(())
}

async fn cleanup_database(pool: SqlitePool, path: PathBuf) -> Result<(), String> {
    close_sqlite_pool_checked(&pool, &format!("TempDb {}", path.display())).await?;

    for suffix in ["-wal", "-shm", ""] {
        let candidate = sidecar_path(&path, suffix);
        if let Err(error) = remove_with_retry(&candidate).await {
            // Stop at the first failed unlink so the main file and every
            // not-yet-removed sidecar remain available for diagnosis.
            return Err(format!(
                "{}: {} (kind={:?}, windows_error={:?})",
                candidate.display(),
                error,
                error.kind(),
                error.raw_os_error()
            ));
        }
    }
    Ok(())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut candidate = path.as_os_str().to_os_string();
    candidate.push(suffix);
    PathBuf::from(candidate)
}

/// Unlink a file after its pool has closed, tolerating only transient Windows
/// handle-release delays and returning the final I/O error to the caller.
async fn remove_with_retry(path: &Path) -> Result<(), std::io::Error> {
    let mut last_error = None;
    for attempt in 0..50 {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        tokio::time::sleep(Duration::from_millis(if attempt < 10 { 2 } else { 20 })).await;
    }
    Err(last_error.expect("a failed removal records its I/O error"))
}

// ============================================================================
// Fixture IDs — the rows migration 001 seeds. Tests build everything else.
// ============================================================================

pub const STORE_ID: &str = "00000000-0000-0000-0000-000000000001";
pub const USER_ID: &str = "00000000-0000-0000-0000-000000000002";
/// Standard Lebanese VAT, 1100 bps.
pub const VAT_STD_ID: &str = "00000000-0000-0000-0000-000000000010";
pub const VAT_STD_BPS: i64 = 1100;
/// Exempt, 0 bps.
pub const VAT_EXEMPT_ID: &str = "00000000-0000-0000-0000-000000000012";
pub const VAT_EXEMPT_BPS: i64 = 0;

pub const RATE_ID: &str = "00000000-0000-0000-0000-00000000e001";
pub const RATE_LBP_PER_USD: i64 = 89_500;

/// The store's open shift — the one `builders::sale_payload` attributes a sale
/// to by default.
///
/// Not seed data: migration 001 seeds the store, the user, the VAT rates and the
/// units of measure, but a shift is something a cashier opens. Since WP-04 a NEW
/// sale must name an open shift of its store, so every fixture that posts a sale
/// calls `seed_open_shift`. Leaving it out is how a test says "this store has no
/// open shift", which is now a posting error rather than a quiet success.
pub const SHIFT_ID: &str = "00000000-0000-0000-0000-00000000f001";

// ============================================================================
// Fixture builders
// ============================================================================

/// The three product ids migration 003 seeds and migration 019 retires.
pub const DEMO_CATALOGUE_IDS: [&str; 3] = [
    "00000000-0000-0000-0000-0000000000d1",
    "00000000-0000-0000-0000-0000000000d2",
    "00000000-0000-0000-0000-0000000000d3",
];

/// Make the v3 demonstration catalogue sellable again, for a test that wants it.
///
/// This is the "explicitly controlled demo setup" half of migration 019. A
/// development or demonstration fixture is created by the thing that needs
/// it, in one visible call; production provisioning creates nothing sellable
/// at all. Nothing in the suite currently needs this — it exists so that the
/// next test that wants a ready-made catalogue reaches for a named helper
/// instead of quietly depending on a migration to leave products switched on.
pub async fn activate_demo_catalogue(db: &TempDb) {
    for id in DEMO_CATALOGUE_IDS {
        db.exec(&format!("UPDATE products SET is_active = 1 WHERE id = '{id}'"))
        .await;
    }
}

pub async fn seed_exchange_rate(db: &TempDb) {
    sqlx::query(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES (?, ?, '2026-01-01', ?, 'manual')",
    )
    .bind(RATE_ID)
    .bind(STORE_ID)
    .bind(RATE_LBP_PER_USD)
    .execute(db.pool())
    .await
    .expect("seed exchange rate");
}

/// A second exchange rate, for tests that need a rate a replay could wrongly
/// switch to. `effective_date` differs so the (store, date) unique key holds.
pub async fn seed_exchange_rate_at(db: &TempDb, id: &str, rate_lbp_per_usd: i64) {
    sqlx::query(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES (?, ?, '2026-01-02', ?, 'manual')",
    )
    .bind(id)
    .bind(STORE_ID)
    .bind(rate_lbp_per_usd)
    .execute(db.pool())
    .await
    .expect("seed second exchange rate");
}

pub struct ProductSpec<'a> {
    pub id: &'a str,
    pub sku: &'a str,
    pub name: &'a str,
    pub vat_rate_id: &'a str,
    pub price_excl_vat_cents: i64,
    pub price_incl_vat_cents: i64,
    pub quantity_on_hand: i64,
    pub avg_cost_excl_vat_cents: i64,
    pub avg_cost_incl_vat_cents: i64,
    pub is_service: bool,
    pub is_active: bool,
    /// UoM code of the product's base row in `product_uoms`. `seed_product`
    /// always creates that row, because `productsRepo.create` always does —
    /// and since WP-02 `post_sale` requires it.
    pub base_uom_code: &'a str,
    /// `products.vat_pricing_mode` — "inclusive" or "exclusive". Since the
    /// WP-05 correction this is what `post_purchase` falls back to when a
    /// purchase line does not say which side of its cost pair the invoice
    /// states, so a fixture that cares about the fallback sets it.
    pub vat_pricing_mode: &'a str,
}

impl<'a> ProductSpec<'a> {
    /// A stocked, VAT-standard product with sane defaults.
    pub fn stocked(id: &'a str, sku: &'a str, name: &'a str) -> Self {
        Self {
            id,
            sku,
            name,
            vat_rate_id: VAT_STD_ID,
            price_excl_vat_cents: 1000,
            price_incl_vat_cents: 1110,
            quantity_on_hand: 0,
            avg_cost_excl_vat_cents: 0,
            avg_cost_incl_vat_cents: 0,
            is_service: false,
            is_active: true,
            base_uom_code: "each",
            vat_pricing_mode: "inclusive",
        }
    }
}

pub async fn seed_product(db: &TempDb, spec: &ProductSpec<'_>) {
    // The spec states cost in whole cents, which is what a fixture normally
    // wants. Both representations are written, the microcent one derived the
    // same way migration 008 backfills a pre-WP-03 database — exactly
    // `cents x COST_SCALE` — because `post_purchase` maintains the pair and a
    // product seeded with only one of them would be costed at zero.
    // `seed_product_avg_cost_microcents` sets a sub-cent cost that whole cents
    // cannot express.
    let avg_excl_mc = cents_to_microcents(spec.avg_cost_excl_vat_cents)
        .expect("fixture average cost must be representable");
    let avg_incl_mc = cents_to_microcents(spec.avg_cost_incl_vat_cents)
        .expect("fixture average cost must be representable");
    sqlx::query(
        "INSERT INTO products (
           id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents,
           avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
           avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
           quantity_on_hand, is_active, is_service
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(spec.id)
    .bind(STORE_ID)
    .bind(spec.sku)
    .bind(spec.name)
    .bind(spec.vat_rate_id)
    .bind(spec.vat_pricing_mode)
    .bind(spec.price_excl_vat_cents)
    .bind(spec.price_incl_vat_cents)
    .bind(spec.avg_cost_excl_vat_cents)
    .bind(spec.avg_cost_incl_vat_cents)
    .bind(avg_excl_mc)
    .bind(avg_incl_mc)
    .bind(spec.quantity_on_hand)
    .bind(i64::from(spec.is_active))
    .bind(i64::from(spec.is_service))
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed product {}: {e}", spec.id));

    // Mirror `productsRepo.create`: every product gets a base UoM row that is
    // also its default sale and purchase UoM, with factor (1, 1).
    sqlx::query(
        "INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active
         ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 1)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(STORE_ID)
    .bind(spec.id)
    .bind(spec.base_uom_code)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed base UoM for product {}: {e}", spec.id));
}

/// Set a product's weighted-average cost directly in microcents, for the
/// fractional per-base costs whole cents cannot express (a gram of flour at
/// 250,000 microcents = $0.0025). The rounded cents mirror is maintained
/// alongside, exactly as `post_purchase` maintains it.
pub async fn seed_product_avg_cost_microcents(
    db: &TempDb,
    product_id: &str,
    excl_microcents: i64,
    incl_microcents: i64,
) {
    sqlx::query(
        "UPDATE products
            SET avg_cost_excl_vat_microcents = ?,
                avg_cost_incl_vat_microcents = ?,
                avg_cost_excl_vat_cents      = ?,
                avg_cost_incl_vat_cents      = ?
          WHERE id = ? AND store_id = ?",
    )
    .bind(excl_microcents)
    .bind(incl_microcents)
    .bind(microcents_to_cents(excl_microcents).expect("representable"))
    .bind(microcents_to_cents(incl_microcents).expect("representable"))
    .bind(product_id)
    .bind(STORE_ID)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed microcent cost for {product_id}: {e}"));
}

/// Configure a product for MANUAL STANDARD COST (WP-B1, migration 020).
///
/// `cost_microcents` is a RATE per base unit, exclusive of VAT. Setting the
/// method and the figure in ONE statement is not a convenience: migration
/// 020's trigger judges the resulting row, so a fixture that set the method
/// first would be refused before it could state the cost.
pub async fn seed_manual_cost(db: &TempDb, product_id: &str, cost_microcents: i64) {
    sqlx::query(
        "UPDATE products
            SET costing_method = 'standard',
                standard_cost_excl_vat_microcents = ?,
                standard_cost_set_at = '2026-10-25T00:00:00.000Z'
          WHERE id = ? AND store_id = ?",
    )
    .bind(cost_microcents)
    .bind(product_id)
    .bind(STORE_ID)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed manual cost for {product_id}: {e}"));
}

/// Forge the state migration 020 forbids: Manual Cost with NO figure.
///
/// The row is UNREACHABLE while the schema holds — `save_product` refuses it
/// and `trg_products_costing_coherence_{ins,upd}` refuses it — so the only way
/// to test `post_sale`'s own refusal is to drop the guard and write it. That
/// is the point of the test, not a workaround: the posting command must not
/// depend on the schema having held, because the same row is what a migration
/// bug, a hand-edited database or a future importer would produce.
///
/// The trigger stays dropped. The database is disposable and belongs to one
/// test.
pub async fn forge_manual_cost_without_figure(db: &TempDb, product_id: &str) {
    db.exec("DROP TRIGGER IF EXISTS trg_products_costing_coherence_upd").await;
    db.exec(&format!(
        "UPDATE products
            SET costing_method = 'standard',
                standard_cost_excl_vat_microcents = NULL,
                standard_cost_set_at = NULL
          WHERE id = '{product_id}' AND store_id = '{STORE_ID}'"
    ))
    .await;
}

/// The `costing_method` / `standard_cost_excl_vat_microcents` pair as stored.
pub async fn costing_config(db: &TempDb, product_id: &str) -> (String, Option<i64>) {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT costing_method, standard_cost_excl_vat_microcents
           FROM products WHERE id = ? AND store_id = ?",
    )
    .bind(product_id)
    .bind(STORE_ID)
    .fetch_one(db.pool())
    .await
    .unwrap_or_else(|e| panic!("read costing config for {product_id}: {e}"));
    (
        row.try_get("costing_method").expect("costing_method"),
        row.try_get("standard_cost_excl_vat_microcents")
            .expect("standard_cost_excl_vat_microcents"),
    )
}

/// Add a non-base sale UoM to a product: `1 <uom_code> = num/den` base units.
/// The frontend only ever offers active rows, so this row is active.
pub async fn seed_product_uom(db: &TempDb, product_id: &str, uom_code: &str, num: i64, den: i64) {
    sqlx::query(
        "INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 1)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(STORE_ID)
    .bind(product_id)
    .bind(uom_code)
    .bind(num)
    .bind(den)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed UoM {uom_code} for product {product_id}: {e}"));
}

/// A non-base UoM that has been RETIRED: present on the product but inactive.
/// `post_sale` and `post_purchase` both resolve only active rows, so this is the
/// fixture for "the shop stopped buying by the case".
pub async fn seed_inactive_product_uom(
    db: &TempDb,
    product_id: &str,
    uom_code: &str,
    num: i64,
    den: i64,
) {
    sqlx::query(
        "INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(STORE_ID)
    .bind(product_id)
    .bind(uom_code)
    .bind(num)
    .bind(den)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed inactive UoM {uom_code} for product {product_id}: {e}"));
}

/// The `product_uoms.id` of a product's row for `uom_code` — what the Purchases
/// page sends as `productUomIdSnapshot`.
pub async fn product_uom_id(db: &TempDb, product_id: &str, uom_code: &str) -> String {
    sqlx::query("SELECT id FROM product_uoms WHERE product_id = ? AND uom_code = ?")
        .bind(product_id)
        .bind(uom_code)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read product_uom id for {product_id}/{uom_code}: {e}"))
        .try_get::<String, _>(0)
        .expect("decode String")
}

pub async fn seed_supplier(db: &TempDb, id: &str, name: &str) {
    seed_supplier_in_store(db, id, name, STORE_ID).await;
}

/// A supplier owned by a NAMED store. A supplier row belongs to exactly one
/// store, and since WP-05 both posting commands prove that the store they are
/// writing for is the one that owns the supplier — so a test needs a way to
/// create the mismatch.
pub async fn seed_supplier_in_store(db: &TempDb, id: &str, name: &str, store_id: &str) {
    sqlx::query("INSERT INTO suppliers (id, store_id, name) VALUES (?, ?, ?)")
        .bind(id)
        .bind(store_id)
        .bind(name)
        .execute(db.pool())
        .await
        .expect("seed supplier");
}

/// A driver, the shop's own, active (WP-6).
pub async fn seed_driver(db: &TempDb, id: &str, name: &str) {
    seed_driver_in_store(db, id, name, STORE_ID, true).await;
}

/// An inactive driver — one the shop has stopped giving orders to. A new
/// delivery order may not be assigned to him; he may still remit what he is
/// already holding.
pub async fn seed_inactive_driver(db: &TempDb, id: &str, name: &str) {
    seed_driver_in_store(db, id, name, STORE_ID, false).await;
}

/// A driver owned by a NAMED store. `post_sale` and `post_driver_remittance`
/// both prove the store they are writing for owns the driver, so a test needs
/// a way to create the mismatch — the same reason
/// `seed_supplier_in_store` exists.
pub async fn seed_driver_in_store(
    db: &TempDb,
    id: &str,
    name: &str,
    store_id: &str,
    is_active: bool,
) {
    sqlx::query("INSERT INTO drivers (id, store_id, name, is_active) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(store_id)
        .bind(name)
        .bind(if is_active { 1 } else { 0 })
        .execute(db.pool())
        .await
        .expect("seed driver");
}

/// A driver's balance, straight from the view the UI reads. Positive means he
/// owes the shop.
pub async fn driver_balance(db: &TempDb, driver_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT outstanding_cents FROM driver_balances WHERE driver_id = ?",
    )
    .bind(driver_id)
    .fetch_one(db.pool())
    .await
    .expect("read driver balance")
}

/// A second store, for the cross-store scoping tests. Migration 001 seeds one
/// store (`STORE_ID`); a second one is not seed data because Greaz is
/// single-store in practice, but the scoping rules are written in terms of the
/// store and have to be provable.
pub async fn seed_store(db: &TempDb, id: &str, name: &str) {
    sqlx::query("INSERT INTO stores (id, name, default_currency) VALUES (?, ?, 'USD')")
        .bind(id)
        .bind(name)
        .execute(db.pool())
        .await
        .expect("seed store");

    // AND AN OWNER FOR IT (Gate 2B).
    //
    // A second store with no staff is not a shop any command can act in: since
    // Stage B every write is authorized against a real, active user, and since
    // the store check that user must belong to the document's own store. A test
    // that builds a second branch in order to prove a CROSS-STORE guard needs
    // somebody there to act as — otherwise the only thing it can prove is that
    // the store check works, which is covered on its own and is not what those
    // tests were written to show.
    sqlx::query(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES (?, ?, ?, 'owner')",
    )
    .bind(seeded_owner_of(id))
    .bind(id)
    .bind(format!("{name} Owner"))
    .execute(db.pool())
    .await
    .expect("seed the store's owner");
}

/// The id `seed_store` gives a seeded store's owner, so a test can act as them.
///
/// Derived from the store id rather than random, so a test can name the actor
/// without threading a value back out of the seeding call.
pub fn seeded_owner_of(store_id: &str) -> String {
    format!("owner-of-{store_id}")
}

/// A supplier's outstanding payable, read the way every read model reads it:
/// `SUM(supplier_ledger.amount_cents)`. Positive means the shop owes money.
pub async fn supplier_balance(db: &TempDb, supplier_id: &str) -> i64 {
    sqlx::query("SELECT COALESCE(SUM(amount_cents), 0) FROM supplier_ledger WHERE supplier_id = ?")
        .bind(supplier_id)
        .fetch_one(db.pool())
        .await
        .expect("read supplier balance")
        .try_get::<i64, _>(0)
        .expect("decode i64")
}

/// The default open shift (`SHIFT_ID`) with an empty float — the precondition
/// for posting a sale through `builders::sale_payload`.
pub async fn seed_open_shift(db: &TempDb) {
    seed_shift(db, SHIFT_ID, 0, 0).await;
}

/// An OPEN shift for the fixture store.
///
/// Since migration 009 a store may hold only one of these at a time, which is
/// the application's actual model — use `seed_closed_shift` for the second shift
/// a test needs to exist alongside it.
pub async fn seed_shift(db: &TempDb, id: &str, opening_usd_cents: i64, opening_lbp: i64) {
    seed_shift_with_status(db, id, opening_usd_cents, opening_lbp, "open").await;
}

/// A shift that has already been closed and counted. `closing`/`expected`/
/// `variance` are left NULL: a test that cares about those figures should post
/// sales and run `close_shift`, which is what computes them.
pub async fn seed_closed_shift(db: &TempDb, id: &str, opening_usd_cents: i64, opening_lbp: i64) {
    seed_shift_with_status(db, id, opening_usd_cents, opening_lbp, "closed").await;
}

async fn seed_shift_with_status(
    db: &TempDb,
    id: &str,
    opening_usd_cents: i64,
    opening_lbp: i64,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO shifts (
           id, store_id, opened_by_user_id, opened_at, closed_at, closed_by_user_id,
           opening_cash_usd_cents, opening_cash_lbp, status
         ) VALUES (
           ?, ?, ?, '2026-01-01T08:00:00.000Z',
           CASE WHEN ? = 'closed' THEN '2026-01-01T16:00:00.000Z' END,
           CASE WHEN ? = 'closed' THEN ? END,
           ?, ?, ?
         )",
    )
    .bind(id)
    .bind(STORE_ID)
    .bind(USER_ID)
    .bind(status)
    .bind(status)
    .bind(USER_ID)
    .bind(opening_usd_cents)
    .bind(opening_lbp)
    .bind(status)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed {status} shift {id}: {e}"));
}

/// The `status` of one shift.
pub async fn shift_status(db: &TempDb, shift_id: &str) -> String {
    sqlx::query("SELECT status FROM shifts WHERE id = ?")
        .bind(shift_id)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read status of shift {shift_id}: {e}"))
        .try_get::<String, _>(0)
        .expect("decode String")
}

/// Sum of every inventory movement for a product — the reconciliation target
/// for `products.quantity_on_hand`.
pub async fn movement_sum(db: &TempDb, product_id: &str) -> i64 {
    sqlx::query(
        "SELECT COALESCE(SUM(quantity_delta), 0) FROM inventory_movements WHERE product_id = ?",
    )
    .bind(product_id)
    .fetch_one(db.pool())
    .await
    .expect("movement sum")
    .try_get::<i64, _>(0)
    .expect("decode i64")
}

pub async fn quantity_on_hand(db: &TempDb, product_id: &str) -> i64 {
    sqlx::query("SELECT quantity_on_hand FROM products WHERE id = ?")
        .bind(product_id)
        .fetch_one(db.pool())
        .await
        .expect("read qoh")
        .try_get::<i64, _>(0)
        .expect("decode i64")
}

// ============================================================================
// Returns / credit memos (WP-06)
// ============================================================================

/// The `sale_items.id` of the line a sale posted for `product_id`.
///
/// `post_sale` mints the line ids itself (the repo does, and the builders do),
/// so a return test has to read back the line it means to send back rather
/// than assume an id.
pub async fn sale_item_id(db: &TempDb, sale_id: &str, product_id: &str) -> String {
    sqlx::query("SELECT id FROM sale_items WHERE sale_id = ? AND product_id = ? ORDER BY rowid")
        .bind(sale_id)
        .bind(product_id)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read sale_item for {sale_id}/{product_id}: {e}"))
        .try_get::<String, _>(0)
        .expect("decode String")
}

/// A product's weighted-average cost, in microcents — the WP-03 accounting
/// value, not its rounded cents mirror.
pub async fn avg_cost_excl_microcents(db: &TempDb, product_id: &str) -> i64 {
    sqlx::query("SELECT avg_cost_excl_vat_microcents FROM products WHERE id = ?")
        .bind(product_id)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read avg cost for {product_id}: {e}"))
        .try_get::<i64, _>(0)
        .expect("decode i64")
}

pub async fn avg_cost_incl_microcents(db: &TempDb, product_id: &str) -> i64 {
    sqlx::query("SELECT avg_cost_incl_vat_microcents FROM products WHERE id = ?")
        .bind(product_id)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read avg cost for {product_id}: {e}"))
        .try_get::<i64, _>(0)
        .expect("decode i64")
}

/// Base units of one sale line that POSTED credit memos have sent back.
pub async fn returned_quantity(db: &TempDb, sale_item_id: &str) -> i64 {
    sqlx::query(
        "SELECT COALESCE(SUM(l.quantity_base), 0)
           FROM sales_credit_memo_lines l
           JOIN sales_credit_memos m ON m.id = l.credit_memo_id
          WHERE l.original_sale_item_id = ? AND m.status = 'posted'",
    )
    .bind(sale_item_id)
    .fetch_one(db.pool())
    .await
    .expect("read returned quantity")
    .try_get::<i64, _>(0)
    .expect("decode i64")
}

/// The application's migration list plus ONE extra migration appended after it.
///
/// For proving that a failing migration rolls back cleanly (WP-07). The real
/// list is resolved exactly as `app_migrator` resolves it, so the extra one
/// runs against a genuinely current database and through the same runner
/// tauri-plugin-sql uses — `no_tx = false`, one transaction per migration.
pub fn migrator_with_extra_migration(version: i64, description: &str, sql: &str) -> Migrator {
    let mut list = to_sqlx_migrations(crate::migrations());
    list.push(SqlxMigration::new(
        version,
        description.to_string().into(),
        MigrationType::ReversibleUp,
        sql.to_string().into(),
        false,
    ));
    Migrator {
        migrations: Cow::Owned(list),
        ..Migrator::DEFAULT
    }
}

// ============================================================================
// Recipes (WP-B2-A)
// ============================================================================

/// Give a product a DOCUMENTED cost basis without going through the purchase
/// command: one `purchase` movement at the stated rate.
///
/// A rate of zero is the point for some fixtures — it is the documented free
/// receipt that WP-B1's P1-A correction distinguishes from an absent cost.
pub async fn seed_purchase_movement(db: &TempDb, product_id: &str, rate_microcents: i64) {
    sqlx::query(
        "INSERT INTO inventory_movements
           (id, store_id, product_id, movement_type, quantity_delta,
            unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
            unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents, posted_at)
         VALUES (?, ?, ?, 'purchase', 10, ?, ?, ?, ?, '2026-10-20T08:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(STORE_ID)
    .bind(product_id)
    .bind(microcents_to_cents(rate_microcents).expect("representable"))
    .bind(microcents_to_cents(rate_microcents).expect("representable"))
    .bind(rate_microcents)
    .bind(rate_microcents)
    .execute(db.pool())
    .await
    .unwrap_or_else(|e| panic!("seed purchase movement for {product_id}: {e}"));
}

/// The status of a recipe row, for a transition assertion.
pub async fn recipe_status(db: &TempDb, recipe_id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM recipes WHERE id = ?")
        .bind(recipe_id)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read status of {recipe_id}: {e}"))
}

/// `(activated_at, retired_at)` of a recipe row — the lifecycle history.
pub async fn recipe_timestamps(db: &TempDb, recipe_id: &str) -> (Option<String>, Option<String>) {
    use sqlx::Row;
    let row = sqlx::query("SELECT activated_at, retired_at FROM recipes WHERE id = ?")
        .bind(recipe_id)
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|e| panic!("read timestamps of {recipe_id}: {e}"));
    (
        row.try_get("activated_at").expect("decode activated_at"),
        row.try_get("retired_at").expect("decode retired_at"),
    )
}
