// Layer C — `open_shift` / `close_shift` against a temporary database.
//
// WP-04 (GZ-HI-03). The shift scope is THE STORE: at most one open shift per
// store, which is the scope `shiftsRepo.getOpenShift(storeId)` has always
// queried by. Every test here asserts on persisted rows, because the defect
// this package fixes was precisely a command whose return value looked right
// while the rows behind it did not.
//
// Concurrency: the races use `TempDb::rival_pool`, a second connection pool
// against the same file configured exactly as production is. `TempDb`'s own
// pool holds one connection, so two commands on it could never contend inside
// the engine.

use crate::posting::{
    close_shift_with_pool, open_shift_with_pool, post_sale_with_pool, CloseShiftPayload,
    OpenShiftPayload, ShiftSnapshot,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const SHIFT_A: &str = "00000000-0000-0000-0000-0000000000a1";
const SHIFT_B: &str = "00000000-0000-0000-0000-0000000000a2";

/// A store with 1,000 coffees on hand, so no test here trips the stock guard.
async fn store_with_coffee() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 1_000,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db
}

fn open_payload(shift_id: &str, usd: i64, lbp: i64) -> OpenShiftPayload {
    OpenShiftPayload {
        shift_id: shift_id.to_string(),
        store_id: STORE_ID.to_string(),
        opened_by_user_id: USER_ID.to_string(),
        device_id: None,
        opening_cash_usd_cents: usd,
        opening_cash_lbp: lbp,
        notes: None,
    }
}

fn close_payload(shift_id: &str, counted_usd: i64, counted_lbp: i64) -> CloseShiftPayload {
    CloseShiftPayload {
        shift_id: shift_id.to_string(),
        store_id: STORE_ID.to_string(),
        closed_by_user_id: USER_ID.to_string(),
        closing_cash_usd_cents: counted_usd,
        closing_cash_lbp: counted_lbp,
    }
}

/// Post one cash sale of `qty` coffees at $5.00 each into `shift_id`.
async fn sell_for_cash_usd(db: &TempDb, shift_id: &str, qty: i64) -> Result<(), String> {
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(qty).unit_incl(500).build()];
    let total = lines_total(&lines);
    let mut payload = sale_payload(lines, vec![cash_usd(total)]);
    payload.shift_id = Some(shift_id.to_string());
    post_sale_with_pool(db.pool(), payload).await.map(|_| ())
}

async fn open_shift_count(db: &TempDb) -> i64 {
    db.count(&format!(
        "SELECT COUNT(*) FROM shifts WHERE store_id='{STORE_ID}' AND status='open'"
    ))
    .await
}

