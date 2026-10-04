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
//
// Cost convention (WP-03, GP-A03) — the one exception to "everything is cents":
//   - A UNIT COST is a rate, not an amount, and is held in MICROCENTS
//     (1 cent = cost::COST_SCALE = 1_000_000), so a cost below one cent per
//     base unit survives. `products.avg_cost_*_microcents`,
//     `inventory_movements.unit_cost_*_microcents`,
//     `purchase_items.unit_cost_*_base_microcents` and
//     `sale_items.unit_cogs_excl_vat_microcents` are the accounting source of
//     truth; the matching `*_cents` columns are a rounded display mirror this
//     module maintains and never reads back into a calculation.
//   - Cost becomes money exactly once, at `cost::extended_cost_cents`.
//   - All cost arithmetic goes through `crate::cost`. Nothing here scales,
//     divides or rounds a cost by hand.

use crate::cost::{
    extended_cost_cents, microcents_to_cents, new_weighted_avg,
    unit_cost_in_uom_to_base_microcents,
};
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

    // The UoM the goods were invoiced in. `uom_code_snapshot` is the LOOKUP KEY:
    // `post_purchase` resolves the product's own `product_uoms` row from it and
    // takes the conversion factor from there (WP-03 correction, mirroring
    // GP-A02 on the sale side).
    //
    // `product_uom_id_snapshot` and the two factor snapshots are the client's
    // CLAIM about that row. They are cross-checked against the resolved row and
    // a disagreement is refused, but they are never the source of the factor.
    pub product_uom_id_snapshot: Option<String>,
    pub uom_code_snapshot: String,
    pub factor_num_snapshot: i64,
    pub factor_den_snapshot: i64,

    // `quantity_in_uom` is what the buyer entered and is authoritative.
    // `quantity_base` is the client's claim about the conversion; the backend
    // derives the real one from the resolved factor and refuses a payload that
    // contradicts it.
    pub quantity_in_uom: i64,
    pub quantity_base: i64,

    // Which side of the cost pair below the supplier's invoice actually states
    // — "inclusive" or "exclusive". The buyer sets it per line on the Purchases
    // page (the Incl/Excl toggle), initialised from the product's own
    // `vat_pricing_mode`, because whether a bill quotes net or gross is a fact
    // about the bill. When the payload omits it, `post_purchase` falls back to
    // `products.vat_pricing_mode`.
    //
    // This does NOT let a caller choose its own price: it names which ONE of
    // the two figures below is the invoice's, and the other is then derived and
    // cross-checked. See `derive_unit_cost_pair`.
    #[serde(default)]
    pub vat_pricing_mode: Option<String>,

    // What the supplier invoice says, per purchasing UoM, in exact cents.
    //
    // Exactly ONE of these is authoritative — the one `vat_pricing_mode` names.
    // The other is a cross-check: `post_purchase` derives it from the
    // authoritative side with the application's own VAT rounding and refuses a
    // line whose declared counterpart disagrees. Two independently chosen
    // figures here are how a crafted request used to stock goods at one price
    // and bill the shop at another.
    pub unit_cost_excl_vat_in_uom_cents: i64,
    pub unit_cost_incl_vat_in_uom_cents: i64,

    // What the CLIENT derived as the per-base cost, in cents. Accepted for wire
    // compatibility and NEVER acted on: rounding a per-base cost to whole cents
    // is the GP-A03 defect itself, so `post_purchase` derives the per-base cost
    // from the per-UoM cost and the conversion factor at microcent precision
    // (`cost::unit_cost_in_uom_to_base_microcents`) and writes both the
    // microcent column and its rounded cents mirror from that.
    #[allow(dead_code)]
    pub unit_cost_excl_vat_base_cents: i64,
    #[allow(dead_code)]
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
    /// The payment identity. Stable across retries: replaying it reconciles to
    /// the entry it already created instead of paying the supplier twice.
    pub ledger_entry_id: String,
    pub store_id: String,
    pub supplier_id: String,
    pub entry_type: String, // 'payment' | 'credit_note' | 'opening_balance' | 'adjustment'

    /// The money, as a POSITIVE magnitude. Authoritative when present.
    ///
    /// WP-05: how an entry type moves the payable is an accounting fact about
    /// the type, not a choice the caller gets to make per request — see
    /// `ledger_direction`. A caller states how much; the backend decides which
    /// way. The one exception is the two deliberately bidirectional types
    /// (`opening_balance`, `adjustment`), where the direction IS the
    /// instruction and comes from `amount_cents`'s sign.
    #[serde(default)]
    pub amount_magnitude_cents: Option<i64>,

    /// The legacy signed amount. Kept on the wire, and still the way the
    /// bidirectional types carry their direction, but its sign is NOT
    /// authoritative for `payment` or `credit_note`: a payment sent as `+5000`
    /// pays $50 down, it does not add $50 to the payable. When
    /// `amount_magnitude_cents` is also given the two must agree in magnitude.
    pub amount_cents: i64,

    pub entry_date: String, // YYYY-MM-DD
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
    /// The supplier's payable as it stands after this call. On a replay it is
    /// the payable as it stands now, which is what the original call reported
    /// when nothing else had posted in between.
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

/// The supplier's outstanding payable: `SUM(amount_cents)` over its whole
/// ledger, positive meaning the shop owes money.
///
/// THE definition. `supplierLedgerRepo.getBalance`, `listBalances` and the
/// `supplier_balances` view all compute the same sum over the same rows, which
/// is what makes the figure on the Supplier screen the figure
/// `post_supplier_payment` checks a payment against. Read inside the posting
/// transaction, never taken from the caller: a balance the client last rendered
/// is a balance from before whatever posted since.
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

/// The store a supplier belongs to, or `None` if there is no such supplier.
///
/// A supplier row is owned by exactly one store (`suppliers.store_id`), so a
/// document filed against a different store's books would be counted by
/// `listBalances(storeId)` for one store and by the supplier's own balance for
/// another. Both `post_purchase` and `post_supplier_payment` resolve this
/// before writing; `trg_supplier_ledger_sign_discipline` is the backstop.
async fn supplier_store_id(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    supplier_id: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT store_id FROM suppliers WHERE id = ?")
        .bind(supplier_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("read supplier {supplier_id}: {e}"))?;
    match row {
        None => Ok(None),
        Some(r) => Ok(Some(
            r.try_get("store_id").map_err(|e| format!("decode supplier store_id: {e}"))?,
        )),
    }
}

/// Prove that `supplier_id` is a supplier of `store_id`, or fail saying so.
async fn assert_supplier_belongs_to_store(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    supplier_id: &str,
    store_id: &str,
) -> Result<(), String> {
    match supplier_store_id(tx, supplier_id).await? {
        None => Err(format!("Supplier {supplier_id} does not exist.")),
        Some(owner) if owner == store_id => Ok(()),
        Some(owner) => Err(format!(
            "Supplier {supplier_id} belongs to store {owner}, not to store {store_id}."
        )),
    }
}

// ============================================================================
// Supplier-ledger sign authority (WP-05, GZ-HI-05)
// ============================================================================

/// Which way an entry type moves the payable.
///
/// The supplier ledger is append-only, immutable and undeletable, and the
/// balance every screen and report shows is `SUM(amount_cents)`. So the sign on
/// a row is not a presentation detail that can be fixed later — it is the
/// accounting meaning of the document, permanently. Migration 006 wrote the
/// convention down in prose; this is that prose, as code, in the one place
/// every writer goes through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LedgerDirection {
    /// The payable goes up. `purchase` only: goods received on credit.
    Increase,
    /// The payable goes down. `payment` and `credit_note`.
    Decrease,
    /// Either way, and the caller says which. `opening_balance` carries in a
    /// balance from elsewhere; `adjustment` is a manual write-up or write-down
    /// and must explain itself in `notes`. Both are deliberately bidirectional
    /// — the Supplier screen gives `adjustment` an explicit +/− toggle — so for
    /// these two the caller's sign IS the instruction, not a guess at one.
    Signed,
}

/// The direction of a `supplier_ledger.entry_type`, or `None` if the type is
/// not one the schema allows.
pub(crate) fn ledger_direction(entry_type: &str) -> Option<LedgerDirection> {
    match entry_type {
        "purchase" => Some(LedgerDirection::Increase),
        "payment" | "credit_note" => Some(LedgerDirection::Decrease),
        "opening_balance" | "adjustment" => Some(LedgerDirection::Signed),
        _ => None,
    }
}

/// The authoritative signed ledger amount for one entry.
///
/// This is the whole of Part A of WP-05 in one function: a caller states a
/// magnitude, and for every type whose direction is fixed the backend applies
/// the sign. A payment sent as `+5000` by a buggy client, a stale build or a
/// hand-rolled integration pays $50 off the balance; it cannot add $50 to it.
///
/// `amount_magnitude_cents` is the authoritative input when given and must be
/// strictly positive — a negative magnitude is a malformed request, not a
/// direction, and zero records nothing. `amount_cents` stays on the wire for
/// compatibility: when the magnitude is absent its absolute value supplies one,
/// and when both are present they must agree about how much money moved (the
/// same cross-check WP-03 applies to the UoM snapshots it no longer trusts).
pub(crate) fn resolve_ledger_amount(
    entry_type: &str,
    amount_magnitude_cents: Option<i64>,
    legacy_signed_amount_cents: i64,
) -> Result<i64, String> {
    let direction = ledger_direction(entry_type)
        .ok_or_else(|| format!("Invalid entry_type: {entry_type}"))?;

    let legacy_magnitude = legacy_signed_amount_cents
        .checked_abs()
        .ok_or_else(|| "Amount is too large to post.".to_string())?;

    let magnitude = match amount_magnitude_cents {
        Some(declared) => {
            if declared <= 0 {
                return Err(format!(
                    "Amount must be a positive number of cents; got {declared}."
                ));
            }
            if legacy_signed_amount_cents != 0 && legacy_magnitude != declared {
                return Err(format!(
                    "Amount disagrees with itself: magnitude {declared} cents against a signed \
                     amount of {legacy_signed_amount_cents} cents."
                ));
            }
            declared
        }
        None => {
            if legacy_signed_amount_cents == 0 {
                return Err("Amount must be non-zero.".into());
            }
            legacy_magnitude
        }
    };

    match direction {
        LedgerDirection::Increase => Ok(magnitude),
        LedgerDirection::Decrease => Ok(-magnitude),
        LedgerDirection::Signed => {
            // The direction has to come from somewhere, and for these two types
            // the caller is the only one who knows it.
            if legacy_signed_amount_cents == 0 {
                return Err(format!(
                    "A '{entry_type}' entry is bidirectional and needs a signed amount_cents \
                     saying which way it moves the balance."
                ));
            }
            if legacy_signed_amount_cents < 0 {
                Ok(-magnitude)
            } else {
                Ok(magnitude)
            }
        }
    }
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
        if line.quantity_in_uom <= 0 {
            return Err(format!("Line {} has non-positive quantity.", i + 1));
        }
        if line.factor_num_snapshot <= 0 || line.factor_den_snapshot <= 0 {
            return Err(format!("Line {} has invalid UoM factor.", i + 1));
        }
        if line.uom_code_snapshot.trim().is_empty() {
            return Err(format!("Line {} does not name a unit of measure.", i + 1));
        }
        // A pricing mode the payload names must be one the application has.
        // The arithmetic it selects runs inside the transaction, where the
        // product's own mode is available as the fallback — this is only the
        // shape check, so a nonsense string fails before the pool is touched.
        if let Some(mode) = line.vat_pricing_mode.as_deref() {
            VatPricingMode::parse(mode).map_err(|e| format!("Line {}: {}", i + 1, e))?;
        }
    }
    Ok(())
}

// ----------------------------------------------------------------------------
// VAT arithmetic (mirrors lib/vat.ts)
// ----------------------------------------------------------------------------

/// Net → gross: `net + round(net × bps / 10000)`.
///
/// Mirrors `lib/vat.ts::addVat` exactly, but in integer arithmetic with no
/// float step: the product is taken in i128 so a large amount cannot overflow
/// on the way, and the half-up adjustment is exact rather than the result of an
/// f64 division that happened to land near a boundary. `Math.round` in
/// JavaScript rounds a positive half upward, which for the non-negative amounts
/// this is ever called with is the same half-away-from-zero rule the rest of
/// the money and cost code uses.
///
/// This is the ONLY net→gross rule in the backend. It is not a second VAT
/// implementation: it is the existing one, restated in the language the posting
/// commands are written in, and `pure.rs` pins the two together.
pub(crate) fn add_vat(net_cents: i64, bps: i64) -> Result<i64, String> {
    if net_cents < 0 {
        return Err("a VAT-exclusive amount cannot be negative".into());
    }
    if bps < 0 {
        return Err("a VAT rate cannot be negative".into());
    }
    let tax = (i128::from(net_cents) * i128::from(bps) + 5_000) / 10_000;
    let gross = i128::from(net_cents) + tax;
    i64::try_from(gross).map_err(|_| "amount overflows when VAT is added".to_string())
}

