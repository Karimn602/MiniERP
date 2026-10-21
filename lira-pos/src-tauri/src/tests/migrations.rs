// Layer C — migrations against a virgin temporary database.

use crate::cost::{cents_to_microcents, COST_SCALE};
use crate::test_support::{
    app_migrator, assert_not_production_db, driver_balance, latest_migration_version,
    migration_count, seed_driver, seed_driver_in_store, seed_store, TempDb, RATE_ID, STORE_ID,
    USER_ID, VAT_STD_ID,
};
use sqlx::Row;

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
        "sales_credit_memos", "sales_credit_memo_lines", "sales_credit_memo_refunds",
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

    let expected = migration_count();
    let latest = latest_migration_version();

    let applied = db
        .count("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
        .await;
    assert_eq!(applied, expected, "every shipped migration must be recorded");

    assert_eq!(db.scalar_i64("SELECT MIN(version) FROM _sqlx_migrations").await, 1);
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, latest);

    // Versions are exactly 1..=latest with no gaps or duplicates.
    let distinct = db
        .count("SELECT COUNT(DISTINCT version) FROM _sqlx_migrations")
        .await;
    assert_eq!(distinct, expected);
    assert_eq!(latest, expected, "migration versions must be contiguous from 1");
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

    // Since WP-02 `post_sale` resolves the sale UoM against product_uoms, so
    // every seeded product must have one. `productsRepo.create` upholds the
    // same rule for products made later.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM products p
              WHERE NOT EXISTS (
                SELECT 1 FROM product_uoms u
                 WHERE u.product_id = p.id AND u.is_base = 1 AND u.is_active = 1)"
        )
        .await,
        0,
        "every product must have an active base UoM row"
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

// ============================================================================
// Migration 008 — cost precision (GP-A03)
// ============================================================================
//
// The upgrade path is the risky one. A fresh database is covered by the tests
// above; these cover a database an EARLIER release of the app already wrote
// money into, which is what every existing shop has. They run migrations 1..=7
// through the real runner, fill the four cost-bearing tables with whole-cent
// data, and only then apply 008.

const P_UPGRADE: &str = "00000000-0000-0000-0000-0000000000u1";
const SUP_UPGRADE: &str = "00000000-0000-0000-0000-0000000000u2";

/// A v7 database holding one product, one posted purchase, one posted sale and
/// the matching inventory movements — all with whole-cent costs, exactly as the
/// pre-WP-03 posting commands wrote them.
async fn pre_wp03_database_with_cost_data() -> TempDb {
    let db = TempDb::at_schema_version(7).await;

    db.exec(&format!(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('{RATE_ID}', '{STORE_ID}', '2026-01-01', 89500, 'manual')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO suppliers (id, store_id, name)
         VALUES ('{SUP_UPGRADE}', '{STORE_ID}', 'Legacy Co')"
    ))
    .await;
    // Whole-cent average cost, the only kind a v7 database can hold.
    db.exec(&format!(
        "INSERT INTO products (
           id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents,
           avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
           quantity_on_hand, is_active, is_service, updated_at
         ) VALUES ('{P_UPGRADE}', '{STORE_ID}', 'SKU-LEGACY', 'Legacy Coffee',
                   '{VAT_STD_ID}', 'inclusive', 1000, 1110, 237, 263, 40, 1, 0,
                   '2026-01-01T00:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active
         ) VALUES ('{P_UPGRADE}-u', '{STORE_ID}', '{P_UPGRADE}', 'each', 1, 1, 1, 1, 1, 1)"
    ))
    .await;

    // A posted purchase and its line.
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, purchase_number, purchase_date,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           status, created_by_user_id, posted_at
         ) VALUES ('pur-legacy', '{STORE_ID}', '{SUP_UPGRADE}', 'normal', 1, '2026-01-02',
                   9480, 1043, 10523, 'posted', '{USER_ID}', '2026-01-02T10:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO purchase_items (
           id, purchase_id, store_id, product_id, product_name_snapshot,
           uom_code_snapshot, factor_num_snapshot, factor_den_snapshot,
           quantity_in_uom, quantity_base,
           unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
           unit_cost_excl_vat_base_cents, unit_cost_incl_vat_base_cents,
           vat_rate_id_snapshot, vat_rate_bps_snapshot,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
         ) VALUES ('pi-legacy', 'pur-legacy', '{STORE_ID}', '{P_UPGRADE}', 'Legacy Coffee',
                   'each', 1, 1, 40, 40, 237, 263, 237, 263,
                   '{VAT_STD_ID}', 1100, 9480, 1043, 10523)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO inventory_movements (
           id, store_id, product_id, movement_type, quantity_delta,
           unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
           related_purchase_id, related_purchase_item_id, posted_at
         ) VALUES ('mv-legacy-pur', '{STORE_ID}', '{P_UPGRADE}', 'purchase', 40,
                   237, 263, 'pur-legacy', 'pi-legacy', '2026-01-02T10:00:00.000Z')"
    ))
    .await;

    // A posted sale and its line, carrying a COGS snapshot.
    db.exec(&format!(
        "INSERT INTO sales (
           id, store_id, cashier_user_id, receipt_number,
           exchange_rate_lbp_per_usd, exchange_rate_id,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           discount_cents, cogs_total_cents, cogs_method, status, posted_at
         ) VALUES ('sale-legacy', '{STORE_ID}', '{USER_ID}', 1, 89500, '{RATE_ID}',
                   900, 100, 1000, 0, 474, 'weighted_average', 'posted',
                   '2026-01-03T10:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_items (
           id, sale_id, store_id, product_id, product_name_snapshot,
           vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
           unit_price_excl_vat_cents, unit_price_incl_vat_cents,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
           line_discount_cents, unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
           quantity_in_uom, uom_code_snapshot, factor_num_snapshot, factor_den_snapshot
         ) VALUES ('si-legacy', 'sale-legacy', '{STORE_ID}', '{P_UPGRADE}', 'Legacy Coffee',
                   '{VAT_STD_ID}', 1100, 2, 450, 500, 900, 100, 1000, 0, 237, 474,
                   2, 'each', 1, 1)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO inventory_movements (
           id, store_id, product_id, movement_type, quantity_delta,
           unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
           related_sale_id, related_sale_item_id, posted_at
         ) VALUES ('mv-legacy-sale', '{STORE_ID}', '{P_UPGRADE}', 'sale', -2,
                   237, 263, 'sale-legacy', 'si-legacy', '2026-01-03T10:00:00.000Z')"
    ))
    .await;

    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_008_applies_to_an_existing_pre_wp03_database() {
    let db = pre_wp03_database_with_cost_data().await;
    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        7,
        "the fixture must start on the pre-WP-03 schema"
    );

    db.migrate_again()
        .await
        .expect("migration 008 must apply to a populated v7 database");

    // `migrate_again` runs the whole remaining list, so a v7 database lands on
    // the current head rather than stopping at 8.
    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        latest_migration_version()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_008_backfills_every_existing_cost_exactly() {
    let db = pre_wp03_database_with_cost_data().await;
    db.migrate_again().await.expect("migration 008 must apply");

    // Backfill is `cents x COST_SCALE` — an exact change of units, never a
    // recomputation. Each assertion states the expected value independently of
    // the migration SQL.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_UPGRADE}'"
        ))
        .await,
        cents_to_microcents(237).unwrap(),
        "the weighted-average cost must survive the unit change exactly"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_incl_vat_microcents FROM products WHERE id='{P_UPGRADE}'"
        ))
        .await,
        263 * COST_SCALE
    );
    assert_eq!(
        db.scalar_i64(
            "SELECT unit_cost_excl_vat_base_microcents FROM purchase_items WHERE id='pi-legacy'"
        )
        .await,
        237 * COST_SCALE
    );
    assert_eq!(
        db.scalar_i64(
            "SELECT unit_cost_incl_vat_base_microcents FROM purchase_items WHERE id='pi-legacy'"
        )
        .await,
        263 * COST_SCALE
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE id='si-legacy'")
            .await,
        237 * COST_SCALE,
        "a posted sale COGS rate must be re-expressed, not re-derived"
    );
    for movement in ["mv-legacy-pur", "mv-legacy-sale"] {
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT unit_cost_excl_vat_microcents FROM inventory_movements WHERE id='{movement}'"
            ))
            .await,
            237 * COST_SCALE,
            "movement {movement} must keep its cost snapshot"
        );
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT unit_cost_incl_vat_microcents FROM inventory_movements WHERE id='{movement}'"
            ))
            .await,
            263 * COST_SCALE
        );
    }

    // Nothing else moved. In particular the legacy cents columns are untouched,
    // the posted monetary COGS is untouched, and `products.updated_at` was not
    // rewritten by the backfill.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_UPGRADE}'"
        ))
        .await,
        237
    );
    assert_eq!(
        db.scalar_i64("SELECT line_cogs_excl_vat_cents FROM sale_items WHERE id='si-legacy'")
            .await,
        474,
        "a posted sale COGS amount must not be recomputed by the migration"
    );
    assert_eq!(
        db.scalar_i64("SELECT cogs_total_cents FROM sales WHERE id='sale-legacy'").await,
        474
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT updated_at FROM products WHERE id='{P_UPGRADE}'"))
            .await,
        "2026-01-01T00:00:00.000Z",
        "the backfill must not disturb product housekeeping timestamps"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_008_restores_the_append_only_guards_it_lifts() {
    // The backfill has to drop three immutability triggers to write its new
    // columns. If it ever forgot to put one back, posted history would become
    // editable — a far worse defect than the one being fixed.
    let db = pre_wp03_database_with_cost_data().await;
    db.migrate_again().await.expect("migration 008 must apply");

    for trigger in [
        "trg_inv_mov_no_update",
        "trg_sale_items_no_update_after_post",
        "trg_purchase_items_no_update_after_post",
        "trg_products_updated_at",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
            ))
            .await,
            1,
            "migration 008 must restore `{trigger}`"
        );
    }

    // And they actually fire.
    assert!(
        db.try_exec(
            "UPDATE inventory_movements SET unit_cost_excl_vat_microcents = 1
              WHERE id='mv-legacy-pur'"
        )
        .await
        .is_err(),
        "inventory movements must still be append-only after migration 008"
    );
    assert!(
        db.try_exec(
            "UPDATE sale_items SET unit_cogs_excl_vat_microcents = 1 WHERE id='si-legacy'"
        )
        .await
        .is_err(),
        "the items of a posted sale must still be immutable after migration 008"
    );
    assert!(
        db.try_exec(
            "UPDATE purchase_items SET unit_cost_excl_vat_base_microcents = 1
              WHERE id='pi-legacy'"
        )
        .await
        .is_err(),
        "the items of a posted purchase must still be immutable after migration 008"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_008_is_idempotent_through_the_real_runner() {
    let db = pre_wp03_database_with_cost_data().await;
    db.migrate_again().await.expect("first upgrade");
    let before = db.count("SELECT COUNT(*) FROM _sqlx_migrations").await;

    db.migrate_again().await.expect("second run must be a no-op");
    db.migrate_again().await.expect("third run must be a no-op");

    assert_eq!(db.count("SELECT COUNT(*) FROM _sqlx_migrations").await, before);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_UPGRADE}'"
        ))
        .await,
        237 * COST_SCALE,
        "re-running must not re-scale an already-backfilled cost"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgraded_database_matches_a_fresh_one_schema_for_schema() {
    // An existing shop that upgrades must end up on exactly the schema a new
    // install gets — otherwise the two diverge silently from here on.
    let upgraded = pre_wp03_database_with_cost_data().await;
    upgraded.migrate_again().await.expect("upgrade");
    let fresh = TempDb::new().await;

    let schema_sql =
        "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
         (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(
        upgraded.scalar_string(schema_sql).await,
        fresh.scalar_string(schema_sql).await
    );
}

// ============================================================================
// Migration 009 — shift lifecycle integrity (GZ-HI-03)
// ============================================================================
//
// The uniqueness scope is the STORE, which is the scope the application already
// queried by. The risky path is a database that has ALREADY drifted: a shop on
// an earlier release could accumulate two or more open shifts for one store,
// and the unique index cannot be created over them. These tests run migrations
// 1..=8, produce exactly that drift, and only then apply 009.

const SHIFT_OLD: &str = "00000000-0000-0000-0000-0000000009a1";
const SHIFT_MID: &str = "00000000-0000-0000-0000-0000000009a2";
const SHIFT_NEW: &str = "00000000-0000-0000-0000-0000000009a3";

/// A v8 database holding `count` simultaneously-open shifts for the seeded
/// store — the state the pre-WP-04 check-then-insert could leave behind.
async fn pre_wp04_database_with_open_shifts(shifts: &[(&str, &str)]) -> TempDb {
    let db = TempDb::at_schema_version(8).await;
    for (id, opened_at) in shifts {
        db.exec(&format!(
            "INSERT INTO shifts (
               id, store_id, opened_by_user_id, opened_at,
               opening_cash_usd_cents, opening_cash_lbp, status
             ) VALUES ('{id}', '{STORE_ID}', '{USER_ID}', '{opened_at}', 5000, 100000, 'open')"
        ))
        .await;
    }
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_009_applies_to_a_v8_database_with_one_open_shift() {
    // The ordinary upgrade: a shop mid-shift when it installs the new version.
    // Its open shift must survive untouched — the migration is not allowed to
    // close a drawer somebody is still trading out of.
    let db = pre_wp04_database_with_open_shifts(&[(SHIFT_NEW, "2026-03-01T08:00:00.000Z")]).await;
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 8);

    db.migrate_again().await.expect("migration 009 must apply to a populated v8 database");

    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        latest_migration_version()
    );
    assert_eq!(db.scalar_string(&format!("SELECT status FROM shifts WHERE id='{SHIFT_NEW}'")).await, "open");
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM shifts WHERE id='{SHIFT_NEW}' AND closed_at IS NULL")).await,
        1,
        "an untouched open shift keeps its NULL close columns"
    );
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM shifts WHERE id='{SHIFT_NEW}' AND notes IS NULL")).await,
        1,
        "and is not annotated"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_009_reconciles_a_database_that_already_held_two_open_shifts() {
    let db = pre_wp04_database_with_open_shifts(&[
        (SHIFT_OLD, "2026-03-01T06:00:00.000Z"),
        (SHIFT_MID, "2026-03-01T10:00:00.000Z"),
        (SHIFT_NEW, "2026-03-01T14:00:00.000Z"),
    ])
    .await;
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts WHERE status='open'").await, 3);

    db.migrate_again().await.expect("migration 009 must repair the drift, not fail on it");

    // The newest stays open; the older two are closed. Deterministic, by
    // `opened_at` then `id`.
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts WHERE status='open'").await, 1);
    assert_eq!(db.scalar_string(&format!("SELECT status FROM shifts WHERE id='{SHIFT_NEW}'")).await, "open");
    assert_eq!(db.scalar_string(&format!("SELECT status FROM shifts WHERE id='{SHIFT_OLD}'")).await, "closed");
    assert_eq!(db.scalar_string(&format!("SELECT status FROM shifts WHERE id='{SHIFT_MID}'")).await, "closed");

    // Nothing is INVENTED for the drawers nobody counted: counted, expected and
    // variance stay NULL, and the row says in words why it was closed.
    for id in [SHIFT_OLD, SHIFT_MID] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM shifts
                  WHERE id='{id}'
                    AND closing_cash_usd_cents IS NULL AND closing_cash_lbp IS NULL
                    AND expected_cash_usd_cents IS NULL AND expected_cash_lbp IS NULL
                    AND variance_usd_cents IS NULL AND variance_lbp IS NULL
                    AND closed_at IS NOT NULL"
            ))
            .await,
            1,
            "an auto-closed shift records 'never reconciled', not a fabricated count"
        );
        assert!(
            db.scalar_string(&format!("SELECT notes FROM shifts WHERE id='{id}'"))
                .await
                .contains("Auto-closed by migration 009"),
            "the repair must be visible in the audit trail"
        );
    }

    // The opening floats — real money somebody did hand over — are preserved.
    assert_eq!(
        db.scalar_i64(&format!("SELECT opening_cash_usd_cents FROM shifts WHERE id='{SHIFT_OLD}'")).await,
        5_000
    );

    // And the invariant now holds against a direct write.
    let err = db
        .try_exec(&format!(
            "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                                 opening_cash_lbp, status)
             VALUES ('another', '{STORE_ID}', '{USER_ID}', 0, 0, 'open')"
        ))
        .await
        .expect_err("after the repair the index must be in force");
    assert!(err.to_string().contains("UNIQUE") || err.to_string().contains("ux_shifts_one_open_per_store"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_009_leaves_each_store_its_own_open_shift() {
    // The scope is per store, so two stores trading at once is NOT drift. A
    // migration that closed one of them would shut a branch down.
    let db = TempDb::at_schema_version(8).await;
    db.exec("INSERT INTO stores (id, name) VALUES ('store-2', 'Second Branch')").await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                             opening_cash_usd_cents, opening_cash_lbp, status)
         VALUES ('{SHIFT_NEW}', '{STORE_ID}', '{USER_ID}', '2026-03-01T08:00:00.000Z', 0, 0, 'open')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                             opening_cash_usd_cents, opening_cash_lbp, status)
         VALUES ('{SHIFT_MID}', 'store-2', '{USER_ID}', '2026-03-01T09:00:00.000Z', 0, 0, 'open')"
    ))
    .await;

    db.migrate_again().await.expect("migration 009 must apply");

    assert_eq!(db.count("SELECT COUNT(*) FROM shifts WHERE status='open'").await, 2);
    assert_eq!(db.scalar_string(&format!("SELECT status FROM shifts WHERE id='{SHIFT_NEW}'")).await, "open");
    assert_eq!(db.scalar_string(&format!("SELECT status FROM shifts WHERE id='{SHIFT_MID}'")).await, "open");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_009_keeps_closed_and_voided_shifts_unconstrained() {
    // Only OPEN rows are constrained — that is what a partial index is for. A
    // store accumulates a closed shift per day for ever, plus any voided ones.
    let db = TempDb::new().await;
    for i in 0..5 {
        db.exec(&format!(
            "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, closed_at,
                                 opening_cash_usd_cents, opening_cash_lbp, status)
             VALUES ('closed-{i}', '{STORE_ID}', '{USER_ID}',
                     '2026-03-0{}T08:00:00.000Z', '2026-03-0{}T16:00:00.000Z', 0, 0, 'closed')",
            i + 1,
            i + 1
        ))
        .await;
    }
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                             opening_cash_lbp, status)
         VALUES ('voided-1', '{STORE_ID}', '{USER_ID}', 0, 0, 'voided')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                             opening_cash_lbp, status)
         VALUES ('open-1', '{STORE_ID}', '{USER_ID}', 0, 0, 'open')"
    ))
    .await;

    assert_eq!(db.count("SELECT COUNT(*) FROM shifts").await, 7);
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts WHERE status='open'").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgraded_database_converges_on_the_same_schema_as_a_fresh_one() {
    // Fresh install and upgrade must end up in the same place: same tables, same
    // indexes, same triggers. A partial index or a trigger that only ever
    // appeared on one of the two paths would make the invariant depend on how
    // old the shop's database is.
    let fresh = TempDb::new().await;
    let upgraded = pre_wp04_database_with_open_shifts(&[
        (SHIFT_OLD, "2026-03-01T06:00:00.000Z"),
        (SHIFT_NEW, "2026-03-01T14:00:00.000Z"),
    ])
    .await;
    upgraded.migrate_again().await.expect("migration 009 must apply");

    let schema_sql = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                      (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(
        fresh.scalar_string(schema_sql).await,
        upgraded.scalar_string(schema_sql).await,
        "a fresh database and an upgraded one must carry identical schema"
    );

    for db in [&fresh, &upgraded] {
        assert_eq!(
            db.count(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type='index' AND name='ux_shifts_one_open_per_store'"
            )
            .await,
            1,
            "the one-open-shift index must exist on both paths"
        );
        assert_eq!(
            db.count(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type='trigger' AND name='trg_shifts_no_update_after_close'"
            )
            .await,
            1,
            "the closed-shift immutability trigger must exist on both paths"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_009_does_not_disturb_the_earlier_immutability_guards() {
    // Migration 008 had to drop and restore the append-only triggers to backfill.
    // 009 adds a trigger of its own; the existing ones must still be in force.
    let db = TempDb::at_schema_version(8).await;
    db.migrate_again().await.expect("migration 009 must apply");

    for trigger in [
        "trg_inv_mov_no_update",
        "trg_sale_items_no_update_after_post",
        "trg_purchase_items_no_update_after_post",
        "trg_products_updated_at",
        "trg_shifts_no_update_after_close",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
            ))
            .await,
            1,
            "`{trigger}` must be present after migration 009"
        );
    }
}

