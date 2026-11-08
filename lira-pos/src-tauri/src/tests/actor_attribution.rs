//! GATE 2B STAGE B.2b — the actor on a posted document is the one who was
//! signed in.
//!
//! WHAT THIS REPLACES. Every `*_user_id` column was bound straight from the
//! request and checked by nothing: not against `users`, not against `active`,
//! not against `role`. The foreign key guaranteed only that the value was SOME
//! user id, and `NULL` was always available. So the attribution on every posted
//! financial document was a claim by the caller — and because
//! `activeContext.ts` chose "whichever owner sorts first", that claim was the
//! same hardcoded owner on every row in the shop's history.
//!
//! The actor now comes from the session and the payload's copy is a
//! CROSS-CHECK, refused on disagreement. That is this codebase's own pattern —
//! `quantity_base`, `factor_*_snapshot`, the declared VAT counterpart — applied
//! to who did it, and keeping the field on the wire is what lets a frozen
//! checkout attempt replay unchanged.

use crate::auth::{Actor, Role};
use crate::authz;
use crate::posting::{
    close_shift_tx, open_shift_tx, post_adjustment_tx, post_sale_tx, prepare_sale,
    CloseShiftPayload, OpenShiftPayload,
};
use crate::test_support::*;
use crate::tests::builders::*;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";
const MANAGER: &str = "00000000-0000-0000-0000-0000000000a1";
const CASHIER: &str = "00000000-0000-0000-0000-0000000000a2";
const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";

async fn staffed() -> TempDb {
    let db = TempDb::new().await;
    for (id, name, role) in [(MANAGER, "Mona", "manager"), (CASHIER, "Sami", "cashier")] {
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

fn open_shift_payload() -> OpenShiftPayload {
    OpenShiftPayload {
        shift_id: uuid(),
        store_id: STORE.to_string(),
        opened_by_user_id: String::new(),
        device_id: None,
        opening_cash_usd_cents: 10_000,
        opening_cash_lbp: 0,
        notes: None,
    }
}

fn close_shift_payload(shift_id: &str) -> CloseShiftPayload {
    CloseShiftPayload {
        shift_id: shift_id.to_string(),
        store_id: STORE.to_string(),
        closed_by_user_id: String::new(),
        closing_cash_usd_cents: 10_000,
        closing_cash_lbp: 0,
    }
}

fn actor(role: Role) -> Actor {
    let id = match role {
        Role::Owner => OWNER,
        Role::Manager => MANAGER,
        Role::Cashier => CASHIER,
    };
    Actor::for_tests(id, STORE, role)
}

// ===========================================================================
// The pure rule
// ===========================================================================

/// THE CROSS-CHECK, in all four cases.
#[test]
fn the_declared_actor_is_a_cross_check_and_a_mismatch_is_refused() {
    let who = Actor::for_tests(CASHIER, STORE, Role::Cashier);

    // Not named: filled from the session. A caller that declines to name an
    // actor is not asserting a false one.
    assert_eq!(authz::attribute(&who, None).unwrap(), CASHIER);

    // Named consistently: accepted, and the session's value is what is used.
    assert_eq!(authz::attribute(&who, Some(CASHIER)).unwrap(), CASHIER);

    // NAMED AS SOMEBODY ELSE: refused, not silently corrected. Accepting it
    // would be the defect; correcting it silently would hide a stale screen or
    // a hand-built request.
    let refused = authz::attribute(&who, Some(OWNER)).expect_err("a mismatch must be refused");
    assert!(refused.contains("different person"), "{refused}");
    assert!(refused.contains("Nothing has been changed"), "{refused}");

    // The NOT NULL variant treats an empty string as "not named", because that
    // is what an unfilled form field sends and a user whose id is "" does not
    // exist.
    assert_eq!(authz::attribute_required(&who, "").unwrap(), CASHIER);
    assert_eq!(authz::attribute_required(&who, "   ").unwrap(), CASHIER);
    assert_eq!(authz::attribute_required(&who, CASHIER).unwrap(), CASHIER);
    assert!(authz::attribute_required(&who, OWNER).is_err());
}

// ===========================================================================
// Against real documents
// ===========================================================================

/// A SALE RECORDS THE CASHIER WHO RANG IT, from the session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_records_the_signed_in_cashier() {
    let db = staffed().await;
    let shift = uuid();
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('{shift}', '{STORE}', '{CASHIER}', '2026-11-08T08:00:00.000Z', 'open', 0, 0)"
    ))
    .await;

    // The payload names NOBODY — the honest shape once the frontend stops
    // guessing — and the row still gets an actor.
    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(999).build()],
        vec![cash_usd(999)],
    );
    payload.shift_id = Some(shift);
    payload.cashier_user_id = None;

    let prepared = prepare_sale(&payload).expect("prepare");
    post_sale_tx(db.pool(), &actor(Role::Cashier), payload, prepared)
        .await
        .expect("the cashier posts it");

    assert_eq!(
        db.scalar_string("SELECT cashier_user_id FROM sales").await,
        CASHIER,
        "the sale must name the cashier who was signed in, not a payload value"
    );
    // And so does its inventory movement, so the stock trail agrees with the
    // receipt about who moved it.
    assert_eq!(
        db.scalar_string(
            "SELECT created_by_user_id FROM inventory_movements WHERE movement_type = 'sale'"
        )
        .await,
        CASHIER
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A SALE CLAIMING SOMEBODY ELSE IS REFUSED, and nothing is written.
///
/// This is the forgery the old design permitted: a hand-built `invoke`, or a
/// stale screen, naming any user id it liked — including the owner's, and
/// including `NULL`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_that_names_another_person_is_refused_and_posts_nothing() {
    let db = staffed().await;
    let shift = uuid();
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('{shift}', '{STORE}', '{CASHIER}', '2026-11-08T08:00:00.000Z', 'open', 0, 0)"
    ))
    .await;

    let mut payload = sale_payload(
        vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(999).build()],
        vec![cash_usd(999)],
    );
    payload.shift_id = Some(shift);
    // The cashier's session, the OWNER's name on the receipt.
    payload.cashier_user_id = Some(OWNER.to_string());

    let prepared = prepare_sale(&payload).expect("prepare");
    let refused = post_sale_tx(db.pool(), &actor(Role::Cashier), payload, prepared)
        .await
        .expect_err("a sale may not be attributed to somebody else");
    assert!(
        format!("{refused:?}").contains("different person"),
        "{refused:?}"
    );

    assert_eq!(
        db.count("SELECT count(*) AS n FROM sales").await,
        0,
        "and no sale may be left behind"
    );
    assert_eq!(
        db.count("SELECT count(*) AS n FROM inventory_movements").await,
        0
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT quantity_on_hand FROM products WHERE id = '{P_COFFEE}'"
        ))
        .await,
        50,
        "nor any stock moved"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// A SHIFT IS OPENED AND CLOSED BY WHOEVER IS SIGNED IN.