// ============================================================================
// Opening a shift
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_shift_of_the_day_opens() {
    let db = store_with_coffee().await;

    let shift = open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 500_000))
        .await
        .expect("the first shift must open");

    assert_eq!(shift.id, SHIFT_A);
    assert_eq!(shift.store_id, STORE_ID);
    assert_eq!(shift.status, "open");
    assert_eq!(shift.opening_cash_usd_cents, 10_000);
    assert_eq!(shift.opening_cash_lbp, 500_000);
    assert_eq!(shift.opened_by_user_id, USER_ID);
    assert!(!shift.opened_at.is_empty(), "opened_at is stamped by the command");

    // Nothing is reconciled yet, and that is NULL rather than zero: a zero
    // expected figure would claim an empty till had been counted.
    assert_eq!(shift.closed_at, None);
    assert_eq!(shift.closing_cash_usd_cents, None);
    assert_eq!(shift.expected_cash_usd_cents, None);
    assert_eq!(shift.variance_usd_cents, None);

    // The returned snapshot is the persisted row, not an echo of the payload.
    assert_eq!(open_shift_count(&db).await, 1);
    assert_eq!(shift_status(&db, SHIFT_A).await, "open");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT opening_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        10_000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_open_shift_for_the_same_store_is_refused() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    let err = open_shift_with_pool(db.pool(), open_payload(SHIFT_B, 999, 0))
        .await
        .expect_err("a store may hold only one open shift");
    assert!(err.contains("already open"), "got: {err}");

    // The refusal wrote nothing: no second row, and the first shift's float is
    // untouched.
    assert_eq!(open_shift_count(&db).await, 1);
    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM shifts WHERE id='{SHIFT_B}'")).await, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT opening_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        10_000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shift_can_be_opened_again_once_the_previous_one_is_closed() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();
    close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    // The normal handover. A store accumulates any number of CLOSED shifts; the
    // partial unique index constrains only the open ones.
    let second = open_shift_with_pool(db.pool(), open_payload(SHIFT_B, 5_000, 0))
        .await
        .expect("a new shift opens after the previous one closed");
    assert_eq!(second.status, "open");
    assert_eq!(open_shift_count(&db).await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts").await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_database_itself_refuses_a_second_open_shift() {
    // The invariant does not depend on going through `open_shift`. A direct
    // INSERT — a future integration, a repair script, a stray query — is refused
    // by `ux_shifts_one_open_per_store` just the same.
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    let err = db
        .try_exec(&format!(
            "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                                 opening_cash_lbp, status)
             VALUES ('{SHIFT_B}', '{STORE_ID}', '{USER_ID}', 0, 0, 'open')"
        ))
        .await
        .expect_err("the engine must refuse a second open shift");
    assert!(
        err.to_string().contains("ux_shifts_one_open_per_store")
            || err.to_string().contains("UNIQUE"),
        "got: {err}"
    );
    assert_eq!(open_shift_count(&db).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_simultaneous_opens_cannot_both_produce_an_open_shift() {
    let db = store_with_coffee().await;
    let rival = db.rival_pool().await;

    // Two tabs, two devices, or a double-click that outran the UI's own gate.
    let a = open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0));
    let b = open_shift_with_pool(&rival, open_payload(SHIFT_B, 777, 0));
    let (ra, rb) = tokio::join!(a, b);

    // Exactly one wins. Which one is a genuine race, but "both" and "neither"
    // are both failures: the first would give the store two drawers, the second
    // would leave the cashier unable to trade.
    let winners = [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count();
    assert_eq!(
        winners, 1,
        "exactly one concurrent open must succeed; got a={ra:?} b={rb:?}"
    );

    assert_eq!(
        open_shift_count(&db).await,
        1,
        "the store must never end up holding two open shifts"
    );

    // The loser's shift row does not exist at all — a conflicting open is not a
    // half-written shift. And the one that exists is the one that reported
    // success, so the caller's hand matches the database.
    let winner: &ShiftSnapshot = ra.as_ref().or(rb.as_ref()).unwrap();
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts").await, 1);
    assert_eq!(shift_status(&db, &winner.id).await, "open");

    rival.close().await;
}

// ============================================================================
// Closing a shift — the expected-drawer calculation
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expected_usd_drawer_cash_is_opening_plus_cash_in_minus_change_out() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    // Two exact-cash sales: $10.00 and $15.00.
    sell_for_cash_usd(&db, SHIFT_A, 2).await.unwrap();
    sell_for_cash_usd(&db, SHIFT_A, 3).await.unwrap();

    // One overpaid sale: $5.00 due, $20.00 handed over, $15.00 back.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![cash_usd(2_000)]);
    payload.shift_id = Some(SHIFT_A.to_string());
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    // Cash in: 1000 + 1500 + 2000 = 4500. Change out: 1500.
    // Expected: 10,000 + 4,500 - 1,500 = 13,000.
    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 13_000, 0))
        .await
        .unwrap();

    assert_eq!(closed.expected_cash_usd_cents, Some(13_000));
    assert_eq!(closed.closing_cash_usd_cents, Some(13_000));
    assert_eq!(closed.variance_usd_cents, Some(0));
    assert_eq!(closed.status, "closed");
    assert!(closed.closed_at.is_some());
    assert_eq!(closed.closed_by_user_id, Some(USER_ID.to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expected_lbp_drawer_cash_is_tracked_in_lira_not_in_usd() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 500_000)).await.unwrap();

    // Due $5.00. Tender 900,000 lira (worth $10.06 at 89,500), change in lira.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![cash_lbp(900_000)]);
    payload.shift_id = Some(SHIFT_A.to_string());
    let result = post_sale_with_pool(db.pool(), payload).await.unwrap();

    let change_lbp = db
        .scalar_i64("SELECT change_given_lbp FROM sale_payments WHERE method='cash_lbp'")
        .await;
    assert_eq!(
        change_lbp,
        (result.change_total_usd_cents * RATE_LBP_PER_USD + 50) / 100,
        "change on a lira row is expressed in lira, at the locked rate"
    );

    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 0, 0))
        .await
        .unwrap();

    // The lira drawer is reconciled in lira: 500,000 + 900,000 - change.
    assert_eq!(closed.expected_cash_lbp, Some(500_000 + 900_000 - change_lbp));
    // The USD drawer never saw a cent of it.
    assert_eq!(closed.expected_cash_usd_cents, Some(0));
    // Counted zero against a full till: short by the whole expected amount.
    assert_eq!(closed.variance_lbp, Some(-(500_000 + 900_000 - change_lbp)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cards_are_excluded_from_physical_cash_entirely() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 1_000, 2_000)).await.unwrap();

    // $100.00 of card sales, and a split where the card settles most of a bill.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(20).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![card_usd(10_000)]);
    payload.shift_id = Some(SHIFT_A.to_string());
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![card_usd(600), cash_usd(400)]);
    payload.shift_id = Some(SHIFT_A.to_string());
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 1_400, 2_000))
        .await
        .unwrap();

    // Only the $4.00 of cash reached the till. The $106.00 of card never did,
    // in either direction.
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000 + 400));
    assert_eq!(closed.expected_cash_lbp, Some(2_000));
    assert_eq!(closed.variance_usd_cents, Some(0));
    assert_eq!(closed.variance_lbp, Some(0));

    // Sales themselves are unaffected: the money was still collected.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(total_incl_vat_cents),0) FROM sales WHERE shift_id='{SHIFT_A}'"
        ))
        .await,
        11_000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_card_row_carrying_change_cannot_pull_the_drawer_down() {
    // `post_sale` refuses to write this row at all now. A database written by an
    // EARLIER release can hold it, though, and such a row must not go on making
    // every close of that shift report a shortfall. The fixture inserts it
    // directly, exactly as the pre-WP-04 command would have.
    // Built as a DRAFT and promoted, which is how such a row could actually
    // have come to exist: the old command wrote the header and its payment rows
    // in one transaction, so the legacy card row went in while the sale was
    // still being constructed. Since migration 012 a posted sale takes no
    // further payment rows, and that guard is not weakened for a fixture — the
    // committed row state here is identical either way.
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    db.exec(&format!(
        "INSERT INTO sales (
           id, store_id, shift_id, cashier_user_id, receipt_number,
           exchange_rate_lbp_per_usd, exchange_rate_id,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           discount_cents, cogs_total_cents, cogs_method, sale_type, status
         ) VALUES ('legacy-sale', '{STORE_ID}', '{SHIFT_A}', '{USER_ID}', 1,
                   {RATE_LBP_PER_USD}, '{RATE_ID}', 900, 100, 1000, 0, 0,
                   'weighted_average', 'normal', 'draft')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_payments (
           id, sale_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
           change_given_usd_cents, change_given_lbp
         ) VALUES ('legacy-cash', 'legacy-sale', '{STORE_ID}', 'cash_usd', 'USD',
                   1_000, 0, 1_000, 0, 0)"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO sale_payments (
           id, sale_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
           change_given_usd_cents, change_given_lbp
         ) VALUES ('legacy-card', 'legacy-sale', '{STORE_ID}', 'card_usd', 'USD',
                   5_000, 0, 5_000, 2_500, 0)"
    ))
    .await;
    db.exec(
        "UPDATE sales SET status = 'posted', posted_at = '2026-03-01T10:00:00.000Z'
          WHERE id = 'legacy-sale'",
    )
    .await;

    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 11_000, 0))
        .await
        .unwrap();

    assert_eq!(
        closed.expected_cash_usd_cents,
        Some(11_000),
        "a card row's change must not be subtracted from physical cash"
    );
    assert_eq!(closed.variance_usd_cents, Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_variance_sign_says_short_or_over_unambiguously() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 5_000, 100_000)).await.unwrap();
    sell_for_cash_usd(&db, SHIFT_A, 2).await.unwrap(); // expected USD 6,000

    // 50 cents missing, 1,000 lira extra.
    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 5_950, 101_000))
        .await
        .unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(6_000));
    assert_eq!(closed.variance_usd_cents, Some(-50), "short is negative");
    assert_eq!(closed.expected_cash_lbp, Some(100_000));
    assert_eq!(closed.variance_lbp, Some(1_000), "over is positive");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_posted_sales_of_this_shift_count_toward_the_drawer() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();
    sell_for_cash_usd(&db, SHIFT_A, 2).await.unwrap(); // $10.00

    // A sale voided after posting is outside this drawer: the money went back.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![cash_usd(500)]);
    payload.shift_id = Some(SHIFT_A.to_string());
    let voided = post_sale_with_pool(db.pool(), payload).await.unwrap();
    db.exec(&format!(
        "UPDATE sales SET status='voided', voided_at='2026-01-01T12:00:00.000Z'
          WHERE id='{}'",
        voided.sale_id
    ))
    .await;

    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 1_000, 0))
        .await
        .unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000));

    // And the previous shift's takings stay in the previous shift. A second
    // shift of the same store, opened after this one closed, starts empty.
    open_shift_with_pool(db.pool(), open_payload(SHIFT_B, 0, 0)).await.unwrap();
    let second = close_shift_with_pool(db.pool(), close_payload(SHIFT_B, 0, 0)).await.unwrap();
    assert_eq!(second.expected_cash_usd_cents, Some(0));
}