// ============================================================================
// Migration 010 — supplier / accounts-payable integrity (GZ-HI-05)
// ============================================================================
//
// 010 adds a generated column, an index and three triggers. The risky paths are
// both about a database that has ALREADY drifted, because nothing before this
// release stopped it:
//
//   * a shop that keyed one supplier invoice twice — which is exactly why the
//     duplicate rule is a trigger and not a unique index, since the index
//     could not be created over that data and the only ways around it would be
//     to rewrite or delete one of two real financial documents;
//   * a ledger holding a payment row with the wrong sign, which the new sign
//     trigger would reject on insert but must not retroactively condemn.
//
// These tests run migrations 1..=9, produce exactly that drift, and only then
// apply 010.

const AP_SUPPLIER: &str = "00000000-0000-0000-0000-00000000a0a1";
const AP_SUPPLIER_B: &str = "00000000-0000-0000-0000-00000000a0a2";

/// A v9 database with one supplier and `purchases` rows as an earlier release
/// left them: posted, each quoting the reference given, with the matching
/// invoice liability in the supplier ledger.
async fn pre_wp05_database(purchases: &[(&str, &str, i64)]) -> TempDb {
    let db = TempDb::at_schema_version(9).await;
    for (id, name) in [(AP_SUPPLIER, "Beirut Wholesale"), (AP_SUPPLIER_B, "Tripoli Imports")] {
        db.exec(&format!(
            "INSERT INTO suppliers (id, store_id, name) VALUES ('{id}', '{STORE_ID}', '{name}')"
        ))
        .await;
    }
    for (i, (id, reference, total)) in purchases.iter().enumerate() {
        let number = i as i64 + 1;
        db.exec(&format!(
            "INSERT INTO purchases (
               id, store_id, supplier_id, purchase_type, supplier_reference,
               purchase_number, purchase_date,
               subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
               status, posted_at
             ) VALUES ('{id}', '{STORE_ID}', '{AP_SUPPLIER}', 'normal', '{reference}',
                       {number}, '2026-02-0{number}', {total}, 0, {total},
                       'posted', '2026-02-0{number}T10:00:00.000Z')"
        ))
        .await;
        db.exec(&format!(
            "INSERT INTO supplier_ledger (
               id, store_id, supplier_id, entry_type, amount_cents, entry_date,
               related_purchase_id, posted_at
             ) VALUES ('led-{number}', '{STORE_ID}', '{AP_SUPPLIER}', 'purchase', {total},
                       '2026-02-0{number}', '{id}', '2026-02-0{number}T10:00:00.000Z')"
        ))
        .await;
    }
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_010_applies_to_a_populated_v9_database() {
    // The ordinary upgrade: a shop with purchase history and a supplier ledger
    // installs the new version. Every document survives untouched.
    let db = pre_wp05_database(&[("pur-1", "INV-1", 2_220), ("pur-2", "INV-2", 1_110)]).await;
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 9);

    db.migrate_again()
        .await
        .expect("migration 010 must apply to a populated v9 database");

    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        latest_migration_version()
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases WHERE status='posted'").await, 2);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 2);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_cents),0) FROM supplier_ledger WHERE supplier_id='{AP_SUPPLIER}'"
        ))
        .await,
        3_330,
        "the payable a shop carried in must be exactly what it was"
    );

    // The generated column is populated for history, with no backfill — which
    // is the point of generating it: an UPDATE over `purchases` would have had
    // to lift the posted-purchase immutability trigger.
    assert_eq!(
        db.scalar_string("SELECT supplier_reference_key FROM purchases WHERE id='pur-1'").await,
        "INV-1"
    );
    // So a NEW purchase quoting a reference a shop used BEFORE the upgrade is
    // still caught.
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, supplier_reference,
           purchase_number, purchase_date, status
         ) VALUES ('pur-new', '{STORE_ID}', '{AP_SUPPLIER}', 'normal', 'inv-1',
                   99, '2026-03-01', 'draft')"
    ))
    .await;
    let err = db
        .try_exec("UPDATE purchases SET status='posted', posted_at='2026-03-01T09:00:00.000Z' WHERE id='pur-new'")
        .await
        .expect_err("a historical reference must still be protected after the upgrade");
    assert!(err.to_string().contains("already posted"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_010_upgrades_a_database_that_already_held_a_duplicate_invoice() {
    // THE dirty-data case. A shop on an earlier release keyed invoice "INV-1"
    // twice and owes double for one delivery. That is the defect — and it is
    // not this migration's business to restate a shop's books: both documents
    // and both liabilities stay exactly as recorded.
    let db = pre_wp05_database(&[
        ("pur-1", "INV-1", 2_220),
        ("pur-2", "inv-1 ", 2_220),
        ("pur-3", "INV-2", 500),
    ])
    .await;

    db.migrate_again()
        .await
        .expect("migration 010 must upgrade a drifted database, not refuse to start");

    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        latest_migration_version()
    );

    // Nothing deleted, nothing rewritten, nothing annotated.
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 3);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 3);
    assert_eq!(
        db.scalar_string("SELECT supplier_reference FROM purchases WHERE id='pur-2'").await,
        "inv-1 ",
        "the second document keeps its reference exactly as it was typed"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_cents),0) FROM supplier_ledger WHERE supplier_id='{AP_SUPPLIER}'"
        ))
        .await,
        4_940,
        "the balance a shop carried in is preserved, duplicate and all"
    );
    // Both are still visible as the duplicate pair they are, which is what lets
    // the shop reconcile them deliberately.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM purchases WHERE supplier_reference_key = 'INV-1'").await,
        2
    );

    // But the shop cannot add a THIRD.
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, supplier_reference,
           purchase_number, purchase_date, status
         ) VALUES ('pur-4', '{STORE_ID}', '{AP_SUPPLIER}', 'normal', 'INV-1',
                   98, '2026-03-01', 'draft')"
    ))
    .await;
    let err = db
        .try_exec("UPDATE purchases SET status='posted', posted_at='2026-03-01T09:00:00.000Z' WHERE id='pur-4'")
        .await
        .expect_err("the rule must bind writes from here on");
    assert!(err.to_string().contains("already posted"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_010_leaves_a_historically_wrong_signed_ledger_row_alone() {
    // A v9 ledger could hold a payment with a positive amount — the sign defect
    // itself. The new trigger constrains INSERTs, so the historical row stands:
    // it is a row the shop's accountant has to look at, not one a migration may
    // silently flip, and flipping it would move a balance nobody asked us to.
    let db = pre_wp05_database(&[("pur-1", "INV-1", 10_000)]).await;
    db.exec(&format!(
        "INSERT INTO supplier_ledger (
           id, store_id, supplier_id, entry_type, amount_cents, entry_date, posted_at
         ) VALUES ('led-bad', '{STORE_ID}', '{AP_SUPPLIER}', 'payment', 2_500,
                   '2026-02-05', '2026-02-05T10:00:00.000Z')"
    ))
    .await;

    db.migrate_again().await.expect("migration 010 must apply");

    assert_eq!(
        db.scalar_i64("SELECT amount_cents FROM supplier_ledger WHERE id='led-bad'").await,
        2_500,
        "history is not restated"
    );
    // And a new row like it is refused.
    let err = db
        .try_exec(&format!(
            "INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount_cents, entry_date)
             VALUES ('led-bad-2', '{STORE_ID}', '{AP_SUPPLIER}', 'payment', 2500, '2026-03-01')"
        ))
        .await
        .expect_err("the sign trigger must bind writes from here on");
    assert!(err.to_string().contains("must be negative"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_010_is_idempotent_through_the_real_runner() {
    let db = pre_wp05_database(&[("pur-1", "INV-1", 2_220)]).await;
    db.migrate_again().await.expect("first run");
    let before = db.count("SELECT COUNT(*) FROM _sqlx_migrations").await;

    db.migrate_again().await.expect("second run must succeed");
    db.migrate_again().await.expect("third run must succeed");

    assert_eq!(db.count("SELECT COUNT(*) FROM _sqlx_migrations").await, before);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_v9_upgrade_converges_on_the_same_schema_as_a_fresh_install() {
    // Fresh install and upgrade must end up in the same place. A generated
    // column, a partial index or a trigger that only ever appeared on one of
    // the two paths would make the AP rules depend on how old the shop's
    // database is.
    let fresh = TempDb::new().await;
    let upgraded = pre_wp05_database(&[("pur-1", "INV-1", 2_220), ("pur-2", "inv-1", 2_220)]).await;
    upgraded.migrate_again().await.expect("migration 010 must apply");

    let schema_sql = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                      (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(
        fresh.scalar_string(schema_sql).await,
        upgraded.scalar_string(schema_sql).await,
        "a fresh database and an upgraded one must carry identical schema"
    );

    for db in [&fresh, &upgraded] {
        for (kind, name) in [
            ("index", "idx_purchases_supplier_reference_key"),
            ("trigger", "trg_purchases_no_duplicate_supplier_invoice_ins"),
            ("trigger", "trg_purchases_no_duplicate_supplier_invoice_upd"),
            ("trigger", "trg_supplier_ledger_sign_discipline"),
        ] {
            assert_eq!(
                db.count(&format!(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='{kind}' AND name='{name}'"
                ))
                .await,
                1,
                "`{name}` must exist on both paths"
            );
        }
        assert_eq!(
            // `pragma_table_xinfo`, not `table_info`: a VIRTUAL generated
            // column is a hidden column and `table_info` does not list it.
            db.count("SELECT COUNT(*) FROM pragma_table_xinfo('purchases') WHERE name='supplier_reference_key'")
                .await,
            1,
            "the normalized-reference column must exist on both paths"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_010_does_not_disturb_the_earlier_guards() {
    // 010 adds triggers of its own and lifts none; every guard migrations 001
    // through 009 put in place must still be in force.
    let db = pre_wp05_database(&[("pur-1", "INV-1", 2_220)]).await;
    db.migrate_again().await.expect("migration 010 must apply");

    for trigger in [
        "trg_sales_no_update_after_post",
        "trg_inv_mov_no_update",
        "trg_sale_items_no_update_after_post",
        "trg_purchase_items_no_update_after_post",
        "trg_purchases_no_update_after_post",
        "trg_purchases_no_delete_after_post",
        "trg_supplier_ledger_no_update",
        "trg_supplier_ledger_no_delete",
        "trg_shifts_no_update_after_close",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
            ))
            .await,
            1,
            "`{trigger}` must be present after migration 010"
        );
    }

    // And they still bite: a posted purchase cannot be edited, and a ledger row
    // cannot be rewritten to change what the shop owes.
    assert!(
        db.try_exec("UPDATE purchases SET total_incl_vat_cents = 1 WHERE id='pur-1'")
            .await
            .is_err(),
        "a posted purchase must stay immutable"
    );
    assert!(
        db.try_exec("UPDATE supplier_ledger SET amount_cents = 1 WHERE id='led-1'")
            .await
            .is_err(),
        "a supplier-ledger entry must stay immutable"
    );
    assert!(
        db.try_exec("DELETE FROM supplier_ledger WHERE id='led-1'").await.is_err(),
        "a supplier-ledger entry must stay undeletable"
    );
}

// ============================================================================
// Migration 011 — sales returns / credit memos (GP-A08)
// ============================================================================
//
// 011 adds three tables, two columns on `inventory_movements`, a sequence key
// and a set of guards. Unlike 008 it backfills nothing — there is no prior
// returns data anywhere, because no command and no repository ever wrote any —
// so the risk is not dirty data but DIVERGENCE: a table, a trigger or a
// sequence that appears on only one of the two paths into version 11 would make
// whether a shop can process a return depend on how old its database is.
//
// These tests run migrations 1..=10, put a real posted sale in the database the
// way an earlier release left one, and only then apply 011.

const RET_PRODUCT: &str = "00000000-0000-0000-0000-00000000cb01";
const RET_SALE: &str = "00000000-0000-0000-0000-00000000cb02";
const RET_SALE_ITEM: &str = "00000000-0000-0000-0000-00000000cb03";

/// A v10 database holding one posted sale of two units, paid in cash, with its
/// stock movement — the shape every return in production starts from.
async fn pre_wp06_database() -> TempDb {
    let db = TempDb::at_schema_version(10).await;
    db.exec(&format!(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('{RATE_ID}', '{STORE_ID}', '2026-01-01', 89500, 'manual')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO products (
           id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents,
           avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
           avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
           quantity_on_hand
         ) VALUES ('{RET_PRODUCT}', '{STORE_ID}', 'SKU-D1', 'Coffee 250g', '{VAT_STD_ID}',
                   'exclusive', 450, 500, 200, 222, 200000000, 222000000, 98)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at,
                             opening_cash_usd_cents, opening_cash_lbp, status)
         VALUES ('shift-v10', '{STORE_ID}', '{USER_ID}', '2026-03-01T08:00:00.000Z', 0, 0, 'open')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sales (
           id, store_id, shift_id, cashier_user_id, receipt_number,
           exchange_rate_lbp_per_usd, exchange_rate_id,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           discount_cents, cogs_total_cents, cogs_method,
           sale_type, status, posted_at
         ) VALUES ('{RET_SALE}', '{STORE_ID}', 'shift-v10', '{USER_ID}', 1,
                   89500, '{RATE_ID}', 900, 100, 1000, 0, 400, 'weighted_average',
                   'normal', 'posted', '2026-03-01T10:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_items (
           id, sale_id, store_id, product_id, product_name_snapshot,
           vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
           unit_price_excl_vat_cents, unit_price_incl_vat_cents,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
           line_discount_cents,
           unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents, unit_cogs_excl_vat_microcents,
           quantity_in_uom, uom_code_snapshot, factor_num_snapshot, factor_den_snapshot
         ) VALUES ('{RET_SALE_ITEM}', '{RET_SALE}', '{STORE_ID}', '{RET_PRODUCT}', 'Coffee 250g',
                   '{VAT_STD_ID}', 1100, 2, 450, 500, 900, 100, 1000, 0,
                   200, 400, 200000000, 2, 'each', 1, 1)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_payments (
           id, sale_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
         ) VALUES ('pay-v10', '{RET_SALE}', '{STORE_ID}', 'cash_usd', 'USD', 1000, 0, 1000)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO inventory_movements (
           id, store_id, product_id, movement_type, quantity_delta,
           unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
           unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents,
           related_sale_id, related_sale_item_id, posted_at
         ) VALUES ('mov-v10', '{STORE_ID}', '{RET_PRODUCT}', 'sale', -2,
                   200, 222, 200000000, 222000000,
                   '{RET_SALE}', '{RET_SALE_ITEM}', '2026-03-01T10:00:00.000Z')"
    ))
    .await;
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_011_applies_to_a_populated_v10_database() {
    let db = pre_wp06_database().await;
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 10);

    db.migrate_again()
        .await
        .expect("migration 011 must apply to a populated v10 database");

    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        latest_migration_version()
    );

    // The three new tables exist and are empty — 011 backfills nothing, because
    // there was never any returns data to carry forward.
    for table in [
        "sales_credit_memos",
        "sales_credit_memo_lines",
        "sales_credit_memo_refunds",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{table}'"
            ))
            .await,
            1,
            "`{table}` is missing after migration 011"
        );
        assert_eq!(db.count(&format!("SELECT COUNT(*) FROM {table}")).await, 0);
    }

    // The sale, its line, its tender and its movement are byte for byte what
    // they were. A shop's books are not ours to restate.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales WHERE status='posted'").await, 1);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT total_incl_vat_cents FROM sales WHERE id = '{RET_SALE}'"
        ))
        .await,
        1_000
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE id = '{RET_SALE_ITEM}'"
        ))
        .await,
        200_000_000,
        "the WP-03 cost snapshot a return will value its restock at"
    );
    assert_eq!(db.scalar_i64(&format!("SELECT quantity_on_hand FROM products WHERE id = '{RET_PRODUCT}'")).await,
        98);

    // The two new movement columns are present and NULL on history: a sale
    // movement belongs to no credit memo.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM inventory_movements
              WHERE related_credit_memo_id IS NULL AND related_credit_memo_line_id IS NULL"
        )
        .await,
        1
    );

    // And the sequence is ready to issue #1.
    assert_eq!(
        db.scalar_string(
            "SELECT value FROM app_settings WHERE key = 'next_credit_memo_number'"
        )
        .await,
        "1"
    );
}

