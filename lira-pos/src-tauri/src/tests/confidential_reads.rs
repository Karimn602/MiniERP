//! STAGE C — CONFIDENTIAL READS (GZ-B3-R1).
//!
//! `db_select` still accepts SELECT text from the renderer. What changed is the
//! connection a CASHIER's text is compiled on: `read_api::read_pool_for_state`
//! resolves the tier from the session AND the user's own row, and a cashier
//! gets a pool whose authorizer refuses cost, COGS, purchasing, stock-ledger
//! and recipe data.
//!
//! These tests drive the REAL chokepoint (`read_pool_for_state`) and the REAL
//! body of the command (`run_select`) against a real migrated database. The
//! adversarial battery is the point: every spelling a cashier could try —
//! `*`, an alias, a CTE, a subquery, a view, an aggregate, an expression, a
//! quoted upper-case name — must be refused, and the queries the cashier's
//! three screens actually issue must still succeed, so the negatives are not
//! the vacuous result of a dead read channel.

use serde_json::Value;

use crate::auth::{Role, SessionState};
use crate::read_api::{read_pool_for_state, run_select, ReadPool};
use crate::test_support::TempDb;

const STORE: &str = "00000000-0000-0000-0000-000000000001";
const OWNER: &str = "00000000-0000-0000-0000-000000000002";
const CASHIER: &str = "00000000-0000-0000-0000-0000000000c1";
const MANAGER: &str = "00000000-0000-0000-0000-0000000000c2";

struct Harness {
    db: TempDb,
    state: crate::posting::DbState,
    reads: ReadPool,
    sessions: SessionState,
}

impl Harness {
    async fn new() -> Self {
        let db = TempDb::new().await;
        db.exec(&format!(
            "INSERT INTO users (id, store_id, full_name, role) VALUES
               ('{CASHIER}', '{STORE}', 'Sami', 'cashier'),
               ('{MANAGER}', '{STORE}', 'Rana', 'manager')"
        ))
        .await;
        // Something confidential to try to read: a product with a cost, a
        // posted-looking sale line is not needed — the authorizer refuses at
        // COMPILE time, so an empty table proves the refusal exactly as well.
        db.exec(&format!(
            "UPDATE products SET avg_cost_excl_vat_cents = 777, avg_cost_excl_vat_microcents = 777000000
              WHERE store_id = '{STORE}'"
        ))
        .await;
        let state = crate::posting::DbState::new();
        state.mark_startup_ready().await;
        Self {
            db,
            state,
            reads: ReadPool::new(),
            sessions: SessionState::new(),
        }
    }

    async fn sign_in(&self, user: &str, role: Role) {
        self.sessions.open_for_tests(user, STORE, role).await;
    }

    async fn select(&self, sql: &str, params: Vec<Value>) -> Result<usize, String> {
        let pool =
            read_pool_for_state(&self.state, &self.sessions, &self.reads, self.db.path()).await?;
        run_select(&pool, sql, params).await.map(|rows| rows.len())
    }

    async fn finish(self) {
        crate::read_api::close_read_pool(&self.reads).await;
        self.state.close_pool().await;
        self.db.cleanup().await.expect("remove TempDb");
    }
}

/// Every one of these must be REFUSED on a cashier's read channel.
const CASHIER_MUST_FAIL: &[&str] = &[
    // Cost columns, every spelling.
    "SELECT * FROM products",
    "SELECT p.* FROM products p",
    "SELECT avg_cost_excl_vat_microcents FROM products",
    "SELECT \"AVG_COST_EXCL_VAT_CENTS\" FROM products",
    "SELECT [avg_cost_incl_vat_cents] FROM products",
    "SELECT standard_cost_excl_vat_microcents FROM products",
    "SELECT name, avg_cost_excl_vat_cents * 2 AS x FROM products",
    "SELECT json_object('c', avg_cost_excl_vat_cents) FROM products",
    "SELECT name FROM products WHERE avg_cost_excl_vat_cents > 500",
    "SELECT name FROM products ORDER BY avg_cost_excl_vat_cents",
    "WITH x AS (SELECT * FROM products) SELECT name FROM x",
    "SELECT (SELECT max(avg_cost_excl_vat_cents) FROM products) AS leak",
    "SELECT name FROM products p WHERE EXISTS (SELECT 1 FROM products q WHERE q.id = p.id AND q.avg_cost_excl_vat_cents > 0)",
    "SELECT name FROM products UNION SELECT avg_cost_excl_vat_cents FROM products",
    // COGS on the sale documents.
    "SELECT * FROM sales",
    "SELECT SUM(cogs_total_cents) FROM sales",
    "SELECT * FROM sale_items",
    "SELECT unit_cogs_excl_vat_microcents FROM sale_items",
    "SELECT line_cogs_excl_vat_cents FROM sale_items",
    "SELECT cogs_source FROM sale_items",
    "SELECT * FROM sales_credit_memos",
    "SELECT SUM(cogs_reversed_cents) FROM sales_credit_memos",
    "SELECT * FROM sales_credit_memo_lines",
    // Whole tables.
    "SELECT * FROM purchases",
    "SELECT COUNT(*) FROM purchases",
    "SELECT * FROM purchase_items",
    "SELECT * FROM suppliers",
    "SELECT * FROM supplier_ledger",
    "SELECT * FROM supplier_balances",
    "SELECT * FROM inventory_movements",
    "SELECT COUNT(*) FROM inventory_movements",
    "SELECT * FROM recipes",
    "SELECT * FROM recipe_components",
    "SELECT * FROM sale_item_recipe_costs",
    "SELECT * FROM journal_entries",
    "SELECT * FROM sync_queue",
    // Another operator's reconciliation.
    "SELECT * FROM shifts",
    "SELECT expected_cash_usd_cents FROM shifts",
    "SELECT variance_usd_cents, variance_lbp FROM shifts",
    // Independent review (V1): with the COUNT readable, a variance is one
    // subtraction from readable tender rows; and the purchase sequence in
    // `app_settings` discloses purchasing activity.
    "SELECT closing_cash_usd_cents FROM shifts",
    "SELECT closing_cash_lbp FROM shifts",
    "SELECT value, updated_at FROM app_settings",
    "SELECT COUNT(*) FROM app_settings",
    // And the credential policy still holds on this tier.
    "SELECT pin_hash FROM users",
    "SELECT * FROM auth_audit",
];

