// Layer C — WP-07 correction pass: the catalog write seam.
//
// Two defects, both in code that was never transactional because it lived in
// TypeScript, where tauri-plugin-sql's connection pool gives no usable
// BEGIN/COMMIT:
//
//   * GZ-HI-09 — saving a product was two to four separate writes. An ordinary
//     duplicate SKU or duplicate barcode part-way through left a product with
//     no base UoM, or no default sale UoM, or barcodes and no primary. The
//     first two are catalog objects `productsRepo.enrich` REFUSES to load,
//     which breaks the product list for every other product too.
//
//   * GZ-HI-10 — the generic product UPDATE wrote `quantity_on_hand` and the
//     weighted-average cost. The Products page computed
//     `quantityOnHand = form.isService ? 0 : existing`, so ticking "service"
//     on a product holding ten units destroyed ten units of stock with no
//     `inventory_movements` row behind it. `SUM(quantity_delta)` and
//     `quantity_on_hand` then disagreed permanently — the one invariant the
//     whole inventory model rests on.
//
// Every test here drives the real Rust commands against a real migrated SQLite
// database, which is the only way the rollback claims mean anything.

use crate::catalog::{
    add_product_barcode_with_pool, remove_product_barcode_with_pool, save_product_with_pool,
    set_primary_product_barcode_with_pool, AddBarcodePayload, BarcodeRefPayload,
    SaveProductPayload,
};
use crate::test_support::*;

const P_NEW: &str = "00000000-0000-0000-0000-0000000000e1";
const P_EXISTING: &str = "00000000-0000-0000-0000-0000000000e2";

/// A store holding one product — "Coffee 250g", SKU `SKU-E2`, 10 on hand at
/// $2.00 / $2.22 — with the barcode `1111111111111` as its primary.
async fn shop() -> TempDb {
    let db = TempDb::new().await;
    seed_product(
        &db,
        &ProductSpec {
            quantity_on_hand: 10,
            avg_cost_excl_vat_cents: 200,
            avg_cost_incl_vat_cents: 222,
            ..ProductSpec::stocked(P_EXISTING, "SKU-E2", "Coffee 250g")
        },
    )
    .await;
    seed_barcode(&db, P_EXISTING, "1111111111111", true).await;
    db
}

async fn seed_barcode(db: &TempDb, product_id: &str, barcode: &str, primary: bool) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    db.exec(&format!(
        "INSERT INTO product_barcodes
           (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
         VALUES ('{id}', '{STORE_ID}', '{product_id}', '{barcode}', '{barcode}', 'OTHER', {}, 1)",
        i64::from(primary)
    ))
    .await;
    id
}

/// A well-formed create payload: "Latte", stocked in `each`, sold in `each`.
fn create_payload(product_id: &str, sku: &str, name: &str) -> SaveProductPayload {
    SaveProductPayload {
        product_id: product_id.to_string(),
        store_id: STORE_ID.to_string(),
        mode: "create".to_string(),
        sku: Some(sku.to_string()),
        name: name.to_string(),
        description: None,
        vat_rate_id: VAT_STD_ID.to_string(),
        vat_pricing_mode: "inclusive".to_string(),
        price_excl_vat_cents: 450,
        price_incl_vat_cents: 500,
        reorder_point: None,
        is_service: false,
        is_active: true,
        base_uom_code: "each".to_string(),
        sale_uom_code: "each".to_string(),
        sale_factor_num: 1,
        sale_factor_den: 1,
        sale_price_excl_vat_cents: None,
        sale_price_incl_vat_cents: None,
        barcode: None,
        barcode_type: None,
    }
}

/// An update payload that restates the seeded product exactly as the Products
/// page would on an edit, with `name` as the only thing a caller varies.
fn update_payload(name: &str) -> SaveProductPayload {
    SaveProductPayload {
        product_id: P_EXISTING.to_string(),
        store_id: STORE_ID.to_string(),
        mode: "update".to_string(),
        sku: Some("SKU-E2".to_string()),
        name: name.to_string(),
        description: None,
        vat_rate_id: VAT_STD_ID.to_string(),
        vat_pricing_mode: "inclusive".to_string(),
        price_excl_vat_cents: 1000,
        price_incl_vat_cents: 1110,
        reorder_point: None,
        is_service: false,
        is_active: true,
        base_uom_code: "each".to_string(),
        sale_uom_code: "each".to_string(),
        sale_factor_num: 1,
        sale_factor_den: 1,
        sale_price_excl_vat_cents: None,
        sale_price_incl_vat_cents: None,
        barcode: None,
        barcode_type: None,
    }
}