/// The upgraded database must be able to take a real return, not merely hold
/// the tables for one. This is the end-to-end proof that an upgrade and a fresh
/// install behave the same, rather than only look the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgraded_database_can_post_a_return_against_its_own_history() {
    let db = pre_wp06_database().await;
    db.migrate_again().await.expect("migration 011 must apply");

    let result = crate::posting::post_credit_memo_with_pool(
        db.pool(),
        crate::posting::PostCreditMemoPayload {
            credit_memo_id: "memo-upgrade".to_string(),
            store_id: STORE_ID.to_string(),
            original_sale_id: RET_SALE.to_string(),
            shift_id: Some("shift-v10".to_string()),
            cashier_user_id: Some(USER_ID.to_string()),
            device_id: None,
            reason: Some("Upgrade smoke test".to_string()),
            notes: None,
            exchange_rate_id: None,
            exchange_rate_lbp_per_usd: None,
            manager_approval: None,
            lines: vec![crate::posting::PostCreditMemoLine {
                credit_memo_line_id: "memo-upgrade-line".to_string(),
                original_sale_item_id: RET_SALE_ITEM.to_string(),
                quantity_in_uom: 2,
                quantity_base: 2,
                return_to_stock: true,
            }],
            refunds: vec![crate::posting::PostCreditMemoRefund {
                refund_id: "memo-upgrade-refund".to_string(),
                method: "cash_usd".to_string(),
                currency: "USD".to_string(),
                amount_native_usd_cents: 1_000,
                amount_native_lbp: 0,
                amount_usd_cents_equivalent: 1_000,
                reference: None,
            }],
        },
    )
    .await
    .expect("a return must post against history that predates the feature");

    assert_eq!(result.credit_memo_number, 1);
    assert_eq!(result.total_incl_vat_cents, 1_000);
    assert_eq!(result.vat_total_cents, 100);
    assert_eq!(
        result.cogs_reversed_cents, 400,
        "valued at the 200,000,000-microcent rate the pre-upgrade sale snapshotted"
    );
    assert_eq!(db.scalar_i64(&format!("SELECT quantity_on_hand FROM products WHERE id = '{RET_PRODUCT}'")).await,
        100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_011_is_idempotent_through_the_real_runner() {
    let db = pre_wp06_database().await;
    db.migrate_again().await.expect("first run");
    let before = db.count("SELECT COUNT(*) FROM _sqlx_migrations").await;

    db.migrate_again().await.expect("second run must succeed");
    db.migrate_again().await.expect("third run must succeed");

    assert_eq!(db.count("SELECT COUNT(*) FROM _sqlx_migrations").await, before);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales_credit_memos").await, 0);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key = 'next_credit_memo_number'")
            .await,
        "1",
        "re-running must not reset a sequence a shop has already used"
    );
}

