// Layer B — pure Rust unit tests. No database.

use crate::cost::new_weighted_avg;
use crate::posting::{
    add_vat, derive_base_quantity, derive_purchase_line_amounts, derive_unit_cost_pair,
    lbp_to_usd_cents, ledger_direction, prepare_purchase, prepare_sale, resolve_ledger_amount,
    strip_vat as strip_vat_cents, usd_cents_to_lbp, validate_adjustment_payload,
    validate_close_shift_payload,
    validate_open_shift_payload, validate_purchase_payload, validate_supplier_payment_payload,
    CloseShiftPayload, LedgerDirection, OpenShiftPayload, VatPricingMode,
};
use crate::test_support::{
    RATE_LBP_PER_USD, STORE_ID, USER_ID, VAT_EXEMPT_BPS, VAT_EXEMPT_ID, VAT_STD_BPS, VAT_STD_ID,
};
use crate::tests::builders::*;

// ============================================================================
// new_weighted_avg — the COGS engine behind every purchase post.
// ============================================================================

#[test]
fn weighted_avg_from_empty_stock_takes_the_new_cost() {
    // No stock, no history: the first purchase defines the average outright.
    assert_eq!(new_weighted_avg(0, 0, 100, 250).unwrap(), 250);
}

#[test]
fn weighted_avg_blends_proportionally() {
    // 100 @ $1.00 + 100 @ $2.00 → $1.50
    assert_eq!(new_weighted_avg(100, 100, 100, 200).unwrap(), 150);
    // 300 @ $1.00 + 100 @ $2.00 → $1.25
    assert_eq!(new_weighted_avg(300, 100, 100, 200).unwrap(), 125);
}

#[test]
fn weighted_avg_is_idempotent_at_an_unchanged_cost() {
    // Restocking at the current average must not move the average.
    assert_eq!(new_weighted_avg(40, 733, 60, 733).unwrap(), 733);
}

#[test]
fn weighted_avg_rounds_half_away_from_zero() {
    // 1 @ 100 + 1 @ 101 → 100.5 → 101
    assert_eq!(new_weighted_avg(1, 100, 1, 101).unwrap(), 101);
    // Negative side (a credit-valued average) rounds away from zero too.
    assert_eq!(new_weighted_avg(1, -100, 1, -101).unwrap(), -101);
}

#[test]
fn weighted_avg_handles_large_realistic_values() {
    // 50,000 units at $200.00 plus 10,000 at $250.00 → $208.34 (rounded).
    let got = new_weighted_avg(50_000, 20_000, 10_000, 25_000).unwrap();
    assert_eq!(got, 20_833);
}

#[test]
fn weighted_avg_rejects_non_positive_total_quantity() {
    assert!(new_weighted_avg(0, 100, 0, 100).is_err());
    assert!(new_weighted_avg(10, 100, -10, 100).is_err());
}

#[test]
fn weighted_avg_rejects_overflow() {
    // 2 × i64::MAX cannot be represented, so the value accumulator must bail.
    assert!(new_weighted_avg(2, i64::MAX, 1, 1).is_err());
    assert!(new_weighted_avg(1, 1, 2, i64::MAX).is_err());
}

// ============================================================================
// prepare_sale — the pure prelude the Tauri command runs before any DB work.
// ============================================================================

fn one_line_sale() -> Vec<crate::posting::PostSaleLine> {
    vec![SaleLineBuilder::new("p1", "Coffee").qty(2).unit_incl(500).build()]
}

#[test]
fn prepare_sale_totals_reconcile_and_are_summed_from_lines() {
    let lines = one_line_sale();
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);

    let prep = prepare_sale(&payload).expect("valid sale");

    // 2 × $5.00 incl VAT, 11% → excl 450/unit, so 900 + 100 = 1000.
    assert_eq!(prep.total, 1000);
    assert_eq!(prep.subtotal, 900);
    assert_eq!(prep.vat_total, 100);
    assert_eq!(
        prep.subtotal + prep.vat_total,
        prep.total,
        "subtotal + VAT must equal total"
    );
    assert_eq!(prep.change_total_usd, 0);
    assert_eq!(prep.change_row_index, None);
}

#[test]
fn prepare_sale_reconciles_mixed_vat_at_transaction_level() {
    let taxable = SaleLineBuilder::new("p1", "Coffee").qty(1).unit_incl(555).build();
    let exempt = SaleLineBuilder::new("p2", "Bread")
        .vat(VAT_EXEMPT_ID, 0)
        .qty(3)
        .unit_incl(200)
        .build();

    assert_eq!(exempt.line_vat_cents, 0, "an exempt line carries no VAT");

    let lines = vec![taxable, exempt];
    let total = lines_total(&lines);
    let payload = sale_payload(lines, vec![cash_usd(total)]);
    let prep = prepare_sale(&payload).unwrap();

    assert_eq!(prep.total, 555 + 600);
    assert_eq!(prep.subtotal + prep.vat_total, prep.total);
}

#[test]
fn prepare_sale_computes_change_and_routes_it_to_cash_usd_first() {
    let lines = one_line_sale(); // 1000
    let payload = sale_payload(
        lines,
        vec![card_usd(200), cash_usd(1000)], // overpaid by 200
    );
    let prep = prepare_sale(&payload).unwrap();

    assert_eq!(prep.change_total_usd, 200);
    // Preference order is cash_usd → cash_lbp → first row; index 1 is the cash.
    assert_eq!(prep.change_row_index, Some(1));
}

#[test]
fn prepare_sale_routes_change_to_cash_lbp_when_no_usd_cash() {
    let lines = one_line_sale(); // 1000
    let payload = sale_payload(lines, vec![card_usd(100), cash_lbp(1_000_000)]);
    let prep = prepare_sale(&payload).unwrap();

    assert!(prep.change_total_usd > 0);
    assert_eq!(prep.change_row_index, Some(1));
}