async fn product_count(db: &TempDb, product_id: &str) -> i64 {
    db.count(&format!(
        "SELECT COUNT(*) FROM products WHERE id = '{product_id}'"
    ))
    .await
}

async fn uom_count(db: &TempDb, product_id: &str) -> i64 {
    db.count(&format!(
        "SELECT COUNT(*) FROM product_uoms WHERE product_id = '{product_id}'"
    ))
    .await
}

async fn barcode_count(db: &TempDb, product_id: &str) -> i64 {
    db.count(&format!(
        "SELECT COUNT(*) FROM product_barcodes WHERE product_id = '{product_id}' AND is_active = 1"
    ))
    .await
}

async fn primary_barcode(db: &TempDb, product_id: &str) -> String {
    db.scalar_string(&format!(
        "SELECT COALESCE((SELECT barcode FROM product_barcodes
            WHERE product_id = '{product_id}' AND is_primary = 1 AND is_active = 1), 'NONE')"
    ))
    .await
}

async fn default_sale_uom(db: &TempDb, product_id: &str) -> String {
    db.scalar_string(&format!(
        "SELECT COALESCE((SELECT uom_code FROM product_uoms
            WHERE product_id = '{product_id}' AND is_default_sale_uom = 1), 'NONE')"
    ))
    .await
}

// ============================================================================
// 1. GZ-HI-09 — a catalog save is all or nothing
// ============================================================================

/// The ordinary case first: one call produces a loadable product — a row, a
/// base UoM, a default sale UoM and a primary barcode.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_create_produces_a_complete_loadable_product_in_one_call() {
    let db = shop().await;
    let mut payload = create_payload(P_NEW, "SKU-E1", "Latte");
    payload.base_uom_code = "each".to_string();
    payload.sale_uom_code = "box".to_string();
    payload.sale_factor_num = 12;
    payload.barcode = Some("2222222222222".to_string());

    save_product_with_pool(db.pool(), payload)
        .await
        .expect("a well-formed create must save");

    assert_eq!(product_count(&db, P_NEW).await, 1);
    assert_eq!(uom_count(&db, P_NEW).await, 2, "a base row and a selling row");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM product_uoms WHERE product_id = '{P_NEW}' AND is_base = 1"
        ))
        .await,
        1,
        "exactly one base row"
    );
    assert_eq!(default_sale_uom(&db, P_NEW).await, "box");
    assert_eq!(primary_barcode(&db, P_NEW).await, "2222222222222");
}

/// A duplicate SKU is caught by `UNIQUE (store_id, sku)` on the FIRST statement
/// of the transaction, and reported as a sentinel the repo turns into
/// `DuplicateSkuError` rather than by sniffing driver text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_sku_leaves_no_trace_of_the_attempt() {
    let db = shop().await;

    let err = save_product_with_pool(db.pool(), create_payload(P_NEW, "SKU-E2", "Latte"))
        .await
        .expect_err("SKU-E2 is taken");
    assert_eq!(err, "DUPLICATE_SKU");

    assert_eq!(product_count(&db, P_NEW).await, 0);
    assert_eq!(uom_count(&db, P_NEW).await, 0);
    assert_eq!(
        db.scalar_string(&format!("SELECT name FROM products WHERE id = '{P_EXISTING}'")).await,
        "Coffee 250g",
        "and the product that owns the SKU is untouched"
    );
}