/// Gross → net: `round(gross × 10000 / (10000 + bps))`.
///
/// Mirrors `lib/vat.ts::stripVat` exactly, in integer arithmetic. Same
/// provenance and same rounding rule as `add_vat`.
///
/// Note that `add_vat` and `strip_vat` are NOT exact inverses at cent
/// precision — that is a property of rounding to whole cents, not a defect —
/// which is precisely why the pricing mode decides which of the two runs. See
/// `derive_unit_cost_pair`.
pub(crate) fn strip_vat(gross_cents: i64, bps: i64) -> Result<i64, String> {
    if gross_cents < 0 {
        return Err("a VAT-inclusive amount cannot be negative".into());
    }
    if bps < 0 {
        return Err("a VAT rate cannot be negative".into());
    }
    let denom = 10_000 + i128::from(bps);
    let net = (i128::from(gross_cents) * 10_000 + denom / 2) / denom;
    i64::try_from(net).map_err(|_| "amount overflows when VAT is stripped".to_string())
}

// ----------------------------------------------------------------------------
// The authoritative unit cost of a purchase line (WP-05 correction)
// ----------------------------------------------------------------------------

/// Which side of a purchase line's VAT-exclusive/VAT-inclusive cost pair the
/// supplier's invoice actually states.
///
/// This is not a presentation detail. A supplier bill quotes ONE price per unit,
/// and whether that figure is net or gross is a fact about the bill that only
/// the buyer reading it knows — which is why the Purchases page gives every
/// line an Incl/Excl toggle, initialised from `products.vat_pricing_mode`.
/// The other side of the pair is arithmetic, not information.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VatPricingMode {
    /// The invoice states the NET price. `unit_cost_excl_vat_in_uom_cents` is
    /// authoritative and the inclusive figure is derived with `add_vat`.
    Exclusive,
    /// The invoice states the GROSS price. `unit_cost_incl_vat_in_uom_cents` is
    /// authoritative and the exclusive figure is derived with `strip_vat`.
    Inclusive,
}

impl VatPricingMode {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "exclusive" => Ok(Self::Exclusive),
            "inclusive" => Ok(Self::Inclusive),
            other => Err(format!(
                "Invalid VAT pricing mode \"{other}\" — expected \"inclusive\" or \"exclusive\"."
            )),
        }
    }
}

/// A purchase line's per-UoM cost pair, as the backend derived it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UnitCostPair {
    pub excl_vat_in_uom_cents: i64,
    pub incl_vat_in_uom_cents: i64,
}

/// Derive a line's full cost pair from the ONE price the invoice states, and
/// refuse a payload whose other side disagrees.
///
/// WHY THIS EXISTS. Until this correction the backend accepted
/// `unit_cost_excl_vat_in_uom_cents` and `unit_cost_incl_vat_in_uom_cents` as
/// two independent client values, checking only that they were non-negative and
/// ordered. Nothing proved they were the same price. So a crafted line could
/// say "$20.00 net, $999.00 gross" at 11% and, if its declared totals matched
/// the gross figure, post — stocking inventory at a $20 cost basis while
/// raising $999 of supplier debt. One economic event, two prices, and the
/// purchase immutable afterwards. That is the GZ-HI-05 invariant failing on the
/// exact axis WP-05 set out to close.
///
/// There is now one authoritative economic unit price per line. The pricing
/// mode names which side of the pair it is; the counterpart is computed with
/// the application's own VAT rounding (`add_vat` / `strip_vat`, mirroring
/// `lib/vat.ts`, which is what `lib/purchaseMath.ts::computeLineMath` already
/// uses to build the pair on the client). The declared counterpart is a
/// cross-check and a disagreement is REFUSED rather than overruled — the same
/// treatment WP-03 gives the UoM factor and base quantity, and for the same
/// reason: the buyer priced the goods against one figure, and quietly
/// substituting another invents a cost or a debt nobody agreed to.
///
/// Rounding to whole cents means `add_vat` and `strip_vat` are not exact
/// inverses, so the direction matters and the mode is what fixes it. An exempt
/// (0 bps) line has no VAT to add or strip, and both sides must be the single
/// price the invoice states.
pub(crate) fn derive_unit_cost_pair(
    index: usize,
    line: &PostPurchaseLine,
    mode: VatPricingMode,
) -> Result<UnitCostPair, String> {
    let n = index + 1;

    if line.unit_cost_excl_vat_in_uom_cents < 0 || line.unit_cost_incl_vat_in_uom_cents < 0 {
        return Err(format!("Line {n} has a negative unit cost."));
    }
    if line.vat_rate_bps_snapshot < 0 {
        return Err(format!("Line {n} has a negative VAT rate."));
    }

    let bps = line.vat_rate_bps_snapshot;
    let (excl, incl) = match mode {
        VatPricingMode::Exclusive => {
            let excl = line.unit_cost_excl_vat_in_uom_cents;
            let incl = add_vat(excl, bps)
                .map_err(|e| format!("Line {n}: {e}."))?;
            (excl, incl)
        }
        VatPricingMode::Inclusive => {
            let incl = line.unit_cost_incl_vat_in_uom_cents;
            let excl = strip_vat(incl, bps)
                .map_err(|e| format!("Line {n}: {e}."))?;
            (excl, incl)
        }
    };

    // The cross-check. Whichever side was derived must be the side the client
    // declared; the authoritative side compares to itself and cannot fail.
    if excl != line.unit_cost_excl_vat_in_uom_cents
        || incl != line.unit_cost_incl_vat_in_uom_cents
    {
        let stated = match mode {
            VatPricingMode::Exclusive => "excluding",
            VatPricingMode::Inclusive => "including",
        };
        return Err(format!(
            "Line {n}: the declared unit costs are not one price. The invoice states \
             {} cents {stated} VAT, which at {} bps is {}/{} (excl/incl) — the line declares \
             {}/{}. One of the two figures was not derived from the other.",
            match mode {
                VatPricingMode::Exclusive => line.unit_cost_excl_vat_in_uom_cents,
                VatPricingMode::Inclusive => line.unit_cost_incl_vat_in_uom_cents,
            },
            bps,
            excl,
            incl,
            line.unit_cost_excl_vat_in_uom_cents,
            line.unit_cost_incl_vat_in_uom_cents,
        ));
    }

    Ok(UnitCostPair {
        excl_vat_in_uom_cents: excl,
        incl_vat_in_uom_cents: incl,
    })
}

/// One purchase line's money, derived from the inputs that are authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PurchaseLineAmounts {
    pub subtotal_excl_vat_cents: i64,
    pub vat_cents: i64,
    pub total_incl_vat_cents: i64,
}

/// Everything `post_purchase` computes before it touches the database: the
/// per-line amounts and the header totals they sum into.
///
/// The header total is the supplier's payable, so it cannot be a number the
/// client chose (WP-05 Part C). It is derived here from the two inputs that
/// genuinely are authoritative — the per-UoM invoice cost, which the buyer
/// typed to the cent off the bill, and the quantity in that UoM — using the
/// application's own convention from `lib/purchaseMath.ts::computeLineMath`.
#[derive(Debug)]
pub(crate) struct PreparedPurchase {
    pub lines: Vec<PurchaseLineAmounts>,
    pub subtotal_excl_vat_cents: i64,
    pub vat_total_cents: i64,
    pub total_incl_vat_cents: i64,
}

/// Derive one line's subtotal, VAT and total, and refuse a payload that
/// declares different ones.
///
/// `lib/purchaseMath.ts` extends the per-UoM cost by the quantity in that UoM
/// and takes VAT as the difference between the gross and net extensions. That
/// is reproduced exactly here, so a line the Purchases page built passes
/// unchanged — and a line that was assembled anywhere else does not get to name
/// its own payable.
///
/// The relationship BETWEEN the two per-UoM costs is not settled here, because
/// settling it needs the line's pricing mode and therefore possibly a look at
/// the product row: `derive_unit_cost_pair` does it inside the transaction,
/// before anything is written. What this function checks is that the pair is
/// non-negative and ordered, that an exempt line carries no VAT, and — the
/// part that matters for the payable — that the declared line totals really are
/// that pair extended by the quantity. The two checks compose: the header is
/// the extension of a pair that has been proved to be one price.
pub(crate) fn derive_purchase_line_amounts(
    index: usize,
    line: &PostPurchaseLine,
) -> Result<PurchaseLineAmounts, String> {
    let n = index + 1;

    if line.unit_cost_excl_vat_in_uom_cents < 0 || line.unit_cost_incl_vat_in_uom_cents < 0 {
        return Err(format!("Line {n} has a negative unit cost."));
    }
    if line.vat_rate_bps_snapshot < 0 {
        return Err(format!("Line {n} has a negative VAT rate."));
    }
    if line.unit_cost_incl_vat_in_uom_cents < line.unit_cost_excl_vat_in_uom_cents {
        return Err(format!(
            "Line {n} costs less with VAT ({} cents) than without it ({} cents).",
            line.unit_cost_incl_vat_in_uom_cents, line.unit_cost_excl_vat_in_uom_cents
        ));
    }

    let overflow = || format!("Line {n} overflows when its cost is extended by its quantity.");
    let subtotal = line
        .unit_cost_excl_vat_in_uom_cents
        .checked_mul(line.quantity_in_uom)
        .ok_or_else(overflow)?;
    let total = line
        .unit_cost_incl_vat_in_uom_cents
        .checked_mul(line.quantity_in_uom)
        .ok_or_else(overflow)?;
    let vat = total - subtotal;

    if line.vat_rate_bps_snapshot == 0 && vat != 0 {
        return Err(format!(
            "Line {n} does not reconcile: VAT of {vat} cents at an exempt (0 bps) rate."
        ));
    }

    // The declared figures are a cross-check, exactly as WP-03 treats the
    // declared base quantity and UoM factor: a client whose arithmetic
    // disagrees with the invoice it is quoting is refused, not quietly
    // overruled, because the difference IS the payable the shop would be left
    // owing.
    if line.line_subtotal_excl_vat_cents != subtotal
        || line.line_vat_cents != vat
        || line.line_total_incl_vat_cents != total
    {
        return Err(format!(
            "Line {n} does not reconcile against its invoice cost: declared {}/{}/{} \
             (subtotal/VAT/total) against {} {} x {} cents = {}/{}/{}.",
            line.line_subtotal_excl_vat_cents,
            line.line_vat_cents,
            line.line_total_incl_vat_cents,
            line.quantity_in_uom,
            line.uom_code_snapshot,
            line.unit_cost_excl_vat_in_uom_cents,
            subtotal,
            vat,
            total
        ));
    }

    Ok(PurchaseLineAmounts {
        subtotal_excl_vat_cents: subtotal,
        vat_cents: vat,
        total_incl_vat_cents: total,
    })
}

/// Validate a purchase payload and derive its authoritative money.
pub(crate) fn prepare_purchase(
    payload: &PostPurchasePayload,
) -> Result<PreparedPurchase, String> {
    validate_purchase_payload(payload)?;

    let mut lines = Vec::with_capacity(payload.lines.len());
    let mut subtotal: i64 = 0;
    let mut vat_total: i64 = 0;
    let mut total: i64 = 0;

    for (i, line) in payload.lines.iter().enumerate() {
        let amounts = derive_purchase_line_amounts(i, line)?;
        let overflow = || "Purchase total is too large to post.".to_string();
        subtotal = subtotal
            .checked_add(amounts.subtotal_excl_vat_cents)
            .ok_or_else(overflow)?;
        vat_total = vat_total.checked_add(amounts.vat_cents).ok_or_else(overflow)?;
        total = total
            .checked_add(amounts.total_incl_vat_cents)
            .ok_or_else(overflow)?;
        lines.push(amounts);
    }

    Ok(PreparedPurchase {
        lines,
        subtotal_excl_vat_cents: subtotal,
        vat_total_cents: vat_total,
        total_incl_vat_cents: total,
    })
}

// ----------------------------------------------------------------------------
// Purchase identity (WP-05 Part I)
// ----------------------------------------------------------------------------

