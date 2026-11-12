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
// GZ-HI-05 (supplier / accounts-payable integrity) was fixed in WP-05 and, like
// GP-A01, never had an ignored test here. Its invariants could not be stated
// before the AP model had one sign convention, one derived payable and a
// document identity to key a retry on, and the obvious shorthand — "the same
// bill must not post twice" — would have licensed content-based deduplication,
// silently swallowing a shop's second genuine delivery of the same goods. Its
// coverage lives in `supplier_ap.rs` and `supplier_payments.rs`, each alongside
// the control test that keeps the two apart
// (`two_deliveries_of_the_same_goods_under_different_identities_both_post`,
// `two_separate_payments_of_the_same_amount_both_post`).
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

// ============================================================================
// GZ-B-P1 — a sale's PRICES are not authoritative, so the large-discount
//           permission binds only the DECLARED discount.
// ============================================================================
//
// Reported by independent review of Gate 2B Stage B. Owned by a later work
// package: "make sale prices authoritative".
//
// Stage B gives a cashier permission to post a sale and withholds permission to
// give a discount above `authz::DISCOUNT_WITHOUT_APPROVAL_CENTS`. That check
// reads `payload.discount_cents`. It cannot read the ECONOMIC discount, because
// `post_sale` does not prove a line's unit price against the catalogue:
// `PostSaleLine` carries `unit_price_excl_vat_cents` /
// `unit_price_incl_vat_cents` and the command persists them.
//
// So a caller that shapes a request may sell a $10.00 item for $0.01 while
// declaring no discount at all. The sale reconciles perfectly — every line
// total, every VAT figure and the header sum agree, because they are all
// derived from the same understated price — and the permission is never
// consulted.
//
// WHAT THIS IS AND IS NOT. It is not reachable from the register, which sends
// the catalogue price and puts every reduction in the discount field; the
// control does bind that path. It IS reachable by a hand-built request, a
// future screen, an import or a script — and "an argument about one screen,
// not about the data" is a line this codebase has drawn before (see CLAUDE.md
// on `post_sale`'s delivery shape). So the honest claim is the smaller one:
// the permission binds the declared discount.
//
// THE FIX, when it is done, is not an extra check. It is to resolve each line's
// price from the product and its resolved `product_uoms` row INSIDE the posting
// transaction, derive the economic discount, and authorize on that — the same
// treatment `post_purchase` already gives a supplier's unit cost and
// `post_sale` already gives the UoM conversion and the COGS rate. It needs a
// product decision first: may a till sell at an overridden price at all, and if
// so is that override a discount for reporting?
//
// CLOSED (V1 release blockers). `post_sale_tx` now authorizes on the economic
// discount: the declared discount plus each line's shortfall against the
// catalogue price, read inside the posting transaction. The product decision
// was taken the conservative way: an overridden price is not refused outright
// (a cart rung before a reprice legitimately carries the old figure); it is
// treated as discount and meets the large-discount permission. The test runs
// normally and its assertion was not weakened. The companions below pin what
// must keep working.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_sale_price_cannot_be_used_to_give_an_unapproved_discount() {
    use crate::auth::{Actor, Role};
    use crate::posting::{post_sale_tx, prepare_sale};

    const CASHIER: &str = "00000000-0000-0000-0000-0000000000a2";
    const STORE: &str = "00000000-0000-0000-0000-000000000001";

    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('{CASHIER}', '{STORE}', 'Sami', 'cashier')"
    ))
    .await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 10,
            // A $10.00 item.
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db.exec(&format!(
        "UPDATE products SET price_incl_vat_cents = 1000, price_excl_vat_cents = 901
          WHERE id = '{P_COFFEE}'"
    ))
    .await;

    let shift = uuid();
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('{shift}', '{STORE}', '{CASHIER}', '2026-11-08T08:00:00.000Z', 'open', 0, 0)"
    ))
    .await;

    // One unit at ONE CENT, with no declared discount. The economic discount is
    // $9.99 — far above the threshold a cashier may give unaided.
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_incl(1).build();
    let mut payload = sale_payload(vec![line], vec![cash_usd(1)]);
    payload.shift_id = Some(shift);
    payload.cashier_user_id = Some(CASHIER.to_string());
    payload.discount_cents = 0;

    let prepared = prepare_sale(&payload).expect("the payload reconciles with itself");
    let outcome = post_sale_tx(
        db.pool(),
        &Actor::for_tests(CASHIER, STORE, Role::Cashier),
        payload,
        prepared,
    )
    .await;

    assert!(
        outcome.is_err(),
        "GZ-B-P1: a cashier sold a $10.00 item for $0.01 while declaring no \
         discount, so the large-discount permission was never consulted. The \
         economic discount must be derived from the catalogue price and \
         authorized."
    );

    db.cleanup().await.expect("remove TempDb");
}