#[test]
fn prepare_sale_accepts_exact_payment_with_zero_change() {
    let lines = one_line_sale();
    let total = lines_total(&lines);
    let prep = prepare_sale(&sale_payload(lines, vec![cash_usd(total)])).unwrap();
    assert_eq!(prep.change_total_usd, 0);
}

#[test]
fn prepare_sale_rejects_underpayment() {
    let lines = one_line_sale(); // 1000
    let err = prepare_sale(&sale_payload(lines, vec![cash_usd(999)])).unwrap_err();
    assert!(err.contains("Underpayment"), "got: {err}");
}

#[test]
fn prepare_sale_rejects_structurally_invalid_payloads() {
    let total = lines_total(&one_line_sale());

    // No lines.
    assert!(prepare_sale(&sale_payload(vec![], vec![cash_usd(100)])).is_err());
    // No payments.
    assert!(prepare_sale(&sale_payload(one_line_sale(), vec![])).is_err());

    // Non-positive quantity.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.lines[0].quantity_in_uom = 0;
    assert!(prepare_sale(&p).unwrap_err().contains("non-positive quantity"));

    // Invalid UoM factor.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.lines[0].factor_den_snapshot = 0;
    assert!(prepare_sale(&p).unwrap_err().contains("invalid UoM factor"));

    // Negative price.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.lines[0].unit_price_excl_vat_cents = -1;
    assert!(prepare_sale(&p).unwrap_err().contains("negative price"));

    // Non-positive exchange rate.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.exchange_rate_lbp_per_usd = 0;
    assert!(prepare_sale(&p).unwrap_err().contains("Exchange rate"));

    // Unknown COGS method.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.cogs_method = "fifo".to_string();
    assert!(prepare_sale(&p).unwrap_err().contains("Invalid COGS method"));

    // Negative discount.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.discount_cents = -1;
    assert!(prepare_sale(&p).unwrap_err().contains("non-negative"));
}

#[test]
fn prepare_sale_rejects_invalid_tenders() {
    let total = lines_total(&one_line_sale());

    // Unknown method.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.payments[0].method = "crypto".to_string();
    assert!(prepare_sale(&p).unwrap_err().contains("invalid method"));

    // Unknown currency.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.payments[0].currency = "EUR".to_string();
    assert!(prepare_sale(&p).unwrap_err().contains("invalid currency"));

    // Zero-value tender.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.payments[0].amount_usd_cents_equivalent = 0;
    assert!(prepare_sale(&p).unwrap_err().contains("non-positive amount"));

    // A method whose name names a currency must be declared in that currency.
    // `cash_usd` tendered "in LBP" is not a tender anyone took (WP-04).
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.payments[0].currency = "LBP".to_string();
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("is a USD tender"), "got: {err}");

    // For a method that may be either currency, the native amount still has to
    // be the one that currency is denominated in.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.payments[0].method = "bank_transfer".to_string();
    p.payments[0].currency = "LBP".to_string();
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("inconsistent"), "got: {err}");
}

// ============================================================================
// Tender authority — the USD equivalent is derived, never declared (WP-04)
// ============================================================================

#[test]
fn a_usd_tender_must_declare_itself_as_its_own_usd_equivalent() {
    let total = lines_total(&one_line_sale());

    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    // $10.00 of cash claiming to be worth $12.00.
    p.payments[0].amount_usd_cents_equivalent = total + 200;
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("declared USD equivalent"), "got: {err}");
}

#[test]
fn an_lbp_tender_must_declare_the_locked_rate_equivalent() {
    let lines = one_line_sale();
    let total = lines_total(&lines);
    // Enough lira to cover the bill at the locked rate.
    let lbp = total as i64 * RATE_LBP_PER_USD / 100 + RATE_LBP_PER_USD;

    // The honest conversion posts.
    let p = sale_payload(one_line_sale(), vec![cash_lbp(lbp)]);
    assert!(prepare_sale(&p).is_ok());

    // One cent off the locked-rate conversion is refused: that cent is the
    // difference between the drawer reconciling and not.
    let mut p = sale_payload(one_line_sale(), vec![cash_lbp(lbp)]);
    p.payments[0].amount_usd_cents_equivalent += 1;
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("locked rate"), "got: {err}");

    // So is a figure computed at some other rate entirely — the shape a client
    // reading today's rate instead of the sale's locked one would produce.
    let mut p = sale_payload(one_line_sale(), vec![cash_lbp(lbp)]);
    p.payments[0].amount_usd_cents_equivalent =
        lbp_to_usd_cents(lbp, RATE_LBP_PER_USD * 2).unwrap();
    assert!(prepare_sale(&p).unwrap_err().contains("locked rate"));
}

#[test]
fn lbp_to_usd_cents_rounds_half_away_from_zero_in_integers() {
    // Exact multiples convert exactly, in both directions.
    assert_eq!(lbp_to_usd_cents(89_500, 89_500).unwrap(), 100);
    assert_eq!(usd_cents_to_lbp(100, 89_500).unwrap(), 89_500);
    assert_eq!(lbp_to_usd_cents(895_000, 89_500).unwrap(), 1000);

    // A rate of 200 lira per dollar makes the half-cent boundary expressible:
    // 1 lira is half a cent, so it rounds UP to one cent, not down to zero.
    assert_eq!(lbp_to_usd_cents(1, 200).unwrap(), 1);
    assert_eq!(lbp_to_usd_cents(3, 200).unwrap(), 2); // 1.5 cents -> 2
    assert_eq!(lbp_to_usd_cents(5, 200).unwrap(), 3); // 2.5 cents -> 3

    // Sub-half rounds down, and a tender too small to be worth a cent is zero —
    // which `prepare_sale` then rejects as a non-positive amount rather than
    // silently accepting free goods.
    assert_eq!(lbp_to_usd_cents(2, 1000).unwrap(), 0);

    // A lira amount large enough to overflow an i64 product is caught, not
    // wrapped: the multiplication runs in i128.
    assert!(lbp_to_usd_cents(i64::MAX, 89_500).is_ok());
    assert!(usd_cents_to_lbp(i64::MAX, 89_500).is_err());

    // Invalid rates are refused rather than dividing by zero.
    assert!(lbp_to_usd_cents(1000, 0).is_err());
    assert!(usd_cents_to_lbp(1000, -1).is_err());
}

