//! GATE 2B STAGE A.1 — authentication, enrollment, sessions, locking, recovery.
//!
//! These tests drive the PRODUCTION functions — `status_inner`,
//! `enroll_owner_inner`, `login_inner`, `unlock_inner`,
//! `change_credential_inner`, `recover_owner_inner` — against brand-new
//! disposable `TempDb` databases, with the one-time enrollment code file
//! pointed at a temporary directory. The `#[tauri::command]` wrappers above
//! them do nothing but check the window, resolve the context and delegate, and
//! `the_command_wrappers_take_no_security_decision` asserts they stay that way.
//!
//! No protected identity is opened and no real credential is ever created: every
//! passphrase here is a synthetic test value.

use std::time::Instant;

use crate::auth::{
    change_credential_inner, enroll_owner_inner, login_inner, lock_inner, logout_inner,
    recover_owner_inner, require_primary_window_label, status_inner, testing, unlock_inner,
    AuthCtx, Role, SessionState,
};
use crate::test_support::TempDb;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";

const GOOD_PASSPHRASE: &str = "copper-kettle-olive-tree";
const OTHER_PASSPHRASE: &str = "another-good-long-phrase";

/// A disposable scratch directory for the enrollment code file, so nothing is
/// written anywhere near a real application identity.
struct Scratch {
    dir: std::path::PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("greaz-a1-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Self { dir }
    }
    fn code_file(&self) -> std::path::PathBuf {
        self.dir.join("FIRST-RUN-ENROLLMENT-CODE.txt")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Read the enrollment code out of the file the application wrote, the way the
/// installer would read it off the screen.
fn code_from_file(scratch: &Scratch) -> String {
    let body = std::fs::read_to_string(scratch.code_file()).expect("the code file must exist");
    for line in body.lines() {
        if let Some(rest) = line.trim().strip_prefix("Enrollment code:") {
            return rest.trim().to_string();
        }
    }
    panic!("the code file does not contain an enrollment code:\n{body}");
}

/// Bring a fresh database to the point where enrollment is possible, and return
/// the code the installer would type.
async fn ready_to_enroll(db: &TempDb, scratch: &Scratch) -> (SessionState, String) {
    let sessions = SessionState::new();
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    let status = status_inner(&ctx, &sessions).await.expect("status");
    assert_eq!(status.enrollment_state, "virgin");
    assert!(status.session.is_none());
    assert!(
        status.enrollment_code_file.is_some(),
        "the status must tell the installer where the code is"
    );

    let code = code_from_file(scratch);
    (sessions, code)
}

/// A fully enrolled shop, signed in as the owner.
async fn enrolled(db: &TempDb, scratch: &Scratch) -> SessionState {
    let (sessions, code) = ready_to_enroll(db, scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("enrollment");
    sessions
}

// ===========================================================================
// Enrollment
// ===========================================================================

/// THE VIRGIN CEREMONY, end to end.
#[tokio::test]
async fn a_virgin_installation_enrolls_its_owner_once_and_is_then_initialized() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let (sessions, code) = ready_to_enroll(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    let result = enroll_owner_inner(
        &ctx,
        &sessions,
        code.clone(),
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("enrollment must succeed with the right code");

    // Terminal state, a named owner, a recovery code shown once.
    assert_eq!(result.status.enrollment_state, "initialized");
    assert!(
        !result.recovery_code.trim().is_empty(),
        "a recovery code must be issued and shown once"
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT initialized_user_id FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        OWNER
    );

    // The credential is a real Argon2id PHC string, and it is NOT the
    // passphrase. Asserted by value, because "we hashed it" is the one claim
    // that must never be taken on trust.
    let stored = db
        .scalar_string(&format!("SELECT pin_hash FROM users WHERE id = '{OWNER}'"))
        .await;
    assert!(
        stored.starts_with("$argon2id$"),
        "the stored credential must be an Argon2id PHC string, got: {stored}"
    );
    assert!(!stored.contains(GOOD_PASSPHRASE));
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT credential_algo FROM users WHERE id = '{OWNER}'"
        ))
        .await,
        "argon2id"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT credential_version FROM users WHERE id = '{OWNER}'"
        ))
        .await,
        testing::credential_version()
    );

    // The enrollment code is spent: the hash is cleared and the file is gone.
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM auth_enrollment WHERE enrollment_code_hash IS NOT NULL"
        )
        .await,
        0
    );
    assert!(
        !scratch.code_file().exists(),
        "the one-time code file must be removed once it has been used"
    );

    // The owner is signed in, and the recovery code is stored only as a hash.
    assert!(result.status.session.is_some());
    let recovery_hash = db
        .scalar_string("SELECT code_hash FROM owner_recovery WHERE used_at IS NULL")
        .await;
    assert!(recovery_hash.starts_with("$argon2id$"));
    assert!(!recovery_hash.contains(&result.recovery_code));

    // And it cannot be done twice, with the same code or a fresh attempt.
    let again = enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await;
    assert!(
        again.is_err_and(|e| e.contains("already has an owner")),
        "enrollment must be single-use"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A WRONG OR EXPIRED CODE IS REFUSED, counted, and eventually locked out.
///
/// Persistent throttling, not in-memory: the counter is read back out of the
/// database between attempts, because an in-memory counter is cleared by
/// restarting the application.
#[tokio::test]
async fn wrong_enrollment_codes_are_counted_in_the_database_and_lock_out() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let (sessions, _code) = ready_to_enroll(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    for expected in 1..=4 {
        let refused = enroll_owner_inner(
            &ctx,
            &sessions,
            "WRONG-CODE-ENTIRELY".to_string(),
            OWNER.to_string(),
            GOOD_PASSPHRASE.to_string(),
        )
        .await
        .expect_err("a wrong code must be refused");
        assert!(refused.contains("wrong or has expired"), "{refused}");
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT enrollment_attempts FROM auth_enrollment WHERE store_id = '{STORE}'"
            ))
            .await,
            expected,
            "the attempt must be persisted, not counted in memory"
        );
        // Nothing was created.
        assert_eq!(
            db.count("SELECT count(*) AS n FROM users WHERE pin_hash IS NOT NULL")
                .await,
            0
        );
        assert_eq!(
            db.scalar_string(&format!(
                "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
            ))
            .await,
            "virgin"
        );
    }

    // The fifth locks it.
    let locked = enroll_owner_inner(
        &ctx,
        &sessions,
        "WRONG-AGAIN".to_string(),
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("the fifth attempt must lock out");
    assert!(locked.contains("fifteen minutes"), "{locked}");
    assert!(
        db.count(&format!(
            "SELECT count(*) AS n FROM auth_enrollment
              WHERE store_id = '{STORE}' AND enrollment_locked_until IS NOT NULL"
        ))
        .await
            == 1
    );

    // And while locked, even the RIGHT code is refused — otherwise the lockout
    // is decoration.
    let code = code_from_file(&scratch);
    let still = enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("the lockout must hold against a correct code too");
    assert!(still.contains("Too many wrong enrollment codes"), "{still}");

    // Every failure is audited.
    assert!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'enrollment_failed'")
            .await
            >= 5
    );

    db.cleanup().await.expect("remove TempDb");
}

