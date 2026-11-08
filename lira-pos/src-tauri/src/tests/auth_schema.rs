//! MIGRATION 023 — the authentication foundation's schema, and the upgrade.
//!
//! Two things are proven here and the second one is the harder one.
//!
//! THE RULES. The enrollment state machine, the credential coherence pair, the
//! single-live-recovery-code index, append-only `auth_audit`, and the
//! store-scoping guards. Each is asserted against a real disposable database
//! rather than read off the migration.
//!
//! THE UPGRADE. 023 decides, ONCE, whether an installation is `virgin` or
//! `legacy_pending`, and it decides it from the shop's own trading history.
//! That decision cannot be re-made later and it cannot be got wrong twice, so
//! it is tested against SYNTHETIC LEGACY DATA at v22 — a database that traded
//! before authentication existed — and not only against a fresh one. The whole
//! point of the state machine is the case where somebody has been using Greaz
//! for months, and a test that only ever migrates an empty database would never
//! touch it.

use crate::test_support::TempDb;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";
const VAT_STD: &str = "00000000-0000-0000-0000-000000000010";

/// A v22 database that has TRADED: one open shift and one posted sale, written
/// the way the pre-023 application wrote them.
///
/// Deliberately built at schema version 22 and migrated afterwards, so the rows
/// exist before 023 runs and 023 sees exactly what it would see in a shop.
async fn legacy_v22_that_has_traded() -> TempDb {
    let db = TempDb::at_schema_version(22).await;
    crate::test_support::seed_exchange_rate(&db).await;
    let rate_id = db
        .scalar_string(&format!(
            "SELECT id FROM exchange_rates WHERE store_id = '{STORE}' LIMIT 1"
        ))
        .await;

    db.exec(&format!(
        "INSERT INTO shifts
           (id, store_id, opened_by_user_id, opened_at, status,
            opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('shift-legacy', '{STORE}', '{OWNER}',
                 '2026-06-01T08:00:00.000Z', 'open', 10000, 0)"
    ))
    .await;

    // BORN A DRAFT, then promoted in one statement — migration 022's rule. A
    // sale cannot be INSERTed already posted, and that is the shape a legacy
    // row genuinely has: `post_sale` has always built a draft and promoted it
    // last.
    db.exec(&format!(
        "INSERT INTO sales
           (id, store_id, shift_id, cashier_user_id, receipt_number,
            exchange_rate_lbp_per_usd, exchange_rate_id,
            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
            discount_cents, cogs_total_cents, cogs_method, status)
         VALUES ('sale-legacy', '{STORE}', 'shift-legacy', '{OWNER}', 1,
                 89500, '{rate_id}', 900, 99, 999, 0, 0,
                 'weighted_average', 'draft')"
    ))
    .await;
    db.exec(
        "UPDATE sales
            SET status = 'posted', posted_at = '2026-06-01T09:00:00.000Z'
          WHERE id = 'sale-legacy'",
    )
    .await;

    db
}

// ===========================================================================
// The upgrade decision
// ===========================================================================

/// A FRESH installation is `virgin`, and carries NO credential.
///
/// "No default credentials exist" is a release acceptance criterion, so it is
/// asserted from both sides: the state says bootstrap is required, and there is
/// no hash anywhere that could be used instead.
#[tokio::test]
async fn a_fresh_installation_is_virgin_and_has_no_credential() {
    let db = TempDb::new().await;

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "virgin"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_enrollment").await,
        1,
        "exactly one enrollment row per store"
    );

    // No credential, no enrollment code, no recovery code, no audit history.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM users WHERE pin_hash IS NOT NULL")
            .await,
        0,
        "a fresh installation must ship with NO credential of any kind"
    );
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM auth_enrollment
              WHERE enrollment_code_hash IS NOT NULL"
        )
        .await,
        0,
        "the enrollment code is minted by Rust at first launch, never by a migration"
    );
    assert_eq!(db.count("SELECT count(*) AS n FROM owner_recovery").await, 0);
    assert_eq!(db.count("SELECT count(*) AS n FROM auth_audit").await, 0);

    // And the initialized-state invariant holds vacuously.
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM auth_enrollment
              WHERE initialized_at IS NOT NULL OR initialized_user_id IS NOT NULL"
        )
        .await,
        0
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A DATABASE THAT HAS TRADED becomes `legacy_pending`, not `virgin`.
///
/// This is the finding the state machine exists for. If bootstrap eligibility
/// were inferred from `pin_hash IS NULL`, this shop — months of real takings —
/// would present a "create the owner account" screen to whoever launched the
/// upgraded build first, which at 8 a.m. is a cashier.
#[tokio::test]
async fn an_installation_that_has_traded_requires_owner_assisted_enrollment() {
    let db = legacy_v22_that_has_traded().await;

    // Before 023 there is no enrollment concept at all.
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM sqlite_master
              WHERE type = 'table' AND name = 'auth_enrollment'"
        )
        .await,
        0
    );

    db.migrate_through(23).await.expect("023 applies to a v22 shop");

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "legacy_pending",
        "a shop with posted sales must NOT be offered first-time bootstrap"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// EVERY kind of trading document counts as evidence, one at a time.