/// And re-running after a return has posted must not reset the sequence —
/// `INSERT OR IGNORE` is what makes that true, and it is worth stating because
/// an `INSERT OR REPLACE` here would silently renumber a shop's credit memos.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_running_migration_011_leaves_a_used_sequence_alone() {
    let db = TempDb::new().await;
    db.exec("UPDATE app_settings SET value = '47' WHERE key = 'next_credit_memo_number'")
        .await;
    db.migrate_again().await.expect("re-running must succeed");
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key = 'next_credit_memo_number'")
            .await,
        "47"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_v10_upgrade_converges_on_the_same_schema_as_a_fresh_install() {
    let fresh = TempDb::new().await;
    let upgraded = pre_wp06_database().await;
    upgraded.migrate_again().await.expect("migration 011 must apply");

    let schema_sql = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                      (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(
        fresh.scalar_string(schema_sql).await,
        upgraded.scalar_string(schema_sql).await,
        "a fresh database and an upgraded one must carry identical schema"
    );

    for db in [&fresh, &upgraded] {
        for (kind, name) in [
            ("table", "sales_credit_memos"),
            ("table", "sales_credit_memo_lines"),
            ("table", "sales_credit_memo_refunds"),
            ("index", "idx_credit_memos_original"),
            ("index", "idx_credit_memo_lines_orig_item"),
            ("index", "idx_inv_mov_credit_memo"),
            ("trigger", "trg_credit_memos_no_update_after_post"),
            ("trigger", "trg_credit_memos_no_delete_after_post"),
            ("trigger", "trg_credit_memo_lines_no_insert_after_post"),
            ("trigger", "trg_credit_memo_refunds_no_insert_after_post"),
            ("trigger", "trg_credit_memo_lines_no_update_after_post"),
            ("trigger", "trg_credit_memo_lines_no_delete_after_post"),
            ("trigger", "trg_credit_memo_refunds_no_update_after_post"),
            ("trigger", "trg_credit_memo_refunds_no_delete_after_post"),
            ("trigger", "trg_credit_memo_lines_no_over_return"),
        ] {
            assert_eq!(
                db.count(&format!(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='{kind}' AND name='{name}'"
                ))
                .await,
                1,
                "`{name}` must exist on both paths"
            );
        }
        for column in ["related_credit_memo_id", "related_credit_memo_line_id"] {
            assert_eq!(
                db.count(&format!(
                    "SELECT COUNT(*) FROM pragma_table_info('inventory_movements')
                      WHERE name='{column}'"
                ))
                .await,
                1,
                "`inventory_movements.{column}` must exist on both paths"
            );
        }
        assert_eq!(
            db.count(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'next_credit_memo_number'"
            )
            .await,
            1,
            "the credit-memo sequence must exist on both paths"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_011_does_not_disturb_the_earlier_guards() {
    // 011 adds triggers of its own and lifts none — unlike 008, which had to
    // drop and recreate three to backfill. Every guard migrations 001 through
    // 010 put in place must still be in force, and must still bite.
    let db = pre_wp06_database().await;
    db.exec(&format!(
        "INSERT INTO suppliers (id, store_id, name) VALUES ('sup-v10', '{STORE_ID}', 'Wholesale')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, supplier_reference,
           purchase_number, purchase_date, subtotal_excl_vat_cents, vat_total_cents,
           total_incl_vat_cents, status, posted_at
         ) VALUES ('pur-v10', '{STORE_ID}', 'sup-v10', 'normal', 'INV-7', 1, '2026-02-01',
                   1000, 0, 1000, 'posted', '2026-02-01T10:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO supplier_ledger (
           id, store_id, supplier_id, entry_type, amount_cents, entry_date,
           related_purchase_id, posted_at
         ) VALUES ('led-v10', '{STORE_ID}', 'sup-v10', 'purchase', 1000, '2026-02-01',
                   'pur-v10', '2026-02-01T10:00:00.000Z')"
    ))
    .await;

    db.migrate_again().await.expect("migration 011 must apply");

    for trigger in [
        // 001
        "trg_sales_no_update_after_post",
        "trg_sales_no_delete_after_post",
        "trg_sale_items_no_update_after_post",
        "trg_sale_payments_no_update_after_post",
        "trg_inv_mov_no_update",
        "trg_inv_mov_no_delete",
        // 005 / 006
        "trg_purchases_no_update_after_post",
        "trg_purchase_items_no_update_after_post",
        "trg_supplier_ledger_no_update",
        "trg_supplier_ledger_no_delete",
        // 009
        "trg_shifts_no_update_after_close",
        // 010
        "trg_purchases_no_duplicate_supplier_invoice_ins",
        "trg_purchases_no_duplicate_supplier_invoice_upd",
        "trg_supplier_ledger_sign_discipline",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
            ))
            .await,
            1,
            "`{trigger}` must be present after migration 011"
        );
    }
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
              AND name='ux_shifts_one_open_per_store'"
        )
        .await,
        1,
        "migration 009's partial unique index must survive"
    );

    // 001: a posted sale and its children stay immutable.
    assert!(
        db.try_exec(&format!(
            "UPDATE sales SET total_incl_vat_cents = 1 WHERE id = '{RET_SALE}'"
        ))
        .await
        .is_err(),
        "a posted sale must stay immutable"
    );
    assert!(
        db.try_exec("UPDATE inventory_movements SET quantity_delta = 1 WHERE id = 'mov-v10'")
            .await
            .is_err(),
        "the movement ledger must stay append-only"
    );
    // 008: the backfilled cost columns and the triggers it restored still work.
    assert!(
        db.try_exec(&format!(
            "UPDATE sale_items SET unit_cogs_excl_vat_microcents = 1 WHERE id = '{RET_SALE_ITEM}'"
        ))
        .await
        .is_err(),
        "a posted sale's cost snapshot must stay immutable"
    );
    // 009: a closed shift is final.
    db.exec("UPDATE shifts SET status = 'closed', closed_at = '2026-03-01T18:00:00.000Z' WHERE id = 'shift-v10'")
        .await;
    assert!(
        db.try_exec("UPDATE shifts SET closing_cash_usd_cents = 1 WHERE id = 'shift-v10'")
            .await
            .is_err(),
        "a closed shift must stay immutable"
    );
    // 010: the duplicate-invoice rule and the ledger sign rule still bind.
    assert!(
        db.try_exec(&format!(
            "INSERT INTO purchases (
               id, store_id, supplier_id, purchase_type, supplier_reference,
               purchase_number, purchase_date, status, posted_at
             ) VALUES ('pur-dup', '{STORE_ID}', 'sup-v10', 'normal', ' inv-7 ',
                       2, '2026-04-01', 'posted', '2026-04-01T10:00:00.000Z')"
        ))
        .await
        .is_err(),
        "one supplier invoice may still be posted only once"
    );
    assert!(
        db.try_exec(&format!(
            "INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount_cents, entry_date)
             VALUES ('led-bad', '{STORE_ID}', 'sup-v10', 'payment', 500, '2026-04-01')"
        ))
        .await
        .is_err(),
        "a payment must still be negative"
    );
    assert!(
        db.try_exec("UPDATE supplier_ledger SET amount_cents = 1 WHERE id = 'led-v10'")
            .await
            .is_err(),
        "a supplier-ledger entry must stay immutable"
    );
}

