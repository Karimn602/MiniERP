// src-tauri/src/posting.rs
//
// Transactional posting commands.
//
// Why this exists: tauri-plugin-sql's public API dispatches each execute()
// across a connection pool, which makes JS-side BEGIN/COMMIT unreliable
// (see plugins-workspace issue #886, still open). Multi-row writes that
// must atomically succeed-or-fail go through this module instead.
//
// Money convention (mirrors the JS side):
//   - All USD values are INTEGER cents.
//   - All quantities are INTEGER in the product's BASE UoM.
//   - All rate/bps are INTEGER.

use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool};
use tauri::{Manager, State};
use tokio::sync::Mutex;

// ============================================================================
// State
// ============================================================================

pub struct DbState {
    pub pool: Mutex<Option<SqlitePool>>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            pool: Mutex::new(None),
        }
    }
}

fn resolve_db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;
    Ok(dir.join("greaz-pos.db"))
}

async fn pool(
    app: &tauri::AppHandle,
    state: &State<'_, DbState>,
) -> Result<SqlitePool, String> {
    let mut guard = state.pool.lock().await;
    if let Some(p) = &*guard {
        return Ok(p.clone());
    }
    let path = resolve_db_path(app)?;
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let p = SqlitePool::connect(&url)
        .await
        .map_err(|e| format!("failed to open db pool at {}: {e}", path.display()))?;
    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(&p)
        .await
        .map_err(|e| format!("PRAGMA foreign_keys failed: {e}"))?;
    *guard = Some(p.clone());
    Ok(p)
}