// ============================================================================
// Change is a cash movement (WP-04, GZ-HI-04)
// ============================================================================

#[test]
fn change_is_attached_to_the_first_cash_row_in_preference_order() {
    let lines = one_line_sale();
    let total = lines_total(&lines);

    // Card first in the list, cash second: the cash row still takes the change.
    let p = sale_payload(one_line_sale(), vec![card_usd(total - 100), cash_usd(300)]);
    let prepared = prepare_sale(&p).unwrap();
    assert_eq!(prepared.change_total_usd, 200);
    assert_eq!(prepared.change_row_index, Some(1));

    // USD cash outranks LBP cash, whatever order they arrive in.
    let lbp = 2 * RATE_LBP_PER_USD; // $2.00 of lira
    let p = sale_payload(one_line_sale(), vec![cash_lbp(lbp), cash_usd(total)]);
    let prepared = prepare_sale(&p).unwrap();
    assert_eq!(prepared.change_row_index, Some(1), "the USD cash row takes the change");
}

#[test]
fn no_change_means_no_row_absorbs_any() {
    let p = sale_payload(one_line_sale(), vec![cash_usd(lines_total(&one_line_sale()))]);
    let prepared = prepare_sale(&p).unwrap();
    assert_eq!(prepared.change_total_usd, 0);
    assert_eq!(prepared.change_row_index, None);
}

#[test]
fn a_non_cash_tender_can_never_be_over_collected() {
    let total = lines_total(&one_line_sale());

    // Card-only overpayment. Previously this wrote the surplus to
    // `change_given_usd_cents` ON THE CARD ROW, and shift close then subtracted
    // it from expected physical cash — the till looked short by money that never
    // left it. There is no cash refund to give, so the sale is refused.
    for over in [card_usd(total + 1), card_usd(total + 5_000)] {
        let p = sale_payload(one_line_sale(), vec![over]);
        let err = prepare_sale(&p).unwrap_err();
        assert!(
            err.contains("Non-cash tender"),
            "a card swiped for more than the bill must be refused, got: {err}"
        );
    }

    // The same rule for the other non-cash methods, and for a card in lira.
    let mut transfer = card_usd(total + 100);
    transfer.method = "bank_transfer".to_string();
    assert!(prepare_sale(&sale_payload(one_line_sale(), vec![transfer]))
        .unwrap_err()
        .contains("Non-cash tender"));
    let over_lbp = (total as i64 + 100) * RATE_LBP_PER_USD / 100;
    assert!(prepare_sale(&sale_payload(one_line_sale(), vec![card_lbp(over_lbp)]))
        .unwrap_err()
        .contains("Non-cash tender"));

    // Mixed tender where the CARD is the part that overpays: cash covers $3.00
    // of a $10.00 bill and the card is swiped for $10.50. The surplus belongs to
    // the card, not to the till, so the sale is refused.
    let p = sale_payload(one_line_sale(), vec![cash_usd(300), card_usd(total + 50)]);
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("Non-cash tender"), "got: {err}");

    // Exact to the cent is fine, and produces no change at all.
    let p = sale_payload(one_line_sale(), vec![card_usd(total)]);
    let prepared = prepare_sale(&p).unwrap();
    assert_eq!(prepared.change_total_usd, 0);
    assert_eq!(prepared.change_row_index, None);

    // And a card settling part of the bill, with cash covering the rest and
    // overpaying, is a legitimate split tender: the change comes off the cash.
    let p = sale_payload(one_line_sale(), vec![card_usd(total - 400), cash_usd(600)]);
    let prepared = prepare_sale(&p).unwrap();
    assert_eq!(prepared.change_total_usd, 200);
    assert_eq!(prepared.change_row_index, Some(1));

    // The boundary case the rule deliberately ALLOWS: cash is handed over,
    // then the card is swiped for the whole bill and the cash goes straight
    // back ("actually, put it all on the card"). The card is charged exactly
    // what is owed, and the change is the same cash that came in, so the drawer
    // nets to zero. Nothing is invented — both movements really happened —
    // which is precisely why the rule is "non-cash may not exceed the amount
    // due" and not "the tender must equal the amount due".
    let p = sale_payload(one_line_sale(), vec![cash_usd(300), card_usd(total)]);
    let prepared = prepare_sale(&p).unwrap();
    assert_eq!(prepared.change_total_usd, 300);
    assert_eq!(prepared.change_row_index, Some(0), "the cash row gives back the cash");
}

#[test]
fn prepare_sale_accepts_both_documented_cogs_methods() {
    for method in ["weighted_average", "last_purchase"] {
        let lines = one_line_sale();
        let total = lines_total(&lines);
        let mut p = sale_payload(lines, vec![cash_usd(total)]);
        p.cogs_method = method.to_string();
        assert_eq!(prepare_sale(&p).unwrap().cogs_method, method);
    }
}

// ============================================================================
// The other three commands' pure validators.
// ============================================================================

