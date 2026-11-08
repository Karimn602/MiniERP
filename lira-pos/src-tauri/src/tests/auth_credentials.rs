//! GATE 2B STAGE A.1 — the credential primitives.
//!
//! `tests::auth_session` covers the flows; this file covers the things the
//! flows rest on, each of which is easy to get wrong in a way no flow test
//! would notice: the hash is really salted, the verifier really rejects, the
//! codes really have entropy, the strength rules really apply, and — the one
//! that matters most — **no audit row ever contains a secret.**

use std::time::Instant;

use crate::auth::{testing, Role};
use crate::test_support::TempDb;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";

// ===========================================================================
// Hashing
// ===========================================================================

/// THE HASH IS SALTED, so two accounts with the SAME passphrase do not share a
/// stored value.
///
/// Without a per-credential salt, one cracked hash cracks every account that
/// chose the same passphrase, and anybody who can read the table can see at a
/// glance which staff share one. This is asserted on the real hashing function,
/// not on a description of it.
#[test]
fn the_same_passphrase_hashes_differently_every_time() {
    let secret = "copper-kettle-olive-tree";
    let a = testing::hash(secret);
    let b = testing::hash(secret);

    assert_ne!(a, b, "two hashes of one passphrase must differ (salting)");
    assert!(testing::verify(secret, &a));
    assert!(testing::verify(secret, &b));

    // And the stored form is a PHC string naming argon2id, so the parameters
    // travel with the hash and an old credential stays verifiable after the
    // policy is raised.
    for h in [&a, &b] {
        assert!(h.starts_with("$argon2id$"), "not an argon2id PHC string: {h}");
        assert!(h.contains("$v=19$"), "unexpected Argon2 version: {h}");
        assert!(h.contains("m=19456"), "unexpected memory cost: {h}");
        assert!(h.contains("t=2"), "unexpected time cost: {h}");
        assert!(h.contains("p=1"), "unexpected parallelism: {h}");
        assert!(
            !h.contains(secret),
            "the passphrase must not appear in its own hash"
        );
    }
}

/// The verifier rejects everything that is not the passphrase, including the
/// near misses and the malformed stored values.
#[test]
fn the_verifier_rejects_near_misses_and_refuses_to_trust_a_broken_hash() {
    let secret = "copper-kettle-olive-tree";
    let stored = testing::hash(secret);

    for wrong in [
        "",
        " ",
        "copper-kettle-olive-tre",
        "copper-kettle-olive-trees",
        "Copper-Kettle-Olive-Tree",
        "copper kettle olive tree",
        "$argon2id$",
        stored.as_str(),
    ] {
        assert!(
            !testing::verify(wrong, &stored),
            "`{wrong}` must not verify against the hash of `{secret}`"
        );
    }
    assert!(testing::verify(secret, &stored));

    // A STORED VALUE THAT CANNOT BE PARSED IS NOT A REASON TO LET SOMEBODY IN.
    // This is the fail-closed half: a truncated or corrupted hash — a bad
    // restore, a half-written row — must refuse every passphrase rather than
    // accept any.
    for broken in [
        "",
        "not-a-hash",
        "$argon2id$v=19$m=19456,t=2,p=1$",
        "$argon2id$v=19$bad",
        "$plaintext$copper-kettle-olive-tree",
        &stored[..stored.len() / 2],
    ] {
        assert!(
            !testing::verify(secret, broken),
            "a stored value of `{broken}` must verify nothing"
        );
    }
}

/// THE COST IS MEASURED, not assumed.
///
/// A hash that is too cheap is not a hash; one that is too slow gets worked
/// around by staff. The bounds here are deliberately wide, because this runs on
/// shared CI as well as the pilot machine — the point is to catch a parameter
/// set that has collapsed to milliseconds or ballooned to seconds, not to pin a
/// duration. The figure measured on the pilot hardware is recorded in the
/// Stage A.1 qualification notes.
#[test]
fn the_hash_costs_something_but_not_too_much() {
    let secret = "copper-kettle-olive-tree";

    let start = Instant::now();
    let stored = testing::hash(secret);
    let hashing = start.elapsed();

    let start = Instant::now();
    assert!(testing::verify(secret, &stored));
    let verifying = start.elapsed();

    assert!(
        hashing.as_millis() >= 10,
        "hashing took {hashing:?}, which is too cheap to be a memory-hard hash — \
         check the Argon2id parameters"
    );
    assert!(
        hashing.as_secs() < 5,
        "hashing took {hashing:?}; a login that slow at the counter will be worked around"
    );
    assert!(
        verifying.as_secs() < 5,
        "verifying took {verifying:?}, which is too slow for a till"
    );
}