/// The canonical business content of a purchase: everything that decides WHICH
/// supplier bill was entered, in a form that compares equal for a true retry
/// and unequal for anything materially different.
///
/// Deliberately EXCLUDED, because comparing them would reject honest retries:
///   - `purchase_item_id` — regenerated per request by `db/repos/purchases.ts`
///     and by the Purchases page, so it is request noise, not business content.
///   - the client's `quantity_base`, `factor_*_snapshot` and
///     `product_uom_id_snapshot` — the backend derives all three from the
///     product's own `product_uoms` row (WP-03), so the payload copies are
///     non-authoritative. `quantity_in_uom` + `uom_code` are compared instead,
///     and the authoritative base follows from them.
///   - the per-base microcent costs — derived from the per-UoM cost and the
///     resolved factor, so comparing them would compare a derivation twice.
///   - `purchase_number` / `posted_at` — assigned by the first post.
///
/// `supplier_reference` IS compared, as typed: two bills quoting different
/// references are different documents even when they cost the same.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalPurchase {
    store_id: String,
    supplier_id: Option<String>,
    purchase_type: String,
    supplier_reference: Option<String>,
    purchase_date: String,
    created_by_user_id: Option<String>,
    device_id: Option<String>,
    notes: Option<String>,
    subtotal_excl_vat_cents: i64,
    vat_total_cents: i64,
    total_incl_vat_cents: i64,
    /// Sorted, so a retry is not rejected merely because rows came back in a
    /// different order.
    lines: Vec<CanonicalPurchaseLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CanonicalPurchaseLine {
    product_id: String,
    uom_code: String,
    quantity_in_uom: i64,
    unit_cost_excl_vat_in_uom_cents: i64,
    unit_cost_incl_vat_in_uom_cents: i64,
    vat_rate_id: String,
    vat_rate_bps: i64,
    line_subtotal_excl_vat_cents: i64,
    line_vat_cents: i64,
    line_total_incl_vat_cents: i64,
}

impl CanonicalPurchase {
    fn from_payload(payload: &PostPurchasePayload, prepared: &PreparedPurchase) -> Self {
        let mut lines: Vec<CanonicalPurchaseLine> = payload
            .lines
            .iter()
            .zip(&prepared.lines)
            .map(|(l, a)| CanonicalPurchaseLine {
                product_id: l.product_id.clone(),
                uom_code: l.uom_code_snapshot.clone(),
                quantity_in_uom: l.quantity_in_uom,
                unit_cost_excl_vat_in_uom_cents: l.unit_cost_excl_vat_in_uom_cents,
                unit_cost_incl_vat_in_uom_cents: l.unit_cost_incl_vat_in_uom_cents,
                vat_rate_id: l.vat_rate_id_snapshot.clone(),
                vat_rate_bps: l.vat_rate_bps_snapshot,
                line_subtotal_excl_vat_cents: a.subtotal_excl_vat_cents,
                line_vat_cents: a.vat_cents,
                line_total_incl_vat_cents: a.total_incl_vat_cents,
            })
            .collect();
        lines.sort();

        Self {
            store_id: payload.store_id.clone(),
            supplier_id: payload.supplier_id.clone(),
            purchase_type: payload.purchase_type.clone(),
            supplier_reference: payload.supplier_reference.clone(),
            purchase_date: payload.purchase_date.clone(),
            created_by_user_id: payload.created_by_user_id.clone(),
            device_id: payload.device_id.clone(),
            notes: payload.notes.clone(),
            subtotal_excl_vat_cents: prepared.subtotal_excl_vat_cents,
            vat_total_cents: prepared.vat_total_cents,
            total_incl_vat_cents: prepared.total_incl_vat_cents,
            lines,
        }
    }
}

struct PostedPurchase {
    purchase_number: i64,
    posted_at: String,
    status: String,
    canonical: CanonicalPurchase,
}

