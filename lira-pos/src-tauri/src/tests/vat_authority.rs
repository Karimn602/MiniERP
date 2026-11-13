// GZ-VAT-1 — the revenue/VAT split of a NEW sale line is the database's.
//
// Before this, `validate_line_financials` proved only that a line's parts add
// up, and the rate was the caller's: a request could post a taxable item as
// exempt, or move revenue into VAT (or VAT into revenue) while keeping the
// customer's total — so every one of these tests asserts the PERSISTED split,
// or that nothing was written at all, never merely that subtotal + VAT = total.
//
// The authoritative rule is the register's own, `lib/discount.ts::
// postDiscountLineTotals`: the post-discount VAT-inclusive line total, stripped
// at the product's configured `vat_rates.rate_bps` with the application's
// half-away-from-zero rounding (`posting::strip_vat`, pinned to `lib/vat.ts`).

use crate::auth::{Actor, Role};
use crate::posting::{
    post_sale_tx, prepare_sale, strip_vat, validate_sale_vat_authority, PostSaleLine,
    PostSalePayload, PostSaleResult,
};
use crate::test_support::*;
use crate::tests::builders::{
    cash_usd, replay_of, sale_payload, seed_posted_sale_in_its_shift, uuid, SaleLineBuilder,
};

const USER: &str = "00000000-0000-0000-0000-0000000000a7";
const VAT_ZERO_ID: &str = "00000000-0000-0000-0000-000000000011";
const VAT_FULL_ID: &str = "vat-test-100pct";

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000007c1"; // 11%, $10.00 incl
const P_BREAD: &str = "00000000-0000-0000-0000-0000000007c2"; // exempt, $3.00
const P_WATER: &str = "00000000-0000-0000-0000-0000000007c3"; // zero-rated, $1.50
const P_CAKE: &str = "00000000-0000-0000-0000-0000000007c4"; // 11%, priced EXCLUSIVE $9.99
const P_TIE: &str = "00000000-0000-0000-0000-0000000007c5"; // 100%, 1 cent: exact halves
const P_BIG: &str = "00000000-0000-0000-0000-0000000007c6"; // 11%, $9 trillion

const BIG_INCL: i64 = 900_000_000_000_000;

async fn store(role: Role) -> (TempDb, String) {
    let db = TempDb::new().await;
    let role_text = match role {
        Role::Owner => "owner",
        Role::Manager => "manager",
        Role::Cashier => "cashier",
    };
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('{USER}', '{STORE_ID}', 'Staff', '{role_text}')"
    ))
    .await;
    // A configured 100% rate: the only rate at which `total × 10000 /
    // (10000 + bps)` lands EXACTLY on a half cent (an odd total), so the
    // rounding direction at a tie is exercised on real rows.
    db.exec(&format!(
        "INSERT INTO vat_rates (id, name, rate_bps, is_exempt, effective_from)
         VALUES ('{VAT_FULL_ID}', 'Test 100%', 10000, 0, '2018-01-01')"
    ))
    .await;
    seed_exchange_rate(&db).await;
    for (id, sku, name, rate, excl, incl, mode) in [
        (P_COFFEE, "V-1", "Coffee", VAT_STD_ID, 901, 1_000, "inclusive"),
        (P_BREAD, "V-2", "Bread", VAT_EXEMPT_ID, 300, 300, "inclusive"),
        (P_WATER, "V-3", "Water", VAT_ZERO_ID, 150, 150, "inclusive"),
        (P_CAKE, "V-4", "Cake", VAT_STD_ID, 999, 1_109, "exclusive"),
        (P_TIE, "V-5", "Tie", VAT_FULL_ID, 1, 1, "inclusive"),
        (P_BIG, "V-6", "Big", VAT_STD_ID, strip_vat(BIG_INCL, 1100).unwrap(), BIG_INCL, "inclusive"),
    ] {
        seed_product(
            &db,
            &ProductSpec {
                vat_rate_id: rate,
                price_excl_vat_cents: excl,
                price_incl_vat_cents: incl,
                quantity_on_hand: 1_000,
                vat_pricing_mode: mode,
                ..ProductSpec::stocked(id, sku, name)
            },
        )
        .await;
    }
    let shift = uuid();
    db.exec(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opened_at, status,
                             opening_cash_usd_cents, opening_cash_lbp)
         VALUES ('{shift}', '{STORE_ID}', '{USER}', '2026-11-13T08:00:00.000Z', 'open', 0, 0)"
    ))
    .await;
    (db, shift)
}

