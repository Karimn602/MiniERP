//! GATE 2B STAGE B.2 — authorization INSIDE the transaction, and the one
//! ordering that must not be got wrong.
//!
//! THE HAZARD, stated plainly because it is the highest-consequence regression
//! risk in the whole gate.
//!
//! `post_sale` is idempotent on `sales.id`, and that contract is the only thing
//! between a lost response and a double charge. The register freezes the
//! complete request into `localStorage` with a read-back proof BEFORE invoking,
//! precisely so the request can be re-sent. But a frozen attempt is replayed by
//! WHOEVER IS AT THE TILL when the application comes back — which, after a
//! crash at the end of a shift, is the next shift's cashier, or an owner who has
//! since deactivated the person who rang it.
//!
//! So if authorization ran BEFORE the idempotency resolution, the recovery path
//! would be refused on a permission the original operator had and the current
//! one does not — and the cashier, told "you cannot do that", would ring the
//! order again. That is the double charge the whole machinery exists to prevent,
//! introduced by the thing meant to make the till safer.
//!
//! The ordering is therefore: resolve the identity, return the original result
//! if it is a replay, and only then authorize. These tests drive that against a
//! real database, from both sides.

use crate::auth::{Actor, Role};
use crate::authz::{self, Operation};
use crate::posting::{post_adjustment_tx, post_sale_tx, prepare_sale};
use crate::test_support::*;
use crate::tests::builders::*;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";
const MANAGER: &str = "00000000-0000-0000-0000-0000000000a1";
const CASHIER: &str = "00000000-0000-0000-0000-0000000000a2";
const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";

async fn staffed_store_with_stock() -> TempDb {
    let db = TempDb::new().await;
    for (id, name, role) in [
        (MANAGER, "Mona", "manager"),
        (CASHIER, "Sami", "cashier"),
    ] {
        db.exec(&format!(
            "INSERT INTO users (id, store_id, full_name, role)
             VALUES ('{id}', '{STORE}', '{name}', '{role}')"
        ))
        .await;
    }
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 50,
            avg_cost_excl_vat_cents: 250,
            avg_cost_incl_vat_cents: 278,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db
}

fn actor(role: Role) -> Actor {
    let id = match role {
        Role::Owner => OWNER,
        Role::Manager => MANAGER,
        Role::Cashier => CASHIER,
    };
    Actor::for_tests(id, STORE, role)
}

async fn open_a_shift(db: &TempDb, user: &str) -> String {
    let shift = uuid();
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('{shift}', '{STORE}', '{user}', '2026-11-08T08:00:00.000Z', 'open',
                 10000, 0)"
    ))
    .await;
    shift
}

// ===========================================================================
// THE ORDERING
// ===========================================================================

