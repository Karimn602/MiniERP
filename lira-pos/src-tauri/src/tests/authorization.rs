//! GATE 2B STAGE B.1 — the permission matrix, enforced in Rust.
//!
//! Stage A.1 decided WHO is at the till. This decides WHAT THEY MAY DO, and it
//! is the stage that makes the three roles mean something: before it, a role
//! was a label `users.role` carried and nothing read.
//!
//! Every test here runs against a brand-new disposable `TempDb`. The matrix is
//! enumerated from the policy itself (`authz::ALL_OPERATIONS` x
//! `authz::ALL_ROLES`), not from a second list, so an operation added without a
//! test is impossible.
//!
//! WHAT B.1 DOES AND DOES NOT COVER, because the difference matters for how
//! these tests are written. B.1 authorizes at the COMMAND BOUNDARY: the window
//! is checked, the actor is resolved from the session, and the operation is
//! authorized before any transaction opens. It does NOT yet thread the actor
//! into the posting transactions, so it does not yet change which `*_user_id`
//! is written — that is B.2, together with migration 025. So nothing here
//! asserts attribution; it asserts refusals, and that a refusal leaves nothing
//! behind.

use crate::auth::{Actor, Role, SessionState};
use crate::authz::{self, Operation};
use crate::test_support::TempDb;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";
const MANAGER: &str = "00000000-0000-0000-0000-0000000000a1";
const CASHIER: &str = "00000000-0000-0000-0000-0000000000a2";

/// A store with one of each role, so the matrix can be driven against real
/// `users` rows rather than against an `Actor` nobody has to back up.
async fn staffed() -> TempDb {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('{MANAGER}', '{STORE}', 'Mona', 'manager')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('{CASHIER}', '{STORE}', 'Sami', 'cashier')"
    ))
    .await;
    db
}

fn actor_for(role: Role) -> Actor {
    let id = match role {
        Role::Owner => OWNER,
        Role::Manager => MANAGER,
        Role::Cashier => CASHIER,
    };
    Actor::for_tests(id, STORE, role)
}

// ===========================================================================
// The matrix itself
// ===========================================================================

/// THE WHOLE MATRIX, against a real database, in both directions.
///
/// For every (role, operation) pair: `authorize` agrees with `permits`, and a
/// refusal writes exactly one `permission_denied` row naming the operation
/// while an allowed call writes none. Driving both from `permits` rather than
/// from a re-typed expectation table is deliberate — a second table would
/// simply be the same mistake written twice — and the SHAPE of the policy is
/// pinned separately below, where the actual answers are written out.
#[tokio::test]
async fn every_role_and_operation_pair_is_enforced_and_audited() {
    let db = staffed().await;

    for &role in authz::ALL_ROLES {
        let actor = actor_for(role);
        for &operation in authz::ALL_OPERATIONS {
            let before = db
                .count("SELECT count(*) AS n FROM auth_audit WHERE event = 'permission_denied'")
                .await;

            let outcome = authz::authorize(db.pool(), &actor, operation).await;
            let after = db
                .count("SELECT count(*) AS n FROM auth_audit WHERE event = 'permission_denied'")
                .await;

            if authz::permits(role, operation) {
                outcome.unwrap_or_else(|e| {
                    panic!("{role:?} should be allowed {operation:?}: {e}")
                });
                assert_eq!(
                    after, before,
                    "an ALLOWED operation ({role:?}, {operation:?}) must write no \
                     permission_denied row"
                );
            } else {
                let refusal = outcome
                    .expect_err(&format!("{role:?} must be refused {operation:?}"));
                assert!(
                    !refusal.is_empty(),
                    "the refusal of ({role:?}, {operation:?}) must say something"
                );
                assert_eq!(
                    after,
                    before + 1,
                    "a REFUSED operation ({role:?}, {operation:?}) must write exactly one \
                     permission_denied row"
                );

                // The row names the operation, so an owner reading the log can
                // see WHAT was attempted and not merely that something was.
                assert_eq!(
                    db.count(&format!(
                        "SELECT count(*) AS n FROM auth_audit
                          WHERE event = 'permission_denied'
                            AND operation = '{}'
                            AND user_id = '{}'",
                        operation.audit_name(),
                        actor.user_id
                    ))
                    .await,
                    1,
                    "the refusal of {operation:?} must be attributed to {role:?}"
                );
            }
        }
    }

    db.cleanup().await.expect("remove TempDb");
}

/// A REFUSED OPERATION IS REFUSED AT THE SAME ANSWER by the boundary check and
/// by the in-transaction check.
///
/// Two checks exist for a reason — the boundary one is fast and auditable, the
/// in-transaction one is the authority — and the one thing that must never
/// happen is that they disagree. A boundary that allowed what the transaction
/// refuses would consume a receipt number for nothing; a boundary that refused
/// what the transaction allows would be a permission system nobody could use.
#[tokio::test]
async fn the_boundary_check_and_the_in_transaction_check_agree() {
    let db = staffed().await;

    for &role in authz::ALL_ROLES {
        let actor = actor_for(role);
        for &operation in authz::ALL_OPERATIONS {
            let boundary = authz::authorize(db.pool(), &actor, operation).await.is_ok();

            let mut tx = db.pool().begin().await.expect("begin");
            let in_tx = authz::authorize_tx(&mut tx, &actor, operation)
                .await
                .is_ok();
            tx.rollback().await.expect("rollback");

            assert_eq!(
                boundary, in_tx,
                "the two checks disagree about ({role:?}, {operation:?})"
            );
        }
    }

    db.cleanup().await.expect("remove TempDb");
}

