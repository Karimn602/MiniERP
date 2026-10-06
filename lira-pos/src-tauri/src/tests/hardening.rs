// Layer C — WP-07 database & inventory hardening.
//
// Three families of defect, all found by asking what DIRECT SQL can still do
// to a settled document, plus the one application-level trust boundary WP-02
// and WP-03 left behind:
//
//   * `post_adjustment` believed the client's quantity and UoM metadata — the
//     GP-A02 rule was never applied to the third posting command.
//   * a CLOSED shift could be deleted.
//   * a POSTED sale or purchase could gain a child, or have one reparented
//     into it, because migration 001/005 guarded UPDATE and DELETE only and
//     keyed those guards on the OLD parent alone.

use crate::posting::{
    close_shift_with_pool, open_shift_with_pool, post_adjustment_with_pool,
    post_purchase_with_pool, post_sale_with_pool, CloseShiftPayload, OpenShiftPayload,
};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_WATER: &str = "00000000-0000-0000-0000-0000000000c2";
const SHIFT_A: &str = "00000000-0000-0000-0000-0000000000a1";
const SUPPLIER: &str = "00000000-0000-0000-0000-00000000a0b1";

/// A store with coffee (100 on hand at $2.00/$2.22) and water, plus a `box` UoM
/// of 12 on the coffee and a retired `case` UoM of 24.
async fn shop() -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 100,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            price_excl_vat_cents: 450,
            price_incl_vat_cents: 500,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee 250g")
        },
    )
    .await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 50,
            ..ProductSpec::stocked(P_WATER, "SKU-C2", "Water 1.5L")
        },
    )
    .await;
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;
    seed_inactive_product_uom(&db, P_COFFEE, "case", 24, 1).await;
    seed_product_uom(&db, P_WATER, "pack", 6, 1).await;
    db
}

async fn movement_count(db: &TempDb) -> i64 {
    db.count("SELECT COUNT(*) FROM inventory_movements WHERE movement_type = 'adjustment'")
        .await
}

// ============================================================================
// 1. The inventory-adjustment trust boundary
// ============================================================================

/// The ordinary case, end to end: a manager counts two boxes of twelve back
/// onto the shelf, and the DATABASE's conversion is what moves the stock and
/// what the movement row records.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_in_a_derived_uom_resolves_its_conversion_from_the_database() {
    let db = shop().await;
    let line = adjustment_line_in_uom(P_COFFEE, "box", 12, 1, 2);
    let movement_id = line.movement_id.clone();

    post_adjustment_with_pool(db.pool(), adjustment_payload("stock count", vec![line]))
        .await
        .expect("a box adjustment must post");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 124, "100 + 2 x 12");
    assert_eq!(movement_sum(&db, P_COFFEE).await, 24);

    // The row documents the same conversion that moved the stock: the resolved
    // factor, the manager's own unit quantity, and the derived base delta.
    for (column, expected) in [
        ("quantity_delta", 24),
        ("quantity_in_uom", 2),
        ("factor_num_snapshot", 12),
        ("factor_den_snapshot", 1),
        // And it is valued at the product's CURRENT weighted average, in
        // microcents, with the cents column as its rounded mirror.
        ("unit_cost_excl_vat_microcents", 200_000_000),
        ("unit_cost_incl_vat_microcents", 222_000_000),
        ("unit_cost_excl_vat_cents", 200),
    ] {
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT {column} FROM inventory_movements WHERE id = '{movement_id}'"
            ))
            .await,
            expected,
            "movement column {column}"
        );
    }
    assert_eq!(
        db.scalar_string(&format!(
            "SELECT uom_code_snapshot FROM inventory_movements WHERE id = '{movement_id}'"
        ))
        .await,
        "box"
    );
}

/// A negative adjustment in a derived UoM, and the zero boundary the existing
/// policy allows — both measured against the AUTHORITATIVE delta.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_negative_uom_adjustment_removes_the_derived_quantity() {
    let db = shop().await;
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("breakage", vec![adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -3)]),
    )
    .await
    .expect("a negative box adjustment must post");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 64, "100 - 3 x 12");

    // Down to exactly zero is still the allowed boundary, and it is the derived
    // delta the policy is applied to.
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "wrote off the rest",
            vec![adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -1)],
        ),
    )
    .await
    .expect("64 - 12 is still above zero");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 52);

    // And one box too many is refused, on the derived quantity.
    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("shrinkage", vec![adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -5)]),
    )
    .await
    .expect_err("5 x 12 is more than 52");
    assert!(err.contains("drive stock negative"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 52, "unchanged");
}

/// THE defect. A request that claims one unit while moving a thousand.
///
/// Before WP-07 `quantity_base_signed` went straight into both the movement row
/// and `quantity_on_hand`, so this posted — and the audit trail then actively
/// denied the discrepancy it had created, which is worse than being wrong,
/// because reconciliation reports the trail as consistent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_base_delta_that_contradicts_the_unit_quantity_is_refused() {
    let db = shop().await;
    let crafted = with_raw_base(adjustment_line_in_uom(P_COFFEE, "each", 1, 1, 1), 1_000);

    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload("stock count", vec![crafted]),
    )
    .await
    .expect_err("a declared base delta that contradicts the conversion is refused");
    assert!(err.contains("does not match the authoritative"), "got: {err}");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "no stock moved");
    assert_eq!(movement_count(&db).await, 0, "and no movement was written");
}

