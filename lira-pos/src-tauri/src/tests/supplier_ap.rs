// Layer C — the purchase side of accounts payable (WP-05, GZ-HI-05).
//
// Three separate rules live here, and keeping them apart is the point:
//
//   * PURCHASE → AP RECONCILIATION — the payable a purchase raises is the
//     purchase's own authoritative total, derived from the invoice costs, never
//     a figure the caller supplied alongside them.
//
//   * TECHNICAL RETRY IDEMPOTENCY — `purchases.id` is the document identity.
//     Replaying it with the same bill reconciles to the purchase that posted;
//     replaying it with a different bill is a conflict. This is about lost
//     answers and nothing else.
//
//   * BUSINESS DUPLICATE-INVOICE DETECTION — one supplier invoice reference may
//     be posted once per supplier per store, whatever identity it arrives
//     under. This is about the paper on the counter.
//
// The two idempotency-shaped rules are deliberately different questions: two
// separate deliveries of the same goods at the same price under two identities
// are two legitimate purchases, and are refused only if they quote the same
// invoice number.
//
// Concurrency: the races use `TempDb::rival_pool`, a second connection pool
// against the same file configured exactly as production is.

use crate::posting::{post_purchase_with_pool, post_supplier_payment_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_SUGAR: &str = "00000000-0000-0000-0000-0000000000c2";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";
const SUPPLIER_B: &str = "00000000-0000-0000-0000-0000000000s2";
const OTHER_STORE: &str = "00000000-0000-0000-0000-00000000bbbb";
const SUPPLIER_OTHER_STORE: &str = "00000000-0000-0000-0000-0000000000s9";

async fn store_with_supplier_and_products() -> TempDb {
    let db = TempDb::new().await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_supplier(&db, SUPPLIER_B, "Tripoli Imports").await;
    seed_product(&db, &ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")).await;
    seed_product(&db, &ProductSpec::stocked(P_SUGAR, "SKU-C2", "Sugar")).await;
    db
}

/// A one-line coffee purchase: `qty` units at `unit_cost` cents excl-VAT.
fn coffee_lines(qty: i64, unit_cost: i64) -> Vec<crate::posting::PostPurchaseLine> {
    vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(qty)
        .unit_cost_excl(unit_cost)
        .build()]
}

async fn ledger_total_for(db: &TempDb, supplier: &str, entry_type: &str) -> i64 {
    db.scalar_i64(&format!(
        "SELECT COALESCE(SUM(amount_cents),0) FROM supplier_ledger
          WHERE supplier_id='{supplier}' AND entry_type='{entry_type}'"
    ))
    .await
}

// ============================================================================
// Purchase → AP reconciliation (Part C)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_purchase_raises_exactly_its_own_vat_inclusive_total() {
    let db = store_with_supplier_and_products().await;

    // 10 × $2.00 excl = $20.00 excl, + 11% = $22.20 incl.
    let lines = coffee_lines(10, 200);
    let r = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("purchase posts");

    let header_total = db
        .scalar_i64("SELECT total_incl_vat_cents FROM purchases WHERE status='posted'")
        .await;
    assert_eq!(header_total, 2_220);

    // The payable IS the header total — one ledger row, that amount, positive.
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(ledger_total_for(&db, SUPPLIER, "purchase").await, header_total);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 2_220);
    assert!(r.ledger_entry_id.is_some());

    // And it reconciles to the lines it was summed from, not merely to itself.
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(line_total_incl_vat_cents),0) FROM purchase_items").await,
        header_total
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_payable_tracks_the_invoice_cost_and_not_a_total_the_caller_declared() {
    // The GZ-HI-05 core defect: before WP-05 the header total — and therefore
    // the payable — was `SUM(payload.line_total_incl_vat_cents)`, three numbers
    // the client sent alongside the costs with nothing checking they agreed.
    // A line could cost $20 of goods and book $900 of debt.
    let db = store_with_supplier_and_products().await;

    let mut lines = coffee_lines(10, 200);
    lines[0].line_subtotal_excl_vat_cents = 90_000;
    lines[0].line_vat_cents = 9_900;
    lines[0].line_total_incl_vat_cents = 99_900;

    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("does not reconcile against its invoice cost"), "got: {err}");

    // No purchase, no goods, and above all no debt.
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_purchase_raises_one_payable_for_the_whole_bill() {
    let db = store_with_supplier_and_products().await;

    let lines = vec![
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build(),
        PurchaseLineBuilder::new(P_SUGAR, "Sugar").qty(4).unit_cost_excl(150).build(),
    ];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap();

    // Coffee: 10 x 200 excl = 2000, + 11% = 2220.
    // Sugar:   4 x 150 excl =  600, and 150 incl-VAT is 167, so 4 x 167 = 668.
    // One payable of 2888 — the bill, not the lines.
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 2_888);
    assert_eq!(
        db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await,
        2_888
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_that_fails_mid_flight_leaves_no_debt_no_goods_and_no_number() {
    // Atomicity (Part C): the payable, the stock, the cost pool and the
    // document number are one unit of work. A delivery recorded without the
    // debt for it — or a debt without the delivery — is unreconcilable, and
    // posted rows cannot be edited afterwards to fix it.
    let db = store_with_supplier_and_products().await;

    // Line 1 is good and line 2 names a product that does not exist, so the
    // failure lands after stock and cost have already been written for line 1.
    let lines = vec![
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build(),
        PurchaseLineBuilder::new("no-such-product", "Ghost").qty(1).unit_cost_excl(100).build(),
    ];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 0);
    assert_eq!(
        db.scalar_i64(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='00000000-0000-0000-0000-0000000000c1'"
        )
        .await,
        0,
        "the cost pool must be untouched"
    );
    // The document sequence is part of the transaction too.
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "1",
        "a failed purchase must not consume a purchase number"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_opening_batch_raises_no_payable() {
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(db.pool(), purchase_payload("opening", None, coffee_lines(10, 200)))
        .await
        .unwrap();

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger").await,
        0,
        "opening stock is not something the shop owes anybody for"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_cannot_raise_a_payable_against_another_stores_supplier() {
    let db = store_with_supplier_and_products().await;
    seed_store(&db, OTHER_STORE, "Second Branch").await;
    seed_supplier_in_store(&db, SUPPLIER_OTHER_STORE, "Saida Traders", OTHER_STORE).await;

    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload("normal", Some(SUPPLIER_OTHER_STORE), coffee_lines(5, 200)),
    )
    .await
    .unwrap_err();
    assert!(err.contains("belongs to store"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0);
}

// ============================================================================
// Duplicate supplier invoices (Part B)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_supplier_invoice_cannot_be_posted_twice() {
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-1024"), coffee_lines(10, 200)),
    )
    .await
    .expect("the first entry of the bill posts");

    // A different document identity carrying the same bill — the buyer typing
    // it in again, or a second person doing the same day's paperwork.
    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-1024"), coffee_lines(10, 200)),
    )
    .await
    .unwrap_err();
    assert!(err.contains("already posted for this supplier"), "got: {err}");
    assert!(err.contains("purchase #1"), "the error must point at the bill that exists: {err}");

    // One bill, one payable, one delivery, one number consumed.
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 2_220);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "2",
        "the refused duplicate must not consume a purchase number"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_duplicate_invoice_changes_nothing_at_all() {
    // Part M item 17, stated against the cost pool as well as the obvious
    // tables: a second entry of one bill must not blend its cost in again.
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-7"), coffee_lines(10, 200)),
    )
    .await
    .unwrap();
    let avg_before = db
        .scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await;

    // The re-entry is priced differently — a buyer who mistyped and is trying
    // again — so blending it in would be visible.
    let _ = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-7"), coffee_lines(10, 900)),
    )
    .await
    .unwrap_err();

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(movement_sum(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        avg_before,
        "the cost pool must not absorb a bill that was refused"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_reference_is_matched_whatever_its_case_and_padding() {
    // The rule has to match the way a human types an invoice number off paper.
    // `supplier_reference_key` — trim + uppercase, migration 002's convention
    // for `product_barcodes.lookup_value` — is what decides.
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("inv-88"), coffee_lines(1, 200)),
    )
    .await
    .unwrap();

    for retyped in ["INV-88", " inv-88 ", "Inv-88", "\tINV-88\n"] {
        let err = post_purchase_with_pool(
            db.pool(),
            purchase_payload_with_reference("normal", Some(SUPPLIER), Some(retyped), coffee_lines(1, 200)),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("already posted for this supplier"),
            "{retyped:?} must be recognised as the same invoice: {err}"
        );
    }

    // The original text is preserved as typed — normalization is for matching,
    // not for rewriting what the supplier printed.
    assert_eq!(
        db.scalar_string("SELECT supplier_reference FROM purchases").await,
        "inv-88"
    );
    assert_eq!(
        db.scalar_string("SELECT supplier_reference_key FROM purchases").await,
        "INV-88"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_suppliers_may_both_number_an_invoice_the_same_way() {
    // Invoice numbering belongs to the supplier. Making "1001" globally unique
    // would reject the second supplier's perfectly ordinary first bill.
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("1001"), coffee_lines(5, 200)),
    )
    .await
    .expect("the first supplier's invoice 1001 posts");
    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER_B), Some("1001"), coffee_lines(5, 300)),
    )
    .await
    .expect("the second supplier's invoice 1001 posts too");

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases WHERE status='posted'").await, 2);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 1_110);
    assert_eq!(supplier_balance(&db, SUPPLIER_B).await, 1_665);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchases_with_no_reference_never_collide() {
    // Part M item 15. A cash-and-carry receipt with no number to quote, and a
    // reference field somebody left as spaces, both normalize to NULL — and
    // NULL is never equal to NULL. Constraining them would stop a shop
    // recording its second unnumbered delivery of the day.
    let db = store_with_supplier_and_products().await;

    for reference in [None, Some(""), Some("   "), None] {
        post_purchase_with_pool(
            db.pool(),
            purchase_payload_with_reference("normal", Some(SUPPLIER), reference, coffee_lines(1, 100)),
        )
        .await
        .unwrap_or_else(|e| panic!("an unreferenced purchase must post ({reference:?}): {e}"));
    }

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases WHERE status='posted'").await, 4);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM purchases WHERE supplier_reference_key IS NOT NULL").await,
        0,
        "blank and whitespace references must normalize to NULL, not to ''"
    );
    // Four bills, four payables, each the full gross of its own delivery.
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 4);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 4 * 111);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_concurrent_entries_of_one_invoice_cannot_both_commit() {
    let db = store_with_supplier_and_products().await;
    let rival = db.rival_pool().await;

    // Two tabs, or two people doing the same stack of paperwork.
    let a = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-RACE"), coffee_lines(10, 200)),
    );
    let b = post_purchase_with_pool(
        &rival,
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-RACE"), coffee_lines(10, 200)),
    );
    let (ra, rb) = tokio::join!(a, b);

    let winners = [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count();
    assert!(
        winners <= 1,
        "two entries of one invoice must not both commit; got a={ra:?} b={rb:?}"
    );

    // Whichever way the race went, the books hold at most one of this bill —
    // and "neither" is acceptable here, unlike opening a shift: a refused entry
    // is simply retyped, and the test below proves the path still works.
    let posted = db.count("SELECT COUNT(*) FROM purchases WHERE status='posted'").await;
    assert!(posted <= 1, "at most one posted purchase, got {posted}");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger").await,
        posted,
        "one payable per posted bill, never two"
    );
    assert_eq!(supplier_balance(&db, SUPPLIER).await, posted * 2_220);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, posted * 10);
    assert_eq!(movement_sum(&db, P_COFFEE).await, quantity_on_hand(&db, P_COFFEE).await);

    // The supplier's NEXT bill still goes in, so nothing above was achieved by
    // breaking purchasing.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-RACE-2"), coffee_lines(1, 100)),
    )
    .await
    .expect("a different invoice still posts after the race");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_direct_write_cannot_slip_a_duplicate_invoice_past_the_command() {
    // The database-level backstop. `post_purchase` checks first and reports
    // nicely; `trg_purchases_no_duplicate_supplier_invoice_*` is what holds for
    // an importer, a manual fix, or a future command that forgets.
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-DIRECT"), coffee_lines(1, 200)),
    )
    .await
    .unwrap();

    // Straight in as posted, bypassing the command entirely.
    let err = db
        .try_exec(&format!(
            "INSERT INTO purchases (
               id, store_id, supplier_id, purchase_type, supplier_reference,
               purchase_number, purchase_date, total_incl_vat_cents, status, posted_at
             ) VALUES ('direct-1', '{STORE_ID}', '{SUPPLIER}', 'normal', ' inv-direct ',
                       900, '2026-02-09', 5000, 'posted', '2026-02-09T10:00:00.000Z')"
        ))
        .await
        .expect_err("the trigger must refuse a directly inserted duplicate");
    assert!(
        err.to_string().contains("already posted"),
        "got: {err}"
    );

    // And via the draft-then-promote path the command itself uses.
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, supplier_reference,
           purchase_number, purchase_date, total_incl_vat_cents, status
         ) VALUES ('direct-2', '{STORE_ID}', '{SUPPLIER}', 'normal', 'INV-DIRECT',
                   901, '2026-02-09', 5000, 'draft')"
    ))
    .await;
    let err = db
        .try_exec("UPDATE purchases SET status='posted', posted_at='2026-02-09T10:00:00.000Z' WHERE id='direct-2'")
        .await
        .expect_err("the trigger must refuse promoting a duplicate to posted");
    assert!(err.to_string().contains("already posted"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases WHERE status='posted'").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_duplicate_guard_normalizes_exactly_as_the_stored_key_does() {
    // Migration 010 defines the normalized form twice: once as the generated
    // column `supplier_reference_key`, and once inline in each duplicate
    // trigger, because SQLite does not expose a VIRTUAL generated column
    // through `NEW`. If those two expressions ever drift, a duplicate slips
    // past one of them. This test is what holds them in step.
    let db = store_with_supplier_and_products().await;

    for raw in [" inv-1 ", "inv/2", "ab-ç-3", "  ", "", "x"] {
        db.exec(&format!(
            "INSERT INTO purchases (
               id, store_id, supplier_id, purchase_type, supplier_reference,
               purchase_number, purchase_date, status
             ) VALUES ('{}', '{STORE_ID}', '{SUPPLIER}', 'normal', '{raw}',
                       {}, '2026-02-09', 'draft')",
            uuid(),
            500 + raw.len() as i64 * 7 + raw.as_bytes().first().copied().unwrap_or(0) as i64,
        ))
        .await;
    }

    // The column and the trigger's inline expression must agree for every one
    // of those, which is exactly what comparing them row by row asserts.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM purchases
              WHERE supplier_reference_key IS NOT NULLIF(TRIM(UPPER(supplier_reference), char(9,10,13,32)), '')"
        )
        .await,
        0,
        "the stored key must equal the expression the duplicate triggers compute"
    );
}

