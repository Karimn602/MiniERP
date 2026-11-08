//! GATE 2B STAGE B.3 — staff administration.
//!
//! `users` had been a table nothing owned: migration 001 created it, seeded one
//! owner, and until now no command in the application wrote to it. So the only
//! way a shop acquired a second member of staff was somebody editing the
//! database file — which is exactly the route this gate exists to make
//! unnecessary.
//!
//! These commands are also what made it possible to lift
//! `LOGIN_RESTRICTED_TO_OWNER`. A staff row with no credential and no way to
//! acquire one is not an account, so lifting the restriction before this module
//! existed would have offered a login screen nobody but the owner could get
//! through.

use crate::auth::{Actor, Role};
use crate::test_support::TempDb;
use crate::users::*;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";
const MANAGER: &str = "00000000-0000-0000-0000-0000000000a1";
const CASHIER: &str = "00000000-0000-0000-0000-0000000000a2";

const PASSPHRASE: &str = "copper-kettle-olive-tree";

async fn staffed() -> TempDb {
    let db = TempDb::new().await;
    for (id, name, role) in [(MANAGER, "Mona", "manager"), (CASHIER, "Sami", "cashier")] {
        db.exec(&format!(
            "INSERT INTO users (id, store_id, full_name, role)
             VALUES ('{id}', '{STORE}', '{name}', '{role}')"
        ))
        .await;
    }
    db
}

/// Give somebody a credential directly, so a test can set up the state the
/// last-owner rule is about without going through the command under test.
///
/// Written as a hash-shaped value rather than through `set_user_credential_as`
/// where the point is only that the column is populated: the rule reads
/// `pin_hash IS NOT NULL` and nothing here signs in.
async fn give_credential(db: &TempDb, user_id: &str) {
    db.exec(&format!(
        "UPDATE users
            SET pin_hash = '$argon2id$v=19$m=19456,t=2,p=1$c2VlZA$c2VlZHNlZWRzZWVk',
                credential_algo = 'argon2id', credential_version = 1,
                credential_set_at = '2026-01-01T00:00:00.000Z'
          WHERE id = '{user_id}'"
    ))
    .await;
}

fn owner() -> Actor {
    Actor::for_tests(OWNER, STORE, Role::Owner)
}
fn manager() -> Actor {
    Actor::for_tests(MANAGER, STORE, Role::Manager)
}
fn cashier() -> Actor {
    Actor::for_tests(CASHIER, STORE, Role::Cashier)
}

fn save(user_id: &str, name: &str, role: &str) -> UserSaveArgs {
    UserSaveArgs {
        user_id: user_id.to_string(),
        full_name: name.to_string(),
        role: role.to_string(),
    }
}

// ===========================================================================
// The ordinary path
// ===========================================================================

/// THE WHOLE FLOW: the owner creates a cashier, gives them a passphrase, and
/// they can then sign in as themselves.
///
/// Asserted end to end because the three steps only mean something together: an
/// account with no credential cannot be used, and a credential set on no
/// account is nothing.
#[tokio::test]
async fn an_owner_creates_a_cashier_and_gives_them_a_first_passphrase() {
    let db = staffed().await;

    let id = users_save_as(db.pool(), &owner(), save("new-cashier", "Rami", "cashier"))
        .await
        .expect("an owner may create a cashier");
    assert_eq!(id, "new-cashier");

    // Created in the OWNER's shop, with no credential, so they cannot sign in
    // yet. That order is deliberate: the account is visible and marked as
    // unusable rather than created with a passphrase the owner has to
    // communicate before the person arrives.
    let staff = users_list_as(db.pool(), &owner()).await.expect("list");
    let made = staff.iter().find(|s| s.user_id == "new-cashier").expect("listed");
    assert_eq!(made.full_name, "Rami");
    assert_eq!(made.role, Role::Cashier);
    assert!(made.active);
    assert!(!made.has_credential, "a new account has no passphrase");
    assert!(!made.is_you);
    assert_eq!(
        db.scalar_string("SELECT store_id FROM users WHERE id = 'new-cashier'")
            .await,
        STORE,
        "created in the owner's own shop, which is never taken from the request"
    );

    // The owner sets the first passphrase.
    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: "new-cashier".to_string(),
            secret: "123456".to_string(),
        },
    )
    .await
    .expect("an owner may set a cashier's first PIN");

    let stored = db
        .scalar_string("SELECT pin_hash FROM users WHERE id = 'new-cashier'")
        .await;
    assert!(stored.starts_with("$argon2id$"), "{stored}");
    assert!(!stored.contains("123456"), "the PIN itself must not be stored");
    assert_eq!(
        db.scalar_i64("SELECT must_change_pin FROM users WHERE id = 'new-cashier'")
            .await,
        1,
        "the owner knows this secret — they just typed it — so it is temporary \
         by construction and the person is told to change it"
    );

    // And it is auditable: who was created, and who gave them a credential.
    for (event, subject) in [("user_created", "new-cashier"), ("credential_set", "new-cashier")] {
        assert_eq!(
            db.count(&format!(
                "SELECT count(*) AS n FROM auth_audit
                  WHERE event = '{event}' AND user_id = '{subject}'
                    AND actor_user_id = '{OWNER}'"
            ))
            .await,
            1,
            "{event} must be recorded against the owner who did it"
        );
    }

    db.cleanup().await.expect("remove TempDb");
}