/// A line exactly as the register sends it: the post-discount inclusive total,
/// split by `postDiscountLineTotals` at the product's rate.
fn register_line(
    product: &str,
    name: &str,
    rate: (&str, i64),
    qty: i64,
    unit: (i64, i64),
    line_discount: i64,
) -> PostSaleLine {
    let mut l = SaleLineBuilder::new(product, name)
        .vat(rate.0, rate.1)
        .qty(qty)
        .unit_prices(unit.0, unit.1)
        .build();
    let total = unit.1 * qty - line_discount;
    let subtotal = strip_vat(total, rate.1).unwrap();
    l.line_total_incl_vat_cents = total;
    l.line_subtotal_excl_vat_cents = subtotal;
    l.line_vat_cents = total - subtotal;
    l.line_discount_cents = line_discount;
    l
}

fn coffee(qty: i64) -> PostSaleLine {
    register_line(P_COFFEE, "Coffee", (VAT_STD_ID, 1100), qty, (901, 1_000), 0)
}
fn bread(qty: i64) -> PostSaleLine {
    register_line(P_BREAD, "Bread", (VAT_EXEMPT_ID, 0), qty, (300, 300), 0)
}
fn water(qty: i64) -> PostSaleLine {
    register_line(P_WATER, "Water", (VAT_ZERO_ID, 0), qty, (150, 150), 0)
}

/// Re-split a line's unchanged total by hand.
fn forged(mut l: PostSaleLine, subtotal: i64) -> PostSaleLine {
    l.line_subtotal_excl_vat_cents = subtotal;
    l.line_vat_cents = l.line_total_incl_vat_cents - subtotal;
    l
}

fn payload(shift: &str, lines: Vec<PostSaleLine>) -> PostSalePayload {
    let total: i64 = lines.iter().map(|l| l.line_total_incl_vat_cents).sum();
    let discount: i64 = lines.iter().map(|l| l.line_discount_cents).sum();
    let mut p = sale_payload(lines, vec![cash_usd(total)]);
    p.shift_id = Some(shift.to_string());
    p.cashier_user_id = Some(USER.to_string());
    p.discount_cents = discount;
    p
}

async fn post(db: &TempDb, role: Role, p: PostSalePayload) -> Result<PostSaleResult, String> {
    let prepared = prepare_sale(&p)?;
    post_sale_tx(db.pool(), &Actor::for_tests(USER, STORE_ID, role), p, prepared).await
}

/// Everything a posting could have touched.
async fn footprint(db: &TempDb) -> String {
    let mut parts = Vec::new();
    for sql in [
        "SELECT COUNT(*) FROM sales",
        "SELECT COUNT(*) FROM sale_items",
        "SELECT COUNT(*) FROM sale_payments",
        "SELECT COUNT(*) FROM inventory_movements",
        "SELECT COALESCE(SUM(quantity_on_hand), 0) FROM products",
        "SELECT CAST(value AS INTEGER) FROM app_settings WHERE key = 'next_receipt_number'",
    ] {
        parts.push(db.scalar_i64(sql).await.to_string());
    }
    parts.join("|")
}

async fn persisted_line(db: &TempDb, sale_id: &str, product: &str) -> (i64, i64, i64, i64) {
    let q = |col: &str| {
        format!(
            "SELECT {col} FROM sale_items WHERE sale_id = '{sale_id}' AND product_id = '{product}'"
        )
    };
    (
        db.scalar_i64(&q("line_subtotal_excl_vat_cents")).await,
        db.scalar_i64(&q("line_vat_cents")).await,
        db.scalar_i64(&q("line_total_incl_vat_cents")).await,
        db.scalar_i64(&q("vat_rate_bps_snapshot")).await,
    )
}