// ============================================================================
// Purchase retry idempotency (Part I)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaying_a_purchase_identity_reconciles_to_the_purchase_that_exists() {
    // The lost-answer case: the transaction committed, the client never saw the
    // reply, the buyer presses Post again. Before WP-05 that booked the
    // delivery twice — two payables, twice the stock, the cost blended in
    // twice — and the supplier-reference rule only caught it if the bill
    // happened to quote a number.
    let db = store_with_supplier_and_products().await;

    let payload =
        purchase_payload_with_reference("normal", Some(SUPPLIER), None, coffee_lines(10, 200));
    let first = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload))
        .await
        .expect("the purchase posts");

    let avg_after_first = db
        .scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await;

    let replay = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload))
        .await
        .expect("a faithful replay must reconcile, not fail");

    // The caller is handed the purchase that exists, down to its number.
    assert_eq!(replay.purchase_id, first.purchase_id);
    assert_eq!(replay.purchase_number, first.purchase_number);
    assert_eq!(replay.posted_at, first.posted_at);
    assert_eq!(replay.movement_ids, first.movement_ids);
    assert_eq!(replay.ledger_entry_id, first.ledger_entry_id);

    // And exactly one of everything economic.
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 2_220);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        avg_after_first,
        "a replay must not blend the same delivery into the cost pool twice"
    );
    // A replay writes nothing, so it costs the document sequence nothing.
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_is_keyed_on_the_purchase_identity_not_on_its_line_ids() {
    // `replay_of_purchase` mints fresh `purchase_item_id`s, because that is
    // what the Purchases page and `purchasesRepo.post` actually send on a
    // retry. Those ids are request noise; the document identity is not.
    let db = store_with_supplier_and_products().await;

    let payload = purchase_payload("normal", Some(SUPPLIER), coffee_lines(5, 400));
    let first = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload)).await.unwrap();
    let replay = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload)).await.unwrap();

    assert_eq!(replay.purchase_number, first.purchase_number);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reusing_a_purchase_identity_for_a_different_bill_is_a_conflict() {
    let db = store_with_supplier_and_products().await;

    let payload = purchase_payload("normal", Some(SUPPLIER), coffee_lines(10, 200));
    post_purchase_with_pool(db.pool(), replay_of_purchase(&payload)).await.unwrap();

    // Same identity, a different quantity: not the bill that posted under it.
    let mut changed = replay_of_purchase(&payload);
    changed.lines = coffee_lines(11, 200);
    let err = post_purchase_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");
    assert!(err.contains("different subtotal"), "got: {err}");

    // Same identity, a different price.
    let mut changed = replay_of_purchase(&payload);
    changed.lines = coffee_lines(10, 250);
    assert!(post_purchase_with_pool(db.pool(), changed).await.is_err());

    // Same identity, a different supplier reference — a different document.
    let mut changed = replay_of_purchase(&payload);
    changed.supplier_reference = Some("INV-OTHER".to_string());
    let err = post_purchase_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("different supplier reference"), "got: {err}");

    // Same identity, a different supplier.
    let mut changed = replay_of_purchase(&payload);
    changed.supplier_id = Some(SUPPLIER_B.to_string());
    let err = post_purchase_with_pool(db.pool(), changed).await.unwrap_err();
    assert!(err.contains("different supplier"), "got: {err}");

    // Nothing was added by any of the four refusals.
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 2_220);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_deliveries_of_the_same_goods_under_different_identities_both_post() {
    // The control for the rule above, and the reason business duplicate
    // detection is a SEPARATE question: a shop really can receive the same
    // order twice in a week. Different identities, different invoice numbers,
    // two legitimate purchases and two payables.
    let db = store_with_supplier_and_products().await;

    let a = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-A"), coffee_lines(10, 200)),
    )
    .await
    .unwrap();
    let b = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-B"), coffee_lines(10, 200)),
    )
    .await
    .unwrap();

    assert_ne!(a.purchase_id, b.purchase_id);
    assert_ne!(a.purchase_number, b.purchase_number);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases WHERE status='posted'").await, 2);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 2);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 4_440);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 20);
}