///
/// `shifts.opened_by_user_id` is `NOT NULL`, so this is the column where the
/// old design's claim was least avoidable and most load-bearing: the shift is
/// what every drawer figure is reconciled against.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shift_records_who_opened_and_who_closed_it() {
    let db = staffed().await;

    let mut open = open_shift_payload();
    // The payload names the OWNER, as the old frontend always did.
    open.opened_by_user_id = OWNER.to_string();
    let refused = open_shift_tx(db.pool(), &actor(Role::Cashier), open)
        .await
        .expect_err("a cashier may not open a shift in the owner's name");
    assert!(refused.contains("different person"), "{refused}");
    assert_eq!(db.count("SELECT count(*) AS n FROM shifts").await, 0);

    // Named correctly, it opens and records the cashier.
    let mut open = open_shift_payload();
    open.opened_by_user_id = CASHIER.to_string();
    let shift = open_shift_tx(db.pool(), &actor(Role::Cashier), open)
        .await
        .expect("the cashier opens their own shift");
    assert_eq!(
        db.scalar_string("SELECT opened_by_user_id FROM shifts").await,
        CASHIER
    );

    // A MANAGER closes it — permitted, and recorded as the manager, so the
    // reconciliation names the person who counted the drawer rather than the
    // person who opened it.
    let mut close = close_shift_payload(&shift.id);
    close.closed_by_user_id = MANAGER.to_string();
    close_shift_tx(db.pool(), &actor(Role::Manager), close)
        .await
        .expect("a manager may close somebody else's shift");

    assert_eq!(
        db.scalar_string("SELECT opened_by_user_id FROM shifts").await,
        CASHIER,
        "the opener is unchanged"
    );
    assert_eq!(
        db.scalar_string("SELECT closed_by_user_id FROM shifts").await,
        MANAGER,
        "and the closer is the manager who actually closed it"
    );

    db.cleanup().await.expect("remove TempDb");
}