/// A role change is recorded with what it was and what it became.
#[tokio::test]
async fn promoting_a_cashier_is_recorded_as_a_role_change() {
    let db = staffed().await;

    users_save_as(db.pool(), &owner(), save(CASHIER, "Sami", "manager"))
        .await
        .expect("an owner may promote a cashier");

    assert_eq!(
        db.scalar_string(&format!("SELECT role FROM users WHERE id = '{CASHIER}'"))
            .await,
        "manager"
    );
    let detail = db
        .scalar_string(&format!(
            "SELECT detail FROM auth_audit
              WHERE event = 'role_changed' AND user_id = '{CASHIER}'"
        ))
        .await;
    assert_eq!(
        detail, "cashier -> manager",
        "the log must say what the role was as well as what it became"
    );

    // Renaming alone is NOT a role change, so the log does not fill with them.
    users_save_as(db.pool(), &owner(), save(CASHIER, "Sami Haddad", "manager"))
        .await
        .expect("a rename");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'role_changed'")
            .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

/// Retiring is how somebody is stopped from using the till, and it does not
/// destroy their attribution.
#[tokio::test]
async fn retiring_a_cashier_stops_them_without_deleting_their_history() {
    let db = staffed().await;

    users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: CASHIER.to_string(),
            is_active: false,
        },
    )
    .await
    .expect("an owner may retire a cashier");

    assert_eq!(
        db.scalar_i64(&format!("SELECT active FROM users WHERE id = '{CASHIER}'"))
            .await,
        0
    );
    // THE ROW IS STILL THERE. It is referenced by every document that person
    // ever touched, and `active = 0` is how this schema has always said "not
    // usable" — deleting it to tidy up would be destroying the attribution on
    // real financial records.
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users WHERE id = '{CASHIER}'"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'user_deactivated'")
            .await,
        1
    );

    // And they can be brought back.
    users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: CASHIER.to_string(),
            is_active: true,
        },
    )
    .await
    .expect("and brought back");
    assert_eq!(
        db.scalar_i64(&format!("SELECT active FROM users WHERE id = '{CASHIER}'"))
            .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The shop must keep an owner
// ===========================================================================

/// THE LAST OWNER WHO CAN SIGN IN CANNOT BE RETIRED OR DEMOTED.
///
/// An application with no owner cannot be administered: nothing could create a
/// user, reset a credential or change a role, and the enrollment ceremony is
/// terminal so it cannot be re-run. The only way back would be somebody editing
/// the database file — the route this gate exists to make unnecessary. So the
/// COMMAND refuses it rather than the screen hiding it.
#[tokio::test]
async fn the_shops_last_usable_owner_cannot_be_removed() {
    let db = staffed().await;
    give_credential(&db, OWNER).await;

    // Retiring yourself is refused for its own reason first: you are signed in
    // to it.
    let refused = users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: OWNER.to_string(),
            is_active: false,
        },
    )
    .await
    .expect_err("you cannot retire the account you are using");
    assert!(refused.contains("your own account"), "{refused}");

    // Demoting the only owner is refused, and the message says why and what to
    // do about it.
    let refused = users_save_as(db.pool(), &owner(), save(OWNER, "Owner", "manager"))
        .await
        .expect_err("the only owner cannot be demoted");
    assert!(refused.contains("only owner who can sign in"), "{refused}");
    assert!(
        refused.contains("give them a passphrase first"),
        "the refusal must say what to do: {refused}"
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT role FROM users WHERE id = '{OWNER}'"))
            .await,
        "owner",
        "and nothing may have changed"
    );

    // With a second owner WHO CAN SIGN IN, both become possible — so the rule
    // is about the shop keeping an owner, not about protecting one row.
    users_save_as(db.pool(), &owner(), save("owner-2", "Second Owner", "owner"))
        .await
        .expect("a second owner");
    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: "owner-2".to_string(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect("and a passphrase for them");

    users_save_as(db.pool(), &owner(), save(OWNER, "Owner", "manager"))
        .await
        .expect("now the first owner may step down");
    assert_eq!(
        db.scalar_string(&format!("SELECT role FROM users WHERE id = '{OWNER}'"))
            .await,
        "manager"
    );

    // And the remaining one is now protected in turn.
    let actor2 = Actor::for_tests("owner-2", STORE, Role::Owner);
    let refused = users_save_as(db.pool(), &actor2, save("owner-2", "Second Owner", "cashier"))
        .await
        .expect_err("the last owner is protected whoever it is");
    assert!(refused.contains("only owner who can sign in"), "{refused}");

    db.cleanup().await.expect("remove TempDb");
}

