// Layer C — migrations against a virgin temporary database.

use crate::test_support::{app_migrator, assert_not_production_db, TempDb, STORE_ID};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_migrations_apply_to_a_virgin_database() {
    let db = TempDb::empty().await;

    // Nothing exists yet.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").await,
        0,
        "a virgin database must start empty"
    );

    app_migrator().run(db.pool()).await.expect("migrations apply");

    // Every table the app documents is present.
    for table in [
        "stores", "users", "devices", "vat_rates", "products", "exchange_rates",
        "inventory_movements", "shifts", "sales", "sale_items", "sale_payments",
        "sync_queue", "app_settings", "accounts", "journal_entries", "journal_lines",
        "product_barcodes", "units_of_measure", "product_uoms", "suppliers",
        "purchases", "purchase_items", "supplier_ledger",
    ] {
        let n = db
            .count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{table}'"
            ))
            .await;
        assert_eq!(n, 1, "table `{table}` is missing after migration");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_versions_are_recorded_in_order() {
    let db = TempDb::new().await;

    let applied = db
        .count("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
        .await;
    assert_eq!(applied, 7, "all seven migrations must be recorded");

    assert_eq!(db.scalar_i64("SELECT MIN(version) FROM _sqlx_migrations").await, 1);
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 7);

    // Versions are exactly 1..=7 with no gaps or duplicates.
    let distinct = db
        .count("SELECT COUNT(DISTINCT version) FROM _sqlx_migrations")
        .await;
    assert_eq!(distinct, 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_running_the_migrator_is_a_no_op() {
    // Exercises the real runner's `_sqlx_migrations` tracking and checksum
    // validation — not a naive "execute the SQL twice" check.
    let db = TempDb::new().await;
    let before = db.count("SELECT COUNT(*) FROM _sqlx_migrations").await;
    let products_before = db.count("SELECT COUNT(*) FROM products").await;

    db.migrate_again().await.expect("second run must succeed");
    db.migrate_again().await.expect("third run must succeed");

    assert_eq!(db.count("SELECT COUNT(*) FROM _sqlx_migrations").await, before);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products").await,
        products_before,
        "re-running migrations must not duplicate seed rows"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migrations_are_deterministic_across_databases() {
    // Two independent databases must end up with byte-identical schema and
    // identical migration checksums.
    let a = TempDb::new().await;
    let b = TempDb::new().await;

    let schema_sql =
        "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
         (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(a.scalar_string(schema_sql).await, b.scalar_string(schema_sql).await);

    let checksums = "SELECT COALESCE(GROUP_CONCAT(HEX(checksum), ','), '') FROM \
                     (SELECT checksum FROM _sqlx_migrations ORDER BY version)";
    assert_eq!(a.scalar_string(checksums).await, b.scalar_string(checksums).await);

    assert_ne!(a.path(), b.path(), "each test database must be its own file");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seed_data_required_by_the_posting_commands_is_present() {
    let db = TempDb::new().await;

    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM stores WHERE id = '{STORE_ID}'")).await,
        1
    );
    // Lebanese standard VAT, stored in basis points.
    assert_eq!(
        db.scalar_i64("SELECT rate_bps FROM vat_rates WHERE name = 'Standard 11%'").await,
        1100
    );
    assert_eq!(
        db.scalar_i64("SELECT rate_bps FROM vat_rates WHERE name = 'Exempt'").await,
        0
    );
    assert_eq!(
        db.scalar_i64("SELECT is_exempt FROM vat_rates WHERE name = 'Exempt'").await,
        1
    );

    // The document-number sequences both posting commands consume.
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key = 'next_receipt_number'").await,
        "1"
    );
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key = 'next_purchase_number'").await,
        "1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn temp_databases_are_isolated_and_removed_on_drop() {
    let path = {
        let db = TempDb::new().await;
        let p = db.path().to_path_buf();
        assert!(p.exists(), "the database file should exist while in use");
        p
    };
    assert!(!path.exists(), "the database file must be deleted when the guard drops");
}

#[test]
#[should_panic(expected = "refusing to open the production database")]
fn the_production_database_cannot_be_opened_from_a_test() {
    assert_not_production_db(&std::env::temp_dir().join("greaz-pos-tests").join("greaz-pos.db"));
}

#[test]
#[should_panic(expected = "test databases must live under")]
fn databases_outside_the_temp_root_are_rejected() {
    assert_not_production_db(std::path::Path::new("C:/Users/someone/AppData/Roaming/app/x.db"));
}