/// The cashier screens' own reads, as the repos now spell them. Each must
/// SUCCEED on the cashier channel, or the boundary would be a broken till.
const CASHIER_MUST_PASS: &[&str] = &[
    // productsRepo (PRODUCT_PUBLIC_COLUMNS) and enrich.
    "SELECT id, store_id, sku, name, description, vat_rate_id, vat_pricing_mode,
            price_excl_vat_cents, price_incl_vat_cents, quantity_on_hand, reorder_point,
            is_active, is_service, category, icon, created_at, updated_at
       FROM products WHERE store_id = ? AND is_active = 1 ORDER BY name LIMIT 200",
    "SELECT id, product_id, uom_code, factor_num, factor_den, is_base, is_default_sale_uom,
            is_default_purchase_uom, is_active, sale_price_excl_vat_cents, sale_price_incl_vat_cents
       FROM product_uoms WHERE product_id = ? AND is_active = 1",
    "SELECT id, name, rate_bps, is_exempt, effective_from, effective_to FROM vat_rates WHERE id = ?",
    "SELECT id, store_id, product_id, barcode, lookup_value, barcode_type FROM product_barcodes WHERE store_id = ?",
    "SELECT COUNT(*) AS n FROM products WHERE store_id = ?",
    // The register's receipt and the shift screen.
    "SELECT id, receipt_number, total_incl_vat_cents FROM sales WHERE store_id = ?",
    "SELECT COUNT(*) AS receipt_count, COALESCE(SUM(total_incl_vat_cents), 0) FROM sales WHERE store_id = ?",
    "SELECT id, product_name_snapshot, quantity_in_uom, line_total_incl_vat_cents, kitchen_note FROM sale_items WHERE sale_id = ?",
    "SELECT * FROM sale_payments WHERE sale_id = ?",
    "SELECT id, store_id, status, opened_at, opening_cash_usd_cents, opening_cash_lbp FROM shifts WHERE store_id = ?",
    "SELECT COUNT(*) AS memo_count, COALESCE(SUM(total_incl_vat_cents), 0) FROM sales_credit_memos WHERE store_id = ?",
    "SELECT * FROM sales_credit_memo_refunds WHERE credit_memo_id = ?",
    // Drivers and the rate.
    "SELECT * FROM drivers WHERE store_id = ?",
    "SELECT * FROM driver_balances WHERE store_id = ?",
    "SELECT * FROM driver_ledger WHERE driver_id = ?",
    "SELECT * FROM shift_driver_cash",
    "SELECT id, store_id, effective_date, rate_lbp_per_usd FROM exchange_rates WHERE store_id = ?",
    "SELECT id, full_name, role FROM users WHERE store_id = ?",
];

fn params_for(sql: &str) -> Vec<Value> {
    let n = sql.matches('?').count();
    (0..n).map(|_| Value::String(STORE.to_string())).collect()
}

#[tokio::test]
async fn a_cashier_cannot_read_a_cost_however_the_query_is_spelled() {
    let h = Harness::new().await;
    h.sign_in(CASHIER, Role::Cashier).await;

    let mut leaked = Vec::new();
    for sql in CASHIER_MUST_FAIL {
        if let Ok(n) = h.select(sql, params_for(sql)).await {
            leaked.push(format!("{sql}  -> {n} row(s)"));
        }
    }
    assert!(
        leaked.is_empty(),
        "a cashier read channel answered confidential queries:\n{}",
        leaked.join("\n")
    );
    h.finish().await;
}

