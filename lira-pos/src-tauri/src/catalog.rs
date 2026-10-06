// src-tauri/src/catalog.rs
//
// Transactional catalog maintenance (WP-07, GZ-HI-09 / GZ-HI-10).
//
// WHY THIS MODULE EXISTS
//
// Creating or editing a product is not one write. It is a product row, one or
// two `product_uoms` rows, and sometimes a `product_barcodes` row — and the
// schema has partial unique indexes saying a product has exactly one base UoM,
// at most one default sale UoM, at most one default purchase UoM, and at most
// one primary barcode (`uq_product_uoms_one_base`,
// `uq_product_uoms_one_default_sale`, `uq_product_uoms_one_default_purchase`,
// `uq_product_barcodes_one_primary`).
//
// Those indexes constrain the END state. They say nothing about the gap between
// two statements, and the TypeScript repos performed these sequences as separate
// `execute()` calls through tauri-plugin-sql's connection pool — where, exactly
// as for the posting commands in `posting.rs`, there is no usable BEGIN/COMMIT.
// So an ordinary catalog edit could stop halfway and leave a catalog object the
// application refuses to load:
//
//   * product INSERT succeeds, UoM INSERT fails  -> a product with no base UoM.
//     `productsRepo.enrich` THROWS on that ("has no base UoM"), so the product
//     is not merely odd, it is unloadable — it breaks the product list for
//     everything else too.
//   * "make this the default sale UoM" clears every `is_default_sale_uom` and
//     then the INSERT or UPDATE fails -> no default remains, and `enrich`
//     throws again.
//   * "make this barcode primary" demotes the current primary and then the
//     promotion fails -> the product has barcodes but no primary, so there is
//     nothing to print on a label.
//   * product + UoM succeed and the barcode INSERT hits the duplicate-barcode
//     unique constraint -> a half-created product the operator did not get told
//     about, which they then create again.
//
// Each of those is reachable from normal catalog maintenance: a duplicate SKU, a
// duplicate barcode, a UoM code the product already has. So every COMPOUND
// catalog mutation now runs here, in one sqlx transaction, and commits or rolls
// back whole.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
// It does not touch `quantity_on_hand` or any `avg_cost_*` column. Ever. Those
// belong exclusively to the posting and adjustment commands in `posting.rs`,
// which write them against an `inventory_movements` row — see
// `save_product`'s own note. Reads are untouched: the repos still query
// directly, because a read cannot leave a half-state.

use crate::posting::{pool, DbState};
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool};
use tauri::State;

// ============================================================================
// Barcode vocabulary — mirrors `src/lib/barcode.ts`
// ============================================================================

/// Every `product_barcodes.barcode_type` migration 002's CHECK allows.
const BARCODE_TYPES: [&str; 7] = [
    "EAN13", "EAN8", "UPC_A", "UPC_E", "INTERNAL", "SUPPLIER", "OTHER",
];

/// The canonical lookup form: trim + uppercase.
///
/// The exact rule `lib/barcode.ts::normalizeBarcode` applies, and the one
/// migration 002 documents for `lookup_value`. The `barcode` column keeps the
/// operator's original input; only `lookup_value` is normalized, and every
/// lookup normalizes its probe the same way.
fn normalize_barcode(raw: &str) -> String {
    raw.trim().to_uppercase()
}

/// Best-effort type from the shape of the input, mirroring
/// `lib/barcode.ts::classifyBarcode`. Used only when the caller names none.
fn classify_barcode(raw: &str) -> &'static str {
    let norm = normalize_barcode(raw);
    if norm.is_empty() || !norm.chars().all(|c| c.is_ascii_digit()) {
        return "OTHER";
    }
    match norm.len() {
        13 => "EAN13",
        12 => "UPC_A",
        8 => "EAN8",
        _ => "OTHER",
    }
}

fn resolve_barcode_type(raw: &str, declared: Option<&str>) -> Result<String, String> {
    match declared {
        Some(t) if !t.trim().is_empty() => {
            if BARCODE_TYPES.contains(&t) {
                Ok(t.to_string())
            } else {
                Err(format!("Invalid barcode type: {t}"))
            }
        }
        _ => Ok(classify_barcode(raw).to_string()),
    }
}

/// The message the frontend maps back to `DuplicateSkuError`.
///
/// A sentinel rather than a parsed driver string: `products` has
/// `UNIQUE (store_id, sku)`, and the TypeScript side used to recognise the
/// violation by sniffing for "UNIQUE constraint failed" and "products" in the
/// error text — which would also have matched a future unique index on some
/// other `products` column. The command knows exactly which constraint it hit,
/// so it says so.
pub(crate) const DUPLICATE_SKU: &str = "DUPLICATE_SKU";