/// The same crafted shape in the other direction: a plausible unit quantity in
/// a real UoM, with a base delta that is not what that UoM converts to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_understated_base_delta_in_a_derived_uom_is_refused() {
    let db = shop().await;
    // "2 boxes", but only 2 base units, please.
    let crafted = with_raw_base(adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -2), -2);

    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("count", vec![crafted]))
        .await
        .expect_err("an understated base delta is refused");
    assert!(err.contains("× 12/1 = -24"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_conversion_factor_is_refused_rather_than_normalized() {
    let db = shop().await;
    // The shop used to pack coffee ten to a box; the payload still believes it.
    let stale = with_raw_factor(adjustment_line_in_uom(P_COFFEE, "box", 12, 1, 2), 10, 1);

    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("recount", vec![stale]))
        .await
        .expect_err("a factor that contradicts the product's own is refused");
    assert!(
        err.contains("declared UoM factor 10/1 does not match"),
        "got: {err}"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(movement_count(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_products_unit_of_measure_cannot_be_borrowed() {
    let db = shop().await;
    // `pack` is water's unit, not coffee's. Scoping the lookup by product_id is
    // what makes it unresolvable here rather than merely implausible.
    let borrowed = adjustment_line_in_uom(P_COFFEE, "pack", 6, 1, 2);

    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("count", vec![borrowed]))
        .await
        .expect_err("another product's UoM is not this product's");
    assert!(err.contains("is not an active unit of measure"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_unit_of_measure_cannot_be_adjusted_in() {
    let db = shop().await;
    // The shop stopped buying by the case; the row is still there, inactive.
    let retired = adjustment_line_in_uom(P_COFFEE, "case", 24, 1, 1);

    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("count", vec![retired]))
        .await
        .expect_err("a retired UoM is unusable");
    assert!(err.contains("is not an active unit of measure"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_unit_of_measure_that_does_not_exist_at_all_is_refused() {
    let db = shop().await;
    let invented = with_raw_uom_code(
        adjustment_line_in_uom(P_COFFEE, "each", 1, 1, 5),
        "pallet",
    );
    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("count", vec![invented]))
        .await
        .expect_err("an invented UoM is refused");
    assert!(err.contains("is not an active unit of measure"), "got: {err}");
    assert_eq!(movement_count(&db).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_against_an_unknown_product_or_another_store_is_refused() {
    let db = shop().await;
    let mut payload =
        adjustment_payload("count", vec![adjustment_line_in_uom(P_COFFEE, "each", 1, 1, 1)]);
    payload.lines[0].product_id = "no-such-product".to_string();
    let err = post_adjustment_with_pool(db.pool(), payload)
        .await
        .expect_err("an unknown product is refused");
    assert!(err.contains("not found in store"), "got: {err}");

    // And a product that exists, read through another store's books.
    seed_store(&db, "store-b", "Branch B").await;
    let mut payload =
        adjustment_payload("count", vec![adjustment_line_in_uom(P_COFFEE, "each", 1, 1, 1)]);
    payload.store_id = "store-b".to_string();
    let err = post_adjustment_with_pool(db.pool(), payload)
        .await
        .expect_err("another store's inventory is not ours to adjust");
    assert!(err.contains("not found in store"), "got: {err}");
    assert_eq!(movement_count(&db).await, 0);
}

/// A line that disagrees with itself about DIRECTION is refused before the pool
/// is even acquired: "−3 boxes" with a +36 base delta is not a rounding
/// disagreement for the backend to resolve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_line_that_disagrees_about_direction_is_refused() {
    let db = shop().await;
    let crafted = with_raw_base(adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -3), 36);

    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("count", vec![crafted]))
        .await
        .expect_err("a direction disagreement is refused");
    assert!(err.contains("disagrees with itself about direction"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_quantity_line_is_refused_in_either_field() {
    let db = shop().await;
    let mut zero_base =
        adjustment_payload("count", vec![adjustment_line_in_uom(P_COFFEE, "each", 1, 1, 1)]);
    zero_base.lines[0].quantity_base_signed = 0;
    assert!(post_adjustment_with_pool(db.pool(), zero_base)
        .await
        .unwrap_err()
        .contains("zero delta"));

    let mut zero_uom =
        adjustment_payload("count", vec![adjustment_line_in_uom(P_COFFEE, "each", 1, 1, 1)]);
    zero_uom.lines[0].quantity_in_uom_signed = 0;
    assert!(post_adjustment_with_pool(db.pool(), zero_uom)
        .await
        .unwrap_err()
        .contains("zero quantity"));

    assert_eq!(movement_count(&db).await, 0);
}

/// Resolution is a PRE-PASS: a malformed line 2 cannot leave line 1's stock
/// movement behind, even transiently.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bad_second_line_rolls_the_whole_adjustment_back() {
    let db = shop().await;
    let good = adjustment_line_in_uom(P_COFFEE, "box", 12, 1, 2);
    let bad = with_raw_factor(adjustment_line_in_uom(P_WATER, "pack", 6, 1, 1), 99, 1);

    let err = post_adjustment_with_pool(db.pool(), adjustment_payload("recount", vec![good, bad]))
        .await
        .expect_err("the second line is malformed");
    assert!(err.contains("Line 2"), "got: {err}");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "line 1 did not move stock");
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 50);
    assert_eq!(movement_count(&db).await, 0);
    assert_eq!(movement_sum(&db, P_COFFEE).await, 0);
}

/// An adjustment does not touch the weighted average — it is a quantity
/// correction valued AT the average, not a repricing of the pool. Unchanged
/// policy, restated because WP-07 rewrote the surrounding code.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_adjustment_values_itself_at_the_average_without_moving_it() {
    let db = shop().await;
    seed_product_avg_cost_microcents(&db, P_COFFEE, 2_500, 2_775).await; // $0.000025
    let before = avg_cost_excl_microcents(&db, P_COFFEE).await;

    let line = adjustment_line_in_uom(P_COFFEE, "box", 12, 1, 1);
    let movement_id = line.movement_id.clone();
    post_adjustment_with_pool(db.pool(), adjustment_payload("count", vec![line]))
        .await
        .expect("post");

    assert_eq!(
        avg_cost_excl_microcents(&db, P_COFFEE).await,
        before,
        "an adjustment is not a cost event"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cost_excl_vat_microcents FROM inventory_movements WHERE id = '{movement_id}'"
        ))
        .await,
        2_500,
        "but it is valued at the fractional average, not rounded to zero"
    );
}

// ============================================================================
// 2. A closed shift cannot be deleted
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_shift_can_neither_be_rewritten_nor_deleted() {
    let db = shop().await;
    // Retire the fixture shift so this test owns the store's open one.
    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_ID.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 0,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close the fixture shift");

    open_shift_with_pool(
        db.pool(),
        OpenShiftPayload {
            shift_id: SHIFT_A.to_string(),
            store_id: STORE_ID.to_string(),
            opened_by_user_id: USER_ID.to_string(),
            device_id: None,
            opening_cash_usd_cents: 5_000,
            opening_cash_lbp: 0,
            notes: None,
        },
    )
    .await
    .expect("open a shift");
    close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_A.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 4_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close it, $10.00 short");

    // Migration 009 already refused the UPDATE.
    assert!(
        db.try_exec(&format!(
            "UPDATE shifts SET closing_cash_usd_cents = 5_000 WHERE id = '{SHIFT_A}'"
        ))
        .await
        .is_err(),
        "a closed shift's counted cash is final"
    );

    // WP-07 refuses the DELETE. This shift has NO sales, so no foreign key
    // protects it — the reconciliation evidence is all there is, and a drawer
    // that was counted and found short is exactly the shift somebody might
    // prefer did not exist.
    let err = db
        .try_exec(&format!("DELETE FROM shifts WHERE id = '{SHIFT_A}'"))
        .await
        .expect_err("a closed shift cannot be deleted");
    assert!(err.to_string().contains("closed shift"), "got: {err}");

    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM shifts WHERE id = '{SHIFT_A}'")).await, 1);
    assert_eq!(
        db.scalar_i64(&format!("SELECT variance_usd_cents FROM shifts WHERE id = '{SHIFT_A}'"))
            .await,
        -1_000,
        "and the variance still says it was short"
    );
}

/// The shift LIFECYCLE is untouched: an open shift is still an ordinary row
/// until it is closed, which is what `open_shift`/`close_shift` own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_shift_is_still_deletable_and_the_lifecycle_still_works() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    open_shift_with_pool(
        db.pool(),
        OpenShiftPayload {
            shift_id: SHIFT_A.to_string(),
            store_id: STORE_ID.to_string(),
            opened_by_user_id: USER_ID.to_string(),
            device_id: None,
            opening_cash_usd_cents: 0,
            opening_cash_lbp: 0,
            notes: None,
        },
    )
    .await
    .expect("open");

    // A shift opened by mistake, before anything was rung up, is not yet a
    // financial record.
    db.exec(&format!("DELETE FROM shifts WHERE id = '{SHIFT_A}'")).await;
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts").await, 0);

    // And the store can open and close one again afterwards.
    open_shift_with_pool(
        db.pool(),
        OpenShiftPayload {
            shift_id: SHIFT_A.to_string(),
            store_id: STORE_ID.to_string(),
            opened_by_user_id: USER_ID.to_string(),
            device_id: None,
            opening_cash_usd_cents: 1_000,
            opening_cash_lbp: 0,
            notes: None,
        },
    )
    .await
    .expect("reopen");
    let closed = close_shift_with_pool(
        db.pool(),
        CloseShiftPayload {
            shift_id: SHIFT_A.to_string(),
            store_id: STORE_ID.to_string(),
            closed_by_user_id: USER_ID.to_string(),
            closing_cash_usd_cents: 1_000,
            closing_cash_lbp: 0,
        },
    )
    .await
    .expect("close");
    assert_eq!(closed.status, "closed");
    assert_eq!(closed.variance_usd_cents, Some(0));
}

/// A shift WITH activity was already protected, by the foreign key rather than
/// by a trigger. Stated so the two mechanisms are not confused for one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shift_with_sales_against_it_is_protected_by_its_foreign_key() {
    let db = shop().await;
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(1).unit_incl(500).build()];
    let total = lines_total(&lines);
    post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(total)]))
        .await
        .expect("sell something into the open shift");

    assert!(
        db.try_exec(&format!("DELETE FROM shifts WHERE id = '{SHIFT_ID}'"))
            .await
            .is_err(),
        "ON DELETE RESTRICT already refuses this, closed or not"
    );
}