#[tokio::test]
async fn a_cashier_can_still_run_the_till() {
    let h = Harness::new().await;
    h.sign_in(CASHIER, Role::Cashier).await;

    let mut refused = Vec::new();
    for sql in CASHIER_MUST_PASS {
        if let Err(e) = h.select(sql, params_for(sql)).await {
            refused.push(format!("{sql}\n   -> {e}"));
        }
    }
    assert!(
        refused.is_empty(),
        "the cashier channel refused reads the till depends on:\n{}",
        refused.join("\n")
    );
    // And it returns DATA, not merely no error.
    let n = h
        .select("SELECT id, name, price_incl_vat_cents FROM products WHERE store_id = ?", params_for("?"))
        .await
        .expect("catalogue read");
    assert!(n > 0, "the demo catalogue is visible to a cashier");
    h.finish().await;
}

#[tokio::test]
async fn owners_and_managers_still_read_costs() {
    for (user, role) in [(OWNER, Role::Owner), (MANAGER, Role::Manager)] {
        let h = Harness::new().await;
        h.sign_in(user, role).await;
        for sql in [
            "SELECT * FROM products",
            "SELECT SUM(cogs_total_cents) FROM sales",
            "SELECT * FROM purchases",
            "SELECT * FROM supplier_balances",
            "SELECT * FROM sale_item_recipe_costs",
            "SELECT expected_cash_usd_cents, variance_usd_cents FROM shifts",
            "SELECT closing_cash_usd_cents, closing_cash_lbp FROM shifts",
            "SELECT key, value FROM app_settings",
        ] {
            h.select(sql, vec![])
                .await
                .unwrap_or_else(|e| panic!("{role:?} must read `{sql}`: {e}"));
        }
        // ...and the credential policy is unchanged on the staff tier.
        assert!(h.select("SELECT pin_hash FROM users", vec![]).await.is_err());
        h.finish().await;
    }
}

/// The tier is decided on EVERY read from the user's own row, so a demotion
/// takes effect on the next query — not at the next sign-in — and a session
/// that still SAYS manager cannot keep reading costs.
#[tokio::test]
async fn a_demotion_takes_effect_on_the_next_read() {
    let h = Harness::new().await;
    h.sign_in(MANAGER, Role::Manager).await;
    h.select("SELECT avg_cost_excl_vat_cents FROM products", vec![])
        .await
        .expect("a manager reads costs");

    h.db.exec(&format!("UPDATE users SET role = 'cashier' WHERE id = '{MANAGER}'"))
        .await;
    assert!(
        h.select("SELECT avg_cost_excl_vat_cents FROM products", vec![])
            .await
            .is_err(),
        "a demoted user's live session must lose cost visibility immediately"
    );
    h.finish().await;
}

/// The stricter of session and row wins in the other direction too: a cashier
/// session does not gain costs because the row was promoted underneath it.
#[tokio::test]
async fn a_cashier_session_does_not_widen_when_the_row_is_promoted() {
    let h = Harness::new().await;
    h.sign_in(CASHIER, Role::Cashier).await;
    h.db.exec(&format!("UPDATE users SET role = 'manager' WHERE id = '{CASHIER}'"))
        .await;
    assert!(h
        .select("SELECT avg_cost_excl_vat_cents FROM products", vec![])
        .await
        .is_err());
    h.finish().await;
}

/// A retired account's session gets no read channel at all — there is no
/// default tier to fall back to.
#[tokio::test]
async fn a_retired_account_gets_no_read_channel() {
    let h = Harness::new().await;
    h.sign_in(CASHIER, Role::Cashier).await;
    h.db.exec(&format!("UPDATE users SET active = 0 WHERE id = '{CASHIER}'"))
        .await;
    assert!(h
        .select("SELECT id, name FROM products", vec![])
        .await
        .is_err());
    h.finish().await;
}

/// The policy lists are what the source says they are, and the name rule
/// covers every cost column the schema actually has.
#[tokio::test]
async fn every_cost_column_in_the_schema_is_covered_by_the_name_rule() {
    let h = Harness::new().await;
    let pool = h.db.pool();
    let tables: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(pool)
    .await
    .expect("tables");
    let policy = crate::read_guard::policy_for_tests();
    let mut uncovered = Vec::new();
    for (table,) in tables {
        if policy.cashier_tables.iter().any(|t| t.eq_ignore_ascii_case(&table)) {
            continue;
        }
        let cols: Vec<(String,)> =
            sqlx::query_as(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .fetch_all(pool)
                .await
                .expect("columns");
        for (col,) in cols {
            let lc = col.to_ascii_lowercase();
            let looks_confidential = lc.contains("cost") || lc.contains("cogs") || lc.contains("margin") || lc.contains("profit");
            let covered = policy
                .cashier_fragments
                .iter()
                .any(|f| lc.contains(&f.to_ascii_lowercase()));
            if looks_confidential && !covered {
                uncovered.push(format!("{table}.{col}"));
            }
        }
    }
    assert!(uncovered.is_empty(), "uncovered confidential columns: {uncovered:?}");
    h.finish().await;
}
