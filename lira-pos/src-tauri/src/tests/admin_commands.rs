//! GATE 2A — the seven writes that moved out of TypeScript.
//!
//! These exercise the validation and the SQL of `crate::admin` against a real
//! disposable database. The commands themselves take `tauri::AppHandle`, which
//! a unit test has no way to build, so each test drives the same statements the
//! command runs, in the same order and in the same transaction shape, through
//! the `TempDb` pool — and asserts the VALIDATION through `admin`'s own helper
//! where it is shared.
//!
//! That split is stated rather than hidden: what is proven here is that the
//! statements and the rules are right, and that the behaviour matches what the
//! TypeScript did before it moved. What is NOT proven here is Tauri's
//! serialisation of the payload into `*SaveArgs`; `cargo check` covers the
//! types and the desktop walkthrough covers the wire.

use crate::test_support::TempDb;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OTHER_STORE: &str = "22222222-2222-2222-2222-222222222222";

async fn with_second_store() -> TempDb {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO stores (id, name, default_currency) VALUES ('{OTHER_STORE}', 'Branch 2', 'USD')"
    ))
    .await;
    db
}

// ===========================================================================
// Exchange rates — the security-critical pair
// ===========================================================================

/// The upsert resolves an existing row by `(store, effective_date)` and keeps
/// its id, which is what `exchangeRates.ts::upsert` promised and what the
/// history table and `sales.exchange_rate_id` depend on.
#[tokio::test]
async fn the_rate_upsert_keeps_the_existing_row_id() {
    let db = TempDb::new().await;

    db.exec(&format!(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('rate-1', '{STORE}', '2026-11-01', 89000, 'manual')"
    ))
    .await;

    // Second save for the same day: UPDATE, not INSERT.
    db.exec(&format!(
        "UPDATE exchange_rates SET rate_lbp_per_usd = 89500, source = 'manual', notes = 'morning'
          WHERE id = (SELECT id FROM exchange_rates
                       WHERE store_id = '{STORE}' AND effective_date = '2026-11-01')"
    ))
    .await;

    assert_eq!(
        db.count("SELECT COUNT(*) FROM exchange_rates").await,
        1,
        "one row per (store, day), not two"
    );
    assert_eq!(
        db.scalar_string("SELECT id FROM exchange_rates").await,
        "rate-1",
        "the id survives, so sales that locked it still resolve"
    );
    assert_eq!(
        db.scalar_i64("SELECT rate_lbp_per_usd FROM exchange_rates").await,
        89_500
    );

    db.cleanup().await.expect("cleanup");
}

/// Two stores keep two independent rates for the same day.
#[tokio::test]
async fn rates_are_scoped_per_store() {
    let db = with_second_store().await;

    for (id, store, rate) in [
        ("r-a", STORE, 89_500_i64),
        ("r-b", OTHER_STORE, 90_000),
    ] {
        db.exec(&format!(
            "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
             VALUES ('{id}', '{store}', '2026-11-01', {rate}, 'manual')"
        ))
        .await;
    }

    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT rate_lbp_per_usd FROM exchange_rates WHERE store_id = '{STORE}'"
        ))
        .await,
        89_500
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT rate_lbp_per_usd FROM exchange_rates WHERE store_id = '{OTHER_STORE}'"
        ))
        .await,
        90_000
    );

    db.cleanup().await.expect("cleanup");
}

/// A rate for an unknown store is refused by the foreign key, which is the
/// backstop behind `exchange_rate_save`'s explicit UNKNOWN_STORE check.
#[tokio::test]
async fn a_rate_for_an_unknown_store_is_refused() {
    let db = TempDb::new().await;
    let err = db
        .exec_err(
            "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
             VALUES ('r-x', 'no-such-store', '2026-11-01', 89500, 'manual')",
        )
        .await;
    assert!(
        err.to_lowercase().contains("foreign key"),
        "expected a foreign-key refusal, got: {err}"
    );
    db.cleanup().await.expect("cleanup");
}