// ============================================================================
// 3. A posted sale takes no further children, and cannot be reparented
// ============================================================================

/// Post one coffee for cash and hand back the sale id.
async fn posted_sale(db: &TempDb) -> String {
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(2).unit_incl(500).build()];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.expect("the fixture sale must post");
    sale_id
}

/// A DRAFT sale, written by hand — the only state in which a sale legitimately
/// takes children, and the state `post_sale` itself is in while it writes them.
async fn draft_sale(db: &TempDb, id: &str, receipt: i64) {
    db.exec(&format!(
        "INSERT INTO sales (
           id, store_id, shift_id, cashier_user_id, receipt_number,
           exchange_rate_lbp_per_usd, exchange_rate_id,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           discount_cents, cogs_total_cents, cogs_method, sale_type, status
         ) VALUES ('{id}', '{STORE_ID}', '{SHIFT_ID}', '{USER_ID}', {receipt},
                   {RATE_LBP_PER_USD}, '{RATE_ID}', 450, 50, 500, 0, 0,
                   'weighted_average', 'normal', 'draft')"
    ))
    .await;
}

fn sale_item_sql(id: &str, sale_id: &str) -> String {
    format!(
        "INSERT INTO sale_items (
           id, sale_id, store_id, product_id, product_name_snapshot,
           vat_rate_id_snapshot, vat_rate_bps_snapshot, quantity,
           unit_price_excl_vat_cents, unit_price_incl_vat_cents,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
         ) VALUES ('{id}', '{sale_id}', '{STORE_ID}', '{P_COFFEE}', 'Coffee 250g',
                   '{VAT_STD_ID}', 1100, 1, 450, 500, 450, 50, 500)"
    )
}