/// Enrollment refuses anything that is not an active OWNER of this shop, and
/// the chosen account is never inferred.
#[tokio::test]
async fn enrollment_refuses_a_cashier_an_inactive_owner_and_another_shops_owner() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();

    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('cashier-1', '{STORE}', 'Sami', 'cashier')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role, active)
         VALUES ('owner-off', '{STORE}', 'Retired Owner', 'owner', 0)"
    ))
    .await;
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

    let (sessions, code) = ready_to_enroll(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    for (who, expected) in [
        ("cashier-1", "Only an owner account"),
        ("owner-off", "not active"),
        ("owner-2", "another shop"),
        ("nobody-at-all", "does not exist"),
    ] {
        let refused = enroll_owner_inner(
            &ctx,
            &sessions,
            code.clone(),
            who.to_string(),
            GOOD_PASSPHRASE.to_string(),
        )
        .await
        .expect_err("must be refused");
        assert!(
            refused.contains(expected),
            "enrolling `{who}` should mention `{expected}`, got: {refused}"
        );
        assert_eq!(
            db.scalar_string(&format!(
                "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
            ))
            .await,
            "virgin",
            "a refused enrollment must change nothing"
        );
    }

    db.cleanup().await.expect("remove TempDb");
}

/// MULTIPLE ACTIVE OWNERS: the choice is the installer's, and nothing is
/// selected automatically.
///
/// This is the defect Stage A.1 exists to remove. `activeContext.ts` picked
/// "the oldest active owner" with an `ORDER BY ... LIMIT 1`, so on a shop with
/// two owner rows the application simply decided which one it was. Enrollment
/// takes an explicit `user_id`, so both are enrollable and neither is default.
#[tokio::test]
async fn with_two_active_owners_the_installer_chooses_and_nothing_is_automatic() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role, created_at)
         VALUES ('owner-second', '{STORE}', 'Second Owner', 'owner',
                 '2020-01-01T00:00:00.000Z')"
    ))
    .await;

    let (sessions, code) = ready_to_enroll(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    // Both appear as candidates, so the screen can offer the choice.
    let status = status_inner(&ctx, &sessions).await.expect("status");
    let owners: Vec<_> = status
        .accounts
        .iter()
        .filter(|a| a.role == Role::Owner)
        .collect();
    assert_eq!(owners.len(), 2, "both owner rows must be offered");
    assert!(
        owners.iter().all(|a| !a.has_credential && !a.can_sign_in),
        "neither owner can sign in before enrollment"
    );

    // The SECOND one — the one the old ORDER BY would NOT have chosen, since it
    // sorts first by created_at and would have been picked silently — is
    // enrolled because the installer named it.
    enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        "owner-second".to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("the named owner is enrolled");

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT initialized_user_id FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "owner-second"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users WHERE id = '{OWNER}' AND pin_hash IS NULL"
        ))
        .await,
        1,
        "the owner the installer did NOT choose must be left alone"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A LEGACY shop — one that traded before authentication existed — enrolls
/// through the same ceremony, and its history is untouched.
#[tokio::test]
async fn a_legacy_shop_enrolls_without_disturbing_its_history() {
    let db = TempDb::at_schema_version(22).await;
    crate::test_support::seed_exchange_rate(&db).await;
    let rate = db
        .scalar_string(&format!(
            "SELECT id FROM exchange_rates WHERE store_id = '{STORE}' LIMIT 1"
        ))
        .await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('sh', '{STORE}', '{OWNER}', '2026-06-01T08:00:00.000Z', 'open', 0, 0)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sales (id, store_id, shift_id, cashier_user_id, receipt_number,
                            exchange_rate_lbp_per_usd, exchange_rate_id,
                            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                            discount_cents, cogs_total_cents, cogs_method, status)
         VALUES ('old-sale', '{STORE}', 'sh', '{OWNER}', 7, 89500, '{rate}',
                 900, 99, 999, 0, 0, 'weighted_average', 'draft')"
    ))
    .await;
    db.exec(
        "UPDATE sales SET status = 'posted', posted_at = '2026-06-01T09:00:00.000Z'
          WHERE id = 'old-sale'",
    )
    .await;

    db.migrate_through(23).await.expect("023 applies");

    let scratch = Scratch::new();
    let sessions = SessionState::new();
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    let status = status_inner(&ctx, &sessions).await.expect("status");
    assert_eq!(
        status.enrollment_state, "legacy_pending",
        "a shop with takings must not be offered first-time bootstrap"
    );

    let code = code_from_file(&scratch);
    enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("legacy enrollment");

    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "initialized"
    );
    // The history is exactly as it was.
    assert_eq!(
        db.scalar_i64("SELECT receipt_number FROM sales WHERE id = 'old-sale'")
            .await,
        7
    );
    assert_eq!(
        db.scalar_string("SELECT cashier_user_id FROM sales WHERE id = 'old-sale'")
            .await,
        OWNER
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A RESTORED, ALREADY-INITIALIZED DATABASE DOES NOT RE-OFFER BOOTSTRAP — even
/// with the credential cleared.
///
/// This is the scenario the state machine was designed for, and it is worth
/// stating what it models: a shop restores last night's backup, or a support
/// engineer clears a forgotten passphrase directly in the file. Under a design
/// that inferred "needs bootstrap" from `pin_hash IS NULL`, either of those
/// would hand the shop to whoever launched Greaz next.
#[tokio::test]
async fn a_restored_initialized_database_never_offers_bootstrap_again() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    // Simulate the support reset: the credential is gone from the file.
    db.exec(&format!(
        "UPDATE users SET pin_hash = NULL, credential_algo = NULL, credential_set_at = NULL
          WHERE id = '{OWNER}'"
    ))
    .await;
    sessions.clear_for_tests().await;

    let status = status_inner(&ctx, &sessions).await.expect("status");
    assert_eq!(
        status.enrollment_state, "initialized",
        "clearing the hash must NOT re-arm first-time bootstrap"
    );
    assert!(
        status.enrollment_code_file.is_none(),
        "no enrollment code should be offered for an initialized shop"
    );
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM auth_enrollment WHERE enrollment_code_hash IS NOT NULL"
        )
        .await,
        0,
        "and no code should have been minted"
    );

    let refused = enroll_owner_inner(
        &ctx,
        &sessions,
        "anything".to_string(),
        OWNER.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("enrollment must be refused on an initialized shop");
    assert!(refused.contains("already has an owner"), "{refused}");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Login
// ===========================================================================

#[tokio::test]
async fn the_right_passphrase_signs_in_and_the_wrong_one_does_not() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    logout_inner(&ctx, &sessions).await.expect("logout");
    assert!(status_inner(&ctx, &sessions).await.unwrap().session.is_none());

    let wrong = login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        "not-the-passphrase".to_string(),
    )
    .await
    .expect_err("a wrong passphrase must be refused");
    assert!(wrong.contains("not right"), "{wrong}");
    assert!(status_inner(&ctx, &sessions).await.unwrap().session.is_none());

    let ok = login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("the right passphrase signs in");
    let session = ok.session.expect("a session");
    assert_eq!(session.user_id, OWNER);
    assert_eq!(session.role, Role::Owner);
    assert!(!session.locked);

    db.cleanup().await.expect("remove TempDb");
}