/// THE POLICY, WRITTEN OUT. The deployment promise, asserted literally.
///
/// `every_role_and_operation_pair_is_enforced_and_audited` proves the
/// enforcement matches the policy; this proves the POLICY IS THE RIGHT ONE. The
/// two are separate on purpose: a matrix test driven from `permits` would pass
/// just as happily if somebody made every operation available to everybody.
#[test]
fn a_cashier_cannot_refund_reprice_adjust_or_set_the_rate() {
    use Operation::*;

    // What a cashier IS for. If any of these becomes false the till stops
    // working for the person who actually uses it.
    for op in [PostSale, OpenShift, CloseOwnShift, DriverRemittance] {
        assert!(
            authz::permits(Role::Cashier, op),
            "a cashier must be able to {op:?} — it is their job"
        );
    }

    // The deployment promise. Each of these is a specific way a shortfall gets
    // covered up, and the whole point of hiring a cashier under Greaz is that
    // the owner can rely on this list.
    for op in [
        PostCreditMemo,          // cannot refund
        PostAdjustment,          // cannot write stock off to cover theft
        SaveProduct,             // cannot reprice
        SaveProductCost,         // cannot restate a margin
        ExchangeRateSave,        // cannot make a lira tender favourable
        CloseAnotherShift,       // cannot close over somebody's variance
        PostSaleLargeDiscount,   // cannot discount without a manager
        DriverLedgerAdjustment,  // cannot write a driver's balance down
        PostPurchase,
        SupplierPayment,
        UserAdmin,
        ResetAnotherCredential,
        ReadCostAndMargin,
        ReadProfitReports,
        ReadAuthAudit,
    ] {
        assert!(
            !authz::permits(Role::Cashier, op),
            "a cashier must NOT be able to {op:?}"
        );
    }

    // A manager runs the evening, and may do everything a cashier may not —
    // except the two that are the owner's alone.
    for op in [
        PostCreditMemo,
        PostAdjustment,
        SaveProduct,
        ExchangeRateSave,
        CloseAnotherShift,
        PostSaleLargeDiscount,
        PostPurchase,
        SupplierPayment,
        SupplierSave,
        DriverSave,
        RecipeDraft,
        RecipeActivate,
        RecipeRetire,
        ReadCostAndMargin,
        ReadProfitReports,
    ] {
        assert!(
            authz::permits(Role::Manager, op),
            "a manager must be able to {op:?}"
        );
    }

    // THE OWNER'S ALONE. Cost editing, because a cost is the basis of every
    // margin figure and under `standard` costing has no document behind it —
    // WP-B1's argument. And staff administration, because a manager who can
    // reset a cashier's passphrase can sign in as that cashier, which would
    // undo the attribution this whole gate exists to make trustworthy.
    for op in [SaveProductCost, UserAdmin, ResetAnotherCredential, ReadAuthAudit] {
        assert!(
            !authz::permits(Role::Manager, op),
            "{op:?} must be the owner's alone"
        );
        assert!(authz::permits(Role::Owner, op));
    }

    // The owner does everything, intentionally.
    for &op in authz::ALL_OPERATIONS {
        assert!(authz::permits(Role::Owner, op), "the owner must be able to {op:?}");
    }
}

/// The enumeration used by the matrix tests covers the enum.
///
/// `ALL_OPERATIONS` is written by hand, so this is what stops an operation
/// being added to the enum and silently escaping every test above. The count is
/// compared against the number of `Operation::` variants in the source, which
/// is the only way to count them without a derive.
#[test]
fn the_matrix_covers_every_operation() {
    let src = include_str!("../authz.rs");
    let declaration = src
        .split("pub(crate) enum Operation {")
        .nth(1)
        .expect("the Operation enum")
        .split("\n}")
        .next()
        .expect("the end of the enum");

    let variants = declaration
        .lines()
        .map(str::trim)
        .filter(|line| {
            line.ends_with(',')
                && !line.starts_with("//")
                && !line.starts_with("/*")
                && line
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_uppercase())
        })
        .count();

    assert!(variants > 20, "only found {variants} variants; the parse is wrong");
    assert_eq!(
        authz::ALL_OPERATIONS.len(),
        variants,
        "ALL_OPERATIONS lists {} of {variants} operations, so {} escape the \
         matrix tests",
        authz::ALL_OPERATIONS.len(),
        variants - authz::ALL_OPERATIONS.len()
    );

    // And every entry is distinct, so padding the list cannot satisfy the
    // count.
    let mut seen = std::collections::HashSet::new();
    for op in authz::ALL_OPERATIONS {
        assert!(seen.insert(format!("{op:?}")), "{op:?} is listed twice");
    }
}

// ===========================================================================
// The identity is re-read, not trusted
// ===========================================================================