/// AN OWNER WITH NO PASSPHRASE DOES NOT KEEP THE SHOP ADMINISTRABLE.
///
/// THE REGRESSION. An independent review of Stage B.3 found this, and the
/// original version of the test above CODIFIED it: the count was over active
/// owner ROWS, and a new account is deliberately created with no credential, so
/// the one supported way to hand a shop over was also the way to lose it.
/// Create a second owner, demote yourself in the next click, and the shop holds
/// an "active owner" nobody has given a passphrase to and nobody left who
/// could: every command refuses, enrollment is terminal and cannot be re-run,
/// and the only route back is somebody editing the database file.
///
/// The hand-over is still available — it is one extra step, in the right order,
/// and the test above walks it.
#[tokio::test]
async fn a_second_owner_with_no_passphrase_does_not_free_the_demotion() {
    let db = staffed().await;
    give_credential(&db, OWNER).await;

    users_save_as(db.pool(), &owner(), save("owner-2", "Second Owner", "owner"))
        .await
        .expect("a second owner, with no passphrase yet");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM users
                   WHERE id = 'owner-2' AND role = 'owner' AND active = 1")
            .await,
        1,
        "they are an active owner by every other measure"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM users
                   WHERE id = 'owner-2' AND pin_hash IS NULL")
            .await,
        1,
        "and they cannot sign in, which is the whole point"
    );

    // DEMOTION IS REFUSED, because the shop would be left with nobody who can
    // administer it.
    let refused = users_save_as(db.pool(), &owner(), save(OWNER, "Owner", "manager"))
        .await
        .expect_err("an owner who cannot sign in does not count");
    assert!(refused.contains("only owner who can sign in"), "{refused}");

    // RETIREMENT IS REFUSED FOR THE SAME REASON. Checked separately because it
    // is a different command with its own call to the rule, and the self-retire
    // guard would mask it — so this retires through the SECOND owner's actor.
    let actor2 = Actor::for_tests("owner-2", STORE, Role::Owner);
    let refused = users_set_active_as(
        db.pool(),
        &actor2,
        UserSetActiveArgs {
            user_id: OWNER.to_string(),
            is_active: false,
        },
    )
    .await
    .expect_err("retiring the only usable owner is refused too");
    assert!(refused.contains("only owner who can sign in"), "{refused}");

    assert_eq!(
        db.scalar_string(&format!("SELECT role FROM users WHERE id = '{OWNER}'"))
            .await,
        "owner"
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT active FROM users WHERE id = '{OWNER}'"))
            .await,
        1
    );

    // GIVE THEM A PASSPHRASE AND IT GOES THROUGH. The rule is about the shop
    // keeping somebody who can administer it, not about making the hand-over
    // impossible.
    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: "owner-2".to_string(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect("a passphrase for the second owner");
    users_save_as(db.pool(), &owner(), save(OWNER, "Owner", "manager"))
        .await
        .expect("and now the hand-over completes");

    db.cleanup().await.expect("remove TempDb");
}

