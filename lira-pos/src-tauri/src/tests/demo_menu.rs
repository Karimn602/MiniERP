// ============================================================================
// The Greaz demonstration menu (WP-3 E)
// ============================================================================
//
// `fixtures/greaz_menu_seed.sql` is generated from the approved design fixture
// and is for DISPOSABLE databases only. These tests apply it to a `TempDb` —
// never to any application identity — and check two things: that it loads
// cleanly into the real schema, and that it is honest about what it does not
// contain.
//
// It lives BESIDE THE TEST that consumes it rather than in `dev/`, which is
// where it was generated. The test compiles it in with `include_str!`, so its
// location is a build dependency of the Rust suite: a checkpoint that shipped
// the test without the file would not compile from a clean clone. `dev/` holds
// developer tooling that is deliberately not committed, so a compiled-in
// fixture could not stay there. Note that `dev/generate_greaz_menu_seed.py`
// still writes to `dev/`, so regenerating the seed means copying it here —
// which this test would catch, because it asserts on the content it compiled.
//
// The second half matters more than the first. A demonstration catalogue that
// looked complete would invite someone to read a margin off it, and the
// fixture supplies no cost at all.

use crate::test_support::*;

const P_COFFEE: &str = "00000000-0000-0000-0000-0000000000c1";

/// The generated seed, compiled in so the test cannot drift from the file.
const GREAZ_MENU_SEED: &str = include_str!("fixtures/greaz_menu_seed.sql");