/// A ROLE CHANGED AFTER THE ACTOR WAS RESOLVED IS HONOURED IMMEDIATELY.
///
/// The `Actor` carries a role, and it would be the obvious thing to check. It
/// is not checked: both `authorize` and `authorize_tx` re-read the role from the
/// database, because the actor was resolved when the command started and an
/// owner may have changed it since. A permission decided against the actor's
/// copy is a permission decided against the past.
#[tokio::test]
async fn a_role_change_takes_effect_on_the_next_operation() {
    let db = staffed().await;

    // An actor that CLAIMS to be an owner, backed by a cashier row.
    let liar = Actor::for_tests(CASHIER, STORE, Role::Owner);
    let refused = authz::authorize(db.pool(), &liar, Operation::PostCreditMemo)
        .await
        .expect_err("the stored role decides, not the actor's copy");
    assert!(refused.contains("cannot give a refund"), "{refused}");

    // Promote the row; the same actor is now allowed, with no new session.
    db.exec(&format!(
        "UPDATE users SET role = 'manager' WHERE id = '{CASHIER}'"
    ))
    .await;
    authz::authorize(db.pool(), &liar, Operation::PostCreditMemo)
        .await
        .expect("a promotion takes effect at once");

    // Demote again and it is refused again.
    db.exec(&format!(
        "UPDATE users SET role = 'cashier' WHERE id = '{CASHIER}'"
    ))
    .await;
    assert!(
        authz::authorize(db.pool(), &liar, Operation::PostCreditMemo)
            .await
            .is_err(),
        "a demotion takes effect at once too"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A deactivated, deleted or cross-store account is refused EVERYTHING,
/// including the operations its role would allow.
#[tokio::test]
async fn an_account_that_has_changed_underneath_the_session_is_refused() {
    let db = staffed().await;

    // Deactivated.
    db.exec(&format!("UPDATE users SET active = 0 WHERE id = '{OWNER}'"))
        .await;
    let refused = authz::authorize(db.pool(), &actor_for(Role::Owner), Operation::PostSale)
        .await
        .expect_err("an inactive account may do nothing");
    assert!(refused.contains("no longer active"), "{refused}");
    db.exec(&format!("UPDATE users SET active = 1 WHERE id = '{OWNER}'"))
        .await;

    // Unknown.
    let ghost = Actor::for_tests("no-such-user", STORE, Role::Owner);
    let refused = authz::authorize(db.pool(), &ghost, Operation::PostSale)
        .await
        .expect_err("an account that does not exist may do nothing");
    assert!(refused.contains("no longer exists"), "{refused}");

    // A session whose store disagrees with the user's row. Nothing in the
    // application produces this, which is why it is refused rather than
    // reconciled to one of the two.
    db.exec(
        "INSERT INTO stores (id, name, legal_name, default_currency)
         VALUES ('store-2', 'Branch', 'Branch SARL', 'USD')",
    )
    .await;
    let elsewhere = Actor::for_tests(OWNER, "store-2", Role::Owner);
    let refused = authz::authorize(db.pool(), &elsewhere, Operation::PostSale)
        .await
        .expect_err("a cross-store session may do nothing");
    assert!(refused.contains("another shop"), "{refused}");

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The refusals are usable
// ===========================================================================

/// A REFUSAL SAYS WHO TO ASK.
///
/// "Permission denied" at a till leaves the cashier with nothing to do but ask
/// the next person along, and the whole value of a role system is that they
/// know which person that is. It must also say that nothing was changed —
/// otherwise the cashier's next move is to check, or to try again.
#[test]
fn every_refusal_names_the_action_the_role_and_who_can_do_it() {
    for &role in authz::ALL_ROLES {
        for &operation in authz::ALL_OPERATIONS {
            if authz::permits(role, operation) {
                continue;
            }
            let message = operation.refusal(role);

            assert!(
                message.contains("Ask the owner") || message.contains("Ask a manager or the owner"),
                "({role:?}, {operation:?}) does not say who to ask: {message}"
            );
            assert!(
                message.contains("Nothing has been changed"),
                "({role:?}, {operation:?}) does not say nothing changed: {message}"
            );
            // It names the role the person actually has, so they are not left
            // wondering whether they are signed in as somebody else.
            let as_role = match role {
                Role::Owner => "the owner",
                Role::Manager => "a manager",
                Role::Cashier => "a cashier",
            };
            assert!(
                message.contains(as_role),
                "({role:?}, {operation:?}) does not name the role: {message}"
            );
            // And it is a sentence, not an enum name.
            assert!(
                !message.contains("Operation::") && !message.contains('_'),
                "({role:?}, {operation:?}) leaks an identifier: {message}"
            );
        }
    }
}

/// An owner-only refusal says "the owner"; everything else says "a manager or
/// the owner". Getting this backwards would send a cashier to the wrong person.
#[test]
fn an_owner_only_refusal_does_not_send_the_cashier_to_a_manager() {
    for op in [
        Operation::SaveProductCost,
        Operation::UserAdmin,
        Operation::ResetAnotherCredential,
    ] {
        let message = op.refusal(Role::Cashier);
        assert!(
            message.contains("Ask the owner"),
            "{op:?} must send them to the owner: {message}"
        );
        assert!(
            !message.contains("manager"),
            "{op:?} must not offer a manager who cannot help: {message}"
        );
    }

    let message = Operation::PostCreditMemo.refusal(Role::Cashier);
    assert!(
        message.contains("Ask a manager or the owner"),
        "a refund can be done by a manager: {message}"
    );
}

/// Every operation has a distinct audit name, so the log can tell them apart.
#[test]
fn the_audit_names_are_distinct_and_machine_readable() {
    let mut seen = std::collections::HashSet::new();
    for &op in authz::ALL_OPERATIONS {
        let name = op.audit_name();
        assert!(
            seen.insert(name),
            "two operations share the audit name `{name}`"
        );
        assert!(!name.is_empty());
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '.'),
            "`{name}` is not a stable machine-readable name"
        );
    }
}

// ===========================================================================
// The discount threshold
// ===========================================================================

/// The threshold is an AMOUNT, and it is the amount that decides.
#[test]
fn the_discount_threshold_is_an_amount_not_a_role() {
    let limit = authz::DISCOUNT_WITHOUT_APPROVAL_CENTS;

    // A real figure, not a placeholder. Small enough to cover the daily
    // kindness, large enough to be worth asking about.
    assert!(
        (100..=5_000).contains(&limit),
        "the threshold ({limit}) is outside any defensible range for a restaurant"
    );

    // And a cashier may give a discount AT OR BELOW it without anybody, which
    // is the whole reason it is an amount: `PostSale` is permitted, and only
    // the large-discount decision is not.
    assert!(authz::permits(Role::Cashier, Operation::PostSale));
    assert!(!authz::permits(Role::Cashier, Operation::PostSaleLargeDiscount));

    // `post_sale` consults the second permission only above the threshold.
    // Asserted against the source, because the alternative is a desktop run
    // per boundary value.
    let src = include_str!("../posting.rs");
    assert!(
        src.contains("if payload.discount_cents > crate::authz::DISCOUNT_WITHOUT_APPROVAL_CENTS"),
        "post_sale must compare the discount against the threshold, strictly"
    );
}

// ===========================================================================
// Structural guards
// ===========================================================================

/// EVERY writable command goes through `authz::begin`, and none opens a pool
/// any other way.
///
/// This is the guard that makes "backend enforcement" a property of the crate
/// rather than of twenty remembered edits. A behavioural test can only cover
/// the commands somebody wrote one for; this covers the ones nobody has written
/// yet.
#[test]
fn every_writable_command_authorizes_before_it_opens_a_pool() {
    let modules = [
        ("posting.rs", include_str!("../posting.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        ("admin.rs", include_str!("../admin.rs")),
    ];

    let mut commands = 0;
    for (name, src) in modules {
        // The ungated accessor must not be reachable from a command.
        assert!(
            !src.contains("pool(&app, &state)"),
            "{name} still opens a pool without authorizing; every command must \
             go through `authz::begin`"
        );

        for block in src.split("#[tauri::command]").skip(1) {
            let body = &block[..block.find("\n}").unwrap_or(block.len())];
            let signature = &body[..body.find(')').unwrap_or(body.len())];
            commands += 1;

            assert!(
                signature.contains("window: tauri::Window"),
                "a command in {name} does not take the calling window, so a \
                 second webview would inherit the session:\n{signature}"
            );
            assert!(
                body.contains("authz::begin("),
                "a command in {name} does not authorize:\n{signature}"
            );
        }
    }

    assert_eq!(
        commands, 20,
        "expected 20 writable commands across the four modules, found {commands}"
    );
}

/// `authorize_tx` writes no audit row, and `authorize` does.
///
/// The asymmetry is the subtle part of the design and it is easy to "fix" into
/// a bug: a `permission_denied` row written by `authorize_tx` would be inside
/// the transaction that is about to be rolled back, so the rollback would take
/// the evidence with it — an audit log that records only the refusals that
/// somehow succeeded.
#[test]
fn the_denial_is_logged_outside_the_transaction_only() {
    let src = include_str!("../authz.rs");

    let in_tx = src
        .split("pub(crate) async fn authorize_tx(")
        .nth(1)
        .expect("authorize_tx");
    let in_tx = &in_tx[..in_tx.find("\n}").expect("end")];
    assert!(
        !in_tx.contains("record_denial"),
        "authorize_tx must not write an audit row: it would be rolled back with \
         the transaction it refuses"
    );

    let boundary = src
        .split("pub(crate) async fn authorize(")
        .nth(1)
        .expect("authorize");
    let boundary = &boundary[..boundary.find("\n}").expect("end")];
    assert!(
        boundary.contains("record_denial"),
        "authorize must record the refusal — it is the only place that can"
    );
}

/// The privileged test actor is compile-time test-only.
///
/// The mandate for this work is explicit that there must be no
/// production-reachable default privileged test owner. `Actor::test_owner` and
/// every `*_with_pool` seam are `#[cfg(test)]`, so a release binary contains no
/// path that manufactures an owner.
#[test]
fn no_production_path_can_manufacture_a_privileged_actor() {
    let auth = include_str!("../auth.rs");
    for (needle, what) in [
        ("fn test_owner()", "Actor::test_owner"),
        ("fn for_tests(", "Actor::for_tests"),
    ] {
        let at = auth.find(needle).unwrap_or_else(|| panic!("{what} not found"));
        let preceding = &auth[..at];
        let gate = preceding
            .rfind("#[cfg(test)]")
            .unwrap_or_else(|| panic!("{what} has no preceding #[cfg(test)]"));

        // Between the gate and the function there may be only whitespace and
        // visibility/async keywords. Anything else means the `#[cfg(test)]`
        // belongs to a DIFFERENT item and this one is not gated at all — which
        // is the defect this test exists to catch, so the check has to be about
        // adjacency rather than mere presence.
        let between = preceding[gate + "#[cfg(test)]".len()..].trim();
        let leftovers: Vec<&str> = between
            .split_whitespace()
            .filter(|word| !matches!(*word, "pub" | "pub(crate)" | "async" | "fn"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "{what} is not DIRECTLY gated by #[cfg(test)] — found {leftovers:?} \
             between the attribute and the function, so the attribute belongs to \
             something else"
        );
    }

    // EVERY USE of the test actor must sit inside a `#[cfg(test)]` item.
    //
    // Merely counting mentions is not the check: the `*_with_pool` seams
    // legitimately supply it, and they are themselves `#[cfg(test)]`. What must
    // not exist is a use inside something that COMPILES INTO A RELEASE BINARY —
    // a command, a helper, a `_tx`. So for each use, walk back to the function
    // that encloses it and require the gate above that function.
    for (name, src) in [
        ("posting.rs", include_str!("../posting.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        ("admin.rs", include_str!("../admin.rs")),
        ("read_api.rs", include_str!("../read_api.rs")),
        ("authz.rs", include_str!("../authz.rs")),
    ] {
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with('*') {
                continue;
            }
            if !trimmed.contains("Actor::test_owner") {
                continue;
            }

            // The enclosing item: the nearest preceding line that declares a
            // function at the top level of the module.
            let declaration = (0..i).rev().find(|&j| {
                let l = lines[j];
                !l.starts_with(' ') && l.contains("fn ")
            });
            let declaration = declaration.unwrap_or_else(|| {
                panic!("{name}:{} uses the test actor outside any function", i + 1)
            });

            // Attributes sit directly above it.
            let gated = (0..declaration).rev().take_while(|&j| {
                let l = lines[j].trim();
                l.starts_with("#[") || l.starts_with("///") || l.starts_with("//") || l.is_empty()
            }).any(|j| lines[j].trim() == "#[cfg(test)]");

            assert!(
                gated,
                "{name}:{} uses the test actor inside `{}`, which is NOT \
                 #[cfg(test)] — that function compiles into a release binary and \
                 would manufacture a privileged owner",
                i + 1,
                lines[declaration].trim()
            );
        }
    }
}

// ===========================================================================
// The session is still the only source of an actor
// ===========================================================================

/// `authz::begin` takes the actor from the session, and the session gate still
/// closes the door when nobody is signed in.
///
/// `begin` itself needs a Tauri runtime, so this drives the two halves it is
/// composed of: the session gate (already covered in `auth_session`, asserted
/// again here because B.1's claim rests on it) and the authorization that
/// follows.
#[tokio::test]
async fn an_unauthenticated_caller_never_reaches_the_permission_check() {
    let db = staffed().await;
    let state = crate::posting::DbState::new();
    state.mark_startup_ready().await;
    let sessions = SessionState::new();

    // No session: no pool, so no operation is even considered.
    let refused = crate::posting::pool_for_state(&state, &sessions, db.path())
        .await
        .expect_err("no session, no pool");
    assert!(refused.contains("LOCKED"), "{refused}");
    assert!(
        state.pool.lock().await.is_none(),
        "a refused acquisition must open nothing"
    );

    // And `current_actor` refuses too, so there is no actor to authorize.
    assert!(
        sessions.current_actor().await.is_err(),
        "there must be no actor without a session"
    );

    // Signed in as a cashier: an actor exists, and the matrix applies to it.
    sessions
        .open_for_tests(CASHIER, STORE, Role::Cashier)
        .await;
    let actor = sessions
        .current_actor()
        .await
        .expect("a signed-in session yields an actor");
    assert_eq!(actor.user_id, CASHIER);
    assert_eq!(actor.role, Role::Cashier);

    authz::authorize(db.pool(), &actor, Operation::PostSale)
        .await
        .expect("a cashier may post a sale");
    assert!(
        authz::authorize(db.pool(), &actor, Operation::PostCreditMemo)
            .await
            .is_err(),
        "a cashier may not refund"
    );

    // A LOCKED session yields no actor either, so locking the screen removes
    // the authority and not merely the view.
    sessions.lock_for_tests().await.expect("lock");
    assert!(
        sessions.current_actor().await.is_err(),
        "a locked session must yield no actor"
    );

    state.close_pool().await;
    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// The four corrections independent review raised against Stage B
// ===========================================================================

/// GZ-B-P1 — A DRIVER LEDGER ADJUSTMENT IS NOT A REMITTANCE.
///
/// `post_driver_remittance` posts two different things, and the matrix answers
/// them differently: taking a driver's hand-over is front-of-house work bounded
/// by what he owes, so a cashier may do it, while writing a balance down by
/// hand is a correction and corrections are supervision.
///
/// The command authorized every payload as `DriverRemittance`, so a cashier
/// could post an adjustment with any direction and amount — writing off a
/// driver's debt. Both checks now select the permission from the validated
/// entry type, through ONE shared function so they cannot drift apart.
#[test]
fn a_driver_adjustment_needs_the_adjustment_permission_not_the_remittance_one() {
    assert!(authz::permits(Role::Cashier, Operation::DriverRemittance));
    assert!(!authz::permits(Role::Cashier, Operation::DriverLedgerAdjustment));
    assert!(authz::permits(Role::Manager, Operation::DriverLedgerAdjustment));

    let src = include_str!("../posting.rs");
    assert!(
        src.contains("fn driver_entry_operation("),
        "the permission must be derived by one shared function"
    );
    assert_eq!(
        src.matches("driver_entry_operation(&payload)").count(),
        2,
        "both the boundary check and the in-transaction check must use it"
    );

    let derivation = src
        .split("fn driver_entry_operation(")
        .nth(1)
        .expect("the derivation");
    let body = &derivation[..derivation.find("\n}").expect("end")];
    assert!(
        body.contains("adjustment") && body.contains("DriverLedgerAdjustment"),
        "an adjustment must map to the adjustment permission: {body}"
    );
}

/// GZ-B-P2 — THE DOCUMENT MUST BELONG TO THE ACTOR'S OWN SHOP.
///
/// Both authorization checks confirm the actor still belongs to the store on
/// their own `users` row. Neither looked at the store on the DOCUMENT, so a
/// cashier of branch A could name branch B's products, shift and rate and post
/// a branch B sale attributed to a branch A user: every individual check
/// passed, and nothing compared the two.
#[test]
fn the_store_check_compares_the_actor_with_the_document() {
    let who = Actor::for_tests(CASHIER, STORE, Role::Cashier);

    authz::require_same_store(&who, STORE).expect("their own shop is allowed");

    let refused = authz::require_same_store(&who, "store-2")
        .expect_err("another shop's document must be refused");
    assert!(refused.contains("another shop"), "{refused}");
    assert!(refused.contains("Nothing has been changed"), "{refused}");

    // Every module with transactional implementations performs it.
    for (name, src) in [
        ("posting.rs", include_str!("../posting.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
    ] {
        assert!(
            src.contains("require_same_store("),
            "{name} performs no store check at all"
        );
    }
}

/// GZ-B-P2 — THE ADMINISTRATIVE COMMANDS AUTHORIZE AT COMMIT TOO, and the two
/// with no transaction scope their write by store.
#[test]
fn the_administrative_commands_authorize_at_commit_and_scope_by_store() {
    let src = include_str!("../admin.rs");

    assert_eq!(
        src.matches("crate::authz::authorize_tx(&mut tx, &actor,").count(),
        5,
        "all five administrative commands must re-authorize inside a \
         transaction — including the two activations, which had no transaction \
         at all until round 2 of the review"
    );

    // The two single-statement ones scope the UPDATE itself, which is stronger
    // than checking first: the scoping IS the write, so there is no window.
    // Every statement that addresses a row by id is scoped by store: the two
    // activations, and both save commands' existence probe and update.
    assert!(
        src.matches("AND store_id = ?").count() >= 6,
        "every id-addressed statement must be scoped by store, found {}",
        src.matches("AND store_id = ?").count()
    );
    assert!(
        src.matches(".bind(&actor.store_id)").count() >= 6,
        "and each must bind the actor's store"
    );
    // The create branches compare the named store with the actor's.
    assert_eq!(
        src.matches("require_same_store(&actor,").count(),
        3,
        "the exchange rate and both save commands must require the actor's own shop"
    );
}

/// GZ-B-P2 — THE CONDITIONAL DECISIONS HOLD AT COMMIT, not only at the
/// boundary.
///
/// Each of the three was checked once, before its transaction opened. So a user
/// demoted in between could still commit the thing the second permission was
/// meant to stop: an owner demoted to manager committing a cost change, a
/// cashier committing a large discount, a cashier closing somebody else's
/// shift.
#[test]
fn every_conditional_permission_is_re_evaluated_inside_the_transaction() {
    let posting = include_str!("../posting.rs");
    let catalog = include_str!("../catalog.rs");

    let window_of = |src: &'static str, name: &str| -> &'static str {
        let after = src
            .split(name)
            .nth(1)
            .unwrap_or_else(|| panic!("{name} not found"));
        &after[..after.len().min(14_000)]
    };

    let sale_tx = window_of(posting, "pub(crate) async fn post_sale_tx(");
    assert!(
        sale_tx.contains("Operation::PostSaleLargeDiscount"),
        "post_sale_tx must re-check the large-discount permission"
    );

    let close_tx = window_of(posting, "pub(crate) async fn close_shift_tx(");
    assert!(
        close_tx.contains("Operation::CloseAnotherShift"),
        "close_shift_tx must re-check whose shift it is"
    );
    assert!(
        close_tx.contains("SELECT opened_by_user_id FROM shifts"),
        "and must read the opener inside its own transaction"
    );

    let save_tx = window_of(catalog, "pub(crate) async fn save_product_tx(");
    assert!(
        save_tx.contains("Operation::SaveProductCost"),
        "save_product_tx must re-check the cost permission"
    );
    assert!(
        save_tx.contains("cost_fields_would_change_tx("),
        "and must compare against the stored costing pair inside the transaction"
    );
}

/// The boundary and in-transaction cost comparisons apply the SAME rule.
///
/// They are two functions because their callers want different lifetimes, so
/// this is what stops them answering differently — which would mean a manager
/// blocked at the boundary and allowed at commit, or the reverse.
#[test]
fn the_two_cost_comparisons_agree() {
    let src = include_str!("../catalog.rs");

    for name in ["cost_fields_would_change(", "cost_fields_would_change_tx("] {
        let after = src
            .split(&format!("async fn {name}"))
            .nth(1)
            .unwrap_or_else(|| panic!("{name} not found"));
        let body = &after[..after.find("\n}").expect("end")];
        assert!(
            body.contains("costing_method, standard_cost_excl_vat_microcents"),
            "{name} must read the same two columns"
        );
        assert!(
            body.contains("purchase_average"),
            "{name} must apply the same default"
        );
        assert!(
            body.contains("method_moves || cost_moves"),
            "{name} must apply the same rule"
        );
    }
}

/// And the recorded residual is recorded: the discount control's limit is named
/// in the policy, and the gap has a measured test rather than a sentence.
#[test]
fn the_discount_controls_limit_is_written_down_and_measured() {
    let authz_src = include_str!("../authz.rs");
    assert!(
        authz_src.contains("DISCOUNT_CONTROL_LIMIT"),
        "the limit of the discount control must be named in the policy"
    );
    assert!(
        authz_src.contains("GZ-B-P1"),
        "and attributed to the finding that raised it"
    );

    let defects = include_str!("known_defects.rs");
    assert!(
        defects.contains("gz_b_p1_a_sale_price_cannot_be_used_to_give_an_unapproved_discount"),
        "the gap must have a test in the known-defect register, not just prose"
    );
    assert!(
        defects.contains("#[ignore = \"GZ-B-P1"),
        "and it must be registered as a defect the implementation still has"
    );
}

// ===========================================================================
// Round 2 of the review: the administrative commands, behaviourally
// ===========================================================================

/// `authz::begin` IS THE ONLY ROUTE TO A POOL.
///
/// Every command used to open with `posting::pool(&app, &state)`. That function
/// now has exactly ONE caller in the whole crate — `authz::begin` — which is
/// what makes "the window is checked, the gates run, the actor is resolved and
/// the operation is authorized" true of every command rather than of the
/// twenty somebody edited. The modules that used to import it no longer can.
#[test]
fn the_command_boundary_is_the_only_route_to_a_pool() {
    let mut callers = Vec::new();
    for (name, src) in [
        ("authz.rs", include_str!("../authz.rs")),
        ("posting.rs", include_str!("../posting.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        ("admin.rs", include_str!("../admin.rs")),
        ("read_api.rs", include_str!("../read_api.rs")),
        ("auth.rs", include_str!("../auth.rs")),
    ] {
        for line in src.lines() {
            let t = line.trim_start();
            if t.starts_with("//") || t.starts_with('*') || t.starts_with("///") {
                continue;
            }
            if t.contains("crate::posting::pool(") || t.contains(" pool(&app, &state)") {
                callers.push(format!("{name}: {}", t.trim()));
            }
        }
    }
    assert_eq!(
        callers.len(),
        1,
        "exactly one function may open the shared pool, found: {callers:?}"
    );
    assert!(callers[0].starts_with("authz.rs"), "{:?}", callers[0]);
}

/// AN ADMINISTRATIVE COMMAND CANNOT REACH ANOTHER SHOP — driven through the
/// real commands, not through a copy of their SQL.
///
/// Round 2 of the review noted that the previous coverage was a source count,
/// which cannot tell a scoped statement from one that merely mentions a store.
/// These are behavioural, and they are possible because the five commands now
/// have `*_as` seams — which also closes the Gate 2A P2 that
/// `tests::admin_commands` had been working around by re-implementing their
/// statements.
#[tokio::test]
async fn an_administrative_command_cannot_reach_another_shop() {
    use crate::admin::*;

    let db = staffed().await;
    crate::test_support::seed_store(&db, "store-b", "Branch B").await;

    let ours = Actor::for_tests(MANAGER, STORE, Role::Manager);
    let theirs = Actor::for_tests(
        &crate::test_support::seeded_owner_of("store-b"),
        "store-b",
        Role::Owner,
    );

    // --- a driver of branch B -------------------------------------------
    driver_save_as(
        db.pool(),
        &theirs,
        DriverSaveArgs {
            id: "driver-b".to_string(),
            store_id: Some("store-b".to_string()),
            name: "Branch B Driver".to_string(),
            phone: None,
            notes: None,
        },
    )
    .await
    .expect("branch B's own owner may add branch B's driver");

    // Our manager cannot RENAME it. The row is addressable by id, and before
    // the fix nothing compared its store with theirs.
    driver_save_as(
        db.pool(),
        &ours,
        DriverSaveArgs {
            id: "driver-b".to_string(),
            store_id: None,
            name: "Renamed By Branch A".to_string(),
            phone: None,
            notes: None,
        },
    )
    .await
    .expect_err("another branch's driver is not ours to rename");
    assert_eq!(
        db.scalar_string("SELECT name FROM drivers WHERE id = 'driver-b'")
            .await,
        "Branch B Driver",
        "and the name must not have moved"
    );

    // Nor RETIRE it.
    driver_set_active_as(
        db.pool(),
        &ours,
        DriverSetActiveArgs {
            id: "driver-b".to_string(),
            is_active: false,
        },
    )
    .await
    .expect_err("another branch's driver is not ours to retire");
    assert_eq!(
        db.scalar_i64("SELECT is_active FROM drivers WHERE id = 'driver-b'")
            .await,
        1,
        "and it must still be active"
    );

    // Nor CREATE one in their shop.
    driver_save_as(
        db.pool(),
        &ours,
        DriverSaveArgs {
            id: "driver-b2".to_string(),
            store_id: Some("store-b".to_string()),
            name: "Planted".to_string(),
            phone: None,
            notes: None,
        },
    )
    .await
    .expect_err("a driver may not be added to another shop");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM drivers WHERE id = 'driver-b2'")
            .await,
        0
    );

    // --- and the exchange rate, which reaches a posted figure ------------
    exchange_rate_save_as(
        db.pool(),
        &ours,
        ExchangeRateSaveArgs {
            id: crate::tests::builders::uuid(),
            store_id: "store-b".to_string(),
            effective_date: "2026-11-08".to_string(),
            rate_lbp_per_usd: 1,
            source: None,
            notes: None,
            created_by_user_id: None,
        },
    )
    .await
    .expect_err("another shop's exchange rate is not ours to set");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM exchange_rates WHERE store_id = 'store-b'")
            .await,
        0,
        "a lira must not be revalued in a shop we have no claim on"
    );

    // Our OWN shop still works, so the scoping is not a wall.
    exchange_rate_save_as(
        db.pool(),
        &ours,
        ExchangeRateSaveArgs {
            id: crate::tests::builders::uuid(),
            store_id: STORE.to_string(),
            effective_date: "2026-11-08".to_string(),
            rate_lbp_per_usd: 89_500,
            source: None,
            notes: None,
            created_by_user_id: Some(MANAGER.to_string()),
        },
    )
    .await
    .expect("our own shop's rate is ours to set");

    db.cleanup().await.expect("remove TempDb");
}

/// A CASHIER CANNOT USE AN ADMINISTRATIVE COMMAND AT ALL, and the refusal
/// happens inside the transaction as well as at the boundary.
#[tokio::test]
async fn a_cashier_cannot_use_an_administrative_command() {
    use crate::admin::*;

    let db = staffed().await;
    let cashier = Actor::for_tests(CASHIER, STORE, Role::Cashier);

    let refused = exchange_rate_save_as(
        db.pool(),
        &cashier,
        ExchangeRateSaveArgs {
            id: crate::tests::builders::uuid(),
            store_id: STORE.to_string(),
            effective_date: "2026-11-08".to_string(),
            rate_lbp_per_usd: 1,
            source: None,
            notes: None,
            created_by_user_id: Some(CASHIER.to_string()),
        },
    )
    .await
    .expect_err("a cashier may not set the exchange rate");
    assert!(refused.contains("set the exchange rate"), "{refused}");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM exchange_rates").await,
        0,
        "and nothing may be written"
    );

    for outcome in [
        driver_save_as(
            db.pool(),
            &cashier,
            DriverSaveArgs {
                id: crate::tests::builders::uuid(),
                store_id: Some(STORE.to_string()),
                name: "Nope".to_string(),
                phone: None,
                notes: None,
            },
        )
        .await
        .err(),
        supplier_save_as(
            db.pool(),
            &cashier,
            SupplierSaveArgs {
                id: crate::tests::builders::uuid(),
                store_id: Some(STORE.to_string()),
                name: "Nope".to_string(),
                contact_name: None,
                phone: None,
                email: None,
                notes: None,
            },
        )
        .await
        .err(),
    ] {
        let message = outcome.expect("a cashier may not change master data");
        assert!(message.contains("Ask a manager or the owner"), "{message}");
    }
    assert_eq!(db.count("SELECT count(*) AS n FROM drivers").await, 0);
    assert_eq!(db.count("SELECT count(*) AS n FROM suppliers").await, 0);

    db.cleanup().await.expect("remove TempDb");
}

/// A DEMOTION BETWEEN THE BOUNDARY AND THE COMMIT IS HONOURED by an
/// administrative command too.
///
/// The `_as` seam enters BELOW the boundary check, so calling it with an actor
/// whose stored role no longer permits the operation is exactly the state the
/// window produces — and the in-transaction check is what must catch it.
#[tokio::test]
async fn an_administrative_command_honours_a_demotion_at_commit() {
    use crate::admin::*;

    let db = staffed().await;
    let was_manager = Actor::for_tests(MANAGER, STORE, Role::Manager);

    authz::authorize(db.pool(), &was_manager, Operation::ExchangeRateSave)
        .await
        .expect("the boundary passes while they are still a manager");

    db.exec(&format!(
        "UPDATE users SET role = 'cashier' WHERE id = '{MANAGER}'"
    ))
    .await;

    let refused = exchange_rate_save_as(
        db.pool(),
        &was_manager,
        ExchangeRateSaveArgs {
            id: crate::tests::builders::uuid(),
            store_id: STORE.to_string(),
            effective_date: "2026-11-08".to_string(),
            rate_lbp_per_usd: 1,
            source: None,
            notes: None,
            created_by_user_id: Some(MANAGER.to_string()),
        },
    )
    .await
    .expect_err("the in-transaction check must honour the demotion");
    assert!(refused.contains("set the exchange rate"), "{refused}");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM exchange_rates").await,
        0
    );

    // And the two activation commands, which had no transaction at all before
    // round 2 of the review.
    db.exec(&format!(
        "UPDATE users SET role = 'manager' WHERE id = '{MANAGER}'"
    ))
    .await;
    driver_save_as(
        db.pool(),
        &was_manager,
        DriverSaveArgs {
            id: "driver-a".to_string(),
            store_id: Some(STORE.to_string()),
            name: "Ours".to_string(),
            phone: None,
            notes: None,
        },
    )
    .await
    .expect("a manager may add a driver");

    db.exec(&format!(
        "UPDATE users SET role = 'cashier' WHERE id = '{MANAGER}'"
    ))
    .await;
    driver_set_active_as(
        db.pool(),
        &was_manager,
        DriverSetActiveArgs {
            id: "driver-a".to_string(),
            is_active: false,
        },
    )
    .await
    .expect_err("a demoted user must not retire a driver");
    assert_eq!(
        db.scalar_i64("SELECT is_active FROM drivers WHERE id = 'driver-a'")
            .await,
        1,
        "and the driver must still be active, so the transaction rolled back"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// THE DECLARED DISCOUNT CANNOT BE WRAPPED PAST THE PERMISSION.
///
/// GZ-B-R2-P1 (round 2). `i64::sum()` wraps in a release build and panics only
/// in debug, so an unchecked fold over caller-supplied line discounts was a
/// figure the machine could already have lost: line discounts totalling
/// 2^64 + 1 wrap to 1, reconcile against a declared `discount_cents` of 1, and
/// pass both the reconciliation and the large-discount permission that reads
/// the same field.
///
/// Every aggregate in `prepare_sale` is now folded with `checked_add`, not just
/// the discount — the same argument applies to the subtotal, the VAT total, the
/// line total and the tender, all of which end up on a posted row.
#[test]
fn an_overflowing_sale_aggregate_is_refused_rather_than_wrapped() {
    let src = include_str!("../posting.rs");
    let prepare = src
        .split("pub(crate) fn prepare_sale(")
        .nth(1)
        .expect("prepare_sale");
    let body = &prepare[..prepare.len().min(14_000)];

    // No unchecked aggregation survives over caller-supplied figures.
    for forbidden in [
        ".map(|l| l.line_discount_cents).sum()",
        ".map(|l| l.line_subtotal_excl_vat_cents).sum()",
        ".map(|l| l.line_vat_cents).sum()",
        ".map(|l| l.line_total_incl_vat_cents).sum()",
        ".map(|p| p.amount_usd_cents_equivalent)\n        .sum()",
    ] {
        assert!(
            !body.contains(forbidden),
            "prepare_sale still folds caller figures without checking: `{forbidden}`"
        );
    }

    assert!(
        body.matches("checked_add").count() >= 2,
        "the aggregates must be folded with checked_add"
    );
    assert!(
        body.contains("too large to add up"),
        "and overflow must be refused with something an operator can read"
    );
}

/// The same, behaviourally: a sale whose line discounts overflow is refused.
///
/// Debug builds panic on overflow, so the arithmetic itself cannot be driven to
/// wrap here — which is precisely why the release-build route was invisible.
/// What CAN be driven is the refusal, by handing it figures whose sum does not
/// fit, and asserting it comes back as a sentence rather than as a wrapped
/// number that reconciles.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_whose_discounts_do_not_fit_is_refused() {
    let db = staffed().await;
    crate::test_support::seed_exchange_rate(&db).await;
    crate::test_support::seed_product(
        &db,
        &crate::test_support::ProductSpec {
            quantity_on_hand: 100,
            ..crate::test_support::ProductSpec::stocked(
                "00000000-0000-0000-0000-0000000000c1",
                "SKU-C1",
                "Coffee",
            )
        },
    )
    .await;

    let mut payload = crate::tests::builders::sale_payload(
        vec![
            crate::tests::builders::SaleLineBuilder::new(
                "00000000-0000-0000-0000-0000000000c1",
                "Coffee",
            )
            .qty(1)
            .unit_incl(999)
            .discount(i64::MAX)
            .build(),
            crate::tests::builders::SaleLineBuilder::new(
                "00000000-0000-0000-0000-0000000000c1",
                "Coffee",
            )
            .qty(1)
            .unit_incl(999)
            .discount(i64::MAX)
            .build(),
        ],
        vec![crate::tests::builders::cash_usd(1)],
    );
    payload.discount_cents = 1;

    let refused = crate::posting::prepare_sale(&payload)
        .expect_err("a discount total that does not fit must be refused");
    assert!(
        refused.contains("too large to add up"),
        "it must be refused as an overflow, not reconciled against a wrapped \
         figure: {refused}"
    );

    db.cleanup().await.expect("remove TempDb");
}