// ============================================================================
// Payload types — purchase
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPurchasePayload {
    pub purchase_id: String,
    pub store_id: String,
    pub supplier_id: Option<String>,
    pub purchase_type: String,
    pub supplier_reference: Option<String>,
    pub purchase_date: String,
    pub created_by_user_id: Option<String>,
    pub device_id: Option<String>,
    pub notes: Option<String>,
    pub lines: Vec<PostPurchaseLine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPurchaseLine {
    pub purchase_item_id: String,
    pub product_id: String,
    pub product_name_snapshot: String,
    pub product_sku_snapshot: Option<String>,

    pub product_uom_id_snapshot: Option<String>,
    pub uom_code_snapshot: String,
    pub factor_num_snapshot: i64,
    pub factor_den_snapshot: i64,

    pub quantity_in_uom: i64,
    pub quantity_base: i64,

    pub unit_cost_excl_vat_in_uom_cents: i64,
    pub unit_cost_incl_vat_in_uom_cents: i64,
    pub unit_cost_excl_vat_base_cents: i64,
    pub unit_cost_incl_vat_base_cents: i64,

    pub vat_rate_id_snapshot: String,
    pub vat_rate_bps_snapshot: i64,

    pub line_subtotal_excl_vat_cents: i64,
    pub line_vat_cents: i64,
    pub line_total_incl_vat_cents: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPurchaseResult {
    pub purchase_id: String,
    pub purchase_number: i64,
    pub posted_at: String,
    pub movement_ids: Vec<String>,
    pub ledger_entry_id: Option<String>,
}

// ============================================================================
// Payload types — adjustment
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAdjustmentPayload {
    pub store_id: String,
    pub created_by_user_id: Option<String>,
    pub device_id: Option<String>,
    pub reason: String,
    pub lines: Vec<PostAdjustmentLine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAdjustmentLine {
    pub movement_id: String,
    pub product_id: String,
    pub uom_code_snapshot: String,
    pub factor_num_snapshot: i64,
    pub factor_den_snapshot: i64,
    pub quantity_in_uom_signed: i64,
    pub quantity_base_signed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAdjustmentResult {
    pub movement_ids: Vec<String>,
}

// ============================================================================
// Payload types — supplier payment (Phase 2D.6)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSupplierPaymentPayload {
    pub ledger_entry_id: String,
    pub store_id: String,
    pub supplier_id: String,
    pub entry_type: String,        // 'payment' | 'credit_note' | 'opening_balance' | 'adjustment'
    pub amount_cents: i64,         // SIGNED — caller decides the sign
    pub entry_date: String,        // YYYY-MM-DD
    pub payment_reference: Option<String>,
    pub notes: Option<String>,
    pub created_by_user_id: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSupplierPaymentResult {
    pub ledger_entry_id: String,
    pub posted_at: String,
    pub new_balance_cents: i64,
}

// ============================================================================
// Helpers
// ============================================================================

async fn next_purchase_number(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    _store_id: &str,
) -> Result<i64, String> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = 'next_purchase_number'")
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("read next_purchase_number: {e}"))?;
    let current: i64 = row
        .ok_or_else(|| "next_purchase_number missing from app_settings".to_string())?
        .try_get::<String, _>("value")
        .map_err(|e| format!("decode next_purchase_number: {e}"))?
        .parse()
        .map_err(|e| format!("parse next_purchase_number: {e}"))?;
    sqlx::query("UPDATE app_settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = 'next_purchase_number'")
        .bind((current + 1).to_string())
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("write next_purchase_number: {e}"))?;
    Ok(current)
}

pub(crate) fn new_weighted_avg(
    old_qty: i64,
    old_avg_cents: i64,
    new_qty: i64,
    new_cost_cents: i64,
) -> Result<i64, String> {
    let total_qty = old_qty + new_qty;
    if total_qty <= 0 {
        return Err("total quantity must be positive after purchase".into());
    }
    let total_value = old_qty
        .checked_mul(old_avg_cents)
        .and_then(|v| v.checked_add(new_qty.checked_mul(new_cost_cents)?))
        .ok_or_else(|| "weighted-avg overflow".to_string())?;
    let rounded = if total_value >= 0 {
        (total_value + total_qty / 2) / total_qty
    } else {
        (total_value - total_qty / 2) / total_qty
    };
    Ok(rounded)
}

async fn current_supplier_balance(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    supplier_id: &str,
) -> Result<i64, String> {
    let row = sqlx::query(
        "SELECT COALESCE(SUM(amount_cents), 0) AS bal FROM supplier_ledger WHERE supplier_id = ?",
    )
    .bind(supplier_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| format!("read supplier balance: {e}"))?;
    let bal: i64 = row.try_get("bal").map_err(|e| format!("decode balance: {e}"))?;
    Ok(bal)
}

// ============================================================================
// post_purchase
// ============================================================================

/// Pure pre-DB validation for `post_purchase`. Extracted verbatim (WP-01) so it
/// can be unit-tested; the command still runs it before acquiring the pool.
pub(crate) fn validate_purchase_payload(payload: &PostPurchasePayload) -> Result<(), String> {
    if payload.lines.is_empty() {
        return Err("Purchase must have at least one line.".into());
    }
    if payload.purchase_type != "normal" && payload.purchase_type != "opening" {
        return Err(format!("Invalid purchase_type: {}", payload.purchase_type));
    }
    if payload.purchase_type == "normal" && payload.supplier_id.is_none() {
        return Err("A normal purchase requires a supplier.".into());
    }
    for (i, line) in payload.lines.iter().enumerate() {
        if line.quantity_base <= 0 {
            return Err(format!("Line {} has non-positive base quantity.", i + 1));
        }
        if line.factor_num_snapshot <= 0 || line.factor_den_snapshot <= 0 {
            return Err(format!("Line {} has invalid UoM factor.", i + 1));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn post_purchase(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
    validate_purchase_payload(&payload)?;

    let pool = pool(&app, &state).await?;
    post_purchase_tx(&pool, payload).await
}

/// Validate-then-post against an already-resolved pool. Preserves the command's
/// ordering (validation first) and is the entry point the test harness uses.
#[cfg(test)]
pub(crate) async fn post_purchase_with_pool(
    pool: &SqlitePool,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
    validate_purchase_payload(&payload)?;
    post_purchase_tx(pool, payload).await
}

/// The transactional body of `post_purchase`, unchanged.
pub(crate) async fn post_purchase_tx(
    pool: &SqlitePool,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let purchase_number = next_purchase_number(&mut tx, &payload.store_id).await?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let subtotal: i64 = payload.lines.iter().map(|l| l.line_subtotal_excl_vat_cents).sum();
    let vat_total: i64 = payload.lines.iter().map(|l| l.line_vat_cents).sum();
    let total: i64 = payload.lines.iter().map(|l| l.line_total_incl_vat_cents).sum();

    sqlx::query(
    r#"INSERT INTO purchases (
         id, store_id, supplier_id, purchase_type, supplier_reference,
         purchase_number, purchase_date,
         subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
         status, created_by_user_id, device_id, posted_at, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL, ?)"#,
)
.bind(&payload.purchase_id)
.bind(&payload.store_id)
.bind(&payload.supplier_id)
.bind(&payload.purchase_type)
.bind(&payload.supplier_reference)
.bind(purchase_number)
.bind(&payload.purchase_date)
.bind(subtotal)
.bind(vat_total)
.bind(total)
.bind(&payload.created_by_user_id)
.bind(&payload.device_id)
.bind(&payload.notes)
.execute(&mut *tx)
.await
.map_err(|e| format!("insert purchase: {e}"))?;

    let mut movement_ids: Vec<String> = Vec::with_capacity(payload.lines.len());

    for line in &payload.lines {
        let purchase_item_id = if line.purchase_item_id.trim().is_empty() {
    uuid::Uuid::new_v4().to_string()
} else {
    line.purchase_item_id.clone()
};
        let row = sqlx::query(
            "SELECT quantity_on_hand, avg_cost_excl_vat_cents, avg_cost_incl_vat_cents
             FROM products WHERE id = ? AND store_id = ?",
        )
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product {}: {e}", line.product_id))?
        .ok_or_else(|| format!("Product {} not found in store {}", line.product_id, payload.store_id))?;

        let old_qty: i64 = row.try_get("quantity_on_hand").map_err(|e| format!("decode qoh: {e}"))?;
        let old_avg_excl: i64 = row.try_get("avg_cost_excl_vat_cents").map_err(|e| format!("decode avg_excl: {e}"))?;
        let old_avg_incl: i64 = row.try_get("avg_cost_incl_vat_cents").map_err(|e| format!("decode avg_incl: {e}"))?;

        let new_avg_excl = new_weighted_avg(
            old_qty, old_avg_excl, line.quantity_base, line.unit_cost_excl_vat_base_cents,
        )?;
        let new_avg_incl = new_weighted_avg(
            old_qty, old_avg_incl, line.quantity_base, line.unit_cost_incl_vat_base_cents,
        )?;

        let movement_id = uuid::Uuid::new_v4().to_string();
        movement_ids.push(movement_id.clone());

        // Order: movement first, then purchase_item (which references it).
        let movement_type = if payload.purchase_type == "opening" { "opening" } else { "purchase" };
        sqlx::query(
            r#"INSERT INTO purchase_items (
                 id, purchase_id, store_id, product_id,
                 product_name_snapshot, product_sku_snapshot,
                 product_uom_id_snapshot, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot,
                 quantity_in_uom, quantity_base,
                 unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
                 unit_cost_excl_vat_base_cents,  unit_cost_incl_vat_base_cents,
                 vat_rate_id_snapshot, vat_rate_bps_snapshot,
                 line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                 related_movement_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&purchase_item_id)
        .bind(&payload.purchase_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(&line.product_name_snapshot)
        .bind(&line.product_sku_snapshot)
        .bind(&line.product_uom_id_snapshot)
        .bind(&line.uom_code_snapshot)
        .bind(line.factor_num_snapshot)
        .bind(line.factor_den_snapshot)
        .bind(line.quantity_in_uom)
        .bind(line.quantity_base)
        .bind(line.unit_cost_excl_vat_in_uom_cents)
        .bind(line.unit_cost_incl_vat_in_uom_cents)
        .bind(line.unit_cost_excl_vat_base_cents)
        .bind(line.unit_cost_incl_vat_base_cents)
        .bind(&line.vat_rate_id_snapshot)
        .bind(line.vat_rate_bps_snapshot)
        .bind(line.line_subtotal_excl_vat_cents)
        .bind(line.line_vat_cents)
        .bind(line.line_total_incl_vat_cents)
        .bind(Option::<String>::None)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert purchase_item: {e}"))?;
        sqlx::query(
            r#"INSERT INTO inventory_movements (
                 id, store_id, product_id, movement_type, quantity_delta,
                 unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
                 related_purchase_id, related_purchase_item_id,
                 supplier_reference, notes,
                 created_by_user_id, device_id, posted_at,
                 quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&movement_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(movement_type)
        .bind(line.quantity_base)
        .bind(line.unit_cost_excl_vat_base_cents)
        .bind(line.unit_cost_incl_vat_base_cents)
        .bind(&payload.purchase_id)
        .bind(&purchase_item_id)
        .bind(&payload.supplier_reference)
        .bind(&payload.notes)
        .bind(&payload.created_by_user_id)
        .bind(&payload.device_id)
        .bind(&now)
        .bind(line.quantity_in_uom)
        .bind(&line.uom_code_snapshot)
        .bind(line.factor_num_snapshot)
        .bind(line.factor_den_snapshot)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert inventory_movement: {e}"))?;

        sqlx::query(
    r#"UPDATE purchase_items
          SET related_movement_id = ?
        WHERE id = ?"#,
)
.bind(&movement_id)
.bind(&purchase_item_id)
.execute(&mut *tx)
.await
.map_err(|e| format!("link purchase_item to movement: {e}"))?;

        sqlx::query(
            r#"UPDATE products
                  SET quantity_on_hand        = quantity_on_hand + ?,
                      avg_cost_excl_vat_cents = ?,
                      avg_cost_incl_vat_cents = ?
                WHERE id = ? AND store_id = ?"#,
        )
        .bind(line.quantity_base)
        .bind(new_avg_excl)
        .bind(new_avg_incl)
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update product stock/cost: {e}"))?;
    }

    // --- Ledger entry: only for 'normal' purchases with a supplier. ---
    let ledger_entry_id: Option<String> = if payload.purchase_type == "normal" {
        if let Some(supplier_id) = &payload.supplier_id {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                r#"INSERT INTO supplier_ledger (
                     id, store_id, supplier_id, entry_type, amount_cents,
                     entry_date, related_purchase_id, notes,
                     created_by_user_id, device_id, posted_at
                   ) VALUES (?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(&id)
            .bind(&payload.store_id)
            .bind(supplier_id)
            .bind(total) // positive = we owe more
            .bind(&payload.purchase_date)
            .bind(&payload.purchase_id)
            .bind(format!("Purchase #{}", purchase_number))
            .bind(&payload.created_by_user_id)
            .bind(&payload.device_id)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert supplier_ledger: {e}"))?;
            Some(id)
        } else {
            None
        }
    } else {
        None
    };
    sqlx::query(
    r#"UPDATE purchases
          SET status = 'posted',
              posted_at = ?
        WHERE id = ? AND store_id = ? AND status = 'draft'"#,
)
.bind(&now)
.bind(&payload.purchase_id)
.bind(&payload.store_id)
.execute(&mut *tx)
.await
.map_err(|e| format!("finalize purchase posting: {e}"))?;
    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;

    Ok(PostPurchaseResult {
        purchase_id: payload.purchase_id,
        purchase_number,
        posted_at: now,
        movement_ids,
        ledger_entry_id,
    })
}

// ============================================================================
// post_adjustment (unchanged from 2C)
// ============================================================================

/// Pure pre-DB validation for `post_adjustment`. Extracted verbatim (WP-01).
pub(crate) fn validate_adjustment_payload(payload: &PostAdjustmentPayload) -> Result<(), String> {
    if payload.lines.is_empty() {
        return Err("Adjustment must have at least one line.".into());
    }
    if payload.reason.trim().is_empty() {
        return Err("Adjustment reason is required.".into());
    }
    for (i, line) in payload.lines.iter().enumerate() {
        if line.quantity_base_signed == 0 {
            return Err(format!("Line {} has zero delta — drop the line instead.", i + 1));
        }
        if line.factor_num_snapshot <= 0 || line.factor_den_snapshot <= 0 {
            return Err(format!("Line {} has invalid UoM factor.", i + 1));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn post_adjustment(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostAdjustmentPayload,
) -> Result<PostAdjustmentResult, String> {
    validate_adjustment_payload(&payload)?;

    let pool = pool(&app, &state).await?;
    post_adjustment_tx(&pool, payload).await
}

/// Validate-then-post against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn post_adjustment_with_pool(
    pool: &SqlitePool,
    payload: PostAdjustmentPayload,
) -> Result<PostAdjustmentResult, String> {
    validate_adjustment_payload(&payload)?;
    post_adjustment_tx(pool, payload).await
}

/// The transactional body of `post_adjustment`, unchanged.
pub(crate) async fn post_adjustment_tx(
    pool: &SqlitePool,
    payload: PostAdjustmentPayload,
) -> Result<PostAdjustmentResult, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let mut movement_ids: Vec<String> = Vec::with_capacity(payload.lines.len());

    for line in &payload.lines {
        if line.quantity_base_signed < 0 {
            let row = sqlx::query(
                "SELECT quantity_on_hand FROM products WHERE id = ? AND store_id = ?",
            )
            .bind(&line.product_id)
            .bind(&payload.store_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| format!("read product for adjustment: {e}"))?
            .ok_or_else(|| format!("Product {} not found", line.product_id))?;
            let qoh: i64 = row.try_get("quantity_on_hand").map_err(|e| format!("decode qoh: {e}"))?;
            if qoh + line.quantity_base_signed < 0 {
                return Err(format!(
                    "Adjustment would drive stock negative for product {} (current {}, delta {}).",
                    line.product_id, qoh, line.quantity_base_signed
                ));
            }
        }

        let cost_row = sqlx::query(
            "SELECT avg_cost_excl_vat_cents, avg_cost_incl_vat_cents
             FROM products WHERE id = ? AND store_id = ?",
        )
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("read avg cost: {e}"))?;
        let avg_excl: i64 = cost_row.try_get("avg_cost_excl_vat_cents").map_err(|e| format!("decode: {e}"))?;
        let avg_incl: i64 = cost_row.try_get("avg_cost_incl_vat_cents").map_err(|e| format!("decode: {e}"))?;

        sqlx::query(
            r#"INSERT INTO inventory_movements (
                 id, store_id, product_id, movement_type, quantity_delta,
                 unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
                 notes,
                 created_by_user_id, device_id, posted_at,
                 quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot
               ) VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        
        .bind(&line.movement_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(line.quantity_base_signed)
        .bind(avg_excl)
        .bind(avg_incl)
        .bind(&payload.reason)
        .bind(&payload.created_by_user_id)
        .bind(&payload.device_id)
        .bind(&now)
        .bind(line.quantity_in_uom_signed)
        .bind(&line.uom_code_snapshot)
        .bind(line.factor_num_snapshot)
        .bind(line.factor_den_snapshot)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert adjustment movement: {e}"))?;

        sqlx::query(
            "UPDATE products SET quantity_on_hand = quantity_on_hand + ?
             WHERE id = ? AND store_id = ?",
        )
        .bind(line.quantity_base_signed)
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update qoh: {e}"))?;

        movement_ids.push(line.movement_id.clone());
    }

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(PostAdjustmentResult { movement_ids })
}

// ============================================================================
// post_supplier_payment (Phase 2D.6)
// ============================================================================

/// Pure pre-DB validation for `post_supplier_payment`. Extracted verbatim (WP-01).
pub(crate) fn validate_supplier_payment_payload(
    payload: &PostSupplierPaymentPayload,
) -> Result<(), String> {
    let allowed = ["payment", "credit_note", "opening_balance", "adjustment"];
    if !allowed.contains(&payload.entry_type.as_str()) {
        return Err(format!("Invalid entry_type for this command: {}", payload.entry_type));
    }
    if payload.amount_cents == 0 {
        return Err("Amount must be non-zero.".into());
    }
    if payload.entry_type == "adjustment" && payload.notes.as_deref().unwrap_or("").trim().is_empty() {
        return Err("Adjustment entries require a note explaining why.".into());
    }
    if payload.entry_date.trim().is_empty() {
        return Err("Entry date is required.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn post_supplier_payment(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostSupplierPaymentPayload,
) -> Result<PostSupplierPaymentResult, String> {
    validate_supplier_payment_payload(&payload)?;

    let pool = pool(&app, &state).await?;
    post_supplier_payment_tx(&pool, payload).await
}

/// Validate-then-post against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn post_supplier_payment_with_pool(
    pool: &SqlitePool,
    payload: PostSupplierPaymentPayload,
) -> Result<PostSupplierPaymentResult, String> {
    validate_supplier_payment_payload(&payload)?;
    post_supplier_payment_tx(pool, payload).await
}

/// The transactional body of `post_supplier_payment`, unchanged.
pub(crate) async fn post_supplier_payment_tx(
    pool: &SqlitePool,
    payload: PostSupplierPaymentPayload,
) -> Result<PostSupplierPaymentResult, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    sqlx::query(
        r#"INSERT INTO supplier_ledger (
             id, store_id, supplier_id, entry_type, amount_cents,
             entry_date, payment_reference, notes,
             created_by_user_id, device_id, posted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&payload.ledger_entry_id)
    .bind(&payload.store_id)
    .bind(&payload.supplier_id)
    .bind(&payload.entry_type)
    .bind(payload.amount_cents)
    .bind(&payload.entry_date)
    .bind(&payload.payment_reference)
    .bind(&payload.notes)
    .bind(&payload.created_by_user_id)
    .bind(&payload.device_id)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("insert supplier_ledger: {e}"))?;

    let new_balance = current_supplier_balance(&mut tx, &payload.supplier_id).await?;

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;

    Ok(PostSupplierPaymentResult {
        ledger_entry_id: payload.ledger_entry_id,
        posted_at: now,
        new_balance_cents: new_balance,
    })
}

// ============================================================================
// Payload types — sale (Phase 3 — POS Register v1)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSalePayload {
    pub sale_id: String,
    pub store_id: String,
    pub cashier_user_id: Option<String>,
    pub device_id: Option<String>,
    pub shift_id: Option<String>,

    // Exchange rate LOCKED at sale time. Required (even on USD-only sales) so
    // historical receipts can be reprinted with the rate that was in effect.
    pub exchange_rate_id: String,
    pub exchange_rate_lbp_per_usd: i64,

    pub notes: Option<String>,
    pub cogs_method: String,
    // Sale-level discount in USD cents (incl-VAT). JS allocates this
    // proportionally across lines and sends post-discount line values.
    pub discount_cents: i64,
    // When true, the per-line stock-availability guard is skipped so stock
    // can be driven below zero. Stock is still decremented normally.
    // Defaults to false for older payloads that omit the field.
    #[serde(default)]
    pub allow_negative_inventory: bool,
    pub lines: Vec<PostSaleLine>,
    pub payments: Vec<PostSalePayment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSaleLine {
    pub sale_item_id: String,
    pub product_id: String,
    pub product_name_snapshot: String,
    pub product_sku_snapshot: Option<String>,

    pub uom_code_snapshot: String,
    pub factor_num_snapshot: i64,
    pub factor_den_snapshot: i64,

    // Quantities — both stored. quantity_in_uom is what the cashier sees
    // (e.g. "2 boxes"); quantity_base is what we decrement (e.g. 24 pcs).
    pub quantity_in_uom: i64,
    pub quantity_base: i64,

    // Per-unit price snapshots in USD cents (excl- and incl-VAT) — already
    // resolved on the JS side via lib/uom.resolvePriceForUom for the chosen UoM.
    pub unit_price_excl_vat_cents: i64,
    pub unit_price_incl_vat_cents: i64,

    pub vat_rate_id_snapshot: String,
    pub vat_rate_bps_snapshot: i64,

    pub line_subtotal_excl_vat_cents: i64,
    pub line_vat_cents: i64,
    pub line_total_incl_vat_cents: i64,
    // Proportional share of the header discount_cents allocated to this line.
    pub line_discount_cents: i64,

    // Optional: which barcode was scanned to add the line (for the receipt).
    pub barcode_used_snapshot: Option<String>,
    pub barcode_type_snapshot: Option<String>,

    // Whether the CLIENT believes this product is a service. Accepted for wire
    // compatibility and never acted on: `post_sale` reads `products.is_service`
    // instead, so a parked cart holding a stale flag cannot suppress a stocked
    // product's inventory movement (GP-A05).
    #[allow(dead_code)]
    pub is_service: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSalePayment {
    pub payment_id: String,
    pub method: String,                       // 'cash_usd' | 'cash_lbp' | 'card_usd' | ...
    pub currency: String,                     // 'USD' | 'LBP'
    pub amount_native_usd_cents: i64,         // > 0 if currency == 'USD', else 0
    pub amount_native_lbp: i64,               // > 0 if currency == 'LBP', else 0
    pub amount_usd_cents_equivalent: i64,     // at the LOCKED rate
    pub reference: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSaleResult {
    pub sale_id: String,
    pub receipt_number: i64,
    pub posted_at: String,
    pub movement_ids: Vec<String>,
    pub change_total_usd_cents: i64,
}

// ============================================================================
// Helpers — sale
// ============================================================================

async fn next_receipt_number(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    _store_id: &str,
) -> Result<i64, String> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = 'next_receipt_number'")
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("read next_receipt_number: {e}"))?;
    let current: i64 = row
        .ok_or_else(|| "next_receipt_number missing from app_settings".to_string())?
        .try_get::<String, _>("value")
        .map_err(|e| format!("decode next_receipt_number: {e}"))?
        .parse()
        .map_err(|e| format!("parse next_receipt_number: {e}"))?;
    sqlx::query("UPDATE app_settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = 'next_receipt_number'")
        .bind((current + 1).to_string())
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("write next_receipt_number: {e}"))?;
    Ok(current)
}

// ============================================================================
// Checkout idempotency (GP-A01)
// ============================================================================
//
// `sales.id` IS the checkout identity. The client issues one `saleId` per
// checkout attempt and reuses it for every retry of that attempt (see
// `pages/PosRegister.tsx`), so the backend can tell "the cashier pressed F5
// twice" from "the next customer bought the same basket" — the latter arrives
// under a different identity and must still post.
//
// Idempotency is keyed on that identity ALONE. Nothing here looks at basket
// content, totals, or timing to decide whether two requests are the same
// checkout: content-based deduplication would silently swallow a second
// customer's money. Content is compared only to detect the opposite mistake —
// one identity reused for a materially different transaction.

/// The canonical business content of a sale: everything that decides WHAT
/// transaction was rung up, in a form that compares equal for a true retry and
/// unequal for anything materially different.
///
/// Deliberately EXCLUDED, because comparing them would reject honest retries:
///   - `sale_item_id` / `payment_id` — regenerated per request by
///     `db/repos/sales.ts::post`; they are request noise, not business content.
///   - the client's `quantity_base` and `is_service` — the backend derives both
///     from `product_uoms` and `products` (WP-02 GP-A02/GP-A05), so the payload
///     copies are non-authoritative. `quantity_in_uom` + `uom_code` are
///     compared instead, and the authoritative base follows from them.
///   - `cogs_total_cents` and per-line COGS — read from product cost at post
///     time, so a retry after a purchase would legitimately recompute them.
///   - `change_given_*` — derived from tender minus amount due.
///   - `receipt_number` / `posted_at` — assigned by the first post.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalSale {
    store_id: String,
    shift_id: Option<String>,
    cashier_user_id: Option<String>,
    device_id: Option<String>,
    exchange_rate_id: String,
    exchange_rate_lbp_per_usd: i64,
    cogs_method: String,
    notes: Option<String>,
    subtotal_excl_vat_cents: i64,
    vat_total_cents: i64,
    total_incl_vat_cents: i64,
    discount_cents: i64,
    /// Sorted, so a retry is not rejected merely because rows came back in a
    /// different order. Sorting a `Vec` of comparable values and comparing
    /// gives multiset equality, which is what "the same basket" means here.
    lines: Vec<CanonicalLine>,
    payments: Vec<CanonicalPayment>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CanonicalLine {
    product_id: String,
    uom_code: String,
    quantity_in_uom: i64,
    unit_price_excl_vat_cents: i64,
    unit_price_incl_vat_cents: i64,
    vat_rate_id: String,
    vat_rate_bps: i64,
    line_subtotal_excl_vat_cents: i64,
    line_vat_cents: i64,
    line_total_incl_vat_cents: i64,
    line_discount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CanonicalPayment {
    method: String,
    currency: String,
    amount_native_usd_cents: i64,
    amount_native_lbp: i64,
    amount_usd_cents_equivalent: i64,
    reference: Option<String>,
}

impl CanonicalSale {
    /// The canonical form of an incoming request. `subtotal`/`vat_total`/
    /// `total` come from `prepare_sale`, which sums them from the lines.
    fn from_payload(payload: &PostSalePayload, subtotal: i64, vat_total: i64, total: i64) -> Self {
        let mut lines: Vec<CanonicalLine> = payload
            .lines
            .iter()
            .map(|l| CanonicalLine {
                product_id: l.product_id.clone(),
                uom_code: l.uom_code_snapshot.clone(),
                quantity_in_uom: l.quantity_in_uom,
                unit_price_excl_vat_cents: l.unit_price_excl_vat_cents,
                unit_price_incl_vat_cents: l.unit_price_incl_vat_cents,
                vat_rate_id: l.vat_rate_id_snapshot.clone(),
                vat_rate_bps: l.vat_rate_bps_snapshot,
                line_subtotal_excl_vat_cents: l.line_subtotal_excl_vat_cents,
                line_vat_cents: l.line_vat_cents,
                line_total_incl_vat_cents: l.line_total_incl_vat_cents,
                line_discount_cents: l.line_discount_cents,
            })
            .collect();
        lines.sort();

        let mut payments: Vec<CanonicalPayment> = payload
            .payments
            .iter()
            .map(|p| CanonicalPayment {
                method: p.method.clone(),
                currency: p.currency.clone(),
                amount_native_usd_cents: p.amount_native_usd_cents,
                amount_native_lbp: p.amount_native_lbp,
                amount_usd_cents_equivalent: p.amount_usd_cents_equivalent,
                reference: p.reference.clone(),
            })
            .collect();
        payments.sort();

        Self {
            store_id: payload.store_id.clone(),
            shift_id: payload.shift_id.clone(),
            cashier_user_id: payload.cashier_user_id.clone(),
            device_id: payload.device_id.clone(),
            exchange_rate_id: payload.exchange_rate_id.clone(),
            exchange_rate_lbp_per_usd: payload.exchange_rate_lbp_per_usd,
            cogs_method: payload.cogs_method.clone(),
            notes: payload.notes.clone(),
            subtotal_excl_vat_cents: subtotal,
            vat_total_cents: vat_total,
            total_incl_vat_cents: total,
            discount_cents: payload.discount_cents,
            lines,
            payments,
        }
    }

    fn tendered_usd_cents(&self) -> i64 {
        self.payments.iter().map(|p| p.amount_usd_cents_equivalent).sum()
    }
}

/// What a posted sale looks like to a replayed request.
struct PostedSale {
    receipt_number: i64,
    posted_at: String,
    status: String,
    canonical: CanonicalSale,
}

/// Load the sale already stored under this checkout identity, if any, in the
/// same canonical form an incoming payload is reduced to.
async fn load_sale_by_identity(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    sale_id: &str,
) -> Result<Option<PostedSale>, String> {
    let header = sqlx::query(
        "SELECT store_id, shift_id, cashier_user_id, device_id,
                receipt_number, posted_at, status, notes,
                exchange_rate_id, exchange_rate_lbp_per_usd, cogs_method,
                subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents, discount_cents
           FROM sales WHERE id = ?",
    )
    .bind(sale_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read sale {sale_id}: {e}"))?;

    let Some(row) = header else { return Ok(None) };
    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");

    let mut lines: Vec<CanonicalLine> = sqlx::query(
        "SELECT product_id,
                COALESCE(uom_code_snapshot, '') AS uom_code_snapshot,
                COALESCE(quantity_in_uom, quantity) AS quantity_in_uom,
                unit_price_excl_vat_cents, unit_price_incl_vat_cents,
                vat_rate_id_snapshot, vat_rate_bps_snapshot,
                line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                line_discount_cents
           FROM sale_items WHERE sale_id = ?",
    )
    .bind(sale_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("read sale_items for {sale_id}: {e}"))?
    .into_iter()
    .map(|r| {
        Ok(CanonicalLine {
            product_id: r.try_get("product_id").map_err(d("product_id"))?,
            uom_code: r.try_get("uom_code_snapshot").map_err(d("uom_code"))?,
            quantity_in_uom: r.try_get("quantity_in_uom").map_err(d("quantity_in_uom"))?,
            unit_price_excl_vat_cents: r
                .try_get("unit_price_excl_vat_cents")
                .map_err(d("unit_price_excl"))?,
            unit_price_incl_vat_cents: r
                .try_get("unit_price_incl_vat_cents")
                .map_err(d("unit_price_incl"))?,
            vat_rate_id: r.try_get("vat_rate_id_snapshot").map_err(d("vat_rate_id"))?,
            vat_rate_bps: r.try_get("vat_rate_bps_snapshot").map_err(d("vat_rate_bps"))?,
            line_subtotal_excl_vat_cents: r
                .try_get("line_subtotal_excl_vat_cents")
                .map_err(d("line_subtotal"))?,
            line_vat_cents: r.try_get("line_vat_cents").map_err(d("line_vat"))?,
            line_total_incl_vat_cents: r
                .try_get("line_total_incl_vat_cents")
                .map_err(d("line_total"))?,
            line_discount_cents: r.try_get("line_discount_cents").map_err(d("line_discount"))?,
        })
    })
    .collect::<Result<Vec<_>, String>>()?;
    lines.sort();

    let mut payments: Vec<CanonicalPayment> = sqlx::query(
        "SELECT method, currency,
                amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
                reference
           FROM sale_payments WHERE sale_id = ?",
    )
    .bind(sale_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("read sale_payments for {sale_id}: {e}"))?
    .into_iter()
    .map(|r| {
        Ok(CanonicalPayment {
            method: r.try_get("method").map_err(d("method"))?,
            currency: r.try_get("currency").map_err(d("currency"))?,
            amount_native_usd_cents: r
                .try_get("amount_native_usd_cents")
                .map_err(d("amount_native_usd"))?,
            amount_native_lbp: r.try_get("amount_native_lbp").map_err(d("amount_native_lbp"))?,
            amount_usd_cents_equivalent: r
                .try_get("amount_usd_cents_equivalent")
                .map_err(d("amount_usd_equivalent"))?,
            reference: r.try_get("reference").map_err(d("reference"))?,
        })
    })
    .collect::<Result<Vec<_>, String>>()?;
    payments.sort();

    Ok(Some(PostedSale {
        receipt_number: row.try_get("receipt_number").map_err(d("receipt_number"))?,
        posted_at: row
            .try_get::<Option<String>, _>("posted_at")
            .map_err(d("posted_at"))?
            .unwrap_or_default(),
        status: row.try_get("status").map_err(d("status"))?,
        canonical: CanonicalSale {
            store_id: row.try_get("store_id").map_err(d("store_id"))?,
            shift_id: row.try_get("shift_id").map_err(d("shift_id"))?,
            cashier_user_id: row.try_get("cashier_user_id").map_err(d("cashier_user_id"))?,
            device_id: row.try_get("device_id").map_err(d("device_id"))?,
            exchange_rate_id: row
                .try_get::<Option<String>, _>("exchange_rate_id")
                .map_err(d("exchange_rate_id"))?
                .unwrap_or_default(),
            exchange_rate_lbp_per_usd: row
                .try_get("exchange_rate_lbp_per_usd")
                .map_err(d("exchange_rate"))?,
            cogs_method: row.try_get("cogs_method").map_err(d("cogs_method"))?,
            notes: row.try_get("notes").map_err(d("notes"))?,
            subtotal_excl_vat_cents: row
                .try_get("subtotal_excl_vat_cents")
                .map_err(d("subtotal"))?,
            vat_total_cents: row.try_get("vat_total_cents").map_err(d("vat_total"))?,
            total_incl_vat_cents: row.try_get("total_incl_vat_cents").map_err(d("total"))?,
            discount_cents: row.try_get("discount_cents").map_err(d("discount"))?,
            lines,
            payments,
        },
    }))
}

/// The one place that decides whether a replayed request is the SAME checkout
/// as the one already posted under this identity.
///
/// Returns `None` when the replay matches, or `Some((what, posted, replayed))`
/// naming the first material difference.
///
/// A true retry re-sends the same cart, so this returns `None` for one. It
/// fires when an identity is reused for a transaction nobody rang up under it —
/// which would otherwise hand back a receipt for the wrong sale.
fn sale_replay_matches_existing(
    posted: &CanonicalSale,
    replayed: &CanonicalSale,
) -> Option<(&'static str, String, String)> {
    macro_rules! compare {
        ($what:literal, $field:ident) => {
            if posted.$field != replayed.$field {
                return Some((
                    $what,
                    format!("{:?}", posted.$field),
                    format!("{:?}", replayed.$field),
                ));
            }
        };
    }

    // --- Attribution: who rang this up, where, and against which shift. ---
    compare!("store", store_id);
    compare!("shift", shift_id);
    compare!("cashier", cashier_user_id);
    compare!("device", device_id);

    // --- Monetary context locked at sale time. ---
    compare!("exchange rate", exchange_rate_id);
    compare!("exchange rate", exchange_rate_lbp_per_usd);
    compare!("COGS method", cogs_method);
    compare!("notes", notes);

    // --- Header money. ---
    compare!("subtotal", subtotal_excl_vat_cents);
    compare!("VAT total", vat_total_cents);
    compare!("total", total_incl_vat_cents);
    compare!("discount", discount_cents);

    // --- The basket, line for line: price, VAT code and rate, per-line VAT
    //     and discount allocation, not just the aggregate. Two carts can share
    //     a total and still be different transactions. ---
    if posted.lines != replayed.lines {
        let (was, now) = first_line_difference(&posted.lines, &replayed.lines);
        return Some(("basket line", was, now));
    }

    // --- The tender: method and currency, not just the USD-equivalent sum.
    //     Cash and card for the same amount are different transactions. ---
    if posted.payments != replayed.payments {
        let (was, now) = first_payment_difference(&posted.payments, &replayed.payments);
        return Some(("tender", was, now));
    }

    None
}

fn first_line_difference(posted: &[CanonicalLine], replayed: &[CanonicalLine]) -> (String, String) {
    if posted.len() != replayed.len() {
        return (format!("{} line(s)", posted.len()), format!("{} line(s)", replayed.len()));
    }
    for (a, b) in posted.iter().zip(replayed) {
        if a != b {
            return (format!("{a:?}"), format!("{b:?}"));
        }
    }
    (String::new(), String::new())
}

fn first_payment_difference(
    posted: &[CanonicalPayment],
    replayed: &[CanonicalPayment],
) -> (String, String) {
    if posted.len() != replayed.len() {
        return (format!("{} row(s)", posted.len()), format!("{} row(s)", replayed.len()));
    }
    for (a, b) in posted.iter().zip(replayed) {
        if a != b {
            return (format!("{a:?}"), format!("{b:?}"));
        }
    }
    (String::new(), String::new())
}

/// Refuse a replay that reuses a posted checkout identity for materially
/// different transaction content.
fn assert_replay_matches(
    existing: &PostedSale,
    payload: &PostSalePayload,
    subtotal: i64,
    vat_total: i64,
    total: i64,
) -> Result<(), String> {
    let replayed = CanonicalSale::from_payload(payload, subtotal, vat_total, total);
    match sale_replay_matches_existing(&existing.canonical, &replayed) {
        None => Ok(()),
        Some((what, was, now)) => Err(format!(
            "Sale {} already exists (receipt #{}) with a different {}: posted {}, replayed {}. \
             Start a new checkout instead of reusing this one.",
            payload.sale_id, existing.receipt_number, what, was, now
        )),
    }
}

/// Rebuild the original command result for an already-posted sale, so a retry
/// reconciles to the sale that exists instead of creating a second one.
async fn result_for_posted_sale(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    sale_id: &str,
    existing: &PostedSale,
) -> Result<PostSaleResult, String> {
    let movement_ids: Vec<String> = sqlx::query(
        "SELECT id FROM inventory_movements WHERE related_sale_id = ? ORDER BY rowid",
    )
    .bind(sale_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("read movements for {sale_id}: {e}"))?
    .into_iter()
    .map(|r| r.try_get::<String, _>("id").map_err(|e| format!("decode movement id: {e}")))
    .collect::<Result<Vec<_>, String>>()?;

    Ok(PostSaleResult {
        sale_id: sale_id.to_string(),
        receipt_number: existing.receipt_number,
        posted_at: existing.posted_at.clone(),
        movement_ids,
        // Recomputed the same way `prepare_sale` computed it originally:
        // tendered − amount due.
        change_total_usd_cents: existing.canonical.tendered_usd_cents()
            - existing.canonical.total_incl_vat_cents,
    })
}

// ============================================================================
// post_sale
// ============================================================================

/// Everything `post_sale` computes before it touches the database: validation,
/// the line/payment totals, and the change-allocation decision.
///
/// Extracted verbatim (WP-01) so it is unit-testable and so the Tauri command
/// still performs all of it *before* acquiring the pool, exactly as before.
#[derive(Debug)]
pub(crate) struct PreparedSale {
    pub cogs_method: String,
    pub subtotal: i64,
    pub vat_total: i64,
    pub total: i64,
    pub change_total_usd: i64,
    pub change_row_index: Option<usize>,
}

/// Per-line financial reconciliation (GP-A06).
///
/// The application's convention — see `lib/discount.ts::postDiscountLineTotals`
/// — is that a line's post-discount parts always satisfy
/// `subtotal_excl_vat + vat = total_incl_vat` in exact integer cents, and that
/// an exempt (0 bps) line carries no VAT at all. Anything else is an
/// internally inconsistent line: the header it sums into would be wrong, and
/// posted rows are immutable, so it has to be refused up front.
///
/// This deliberately does NOT re-derive the VAT split from the rate. Both
/// legitimate decompositions in the codebase (per-unit-then-multiply in
/// `lib/saleMath.ts`, total-then-strip in `lib/discount.ts`) can differ by a
/// cent while both reconciling, and WP-02 does not redesign VAT policy.
pub(crate) fn validate_line_financials(index: usize, line: &PostSaleLine) -> Result<(), String> {
    let n = index + 1;
    if line.line_subtotal_excl_vat_cents < 0
        || line.line_vat_cents < 0
        || line.line_total_incl_vat_cents < 0
    {
        return Err(format!("Line {} has a negative subtotal, VAT amount, or total.", n));
    }
    if line.vat_rate_bps_snapshot < 0 {
        return Err(format!("Line {} has a negative VAT rate.", n));
    }
    if line.line_discount_cents < 0 {
        return Err(format!("Line {} has a negative discount.", n));
    }
    let parts = line
        .line_subtotal_excl_vat_cents
        .checked_add(line.line_vat_cents)
        .ok_or_else(|| format!("Line {} overflows when its parts are summed.", n))?;
    if parts != line.line_total_incl_vat_cents {
        return Err(format!(
            "Line {} does not reconcile: subtotal {} + VAT {} != total {}.",
            n,
            line.line_subtotal_excl_vat_cents,
            line.line_vat_cents,
            line.line_total_incl_vat_cents
        ));
    }
    if line.vat_rate_bps_snapshot == 0 && line.line_vat_cents != 0 {
        return Err(format!(
            "Line {} does not reconcile: VAT of {} cents at an exempt (0 bps) rate.",
            n, line.line_vat_cents
        ));
    }
    Ok(())
}

/// Base-UoM quantity for `qty_in_uom` under the conversion factor `num/den`.
///
/// Mirrors `lib/uom.ts::toBaseQty` exactly — `round(qty × num ÷ den)`, half
/// away from zero — but in integer arithmetic, with no float step. Both inputs
/// are positive in every calling path, which is asserted rather than assumed.
pub(crate) fn derive_base_quantity(
    qty_in_uom: i64,
    factor_num: i64,
    factor_den: i64,
) -> Result<i64, String> {
    if qty_in_uom <= 0 {
        return Err("quantity in UoM must be positive".into());
    }
    if factor_num <= 0 || factor_den <= 0 {
        return Err("UoM conversion factor must be positive".into());
    }
    let scaled = qty_in_uom
        .checked_mul(factor_num)
        .ok_or_else(|| "UoM conversion overflows".to_string())?;
    let base = scaled
        .checked_add(factor_den / 2)
        .ok_or_else(|| "UoM conversion overflows".to_string())?
        / factor_den;
    if base <= 0 {
        return Err("UoM conversion yields a non-positive base quantity".into());
    }
    Ok(base)
}

pub(crate) fn prepare_sale(payload: &PostSalePayload) -> Result<PreparedSale, String> {
    // ---- Validation: header ----
    if payload.lines.is_empty() {
        return Err("Sale must have at least one line.".into());
    }
    if payload.payments.is_empty() {
        return Err("Sale must have at least one payment.".into());
    }
    if payload.exchange_rate_lbp_per_usd <= 0 {
        return Err("Exchange rate must be positive.".into());
    }

    let cogs_method = match payload.cogs_method.as_str() {
        "weighted_average" | "last_purchase" => payload.cogs_method.clone(),
        other => return Err(format!("Invalid COGS method: {}", other)),
    };

    if payload.discount_cents < 0 {
        return Err("discount_cents must be non-negative.".into());
    }

    // ---- Validation: lines ----
    for (i, line) in payload.lines.iter().enumerate() {
        if line.quantity_in_uom <= 0 || line.quantity_base <= 0 {
            return Err(format!("Line {} has non-positive quantity.", i + 1));
        }
        if line.factor_num_snapshot <= 0 || line.factor_den_snapshot <= 0 {
            return Err(format!("Line {} has invalid UoM factor.", i + 1));
        }
        if line.unit_price_excl_vat_cents < 0 || line.unit_price_incl_vat_cents < 0 {
            return Err(format!("Line {} has negative price.", i + 1));
        }
        validate_line_financials(i, line)?;
    }

    // ---- Validation: payments ----
    let allowed_methods = [
        "cash_usd", "cash_lbp", "card_usd", "card_lbp",
        "bank_transfer", "wallet", "store_credit", "other",
    ];
    for (i, p) in payload.payments.iter().enumerate() {
        if !allowed_methods.contains(&p.method.as_str()) {
            return Err(format!("Payment {} has invalid method: {}", i + 1, p.method));
        }
        if p.currency != "USD" && p.currency != "LBP" {
            return Err(format!("Payment {} has invalid currency: {}", i + 1, p.currency));
        }
        if p.amount_usd_cents_equivalent <= 0 {
            return Err(format!("Payment {} has non-positive amount.", i + 1));
        }
        // Enforce the same CHECK the schema enforces, so the error is friendly
        // (the trigger would otherwise raise a raw constraint error).
        let usd_ok = p.amount_native_usd_cents > 0
            && p.currency == "USD"
            && p.amount_native_lbp == 0;
        let lbp_ok = p.amount_native_lbp > 0
            && p.currency == "LBP"
            && p.amount_native_usd_cents == 0;
        if !(usd_ok || lbp_ok) {
            return Err(format!(
                "Payment {}: native amounts inconsistent with currency.",
                i + 1
            ));
        }
    }

    // ---- Totals from lines ----
    let subtotal: i64 = payload.lines.iter().map(|l| l.line_subtotal_excl_vat_cents).sum();
    let vat_total: i64 = payload.lines.iter().map(|l| l.line_vat_cents).sum();
    let total: i64 = payload.lines.iter().map(|l| l.line_total_incl_vat_cents).sum();
    if total <= 0 {
        return Err("Sale total must be positive.".into());
    }
    // The header is the sum of the lines, so this can only trip on overflow —
    // but the header invariant is the one reports rely on, so state it here.
    if subtotal + vat_total != total {
        return Err(format!(
            "Sale header does not reconcile: subtotal {} + VAT {} != total {}.",
            subtotal, vat_total, total
        ));
    }

    // ---- Discount reconciliation (GP-A07) ----
    // `lib/discount.ts::allocateLineDiscounts` distributes the header discount
    // across the lines to the exact cent (largest-remainder). Verify the
    // allocation we were handed instead of trusting it: a sale whose line
    // discounts do not add up to its header discount makes every downstream
    // report disagree with itself, and it is immutable once posted.
    let line_discount_total: i64 = payload.lines.iter().map(|l| l.line_discount_cents).sum();
    if line_discount_total != payload.discount_cents {
        return Err(format!(
            "Discount does not reconcile: the line discounts total {} cents but the sale header \
             declares a discount of {} cents.",
            line_discount_total, payload.discount_cents
        ));
    }

    // ---- Totals from payments ----
    let total_paid_usd: i64 = payload
        .payments
        .iter()
        .map(|p| p.amount_usd_cents_equivalent)
        .sum();
    if total_paid_usd < total {
        return Err(format!(
            "Underpayment: tendered {} USD-cents, total {} USD-cents.",
            total_paid_usd, total
        ));
    }
    let change_total_usd: i64 = total_paid_usd - total;

    // ---- Decide which payment row absorbs the change (if any) ----
    // Preference: first cash_usd → first cash_lbp → first row.
    let change_row_index: Option<usize> = if change_total_usd > 0 {
        payload
            .payments
            .iter()
            .position(|p| p.method == "cash_usd")
            .or_else(|| payload.payments.iter().position(|p| p.method == "cash_lbp"))
            .or(Some(0))
    } else {
        None
    };

    Ok(PreparedSale {
        cogs_method,
        subtotal,
        vat_total,
        total,
        change_total_usd,
        change_row_index,
    })
}

#[tauri::command]
pub async fn post_sale(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostSalePayload,
) -> Result<PostSaleResult, String> {
    let prepared = prepare_sale(&payload)?;

    // ---- Open transaction ----
    let pool = pool(&app, &state).await?;
    post_sale_tx(&pool, payload, prepared).await
}

/// Validate-then-post against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn post_sale_with_pool(
    pool: &SqlitePool,
    payload: PostSalePayload,
) -> Result<PostSaleResult, String> {
    let prepared = prepare_sale(&payload)?;
    post_sale_tx(pool, payload, prepared).await
}

/// One sale line after the database has had its say: the authoritative base
/// quantity, conversion factor, service flag, and COGS snapshot. Everything
/// written for a line comes from here, not from the payload.
struct ResolvedLine {
    quantity_base: i64,
    factor_num: i64,
    factor_den: i64,
    is_service: bool,
    unit_cogs_excl: i64,
    unit_cogs_incl: i64,
}

/// The transactional body of `post_sale`.
pub(crate) async fn post_sale_tx(
    pool: &SqlitePool,
    payload: PostSalePayload,
    prepared: PreparedSale,
) -> Result<PostSaleResult, String> {
    let PreparedSale {
        cogs_method,
        subtotal,
        vat_total,
        total,
        change_total_usd,
        change_row_index,
    } = prepared;
    let cogs_method = cogs_method.as_str();

    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    // ---- Idempotency: has this checkout identity already posted? ----
    // Runs before anything is written, and in particular before a receipt
    // number is consumed, so a replay costs the sequence nothing.
    if let Some(existing) = load_sale_by_identity(&mut tx, &payload.sale_id).await? {
        if existing.status != "posted" {
            return Err(format!(
                "Sale {} already exists with status '{}' and cannot be re-posted.",
                payload.sale_id, existing.status
            ));
        }
        assert_replay_matches(&existing, &payload, subtotal, vat_total, total)?;
        let result = result_for_posted_sale(&mut tx, &payload.sale_id, &existing).await?;
        // Nothing was written; end the transaction without a commit.
        tx.rollback().await.map_err(|e| format!("close replay tx: {e}"))?;
        return Ok(result);
    }

    let receipt_number = next_receipt_number(&mut tx, &payload.store_id).await?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // ---- Resolve every line against the database before writing anything.
    //      The product row and its product_uoms row — never the payload — decide
    //      the base quantity, the conversion factor, and whether the line moves
    //      physical stock. We also validate is_active and stock availability
    //      for non-service lines, and snapshot COGS.
    let mut resolved: Vec<ResolvedLine> = Vec::with_capacity(payload.lines.len());
    let mut cogs_total: i64 = 0;

    for (i, line) in payload.lines.iter().enumerate() {
        let row = sqlx::query(
            "SELECT quantity_on_hand,
                    avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
                    is_active, is_service
             FROM products WHERE id = ? AND store_id = ?",
        )
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product {} for sale: {e}", line.product_id))?
        .ok_or_else(|| {
            format!(
                "Line {}: product {} not found in store {}.",
                i + 1,
                line.product_id,
                payload.store_id
            )
        })?;

        let qoh: i64 = row
            .try_get("quantity_on_hand")
            .map_err(|e| format!("decode qoh: {e}"))?;
        let avg_cost_excl: i64 = row
            .try_get("avg_cost_excl_vat_cents")
            .map_err(|e| format!("decode avg_cost_excl: {e}"))?;
        let avg_cost_incl: i64 = row
            .try_get("avg_cost_incl_vat_cents")
            .map_err(|e| format!("decode avg_cost_incl: {e}"))?;
        let is_active: i64 = row
            .try_get("is_active")
            .map_err(|e| format!("decode is_active: {e}"))?;
        let is_service_db: i64 = row
            .try_get("is_service")
            .map_err(|e| format!("decode is_service: {e}"))?;

        if is_active == 0 {
            return Err(format!(
                "Line {}: product \"{}\" is inactive.",
                i + 1,
                line.product_name_snapshot
            ));
        }
        // The DB decides whether this product is a service (GP-A05). A parked
        // cart can hold a stale `isService: true` for a product that is stocked
        // today; letting the payload suppress the stock effects would walk goods
        // off the shelf with no movement row and no decrement.
        let is_service = is_service_db == 1;

        // ---- Authoritative UoM + base quantity (GP-A02) ----
        // The selected UoM must be one this product actually sells in, and the
        // base quantity is derived from ITS factor. A payload that understates
        // quantity_base ("2 boxes, but only 1 piece of stock, please") must not
        // be able to walk 24 pieces past the guard.
        let uom_row = sqlx::query(
            "SELECT factor_num, factor_den
               FROM product_uoms
              WHERE product_id = ? AND store_id = ? AND uom_code = ? AND is_active = 1",
        )
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .bind(&line.uom_code_snapshot)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product_uom for {}: {e}", line.product_id))?
        .ok_or_else(|| {
            format!(
                "Line {}: UoM \"{}\" is not an active unit of measure for \"{}\".",
                i + 1,
                line.uom_code_snapshot,
                line.product_name_snapshot
            )
        })?;
        let factor_num: i64 = uom_row
            .try_get("factor_num")
            .map_err(|e| format!("decode factor_num: {e}"))?;
        let factor_den: i64 = uom_row
            .try_get("factor_den")
            .map_err(|e| format!("decode factor_den: {e}"))?;
        let quantity_base = derive_base_quantity(line.quantity_in_uom, factor_num, factor_den)
            .map_err(|e| {
                format!(
                    "Line {}: invalid quantity for \"{}\" in UoM \"{}\" — {}.",
                    i + 1,
                    line.product_name_snapshot,
                    line.uom_code_snapshot,
                    e
                )
            })?;

        // The guard runs on the AUTHORITATIVE quantity, and before the payload
        // consistency check below: when there genuinely isn't enough stock, the
        // cashier needs to hear that, not a payload diagnostic.
        if !is_service && !payload.allow_negative_inventory && quantity_base > qoh {
            return Err(format!(
                "Line {}: insufficient stock for \"{}\" (have {}, need {} — {} {}).",
                i + 1,
                line.product_name_snapshot,
                qoh,
                quantity_base,
                line.quantity_in_uom,
                line.uom_code_snapshot
            ));
        }

        // A payload whose declared base quantity disagrees with the product's
        // own conversion is structurally corrupt (a stale cart, a changed
        // factor, a bad integration). Refuse it rather than post a quantity the
        // cashier never saw.
        if line.quantity_base != quantity_base {
            return Err(format!(
                "Line {}: declared base quantity {} does not match the authoritative UoM \
                 conversion for \"{}\" ({} {} × {}/{} = {}).",
                i + 1,
                line.quantity_base,
                line.product_name_snapshot,
                line.quantity_in_uom,
                line.uom_code_snapshot,
                factor_num,
                factor_den,
                quantity_base
            ));
        }

        let (unit_excl, unit_incl) = if is_service {
            (0, 0)
        } else if cogs_method == "last_purchase" {
            let last_cost_row = sqlx::query(
                "SELECT unit_cost_excl_vat_cents, unit_cost_incl_vat_cents
                   FROM inventory_movements
                  WHERE store_id = ?
                    AND product_id = ?
                    AND movement_type IN ('purchase', 'opening')
                    AND unit_cost_excl_vat_cents >= 0
                  ORDER BY posted_at DESC
                  LIMIT 1",
            )
            .bind(&payload.store_id)
            .bind(&line.product_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| format!("read last purchase cost for {}: {e}", line.product_id))?;

            if let Some(cost_row) = last_cost_row {
                let last_excl: i64 = cost_row
                    .try_get("unit_cost_excl_vat_cents")
                    .map_err(|e| format!("decode last_cost_excl: {e}"))?;
                let last_incl: i64 = cost_row
                    .try_get("unit_cost_incl_vat_cents")
                    .map_err(|e| format!("decode last_cost_incl: {e}"))?;
                (last_excl, last_incl)
            } else {
                // Fallback: products without a purchase/opening movement still use WAC.
                (avg_cost_excl, avg_cost_incl)
            }
        } else {
            (avg_cost_excl, avg_cost_incl)
        };

        cogs_total += unit_excl * quantity_base;
        resolved.push(ResolvedLine {
            quantity_base,
            factor_num,
            factor_den,
            is_service,
            unit_cogs_excl: unit_excl,
            unit_cogs_incl: unit_incl,
        });
    }

    // ---- Insert sale header ----
    sqlx::query(
        r#"INSERT INTO sales (
             id, store_id, shift_id, device_id, cashier_user_id,
             receipt_number,
             exchange_rate_lbp_per_usd, exchange_rate_id,
             subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
             discount_cents, cogs_total_cents, cogs_method,
             sale_type, status, posted_at, notes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'posted', ?, ?)"#,
    )
    .bind(&payload.sale_id)
    .bind(&payload.store_id)
    .bind(&payload.shift_id)
    .bind(&payload.device_id)
    .bind(&payload.cashier_user_id)
    .bind(receipt_number)
    .bind(payload.exchange_rate_lbp_per_usd)
    .bind(&payload.exchange_rate_id)
    .bind(subtotal)
    .bind(vat_total)
    .bind(total)
    .bind(payload.discount_cents)
    .bind(cogs_total)
    .bind(cogs_method)
    .bind(&now)
    .bind(&payload.notes)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("insert sale: {e}"))?;

    // ---- Insert each line + matching inventory_movement (stock only) ----
    let mut movement_ids: Vec<String> = Vec::new();

    for (i, line) in payload.lines.iter().enumerate() {
        let r = &resolved[i];
        let unit_cogs_excl = r.unit_cogs_excl;
        let unit_cogs_incl = r.unit_cogs_incl;
        let line_cogs = unit_cogs_excl * r.quantity_base;

        sqlx::query(
            r#"INSERT INTO sale_items (
                 id, sale_id, store_id, product_id,
                 product_name_snapshot, product_sku_snapshot,
                 vat_rate_id_snapshot, vat_rate_bps_snapshot,
                 quantity,
                 unit_price_excl_vat_cents, unit_price_incl_vat_cents,
                 line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                 line_discount_cents,
                 unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
                 barcode_used_snapshot, barcode_type_snapshot,
                 quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&line.sale_item_id)
        .bind(&payload.sale_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(&line.product_name_snapshot)
        .bind(&line.product_sku_snapshot)
        .bind(&line.vat_rate_id_snapshot)
        .bind(line.vat_rate_bps_snapshot)
        .bind(r.quantity_base) // sale_items.quantity is the canonical base qty
        .bind(line.unit_price_excl_vat_cents)
        .bind(line.unit_price_incl_vat_cents)
        .bind(line.line_subtotal_excl_vat_cents)
        .bind(line.line_vat_cents)
        .bind(line.line_total_incl_vat_cents)
        .bind(line.line_discount_cents)
        .bind(unit_cogs_excl)
        .bind(line_cogs)
        .bind(&line.barcode_used_snapshot)
        .bind(&line.barcode_type_snapshot)
        .bind(line.quantity_in_uom)
        .bind(&line.uom_code_snapshot)
        .bind(r.factor_num)
        .bind(r.factor_den)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert sale_item: {e}"))?;

        // Services don't move stock or generate inventory_movements rows.
        // The DB's is_service decides, never the payload's (GP-A05).
        if !r.is_service {
            let movement_id = uuid::Uuid::new_v4().to_string();
            movement_ids.push(movement_id.clone());

            sqlx::query(
                r#"INSERT INTO inventory_movements (
                     id, store_id, product_id, movement_type, quantity_delta,
                     unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
                     related_sale_id, related_sale_item_id,
                     notes,
                     created_by_user_id, device_id, posted_at,
                     quantity_in_uom, uom_code_snapshot,
                     factor_num_snapshot, factor_den_snapshot
                   ) VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(&movement_id)
            .bind(&payload.store_id)
            .bind(&line.product_id)
            .bind(-r.quantity_base) // sale = stock OUT
            .bind(unit_cogs_excl)
            .bind(unit_cogs_incl)
            .bind(&payload.sale_id)
            .bind(&line.sale_item_id)
            .bind(format!("Sale #{}", receipt_number))
            .bind(&payload.cashier_user_id)
            .bind(&payload.device_id)
            .bind(&now)
            .bind(line.quantity_in_uom)
            .bind(&line.uom_code_snapshot)
            .bind(r.factor_num)
            .bind(r.factor_den)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert sale inventory_movement: {e}"))?;

            sqlx::query(
                "UPDATE products
                    SET quantity_on_hand = quantity_on_hand - ?
                  WHERE id = ? AND store_id = ?",
            )
            .bind(r.quantity_base)
            .bind(&line.product_id)
            .bind(&payload.store_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("decrement product stock: {e}"))?;
        }
    }

    // ---- Insert each payment row. Attach change_given to the chosen row. ----
    for (i, p) in payload.payments.iter().enumerate() {
        let (change_usd_for_row, change_lbp_for_row) = if Some(i) == change_row_index {
            // Express change in this row's native currency.
            if p.currency == "USD" {
                (change_total_usd, 0i64)
            } else {
                // LBP: convert USD-cents → LBP using the LOCKED rate.
                // lbp = round(usd_cents * rate / 100)
                let rate = payload.exchange_rate_lbp_per_usd;
                let lbp = (change_total_usd * rate + 50) / 100; // round-half-up
                (0i64, lbp)
            }
        } else {
            (0i64, 0i64)
        };

        sqlx::query(
            r#"INSERT INTO sale_payments (
                 id, sale_id, store_id,
                 method, currency,
                 amount_native_usd_cents, amount_native_lbp,
                 amount_usd_cents_equivalent,
                 change_given_usd_cents, change_given_lbp,
                 reference
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&p.payment_id)
        .bind(&payload.sale_id)
        .bind(&payload.store_id)
        .bind(&p.method)
        .bind(&p.currency)
        .bind(p.amount_native_usd_cents)
        .bind(p.amount_native_lbp)
        .bind(p.amount_usd_cents_equivalent)
        .bind(change_usd_for_row)
        .bind(change_lbp_for_row)
        .bind(&p.reference)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert sale_payment: {e}"))?;
    }

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;

    Ok(PostSaleResult {
        sale_id: payload.sale_id,
        receipt_number,
        posted_at: now,
        movement_ids,
        change_total_usd_cents: change_total_usd,
    })
}