///
/// Asserted per-table rather than all together, because the failure mode of a
/// multi-clause `CASE` is that one branch is wrong and the others hide it. A
/// shop whose only history is a supplier payment has still been operated by
/// somebody.
#[tokio::test]
async fn each_trading_document_on_its_own_makes_the_installation_legacy() {
    // (table, the INSERT that creates one row of it at v22)
    let cases: Vec<(&str, String)> = vec![
        (
            "shifts",
            format!(
                "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                                     opening_cash_usd_cents, opening_cash_lbp)
                 VALUES ('s1', '{STORE}', '{OWNER}', '2026-06-01T08:00:00.000Z', 'open', 0, 0)"
            ),
        ),
        (
            "supplier_ledger",
            format!(
                "INSERT INTO suppliers (id, store_id, name) VALUES ('sup1', '{STORE}', 'Acme');
                 INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type,
                                              amount_cents, entry_date)
                 VALUES ('sl1', '{STORE}', 'sup1', 'opening_balance', 5000,
                         '2026-06-01T08:00:00.000Z')"
            ),
        ),
        (
            "inventory_movements",
            format!(
                "INSERT INTO products (id, store_id, sku, name, vat_rate_id, vat_pricing_mode,
                                       price_excl_vat_cents, price_incl_vat_cents,
                                       quantity_on_hand, is_active, is_service)
                 VALUES ('p1', '{STORE}', 'SKU1', 'Thing', '{VAT_STD}', 'inclusive',
                         900, 999, 0, 1, 0);
                 INSERT INTO inventory_movements (id, store_id, product_id, movement_type,
                                                  quantity_delta, posted_at)
                 VALUES ('m1', '{STORE}', 'p1', 'opening', 5, '2026-06-01T08:00:00.000Z')"
            ),
        ),
    ];

    for (what, setup) in cases {
        let db = TempDb::at_schema_version(22).await;
        for statement in setup.split(';') {
            if !statement.trim().is_empty() {
                db.exec(statement).await;
            }
        }

        db.migrate_through(23).await.expect("023 applies");

        assert_eq!(
            db.scalar_string(&format!(
                "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
            ))
            .await,
            "legacy_pending",
            "a database whose only history is in `{what}` is still an operated shop"
        );

        db.cleanup().await.expect("remove TempDb");
    }
}

