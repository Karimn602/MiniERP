// Layer B — pure Rust unit tests. No database.

use crate::cost::new_weighted_avg;
use crate::posting::{
    derive_base_quantity, prepare_sale, validate_adjustment_payload, validate_purchase_payload,
    validate_supplier_payment_payload,
};
use crate::test_support::{VAT_EXEMPT_ID, VAT_STD_BPS, VAT_STD_ID};
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

    // Native amount inconsistent with the declared currency.
    let mut p = sale_payload(one_line_sale(), vec![cash_usd(total)]);
    p.payments[0].currency = "LBP".to_string();
    assert!(prepare_sale(&p).unwrap_err().contains("inconsistent"));
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