#[test]
fn purchase_validation_covers_type_supplier_and_lines() {
    let line = || PurchaseLineBuilder::new("p1", "Coffee").qty(5).unit_cost_excl(200).build();

    assert!(validate_purchase_payload(&purchase_payload("normal", Some("s1"), vec![line()])).is_ok());
    assert!(validate_purchase_payload(&purchase_payload("opening", None, vec![line()])).is_ok());

    // Empty lines.
    assert!(validate_purchase_payload(&purchase_payload("normal", Some("s1"), vec![])).is_err());
    // Unknown type.
    assert!(validate_purchase_payload(&purchase_payload("gift", Some("s1"), vec![line()])).is_err());
    // Normal purchase without a supplier.
    let err = validate_purchase_payload(&purchase_payload("normal", None, vec![line()])).unwrap_err();
    assert!(err.contains("requires a supplier"), "got: {err}");

    // Non-positive base quantity.
    let mut p = purchase_payload("normal", Some("s1"), vec![line()]);
    p.lines[0].quantity_base = 0;
    assert!(validate_purchase_payload(&p).unwrap_err().contains("non-positive"));

    // Invalid factor.
    let mut p = purchase_payload("normal", Some("s1"), vec![line()]);
    p.lines[0].factor_num_snapshot = 0;
    assert!(validate_purchase_payload(&p).unwrap_err().contains("invalid UoM factor"));
}

#[test]
fn adjustment_validation_requires_reason_and_non_zero_deltas() {
    assert!(
        validate_adjustment_payload(&adjustment_payload("count", vec![adjustment_line("p1", -3)]))
            .is_ok()
    );
    assert!(validate_adjustment_payload(&adjustment_payload("count", vec![])).is_err());
    assert!(
        validate_adjustment_payload(&adjustment_payload("   ", vec![adjustment_line("p1", 1)]))
            .is_err()
    );
    let err =
        validate_adjustment_payload(&adjustment_payload("count", vec![adjustment_line("p1", 0)]))
            .unwrap_err();
    assert!(err.contains("zero delta"), "got: {err}");
}

#[test]
fn supplier_payment_validation_covers_type_amount_date_and_notes() {
    assert!(validate_supplier_payment_payload(&supplier_payment_payload("s1", "payment", -5000)).is_ok());
    assert!(validate_supplier_payment_payload(&supplier_payment_payload("s1", "refund", -5000)).is_err());
    assert!(validate_supplier_payment_payload(&supplier_payment_payload("s1", "payment", 0)).is_err());

    // An 'adjustment' entry must explain itself.
    let mut p = supplier_payment_payload("s1", "adjustment", 100);
    p.notes = Some("   ".to_string());
    assert!(validate_supplier_payment_payload(&p).unwrap_err().contains("note"));

    let mut p = supplier_payment_payload("s1", "payment", -100);
    p.entry_date = "".to_string();
    assert!(validate_supplier_payment_payload(&p).unwrap_err().contains("date"));
}

// ============================================================================
// VAT decomposition used by the builders mirrors lib/vat.ts.
// ============================================================================

#[test]
fn strip_vat_matches_the_frontend_decomposition() {
    // $111.00 incl at 11% → $100.00 excl.
    assert_eq!(strip_vat(11_100, VAT_STD_BPS), 10_000);
    // Zero-rated input is unchanged.
    assert_eq!(strip_vat(5_000, 0), 5_000);
    // Boundary: one cent.
    assert_eq!(strip_vat(1, VAT_STD_BPS), 1);
    assert_eq!(VAT_STD_ID.len(), 36);
}

// ============================================================================
// WP-02 — line reconciliation, discount reconciliation, base-quantity derivation
// ============================================================================

#[test]
fn prepare_sale_rejects_a_line_whose_parts_do_not_sum() {
    let total = lines_total(&one_line_sale());
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    // 900 + 150 ≠ 1000.
    p.lines[0].line_subtotal_excl_vat_cents = 900;
    p.lines[0].line_vat_cents = 150;
    p.lines[0].line_total_incl_vat_cents = 1000;

    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("does not reconcile"), "got: {err}");
}

#[test]
fn prepare_sale_rejects_vat_charged_at_an_exempt_rate() {
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(1000)]);
    p.lines[0].vat_rate_bps_snapshot = 0; // the line still carries 100¢ of VAT
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("exempt"), "got: {err}");
}

#[test]
fn prepare_sale_rejects_negative_line_money() {
    for mutate in [
        (|l: &mut crate::posting::PostSaleLine| l.line_vat_cents = -1) as fn(&mut _),
        |l: &mut crate::posting::PostSaleLine| l.line_subtotal_excl_vat_cents = -1,
        |l: &mut crate::posting::PostSaleLine| l.line_discount_cents = -1,
        |l: &mut crate::posting::PostSaleLine| l.vat_rate_bps_snapshot = -1,
    ] {
        let mut p = sale_payload(one_line_sale(), vec![cash_usd(1000)]);
        mutate(&mut p.lines[0]);
        assert!(prepare_sale(&p).is_err(), "a negative line amount must be refused");
    }
}

#[test]
fn prepare_sale_accepts_the_registers_own_line_decomposition() {
    // What `lib/discount.ts::postDiscountLineTotals` sends: the excl-VAT part is
    // stripped from the line total, so the parts always sum exactly.
    let total = 1500;
    let subtotal = strip_vat(total, VAT_STD_BPS);
    let line = SaleLineBuilder::new("p1", "Coffee")
        .qty(3)
        .unit_incl(500)
        .raw_line_totals(subtotal, total - subtotal, total)
        .build();
    let prep = prepare_sale(&sale_payload(vec![line], vec![cash_usd(total)])).expect("valid line");
    assert_eq!(prep.total, total);
    assert_eq!(prep.subtotal + prep.vat_total, prep.total);
}