fn sale_payment_sql(id: &str, sale_id: &str) -> String {
    format!(
        "INSERT INTO sale_payments (
           id, sale_id, store_id, method, currency,
           amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent
         ) VALUES ('{id}', '{sale_id}', '{STORE_ID}', 'cash_usd', 'USD', 500, 0, 500)"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sale_cannot_gain_a_line() {
    let db = shop().await;
    let sale = posted_sale(&db).await;

    // A smuggled line changes what the receipt sold — and therefore what is
    // returnable against it, since WP-06 bounds a return by `sale_items.quantity`.
    let err = db
        .try_exec(&sale_item_sql("smuggled", &sale))
        .await
        .expect_err("a posted sale must not take another line");
    assert!(err.to_string().contains("posted sale"), "got: {err}");

    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sale_items WHERE sale_id = '{sale}'")).await,
        1,
        "the sale still holds exactly the line it posted with"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_sale_cannot_gain_a_payment() {
    let db = shop().await;
    let sale = posted_sale(&db).await;

    // A smuggled tender row inflates the drawer `close_shift` expects, and
    // hands a return a method to refund through that nobody paid with.
    let err = db
        .try_exec(&sale_payment_sql("smuggled", &sale))
        .await
        .expect_err("a posted sale must not take another payment");
    assert!(err.to_string().contains("posted sale"), "got: {err}");

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT COALESCE(SUM(amount_usd_cents_equivalent), 0)
               FROM sale_payments WHERE sale_id = '{sale}'"
        ))
        .await,
        1_000,
        "the tender still equals what was rung up"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_child_cannot_be_reparented_into_or_out_of_a_posted_sale() {
    let db = shop().await;
    let posted = posted_sale(&db).await;
    draft_sale(&db, "draft-sale", 9001).await;
    db.exec(&sale_item_sql("draft-item", "draft-sale")).await;
    db.exec(&sale_payment_sql("draft-pay", "draft-sale")).await;

    // Into: the old parent is a draft, which is what a one-sided guard waved
    // through.
    let err = db
        .try_exec(&format!(
            "UPDATE sale_items SET sale_id = '{posted}' WHERE id = 'draft-item'"
        ))
        .await
        .expect_err("a posted sale must not grow a line by reparenting");
    assert!(err.to_string().contains("posted sale"), "got: {err}");
    assert!(
        db.try_exec(&format!(
            "UPDATE sale_payments SET sale_id = '{posted}' WHERE id = 'draft-pay'"
        ))
        .await
        .is_err(),
        "nor a payment"
    );

    // Out: a child of a posted sale cannot be moved to a draft either, which
    // would silently shrink a settled receipt.
    let posted_item = db
        .scalar_string(&format!("SELECT id FROM sale_items WHERE sale_id = '{posted}'"))
        .await;
    let posted_pay = db
        .scalar_string(&format!("SELECT id FROM sale_payments WHERE sale_id = '{posted}'"))
        .await;
    assert!(
        db.try_exec(&format!(
            "UPDATE sale_items SET sale_id = 'draft-sale' WHERE id = '{posted_item}'"
        ))
        .await
        .is_err(),
        "a posted sale must not lose a line"
    );
    assert!(
        db.try_exec(&format!(
            "UPDATE sale_payments SET sale_id = 'draft-sale' WHERE id = '{posted_pay}'"
        ))
        .await
        .is_err(),
        "nor a payment"
    );

    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sale_items WHERE sale_id = '{posted}'")).await,
        1
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_items WHERE sale_id = 'draft-sale'").await,
        1,
        "and the draft gained nothing"
    );
}