// ============================================================================
// Migration 012 — database & inventory hardening (WP-07)
// ============================================================================
//
// 012 adds one trigger and REPLACES three, which is the part worth testing:
// `CREATE TRIGGER IF NOT EXISTS` would silently keep the weak one-sided
// versions migrations 001/005/008 left behind, so 012 drops them first. A
// convergence test is the only thing that proves the drop-and-recreate ran on
// both paths into version 12.

/// A v11 database holding a posted sale with a line and a tender, a posted
/// purchase with a line and its supplier liability, and a closed shift — one of
/// each thing 012 constrains, as an earlier release left them.
async fn pre_wp07_database() -> TempDb {
    let db = TempDb::at_schema_version(11).await;
    db.exec(&format!(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('{RATE_ID}', '{STORE_ID}', '2026-01-01', 89500, 'manual')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO products (
           id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand
         ) VALUES ('wp07-prod', '{STORE_ID}', 'SKU-W7', 'Burger', '{VAT_STD_ID}',
                   'inclusive', 450, 500, 50)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO shifts (
           id, store_id, opened_by_user_id, opened_at, closed_at, closed_by_user_id,
           opening_cash_usd_cents, opening_cash_lbp,
           closing_cash_usd_cents, expected_cash_usd_cents, variance_usd_cents, status
         ) VALUES ('wp07-shift', '{STORE_ID}', '{USER_ID}', '2026-03-01T08:00:00.000Z',
                   '2026-03-01T16:00:00.000Z', '{USER_ID}', 0, 0, 900, 1000, -100, 'closed')"
    ))
    .await;
    // A posted sale, written the way a pre-WP-07 release wrote one: header
    // posted outright, children after. That is precisely the shortcut 012
    // closes, so the fixture has to take it BEFORE 012 applies.
    db.exec(&format!(
        "INSERT INTO sales (
           id, store_id, shift_id, cashier_user_id, receipt_number,
           exchange_rate_lbp_per_usd, exchange_rate_id,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           discount_cents, cogs_total_cents, cogs_method, sale_type, status, posted_at
         ) VALUES ('wp07-sale', '{STORE_ID}', 'wp07-shift', '{USER_ID}', 1,
                   89500, '{RATE_ID}', 450, 50, 500, 0, 0, 'weighted_average',
                   'normal', 'posted', '2026-03-01T10:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_items (
           id, sale_id, store_id, product_id, product_name_snapshot,
           vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
           unit_price_excl_vat_cents, unit_price_incl_vat_cents,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
         ) VALUES ('wp07-item', 'wp07-sale', '{STORE_ID}', 'wp07-prod', 'Burger',
                   '{VAT_STD_ID}', 1100, 1, 450, 500, 450, 50, 500)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_payments (
           id, sale_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
         ) VALUES ('wp07-pay', 'wp07-sale', '{STORE_ID}', 'cash_usd', 'USD', 500, 0, 500)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO suppliers (id, store_id, name)
         VALUES ('wp07-sup', '{STORE_ID}', 'Wholesale')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, purchase_number, purchase_date,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents, status, posted_at
         ) VALUES ('wp07-pur', '{STORE_ID}', 'wp07-sup', 'normal', 1, '2026-02-01',
                   1000, 110, 1110, 'posted', '2026-02-01T10:00:00.000Z')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO purchase_items (
           id, purchase_id, store_id, product_id, product_name_snapshot,
           uom_code_snapshot, factor_num_snapshot, factor_den_snapshot,
           quantity_in_uom, quantity_base,
           unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
           unit_cost_excl_vat_base_cents, unit_cost_incl_vat_base_cents,
           unit_cost_excl_vat_base_microcents, unit_cost_incl_vat_base_microcents,
           vat_rate_id_snapshot, vat_rate_bps_snapshot,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
         ) VALUES ('wp07-pitem', 'wp07-pur', '{STORE_ID}', 'wp07-prod', 'Burger',
                   'each', 1, 1, 5, 5, 200, 222, 200, 222, 200000000, 222000000,
                   '{VAT_STD_ID}', 1100, 1000, 110, 1110)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO supplier_ledger (
           id, store_id, supplier_id, entry_type, amount_cents, entry_date,
           related_purchase_id, posted_at
         ) VALUES ('wp07-led', '{STORE_ID}', 'wp07-sup', 'purchase', 1110, '2026-02-01',
                   'wp07-pur', '2026-02-01T10:00:00.000Z')"
    ))
    .await;
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_012_applies_to_a_populated_v11_database() {
    let db = pre_wp07_database().await;
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 11);

    db.migrate_again()
        .await
        .expect("migration 012 must apply to a populated v11 database");

    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        latest_migration_version()
    );

    // Every document survives untouched — 012 backfills nothing and rewrites
    // nothing; it constrains writes from here on.
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 1);
    assert_eq!(db.scalar_i64("SELECT amount_cents FROM supplier_ledger").await, 1_110);
    assert_eq!(
        db.scalar_i64("SELECT variance_usd_cents FROM shifts WHERE id = 'wp07-shift'").await,
        -100,
        "the closed shift's reconciliation is exactly as it was counted"
    );

    // And the rules now bind. Every one of these was possible on v11.
    assert!(
        db.try_exec("DELETE FROM shifts WHERE id = 'wp07-shift'").await.is_err(),
        "a closed shift can no longer be deleted"
    );
    assert!(
        db.try_exec(&format!(
            "INSERT INTO sale_items (
               id, sale_id, store_id, product_id, product_name_snapshot,
               vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
               unit_price_excl_vat_cents, unit_price_incl_vat_cents,
               line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
             ) VALUES ('late-item', 'wp07-sale', '{STORE_ID}', 'wp07-prod', 'Burger',
                       '{VAT_STD_ID}', 1100, 1, 450, 500, 450, 50, 500)"
        ))
        .await
        .is_err(),
        "a posted sale can no longer gain a line"
    );
    assert!(
        db.try_exec(&format!(
            "INSERT INTO sale_payments (
               id, sale_id, store_id, method, currency,
               amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
             ) VALUES ('late-pay', 'wp07-sale', '{STORE_ID}', 'cash_usd', 'USD', 1, 0, 1)"
        ))
        .await
        .is_err(),
        "nor a payment"
    );
    assert!(
        db.try_exec(&format!(
            "INSERT INTO purchase_items (
               id, purchase_id, store_id, product_id, product_name_snapshot,
               uom_code_snapshot, factor_num_snapshot, factor_den_snapshot,
               quantity_in_uom, quantity_base,
               unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
               unit_cost_excl_vat_base_cents, unit_cost_incl_vat_base_cents,
               unit_cost_excl_vat_base_microcents, unit_cost_incl_vat_base_microcents,
               vat_rate_id_snapshot, vat_rate_bps_snapshot,
               line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
             ) VALUES ('late-pitem', 'wp07-pur', '{STORE_ID}', 'wp07-prod', 'Burger',
                       'each', 1, 1, 1, 1, 200, 222, 200, 222, 200000000, 222000000,
                       '{VAT_STD_ID}', 1100, 200, 22, 222)"
        ))
        .await
        .is_err(),
        "and a posted purchase can no longer gain a line"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_012_is_idempotent_through_the_real_runner() {
    let db = pre_wp07_database().await;
    db.migrate_again().await.expect("first run");
    let before = db.count("SELECT COUNT(*) FROM _sqlx_migrations").await;

    db.migrate_again().await.expect("second run must succeed");
    db.migrate_again().await.expect("third run must succeed");

    assert_eq!(db.count("SELECT COUNT(*) FROM _sqlx_migrations").await, before);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_v11_upgrade_converges_on_the_same_schema_as_a_fresh_install() {
    let fresh = TempDb::new().await;
    let upgraded = pre_wp07_database().await;
    upgraded.migrate_again().await.expect("migration 012 must apply");

    let schema_sql = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                      (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(
        fresh.scalar_string(schema_sql).await,
        upgraded.scalar_string(schema_sql).await,
        "a fresh database and an upgraded one must carry identical schema"
    );

    for db in [&fresh, &upgraded] {
        for trigger in [
            "trg_shifts_no_delete_after_close",
            "trg_sale_items_no_insert_after_post",
            "trg_sale_payments_no_insert_after_post",
            "trg_purchase_items_no_insert_after_post",
        ] {
            assert_eq!(
                db.count(&format!(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
                ))
                .await,
                1,
                "`{trigger}` must exist on both paths"
            );
        }
        // THE replacement check: the three guards 012 drops and recreates must
        // carry the SYMMETRIC form on both paths. `CREATE TRIGGER IF NOT EXISTS`
        // would have silently kept migration 001/005/008's one-sided version on
        // the upgrade path, and only this assertion would notice.
        for trigger in [
            "trg_sale_items_no_update_after_post",
            "trg_sale_payments_no_update_after_post",
            "trg_purchase_items_no_update_after_post",
        ] {
            let sql = db
                .scalar_string(&format!(
                    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
                ))
                .await;
            assert!(
                sql.contains("NEW."),
                "`{trigger}` must judge the NEW parent too, not just the old one: {sql}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_012_does_not_disturb_the_earlier_guards() {
    let db = pre_wp07_database().await;
    db.migrate_again().await.expect("migration 012 must apply");

    for trigger in [
        // 001
        "trg_sales_no_update_after_post",
        "trg_sales_no_delete_after_post",
        "trg_sale_items_no_delete_after_post",
        "trg_sale_payments_no_delete_after_post",
        "trg_inv_mov_no_update",
        "trg_inv_mov_no_delete",
        // 005 / 006
        "trg_purchases_no_update_after_post",
        "trg_purchase_items_no_delete_after_post",
        "trg_supplier_ledger_no_update",
        "trg_supplier_ledger_no_delete",
        // 009
        "trg_shifts_no_update_after_close",
        // 010
        "trg_purchases_no_duplicate_supplier_invoice_ins",
        "trg_supplier_ledger_sign_discipline",
        // 011
        "trg_credit_memos_no_update_after_post",
        "trg_credit_memo_lines_no_insert_after_post",
        "trg_credit_memo_lines_no_over_return",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='{trigger}'"
            ))
            .await,
            1,
            "`{trigger}` must be present after migration 012"
        );
    }

    // And they still bite.
    assert!(
        db.try_exec("UPDATE sales SET total_incl_vat_cents = 1 WHERE id = 'wp07-sale'")
            .await
            .is_err(),
        "a posted sale must stay immutable"
    );
    assert!(
        db.try_exec("UPDATE shifts SET closing_cash_usd_cents = 1 WHERE id = 'wp07-shift'")
            .await
            .is_err(),
        "a closed shift must stay immutable"
    );
    assert!(
        db.try_exec("DELETE FROM supplier_ledger WHERE id = 'wp07-led'").await.is_err(),
        "the supplier ledger must stay undeletable"
    );
    assert!(
        db.try_exec(&format!(
            "INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount_cents, entry_date)
             VALUES ('bad', '{STORE_ID}', 'wp07-sup', 'payment', 500, '2026-04-01')"
        ))
        .await
        .is_err(),
        "a payment must still be negative"
    );
}

// ============================================================================
// Migration 013 — menu presentation (WP-3)
// ============================================================================
//
// Two nullable TEXT columns on `products`, plus one index. The whole point of
// the migration is that it changes nothing about an existing catalogue, so
// these tests are mostly about what did NOT happen.

/// A database as a pre-WP-3 release left it, carrying one real product.
async fn pre_wp3_database() -> TempDb {
    let db = TempDb::at_schema_version(12).await;
    db.exec(&format!(
        "INSERT INTO products (
           id, store_id, sku, name, description, vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand, is_service
         ) VALUES ('wp3-burger', '{STORE_ID}', 'SKU-B1', 'Double Burger',
                   '2 patties', '{VAT_STD_ID}', 'inclusive', 540, 600, 25, 0)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO products (
           id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand, is_service
         ) VALUES ('wp3-service', '{STORE_ID}', 'SKU-S1', 'Delivery',
                   '{VAT_STD_ID}', 'inclusive', 180, 200, 0, 1)"
    ))
    .await;
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_013_adds_the_columns_as_null_and_changes_no_product() {
    let db = pre_wp3_database().await;

    // Before: the columns do not exist at all.
    assert_eq!(db.count("SELECT COUNT(*) FROM pragma_table_info('products') WHERE name='category'").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM pragma_table_info('products') WHERE name='icon'").await, 0);

    db.migrate_again().await.expect("migration 013 must apply to a v12 database");

    // After: present, and NULL for every row that already existed. A shop
    // mid-service is not asked to categorise its catalogue before it can sell.
    assert_eq!(db.count("SELECT COUNT(*) FROM pragma_table_info('products') WHERE name='category'").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM pragma_table_info('products') WHERE name='icon'").await, 1);
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM products
              WHERE id IN ('wp3-burger', 'wp3-service') AND category IS NULL AND icon IS NULL"
        )
        .await,
        2,
        "every pre-existing product is uncategorised, not defaulted"
    );
    // And the demo catalogue migration 003 seeds is in the same position: no
    // row anywhere is given a default section.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE category IS NOT NULL OR icon IS NOT NULL")
            .await,
        0,
        "migration 013 writes no data at all"
    );

    // And nothing else about those products moved.
    assert_eq!(
        db.scalar_string("SELECT name FROM products WHERE id='wp3-burger'").await,
        "Double Burger"
    );
    assert_eq!(
        db.scalar_i64("SELECT price_incl_vat_cents FROM products WHERE id='wp3-burger'").await,
        600
    );
    assert_eq!(
        db.scalar_i64("SELECT quantity_on_hand FROM products WHERE id='wp3-burger'").await,
        25
    );
    assert_eq!(
        db.scalar_string("SELECT description FROM products WHERE id='wp3-burger'").await,
        "2 patties"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_product_with_no_category_stays_perfectly_usable() {
    // The compatibility promise, in the terms the register actually loads a
    // product on: active, priced, stocked, and selectable by store.
    let db = pre_wp3_database().await;
    db.migrate_again().await.expect("migrate");

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM products
              WHERE id IN ('wp3-burger', 'wp3-service') AND store_id = '{STORE_ID}' AND is_active = 1"
        ))
        .await,
        2,
        "both uncategorised products are still active and loadable"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM products
              WHERE id IN ('wp3-burger', 'wp3-service') AND store_id = '{STORE_ID}'
                AND category IS NULL AND price_incl_vat_cents > 0"
        ))
        .await,
        2,
        "and still priced"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_013_is_idempotent_through_the_real_runner() {
    let db = pre_wp3_database().await;
    db.migrate_again().await.expect("first run");
    let before = db.count("SELECT COUNT(*) FROM _sqlx_migrations").await;

    db.migrate_again().await.expect("second run must succeed");
    db.migrate_again().await.expect("third run must succeed");

    assert_eq!(db.count("SELECT COUNT(*) FROM _sqlx_migrations").await, before);
    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM products WHERE id IN ('wp3-burger', 'wp3-service')")).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_v12_upgrade_converges_on_the_same_schema_as_a_fresh_install() {
    // An upgraded database and a brand-new one must be indistinguishable, or a
    // bug only reproduces on one of them.
    let fresh = TempDb::new().await;
    let upgraded = pre_wp3_database().await;
    upgraded.migrate_again().await.expect("migration 013 must apply");

    let schema_sql = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                      (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    assert_eq!(
        fresh.scalar_string(schema_sql).await,
        upgraded.scalar_string(schema_sql).await,
        "a v12 upgrade and a fresh install must have identical schemas"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn category_and_icon_are_free_text_and_nullable_by_design() {
    // No CHECK constraint: a restaurant's sections change far more often than
    // its schema should, and a CHECK would make adding "Breakfast" a migration.
    // Normalisation is the write boundary's job
    // (`lib/menuCategories.ts::normalizeCategoryId`), because a CHECK can only
    // reject a value, never fold two spellings into one.
    let db = pre_wp3_database().await;
    db.migrate_again().await.expect("migrate");

    db.exec("UPDATE products SET category = 'burgers', icon = 'B' WHERE id = 'wp3-burger'").await;
    assert_eq!(
        db.scalar_string("SELECT category FROM products WHERE id='wp3-burger'").await,
        "burgers"
    );

    // A section the application does not know is STORED, not rejected — and the
    // UI buckets it under "Other" rather than hiding the product.
    db.exec("UPDATE products SET category = 'breakfast' WHERE id = 'wp3-service'").await;
    assert_eq!(
        db.scalar_string("SELECT category FROM products WHERE id='wp3-service'").await,
        "breakfast"
    );

    // And both can go back to NULL.
    db.exec(&format!("UPDATE products SET category = NULL, icon = NULL WHERE id IN ('wp3-burger', 'wp3-service')")).await;
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM products
              WHERE id IN ('wp3-burger', 'wp3-service') AND category IS NULL AND icon IS NULL"
        ))
        .await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn neither_new_column_is_financial() {
    // Stated as a schema assertion so it cannot drift: a product's menu section
    // is not part of what was sold. `sale_items` snapshots the name and the
    // price at post time, and that is the whole record of the item.
    let db = TempDb::new().await;

    for column in ["category", "icon"] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('sale_items') WHERE name='{column}'"
            ))
            .await,
            0,
            "{column} must not be snapshotted onto a sale line"
        );
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('inventory_movements') WHERE name='{column}'"
            ))
            .await,
            0,
            "{column} must not reach an inventory movement"
        );
    }
}