/// A RETIRED owner does not keep the shop administrable either.
#[tokio::test]
async fn a_retired_owner_does_not_keep_the_shop_administrable() {
    let db = staffed().await;
    give_credential(&db, OWNER).await;

    users_save_as(db.pool(), &owner(), save("owner-2", "Second Owner", "owner"))
        .await
        .expect("a second owner");
    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: "owner-2".to_string(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect("with a passphrase, so only `active` is in question");
    users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: "owner-2".to_string(),
            is_active: false,
        },
    )
    .await
    .expect("retire them again");

    // The first owner is once more the only usable one, so demoting them is
    // refused — a retired owner cannot administer anything, so counting them
    // would be counting somebody who cannot help.
    let refused = users_save_as(db.pool(), &owner(), save(OWNER, "Owner", "manager"))
        .await
        .expect_err("a retired owner does not count");
    assert!(refused.contains("only owner who can sign in"), "{refused}");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// A promotion does not carry a weaker secret with it
// ===========================================================================

/// PROMOTING A CASHIER RETIRES THEIR PIN.
///
/// Found by an independent review of Stage B.3. The strength rule is applied
/// when a secret is SET, against the role the account had at that moment: a
/// cashier may legitimately be given `123456`. Promote them and that six-digit
/// PIN became a manager's credential, below both halves of the rule a manager
/// is held to — ten characters and not all digits — and nothing would ever have
/// re-examined it. The stored value is an Argon2id hash, so the old secret
/// cannot be re-tested against the new rule; there is therefore no honest way
/// to keep it.
#[tokio::test]
async fn promoting_a_cashier_retires_the_pin_they_had() {
    let db = staffed().await;

    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: CASHIER.to_string(),
            secret: "123456".to_string(),
        },
    )
    .await
    .expect("a cashier PIN, which is legitimate for a cashier");
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users
              WHERE id = '{CASHIER}' AND pin_hash IS NOT NULL"
        ))
        .await,
        1
    );

    users_save_as(db.pool(), &owner(), save(CASHIER, "Sami", "manager"))
        .await
        .expect("the promotion itself goes through");

    // THE ROLE MOVED AND THE SECRET DID NOT COME WITH IT.
    assert_eq!(
        db.scalar_string(&format!("SELECT role FROM users WHERE id = '{CASHIER}'"))
            .await,
        "manager"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users
              WHERE id = '{CASHIER}'
                AND pin_hash IS NULL AND credential_algo IS NULL
                AND credential_version IS NULL AND credential_set_at IS NULL
                AND must_change_pin = 0
                AND failed_attempts = 0 AND locked_until IS NULL"
        ))
        .await,
        1,
        "every part of the credential goes, not just the hash"
    );

    // AND THE LOG SAYS SO. A row recording the promotion but not the credential
    // it retired would leave somebody reading it later unable to explain why
    // that person could not sign in.
    let detail = db
        .scalar_string(&format!(
            "SELECT detail FROM auth_audit
              WHERE event = 'role_changed' AND user_id = '{CASHIER}'"
        ))
        .await;
    assert!(detail.contains("cashier -> manager"), "{detail}");
    assert!(detail.contains("passphrase cleared"), "{detail}");

    // The owner can then set one under the manager rule — and the SIX-DIGIT
    // PIN is now refused, which is the point.
    let refused = set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: CASHIER.to_string(),
            secret: "123456".to_string(),
        },
    )
    .await
    .expect_err("the old PIN cannot be re-set under the new role");
    assert!(refused.contains("at least"), "{refused}");

    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: CASHIER.to_string(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect("a passphrase is accepted");

    db.cleanup().await.expect("remove TempDb");
}