/// Draft → draft stays allowed, deliberately: it is the state the posting
/// command builds in, and a draft is invisible to every read model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sale_child_may_still_move_between_drafts() {
    let db = shop().await;
    draft_sale(&db, "draft-a", 9001).await;
    draft_sale(&db, "draft-b", 9002).await;
    db.exec(&sale_item_sql("draft-item", "draft-a")).await;

    db.exec("UPDATE sale_items SET sale_id = 'draft-b' WHERE id = 'draft-item'").await;
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sale_items WHERE sale_id = 'draft-b'").await,
        1
    );

    // Promote, and it is sealed from both sides.
    db.exec(
        "UPDATE sales SET status = 'posted', posted_at = '2026-04-01T10:00:00.000Z'
          WHERE id = 'draft-b'",
    )
    .await;
    assert!(
        db.try_exec("UPDATE sale_items SET sale_id = 'draft-a' WHERE id = 'draft-item'")
            .await
            .is_err()
    );
    assert!(
        db.try_exec("UPDATE sale_items SET quantity = 99 WHERE id = 'draft-item'")
            .await
            .is_err(),
        "and immutable in place"
    );
}

/// The guard is only expressible because `post_sale` now builds a draft and
/// promotes it last. This is that sequence working, end to end, with
/// everything a real sale writes: lines, a stock movement, split tender with
/// change, and the shift it belongs to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn normal_sale_posting_still_works_through_the_draft_sequence() {
    let db = shop().await;
    let lines = vec![
        SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(2).unit_incl(500).build(),
        SaleLineBuilder::new(P_WATER, "Water 1.5L").qty(1).unit_incl(300).build(),
    ];
    let total = lines_total(&lines);
    assert_eq!(total, 1_300);
    let payload = sale_payload(lines, vec![cash_usd(1_500)]);
    let sale_id = payload.sale_id.clone();
    let result = post_sale_with_pool(db.pool(), payload).await.expect("post");

    assert_eq!(result.change_total_usd_cents, 200);
    assert_eq!(result.movement_ids.len(), 2);

    // The committed row is POSTED, with a posted_at, and every child is there.
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM sales WHERE id = '{sale_id}'")).await,
        "posted"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM sales WHERE id = '{sale_id}' AND posted_at IS NOT NULL"
        ))
        .await,
        1
    );
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sale_items WHERE sale_id = '{sale_id}'")).await,
        2
    );
    assert_eq!(
        db.count(&format!("SELECT COUNT(*) FROM sale_payments WHERE sale_id = '{sale_id}'")).await,
        1
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 98);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 49);
    // And no draft is left anywhere.
    assert_eq!(db.count("SELECT COUNT(*) FROM sales WHERE status = 'draft'").await, 0);
}

/// A sale that FAILS leaves no draft behind either — the draft is a phase of a
/// transaction, not a persisted state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_sale_leaves_no_draft_and_no_receipt_number() {
    let db = shop().await;
    let lines = vec![SaleLineBuilder::new(P_COFFEE, "Coffee 250g").qty(500).unit_incl(500).build()];
    let total = lines_total(&lines);
    let err = post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(total)]))
        .await
        .expect_err("500 is more than the 100 on hand");
    assert!(err.contains("insufficient stock"), "got: {err}");

    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 0, "no draft, no sale");
    assert_eq!(
        db.scalar_string("SELECT value FROM app_settings WHERE key = 'next_receipt_number'").await,
        "1",
        "and no receipt number consumed"
    );
}

// ============================================================================
// 4. A posted purchase takes no further lines, and cannot be reparented
// ============================================================================

async fn posted_purchase(db: &TempDb) -> String {
    let payload = purchase_payload(
        "normal",
        Some(SUPPLIER),
        vec![PurchaseLineBuilder::new(P_COFFEE, "Coffee 250g")
            .qty(10)
            .unit_cost_excl(200)
            .build()],
    );
    let id = payload.purchase_id.clone();
    post_purchase_with_pool(db.pool(), payload).await.expect("the fixture purchase must post");
    id
}