/// AN UNKNOWN ACCOUNT AND A WRONG PASSPHRASE GIVE THE SAME ANSWER.
///
/// Both the sentence and, as far as a test can check it, the time: an unknown
/// account performs a full dummy verification so the response does not say
/// which account ids are real. The timing assertion is deliberately generous —
/// it is asserting that the dummy verify HAPPENS, not a precise duration, since
/// a loaded CI machine cannot promise one.
#[tokio::test]
async fn an_unknown_account_is_indistinguishable_from_a_wrong_passphrase() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    logout_inner(&ctx, &sessions).await.expect("logout");

    let start = Instant::now();
    let unknown = login_inner(
        &ctx,
        &sessions,
        "no-such-account".to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("unknown account");
    let unknown_took = start.elapsed();

    let start = Instant::now();
    let wrong = login_inner(&ctx, &sessions, OWNER.to_string(), "wrong".to_string())
        .await
        .expect_err("wrong passphrase");
    let wrong_took = start.elapsed();

    assert_eq!(
        unknown, wrong,
        "the two refusals must read identically, or the message is an account oracle"
    );

    // The unknown path must have done real hashing work. One tenth of the
    // wrong-passphrase path is a very loose floor and still worlds away from
    // the microseconds an early return would take.
    assert!(
        unknown_took * 10 > wrong_took,
        "an unknown account returned far too quickly ({unknown_took:?} vs {wrong_took:?}), \
         so the response time discloses which accounts exist"
    );

    // The unknown attempt is still audited, with no user attached.
    assert!(
        db.count(
            "SELECT count(*) AS n FROM auth_audit
              WHERE event = 'login_failed' AND user_id IS NULL"
        )
        .await
            >= 1
    );

    db.cleanup().await.expect("remove TempDb");
}

/// PERSISTENT THROTTLING: the counter survives a restart, because it is a
/// column and not a variable.
#[tokio::test]
async fn failed_logins_are_counted_in_the_database_and_lock_the_account() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    logout_inner(&ctx, &sessions).await.expect("logout");

    let limit = testing::max_failed_attempts();
    for n in 1..limit {
        let _ = login_inner(&ctx, &sessions, OWNER.to_string(), "wrong".to_string()).await;
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT failed_attempts FROM users WHERE id = '{OWNER}'"
            ))
            .await,
            n
        );
        assert_eq!(
            db.count(&format!(
                "SELECT count(*) AS n FROM users
                  WHERE id = '{OWNER}' AND locked_until IS NOT NULL"
            ))
            .await,
            0,
            "must not lock before the limit"
        );
    }

    // The one that locks it.
    let _ = login_inner(&ctx, &sessions, OWNER.to_string(), "wrong".to_string()).await;
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users
              WHERE id = '{OWNER}' AND locked_until IS NOT NULL"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'locked_out'")
            .await,
        1
    );

    // AND THE CORRECT PASSPHRASE IS REFUSED WHILE LOCKED. A lockout that the
    // right answer walks through is not a lockout.
    let locked = login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("the lockout must hold against the right passphrase");
    assert!(locked.contains("locked"), "{locked}");

    // Clearing the lock lets the right passphrase through and resets the count.
    db.exec(&format!(
        "UPDATE users SET locked_until = NULL WHERE id = '{OWNER}'"
    ))
    .await;
    login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("a correct sign-in after the lock expires");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT failed_attempts FROM users WHERE id = '{OWNER}'"
        ))
        .await,
        0,
        "a successful sign-in clears the counter"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A SECOND LOGIN OVER A LIVE SESSION IS REFUSED.
///
/// Switching user is a deliberate logout then login. Replacing a live session
/// silently would strand whatever the first user was part-way through — a cart,
/// an open shift, a frozen checkout attempt — under somebody else's name.
#[tokio::test]
async fn a_user_switch_requires_a_deliberate_logout() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    let refused = login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("a second login over a live session must be refused");
    assert!(refused.contains("already signed in"), "{refused}");

    logout_inner(&ctx, &sessions).await.expect("logout");
    login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("after a deliberate logout, signing in works");

    db.cleanup().await.expect("remove TempDb");
}

/// Stage A.1's release boundary: only the owner may sign in.
#[tokio::test]
async fn a_manager_or_cashier_cannot_sign_in_in_this_stage() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    logout_inner(&ctx, &sessions).await.expect("logout");

    // Give a manager and a cashier real credentials, so the refusal is about
    // the ROLE and not about a missing passphrase.
    let hash = testing::hash(GOOD_PASSPHRASE);
    for (id, name, role) in [
        ("mgr-1", "Mona", "manager"),
        ("csh-1", "Sami", "cashier"),
    ] {
        db.exec(&format!(
            "INSERT INTO users (id, store_id, full_name, role, pin_hash,
                                credential_algo, credential_version, credential_set_at)
             VALUES ('{id}', '{STORE}', '{name}', '{role}', '{hash}',
                     'argon2id', 1, '2026-11-08T00:00:00.000Z')"
        ))
        .await;

        let refused = login_inner(&ctx, &sessions, id.to_string(), GOOD_PASSPHRASE.to_string())
            .await
            .expect_err("only the owner may sign in at this stage");
        assert!(
            refused.contains("only be used by the owner"),
            "the refusal must explain the stage boundary: {refused}"
        );
    }

    // The status says so, so the screen can explain it rather than looking
    // broken.
    let status = status_inner(&ctx, &sessions).await.expect("status");
    assert!(status.login_restricted_to_owner);
    for account in &status.accounts {
        if account.role == Role::Owner {
            assert!(account.can_sign_in, "the owner can sign in");
        } else {
            assert!(
                !account.can_sign_in,
                "{:?} must be marked unusable in this stage",
                account.role
            );
        }
    }

    // The owner still can.
    login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("the owner signs in");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Sessions, locking, F5