/// A DEMOTION KEEPS THE CREDENTIAL, and a rename never touches it.
///
/// A passphrase already satisfies the PIN rule, so clearing it on the way down
/// would lock somebody out of the till to no purpose. The asymmetry is the
/// whole rule: the clearing happens when the BAR RISES, not whenever the role
/// moves.
#[tokio::test]
async fn a_demotion_or_a_rename_keeps_the_credential() {
    let db = staffed().await;
    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: MANAGER.to_string(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect("a manager passphrase");
    let before = db
        .scalar_string(&format!("SELECT pin_hash FROM users WHERE id = '{MANAGER}'"))
        .await;

    // Rename: no role change at all.
    users_save_as(db.pool(), &owner(), save(MANAGER, "Mona Haddad", "manager"))
        .await
        .expect("a rename");
    assert_eq!(
        db.scalar_string(&format!("SELECT pin_hash FROM users WHERE id = '{MANAGER}'"))
            .await,
        before
    );

    // Demotion: the bar falls, so the secret stands.
    users_save_as(db.pool(), &owner(), save(MANAGER, "Mona Haddad", "cashier"))
        .await
        .expect("a demotion");
    assert_eq!(
        db.scalar_string(&format!("SELECT pin_hash FROM users WHERE id = '{MANAGER}'"))
            .await,
        before,
        "a passphrase already satisfies the cashier rule"
    );
    let detail = db
        .scalar_string(&format!(
            "SELECT detail FROM auth_audit
              WHERE event = 'role_changed' AND user_id = '{MANAGER}'"
        ))
        .await;
    assert_eq!(detail, "manager -> cashier", "and the log claims no clearing");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// What the log records (migration 024)
// ===========================================================================

/// RESTORING ACCESS IS AUDITED, and that was the P1 of the three.
///
/// `user_deactivated` records that somebody's access was TAKEN AWAY. With no
/// counterpart, access could be GIVEN BACK and the log would say only that it
/// had once been removed — an owner reading it six months later would see a
/// cashier retired in March and nothing to indicate they were ringing sales
/// again in April. Nothing else could have told them: `users.active` holds
/// today's value and keeps no history.
#[tokio::test]
async fn retiring_and_restoring_are_both_recorded() {
    let db = staffed().await;

    for (is_active, event) in [(false, "user_deactivated"), (true, "user_activated")] {
        users_set_active_as(
            db.pool(),
            &owner(),
            UserSetActiveArgs {
                user_id: CASHIER.to_string(),
                is_active,
            },
        )
        .await
        .expect("the change itself");
        assert_eq!(
            db.count(&format!(
                "SELECT count(*) AS n FROM auth_audit
                  WHERE event = '{event}' AND user_id = '{CASHIER}'
                    AND actor_user_id = '{OWNER}'"
            ))
            .await,
            1,
            "{event} must be recorded against the owner who did it"
        );
    }

    // RE-SAVING THE STATE IT IS ALREADY IN WRITES NOTHING, so the log stays a
    // list of changes rather than of clicks.
    users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: CASHIER.to_string(),
            is_active: true,
        },
    )
    .await
    .expect("a no-op");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'user_activated'")
            .await,
        1,
        "a no-op must not write a second row"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A RENAME IS RECORDED, WITH BOTH NAMES.
///
/// `users.full_name` is the name printed on every shift report and shown beside
/// every sale in Sales History, and those screens JOIN to the live row rather
/// than reading a snapshot. So editing it silently restates the attribution on
/// documents that are otherwise immutable — not the `user_id` they are keyed on,
/// but the name a person actually reads to say who did something. The edit is
/// allowed, because names change; what was missing is the trace.
#[tokio::test]
async fn renaming_somebody_is_recorded_with_both_names() {
    let db = staffed().await;

    users_save_as(db.pool(), &owner(), save(CASHIER, "Sami Haddad", "cashier"))
        .await
        .expect("a rename");
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT detail FROM auth_audit
              WHERE event = 'user_renamed' AND user_id = '{CASHIER}'"
        ))
        .await,
        "Sami -> Sami Haddad",
        "a log saying only `renamed` answers nothing"
    );

    // Saving the same name again writes no row.
    users_save_as(db.pool(), &owner(), save(CASHIER, "Sami Haddad", "cashier"))
        .await
        .expect("a no-op save");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'user_renamed'")
            .await,
        1
    );

    // A CREATION IS NOT A RENAME. The row has no previous name, and recording
    // one would invent a history the account does not have.
    users_save_as(db.pool(), &owner(), save("fresh", "Rami", "cashier"))
        .await
        .expect("a new person");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit
                   WHERE event = 'user_renamed' AND user_id = 'fresh'")
            .await,
        0
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit
                   WHERE event = 'user_created' AND user_id = 'fresh'")
            .await,
        1
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Owner-only, and the reason
// ===========================================================================