// ---- GZ-B-P1 companions ----------------------------------------------------

const GZ_B_P1_USER: &str = "00000000-0000-0000-0000-0000000000a3";
const GZ_B_P1_STORE: &str = "00000000-0000-0000-0000-000000000001";

/// The GZ-B-P1 scenario ($10.00 / $9.01 coffee, ten in stock, an open shift)
/// with one member of staff of the given role.
async fn gz_b_p1_store(role: crate::auth::Role) -> (TempDb, String) {
    let db = TempDb::new().await;
    let role_text = match role {
        crate::auth::Role::Owner => "owner",
        crate::auth::Role::Manager => "manager",
        crate::auth::Role::Cashier => "cashier",
    };
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('{GZ_B_P1_USER}', '{GZ_B_P1_STORE}', 'Staff', '{role_text}')"
    ))
    .await;
    seed_exchange_rate(&db).await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 10,
            ..ProductSpec::stocked(P_COFFEE, "SKU-C1", "Coffee")
        },
    )
    .await;
    db.exec(&format!(
        "UPDATE products SET price_incl_vat_cents = 1000, price_excl_vat_cents = 901
          WHERE id = '{P_COFFEE}'"
    ))
    .await;
    let shift = uuid();
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('{shift}', '{GZ_B_P1_STORE}', '{GZ_B_P1_USER}', '2026-11-08T08:00:00.000Z', 'open', 0, 0)"
    ))
    .await;
    (db, shift)
}

async fn gz_b_p1_post(
    db: &TempDb,
    role: crate::auth::Role,
    shift: &str,
    unit_excl: i64,
    unit_incl: i64,
    qty: i64,
) -> Result<(), String> {
    use crate::auth::Actor;
    use crate::posting::{post_sale_tx, prepare_sale};
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(qty)
        .unit_prices(unit_excl, unit_incl)
        .build();
    let total = line.line_total_incl_vat_cents;
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.shift_id = Some(shift.to_string());
    payload.cashier_user_id = Some(GZ_B_P1_USER.to_string());
    payload.discount_cents = 0;
    let prepared = prepare_sale(&payload)?;
    post_sale_tx(
        db.pool(),
        &Actor::for_tests(GZ_B_P1_USER, GZ_B_P1_STORE, role),
        payload,
        prepared,
    )
    .await
    .map(|_| ())
}

/// A cashier selling at the catalogue price is untouched by the fix.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_cashier_at_the_catalogue_price_still_posts() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    gz_b_p1_post(&db, Role::Cashier, &shift, 901, 1000, 2)
        .await
        .expect("a catalogue-priced sale must post for a cashier");
    db.cleanup().await.expect("remove TempDb");
}

/// A price below the catalogue but within the threshold (a cart rung before a
/// small reprice) still posts for a cashier: it is discount, and small.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_small_price_shortfall_is_within_a_cashiers_authority() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    // 2 x 50 cents short = 100 cents of economic discount, under 500.
    gz_b_p1_post(&db, Role::Cashier, &shift, 856, 950, 2)
        .await
        .expect("a 100-cent shortfall is within a cashier's discount authority");
    db.cleanup().await.expect("remove TempDb");
}

/// Quantity multiplies the shortfall: 6 x 90 cents = 540 > 500.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_shortfall_is_counted_per_unit_sold() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    let err = gz_b_p1_post(&db, Role::Cashier, &shift, 820, 910, 6)
        .await
        .expect_err("540 cents below catalogue across six units exceeds the threshold");
    assert!(err.contains("below the"), "the refusal must say why: {err}");
    let sales = db.scalar_i64("SELECT COUNT(*) FROM sales").await;
    assert_eq!(sales, 0, "a refused sale leaves nothing behind");
    db.cleanup().await.expect("remove TempDb");
}