/// 023 RESTATES NOTHING. The legacy shop's history reads back exactly as it was
/// written, and the posted sale is still immutable afterwards.
#[tokio::test]
async fn the_upgrade_preserves_every_historical_row() {
    let db = legacy_v22_that_has_traded().await;

    let before_receipt = db
        .scalar_i64("SELECT receipt_number FROM sales WHERE id = 'sale-legacy'")
        .await;
    let before_total = db
        .scalar_i64("SELECT total_incl_vat_cents FROM sales WHERE id = 'sale-legacy'")
        .await;
    let before_cashier = db
        .scalar_string("SELECT cashier_user_id FROM sales WHERE id = 'sale-legacy'")
        .await;
    let before_posted = db
        .scalar_string("SELECT posted_at FROM sales WHERE id = 'sale-legacy'")
        .await;

    db.migrate_through(23).await.expect("023 applies");

    assert_eq!(
        db.scalar_i64("SELECT receipt_number FROM sales WHERE id = 'sale-legacy'")
            .await,
        before_receipt
    );
    assert_eq!(
        db.scalar_i64("SELECT total_incl_vat_cents FROM sales WHERE id = 'sale-legacy'")
            .await,
        before_total
    );
    assert_eq!(
        db.scalar_string("SELECT cashier_user_id FROM sales WHERE id = 'sale-legacy'")
            .await,
        before_cashier,
        "023 must not rewrite a historical actor"
    );
    assert_eq!(
        db.scalar_string("SELECT posted_at FROM sales WHERE id = 'sale-legacy'")
            .await,
        before_posted
    );

    // And the seal is still a seal.
    let refused = db
        .exec_err("UPDATE sales SET total_incl_vat_cents = 1 WHERE id = 'sale-legacy'")
        .await;
    assert!(
        !refused.is_empty(),
        "a posted sale must still be immutable after 023"
    );

    // The existing user row kept its identity and gained only NULL credential
    // columns and zeroed counters.
    assert_eq!(
        db.scalar_string(&format!("SELECT full_name FROM users WHERE id = '{OWNER}'"))
            .await,
        "Owner"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users
              WHERE id = '{OWNER}' AND pin_hash IS NULL AND credential_algo IS NULL
                AND failed_attempts = 0 AND must_change_pin = 0"
        ))
        .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The state machine
// ===========================================================================

/// `initialized` IS TERMINAL — the assertion that makes a restored database
/// safe.
///
/// Every route backwards is tried, because the dangerous one is not "somebody
/// sets state = 'virgin'" on purpose; it is a support engineer clearing a
/// credential to recover a forgotten passphrase and inadvertently re-arming
/// first-time bootstrap. The state is a separate fact from the hash precisely
/// so that clearing the hash cannot do that.
#[tokio::test]
async fn an_initialized_store_can_never_be_offered_bootstrap_again() {
    let db = TempDb::new().await;

    db.exec(&format!(
        "UPDATE auth_enrollment
            SET state = 'initialized',
                initialized_at = '2026-11-08T00:00:00.000Z',
                initialized_user_id = '{OWNER}'
          WHERE store_id = '{STORE}'"
    ))
    .await;

    for backwards in [
        "UPDATE auth_enrollment SET state = 'virgin', initialized_at = NULL, initialized_user_id = NULL",
        "UPDATE auth_enrollment SET state = 'legacy_pending', initialized_at = NULL, initialized_user_id = NULL",
        "UPDATE auth_enrollment SET state = 'virgin'",
        "UPDATE auth_enrollment SET initialized_at = NULL",
        "UPDATE auth_enrollment SET initialized_user_id = NULL",
        "UPDATE auth_enrollment SET initialized_at = '2020-01-01T00:00:00.000Z'",
        "DELETE FROM auth_enrollment",
    ] {
        let refused = db.exec_err(backwards).await;
        assert!(
            !refused.is_empty(),
            "this must be refused: {backwards} (got: {refused})"
        );
    }

    // AND THE CREDENTIAL CAN STILL BE CLEARED — the support reset — without the
    // state moving. That combination is the whole design: a recoverable
    // password, an unrecoverable "this shop already has an owner".
    db.exec(&format!(
        "UPDATE users SET pin_hash = NULL, credential_algo = NULL, credential_set_at = NULL
          WHERE id = '{OWNER}'"
    ))
    .await;
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "initialized",
        "clearing the hash must NOT re-arm bootstrap"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// Forward transitions are allowed, from either starting state — and each
/// starting state is REACHED THE WAY THE APPLICATION REACHES IT.
///
/// Note what this test cannot do, and why that is correct: it cannot set up
/// `legacy_pending` by `UPDATE`ing a virgin row, because the lifecycle trigger
/// refuses `virgin -> legacy_pending`. That refusal is right. `legacy_pending`
/// means "this shop traded before authentication existed", which is a fact
/// about the past that only the migration can establish; a virgin installation
/// cannot acquire it, because from Stage A.1 onwards nothing can trade before
/// it is initialized. So the legacy case is built by migrating a v22 shop that
/// really did trade.
#[tokio::test]
async fn enrollment_moves_forward_from_either_starting_state() {
    // virgin -> initialized
    let db = TempDb::new().await;
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "virgin"
    );
    db.exec(&format!(
        "UPDATE auth_enrollment
            SET state = 'initialized',
                initialized_at = '2026-11-08T00:00:00.000Z',
                initialized_user_id = '{OWNER}'
          WHERE store_id = '{STORE}'"
    ))
    .await;
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "initialized"
    );
    db.cleanup().await.expect("remove TempDb");

    // legacy_pending -> initialized
    let db = legacy_v22_that_has_traded().await;
    db.migrate_through(23).await.expect("023 applies");
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "legacy_pending"
    );
    db.exec(&format!(
        "UPDATE auth_enrollment
            SET state = 'initialized',
                initialized_at = '2026-11-08T00:00:00.000Z',
                initialized_user_id = '{OWNER}'
          WHERE store_id = '{STORE}'"
    ))
    .await;
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "initialized"
    );
    db.cleanup().await.expect("remove TempDb");
}

