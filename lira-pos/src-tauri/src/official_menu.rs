//! GREAZ'S OFFICIAL MENU — the bundled catalog, an owner-only preview, and a
//! one-time, idempotent apply.
//!
//! WHAT THIS IS
//!
//! `src/catalog/greaz-menu-v1.json` is a byte-for-byte copy of the founder's
//! structured transcription of the printed Greaz menu (27 menu items, 4 paid
//! add-ons, 2 combo upgrades, 9 sections, 3 sauce/dip choice groups). It is
//! COMPILED INTO the binary with `include_str!`, so the catalog a build offers
//! is the catalog that was reviewed for that build and cannot be edited on the
//! till's disk afterwards. `tests::official_menu` pins its counts, its SKUs and
//! every price.
//!
//! WHY IT IS NOT A MIGRATION
//!
//! A migration runs on EVERY installation without asking anyone, and migration
//! 019 exists because 003 did exactly that with three grocery items. A menu
//! also needs a decision nobody has made yet: the printed prices say nothing
//! about VAT ("Unconfirmed (do not assume VAT inclusive/exclusive or tax
//! rate)", in the catalog's own words), and `products.vat_rate_id` is NOT NULL.
//! Seeding from a migration would have to choose a rate and a pricing mode for
//! the shop, and every sale of every item would then snapshot that choice
//! permanently (`sale_items` is sealed). So the menu is loaded by the OWNER,
//! once, after enrollment, through [`official_menu_apply`], which REFUSES to
//! run unless the owner has named a VAT rate, said whether the printed prices
//! include it, and ticked that they have confirmed it.
//!
//! WHAT APPLY DOES, AND DOES NOT DO
//!
//!   * Creates each catalog item whose SKU is not already in the store, as a
//!     NON-STOCK menu item (`is_service = 1`): a burger is made to order, is
//!     never received on a purchase, and as a stocked product with nothing on
//!     hand it could not be sold at all (`allow_negative_stock` defaults to 0).
//!     One `each` unit, base and default sale. No barcode. No cost: the item is
//!     on purchase valuation with no basis, so its sales post `cogs_source =
//!     'uncosted'` and the coverage panel says so — a recipe can be published
//!     for it later, when the real quantities and purchase costs are known.
//!   * Never touches an existing product's row except to take it OFF THE
//!     REGISTER (`show_on_register = 0`), and only a product the owner ticked
//!     in the preview. Its price, VAT, cost, stock, recipes and history are not
//!     read for anything but display, and not written at all. An existing SKU
//!     is skipped, whatever it now says.
//!   * The "Coming Soon" dessert is created with `show_on_register = 0`, so it
//!     is not a tile and `post_sale` refuses a sale of it, until the owner
//!     turns it on from Products.
//!   * Writes one `app_settings` marker naming the catalog version, the owner,
//!     the time and the tax treatment chosen. A second apply of the same
//!     version is refused: the load is ONE-TIME, and a product whose SKU the
//!     owner has since edited must not be quietly re-created.
//!   * Writes no user, shift, sale, purchase, movement, recipe or barcode.
//!
//! Everything is decided again INSIDE the writing transaction — the preview is
//! a picture for the owner, not an input the apply trusts.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::posting::DbState;

/// The bundled catalog. A copy of the founder-supplied
/// `dev/greaz_menu_seed_reference.json`, unchanged.
pub(crate) const CATALOG_JSON: &str = include_str!("../../src/catalog/greaz-menu-v1.json");

/// The catalog version this build carries. Also the apply payload's guard
/// against a screen built for a different catalog.
pub(crate) const CATALOG_LABEL: &str = "greaz_menu_reference_v1";

/// The `app_settings` key recording that THIS version was loaded INTO THIS
/// STORE. Store-scoped like everything the load writes: a second branch in the
/// same database is a separate menu (Codex review, P2).
pub(crate) fn marker_key(store_id: &str) -> String {
    format!("official_menu.{CATALOG_LABEL}.{store_id}")
}

