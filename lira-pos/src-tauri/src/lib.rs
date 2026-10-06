// src-tauri/src/lib.rs
use tauri_plugin_sql::{Migration, MigrationKind};

mod catalog;
mod cost;
mod posting;
use posting::DbState;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

/// The application's migration list — the single source of truth.
///
/// `run()` registers exactly this list with tauri-plugin-sql, and the test
/// harness applies exactly this list to its temporary databases, so the two
/// cannot drift apart.
pub(crate) fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../../src/db/migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "barcodes",
            sql: include_str!("../../src/db/migrations/002_barcodes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "demo_products_and_barcodes",
            sql: include_str!("../../src/db/migrations/003_demo_products.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "multi_uom",
            sql: include_str!("../../src/db/migrations/004_uom.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "suppliers_and_purchases",
            sql: include_str!("../../src/db/migrations/005_purchases.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "supplier_ledger",
            sql: include_str!("../../src/db/migrations/006_supplier_ledger.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "sales_cogs_method",
            sql: include_str!("../../src/db/migrations/007_sales_cogs_method.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "cost_precision",
            sql: include_str!("../../src/db/migrations/008_cost_precision.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "shift_integrity",
            sql: include_str!("../../src/db/migrations/009_shift_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "supplier_ap_integrity",
            sql: include_str!("../../src/db/migrations/010_supplier_ap_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "sales_credit_memos",
            sql: include_str!("../../src/db/migrations/011_sales_credit_memos.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "database_inventory_hardening",
            sql: include_str!("../../src/db/migrations/012_database_inventory_hardening.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = migrations();

    tauri::Builder::default()
        .manage(DbState::new())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:greaz-pos.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            posting::post_purchase,
            posting::post_adjustment,
            posting::post_supplier_payment,
            posting::post_sale,
            posting::post_credit_memo,
            posting::open_shift,
            posting::close_shift,
            catalog::save_product,
            catalog::add_product_barcode,
            catalog::set_primary_product_barcode,
            catalog::remove_product_barcode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}