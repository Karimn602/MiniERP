//! MIGRATION 024 — the audit log can record restoring access and renaming
//! somebody (Gate 2B, Stage B.3, round 2).
//!
//! 023 created `auth_audit` with a fixed `event` vocabulary and said in its own
//! header that stating the list up front meant "the CHECK never has to be
//! widened, which on this table would mean a rebuild". The intent was right and
//! the list was incomplete: Stage B.3's four commands do five things and the
//! vocabulary covered three of them. An independent review called the missing
//! reactivation event a P1, correctly — `user_deactivated` records that access
//! was taken away, and with no counterpart the log could show a cashier retired
//! in March with nothing to say they were ringing sales again in April.
//!
//! So 024 does the rebuild. These tests are about the rebuild being faithful,
//! not merely about the new values being accepted, because a security log that
//! lost or altered a row in the course of being improved would be worse than
//! one that could not record a reactivation.

use crate::test_support::{self, TempDb};

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const USER: &str = "00000000-0000-0000-0000-000000000002";

/// 024 is registered and is the newest migration.
#[tokio::test]
async fn migration_024_is_registered_and_is_the_newest() {
    assert_eq!(
        test_support::latest_migration_version(),
        24,
        "024 must be the newest registered migration"
    );
    assert!(crate::migrations()
        .iter()
        .any(|m| m.version == 24 && m.description == "audit_vocabulary"));

    // And a fully migrated database still satisfies the startup completeness
    // proof, which is what lets GZ-WAL-01's gate open.
    let db = TempDb::new().await;
    crate::db_init::require_complete_migrations(db.pool())
        .await
        .expect("a v24 database must satisfy the startup completeness check");
    db.cleanup().await.expect("remove TempDb");
}

/// THE THREE NEW EVENTS ARE ACCEPTED, and every one of 023's still is.
///
/// Both halves matter. A rebuild that admitted the new values and quietly
/// dropped an old one would make the next `login_failed` unwritable, and the
/// login path audits from its first line.
#[tokio::test]
async fn the_vocabulary_gains_three_events_and_loses_none() {
    let db = TempDb::new().await;

    for event in [
        // 024's.
        "user_activated",
        "user_renamed",
        "session_revoked",
        // 023's, in full.
        "login_ok",
        "login_failed",
        "locked_out",
        "logout",
        "timeout",
        "lock",
        "unlock",
        "unlock_failed",
        "credential_set",
        "credential_changed",
        "credential_reset",
        "enrollment_code_issued",
        "enrollment_failed",
        "owner_enrolled",
        "recovery_used",
        "recovery_failed",
        "role_changed",
        "user_created",
        "user_deactivated",
        "permission_denied",
    ] {
        db.exec(&format!(
            "INSERT INTO auth_audit (id, store_id, event)
             VALUES ('ok-{event}', '{STORE}', '{event}')"
        ))
        .await;
    }

    // And the CHECK is still a CHECK: an invented event is refused, so the
    // widening did not become an opening.
    for bad in ["", "user_promoted", "USER_ACTIVATED", "deleted", "anything"] {
        let refused = db
            .exec_err(&format!(
                "INSERT INTO auth_audit (id, store_id, event)
                 VALUES ('x-{bad}', '{STORE}', '{bad}')"
            ))
            .await;
        assert!(!refused.is_empty(), "`{bad}` must still be refused");
    }

    db.cleanup().await.expect("remove TempDb");
}