/// Load the purchase already stored under this document identity, if any, in
/// the same canonical form an incoming payload is reduced to.
async fn load_purchase_by_identity(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    purchase_id: &str,
) -> Result<Option<PostedPurchase>, String> {
    let header = sqlx::query(
        "SELECT store_id, supplier_id, purchase_type, supplier_reference,
                purchase_number, purchase_date, created_by_user_id, device_id, notes,
                subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
                status, posted_at
           FROM purchases WHERE id = ?",
    )
    .bind(purchase_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read purchase {purchase_id}: {e}"))?;

    let Some(row) = header else { return Ok(None) };
    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");

    let mut lines: Vec<CanonicalPurchaseLine> = sqlx::query(
        "SELECT product_id, uom_code_snapshot, quantity_in_uom,
                unit_cost_excl_vat_in_uom_cents, unit_cost_incl_vat_in_uom_cents,
                vat_rate_id_snapshot, vat_rate_bps_snapshot,
                line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents
           FROM purchase_items WHERE purchase_id = ?",
    )
    .bind(purchase_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("read purchase_items for {purchase_id}: {e}"))?
    .into_iter()
    .map(|r| {
        Ok(CanonicalPurchaseLine {
            product_id: r.try_get("product_id").map_err(d("product_id"))?,
            uom_code: r.try_get("uom_code_snapshot").map_err(d("uom_code"))?,
            quantity_in_uom: r.try_get("quantity_in_uom").map_err(d("quantity_in_uom"))?,
            unit_cost_excl_vat_in_uom_cents: r
                .try_get("unit_cost_excl_vat_in_uom_cents")
                .map_err(d("unit_cost_excl_in_uom"))?,
            unit_cost_incl_vat_in_uom_cents: r
                .try_get("unit_cost_incl_vat_in_uom_cents")
                .map_err(d("unit_cost_incl_in_uom"))?,
            vat_rate_id: r.try_get("vat_rate_id_snapshot").map_err(d("vat_rate_id"))?,
            vat_rate_bps: r.try_get("vat_rate_bps_snapshot").map_err(d("vat_rate_bps"))?,
            line_subtotal_excl_vat_cents: r
                .try_get("line_subtotal_excl_vat_cents")
                .map_err(d("line_subtotal"))?,
            line_vat_cents: r.try_get("line_vat_cents").map_err(d("line_vat"))?,
            line_total_incl_vat_cents: r
                .try_get("line_total_incl_vat_cents")
                .map_err(d("line_total"))?,
        })
    })
    .collect::<Result<Vec<_>, String>>()?;
    lines.sort();

    Ok(Some(PostedPurchase {
        purchase_number: row.try_get("purchase_number").map_err(d("purchase_number"))?,
        posted_at: row
            .try_get::<Option<String>, _>("posted_at")
            .map_err(d("posted_at"))?
            .unwrap_or_default(),
        status: row.try_get("status").map_err(d("status"))?,
        canonical: CanonicalPurchase {
            store_id: row.try_get("store_id").map_err(d("store_id"))?,
            supplier_id: row.try_get("supplier_id").map_err(d("supplier_id"))?,
            purchase_type: row.try_get("purchase_type").map_err(d("purchase_type"))?,
            supplier_reference: row
                .try_get("supplier_reference")
                .map_err(d("supplier_reference"))?,
            purchase_date: row.try_get("purchase_date").map_err(d("purchase_date"))?,
            created_by_user_id: row
                .try_get("created_by_user_id")
                .map_err(d("created_by_user_id"))?,
            device_id: row.try_get("device_id").map_err(d("device_id"))?,
            notes: row.try_get("notes").map_err(d("notes"))?,
            subtotal_excl_vat_cents: row
                .try_get("subtotal_excl_vat_cents")
                .map_err(d("subtotal"))?,
            vat_total_cents: row.try_get("vat_total_cents").map_err(d("vat_total"))?,
            total_incl_vat_cents: row.try_get("total_incl_vat_cents").map_err(d("total"))?,
            lines,
        },
    }))
}

/// Name the first material difference between a posted purchase and a replay of
/// it, or `None` when the replay is the same document.
fn purchase_replay_difference(
    posted: &CanonicalPurchase,
    replayed: &CanonicalPurchase,
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
    compare!("store", store_id);
    compare!("supplier", supplier_id);
    compare!("purchase type", purchase_type);
    compare!("supplier reference", supplier_reference);
    compare!("purchase date", purchase_date);
    compare!("buyer", created_by_user_id);
    compare!("device", device_id);
    compare!("notes", notes);
    compare!("subtotal", subtotal_excl_vat_cents);
    compare!("VAT total", vat_total_cents);
    compare!("total", total_incl_vat_cents);

    if posted.lines != replayed.lines {
        if posted.lines.len() != replayed.lines.len() {
            return Some((
                "line count",
                format!("{} line(s)", posted.lines.len()),
                format!("{} line(s)", replayed.lines.len()),
            ));
        }
        for (a, b) in posted.lines.iter().zip(&replayed.lines) {
            if a != b {
                return Some(("purchase line", format!("{a:?}"), format!("{b:?}")));
            }
        }
    }
    None
}

/// Rebuild the original command result for an already-posted purchase, so a
/// retry reconciles to the purchase that exists instead of creating a second
/// one — with a second payable, a second stock receipt and a second cost blend.
async fn result_for_posted_purchase(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    purchase_id: &str,
    existing: &PostedPurchase,
) -> Result<PostPurchaseResult, String> {
    let movement_ids: Vec<String> = sqlx::query(
        "SELECT id FROM inventory_movements WHERE related_purchase_id = ? ORDER BY rowid",
    )
    .bind(purchase_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("read movements for {purchase_id}: {e}"))?
    .into_iter()
    .map(|r| r.try_get::<String, _>("id").map_err(|e| format!("decode movement id: {e}")))
    .collect::<Result<Vec<_>, String>>()?;

    let ledger_entry_id: Option<String> = sqlx::query(
        "SELECT id FROM supplier_ledger
          WHERE related_purchase_id = ? AND entry_type = 'purchase' ORDER BY rowid LIMIT 1",
    )
    .bind(purchase_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read ledger entry for {purchase_id}: {e}"))?
    .map(|r| r.try_get::<String, _>("id").map_err(|e| format!("decode ledger id: {e}")))
    .transpose()?;

    Ok(PostPurchaseResult {
        purchase_id: purchase_id.to_string(),
        purchase_number: existing.purchase_number,
        posted_at: existing.posted_at.clone(),
        movement_ids,
        ledger_entry_id,
    })
}

/// The canonical normalized form of a supplier invoice reference, as SQL.
///
/// ONE definition in SQL, applied to both sides of every duplicate comparison:
/// the stored side is `purchases.supplier_reference_key`, a generated column
/// that migration 010 defines with exactly this expression, and the incoming
/// side is this text applied to the bound parameter. Normalizing in Rust
/// instead would fold Unicode case where SQLite's `UPPER` folds only ASCII, and
/// a probe that disagreed with the column it probes is how a duplicate slips
/// past the friendly check and surfaces as a raw trigger abort.
const SUPPLIER_REFERENCE_KEY_SQL: &str =
    "NULLIF(TRIM(UPPER(?), char(9,10,13,32)), '')";

#[tauri::command]
pub async fn post_purchase(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
    let prepared = prepare_purchase(&payload)?;

    let pool = pool(&app, &state).await?;
    post_purchase_tx(&pool, payload, prepared).await
}

/// Validate-then-post against an already-resolved pool. Preserves the command's
/// ordering (validation first) and is the entry point the test harness uses.
#[cfg(test)]
pub(crate) async fn post_purchase_with_pool(
    pool: &SqlitePool,
    payload: PostPurchasePayload,
) -> Result<PostPurchaseResult, String> {
    let prepared = prepare_purchase(&payload)?;
    post_purchase_tx(pool, payload, prepared).await
}

/// The transactional body of `post_purchase`.
pub(crate) async fn post_purchase_tx(
    pool: &SqlitePool,
    payload: PostPurchasePayload,
    prepared: PreparedPurchase,
) -> Result<PostPurchaseResult, String> {
    let subtotal = prepared.subtotal_excl_vat_cents;
    let vat_total = prepared.vat_total_cents;
    let total = prepared.total_incl_vat_cents;

    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    // ---- Idempotency: has this purchase identity already posted? (Part I) ----
    //
    // A duplicate purchase is a duplicate payable, a duplicate stock receipt
    // and a second blend into the weighted average, so a lost answer that the
    // client retries must land on the purchase it may already have created.
    //
    // Runs before anything is written, and in particular before a purchase
    // number is consumed, so a replay costs the sequence nothing.
    //
    // This is TECHNICAL retry idempotency and nothing else. It keys on
    // `purchases.id` — the document identity the caller minted once — never on
    // what the purchase contains. Two genuinely separate deliveries of the same
    // goods at the same price are two purchases; what stops the same BILL being
    // entered twice is the supplier-reference rule below, which is a different
    // question with a different answer.
    if let Some(existing) = load_purchase_by_identity(&mut tx, &payload.purchase_id).await? {
        if existing.status != "posted" {
            return Err(format!(
                "Purchase {} already exists with status '{}' and cannot be re-posted.",
                payload.purchase_id, existing.status
            ));
        }
        let replayed = CanonicalPurchase::from_payload(&payload, &prepared);
        if let Some((what, was, now_)) =
            purchase_replay_difference(&existing.canonical, &replayed)
        {
            return Err(format!(
                "Purchase {} already exists (purchase #{}) with a different {}: posted {}, \
                 replayed {}. Start a new purchase instead of reusing this one.",
                payload.purchase_id, existing.purchase_number, what, was, now_
            ));
        }
        let result = result_for_posted_purchase(&mut tx, &payload.purchase_id, &existing).await?;
        // Nothing was written; end the transaction without a commit.
        tx.rollback().await.map_err(|e| format!("close replay tx: {e}"))?;
        return Ok(result);
    }

    // ---- The supplier is this store's supplier ----
    //
    // A normal purchase raises a payable, and which store's books it lands in
    // decides whose payable it is. The foreign key only proves the supplier
    // exists somewhere.
    if let Some(supplier_id) = &payload.supplier_id {
        assert_supplier_belongs_to_store(&mut tx, supplier_id, &payload.store_id).await?;
    }

    // ---- One posted purchase per supplier invoice reference (Part B) ----
    //
    // A supplier bill is a document, and entering it twice books the goods
    // twice: two payables for one delivery, two stock receipts, two blends into
    // the cost pool. The shop then owes double and nothing in the ledger says
    // which half is real.
    //
    // Scoped to (store, supplier, normalized reference) and to POSTED
    // purchases, because that is the scope in which a reference identifies a
    // document: two suppliers may both number their invoices "1001", and a
    // voided purchase has released its reference. A blank or whitespace-only
    // reference normalizes to NULL and constrains nothing — a cash-and-carry
    // receipt with no number to quote is not a duplicate of the next one.
    //
    // Checked HERE, before a purchase number is consumed and before any row,
    // movement or ledger entry is written, so the common case fails with an
    // error a buyer can act on. `trg_purchases_no_duplicate_supplier_invoice_*`
    // is the backstop for the interleaved case and for every writer that does
    // not come through this command.
    if let (Some(supplier_id), Some(reference)) =
        (payload.supplier_id.as_deref(), payload.supplier_reference.as_deref())
    {
        if !reference.trim().is_empty() {
            let existing = sqlx::query(&format!(
                "SELECT purchase_number, purchase_date FROM purchases
                  WHERE store_id = ? AND supplier_id = ? AND status = 'posted'
                    AND supplier_reference_key IS NOT NULL
                    AND supplier_reference_key = {SUPPLIER_REFERENCE_KEY_SQL}
                  ORDER BY purchase_number LIMIT 1"
            ))
            .bind(&payload.store_id)
            .bind(supplier_id)
            .bind(reference)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| format!("check supplier reference {reference}: {e}"))?;

            if let Some(row) = existing {
                let number: i64 = row
                    .try_get("purchase_number")
                    .map_err(|e| format!("decode purchase_number: {e}"))?;
                let date: String = row
                    .try_get("purchase_date")
                    .map_err(|e| format!("decode purchase_date: {e}"))?;
                return Err(format!(
                    "Supplier invoice \"{reference}\" is already posted for this supplier as \
                     purchase #{number} of {date}. Open that purchase instead of entering the \
                     bill a second time."
                ));
            }
        }
    }

    // ---- One authoritative unit price per line (WP-05 correction) ----
    //
    // The invoice states ONE price per unit. `vat_pricing_mode` names which
    // side of each line's excl/incl pair that is — the payload's, or the
    // product's own `vat_pricing_mode` when the payload is silent — and
    // `derive_unit_cost_pair` computes the counterpart and refuses a line whose
    // declared counterpart disagrees.
    //
    // Without this, "net $20.00, gross $999.00 at 11%" was a payload the
    // backend had no opinion about: the stock went in at a $20 cost basis while
    // the supplier ledger took $999 of debt, from one delivery, on rows that
    // can never be edited again.
    //
    // A PRE-PASS, deliberately. It runs before the purchase number is consumed
    // and before the first `purchase_items` insert, so a malformed pair on
    // line 2 cannot leave line 1's goods, cost blend or sequence advance behind
    // even transiently — the rejection is clean rather than merely rolled back.
    // Same placement, and same reasoning, as the duplicate-invoice check above.
    for (i, line) in payload.lines.iter().enumerate() {
        let mode = match line.vat_pricing_mode.as_deref() {
            Some(declared) => VatPricingMode::parse(declared)
                .map_err(|e| format!("Line {}: {}", i + 1, e))?,
            None => {
                // The product's own pricing mode is the fallback, which is what
                // the Purchases page initialises its per-line toggle from. A
                // caller that predates this field therefore keeps working, and
                // keeps working the way the UI would have.
                let stored: String = sqlx::query(
                    "SELECT vat_pricing_mode FROM products WHERE id = ? AND store_id = ?",
                )
                .bind(&line.product_id)
                .bind(&payload.store_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| format!("read pricing mode for {}: {e}", line.product_id))?
                .ok_or_else(|| {
                    // The same wording the line loop uses, so the error does not
                    // depend on which stage noticed the product was missing.
                    format!(
                        "Product {} not found in store {}",
                        line.product_id, payload.store_id
                    )
                })?
                .try_get("vat_pricing_mode")
                .map_err(|e| format!("decode vat_pricing_mode: {e}"))?;
                VatPricingMode::parse(&stored).map_err(|e| {
                    format!(
                        "Product {} carries an unusable pricing mode: {}",
                        line.product_id, e
                    )
                })?
            }
        };
        // The derived pair is equal to the declared one by construction — that
        // IS the check — so the value itself is nothing the caller needs. What
        // matters is that a line which could not produce it never gets past
        // here. The per-base microcent costs below are then derived from a pair
        // that has been proved to be one price, which is what makes the stock's
        // cost basis and the supplier's debt two views of the same money.
        derive_unit_cost_pair(i, line, mode)?;
    }

    let purchase_number = next_purchase_number(&mut tx, &payload.store_id).await?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

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

    for (line, amounts) in payload.lines.iter().zip(&prepared.lines) {
        let purchase_item_id = if line.purchase_item_id.trim().is_empty() {
    uuid::Uuid::new_v4().to_string()
} else {
    line.purchase_item_id.clone()
};
        let row = sqlx::query(
            "SELECT quantity_on_hand,
                    avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents
             FROM products WHERE id = ? AND store_id = ?",
        )
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read product {}: {e}", line.product_id))?
        .ok_or_else(|| format!("Product {} not found in store {}", line.product_id, payload.store_id))?;

        let old_qty: i64 = row.try_get("quantity_on_hand").map_err(|e| format!("decode qoh: {e}"))?;
        let old_avg_excl: i64 = row
            .try_get("avg_cost_excl_vat_microcents")
            .map_err(|e| format!("decode avg_excl: {e}"))?;
        let old_avg_incl: i64 = row
            .try_get("avg_cost_incl_vat_microcents")
            .map_err(|e| format!("decode avg_incl: {e}"))?;

        // ---- Authoritative UoM + base quantity ----
        // The product's own `product_uoms` row — never the payload — decides the
        // conversion. `uom_code_snapshot` is only the lookup key; scoping the
        // query by `product_id` is what makes a UoM belonging to another product
        // unresolvable here, and `is_active = 1` is what makes a retired UoM
        // unusable. Receiving goods moves physical stock and rewrites the cost
        // pool, so it needs the same DB authority `post_sale` has had since
        // WP-02 (GP-A02): without it a stale client could post 2 boxes of 12 as
        // 2 base units, and the weighted average would blend a precise cost
        // against a quantity nobody received.
        let uom_row = sqlx::query(
            "SELECT id, factor_num, factor_den
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
                "Line for \"{}\": UoM \"{}\" is not an active unit of measure for this product.",
                line.product_name_snapshot, line.uom_code_snapshot
            )
        })?;
        let resolved_uom_id: String = uom_row
            .try_get("id")
            .map_err(|e| format!("decode product_uom id: {e}"))?;
        let factor_num: i64 = uom_row
            .try_get("factor_num")
            .map_err(|e| format!("decode factor_num: {e}"))?;
        let factor_den: i64 = uom_row
            .try_get("factor_den")
            .map_err(|e| format!("decode factor_den: {e}"))?;

        // A client that names a specific `product_uoms` row must name the one
        // that resolved. This is where another product's UoM id, or a stale id
        // for a since-replaced row, is caught.
        if let Some(claimed_uom_id) = line.product_uom_id_snapshot.as_deref() {
            if !claimed_uom_id.is_empty() && claimed_uom_id != resolved_uom_id {
                return Err(format!(
                    "Line for \"{}\": the declared UoM row {} is not the active \"{}\" unit of \
                     measure for this product ({}).",
                    line.product_name_snapshot,
                    claimed_uom_id,
                    line.uom_code_snapshot,
                    resolved_uom_id
                ));
            }
        }

        // A payload whose declared factor contradicts the product's own
        // conversion is structurally corrupt (a stale cart, an edited UoM, a bad
        // integration). Refuse it rather than silently normalize: the buyer
        // priced the goods against the conversion they believed in, so posting
        // under a different one would invent a cost they never agreed to.
        if line.factor_num_snapshot != factor_num || line.factor_den_snapshot != factor_den {
            return Err(format!(
                "Line for \"{}\": declared UoM factor {}/{} does not match the authoritative \
                 conversion for \"{}\" ({}/{}).",
                line.product_name_snapshot,
                line.factor_num_snapshot,
                line.factor_den_snapshot,
                line.uom_code_snapshot,
                factor_num,
                factor_den
            ));
        }

        let quantity_base = derive_base_quantity(line.quantity_in_uom, factor_num, factor_den)
            .map_err(|e| {
                format!(
                    "Line for \"{}\": invalid quantity in UoM \"{}\" — {}.",
                    line.product_name_snapshot, line.uom_code_snapshot, e
                )
            })?;
        if line.quantity_base != quantity_base {
            return Err(format!(
                "Line for \"{}\": declared base quantity {} does not match the authoritative UoM \
                 conversion ({} {} × {}/{} = {}).",
                line.product_name_snapshot,
                line.quantity_base,
                line.quantity_in_uom,
                line.uom_code_snapshot,
                factor_num,
                factor_den,
                quantity_base
            ));
        }

        // ---- Per-base unit cost, at microcent precision (GP-A03) ----
        // Derived here from the invoice's per-UoM cost and the AUTHORITATIVE
        // factor resolved above, NOT taken from the payload: the payload only
        // carries a cents-rounded copy, which is zero for anything cheaper than
        // a cent per base unit. One division, at microcent scale, no
        // intermediate rounding to cents — and over the same conversion that
        // drives the quantity, so cost and stock cannot disagree.
        let unit_cost_excl_base_mc = unit_cost_in_uom_to_base_microcents(
            line.unit_cost_excl_vat_in_uom_cents,
            factor_num,
            factor_den,
        )
        .map_err(|e| format!("Line for \"{}\": {}.", line.product_name_snapshot, e))?;
        let unit_cost_incl_base_mc = unit_cost_in_uom_to_base_microcents(
            line.unit_cost_incl_vat_in_uom_cents,
            factor_num,
            factor_den,
        )
        .map_err(|e| format!("Line for \"{}\": {}.", line.product_name_snapshot, e))?;
        // The rounded mirrors the legacy cents columns keep. Presentation only.
        let unit_cost_excl_base_cents = microcents_to_cents(unit_cost_excl_base_mc)?;
        let unit_cost_incl_base_cents = microcents_to_cents(unit_cost_incl_base_mc)?;

        // The weighted average blends the precise cost against the DERIVED base
        // quantity, so the pool's value and its quantity come from one resolved
        // conversion.
        let new_avg_excl =
            new_weighted_avg(old_qty, old_avg_excl, quantity_base, unit_cost_excl_base_mc)?;
        let new_avg_incl =
            new_weighted_avg(old_qty, old_avg_incl, quantity_base, unit_cost_incl_base_mc)?;

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
                 unit_cost_excl_vat_base_microcents, unit_cost_incl_vat_base_microcents,
                 vat_rate_id_snapshot, vat_rate_bps_snapshot,
                 line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
                 related_movement_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&purchase_item_id)
        .bind(&payload.purchase_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(&line.product_name_snapshot)
        .bind(&line.product_sku_snapshot)
        .bind(&resolved_uom_id)
        .bind(&line.uom_code_snapshot)
        .bind(factor_num)
        .bind(factor_den)
        .bind(line.quantity_in_uom)
        .bind(quantity_base)
        .bind(line.unit_cost_excl_vat_in_uom_cents)
        .bind(line.unit_cost_incl_vat_in_uom_cents)
        .bind(unit_cost_excl_base_cents)
        .bind(unit_cost_incl_base_cents)
        .bind(unit_cost_excl_base_mc)
        .bind(unit_cost_incl_base_mc)
        .bind(&line.vat_rate_id_snapshot)
        .bind(line.vat_rate_bps_snapshot)
        // The DERIVED line money (Part C), not the payload's copy of it. The
        // two were proved equal by `derive_purchase_line_amounts`; writing the
        // derived one is what makes the header — and the payable that is summed
        // from these rows — a figure the backend stands behind.
        .bind(amounts.subtotal_excl_vat_cents)
        .bind(amounts.vat_cents)
        .bind(amounts.total_incl_vat_cents)
        .bind(Option::<String>::None)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert purchase_item: {e}"))?;
        sqlx::query(
            r#"INSERT INTO inventory_movements (
                 id, store_id, product_id, movement_type, quantity_delta,
                 unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
                 unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents,
                 related_purchase_id, related_purchase_item_id,
                 supplier_reference, notes,
                 created_by_user_id, device_id, posted_at,
                 quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&movement_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(movement_type)
        .bind(quantity_base)
        .bind(unit_cost_excl_base_cents)
        .bind(unit_cost_incl_base_cents)
        .bind(unit_cost_excl_base_mc)
        .bind(unit_cost_incl_base_mc)
        .bind(&payload.purchase_id)
        .bind(&purchase_item_id)
        .bind(&payload.supplier_reference)
        .bind(&payload.notes)
        .bind(&payload.created_by_user_id)
        .bind(&payload.device_id)
        .bind(&now)
        .bind(line.quantity_in_uom)
        .bind(&line.uom_code_snapshot)
        .bind(factor_num)
        .bind(factor_den)
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
                  SET quantity_on_hand             = quantity_on_hand + ?,
                      avg_cost_excl_vat_microcents = ?,
                      avg_cost_incl_vat_microcents = ?,
                      avg_cost_excl_vat_cents      = ?,
                      avg_cost_incl_vat_cents      = ?
                WHERE id = ? AND store_id = ?"#,
        )
        .bind(quantity_base)
        .bind(new_avg_excl)
        .bind(new_avg_incl)
        .bind(microcents_to_cents(new_avg_excl)?)
        .bind(microcents_to_cents(new_avg_incl)?)
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update product stock/cost: {e}"))?;
    }

    // --- Ledger entry: only for 'normal' purchases with a supplier. ---
    //
    // The payable raised is `total` — the purchase's own authoritative
    // VAT-inclusive total, derived by `prepare_purchase` from the invoice costs
    // and summed from the very rows written above. There is no second amount on
    // the wire for a caller to put here instead, which is the whole of Part C:
    // `SUM(supplier_ledger.amount_cents WHERE entry_type='purchase')` for a
    // supplier can only ever equal the sum of its posted purchase totals.
    //
    // Written inside the same transaction as the purchase, its lines, its
    // movements and its stock and cost updates, so there is no state in which a
    // delivery was received without the debt for it, or the debt without the
    // goods. An 'opening' batch raises nothing: opening stock is not something
    // the shop owes anybody for.
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

        // An adjustment is valued at the product's CURRENT weighted-average
        // cost, snapshotted at microcent precision so a sub-cent ingredient's
        // write-off is not valued at zero.
        let cost_row = sqlx::query(
            "SELECT avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents
             FROM products WHERE id = ? AND store_id = ?",
        )
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("read avg cost: {e}"))?;
        let avg_excl_mc: i64 = cost_row
            .try_get("avg_cost_excl_vat_microcents")
            .map_err(|e| format!("decode: {e}"))?;
        let avg_incl_mc: i64 = cost_row
            .try_get("avg_cost_incl_vat_microcents")
            .map_err(|e| format!("decode: {e}"))?;

        sqlx::query(
            r#"INSERT INTO inventory_movements (
                 id, store_id, product_id, movement_type, quantity_delta,
                 unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
                 unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents,
                 notes,
                 created_by_user_id, device_id, posted_at,
                 quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot
               ) VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )

        .bind(&line.movement_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(line.quantity_base_signed)
        .bind(microcents_to_cents(avg_excl_mc)?)
        .bind(microcents_to_cents(avg_incl_mc)?)
        .bind(avg_excl_mc)
        .bind(avg_incl_mc)
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

/// Pure pre-DB validation for `post_supplier_payment`.
///
/// Returns the AUTHORITATIVE signed ledger amount, because deciding it is part
/// of validating the request: the magnitude has to be positive and the
/// direction has to be knowable before there is anything worth writing. The
/// command runs this before acquiring the pool, as it always has.
pub(crate) fn validate_supplier_payment_payload(
    payload: &PostSupplierPaymentPayload,
) -> Result<i64, String> {
    // `purchase` is deliberately absent: only `post_purchase` may raise a
    // payable, and it does so from the purchase document's own total. A caller
    // able to book an arbitrary invoice liability through this command could
    // invent debt with no goods, no lines and no paper behind it.
    let allowed = ["payment", "credit_note", "opening_balance", "adjustment"];
    if !allowed.contains(&payload.entry_type.as_str()) {
        return Err(format!("Invalid entry_type for this command: {}", payload.entry_type));
    }
    if payload.ledger_entry_id.trim().is_empty() {
        return Err("A ledger entry id is required.".into());
    }
    if payload.store_id.trim().is_empty() {
        return Err("A store is required.".into());
    }
    if payload.supplier_id.trim().is_empty() {
        return Err("A supplier is required.".into());
    }
    let amount_cents = resolve_ledger_amount(
        &payload.entry_type,
        payload.amount_magnitude_cents,
        payload.amount_cents,
    )?;
    if payload.entry_type == "adjustment" && payload.notes.as_deref().unwrap_or("").trim().is_empty() {
        return Err("Adjustment entries require a note explaining why.".into());
    }
    if payload.entry_date.trim().is_empty() {
        return Err("Entry date is required.".into());
    }
    Ok(amount_cents)
}

/// The business content of a supplier-ledger entry, in a form that compares
/// equal for a true retry and unequal for anything materially different.
///
/// `amount_cents` here is the DERIVED signed amount, not the payload's: a
/// client that sent a payment as `+5000` on the first attempt and `−5000` on
/// the retry sent the same payment twice, and must be told so rather than
/// handed a conflict over a sign the backend was never going to honour.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalLedgerEntry {
    store_id: String,
    supplier_id: String,
    entry_type: String,
    amount_cents: i64,
    entry_date: String,
    payment_reference: Option<String>,
    notes: Option<String>,
}