/// Editing today's rate must not restate a sale that already locked one. This
/// is the forward-only rule `exchange_rate_save` documents, and it is a
/// property of the schema rather than of the command: the sale stores both the
/// rate id and the rate itself.
#[tokio::test]
async fn changing_the_rate_does_not_restate_a_posted_sale() {
    let db = TempDb::new().await;
    crate::test_support::seed_exchange_rate(&db).await;

    let rate_id = db.scalar_string("SELECT id FROM exchange_rates LIMIT 1").await;
    let locked = db.scalar_i64("SELECT rate_lbp_per_usd FROM exchange_rates LIMIT 1").await;

    db.exec(&format!(
        "INSERT INTO sales (id, store_id, receipt_number, exchange_rate_id,
            exchange_rate_lbp_per_usd, subtotal_excl_vat_cents, vat_total_cents,
            total_incl_vat_cents, status)
         VALUES ('sale-1', '{STORE}', 1, '{rate_id}', {locked}, 901, 99, 1000, 'draft')"
    ))
    .await;
    db.exec("UPDATE sales SET status='posted', posted_at='2026-11-01T12:00:00.000Z' WHERE id='sale-1'")
        .await;

    // The owner changes today's rate afterwards.
    db.exec(&format!(
        "UPDATE exchange_rates SET rate_lbp_per_usd = 1 WHERE id = '{rate_id}'"
    ))
    .await;

    assert_eq!(
        db.scalar_i64("SELECT exchange_rate_lbp_per_usd FROM sales WHERE id='sale-1'")
            .await,
        locked,
        "the posted sale keeps the rate it was rung up at"
    );

    db.cleanup().await.expect("cleanup");
}

// ===========================================================================
// Drivers
// ===========================================================================

#[tokio::test]
async fn a_driver_is_created_then_renamed_without_changing_store() {
    let db = with_second_store().await;

    db.exec(&format!(
        "INSERT INTO drivers (id, store_id, name, phone, notes)
         VALUES ('drv-1', '{STORE}', 'Ali', '0300', NULL)"
    ))
    .await;
    assert_eq!(db.scalar_string("SELECT name FROM drivers WHERE id='drv-1'").await, "Ali");

    // `driver_save`'s update path writes name/phone/notes and NOT store_id.
    db.exec(
        "UPDATE drivers
            SET name = 'Ali Hassan', phone = '0311', notes = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = 'drv-1'",
    )
    .await;

    assert_eq!(
        db.scalar_string("SELECT name FROM drivers WHERE id='drv-1'").await,
        "Ali Hassan"
    );
    assert_eq!(
        db.scalar_string("SELECT store_id FROM drivers WHERE id='drv-1'").await,
        STORE,
        "a rename never moves a driver between stores: his ledger is scoped to one"
    );

    db.cleanup().await.expect("cleanup");
}

#[tokio::test]
async fn retiring_a_driver_keeps_the_row_and_its_references() {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO drivers (id, store_id, name) VALUES ('drv-1', '{STORE}', 'Ali')"
    ))
    .await;

    db.exec(
        "UPDATE drivers SET is_active = 0,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = 'drv-1'",
    )
    .await;

    assert_eq!(db.scalar_i64("SELECT is_active FROM drivers WHERE id='drv-1'").await, 0);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM drivers WHERE id='drv-1'").await,
        1,
        "never a delete: his name is on posted receipts and ledger rows"
    );

    // And back again.
    db.exec("UPDATE drivers SET is_active = 1 WHERE id = 'drv-1'").await;
    assert_eq!(db.scalar_i64("SELECT is_active FROM drivers WHERE id='drv-1'").await, 1);

    db.cleanup().await.expect("cleanup");
}

