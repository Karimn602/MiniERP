// Layer C — migrations against a virgin temporary database.

use crate::cost::{cents_to_microcents, COST_SCALE};
use crate::test_support::{
    app_migrator, assert_not_production_db, TempDb, RATE_ID, STORE_ID, USER_ID, VAT_STD_ID,
};

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
    assert_eq!(applied, 10, "all ten migrations must be recorded");

    assert_eq!(db.scalar_i64("SELECT MIN(version) FROM _sqlx_migrations").await, 1);
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 10);

    // Versions are exactly 1..=10 with no gaps or duplicates.
    let distinct = db
        .count("SELECT COUNT(DISTINCT version) FROM _sqlx_migrations")
        .await;
    assert_eq!(distinct, 10);
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
    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 10);
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

    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 10);
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

    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 10);
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

    assert_eq!(db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await, 10);

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