/// A MANAGER CANNOT ADMINISTER STAFF, and specifically cannot set anybody
/// else's passphrase.
///
/// The reason is narrow and decisive: somebody who can set another person's
/// passphrase can SIGN IN AS THEM, and every document would then name that
/// person for something somebody else did — undoing the one thing Stage B
/// establishes. So it is not merely a tidier menu for a manager; it is the
/// attribution itself.
#[tokio::test]
async fn a_manager_cannot_administer_staff_or_reset_a_passphrase() {
    let db = staffed().await;

    // The owner's stored credential material, before any of this.
    let owner_credential_before = db
        .scalar_string(&format!(
            "SELECT coalesce(pin_hash, 'none') FROM users WHERE id = '{OWNER}'"
        ))
        .await;

    for actor in [manager(), cashier()] {
        let refused = users_save_as(db.pool(), &actor, save("planted", "Planted", "owner"))
            .await
            .expect_err("only an owner administers staff");
        assert!(refused.contains("manage staff accounts"), "{refused}");
        assert!(refused.contains("Ask the owner"), "{refused}");

        let refused = users_set_active_as(
            db.pool(),
            &actor,
            UserSetActiveArgs {
                user_id: CASHIER.to_string(),
                is_active: false,
            },
        )
        .await
        .expect_err("only an owner retires staff");
        assert!(refused.contains("manage staff accounts"), "{refused}");

        // Aimed at the OWNER's account, which is the attack that matters: a
        // manager who could do this would own the shop by the afternoon.
        let refused = set_user_credential_as(
            db.pool(),
            &actor,
            SetUserCredentialArgs {
                user_id: OWNER.to_string(),
                secret: PASSPHRASE.to_string(),
            },
        )
        .await
        .expect_err("only an owner sets somebody else's passphrase");
        assert!(
            refused.contains("reset somebody else's passphrase"),
            "{refused}"
        );
        assert!(refused.contains("Ask the owner"), "{refused}");
    }

    // NOTHING was written by any of it.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM users WHERE id = 'planted'")
            .await,
        0
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users WHERE id = '{CASHIER}' AND active = 1"
        ))
        .await,
        1
    );
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT coalesce(pin_hash, 'none') FROM users WHERE id = '{OWNER}'"
        ))
        .await,
        owner_credential_before,
        "the owner's credential must be exactly as it was"
    );

    // AND NOTHING WAS LOGGED, which is the deliberate half of the two-point
    // design rather than an omission. `authorize_tx` is the authoritative
    // check and runs INSIDE the transaction, so a row it wrote would be rolled
    // back with the refusal — an audit trail that disappears precisely when it
    // is needed. The durable `permission_denied` row is written by the boundary
    // check in `authz::authorize`, which these seams bypass by construction
    // because they take an `Actor` directly. Both halves are pinned in
    // `tests::authorization`: `the_denial_is_logged_outside_the_transaction_only`
    // asserts the split, and the matrix test asserts the row is actually
    // written at the boundary.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM auth_audit WHERE event = 'permission_denied'")
            .await,
        0,
        "an in-transaction refusal must not leave a row that would roll back"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// THE LIST SEAM REFUSES A NON-OWNER TOO, not only its command wrapper.