// ============================================================================
// The balance read model (Part J)
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_payable_reconciles_across_purchases_payments_and_credits() {
    // One arithmetic, one answer: whatever the Supplier screen shows is
    // `SUM(amount_cents)`, and that is the figure the posting commands check
    // against. This walks a realistic month and asserts the balance after every
    // step — including that the `supplier_balances` view agrees.
    let db = store_with_supplier_and_products().await;

    // Two bills on credit: $22.20 and $11.10 gross.
    for (reference, qty) in [("INV-301", 10), ("INV-302", 5)] {
        post_purchase_with_pool(
            db.pool(),
            purchase_payload_with_reference("normal", Some(SUPPLIER), Some(reference), coffee_lines(qty, 200)),
        )
        .await
        .unwrap();
    }
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 3_330);

    // A part payment.
    let r = post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -1_000))
        .await
        .unwrap();
    assert_eq!(r.new_balance_cents, 2_330);

    // A credit note the supplier issued for short-delivered goods.
    let r = post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "credit_note", -330))
        .await
        .unwrap();
    assert_eq!(r.new_balance_cents, 2_000);

    // The rest.
    let r = post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -2_000))
        .await
        .unwrap();
    assert_eq!(r.new_balance_cents, 0);

    // Every way of asking gives the same number.
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT balance_cents FROM supplier_balances WHERE supplier_id='{SUPPLIER}'"
        ))
        .await,
        0,
        "the supplier_balances view must agree with the ledger sum"
    );
    // And it decomposes: invoices raised, payments and credits applied.
    assert_eq!(ledger_total_for(&db, SUPPLIER, "purchase").await, 3_330);
    assert_eq!(ledger_total_for(&db, SUPPLIER, "payment").await, -3_000);
    assert_eq!(ledger_total_for(&db, SUPPLIER, "credit_note").await, -330);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(total_incl_vat_cents),0) FROM purchases
              WHERE supplier_id='{SUPPLIER}' AND status='posted'"
        ))
        .await,
        ledger_total_for(&db, SUPPLIER, "purchase").await,
        "posted purchase totals must equal the invoice liabilities they raised"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_suppliers_activity_never_moves_anothers_balance() {
    let db = store_with_supplier_and_products().await;

    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("A-1"), coffee_lines(10, 200)),
    )
    .await
    .unwrap();
    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER_B), Some("B-1"), coffee_lines(5, 200)),
    )
    .await
    .unwrap();
    post_supplier_payment_with_pool(db.pool(), supplier_payment_payload(SUPPLIER, "payment", -2_220))
        .await
        .unwrap();

    assert_eq!(supplier_balance(&db, SUPPLIER).await, 0);
    assert_eq!(supplier_balance(&db, SUPPLIER_B).await, 1_110);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_of_a_referenced_bill_reconciles_rather_than_tripping_the_duplicate_rule() {
    // The ordering inside `post_purchase` is load bearing. The retry check runs
    // BEFORE the duplicate-invoice check, and it has to: the purchase already
    // posted under this identity quotes this very reference, so a duplicate
    // check that ran first would tell a buyer their own bill is a duplicate of
    // itself and leave them unable to confirm what had posted.
    let db = store_with_supplier_and_products().await;

    let payload = purchase_payload_with_reference(
        "normal",
        Some(SUPPLIER),
        Some("INV-REPLAY"),
        coffee_lines(10, 200),
    );
    let first = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload))
        .await
        .expect("the purchase posts");

    let replay = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload))
        .await
        .expect("a retry of the same identity must reconcile, not read as a duplicate invoice");
    assert_eq!(replay.purchase_number, first.purchase_number);
    assert_eq!(replay.ledger_entry_id, first.ledger_entry_id);

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(supplier_balance(&db, SUPPLIER).await, 2_220);

    // A DIFFERENT identity quoting the same reference is still the duplicate it
    // always was.
    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-REPLAY"), coffee_lines(10, 200)),
    )
    .await
    .unwrap_err();
    assert!(err.contains("already posted for this supplier"), "got: {err}");
}

