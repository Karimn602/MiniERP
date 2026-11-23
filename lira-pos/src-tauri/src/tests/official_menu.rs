// Greaz's official menu: the bundled catalog and its one-time load.
//
// Every test runs against a brand-new disposable `TempDb`. No application
// identity's database is opened.

use crate::auth::{Actor, Role};
use crate::official_menu::{
    apply_tx, load_catalog, marker_key, preview_as, validate_apply, ApplyOfficialMenuPayload,
    NameMatchReplacement, CATALOG_LABEL,
};
use crate::posting::post_sale_with_pool;
use crate::tests::builders::{cash_usd, sale_payload, SaleLineBuilder};
use crate::test_support::*;

const VAT_ZERO_ID: &str = "00000000-0000-0000-0000-000000000011";

/// Every item of the printed menu, exactly as the founder's transcription
/// states it: SKU, section, name, price in cents, kind, sellable.
const EXPECTED: &[(&str, &str, &str, i64, &str, bool)] = &[
    ("GRZ-BUR-001", "burgers", "Double Smash", 700, "menu", true),
    ("GRZ-BUR-002", "burgers", "Triple Smash", 900, "menu", true),
    ("GRZ-BUR-003", "burgers", "OG Chicken", 700, "menu", true),
    ("GRZ-BUR-004", "burgers", "Dipper Chicken", 700, "menu", true),
    ("GRZ-BUR-005", "burgers", "Smushroom", 850, "menu", true),
    ("GRZ-BUR-006", "burgers", "Triple Smushroom", 1050, "menu", true),
    ("GRZ-BUR-007", "burgers", "Chicken Smushroom", 850, "menu", true),
    ("GRZ-WRP-001", "wraps", "Boneless", 700, "menu", true),
    ("GRZ-WRP-002", "wraps", "OG Chicken", 700, "menu", true),
    ("GRZ-WRP-003", "wraps", "Twister", 850, "menu", true),
    ("GRZ-WRP-004", "wraps", "OG Grilled Chicken", 700, "menu", true),
    ("GRZ-FRY-001", "fries", "Fries (ketchup)", 300, "menu", true),
    ("GRZ-FRY-002", "fries", "Curly Fries", 450, "menu", true),
    ("GRZ-FRY-003", "fries", "Bacon Fries", 600, "menu", true),
    ("GRZ-FRY-004", "fries", "Chilli Cheese Fries", 600, "menu", true),
    ("GRZ-FRY-005", "fries", "Chicken Loaded Fries", 600, "menu", true),
    ("GRZ-FRY-006", "fries", "OG Loaded Fries", 600, "menu", true),
    ("GRZ-APP-001", "appetizers", "Onion Rings (7 pcs)", 500, "menu", true),
    ("GRZ-APP-002", "appetizers", "Cheese Balls (6 pcs)", 500, "menu", true),
    ("GRZ-APP-003", "appetizers", "Wings (7 pcs)", 550, "menu", true),
    ("GRZ-APP-004", "appetizers", "Chicken Tenders (4 pcs)", 650, "menu", true),
    ("GRZ-APP-005", "appetizers", "Mozzarella Bricks (3 pcs)", 600, "menu", true),
    ("GRZ-CMB-001", "combos", "Chicken Strips Combo", 900, "menu", true),
    ("GRZ-CMB-002", "combos", "Greaz Box", 1600, "menu", true),
    ("GRZ-DRK-001", "drinks", "Soft Drink", 100, "menu", true),
    ("GRZ-DRK-002", "drinks", "Water", 50, "menu", true),
    ("GRZ-DES-001", "dessert", "Ice Cream Burger", 650, "menu", false),
    ("GRZ-ADD-001", "addons", "Beef Bacon Add-on", 200, "add_on", true),
    ("GRZ-ADD-002", "addons", "Mozzarella Patty Add-on", 200, "add_on", true),
    ("GRZ-ADD-003", "addons", "Red Cheddar Slice (1 pc)", 50, "add_on", true),
    ("GRZ-ADD-004", "addons", "Swiss Cheese (1 pc)", 50, "add_on", true),
    ("GRZ-UPG-001", "upgrades", "Fries + Soft Drink Upgrade", 300, "upgrade", true),
    ("GRZ-UPG-002", "upgrades", "Curly Fries + Soft Drink Upgrade", 450, "upgrade", true),
];