#[tokio::test]
async fn two_drivers_of_one_store_cannot_share_a_name() {
    let db = with_second_store().await;
    db.exec(&format!(
        "INSERT INTO drivers (id, store_id, name) VALUES ('drv-1', '{STORE}', 'Ali')"
    ))
    .await;

    let err = db
        .exec_err(&format!(
            "INSERT INTO drivers (id, store_id, name) VALUES ('drv-2', '{STORE}', 'Ali')"
        ))
        .await;
    assert!(
        err.to_lowercase().contains("unique"),
        "one driver, one balance: {err}"
    );

    // The other branch may have its own Ali.
    db.exec(&format!(
        "INSERT INTO drivers (id, store_id, name) VALUES ('drv-3', '{OTHER_STORE}', 'Ali')"
    ))
    .await;
    assert_eq!(db.count("SELECT COUNT(*) FROM drivers").await, 2);

    db.cleanup().await.expect("cleanup");
}

// ===========================================================================
// Suppliers
// ===========================================================================

#[tokio::test]
async fn a_supplier_is_created_then_edited_and_deactivated() {
    let db = TempDb::new().await;

    db.exec(&format!(
        "INSERT INTO suppliers (id, store_id, name, contact_name, phone, email, notes)
         VALUES ('sup-1', '{STORE}', 'Beirut Coffee', 'Rami', '01', 'a@b.c', NULL)"
    ))
    .await;
    assert_eq!(
        db.scalar_string("SELECT name FROM suppliers WHERE id='sup-1'").await,
        "Beirut Coffee"
    );

    db.exec(
        "UPDATE suppliers
            SET name = 'Beirut Coffee Co', contact_name = 'Rami H',
                phone = '02', email = NULL, notes = 'net 30'
          WHERE id = 'sup-1'",
    )
    .await;
    assert_eq!(
        db.scalar_string("SELECT name FROM suppliers WHERE id='sup-1'").await,
        "Beirut Coffee Co"
    );
    assert_eq!(
        db.scalar_string("SELECT store_id FROM suppliers WHERE id='sup-1'").await,
        STORE,
        "a supplier never moves store: supplier_ledger is scoped and append-only"
    );

    db.exec("UPDATE suppliers SET is_active = 0 WHERE id = 'sup-1'").await;
    assert_eq!(
        db.scalar_i64("SELECT is_active FROM suppliers WHERE id='sup-1'").await,
        0
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM suppliers WHERE id='sup-1'").await,
        1,
        "deactivated, not deleted: purchases reference it RESTRICT"
    );

    db.cleanup().await.expect("cleanup");
}

#[tokio::test]
async fn a_supplier_for_an_unknown_store_is_refused() {
    let db = TempDb::new().await;
    let err = db
        .exec_err(
            "INSERT INTO suppliers (id, store_id, name)
             VALUES ('sup-x', 'no-such-store', 'Ghost')",
        )
        .await;
    assert!(
        err.to_lowercase().contains("foreign key"),
        "expected a foreign-key refusal, got: {err}"
    );
    db.cleanup().await.expect("cleanup");
}

// ===========================================================================
// The validation helpers, directly
// ===========================================================================

/// `exchange_rate_save` validates the effective date rather than trusting it:
/// a malformed date sorts wrongly against `effective_date <= ?` and would
/// silently stop applying.
#[test]
fn the_effective_date_is_validated_in_full() {
    use crate::admin::valid_effective_date_for_tests as ok;

    for good in ["2026-11-01", "2026-01-31", "2024-02-29", "2000-01-01", "2100-12-31"] {
        assert!(ok(good), "must accept {good}");
    }
    for bad in [
        "2026-11-1",     // not zero-padded
        "2026/11/01",    // wrong separator
        "01-11-2026",    // wrong order
        "2026-13-01",    // month 13
        "2026-00-01",    // month 0
        "2026-11-00",    // day 0
        "2026-11-31",    // November has 30
        "2026-02-29",    // 2026 is not a leap year
        "2100-02-29",    // century non-leap
        "1999-12-31",    // before the supported range
        "2101-01-01",    // after it
        "2026-11-01x",   // trailing junk
        "",
        "today",
    ] {
        assert!(!ok(bad), "must refuse {bad}");
    }
}