// ===========================================================================

/// AN F5 DOES NOT SIGN THE OPERATOR OUT, and a LOCKED session comes back
/// locked.
///
/// The renderer's state dies on a reload; the Rust session does not. `App.tsx`
/// rediscovers it through `auth_status`, which is modelled here by calling the
/// status function again with the same `SessionState` — exactly what a reload
/// does.
#[tokio::test]
async fn a_reload_rediscovers_the_session_and_a_locked_one_stays_locked() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    // "F5": ask again, get the same session.
    let after_reload = status_inner(&ctx, &sessions).await.expect("status");
    let session = after_reload.session.expect("the session survives a reload");
    assert_eq!(session.user_id, OWNER);
    assert!(!session.locked);

    lock_inner(&ctx, &sessions).await.expect("lock");

    // "F5" again: still there, still locked.
    let after_reload = status_inner(&ctx, &sessions).await.expect("status");
    let session = after_reload
        .session
        .expect("a locked session survives a reload");
    assert!(
        session.locked,
        "a reload must not clear the lock — otherwise F5 is the unlock button"
    );
    assert_eq!(session.idle_seconds_remaining, 0);

    db.cleanup().await.expect("remove TempDb");
}

/// IDLE LOCKING IS ENFORCED IN RUST, on a monotonic clock.
#[tokio::test]
async fn an_idle_session_locks_itself_and_blocks_the_database() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    // While active, the gate opens.
    sessions
        .ensure_signed_in()
        .await
        .expect("an active session may use the database");

    sessions.force_idle_for_tests().await;

    let refused = sessions
        .ensure_signed_in()
        .await
        .expect_err("an idle session must be refused");
    assert!(refused.contains("LOCKED"), "{refused}");

    // It LOCKED rather than expiring: the session is still there, so the cart
    // and the open shift are still there.
    let status = status_inner(&ctx, &sessions).await.expect("status");
    let session = status
        .session
        .expect("an idle session must LOCK, not vanish — vanishing loses the cart");
    assert!(session.locked);
    assert_eq!(session.user_id, OWNER);

    // And it stays refused until somebody unlocks it, rather than coming back
    // to life on the next call.
    assert!(sessions.ensure_signed_in().await.is_err());

    unlock_inner(&ctx, &sessions, GOOD_PASSPHRASE.to_string())
        .await
        .expect("unlock");
    sessions
        .ensure_signed_in()
        .await
        .expect("after unlocking, the database is available again");

    db.cleanup().await.expect("remove TempDb");
}

/// `auth_touch` DEFERS a live session's lock and CANNOT REVIVE AN EXPIRED ONE.
///
/// GZ-A1-P1, found by independent review, and this test is the REVERSAL of the
/// one that blessed the defect. The first version asserted that touching an
/// already-expired session reset the clock — which is what the code did, and
/// which was an authentication bypass:
///
///   * the idle lock is LATCHED, not computed, so a session that has passed the
///     limit is not `locked` until something consults the gate or the status;
///   * `auth_touch` runs on ordinary pointer and key events and touches no
///     database, so it is the most frequent caller there is;
///   * so an owner who left an unlocked till past the limit — after a
///     sleep/resume, or a throttled background timer — had the clock reset by
///     the first touch of the screen and traded on without re-entering
///     anything, and repeated calls could hold the session open for ever.
///
/// Three cases, and the middle one is the finding.
#[tokio::test]
async fn touching_defers_a_live_session_and_cannot_revive_an_expired_one() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    // 1. A LIVE session is deferred. Touching is still useful.
    sessions
        .touch_for_tests()
        .await
        .expect("a live session may be deferred");
    sessions.ensure_signed_in().await.expect("and remains usable");

    // 2. AN EXPIRED-BUT-NOT-YET-LATCHED SESSION IS REFUSED, and touching
    //    LATCHES the lock rather than undoing it. Nothing has consulted the
    //    gate since the clock was moved, so `locked` is still false when
    //    `touch` is called — which is exactly the window the defect lived in.
    sessions.force_idle_for_tests().await;
    let refused = sessions
        .touch_for_tests()
        .await
        .expect_err("an expired session must NOT be touched back to life");
    assert!(refused.contains("LOCKED"), "{refused}");

    // It is now locked, and the database is closed to it.
    assert!(sessions.ensure_signed_in().await.is_err());
    assert!(
        status_inner(&ctx, &sessions)
            .await
            .unwrap()
            .session
            .expect("the session still exists — locking is not logging out")
            .locked
    );

    // And repeated touching cannot get it back.
    for _ in 0..5 {
        assert!(
            sessions.touch_for_tests().await.is_err(),
            "no number of touches may revive an expired session"
        );
    }

    // 3. Only the passphrase lifts it.
    unlock_inner(&ctx, &sessions, GOOD_PASSPHRASE.to_string())
        .await
        .expect("the passphrase unlocks");
    sessions
        .ensure_signed_in()
        .await
        .expect("usable again after unlocking");
    sessions
        .touch_for_tests()
        .await
        .expect("and deferrable again");

    db.cleanup().await.expect("remove TempDb");
}

/// EVERY expiry decision goes through one helper, so the three entry points
/// cannot drift apart again.
///
/// The defect above existed because `touch` evaluated the limit differently
/// from `ensure_signed_in` — or rather, did not evaluate it at all. This pins
/// the single-source-of-truth shape, because a behavioural test can only cover
/// the entry points somebody remembered to write one for.
#[test]
fn the_idle_limit_is_evaluated_in_exactly_one_place() {
    let src = include_str!("../auth.rs");

    assert_eq!(
        src.matches("fn latch_expiry(").count(),
        1,
        "there must be exactly one expiry decision"
    );

    // The raw comparison appears ONLY inside it. Anywhere else is a second
    // opinion about when a session has expired.
    assert_eq!(
        src.matches("last_seen.elapsed() >= IDLE_LOCK_AFTER").count(),
        1,
        "the idle comparison must appear only inside `latch_expiry`"
    );

    for caller in ["async fn ensure_signed_in(", "async fn snapshot(", "async fn touch("] {
        let after = src
            .split(caller)
            .nth(1)
            .unwrap_or_else(|| panic!("{caller} not found"));
        let body = &after[..after.find("\n    }").unwrap_or(after.len())];
        assert!(
            body.contains("latch_expiry"),
            "{caller} must evaluate the idle limit through `latch_expiry`"
        );
    }
}