// ============================================================================
// 014 -> 015 -> 016, ON A POPULATED DATABASE (WP-7 §6)
//
// Migration 015 does something no other migration in this project does: it
// REBUILDS two tables. SQLite cannot alter a CHECK constraint, so adding the
// `driver_collection` tender meant the documented create-copy-drop-rename on
// `sale_payments` and `sales_credit_memo_refunds`.
//
// A rebuild is the single most dangerous shape a migration can take on a
// financial table. It can silently lose rows, re-type a column, drop an index,
// leave an immutability trigger off, or re-derive a value that was supposed to
// be historical. None of that shows up on an empty database, which is exactly
// why these tests populate one first: a real shop's books, upgraded, and then
// compared row for row against what they were.
//
// `at_schema_version(14)` builds the database as the previous release left it
// and `migrate_again()` runs the rest through the real sqlx runner — the same
// code path a user's upgrade takes, not a hand-applied script.
// ============================================================================

/// A v14 shop with real books: a posted cash sale, a posted card sale, a
/// posted credit memo with a refund leg, a purchase, and a supplier ledger
/// entry. Everything a rebuild could damage.
async fn populated_v14() -> TempDb {
    populated_at_schema_version(14).await
}

/// The same books, built on a database left at `version`.
///
/// GZ-P1-3 and GZ-P1-4 ship as migration 017, and the databases that will
/// receive it are at v14 (the previous release), v15 and v16 (the disposable
/// qualification identities). Every one of those upgrades is exercised, because
/// "it works from v14" says nothing about a database that already carries the
/// trigger 017 replaces.
async fn populated_at_schema_version(version: i64) -> TempDb {
    let db = TempDb::at_schema_version(version).await;

    sqlx::query(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('rate-v14', ?, '2026-03-01', 89500, 'manual')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await
    .expect("seed rate");

    sqlx::query(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents, status)
         VALUES ('shift-v14', ?, ?, 5000, 'open')",
    )
    .bind(STORE_ID)
    .bind(USER_ID)
    .execute(db.pool())
    .await
    .expect("seed shift");

    sqlx::query(
        "INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                               price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand)
         VALUES ('prod-v14', ?, 'SKU-V14', 'Legacy Burger', ?, 'inclusive', 901, 1000, 100)",
    )
    .bind(STORE_ID)
    .bind(VAT_STD_ID)
    .execute(db.pool())
    .await
    .expect("seed product");

    // Two posted sales, built draft-then-promoted the way the commands do.
    for (sale_id, receipt, method, native, change) in [
        ("sale-v14-cash", 1_i64, "cash_usd", 1_000_i64, 150_i64),
        ("sale-v14-card", 2, "card_usd", 1_000, 0),
    ] {
        sqlx::query(
            "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
                                exchange_rate_id, exchange_rate_lbp_per_usd,
                                subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                                cogs_total_cents, cogs_method, sale_type, status, channel)
             VALUES (?, ?, 'shift-v14', ?, ?, 'rate-v14', 89500, 901, 99, 1000, 300,
                     'weighted_average', 'normal', 'draft', 'counter')",
        )
        .bind(sale_id)
        .bind(STORE_ID)
        .bind(USER_ID)
        .bind(receipt)
        .execute(db.pool())
        .await
        .expect("seed sale");

        sqlx::query(
            "INSERT INTO sale_payments (id, sale_id, store_id, method, currency,
                                        amount_native_usd_cents, amount_usd_cents_equivalent,
                                        change_given_usd_cents, reference, created_at)
             VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, 'legacy-ref', '2026-03-01T10:00:00.000Z')",
        )
        .bind(format!("pay-{sale_id}"))
        .bind(sale_id)
        .bind(STORE_ID)
        .bind(method)
        .bind(native)
        .bind(native)
        .bind(change)
        .execute(db.pool())
        .await
        .expect("seed payment");

        sqlx::query("UPDATE sales SET status = 'posted', posted_at = '2026-03-01T10:00:00.000Z' WHERE id = ?")
            .bind(sale_id)
            .execute(db.pool())
            .await
            .expect("promote sale");
    }

    // A posted credit memo with a refund leg — the other rebuilt table.
    sqlx::query(
        "INSERT INTO sales_credit_memos (id, store_id, original_sale_id, credit_memo_number,
                                         shift_id, cashier_user_id, exchange_rate_id,
                                         exchange_rate_lbp_per_usd, subtotal_excl_vat_cents,
                                         vat_total_cents, total_incl_vat_cents,
                                         refund_total_usd_cents, status)
         VALUES ('memo-v14', ?, 'sale-v14-cash', 1, 'shift-v14', ?, 'rate-v14', 89500,
                 450, 50, 500, 500, 'draft')",
    )
    .bind(STORE_ID)
    .bind(USER_ID)
    .execute(db.pool())
    .await
    .expect("seed memo");

    sqlx::query(
        "INSERT INTO sales_credit_memo_refunds (id, credit_memo_id, store_id, method, currency,
                                                amount_native_usd_cents,
                                                amount_usd_cents_equivalent, reference, created_at)
         VALUES ('refund-v14', 'memo-v14', ?, 'cash_usd', 'USD', 500, 500, 'legacy-refund',
                 '2026-03-01T11:00:00.000Z')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await
    .expect("seed refund leg");

    sqlx::query("UPDATE sales_credit_memos SET status = 'posted', posted_at = '2026-03-01T11:00:00.000Z' WHERE id = 'memo-v14'")
        .execute(db.pool())
        .await
        .expect("promote memo");

    db
}