struct PostedLedgerEntry {
    posted_at: String,
    canonical: CanonicalLedgerEntry,
}

/// Load the entry already stored under this payment identity, if any.
async fn load_ledger_entry_by_identity(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    ledger_entry_id: &str,
) -> Result<Option<PostedLedgerEntry>, String> {
    let row = sqlx::query(
        "SELECT store_id, supplier_id, entry_type, amount_cents, entry_date,
                payment_reference, notes, posted_at
           FROM supplier_ledger WHERE id = ?",
    )
    .bind(ledger_entry_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read supplier_ledger entry {ledger_entry_id}: {e}"))?;

    let Some(row) = row else { return Ok(None) };
    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");

    Ok(Some(PostedLedgerEntry {
        posted_at: row.try_get("posted_at").map_err(d("posted_at"))?,
        canonical: CanonicalLedgerEntry {
            store_id: row.try_get("store_id").map_err(d("store_id"))?,
            supplier_id: row.try_get("supplier_id").map_err(d("supplier_id"))?,
            entry_type: row.try_get("entry_type").map_err(d("entry_type"))?,
            amount_cents: row.try_get("amount_cents").map_err(d("amount_cents"))?,
            entry_date: row.try_get("entry_date").map_err(d("entry_date"))?,
            payment_reference: row
                .try_get("payment_reference")
                .map_err(d("payment_reference"))?,
            notes: row.try_get("notes").map_err(d("notes"))?,
        },
    }))
}

/// Name the first material difference between a stored entry and a replay of
/// it, or `None` when the replay is the same payment.
fn ledger_replay_difference(
    posted: &CanonicalLedgerEntry,
    replayed: &CanonicalLedgerEntry,
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
    compare!("store", store_id);
    compare!("supplier", supplier_id);
    compare!("entry type", entry_type);
    compare!("amount", amount_cents);
    compare!("entry date", entry_date);
    compare!("reference", payment_reference);
    compare!("notes", notes);
    None
}

#[tauri::command]
pub async fn post_supplier_payment(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: PostSupplierPaymentPayload,
) -> Result<PostSupplierPaymentResult, String> {
    let amount_cents = validate_supplier_payment_payload(&payload)?;

    let pool = pool(&app, &state).await?;
    post_supplier_payment_tx(&pool, payload, amount_cents).await
}

/// Validate-then-post against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn post_supplier_payment_with_pool(
    pool: &SqlitePool,
    payload: PostSupplierPaymentPayload,
) -> Result<PostSupplierPaymentResult, String> {
    let amount_cents = validate_supplier_payment_payload(&payload)?;
    post_supplier_payment_tx(pool, payload, amount_cents).await
}

/// The transactional body of `post_supplier_payment`.
///
/// `amount_cents` is the signed amount `validate_supplier_payment_payload`
/// derived. The payload's own `amount_cents` is never written.
pub(crate) async fn post_supplier_payment_tx(
    pool: &SqlitePool,
    payload: PostSupplierPaymentPayload,
    amount_cents: i64,
) -> Result<PostSupplierPaymentResult, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let replayed = CanonicalLedgerEntry {
        store_id: payload.store_id.clone(),
        supplier_id: payload.supplier_id.clone(),
        entry_type: payload.entry_type.clone(),
        amount_cents,
        entry_date: payload.entry_date.clone(),
        payment_reference: payload.payment_reference.clone(),
        notes: payload.notes.clone(),
    };

    // ---- Idempotency: has this payment identity already posted? ----
    //
    // Before anything is written, and in particular before the overpayment
    // check below — which a replay would fail, because the payable it would be
    // tested against already includes this very payment. A retry after a lost
    // answer is the case that matters: the money has left the shop, the ledger
    // already says so, and the caller needs to be told which entry it was, not
    // handed a second one or an error about a balance it already paid down.
    if let Some(existing) = load_ledger_entry_by_identity(&mut tx, &payload.ledger_entry_id).await? {
        if let Some((what, was, now_)) =
            ledger_replay_difference(&existing.canonical, &replayed)
        {
            return Err(format!(
                "Supplier ledger entry {} already exists with a different {}: posted {}, \
                 replayed {}. Record a new entry instead of reusing this one.",
                payload.ledger_entry_id, what, was, now_
            ));
        }
        let new_balance = current_supplier_balance(&mut tx, &payload.supplier_id).await?;
        // Nothing was written; end the transaction without a commit.
        tx.rollback().await.map_err(|e| format!("close replay tx: {e}"))?;
        return Ok(PostSupplierPaymentResult {
            ledger_entry_id: payload.ledger_entry_id,
            posted_at: existing.posted_at,
            new_balance_cents: new_balance,
        });
    }

    // ---- The supplier is this store's supplier ----
    //
    // The foreign key only proves the supplier exists somewhere. Which store's
    // books the entry lands in decides which store's payable it reduces, so it
    // is checked rather than assumed.
    assert_supplier_belongs_to_store(&mut tx, &payload.supplier_id, &payload.store_id).await?;

    // ---- A payment cannot exceed what is outstanding (Part E) ----
    //
    // Greaz models no supplier advance and no supplier receivable: there is no
    // prepayment document, no advance account, and nothing that would ever draw
    // such a balance back down. A payment that overshot would leave a negative
    // payable that only looks like an asset, and since ledger rows are
    // immutable it could never be unwound — only offset by a second entry that
    // misstates something else.
    //
    // Negative balances remain reachable, deliberately, through the two
    // explicitly-signed instruments: a `credit_note` the supplier actually
    // issued, or an `adjustment` somebody signed off in writing. Those are
    // decisions a human made about a real document. An overpayment is a typo.
    //
    // The balance is read HERE, inside the transaction that writes the payment,
    // never from the caller. Two payments racing against one remaining balance
    // cannot both commit: SQLite runs one write transaction at a time, so the
    // second either sees the first's row in this sum, or cannot commit at all.
    if payload.entry_type == "payment" {
        let outstanding = current_supplier_balance(&mut tx, &payload.supplier_id).await?;
        let paying = -amount_cents; // positive: `payment` is a Decrease
        if outstanding <= 0 {
            return Err(format!(
                "There is nothing outstanding to pay: the supplier's balance is {} cents. \
                 Record a credit note or an adjustment if the supplier owes the shop.",
                outstanding
            ));
        }
        if paying > outstanding {
            return Err(format!(
                "Payment of {} cents exceeds the {} cents outstanding. Pay the balance or less — \
                 the shop does not carry supplier advances.",
                paying, outstanding
            ));
        }
    }

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
    .bind(amount_cents)
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

    // REQUIRED for a new sale, despite the `Option`: `post_sale_tx` refuses a
    // payload that omits it, and refuses one naming a shift that is not an open
    // shift of `store_id` (WP-04, GZ-HI-03). The type stays optional because the
    // replay path must still accept `None` — a sale posted before that rule
    // exists carries a NULL `shift_id`, and retrying it has to return the
    // receipt it already has rather than fail on history nobody can change.
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