/// Credential attempts are SERIALISED, so a fan-out of guesses cannot outrun
/// the persisted counter.
///
/// GZ-A1-P2 (independent review). Each attempt reads the count, spends ~250 ms
/// in Argon2id, then writes count + 1. Twenty simultaneous wrong guesses all
/// read the same count and all write the same value, so the attacker gets
/// twenty tries for one recorded failure and can postpone the lockout
/// indefinitely in batches. The counter was doing exactly what it was designed
/// to do and being lapped.
///
/// Pinned with a multi-thread runtime, because this is the one test here that
/// would pass by accident on a single-threaded one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_wrong_passphrases_are_all_counted() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = std::sync::Arc::new(enrolled(&db, &scratch).await);
    {
        let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
        logout_inner(&ctx, &sessions).await.expect("logout");
    }

    let attempts: i64 = 20;
    let mut handles = Vec::new();
    for n in 0..attempts {
        let pool = db.pool().clone();
        let code_file = scratch.code_file();
        let sessions = sessions.clone();
        handles.push(tokio::spawn(async move {
            let ctx = AuthCtx::for_tests(&pool, code_file);
            login_inner(&ctx, &sessions, OWNER.to_string(), format!("wrong-{n}")).await
        }));
    }
    for h in handles {
        let outcome = h.await.expect("task");
        assert!(outcome.is_err(), "a wrong passphrase must never sign in");
    }

    // THE COUNTER REACHED THE LOCKOUT THRESHOLD AND STOPPED THERE, which is
    // the property, and it is worth being exact about why 5 is the right answer
    // and not 20.
    //
    // Serialised, the attempts queue: each reads the counter the previous one
    // wrote. The fifth trips the lockout, and attempts six to twenty are then
    // refused by the lockout check BEFORE they verify anything or touch the
    // counter — which is correct, and is what a lockout is for.
    //
    // UNSERIALISED, all twenty would read 0, all twenty would verify, and all
    // twenty would write 1. The account would never lock and the attacker would
    // have had twenty free guesses. So the assertion that distinguishes the two
    // is "the counter reached the threshold", not "the counter equals twenty".
    let limit = testing::max_failed_attempts();
    let counted = db
        .scalar_i64(&format!(
            "SELECT failed_attempts FROM users WHERE id = '{OWNER}'"
        ))
        .await;
    assert_eq!(
        counted, limit,
        "{attempts} concurrent failures must drive the counter to the lockout \
         threshold ({limit}); a value near 1 means they all read the same \
         counter and lapped it"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users
              WHERE id = '{OWNER}' AND locked_until IS NOT NULL"
        ))
        .await,
        1,
        "and the account must be locked, which is the thing the race postponed"
    );

    // Every attempt that got as far as verifying is audited, and every one that
    // was refused by the lockout is audited too — so the owner can see a
    // twenty-guess burst in the log rather than a single failure.
    let audited = db
        .count("SELECT count(*) AS n FROM auth_audit WHERE event = 'login_failed'")
        .await;
    assert_eq!(
        audited, attempts,
        "all {attempts} attempts must appear in the audit log, including the \
         ones the lockout refused"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'locked_out'")
            .await,
        1,
        "and the lockout itself is recorded exactly once"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// OWNERSHIP CAPTURE IS AUDITED IN THE SAME TRANSACTION AS THE CAPTURE.
///
/// GZ-A1-P2 (independent review). The credential, the terminal enrollment state
/// and the recovery code committed together, but `owner_enrolled` and
/// `credential_set` were written AFTERWARDS through the best-effort audit
/// helper — so a crash or an audit failure in between left a shop with a
/// captured owner and no record of the capture, which is the one state that
/// makes the ceremony's claim untrue.
#[tokio::test]
async fn the_ownership_capture_audit_commits_with_the_capture() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let _sessions = enrolled(&db, &scratch).await;

    for event in ["owner_enrolled", "credential_set"] {
        assert_eq!(
            db.count(&format!(
                "SELECT count(*) AS n FROM auth_audit WHERE event = '{event}'"
            ))
            .await,
            1,
            "{event} must be recorded"
        );
    }
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "initialized"
    );

    // THE STRUCTURAL HALF, because a test cannot crash the process between two
    // statements: the ownership-capture events are written with `audit_tx`,
    // which FAILS the transaction, and never with the best-effort `audit`.
    let src = include_str!("../auth.rs");
    for event in [
        "\"owner_enrolled\"",
        "\"credential_set\"",
        "\"recovery_used\"",
        "\"credential_reset\"",
    ] {
        // Find the call that passes this event name. The event also appears in
        // migration 023's CHECK list and in comments, so search the Rust source
        // for the call shape specifically.
        let mut found_in_tx = false;
        for (i, _) in src.match_indices(event) {
            let before = &src[..i];
            if let Some(call) = before.rfind("audit") {
                if before[call..].starts_with("audit_tx") {
                    found_in_tx = true;
                    break;
                }
            }
        }
        assert!(
            found_in_tx,
            "{event} must be written with `audit_tx`, so a failure to record \
             ownership capture refuses the capture itself"
        );
    }

    db.cleanup().await.expect("remove TempDb");
}

/// Two simultaneous first-run status calls issue exactly ONE enrollment code.
///
/// GZ-A1-P2 (independent review). Both could see no live code, both would write
/// their plaintext to the file, and the later writer's plaintext could end up
/// beside the earlier writer's hash — a code the installer can read and the
/// database will not accept, for twenty-four hours, with no way for a later
/// status call to notice.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_first_run_status_calls_issue_one_code() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = std::sync::Arc::new(SessionState::new());

    let mut handles = Vec::new();
    for _ in 0..6 {
        let pool = db.pool().clone();
        let code_file = scratch.code_file();
        let sessions = sessions.clone();
        handles.push(tokio::spawn(async move {
            let ctx = AuthCtx::for_tests(&pool, code_file);
            status_inner(&ctx, &sessions)
                .await
                .map(|s| s.enrollment_state)
        }));
    }
    for h in handles {
        let state = h.await.expect("task").expect("status must succeed");
        assert_eq!(state, "virgin");
    }

    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'enrollment_code_issued'")
            .await,
        1,
        "exactly one code should have been issued"
    );

    // THE CODE IN THE FILE IS THE CODE THE DATABASE WILL ACCEPT. That is the
    // property the race broke, and the only way to test it is to use the code.
    let code = code_from_file(&scratch);
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("the code in the file must be the one on file");

    db.cleanup().await.expect("remove TempDb");
}