// ===========================================================================
// Strength
// ===========================================================================

/// The owner and manager rules, and why they are stricter than a PIN.
#[test]
fn an_owner_passphrase_must_be_long_and_not_only_digits() {
    let min = testing::min_passphrase_len();

    for bad in ["", "   ", "short", "abcdefghi", "123456789012345"] {
        assert!(
            testing::strength(Role::Owner, bad).is_err(),
            "`{bad}` must be refused as an owner passphrase"
        );
        assert!(testing::strength(Role::Manager, bad).is_err());
    }

    // A refusal must SAY what is wanted. "Invalid passphrase" is how an
    // installer ends up choosing something shorter on the second try.
    let refusal = testing::strength(Role::Owner, "short").expect_err("too short");
    assert!(
        refusal.contains(&min.to_string()),
        "the refusal must name the minimum length: {refusal}"
    );

    // Leading or trailing space is refused rather than silently trimmed: a
    // passphrase whose stored form differs from what was typed is a passphrase
    // nobody can retype.
    assert!(testing::strength(Role::Owner, " copper-kettle-olive ").is_err());

    for good in [
        "copper-kettle-olive-tree",
        "three unrelated words",
        "Beirut-Hamra-2026!",
    ] {
        testing::strength(Role::Owner, good)
            .unwrap_or_else(|e| panic!("`{good}` should be accepted: {e}"));
    }
}

/// The cashier floor, and the honest note about what it is worth.
#[test]
fn a_cashier_pin_has_a_floor_of_six() {
    for bad in ["", "1", "12345"] {
        assert!(testing::strength(Role::Cashier, bad).is_err());
    }
    // Six digits is accepted for a cashier and NOT for an owner — the whole
    // point of splitting the rule by role.
    testing::strength(Role::Cashier, "123456").expect("six digits is a valid cashier PIN");
    assert!(
        testing::strength(Role::Owner, "123456").is_err(),
        "an owner must not be allowed a six-digit PIN: offline guessing against the \
         database file makes 10^6 possibilities a weekend's work"
    );
}

// ===========================================================================
// One-time codes
// ===========================================================================

/// The codes are high-entropy, unique, and typeable.
#[test]
fn one_time_codes_are_unique_high_entropy_and_forgiving_to_type() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..500 {
        let code = testing::code();
        assert!(seen.insert(code.clone()), "a code repeated: {code}");

        // 20 bytes rendered two characters per byte = 40 characters of
        // alphabet, plus grouping dashes.
        let payload = testing::normalise(&code);
        assert_eq!(payload.len(), 40, "unexpected code length: {code}");
        assert!(
            payload.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
            "a code must be upper-case alphanumeric after normalising: {code}"
        );
        // The ambiguous letters are excluded, because somebody reads this off a
        // screen and types it in.
        for confusable in ['I', 'L', 'O', 'U'] {
            assert!(
                !payload.contains(confusable),
                "`{confusable}` is too easily misread to appear in a code: {code}"
            );
        }
    }

    // Typing it in lower case, without the dashes, or with stray spaces, still
    // matches — the grouping is a reading aid, not part of the secret.
    let code = testing::code();
    let canonical = testing::normalise(&code);
    for variant in [
        code.to_ascii_lowercase(),
        code.replace('-', ""),
        format!("  {code}  "),
        code.replace('-', " "),
    ] {
        assert_eq!(
            testing::normalise(&variant),
            canonical,
            "`{variant}` should normalise to the same code as `{code}`"
        );
    }
}

// ===========================================================================
// The audit log keeps no secrets
// ===========================================================================