// ============================================================================
// Tender vocabulary and currency conversion (WP-04)
// ============================================================================

/// Every `sale_payments.method` the schema's CHECK constraint allows.
pub(crate) const PAYMENT_METHODS: [&str; 8] = [
    "cash_usd",
    "cash_lbp",
    "card_usd",
    "card_lbp",
    "bank_transfer",
    "wallet",
    "store_credit",
    "other",
];

/// Whether a tender method puts money in, or takes money out of, the physical
/// cash drawer. This is the ONE definition of "cash" in the backend: the change
/// rules in `prepare_sale` and the expected-drawer figure in `close_shift` both
/// derive from it, so they cannot disagree about whether a card touches cash.
pub(crate) fn is_cash_method(method: &str) -> bool {
    method == "cash_usd" || method == "cash_lbp"
}

/// The currency a method's name commits it to, if it names one at all.
/// `bank_transfer`, `wallet`, `store_credit` and `other` may be either.
pub(crate) fn method_currency(method: &str) -> Option<&'static str> {
    match method {
        "cash_usd" | "card_usd" => Some("USD"),
        "cash_lbp" | "card_lbp" => Some("LBP"),
        _ => None,
    }
}

/// LBP to USD cents at `rate_lbp_per_usd`: `round(lbp x 100 / rate)`, half away
/// from zero.
///
/// Mirrors `lib/money.ts::lbpToUsdCents` exactly, but in integer arithmetic
/// with no float step: the product is taken in i128 so a large lira amount
/// cannot overflow on the way, and the half-up adjustment is exact rather than
/// the result of an f64 division that happened to land near a boundary.
pub(crate) fn lbp_to_usd_cents(lbp: i64, rate_lbp_per_usd: i64) -> Result<i64, String> {
    if lbp < 0 {
        return Err("an LBP tender cannot be negative".into());
    }
    if rate_lbp_per_usd <= 0 {
        return Err("exchange rate must be positive".into());
    }
    let rate = i128::from(rate_lbp_per_usd);
    let cents = (i128::from(lbp) * 100 + rate / 2) / rate;
    i64::try_from(cents).map_err(|_| "LBP tender overflows when converted to USD cents".to_string())
}