/// AND SIDEWAYS IS REFUSED. A virgin installation cannot be relabelled as a
/// shop with history, which would be a claim that trading happened before
/// anyone was accountable for it; and a legacy shop cannot be relabelled
/// virgin, which is the bootstrap-capture case all over again.
#[tokio::test]
async fn enrollment_state_cannot_move_sideways() {
    let db = TempDb::new().await;
    let refused = db
        .exec_err("UPDATE auth_enrollment SET state = 'legacy_pending'")
        .await;
    assert!(refused.contains("only move forward"), "{refused}");
    db.cleanup().await.expect("remove TempDb");

    let db = legacy_v22_that_has_traded().await;
    db.migrate_through(23).await.expect("023 applies");
    let refused = db
        .exec_err("UPDATE auth_enrollment SET state = 'virgin'")
        .await;
    assert!(refused.contains("only move forward"), "{refused}");
    db.cleanup().await.expect("remove TempDb");
}

/// `initialized` requires BOTH facts, and the enrolled user must be an owner of
/// that store.
#[tokio::test]
async fn an_initialized_store_names_an_owner_of_its_own_store_at_a_known_time() {
    let db = TempDb::new().await;

    // Missing either fact.
    assert!(!db
        .exec_err("UPDATE auth_enrollment SET state = 'initialized'")
        .await
        .is_empty());
    assert!(!db
        .exec_err(
            "UPDATE auth_enrollment
                SET state = 'initialized', initialized_at = '2026-11-08T00:00:00.000Z'"
        )
        .await
        .is_empty());

    // A cashier cannot be the enrolled owner.
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('cashier-1', '{STORE}', 'Sami', 'cashier')"
    ))
    .await;
    let refused = db
        .exec_err(
            "UPDATE auth_enrollment
                SET state = 'initialized',
                    initialized_at = '2026-11-08T00:00:00.000Z',
                    initialized_user_id = 'cashier-1'",
        )
        .await;
    assert!(
        refused.contains("owner of this store"),
        "a cashier must not be enrollable as the owner: {refused}"
    );

    // Another store's owner cannot either.
    db.exec(
        "INSERT INTO stores (id, name, legal_name, default_currency)
         VALUES ('store-2', 'Branch', 'Branch SARL', 'USD')",
    )
    .await;
    db.exec(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('owner-2', 'store-2', 'Other Owner', 'owner')",
    )
    .await;
    let refused = db
        .exec_err(&format!(
            "UPDATE auth_enrollment
                SET state = 'initialized',
                    initialized_at = '2026-11-08T00:00:00.000Z',
                    initialized_user_id = 'owner-2'
              WHERE store_id = '{STORE}'"
        ))
        .await;
    assert!(
        refused.contains("owner of this store"),
        "another store's owner must not be enrollable here: {refused}"
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The credential
// ===========================================================================

/// A credential is all three parts or none, on INSERT and on UPDATE.
///
/// The UPDATE half is the one that matters and the one a first draft omits:
/// every credential this application ever writes arrives by UPDATE of an
/// existing `users` row, because 001 seeded the owner and Stage B creates staff
/// through a command that sets the credential afterwards.
#[tokio::test]
async fn a_credential_is_a_hash_an_algorithm_and_a_date_or_nothing() {
    let db = TempDb::new().await;

    for partial in [
        "UPDATE users SET pin_hash = 'x'",
        "UPDATE users SET credential_algo = 'argon2id'",
        "UPDATE users SET credential_set_at = '2026-11-08T00:00:00.000Z'",
        "UPDATE users SET pin_hash = 'x', credential_algo = 'argon2id'",
        "UPDATE users SET pin_hash = 'x', credential_set_at = '2026-11-08T00:00:00.000Z'",
    ] {
        let refused = db.exec_err(partial).await;
        assert!(
            refused.contains("hash plus an algorithm plus a date"),
            "partial credential must be refused: {partial} (got {refused})"
        );
    }

    for partial_insert in [
        format!(
            "INSERT INTO users (id, store_id, full_name, role, pin_hash)
             VALUES ('u-a', '{STORE}', 'A', 'cashier', 'x')"
        ),
        format!(
            "INSERT INTO users (id, store_id, full_name, role, credential_algo)
             VALUES ('u-b', '{STORE}', 'B', 'cashier', 'argon2id')"
        ),
    ] {
        assert!(!db.exec_err(&partial_insert).await.is_empty());
    }

    // The complete form is accepted, and so is clearing all three.
    db.exec(&format!(
        "UPDATE users
            SET pin_hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
                credential_algo = 'argon2id',
                credential_version = 1,
                credential_set_at = '2026-11-08T00:00:00.000Z'
          WHERE id = '{OWNER}'"
    ))
    .await;
    db.exec(&format!(
        "UPDATE users SET pin_hash = NULL, credential_algo = NULL, credential_set_at = NULL
          WHERE id = '{OWNER}'"
    ))
    .await;

    db.cleanup().await.expect("remove TempDb");
}

/// Only Argon2id, and the counters stay in range.
#[tokio::test]
async fn an_unsupported_algorithm_or_impossible_auth_state_is_refused() {
    let db = TempDb::new().await;

    for bad in [
        "UPDATE users SET pin_hash = 'x', credential_algo = 'md5', credential_set_at = '2026-11-08T00:00:00.000Z'",
        "UPDATE users SET pin_hash = 'x', credential_algo = 'bcrypt', credential_set_at = '2026-11-08T00:00:00.000Z'",
        "UPDATE users SET pin_hash = 'x', credential_algo = 'plaintext', credential_set_at = '2026-11-08T00:00:00.000Z'",
        "UPDATE users SET failed_attempts = -1",
        "UPDATE users SET must_change_pin = 2",
    ] {
        let refused = db.exec_err(bad).await;
        assert!(
            refused.contains("unsupported credential algorithm")
                || refused.contains("out-of-range"),
            "must be refused: {bad} (got {refused})"
        );
    }

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Recovery
// ===========================================================================

/// ONE live recovery code per store, enforced by the engine.
#[tokio::test]
async fn a_store_cannot_hold_two_live_recovery_codes() {
    let db = TempDb::new().await;

    db.exec(&format!(
        "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at)
         VALUES ('r1', '{STORE}', 'h1', 'argon2id', '2026-11-08T00:00:00.000Z')"
    ))
    .await;

    let refused = db
        .exec_err(&format!(
            "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at)
             VALUES ('r2', '{STORE}', 'h2', 'argon2id', '2026-11-08T01:00:00.000Z')"
        ))
        .await;
    assert!(
        refused.to_ascii_lowercase().contains("unique"),
        "two live codes must be refused by the index: {refused}"
    );

    // Spend the first and the replacement is allowed — which is exactly what
    // `auth_recover_owner` does, in one transaction.
    db.exec("UPDATE owner_recovery SET used_at = '2026-11-08T02:00:00.000Z' WHERE id = 'r1'")
        .await;
    db.exec(&format!(
        "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at)
         VALUES ('r2', '{STORE}', 'h2', 'argon2id', '2026-11-08T03:00:00.000Z')"
    ))
    .await;

    assert_eq!(
        db.count("SELECT count(*) AS n FROM owner_recovery WHERE used_at IS NULL")
            .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A SPENT CODE IS SPENT. `used_at` is set once and can never be cleared, and
/// the secret itself is immutable.
#[tokio::test]
async fn a_spent_recovery_code_can_never_be_made_live_again() {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO owner_recovery (id, store_id, code_hash, code_algo, issued_at, used_at)
         VALUES ('r1', '{STORE}', 'h1', 'argon2id',
                 '2026-11-08T00:00:00.000Z', '2026-11-08T01:00:00.000Z')"
    ))
    .await;

    for attempt in [
        "UPDATE owner_recovery SET used_at = NULL WHERE id = 'r1'",
        "UPDATE owner_recovery SET used_at = '2026-11-09T00:00:00.000Z' WHERE id = 'r1'",
        "UPDATE owner_recovery SET code_hash = 'mine' WHERE id = 'r1'",
        "UPDATE owner_recovery SET code_algo = 'md5' WHERE id = 'r1'",
        "UPDATE owner_recovery SET issued_at = '2020-01-01T00:00:00.000Z' WHERE id = 'r1'",
        "UPDATE owner_recovery SET store_id = 'other' WHERE id = 'r1'",
        "DELETE FROM owner_recovery WHERE id = 'r1'",
    ] {
        let refused = db.exec_err(attempt).await;
        assert!(
            !refused.is_empty(),
            "must be refused: {attempt} (got {refused})"
        );
    }

    // Throttling state IS writable — it has to be, to count attempts.
    db.exec("UPDATE owner_recovery SET attempts = 1 WHERE id = 'r1'")
        .await;
    db.exec(
        "UPDATE owner_recovery SET locked_until = '2026-11-08T02:00:00.000Z' WHERE id = 'r1'",
    )
    .await;

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The audit log
// ===========================================================================

/// `auth_audit` is append-only, in any state, like `supplier_ledger` (006).
#[tokio::test]
async fn the_audit_log_takes_no_update_and_no_delete() {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, event, user_id, detail)
         VALUES ('a1', '{STORE}', 'login_failed', '{OWNER}', 'wrong passphrase')"
    ))
    .await;

    for attempt in [
        "UPDATE auth_audit SET detail = 'nothing to see' WHERE id = 'a1'",
        "UPDATE auth_audit SET event = 'login_ok' WHERE id = 'a1'",
        "UPDATE auth_audit SET user_id = NULL WHERE id = 'a1'",
        "DELETE FROM auth_audit WHERE id = 'a1'",
        "DELETE FROM auth_audit",
    ] {
        let refused = db.exec_err(attempt).await;
        assert!(
            refused.contains("append-only"),
            "must be refused: {attempt} (got {refused})"
        );
    }

    assert_eq!(db.count("SELECT count(*) AS n FROM auth_audit").await, 1);
    db.cleanup().await.expect("remove TempDb");
}