#[test]
fn prepare_sale_requires_line_discounts_to_sum_to_the_header_discount() {
    // Header claims a discount the lines do not carry.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(1000)]);
    p.discount_cents = 100;
    let err = prepare_sale(&p).unwrap_err();
    assert!(err.contains("Discount does not reconcile"), "got: {err}");

    // Lines carry a discount the header does not declare.
    let line = SaleLineBuilder::new("p1", "Coffee").qty(2).unit_incl(500).discount(40).build();
    let err = prepare_sale(&sale_payload(vec![line], vec![cash_usd(1000)])).unwrap_err();
    assert!(err.contains("Discount does not reconcile"), "got: {err}");

    // An exact allocation across several lines is accepted.
    let lines = vec![
        SaleLineBuilder::new("p1", "Coffee").qty(2).unit_incl(500).discount(60).build(),
        SaleLineBuilder::new("p2", "Water").qty(1).unit_incl(700).discount(41).build(),
    ];
    let total = lines_total(&lines);
    let mut p = sale_payload(lines, vec![cash_usd(total)]);
    p.discount_cents = 101;
    assert!(prepare_sale(&p).is_ok(), "an exactly-allocated discount must be accepted");
}

#[test]
fn base_quantity_is_derived_from_the_uom_factor() {
    // 2 boxes of 12 is 24 base units — the GP-A02 case.
    assert_eq!(derive_base_quantity(2, 12, 1).unwrap(), 24);
    // The base UoM itself is the identity.
    assert_eq!(derive_base_quantity(7, 1, 1).unwrap(), 7);
    // 3 kg of a gram-based product.
    assert_eq!(derive_base_quantity(3, 1000, 1).unwrap(), 3_000);
    // Rounds half away from zero, exactly like lib/uom.ts::toBaseQty.
    assert_eq!(derive_base_quantity(3, 1, 2).unwrap(), 2, "1.5 → 2");
    assert_eq!(derive_base_quantity(5, 1, 2).unwrap(), 3, "2.5 → 3");
    assert_eq!(derive_base_quantity(5, 1, 4).unwrap(), 1, "1.25 → 1");
}

#[test]
fn base_quantity_derivation_rejects_nonsense() {
    assert!(derive_base_quantity(0, 12, 1).is_err(), "zero quantity");
    assert!(derive_base_quantity(-1, 12, 1).is_err(), "negative quantity");
    assert!(derive_base_quantity(2, 0, 1).is_err(), "zero numerator");
    assert!(derive_base_quantity(2, 12, 0).is_err(), "zero denominator");
    assert!(derive_base_quantity(i64::MAX, 12, 1).is_err(), "overflow");
    // A conversion that would round away to nothing is not a sale.
    assert!(derive_base_quantity(1, 1, 1000).is_err(), "0.001 → 0");
}

// ============================================================================
// Shift lifecycle validators (WP-04)
// ============================================================================

fn open_payload() -> OpenShiftPayload {
    OpenShiftPayload {
        shift_id: uuid(),
        store_id: STORE_ID.to_string(),
        opened_by_user_id: USER_ID.to_string(),
        device_id: None,
        opening_cash_usd_cents: 10_000,
        opening_cash_lbp: 500_000,
        notes: None,
    }
}

fn close_payload(shift_id: &str) -> CloseShiftPayload {
    CloseShiftPayload {
        shift_id: shift_id.to_string(),
        store_id: STORE_ID.to_string(),
        closed_by_user_id: USER_ID.to_string(),
        closing_cash_usd_cents: 10_000,
        closing_cash_lbp: 500_000,
    }
}

#[test]
fn open_shift_validation_requires_identity_and_non_negative_float() {
    assert!(validate_open_shift_payload(&open_payload()).is_ok());

    // A zero float is a real opening state — an empty till.
    let mut p = open_payload();
    p.opening_cash_usd_cents = 0;
    p.opening_cash_lbp = 0;
    assert!(validate_open_shift_payload(&p).is_ok());

    for (label, mutate) in [
        ("identifier", (|p: &mut OpenShiftPayload| p.shift_id = "  ".to_string()) as fn(&mut OpenShiftPayload)),
        ("store", |p: &mut OpenShiftPayload| p.store_id = String::new()),
        ("user who opened it", |p: &mut OpenShiftPayload| p.opened_by_user_id = String::new()),
    ] {
        let mut p = open_payload();
        mutate(&mut p);
        let err = validate_open_shift_payload(&p).expect_err("must be refused");
        assert!(err.contains(label), "expected {label} in: {err}");
    }

    // Negative cash is not a count anybody took.
    let mut p = open_payload();
    p.opening_cash_usd_cents = -1;
    assert!(validate_open_shift_payload(&p).unwrap_err().contains("negative"));
    let mut p = open_payload();
    p.opening_cash_lbp = -1;
    assert!(validate_open_shift_payload(&p).unwrap_err().contains("negative"));
}

#[test]
fn close_shift_validation_requires_identity_and_non_negative_count() {
    assert!(validate_close_shift_payload(&close_payload("shift-1")).is_ok());

    // An empty till at close is a legitimate count, and the one most likely to
    // show a variance — it must not be mistaken for "no count given".
    let mut p = close_payload("shift-1");
    p.closing_cash_usd_cents = 0;
    p.closing_cash_lbp = 0;
    assert!(validate_close_shift_payload(&p).is_ok());

    let mut p = close_payload("   ");
    assert!(validate_close_shift_payload(&p).unwrap_err().contains("identifier"));
    p = close_payload("shift-1");
    p.store_id = String::new();
    assert!(validate_close_shift_payload(&p).unwrap_err().contains("store"));
    p = close_payload("shift-1");
    p.closed_by_user_id = String::new();
    assert!(validate_close_shift_payload(&p).unwrap_err().contains("user who closed it"));
    p = close_payload("shift-1");
    p.closing_cash_usd_cents = -1;
    assert!(validate_close_shift_payload(&p).unwrap_err().contains("negative"));
    p = close_payload("shift-1");
    p.closing_cash_lbp = -1;
    assert!(validate_close_shift_payload(&p).unwrap_err().contains("negative"));
}

