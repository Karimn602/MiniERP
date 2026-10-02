// ============================================================================
// KNOWN-DEFECT REGISTER TESTS
// ============================================================================
//
// Each test below states an invariant the system must uphold, and is named for
// the audit finding that first reported it. A test that is `#[ignore]`d records
// a defect the current implementation still has, owned by a later work package;
// a test without the attribute is an invariant that is now ENFORCED and must
// stay enforced.
//
// Fixed in WP-02 — these now pass and must never regress:
//
//   GP-A02  authoritative UoM base-quantity + stock guard
//   GP-A05  stale is_service must not suppress the stock movement
//   GP-A06  backend line subtotal/VAT/total reconciliation
//   GP-A07  line-discount vs header-discount reconciliation
//
// Still ignored, still defects:
//
//   GP-A03  fractional base-unit cost precision             → WP-03
//   GP-A04  report / shift discount double subtraction      → WP-08 (TS layer)
//
// GP-A01 (checkout idempotency) was also fixed in WP-02. It never had an
// ignored test here — the invariant could not be stated before a stable
// checkout identity existed, and writing it as "two commercially identical
// carts must collapse into one sale" would have licensed basket-content
// deduplication, silently swallowing a second customer's money. Its real
// coverage lives in `sales.rs` under "Checkout idempotency", alongside the
// control test `two_identical_baskets_with_different_identities_both_post`.
//
// GP-A08 (returns / credit memos) → WP-06. Not implemented on this branch, so
// there is no behaviour to characterize. Recorded as a coverage gap in
// tests/README.md only — no placeholder test.
//
// See tests/README.md for the full register.

use crate::cost::{extended_cost_cents, COST_SCALE};
use crate::posting::{post_purchase_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";
const P_FLOUR: &str = "00000000-0000-0000-0000-0000000000c5";
const SUPPLIER: &str = "00000000-0000-0000-0000-0000000000s1";

/// A store with one stocked coffee product sold in `each` (base) or `box`
/// (12 each) — the same shape `productsRepo.create` produces.
async fn store_with_coffee(qty: i64) -> TempDb {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
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
    seed_product_uom(&db, P_COFFEE, "box", 12, 1).await;
    db
}

// ============================================================================
// GP-A02 — AUTHORITATIVE UoM BASE QUANTITY / STOCK GUARD        (fixed WP-02)
// ============================================================================
//
// Was: `post_sale` trusted `quantity_base` straight from the payload. It never
// recomputed it from `quantity_in_uom × num ÷ den`, so the stock guard compared
// a client-supplied number against quantity_on_hand — a stale or wrong frontend
// could sell 2 boxes (24 pieces) while declaring, and decrementing, 1 piece.
//
// Now: `post_sale` loads the product's own `product_uoms` row and derives the
// base quantity from ITS factor. That derived quantity drives the guard, the
// movement, the decrement and the COGS basis, and a payload that declares a
// different one is refused.

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
// GP-A03 — FRACTIONAL BASE-UNIT COST PRECISION                  (fixed WP-03)
// ============================================================================
//
// Was: every cost column was INTEGER USD cents, so the smallest representable
// per-base-unit cost was $0.01. A low-cost ingredient bought by the kilo but
// stocked in grams collapsed to zero:
//   unitCostInUomToBase(250 ¢/kg, 1000/1) = round(250 ÷ 1000) = 0 ¢/g
// Every gram then cost nothing, COGS was zero, and gross margin was overstated
// with nothing visibly wrong anywhere.
//
// Now: a unit cost is a RATE, not an amount, and is held in MICROCENTS
// (1 cent = `cost::COST_SCALE` = 1,000,000) in `products.avg_cost_*_microcents`,
// `inventory_movements.unit_cost_*_microcents`,
// `purchase_items.unit_cost_*_base_microcents` and
// `sale_items.unit_cogs_excl_vat_microcents`. `post_purchase` derives the
// per-base cost from the invoice's per-UoM cost with ONE division at microcent
// scale, and cost becomes money exactly once, at
// `cost::extended_cost_cents` — unit rate × base quantity, rounded once.
//
// The assertion on the stored per-gram cost now names the microcent column
// rather than its rounded cents mirror, and pins the exact expected value
// instead of merely `> 0`: at the new precision "non-zero" is no longer the
// interesting part. Rounding $0.0025/g to a whole cent still gives 0 — that
// mirror is display only, which is precisely why it is no longer what anything
// costs from. The money assertion below ($1.25 of COGS) is unchanged from the
// original characterization.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gp_a03_fractional_base_unit_costs_must_survive_conversion() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    seed_supplier(&db, SUPPLIER, "Beirut Wholesale").await;
    // Flour: base UoM is the gram, bought by the kilo. `post_purchase` resolves
    // the purchase UoM against `product_uoms`, so the kilo has to be a real
    // active row on the product.
    seed_product(&db, &ProductSpec::stocked(P_FLOUR, "SKU-F1", "Flour (g)")).await;
    seed_product_uom(&db, P_FLOUR, "kg", 1_000, 1).await;

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
        .scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_microcents FROM products WHERE id='{P_FLOUR}'"
        ))
        .await;
    assert!(
        avg > 0,
        "GP-A03: a $50 purchase must not leave a zero per-gram cost (got {avg})"
    );
    assert_eq!(
        avg,
        COST_SCALE / 4,
        "GP-A03: $2.50/kg is $0.0025/g — a quarter of a cent, or 250,000 microcents"
    );
    // The whole purchase is still accounted for: 20,000 g at that rate is the
    // $50.00 that was actually spent, to the cent.
    assert_eq!(extended_cost_cents(avg, 20_000).unwrap(), 5_000);

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
    // The header agrees with the line, and the rate itself was snapshotted.
    assert_eq!(
        db.scalar_i64(&format!("SELECT cogs_total_cents FROM sales WHERE id='{sale_id}'")).await,
        125
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT unit_cogs_excl_vat_microcents FROM sale_items WHERE sale_id='{sale_id}'"
        ))
        .await,
        250_000
    );
}