/// Understating only the EXCLUSIVE price (revenue moved into VAT) is a
/// shortfall too, even though the customer pays the catalogue's inclusive one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_an_understated_exclusive_price_is_a_shortfall() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    let err = gz_b_p1_post(&db, Role::Cashier, &shift, 1, 1000, 1)
        .await
        .expect_err("900 cents of revenue moved into VAT must be authorized");
    assert!(err.contains("below the"), "refused by the shortfall rule: {err}");
    db.cleanup().await.expect("remove TempDb");
}

/// A manager may give the reduction: the permission is a role rule, not a ban.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_manager_may_sell_below_the_catalogue() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Manager).await;
    gz_b_p1_post(&db, Role::Manager, &shift, 1, 1, 1)
        .await
        .expect("a manager holds the large-discount permission");
    db.cleanup().await.expect("remove TempDb");
}

/// A price ABOVE the catalogue is not a discount.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_price_above_the_catalogue_is_not_a_discount() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    gz_b_p1_post(&db, Role::Cashier, &shift, 1081, 1200, 1)
        .await
        .expect("a higher price is not a discount");
    db.cleanup().await.expect("remove TempDb");
}

/// A unit with its OWN sale price is priced from that row, not from the base
/// price scaled by the factor: a 6-pack sold at its own $50.00 is not a
/// $10.00 shortfall against 6 x $10.00.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_unit_with_its_own_price_is_priced_from_that_row() {
    use crate::auth::{Actor, Role};
    use crate::posting::{post_sale_tx, prepare_sale};
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    db.exec(&format!(
        "INSERT INTO product_uoms (id, product_id, store_id, uom_code, factor_num, factor_den,
                                   is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
                                   sale_price_excl_vat_cents, sale_price_incl_vat_cents)
         VALUES ('{}', '{P_COFFEE}', '{GZ_B_P1_STORE}', 'box', 6, 1, 0, 0, 0, 1, 4505, 5000)",
        uuid()
    ))
    .await;
    let line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .uom("box", 6, 1)
        .qty(1)
        .unit_prices(4505, 5000)
        .build();
    let total = line.line_total_incl_vat_cents;
    let mut payload = sale_payload(vec![line], vec![cash_usd(total)]);
    payload.shift_id = Some(shift);
    payload.cashier_user_id = Some(GZ_B_P1_USER.to_string());
    let prepared = prepare_sale(&payload).expect("coherent");
    post_sale_tx(
        db.pool(),
        &Actor::for_tests(GZ_B_P1_USER, GZ_B_P1_STORE, Role::Cashier),
        payload,
        prepared,
    )
    .await
    .expect("the unit's own price is the catalogue price");
    db.cleanup().await.expect("remove TempDb");
}

/// Post a one-line sale as the GZ-B-P1 user with the line's TOTALS (and the
/// declared discount) set by hand, the unit prices left at the catalogue's.
async fn gz_b_p1_post_totals(
    db: &TempDb,
    role: crate::auth::Role,
    shift: &str,
    qty: i64,
    line_total_incl: i64,
    line_subtotal_excl: i64,
    discount: i64,
) -> Result<(), String> {
    use crate::auth::Actor;
    use crate::posting::{post_sale_tx, prepare_sale};
    let mut line = SaleLineBuilder::new(P_COFFEE, "Coffee")
        .qty(qty)
        .unit_prices(901, 1000)
        .build();
    line.line_total_incl_vat_cents = line_total_incl;
    line.line_subtotal_excl_vat_cents = line_subtotal_excl;
    line.line_vat_cents = line_total_incl - line_subtotal_excl;
    line.line_discount_cents = discount;
    let mut payload = sale_payload(vec![line], vec![cash_usd(line_total_incl)]);
    payload.shift_id = Some(shift.to_string());
    payload.cashier_user_id = Some(GZ_B_P1_USER.to_string());
    payload.discount_cents = discount;
    let prepared = prepare_sale(&payload)?;
    post_sale_tx(
        db.pool(),
        &Actor::for_tests(GZ_B_P1_USER, GZ_B_P1_STORE, role),
        payload,
        prepared,
    )
    .await
    .map(|_| ())
}

/// INDEPENDENT REVIEW (V1): honest unit prices over a ONE-CENT line total.
/// `validate_line_financials` proves subtotal + VAT = total and nothing ties
/// the total to the unit price, so this was a $10.00 item sold for $0.01 with
/// zero unit-price shortfall. The line total is now compared too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_honest_unit_prices_over_a_one_cent_total_are_refused() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    let err = gz_b_p1_post_totals(&db, Role::Cashier, &shift, 1, 1, 1, 0)
        .await
        .expect_err("a $0.01 line total under a $10.00 unit price is a $9.99 discount");
    assert!(err.contains("below the"), "refused by the economic-discount rule: {err}");
    assert_eq!(db.scalar_i64("SELECT COUNT(*) FROM sales").await, 0);
    db.cleanup().await.expect("remove TempDb");
}