/// Every column of every row of a table, as one comparable string.
///
/// The digest is assembled in SQL from `PRAGMA table_info`, so it covers every
/// column the table actually has — including ones a later migration adds —
/// without this helper needing to know the schema. Values are cast to TEXT so
/// the comparison is over what is STORED: a rebuild that re-typed a column
/// would change the text of its values and fail here.
async fn snapshot(db: &TempDb, table: &str) -> Vec<String> {
    let cols: Vec<String> = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(db.pool())
        .await
        .unwrap_or_else(|e| panic!("table_info {table}: {e}"))
        .iter()
        .map(|r| r.try_get::<String, _>("name").expect("column name"))
        .collect();
    assert!(!cols.is_empty(), "{table} must exist to be snapshotted");

    let digest = cols
        .iter()
        .map(|c| format!("COALESCE(CAST({c} AS TEXT), '<NULL>')"))
        .collect::<Vec<_>>()
        .join(" || '|' || ");

    sqlx::query_scalar::<_, String>(&format!(
        "SELECT {digest} AS digest FROM {table} ORDER BY id"
    ))
    .fetch_all(db.pool())
    .await
    .unwrap_or_else(|e| panic!("snapshot {table}: {e}"))
}

async fn object_names(db: &TempDb, kind: &str, table: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name",
    )
    .bind(kind)
    .bind(table)
    .fetch_all(db.pool())
    .await
    .expect("read sqlite_master")
}

#[tokio::test]
async fn the_upgrade_preserves_every_financial_row_byte_for_byte() {
    let db = populated_v14().await;

    let payments_before = snapshot(&db, "sale_payments").await;
    let refunds_before = snapshot(&db, "sales_credit_memo_refunds").await;
    let sales_before = snapshot(&db, "sales").await;
    let memos_before = snapshot(&db, "sales_credit_memos").await;
    assert_eq!(payments_before.len(), 2, "two tenders to carry over");
    assert_eq!(refunds_before.len(), 1);

    db.migrate_again().await.expect("015 and 016 must apply to a populated v14 database");

    // `sales` and `sales_credit_memos` gain columns, so only the REBUILT tables
    // can be compared whole. Those are the ones at risk.
    assert_eq!(
        snapshot(&db, "sale_payments").await,
        payments_before,
        "the sale_payments rebuild must not alter a single stored value"
    );
    assert_eq!(
        snapshot(&db, "sales_credit_memo_refunds").await,
        refunds_before,
        "nor the refunds rebuild"
    );

    // And the untouched tables are still their old selves, column for column,
    // apart from the two columns 015 adds with defaults.
    assert_eq!(snapshot(&db, "sales").await.len(), sales_before.len());
    assert_eq!(snapshot(&db, "sales_credit_memos").await.len(), memos_before.len());
    let (driver, fee): (Option<String>, i64) =
        sqlx::query_as("SELECT driver_id, delivery_fee_cents FROM sales WHERE id = 'sale-v14-cash'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(driver, None, "a historical sale names no driver");
    assert_eq!(fee, 0, "and carries no delivery fee");
}

#[tokio::test]
async fn the_upgrade_keeps_the_indexes_and_the_immutability_triggers() {
    let db = populated_v14().await;
    let pay_idx_before = object_names(&db, "index", "sale_payments").await;
    let pay_trg_before = object_names(&db, "trigger", "sale_payments").await;
    let ref_idx_before = object_names(&db, "index", "sales_credit_memo_refunds").await;
    let ref_trg_before = object_names(&db, "trigger", "sales_credit_memo_refunds").await;

    db.migrate_again().await.expect("upgrade");

    assert_eq!(object_names(&db, "index", "sale_payments").await, pay_idx_before);
    assert_eq!(object_names(&db, "trigger", "sale_payments").await, pay_trg_before);
    assert_eq!(
        object_names(&db, "index", "sales_credit_memo_refunds").await,
        ref_idx_before
    );
    assert_eq!(
        object_names(&db, "trigger", "sales_credit_memo_refunds").await,
        ref_trg_before
    );

    // Not just present — ARMED. A rebuild that recreated a trigger with the
    // wrong WHEN clause would pass a name check and fail here.
    let insert = sqlx::query(
        "INSERT INTO sale_payments (id, sale_id, store_id, method, currency,
                                    amount_native_usd_cents, amount_usd_cents_equivalent)
         VALUES ('smuggled', 'sale-v14-cash', ?, 'cash_usd', 'USD', 1, 1)",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(insert.is_err(), "a posted sale must still refuse another tender");

    let update = sqlx::query("UPDATE sale_payments SET reference = 'x' WHERE id = 'pay-sale-v14-cash'")
        .execute(db.pool())
        .await;
    assert!(update.is_err(), "a posted tender must still be immutable");

    let delete = sqlx::query("DELETE FROM sale_payments WHERE id = 'pay-sale-v14-cash'")
        .execute(db.pool())
        .await;
    assert!(delete.is_err(), "and undeletable");

    let memo_insert = sqlx::query(
        "INSERT INTO sales_credit_memo_refunds (id, credit_memo_id, store_id, method, currency,
                                                amount_native_usd_cents,
                                                amount_usd_cents_equivalent)
         VALUES ('smuggled-refund', 'memo-v14', ?, 'cash_usd', 'USD', 1, 1)",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(memo_insert.is_err(), "a posted memo must still refuse another refund leg");
}

#[tokio::test]
async fn the_upgrade_leaves_foreign_keys_and_integrity_intact() {
    let db = populated_v14().await;
    db.migrate_again().await.expect("upgrade");

    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(db.pool())
        .await
        .expect("fk check");
    assert!(violations.is_empty(), "the rebuild must repoint nothing");

    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(db.pool())
        .await
        .expect("integrity check");
    assert_eq!(integrity, "ok");

    // The rebuilt table is still a child of `sales`: a tender for a sale that
    // does not exist must be refused by the foreign key, not accepted.
    let orphan = sqlx::query(
        "INSERT INTO sale_payments (id, sale_id, store_id, method, currency,
                                    amount_native_usd_cents, amount_usd_cents_equivalent)
         VALUES ('orphan', 'no-such-sale', ?, 'cash_usd', 'USD', 1, 1)",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(orphan.is_err(), "the foreign key survived the rebuild");
}

#[tokio::test]
async fn the_upgrade_adds_the_new_tender_without_widening_the_old_list() {
    let db = populated_v14().await;

    // Before: the method is refused outright.
    sqlx::query(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
                            exchange_rate_id, exchange_rate_lbp_per_usd,
                            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                            cogs_total_cents, cogs_method, sale_type, status, channel)
         VALUES ('sale-draft', ?, 'shift-v14', ?, 9, 'rate-v14', 89500, 901, 99, 1000, 0,
                 'weighted_average', 'normal', 'draft', 'counter')",
    )
    .bind(STORE_ID)
    .bind(USER_ID)
    .execute(db.pool())
    .await
    .expect("seed draft");

    let before = sqlx::query(
        "INSERT INTO sale_payments (id, sale_id, store_id, method, currency,
                                    amount_native_usd_cents, amount_usd_cents_equivalent)
         VALUES ('dc-before', 'sale-draft', ?, 'driver_collection', 'USD', 1000, 1000)",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(before.is_err(), "v14 knows no driver collection");

    db.migrate_again().await.expect("upgrade");

    // After: accepted.
    sqlx::query(
        "INSERT INTO sale_payments (id, sale_id, store_id, method, currency,
                                    amount_native_usd_cents, amount_usd_cents_equivalent)
         VALUES ('dc-after', 'sale-draft', ?, 'driver_collection', 'USD', 1000, 1000)",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await
    .expect("driver collection is a tender now");

    // And nothing else crept in: the CHECK is still a closed list.
    let nonsense = sqlx::query(
        "INSERT INTO sale_payments (id, sale_id, store_id, method, currency,
                                    amount_native_usd_cents, amount_usd_cents_equivalent)
         VALUES ('nonsense', 'sale-draft', ?, 'crypto', 'USD', 1, 1)",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(nonsense.is_err(), "the rebuild must not have widened the list");
}

#[tokio::test]
async fn a_failed_upgrade_rolls_back_and_leaves_v14_usable() {
    // A rebuild that failed halfway would be the worst outcome of all: the old
    // table dropped and the new one incomplete. sqlx runs each migration in a
    // transaction, and this proves it for THIS migration by making it fail —
    // a pre-existing row that violates a constraint 015 introduces.
    //
    // `drivers` has a UNIQUE index on (store_id, name_key), so a pre-seeded
    // duplicate cannot be the trigger; instead the failure is forced on the
    // table 015 creates, by taking its name first.
    let db = populated_v14().await;
    sqlx::query("CREATE TABLE drivers (id TEXT PRIMARY KEY, bogus TEXT NOT NULL)")
        .execute(db.pool())
        .await
        .expect("squat on the name 015 wants");

    let outcome = db.migrate_again().await;
    assert!(outcome.is_err(), "015 cannot create a table that already exists differently");

    // The v14 books are untouched and still readable.
    let payments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sale_payments")
        .fetch_one(db.pool())
        .await
        .expect("sale_payments still exists");
    assert_eq!(payments, 2, "no rows were lost to the failed upgrade");

    let refunds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_credit_memo_refunds")
        .fetch_one(db.pool())
        .await
        .expect("refunds still exist");
    assert_eq!(refunds, 1);

    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(db.pool())
        .await
        .expect("integrity");
    assert_eq!(integrity, "ok");

    // And no half-built rebuild table was left behind.
    let leftovers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE name IN ('sale_payments_v15', 'sales_credit_memo_refunds_v15')",
    )
    .fetch_one(db.pool())
    .await
    .expect("scan for leftovers");
    assert_eq!(leftovers, 0, "a rolled-back rebuild leaves no scaffolding");
}

#[tokio::test]
async fn the_driver_ledger_constraints_are_correct_after_the_upgrade() {
    let db = populated_v14().await;
    db.migrate_again().await.expect("upgrade");

    seed_driver(&db, "drv-a", "Ali").await;

    // A collection must name a sale and be positive.
    for (what, sql) in [
        (
            "a collection with no sale",
            "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents, entry_date)
             VALUES ('bad-1', ?, 'drv-a', 'collection', 100, '2026-03-02')",
        ),
        (
            "a negative collection",
            "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                        entry_date, related_sale_id)
             VALUES ('bad-2', ?, 'drv-a', 'collection', -100, '2026-03-02', 'sale-v14-cash')",
        ),
        (
            "a positive remittance",
            "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                        entry_date, received_currency, received_native_usd_cents,
                                        shift_id)
             VALUES ('bad-3', ?, 'drv-a', 'remittance', 100, '2026-03-02', 'USD', 100, 'shift-v14')",
        ),
        (
            "a remittance with no shift",
            "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                        entry_date, received_currency, received_native_usd_cents)
             VALUES ('bad-4', ?, 'drv-a', 'remittance', -100, '2026-03-02', 'USD', 100)",
        ),
        (
            "an adjustment with no reason",
            "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                        entry_date)
             VALUES ('bad-5', ?, 'drv-a', 'adjustment', 100, '2026-03-02')",
        ),
        (
            "a lira remittance with no rate",
            "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                        entry_date, received_currency, received_native_lbp,
                                        shift_id)
             VALUES ('bad-6', ?, 'drv-a', 'remittance', -100, '2026-03-02', 'LBP', 89500,
                     'shift-v14')",
        ),
    ] {
        let outcome = sqlx::query(sql).bind(STORE_ID).execute(db.pool()).await;
        assert!(outcome.is_err(), "{what} must be refused");
    }

    // A collection against a sale that does NOT name this driver is refused:
    // the historical v14 sales have no driver at all.
    let unrelated = sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                    entry_date, related_sale_id)
         VALUES ('bad-7', ?, 'drv-a', 'collection', 1000, '2026-03-02', 'sale-v14-cash')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(
        unrelated.is_err(),
        "a collection must name the driver the sale itself records"
    );

    // And the honest row posts, against a delivery sale that does name him.
    sqlx::query(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
                            exchange_rate_id, exchange_rate_lbp_per_usd,
                            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                            cogs_total_cents, cogs_method, sale_type, status, channel,
                            driver_id, delivery_fee_cents)
         VALUES ('sale-delivery', ?, 'shift-v14', ?, 7, 'rate-v14', 89500, 901, 99, 1000, 300,
                 'weighted_average', 'normal', 'draft', 'online_delivery', 'drv-a', 200)",
    )
    .bind(STORE_ID)
    .bind(USER_ID)
    .execute(db.pool())
    .await
    .expect("seed a delivery sale");

    sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                    entry_date, related_sale_id)
         VALUES ('good-1', ?, 'drv-a', 'collection', 1000, '2026-03-02', 'sale-delivery')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await
    .expect("a collection against this driver's own sale posts");

    // Append-only.
    assert!(
        sqlx::query("UPDATE driver_ledger SET amount_cents = 1 WHERE id = 'good-1'")
            .execute(db.pool())
            .await
            .is_err(),
        "driver ledger entries are immutable"
    );
    assert!(
        sqlx::query("DELETE FROM driver_ledger WHERE id = 'good-1'")
            .execute(db.pool())
            .await
            .is_err(),
        "and undeletable"
    );
}