// ============================================================================
// The catalog
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct Catalog {
    pub schema_label: String,
    pub currency: String,
    pub categories: Vec<CatalogCategory>,
    pub items: Vec<CatalogItem>,
    pub choice_groups: Vec<ChoiceGroup>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogCategory {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogItem {
    pub sku: String,
    pub category: String,
    pub name: String,
    pub price_usd_cents: i64,
    #[serde(default)]
    pub description: String,
    pub status: String,
    pub kind: String,
    pub barcode: Option<String>,
    pub icon_suggestion: String,
    #[serde(default)]
    pub choice_group_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChoiceGroup {
    pub id: String,
    pub options: Vec<String>,
    pub selection_count: i64,
    pub price_usd_cents: i64,
}

/// The catalog's section names → the application's stable category ids
/// (`lib/menuCategories.ts`). Explicit, so a renamed section fails here instead
/// of landing in "Other".
pub(crate) fn category_id(section: &str) -> Option<&'static str> {
    Some(match section {
        "Burgers" => "burgers",
        "Wraps" => "wraps",
        "Fries" => "fries",
        "Appetizers" => "appetizers",
        "Combos" => "combos",
        "Drinks" => "drinks",
        "Dessert" => "dessert",
        "Add-ons" => "addons",
        "Combo Upgrades" => "upgrades",
        _ => return None,
    })
}

/// Parse and validate the bundled catalog.
///
/// Every rule here is one the apply relies on; a catalog that breaks one is a
/// build defect and the command refuses rather than loading part of a menu.
pub(crate) fn load_catalog() -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_str(CATALOG_JSON)
        .map_err(|e| format!("The bundled menu could not be read: {e}"))?;
    if catalog.schema_label != CATALOG_LABEL {
        return Err(format!(
            "The bundled menu is version {}, expected {CATALOG_LABEL}.",
            catalog.schema_label
        ));
    }
    if catalog.currency != "USD" {
        return Err("The bundled menu must be priced in USD.".into());
    }
    for c in &catalog.categories {
        if category_id(&c.name).is_none() {
            return Err(format!("The bundled menu has an unknown section: {}", c.name));
        }
    }
    let group_ids: HashSet<&str> = catalog.choice_groups.iter().map(|g| g.id.as_str()).collect();
    for g in &catalog.choice_groups {
        if g.options.is_empty() || g.selection_count < 1 || g.price_usd_cents != 0 {
            return Err(format!("The bundled menu's choice group {} is malformed.", g.id));
        }
    }
    let mut skus = HashSet::new();
    for item in &catalog.items {
        if !skus.insert(item.sku.to_uppercase()) {
            return Err(format!("The bundled menu repeats SKU {}.", item.sku));
        }
        if item.sku.trim().is_empty() || item.name.trim().is_empty() {
            return Err("The bundled menu has an item with no SKU or name.".into());
        }
        if category_id(&item.category).is_none() {
            return Err(format!("{}: unknown section {}", item.sku, item.category));
        }
        if item.price_usd_cents <= 0 {
            return Err(format!("{}: a menu price must be positive", item.sku));
        }
        if item.status != "active" && item.status != "coming_soon" {
            return Err(format!("{}: unknown status {}", item.sku, item.status));
        }
        if !matches!(item.kind.as_str(), "menu" | "add_on" | "upgrade") {
            return Err(format!("{}: unknown kind {}", item.sku, item.kind));
        }
        if item.barcode.is_some() {
            return Err(format!("{}: the official menu carries no barcodes", item.sku));
        }
        let glyph = item.icon_suggestion.trim();
        if glyph.is_empty() || glyph.chars().count() > 4 {
            return Err(format!("{}: icon must be one short glyph", item.sku));
        }
        for id in &item.choice_group_ids {
            if !group_ids.contains(id.as_str()) {
                return Err(format!("{}: unknown choice group {id}", item.sku));
            }
        }
    }
    Ok(catalog)
}

// ============================================================================
// Reading the store
// ============================================================================

/// A product already in the store, as the preview shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingProduct {
    pub product_id: String,
    pub sku: Option<String>,
    pub name: String,
    pub category: Option<String>,
    pub price_incl_vat_cents: i64,
    pub price_excl_vat_cents: i64,
    pub vat_pricing_mode: String,
    pub is_active: bool,
    pub show_on_register: bool,
    #[serde(skip)]
    is_ingredient: bool,
}

