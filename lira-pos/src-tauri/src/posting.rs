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

    let cogs_method = match payload.cogs_method.as_str() {
        "weighted_average" | "last_purchase" => payload.cogs_method.as_str(),
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
        if !is_service && !payload.allow_negative_inventory && line.quantity_base > qoh {
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
        .bind(line.quantity_base) // sale_items.quantity is the canonical base qty
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

// ============================================================================
// Payload types — credit memo / return (Phase 4 — Sales Returns)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreditMemoPayload {
    pub credit_memo_id: String,
    pub store_id: String,
    pub original_sale_id: String,
    pub cashier_user_id: Option<String>,
    pub device_id: Option<String>,
    pub shift_id: Option<String>,

    // Exchange rate LOCKED at refund time — used to value any LBP refund leg.
    pub exchange_rate_id: String,
    pub exchange_rate_lbp_per_usd: i64,

    pub reason: Option<String>,
    pub lines: Vec<PostCreditMemoLine>,
    pub refunds: Vec<PostCreditMemoRefund>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreditMemoLine {
    pub credit_memo_line_id: String,
    pub original_sale_item_id: String,
    // Returned quantity in the canonical BASE UoM (authoritative for caps/proration).
    pub quantity_base: i64,
    // Display quantity in the sold UoM (snapshot only; may be null).
    pub quantity_in_uom: Option<i64>,
    // Whether to put stock back. Ignored (forced false) for service lines.
    pub return_to_stock: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreditMemoRefund {
    pub refund_id: String,
    pub method: String,
    pub currency: String,
    pub amount_native_usd_cents: i64,
    pub amount_native_lbp: i64,
    pub amount_usd_cents_equivalent: i64,
    pub reference: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreditMemoResult {
    pub credit_memo_id: String,
    pub credit_memo_number: i64,
    pub posted_at: String,
    pub total_incl_vat_cents: i64,
    pub refund_total_usd_cents: i64,
    pub movement_ids: Vec<String>,
}

// ============================================================================
// Helpers — credit memo
// ============================================================================

async fn next_credit_memo_number(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
) -> Result<i64, String> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = 'next_credit_memo_number'")
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("read next_credit_memo_number: {e}"))?;
    let current: i64 = row
        .ok_or_else(|| "next_credit_memo_number missing from app_settings".to_string())?
        .try_get::<String, _>("value")
        .map_err(|e| format!("decode next_credit_memo_number: {e}"))?
        .parse()
        .map_err(|e| format!("parse next_credit_memo_number: {e}"))?;
    sqlx::query("UPDATE app_settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = 'next_credit_memo_number'")
        .bind((current + 1).to_string())
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("write next_credit_memo_number: {e}"))?;
    Ok(current)
}

// Proportional share of `amount` for `q` out of `total_q`, round-half-up.
// Mirrors the JS Math.round(amount * q / total_q) used in creditMemoMath.ts.
fn prorate(amount: i64, q: i64, total_q: i64) -> i64 {
    if total_q <= 0 {
        return 0;
    }
    let num = amount as i128 * q as i128;
    let half = (total_q as i128) / 2;
    ((num + half) / total_q as i128) as i64
}

// Split a VAT-inclusive total into (subtotal_excl, vat) so the two always sum
// back to the input. Mirrors postDiscountLineTotals in the JS side.
fn split_incl_vat(total_incl: i64, vat_bps: i64) -> (i64, i64) {
    if vat_bps <= 0 {
        return (total_incl, 0);
    }
    let denom = 10000 + vat_bps;
    let subtotal =
        ((total_incl as i128 * 10000 + (denom as i128) / 2) / denom as i128) as i64;
    (subtotal, total_incl - subtotal)
}

// ============================================================================
// post_credit_memo
// ============================================================================

#[tauri::command]
pub async fn post_credit_memo(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostCreditMemoPayload,
) -> Result<PostCreditMemoResult, String> {
    // ---- Validation: header ----
    if payload.lines.is_empty() {
        return Err("A return must have at least one line.".into());
    }
    if payload.refunds.is_empty() {
        return Err("A return must have at least one refund.".into());
    }
    if payload.exchange_rate_lbp_per_usd <= 0 {
        return Err("Exchange rate must be positive.".into());
    }

    // ---- Validation: lines (shape only; amounts come from the DB) ----
    for (i, line) in payload.lines.iter().enumerate() {
        if line.quantity_base <= 0 {
            return Err(format!("Return line {} has non-positive quantity.", i + 1));
        }
    }

    // ---- Validation: refunds ----
    let allowed_methods = [
        "cash_usd", "cash_lbp", "card_usd", "card_lbp",
        "bank_transfer", "wallet", "store_credit", "other",
    ];
    for (i, r) in payload.refunds.iter().enumerate() {
        if !allowed_methods.contains(&r.method.as_str()) {
            return Err(format!("Refund {} has invalid method: {}", i + 1, r.method));
        }
        if r.currency != "USD" && r.currency != "LBP" {
            return Err(format!("Refund {} has invalid currency: {}", i + 1, r.currency));
        }
        if r.amount_usd_cents_equivalent <= 0 {
            return Err(format!("Refund {} has non-positive amount.", i + 1));
        }
        let usd_ok = r.amount_native_usd_cents > 0
            && r.currency == "USD"
            && r.amount_native_lbp == 0;
        let lbp_ok = r.amount_native_lbp > 0
            && r.currency == "LBP"
            && r.amount_native_usd_cents == 0;
        if !(usd_ok || lbp_ok) {
            return Err(format!(
                "Refund {}: native amounts inconsistent with currency.",
                i + 1
            ));
        }
    }

    let pool = pool(&app, &state).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    // ---- The original sale must exist, be posted and be a normal sale. ----
    let sale_row = sqlx::query(
        "SELECT sale_type, status FROM sales WHERE id = ? AND store_id = ?",
    )
    .bind(&payload.original_sale_id)
    .bind(&payload.store_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read original sale: {e}"))?
    .ok_or_else(|| "Original sale not found.".to_string())?;

    let sale_type: String = sale_row.try_get("sale_type").map_err(|e| format!("decode sale_type: {e}"))?;
    let sale_status: String = sale_row.try_get("status").map_err(|e| format!("decode status: {e}"))?;
    if sale_status != "posted" {
        return Err("Only posted sales can be returned.".into());
    }
    if sale_type != "normal" {
        return Err("Only normal sales can be returned.".into());
    }

    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // ---- Resolve each line from the ORIGINAL sale_item snapshot. ----
    struct ResolvedLine {
        line: PostCreditMemoLine,
        product_id: String,
        product_name: String,
        product_sku: Option<String>,
        vat_rate_id: String,
        vat_bps: i64,
        uom_code: Option<String>,
        factor_num: Option<i64>,
        factor_den: Option<i64>,
        unit_price_excl: i64,
        unit_price_incl: i64,
        line_subtotal: i64,
        line_vat: i64,
        line_total: i64,
        line_discount: i64,
        unit_cogs_excl: i64,
        unit_cogs_incl: i64,
        line_cogs: i64,
        is_service: bool,
    }

    let mut resolved: Vec<ResolvedLine> = Vec::with_capacity(payload.lines.len());
    let mut header_subtotal: i64 = 0;
    let mut header_vat: i64 = 0;
    let mut header_total: i64 = 0;
    let mut header_discount: i64 = 0;
    let mut header_cogs_reversed: i64 = 0;

    for (i, line) in payload.lines.iter().enumerate() {
        let item = sqlx::query(
            "SELECT product_id, product_name_snapshot, product_sku_snapshot,
                    vat_rate_id_snapshot, vat_rate_bps_snapshot,
                    quantity, uom_code_snapshot, factor_num_snapshot, factor_den_snapshot,
                    unit_price_excl_vat_cents, unit_price_incl_vat_cents,
                    line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                    line_discount_cents, unit_cogs_excl_vat_cents
               FROM sale_items
              WHERE id = ? AND sale_id = ? AND store_id = ?",
        )
        .bind(&line.original_sale_item_id)
        .bind(&payload.original_sale_id)
        .bind(&payload.store_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read sale_item: {e}"))?
        .ok_or_else(|| {
            format!(
                "Return line {}: original sale item not found on this sale.",
                i + 1
            )
        })?;

        let orig_qty: i64 = item.try_get("quantity").map_err(|e| format!("decode quantity: {e}"))?;

        // Already-returned base qty for this original sale item (posted memos only).
        let prev_row = sqlx::query(
            "SELECT COALESCE(SUM(l.quantity_base), 0) AS returned
               FROM sales_credit_memo_lines l
               JOIN sales_credit_memos m ON m.id = l.credit_memo_id
              WHERE l.original_sale_item_id = ? AND m.status = 'posted'",
        )
        .bind(&line.original_sale_item_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("read already-returned qty: {e}"))?;
        let already_returned: i64 =
            prev_row.try_get("returned").map_err(|e| format!("decode returned: {e}"))?;

        let remaining = orig_qty - already_returned;
        if line.quantity_base > remaining {
            return Err(format!(
                "Return line {}: cannot return {} (only {} remaining of {} sold).",
                i + 1,
                line.quantity_base,
                remaining,
                orig_qty
            ));
        }

        let product_id: String = item.try_get("product_id").map_err(|e| format!("decode product_id: {e}"))?;
        let product_name: String = item.try_get("product_name_snapshot").map_err(|e| format!("decode name: {e}"))?;
        let product_sku: Option<String> = item.try_get("product_sku_snapshot").map_err(|e| format!("decode sku: {e}"))?;
        let vat_rate_id: String = item.try_get("vat_rate_id_snapshot").map_err(|e| format!("decode vat_rate_id: {e}"))?;
        let vat_bps: i64 = item.try_get("vat_rate_bps_snapshot").map_err(|e| format!("decode vat_bps: {e}"))?;
        let uom_code: Option<String> = item.try_get("uom_code_snapshot").map_err(|e| format!("decode uom: {e}"))?;
        let factor_num: Option<i64> = item.try_get("factor_num_snapshot").map_err(|e| format!("decode factor_num: {e}"))?;
        let factor_den: Option<i64> = item.try_get("factor_den_snapshot").map_err(|e| format!("decode factor_den: {e}"))?;
        let unit_price_excl: i64 = item.try_get("unit_price_excl_vat_cents").map_err(|e| format!("decode unit_price_excl: {e}"))?;
        let unit_price_incl: i64 = item.try_get("unit_price_incl_vat_cents").map_err(|e| format!("decode unit_price_incl: {e}"))?;
        let orig_subtotal: i64 = item.try_get("line_subtotal_excl_vat_cents").map_err(|e| format!("decode subtotal: {e}"))?;
        let orig_total: i64 = item.try_get("line_total_incl_vat_cents").map_err(|e| format!("decode total: {e}"))?;
        let orig_discount: i64 = item.try_get("line_discount_cents").map_err(|e| format!("decode discount: {e}"))?;
        let unit_cogs_excl: i64 = item.try_get("unit_cogs_excl_vat_cents").map_err(|e| format!("decode unit_cogs: {e}"))?;
        let _ = orig_subtotal;

        // Determine whether stock actually moved when this line was sold. If a
        // 'sale' movement exists, it's a stock line; if not, it was a service.
        let sale_mov = sqlx::query(
            "SELECT unit_cost_excl_vat_cents, unit_cost_incl_vat_cents
               FROM inventory_movements
              WHERE related_sale_item_id = ? AND movement_type = 'sale'
              LIMIT 1",
        )
        .bind(&line.original_sale_item_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read sale movement: {e}"))?;

        let is_service = sale_mov.is_none();
        let unit_cogs_incl: i64 = match &sale_mov {
            Some(m) => m.try_get("unit_cost_incl_vat_cents").map_err(|e| format!("decode cost_incl: {e}"))?,
            None => 0,
        };

        // Prorate the VAT-inclusive total by returned quantity, then back out VAT
        // so subtotal + vat == total exactly. Discount/COGS prorate likewise.
        let line_total = prorate(orig_total, line.quantity_base, orig_qty);
        let (line_subtotal, line_vat) = split_incl_vat(line_total, vat_bps);
        let line_discount = prorate(orig_discount, line.quantity_base, orig_qty);
        let line_cogs = unit_cogs_excl * line.quantity_base;

        let restock = !is_service && line.return_to_stock;
        if restock {
            header_cogs_reversed += line_cogs;
        }

        header_total += line_total;
        header_subtotal += line_subtotal;
        header_vat += line_vat;
        header_discount += line_discount;

        resolved.push(ResolvedLine {
            line: PostCreditMemoLine {
                credit_memo_line_id: line.credit_memo_line_id.clone(),
                original_sale_item_id: line.original_sale_item_id.clone(),
                quantity_base: line.quantity_base,
                quantity_in_uom: line.quantity_in_uom,
                return_to_stock: restock,
            },
            product_id,
            product_name,
            product_sku,
            vat_rate_id,
            vat_bps,
            uom_code,
            factor_num,
            factor_den,
            unit_price_excl,
            unit_price_incl,
            line_subtotal,
            line_vat,
            line_total,
            line_discount,
            unit_cogs_excl,
            unit_cogs_incl,
            line_cogs,
            is_service,
        });
    }

    if header_total <= 0 {
        return Err("Return total must be positive.".into());
    }

    // ---- Refund total must reconcile to the credit memo total exactly. ----
    let refund_total: i64 = payload
        .refunds
        .iter()
        .map(|r| r.amount_usd_cents_equivalent)
        .sum();
    if refund_total != header_total {
        return Err(format!(
            "Refund total ({} USD-cents) must equal the return total ({} USD-cents).",
            refund_total, header_total
        ));
    }

    let credit_memo_number = next_credit_memo_number(&mut tx).await?;

    // ---- Insert credit memo header. ----
    sqlx::query(
        r#"INSERT INTO sales_credit_memos (
             id, store_id, original_sale_id, credit_memo_number,
             shift_id, device_id, cashier_user_id,
             exchange_rate_lbp_per_usd, exchange_rate_id, reason,
             subtotal_excl_vat_cents, vat_total_cents, discount_cents, total_incl_vat_cents,
             cogs_reversed_cents, refund_total_usd_cents,
             status, posted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)"#,
    )
    .bind(&payload.credit_memo_id)
    .bind(&payload.store_id)
    .bind(&payload.original_sale_id)
    .bind(credit_memo_number)
    .bind(&payload.shift_id)
    .bind(&payload.device_id)
    .bind(&payload.cashier_user_id)
    .bind(payload.exchange_rate_lbp_per_usd)
    .bind(&payload.exchange_rate_id)
    .bind(&payload.reason)
    .bind(header_subtotal)
    .bind(header_vat)
    .bind(header_discount)
    .bind(header_total)
    .bind(header_cogs_reversed)
    .bind(refund_total)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("insert credit memo: {e}"))?;

    // ---- Insert each line + (for restock lines) a return_in movement. ----
    let mut movement_ids: Vec<String> = Vec::new();

    for r in &resolved {
        let mut related_movement_id: Option<String> = None;

        if r.line.return_to_stock {
            let movement_id = uuid::Uuid::new_v4().to_string();
            movement_ids.push(movement_id.clone());
            related_movement_id = Some(movement_id.clone());

            sqlx::query(
                r#"INSERT INTO inventory_movements (
                     id, store_id, product_id, movement_type, quantity_delta,
                     unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
                     related_sale_id, related_sale_item_id,
                     related_credit_memo_id, related_credit_memo_line_id,
                     notes, created_by_user_id, device_id, posted_at,
                     quantity_in_uom, uom_code_snapshot,
                     factor_num_snapshot, factor_den_snapshot
                   ) VALUES (?, ?, ?, 'return_in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(&movement_id)
            .bind(&payload.store_id)
            .bind(&r.product_id)
            .bind(r.line.quantity_base) // return = stock IN (positive)
            .bind(r.unit_cogs_excl)
            .bind(r.unit_cogs_incl)
            .bind(&payload.original_sale_id)
            .bind(&r.line.original_sale_item_id)
            .bind(&payload.credit_memo_id)
            .bind(&r.line.credit_memo_line_id)
            .bind(format!("Return #{}", credit_memo_number))
            .bind(&payload.cashier_user_id)
            .bind(&payload.device_id)
            .bind(&now)
            .bind(&r.line.quantity_in_uom)
            .bind(&r.uom_code)
            .bind(&r.factor_num)
            .bind(&r.factor_den)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert return_in movement: {e}"))?;

            sqlx::query(
                "UPDATE products
                    SET quantity_on_hand = quantity_on_hand + ?
                  WHERE id = ? AND store_id = ?",
            )
            .bind(r.line.quantity_base)
            .bind(&r.product_id)
            .bind(&payload.store_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("restock product: {e}"))?;
        }

        sqlx::query(
            r#"INSERT INTO sales_credit_memo_lines (
                 id, credit_memo_id, store_id, original_sale_item_id, product_id,
                 product_name_snapshot, product_sku_snapshot,
                 vat_rate_id_snapshot, vat_rate_bps_snapshot,
                 quantity_base, quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot,
                 unit_price_excl_vat_cents, unit_price_incl_vat_cents,
                 line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                 line_discount_cents,
                 unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
                 is_service, return_to_stock, related_movement_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&r.line.credit_memo_line_id)
        .bind(&payload.credit_memo_id)
        .bind(&payload.store_id)
        .bind(&r.line.original_sale_item_id)
        .bind(&r.product_id)
        .bind(&r.product_name)
        .bind(&r.product_sku)
        .bind(&r.vat_rate_id)
        .bind(r.vat_bps)
        .bind(r.line.quantity_base)
        .bind(&r.line.quantity_in_uom)
        .bind(&r.uom_code)
        .bind(&r.factor_num)
        .bind(&r.factor_den)
        .bind(r.unit_price_excl)
        .bind(r.unit_price_incl)
        .bind(r.line_subtotal)
        .bind(r.line_vat)
        .bind(r.line_total)
        .bind(r.line_discount)
        .bind(r.unit_cogs_excl)
        .bind(r.line_cogs)
        .bind(r.is_service as i64)
        .bind(r.line.return_to_stock as i64)
        .bind(&related_movement_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert credit memo line: {e}"))?;
    }

    // ---- Insert refund rows. ----
    for r in &payload.refunds {
        sqlx::query(
            r#"INSERT INTO sales_credit_memo_refunds (
                 id, credit_memo_id, store_id, method, currency,
                 amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
                 reference
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&r.refund_id)
        .bind(&payload.credit_memo_id)
        .bind(&payload.store_id)
        .bind(&r.method)
        .bind(&r.currency)
        .bind(r.amount_native_usd_cents)
        .bind(r.amount_native_lbp)
        .bind(r.amount_usd_cents_equivalent)
        .bind(&r.reference)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert credit memo refund: {e}"))?;
    }

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;

    Ok(PostCreditMemoResult {
        credit_memo_id: payload.credit_memo_id,
        credit_memo_number,
        posted_at: now,
        total_incl_vat_cents: header_total,
        refund_total_usd_cents: refund_total,
        movement_ids,
    })
}