/// Likewise for a barcode that is already in use in this store.
pub(crate) const DUPLICATE_BARCODE: &str = "DUPLICATE_BARCODE";

fn is_unique_violation(message: &str, needle: &str) -> bool {
    message.contains("UNIQUE constraint failed") && message.contains(needle)
}

// ============================================================================
// save_product
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProductPayload {
    /// The product identity. Minted by the caller for a create; the existing id
    /// for an update.
    pub product_id: String,
    pub store_id: String,
    /// "create" | "update".
    pub mode: String,

    // ---- Metadata. This is the WHOLE of what a catalog edit may write. ----
    pub sku: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub vat_rate_id: String,
    pub vat_pricing_mode: String,
    pub price_excl_vat_cents: i64,
    pub price_incl_vat_cents: i64,
    pub reorder_point: Option<i64>,
    pub is_service: bool,
    pub is_active: bool,

    // ---- The UoM configuration the Products page edits as one unit. ----
    /// The stocking unit. On an update it is informational: a product's base
    /// UoM is not something this command changes (see `save_product_tx`).
    pub base_uom_code: String,
    /// The unit the product is SOLD in, which becomes its default sale UoM.
    pub sale_uom_code: String,
    pub sale_factor_num: i64,
    pub sale_factor_den: i64,
    pub sale_price_excl_vat_cents: Option<i64>,
    pub sale_price_incl_vat_cents: Option<i64>,

    // ---- An optional first barcode, on create only. ----
    pub barcode: Option<String>,
    pub barcode_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProductResult {
    pub product_id: String,
}

/// Pure pre-DB validation. Shape only; everything that needs the catalog is
/// decided inside the transaction.
pub(crate) fn validate_save_product(payload: &SaveProductPayload) -> Result<(), String> {
    if payload.product_id.trim().is_empty() {
        return Err("A product needs an identifier.".into());
    }
    if payload.store_id.trim().is_empty() {
        return Err("A product needs a store.".into());
    }
    if payload.mode != "create" && payload.mode != "update" {
        return Err(format!("Invalid save mode: {}", payload.mode));
    }
    if payload.name.trim().is_empty() {
        return Err("A product needs a name.".into());
    }
    if payload.vat_pricing_mode != "inclusive" && payload.vat_pricing_mode != "exclusive" {
        return Err(format!(
            "Invalid VAT pricing mode: {}",
            payload.vat_pricing_mode
        ));
    }
    if payload.price_excl_vat_cents < 0 || payload.price_incl_vat_cents < 0 {
        return Err("A price cannot be negative.".into());
    }
    if payload.base_uom_code.trim().is_empty() || payload.sale_uom_code.trim().is_empty() {
        return Err("A product needs a stocking unit and a selling unit.".into());
    }
    if payload.sale_factor_num <= 0 || payload.sale_factor_den <= 0 {
        return Err("A unit-of-measure factor must be positive.".into());
    }
    for price in [
        payload.sale_price_excl_vat_cents,
        payload.sale_price_incl_vat_cents,
    ] {
        if price.is_some_and(|p| p < 0) {
            return Err("A unit price cannot be negative.".into());
        }
    }
    if let Some(point) = payload.reorder_point {
        if point < 0 {
            return Err("A reorder point cannot be negative.".into());
        }
    }
    if payload.mode == "create" {
        if let Some(barcode) = payload.barcode.as_deref() {
            if normalize_barcode(barcode).is_empty() {
                return Err("A barcode cannot be blank.".into());
            }
        }
    }
    if let Some(t) = payload.barcode_type.as_deref() {
        if !t.trim().is_empty() && !BARCODE_TYPES.contains(&t) {
            return Err(format!("Invalid barcode type: {t}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_product(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: SaveProductPayload,
) -> Result<SaveProductResult, String> {
    validate_save_product(&payload)?;
    let pool = pool(&app, &state).await?;
    save_product_tx(&pool, payload).await
}

/// Validate-then-save against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn save_product_with_pool(
    pool: &SqlitePool,
    payload: SaveProductPayload,
) -> Result<SaveProductResult, String> {
    validate_save_product(&payload)?;
    save_product_tx(pool, payload).await
}

/// Clear every `is_default_sale_uom` flag on a product.
///
/// Always paired with setting one, inside the same transaction. Separately they
/// are the GZ-HI-09 defect: the clear succeeded, the set failed, and the product
/// had no default sale UoM — which `productsRepo.enrich` refuses to load.
async fn clear_default_sale_uom(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    product_id: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE product_uoms SET is_default_sale_uom = 0 WHERE product_id = ?")
        .bind(product_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("clear default sale UoM: {e}"))?;
    Ok(())
}

/// The transactional body of `save_product`.
pub(crate) async fn save_product_tx(
    pool: &SqlitePool,
    payload: SaveProductPayload,
) -> Result<SaveProductResult, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");

    if payload.mode == "create" {
        // ---- Stock and cost are NOT this command's to set (GZ-HI-10) ----
        //
        // A new product starts with nothing on the shelf and no cost basis,
        // and the only ways to change that are a purchase, an opening-stock
        // batch or an inventory adjustment — each of which writes an
        // `inventory_movements` row so `SUM(quantity_delta)` keeps reconciling
        // to `quantity_on_hand`. There is no field on this payload for either,
        // which is the point: the authority is removed rather than merely
        // unused.
        sqlx::query(
            r#"INSERT INTO products (
                 id, store_id, sku, name, description,
                 vat_rate_id, vat_pricing_mode,
                 price_excl_vat_cents, price_incl_vat_cents,
                 avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
                 avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
                 quantity_on_hand, reorder_point,
                 is_active, is_service
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)"#,
        )
        .bind(&payload.product_id)
        .bind(&payload.store_id)
        .bind(&payload.sku)
        .bind(payload.name.trim())
        .bind(&payload.description)
        .bind(&payload.vat_rate_id)
        .bind(&payload.vat_pricing_mode)
        .bind(payload.price_excl_vat_cents)
        .bind(payload.price_incl_vat_cents)
        .bind(payload.reorder_point)
        .bind(i64::from(payload.is_active))
        .bind(i64::from(payload.is_service))
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            let message = e.to_string();
            if is_unique_violation(&message, "products") {
                DUPLICATE_SKU.to_string()
            } else {
                format!("insert product: {message}")
            }
        })?;

        // ---- The UoM rows, in the same transaction ----
        //
        // A product with no base UoM is unloadable, so the row that makes it
        // loadable cannot be a separate call that might not happen.
        let base_uom_id = uuid::Uuid::new_v4().to_string();
        if payload.base_uom_code == payload.sale_uom_code {
            // One row does both jobs, at factor 1/1 by definition.
            sqlx::query(
                r#"INSERT INTO product_uoms (
                     id, store_id, product_id, uom_code, factor_num, factor_den,
                     is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
                     sale_price_excl_vat_cents, sale_price_incl_vat_cents
                   ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 1, ?, ?)"#,
            )
            .bind(&base_uom_id)
            .bind(&payload.store_id)
            .bind(&payload.product_id)
            .bind(&payload.base_uom_code)
            .bind(payload.sale_price_excl_vat_cents)
            .bind(payload.sale_price_incl_vat_cents)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert base UoM: {e}"))?;
        } else {
            sqlx::query(
                r#"INSERT INTO product_uoms (
                     id, store_id, product_id, uom_code, factor_num, factor_den,
                     is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
                     sale_price_excl_vat_cents, sale_price_incl_vat_cents
                   ) VALUES (?, ?, ?, ?, 1, 1, 1, 0, 1, 1, NULL, NULL)"#,
            )
            .bind(&base_uom_id)
            .bind(&payload.store_id)
            .bind(&payload.product_id)
            .bind(&payload.base_uom_code)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert base UoM: {e}"))?;

            sqlx::query(
                r#"INSERT INTO product_uoms (
                     id, store_id, product_id, uom_code, factor_num, factor_den,
                     is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
                     sale_price_excl_vat_cents, sale_price_incl_vat_cents
                   ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, 1, ?, ?)"#,
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&payload.store_id)
            .bind(&payload.product_id)
            .bind(&payload.sale_uom_code)
            .bind(payload.sale_factor_num)
            .bind(payload.sale_factor_den)
            .bind(payload.sale_price_excl_vat_cents)
            .bind(payload.sale_price_incl_vat_cents)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("insert sale UoM: {e}"))?;
        }

        // ---- And the optional first barcode ----
        //
        // The duplicate-barcode case is the one an operator actually meets, and
        // it used to leave a product and its UoMs behind while reporting a
        // failure — so the operator typed it all again and got a second product.
        if let Some(raw) = payload.barcode.as_deref() {
            insert_barcode(&mut tx, &payload.store_id, &payload.product_id, raw,
                           payload.barcode_type.as_deref(), true).await?;
        }
    } else {
        // ================================================================
        // UPDATE
        // ================================================================
        let current = sqlx::query(
            "SELECT quantity_on_hand, is_service FROM products WHERE id = ? AND store_id = ?",
        )
        .bind(&payload.product_id)
        .bind(&payload.store_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product {}: {e}", payload.product_id))?
        .ok_or_else(|| {
            format!(
                "Product {} not found in store {}.",
                payload.product_id, payload.store_id
            )
        })?;
        let qoh: i64 = current.try_get("quantity_on_hand").map_err(d("quantity_on_hand"))?;
        let was_service: bool =
            current.try_get::<i64, _>("is_service").map_err(d("is_service"))? == 1;

        // ---- Stocked -> service, with stock on the shelf, is REFUSED ----
        //
        // THE GZ-HI-10 remainder. The Products page computed
        // `quantityOnHand = form.isService ? 0 : existing`, and the generic
        // update wrote that column — so ticking "service" on a product with ten
        // units destroyed ten units of stock, with no `inventory_movements` row
        // to account for it. `SUM(quantity_delta)` and `quantity_on_hand` then
        // disagreed permanently, which is the one invariant the whole inventory
        // model rests on.
        //
        // The fix is not to zero the stock more carefully. It is that a METADATA
        // edit may not decide inventory at all: the operator writes the stock off
        // through the inventory-adjustment flow — which creates the movement, at
        // the product's current cost, under a reason — and only then reclassifies
        // it. A zeroing movement is NOT fabricated here, because this command
        // does not know why the stock is going away, and a movement with an
        // invented reason is worse than a refusal.
        if payload.is_service && !was_service && qoh != 0 {
            return Err(format!(
                "STOCKED_TO_SERVICE_WITH_STOCK:{qoh}"
            ));
        }

        // ---- Metadata only. No stock, no cost. ----
        //
        // `quantity_on_hand`, `avg_cost_*_microcents` and their rounded cents
        // mirrors are absent from this statement on purpose. They are not
        // "passed through unchanged" — they are not writable from here, so no
        // future caller can reintroduce the authority by filling a field in.
        sqlx::query(
            r#"UPDATE products
                  SET sku = ?,
                      name = ?,
                      description = ?,
                      vat_rate_id = ?,
                      vat_pricing_mode = ?,
                      price_excl_vat_cents = ?,
                      price_incl_vat_cents = ?,
                      reorder_point = ?,
                      is_service = ?,
                      is_active = ?
                WHERE id = ? AND store_id = ?"#,
        )
        .bind(&payload.sku)
        .bind(payload.name.trim())
        .bind(&payload.description)
        .bind(&payload.vat_rate_id)
        .bind(&payload.vat_pricing_mode)
        .bind(payload.price_excl_vat_cents)
        .bind(payload.price_incl_vat_cents)
        .bind(payload.reorder_point)
        .bind(i64::from(payload.is_service))
        .bind(i64::from(payload.is_active))
        .bind(&payload.product_id)
        .bind(&payload.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            let message = e.to_string();
            if is_unique_violation(&message, "products") {
                DUPLICATE_SKU.to_string()
            } else {
                format!("update product: {message}")
            }
        })?;

        // ---- The selling unit becomes the default sale UoM ----
        let existing = sqlx::query(
            "SELECT id, is_base FROM product_uoms
              WHERE product_id = ? AND store_id = ? AND uom_code = ?",
        )
        .bind(&payload.product_id)
        .bind(&payload.store_id)
        .bind(&payload.sale_uom_code)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product UoM: {e}"))?;

        // Clearing and setting are one step, never two calls.
        clear_default_sale_uom(&mut tx, &payload.product_id).await?;

        match existing {
            Some(row) => {
                let uom_id: String = row.try_get("id").map_err(d("product_uom id"))?;
                let is_base: bool = row.try_get::<i64, _>("is_base").map_err(d("is_base"))? == 1;

                // A BASE unit is 1/1 by definition — it is what every other
                // factor is expressed against. Writing 12/1 onto it would
                // silently reinterpret every quantity ever recorded for this
                // product, so it is refused rather than coerced.
                if is_base && (payload.sale_factor_num != 1 || payload.sale_factor_den != 1) {
                    return Err(format!(
                        "\"{}\" is this product's stocking unit, so its factor is 1/1 and cannot \
                         be {}/{}. Add a separate selling unit instead.",
                        payload.sale_uom_code, payload.sale_factor_num, payload.sale_factor_den
                    ));
                }

                sqlx::query(
                    r#"UPDATE product_uoms
                          SET factor_num = ?,
                              factor_den = ?,
                              is_default_sale_uom = 1,
                              is_active = 1,
                              sale_price_excl_vat_cents = ?,
                              sale_price_incl_vat_cents = ?
                        WHERE id = ?"#,
                )
                .bind(payload.sale_factor_num)
                .bind(payload.sale_factor_den)
                .bind(payload.sale_price_excl_vat_cents)
                .bind(payload.sale_price_incl_vat_cents)
                .bind(&uom_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("update product UoM: {e}"))?;
            }
            None => {
                sqlx::query(
                    r#"INSERT INTO product_uoms (
                         id, store_id, product_id, uom_code, factor_num, factor_den,
                         is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
                         sale_price_excl_vat_cents, sale_price_incl_vat_cents
                       ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, 1, ?, ?)"#,
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(&payload.store_id)
                .bind(&payload.product_id)
                .bind(&payload.sale_uom_code)
                .bind(payload.sale_factor_num)
                .bind(payload.sale_factor_den)
                .bind(payload.sale_price_excl_vat_cents)
                .bind(payload.sale_price_incl_vat_cents)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("insert product UoM: {e}"))?;
            }
        }
    }

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(SaveProductResult {
        product_id: payload.product_id,
    })
}

