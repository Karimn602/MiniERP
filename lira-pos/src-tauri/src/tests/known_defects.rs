// ============================================================================
// KNOWN-DEFECT CHARACTERIZATION TESTS — all #[ignore]d on purpose.
// ============================================================================
//
// Each test below states the invariant the system SHOULD uphold. They are
// ignored because the current implementation violates them; WP-01 deliberately
// does not fix the behaviour, only records it.
//
// Remove the `#[ignore]` line as part of the owning work package. A test that
// starts passing before then means the defect was fixed elsewhere — verify and
// un-ignore it rather than leaving it dormant.
//
//   GP-A02  authoritative UoM base-quantity + stock guard   → WP-02
//   GP-A05  stale is_service suppresses the stock movement  → WP-02
//   GP-A06  backend line subtotal/VAT/total reconciliation  → WP-02
//   GP-A07  line-discount vs header-discount reconciliation → WP-02
//   GP-A03  fractional base-unit cost precision             → WP-03
//   GP-A04  report / shift discount double subtraction      → WP-08 (TS layer)
//
// Two audit items have NO ignored test here, deliberately:
//
//   GP-A01  checkout idempotency  → WP-02.  The production contract has no
//           stable checkout identity yet, so no test can express the real
//           invariant without inventing one. Writing the requirement as
//           "two commercially identical carts must collapse into one sale"
//           would be WRONG — it licenses basket-content deduplication, which
//           would silently swallow a second customer buying the same items.
//           `sales::two_identical_baskets_with_different_identities_both_post`
//           is a PASSING control test guarding against exactly that mistake.
//           See tests/README.md for what WP-02 must actually prove.
//
//   GP-A08  returns / credit memos  → WP-06.  Not implemented on this branch,
//           so there is no behaviour to characterize. Recorded as a coverage
//           gap in tests/README.md only — no placeholder test.
//
// See tests/README.md for the full register.

use crate::posting::{post_purchase_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_FLOUR: &str = "00000000-0000-0000-0000-0000000000c5";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

async fn store_with_coffee(qty: i64) -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: qty,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db
}

// ============================================================================
// GP-A02 — AUTHORITATIVE UoM BASE QUANTITY / STOCK GUARD             (→ WP-02)
// ============================================================================
//
// Current behaviour: `post_sale` trusts `quantity_base` straight from the
// payload. It never recomputes it from `quantity_in_uom × num ÷ den`, so the
// stock guard at posting.rs compares a client-supplied number against
// quantity_on_hand. A stale or wrong frontend can sell 2 boxes (24 pieces)
// while only declaring — and only decrementing — 1 piece.

#[ignore = "GP-A02: quantity_base is trusted from the payload; enable in WP-02"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a02_base_quantity_must_be_derived_from_the_uom_factor() {
    let db = store_with_coffee(100).await;

    // 2 boxes of 12 is 24 base units, but the payload claims 1.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_incl(6000)
        .raw_quantity_base(1)
        .build();
    let total = lines_total(std::slice::from_ref(&line));

    let result = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(total)])).await;

    match result {
        Err(e) => assert!(
            e.contains("quantity") || e.contains("UoM"),
            "GP-A02: an inconsistent base quantity must be rejected explicitly, got: {e}"
        ),
        Ok(_) => assert_eq!(
            quantity_on_hand(&db, P_COFFEE).await,
            76,
            "GP-A02: selling 2 boxes of 12 must remove 24 base units, not the declared 1"
        ),
    }
}

#[ignore = "GP-A02: the stock guard uses the payload's base quantity; enable in WP-02"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a02_the_stock_guard_must_validate_the_true_base_quantity() {
    // 10 pieces on hand. Selling 2 boxes of 12 needs 24 — it must be refused.
    let db = store_with_coffee(10).await;

    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 12, 1)
        .qty(2)
        .unit_incl(6000)
        .raw_quantity_base(1) // understated, so today's guard passes
        .build();
    let total = lines_total(std::slice::from_ref(&line));

    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(total)]))
        .await
        .expect_err("GP-A02: selling more base units than exist must be refused");
    assert!(err.contains("insufficient stock"), "got: {err}");
}

// ============================================================================
// GP-A03 — FRACTIONAL BASE-UNIT COST PRECISION                       (→ WP-03)
// ============================================================================
//
// Current behaviour: every cost column is INTEGER USD cents, so the smallest
// representable per-base-unit cost is $0.01. A low-cost ingredient bought by
// the kilo but stocked in grams collapses to zero:
//   unitCostInUomToBase(250 ¢/kg, 1000/1) = round(250 ÷ 1000) = 0 ¢/g
// Every gram then costs nothing, COGS is zero, and gross margin is overstated.
//
// This CANNOT be fixed without a schema change (a scaled/минor-unit cost
// column, or a rational cost), which WP-01 is forbidden from making. WP-03 owns
// both the representation decision and this test.