fn purchase_item_sql(id: &str, purchase_id: &str) -> String {
    format!(
        "INSERT INTO purchase_items (
           id, purchase_id, store_id, product_id, product_name_snapshot,
           uom_code_snapshot, factor_num_snapshot, factor_den_snapshot,
           quantity_in_uom, quantity_base,
           unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
           unit_cost_excl_vat_base_cents, unit_cost_incl_vat_base_cents,
           unit_cost_excl_vat_base_microcents, unit_cost_incl_vat_base_microcents,
           vat_rate_id_snapshot, vat_rate_bps_snapshot,
           line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
         ) VALUES ('{id}', '{purchase_id}', '{STORE_ID}', '{P_COFFEE}', 'Coffee 250g',
                   'each', 1, 1, 1, 1, 200, 222, 200, 222, 200000000, 222000000,
                   '{VAT_STD_ID}', 1100, 200, 22, 222)"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_posted_purchase_cannot_gain_or_lose_a_line() {
    let db = shop().await;
    let purchase = posted_purchase(&db).await;
    let payable_before = supplier_balance(&db, SUPPLIER).await;

    // A smuggled line is worse than its sales counterpart: the payable this
    // purchase raised is the SUM of its lines (WP-05) and the supplier-ledger
    // row that recorded it is immutable, so the purchase and the debt it
    // raised would disagree permanently, with no row anybody can correct.
    let err = db
        .try_exec(&purchase_item_sql("smuggled", &purchase))
        .await
        .expect_err("a posted purchase must not take another line");
    assert!(err.to_string().contains("posted purchase"), "got: {err}");

    let item = db
        .scalar_string(&format!(
            "SELECT id FROM purchase_items WHERE purchase_id = '{purchase}'"
        ))
        .await;
    assert!(
        db.try_exec(&format!("DELETE FROM purchase_items WHERE id = '{item}'"))
            .await
            .is_err(),
        "nor lose one"
    );
    assert!(
        db.try_exec(&format!(
            "UPDATE purchase_items SET quantity_base = 99 WHERE id = '{item}'"
        ))
        .await
        .is_err(),
        "nor have one rewritten"
    );

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM purchase_items WHERE purchase_id = '{purchase}'"
        ))
        .await,
        1
    );
    assert_eq!(
        supplier_balance(&db, SUPPLIER).await,
        payable_before,
        "and the payable still matches the bill"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purchase_line_cannot_be_reparented_into_or_out_of_a_posted_purchase() {
    let db = shop().await;
    let posted = posted_purchase(&db).await;
    db.exec(&format!(
        "INSERT INTO purchases (
           id, store_id, supplier_id, purchase_type, purchase_number, purchase_date,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents, status
         ) VALUES ('draft-pur', '{STORE_ID}', '{SUPPLIER}', 'normal', 9001, '2026-04-01',
                   200, 22, 222, 'draft')"
    ))
    .await;
    db.exec(&purchase_item_sql("draft-item", "draft-pur")).await;

    let err = db
        .try_exec(&format!(
            "UPDATE purchase_items SET purchase_id = '{posted}' WHERE id = 'draft-item'"
        ))
        .await
        .expect_err("a posted purchase must not grow a line by reparenting");
    assert!(err.to_string().contains("posted purchase"), "got: {err}");

    let posted_item = db
        .scalar_string(&format!(
            "SELECT id FROM purchase_items WHERE purchase_id = '{posted}'"
        ))
        .await;
    assert!(
        db.try_exec(&format!(
            "UPDATE purchase_items SET purchase_id = 'draft-pur' WHERE id = '{posted_item}'"
        ))
        .await
        .is_err(),
        "nor lose one that way"
    );

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM purchase_items WHERE purchase_id = '{posted}'"
        ))
        .await,
        1
    );
}

/// `post_purchase` links each line to the movement it created, while the
/// purchase is still a draft. The symmetric guard must leave that alone — and
/// the whole command must still post.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn normal_purchase_posting_still_links_its_lines_to_their_movements() {
    let db = shop().await;
    let purchase = posted_purchase(&db).await;

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM purchase_items
              WHERE purchase_id = '{purchase}' AND related_movement_id IS NOT NULL"
        ))
        .await,
        1,
        "the line→movement link UPDATE ran while the purchase was a draft"
    );
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 110);
    assert_eq!(
        db.scalar_string(&format!("SELECT status FROM purchases WHERE id = '{purchase}'")).await,
        "posted"
    );
}

/// The supplier ledger needed NOTHING from WP-07, and this says why: it was
/// already append-only in both directions, while a legitimate signed
/// adjustment is an INSERT and still works.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_supplier_ledger_stays_append_only_and_still_takes_adjustments() {
    let db = shop().await;
    let purchase = posted_purchase(&db).await;
    let liability = db
        .scalar_string(&format!(
            "SELECT id FROM supplier_ledger WHERE related_purchase_id = '{purchase}'"
        ))
        .await;

    // The liability can be neither modified nor detached nor deleted.
    assert!(
        db.try_exec(&format!(
            "UPDATE supplier_ledger SET amount_cents = 1 WHERE id = '{liability}'"
        ))
        .await
        .is_err()
    );
    assert!(
        db.try_exec(&format!(
            "UPDATE supplier_ledger SET related_purchase_id = NULL WHERE id = '{liability}'"
        ))
        .await
        .is_err(),
        "a liability cannot be detached from the purchase that raised it"
    );
    assert!(
        db.try_exec(&format!("DELETE FROM supplier_ledger WHERE id = '{liability}'"))
            .await
            .is_err()
    );

    // But the two deliberately bidirectional instruments still post — WP-05's
    // sign discipline is a BEFORE INSERT trigger, so an insert is all they need.
    let before = supplier_balance(&db, SUPPLIER).await;
    db.exec(&format!(
        "INSERT INTO supplier_ledger (
           id, store_id, supplier_id, entry_type, amount_cents, entry_date, notes
         ) VALUES ('adj-down', '{STORE_ID}', '{SUPPLIER}', 'adjustment', -500, '2026-04-01',
                   'agreed write-down')"
    ))
    .await;
    db.exec(&format!(
        "INSERT INTO supplier_ledger (
           id, store_id, supplier_id, entry_type, amount_cents, entry_date, notes
         ) VALUES ('adj-up', '{STORE_ID}', '{SUPPLIER}', 'adjustment', 300, '2026-04-01',
                   'missed freight')"
    ))
    .await;
    assert_eq!(supplier_balance(&db, SUPPLIER).await, before - 500 + 300);
}

