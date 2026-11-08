// src-tauri/src/lib.rs
use tauri_plugin_sql::{Migration, MigrationKind};

mod admin;
mod catalog;
mod cost;
mod db_init;
mod posting;
mod read_api;
mod read_guard;
mod recipe_cost;
mod recipe_sale_cost;
mod recipes;
use posting::DbState;
use read_api::ReadPool;

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
        Migration {
            version: 13,
            description: "menu_presentation",
            sql: include_str!("../../src/db/migrations/013_menu_presentation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "sales_channel",
            sql: include_str!("../../src/db/migrations/014_sales_channel.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "driver_collection",
            sql: include_str!("../../src/db/migrations/015_driver_collection.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "driver_cash_discipline",
            sql: include_str!("../../src/db/migrations/016_driver_cash_discipline.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "driver_source_integrity",
            sql: include_str!("../../src/db/migrations/017_driver_source_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "kitchen_notes",
            sql: include_str!("../../src/db/migrations/018_kitchen_notes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "retire_demo_catalogue",
            sql: include_str!("../../src/db/migrations/019_retire_demo_catalogue.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "manual_standard_cost",
            sql: include_str!("../../src/db/migrations/020_manual_standard_cost.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "recipes",
            sql: include_str!("../../src/db/migrations/021_recipes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "recipe_sale_costing",
            sql: include_str!("../../src/db/migrations/022_recipe_sale_costing.sql"),
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
        state.close_pool().await;
    });
}

/// Close the READ-ONLY pool on exit, and close it FIRST.
///
/// SQLite folds the WAL back into the main file and removes `-wal` / `-shm`
/// when the LAST connection closes, and `docs/BACKUP.md` step 3 has the
/// operator read the absence of those two files as the signal that
/// `greaz-pos.db` is complete and safe to copy. Gate 2A adds a third pool to
/// this process; leaving it open would leave the companions behind on every
/// clean shutdown and silently break the backup procedure — which is precisely
/// the defect `close_db_pool_on_exit` exists to fix for the second pool.
///
/// ORDER IS LOAD-BEARING, AND THE FIRST CUT OF GATE 2A HAD IT WRONG. Only a
/// connection that may WRITE can perform that final checkpoint: a read-only
/// handle has no authority to modify the main database, so it closes quietly
/// and leaves both companions on disk. Closing this pool AFTER the posting pool
/// therefore reintroduced the exact defect it was written to avoid — observed
/// on the desktop under a disposable identity, where a cleanly closed Greaz
/// left a 1.8 MB `-wal` beside a 4 KB main file holding none of the evening's
/// sales. So the read-only pool is retired first and a writable pool closes
/// last. Pinned by `tests::lifecycle::a_read_only_pool_closed_last_leaves_the_wal_behind`
/// and `::closing_the_read_only_pool_first_checkpoints_the_wal`.
fn close_read_pool_on_exit(app: &tauri::AppHandle) {
    use tauri::Manager;

    let state = app.state::<ReadPool>();
    tauri::async_runtime::block_on(async move {
        read_api::close_read_pool(&state).await;
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = migrations();

    match tauri::Builder::default()
        .manage(DbState::new())
        .manage(ReadPool::new())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:greaz-pos.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            posting::post_purchase,
            posting::post_adjustment,
            posting::post_supplier_payment,
            posting::post_driver_remittance,
            posting::post_sale,
            posting::post_credit_memo,
            posting::open_shift,
            posting::close_shift,
            catalog::save_product,
            catalog::add_product_barcode,
            catalog::set_primary_product_barcode,
            catalog::remove_product_barcode,
            recipes::save_recipe_draft,
            recipes::activate_recipe,
            recipes::retire_recipe,
            // Gate 2A — the renderer's only database access, read-only by
            // construction (`read_api`), plus the master-data writes that used
            // to be direct `execute()` calls from TypeScript (`admin`).
            read_api::db_select,
            admin::exchange_rate_save,
            admin::driver_save,
            admin::driver_set_active,
            admin::supplier_save,
            admin::supplier_set_active,
        ])
        .setup(|app| {
            // MANDATORY DATABASE VALIDATION, AND IT FAILS CLOSED.
            //
            // Until this work package both bad outcomes here — an error, or a
            // journal mode that is not `wal` — were printed to `stderr` and
            // followed by an ordinary launch. That let Greaz trade onto a
            // database whose documented backup procedure no longer described
            // it, with nothing on screen to say so. See the `db_init` module
            // header for why that is the worse of the two failures.
            //
            // The hook still returns `Ok(())` on failure, deliberately.
            // Returning `Err` aborts `build()`, and a GUI application that
            // vanishes tells the person at the till nothing at all. Instead the
            // startup gate is shut and the pools are released, so the window
            // opens, every command and every read is refused, and `App.tsx`'s
            // existing "Startup failed" screen shows the operator exactly what
            // is wrong and what to do about it.
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                use tauri::Manager;
                let state = handle.state::<DbState>();
                match db_init::initialize_database(&handle, &state).await {
                    Ok(mode) => {
                        // The ONLY path that opens the gate.
                        state.mark_startup_ready().await;
                        println!("[db] ready, journal_mode = {mode}");
                    }
                    Err(reason) => {
                        let message = db_init::fatal_startup_message(&reason);
                        eprintln!("[db] STARTUP FAILED — refusing to trade.\n{message}");
                        // Order matters: shut the gate BEFORE letting go of the
                        // pools, so nothing can lazily re-open the file in
                        // between.
                        state.mark_startup_failed(&message).await;
                        db_init::release_pools_after_failed_startup(&handle, &state).await;
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(e) => {
            // tauri-plugin-sql runs the `preload` connection AND the migrations
            // inside its own setup, so a database that cannot be opened, a
            // migration that errors, and a migration whose checksum no longer
            // matches all surface HERE rather than in the hook above — before
            // any window exists.
            //
            // That was already fail-closed: the process cannot reach trading
            // mode. What it was not was legible. `.expect()` turned the one
            // startup failure that most needs explaining into a Rust panic, so
            // this prints the operator text and exits non-zero instead. There
            // is no window to show it in yet, and building a fallback window to
            // carry it would be a new startup framework; that limitation is
            // recorded in the handoff rather than papered over.
            eprintln!(
                "{}",
                db_init::fatal_startup_message(&format!(
                    "The database could not be opened or brought up to date: {e}"
                ))
            );
            std::process::exit(1);
        }
    }
    .run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Read-only FIRST: it cannot checkpoint, so it must not be the
            // last connection holding the file. See the note on
            // `close_read_pool_on_exit`. Both are no-ops after a failed
            // startup, which has already released them.
            close_read_pool_on_exit(app_handle);
            close_db_pool_on_exit(app_handle);
        }
    });
}
