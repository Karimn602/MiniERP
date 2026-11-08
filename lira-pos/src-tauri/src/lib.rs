// src-tauri/src/lib.rs
use tauri_plugin_sql::{Migration, MigrationKind};

mod admin;
mod auth;
mod authz;
mod catalog;
mod cost;
mod db_init;
mod posting;
mod read_api;
mod read_guard;
mod recipe_cost;
mod recipe_sale_cost;
mod recipes;
mod users;
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
        Migration {
            version: 23,
            description: "authentication",
            sql: include_str!("../../src/db/migrations/023_authentication.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 24,
            description: "audit_vocabulary",
            sql: include_str!("../../src/db/migrations/024_audit_vocabulary.sql"),
            kind: MigrationKind::Up,
        },
        // MIGRATION 025 IS WRITTEN BUT NOT YET REGISTERED.
        //
        // `src/db/migrations-pending/025_actor_required.sql` exists and is
        // complete: BEFORE INSERT triggers requiring every new financial
        // document to name an active user of its own store. It is the
        // ENGINE's half of Stage B.2's attribution rule, for a writer that
        // never goes through `posting.rs`.
        //
        // It is not registered yet because registering it makes ~131
        // existing TEST FIXTURES invalid in one step: they insert sales,
        // purchases, movements, shifts and ledger rows directly, naming
        // nobody, because until Stage B.2 nobody had to be named. Those
        // are fixtures standing in for real documents and they must now
        // look like real documents; the edit is mechanical but it is 131
        // of them across 19 files, and rushing it is how a fixture gets
        // quietly weakened to make a suite pass.
        //
        // NOTHING IS UNENFORCED IN THE MEANTIME. The application already
        // takes every actor from the session and refuses a request that
        // names somebody else (`authz::attribute`), with
        // `tests::actor_attribution` proving it against a real database
        // and a structural guard proving no actor column is written from
        // a request. 024 adds defence in depth against a FUTURE writer,
        // not a fix for a present hole.
        //
        // It was numbered 024 until Stage B.3's round-2 corrections needed
        // 024 for the `auth_audit` vocabulary, which could not wait: the
        // commands that write those events shipped in the same change. A
        // pending file's number is free to move precisely because no database
        // has recorded its checksum, and sqlx refuses a migration arriving
        // BELOW the highest version a database already holds — so leaving a gap
        // at 024 and filling it later was never an option.
        //
        // See that directory's README for the exact adoption steps, and
        // dev/AUTONOMOUS-COMPLETION-LEDGER.md for where it sits in the plan.
    ]
}

/// SHOW A FATAL STARTUP FAILURE WHERE A PERSON WILL ACTUALLY SEE IT.
///
/// GZ-WAL-R1. There is exactly one startup failure in this application that has
/// no window to report itself in: `tauri::Builder::build()` returning `Err`.
/// tauri-plugin-sql runs its preload connection AND the migrations inside its
/// own setup, so a database that cannot be opened, a migration that errors and a
/// migration whose checksum no longer matches all surface there — before any
/// webview exists. Every other failure, including the startup gate refusing to
/// trade, happens in the setup hook, where the window does open and `App.tsx`
/// shows the operator text.
///
/// That case was already fail-closed and already printed the operator text. It
/// was simply INVISIBLE: a packaged Windows GUI application has no console, so
/// somebody who double-clicked the icon saw the splash vanish and nothing else.
/// For a shop that is indistinguishable from "Greaz is broken", and the thing
/// they would reach for next is deleting the database files — which the message
/// exists to tell them not to do.
///
/// ## Why `MessageBoxW` and no new dependency
///
/// `tauri-plugin-dialog` needs an `AppHandle`, which is precisely what does not
/// exist here. The Win32 `MessageBoxW` needs neither a window nor an
/// initialised GUI framework; `user32` is already loaded in a GUI process.
/// Declaring the one import directly costs no crate — and the mandate for this
/// work is explicit that `Cargo.toml` is not to be touched without a deliberate,
/// independently inspected reason, which a message box is not.
///
/// ## What it deliberately does
///
/// It BLOCKS until the operator dismisses it. That is the point: the process is
/// about to exit, and a dialog that did not block would flash and disappear with
/// everything else. `MB_SETFOREGROUND | MB_TOPMOST` because the window this
/// replaces never appeared, so there is nothing for the box to sit in front of
/// and no taskbar entry to find it behind.
///
/// It is a no-op off Windows, where this build does not ship and where the
/// terminal the application was launched from is the right place for the text.
#[cfg(windows)]
fn show_fatal_startup_dialog(message: &str) {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;

    fn wide(text: &str) -> Vec<u16> {
        OsStr::new(text).encode_wide().chain(once(0)).collect()
    }

    // A message box sizes itself to its text and does not scroll, so a very long
    // body can run off a small screen. The operator text is ~900 characters and
    // fits comfortably at 1366x768; the bound is a guard against a driver error
    // appended to it being pathological, and it keeps the ACTIONABLE part — the
    // numbered steps are at the end, so the truncation notice points at the
    // console copy rather than silently dropping them.
    const MAX: usize = 1800;
    let body = if message.chars().count() > MAX {
        let kept: String = message.chars().take(MAX).collect();
        format!("{kept}\n\n[This message was shortened to fit on screen.]")
    } else {
        message.to_string()
    };

    let body = wide(&body);
    let caption = wide("Greaz POS - cannot start");

    // SAFETY: both pointers are to NUL-terminated UTF-16 buffers that outlive
    // the call, and a null owner window is documented as valid (the box is
    // owned by the desktop). `MessageBoxW` takes no ownership of either buffer.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(windows))]
fn show_fatal_startup_dialog(_message: &str) {}

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
        .manage(auth::SessionState::new())
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
            // Gate 2B Stage A.1 - offline authentication. `auth_status` is the
            // ONLY command callable with no session; it is what the pre-login
            // boot runs on, so the read channel can be session-gated without
            // an allowlist of "harmless" pre-login queries.
            auth::auth_status,
            auth::auth_enroll_owner,
            auth::auth_login,
            auth::auth_logout,
            auth::auth_lock,
            auth::auth_unlock,
            auth::auth_touch,
            auth::auth_change_credential,
            auth::auth_recover_owner,
            // Gate 2B Stage B.3 - staff administration, owner-only. Until these
            // existed a staff account had no credential and no way to acquire
            // one, which is why LOGIN_RESTRICTED_TO_OWNER could not be lifted.
            users::users_list,
            users::users_save,
            users::users_set_active,
            users::users_set_credential,
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
            // this prints the operator text and exits non-zero instead.
            //
            // AND NOW IT IS ALSO ON SCREEN (GZ-WAL-R1). `eprintln!` alone was
            // invisible in the case that matters: a packaged Windows GUI
            // application has no console, so somebody who double-clicked the
            // icon saw the splash vanish and nothing else — indistinguishable
            // from "Greaz is broken", after which the thing they reach for is
            // deleting the database files, which this very message exists to
            // tell them not to do. `show_fatal_startup_dialog` is a native
            // message box that needs no window and no AppHandle, and it blocks
            // until it is dismissed because the process is about to exit.
            //
            // Both, not either: the console copy is what a support call can be
            // read from and what a launcher's redirected output captures.
            let message = db_init::fatal_startup_message(&format!(
                "The database could not be opened or brought up to date: {e}"
            ));
            eprintln!("{message}");
            show_fatal_startup_dialog(&message);
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