/// THE GZ-HI-09 defect, at the stage that actually bit: the product row and
/// BOTH UoM rows are already inserted when the barcode turns out to be taken.
///
/// Before this, the operator saw "failed" and had a product in the catalog with
/// no barcode — so they typed it in again and got a second product. Now the
/// failure rolls the whole thing back, including the demotion of the other
/// product's primary barcode.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_barcode_rolls_back_the_product_and_its_uoms() {
    let db = shop().await;
    let mut payload = create_payload(P_NEW, "SKU-E1", "Latte");
    payload.sale_uom_code = "box".to_string();
    payload.sale_factor_num = 12;
    // Already owned by P_EXISTING, and `UNIQUE (store_id, barcode)` is
    // store-wide — so this fails at the last statement of the transaction.
    payload.barcode = Some("1111111111111".to_string());

    let err = save_product_with_pool(db.pool(), payload)
        .await
        .expect_err("that barcode belongs to another product");
    assert_eq!(err, "DUPLICATE_BARCODE");

    // Exact pre-operation state.
    assert_eq!(product_count(&db, P_NEW).await, 0, "no half-created product");
    assert_eq!(uom_count(&db, P_NEW).await, 0, "no orphaned UoM rows");
    assert_eq!(
        db.count("SELECT COUNT(*) FROM product_barcodes WHERE barcode = '1111111111111'").await,
        1,
        "and no second row for the barcode"
    );
    assert_eq!(
        primary_barcode(&db, P_EXISTING).await,
        "1111111111111",
        "the other product's primary was demoted inside the transaction and restored by the rollback"
    );
}

/// A failure injected BETWEEN the two UoM inserts — a selling unit that is not
/// in `units_of_measure`, which the foreign key refuses.
///
/// This is the stage that produced the unloadable product: the base row was in,
/// the selling row was not, and the product had no default sale UoM.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_between_the_two_uom_inserts_rolls_back_the_product() {
    let db = shop().await;
    let mut payload = create_payload(P_NEW, "SKU-E1", "Latte");
    payload.sale_uom_code = "firkin".to_string(); // not a unit of measure
    payload.sale_factor_num = 9;

    let err = save_product_with_pool(db.pool(), payload)
        .await
        .expect_err("an unknown selling unit cannot be saved");
    assert!(err.contains("sale UoM"), "got: {err}");

    assert_eq!(product_count(&db, P_NEW).await, 0);
    assert_eq!(
        uom_count(&db, P_NEW).await,
        0,
        "including the base row that had already been written"
    );
}

/// An UPDATE clears every `is_default_sale_uom` flag and sets one, and those
/// two statements are one step.
///
/// The injected failure is the base-factor refusal, which fires AFTER the
/// clear. Separately, the clear would have committed and the product would have
/// been left with no default sale UoM at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_update_does_not_leave_a_product_without_a_default_sale_uom() {
    let db = shop().await;
    assert_eq!(default_sale_uom(&db, P_EXISTING).await, "each");

    let mut payload = update_payload("Coffee 250g");
    // `each` is this product's BASE unit, so its factor is 1/1 by definition.
    payload.sale_factor_num = 12;

    let err = save_product_with_pool(db.pool(), payload)
        .await
        .expect_err("a base unit's factor cannot be rewritten");
    assert!(err.contains("stocking unit"), "got: {err}");

    assert_eq!(
        default_sale_uom(&db, P_EXISTING).await,
        "each",
        "the clear rolled back with the rest"
    );
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT factor_num FROM product_uoms WHERE product_id = '{P_EXISTING}'"
        ))
        .await,
        1,
        "and the base factor is still 1"
    );
}

/// A duplicate SKU on an UPDATE rolls back the metadata with everything else —
/// the name is not half-applied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_update_applies_none_of_the_metadata() {
    let db = shop().await;
    save_product_with_pool(db.pool(), create_payload(P_NEW, "SKU-E1", "Latte"))
        .await
        .unwrap();

    let mut payload = update_payload("Renamed Coffee");
    payload.sku = Some("SKU-E1".to_string()); // now owned by the Latte

    let err = save_product_with_pool(db.pool(), payload)
        .await
        .expect_err("SKU-E1 is taken");
    assert_eq!(err, "DUPLICATE_SKU");

    assert_eq!(
        db.scalar_string(&format!("SELECT name FROM products WHERE id = '{P_EXISTING}'")).await,
        "Coffee 250g",
        "the rename rolled back too"
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT sku FROM products WHERE id = '{P_EXISTING}'")).await,
        "SKU-E2"
    );
}

// ============================================================================
// 2. GZ-HI-09 — the barcode commands
// ============================================================================