// ============================================================================
// Barcodes
// ============================================================================

/// Demote any current primary and insert the new row, as one step.
async fn insert_barcode(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    store_id: &str,
    product_id: &str,
    raw: &str,
    declared_type: Option<&str>,
    make_primary: bool,
) -> Result<String, String> {
    let barcode_type = resolve_barcode_type(raw, declared_type)?;
    let id = uuid::Uuid::new_v4().to_string();

    if make_primary {
        // Demote first, because `uq_product_barcodes_one_primary` allows only
        // one. Separately, this pair was the defect: demote, then fail, and the
        // product has barcodes but nothing to print.
        sqlx::query("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?")
            .bind(product_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("demote current primary barcode: {e}"))?;
    }

    sqlx::query(
        r#"INSERT INTO product_barcodes
             (id, store_id, product_id, barcode, lookup_value, barcode_type,
              is_primary, is_active, product_uom_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)"#,
    )
    .bind(&id)
    .bind(store_id)
    .bind(product_id)
    .bind(raw)
    .bind(normalize_barcode(raw))
    .bind(&barcode_type)
    .bind(i64::from(make_primary))
    .execute(&mut **tx)
    .await
    .map_err(|e| {
        let message = e.to_string();
        if is_unique_violation(&message, "product_barcodes") {
            DUPLICATE_BARCODE.to_string()
        } else {
            format!("insert barcode: {message}")
        }
    })?;

    Ok(id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBarcodePayload {
    pub product_id: String,
    pub barcode: String,
    pub barcode_type: Option<String>,
    /// When absent, the first barcode of a product becomes its primary and any
    /// later one does not — the rule `barcodesRepo.addBarcode` already had.
    pub make_primary: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBarcodeResult {
    pub id: String,
}

#[tauri::command]
pub async fn add_product_barcode(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: AddBarcodePayload,
) -> Result<AddBarcodeResult, String> {
    let pool = pool(&app, &state).await?;
    add_product_barcode_tx(&pool, payload).await
}

#[cfg(test)]
pub(crate) async fn add_product_barcode_with_pool(
    pool: &SqlitePool,
    payload: AddBarcodePayload,
) -> Result<AddBarcodeResult, String> {
    add_product_barcode_tx(pool, payload).await
}

pub(crate) async fn add_product_barcode_tx(
    pool: &SqlitePool,
    payload: AddBarcodePayload,
) -> Result<AddBarcodeResult, String> {
    if normalize_barcode(&payload.barcode).is_empty() {
        return Err("A barcode cannot be blank.".into());
    }
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let store_id: String = sqlx::query("SELECT store_id FROM products WHERE id = ?")
        .bind(&payload.product_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product {}: {e}", payload.product_id))?
        .ok_or_else(|| format!("Product not found: {}", payload.product_id))?
        .try_get("store_id")
        .map_err(|e| format!("decode store_id: {e}"))?;

    let active: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ? AND is_active = 1",
    )
    .bind(&payload.product_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("count barcodes: {e}"))?
    .try_get("n")
    .map_err(|e| format!("decode count: {e}"))?;

    let make_primary = payload.make_primary.unwrap_or(active == 0);
    let id = insert_barcode(
        &mut tx,
        &store_id,
        &payload.product_id,
        &payload.barcode,
        payload.barcode_type.as_deref(),
        make_primary,
    )
    .await?;

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(AddBarcodeResult { id })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarcodeRefPayload {
    pub product_id: String,
    pub barcode_id: String,
}

#[tauri::command]
pub async fn set_primary_product_barcode(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: BarcodeRefPayload,
) -> Result<(), String> {
    let pool = pool(&app, &state).await?;
    set_primary_product_barcode_tx(&pool, payload).await
}

#[cfg(test)]
pub(crate) async fn set_primary_product_barcode_with_pool(
    pool: &SqlitePool,
    payload: BarcodeRefPayload,
) -> Result<(), String> {
    set_primary_product_barcode_tx(pool, payload).await
}

/// Demote the current primary and promote the chosen one, as one step.
pub(crate) async fn set_primary_product_barcode_tx(
    pool: &SqlitePool,
    payload: BarcodeRefPayload,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let exists = sqlx::query(
        "SELECT 1 AS ok FROM product_barcodes
          WHERE id = ? AND product_id = ? AND is_active = 1",
    )
    .bind(&payload.barcode_id)
    .bind(&payload.product_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read barcode: {e}"))?;
    if exists.is_none() {
        return Err("Barcode not found or inactive.".into());
    }

    sqlx::query("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?")
        .bind(&payload.product_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("demote current primary: {e}"))?;

    let promoted = sqlx::query(
        "UPDATE product_barcodes SET is_primary = 1 WHERE id = ? AND product_id = ?",
    )
    .bind(&payload.barcode_id)
    .bind(&payload.product_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("promote barcode: {e}"))?;
    if promoted.rows_affected() != 1 {
        return Err("Barcode not found or inactive.".into());
    }

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn remove_product_barcode(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: BarcodeRefPayload,
) -> Result<(), String> {
    let pool = pool(&app, &state).await?;
    remove_product_barcode_tx(&pool, payload).await
}

#[cfg(test)]
pub(crate) async fn remove_product_barcode_with_pool(
    pool: &SqlitePool,
    payload: BarcodeRefPayload,
) -> Result<(), String> {
    remove_product_barcode_tx(pool, payload).await
}

/// Deactivate a barcode and, if it was the primary, promote the oldest
/// survivor — as one step, so a product never ends up with barcodes and no
/// primary. The last barcode cannot be removed, which is the rule
/// `barcodesRepo.remove` already had.
pub(crate) async fn remove_product_barcode_tx(
    pool: &SqlitePool,
    payload: BarcodeRefPayload,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let row = sqlx::query(
        "SELECT is_primary FROM product_barcodes
          WHERE id = ? AND product_id = ? AND is_active = 1",
    )
    .bind(&payload.barcode_id)
    .bind(&payload.product_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read barcode: {e}"))?
    .ok_or_else(|| "Barcode not found or already inactive.".to_string())?;
    let was_primary: bool = row.try_get::<i64, _>("is_primary").map_err(|e| format!("decode: {e}"))? == 1;

    let active: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ? AND is_active = 1",
    )
    .bind(&payload.product_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("count barcodes: {e}"))?
    .try_get("n")
    .map_err(|e| format!("decode count: {e}"))?;
    if active <= 1 {
        return Err("Cannot remove the last barcode.".into());
    }

    sqlx::query("UPDATE product_barcodes SET is_active = 0, is_primary = 0 WHERE id = ?")
        .bind(&payload.barcode_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("deactivate barcode: {e}"))?;

    if was_primary {
        let next: Option<String> = sqlx::query(
            "SELECT id FROM product_barcodes
              WHERE product_id = ? AND is_active = 1
              ORDER BY created_at ASC, id ASC LIMIT 1",
        )
        .bind(&payload.product_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("find next primary: {e}"))?
        .map(|r| r.try_get::<String, _>("id").map_err(|e| format!("decode id: {e}")))
        .transpose()?;

        if let Some(next_id) = next {
            sqlx::query("UPDATE product_barcodes SET is_primary = 1 WHERE id = ?")
                .bind(&next_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("promote next primary: {e}"))?;
        }
    }

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(())
}