// ============================================================================
// 5. SQLite / runtime
// ============================================================================

/// The one canonical Greaz database name, asserted in the one place both sides
/// of the application agree on it.
///
/// `src/db/client.ts` opens `sqlite:greaz-pos.db` and `posting.rs` joins
/// `PRODUCTION_DB_FILENAME` onto the same directory the plugin resolves
/// against. The old `lira-pos.db` name must appear nowhere in production code.
#[test]
fn the_production_database_has_one_canonical_name() {
    assert_eq!(crate::posting::PRODUCTION_DB_FILENAME, PRODUCTION_DB_FILENAME);
    assert_eq!(PRODUCTION_DB_FILENAME, "greaz-pos.db");

    // The TypeScript side names it too, and drift there would split the app in
    // half just as surely as a mismatched directory would.
    let client_ts = include_str!("../../../src/db/client.ts");
    assert!(
        client_ts.contains("sqlite:greaz-pos.db"),
        "src/db/client.ts must open the canonical database"
    );
    assert!(
        !client_ts.contains("lira-pos.db"),
        "the pre-rename database name must not survive anywhere in production code"
    );
}

/// A migration that fails leaves the schema as it was — no half-upgraded
/// database. sqlx runs each migration in its own transaction (`no_tx = false`,
/// which is how tauri-plugin-sql resolves them), and SQLite DDL is
/// transactional, so this is a guarantee rather than a hope. Worth pinning,
/// because "the app will not open" is a recoverable morning and "the app opens
/// onto half a schema" is not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_migration_rolls_back_and_leaves_the_schema_untouched() {
    let db = TempDb::new().await;
    let schema_sql = "SELECT COALESCE(GROUP_CONCAT(sql, ';'), '') FROM \
                      (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name)";
    let before = db.scalar_string(schema_sql).await;
    let version_before = db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await;

    // A migration whose first statement succeeds and whose second cannot.
    let err = migrator_with_extra_migration(
        9_999,
        "deliberately_broken",
        "CREATE TABLE wp07_probe (id TEXT PRIMARY KEY);
         INSERT INTO wp07_probe (id) SELECT 'x' FROM no_such_table;",
    )
    .run(db.pool())
    .await
    .expect_err("the broken migration must fail");
    let _ = err;

    assert_eq!(
        db.scalar_string(schema_sql).await,
        before,
        "a failed migration must leave the schema byte for byte as it was"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM sqlite_master WHERE name = 'wp07_probe'").await,
        0,
        "including the table its first statement created"
    );
    assert_eq!(
        db.scalar_i64("SELECT MAX(version) FROM _sqlx_migrations").await,
        version_before,
        "and must not record itself as applied"
    );

    // The database is still usable: the real migrator still reports it current.
    db.migrate_again().await.expect("the database is undamaged");
}

// ============================================================================
// 6. One document, one negative-stock decision per product
// ============================================================================
//
// The correction pass. Section 1 moved the adjustment's quantities onto the
// database's own conversion, but left the negative-stock policy where WP-02 put
// it: per line, against `quantity_on_hand` as read for that line. Nothing is
// written until both passes are done, so every line of the same product reads
// the SAME opening quantity — and two lines of −6 against an opening 10 each
// saw 10, each computed a resulting 4, and each passed. The document committed
// a final quantity of −2 under a rule that forbids negative stock.
//
// Reachable, not theoretical: the Inventory screen appends a line per pick with
// no merge, so a manager counting the same item twice produces exactly this.

/// A — THE defect. Two lines of −6 against 10 on hand nets −2, and is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_lines_of_the_same_product_are_judged_on_their_net_effect() {
    let db = shop().await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 10 WHERE id = '{P_COFFEE}'"
    ))
    .await;

    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "counted the same shelf twice",
            vec![adjustment_line(P_COFFEE, -6), adjustment_line(P_COFFEE, -6)],
        ),
    )
    .await
    .expect_err("10 - 6 - 6 is negative, however the lines are split");
    assert!(err.contains("drive stock negative"), "got: {err}");
    // The message names the net figure, not a single line's, so the manager can
    // see why two individually-plausible lines were refused together.
    assert!(err.contains("-12"), "the net change is reported: {err}");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10, "untouched");
    assert_eq!(movement_count(&db).await, 0, "and nothing was written");
}