///
/// Who works here, what each of them may do and whether each can sign in yet is
/// a map of the shop's administration. The wrapper was the only thing holding
/// it, and a structural count of `authz::begin` strings proved the wrapper, not
/// the seam. Asserted behaviourally rather than by reading the source, because
/// the source assertion is what was already there and was not enough.
#[tokio::test]
async fn the_staff_list_refuses_a_manager_and_a_cashier() {
    let db = staffed().await;

    for actor in [manager(), cashier()] {
        let refused = users_list_as(db.pool(), &actor)
            .await
            .expect_err("the staff list is owner-only");
        assert!(refused.contains("manage staff accounts"), "{refused}");
        assert!(refused.contains("Ask the owner"), "{refused}");
    }

    // The owner still gets it, so the check is a check and not a wall.
    let staff = users_list_as(db.pool(), &owner()).await.expect("the owner may list");
    assert!(staff.len() >= 3);

    // The boundary check is the one that writes the durable row, so unlike the
    // in-transaction refusals these ARE logged.
    assert_eq!(
        db.count(
            "SELECT count(*) AS n FROM auth_audit
              WHERE event = 'permission_denied' AND operation = 'users_admin'"
        )
        .await,
        2,
        "a refused read of the staff list must be recorded"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// AN OWNER CANNOT RESET THEIR OWN PASSPHRASE THROUGH THIS COMMAND.
///
/// Changing your own requires the current one (`auth_change_credential`).
/// Allowing it here would turn "reset somebody else's" into a way to skip that
/// — so somebody who found an unlocked till could set the owner's passphrase
/// without knowing it.
#[tokio::test]
async fn an_owner_cannot_reset_their_own_passphrase_here() {
    let db = staffed().await;

    let refused = set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: OWNER.to_string(),
            secret: "a-brand-new-passphrase".to_string(),
        },
    )
    .await
    .expect_err("your own passphrase needs the current one");
    assert!(refused.contains("Change passphrase"), "{refused}");
    assert!(refused.contains("current one"), "{refused}");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Validation and scoping
// ===========================================================================

/// The role vocabulary is the stored one, and a name is required.
#[tokio::test]
async fn a_staff_member_needs_a_name_and_a_real_role() {
    let db = staffed().await;

    for (name, role, expected) in [
        ("", "cashier", "needs a name"),
        ("   ", "cashier", "needs a name"),
        ("Rami", "", "owner, a manager or a cashier"),
        ("Rami", "admin", "owner, a manager or a cashier"),
        ("Rami", "Cashier", "owner, a manager or a cashier"),
        ("Rami", "superuser", "owner, a manager or a cashier"),
    ] {
        let refused = users_save_as(db.pool(), &owner(), save("x", name, role))
            .await
            .expect_err("invalid staff details must be refused");
        assert!(
            refused.contains(expected),
            "`{name}`/`{role}` should mention `{expected}`, got: {refused}"
        );
    }

    assert_eq!(db.count("SELECT count(*) AS n FROM users WHERE id = 'x'").await, 0);
    db.cleanup().await.expect("remove TempDb");
}

/// Staff administration cannot reach another shop.
///
/// The store is the ACTOR's, never the request's, so there is no field through
/// which an owner of one branch could administer another — and a row of another
/// branch simply does not resolve.
#[tokio::test]
async fn staff_administration_cannot_reach_another_shop() {
    let db = staffed().await;
    crate::test_support::seed_store(&db, "store-b", "Branch B").await;
    let theirs = crate::test_support::seeded_owner_of("store-b");

    // Branch B's owner is invisible to us.
    let staff = users_list_as(db.pool(), &owner()).await.expect("list");
    assert!(
        staff.iter().all(|s| s.user_id != theirs),
        "another shop's staff must not be listed"
    );

    // And unreachable.
    let refused = users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: theirs.clone(),
            is_active: false,
        },
    )
    .await
    .expect_err("another shop's owner is not ours to retire");
    assert!(refused.contains("not in this shop"), "{refused}");

    let refused = set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: theirs.clone(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect_err("another shop's owner is not ours to reset");
    assert!(refused.contains("not in this shop"), "{refused}");

    assert_eq!(
        db.count(&format!(
            "SELECT count(*) AS n FROM users WHERE id = '{theirs}' AND active = 1"
        ))
        .await,
        1,
        "and they are untouched"
    );

    // Creating one with THEIR id lands in OUR shop, not theirs — the store is
    // not negotiable. (A clashing id fails on the primary key, which is the
    // correct outcome and is why this uses a fresh one.)
    users_save_as(db.pool(), &owner(), save("fresh", "Ours", "cashier"))
        .await
        .expect("created");
    assert_eq!(
        db.scalar_string("SELECT store_id FROM users WHERE id = 'fresh'")
            .await,
        STORE
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A first passphrase is held to the strength rule of the person's OWN role.
#[tokio::test]
async fn a_first_passphrase_is_held_to_the_rule_for_that_role() {
    let db = staffed().await;

    // A cashier's floor is six characters.
    let refused = set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: CASHIER.to_string(),
            secret: "12345".to_string(),
        },
    )
    .await
    .expect_err("five characters is below the cashier floor");
    assert!(refused.contains("at least"), "{refused}");

    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: CASHIER.to_string(),
            secret: "123456".to_string(),
        },
    )
    .await
    .expect("six is a valid cashier PIN");

    // A MANAGER needs a passphrase, so the same six digits are refused for
    // them — the rule follows the role, not the person doing the setting.
    let refused = set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: MANAGER.to_string(),
            secret: "123456".to_string(),
        },
    )
    .await
    .expect_err("a manager may not have a six-digit PIN");
    assert!(refused.contains("at least"), "{refused}");

    set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: MANAGER.to_string(),
            secret: PASSPHRASE.to_string(),
        },
    )
    .await
    .expect("a passphrase is right for a manager");

    db.cleanup().await.expect("remove TempDb");
}