/// A REPLAY RECONCILES EVEN THOUGH THE CASHIER MAY NO LONGER POST.
///
/// The scenario is the realistic one: the cashier rings a sale, the answer is
/// lost, their shift ends and the owner deactivates the account. The recovery
/// path then replays the frozen request. It MUST return the original receipt —
/// one sale, one receipt number, the original actor — because the alternative
/// is a cashier being told to ring it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_reconciles_after_the_cashier_can_no_longer_post() {
    let db = staffed_store_with_stock().await;
    let shift = open_a_shift(&db, CASHIER).await;
    let cashier = actor(Role::Cashier);

    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(999).build()],
        vec![cash_usd(1998)],
    );
    payload.shift_id = Some(shift.clone());
    payload.cashier_user_id = Some(CASHIER.to_string());

    // The original sale, posted by a cashier who was allowed to.
    let original = replay_of(&payload);
    let prepared = prepare_sale(&original).expect("prepare");
    let first = post_sale_tx(db.pool(), &cashier, original, prepared)
        .await
        .expect("a cashier may post a sale");

    assert_eq!(db.count("SELECT count(*) AS n FROM sales").await, 1);
    let receipt = first.receipt_number;

    // THE ACCOUNT IS DEACTIVATED. From here `authorize_tx` refuses this actor
    // everything — which is correct for anything NEW.
    db.exec(&format!("UPDATE users SET active = 0 WHERE id = '{CASHIER}'"))
        .await;
    assert!(
        authz::authorize(db.pool(), &cashier, Operation::PostSale)
            .await
            .is_err(),
        "a deactivated cashier must not be able to post a NEW sale"
    );

    // THE REPLAY STILL WORKS. Same identity, same canonical content, the way
    // the frozen attempt re-sends it.
    let replay = replay_of(&payload);
    let prepared = prepare_sale(&replay).expect("prepare replay");
    let second = post_sale_tx(db.pool(), &cashier, replay, prepared)
        .await
        .expect(
            "a replay must reconcile whatever the current operator may do — \
             refusing it is how a lost response becomes a double charge",
        );

    assert_eq!(
        second.receipt_number, receipt,
        "the replay must return the ORIGINAL receipt number"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM sales").await,
        1,
        "and must not have created a second sale"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM sale_payments").await,
        1,
        "nor a second payment — this is the double charge being prevented"
    );
    assert_eq!(
        db.scalar_string("SELECT cashier_user_id FROM sales")
            .await,
        CASHIER,
        "and the sale still names the cashier who actually rang it"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// AND A REPLAY BY A DIFFERENT PERSON RECONCILES TOO.
///
/// The frozen attempt carries the original cashier's id, and that id is part of
/// the sale's canonical content — so the replay is compared against the sale as
/// posted and matches. What must NOT happen is the current operator's identity
/// being substituted into the comparison, which would make every cross-user
/// recovery look like a conflict.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_by_a_different_operator_reconciles_to_the_original() {
    let db = staffed_store_with_stock().await;
    let shift = open_a_shift(&db, CASHIER).await;

    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(999).build()],
        vec![cash_usd(999)],
    );
    payload.shift_id = Some(shift);
    payload.cashier_user_id = Some(CASHIER.to_string());

    let original = replay_of(&payload);
    let prepared = prepare_sale(&original).expect("prepare");
    let first = post_sale_tx(db.pool(), &actor(Role::Cashier), original, prepared)
        .await
        .expect("the cashier posts it");

    // The owner comes in the next morning and the recovery path replays it.
    let replay = replay_of(&payload);
    let prepared = prepare_sale(&replay).expect("prepare replay");
    let second = post_sale_tx(db.pool(), &actor(Role::Owner), replay, prepared)
        .await
        .expect("the owner's session may still resolve the cashier's attempt");

    assert_eq!(second.receipt_number, first.receipt_number);
    assert_eq!(db.count("SELECT count(*) AS n FROM sales").await, 1);
    assert_eq!(
        db.scalar_string("SELECT cashier_user_id FROM sales").await,
        CASHIER,
        "the sale keeps the cashier who rang it — the replay does not re-attribute it"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// The ordering, asserted STRUCTURALLY in each of the four idempotent
/// commands.
///
/// The behavioural tests above cover `post_sale`. This covers the other three,
/// and it covers them in the way that matters: a behavioural test proves the
/// order for the path it drives, and this proves it for the source. If somebody
/// moves `authorize_tx` above the identity load in `post_credit_memo_tx`, this
/// fails and the four-fixture behavioural test nobody wrote does not.
#[test]
fn authorization_follows_the_identity_resolution_in_every_idempotent_command() {
    let src = include_str!("../posting.rs");

    for (fn_name, identity_load) in [
        ("post_sale_tx", "load_sale_by_identity"),
        ("post_purchase_tx", "by_identity"),
        ("post_supplier_payment_tx", "by_identity"),
        ("post_credit_memo_tx", "by_identity"),
        ("post_driver_remittance_tx", "by_identity"),
    ] {
        let after = src
            .split(&format!("pub(crate) async fn {fn_name}("))
            .nth(1)
            .unwrap_or_else(|| panic!("{fn_name} not found"));
        let body = &after[..after.find("\n}").unwrap_or(after.len())];

        let load_at = body
            .find(identity_load)
            .unwrap_or_else(|| panic!("{fn_name} does not resolve an identity"));
        let authorize_at = body
            .find("authorize_tx(")
            .unwrap_or_else(|| panic!("{fn_name} does not authorize inside its transaction"));

        assert!(
            load_at < authorize_at,
            "{fn_name} authorizes BEFORE resolving the identity. A replay would \
             then be refused on a permission the original operator had and the \
             current one does not, which turns the one defence against a double \
             charge into a double charge."
        );

        // And the authorization precedes every write, so a refusal consumes no
        // number.
        if let Some(first_write) = body.find("INSERT INTO") {
            assert!(
                authorize_at < first_write,
                "{fn_name} writes before it authorizes"
            );
        }
    }
}

/// Every `_tx` authorizes. The guard that covers the commands nobody has
/// written yet.
#[test]
fn every_transactional_implementation_authorizes_inside_its_transaction() {
    let modules = [
        ("posting.rs", include_str!("../posting.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
    ];

    let mut checked = 0;
    for (name, src) in modules {
        for block in src.split("pub(crate) async fn ").skip(1) {
            let signature = &block[..block.find(')').unwrap_or(block.len())];
            if !signature.starts_with(|c: char| c.is_ascii_lowercase()) {
                continue;
            }
            let fn_name = signature.split('(').next().unwrap_or("");
            if !fn_name.ends_with("_tx") {
                continue;
            }
            let body = &block[..block.find("\n}").unwrap_or(block.len())];
            // Only the ones that open their own transaction.
            if !body.contains("pool.begin()") {
                continue;
            }
            checked += 1;
            assert!(
                signature.contains("actor: &crate::auth::Actor"),
                "{name}::{fn_name} does not take an actor"
            );
            assert!(
                body.contains("authorize_tx("),
                "{name}::{fn_name} opens a transaction without authorizing in it"
            );
        }
    }

    assert_eq!(
        checked, 12,
        "expected 12 transactional implementations, found {checked}"
    );
}

// ===========================================================================
// A refusal inside the transaction leaves nothing behind
// ===========================================================================

/// A CASHIER'S STOCK ADJUSTMENT IS REFUSED, AND NOTHING MOVES.
///
/// This is the deployment promise with teeth on it: adjusting stock is how a
/// shortfall gets covered up, and the test asserts not only the refusal but the
/// absence of every effect — no movement row, no change to
/// `quantity_on_hand`, no cost disturbed. The refusal happens inside the
/// transaction, so the rollback is what guarantees it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cashiers_stock_adjustment_is_refused_and_moves_no_stock() {
    let db = staffed_store_with_stock().await;
    let before_qty = quantity_on_hand(&db, P_COFFEE).await;
    let before_movements = db
        .count("SELECT count(*) AS n FROM inventory_movements")
        .await;

    let refused = post_adjustment_tx(
        db.pool(),
        &actor(Role::Cashier),
        adjustment_payload("stock count correction", vec![adjustment_line(P_COFFEE, -10)]),
    )
    .await
    .expect_err("a cashier must not be able to adjust stock");

    assert!(
        refused.contains("change the stock count"),
        "the refusal should name the action: {refused}"
    );
    assert!(
        refused.contains("Nothing has been changed"),
        "and reassure that nothing moved: {refused}"
    );

    assert_eq!(
        quantity_on_hand(&db, P_COFFEE).await,
        before_qty,
        "the stock must not have moved"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM inventory_movements")
            .await,
        before_movements,
        "and no movement row may be left behind"
    );

    // A MANAGER may, so the refusal is about the role and not about the
    // payload. The declared actor is set to the manager, because the
    // attribution cross-check refuses a request that names somebody else —
    // which is itself asserted separately.
    let mut as_manager =
        adjustment_payload("stock count correction", vec![adjustment_line(P_COFFEE, -10)]);
    as_manager.created_by_user_id = Some(MANAGER.to_string());
    post_adjustment_tx(db.pool(), &actor(Role::Manager), as_manager)
        .await
        .expect("a manager may adjust stock");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, before_qty - 10);

    db.cleanup().await.expect("remove TempDb");
}

/// A role changed between the boundary and the commit is honoured by the
/// in-transaction check.
///
/// This is the whole reason there are two checks. The boundary check cannot see
/// a change that happens after it; the in-transaction one re-reads. Simulated by
/// calling `_tx` directly with an actor whose stored role no longer permits the
/// operation — which is exactly the state the window produces.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_demotion_between_the_boundary_and_the_commit_is_honoured() {
    let db = staffed_store_with_stock().await;

    // An actor that was a manager when the command started.
    let was_manager = Actor::for_tests(MANAGER, STORE, Role::Manager);
    authz::authorize(db.pool(), &was_manager, Operation::PostAdjustment)
        .await
        .expect("the boundary check passes while they are still a manager");

    // The owner demotes them while the command is in flight.
    db.exec(&format!(
        "UPDATE users SET role = 'cashier' WHERE id = '{MANAGER}'"
    ))
    .await;

    // The transaction refuses, because it re-reads.
    let refused = post_adjustment_tx(
        db.pool(),
        &was_manager,
        adjustment_payload("stock count correction", vec![adjustment_line(P_COFFEE, 5)]),
    )
    .await
    .expect_err("the in-transaction check must honour the demotion");
    assert!(refused.contains("change the stock count"), "{refused}");
    assert_eq!(
        db.count("SELECT count(*) AS n FROM inventory_movements")
            .await,
        0,
        "and nothing is written"
    );

    db.cleanup().await.expect("remove TempDb");
}