// ============================================================================
// Closing a shift — atomicity and repetition
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_close_snapshot_includes_every_sale_committed_before_it() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    // Twelve sales of $5.00, one of them a split with a card.
    for _ in 0..11 {
        sell_for_cash_usd(&db, SHIFT_A, 1).await.unwrap();
    }
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![card_usd(200), cash_usd(300)]);
    payload.shift_id = Some(SHIFT_A.to_string());
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 5_800, 0))
        .await
        .unwrap();

    // 11 x 500 cash + 300 cash = 5,800. The card's 200 is not drawer cash.
    assert_eq!(closed.expected_cash_usd_cents, Some(5_800));
    assert_eq!(closed.variance_usd_cents, Some(0));
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sales WHERE shift_id='{SHIFT_A}'")).await,
        12
    );

    // The stored figure IS the aggregate of the posted rows — the same number
    // computed independently of the command.
    let cash_in = db
        .scalar_i64(&format!(
            "SELECT COALESCE(SUM(sp.amount_native_usd_cents),0)
               FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
              WHERE s.shift_id='{SHIFT_A}' AND s.status='posted' AND sp.method='cash_usd'"
        ))
        .await;
    assert_eq!(closed.expected_cash_usd_cents, Some(cash_in));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_twice_is_refused_and_the_first_reconciliation_stands() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();
    sell_for_cash_usd(&db, SHIFT_A, 2).await.unwrap();

    let first = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 11_000, 0))
        .await
        .unwrap();
    assert_eq!(first.variance_usd_cents, Some(0));

    // A second close with a DIFFERENT count must not overwrite the one that was
    // signed off.
    let err = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 999, 0))
        .await
        .expect_err("a closed shift cannot be closed again");
    assert!(err.contains("No open shift found"), "got: {err}");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT closing_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        11_000,
        "the counted cash of a closed shift is final"
    );
    assert_eq!(
        db.scalar_i64(&format!("SELECT variance_usd_cents FROM shifts WHERE id='{SHIFT_A}'")).await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_database_itself_refuses_to_rewrite_a_closed_shift() {
    // Same rule, independent of the command: migration 009's
    // `trg_shifts_no_update_after_close`. A closed reconciliation is as
    // immutable as a posted sale.
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();
    close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    let err = db
        .try_exec(&format!(
            "UPDATE shifts SET closing_cash_usd_cents = 1 WHERE id='{SHIFT_A}'"
        ))
        .await
        .expect_err("a closed shift must be immutable");
    assert!(err.to_string().contains("closed shift is immutable"), "got: {err}");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT closing_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        10_000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_shift_of_another_store_or_an_unknown_one_is_refused() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    let mut wrong_store = close_payload(SHIFT_A, 0, 0);
    wrong_store.store_id = "some-other-store".to_string();
    let err = close_shift_with_pool(db.pool(), wrong_store)
        .await
        .expect_err("a shift belongs to its own store");
    assert!(err.contains("No open shift found"), "got: {err}");

    let err = close_shift_with_pool(db.pool(), close_payload("no-such-shift", 0, 0))
        .await
        .expect_err("an unknown shift cannot be closed");
    assert!(err.contains("No open shift found"), "got: {err}");

    // A FAILED CLOSE LEAVES NO PARTIAL CLOSED STATE. Every closing column is
    // still NULL and the shift is still trading.
    assert_eq!(shift_status(&db, SHIFT_A).await, "open");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM shifts
              WHERE id='{SHIFT_A}'
                AND closed_at IS NULL AND closed_by_user_id IS NULL
                AND closing_cash_usd_cents IS NULL AND closing_cash_lbp IS NULL
                AND expected_cash_usd_cents IS NULL AND expected_cash_lbp IS NULL
                AND variance_usd_cents IS NULL AND variance_lbp IS NULL"
        ))
        .await,
        1,
        "a refused close must not write any part of a reconciliation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_simultaneous_closes_reconcile_the_shift_exactly_once() {
    let db = store_with_coffee().await;
    let rival = db.rival_pool().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();
    sell_for_cash_usd(&db, SHIFT_A, 2).await.unwrap(); // expected 11,000

    // Two operators pressing Close, with different counts.
    let a = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 11_000, 0));
    let b = close_shift_with_pool(&rival, close_payload(SHIFT_A, 42, 0));
    let (ra, rb) = tokio::join!(a, b);

    let winners = [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count();
    assert_eq!(winners, 1, "exactly one close may succeed; got a={ra:?} b={rb:?}");

    let winner = ra.as_ref().or(rb.as_ref()).unwrap();
    assert_eq!(winner.status, "closed");
    assert_eq!(winner.expected_cash_usd_cents, Some(11_000));

    // The persisted reconciliation is the winner's, whole: one count, one
    // expected figure, one variance, and the two agree.
    assert_eq!(shift_status(&db, SHIFT_A).await, "closed");
    let counted = db
        .scalar_i64(&format!(
            "SELECT closing_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await;
    let variance = db
        .scalar_i64(&format!("SELECT variance_usd_cents FROM shifts WHERE id='{SHIFT_A}'"))
        .await;
    assert_eq!(counted, winner.closing_cash_usd_cents.unwrap());
    assert_eq!(variance, counted - 11_000, "variance = counted - expected");

    rival.close().await;
}

// ============================================================================
// Sale versus close
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_cannot_post_into_a_closed_shift() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();
    close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 0, 0)).await.unwrap();

    let err = sell_for_cash_usd(&db, SHIFT_A, 2)
        .await
        .expect_err("a closed shift cannot take payment");
    assert!(err.contains("not open"), "got: {err}");

    // ZERO SIDE EFFECTS. No sale, no payment, no movement, no stock change, and
    // the receipt sequence is untouched so the next real sale gets number 1.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 1_000);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "1"
    );
    // And the closed shift's reconciliation did not move.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT expected_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_cannot_post_into_an_unknown_shift_or_one_of_another_store() {
    let db = store_with_coffee().await;

    let err = sell_for_cash_usd(&db, "no-such-shift", 1)
        .await
        .expect_err("a sale must name a real shift");
    assert!(err.contains("not a shift of store"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);

    // A shift that exists, but belongs to a different store. Scoping the check
    // by store is what stops one store's register drawing on another's drawer.
    db.exec("INSERT INTO stores (id, name) VALUES ('store-2', 'Second Branch')").await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                             opening_cash_lbp, status)
         VALUES ('{SHIFT_B}', 'store-2', '{USER_ID}', 0, 0, 'open')"
    ))
    .await;

    let err = sell_for_cash_usd(&db, SHIFT_B, 1)
        .await
        .expect_err("a sale may only reference its own store's shift");
    assert!(err.contains("not a shift of store"), "got: {err}");
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 1_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sale_racing_a_close_resolves_into_one_of_two_valid_outcomes() {
    let db = store_with_coffee().await;
    let rival = db.rival_pool().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    // $5.00 of cash arriving at the same moment the drawer is being counted.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![cash_usd(500)]);
    payload.shift_id = Some(SHIFT_A.to_string());

    let sale = post_sale_with_pool(db.pool(), payload);
    let close = close_shift_with_pool(&rival, close_payload(SHIFT_A, 10_500, 0));
    let (sale_result, close_result) = tokio::join!(sale, close);

    // The two acceptable serialisations, and nothing else:
    //
    //   A. the sale won: it belongs to the shift, and the close that followed
    //      counted it;
    //   B. the close won: the shift is reconciled without it, and the sale was
    //      refused outright.
    //
    // Either way the shift ends up closed exactly once, and the expected figure
    // agrees with the sales that are actually attributed to it. A lock error on
    // either side is a legitimate loser: the operation is refused whole.
    let sales_in_shift = db
        .count(&format!("SELECT COUNT(*) FROM sales WHERE shift_id='{SHIFT_A}'"))
        .await;
    let cash_in = db
        .scalar_i64(&format!(
            "SELECT COALESCE(SUM(sp.amount_native_usd_cents),0)
               FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
              WHERE s.shift_id='{SHIFT_A}' AND s.status='posted' AND sp.method='cash_usd'"
        ))
        .await;

    match (sale_result.is_ok(), close_result.is_ok()) {
        (true, true) => {
            // Outcome A: the sale committed first, so the close must include it.
            assert_eq!(sales_in_shift, 1);
            assert_eq!(cash_in, 500);
            assert_eq!(
                close_result.as_ref().unwrap().expected_cash_usd_cents,
                Some(10_500),
                "a close that succeeded after the sale must count that sale"
            );
        }
        (false, true) => {
            // Outcome B: the shift closed first and the sale was refused.
            assert_eq!(sales_in_shift, 0, "a refused sale leaves no row behind");
            assert_eq!(cash_in, 0);
            assert_eq!(
                close_result.as_ref().unwrap().expected_cash_usd_cents,
                Some(10_000)
            );
        }
        (true, false) => {
            // The sale committed and the close lost its lock. The shift is still
            // open with the sale inside it, ready to be closed again.
            assert_eq!(sales_in_shift, 1);
            assert_eq!(shift_status(&db, SHIFT_A).await, "open");
            let reclosed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 10_500, 0))
                .await
                .expect("the shift is still open and still closable");
            assert_eq!(reclosed.expected_cash_usd_cents, Some(10_500));
        }
        (false, false) => panic!(
            "at least one of the two must commit; sale={sale_result:?} close={close_result:?}"
        ),
    }

    // Whatever happened, the shift was never left half-closed: its status and
    // its reconciliation columns agree with each other.
    let consistent = db
        .count(&format!(
            "SELECT COUNT(*) FROM shifts
              WHERE id='{SHIFT_A}'
                AND ((status='open'   AND closed_at IS NULL
                                      AND expected_cash_usd_cents IS NULL
                                      AND variance_usd_cents IS NULL)
                  OR (status='closed' AND closed_at IS NOT NULL
                                      AND expected_cash_usd_cents IS NOT NULL
                                      AND variance_usd_cents IS NOT NULL))"
        ))
        .await;
    assert_eq!(consistent, 1, "a shift is either wholly open or wholly closed");

    rival.close().await;
}