fn replacement(sku: &str, ids: &[&str]) -> NameMatchReplacement {
    NameMatchReplacement {
        sku: sku.to_string(),
        existing_product_ids: ids.iter().map(|s| s.to_string()).collect(),
    }
}

fn owner() -> Actor {
    Actor::test_owner()
}

fn payload(vat_rate_id: &str, mode: &str) -> ApplyOfficialMenuPayload {
    ApplyOfficialMenuPayload {
        store_id: STORE_ID.to_string(),
        catalog_label: CATALOG_LABEL.to_string(),
        vat_rate_id: vat_rate_id.to_string(),
        vat_pricing_mode: mode.to_string(),
        tax_treatment_confirmed: true,
        replace_name_matches: vec![],
        hide_product_ids: vec![],
    }
}

/// Official-menu products. Every migrated database also holds migration 003's
/// three demo rows, retired (inactive) by 019, which this load never touches.
async fn product_count(db: &TempDb) -> i64 {
    db.count("SELECT COUNT(*) FROM products WHERE sku LIKE 'GRZ-%'").await
}

async fn id_of(db: &TempDb, sku: &str) -> String {
    db.scalar_string(&format!("SELECT id FROM products WHERE sku = '{sku}'")).await
}

/// A store with an owner AND a manager and cashier, for the role refusals.
async fn staffed() -> TempDb {
    let db = TempDb::new().await;
    db.exec(&format!(
        "INSERT INTO users (id, store_id, full_name, role)
         VALUES ('mgr-1', '{STORE_ID}', 'Mona', 'manager'),
                ('csh-1', '{STORE_ID}', 'Sami', 'cashier')"
    ))
    .await;
    db
}

// ===========================================================================
// The catalog
// ===========================================================================

#[test]
fn the_bundled_catalog_has_the_stated_shape_and_every_price() {
    let c = load_catalog().expect("the bundled catalog must load");
    assert_eq!(c.categories.len(), 9);
    assert_eq!(c.choice_groups.len(), 3);
    let count = |k: &str| c.items.iter().filter(|i| i.kind == k).count();
    assert_eq!(count("menu"), 27, "27 primary menu products");
    assert_eq!(count("add_on"), 4);
    assert_eq!(count("upgrade"), 2);
    assert_eq!(c.items.len(), EXPECTED.len());

    for (item, (sku, cat, name, cents, kind, sellable)) in c.items.iter().zip(EXPECTED) {
        assert_eq!(item.sku, *sku);
        assert_eq!(crate::official_menu::category_id(&item.category), Some(*cat), "{sku}");
        assert_eq!(item.name, *name, "{sku}");
        assert_eq!(item.price_usd_cents, *cents, "{sku}");
        assert_eq!(item.kind, *kind, "{sku}");
        assert_eq!(item.status == "active", *sellable, "{sku}");
        assert!(item.barcode.is_none(), "{sku} carries no barcode");
    }

    // The same name in two sections stays two products.
    let og: Vec<&str> = c.items.iter().filter(|i| i.name == "OG Chicken").map(|i| i.sku.as_str()).collect();
    assert_eq!(og, ["GRZ-BUR-003", "GRZ-WRP-002"]);

    // Exactly the three choice groups, on exactly the three items.
    let with_choices: Vec<(&str, &str)> = c
        .items
        .iter()
        .flat_map(|i| i.choice_group_ids.iter().map(move |g| (i.sku.as_str(), g.as_str())))
        .collect();
    assert_eq!(
        with_choices,
        [
            ("GRZ-BUR-004", "dipper_sauce"),
            ("GRZ-FRY-005", "loaded_fries_sauce"),
            ("GRZ-CMB-002", "greaz_box_dips"),
        ]
    );
}

