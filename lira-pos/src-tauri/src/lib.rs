// src-tauri/src/lib.rs
use tauri_plugin_sql::{Migration, MigrationKind};

mod posting;
use posting::DbState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
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
    ];

    tauri::Builder::default()
        .manage(DbState::new())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lira-pos.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            posting::post_purchase,
            posting::post_adjustment,
            posting::post_supplier_payment,
            posting::post_sale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}