/// An audit row names users of its OWN store, both subject and actor.
#[tokio::test]
async fn an_audit_row_cannot_be_filed_against_another_stores_user() {
    let db = TempDb::new().await;
    db.exec(
        "INSERT INTO stores (id, name, legal_name, default_currency)
         VALUES ('store-2', 'Branch', 'Branch SARL', 'USD')",
    )
    .await;
    db.exec(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('owner-2', 'store-2', 'Other Owner', 'owner')",
    )
    .await;

    let refused = db
        .exec_err(&format!(
            "INSERT INTO auth_audit (id, store_id, event, user_id)
             VALUES ('a1', '{STORE}', 'login_ok', 'owner-2')"
        ))
        .await;
    assert!(refused.contains("own store"), "{refused}");

    let refused = db
        .exec_err(&format!(
            "INSERT INTO auth_audit (id, store_id, event, user_id, actor_user_id)
             VALUES ('a2', '{STORE}', 'credential_reset', '{OWNER}', 'owner-2')"
        ))
        .await;
    assert!(refused.contains("own store"), "{refused}");

    // An attempt against an UNKNOWN identifier is still recorded — the row
    // names no user and puts what was typed in `detail`. This is the case a
    // NOT NULL `user_id` would have made unrecordable.
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, event, user_id, detail)
         VALUES ('a3', '{STORE}', 'login_failed', NULL, 'unknown user id offered')"
    ))
    .await;
    assert_eq!(db.count("SELECT count(*) AS n FROM auth_audit").await, 1);

    db.cleanup().await.expect("remove TempDb");
}

