// src-tauri/src/posting.rs
//
// Transactional posting commands.
//
// Why this exists: tauri-plugin-sql's public API dispatches each execute()
// across a connection pool, which makes JS-side BEGIN/COMMIT unreliable
// (see plugins-workspace issue #886, still open). Multi-row writes that
// must atomically succeed-or-fail go through this module instead.
//
// We acquire one sqlx connection from the pool, run everything inside a
// single sqlx::Transaction, and commit or roll back as a unit. The frontend
// invokes these via tauri::command and sees a single all-or-nothing result.
//
// Money convention (mirrors the JS side):
//   - All USD values are INTEGER cents.
//   - All quantities are INTEGER in the product's BASE UoM.
//   - All rate/bps are INTEGER.

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Row, Sqlite, SqlitePool};
use tauri::{Manager, State};
use tokio::sync::Mutex;

// ============================================================================
// State — a shared sqlx pool we open ourselves, so we can run real
// transactions. The tauri-plugin-sql plugin opens its own pool for the
// regular query/execute path; this is a SECOND pool against the same file.
// SQLite is happy with multiple connections in WAL mode (which we set in
// ensureDbReady on the JS side).
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

/// Resolve the sqlite file the plugin uses. The plugin stores it in
/// `BaseDirectory::App` under the bare filename from the "sqlite:..." URL.
fn resolve_db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;
    Ok(dir.join("lira-pos.db"))
}

/// Lazily open the pool on first call. Idempotent — the plugin has already
/// run migrations before we get here, so we just connect.
async fn pool<'a>(
    app: &tauri::AppHandle,
    state: &'a State<'_, DbState>,
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
    // Match the JS-side PRAGMAs.
    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(&p)
        .await
        .map_err(|e| format!("PRAGMA foreign_keys failed: {e}"))?;
    *guard = Some(p.clone());
    Ok(p)
}

// ============================================================================
// Shared payload types
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPurchasePayload {
    pub purchase_id: String,
    pub store_id: String,
    pub supplier_id: Option<String>,
    pub purchase_type: String,        // 'normal' | 'opening'
    pub supplier_reference: Option<String>,
    pub purchase_date: String,        // YYYY-MM-DD
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAdjustmentPayload {
    pub store_id: String,
    pub created_by_user_id: Option<String>,
    pub device_id: Option<String>,
    pub reason: String,           // mandatory — UI enforces non-empty
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
    pub quantity_in_uom_signed: i64,   // signed; +5 added, -3 removed
    pub quantity_base_signed: i64,     // signed; ditto, in base UoM
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAdjustmentResult {
    pub movement_ids: Vec<String>,
}

// ============================================================================
// Helpers
// ============================================================================

/// Atomically grab and increment the next purchase number for a store.
/// We use a separate row per store in app_settings — for the MVP there's
/// only one store, but the function is forward-compatible.
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

/// Weighted-average cost recompute, integer math:
///   new_avg = round((old_qty * old_avg + new_qty * new_cost) / total_qty)
/// Mirrors `newWeightedAvgCost` in src/lib/money.ts — keep them in sync.
fn new_weighted_avg(
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
    // Half-away-from-zero rounding to match JS Math.round
    let rounded = if total_value >= 0 {
        (total_value + total_qty / 2) / total_qty
    } else {
        (total_value - total_qty / 2) / total_qty
    };
    Ok(rounded)
}

// ============================================================================
// Commands
// ============================================================================

#[tauri::command]
pub async fn post_purchase(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
    // --- Validate up front; cheaper than rolling back. ---
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

    let pool = pool(&app, &state).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    // --- 1. Allocate purchase number + insert header. ---
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

    // --- 2. For each line: insert purchase_item, insert movement, update product. ---
    let mut movement_ids: Vec<String> = Vec::with_capacity(payload.lines.len());

    for line in &payload.lines {
        // Read current stock + avg cost for weighted-avg recompute.
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

        // 2a — purchase_item row, linking the movement.
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
        .bind(&line.purchase_item_id)
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

        // 2b — inventory_movement row.
        let movement_type = if payload.purchase_type == "opening" { "opening" } else { "purchase" };
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
        .bind(line.quantity_base) // positive delta
        .bind(line.unit_cost_excl_vat_base_cents)
        .bind(line.unit_cost_incl_vat_base_cents)
        .bind(&payload.purchase_id)
        .bind(&line.purchase_item_id)
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
        .bind(&line.purchase_item_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("link purchase_item to movement: {e}"))?;

        // 2c — bump products.quantity_on_hand and avg cost.
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
    })
}

#[tauri::command]
pub async fn post_adjustment(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostAdjustmentPayload,
) -> Result<PostAdjustmentResult, String> {
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

    let pool = pool(&app, &state).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let mut movement_ids: Vec<String> = Vec::with_capacity(payload.lines.len());

    for line in &payload.lines {
        // Sanity: if removing stock, the product must have enough.
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

        // Adjustments do NOT recompute weighted-avg cost (treat as shrinkage
        // at current avg cost). We snapshot the current avg cost into the
        // movement so historical COGS-style queries still work.
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
