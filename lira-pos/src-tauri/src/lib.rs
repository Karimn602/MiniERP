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

/// Close Greaz's own SQLite pool, in order, as the application exits.
///
/// Greaz holds TWO pools against the one database file: tauri-plugin-sql's,
/// which the plugin closes itself on `RunEvent::Exit`, and the `DbState` pool in
/// `posting.rs` that every transactional command uses. Nothing closed the second
/// one — it was simply abandoned when the process ended.
///
/// That matters because of how WAL works. SQLite checkpoints the write-ahead log
/// into the main database and unlinks `-wal` / `-shm` when the LAST connection to
/// the file closes. With the posting pool still open, the plugin closing its own
/// achieved nothing, so a cleanly-closed Greaz left its WAL on disk — and
/// `docs/BACKUP.md` reads exactly that as the signature of a crash, while a
/// single-file copy taken in that state silently omits the sales still sitting in
/// the WAL (`tests/lifecycle.rs`).
///
/// It only ever looked intermittent. The pool's idle connections are reaped after
/// roughly ten minutes, so a shop that closed the till long after the last sale
/// checkpointed correctly, and one that closed it straight after a sale did not.
///
/// This changes no durability setting: WAL, `synchronous`, foreign keys and every
/// posting guard are untouched. It closes a resource that was already finished
/// with, at the one moment it is safe to close it.
fn close_db_pool_on_exit(app: &tauri::AppHandle) {
    use tauri::Manager;

    let state = app.state::<DbState>();
    tauri::async_runtime::block_on(async move {
        let mut guard = state.pool.lock().await;
        if let Some(pool) = guard.take() {
            pool.close().await;
        }
    });
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                close_db_pool_on_exit(app_handle);
            }
        });
}