/// Adding a barcode demotes the current primary and inserts the new row as one
/// step. A duplicate fails the insert, and the demotion goes with it — so the
/// product is never left with barcodes and nothing to print on a label.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_barcode_does_not_cost_a_product_its_primary() {
    let db = shop().await;

    let err = add_product_barcode_with_pool(
        db.pool(),
        AddBarcodePayload {
            product_id: P_EXISTING.to_string(),
            barcode: "1111111111111".to_string(),
            barcode_type: None,
            make_primary: Some(true),
        },
    )
    .await
    .expect_err("the product already has that barcode");
    assert_eq!(err, "DUPLICATE_BARCODE");

    assert_eq!(barcode_count(&db, P_EXISTING).await, 1);
    assert_eq!(
        primary_barcode(&db, P_EXISTING).await,
        "1111111111111",
        "the demotion rolled back"
    );
}

/// A second barcode does not steal the primary flag unless it is asked to, and
/// promoting it later is one step.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_barcode_is_added_then_promoted_atomically() {
    let db = shop().await;

    let added = add_product_barcode_with_pool(
        db.pool(),
        AddBarcodePayload {
            product_id: P_EXISTING.to_string(),
            barcode: "3333333333333".to_string(),
            barcode_type: None,
            make_primary: None,
        },
    )
    .await
    .expect("a second barcode must be addable");
    assert_eq!(barcode_count(&db, P_EXISTING).await, 2);
    assert_eq!(
        primary_barcode(&db, P_EXISTING).await,
        "1111111111111",
        "the first barcode keeps the flag"
    );

    set_primary_product_barcode_with_pool(
        db.pool(),
        BarcodeRefPayload {
            product_id: P_EXISTING.to_string(),
            barcode_id: added.id.clone(),
        },
    )
    .await
    .expect("promoting the second must work");
    assert_eq!(primary_barcode(&db, P_EXISTING).await, "3333333333333");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM product_barcodes
              WHERE product_id = '{P_EXISTING}' AND is_primary = 1 AND is_active = 1"
        ))
        .await,
        1,
        "exactly one primary, always"
    );
}

/// Promoting a barcode that does not belong to the product demotes nothing.
///
/// Demote-then-promote was two calls, and the promote matched on the barcode id
/// alone — so a stale id left the product with no primary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promoting_a_foreign_barcode_leaves_the_current_primary_alone() {
    let db = shop().await;
    save_product_with_pool(db.pool(), create_payload(P_NEW, "SKU-E1", "Latte"))
        .await
        .unwrap();
    let other = seed_barcode(&db, P_NEW, "4444444444444", true).await;

    let err = set_primary_product_barcode_with_pool(
        db.pool(),
        BarcodeRefPayload {
            product_id: P_EXISTING.to_string(),
            barcode_id: other.clone(),
        },
    )
    .await
    .expect_err("that barcode belongs to another product");
    assert!(err.contains("not found"), "got: {err}");

    assert_eq!(primary_barcode(&db, P_EXISTING).await, "1111111111111");
    assert_eq!(
        primary_barcode(&db, P_NEW).await,
        "4444444444444",
        "and the other product kept its own"
    );
}

/// Removing the primary deactivates it and promotes the oldest survivor in the
/// same transaction; removing the last barcode is refused outright.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removing_a_primary_promotes_a_survivor_in_the_same_transaction() {
    let db = shop().await;
    let primary = db
        .scalar_string(&format!(
            "SELECT id FROM product_barcodes WHERE product_id = '{P_EXISTING}' AND is_primary = 1"
        ))
        .await;
    seed_barcode(&db, P_EXISTING, "5555555555555", false).await;

    remove_product_barcode_with_pool(
        db.pool(),
        BarcodeRefPayload {
            product_id: P_EXISTING.to_string(),
            barcode_id: primary.clone(),
        },
    )
    .await
    .expect("removing the primary must work when there is a survivor");

    assert_eq!(barcode_count(&db, P_EXISTING).await, 1);
    assert_eq!(
        primary_barcode(&db, P_EXISTING).await,
        "5555555555555",
        "the survivor was promoted, not left unflagged"
    );

    // And the last one cannot go: a product with no barcode cannot be scanned.
    let last = db
        .scalar_string(&format!(
            "SELECT id FROM product_barcodes WHERE product_id = '{P_EXISTING}' AND is_active = 1"
        ))
        .await;
    let err = remove_product_barcode_with_pool(
        db.pool(),
        BarcodeRefPayload {
            product_id: P_EXISTING.to_string(),
            barcode_id: last,
        },
    )
    .await
    .expect_err("the last barcode cannot be removed");
    assert!(err.contains("last barcode"), "got: {err}");
    assert_eq!(barcode_count(&db, P_EXISTING).await, 1, "still there");
    assert_eq!(primary_barcode(&db, P_EXISTING).await, "5555555555555");
}