// ============================================================================
// One authoritative unit price per purchase line
// ============================================================================
//
// The WP-05 release-gate blocker. `post_purchase` used to take the
// VAT-exclusive and VAT-inclusive per-UoM costs as two independent client
// values, checking only that they were non-negative and ordered — so a line
// could declare "$20.00 net, $999.00 gross" at 11% and, with totals that
// matched the gross figure, post: inventory valued off $20 while the supplier
// ledger took $999 of debt, for one delivery, on rows nothing can edit again.
//
// The invoice states ONE price. `vat_pricing_mode` names which side of the pair
// that is, and the counterpart is derived with the application's own VAT
// rounding and cross-checked.
//
// At 11% the figures below are chosen to make the direction visible:
//
//   add_vat(50)   = 50 + round(5.5)   = 56      (a true half-cent boundary)
//   strip_vat(55) = round(550000/11100) = 50
//   strip_vat(56) = round(560000/11100) = 50
//
// so the pair (50, 55) is coherent ONLY as a gross-quoted invoice, and
// (50, 56) is coherent either way. That asymmetry is not a defect — it is what
// rounding to whole cents means — and it is exactly why the mode has to decide
// which helper runs rather than the backend guessing.

/// Sum of the authoritative purchase liabilities raised for `supplier`.
async fn invoice_liability(db: &TempDb, supplier: &str) -> i64 {
    ledger_total_for(db, supplier, "purchase").await
}