// ============================================================================
// Idempotency across the shift boundary (WP-02 GP-A01 must stay intact)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_a_sale_does_not_count_its_cash_into_the_shift_twice() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 10_000, 0)).await.unwrap();

    // One checkout, retried three times under the same identity.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut original = sale_payload(lines, vec![cash_usd(1_500)]);
    original.shift_id = Some(SHIFT_A.to_string());

    let first = post_sale_with_pool(db.pool(), replay_of(&original)).await.unwrap();
    for _ in 0..2 {
        let again = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
            .await
            .expect("a retry must reconcile to the sale that exists");
        assert_eq!(again.receipt_number, first.receipt_number, "no second receipt");
        assert_eq!(again.change_total_usd_cents, first.change_total_usd_cents);
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);

    // $15.00 in, $5.00 of change back, counted exactly once.
    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 20_000, 0))
        .await
        .unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(10_000 + 1_500 - 500));
    assert_eq!(closed.variance_usd_cents, Some(20_000 - 11_000));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_still_reconciles_after_its_shift_has_been_closed() {
    // The shift check sits AFTER the idempotency check for this reason: the
    // cashier's retry of a sale that is already banked must hand back the
    // original receipt, not an error about a drawer that has since been counted.
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut original = sale_payload(lines, vec![cash_usd(1_000)]);
    original.shift_id = Some(SHIFT_A.to_string());
    let first = post_sale_with_pool(db.pool(), replay_of(&original)).await.unwrap();

    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 1_000, 0))
        .await
        .unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000));

    let retry = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&original))
        .await
        .expect("a replay writes nothing, so a closed shift does not block it");
    assert_eq!(retry.receipt_number, first.receipt_number);
    assert_eq!(retry.posted_at, first.posted_at);

    // And it stayed a replay: one sale, one tender row, stock moved once, and
    // the closed shift's figures did not budge.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 998);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT expected_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        1_000
    );
}