// ===========================================================================
// Fresh store
// ===========================================================================

#[tokio::test]
async fn a_fresh_store_previews_every_item_as_new_and_offers_nothing_to_hide() {
    let db = TempDb::new().await;
    let preview = preview_as(db.pool(), &owner(), STORE_ID).await.unwrap();
    assert!(preview.applied.is_none());
    assert_eq!(preview.items.len(), 33);
    assert!(preview.items.iter().all(|i| i.outcome == "create"));
    // Migration 019 retired the v3 demo items, so a virgin store has nothing
    // on its Register to reconcile.
    assert!(preview.samples.is_empty(), "{:?}", preview.samples);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn applying_creates_the_whole_menu_once_as_sellable_non_stock_items() {
    let db = TempDb::new().await;
    let result = apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "inclusive")).await.unwrap();
    assert_eq!(result.created_skus.len(), 33);
    assert_eq!(product_count(&db).await, 33);

    for (sku, cat, name, cents, _, sellable) in EXPECTED {
        let row = sqlx::query_as::<_, (String, Option<String>, i64, i64, String, i64, i64, i64, Option<String>, String, i64, String)>(
            "SELECT name, category, price_incl_vat_cents, price_excl_vat_cents, vat_pricing_mode,
                    is_service, is_active, show_on_register, icon, vat_rate_id,
                    quantity_on_hand, costing_method
               FROM products WHERE sku = ?",
        )
        .bind(sku)
        .fetch_one(db.pool())
        .await
        .unwrap();
        assert_eq!(row.0, *name);
        assert_eq!(row.1.as_deref(), Some(*cat));
        // The printed price is what the customer pays; VAT is inside it.
        assert_eq!(row.2, *cents, "{sku} incl");
        assert_eq!(row.3, crate::posting::strip_vat(*cents, VAT_STD_BPS).unwrap(), "{sku} excl");
        assert_eq!(row.4, "inclusive");
        assert_eq!(row.5, 1, "{sku} is a non-stock menu item");
        assert_eq!(row.6, 1);
        assert_eq!(row.7, i64::from(*sellable), "{sku} register visibility");
        assert!(row.8.is_some());
        assert_eq!(row.9, VAT_STD_ID);
        assert_eq!(row.10, 0, "no invented stock");
        assert_eq!(row.11, "purchase_average", "no invented cost");
    }

    // One `each` unit per item, base and default sale; no barcode, no cost,
    // no movement, no recipe.
    assert_eq!(
        db.count(
            "SELECT COUNT(*) FROM product_uoms
              WHERE uom_code = 'each' AND is_base = 1 AND is_default_sale_uom = 1
                AND factor_num = 1 AND factor_den = 1"
        )
        .await,
        33
    );
    assert_eq!(
        db.count("SELECT COUNT(*) FROM product_uoms u JOIN products p ON p.id = u.product_id WHERE p.sku LIKE 'GRZ-%'").await,
        33
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE p.sku LIKE 'GRZ-%'").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM recipes").await, 0);
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE sku LIKE 'GRZ-%' AND (avg_cost_excl_vat_microcents <> 0 OR standard_cost_excl_vat_microcents IS NOT NULL)").await,
        0
    );

    // Descriptions are carried; a blank one is NULL, not "".
    assert_eq!(
        db.scalar_string("SELECT description FROM products WHERE sku = 'GRZ-CMB-002'").await,
        "4 onion rings, 4 cheese balls, 5 wings, 3 chicken strips & curly fries. Includes 3 dips of your choice."
    );
    assert_eq!(db.count("SELECT COUNT(*) FROM products WHERE sku = 'GRZ-FRY-002' AND description IS NULL").await, 1);

    // The marker records the decision and who made it.
    let marker = db.scalar_string(&format!("SELECT value FROM app_settings WHERE key = '{}'", marker_key(STORE_ID))).await;
    assert!(marker.contains("\"vatPricingMode\":\"inclusive\""), "{marker}");
    assert!(marker.contains(&format!("\"appliedByUserId\":\"{USER_ID}\"")), "{marker}");
    assert_eq!(result.record.vat_rate_bps, VAT_STD_BPS);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn a_second_apply_is_refused_and_duplicates_nothing() {
    let db = TempDb::new().await;
    apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "inclusive")).await.unwrap();
    let err = apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "inclusive")).await.unwrap_err();
    assert!(err.contains("already loaded"), "{err}");
    assert_eq!(product_count(&db).await, 33);

    let preview = preview_as(db.pool(), &owner(), STORE_ID).await.unwrap();
    assert!(preview.applied.is_some());
    assert!(preview.items.iter().all(|i| i.outcome == "sku_exists"));

    // And re-running the migrations (an application restart) adds nothing.
    db.migrate_again().await.unwrap();
    assert_eq!(product_count(&db).await, 33);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn exclusive_pricing_adds_vat_on_top_of_the_printed_price() {
    let db = TempDb::new().await;
    apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "exclusive")).await.unwrap();
    let (excl, incl): (i64, i64) = sqlx::query_as(
        "SELECT price_excl_vat_cents, price_incl_vat_cents FROM products WHERE sku = 'GRZ-BUR-001'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!((excl, incl), (700, 777));
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn an_unconfirmed_or_unchosen_tax_treatment_writes_nothing() {
    let db = TempDb::new().await;

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.tax_treatment_confirmed = false;
    assert!(validate_apply(&p).unwrap_err().contains("Confirm the tax treatment"));

    let p = payload("", "inclusive");
    assert!(validate_apply(&p).unwrap_err().contains("VAT rate"));

    let p = payload(VAT_STD_ID, "");
    assert!(validate_apply(&p).is_err());

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.catalog_label = "greaz_menu_reference_v0".into();
    assert!(validate_apply(&p).is_err());

    // A rate that does not exist is refused inside the transaction.
    let err = apply_tx(db.pool(), &owner(), payload("no-such-rate", "inclusive")).await.unwrap_err();
    assert!(err.contains("VAT rate"), "{err}");

    assert_eq!(product_count(&db).await, 0);
    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM app_settings WHERE key = '{}'", marker_key(STORE_ID))).await, 0);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn a_zero_rate_keeps_both_prices_at_the_printed_figure() {
    let db = TempDb::new().await;
    apply_tx(db.pool(), &owner(), payload(VAT_ZERO_ID, "inclusive")).await.unwrap();
    assert_eq!(
        db.count("SELECT COUNT(*) FROM products WHERE sku LIKE 'GRZ-%' AND price_excl_vat_cents <> price_incl_vat_cents").await,
        0
    );
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn only_the_owner_may_preview_or_load_the_menu() {
    let db = staffed().await;
    for (id, role) in [("mgr-1", Role::Manager), ("csh-1", Role::Cashier)] {
        let actor = Actor::for_tests(id, STORE_ID, role);
        let err = apply_tx(db.pool(), &actor, payload(VAT_STD_ID, "inclusive")).await.unwrap_err();
        assert!(err.contains("Ask the owner"), "{err}");
        assert!(!crate::authz::permits(role, crate::authz::Operation::ApplyOfficialMenu));
    }
    assert_eq!(product_count(&db).await, 0);
    db.cleanup().await.unwrap();
}

// ===========================================================================
// An existing database
// ===========================================================================

#[tokio::test]
async fn an_existing_store_keeps_every_existing_row_and_reconciles_only_on_request() {
    let db = TempDb::new().await;
    // 1. The official SKU already exists at another price: skipped, untouched.
    seed_product(&db, &ProductSpec { price_incl_vat_cents: 650, ..ProductSpec::stocked("p-old-double", "GRZ-BUR-001", "Double (old)") }).await;
    // 2. A Register item with the same name as an official one, other SKU.
    seed_product(&db, &ProductSpec::stocked("p-old-soft", "Item-00007", "Soft Drink")).await;
    // 3. A sample from the old design fixture.
    seed_product(&db, &ProductSpec::stocked("p-gz-fries", "GZ-SID-FRIES", "Fries")).await;
    // 4. A real ingredient named like a menu item, already off the Register.
    seed_product(&db, &ProductSpec::stocked("p-water-case", "ING-WATER", "Water")).await;
    db.exec("UPDATE products SET show_on_register = 0 WHERE id = 'p-water-case'").await;
    // 5. A shift and a user that must not be touched.
    seed_open_shift(&db).await;

    let before_shifts = db.count("SELECT COUNT(*) FROM shifts").await;
    let before_users = db.count("SELECT COUNT(*) FROM users").await;
    let before_rows = db.scalar_string(
        "SELECT group_concat(id || sku || name || price_incl_vat_cents || price_excl_vat_cents || vat_rate_id || quantity_on_hand || updated_at, '|')
           FROM (SELECT * FROM products ORDER BY id)",
    ).await;

    let preview = preview_as(db.pool(), &owner(), STORE_ID).await.unwrap();
    let outcome = |sku: &str| preview.items.iter().find(|i| i.sku == sku).unwrap().outcome.clone();
    assert_eq!(outcome("GRZ-BUR-001"), "sku_exists");
    assert_eq!(outcome("GRZ-DRK-001"), "name_match");
    assert_eq!(outcome("GRZ-DRK-002"), "create", "an ingredient is not a menu item");
    let sample_ids: Vec<&str> = preview.samples.iter().map(|s| s.product.product_id.as_str()).collect();
    assert_eq!(sample_ids, ["p-gz-fries"]);
    assert!(preview.samples[0].looks_like_sample);

    // DEFAULT apply: nothing existing is changed at all.
    let result = apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "inclusive")).await.unwrap();
    assert_eq!(result.skipped_existing_skus, ["GRZ-BUR-001"]);
    assert_eq!(result.kept_existing_by_name_skus, ["GRZ-DRK-001"]);
    assert!(result.hidden_product_ids.is_empty());
    assert_eq!(result.created_skus.len(), 31);
    let after_rows = db.scalar_string(
        "SELECT group_concat(id || sku || name || price_incl_vat_cents || price_excl_vat_cents || vat_rate_id || quantity_on_hand || updated_at, '|')
           FROM (SELECT * FROM products WHERE sku NOT LIKE 'GRZ-%' OR id LIKE 'p-%' ORDER BY id)",
    ).await;
    assert_eq!(before_rows, after_rows, "no existing product row was written");
    assert_eq!(db.count("SELECT COUNT(*) FROM shifts").await, before_shifts);
    assert_eq!(db.count("SELECT COUNT(*) FROM users").await, before_users);
    assert_eq!(db.count("SELECT COUNT(*) FROM products WHERE sku = 'GRZ-BUR-001'").await, 1);
    assert_eq!(db.count("SELECT COUNT(*) FROM products WHERE name = 'Soft Drink'").await, 1);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn the_owner_may_replace_a_same_named_item_and_hide_samples_explicitly() {
    let db = TempDb::new().await;
    seed_product(&db, &ProductSpec::stocked("p-old-soft", "Item-00007", "Soft Drink")).await;
    seed_product(&db, &ProductSpec::stocked("p-gz-fries", "GZ-SID-FRIES", "Fries")).await;
    seed_product(&db, &ProductSpec::stocked("p-keep", "Item-00008", "Manakish")).await;

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.replace_name_matches = vec![replacement("GRZ-DRK-001", &["p-old-soft"])];
    p.hide_product_ids = vec!["p-gz-fries".into()];
    let result = apply_tx(db.pool(), &owner(), p).await.unwrap();
    assert_eq!(result.created_skus.len(), 33);
    let mut hidden = result.hidden_product_ids.clone();
    hidden.sort();
    assert_eq!(hidden, ["p-gz-fries", "p-old-soft"]);

    let shown = |id: &str| format!("SELECT show_on_register FROM products WHERE id = '{id}'");
    assert_eq!(db.scalar_i64(&shown("p-old-soft")).await, 0);
    assert_eq!(db.scalar_i64(&shown("p-gz-fries")).await, 0);
    assert_eq!(db.scalar_i64(&shown("p-keep")).await, 1, "unticked items stay");
    // Hidden, not deleted or deactivated.
    assert_eq!(db.count("SELECT COUNT(*) FROM products WHERE id LIKE 'p-%' AND is_active = 1").await, 3);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn a_product_the_preview_did_not_offer_cannot_be_hidden() {
    let db = TempDb::new().await;
    seed_product(&db, &ProductSpec::stocked("p-ing", "ING-1", "Meat")).await;
    db.exec("UPDATE products SET show_on_register = 0 WHERE id = 'p-ing'").await;

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.hide_product_ids = vec!["p-ing".into()];
    assert!(apply_tx(db.pool(), &owner(), p).await.is_err());

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.replace_name_matches = vec![replacement("GRZ-BUR-001", &[])];
    assert!(apply_tx(db.pool(), &owner(), p).await.is_err());

    assert_eq!(product_count(&db).await, 0, "a refusal writes nothing");
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn og_chicken_in_another_section_matches_only_its_own_section() {
    let db = TempDb::new().await;
    seed_product(&db, &ProductSpec::stocked("p-og-wrap", "Item-1", "OG Chicken")).await;
    db.exec("UPDATE products SET category = 'wraps' WHERE id = 'p-og-wrap'").await;
    let preview = preview_as(db.pool(), &owner(), STORE_ID).await.unwrap();
    let outcome = |sku: &str| preview.items.iter().find(|i| i.sku == sku).unwrap().outcome.clone();
    assert_eq!(outcome("GRZ-WRP-002"), "name_match");
    assert_eq!(outcome("GRZ-BUR-003"), "create");
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn replacing_one_og_chicken_does_not_leave_the_other_section_without_one() {
    let db = TempDb::new().await;
    // Uncategorised, so it matches BOTH the burger and the wrap.
    seed_product(&db, &ProductSpec::stocked("p-og", "Item-1", "OG Chicken")).await;
    let preview = preview_as(db.pool(), &owner(), STORE_ID).await.unwrap();
    for sku in ["GRZ-BUR-003", "GRZ-WRP-002"] {
        assert_eq!(preview.items.iter().find(|i| i.sku == sku).unwrap().outcome, "name_match");
    }

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.replace_name_matches = vec![replacement("GRZ-BUR-003", &["p-og"])];
    let result = apply_tx(db.pool(), &owner(), p).await.unwrap();
    assert!(result.created_skus.contains(&"GRZ-BUR-003".to_string()));
    assert!(
        result.created_skus.contains(&"GRZ-WRP-002".to_string()),
        "the wrap's only match was taken off the Register, so the official wrap is added"
    );
    assert!(result.kept_existing_by_name_skus.is_empty());
    assert_eq!(db.scalar_i64("SELECT show_on_register FROM products WHERE id = 'p-og'").await, 0);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn a_replacement_refuses_if_the_same_named_items_changed_since_the_preview() {
    let db = TempDb::new().await;
    seed_product(&db, &ProductSpec::stocked("p-old-soft", "Item-00007", "Soft Drink")).await;
    // The owner reviewed ONE Soft Drink. Another is created before Apply.
    seed_product(&db, &ProductSpec::stocked("p-new-soft", "Item-00009", "Soft Drink")).await;

    let mut p = payload(VAT_STD_ID, "inclusive");
    p.replace_name_matches = vec![replacement("GRZ-DRK-001", &["p-old-soft"])];
    let err = apply_tx(db.pool(), &owner(), p).await.unwrap_err();
    assert!(err.contains("changed since the preview"), "{err}");
    assert_eq!(product_count(&db).await, 0);
    assert_eq!(db.count("SELECT COUNT(*) FROM products WHERE name = 'Soft Drink' AND show_on_register = 1").await, 2);
    db.cleanup().await.unwrap();
}

#[tokio::test]
async fn the_one_time_record_belongs_to_one_store() {
    let db = TempDb::new().await;
    seed_store(&db, "store-b", "Branch B").await;
    apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "inclusive")).await.unwrap();

    let b_owner = Actor::for_tests(&seeded_owner_of("store-b"), "store-b", Role::Owner);
    let b = preview_as(db.pool(), &b_owner, "store-b").await.unwrap();
    assert!(b.applied.is_none(), "loading branch A says nothing about branch B");
    assert!(b.items.iter().all(|i| i.outcome == "create"));
    let mut p = payload(VAT_STD_ID, "inclusive");
    p.store_id = "store-b".into();
    apply_tx(db.pool(), &b_owner, p).await.unwrap();
    assert_eq!(db.count("SELECT COUNT(*) FROM products WHERE sku LIKE 'GRZ-%' AND store_id = 'store-b'").await, 33);
    assert_eq!(db.count(&format!("SELECT COUNT(*) FROM products WHERE sku LIKE 'GRZ-%' AND store_id = '{STORE_ID}'")).await, 33);

    // And an owner of one store cannot load into another.
    let mut p = payload(VAT_STD_ID, "inclusive");
    p.store_id = "store-b".into();
    assert!(apply_tx(db.pool(), &owner(), p).await.is_err());
    assert!(preview_as(db.pool(), &owner(), "store-b").await.is_err());
    db.cleanup().await.unwrap();
}

// ===========================================================================
// Selling the menu
// ===========================================================================

#[tokio::test]
async fn a_loaded_item_sells_and_the_coming_soon_dessert_does_not() {
    let db = TempDb::new().await;
    seed_exchange_rate(&db).await;
    seed_open_shift(&db).await;
    apply_tx(db.pool(), &owner(), payload(VAT_STD_ID, "inclusive")).await.unwrap();

    // Two OG Chickens — the burger and the wrap — and a Double Smash, with a
    // sauce choice carried as the kitchen note.
    let burger = id_of(&db, "GRZ-BUR-003").await;
    let wrap = id_of(&db, "GRZ-WRP-002").await;
    let dipper = id_of(&db, "GRZ-BUR-004").await;
    let bacon = id_of(&db, "GRZ-ADD-001").await;
    let lines = vec![
        SaleLineBuilder::new(&burger, "OG Chicken").service(true).unit_incl(700).build(),
        SaleLineBuilder::new(&wrap, "OG Chicken").service(true).unit_incl(700).build(),
        SaleLineBuilder::new(&dipper, "Dipper Chicken").service(true).unit_incl(700).note("Sauce: Buffalo").build(),
        SaleLineBuilder::new(&bacon, "Beef Bacon Add-on").service(true).unit_incl(200).build(),
    ];
    post_sale_with_pool(db.pool(), sale_payload(lines, vec![cash_usd(2300)])).await.unwrap();
    assert_eq!(db.scalar_i64("SELECT total_incl_vat_cents FROM sales WHERE status = 'posted'").await, 2300);
    assert_eq!(db.count("SELECT COUNT(*) FROM sale_items WHERE cogs_source = 'uncosted'").await, 4);
    assert_eq!(db.count("SELECT COUNT(*) FROM inventory_movements").await, 0, "non-stock lines move no stock");
    assert_eq!(db.scalar_string("SELECT kitchen_note FROM sale_items WHERE product_id = (SELECT id FROM products WHERE sku = 'GRZ-BUR-004')").await, "Sauce: Buffalo");

    let dessert = id_of(&db, "GRZ-DES-001").await;
    let line = SaleLineBuilder::new(&dessert, "Ice Cream Burger").service(true).unit_incl(650).build();
    let err = post_sale_with_pool(db.pool(), sale_payload(vec![line], vec![cash_usd(650)])).await.unwrap_err();
    assert!(!err.is_empty());
    assert_eq!(db.count("SELECT COUNT(*) FROM sales").await, 1);
    db.cleanup().await.unwrap();
}