// ============================================================================
// 3. GZ-HI-10 — a metadata edit never writes stock or cost
// ============================================================================

/// A — renaming a product does not touch its stock.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_a_product_leaves_its_stock_alone() {
    let db = shop().await;

    save_product_with_pool(db.pool(), update_payload("Coffee 250g — Dark Roast"))
        .await
        .expect("a rename must save");

    assert_eq!(
        db.scalar_string(&format!("SELECT name FROM products WHERE id = '{P_EXISTING}'")).await,
        "Coffee 250g — Dark Roast"
    );
    assert_eq!(quantity_on_hand(&db, P_EXISTING).await, 10, "stock untouched");
}

/// B — nor its weighted-average cost, in either representation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_metadata_edit_leaves_the_weighted_average_cost_alone() {
    let db = shop().await;
    let before_excl = avg_cost_excl_microcents(&db, P_EXISTING).await;
    let before_incl = avg_cost_incl_microcents(&db, P_EXISTING).await;
    assert_eq!(before_excl, 200 * 1_000_000, "the fixture's $2.00");

    let mut payload = update_payload("Coffee 250g");
    payload.price_excl_vat_cents = 9_999;
    payload.price_incl_vat_cents = 11_099;
    payload.reorder_point = Some(4);
    save_product_with_pool(db.pool(), payload)
        .await
        .expect("a price and reorder-point edit must save");

    assert_eq!(avg_cost_excl_microcents(&db, P_EXISTING).await, before_excl);
    assert_eq!(avg_cost_incl_microcents(&db, P_EXISTING).await, before_incl);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_cents FROM products WHERE id = '{P_EXISTING}'"
        ))
        .await,
        200,
        "the rounded cents mirror is not writable from here either"
    );
    // The SELLING price, which a metadata edit legitimately owns, did change.
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT price_excl_vat_cents FROM products WHERE id = '{P_EXISTING}'"
        ))
        .await,
        9_999
    );
}

/// C — THE defect. Turning a product with stock on the shelf into a service is
/// refused, and nothing about the edit is applied.
///
/// The old path wrote `quantity_on_hand = 0` and destroyed ten units with no
/// movement row to account for them. A zeroing movement is NOT fabricated
/// instead: this command does not know why the stock is going away, and a
/// movement under an invented reason is worse than a refusal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stocked_product_holding_stock_cannot_be_turned_into_a_service() {
    let db = shop().await;
    let mut payload = update_payload("Barista service");
    payload.is_service = true;

    let err = save_product_with_pool(db.pool(), payload)
        .await
        .expect_err("ten units cannot vanish into a reclassification");
    assert_eq!(
        err, "STOCKED_TO_SERVICE_WITH_STOCK:10",
        "the refusal reports the quantity, so the UI can tell the operator what to write off"
    );

    assert_eq!(quantity_on_hand(&db, P_EXISTING).await, 10, "still on the shelf");
    assert_eq!(
        db.scalar_i64(&format!("SELECT is_service FROM products WHERE id = '{P_EXISTING}'")).await,
        0,
        "and not reclassified"
    );
    assert_eq!(
        db.scalar_string(&format!("SELECT name FROM products WHERE id = '{P_EXISTING}'")).await,
        "Coffee 250g",
        "nor renamed — the whole edit rolled back"
    );
}