/// UNLOCKING VERIFIES THE SAME PERSON — not merely a valid credential.
///
/// The lock screen protects the session of whoever walked away. Accepting
/// anybody's valid passphrase would make it a different person's session, with
/// their cart, their shift and their name on the next receipt.
#[tokio::test]
async fn only_the_locked_users_own_passphrase_unlocks_the_screen() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    // A second owner with a DIFFERENT valid passphrase.
    let other_hash = testing::hash(OTHER_PASSPHRASE);
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role, pin_hash,
                            credential_algo, credential_version, credential_set_at)
         VALUES ('owner-2', '{STORE}', 'Second Owner', 'owner', '{other_hash}',
                 'argon2id', 1, '2026-11-08T00:00:00.000Z')"
    ))
    .await;

    lock_inner(&ctx, &sessions).await.expect("lock");

    let refused = unlock_inner(&ctx, &sessions, OTHER_PASSPHRASE.to_string())
        .await
        .expect_err("another user's valid passphrase must not unlock this session");
    assert!(refused.contains("not right"), "{refused}");
    assert!(
        status_inner(&ctx, &sessions)
            .await
            .unwrap()
            .session
            .unwrap()
            .locked,
        "a failed unlock leaves it locked"
    );

    unlock_inner(&ctx, &sessions, GOOD_PASSPHRASE.to_string())
        .await
        .expect("the locked user's own passphrase unlocks it");

    // The failed attempt was counted against the right account and audited.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'unlock_failed'")
            .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A session whose account is deactivated while locked cannot be unlocked, and
/// is destroyed rather than left half-valid.
#[tokio::test]
async fn a_session_locked_when_the_account_is_disabled_cannot_be_unlocked() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    lock_inner(&ctx, &sessions).await.expect("lock");
    db.exec(&format!("UPDATE users SET active = 0 WHERE id = '{OWNER}'"))
        .await;

    let refused = unlock_inner(&ctx, &sessions, GOOD_PASSPHRASE.to_string())
        .await
        .expect_err("a deactivated account cannot unlock");
    assert!(refused.contains("no longer active"), "{refused}");
    assert!(
        status_inner(&ctx, &sessions).await.unwrap().session.is_none(),
        "the session must be destroyed, not left locked and un-unlockable"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A SECOND WINDOW INHERITS NO AUTHORITY.
#[test]
fn only_the_primary_window_may_act_as_a_signed_in_user() {
    require_primary_window_label("main").expect("the primary window is allowed");

    for stranger in ["", "devtools", "main2", "Main", "plugin-window", "secondary"] {
        let refused = require_primary_window_label(stranger)
            .expect_err("a non-primary window must have no authority");
        assert!(
            refused.contains("no authority"),
            "window `{stranger}`: {refused}"
        );
    }
}

// ===========================================================================
// Recovery
// ===========================================================================

/// THE RECOVERY CODE WORKS ONCE, re-arms, and resets the passphrase without
/// touching the enrollment state.
#[tokio::test]
async fn a_recovery_code_resets_the_owner_once_and_issues_a_replacement() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let (sessions, code) = ready_to_enroll(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    let enrolled = enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("enrollment");
    let recovery = enrolled.recovery_code;

    logout_inner(&ctx, &sessions).await.expect("logout");

    let recovered = recover_owner_inner(
        &ctx,
        &sessions,
        recovery.clone(),
        OWNER.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect("the recovery code resets the passphrase");

    // A replacement code was issued, and it is a different one.
    assert!(!recovered.recovery_code.trim().is_empty());
    assert_ne!(recovered.recovery_code, recovery);
    assert_eq!(
        db.count("SELECT count(*) AS n FROM owner_recovery WHERE used_at IS NULL")
            .await,
        1,
        "exactly one live code afterwards"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM owner_recovery").await,
        2,
        "the spent code is kept as evidence"
    );

    // The state did NOT go backwards.
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT state FROM auth_enrollment WHERE store_id = '{STORE}'"
        ))
        .await,
        "initialized"
    );
    assert_eq!(recovered.status.enrollment_state, "initialized");

    // Recovery does not sign anybody in: the new passphrase must be proved.
    assert!(recovered.status.session.is_none());
    login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect("the new passphrase works");
    logout_inner(&ctx, &sessions).await.expect("logout");
    assert!(
        login_inner(
            &ctx,
            &sessions,
            OWNER.to_string(),
            GOOD_PASSPHRASE.to_string()
        )
        .await
        .is_err(),
        "the old passphrase must no longer work"
    );

    // AND THE SPENT CODE IS DEAD.
    let reused = recover_owner_inner(
        &ctx,
        &sessions,
        recovery,
        OWNER.to_string(),
        "a-third-long-passphrase".to_string(),
    )
    .await
    .expect_err("a spent recovery code must not work again");
    assert!(reused.contains("not right"), "{reused}");

    assert!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'recovery_used'")
            .await
            == 1
    );

    db.cleanup().await.expect("remove TempDb");
}

/// Recovery is throttled, cannot promote a non-owner, and reveals no hash.
#[tokio::test]
async fn recovery_is_throttled_and_cannot_make_a_cashier_the_owner() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    logout_inner(&ctx, &sessions).await.expect("logout");

    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('csh-1', '{STORE}', 'Sami', 'cashier')"
    ))
    .await;

    // Wrong codes are counted and eventually lock out.
    for n in 1..=4 {
        let refused = recover_owner_inner(
            &ctx,
            &sessions,
            "WRONG".to_string(),
            OWNER.to_string(),
            OTHER_PASSPHRASE.to_string(),
        )
        .await
        .expect_err("a wrong recovery code must be refused");
        assert!(!refused.contains("$argon2id$"), "no hash may be disclosed");
        assert_eq!(
            db.scalar_i64("SELECT attempts FROM owner_recovery WHERE used_at IS NULL")
                .await,
            n
        );
    }
    let _ = recover_owner_inner(
        &ctx,
        &sessions,
        "WRONG".to_string(),
        OWNER.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await;
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM owner_recovery
              WHERE used_at IS NULL AND locked_until IS NOT NULL"
        )
        .await,
        1,
        "the recovery code must lock out after too many attempts"
    );

    // And the owner's credential never changed through any of it.
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users WHERE id = '{OWNER}' AND pin_hash IS NOT NULL"
        ))
        .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A cashier cannot be the subject of a recovery, even with the right code.