/// THE EXISTING ROWS SURVIVE THE REBUILD, byte for byte.
///
/// The table is copied column-for-column into a new one and renamed into place.
/// Nothing is re-derived — not a timestamp, not an id — so a v23 database's log
/// must come through the upgrade identical. This writes a row of every shape the
/// table admits, including the NULL-heavy ones, and compares the whole table
/// before and after.
#[tokio::test]
async fn the_log_comes_through_the_rebuild_unchanged() {
    let db = TempDb::at_schema_version(23).await;

    // A row naming a user and an actor; a row naming neither (a login against
    // an unknown id, which is why those columns are nullable); and a refusal
    // carrying an operation.
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, actor_user_id, operation, detail)
         VALUES ('a', '{STORE}', '2026-03-01T08:00:00.000Z', 'credential_reset',
                 '{USER}', '{USER}', NULL, 'by the owner')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, actor_user_id, operation, detail)
         VALUES ('b', '{STORE}', '2026-03-01T08:00:01.000Z', 'login_failed',
                 NULL, NULL, NULL, 'unknown account: nobody')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, at, event, user_id, actor_user_id, operation, detail)
         VALUES ('c', '{STORE}', '2026-03-01T08:00:02.000Z', 'permission_denied',
                 '{USER}', NULL, 'post_credit_memo', NULL)"
    ))
    .await;

    let before: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, store_id, at, event, user_id, actor_user_id, operation, detail
               FROM auth_audit ORDER BY id",
        )
        .fetch_all(db.pool())
        .await
        .expect("read the v23 log");
    assert_eq!(before.len(), 3);

    db.migrate_through(24).await.expect("024 applies");

    let after: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, store_id, at, event, user_id, actor_user_id, operation, detail
               FROM auth_audit ORDER BY id",
        )
        .fetch_all(db.pool())
        .await
        .expect("read the v24 log");

    assert_eq!(after, before, "every column of every row must come through");

    db.cleanup().await.expect("remove TempDb");
}

/// THE GUARDS ARE BACK AFTER THE REBUILD.
///
/// The append-only pair has to be DROPPED before the old table can be dropped —
/// `trg_auth_audit_no_delete` would abort it — so a rebuild that forgot to
/// recreate them would leave the security log editable, and nothing else in the
/// schema would notice. Same for the store-coherence trigger and the three
/// indexes.
#[tokio::test]
async fn the_append_only_and_store_guards_are_recreated() {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, event) VALUES ('r', '{STORE}', 'login_ok')"
    ))
    .await;

    for sql in [
        "UPDATE auth_audit SET detail = 'edited' WHERE id = 'r'",
        "UPDATE auth_audit SET event = 'logout' WHERE id = 'r'",
        "DELETE FROM auth_audit WHERE id = 'r'",
        "DELETE FROM auth_audit",
    ] {
        let refused = db.exec_err(sql).await;
        assert!(
            refused.contains("append-only"),
            "`{sql}` must be refused by the append-only guard, got: {refused}"
        );
    }

    // The row is still there, which is the point of the guard.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE id = 'r'")
            .await,
        1
    );

    // An audit row is filed against the store of the user it names.
    test_support::seed_store(&db, "store-b", "Branch B").await;
    let theirs = test_support::seeded_owner_of("store-b");
    let refused = db
        .exec_err(&format!(
            "INSERT INTO auth_audit (id, store_id, event, user_id)
             VALUES ('cross', '{STORE}', 'login_ok', '{theirs}')"
        ))
        .await;
    assert!(
        refused.contains("own store"),
        "a cross-store audit row must be refused, got: {refused}"
    );

    // And the indexes the log is read through.
    for index in [
        "idx_auth_audit_at",
        "idx_auth_audit_event",
        "idx_auth_audit_user",
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT count(*) AS n FROM sqlite_master
                  WHERE type = 'index' AND name = '{index}'"
            ))
            .await,
            1,
            "{index} must survive the rebuild"
        );
    }

    // The working name the rebuild used must not be left behind.
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM sqlite_master
              WHERE name = 'auth_audit_v24'"
        )
        .await,
        0,
        "the intermediate table must be renamed, not kept beside the real one"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// Migrations 001–023 are untouched by 024.