// ============================================================================
// Supplier-ledger sign authority (WP-05 Part A)
//
// `resolve_ledger_amount` is the one place that turns "how much" into "which
// way", so it is worth pinning down on its own, away from any database.
// ============================================================================

#[test]
fn every_schema_entry_type_has_a_direction_and_nothing_else_does() {
    use LedgerDirection::*;

    // Exactly the five types `supplier_ledger.entry_type`'s CHECK allows.
    assert_eq!(ledger_direction("purchase"), Some(Increase));
    assert_eq!(ledger_direction("payment"), Some(Decrease));
    assert_eq!(ledger_direction("credit_note"), Some(Decrease));
    assert_eq!(ledger_direction("opening_balance"), Some(Signed));
    assert_eq!(ledger_direction("adjustment"), Some(Signed));

    for unknown in ["refund", "", "PAYMENT", "write_off"] {
        assert_eq!(ledger_direction(unknown), None, "{unknown:?} is not an entry type");
    }
}

#[test]
fn a_fixed_direction_entry_takes_its_sign_from_its_type_not_from_the_caller() {
    // The magnitude decides how much; the type decides which way. Whichever
    // sign a caller attaches to a payment, the payable goes DOWN.
    for signed in [-5_000_i64, 5_000] {
        assert_eq!(
            resolve_ledger_amount("payment", Some(5_000), signed).unwrap(),
            -5_000
        );
        assert_eq!(
            resolve_ledger_amount("credit_note", Some(5_000), signed).unwrap(),
            -5_000
        );
        assert_eq!(
            resolve_ledger_amount("purchase", Some(5_000), signed).unwrap(),
            5_000
        );
    }

    // And on the legacy contract, where the magnitude is absent, the absolute
    // value supplies it and the sign is still ignored.
    assert_eq!(resolve_ledger_amount("payment", None, -5_000).unwrap(), -5_000);
    assert_eq!(resolve_ledger_amount("payment", None, 5_000).unwrap(), -5_000);
}

#[test]
fn a_bidirectional_entry_takes_its_direction_from_the_signed_amount() {
    assert_eq!(resolve_ledger_amount("adjustment", Some(300), 300).unwrap(), 300);
    assert_eq!(resolve_ledger_amount("adjustment", Some(300), -300).unwrap(), -300);
    assert_eq!(resolve_ledger_amount("opening_balance", None, 900).unwrap(), 900);
    assert_eq!(resolve_ledger_amount("opening_balance", None, -900).unwrap(), -900);

    // With a magnitude but no signed amount there is no direction to take, and
    // picking one would be inventing the instruction.
    let err = resolve_ledger_amount("adjustment", Some(300), 0).unwrap_err();
    assert!(err.contains("bidirectional"), "got: {err}");
}

#[test]
fn a_zero_or_negative_magnitude_is_refused() {
    for entry_type in ["payment", "credit_note", "opening_balance", "adjustment"] {
        let err = resolve_ledger_amount(entry_type, Some(0), -100).unwrap_err();
        assert!(err.contains("positive number of cents"), "{entry_type}: {err}");

        let err = resolve_ledger_amount(entry_type, Some(-100), -100).unwrap_err();
        assert!(err.contains("positive number of cents"), "{entry_type}: {err}");

        // Nothing at all, on either field.
        let err = resolve_ledger_amount(entry_type, None, 0).unwrap_err();
        assert!(err.contains("non-zero"), "{entry_type}: {err}");
    }
}

#[test]
fn the_magnitude_and_the_legacy_amount_must_agree_about_how_much_moved() {
    // Same money, stated twice, in either sign — fine.
    assert!(resolve_ledger_amount("payment", Some(4_000), -4_000).is_ok());
    assert!(resolve_ledger_amount("payment", Some(4_000), 4_000).is_ok());

    // Different money — the request does not know its own amount.
    let err = resolve_ledger_amount("payment", Some(4_000), -5_000).unwrap_err();
    assert!(err.contains("disagrees with itself"), "got: {err}");
}

#[test]
fn an_unknown_entry_type_has_no_resolvable_amount() {
    let err = resolve_ledger_amount("refund", Some(100), -100).unwrap_err();
    assert!(err.contains("Invalid entry_type"), "got: {err}");
}

// ============================================================================
// Purchase line money (WP-05 Part C)
// ============================================================================

#[test]
fn a_purchase_line_amount_is_derived_from_the_invoice_cost_and_the_quantity() {
    // The convention is `lib/purchaseMath.ts::computeLineMath`: extend the
    // per-UoM cost by the quantity in that UoM, and take VAT as the difference.
    let line = PurchaseLineBuilder::new("p1", "Coffee").qty(10).unit_cost_excl(200).build();
    let a = derive_purchase_line_amounts(0, &line).unwrap();
    assert_eq!(a.subtotal_excl_vat_cents, 2_000);
    assert_eq!(a.vat_cents, 220);
    assert_eq!(a.total_incl_vat_cents, 2_220);

    // Free goods are a real invoice line and cost nothing.
    let line = PurchaseLineBuilder::new("p1", "Coffee").qty(10).unit_cost_excl(0).build();
    let a = derive_purchase_line_amounts(0, &line).unwrap();
    assert_eq!(
        (a.subtotal_excl_vat_cents, a.vat_cents, a.total_incl_vat_cents),
        (0, 0, 0)
    );

    // An exempt line carries no VAT.
    let line = PurchaseLineBuilder::new("p1", "Bread")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(3)
        .unit_cost_excl(150)
        .build();
    let a = derive_purchase_line_amounts(0, &line).unwrap();
    assert_eq!((a.subtotal_excl_vat_cents, a.vat_cents, a.total_incl_vat_cents), (450, 0, 450));
}