// ============================================================================
// GP-A05 — STALE is_service SUPPRESSES THE INVENTORY MOVEMENT   (fixed WP-02)
// ============================================================================
//
// Was: `post_sale` read `is_service` from the products table and used the DB
// value for the stock guard and for COGS — but branched on the PAYLOAD's
// `line.is_service` when deciding whether to write the inventory_movements row
// and decrement stock. A stocked product sold from a frontend holding a stale
// `isService: true` was charged COGS and checked against stock, yet left the
// shelf with no movement row and no decrement: physical stock drifted away from
// the books with no audit trail.
//
// Now: the products table is authoritative for the movement branch too.

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
// GP-A06 — BACKEND LINE RECONCILIATION                          (fixed WP-02)
// ============================================================================
//
// Was: the backend summed whatever line figures the client sent and wrote the
// sums to the header. It never checked that a line's own subtotal + VAT equals
// its total, so a frontend bug silently produced a sale whose VAT did not match
// its net — immutable once posted.
//
// Now: `prepare_sale` enforces `subtotal + VAT = total` per line in exact
// integer cents (and zero VAT on an exempt line) before the transaction opens.

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
// GP-A07 — LINE-DISCOUNT vs HEADER-DISCOUNT RECONCILIATION      (fixed WP-02)
// ============================================================================
//
// Was: `lib/discount.ts::allocateLineDiscounts` allocates the header discount
// exactly across the lines (proven by the TypeScript suite), but `post_sale`
// never verified the allocation it was handed. Any other caller — a future
// integration, an offline replay, a bug — could persist a sale whose per-line
// discounts did not add up to `sales.discount_cents`, leaving every downstream
// report disagreeing with itself.
//
// Now: `prepare_sale` requires SUM(line_discount_cents) == discount_cents.

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