/// B — the same two lines against enough stock post, and land on exactly zero.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_lines_that_net_to_zero_stock_post() {
    let db = shop().await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 12 WHERE id = '{P_COFFEE}'"
    ))
    .await;

    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "counted the same shelf twice",
            vec![adjustment_line(P_COFFEE, -6), adjustment_line(P_COFFEE, -6)],
        ),
    )
    .await
    .expect("12 - 6 - 6 is exactly zero, which is allowed");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 0);
    assert_eq!(
        movement_count(&db).await,
        2,
        "each line still records its own movement — the trail is what was entered"
    );
    assert_eq!(
        movement_sum(&db, P_COFFEE).await,
        -12,
        "and the movements sum to the net delta that was validated"
    );
}

/// C — duplicate lines in DIFFERENT units aggregate on their derived base
/// quantities, not on the figures the manager typed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_lines_in_different_uoms_aggregate_in_base_units() {
    let db = shop().await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 20 WHERE id = '{P_COFFEE}'"
    ))
    .await;

    // "one box" and "ten each" read as 1 and 10, but are 12 and 10 in base
    // units — 22 against 20 on hand.
    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "write-off",
            vec![
                adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -1),
                adjustment_line(P_COFFEE, -10),
            ],
        ),
    )
    .await
    .expect_err("12 + 10 base units is more than 20");
    assert!(err.contains("drive stock negative"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 20);

    // One fewer, and the same shape posts: 12 + 8 = 20, to exactly zero.
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "write-off",
            vec![
                adjustment_line_in_uom(P_COFFEE, "box", 12, 1, -1),
                adjustment_line(P_COFFEE, -8),
            ],
        ),
    )
    .await
    .expect("12 + 8 is exactly the 20 on hand");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 0);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -20);
}

/// D — a positive and a negative line of one product net, in both directions:
/// a document may dip below zero *within itself* as long as its net effect does
/// not, because the lines commit together and no intermediate state is ever
/// observable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn positive_and_negative_lines_of_one_product_net_out() {
    let db = shop().await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 5 WHERE id = '{P_COFFEE}'"
    ))
    .await;

    // −8 then +6 would be −3 if the lines were judged in order. The net is −2,
    // and 5 − 2 = 3, so it posts.
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "found two in the back",
            vec![adjustment_line(P_COFFEE, -8), adjustment_line(P_COFFEE, 6)],
        ),
    )
    .await
    .expect("the net of a document is what the policy judges");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 3);
    assert_eq!(movement_sum(&db, P_COFFEE).await, -2);
    assert_eq!(movement_count(&db).await, 2);

    // And a net that IS negative is still refused, however it is composed.
    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "recount",
            vec![adjustment_line(P_COFFEE, 2), adjustment_line(P_COFFEE, -6)],
        ),
    )
    .await
    .expect_err("3 + 2 - 6 is negative");
    assert!(err.contains("drive stock negative"), "got: {err}");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 3);
}

/// E — aggregation is PER PRODUCT. One product's headroom never pays for
/// another's shortfall, and a refusal names the product at fault.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn products_are_aggregated_independently_of_each_other() {
    let db = shop().await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 10 WHERE id = '{P_COFFEE}'"
    ))
    .await;
    db.exec(&format!(
        "UPDATE products SET quantity_on_hand = 2 WHERE id = '{P_WATER}'"
    ))
    .await;

    // Coffee has plenty of room; water does not. Summing the document as a
    // whole (+90 of coffee against −4 of water) would pass it.
    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "mixed recount",
            vec![
                adjustment_line(P_COFFEE, 90),
                adjustment_line(P_WATER, -2),
                adjustment_line(P_WATER, -2),
            ],
        ),
    )
    .await
    .expect_err("water's net of -4 against 2 on hand is refused on its own");
    assert!(err.contains(P_WATER), "the product at fault is named: {err}");

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 10, "all or nothing");
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 2);
    assert_eq!(movement_count(&db).await, 0);

    // Each product within its own means, and the whole document posts.
    post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "mixed recount",
            vec![
                adjustment_line(P_COFFEE, 90),
                adjustment_line(P_WATER, -1),
                adjustment_line(P_WATER, -1),
            ],
        ),
    )
    .await
    .expect("every product's net is within its own stock");
    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100);
    assert_eq!(quantity_on_hand(&db, P_WATER).await, 0);
    assert_eq!(movement_count(&db).await, 3);
}

/// F — a net that overflows i64 is refused, and leaves nothing behind.
///
/// The aggregation accumulates with `checked_add`. Two lines near `i64::MAX`
/// each pass their own per-line range check, so the sum is the only place the
/// overflow can be caught.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_net_that_overflows_is_refused_atomically() {
    let db = shop().await;
    let huge = i64::MAX / 2 + 10;

    let err = post_adjustment_with_pool(
        db.pool(),
        adjustment_payload(
            "absurd",
            vec![adjustment_line(P_COFFEE, huge), adjustment_line(P_COFFEE, huge)],
        ),
    )
    .await
    .expect_err("two half-i64 lines cannot be summed");
    assert!(
        err.contains("overflow") || err.contains("too large") || err.contains("out of range"),
        "got: {err}"
    );

    assert_eq!(quantity_on_hand(&db, P_COFFEE).await, 100, "untouched");
    assert_eq!(movement_count(&db).await, 0);
}