/// USD cents to LBP at `rate_lbp_per_usd`: `round(cents x rate / 100)`, half
/// away from zero. Mirrors `lib/money.ts::usdCentsToLbp`.
pub(crate) fn usd_cents_to_lbp(cents: i64, rate_lbp_per_usd: i64) -> Result<i64, String> {
    if cents < 0 {
        return Err("a USD amount converted to LBP cannot be negative".into());
    }
    if rate_lbp_per_usd <= 0 {
        return Err("exchange rate must be positive".into());
    }
    let lbp = (i128::from(cents) * i128::from(rate_lbp_per_usd) + 50) / 100;
    i64::try_from(lbp).map_err(|_| "USD amount overflows when converted to LBP".to_string())
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

    // ---- Validation: payments (GZ-HI-04) ----
    //
    // THE SUPPORTED TENDER MATRIX. `method` says how the money arrived and,
    // for the four methods whose name names a currency, in which currency.
    // `currency` must agree with it, and the native amount must be the one
    // that currency is denominated in:
    //
    //   method         | currency | native column           | drawer cash?
    //   ---------------|----------|-------------------------|--------------
    //   cash_usd       | USD      | amount_native_usd_cents | yes, USD
    //   cash_lbp       | LBP      | amount_native_lbp       | yes, LBP
    //   card_usd       | USD      | amount_native_usd_cents | no
    //   card_lbp       | LBP      | amount_native_lbp       | no
    //   bank_transfer  | either   | matching native column  | no
    //   wallet         | either   | matching native column  | no
    //   store_credit   | either   | matching native column  | no
    //   other          | either   | matching native column  | no
    //
    // The POS emits the first three; the rest are schema-legal and left
    // accepted so WP-05/WP-06 need not reopen this list. A row that
    // contradicts itself — `cash_usd` declared in LBP, a USD row carrying an
    // LBP amount, a USD equivalent that is not what the native amount converts
    // to — is not a tender anyone took, and it is immutable once posted.
    for (i, p) in payload.payments.iter().enumerate() {
        let n = i + 1;
        if !PAYMENT_METHODS.contains(&p.method.as_str()) {
            return Err(format!("Payment {} has invalid method: {}", n, p.method));
        }
        if p.currency != "USD" && p.currency != "LBP" {
            return Err(format!("Payment {} has invalid currency: {}", n, p.currency));
        }
        if let Some(required) = method_currency(&p.method) {
            if p.currency != required {
                return Err(format!(
                    "Payment {}: method \"{}\" is a {} tender, but the row declares currency {}.",
                    n, p.method, required, p.currency
                ));
            }
        }
        if p.amount_usd_cents_equivalent <= 0 {
            return Err(format!("Payment {} has non-positive amount.", n));
        }
        // Enforce the same CHECK the schema enforces, so the error is friendly
        // (the constraint would otherwise raise a raw driver error).
        let usd_ok = p.amount_native_usd_cents > 0
            && p.currency == "USD"
            && p.amount_native_lbp == 0;
        let lbp_ok = p.amount_native_lbp > 0
            && p.currency == "LBP"
            && p.amount_native_usd_cents == 0;
        if !(usd_ok || lbp_ok) {
            return Err(format!(
                "Payment {}: native amounts inconsistent with currency.",
                n
            ));
        }

        // ---- The USD equivalent is DERIVED, not declared (GZ-HI-04) ----
        // A USD tender's USD equivalent is the amount itself. An LBP tender's
        // is its native amount converted at the rate this sale declares as
        // locked. That declared rate is not taken on trust either:
        // `post_sale_tx` proves it equals the `exchange_rates` row named by
        // `exchange_rate_id` before anything is written, so the two checks
        // together mean every LBP equivalent persisted was computed from the
        // stored locked rate — never from an arbitrary client figure.
        let derived = if p.currency == "USD" {
            p.amount_native_usd_cents
        } else {
            lbp_to_usd_cents(p.amount_native_lbp, payload.exchange_rate_lbp_per_usd)
                .map_err(|e| format!("Payment {}: {}.", n, e))?
        };
        if p.amount_usd_cents_equivalent != derived {
            let native = if p.currency == "USD" {
                p.amount_native_usd_cents
            } else {
                p.amount_native_lbp
            };
            return Err(format!(
                "Payment {}: declared USD equivalent of {} cents does not match {} {} at the \
                 locked rate of {} LBP/USD, which is {} cents.",
                n,
                p.amount_usd_cents_equivalent,
                native,
                p.currency,
                payload.exchange_rate_lbp_per_usd,
                derived
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

    // ---- Change is a CASH movement, and only cash can create it (GZ-HI-04) ----
    //
    // Change is physical money handed back out of the till. Two rules follow,
    // and together they make an invented drawer movement impossible:
    //
    // 1. NON-CASH TENDER MAY NEVER EXCEED THE AMOUNT DUE. A card swiped for
    //    more than the bill is not change owed from the drawer — it is an
    //    over-charge on the card, and the remedy is a smaller swipe or a refund
    //    through the card network. This application has no refund operation
    //    (returns and credit memos are WP-06), so there is nothing honest to do
    //    with the surplus and the sale is refused. Previously the surplus was
    //    written to `change_given_usd_cents` on the card row, and shift close
    //    then subtracted it from expected physical cash: a card overpayment
    //    made the drawer look short by the overpaid amount, for ever.
    //
    // 2. THE ROW THAT ABSORBS THE CHANGE IS ALWAYS A CASH ROW. With rule 1 in
    //    force the overpayment is necessarily covered by cash tendered, so such
    //    a row always exists; the lookup below returns an error rather than
    //    falling back to row 0, which is how a card row used to acquire change.
    let non_cash_usd: i64 = payload
        .payments
        .iter()
        .filter(|p| !is_cash_method(&p.method))
        .map(|p| p.amount_usd_cents_equivalent)
        .sum();
    if non_cash_usd > total {
        return Err(format!(
            "Non-cash tender of {} USD-cents exceeds the {} USD-cents due. A card, transfer or \
             wallet payment cannot be over-collected and handed back as cash from the drawer — \
             charge the amount that is owed.",
            non_cash_usd, total
        ));
    }

    // ---- Decide which payment row absorbs the change (if any) ----
    // Preference: first cash_usd, then first cash_lbp. A till holding both
    // hands USD back. This is the currency policy the application has always
    // implemented — see the `pos.changeDue` / `pos.lbpChange` pair in
    // `pages/PosRegister.tsx`, which shows the USD figure with its LBP
    // equivalent beside it — and WP-04 preserves it unchanged.
    let change_row_index: Option<usize> = if change_total_usd > 0 {
        let cash_row = payload
            .payments
            .iter()
            .position(|p| p.method == "cash_usd")
            .or_else(|| payload.payments.iter().position(|p| p.method == "cash_lbp"));
        match cash_row {
            Some(i) => Some(i),
            None => {
                return Err(format!(
                    "Overpayment of {} USD-cents with no cash tender to hand it back from. Change \
                     is cash out of the drawer, so a non-cash tender cannot produce it.",
                    change_total_usd
                ))
            }
        }
    } else {
        None
    };

    // Defence in depth. The two rules above already imply it, but the drawer
    // going negative on a non-cash overpayment is the exact failure this work
    // package exists to prevent, so the invariant is stated rather than
    // inferred: no later edit to either rule can quietly reintroduce it.
    if change_total_usd > 0 {
        let cash_usd: i64 = payload
            .payments
            .iter()
            .filter(|p| is_cash_method(&p.method))
            .map(|p| p.amount_usd_cents_equivalent)
            .sum();
        if change_total_usd > cash_usd {
            return Err(format!(
                "Change of {} USD-cents exceeds the {} USD-cents of cash tendered.",
                change_total_usd, cash_usd
            ));
        }
    }

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
    /// Per-base-unit COGS in MICROCENTS — the precise rate the line is costed
    /// at, never rounded to cents before it is multiplied out.
    unit_cogs_excl_mc: i64,
    unit_cogs_incl_mc: i64,
    /// The line's COGS as money: `round(unit_cogs_excl_mc x quantity_base /
    /// COST_SCALE)`, the single rounding boundary between cost and cents.
    line_cogs_cents: i64,
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

    // ---- The locked exchange rate is the DATABASE's, not the payload's (WP-04) ----
    //
    // `exchange_rate_id` names the rate this sale is locked to; the FK already
    // guarantees that row exists. What it does not guarantee is that the row
    // belongs to this store, or that `exchange_rate_lbp_per_usd` is the rate the
    // row actually carries. Both matter, because `prepare_sale` converted every
    // LBP tender at the declared rate: proving the declared rate IS the stored
    // one is what makes those USD equivalents equivalents of the locked rate
    // rather than of a number the client chose. It also makes the LBP change
    // below, and every historical reprint of this receipt, use one single rate.
    //
    // Checked before a receipt number is consumed, so a bad rate costs the
    // sequence nothing.
    let locked_rate: i64 = {
        let row = sqlx::query(
            "SELECT rate_lbp_per_usd FROM exchange_rates WHERE id = ? AND store_id = ?",
        )
        .bind(&payload.exchange_rate_id)
        .bind(&payload.store_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| format!("read exchange rate {}: {e}", payload.exchange_rate_id))?
        .ok_or_else(|| {
            format!(
                "Exchange rate {} is not a rate of store {}.",
                payload.exchange_rate_id, payload.store_id
            )
        })?;
        row.try_get("rate_lbp_per_usd")
            .map_err(|e| format!("decode rate_lbp_per_usd: {e}"))?
    };
    if locked_rate != payload.exchange_rate_lbp_per_usd {
        return Err(format!(
            "Exchange rate mismatch: rate {} is {} LBP/USD, but the sale declares {} LBP/USD. \
             Reload the register so it locks the rate that is on record.",
            payload.exchange_rate_id, locked_rate, payload.exchange_rate_lbp_per_usd
        ));
    }

    // ---- A NEW sale belongs to an open shift of its store (GZ-HI-03) ----
    //
    // MANDATORY, not merely validated-if-present. A sale with no shift is a sale
    // outside the cash-control model entirely: the register disables Post
    // without an active shift and always sends `activeShift.id`, drawer
    // reconciliation only counts sales attributed to a shift, and no Greaz
    // workflow produces an unattributed new sale. One that slipped through would
    // take cash that no drawer count could ever reconcile against.
    //
    // Checked INSIDE the transaction that writes the sale, so a shift that
    // closes between the cashier pressing Post and this statement cannot acquire
    // a sale afterwards. See the second call, just before the commit.
    //
    // Deliberately AFTER the idempotency block above, and that ordering is load
    // bearing in BOTH directions:
    //
    //   * a replay of a sale that already posted writes nothing, so it must keep
    //     reconciling to its original receipt even once its shift has been
    //     closed and counted, and even if that historical row predates this rule
    //     and carries a NULL `shift_id` (WP-02 GP-A01). Rejecting a retry would
    //     hand the cashier a failure for money that is already banked.
    //   * nothing below this point is reached by a new sale that fails the
    //     check: no receipt number, no row, no movement, no stock change.
    //
    // `sales.shift_id` stays nullable in the schema on purpose. The rule is
    // about what may be WRITTEN from now on; history is not rewritten.
    let shift_id = payload
        .shift_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "This sale is not attached to a shift. Open a shift before taking payment.".to_string()
        })?;
    assert_shift_is_open(&mut tx, shift_id, &payload.store_id).await?;

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
                    avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
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
        let avg_cost_excl_mc: i64 = row
            .try_get("avg_cost_excl_vat_microcents")
            .map_err(|e| format!("decode avg_cost_excl: {e}"))?;
        let avg_cost_incl_mc: i64 = row
            .try_get("avg_cost_incl_vat_microcents")
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

        // ---- COGS basis, in microcents (GP-A03) ----
        // The costing POLICY is unchanged — weighted average or last purchase,
        // whichever the sale declares — only its precision. Both bases are read
        // from the microcent columns, so an ingredient costing a fraction of a
        // cent per base unit is costed at that fraction and not at zero.
        let (unit_excl_mc, unit_incl_mc) = if is_service {
            (0, 0)
        } else if cogs_method == "last_purchase" {
            let last_cost_row = sqlx::query(
                "SELECT unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents
                   FROM inventory_movements
                  WHERE store_id = ?
                    AND product_id = ?
                    AND movement_type IN ('purchase', 'opening')
                    AND unit_cost_excl_vat_microcents >= 0
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
                    .try_get("unit_cost_excl_vat_microcents")
                    .map_err(|e| format!("decode last_cost_excl: {e}"))?;
                let last_incl: i64 = cost_row
                    .try_get("unit_cost_incl_vat_microcents")
                    .map_err(|e| format!("decode last_cost_incl: {e}"))?;
                (last_excl, last_incl)
            } else {
                // Fallback: products without a purchase/opening movement still use WAC.
                (avg_cost_excl_mc, avg_cost_incl_mc)
            }
        } else {
            (avg_cost_excl_mc, avg_cost_incl_mc)
        };

        // The one rounding boundary: multiply the precise rate by the
        // authoritative base quantity, THEN round to cents. Rounding the rate
        // first is what made a 500 g sale of $0.0025/g flour cost $0.00.
        let line_cogs_cents = extended_cost_cents(unit_excl_mc, quantity_base).map_err(|e| {
            format!(
                "Line {}: cannot value \"{}\" — {}.",
                i + 1,
                line.product_name_snapshot,
                e
            )
        })?;

        cogs_total = cogs_total
            .checked_add(line_cogs_cents)
            .ok_or_else(|| "Sale COGS total overflows.".to_string())?;
        resolved.push(ResolvedLine {
            quantity_base,
            factor_num,
            factor_den,
            is_service,
            unit_cogs_excl_mc: unit_excl_mc,
            unit_cogs_incl_mc: unit_incl_mc,
            line_cogs_cents,
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
        // The microcent rates are the snapshot; the cents values beside them are
        // the rounded display mirror, derived from the same numbers.
        let unit_cogs_excl_cents = microcents_to_cents(r.unit_cogs_excl_mc)?;
        let line_cogs = r.line_cogs_cents;

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
                 unit_cogs_excl_vat_microcents,
                 barcode_used_snapshot, barcode_type_snapshot,
                 quantity_in_uom, uom_code_snapshot,
                 factor_num_snapshot, factor_den_snapshot
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
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
        .bind(unit_cogs_excl_cents)
        .bind(line_cogs)
        .bind(r.unit_cogs_excl_mc)
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
                     unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents,
                     related_sale_id, related_sale_item_id,
                     notes,
                     created_by_user_id, device_id, posted_at,
                     quantity_in_uom, uom_code_snapshot,
                     factor_num_snapshot, factor_den_snapshot
                   ) VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(&movement_id)
            .bind(&payload.store_id)
            .bind(&line.product_id)
            .bind(-r.quantity_base) // sale = stock OUT
            .bind(unit_cogs_excl_cents)
            .bind(microcents_to_cents(r.unit_cogs_incl_mc)?)
            .bind(r.unit_cogs_excl_mc)
            .bind(r.unit_cogs_incl_mc)
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
                // LBP: convert USD-cents to LBP at the rate proved above to be
                // the one `exchange_rates` holds for this sale.
                (0i64, usd_cents_to_lbp(change_total_usd, locked_rate)?)
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

    // ---- The shift is still open, now that the sale is written (GZ-HI-03) ----
    //
    // Belt to the brace above. SQLite already makes the interleaving this
    // guards against impossible — a close is itself a write transaction, so it
    // and this one cannot both commit; whichever loses gets a locking error
    // (rollback-journal mode) or a snapshot conflict (WAL). Re-reading here
    // means the rule "a sale never commits into a closed shift" holds on the
    // transaction's own terms rather than on an argument about lock modes, and
    // the cashier gets the shift error instead of a raw driver one.
    assert_shift_is_open(&mut tx, shift_id, &payload.store_id).await?;

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
// Shift lifecycle (GZ-HI-03)
// ============================================================================
//
// THE SHIFT SCOPE IS THE STORE. One open shift per store, which is the scope
// the application has always queried by — `shiftsRepo.getOpenShift(storeId)`
// selects on `(store_id, status = 'open')`, `idx_shifts_store_status` indexes
// exactly that pair, `shifts.device_id` has never been populated (the active
// context hard-codes `deviceId: null`), and the cashier is recorded but never
// scoped on, so any cashier may ring up against the store's open shift. WP-04
// enforces that model; it does not replace it with a different one.
//
// WHY THESE ARE RUST COMMANDS. Opening a shift used to be a JavaScript read
// followed by a separate INSERT, and closing one was a read, an aggregate, an
// UPDATE and a re-read — four round-trips dispatched across
// tauri-plugin-sql's connection pool, where neither sequence is atomic. Two
// opens could both see "nothing open" and both insert; a close could aggregate
// the till, have a sale land, and then write a snapshot that omits it. Both
// operations decide money, so both belong where every other financial write in
// this application lives: one SQLite transaction, in Rust.
//
// Migration 009 backs the same invariants in the engine: a partial unique index
// `ux_shifts_one_open_per_store` and a trigger that makes a closed shift
// immutable. The commands below produce the friendly errors; the schema is what
// makes the rules true even for a caller that never reaches this module.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenShiftPayload {
    pub shift_id: String,
    pub store_id: String,
    pub opened_by_user_id: String,
    pub device_id: Option<String>,
    pub opening_cash_usd_cents: i64,
    pub opening_cash_lbp: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseShiftPayload {
    pub shift_id: String,
    pub store_id: String,
    pub closed_by_user_id: String,
    pub closing_cash_usd_cents: i64,
    pub closing_cash_lbp: i64,
}

/// A whole `shifts` row, as the UI's `Shift` interface expects it. Both
/// commands return the row they just wrote, read back inside their own
/// transaction, so the caller never has to follow up with a SELECT that could
/// observe a different state than the one the command committed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshot {
    pub id: String,
    pub store_id: String,
    pub device_id: Option<String>,
    pub opened_by_user_id: String,
    pub closed_by_user_id: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub opening_cash_usd_cents: i64,
    pub opening_cash_lbp: i64,
    pub closing_cash_usd_cents: Option<i64>,
    pub closing_cash_lbp: Option<i64>,
    pub expected_cash_usd_cents: Option<i64>,
    pub expected_cash_lbp: Option<i64>,
    pub variance_usd_cents: Option<i64>,
    pub variance_lbp: Option<i64>,
    pub status: String,
    pub notes: Option<String>,
}

/// Read one shift back in full, inside the caller's transaction.
async fn load_shift_snapshot(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    shift_id: &str,
) -> Result<ShiftSnapshot, String> {
    let row = sqlx::query(
        "SELECT id, store_id, device_id, opened_by_user_id, closed_by_user_id,
                opened_at, closed_at,
                opening_cash_usd_cents, opening_cash_lbp,
                closing_cash_usd_cents, closing_cash_lbp,
                expected_cash_usd_cents, expected_cash_lbp,
                variance_usd_cents, variance_lbp,
                status, notes
           FROM shifts WHERE id = ?",
    )
    .bind(shift_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("read shift {shift_id}: {e}"))?
    .ok_or_else(|| format!("Shift {shift_id} disappeared while it was being written."))?;

    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");
    Ok(ShiftSnapshot {
        id: row.try_get("id").map_err(d("id"))?,
        store_id: row.try_get("store_id").map_err(d("store_id"))?,
        device_id: row.try_get("device_id").map_err(d("device_id"))?,
        opened_by_user_id: row.try_get("opened_by_user_id").map_err(d("opened_by_user_id"))?,
        closed_by_user_id: row.try_get("closed_by_user_id").map_err(d("closed_by_user_id"))?,
        opened_at: row.try_get("opened_at").map_err(d("opened_at"))?,
        closed_at: row.try_get("closed_at").map_err(d("closed_at"))?,
        opening_cash_usd_cents: row
            .try_get("opening_cash_usd_cents")
            .map_err(d("opening_cash_usd_cents"))?,
        opening_cash_lbp: row.try_get("opening_cash_lbp").map_err(d("opening_cash_lbp"))?,
        closing_cash_usd_cents: row
            .try_get("closing_cash_usd_cents")
            .map_err(d("closing_cash_usd_cents"))?,
        closing_cash_lbp: row.try_get("closing_cash_lbp").map_err(d("closing_cash_lbp"))?,
        expected_cash_usd_cents: row
            .try_get("expected_cash_usd_cents")
            .map_err(d("expected_cash_usd_cents"))?,
        expected_cash_lbp: row.try_get("expected_cash_lbp").map_err(d("expected_cash_lbp"))?,
        variance_usd_cents: row.try_get("variance_usd_cents").map_err(d("variance_usd_cents"))?,
        variance_lbp: row.try_get("variance_lbp").map_err(d("variance_lbp"))?,
        status: row.try_get("status").map_err(d("status"))?,
        notes: row.try_get("notes").map_err(d("notes"))?,
    })
}

/// Refuse unless `shift_id` is a shift of `store_id` that is still open.
///
/// Called by `post_sale_tx` at the top of its transaction and again just before
/// it commits, and by `close_shift_tx` before it computes anything. The error
/// text names the state it found, because "the shift closed under you" and "that
/// shift belongs to another store" need different fixes from the cashier.
async fn assert_shift_is_open(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    shift_id: &str,
    store_id: &str,
) -> Result<(), String> {
    let row = sqlx::query("SELECT status FROM shifts WHERE id = ? AND store_id = ?")
        .bind(shift_id)
        .bind(store_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("read shift {shift_id}: {e}"))?;

    match row {
        None => Err(format!("Shift {shift_id} is not a shift of store {store_id}.")),
        Some(r) => {
            let status: String = r.try_get("status").map_err(|e| format!("decode status: {e}"))?;
            if status == "open" {
                Ok(())
            } else {
                Err(format!(
                    "Shift {shift_id} is {status}, not open. Open a new shift before taking \
                     payment."
                ))
            }
        }
    }
}

/// The cash that actually moved through one shift's drawer.
///
/// THE definition of a drawer-affecting event, and the only one: cash tendered
/// in, and change handed back out, on POSTED sales attributed to this shift.
///
/// `is_cash_method` decides what counts, which is why a card can neither inflate
/// nor reduce the figure. The change terms are filtered by the SAME method test
/// as the tender terms: `prepare_sale` now refuses to put change on a non-cash
/// row at all, but a database written by an earlier release can hold exactly
/// that, and such a row must not go on quietly making the drawer look short.
///
/// Events this deliberately does NOT model, because the application does not
/// have them yet: refunds and credit memos (WP-06), and petty cash /
/// cash-in / cash-out. There is no flow that produces them, so there is nothing
/// to include; each lands here when its own work package adds it.
///
/// Supplier payments stay out too, and WP-05 left them out ON PURPOSE rather
/// than by omission. A `supplier_ledger` payment row records an amount in USD
/// cents and nothing else: no method, no currency, no shift. Nothing in the
/// schema or the Supplier screen says whether a given payment was lira out of
/// this drawer, a bank transfer, or a cheque posted last week. Subtracting
/// every supplier payment from expected cash would therefore make the drawer
/// look short by every payment that never touched it, and would attribute
/// payments to whichever shift happened to be open when somebody typed them in.
/// Giving supplier payments a tender model is a product decision, not a
/// refactor; until it is made, the honest figure is the one that counts only
/// what provably moved through the till.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DrawerCash {
    pub cash_usd_in_cents: i64,
    pub cash_lbp_in: i64,
    pub change_usd_out_cents: i64,
    pub change_lbp_out: i64,
}

async fn drawer_cash_for_shift(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    store_id: &str,
    shift_id: &str,
) -> Result<DrawerCash, String> {
    let row = sqlx::query(
        "SELECT
           COALESCE(SUM(CASE WHEN sp.method = 'cash_usd'
                             THEN sp.amount_native_usd_cents ELSE 0 END), 0) AS cash_usd_in,
           COALESCE(SUM(CASE WHEN sp.method = 'cash_lbp'
                             THEN sp.amount_native_lbp ELSE 0 END), 0)       AS cash_lbp_in,
           COALESCE(SUM(CASE WHEN sp.method IN ('cash_usd','cash_lbp')
                             THEN sp.change_given_usd_cents ELSE 0 END), 0)  AS change_usd_out,
           COALESCE(SUM(CASE WHEN sp.method IN ('cash_usd','cash_lbp')
                             THEN sp.change_given_lbp ELSE 0 END), 0)        AS change_lbp_out
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
        WHERE s.store_id = ?
          AND s.shift_id = ?
          AND s.status = 'posted'",
    )
    .bind(store_id)
    .bind(shift_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| format!("aggregate drawer cash for shift {shift_id}: {e}"))?;

    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");
    Ok(DrawerCash {
        cash_usd_in_cents: row.try_get("cash_usd_in").map_err(d("cash_usd_in"))?,
        cash_lbp_in: row.try_get("cash_lbp_in").map_err(d("cash_lbp_in"))?,
        change_usd_out_cents: row.try_get("change_usd_out").map_err(d("change_usd_out"))?,
        change_lbp_out: row.try_get("change_lbp_out").map_err(d("change_lbp_out"))?,
    })
}

// ----------------------------------------------------------------------------
// open_shift
// ----------------------------------------------------------------------------

/// One wording for "this store already has an open shift", whether the
/// `NOT EXISTS` guard or the unique index caught it. Kept close to the frontend
/// string it replaces so the cashier reads the same sentence as before.
const ALREADY_OPEN_MESSAGE: &str =
    "A shift is already open for this store. Close it before opening a new one.";

/// Pure pre-DB validation for `open_shift`.
pub(crate) fn validate_open_shift_payload(payload: &OpenShiftPayload) -> Result<(), String> {
    if payload.shift_id.trim().is_empty() {
        return Err("A shift needs an identifier.".into());
    }
    if payload.store_id.trim().is_empty() {
        return Err("A shift needs a store.".into());
    }
    if payload.opened_by_user_id.trim().is_empty() {
        return Err("A shift needs the user who opened it.".into());
    }
    if payload.opening_cash_usd_cents < 0 || payload.opening_cash_lbp < 0 {
        return Err("Opening cash cannot be negative.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_shift(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: OpenShiftPayload,
) -> Result<ShiftSnapshot, String> {
    validate_open_shift_payload(&payload)?;
    let pool = pool(&app, &state).await?;
    open_shift_tx(&pool, payload).await
}

/// Validate-then-open against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn open_shift_with_pool(
    pool: &SqlitePool,
    payload: OpenShiftPayload,
) -> Result<ShiftSnapshot, String> {
    validate_open_shift_payload(&payload)?;
    open_shift_tx(pool, payload).await
}

/// The transactional body of `open_shift`.
///
/// The uniqueness decision is ONE statement — an `INSERT ... SELECT ... WHERE
/// NOT EXISTS` — rather than a SELECT the caller then branches on. That is what
/// removes the check-then-insert window: within the statement there is no point
/// at which another connection's shift can slip between the test and the write.
/// `ux_shifts_one_open_per_store` from migration 009 is the backstop for the
/// remaining case, two transactions whose statements interleave across
/// connections; whichever loses is translated into the same message a caller
/// gets from the `NOT EXISTS` arm, so a conflicting open always fails the same
/// deterministic way.
pub(crate) async fn open_shift_tx(
    pool: &SqlitePool,
    payload: OpenShiftPayload,
) -> Result<ShiftSnapshot, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let inserted = sqlx::query(
        "INSERT INTO shifts (
           id, store_id, device_id, opened_by_user_id, opened_at,
           opening_cash_usd_cents, opening_cash_lbp, status, notes
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, 'open', ?
          WHERE NOT EXISTS (
                SELECT 1 FROM shifts WHERE store_id = ? AND status = 'open'
          )",
    )
    .bind(&payload.shift_id)
    .bind(&payload.store_id)
    .bind(&payload.device_id)
    .bind(&payload.opened_by_user_id)
    .bind(&now)
    .bind(payload.opening_cash_usd_cents)
    .bind(payload.opening_cash_lbp)
    .bind(&payload.notes)
    .bind(&payload.store_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        let message = e.to_string();
        // `ux_shifts_one_open_per_store` is the engine refusing a second open
        // shift for this store. Any other constraint failure (a duplicate shift
        // id, an unknown store or user) is a different mistake and keeps its own
        // diagnostic.
        if message.contains("ux_shifts_one_open_per_store") {
            ALREADY_OPEN_MESSAGE.to_string()
        } else {
            format!("open shift: {message}")
        }
    })?;

    if inserted.rows_affected() == 0 {
        return Err(ALREADY_OPEN_MESSAGE.to_string());
    }

    let snapshot = load_shift_snapshot(&mut tx, &payload.shift_id).await?;
    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(snapshot)
}

// ----------------------------------------------------------------------------
// close_shift
// ----------------------------------------------------------------------------

/// Pure pre-DB validation for `close_shift`.
pub(crate) fn validate_close_shift_payload(payload: &CloseShiftPayload) -> Result<(), String> {
    if payload.shift_id.trim().is_empty() {
        return Err("A shift needs an identifier.".into());
    }
    if payload.store_id.trim().is_empty() {
        return Err("A shift needs a store.".into());
    }
    if payload.closed_by_user_id.trim().is_empty() {
        return Err("A shift needs the user who closed it.".into());
    }
    if payload.closing_cash_usd_cents < 0 || payload.closing_cash_lbp < 0 {
        return Err("Counted cash cannot be negative.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn close_shift(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    payload: CloseShiftPayload,
) -> Result<ShiftSnapshot, String> {
    validate_close_shift_payload(&payload)?;
    let pool = pool(&app, &state).await?;
    close_shift_tx(&pool, payload).await
}

/// Validate-then-close against an already-resolved pool (test seam).
#[cfg(test)]
pub(crate) async fn close_shift_with_pool(
    pool: &SqlitePool,
    payload: CloseShiftPayload,
) -> Result<ShiftSnapshot, String> {
    validate_close_shift_payload(&payload)?;
    close_shift_tx(pool, payload).await
}

/// The transactional body of `close_shift`.
///
/// Everything happens in one transaction: the status check, the opening float,
/// the drawer aggregate over posted sales, the UPDATE, and the read-back that is
/// returned. So the financial snapshot stored on the row IS the state that was
/// marked closed — a sale cannot land between the aggregate and the write, which
/// is exactly what the previous four-round-trip JavaScript close allowed.
///
/// Repeated close is REJECTED, which is the contract the previous implementation
/// had (its UPDATE carried `AND status = 'open'`, and the repo then threw "No
/// open shift found — it may already be closed"). A re-close cannot silently
/// succeed with different counted cash and overwrite a reconciliation someone
/// signed off, and migration 009's `trg_shifts_no_update_after_close` makes that
/// true for any caller, not just this one.
pub(crate) async fn close_shift_tx(
    pool: &SqlitePool,
    payload: CloseShiftPayload,
) -> Result<ShiftSnapshot, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    let row = sqlx::query(
        "SELECT status, closed_at, opening_cash_usd_cents, opening_cash_lbp
           FROM shifts WHERE id = ? AND store_id = ?",
    )
    .bind(&payload.shift_id)
    .bind(&payload.store_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read shift {}: {e}", payload.shift_id))?
    .ok_or_else(|| {
        format!(
            "No open shift found — shift {} is not a shift of store {}.",
            payload.shift_id, payload.store_id
        )
    })?;

    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");
    let status: String = row.try_get("status").map_err(d("status"))?;
    if status != "open" {
        let closed_at: Option<String> = row.try_get("closed_at").map_err(d("closed_at"))?;
        return Err(match closed_at {
            Some(at) => format!(
                "No open shift found — shift {} was already closed at {}. Its counted cash and \
                 variance are final.",
                payload.shift_id, at
            ),
            None => format!("No open shift found — shift {} is {}.", payload.shift_id, status),
        });
    }

    let opening_usd: i64 = row
        .try_get("opening_cash_usd_cents")
        .map_err(d("opening_cash_usd_cents"))?;
    let opening_lbp: i64 = row.try_get("opening_cash_lbp").map_err(d("opening_cash_lbp"))?;

    let drawer = drawer_cash_for_shift(&mut tx, &payload.store_id, &payload.shift_id).await?;

    // expected = opening float + cash in - change out, per currency. Card,
    // transfer and wallet tenders appear in neither term: they never reach the
    // till. Checked arithmetic because this is money and the alternative is a
    // silent wrap.
    let expected_usd = opening_usd
        .checked_add(drawer.cash_usd_in_cents)
        .and_then(|v| v.checked_sub(drawer.change_usd_out_cents))
        .ok_or_else(|| "Expected USD drawer cash overflows.".to_string())?;
    let expected_lbp = opening_lbp
        .checked_add(drawer.cash_lbp_in)
        .and_then(|v| v.checked_sub(drawer.change_lbp_out))
        .ok_or_else(|| "Expected LBP drawer cash overflows.".to_string())?;

    // variance = counted - expected. Negative is SHORT, positive is OVER, in
    // both currencies, matching `shifts.variance_*`'s own documentation and the
    // sign the UI renders.
    let variance_usd = payload
        .closing_cash_usd_cents
        .checked_sub(expected_usd)
        .ok_or_else(|| "USD cash variance overflows.".to_string())?;
    let variance_lbp = payload
        .closing_cash_lbp
        .checked_sub(expected_lbp)
        .ok_or_else(|| "LBP cash variance overflows.".to_string())?;

    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let updated = sqlx::query(
        "UPDATE shifts SET
           status                  = 'closed',
           closed_at               = ?,
           closed_by_user_id       = ?,
           closing_cash_usd_cents  = ?,
           closing_cash_lbp        = ?,
           expected_cash_usd_cents = ?,
           expected_cash_lbp       = ?,
           variance_usd_cents      = ?,
           variance_lbp            = ?
         WHERE id = ? AND store_id = ? AND status = 'open'",
    )
    .bind(&now)
    .bind(&payload.closed_by_user_id)
    .bind(payload.closing_cash_usd_cents)
    .bind(payload.closing_cash_lbp)
    .bind(expected_usd)
    .bind(expected_lbp)
    .bind(variance_usd)
    .bind(variance_lbp)
    .bind(&payload.shift_id)
    .bind(&payload.store_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("close shift {}: {e}", payload.shift_id))?;

    // `AND status = 'open'` is still on the UPDATE, so this cannot be reached
    // while the transaction holds a consistent read — but if it ever were, the
    // transaction is rolled back whole and the shift is left exactly as it was.
    // A failed close leaves no partial closed state.
    if updated.rows_affected() != 1 {
        return Err(format!(
            "No open shift found — shift {} was closed by another operation while this close was \
             in flight.",
            payload.shift_id
        ));
    }

    let snapshot = load_shift_snapshot(&mut tx, &payload.shift_id).await?;
    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(snapshot)
}