/// D — once the stock is written off through the adjustment flow, which records
/// the movement, the same edit goes through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_product_with_no_stock_left_can_become_a_service() {
    let db = shop().await;
    // The supported route: an inventory adjustment, which writes a movement.
    crate::posting::post_adjustment_with_pool(
        db.pool(),
        crate::tests::builders::adjustment_payload(
            "no longer stocked",
            vec![crate::tests::builders::adjustment_line(P_EXISTING, -10)],
        ),
    )
    .await
    .expect("writing the stock off must post");
    assert_eq!(quantity_on_hand(&db, P_EXISTING).await, 0);

    let mut payload = update_payload("Barista service");
    payload.is_service = true;
    save_product_with_pool(db.pool(), payload)
        .await
        .expect("with nothing on the shelf the reclassification is fine");

    assert_eq!(
        db.scalar_i64(&format!("SELECT is_service FROM products WHERE id = '{P_EXISTING}'")).await,
        1
    );
    assert_eq!(quantity_on_hand(&db, P_EXISTING).await, 0);
    assert_eq!(
        movement_sum(&db, P_EXISTING).await,
        -10,
        "and the write-off is still accounted for, by the movement that did it"
    );
}

/// E — the reverse direction fabricates nothing. A service becoming a stocked
/// product starts at zero, not at a quantity the form happened to be holding.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_service_becoming_stocked_starts_with_nothing_on_hand() {
    let db = shop().await;
    let mut payload = create_payload(P_NEW, "SKU-E1", "Delivery");
    payload.is_service = true;
    save_product_with_pool(db.pool(), payload).await.unwrap();
    assert_eq!(quantity_on_hand(&db, P_NEW).await, 0);

    let mut payload = create_payload(P_NEW, "SKU-E1", "Delivery box");
    payload.mode = "update".to_string();
    payload.is_service = false;
    save_product_with_pool(db.pool(), payload)
        .await
        .expect("a service may become stocked");

    assert_eq!(
        db.scalar_i64(&format!("SELECT is_service FROM products WHERE id = '{P_NEW}'")).await,
        0
    );
    assert_eq!(quantity_on_hand(&db, P_NEW).await, 0, "nothing invented");
    assert_eq!(avg_cost_excl_microcents(&db, P_NEW).await, 0, "and no cost basis");
    assert_eq!(
        db.count(&format!(
            "SELECT COUNT(*) FROM inventory_movements WHERE product_id = '{P_NEW}'"
        ))
        .await,
        0,
        "no movement, because nothing moved"
    );
}

/// F — the invariant the whole thing exists to protect: after a purchase, a
/// sale and a metadata edit, the movements still account for the stock exactly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn movements_still_reconcile_to_quantity_on_hand_across_an_edit() {
    let db = shop().await;
    // The fixture seeds 10 as an opening balance with no movement behind it, so
    // reconcile against the CHANGE since then, which is what WP-02 asserts.
    crate::posting::post_adjustment_with_pool(
        db.pool(),
        crate::tests::builders::adjustment_payload(
            "recount",
            vec![crate::tests::builders::adjustment_line(P_EXISTING, 7)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(quantity_on_hand(&db, P_EXISTING).await, 17);
    assert_eq!(movement_sum(&db, P_EXISTING).await, 7);

    // Edit everything a metadata edit may touch.
    let mut payload = update_payload("Coffee 250g — new label");
    payload.description = Some("Rebranded".to_string());
    payload.price_excl_vat_cents = 500;
    payload.price_incl_vat_cents = 555;
    payload.reorder_point = Some(6);
    payload.is_active = false;
    save_product_with_pool(db.pool(), payload)
        .await
        .expect("the edit must save");

    assert_eq!(quantity_on_hand(&db, P_EXISTING).await, 17, "untouched by the edit");
    assert_eq!(
        movement_sum(&db, P_EXISTING).await,
        7,
        "and SUM(quantity_delta) still accounts for every change since the opening balance"
    );
}

/// A create starts a product at nothing on hand and no cost basis, whatever the
/// caller is holding — there is no field on the payload for either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_created_product_starts_at_zero_stock_and_zero_cost() {
    let db = shop().await;
    save_product_with_pool(db.pool(), create_payload(P_NEW, "SKU-E1", "Latte"))
        .await
        .unwrap();

    assert_eq!(quantity_on_hand(&db, P_NEW).await, 0);
    assert_eq!(avg_cost_excl_microcents(&db, P_NEW).await, 0);
    assert_eq!(avg_cost_incl_microcents(&db, P_NEW).await, 0);
    assert_eq!(
        db.scalar_i64(&format!(
            "SELECT avg_cost_excl_vat_cents + avg_cost_incl_vat_cents
               FROM products WHERE id = '{P_NEW}'"
        ))
        .await,
        0,
        "both cents mirrors too"
    );
}
