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

/// A disposable SQLite database for one test.
///
/// The pool is held in an `Option` so `Drop` can release it *before* deleting
/// the file. sqlx runs each SQLite connection on its own worker thread, so
/// dropping the last pool handle closes the file without needing an async
/// runtime — which matters because `Drop` often runs as a test's runtime is
/// already shutting down.
pub struct TempDb {
    pool: Option<SqlitePool>,
    path: PathBuf,
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

        // Mirror production, which sets this pragma explicitly on the pool.
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await
            .expect("enable foreign keys");

        Self { pool: Some(pool), path }
    }

    /// The connection pool for this test's database.
    pub fn pool(&self) -> &SqlitePool {
        self.pool.as_ref().expect("pool is live until drop")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A SECOND, independent connection pool against the same database file.
    ///
    /// For the WP-04 concurrency tests. `TempDb`'s own pool holds a single
    /// connection, which is the most deterministic shape for a posting test but
    /// serialises everything before SQLite ever sees it — so two "simultaneous"
    /// commands on it could never actually contend. A separate pool contends for
    /// real, through the engine.
    ///
    /// Configured exactly as `posting::pool` configures production: the same
    /// `sqlite://<path>?mode=rwc` URL through `SqlitePool::connect`, and the same
    /// `PRAGMA foreign_keys = ON`. Nothing is made more forgiving than the real
    /// application, so a lock error a test sees here is one a cashier could see.
    pub async fn rival_pool(&self) -> SqlitePool {
        assert_not_production_db(&self.path);
        let url = format!("sqlite://{}?mode=rwc", self.path.display());
        let pool = SqlitePool::connect(&url)
            .await
            .unwrap_or_else(|e| panic!("open rival pool on {}: {e}", self.path.display()));
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await
            .expect("enable foreign keys on the rival pool");
        pool
    }


    /// Re-run the migrator against this database (idempotency checks).
    pub async fn migrate_again(&self) -> Result<(), sqlx::migrate::MigrateError> {
        app_migrator().run(self.pool()).await
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

    pub async fn exec(&self, sql: &str) {
        self.try_exec(sql)
            .await
            .unwrap_or_else(|e| panic!("exec failed: {sql}\n{e}"));
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        // Release the pool first: Windows will not unlink a file that still has
        // an open handle. Never `block_on` here — `drop` frequently runs while
        // the test's own runtime is shutting down, which would deadlock.
        drop(self.pool.take());

        for suffix in ["-wal", "-shm", ""] {
            let mut p = self.path.clone().into_os_string();
            p.push(suffix);
            remove_with_retry(&PathBuf::from(p));
        }
    }
}

/// Unlink a file, tolerating the brief window where the SQLite worker thread
/// has not yet finished releasing its handle.
fn remove_with_retry(path: &Path) {
    for attempt in 0..50 {
        if !path.exists() {
            return;
        }
        if std::fs::remove_file(path).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(if attempt < 10 { 2 } else { 20 }));
    }
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
         ) VALUES (?, ?, ?, ?, ?, 'inclusive', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(spec.id)
    .bind(STORE_ID)
    .bind(spec.sku)
    .bind(spec.name)
    .bind(spec.vat_rate_id)
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
    sqlx::query("INSERT INTO suppliers (id, store_id, name) VALUES (?, ?, ?)")
        .bind(id)
        .bind(STORE_ID)
        .bind(name)
        .execute(db.pool())
        .await
        .expect("seed supplier");
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