/// Assert that a purchase attempt left absolutely nothing behind: no document,
/// no lines, no goods, no debt, no cost blend, no sequence advance.
async fn assert_no_effects_at_all(db: &TempDb, product: &str) {
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 0, "no purchase");
    assert_eq!(db.count("SELECT COUNT(*) FROM purchase_items").await, 0, "no purchase items");
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0, "no movement");
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 0, "no payable");
    assert_eq!(quantity_on_hand(db, product).await, 0, "no stock");
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents + avg_cost_incl_vat_microcents
               FROM products WHERE id='{product}'"
        ))
        .await,
        0,
        "no weighted-average change"
    );
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key='next_purchase_number'").await,
        "1",
        "no purchase-number advancement"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invoice_quoting_the_net_price_posts_and_derives_the_gross() {
    let db = store_with_supplier_and_products().await;

    // $2.00 net per unit at 11%, 10 units: the buyer typed the net figure.
    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(10)
        .unit_cost_excl(200)
        .build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("an exclusive-mode line posts");

    // The persisted pair is the net price and the gross the backend derived.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_in_uom_cents FROM purchase_items").await,
        200
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_in_uom_cents FROM purchase_items").await,
        222
    );
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await, 2_220);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 2_220);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_net_quoted_line_whose_gross_was_not_derived_from_it_is_refused() {
    // THE blocker case, verbatim: 11% VAT, exclusive mode, $20.00 net declared
    // alongside $999.00 gross — and totals that match the gross, so nothing but
    // the VAT relationship can catch it.
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(1)
        .unit_cost_excl(2_000)
        .raw_unit_costs(2_000, 99_900)
        .build()];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("are not one price"), "got: {err}");
    assert!(err.contains("2220"), "the error must show the price that was derived: {err}");

    assert_no_effects_at_all(&db, P_COFFEE).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invoice_quoting_the_gross_price_posts_and_derives_the_net() {
    let db = store_with_supplier_and_products().await;

    // 55 cents gross per unit at 11% → 50 cents net. Note this pair is NOT
    // reachable from the net side (add_vat(50) = 56), so a backend that
    // silently checked the other direction would refuse a legitimate bill.
    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(4)
        .unit_cost_incl(55)
        .build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("an inclusive-mode line posts");

    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_in_uom_cents FROM purchase_items").await,
        55
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_in_uom_cents FROM purchase_items").await,
        50
    );
    // 4 x 55 = 220 gross, 4 x 50 = 200 net, VAT 20.
    assert_eq!(db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await, 200);
    assert_eq!(db.scalar_i64("SELECT vat_total_cents FROM purchases").await, 20);
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await, 220);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 220);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gross_quoted_line_whose_net_was_not_derived_from_it_is_refused() {
    let db = store_with_supplier_and_products().await;

    // $1.11 gross declared with an unrelated net figure.
    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(1)
        .unit_cost_incl(111)
        .raw_unit_costs(20, 111)
        .build()];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("are not one price"), "got: {err}");
    assert!(err.contains("100"), "the error must show the net that was derived: {err}");

    assert_no_effects_at_all(&db, P_COFFEE).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pricing_mode_decides_which_direction_the_vat_runs() {
    // One pair, two verdicts — the clearest statement of why the mode is not a
    // presentation detail. (50, 55) is a coherent gross-quoted line and an
    // incoherent net-quoted one, because add_vat(50) is 56.
    for (mode, expected_ok) in [("inclusive", true), ("exclusive", false)] {
        let db = store_with_supplier_and_products().await;
        let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .qty(1)
            .unit_cost_incl(55)
            .raw_pricing_mode(Some(mode))
            .build()];
        let result =
            post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
                .await;
        assert_eq!(
            result.is_ok(),
            expected_ok,
            "the pair (50, 55) under {mode} mode: {result:?}"
        );
        if !expected_ok {
            assert_no_effects_at_all(&db, P_COFFEE).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_that_names_no_pricing_mode_falls_back_to_the_products_own() {
    // The compatibility path: a caller that predates the field. The product's
    // `vat_pricing_mode` is what the Purchases page initialises its per-line
    // toggle from, so falling back to it keeps such a caller working the way
    // the UI would have. And the fallback is really consulted — the same pair
    // is accepted or refused depending on the product's mode alone.
    for (product_mode, expected_ok) in [("inclusive", true), ("exclusive", false)] {
        let db = TempDb::new().await;
        seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
        seed_product(
            &db,
            &ProductSpec {
                vat_pricing_mode: product_mode,
                ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
            },
        )
        .await;

        let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
            .qty(1)
            .unit_cost_incl(55)
            .raw_pricing_mode(None)
            .build()];
        let result =
            post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
                .await;
        assert_eq!(
            result.is_ok(),
            expected_ok,
            "a mode-less line against a {product_mode} product: {result:?}"
        );
        if !expected_ok {
            assert_no_effects_at_all(&db, P_COFFEE).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_nonsense_pricing_mode_is_refused_before_the_pool_is_touched() {
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(1)
        .unit_cost_excl(200)
        .raw_pricing_mode(Some("net_of_discount"))
        .build()];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("Invalid VAT pricing mode"), "got: {err}");
    assert_no_effects_at_all(&db, P_COFFEE).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exempt_line_must_quote_the_same_figure_both_ways() {
    let db = store_with_supplier_and_products().await;

    // 0 bps: there is no VAT to add or strip, so one price means one figure,
    // and it holds in both directions.
    for mode in ["exclusive", "inclusive"] {
        let lines = vec![PurchaseLineBuilder::new(P_SUGAR, "Sugar")
            .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
            .qty(3)
            .unit_cost_excl(150)
            .raw_pricing_mode(Some(mode))
            .build()];
        post_purchase_with_pool(
            db.pool(),
            purchase_payload_with_reference("normal", Some(SUPPLIER), Some(mode), lines),
        )
        .await
        .unwrap_or_else(|e| panic!("an exempt line must post under {mode} mode: {e}"));
    }
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM purchase_items
              WHERE unit_cost_excl_vat_in_uom_cents <> unit_cost_incl_vat_in_uom_cents"
        )
        .await,
        0,
        "an exempt line's two costs must be the same figure"
    );
    assert_eq!(db.scalar_i64("SELECT COALESCE(SUM(vat_total_cents),0) FROM purchases").await, 0);

    // And a 'VAT' amount on an exempt line is still refused.
    let lines = vec![PurchaseLineBuilder::new(P_SUGAR, "Sugar")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(1)
        .unit_cost_excl(150)
        .raw_unit_costs(150, 167)
        .build()];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("exempt") || err.contains("are not one price"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_half_cent_vat_boundary_lands_where_the_client_puts_it() {
    // 50 cents at 11% is 5.5 cents of VAT — an exact half, which the whole
    // codebase rounds away from zero. The Purchases page computes 56 via
    // `lib/vat.ts::addVat`; the backend must agree to the cent or every invoice
    // ending on a half-cent would be refused as "not one price".
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(1)
        .unit_cost_excl(50)
        .build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("a half-cent VAT line must post");

    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_in_uom_cents FROM purchase_items").await,
        56,
        "5.5 cents of VAT rounds up, as addVat does"
    );
    assert_eq!(db.scalar_i64("SELECT vat_total_cents FROM purchases").await, 6);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 56);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_quantity_line_extends_the_unit_price_it_was_given() {
    // VAT is applied to the UNIT price and then extended, which is the
    // convention `lib/purchaseMath.ts` uses. 7 x 56 = 392 gross, not
    // add_vat(7 x 50) = 389 — the two differ, and the persisted figures must be
    // the first.
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(7)
        .unit_cost_excl(50)
        .build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("a multi-quantity line posts");

    assert_eq!(db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await, 350);
    assert_eq!(db.scalar_i64("SELECT vat_total_cents FROM purchases").await, 42);
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await, 392);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 392);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_invoice_money_and_the_per_base_cost_stay_coherent_across_a_uom() {
    // The two halves of this package meeting: the invoice is cents-exact money
    // per PURCHASING unit, and the inventory cost is a microcent RATE per BASE
    // unit derived over the UoM conversion the DATABASE holds (WP-03). The VAT
    // correction must not touch the second.
    let db = store_with_supplier_and_products().await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;

    // 2 boxes of 12 at $24.00 net per box → $26.64 gross per box.
    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_cost_excl(2_400)
        .build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("a non-base UoM line posts");

    // Invoice money: per BOX, to the cent, and the payable is the gross.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_in_uom_cents FROM purchase_items").await,
        2_400
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_in_uom_cents FROM purchase_items").await,
        2_664
    );
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await, 5_328);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 5_328);

    // Inventory cost: per EACH, in microcents, over the DB's 12/1 factor.
    // $24.00/box ÷ 12 = $2.00/each = 200 cents = 200,000,000 microcents, and
    // $26.64/box ÷ 12 = $2.22/each.
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 24);
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_microcents FROM purchase_items").await,
        200_000_000
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_base_microcents FROM purchase_items").await,
        222_000_000
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_COFFEE}'"
        ))
        .await,
        200_000_000
    );

    // And the two views reconcile: the per-base net rate x base quantity is the
    // invoice's net subtotal.
    assert_eq!(
        db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await,
        4_800
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sub_cent_per_base_cost_still_survives_a_vat_derivation() {
    // GP-A03's own scenario, now through the VAT pair: flour bought by the kilo
    // at $2.50 net and stocked in grams. The gross is derived per KILO (cents,
    // exact) and the inventory rate per GRAM (microcents, sub-cent).
    let db = store_with_supplier_and_products().await;
    seed_product_uom(&db, P_SUGAR, "kg", 1000, 1).await;

    let lines = vec![PurchaseLineBuilder::new(P_SUGAR, "Sugar")
        .uom("kg", 1000, 1)
        .qty(2)
        .unit_cost_excl(250)
        .build()];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("a sub-cent per-base cost posts");

    // $2.50 net/kg → $2.78 gross/kg (round(27.5) = 28).
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_incl_vat_in_uom_cents FROM purchase_items").await,
        278
    );
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 556);

    // Per gram: 250/1000 = 0.25 cents = 250,000 microcents. Not zero.
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_microcents FROM purchase_items").await,
        250_000
    );
    assert_eq!(
        db.scalar_i64("SELECT unit_cost_excl_vat_base_cents FROM purchase_items").await,
        0,
        "the cents mirror rounds to zero, which is exactly why it is only a mirror"
    );
    assert_eq!(quantity_on_hand(&db, P_SUGAR).await, 2_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_persisted_cost_pair_is_one_price_under_the_lines_own_vat_rate() {
    // The economic consistency assertion, made against what is actually in the
    // database rather than against what was sent: for every posted taxable
    // line, the inclusive snapshot IS the exclusive snapshot grossed up at the
    // line's own snapshotted rate. That is what makes the stock's cost basis
    // and the supplier's debt two views of one price.
    let db = store_with_supplier_and_products().await;

    let lines = vec![
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build(),
        PurchaseLineBuilder::new(P_SUGAR, "Sugar").qty(3).unit_cost_incl(55).build(),
    ];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap();

    let rows = db
        .count(
            "SELECT COUNT(*) FROM purchase_items
              WHERE vat_rate_bps_snapshot > 0
                AND unit_cost_excl_vat_in_uom_cents
                    <> CAST(ROUND(unit_cost_incl_vat_in_uom_cents * 10000.0
                                  / (10000 + vat_rate_bps_snapshot)) AS INTEGER)",
        )
        .await;
    assert_eq!(rows, 0, "every taxable line's pair must strip back to its own net figure");

    // Header, lines and payable are one figure throughout.
    let header = db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await;
    assert_eq!(
        db.scalar_i64("SELECT COALESCE(SUM(line_total_incl_vat_cents),0) FROM purchase_items").await,
        header
    );
    assert_eq!(invoice_liability(&db, SUPPLIER).await, header);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mixed_vat_purchase_reconciles_line_by_line_and_in_total() {
    let db = store_with_supplier_and_products().await;

    // A taxable net-quoted line, a taxable gross-quoted line and an exempt one
    // on one bill — which is an ordinary Lebanese grocery invoice.
    let lines = vec![
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build(),
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(4).unit_cost_incl(55).build(),
        PurchaseLineBuilder::new(P_SUGAR, "Sugar")
            .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
            .qty(2)
            .unit_cost_excl(150)
            .build(),
    ];
    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .expect("a mixed-VAT purchase posts");

    // 10 x 222 = 2220 | 4 x 55 = 220 | 2 x 150 = 300, no VAT.
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM purchases").await, 2_740);
    assert_eq!(db.scalar_i64("SELECT subtotal_excl_vat_cents FROM purchases").await, 2_000 + 200 + 300);
    assert_eq!(db.scalar_i64("SELECT vat_total_cents FROM purchases").await, 220 + 20);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 2_740);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM supplier_ledger").await,
        1,
        "one bill, one payable, whatever the VAT mix"
    );
    // Stock from all three lines.
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 14);
    assert_eq!(quantity_on_hand(&db, P_SUGAR).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_malformed_line_takes_the_whole_bill_down_with_it() {
    // Line 1 is a perfectly good delivery and line 2 is the crafted pair. The
    // pair check is a PRE-PASS, so line 1's goods, cost blend and purchase
    // number are never written at all — not written and rolled back.
    let db = store_with_supplier_and_products().await;

    let lines = vec![
        PurchaseLineBuilder::new(P_COFFEE, "Coffee").qty(10).unit_cost_excl(200).build(),
        PurchaseLineBuilder::new(P_SUGAR, "Sugar")
            .qty(1)
            .unit_cost_excl(100)
            .raw_unit_costs(100, 50_000)
            .build(),
    ];
    let err = post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), lines))
        .await
        .unwrap_err();
    assert!(err.contains("Line 2"), "the error must name the offending line: {err}");
    assert!(err.contains("are not one price"), "got: {err}");

    assert_no_effects_at_all(&db, P_COFFEE).await;
    assert_eq!(quantity_on_hand(&db, P_SUGAR).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purchase_replay_survives_the_pair_derivation_and_still_catches_a_reprice() {
    // Idempotency must not be collateral damage. A faithful retry re-sends the
    // same pair and the same mode, and must reconcile; a retry that changed the
    // authoritative price is a different bill and must conflict.
    let db = store_with_supplier_and_products().await;

    let payload = purchase_payload("normal", Some(SUPPLIER), coffee_lines(10, 200));
    let first = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload)).await.unwrap();
    let replay = post_purchase_with_pool(db.pool(), replay_of_purchase(&payload))
        .await
        .expect("a faithful replay must still reconcile");
    assert_eq!(replay.purchase_number, first.purchase_number);
    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 2_220);

    // Repricing the authoritative side changes the pair, which the canonical
    // comparison compares — so it conflicts rather than replaying.
    let mut repriced = replay_of_purchase(&payload);
    repriced.lines = coffee_lines(10, 201);
    let err = post_purchase_with_pool(db.pool(), repriced).await.unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");

    // Restating the SAME price as a gross-quoted line is the same money and the
    // same purchase: 200 net / 222 gross is coherent read either way, so this
    // is a retry, not a new bill. Nothing is written either way.
    let mut restated = replay_of_purchase(&payload);
    for line in &mut restated.lines {
        line.vat_pricing_mode = Some("inclusive".to_string());
    }
    post_purchase_with_pool(db.pool(), restated)
        .await
        .expect("the same pair, read from the other side, is the same bill");

    assert_eq!(db.count("SELECT COUNT(*) FROM purchases").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM supplier_ledger").await, 1);
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 2_220);
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crafted_pair_cannot_be_smuggled_in_under_a_duplicate_invoice_reference() {
    // The two WP-05 rules compose rather than shadowing each other: a malformed
    // pair is refused on its own terms, and refusing it does not release or
    // consume the invoice reference it quoted.
    let db = store_with_supplier_and_products().await;

    let lines = vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee")
        .qty(1)
        .unit_cost_excl(2_000)
        .raw_unit_costs(2_000, 99_900)
        .build()];
    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-CRAFT"), lines),
    )
    .await
    .unwrap_err();
    assert!(err.contains("are not one price"), "got: {err}");
    assert_no_effects_at_all(&db, P_COFFEE).await;

    // The reference is still free, because nothing was ever posted under it.
    post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-CRAFT"), coffee_lines(1, 2_000)),
    )
    .await
    .expect("a corrected bill quoting the same reference must post");
    assert_eq!(invoice_liability(&db, SUPPLIER).await, 2_220);

    // And now it is taken.
    let err = post_purchase_with_pool(
        db.pool(),
        purchase_payload_with_reference("normal", Some(SUPPLIER), Some("INV-CRAFT"), coffee_lines(1, 2_000)),
    )
    .await
    .unwrap_err();
    assert!(err.contains("already posted for this supplier"), "got: {err}");
}