///
/// By CHECKSUM rather than by reading the files: sqlx records each applied
/// migration's checksum, so a v23 database that then applies 024 must still
/// carry byte-identical checksums for everything before it. If 024 had been
/// written as an edit to 023 — which is what widening a CHECK in place would
/// have looked like — this is what would catch it, and every database that had
/// already applied 023 would have stopped opening.
#[tokio::test]
async fn applying_024_does_not_disturb_any_earlier_migration() {
    let db = TempDb::at_schema_version(23).await;

    let before: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(db.pool())
            .await
            .expect("read the v23 history");
    assert_eq!(before.len(), 23);

    db.migrate_through(24).await.expect("024 applies");

    let after: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(db.pool())
            .await
            .expect("read the v24 history");

    assert_eq!(after.len(), 24);
    assert_eq!(
        &after[..23],
        &before[..],
        "024 must not restate any earlier migration"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// THE REBUILT TABLE STILL CARRIES ITS FOREIGN KEYS.
///
/// This test used to be called "foreign keys are enforced after the rebuild"
/// and it asserted `PRAGMA foreign_keys = 1`, attributing that to the
/// migration having restored it. It proved nothing: the connection enables
/// foreign keys before any migration runs, 024's `PRAGMA` statements were a
/// silent no-op inside sqlx's migration transaction, and the assertion would
/// have passed against a migration that contained neither PRAGMA — which, now
/// that both have been removed, is exactly what it is (independent review,
/// Stage B.3 round 2).
///
/// What is worth asserting is what the rebuild could really have lost: the two
/// foreign keys are declared on the new table, so a dangling reference is
/// still refused. That is a property of the DDL this migration wrote, not of a
/// PRAGMA.
#[tokio::test]
async fn the_rebuilt_table_still_declares_its_foreign_keys() {
    let db = TempDb::new().await;

    // THE USER FOREIGN KEY IS SHADOWED, and saying so is the point of writing
    // this out rather than asserting a message.
    //
    // 023's store-coherence trigger is BEFORE INSERT and its condition is
    // `NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND store_id =
    // NEW.store_id)`, which is satisfied by a user that does not exist at all
    // just as much as by one of another store. So the trigger refuses first,
    // with the better message, and the foreign key on `user_id` is never
    // reached from any INSERT that would violate it. It is still declared, and
    // that is asserted below against the DDL — which is the honest way to assert
    // a constraint nothing can make bite.
    let refused = db
        .exec_err(&format!(
            "INSERT INTO auth_audit (id, store_id, event, user_id)
             VALUES ('fk1', '{STORE}', 'login_ok', 'nobody-at-all')"
        ))
        .await;
    assert!(
        refused.contains("own store"),
        "a dangling user_id is refused by the trigger, before the key: {refused}"
    );

    // THE STORE FOREIGN KEY DOES BITE, because the trigger's condition is false
    // when no user is named at all and the key is then the only thing left.
    let refused = db
        .exec_err(
            "INSERT INTO auth_audit (id, store_id, event)
             VALUES ('fk2', 'no-such-store', 'login_ok')",
        )
        .await;
    assert!(
        refused.to_lowercase().contains("foreign key"),
        "a dangling store_id must be refused by the foreign key, got: {refused}"
    );

    // Both are declared on the table itself, not inherited from anywhere.
    let ddl = db
        .scalar_string("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_audit'")
        .await;
    assert!(ddl.contains("REFERENCES stores(id)"), "{ddl}");
    assert_eq!(
        ddl.matches("REFERENCES users(id)").count(),
        2,
        "both user columns must still reference users: {ddl}"
    );

    // THE MIGRATION ISSUES NO `PRAGMA foreign_keys` STATEMENT. Asserted against
    // the SOURCE, because the finding was precisely that a statement claimed an
    // effect it did not have — and COMMENT LINES ARE EXCLUDED rather than the
    // whole file searched, because the migration now explains at length why the
    // PRAGMA is absent and a blunt `contains` would forbid saying so.
    let sql = include_str!("../../../src/db/migrations/024_audit_vocabulary.sql");
    let offenders: Vec<&str> = sql
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("--") && line.contains("PRAGMA"))
        .collect();
    assert!(
        offenders.is_empty(),
        "024 must not pretend to toggle foreign keys — the statement is a no-op \
         inside sqlx's migration transaction. Offending lines: {offenders:?}"
    );

    db.cleanup().await.expect("remove TempDb");
}