// ============================================================================
// A NEW sale must belong to an open shift (GZ-HI-03, release-gate correction)
// ============================================================================
//
// The first cut of WP-04 validated `shift_id` only when the payload carried
// one, so a payload that simply omitted it posted — outside the cash-control
// model entirely. The register disables Post without an active shift and always
// sends `activeShift.id`; drawer reconciliation only counts sales attributed to
// a shift; no Greaz workflow produces an unattributed new sale. One that
// slipped through would take cash no drawer count could ever reconcile against.
//
// The rule is enforced at the POSTING BOUNDARY, not in the schema:
// `sales.shift_id` stays nullable so a row written before the rule existed is
// still readable, replayable and reprintable. History is not rewritten.

/// Everything a refused sale must NOT have touched.
async fn assert_no_sale_side_effects(db: &TempDb) {
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0, "no sale row");
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 0, "no sale items");
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 0, "no payments");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM inventory_movements").await,
        0,
        "no inventory movement"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 1_000, "stock untouched");
    assert_eq!(movement_sum(&db, P_COFFEE).await, 0, "no COGS-bearing movement");
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "1",
        "a refused sale must not consume a receipt number"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_sale_without_a_shift_is_refused_with_no_side_effects() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    // The store HAS an open shift; the payload just fails to name it. That is
    // the case the first cut let through, and it is the dangerous one: the cash
    // would be real and the drawer would never see it.
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut payload = sale_payload(lines, vec![cash_usd(1_000)]);
    payload.shift_id = None;

    let err = post_sale_with_pool(db.pool(), payload)
        .await
        .expect_err("a new sale with no shift must be refused");
    assert!(err.contains("not attached to a shift"), "got: {err}");

    assert_no_sale_side_effects(&db).await;

    // An empty or blank shift id is the same omission wearing a string.
    for blank in ["", "   "] {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
        let mut payload = sale_payload(lines, vec![cash_usd(1_000)]);
        payload.shift_id = Some(blank.to_string());
        let err = post_sale_with_pool(db.pool(), payload)
            .await
            .expect_err("a blank shift id names no shift");
        assert!(err.contains("not attached to a shift"), "got: {err}");
    }
    assert_no_sale_side_effects(&db).await;

    // The open shift is untouched, and still closes to an empty till.
    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 0, 0)).await.unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(0));
    assert_eq!(closed.variance_usd_cents, Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_sale_naming_the_open_shift_posts() {
    // The control. The rule must refuse the omission, not the workflow.
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    sell_for_cash_usd(&db, SHIFT_A, 2).await.expect("the normal path still posts");

    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM sales WHERE shift_id='{SHIFT_A}'")).await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 998);
    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 1_000, 0)).await.unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_sale_naming_a_closed_shift_is_refused_atomically() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();
    close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 0, 0)).await.unwrap();

    let err = sell_for_cash_usd(&db, SHIFT_A, 2)
        .await
        .expect_err("a closed shift cannot take payment");
    assert!(err.contains("not open"), "got: {err}");

    assert_no_sale_side_effects(&db).await;
    // The closed shift's reconciliation did not move either.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT expected_cash_usd_cents FROM shifts WHERE id='{SHIFT_A}'"
        ))
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_sale_naming_another_stores_shift_is_refused_atomically() {
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    // A shift that exists and is open — for a different branch. Scoping the
    // check by store is what stops one register drawing on another's drawer.
    db.exec("INSERT INTO stores (id, name) VALUES ('store-2', 'Second Branch')").await;
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents,
                             opening_cash_lbp, status)
         VALUES ('{SHIFT_B}', 'store-2', '{USER_ID}', 0, 0, 'open')"
    ))
    .await;

    let err = sell_for_cash_usd(&db, SHIFT_B, 2)
        .await
        .expect_err("a sale may only reference its own store's shift");
    assert!(err.contains("not a shift of store"), "got: {err}");
    assert_no_sale_side_effects(&db).await;

    // An unknown shift is the same refusal.
    let err = sell_for_cash_usd(&db, "no-such-shift", 2)
        .await
        .expect_err("a sale must name a real shift");
    assert!(err.contains("not a shift of store"), "got: {err}");
    assert_no_sale_side_effects(&db).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_historical_null_shift_sale_can_still_be_replayed() {
    // A row an EARLIER release wrote, before a shift was mandatory. The
    // mandatory check sits after the idempotency resolution precisely so this
    // keeps working: a retry writes nothing, and refusing it would hand the
    // cashier a failure for money that is already banked.
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut historical = sale_payload(lines, vec![cash_usd(1_500)]);
    historical.shift_id = None;
    let sale_id = historical.sale_id.clone();

    // Written the way the pre-WP-04 command wrote it: directly, with a NULL
    // shift. Posting it through the command is exactly what is no longer
    // possible, so the fixture cannot use `post_sale_with_pool` here.
    seed_posted_sale_without_shift(&db, &historical).await;
    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM sales WHERE id='{sale_id}' AND shift_id IS NULL")).await, 1);

    // The exact same canonical request, retried.
    let replay = post_sale_with_pool(db.pool(), replay_of_with_new_child_ids(&historical))
        .await
        .expect("WP-02 must still reconcile a retry of a historical NULL-shift sale");

    assert_eq!(replay.sale_id, sale_id);
    assert_eq!(replay.receipt_number, 1, "the original receipt comes back");
    assert_eq!(replay.posted_at, "2026-01-01T09:00:00.000Z");
    assert_eq!(replay.change_total_usd_cents, 500, "tendered 1500 against 1000 due");

    // It stayed a replay: one sale, one tender row, nothing re-decremented, and
    // the historical row still carries its NULL shift. History is not rewritten.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 998, "stock moved once, not twice");
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sales WHERE id='{sale_id}' AND shift_id IS NULL")).await,
        1
    );
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2",
        "a replay costs the receipt sequence nothing beyond the original sale"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_historical_null_shift_identity_still_fails_canonical_comparison() {
    // The other half of the exemption: a NULL shift must not become a hole in
    // the replay comparison. Reusing that identity for different content is
    // still a conflict, decided by WP-02's rules and not waved through.
    let db = store_with_coffee().await;

    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(2).unit_incl(500).build()];
    let mut historical = sale_payload(lines, vec![cash_usd(1_500)]);
    historical.shift_id = None;
    seed_posted_sale_without_shift(&db, &historical).await;

    // A different basket under the same identity.
    let mut different = replay_of_with_new_child_ids(&historical);
    different.lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(4).unit_incl(500).build()];
    different.payments = vec![cash_usd(2_000)];
    let err = post_sale_with_pool(db.pool(), different)
        .await
        .expect_err("a reused identity carrying different content is a conflict");
    assert!(err.contains("already exists"), "got: {err}");

    // A different tender under the same identity.
    let mut different = replay_of_with_new_child_ids(&historical);
    different.payments = vec![card_usd(1_000)];
    let err = post_sale_with_pool(db.pool(), different)
        .await
        .expect_err("a different tender is a different transaction");
    assert!(err.contains("different tender"), "got: {err}");

    // And ATTACHING a shift to that historical identity is itself a conflict —
    // the retry claims an attribution the posted sale never had, which would
    // move its cash into a drawer that never received it.
    let mut attributed = replay_of_with_new_child_ids(&historical);
    attributed.shift_id = Some(SHIFT_ID.to_string());
    let err = post_sale_with_pool(db.pool(), attributed)
        .await
        .expect_err("re-attributing a posted sale to a shift is a conflict");
    assert!(err.contains("different shift"), "got: {err}");

    // None of the three wrote anything.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_payments").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 998);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_receipt_number'").await,
        "2",
        "a refused conflict consumes no receipt number either"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unshiftable_cash_can_no_longer_reach_the_books_at_all() {
    // The reconciliation consequence, stated as its own invariant: because an
    // unattributed new sale cannot post, there is no posted cash outside some
    // shift's drawer accounting. Every cent of `cash_usd` / `cash_lbp` on a
    // posted sale belongs to exactly one shift.
    let db = store_with_coffee().await;
    open_shift_with_pool(db.pool(), open_payload(SHIFT_A, 0, 0)).await.unwrap();

    sell_for_cash_usd(&db, SHIFT_A, 2).await.unwrap();
    for _ in 0..3 {
        let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(500).build()];
        let mut payload = sale_payload(lines, vec![cash_usd(500)]);
        payload.shift_id = None;
        assert!(
            post_sale_with_pool(db.pool(), payload).await.is_err(),
            "unattributed cash must not post"
        );
    }

    assert_eq!(
        db.count("SELECT COUNT(*) FROM sales WHERE shift_id IS NULL AND status='posted'").await,
        0,
        "no posted sale may sit outside a shift"
    );

    // The one sale that did post is fully accounted for by the close.
    let closed = close_shift_with_pool(db.pool(), close_payload(SHIFT_A, 1_000, 0)).await.unwrap();
    assert_eq!(closed.expected_cash_usd_cents, Some(1_000));
    assert_eq!(closed.variance_usd_cents, Some(0));

    let posted_cash = db
        .scalar_i64(
            "SELECT COALESCE(SUM(sp.amount_native_usd_cents),0)
               FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
              WHERE s.status='posted' AND sp.method='cash_usd'",
        )
        .await;
    assert_eq!(
        posted_cash,
        closed.expected_cash_usd_cents.unwrap(),
        "every posted cash cent is inside the shift that was counted"
    );
}