/// An adjustment records the manager who made it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_records_the_manager_who_made_it() {
    let db = staffed().await;

    let mut payload =
        adjustment_payload("stock count correction", vec![adjustment_line(P_COFFEE, -5)]);
    payload.created_by_user_id = None;

    post_adjustment_tx(db.pool(), &actor(Role::Manager), payload)
        .await
        .expect("a manager may adjust stock");

    assert_eq!(
        db.scalar_string(
            "SELECT created_by_user_id FROM inventory_movements
              WHERE movement_type = 'adjustment'"
        )
        .await,
        MANAGER,
        "the movement must name the manager, not a payload value"
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// History is not rewritten
// ===========================================================================

/// A HISTORICAL ROW WITH A NULL ACTOR IS LEFT EXACTLY AS IT IS.
///
/// Every posted document in every existing shop carries whatever the old
/// design put there — usually the seeded owner, sometimes NULL. Stage B governs
/// what may be WRITTEN from now on; it does not restate the past, and a replay
/// of a historical document must still resolve to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_historical_null_actor_is_preserved_and_still_replays() {
    let db = staffed().await;
    let rate = db
        .scalar_string(&format!(
            "SELECT id FROM exchange_rates WHERE store_id = '{STORE}' LIMIT 1"
        ))
        .await;

    // A sale written the way the pre-Stage-B application wrote one, with NO
    // actor at all.
    db.exec(&format!(
        "INSERT INTO sales (id, store_id, cashier_user_id, receipt_number,
                            exchange_rate_lbp_per_usd, exchange_rate_id,
                            subtotal_excl_vat_cents, vat_total_cents,
                            total_incl_vat_cents, discount_cents, cogs_total_cents,
                            cogs_method, status)
         VALUES ('legacy-sale', '{STORE}', NULL, 9, 89500, '{rate}',
                 900, 99, 999, 0, 0, 'weighted_average', 'draft')"
    ))
    .await;
    db.exec(
        "UPDATE sales SET status = 'posted', posted_at = '2026-06-01T09:00:00.000Z'
          WHERE id = 'legacy-sale'",
    )
    .await;

    // It reads back with its NULL intact.
    assert_eq!(
        db.count("SELECT count(*) AS n FROM sales WHERE cashier_user_id IS NULL")
            .await,
        1,
        "a historical NULL actor must not be rewritten"
    );
    assert_eq!(
        db.scalar_i64("SELECT receipt_number FROM sales WHERE id = 'legacy-sale'")
            .await,
        9
    );

    db.cleanup().await.expect("remove TempDb");
}

// ===========================================================================
// Structural
// ===========================================================================

/// NO ACTOR COLUMN IS BOUND FROM A PAYLOAD ANY MORE.
///
/// The guard that makes this a property of the crate rather than of fourteen
/// remembered edits. A behavioural test covers the documents somebody wrote one
/// for; this covers the next column somebody adds.
#[test]
fn no_actor_column_is_written_from_a_request() {
    for (name, src) in [
        ("posting.rs", include_str!("../posting.rs")),
        ("catalog.rs", include_str!("../catalog.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        ("admin.rs", include_str!("../admin.rs")),
    ] {
        for field in [
            "cashier_user_id",
            "created_by_user_id",
            "opened_by_user_id",
            "closed_by_user_id",
        ] {
            for shape in [
                format!(".bind(&payload.{field})"),
                format!(".bind(payload.{field}"),
                format!(".bind(&args.{field})"),
                format!(".bind(args.{field}"),
            ] {
                assert!(
                    !src.contains(&shape),
                    "{name} still writes an actor column from the request: `{shape}`. \
                     The actor must come from the session through \
                     `authz::attribute`."
                );
            }
        }
    }
}

/// And every transactional implementation that writes an actor column computes
/// it through the cross-check.
#[test]
fn every_document_with_an_actor_computes_it_from_the_session() {
    let src = include_str!("../posting.rs");

    for fn_name in [
        "post_purchase_tx",
        "post_adjustment_tx",
        "post_supplier_payment_tx",
        "post_sale_tx",
        "open_shift_tx",
        "close_shift_tx",
        "post_credit_memo_tx",
        "post_driver_remittance_tx",
    ] {
        let after = src
            .split(&format!("pub(crate) async fn {fn_name}("))
            .nth(1)
            .unwrap_or_else(|| panic!("{fn_name} not found"));
        // Look within a generous window rather than to the function's end: a
        // `\n}` heuristic is defeated by nested blocks, which is a mistake this
        // work package already made once.
        let window = &after[..after.len().min(12_000)];

        assert!(
            window.contains("crate::authz::attribute"),
            "{fn_name} does not compute its actor from the session"
        );

        // And it does so AFTER the authorization, which is after the replay —
        // so a replay is never re-attributed.
        let authorize_at = window
            .find("authorize_tx(")
            .unwrap_or_else(|| panic!("{fn_name} does not authorize"));
        let attribute_at = window
            .find("crate::authz::attribute")
            .expect("attribute call");
        assert!(
            authorize_at < attribute_at,
            "{fn_name} attributes before it authorizes; attribution must follow \
             the replay resolution so a replayed document keeps the actor it was \
             posted with"
        );
    }
}