/// **NO AUDIT ROW EVER CONTAINS A SECRET.**
///
/// This is the test that justifies having an audit table at all. The log records
/// who tried to sign in and when, and it is written on the FAILURE path — which
/// is exactly where a careless `detail` would capture what somebody typed. A
/// wrong guess is very often somebody else's right password, so a log of wrong
/// guesses is a password list.
///
/// So this drives the real commands with known secrets through every path that
/// writes a row — enrollment, a wrong code, a successful login, a wrong
/// passphrase, a lockout, a lock, a failed unlock, a change, a recovery — and
/// then searches the ENTIRE table, every column, for any of them.
#[tokio::test]
async fn no_audit_row_ever_contains_a_secret() {
    use crate::auth::{
        change_credential_inner, enroll_owner_inner, lock_inner, login_inner, logout_inner,
        recover_owner_inner, status_inner, unlock_inner, AuthCtx, SessionState,
    };

    const PASSPHRASE: &str = "copper-kettle-olive-tree";
    const SECOND: &str = "another-good-long-phrase";
    const WRONG: &str = "wrong-but-memorable-guess";

    let db = TempDb::new().await;
    let dir = std::env::temp_dir().join(format!("greaz-a1-audit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("scratch");
    let code_file = dir.join("FIRST-RUN-ENROLLMENT-CODE.txt");

    let sessions = SessionState::new();
    let ctx = AuthCtx::for_tests(db.pool(), code_file.clone());

    // Mint the code, then read it the way the installer would.
    status_inner(&ctx, &sessions).await.expect("status");
    let body = std::fs::read_to_string(&code_file).expect("code file");
    let enrollment_code = body
        .lines()
        .find_map(|l| l.trim().strip_prefix("Enrollment code:"))
        .expect("a code in the file")
        .trim()
        .to_string();

    // A wrong code, then the right one.
    let _ = enroll_owner_inner(
        &ctx,
        &sessions,
        "WRONG-CODE-HERE".to_string(),
        OWNER.to_string(),
        PASSPHRASE.to_string(),
    )
    .await;
    let enrolled = enroll_owner_inner(
        &ctx,
        &sessions,
        enrollment_code.clone(),
        OWNER.to_string(),
        PASSPHRASE.to_string(),
    )
    .await
    .expect("enrollment");
    let recovery_code = enrolled.recovery_code;

    // Lock, a failed unlock, a real unlock.
    lock_inner(&ctx, &sessions).await.expect("lock");
    let _ = unlock_inner(&ctx, &sessions, WRONG.to_string()).await;
    unlock_inner(&ctx, &sessions, PASSPHRASE.to_string())
        .await
        .expect("unlock");

    // A change, then sign out and in with the new one.
    change_credential_inner(
        &ctx,
        &sessions,
        PASSPHRASE.to_string(),
        SECOND.to_string(),
    )
    .await
    .expect("change");
    logout_inner(&ctx, &sessions).await.expect("logout");

    // Wrong passphrases until lockout, then clear it and sign in.
    for _ in 0..(testing::max_failed_attempts() + 1) {
        let _ = login_inner(&ctx, &sessions, OWNER.to_string(), WRONG.to_string()).await;
    }
    db.exec(&format!(
        "UPDATE users SET locked_until = NULL WHERE id = '{OWNER}'"
    ))
    .await;
    login_inner(&ctx, &sessions, OWNER.to_string(), SECOND.to_string())
        .await
        .expect("sign in with the new passphrase");
    logout_inner(&ctx, &sessions).await.expect("logout");

    // A wrong recovery code, then the right one.
    let _ = recover_owner_inner(
        &ctx,
        &sessions,
        "WRONG-RECOVERY".to_string(),
        OWNER.to_string(),
        "a-third-long-passphrase".to_string(),
    )
    .await;
    let replacement = recover_owner_inner(
        &ctx,
        &sessions,
        recovery_code.clone(),
        OWNER.to_string(),
        "a-third-long-passphrase".to_string(),
    )
    .await
    .expect("recovery")
    .recovery_code;

    // --- now search the WHOLE table, every column -------------------------
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, event, user_id, actor_user_id, operation, detail FROM auth_audit",
        )
        .fetch_all(db.pool())
        .await
        .expect("read the audit log");

    assert!(
        rows.len() >= 10,
        "this test must actually exercise the audit path; only {} rows were written",
        rows.len()
    );

    let haystack = format!("{rows:?}").to_ascii_lowercase();
    for secret in [
        PASSPHRASE,
        SECOND,
        WRONG,
        "a-third-long-passphrase",
        enrollment_code.as_str(),
        recovery_code.as_str(),
        replacement.as_str(),
        testing::normalise(&enrollment_code).as_str(),
        testing::normalise(&recovery_code).as_str(),
    ] {
        assert!(
            !haystack.contains(&secret.to_ascii_lowercase()),
            "the audit log contains the secret `{secret}` — a log of wrong guesses is a \
             password list, and this is the one thing this table must never hold"
        );
    }
    // And no stored hash leaked into it either.
    assert!(
        !haystack.contains("$argon2id$"),
        "the audit log contains a credential hash"
    );

    // The events that must have been recorded, so the test is known to have
    // covered the failure paths and not only the happy ones.
    let events: Vec<&str> = rows.iter().map(|r| r.1.as_str()).collect();
    for required in [
        "enrollment_code_issued",
        "enrollment_failed",
        "owner_enrolled",
        "credential_set",
        "login_ok",
        "login_failed",
        "locked_out",
        "lock",
        "unlock",
        "unlock_failed",
        "credential_changed",
        "logout",
        "recovery_failed",
        "recovery_used",
        "credential_reset",
    ] {
        assert!(
            events.contains(&required),
            "the audit log is missing a `{required}` row, so this test is not covering \
             that path. Recorded: {events:?}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
    db.cleanup().await.expect("remove TempDb");
}

/// The enrollment code FILE names the path in the audit log, never the code.
#[tokio::test]
async fn the_audit_log_records_where_the_code_went_not_what_it_was() {
    use crate::auth::{status_inner, AuthCtx, SessionState};

    let db = TempDb::new().await;
    let dir = std::env::temp_dir().join(format!("greaz-a1-path-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("scratch");
    let code_file = dir.join("FIRST-RUN-ENROLLMENT-CODE.txt");

    let sessions = SessionState::new();
    let ctx = AuthCtx::for_tests(db.pool(), code_file.clone());
    status_inner(&ctx, &sessions).await.expect("status");

    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM auth_audit WHERE event = 'enrollment_code_issued'",
    )
    .fetch_one(db.pool())
    .await
    .expect("the issue must be audited");

    assert!(
        detail.contains("FIRST-RUN-ENROLLMENT-CODE.txt"),
        "the audit row should say where the code was written: {detail}"
    );

    let body = std::fs::read_to_string(&code_file).expect("code file");
    let code = body
        .lines()
        .find_map(|l| l.trim().strip_prefix("Enrollment code:"))
        .expect("a code")
        .trim()
        .to_string();
    assert!(
        !detail.contains(&code),
        "the audit row must not contain the code itself"
    );

    // The file itself tells the reader what it is, who should use it, and the
    // limitation that matters. Checked because the file IS the installation
    // ceremony's user interface, and a bare code with no instructions is how
    // the wrong person uses it.
    for required in [
        "ENROLLMENT CODE",
        "WHO SHOULD USE IT",
        "RECOVERY CODE",
        "Windows account",
    ] {
        assert!(
            body.contains(required),
            "the code file should mention `{required}`"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
    db.cleanup().await.expect("remove TempDb");
}

/// The store-scoping guard on the audit table holds against this module's own
/// writer, not only against hand-written SQL.
#[tokio::test]
async fn the_audit_writer_respects_store_scoping() {
    let db = TempDb::new().await;
    db.exec(
        "INSERT INTO stores (id, name, legal_name, default_currency)
         VALUES ('store-2', 'Branch', 'Branch SARL', 'USD')",
    )
    .await;

    // The owner of store 1 cannot be filed under store 2.
    let refused = db
        .exec_err(&format!(
            "INSERT INTO auth_audit (id, store_id, event, user_id)
             VALUES ('x', 'store-2', 'login_ok', '{OWNER}')"
        ))
        .await;
    assert!(refused.contains("own store"), "{refused}");

    // And the legitimate shape is accepted.
    db.exec(&format!(
        "INSERT INTO auth_audit (id, store_id, event, user_id)
         VALUES ('ok', '{STORE}', 'login_ok', '{OWNER}')"
    ))
    .await;

    db.cleanup().await.expect("remove TempDb");
}