#[ignore = "GP-A03: sub-cent base costs are unrepresentable in the current schema; enable in WP-03"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a03_fractional_base_unit_costs_must_survive_conversion() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    // Flour: base UoM is the gram.
    seed_product(&db, &ProductSpec::stocked(P_FLOUR, "SKU-F1", "Flour (g)")).await;

    // Buy 20 kg at $2.50/kg = $50.00. Per gram that is $0.0025.
    let line = PurchaseLineBuilder::new(P_FLOUR, "Flour (g)")
        .uom("kg", 1000, 1)
        .qty(20)
        .unit_cost_excl(250)
        .build();
    assert_eq!(line.quantity_base, 20_000, "20 kg is 20,000 g");

    post_purchase_with_pool(db.pool(), purchase_payload("normal", Some(SUPPLIER), vec![line]))
        .await
        .unwrap();

    let avg = db
        .scalar_i64(&format!("SELECT avg_cost_excl_vat_cents FROM products WHERE id='{P_FLOUR}'"))
        .await;
    assert!(
        avg > 0,
        "GP-A03: a $50 purchase must not leave a zero per-gram cost (got {avg})"
    );

    // Selling 500 g of a $50/20kg stock should cost about $1.25.
    let sale_line = SaleLineBuilder::new(P_FLOUR, "Flour (g)").qty(500).unit_incl(400).build();
    let total = lines_total(std::slice::from_ref(&sale_line));
    let payload = sale_payload(vec![sale_line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();
    post_sale_with_pool(db.pool(), payload).await.unwrap();

    let cogs = db
        .scalar_i64(&format!("SELECT line_cogs_excl_vat_cents FROM sale_items WHERE sale_id='{sale_id}'"))
        .await;
    assert_eq!(cogs, 125, "GP-A03: 500 g at $0.0025/g is $1.25 of COGS");
}

// ============================================================================
// GP-A05 — STALE is_service SUPPRESSES THE INVENTORY MOVEMENT        (→ WP-02)
// ============================================================================
//
// Current behaviour: `post_sale` reads `is_service` from the products table and
// uses the DB value for the stock guard and for COGS — but it branches on the
// PAYLOAD's `line.is_service` when deciding whether to write the
// inventory_movements row and decrement stock.
//
// So a stocked product sold from a frontend holding a stale `isService: true`
// is charged COGS, is checked against stock, and yet leaves the shelf without
// any movement row and without any decrement. Physical stock silently drifts
// away from the books, and no audit trail records it.

#[ignore = "GP-A05: the movement branch trusts the payload's is_service; enable in WP-02"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a05_a_stocked_product_must_always_move_stock() {
    let db = store_with_coffee(100).await;

    // The DB says this product is stocked; the payload wrongly says service.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee").qty(3).unit_incl(500).service(true).build();
    let total = lines_total(std::slice::from_ref(&line));
    let payload = sale_payload(vec![line], vec![cash_usd(total)]);
    let sale_id = payload.sale_id.clone();

    post_sale_with_pool(db.pool(), payload).await.unwrap();

    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE related_sale_id='{sale_id}'"
        ))
        .await,
        1,
        "GP-A05: a stocked product must produce an inventory movement regardless of the payload flag"
    );
    assert_eq!(
        quantity_on_hand(&db, P_COFFEE).await,
        97,
        "GP-A05: stock must be decremented for a stocked product"
    );
    // The books must stay self-consistent either way.
    assert_eq!(movement_sum(&db, P_COFFEE).await + 100, quantity_on_hand(&db, P_COFFEE).await);
}

// ============================================================================
// GP-A06 — BACKEND LINE RECONCILIATION                               (→ WP-02)
// ============================================================================
//
// Current behaviour: the backend sums whatever line figures the client sends
// and writes the sums to the header. It never checks that a line's own
// subtotal + VAT equals its total, so a frontend bug silently produces a sale
// whose VAT does not match its net — and it is immutable once posted.

#[ignore = "GP-A06: per-line totals are not validated backend-side; enable in WP-02"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a06_a_line_whose_parts_do_not_sum_must_be_rejected() {
    let db = store_with_coffee(100).await;

    // 900 + 150 ≠ 1000. Internally inconsistent by one dime.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(2)
        .unit_incl(500)
        .raw_line_totals(900, 150, 1000)
        .build();
    let payload = sale_payload(vec![line], vec![cash_usd(1000)]);

    let err = post_sale_with_pool(db.pool(), payload)
        .await
        .expect_err("GP-A06: an internally inconsistent line must be refused");
    assert!(
        err.contains("subtotal") || err.contains("VAT") || err.contains("reconcile"),
        "got: {err}"
    );
}

// ============================================================================
// GP-A07 — LINE-DISCOUNT vs HEADER-DISCOUNT RECONCILIATION           (→ WP-02)
// ============================================================================
//
// Current behaviour: `lib/discount.ts::allocateLineDiscounts` allocates the
// header discount exactly across the lines (proven by the TypeScript suite),
// but `post_sale` never verifies the allocation it is handed. A different
// caller — a future integration, an offline replay, a bug — can persist a sale
// whose per-line discounts do not add up to `sales.discount_cents`, and every
// downstream report then disagrees with itself.

#[ignore = "GP-A07: the discount allocation is not verified backend-side; enable in WP-02"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a07_line_discounts_must_sum_to_the_header_discount() {
    let db = store_with_coffee(100).await;

    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(4)
        .unit_incl(500)
        .discount(30) // the line claims 30¢...
        .build();
    let total = lines_total(std::slice::from_ref(&line));
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.discount_cents = 100; // ...while the header claims $1.00
    let sale_id = payload.sale_id.clone();

    let result = post_sale_with_pool(db.pool(), payload).await;

    match result {
        Err(e) => assert!(e.contains("discount"), "GP-A07: expected a discount error, got: {e}"),
        Ok(_) => {
            let header = db
                .scalar_i64(&format!("SELECT discount_cents FROM sales WHERE id='{sale_id}'"))
                .await;
            let lines = db
                .scalar_i64(&format!(
                    "SELECT COALESCE(SUM(line_discount_cents),0) FROM sale_items WHERE sale_id='{sale_id}'"
                ))
                .await;
            assert_eq!(
                lines, header,
                "GP-A07: SUM(sale_items.line_discount_cents) must equal sales.discount_cents"
            );
        }
    }
}