#[tokio::test]
async fn a_return_credit_cannot_reference_an_unrelated_driver_store_or_sale() {
    // The specific hole §6 names. A ledger entry is only meaningful if it is
    // filed against the right party, in the right store, for the right document.
    let db = populated_v14().await;
    db.migrate_again().await.expect("upgrade");

    seed_driver(&db, "drv-a", "Ali").await;
    seed_store(&db, "store-b", "Other branch").await;
    seed_driver_in_store(&db, "drv-b", "Outsider", "store-b", true).await;

    // A posted sale cannot be re-pointed at a driver after the fact. Worth
    // asserting here as well as in the WP-6 suite: re-attributing a posted
    // receipt is how a receivable would move between two people's balances.
    let repoint = sqlx::query(
        "UPDATE sales SET channel = 'online_delivery', driver_id = 'drv-a'
          WHERE id = 'sale-v14-card'",
    )
    .execute(db.pool())
    .await;
    assert!(repoint.is_err(), "a posted sale's driver is immutable");

    let wrong_driver = sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                    entry_date, related_sale_id)
         VALUES ('bad-driver', ?, 'drv-a', 'collection', 100, '2026-03-02', 'sale-v14-cash')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(
        wrong_driver.is_err(),
        "a collection must name the driver the SALE records"
    );

    // An entry filed in a store that is not the driver's.
    let wrong_store = sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                    entry_date, notes)
         VALUES ('bad-store', 'store-b', 'drv-a', 'adjustment', 100, '2026-03-02', 'why')",
    )
    .execute(db.pool())
    .await;
    assert!(wrong_store.is_err(), "the entry's store must be the driver's store");

    // A return credit against a memo, driving the balance negative, is refused
    // automatically (migration 016) — the §5 rule, in the engine.
    let negative = sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents,
                                    entry_date, related_credit_memo_id)
         VALUES ('bad-neg', ?, 'drv-a', 'return_credit', -100, '2026-03-02', 'memo-v14')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(negative.is_err(), "no automatic negative receivable");

    // And a return credit with no memo at all is not an entry anyone can trace.
    let untraceable = sqlx::query(
        "INSERT INTO driver_ledger (id, store_id, driver_id, entry_type, amount_cents, entry_date)
         VALUES ('bad-trace', ?, 'drv-a', 'return_credit', -1, '2026-03-02')",
    )
    .bind(STORE_ID)
    .execute(db.pool())
    .await;
    assert!(untraceable.is_err(), "a return credit must name its memo");
}

#[tokio::test]
async fn the_upgrade_is_idempotent() {
    // Running the migrator twice is what a restart does. Nothing may be
    // rebuilt a second time, and no row may move.
    let db = populated_v14().await;
    db.migrate_again().await.expect("first upgrade");
    let payments = snapshot(&db, "sale_payments").await;
    let refunds = snapshot(&db, "sales_credit_memo_refunds").await;

    db.migrate_again().await.expect("second run is a no-op");

    assert_eq!(snapshot(&db, "sale_payments").await, payments);
    assert_eq!(snapshot(&db, "sales_credit_memo_refunds").await, refunds);
    let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(db.pool())
        .await
        .expect("read version");
    // Pinned against the migrator itself rather than a literal, so adding a
    // migration does not require editing an assertion about a rebuild.
    assert_eq!(version, latest_migration_version());
}

// ============================================================================
// 017, ON POPULATED v15 AND v16 DATABASES (GZ-P1-3, GZ-P1-4)
// ============================================================================
//
// 017 replaces a guard that v16 databases already carry and adds one v15 never
// had. Two properties have to hold on every one of those upgrades, and they
// pull in opposite directions:
//
//   * the NEW rules bind from the moment the migration lands, for every writer;
//   * the rows already there are history and do not move — including the rows
//     that would be refused today, because they were legitimate when they were
//     written and `driver_ledger` is append-only.
//
// Each test below writes exactly such a row FIRST, under the rules of the day,
// upgrades, and then checks both halves.

/// A remittance insert, as a writer of the day would make it.
async fn insert_remittance(
    db: &TempDb,
    id: &str,
    driver: &str,
    cents: i64,
    shift: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           received_currency, received_native_usd_cents, shift_id
         ) VALUES (?, ?, ?, 'remittance', ?, '2026-03-02', 'USD', ?, ?)",
    )
    .bind(id)
    .bind(STORE_ID)
    .bind(driver)
    .bind(-cents)
    .bind(cents)
    .bind(shift)
    .execute(db.pool())
    .await
    .map(|_| ())
}

/// A return credit pointed at `memo`, as a writer of the day would make it.
async fn insert_return_credit(
    db: &TempDb,
    id: &str,
    driver: &str,
    cents: i64,
    memo: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date,
           related_credit_memo_id
         ) VALUES (?, ?, ?, 'return_credit', ?, '2026-03-02', ?)",
    )
    .bind(id)
    .bind(STORE_ID)
    .bind(driver)
    .bind(-cents)
    .bind(memo)
    .execute(db.pool())
    .await
    .map(|_| ())
}

/// Give a driver something to owe, the one way a caller may choose the sign.
async fn seed_driver_balance(db: &TempDb, id: &str, driver: &str, cents: i64) {
    sqlx::query(
        "INSERT INTO driver_ledger (
           id, store_id, driver_id, entry_type, amount_cents, entry_date, notes
         ) VALUES (?, ?, ?, 'adjustment', ?, '2026-03-01', 'opening position, signed off')",
    )
    .bind(id)
    .bind(STORE_ID)
    .bind(driver)
    .bind(cents)
    .execute(db.pool())
    .await
    .expect("seed a driver balance");
}

#[tokio::test]
async fn migration_017_upgrades_a_populated_v15_database_and_keeps_its_history() {
    // v15 had NO shift rule for a remittance and no source rule for a return
    // credit. Both of the rows below were legal the day they were written.
    let db = populated_at_schema_version(15).await;
    seed_driver(&db, "drv-a", "Ali").await;
    seed_driver_balance(&db, "adj-open", "drv-a", 10_000).await;

    insert_remittance(&db, "remit-v15", "drv-a", 1_000, None)
        .await
        .expect("a shift-less remittance was legal at v15");
    insert_return_credit(&db, "credit-v15", "drv-a", 500, "memo-v14")
        .await
        .expect("an unchecked return credit was legal at v15");

    let before = snapshot(&db, "driver_ledger").await;
    db.migrate_again().await.expect("016 and 017 must apply to a populated v15 database");

    // History stands, byte for byte, including the two rows the new rules
    // would refuse today.
    assert_eq!(snapshot(&db, "driver_ledger").await, before);
    assert_eq!(driver_balance(&db, "drv-a").await, 10_000 - 1_000 - 500);

    // And the rules bind from here on.
    assert!(
        insert_remittance(&db, "remit-new", "drv-a", 100, None).await.is_err(),
        "a new remittance must name a shift"
    );
    assert!(
        insert_return_credit(&db, "credit-new", "drv-a", 100, "memo-v14").await.is_err(),
        "a new return credit must come from this driver's own return"
    );
    // The legitimate hand-over still posts, into the open shift the books have.
    insert_remittance(&db, "remit-ok", "drv-a", 100, Some("shift-v14"))
        .await
        .expect("a remittance into the open shift posts");
}

#[tokio::test]
async fn migration_017_replaces_the_weaker_trigger_on_a_populated_v16_database() {
    // THE UPGRADE THAT MATTERS. A v16 database already carries
    // `trg_driver_ledger_remittance_needs_shift` in its 016 form, so 017 has to
    // REPLACE it — a `CREATE IF NOT EXISTS` would silently leave the weak one
    // in place and this test is what would have caught that.
    let db = populated_at_schema_version(16).await;
    seed_driver(&db, "drv-a", "Ali").await;
    seed_driver_balance(&db, "adj-open", "drv-a", 10_000).await;

    // A shift that has been closed and counted.
    sqlx::query(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                             closed_at, closed_by_user_id, status)
         VALUES ('shift-closed', ?, ?, 0, '2026-03-01T16:00:00.000Z', ?, 'closed')",
    )
    .bind(STORE_ID)
    .bind(USER_ID)
    .bind(USER_ID)
    .execute(db.pool())
    .await
    .expect("seed a closed shift");

    // Legal at v16: the trigger asked only that the shift exist and be this
    // store's. This is the row whose cash lands in a drawer nobody recounts.
    insert_remittance(&db, "remit-v16", "drv-a", 1_000, Some("shift-closed"))
        .await
        .expect("a remittance into a closed shift was legal at v16");
    insert_return_credit(&db, "credit-v16", "drv-a", 500, "memo-v14")
        .await
        .expect("an unchecked return credit was legal at v16");

    let before = snapshot(&db, "driver_ledger").await;
    db.migrate_again().await.expect("017 must apply to a populated v16 database");
    assert_eq!(snapshot(&db, "driver_ledger").await, before, "history stands");

    // The replaced trigger now refuses the same insert.
    let err = insert_remittance(&db, "remit-new", "drv-a", 100, Some("shift-closed"))
        .await
        .expect_err("a closed shift may not acquire new cash")
        .to_string();
    assert!(err.contains("closed"), "got: {err}");

    assert!(
        insert_return_credit(&db, "credit-new", "drv-a", 100, "memo-v14").await.is_err(),
        "and a return credit must come from this driver's own return"
    );

    // The open shift still takes one, so the rule is not simply "no".
    insert_remittance(&db, "remit-ok", "drv-a", 100, Some("shift-v14"))
        .await
        .expect("a remittance into the open shift posts");
    assert_eq!(driver_balance(&db, "drv-a").await, 10_000 - 1_000 - 500 - 100);
}

#[tokio::test]
async fn a_fresh_database_carries_both_017_guards() {
    // The other direction: a shop installed today must get the same rules as a
    // shop that upgraded, which is only true if 017 is in the fresh chain too.
    let db = TempDb::new().await;
    let objects = object_names(&db, "trigger", "driver_ledger").await;
    assert!(objects.contains(&"trg_driver_ledger_remittance_needs_shift".to_string()));
    assert!(objects.contains(&"trg_driver_ledger_return_credit_source".to_string()));

    let sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master
          WHERE type='trigger' AND name='trg_driver_ledger_remittance_needs_shift'",
    )
    .fetch_one(db.pool())
    .await
    .expect("read the trigger body");
    assert!(
        sql.contains("status") && sql.contains("'open'"),
        "the fresh database must have the OPEN-shift form of the guard, got: {sql}"
    );
}