async fn persisted_header(db: &TempDb, sale_id: &str) -> (i64, i64, i64) {
    let q = |col: &str| format!("SELECT {col} FROM sales WHERE id = '{sale_id}'");
    (
        db.scalar_i64(&q("subtotal_excl_vat_cents")).await,
        db.scalar_i64(&q("vat_total_cents")).await,
        db.scalar_i64(&q("total_incl_vat_cents")).await,
    )
}

/// Assert a refusal that names the split or the rate and left nothing behind.
async fn assert_refused(db: &TempDb, role: Role, p: PostSalePayload, needle: &str) -> String {
    let before = footprint(db).await;
    let err = post(db, role, p).await.expect_err("must be refused");
    assert!(err.contains(needle), "expected {needle:?}, got: {err}");
    assert!(err.contains("Nothing has been changed"), "the refusal says so: {err}");
    assert_eq!(footprint(db).await, before, "a refused sale leaves no trace");
    err
}

// ---------------------------------------------------------------------------
// The ordinary register path still posts, and posts the authoritative split
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ordinary_taxable_sale_posts_the_rate_applied_to_its_total() {
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![coffee(3)]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("an ordinary cashier sale posts");
    // $30.00 at 11%: round(3000 / 1.11) = round(2702.70) = 2703.
    assert_eq!(persisted_line(&db, &id, P_COFFEE).await, (2_703, 297, 3_000, 1100));
    assert_eq!(persisted_header(&db, &id).await, (2_703, 297, 3_000));
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vat_inclusive_price_posts_its_inclusive_total_split_at_the_rate() {
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![coffee(1)]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("posts");
    // $10.00 at 11%: round(900.90) = 901.
    assert_eq!(persisted_line(&db, &id, P_COFFEE).await, (901, 99, 1_000, 1100));
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vat_exclusive_price_posts_its_net_figure_back_exactly() {
    let (db, shift) = store(Role::Cashier).await;
    // Priced at $9.99 EXCLUSIVE; the catalogue's gross is add_vat(999) = 1109,
    // which is what the register rings and posts.
    let line = register_line(P_CAKE, "Cake", (VAT_STD_ID, 1100), 1, (999, 1_109), 0);
    let p = payload(&shift, vec![line]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("posts");
    assert_eq!(persisted_line(&db, &id, P_CAKE).await, (999, 110, 1_109, 1100));

    // Three of them: 3327 gross, round(2997.30) = 2997 net.
    let line = register_line(P_CAKE, "Cake", (VAT_STD_ID, 1100), 3, (999, 1_109), 0);
    let p = payload(&shift, vec![line]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("posts");
    assert_eq!(persisted_line(&db, &id, P_CAKE).await, (2_997, 330, 3_327, 1100));
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exempt_and_zero_rated_lines_post_with_no_vat() {
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![bread(2), water(3)]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("posts");
    assert_eq!(persisted_line(&db, &id, P_BREAD).await, (600, 0, 600, 0));
    assert_eq!(persisted_line(&db, &id, P_WATER).await, (450, 0, 450, 0));
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mixed_taxable_and_exempt_sale_splits_each_line_at_its_own_rate() {
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![coffee(2), bread(1), water(1)]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("posts");
    assert_eq!(persisted_line(&db, &id, P_COFFEE).await, (1_802, 198, 2_000, 1100));
    assert_eq!(persisted_line(&db, &id, P_BREAD).await, (300, 0, 300, 0));
    assert_eq!(persisted_line(&db, &id, P_WATER).await, (150, 0, 150, 0));
    assert_eq!(persisted_header(&db, &id).await, (2_252, 198, 2_450));

    // Moving one cent of the taxable line's revenue into VAT — the totals
    // unchanged, the exempt lines honest — is refused by line.
    let p = payload(&shift, vec![coffee(2), bread(1), forged(water(1), 150)]);
    post(&db, Role::Cashier, p).await.expect("the honest mix posts again");
    let p = payload(&shift, vec![bread(1), forged(coffee(2), 1_801)]);
    let err = assert_refused(&db, Role::Cashier, p, "1802 revenue + 198 VAT").await;
    assert!(err.starts_with("Line 2 (Coffee)"), "names the line: {err}");
    // VAT on an exempt line is refused too (by the pure reconciliation, before
    // any database work), and leaves nothing behind.
    let before = footprint(&db).await;
    let p = payload(&shift, vec![coffee(2), forged(bread(1), 299)]);
    let err = post(&db, Role::Cashier, p).await.expect_err("VAT on an exempt line");
    assert!(err.contains("exempt (0 bps)"), "got: {err}");
    assert_eq!(footprint(&db).await, before);
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// Forged splits with an unchanged total
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forged_split_with_an_unchanged_total_is_refused_in_both_directions() {
    let (db, shift) = store(Role::Cashier).await;
    // Revenue moved into VAT (VAT overstated) and VAT moved into revenue (VAT
    // understated), each by a lot and by exactly one cent, and the legacy
    // per-unit-then-multiply split the register never posts.
    for (subtotal, what) in [
        (500, "VAT far too high"),
        (1_000, "no VAT at all on a taxable item"),
        (900, "VAT one cent too high"),
        (902, "VAT one cent too low"),
    ] {
        let p = payload(&shift, vec![forged(coffee(1), subtotal)]);
        let err = assert_refused(&db, Role::Cashier, p, "at 1100 bps it is 901 revenue + 99 VAT")
            .await;
        assert!(err.contains("Coffee"), "{what}: names the line: {err}");
    }
    // A two-unit line split 1800 + 200 (a "round" 10% look) is not 2000
    // stripped at 11%.
    let p = payload(&shift, vec![forged(coffee(2), 1_800)]);
    assert_refused(&db, Role::Cashier, p, "at 1100 bps it is 1802 revenue + 198 VAT").await;
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forged_split_is_not_a_permission_a_manager_or_owner_can_exercise() {
    for role in [Role::Manager, Role::Owner] {
        let (db, shift) = store(role).await;
        let p = payload(&shift, vec![forged(coffee(1), 1_000)]);
        assert_refused(&db, role, p, "901 revenue + 99 VAT").await;
        db.cleanup().await.expect("remove TempDb");
    }
}

// ---------------------------------------------------------------------------
// The rate is the product's configured row, not the caller's
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_taxable_product_cannot_be_posted_as_exempt_or_the_reverse() {
    let (db, shift) = store(Role::Cashier).await;

    // VAT understated: the 11% coffee claimed under the exempt row, split
    // "coherently" at 0 bps.
    let as_exempt = register_line(P_COFFEE, "Coffee", (VAT_EXEMPT_ID, 0), 1, (901, 1_000), 0);
    let p = payload(&shift, vec![as_exempt]);
    assert_refused(&db, Role::Cashier, p, "taxed at 0 bps, but the product is configured at 1100")
        .await;

    // VAT overstated: the exempt bread claimed at 11%.
    let as_std = register_line(P_BREAD, "Bread", (VAT_STD_ID, 1100), 1, (300, 300), 0);
    let p = payload(&shift, vec![as_std]);
    assert_refused(&db, Role::Cashier, p, "taxed at 1100 bps, but the product is configured at 0")
        .await;

    // The right row id with a wrong rate on it.
    let mut wrong_bps = coffee(1);
    wrong_bps.vat_rate_bps_snapshot = 1000;
    let p = payload(&shift, vec![wrong_bps]);
    assert_refused(&db, Role::Cashier, p, "configured at 1100 bps").await;
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zero_rated_and_exempt_are_different_configurations_even_at_zero() {
    let (db, shift) = store(Role::Cashier).await;
    // Zero-rated water claimed under the EXEMPT row: same 0 bps, same split,
    // a different fiscal classification. The row is the product's.
    let p = payload(
        &shift,
        vec![register_line(P_WATER, "Water", (VAT_EXEMPT_ID, 0), 1, (150, 150), 0)],
    );
    assert_refused(&db, Role::Cashier, p, "the product is configured at 0 bps").await;
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rate_changed_while_the_cart_was_open_is_refused_with_the_remedy() {
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![coffee(1)]);
    db.exec(&format!("UPDATE products SET vat_rate_id = '{VAT_EXEMPT_ID}' WHERE id = '{P_COFFEE}'"))
        .await;
    assert_refused(&db, Role::Cashier, p, "remove the item and add it again").await;
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// Discounts: the split follows the authorized post-discount total
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_valid_cashier_discount_posts_its_post_discount_split() {
    let (db, shift) = store(Role::Cashier).await;
    // Two coffees, $4.00 off: $16.00 posted, round(1441.44) = 1441 net.
    let line = register_line(P_COFFEE, "Coffee", (VAT_STD_ID, 1100), 2, (901, 1_000), 400);
    let p = payload(&shift, vec![line]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("$4.00 is within a cashier's authority");
    assert_eq!(persisted_line(&db, &id, P_COFFEE).await, (1_441, 159, 1_600, 1100));
    assert_eq!(db.scalar_i64(&format!("SELECT discount_cents FROM sales WHERE id = '{id}'")).await, 400);

    // The same discounted total, split as if undiscounted VAT stayed put
    // (1600 − 198 = 1402 net), is a forged split.
    let line = register_line(P_COFFEE, "Coffee", (VAT_STD_ID, 1100), 2, (901, 1_000), 400);
    let p = payload(&shift, vec![forged(line, 1_402)]);
    assert_refused(&db, Role::Cashier, p, "1441 revenue + 159 VAT").await;
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_discount_needs_a_manager_and_then_posts_the_authoritative_split() {
    let line = || register_line(P_COFFEE, "Coffee", (VAT_STD_ID, 1100), 2, (901, 1_000), 600);

    let (db, shift) = store(Role::Cashier).await;
    let before = footprint(&db).await;
    let err = post(&db, Role::Cashier, payload(&shift, vec![line()]))
        .await
        .expect_err("$6.00 off is over a cashier's limit");
    assert!(err.contains("discount"), "refused by the discount rule: {err}");
    assert_eq!(footprint(&db).await, before);
    db.cleanup().await.expect("remove TempDb");

    let (db, shift) = store(Role::Manager).await;
    let p = payload(&shift, vec![line()]);
    let id = p.sale_id.clone();
    post(&db, Role::Manager, p).await.expect("a manager may give $6.00 off");
    // $14.00: round(1261.26) = 1261.
    assert_eq!(persisted_line(&db, &id, P_COFFEE).await, (1_261, 139, 1_400, 1100));
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unauthorized_price_reduction_with_an_honest_split_is_still_refused() {
    // The VAT rule does not replace GZ-B-P1: a $10.00 coffee at $0.01, split
    // perfectly at 11% (round(0.9) = 1 + 0), is still $9.99 of discount.
    let (db, shift) = store(Role::Cashier).await;
    let line = register_line(P_COFFEE, "Coffee", (VAT_STD_ID, 1100), 1, (1, 1), 0);
    let p = payload(&shift, vec![line]);
    let before = footprint(&db).await;
    let err = post(&db, Role::Cashier, p).await.expect_err("refused");
    assert!(err.contains("below the catalogue"), "the economic-discount refusal: {err}");
    assert_eq!(footprint(&db).await, before);
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// Rounding and range
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exact_half_cent_rounds_away_from_zero_like_the_register() {
    let (db, shift) = store(Role::Cashier).await;
    // At 100%, 1 cent is 0.5 net → 1 + 0; 3 cents is 1.5 net → 2 + 1.
    // `Math.round` in `postDiscountLineTotals` rounds a positive half upward.
    for (qty, expect) in [(1, (1, 0, 1)), (3, (2, 1, 3))] {
        let line = register_line(P_TIE, "Tie", (VAT_FULL_ID, 10_000), qty, (1, 1), 0);
        let p = payload(&shift, vec![line]);
        let id = p.sale_id.clone();
        post(&db, Role::Cashier, p).await.expect("posts");
        let (s, v, t, _) = persisted_line(&db, &id, P_TIE).await;
        assert_eq!((s, v, t), expect);
    }
    // Rounding the half DOWN instead is a forged split.
    let line = register_line(P_TIE, "Tie", (VAT_FULL_ID, 10_000), 3, (1, 1), 0);
    let p = payload(&shift, vec![forged(line, 1)]);
    assert_refused(&db, Role::Cashier, p, "2 revenue + 1 VAT").await;
    db.cleanup().await.expect("remove TempDb");
}

#[test]
fn the_backend_split_is_the_exactly_rounded_quotient_for_every_small_total() {
    // An independent statement of the rule: net = the nearest integer to
    // total × 10000 / (10000 + bps), a half going up. Checked by exact
    // integer comparison against `strip_vat` for every total up to 20,000
    // cents at every rate the schema allows in steps that include the
    // configured 0, 11% and 100%.
    for bps in (0..=10_000).step_by(25).chain([1100, 1, 9_999]) {
        let d = 10_000 + bps as i128;
        for total in 0..=20_000i64 {
            let num = total as i128 * 10_000;
            let lo = num / d;
            let rem2 = 2 * (num - lo * d);
            let expect = if rem2 >= d { lo + 1 } else { lo };
            assert_eq!(strip_vat(total, bps).unwrap() as i128, expect, "total {total} at {bps}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_largest_realistic_amounts_split_exactly() {
    let (db, shift) = store(Role::Cashier).await;
    // Ten lines' worth of a $9-trillion item: 9 × 10^15 cents, far beyond any
    // till, inside i64, split in i128 with nothing lost.
    let net = strip_vat(BIG_INCL * 10, 1100).unwrap();
    let line =
        register_line(P_BIG, "Big", (VAT_STD_ID, 1100), 10, (strip_vat(BIG_INCL, 1100).unwrap(), BIG_INCL), 0);
    let p = payload(&shift, vec![line]);
    let id = p.sale_id.clone();
    post(&db, Role::Cashier, p).await.expect("posts");
    assert_eq!(
        persisted_line(&db, &id, P_BIG).await,
        (net, BIG_INCL * 10 - net, BIG_INCL * 10, 1100)
    );
    // And at the very top of the range the rule neither overflows nor panics.
    let top = strip_vat(i64::MAX, 1100).expect("i128 arithmetic");
    assert!(top > 0 && top < i64::MAX);
    assert_eq!(strip_vat(i64::MAX, 0).unwrap(), i64::MAX);
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_and_overflowing_figures_are_refused_before_anything_is_written() {
    let (db, shift) = store(Role::Cashier).await;
    let before = footprint(&db).await;

    // Negative VAT to inflate revenue past the total.
    let mut neg = coffee(1);
    neg.line_subtotal_excl_vat_cents = 1_001;
    neg.line_vat_cents = -1;
    // Parts that overflow when summed.
    let mut wrap = coffee(1);
    wrap.line_subtotal_excl_vat_cents = i64::MAX;
    wrap.line_vat_cents = 1;
    wrap.line_total_incl_vat_cents = i64::MIN;
    // Two lines whose totals overflow the header.
    let mut half_a = coffee(1);
    half_a.line_total_incl_vat_cents = i64::MAX / 2 + 1;
    half_a.line_subtotal_excl_vat_cents = i64::MAX / 2 + 1;
    half_a.line_vat_cents = 0;
    let half_b = PostSaleLine { sale_item_id: uuid(), ..crate::tests::builders::clone_sale_line(&half_a) };
    // A negative rate.
    let mut neg_rate = coffee(1);
    neg_rate.vat_rate_bps_snapshot = -1100;

    for lines in [vec![neg], vec![wrap], vec![half_a, half_b], vec![neg_rate]] {
        let mut p = sale_payload(lines, vec![cash_usd(1_000)]);
        p.shift_id = Some(shift.clone());
        p.cashier_user_id = Some(USER.to_string());
        assert!(post(&db, Role::Cashier, p).await.is_err());
    }
    assert_eq!(footprint(&db).await, before);
    db.cleanup().await.expect("remove TempDb");
}

// ---------------------------------------------------------------------------
// Idempotency survives
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_response_retry_of_a_valid_sale_posts_nothing_new() {
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![coffee(2), bread(1)]);
    let first = post(&db, Role::Cashier, replay_of(&p)).await.expect("first post");
    let after_first = footprint(&db).await;

    let again = post(&db, Role::Cashier, replay_of(&p)).await.expect("the replay reconciles");
    assert_eq!(again.receipt_number, first.receipt_number);
    assert_eq!(again.sale_id, first.sale_id);
    assert_eq!(footprint(&db).await, after_first, "one sale, one decrement, one number");

    // A retry of the same identity carrying a re-split line is a conflict,
    // not a second sale and not a rewrite of the first.
    let mut resplit = replay_of(&p);
    resplit.lines[0] = forged(resplit.lines[0].clone_line(), 1_801);
    assert!(post(&db, Role::Cashier, resplit).await.is_err());
    assert_eq!(footprint(&db).await, after_first);
    assert_eq!(persisted_line(&db, &p.sale_id, P_COFFEE).await, (1_802, 198, 2_000, 1100));
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_historical_sale_is_not_re_judged_by_the_new_rule_on_replay() {
    let (db, shift) = store(Role::Cashier).await;
    // Posted before GZ-VAT-1 with a split (1800 + 200) a NEW sale may no
    // longer carry.
    let legacy = payload(&shift, vec![forged(coffee(2), 1_800)]);
    seed_posted_sale_in_its_shift(&db, &legacy).await;
    let before = footprint(&db).await;

    // Its lost-response retry still returns its own receipt, unchanged.
    let r = post(&db, Role::Cashier, replay_of(&legacy)).await.expect("history replays");
    assert_eq!(r.receipt_number, 1);
    assert_eq!(footprint(&db).await, before);
    assert_eq!(persisted_line(&db, &legacy.sale_id, P_COFFEE).await, (1_800, 200, 2_000, 1100));

    // The same content under a NEW identity is a new sale, and is refused.
    let mut fresh = replay_of(&legacy);
    fresh.sale_id = uuid();
    assert_refused(&db, Role::Cashier, fresh, "1802 revenue + 198 VAT").await;
    db.cleanup().await.expect("remove TempDb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_check_reads_the_products_configuration_not_the_payload() {
    // Direct: the validator is driven by the database row alone.
    let (db, shift) = store(Role::Cashier).await;
    let p = payload(&shift, vec![coffee(1), bread(1)]);
    let mut tx = db.pool().begin().await.unwrap();
    validate_sale_vat_authority(&mut tx, &p).await.expect("honest lines pass");
    tx.rollback().await.unwrap();

    db.exec(&format!("UPDATE vat_rates SET rate_bps = 500 WHERE id = '{VAT_STD_ID}'")).await;
    let mut tx = db.pool().begin().await.unwrap();
    let err = validate_sale_vat_authority(&mut tx, &p).await.expect_err("the row moved");
    assert!(err.contains("configured at 500 bps"), "got: {err}");
    tx.rollback().await.unwrap();
    db.cleanup().await.expect("remove TempDb");
}

trait CloneLine {
    fn clone_line(&self) -> PostSaleLine;
}
impl CloneLine for PostSaleLine {
    fn clone_line(&self) -> PostSaleLine {
        crate::tests::builders::clone_sale_line(self)
    }
}