/// A retired account's passphrase is not settable until they are brought back.
#[tokio::test]
async fn a_retired_accounts_passphrase_cannot_be_set() {
    let db = staffed().await;
    users_set_active_as(
        db.pool(),
        &owner(),
        UserSetActiveArgs {
            user_id: CASHIER.to_string(),
            is_active: false,
        },
    )
    .await
    .expect("retire");

    let refused = set_user_credential_as(
        db.pool(),
        &owner(),
        SetUserCredentialArgs {
            user_id: CASHIER.to_string(),
            secret: "123456".to_string(),
        },
    )
    .await
    .expect_err("a retired account gets no passphrase");
    assert!(refused.contains("retired"), "{refused}");
    assert!(
        refused.contains("Bring it back first"),
        "the refusal must say what to do: {refused}"
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Structural
// ===========================================================================

/// The staff commands go through the boundary like every other, the three
/// WRITERS authorize again inside their own transaction, and the view the
/// screen gets carries no credential material.
#[test]
fn the_staff_commands_authorize_and_disclose_nothing_sensitive() {
    let src = include_str!("../users.rs");

    // Four commands, every one of them through `authz::begin`. None may reach
    // its implementation by any other route.
    assert_eq!(src.matches("#[tauri::command]").count(), 4);
    assert_eq!(src.matches("authz::begin(").count(), 4);

    // THE THREE WRITERS AUTHORIZE AGAIN INSIDE THEIR TRANSACTION. The boundary
    // check reads the role before the transaction opens; the in-transaction one
    // is what makes the decision and the write the same event, so a role
    // revoked in between cannot be acted on. `users_list_as` is a read and has
    // no transaction to be inside, so it is gated at the boundary only —
    // stated rather than implied, because the asymmetry is otherwise the kind
    // of thing a reader assumes is a missing check.
    assert_eq!(
        src.matches("authz::authorize_tx(").count(),
        3,
        "every staff WRITER must authorize inside its own transaction"
    );
    for writer in ["users_save_as", "users_set_active_as", "set_user_credential_as"] {
        let body = src
            .split(&format!("async fn {writer}("))
            .nth(1)
            .unwrap_or_else(|| panic!("{writer} must exist"));
        let body = body.split("\n}\n").next().expect("a function body");
        assert!(
            body.contains("authz::authorize_tx("),
            "{writer} must authorize inside its own transaction"
        );
    }
    let list_body = src
        .split("async fn users_list_as(")
        .nth(1)
        .expect("users_list_as")
        .split("\n}\n")
        .next()
        .expect("a body");
    assert!(
        !list_body.contains("pool.begin()"),
        "users_list_as is a read; if it ever opens a transaction it must \
         authorize inside it too"
    );
    // AND IT AUTHORIZES AT THE BOUNDARY (independent review of Stage B.3). The
    // command wrapper already did, and nothing but the wrapper reaches the seam
    // in production — but a read seam that takes any `Actor` and answers with
    // every account's name, role and credential state does not match the
    // module's own claim to be owner-only, and the next caller inside this
    // crate is the problem.
    assert!(
        list_body.contains("authz::authorize(pool, actor, Operation::UserAdmin)"),
        "users_list_as must authorize before it answers"
    );

    // The view the screen gets names no secret and no rate-limit state. How
    // close somebody is to a lockout is the security log, not administration.
    let view = src
        .split("pub struct StaffView {")
        .nth(1)
        .expect("StaffView")
        .split('}')
        .next()
        .expect("end");
    for forbidden in ["pin_hash", "credential_algo", "failed_attempts", "locked_until"] {
        assert!(
            !view.contains(forbidden),
            "StaffView must not carry `{forbidden}`"
        );
    }
}

/// The owner-only policy is what these commands rest on, asserted here as well
/// as in `tests::authorization` so a change to the matrix cannot quietly make
/// staff administration available to a manager.
#[test]
fn staff_administration_is_owner_only_in_the_matrix() {
    use crate::authz::{permits, Operation};

    for op in [Operation::UserAdmin, Operation::ResetAnotherCredential] {
        assert!(permits(Role::Owner, op));
        assert!(!permits(Role::Manager, op), "{op:?} must not be a manager's");
        assert!(!permits(Role::Cashier, op));
    }
}