#[test]
fn a_purchase_line_that_declares_a_total_its_costs_do_not_support_is_refused() {
    // The payable is summed from these figures, so a line that books more debt
    // than it bought goods is refused rather than totalled.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(10).unit_cost_excl(200).build();
    line.line_total_incl_vat_cents = 99_900;
    let err = derive_purchase_line_amounts(0, &line).unwrap_err();
    assert!(err.contains("does not reconcile against its invoice cost"), "got: {err}");

    // The subtotal alone is enough to refuse it.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(10).unit_cost_excl(200).build();
    line.line_subtotal_excl_vat_cents = 1_999;
    assert!(derive_purchase_line_amounts(0, &line).is_err());

    // And so is a VAT amount that does not bridge the two.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(10).unit_cost_excl(200).build();
    line.line_vat_cents = 0;
    assert!(derive_purchase_line_amounts(0, &line).is_err());
}

#[test]
fn a_structurally_impossible_purchase_line_is_refused() {
    // Cheaper with VAT than without it.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build();
    line.unit_cost_incl_vat_in_uom_cents = 100;
    let err = derive_purchase_line_amounts(0, &line).unwrap_err();
    assert!(err.contains("costs less with VAT"), "got: {err}");

    // A negative cost.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build();
    line.unit_cost_excl_vat_in_uom_cents = -1;
    let err = derive_purchase_line_amounts(0, &line).unwrap_err();
    assert!(err.contains("negative unit cost"), "got: {err}");

    // VAT charged at an exempt rate.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build();
    line.vat_rate_bps_snapshot = 0;
    let err = derive_purchase_line_amounts(0, &line).unwrap_err();
    assert!(err.contains("exempt"), "got: {err}");

    // An extension that overflows rather than wrapping into a plausible total.
    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build();
    line.quantity_in_uom = i64::MAX;
    line.unit_cost_excl_vat_in_uom_cents = 2;
    line.unit_cost_incl_vat_in_uom_cents = 2;
    let err = derive_purchase_line_amounts(0, &line).unwrap_err();
    assert!(err.contains("overflows"), "got: {err}");
}

#[test]
fn a_prepared_purchase_header_is_the_sum_of_its_derived_lines() {
    let payload = purchase_payload(
        "normal",
        Some("s1"),
        vec![
            PurchaseLineBuilder::new("p1", "Coffee").qty(10).unit_cost_excl(200).build(),
            PurchaseLineBuilder::new("p2", "Sugar").qty(4).unit_cost_excl(150).build(),
        ],
    );
    let prepared = prepare_purchase(&payload).unwrap();

    assert_eq!(prepared.lines.len(), 2);
    assert_eq!(prepared.subtotal_excl_vat_cents, 2_000 + 600);
    assert_eq!(
        prepared.total_incl_vat_cents,
        prepared.subtotal_excl_vat_cents + prepared.vat_total_cents
    );
    assert_eq!(
        prepared.total_incl_vat_cents,
        prepared.lines.iter().map(|l| l.total_incl_vat_cents).sum::<i64>(),
        "the header is the lines, not a figure of its own"
    );
}

// ============================================================================
// VAT arithmetic, and the one authoritative unit price per purchase line
// ============================================================================

#[test]
fn add_vat_and_strip_vat_mirror_the_frontend_helpers() {
    // The figures `lib/vat.ts` documents on `addVat` and `stripVat` themselves.
    assert_eq!(add_vat(10_000, VAT_STD_BPS).unwrap(), 11_100);
    assert_eq!(strip_vat_cents(11_100, VAT_STD_BPS).unwrap(), 10_000);

    // An exempt rate adds and strips nothing.
    assert_eq!(add_vat(12_345, 0).unwrap(), 12_345);
    assert_eq!(strip_vat_cents(12_345, 0).unwrap(), 12_345);

    // Zero is zero at any rate.
    assert_eq!(add_vat(0, VAT_STD_BPS).unwrap(), 0);
    assert_eq!(strip_vat_cents(0, VAT_STD_BPS).unwrap(), 0);

    // A finer-than-whole-percent rate, since bps exist to express one.
    assert_eq!(add_vat(10_000, 1_050).unwrap(), 11_050);
}

#[test]
fn the_half_cent_vat_boundary_rounds_away_from_zero() {
    // 50 x 11% = 5.5 cents exactly. `Math.round` takes a positive half upward,
    // which is the same half-away-from-zero rule `crate::cost` uses, so the
    // backend must land on 6 and not on 5.
    assert_eq!(add_vat(50, VAT_STD_BPS).unwrap(), 56);
    // 150 x 11% = 16.5 → 17.
    assert_eq!(add_vat(150, VAT_STD_BPS).unwrap(), 167);
    // And the strip side: 550000/11100 = 49.5495 → 50.
    assert_eq!(strip_vat_cents(55, VAT_STD_BPS).unwrap(), 50);
}

#[test]
fn the_integer_vat_helpers_agree_with_the_frontend_decomposition_everywhere() {
    // `builders::strip_vat` is the harness's statement of the client rule and
    // now delegates to the production helper, so this sweeps the whole
    // low-value range where cent rounding actually bites and pins the two
    // together rather than trusting that they look alike.
    for gross in 0..2_000 {
        assert_eq!(
            strip_vat_cents(gross, VAT_STD_BPS).unwrap(),
            strip_vat(gross, VAT_STD_BPS),
            "stripVat disagreed at {gross}"
        );
    }
    // Grossing up and stripping back is NOT an identity at cent precision —
    // that is what rounding means, and it is exactly why the pricing mode has
    // to choose the direction instead of the backend guessing.
    assert_eq!(strip_vat_cents(55, VAT_STD_BPS).unwrap(), 50);
    assert_ne!(add_vat(50, VAT_STD_BPS).unwrap(), 55);
}

