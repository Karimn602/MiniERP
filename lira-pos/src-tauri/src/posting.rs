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
    Ok(dir.join("lira-pos.db"))
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

#[tauri::command]
pub async fn post_purchase(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
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

#[tauri::command]
pub async fn post_supplier_payment(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostSupplierPaymentPayload,
) -> Result<PostSupplierPaymentResult, String> {
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

    let pool = pool(&app, &state).await?;
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

    // Optional: which barcode was scanned to add the line (for the receipt).
    pub barcode_used_snapshot: Option<String>,
    pub barcode_type_snapshot: Option<String>,

    // Whether this product is a service. Services don't move stock or COGS.
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
// post_sale
// ============================================================================

#[tauri::command]
pub async fn post_sale(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostSalePayload,
) -> Result<PostSaleResult, String> {
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

    // ---- Open transaction ----
    let pool = pool(&app, &state).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let receipt_number = next_receipt_number(&mut tx, &payload.store_id).await?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // ---- Pre-compute COGS by reading each product once. We also use this
    //      to validate is_active and stock availability for non-service lines.
    let mut line_cogs_unit_excl: Vec<i64> = Vec::with_capacity(payload.lines.len());
    let mut line_cogs_unit_incl: Vec<i64> = Vec::with_capacity(payload.lines.len());
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
        // Defense-in-depth: trust the DB's is_service, not the payload's.
        let is_service = is_service_db == 1;
        if !is_service && line.quantity_base > qoh {
            return Err(format!(
                "Line {}: insufficient stock for \"{}\" (have {} {}, need {} {}).",
                i + 1,
                line.product_name_snapshot,
                qoh,
                line.uom_code_snapshot,
                line.quantity_base,
                line.uom_code_snapshot
            ));
        }

        let unit_excl = if is_service { 0 } else { avg_cost_excl };
        let unit_incl = if is_service { 0 } else { avg_cost_incl };
        line_cogs_unit_excl.push(unit_excl);
        line_cogs_unit_incl.push(unit_incl);
        cogs_total += unit_excl * line.quantity_base;
    }

    // ---- Insert sale header ----
    sqlx::query(
        r#"INSERT INTO sales (
             id, store_id, shift_id, device_id, cashier_user_id,
             receipt_number,
             exchange_rate_lbp_per_usd, exchange_rate_id,
             subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
             discount_cents, cogs_total_cents,
             sale_type, status, posted_at, notes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'normal', 'posted', ?, ?)"#,
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
    .bind(cogs_total)
    .bind(&now)
    .bind(&payload.notes)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("insert sale: {e}"))?;

    // ---- Insert each line + matching inventory_movement (stock only) ----
    let mut movement_ids: Vec<String> = Vec::new();

    for (i, line) in payload.lines.iter().enumerate() {
        let unit_cogs_excl = line_cogs_unit_excl[i];
        let unit_cogs_incl = line_cogs_unit_incl[i];
        let line_cogs = unit_cogs_excl * line.quantity_base;

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
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&line.sale_item_id)
        .bind(&payload.sale_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(&line.product_name_snapshot)
        .bind(&line.product_sku_snapshot)
        .bind(&line.vat_rate_id_snapshot)
        .bind(line.vat_rate_bps_snapshot)
        .bind(line.quantity_base) // sale_items.quantity is the canonical base qty
        .bind(line.unit_price_excl_vat_cents)
        .bind(line.unit_price_incl_vat_cents)
        .bind(line.line_subtotal_excl_vat_cents)
        .bind(line.line_vat_cents)
        .bind(line.line_total_incl_vat_cents)
        .bind(unit_cogs_excl)
        .bind(line_cogs)
        .bind(&line.barcode_used_snapshot)
        .bind(&line.barcode_type_snapshot)
        .bind(line.quantity_in_uom)
        .bind(&line.uom_code_snapshot)
        .bind(line.factor_num_snapshot)
        .bind(line.factor_den_snapshot)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert sale_item: {e}"))?;

        // Services don't move stock or generate inventory_movements rows.
        if !line.is_service {
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
            .bind(-line.quantity_base) // sale = stock OUT
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
            .bind(line.factor_num_snapshot)
            .bind(line.factor_den_snapshot)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert sale inventory_movement: {e}"))?;

            sqlx::query(
                "UPDATE products
                    SET quantity_on_hand = quantity_on_hand - ?
                  WHERE id = ? AND store_id = ?",
            )
            .bind(line.quantity_base)
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