#[tokio::test]
async fn a_recovery_code_cannot_be_used_to_promote_a_cashier() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let (sessions, code) = ready_to_enroll(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());
    let recovery = enroll_owner_inner(
        &ctx,
        &sessions,
        code,
        OWNER.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect("enrollment")
    .recovery_code;
    logout_inner(&ctx, &sessions).await.expect("logout");

    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('csh-1', '{STORE}', 'Sami', 'cashier')"
    ))
    .await;

    let refused = recover_owner_inner(
        &ctx,
        &sessions,
        recovery,
        "csh-1".to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("a cashier must not be recoverable as the owner");
    assert!(refused.contains("owner account of this shop"), "{refused}");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM users WHERE id = 'csh-1' AND pin_hash IS NOT NULL")
            .await,
        0
    );
    // The code was NOT spent by the refused attempt.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM owner_recovery WHERE used_at IS NULL")
            .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Changing a passphrase
// ===========================================================================

#[tokio::test]
async fn changing_a_passphrase_needs_the_current_one_and_a_live_session() {
    let db = TempDb::new().await;
    let scratch = Scratch::new();
    let sessions = enrolled(&db, &scratch).await;
    let ctx = AuthCtx::for_tests(db.pool(), scratch.code_file());

    let wrong = change_credential_inner(
        &ctx,
        &sessions,
        "not-current".to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("the current passphrase is required");
    assert!(wrong.contains("not your current passphrase"), "{wrong}");

    let same = change_credential_inner(
        &ctx,
        &sessions,
        GOOD_PASSPHRASE.to_string(),
        GOOD_PASSPHRASE.to_string(),
    )
    .await
    .expect_err("the new passphrase must differ");
    assert!(same.contains("same as the old one"), "{same}");

    let weak = change_credential_inner(
        &ctx,
        &sessions,
        GOOD_PASSPHRASE.to_string(),
        "short".to_string(),
    )
    .await
    .expect_err("the strength rule applies to a change too");
    assert!(weak.contains("at least"), "{weak}");

    change_credential_inner(
        &ctx,
        &sessions,
        GOOD_PASSPHRASE.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect("a valid change");

    logout_inner(&ctx, &sessions).await.expect("logout");
    login_inner(
        &ctx,
        &sessions,
        OWNER.to_string(),
        OTHER_PASSPHRASE.to_string(),
    )
    .await
    .expect("the new passphrase works");

    // A LOCKED session cannot change the credential — it is the one change that
    // would let somebody lock the real owner out of their own shop.
    lock_inner(&ctx, &sessions).await.expect("lock");
    let refused = change_credential_inner(
        &ctx,
        &sessions,
        OTHER_PASSPHRASE.to_string(),
        "yet-another-long-phrase".to_string(),
    )
    .await
    .expect_err("a locked session must not be able to change the passphrase");
    assert!(refused.contains("LOCKED"), "{refused}");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The gates
// ===========================================================================

/// NOTHING TOUCHES THE DATABASE BEFORE SIGN-IN — not a write, and not a read.
#[tokio::test]
async fn the_session_gate_closes_both_the_write_pool_and_the_read_channel() {
    let db = TempDb::new().await;
    let state = crate::posting::DbState::new();
    state.mark_startup_ready().await;
    let reads = crate::read_api::ReadPool::new();
    let sessions = SessionState::new();

    // No session: both chokepoints refuse, and NOTHING is opened.
    let write_refused = crate::posting::pool_for_state(&state, &sessions, db.path())
        .await
        .expect_err("the write pool must be refused with no session");
    assert!(write_refused.contains("LOCKED"), "{write_refused}");
    assert!(
        state.pool.lock().await.is_none(),
        "a refused acquisition must not have opened a pool"
    );

    let read_refused =
        crate::read_api::read_pool_for_state(&state, &sessions, &reads, db.path())
            .await
            .expect_err("the read channel must be refused with no session");
    assert!(read_refused.contains("LOCKED"), "{read_refused}");
    assert!(
        reads.pool.lock().await.is_none(),
        "a refused read must not have opened a read pool"
    );

    // Signed in: both work.
    sessions.open_for_tests(OWNER, STORE, Role::Owner).await;
    crate::posting::pool_for_state(&state, &sessions, db.path())
        .await
        .expect("a signed-in session may write");
    crate::read_api::read_pool_for_state(&state, &sessions, &reads, db.path())
        .await
        .expect("a signed-in session may read");

    // Locked: both refuse again, and the pools that are already open are not
    // torn down — an in-flight operation must not be killed mid-transaction.
    sessions.lock_for_tests().await.expect("lock");
    assert!(crate::posting::pool_for_state(&state, &sessions, db.path())
        .await
        .is_err());
    assert!(
        crate::read_api::read_pool_for_state(&state, &sessions, &reads, db.path())
            .await
            .is_err()
    );
    assert!(
        state.pool.lock().await.is_some(),
        "locking must not close a pool an operation may still be using"
    );

    // Release both pools in the order `lib.rs`'s exit path uses — read-only
    // first, because only a writable connection can perform SQLite's final
    // checkpoint — then remove the database.
    if let Some(read) = reads.pool.lock().await.take() {
        read.close().await;
    }
    state.close_pool().await;
    db.cleanup().await.expect("remove TempDb");
}

/// THE STARTUP GATE STILL COMES FIRST, and authentication does not bypass it.
///
/// A credential verified against a database that failed its own integrity
/// checks is a credential verified against nothing. So `pool_for_authentication`
/// requires GZ-WAL-01's validation to have passed, and reports the STARTUP
/// fault rather than "please sign in" — those two refusals send the operator to
/// different places.
#[tokio::test]
async fn authentication_cannot_bypass_the_startup_gate() {
    let db = TempDb::new().await;

    // Pending.
    let pending = crate::posting::DbState::new();
    let refused = crate::posting::pool_for_authentication(&pending, db.path())
        .await
        .expect_err("authentication must wait for startup validation");
    assert!(
        refused.contains("still checking the database"),
        "the pending refusal must be the STARTUP one: {refused}"
    );
    assert!(pending.pool.lock().await.is_none());

    // Failed.
    let failed = crate::posting::DbState::new();
    failed
        .mark_startup_failed("GREAZ CANNOT TRADE — synthetic startup failure for this test")
        .await;
    let refused = crate::posting::pool_for_authentication(&failed, db.path())
        .await
        .expect_err("authentication must be refused after a failed startup");
    assert!(refused.contains("GREAZ CANNOT TRADE"), "{refused}");
    assert!(
        failed.pool.lock().await.is_none(),
        "a refused authentication must not re-create the database file"
    );

    // Ready.
    let ready = crate::posting::DbState::new();
    ready.mark_startup_ready().await;
    crate::posting::pool_for_authentication(&ready, db.path())
        .await
        .expect("a validated database may be authenticated against");

    // Windows will not delete a file that still has an open handle, so the
    // pool this test opened has to be released before the database can be
    // removed. `close_pool` is the same release the failed-startup path uses.
    ready.close_pool().await;
    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Structural guards
// ===========================================================================

/// The command wrappers take no security decision, so nothing is beyond the
/// reach of the tests above.
#[test]
fn the_command_wrappers_take_no_security_decision() {
    let src = include_str!("../auth.rs");
    // Bounded at BOTH ends. The first version of this test took everything
    // after the marker, which swept in the `#[cfg(test)]` accessor module at
    // the end of the file and failed on its own helpers — a test that was
    // measuring the wrong region rather than a wrapper that was doing too much.
    let (_, after) = src
        .split_once("// The Tauri command surface")
        .expect("the command section must be marked");
    let (commands, _) = after
        .split_once("// Test-only accessors")
        .expect("the command section must END before the test-only accessors");

    // Every command is generated by the one macro, or is `auth_touch`, which
    // touches no database. A hand-written command would be a place a check
    // could live that no test could reach.
    let handwritten = commands.matches("#[tauri::command]").count();
    assert_eq!(
        handwritten, 2,
        "expected exactly two `#[tauri::command]` attributes in the wrapper section \
         (one in the macro, one for auth_touch); a third means a command was written \
         by hand and may hold logic the tests cannot drive"
    );

    for forbidden in [
        "verify_secret",
        "hash_secret",
        "check_secret_strength",
        "UPDATE users",
        "INSERT INTO auth_audit",
    ] {
        assert!(
            !commands.contains(forbidden),
            "the wrapper section must not contain `{forbidden}` — it belongs in an \
             `_inner` function a test can call"
        );
    }
}

/// `pool_for_authentication` has exactly one non-test caller: `auth.rs`.
///
/// It is the only accessor that may open the database with nobody signed in, so
/// a second caller would be a second unauthenticated route to the data.
#[test]
fn only_the_auth_module_uses_the_authentication_pool_accessor() {
    let mut callers = Vec::new();
    for (name, src) in [
        ("auth.rs", include_str!("../auth.rs")),
        ("posting.rs", include_str!("../posting.rs")),
        ("read_api.rs", include_str!("../read_api.rs")),
        ("admin.rs", include_str!("../admin.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        ("db_init.rs", include_str!("../db_init.rs")),
        ("lib.rs", include_str!("../lib.rs")),
    ] {
        // The definition itself lives in posting.rs; count only CALLS.
        let calls = src.matches("pool_for_authentication(").count()
            - src
                .matches("pub(crate) async fn pool_for_authentication(")
                .count();
        if calls > 0 {
            callers.push((name, calls));
        }
    }

    assert_eq!(
        callers.len(),
        1,
        "exactly one module may call the authentication pool accessor, found: {callers:?}"
    );
    assert_eq!(callers[0].0, "auth.rs");
}

/// The three pool accessors are distinct, and each one's privilege is visible
/// in its name. Asserted so that a future refactor cannot collapse them.
#[test]
fn the_three_pool_accessors_remain_distinct() {
    let src = include_str!("../posting.rs");
    for required in [
        "pub(crate) async fn pool_for_state(",
        "pub(crate) async fn pool_for_authentication(",
        "pub(crate) async fn pool_for_startup_validation(",
    ] {
        assert!(src.contains(required), "missing accessor: {required}");
    }

    // The gated one checks BOTH gates, and in the documented order.
    let gated = src
        .split("pub(crate) async fn pool_for_state(")
        .nth(1)
        .expect("pool_for_state body");
    let body = &gated[..gated.find("\n}").expect("end of fn")];
    let startup = body
        .find("ensure_trading_allowed")
        .expect("pool_for_state must consult the startup gate");
    let session = body
        .find("ensure_signed_in")
        .expect("pool_for_state must consult the session gate");
    assert!(
        startup < session,
        "the startup gate must be consulted BEFORE the session gate, so a failed \
         startup reports itself rather than asking for a passphrase"
    );

    // The authentication one bypasses the session gate and NOT the startup one.
    let auth = src
        .split("pub(crate) async fn pool_for_authentication(")
        .nth(1)
        .expect("pool_for_authentication body");
    let body = &auth[..auth.find("\n}").expect("end of fn")];
    assert!(
        body.contains("ensure_trading_allowed"),
        "the authentication accessor must still require a validated database"
    );
    assert!(
        !body.contains("ensure_signed_in"),
        "the authentication accessor must bypass the session gate — that is its job"
    );
}

/// THE sqlx BEHAVIOUR THAT CAUSED A REAL DEFECT IN THIS MODULE, pinned.
///
/// `try_get::<String, _>` on a SQL NULL in sqlx-sqlite returns `Ok("")` — it
/// does NOT return an error. So the natural-looking
/// `row.try_get("pin_hash").ok()` produces `Some("")` for an account with no
/// credential, and `pin_hash.is_some()` then reads as "this account already has
/// a passphrase".
///
/// That is not hypothetical: it is the defect the first run of these tests
/// found. Enrollment refused every fresh owner with "That account already has a
/// passphrase", and the same mistake one layer along would have had
/// `verify_secret` comparing a real passphrase against `""`.
///
/// `load_user` now decodes every nullable column as an explicit `Option`. This
/// test exists so the optimistic version is never re-derived: it MEASURES the
/// engine's behaviour rather than assuming it, which is this codebase's rule
/// for anything it has already been caught out by once.
#[tokio::test]
async fn a_sql_null_text_column_decodes_as_an_empty_string_not_an_error() {
    let db = TempDb::new().await;
    let sql = format!("SELECT pin_hash FROM users WHERE id = '{OWNER}'");

    // Explicit Option: NULL is None. This is what the module uses.
    let as_option: Option<String> = sqlx::query_scalar(&sql)
        .fetch_one(db.pool())
        .await
        .expect("an explicit Option decodes a NULL");
    assert_eq!(as_option, None, "an explicit Option is unambiguous");

    // Bare String: NULL becomes "". THIS is the trap.
    let as_string: Result<String, _> = sqlx::query_scalar(&sql).fetch_one(db.pool()).await;
    assert_eq!(
        as_string.as_deref().ok(),
        Some(""),
        "sqlx-sqlite decodes a NULL TEXT column into `String` as the EMPTY STRING          rather than erroring. If this ever changes, `auth::optional_text` and the          comment in `load_user` can be simplified — until then they are load-bearing."
    );

    // And the consequence, stated as an assertion: the naive form is `Some("")`.
    let naive: Option<String> = as_string.ok();
    assert!(
        naive.is_some(),
        "the naive decode yields Some(\"\") for a NULL, which is why `optional_text` exists"
    );

    db.cleanup().await.expect("remove TempDb");
}