/// The event vocabulary is fixed, so a typo cannot create a silent new class of
/// security event that no report counts.
#[tokio::test]
async fn an_unknown_audit_event_is_refused() {
    let db = TempDb::new().await;
    for bad in ["logon", "LOGIN_OK", "", "sale_posted"] {
        let refused = db
            .exec_err(&format!(
                "INSERT INTO auth_audit (id, store_id, event)
                 VALUES ('x-{bad}', '{STORE}', '{bad}')"
            ))
            .await;
        assert!(!refused.is_empty(), "`{bad}` must be refused");
    }

    // Stage B's vocabulary is already admissible, so widening a CHECK on this
    // table — which would mean a rebuild — is never needed.
    for ok in [
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
            "INSERT INTO auth_audit (id, store_id, event) VALUES ('ok-{ok}', '{STORE}', '{ok}')"
        ))
        .await;
    }

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Structural
// ===========================================================================

/// 023 is registered, and the registered list is what the startup gate demands.
#[tokio::test]
async fn migration_023_is_registered_and_is_the_newest() {
    assert_eq!(
        crate::test_support::latest_migration_version(),
        23,
        "023 must be the newest migration"
    );
    assert!(crate::migrations().iter().any(|m| m.version == 23
        && m.description == "authentication"));

    // And a fully migrated database satisfies `db_init`'s completeness proof,
    // which is what lets GZ-WAL-01's startup gate open.
    let db = TempDb::new().await;
    crate::db_init::require_complete_migrations(db.pool())
        .await
        .expect("a v23 database must satisfy the startup completeness check");
    db.cleanup().await.expect("remove TempDb");
}

/// Migrations 001–022 are untouched by 023.
///
/// Asserted by CHECKSUM rather than by reading the files: sqlx records each
/// applied migration's checksum, so a v22 database that then applies 023 must
/// still carry byte-identical checksums for everything before it. If 023 had
/// been written as an edit to an earlier file, this is what would catch it.
#[tokio::test]
async fn applying_023_does_not_disturb_any_earlier_migration() {
    let db = TempDb::at_schema_version(22).await;

    let before: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(db.pool())
            .await
            .expect("read the v22 history");
    assert_eq!(before.len(), 22);

    db.migrate_through(23).await.expect("023 applies");

    let after: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(db.pool())
            .await
            .expect("read the v23 history");
    assert_eq!(after.len(), 23);
    assert_eq!(
        before,
        after[..22].to_vec(),
        "023 changed the recorded checksum of an earlier migration"
    );
    assert!(
        after.iter().all(|(_, c)| !c.is_empty()),
        "every migration must record a checksum"
    );

    db.cleanup().await.expect("remove TempDb");
}