/// Apply the seed to a disposable database — never to any application identity.
///
/// The file is a script with its own `BEGIN`/`COMMIT`, so it is split and run
/// statement by statement; `TempDb::exec` takes one statement at a time.
async fn seeded_demo_menu() -> TempDb {
    let db = TempDb::new().await;
    for chunk in GREAZ_MENU_SEED.split(";\n") {
        // Each chunk carries the comment lines that PRECEDE its statement, so
        // comments are stripped rather than used to skip the chunk. Testing
        // `starts_with("--")` on the whole chunk silently discarded every
        // product INSERT, because each one is introduced by a comment — and
        // the failure surfaced two statements later as a foreign-key error on
        // a product that had never been inserted.
        let sql = chunk
            .lines()
            .filter(|l| !l.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        let sql = sql.trim();
        if sql.is_empty() {
            continue;
        }
        // Transaction control belongs to the script, not to this harness.
        if sql.eq_ignore_ascii_case("BEGIN") || sql.eq_ignore_ascii_case("COMMIT") {
            continue;
        }
        if let Err(e) = db.try_exec(sql).await {
            panic!("seed statement failed: {e}\n--- statement ---\n{sql}\n---");
        }
    }
    db
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_demo_menu_loads_into_the_real_schema() {
    let db = seeded_demo_menu().await;

    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE id LIKE 'GZ-%'").await,
        17,
        "every fixture item is present"
    );

    // Each product has the UoM rows the catalogue loader insists on. Without a
    // base AND a default sale UoM, `productsRepo.enrich` refuses the product —
    // and refuses it while loading the LIST, which takes the whole Products
    // page down for one bad row.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM products p
              WHERE p.id LIKE 'GZ-%'
                AND EXISTS (SELECT 1 FROM product_uoms u
                             WHERE u.product_id = p.id AND u.is_base = 1 AND u.is_active = 1)
                AND EXISTS (SELECT 1 FROM product_uoms u
                             WHERE u.product_id = p.id AND u.is_default_sale_uom = 1
                               AND u.is_active = 1)"
        )
        .await,
        17,
        "every product is loadable"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_demo_menu_is_categorised_the_way_the_register_groups_it() {
    let db = seeded_demo_menu().await;

    for (category, expected) in [
        ("burgers", 3),
        ("wraps", 1),
        ("sides", 7),
        ("addons", 4),
        ("drinks", 2),
    ] {
        assert_eq!(
            db.count(&format!(
                "SELECT COUNT(*) FROM products WHERE id LIKE 'GZ-%' AND category = '{category}'"
            ))
            .await,
            expected,
            "{category}"
        );
    }

    // No product lands outside the sections the register knows, which is what
    // the generator's explicit label map exists to guarantee: a renamed design
    // label fails the generator rather than producing a silent "Other" bucket.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM products
              WHERE id LIKE 'GZ-%'
                AND (category IS NULL
                     OR category NOT IN ('burgers','wraps','sides','addons','drinks'))"
        )
        .await,
        0
    );

    // And every one carries an icon, so no tile falls back in the demo.
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE id LIKE 'GZ-%' AND icon IS NOT NULL").await,
        17
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_demo_menu_prices_match_the_approved_fixture_to_the_cent() {
    let db = seeded_demo_menu().await;

    // Spot-checked against the printed menu via the fixture, including the one
    // item priced below a dollar — the case where a float would have rounded
    // the wrong way.
    for (code, incl) in [
        ("GZ-BUR-DOUBLE", 600),
        ("GZ-BUR-TRIPLE", 800),
        ("GZ-BUR-CHICKEN", 600),
        ("GZ-WRP-BONELESS", 600),
        ("GZ-SID-FRIES", 300),
        ("GZ-SID-ONION", 500),
        ("GZ-ADD-CHEDDAR", 100),
        ("GZ-DRK-WATER", 50),
    ] {
        assert_eq!(
            db.scalar_i64(&format!(
                "SELECT price_incl_vat_cents FROM products WHERE id = '{code}'"
            ))
            .await,
            incl,
            "{code}"
        );
    }

    // The excl-VAT figure is DERIVED from the store's own `vat_rates` row by
    // the seed, so it cannot encode a VAT split that disagrees with the rate
    // the application will charge. At 11%: $6.00 incl -> $5.41 excl.
    assert_eq!(
        db.scalar_i64("SELECT price_excl_vat_cents FROM products WHERE id = 'GZ-BUR-DOUBLE'")
            .await,
        541
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_demo_menu_claims_no_cost_and_no_stock() {
    // The honesty assertions, and the reason this test file exists.
    //
    // The fixture specifies neither cost nor stock, so the seed invents
    // neither. Anyone reading a margin off this catalogue is reading the
    // absence of costing, and a test that pinned a non-zero cost here would be
    // manufacturing the very evidence the brief says not to manufacture.
    let db = seeded_demo_menu().await;

    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM products
              WHERE id LIKE 'GZ-%'
                AND (avg_cost_excl_vat_microcents != 0
                     OR avg_cost_incl_vat_microcents != 0
                     OR avg_cost_excl_vat_cents != 0
                     OR avg_cost_incl_vat_cents != 0)"
        )
        .await,
        0,
        "no product carries a cost: NONE WAS SUPPLIED"
    );

    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE id LIKE 'GZ-%' AND quantity_on_hand != 0")
            .await,
        0,
        "no product carries opening stock: inventing one would invent an asset"
    );

    // And no movement was fabricated to justify either, which is what keeps
    // SUM(quantity_delta) reconciling to quantity_on_hand.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM inventory_movements
              WHERE product_id LIKE 'GZ-%'"
        )
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_in_the_demo_menu_is_marked_as_a_service() {
    // The fixture does not classify items, so the seed classifies nothing.
    // Marking real food as a service would let it sell below zero with no
    // stock record at all — a silent mis-statement of inventory, which is
    // strictly worse than defaulting everything to tracked and saying so.
    let db = seeded_demo_menu().await;

    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE id LIKE 'GZ-%' AND is_service = 1").await,
        0,
        "every demo product is a TRACKED inventory product"
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE id LIKE 'GZ-%' AND is_service = 0").await,
        17
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_demo_menu_omits_the_two_items_with_no_unambiguous_price() {
    // "Combo upgrade" is a modifier on another order, and "Smash Burger
    // single" had no single-item price on the supplied menu. Both are in the
    // fixture's `specials_to_model_later`. Seeding either would mean inventing
    // a price for a real restaurant.
    let db = seeded_demo_menu().await;

    for absent in ["%Combo%", "%Smash%"] {
        assert_eq!(
            db.count(&format!("SELECT COUNT(*) FROM products WHERE name LIKE '{absent}'")).await,
            0,
            "{absent} must not be invented"
        );
    }
}