/// A legitimate DECLARED discount within the threshold — line totals posted
/// after allocation, exactly as the register sends them — still posts for a
/// cashier, and is counted ONCE (declared $4.00 is not doubled to $8.00).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_declared_discount_is_counted_once() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    // Two coffees, $20.00, $4.00 off: $16.00 posted, $14.41 net.
    gz_b_p1_post_totals(&db, Role::Cashier, &shift, 2, 1600, 1441, 400)
        .await
        .expect("a $4.00 declared discount is within a cashier's authority");
    db.cleanup().await.expect("remove TempDb");
}

/// And a declared discount over the threshold is still refused for a cashier
/// and still allowed for a manager.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_large_declared_discount_still_needs_a_manager() {
    use crate::auth::Role;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;
    assert!(gz_b_p1_post_totals(&db, Role::Cashier, &shift, 2, 1400, 1261, 600)
        .await
        .is_err());
    db.cleanup().await.expect("remove TempDb");
    let (db, shift) = gz_b_p1_store(Role::Manager).await;
    gz_b_p1_post_totals(&db, Role::Manager, &shift, 2, 1400, 1261, 600)
        .await
        .expect("a manager may give $6.00 off");
    db.cleanup().await.expect("remove TempDb");
}

/// INDEPENDENT REVIEW ROUND 2 (V1): a hidden-price discount refusal must be
/// AUDITED. The in-transaction refusal rolls back, so the command boundary runs
/// `economic_discount_preflight` and, over the threshold, the auditable
/// `authz::authorize`. This drives exactly those two calls, in that order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gz_b_p1_a_hidden_price_discount_refusal_is_audited() {
    use crate::auth::{Actor, Role};
    use crate::posting::economic_discount_preflight;
    let (db, shift) = gz_b_p1_store(Role::Cashier).await;

    let line = SaleLineBuilder::new(P_COFFEE, "Coffee").qty(1).unit_prices(1, 1).build();
    let mut payload = sale_payload(vec![line], vec![cash_usd(1)]);
    payload.shift_id = Some(shift);
    payload.cashier_user_id = Some(GZ_B_P1_USER.to_string());

    let economic = economic_discount_preflight(db.pool(), &payload)
        .await
        .expect("preflight reads");
    assert_eq!(economic, 999, "$10.00 sold at $0.01 is $9.99 of discount");
    assert!(economic > crate::authz::DISCOUNT_WITHOUT_APPROVAL_CENTS);

    let before = db
        .scalar_i64("SELECT count(*) FROM auth_audit WHERE event = 'permission_denied'")
        .await;
    let refused = crate::authz::authorize(
        db.pool(),
        &Actor::for_tests(GZ_B_P1_USER, GZ_B_P1_STORE, Role::Cashier),
        crate::authz::Operation::PostSaleLargeDiscount,
    )
    .await;
    // And the boundary returns the SAME actionable sentence as the
    // in-transaction check (round 3): a stale cart must hear "re-add the item".
    let message = crate::posting::hidden_price_refusal(
        refused.clone().expect_err("a cashier is refused"),
        economic - payload.discount_cents,
    );
    assert!(
        message.contains("999 cents below the catalogue") && message.contains("add it again"),
        "{message}"
    );
    let after = db
        .scalar_i64("SELECT count(*) FROM auth_audit WHERE event = 'permission_denied'")
        .await;
    assert_eq!(after, before + 1, "the refusal leaves a durable audit row");

    // And a REPLAY identity is never refused by the preflight: an existing
    // sale reports only its declared discount.
    db.exec(&format!(
        "INSERT INTO sales (id, store_id, receipt_number, exchange_rate_lbp_per_usd,
                            subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents)
         VALUES ('{}', '{GZ_B_P1_STORE}', 9001, 89000, 1, 0, 1)",
        payload.sale_id
    ))
    .await;
    assert_eq!(economic_discount_preflight(db.pool(), &payload).await.unwrap(), 0);
    db.cleanup().await.expect("remove TempDb");
}