/// The canonical comparison form of a name or category: trimmed, lower-case,
/// inner whitespace collapsed — `lib/menuCategories.ts::normalizeCategoryId`.
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

async fn read_store_products(
    conn: &mut SqliteConnection,
    store_id: &str,
) -> Result<Vec<ExistingProduct>, String> {
    let rows = sqlx::query(
        "SELECT p.id, p.sku, p.name, p.category,
                p.price_incl_vat_cents, p.price_excl_vat_cents, p.vat_pricing_mode,
                p.is_active, p.show_on_register,
                EXISTS (SELECT 1 FROM recipe_components rc
                         WHERE rc.component_product_id = p.id) AS is_ingredient
           FROM products p
          WHERE p.store_id = ?
          ORDER BY p.name, p.id",
    )
    .bind(store_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| format!("read products: {e}"))?;

    let d = |what: &'static str| move |e: sqlx::Error| format!("decode {what}: {e}");
    rows.iter()
        .map(|r| {
            Ok(ExistingProduct {
                product_id: r.try_get("id").map_err(d("id"))?,
                sku: r.try_get("sku").map_err(d("sku"))?,
                name: r.try_get("name").map_err(d("name"))?,
                category: r.try_get("category").map_err(d("category"))?,
                price_incl_vat_cents: r.try_get("price_incl_vat_cents").map_err(d("price"))?,
                price_excl_vat_cents: r.try_get("price_excl_vat_cents").map_err(d("price"))?,
                vat_pricing_mode: r.try_get("vat_pricing_mode").map_err(d("mode"))?,
                is_active: r.try_get::<i64, _>("is_active").map_err(d("is_active"))? == 1,
                show_on_register: r
                    .try_get::<i64, _>("show_on_register")
                    .map_err(d("show_on_register"))?
                    == 1,
                is_ingredient: r.try_get::<i64, _>("is_ingredient").map_err(d("ingredient"))? == 1,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRecord {
    pub catalog_label: String,
    pub applied_at: String,
    pub applied_by_user_id: String,
    pub vat_rate_id: String,
    pub vat_rate_bps: i64,
    pub vat_pricing_mode: String,
    pub created: i64,
    pub skipped_existing_sku: i64,
    pub kept_existing_by_name: i64,
    pub hidden_from_register: i64,
}

async fn read_marker(
    conn: &mut SqliteConnection,
    store_id: &str,
) -> Result<Option<AppliedRecord>, String> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind(marker_key(store_id))
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| format!("read the menu marker: {e}"))?;
    match raw {
        None => Ok(None),
        Some(v) => serde_json::from_str(&v)
            .map(Some)
            .map_err(|e| format!("The official-menu record in settings is unreadable: {e}")),
    }
}

// ============================================================================
// The plan — computed identically for the preview and inside the apply
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub sku: String,
    pub name: String,
    pub category: String,
    pub price_usd_cents: i64,
    pub description: Option<String>,
    pub icon: String,
    pub kind: String,
    /// `false` for the Coming Soon dessert: created, but kept off the Register.
    pub sellable: bool,
    /// `"create"`, `"sku_exists"` (skipped — never overwritten) or
    /// `"name_match"` (an existing Register item already has this name; kept by
    /// default, replaceable only if the owner asks).
    pub outcome: String,
    pub existing: Vec<ExistingProduct>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleProduct {
    #[serde(flatten)]
    pub product: ExistingProduct,
    /// A SKU from an earlier demonstration catalogue (`GZ-` / `DEMO-`).
    pub looks_like_sample: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuPreview {
    pub catalog_label: String,
    pub applied: Option<AppliedRecord>,
    pub items: Vec<PreviewItem>,
    /// Register items that are not on the official menu, offered for the
    /// owner to take off the Register. Never pre-selected.
    pub samples: Vec<SampleProduct>,
}

fn plan(catalog: &Catalog, products: &[ExistingProduct]) -> (Vec<PreviewItem>, Vec<SampleProduct>) {
    let catalog_skus: HashSet<String> = catalog.items.iter().map(|i| i.sku.to_uppercase()).collect();
    // How many catalog items carry each name. "OG Chicken" is a burger AND a
    // wrap, so for that name the section has to agree as well.
    let mut name_count: HashMap<String, usize> = HashMap::new();
    for i in &catalog.items {
        *name_count.entry(norm(&i.name)).or_default() += 1;
    }

    // Only products a cashier can currently ring up are name-match candidates:
    // an ingredient kept off the Register ("Water" bought by the case for the
    // kitchen) is inventory, not a menu item, and must not stop the menu item
    // of the same name being created.
    let on_register = |p: &ExistingProduct| p.is_active && p.show_on_register && !p.is_ingredient;
    let not_catalog_sku = |p: &ExistingProduct| {
        p.sku
            .as_deref()
            .map(|s| !catalog_skus.contains(&s.trim().to_uppercase()))
            .unwrap_or(true)
    };

    let mut matched: HashSet<String> = HashSet::new();
    let mut items = Vec::with_capacity(catalog.items.len());
    for item in &catalog.items {
        let category = category_id(&item.category).expect("validated").to_string();
        let by_sku: Vec<ExistingProduct> = products
            .iter()
            .filter(|p| {
                p.sku
                    .as_deref()
                    .is_some_and(|s| s.trim().eq_ignore_ascii_case(&item.sku))
            })
            .cloned()
            .collect();

        let (outcome, existing) = if !by_sku.is_empty() {
            ("sku_exists", by_sku)
        } else {
            let unique_name = name_count.get(&norm(&item.name)).copied().unwrap_or(0) <= 1;
            let by_name: Vec<ExistingProduct> = products
                .iter()
                .filter(|p| on_register(p) && not_catalog_sku(p) && norm(&p.name) == norm(&item.name))
                .filter(|p| {
                    unique_name
                        || match p.category.as_deref().map(norm) {
                            None => true,
                            Some(c) if c.is_empty() => true,
                            Some(c) => c == category,
                        }
                })
                .cloned()
                .collect();
            if by_name.is_empty() {
                ("create", vec![])
            } else {
                for p in &by_name {
                    matched.insert(p.product_id.clone());
                }
                ("name_match", by_name)
            }
        };

        let description = item.description.trim();
        items.push(PreviewItem {
            sku: item.sku.clone(),
            name: item.name.clone(),
            category,
            price_usd_cents: item.price_usd_cents,
            description: (!description.is_empty()).then(|| description.to_string()),
            icon: item.icon_suggestion.trim().to_string(),
            kind: item.kind.clone(),
            sellable: item.status == "active",
            outcome: outcome.to_string(),
            existing,
        });
    }

    let samples = products
        .iter()
        .filter(|p| on_register(p) && not_catalog_sku(p) && !matched.contains(&p.product_id))
        .map(|p| SampleProduct {
            looks_like_sample: p.sku.as_deref().is_some_and(|s| {
                let s = s.trim().to_uppercase();
                s.starts_with("GZ-") || s.starts_with("DEMO-")
            }),
            product: p.clone(),
        })
        .collect();

    (items, samples)
}

async fn preview_tx(
    conn: &mut SqliteConnection,
    store_id: &str,
) -> Result<MenuPreview, String> {
    let catalog = load_catalog()?;
    let products = read_store_products(conn, store_id).await?;
    let applied = read_marker(conn, store_id).await?;
    let (items, samples) = plan(&catalog, &products);
    Ok(MenuPreview {
        catalog_label: CATALOG_LABEL.to_string(),
        applied,
        items,
        samples,
    })
}

// ============================================================================
// Commands
// ============================================================================

#[tauri::command]
pub async fn official_menu_preview(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    store_id: String,
) -> Result<MenuPreview, String> {
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::ApplyOfficialMenu,
    )
    .await?;
    preview_as(&pool, &actor, &store_id).await
}

pub(crate) async fn preview_as(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    store_id: &str,
) -> Result<MenuPreview, String> {
    crate::authz::require_same_store(actor, store_id)?;
    let mut conn = pool.acquire().await.map_err(|e| format!("acquire: {e}"))?;
    preview_tx(&mut conn, store_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOfficialMenuPayload {
    pub store_id: String,
    /// Must equal [`CATALOG_LABEL`]: the screen was built for this catalog.
    pub catalog_label: String,
    /// CHOSEN by the owner. Never defaulted.
    pub vat_rate_id: String,
    /// `"inclusive"`: the printed price is what the customer pays, VAT inside.
    /// `"exclusive"`: VAT is added on top of the printed price.
    pub vat_pricing_mode: String,
    /// The owner's explicit statement that the tax treatment above is confirmed.
    pub tax_treatment_confirmed: bool,
    /// Name matches the owner chose to REPLACE: the official item is created
    /// and the existing items are taken off the Register. Each names the exact
    /// products the owner REVIEWED; the apply refuses if that set has changed.
    #[serde(default)]
    pub replace_name_matches: Vec<NameMatchReplacement>,
    /// Products not on the official menu that the owner chose to take off the
    /// Register. Each must be one the preview offered.
    #[serde(default)]
    pub hide_product_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameMatchReplacement {
    pub sku: String,
    pub existing_product_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOfficialMenuResult {
    pub created_skus: Vec<String>,
    pub skipped_existing_skus: Vec<String>,
    pub kept_existing_by_name_skus: Vec<String>,
    pub hidden_product_ids: Vec<String>,
    pub record: AppliedRecord,
}

#[tauri::command]
pub async fn official_menu_apply(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    payload: ApplyOfficialMenuPayload,
) -> Result<ApplyOfficialMenuResult, String> {
    validate_apply(&payload)?;
    let (pool, actor) = crate::authz::begin(
        &app,
        &window,
        &state,
        crate::authz::Operation::ApplyOfficialMenu,
    )
    .await?;
    apply_tx(&pool, &actor, payload).await
}

pub(crate) fn validate_apply(payload: &ApplyOfficialMenuPayload) -> Result<(), String> {
    if payload.catalog_label != CATALOG_LABEL {
        return Err(format!(
            "This screen was prepared for menu {}, but this build carries {CATALOG_LABEL}. \
             Close it and open it again.",
            payload.catalog_label
        ));
    }
    if payload.vat_rate_id.trim().is_empty() {
        return Err(
            "Choose the VAT rate for the menu. It is not defaulted: every sale of every item \
             records it permanently."
                .into(),
        );
    }
    if payload.vat_pricing_mode != "inclusive" && payload.vat_pricing_mode != "exclusive" {
        return Err(
            "Say whether the printed menu prices already include VAT or have it added on top."
                .into(),
        );
    }
    if !payload.tax_treatment_confirmed {
        return Err(
            "Confirm the tax treatment before loading the menu. Nothing has been changed.".into(),
        );
    }
    Ok(())
}

/// The transactional body of [`official_menu_apply`].
pub(crate) async fn apply_tx(
    pool: &SqlitePool,
    actor: &crate::auth::Actor,
    payload: ApplyOfficialMenuPayload,
) -> Result<ApplyOfficialMenuResult, String> {
    let catalog = load_catalog()?;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    // Re-authorized inside the transaction that commits (see `authz`).
    crate::authz::authorize_tx(&mut tx, actor, crate::authz::Operation::ApplyOfficialMenu).await?;
    crate::authz::require_same_store(actor, &payload.store_id)?;

    // ---- ONE-TIME ----
    if let Some(done) = read_marker(&mut tx, &payload.store_id).await? {
        return Err(format!(
            "Greaz's official menu ({}) was already loaded on {}. It is loaded once; edit items \
             from Products. Nothing has been changed.",
            done.catalog_label, done.applied_at
        ));
    }

    // ---- The VAT rate the owner chose, proven to exist and be in effect ----
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let rate_bps: i64 = sqlx::query_scalar(
        "SELECT rate_bps FROM vat_rates
          WHERE id = ? AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to >= ?)",
    )
    .bind(&payload.vat_rate_id)
    .bind(&today)
    .bind(&today)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("read VAT rate: {e}"))?
    .ok_or_else(|| "That VAT rate does not exist or is not in effect today.".to_string())?;

    // ---- The plan, decided again here; the preview is not trusted ----
    let products = read_store_products(&mut tx, &payload.store_id).await?;
    let (items, samples) = plan(&catalog, &products);

    for r in &payload.replace_name_matches {
        let current = items
            .iter()
            .find(|i| i.sku == r.sku && i.outcome == "name_match")
            .ok_or_else(|| {
                format!(
                    "{} has no existing item of the same name to replace. Open the menu preview \
                     again. Nothing has been changed.",
                    r.sku
                )
            })?;
        // The exact products the owner reviewed, or nothing: a same-named
        // product created after the preview must not be hidden on the strength
        // of a tick about something else (Codex review, P1).
        let now: HashSet<&str> = current.existing.iter().map(|p| p.product_id.as_str()).collect();
        let reviewed: HashSet<&str> = r.existing_product_ids.iter().map(String::as_str).collect();
        if now != reviewed {
            return Err(format!(
                "The items named \"{}\" have changed since the preview. Open the menu preview \
                 again. Nothing has been changed.",
                current.name
            ));
        }
    }
    let replace: HashSet<&str> =
        payload.replace_name_matches.iter().map(|r| r.sku.as_str()).collect();

    let sample_ids: HashSet<&str> = samples.iter().map(|s| s.product.product_id.as_str()).collect();
    for id in &payload.hide_product_ids {
        if !sample_ids.contains(id.as_str()) {
            return Err(
                "One of the items ticked to take off the Register is no longer offered for that. \
                 Open the menu preview again. Nothing has been changed."
                    .into(),
            );
        }
    }

    // Everything that will leave the Register, decided BEFORE any item is
    // judged: an uncategorised "OG Chicken" matches both the burger and the
    // wrap, and replacing one of them hides it — so the other must not then be
    // "kept" on the strength of a product that is no longer on the Register.
    let going: HashSet<&str> = items
        .iter()
        .filter(|i| i.outcome == "name_match" && replace.contains(i.sku.as_str()))
        .flat_map(|i| i.existing.iter().map(|p| p.product_id.as_str()))
        .chain(payload.hide_product_ids.iter().map(String::as_str))
        .collect();

    let mut created = Vec::new();
    let mut skipped = Vec::new();
    let mut kept_by_name = Vec::new();
    let mut hidden: Vec<String> = Vec::new();

    for item in &items {
        let create = match item.outcome.as_str() {
            "create" => true,
            "name_match" if replace.contains(item.sku.as_str()) => {
                for p in &item.existing {
                    if !hidden.contains(&p.product_id) {
                        hide_from_register(&mut tx, &payload.store_id, &p.product_id).await?;
                        hidden.push(p.product_id.clone());
                    }
                }
                true
            }
            "name_match"
                if item.existing.iter().all(|p| going.contains(p.product_id.as_str())) =>
            {
                true
            }
            "name_match" => {
                kept_by_name.push(item.sku.clone());
                false
            }
            _ => {
                skipped.push(item.sku.clone());
                false
            }
        };
        if create {
            insert_menu_item(&mut tx, &payload, rate_bps, item).await?;
            created.push(item.sku.clone());
        }
    }

    for id in &payload.hide_product_ids {
        if !hidden.contains(id) {
            hide_from_register(&mut tx, &payload.store_id, id).await?;
            hidden.push(id.clone());
        }
    }

    let record = AppliedRecord {
        catalog_label: CATALOG_LABEL.to_string(),
        applied_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        applied_by_user_id: actor.user_id.clone(),
        vat_rate_id: payload.vat_rate_id.clone(),
        vat_rate_bps: rate_bps,
        vat_pricing_mode: payload.vat_pricing_mode.clone(),
        created: created.len() as i64,
        skipped_existing_sku: skipped.len() as i64,
        kept_existing_by_name: kept_by_name.len() as i64,
        hidden_from_register: hidden.len() as i64,
    };
    // A plain INSERT, not INSERT OR REPLACE: if another apply committed between
    // the marker read and here, the primary key refuses this one whole.
    sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
        .bind(marker_key(&payload.store_id))
        .bind(serde_json::to_string(&record).map_err(|e| format!("encode marker: {e}"))?)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("record the menu load: {e}"))?;

    tx.commit().await.map_err(|e| format!("commit tx: {e}"))?;
    Ok(ApplyOfficialMenuResult {
        created_skus: created,
        skipped_existing_skus: skipped,
        kept_existing_by_name_skus: kept_by_name,
        hidden_product_ids: hidden,
        record,
    })
}

/// Take one product off the Register. The ONLY write apply makes to a product
/// that already existed, and it is reversible from Products.
async fn hide_from_register(
    conn: &mut SqliteConnection,
    store_id: &str,
    product_id: &str,
) -> Result<(), String> {
    let done = sqlx::query(
        "UPDATE products SET show_on_register = 0
          WHERE id = ? AND store_id = ? AND show_on_register = 1",
    )
    .bind(product_id)
    .bind(store_id)
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("take {product_id} off the Register: {e}"))?;
    if done.rows_affected() != 1 {
        return Err(format!(
            "{product_id} could not be taken off the Register. Nothing has been changed."
        ));
    }
    Ok(())
}

async fn insert_menu_item(
    conn: &mut SqliteConnection,
    payload: &ApplyOfficialMenuPayload,
    rate_bps: i64,
    item: &PreviewItem,
) -> Result<(), String> {
    // The printed price is the AUTHORITATIVE side of the pair the owner named;
    // the other side is derived with the application's own VAT rounding, the
    // same helpers `post_sale` validates a line against.
    let (excl, incl) = if payload.vat_pricing_mode == "inclusive" {
        (crate::posting::strip_vat(item.price_usd_cents, rate_bps)?, item.price_usd_cents)
    } else {
        (item.price_usd_cents, crate::posting::add_vat(item.price_usd_cents, rate_bps)?)
    };
    let product_id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        r#"INSERT INTO products (
             id, store_id, sku, name, description,
             vat_rate_id, vat_pricing_mode,
             price_excl_vat_cents, price_incl_vat_cents,
             avg_cost_excl_vat_microcents, avg_cost_incl_vat_microcents,
             avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
             quantity_on_hand, reorder_point,
             is_active, is_service,
             category, icon,
             costing_method, standard_cost_excl_vat_microcents, standard_cost_set_at,
             show_on_register, allow_negative_stock
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, 1, 1, ?, ?,
                     'purchase_average', NULL, NULL, ?, 0)"#,
    )
    .bind(&product_id)
    .bind(&payload.store_id)
    .bind(&item.sku)
    .bind(&item.name)
    .bind(&item.description)
    .bind(&payload.vat_rate_id)
    .bind(&payload.vat_pricing_mode)
    .bind(excl)
    .bind(incl)
    .bind(&item.category)
    .bind(&item.icon)
    .bind(i64::from(item.sellable))
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("create {}: {e}", item.sku))?;

    sqlx::query(
        r#"INSERT INTO product_uoms (
             id, store_id, product_id, uom_code, factor_num, factor_den,
             is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
             sale_price_excl_vat_cents, sale_price_incl_vat_cents
           ) VALUES (?, ?, ?, 'each', 1, 1, 1, 1, 1, 1, NULL, NULL)"#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&payload.store_id)
    .bind(&product_id)
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("create the unit for {}: {e}", item.sku))?;
    Ok(())
}