#[test]
fn vat_helpers_refuse_negatives_and_overflow_rather_than_wrapping() {
    assert!(add_vat(-1, VAT_STD_BPS).is_err());
    assert!(strip_vat_cents(-1, VAT_STD_BPS).is_err());
    assert!(add_vat(100, -1).is_err());
    assert!(strip_vat_cents(100, -1).is_err());
    assert!(add_vat(i64::MAX, VAT_STD_BPS).is_err(), "must error, not wrap");
}

#[test]
fn an_exclusive_line_derives_its_gross_and_an_inclusive_line_derives_its_net() {
    let excl_line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build();
    let pair = derive_unit_cost_pair(0, &excl_line, VatPricingMode::Exclusive).unwrap();
    assert_eq!(pair.excl_vat_in_uom_cents, 200);
    assert_eq!(pair.incl_vat_in_uom_cents, 222);

    let incl_line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_incl(55).build();
    let pair = derive_unit_cost_pair(0, &incl_line, VatPricingMode::Inclusive).unwrap();
    assert_eq!(pair.incl_vat_in_uom_cents, 55);
    assert_eq!(pair.excl_vat_in_uom_cents, 50);
}

#[test]
fn a_cost_pair_that_is_not_one_price_is_refused() {
    // The release-gate blocker, at the arithmetic: $20.00 net declared with
    // $999.00 gross at 11%.
    let line = PurchaseLineBuilder::new("p1", "Coffee")
        .qty(1)
        .unit_cost_excl(2_000)
        .raw_unit_costs(2_000, 99_900)
        .build();
    let err = derive_unit_cost_pair(0, &line, VatPricingMode::Exclusive).unwrap_err();
    assert!(err.contains("are not one price"), "got: {err}");
    assert!(err.contains("2220"), "the error names the derived gross: {err}");

    // And symmetrically, a gross-quoted line with an invented net.
    let line = PurchaseLineBuilder::new("p1", "Coffee")
        .qty(1)
        .unit_cost_incl(111)
        .raw_unit_costs(20, 111)
        .build();
    let err = derive_unit_cost_pair(0, &line, VatPricingMode::Inclusive).unwrap_err();
    assert!(err.contains("are not one price"), "got: {err}");
}

#[test]
fn the_same_pair_can_be_coherent_in_one_mode_and_incoherent_in_the_other() {
    // (50, 55) at 11%: a real gross-quoted bill, and an impossible net-quoted
    // one, because add_vat(50) is 56. The mode is what decides, which is why it
    // cannot be inferred.
    let line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_incl(55).build();
    assert!(derive_unit_cost_pair(0, &line, VatPricingMode::Inclusive).is_ok());
    assert!(derive_unit_cost_pair(0, &line, VatPricingMode::Exclusive).is_err());
}

#[test]
fn an_exempt_line_must_state_the_same_figure_on_both_sides() {
    let line = PurchaseLineBuilder::new("p1", "Bread")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(1)
        .unit_cost_excl(150)
        .build();
    for mode in [VatPricingMode::Exclusive, VatPricingMode::Inclusive] {
        let pair = derive_unit_cost_pair(0, &line, mode).unwrap();
        assert_eq!(pair.excl_vat_in_uom_cents, 150);
        assert_eq!(pair.incl_vat_in_uom_cents, 150);
    }

    // A gross figure above the net one at 0 bps is VAT charged on an exempt
    // line, whichever way it is read.
    let line = PurchaseLineBuilder::new("p1", "Bread")
        .vat(VAT_EXEMPT_ID, VAT_EXEMPT_BPS)
        .qty(1)
        .unit_cost_excl(150)
        .raw_unit_costs(150, 167)
        .build();
    assert!(derive_unit_cost_pair(0, &line, VatPricingMode::Exclusive).is_err());
    assert!(derive_unit_cost_pair(0, &line, VatPricingMode::Inclusive).is_err());
}

#[test]
fn a_negative_unit_cost_or_vat_rate_is_refused_before_any_derivation() {
    let line = PurchaseLineBuilder::new("p1", "Coffee")
        .qty(1)
        .unit_cost_excl(200)
        .raw_unit_costs(-1, 222)
        .build();
    assert!(derive_unit_cost_pair(0, &line, VatPricingMode::Exclusive)
        .unwrap_err()
        .contains("negative unit cost"));

    let mut line = PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build();
    line.vat_rate_bps_snapshot = -1;
    assert!(derive_unit_cost_pair(0, &line, VatPricingMode::Exclusive)
        .unwrap_err()
        .contains("negative VAT rate"));
}

#[test]
fn a_pricing_mode_the_application_does_not_have_is_refused() {
    assert!(VatPricingMode::parse("exclusive").is_ok());
    assert!(VatPricingMode::parse("inclusive").is_ok());
    for bad in ["", "Exclusive", "net", "incl"] {
        let err = VatPricingMode::parse(bad).unwrap_err();
        assert!(err.contains("Invalid VAT pricing mode"), "{bad:?}: {err}");
    }

    // And the payload-shape validator rejects one before the pool is acquired.
    let mut p = purchase_payload(
        "normal",
        Some("s1"),
        vec![PurchaseLineBuilder::new("p1", "Coffee").qty(1).unit_cost_excl(200).build()],
    );
    p.lines[0].vat_pricing_mode = Some("net_of_discount".to_string());
    let err = validate_purchase_payload(&p).unwrap_err();
    assert!(err.contains("Invalid VAT pricing mode"), "got: {err}");

    // Omitting it is legal — `post_purchase` falls back to the product's mode.
    p.lines[0].vat_pricing_mode = None;
    assert!(validate_purchase_payload(&p).is_ok());
}
