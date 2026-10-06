// Payload builders for the posting tests.
//
// These mirror how the frontend assembles payloads (lib/saleMath.ts and
// lib/purchaseMath.ts): line totals are unit price × quantity-in-UoM, and VAT
// is the difference between the incl- and excl-VAT totals. Tests still assert
// against explicit expected numbers; the builders only remove boilerplate.

use crate::posting::{
    add_vat, lbp_to_usd_cents, PostAdjustmentLine, PostAdjustmentPayload, PostCreditMemoLine,
    PostCreditMemoPayload, PostCreditMemoRefund, PostPurchaseLine, PostPurchasePayload,
    PostSaleLine, PostSalePayload, PostSalePayment, PostSupplierPaymentPayload,
};
use crate::test_support::{
    TempDb, RATE_ID, RATE_LBP_PER_USD, SHIFT_ID, STORE_ID, USER_ID, VAT_STD_BPS, VAT_STD_ID,
};

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// net = round(gross x 10000 / (10000 + bps)) — the decomposition
/// `lib/vat.ts::stripVat` performs.
///
/// Delegates to the PRODUCTION helper rather than reimplementing it in f64.
/// Since the WP-05 correction the backend derives one side of every purchase
/// line's cost pair with this exact rule and refuses a pair that disagrees, so
/// a fixture rounding its own way would look like a crafted price rather than a
/// legitimate invoice. `pure.rs` pins the rule itself to explicit figures.
pub fn strip_vat(gross: i64, bps: i64) -> i64 {
    crate::posting::strip_vat(gross, bps).expect("fixture amount must decompose")
}

// ============================================================================
// Sale
// ============================================================================

pub struct SaleLineBuilder {
    line: PostSaleLine,
}

impl SaleLineBuilder {
    /// A one-unit, VAT-standard, base-UoM ("each", 1/1) line.
    pub fn new(product_id: &str, name: &str) -> Self {
        Self {
            line: PostSaleLine {
                sale_item_id: uuid(),
                product_id: product_id.to_string(),
                product_name_snapshot: name.to_string(),
                product_sku_snapshot: None,
                uom_code_snapshot: "each".to_string(),
                factor_num_snapshot: 1,
                factor_den_snapshot: 1,
                quantity_in_uom: 1,
                quantity_base: 1,
                unit_price_excl_vat_cents: 0,
                unit_price_incl_vat_cents: 0,
                vat_rate_id_snapshot: VAT_STD_ID.to_string(),
                vat_rate_bps_snapshot: VAT_STD_BPS,
                line_subtotal_excl_vat_cents: 0,
                line_vat_cents: 0,
                line_total_incl_vat_cents: 0,
                line_discount_cents: 0,
                barcode_used_snapshot: None,
                barcode_type_snapshot: None,
                is_service: false,
            },
        }
    }

    /// Quantity in the line's UoM; base quantity follows the factor.
    pub fn qty(mut self, qty_in_uom: i64) -> Self {
        self.line.quantity_in_uom = qty_in_uom;
        self.line.quantity_base =
            qty_in_uom * self.line.factor_num_snapshot / self.line.factor_den_snapshot;
        self
    }

    pub fn uom(mut self, code: &str, num: i64, den: i64) -> Self {
        self.line.uom_code_snapshot = code.to_string();
        self.line.factor_num_snapshot = num;
        self.line.factor_den_snapshot = den;
        self.line.quantity_base = self.line.quantity_in_uom * num / den;
        self
    }

    /// Set the VAT-inclusive unit price; the excl-VAT price is decomposed.
    pub fn unit_incl(mut self, incl: i64) -> Self {
        self.line.unit_price_incl_vat_cents = incl;
        self.line.unit_price_excl_vat_cents = strip_vat(incl, self.line.vat_rate_bps_snapshot);
        self
    }

    pub fn unit_prices(mut self, excl: i64, incl: i64) -> Self {
        self.line.unit_price_excl_vat_cents = excl;
        self.line.unit_price_incl_vat_cents = incl;
        self
    }

    pub fn vat(mut self, rate_id: &str, bps: i64) -> Self {
        self.line.vat_rate_id_snapshot = rate_id.to_string();
        self.line.vat_rate_bps_snapshot = bps;
        self
    }

    pub fn service(mut self, is_service: bool) -> Self {
        self.line.is_service = is_service;
        self
    }

    pub fn discount(mut self, cents: i64) -> Self {
        self.line.line_discount_cents = cents;
        self
    }

    /// Override the base quantity independently of the factor. Used only by the
    /// GP-A02 characterization test.
    pub fn raw_quantity_base(mut self, base: i64) -> Self {
        self.line.quantity_base = base;
        self
    }

    /// Override the computed line totals. Used only by the GP-A06 test.
    pub fn raw_line_totals(mut self, subtotal: i64, vat: i64, total: i64) -> Self {
        let mut line = self.finish_totals();
        line.line_subtotal_excl_vat_cents = subtotal;
        line.line_vat_cents = vat;
        line.line_total_incl_vat_cents = total;
        self.line = line;
        self
    }

    fn finish_totals(&self) -> PostSaleLine {
        let qty = self.line.quantity_in_uom;
        let subtotal = self.line.unit_price_excl_vat_cents * qty;
        let total = self.line.unit_price_incl_vat_cents * qty;
        PostSaleLine {
            sale_item_id: self.line.sale_item_id.clone(),
            product_id: self.line.product_id.clone(),
            product_name_snapshot: self.line.product_name_snapshot.clone(),
            product_sku_snapshot: self.line.product_sku_snapshot.clone(),
            uom_code_snapshot: self.line.uom_code_snapshot.clone(),
            factor_num_snapshot: self.line.factor_num_snapshot,
            factor_den_snapshot: self.line.factor_den_snapshot,
            quantity_in_uom: qty,
            quantity_base: self.line.quantity_base,
            unit_price_excl_vat_cents: self.line.unit_price_excl_vat_cents,
            unit_price_incl_vat_cents: self.line.unit_price_incl_vat_cents,
            vat_rate_id_snapshot: self.line.vat_rate_id_snapshot.clone(),
            vat_rate_bps_snapshot: self.line.vat_rate_bps_snapshot,
            line_subtotal_excl_vat_cents: subtotal,
            line_vat_cents: total - subtotal,
            line_total_incl_vat_cents: total,
            line_discount_cents: self.line.line_discount_cents,
            barcode_used_snapshot: self.line.barcode_used_snapshot.clone(),
            barcode_type_snapshot: self.line.barcode_type_snapshot.clone(),
            is_service: self.line.is_service,
        }
    }

    pub fn build(self) -> PostSaleLine {
        // `raw_line_totals` already baked its values in; don't recompute.
        if self.line.line_total_incl_vat_cents != 0 {
            return self.line;
        }
        self.finish_totals()
    }
}

pub fn cash_usd(cents: i64) -> PostSalePayment {
    PostSalePayment {
        payment_id: uuid(),
        method: "cash_usd".to_string(),
        currency: "USD".to_string(),
        amount_native_usd_cents: cents,
        amount_native_lbp: 0,
        amount_usd_cents_equivalent: cents,
        reference: None,
    }
}

pub fn card_usd(cents: i64) -> PostSalePayment {
    PostSalePayment {
        payment_id: uuid(),
        method: "card_usd".to_string(),
        currency: "USD".to_string(),
        amount_native_usd_cents: cents,
        amount_native_lbp: 0,
        amount_usd_cents_equivalent: cents,
        reference: None,
    }
}

/// An LBP cash tender. The USD-cent equivalent uses the locked rate, exactly
/// like `lib/money.ts::lbpToUsdCents` and `posting::lbp_to_usd_cents` — in
/// integer arithmetic, because since WP-04 the backend derives this value and
/// refuses a payload that declares a different one. A fixture that rounded its
/// own way would look like a corrupt tender rather than a legitimate sale.
pub fn cash_lbp(lbp: i64) -> PostSalePayment {
    PostSalePayment {
        payment_id: uuid(),
        method: "cash_lbp".to_string(),
        currency: "LBP".to_string(),
        amount_native_usd_cents: 0,
        amount_native_lbp: lbp,
        amount_usd_cents_equivalent: lbp_to_usd_cents(lbp, RATE_LBP_PER_USD)
            .expect("fixture LBP tender must convert"),
        reference: None,
    }
}

/// A card tender in lira: non-cash, so it can never carry change.
pub fn card_lbp(lbp: i64) -> PostSalePayment {
    PostSalePayment {
        payment_id: uuid(),
        method: "card_lbp".to_string(),
        currency: "LBP".to_string(),
        amount_native_usd_cents: 0,
        amount_native_lbp: lbp,
        amount_usd_cents_equivalent: lbp_to_usd_cents(lbp, RATE_LBP_PER_USD)
            .expect("fixture LBP tender must convert"),
        reference: None,
    }
}

pub fn sale_payload(lines: Vec<PostSaleLine>, payments: Vec<PostSalePayment>) -> PostSalePayload {
    PostSalePayload {
        sale_id: uuid(),
        store_id: STORE_ID.to_string(),
        cashier_user_id: Some(USER_ID.to_string()),
        device_id: None,
        // A new sale must belong to an open shift of its store (WP-04), so the
        // default payload names the fixture shift. The test's database needs
        // `seed_open_shift`; a test that wants the "no shift" case clears this
        // field explicitly.
        shift_id: Some(SHIFT_ID.to_string()),
        exchange_rate_id: RATE_ID.to_string(),
        exchange_rate_lbp_per_usd: RATE_LBP_PER_USD,
        notes: None,
        cogs_method: "weighted_average".to_string(),
        discount_cents: 0,
        allow_negative_inventory: false,
        lines,
        payments,
    }
}

/// Total incl-VAT of a set of built lines — what the customer owes.
pub fn lines_total(lines: &[PostSaleLine]) -> i64 {
    lines.iter().map(|l| l.line_total_incl_vat_cents).sum()
}

/// A faithful replay of a sale payload: the same checkout identity, the same
/// line and payment identifiers, the same figures. This is what a retried
/// checkout sends — the cashier pressing Post twice, or the client resending
/// after an answer it never saw.
pub fn replay_of(p: &PostSalePayload) -> PostSalePayload {
    PostSalePayload {
        sale_id: p.sale_id.clone(),
        store_id: p.store_id.clone(),
        cashier_user_id: p.cashier_user_id.clone(),
        device_id: p.device_id.clone(),
        shift_id: p.shift_id.clone(),
        exchange_rate_id: p.exchange_rate_id.clone(),
        exchange_rate_lbp_per_usd: p.exchange_rate_lbp_per_usd,
        notes: p.notes.clone(),
        cogs_method: p.cogs_method.clone(),
        discount_cents: p.discount_cents,
        allow_negative_inventory: p.allow_negative_inventory,
        lines: p.lines.iter().map(clone_sale_line).collect(),
        payments: p.payments.iter().map(clone_sale_payment).collect(),
    }
}

/// `replay_of`, but with freshly minted sale-item and payment ids: the same
/// checkout identity carrying new child identifiers. Idempotency must key on
/// the sale identity alone, so this is still one checkout.
pub fn replay_of_with_new_child_ids(p: &PostSalePayload) -> PostSalePayload {
    let mut replay = replay_of(p);
    for line in &mut replay.lines {
        line.sale_item_id = uuid();
    }
    for payment in &mut replay.payments {
        payment.payment_id = uuid();
    }
    replay
}

pub fn clone_sale_line(l: &PostSaleLine) -> PostSaleLine {
    PostSaleLine {
        sale_item_id: l.sale_item_id.clone(),
        product_id: l.product_id.clone(),
        product_name_snapshot: l.product_name_snapshot.clone(),
        product_sku_snapshot: l.product_sku_snapshot.clone(),
        uom_code_snapshot: l.uom_code_snapshot.clone(),
        factor_num_snapshot: l.factor_num_snapshot,
        factor_den_snapshot: l.factor_den_snapshot,
        quantity_in_uom: l.quantity_in_uom,
        quantity_base: l.quantity_base,
        unit_price_excl_vat_cents: l.unit_price_excl_vat_cents,
        unit_price_incl_vat_cents: l.unit_price_incl_vat_cents,
        vat_rate_id_snapshot: l.vat_rate_id_snapshot.clone(),
        vat_rate_bps_snapshot: l.vat_rate_bps_snapshot,
        line_subtotal_excl_vat_cents: l.line_subtotal_excl_vat_cents,
        line_vat_cents: l.line_vat_cents,
        line_total_incl_vat_cents: l.line_total_incl_vat_cents,
        line_discount_cents: l.line_discount_cents,
        barcode_used_snapshot: l.barcode_used_snapshot.clone(),
        barcode_type_snapshot: l.barcode_type_snapshot.clone(),
        is_service: l.is_service,
    }
}

pub fn clone_sale_payment(p: &PostSalePayment) -> PostSalePayment {
    PostSalePayment {
        payment_id: p.payment_id.clone(),
        method: p.method.clone(),
        currency: p.currency.clone(),
        amount_native_usd_cents: p.amount_native_usd_cents,
        amount_native_lbp: p.amount_native_lbp,
        amount_usd_cents_equivalent: p.amount_usd_cents_equivalent,
        reference: p.reference.clone(),
    }
}


/// Write a POSTED sale directly, with a NULL `shift_id`, the way a release
/// BEFORE WP-04 wrote one.
///
/// This cannot go through `post_sale_with_pool`: an unattributed new sale is
/// exactly what that command now refuses, so the only way to produce the
/// historical row the replay path has to keep honouring is to insert it. The
/// columns written are the ones the canonical replay comparison reads, with the
/// same values the payload carries, so a faithful replay of `payload` compares
/// equal and anything materially different does not.
///
/// Stock is decremented and a movement written, as the original post would
/// have, so "the replay did not decrement again" is an assertion with teeth.
/// COGS is left at zero: WP-02 deliberately excludes it from replay equality
/// (it is re-read from product cost at post time), so it is not part of what
/// this fixture has to reproduce.
///
/// It builds a DRAFT and promotes it at the end, because since migration 012 a
/// posted sale takes no further children — so inserting a posted header and
/// then its lines would be a shortcut the production command cannot take
/// either. The committed row state is identical; only the order differs, which
/// is exactly the order `post_sale` itself uses since WP-07.
pub async fn seed_posted_sale_without_shift(db: &TempDb, payload: &PostSalePayload) {
    let subtotal: i64 = payload.lines.iter().map(|l| l.line_subtotal_excl_vat_cents).sum();
    let vat_total: i64 = payload.lines.iter().map(|l| l.line_vat_cents).sum();
    let total: i64 = payload.lines.iter().map(|l| l.line_total_incl_vat_cents).sum();
    let posted_at = "2026-01-01T09:00:00.000Z";

    sqlx::query(
        "INSERT INTO sales (
           id, store_id, shift_id, device_id, cashier_user_id, receipt_number,
           exchange_rate_lbp_per_usd, exchange_rate_id,
           subtotal_excl_vat_cents, vat_total_cents, total_incl_vat_cents,
           discount_cents, cogs_total_cents, cogs_method,
           sale_type, status, posted_at, notes
         ) VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, 'normal', 'draft', NULL, ?)",
    )
    .bind(&payload.sale_id)
    .bind(&payload.store_id)
    .bind(&payload.device_id)
    .bind(&payload.cashier_user_id)
    .bind(payload.exchange_rate_lbp_per_usd)
    .bind(&payload.exchange_rate_id)
    .bind(subtotal)
    .bind(vat_total)
    .bind(total)
    .bind(payload.discount_cents)
    .bind(&payload.cogs_method)
    .bind(&payload.notes)
    .execute(db.pool())
    .await
    .expect("seed historical sale header");

    for line in &payload.lines {
        sqlx::query(
            "INSERT INTO sale_items (
               id, sale_id, store_id, product_id,
               product_name_snapshot, product_sku_snapshot,
               vat_rate_id_snapshot, vat_rate_bps_snapshot,
               quantity, unit_price_excl_vat_cents, unit_price_incl_vat_cents,
               line_subtotal_excl_vat_cents, line_vat_cents, line_total_incl_vat_cents,
               line_discount_cents,
               unit_cogs_excl_vat_cents, line_cogs_excl_vat_cents,
               unit_cogs_excl_vat_microcents,
               quantity_in_uom, uom_code_snapshot, factor_num_snapshot, factor_den_snapshot
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)",
        )
        .bind(&line.sale_item_id)
        .bind(&payload.sale_id)
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(&line.product_name_snapshot)
        .bind(&line.product_sku_snapshot)
        .bind(&line.vat_rate_id_snapshot)
        .bind(line.vat_rate_bps_snapshot)
        .bind(line.quantity_base)
        .bind(line.unit_price_excl_vat_cents)
        .bind(line.unit_price_incl_vat_cents)
        .bind(line.line_subtotal_excl_vat_cents)
        .bind(line.line_vat_cents)
        .bind(line.line_total_incl_vat_cents)
        .bind(line.line_discount_cents)
        .bind(line.quantity_in_uom)
        .bind(&line.uom_code_snapshot)
        .bind(line.factor_num_snapshot)
        .bind(line.factor_den_snapshot)
        .execute(db.pool())
        .await
        .expect("seed historical sale item");

        sqlx::query(
            "INSERT INTO inventory_movements (
               id, store_id, product_id, movement_type, quantity_delta,
               unit_cost_excl_vat_cents, unit_cost_incl_vat_cents,
               unit_cost_excl_vat_microcents, unit_cost_incl_vat_microcents,
               related_sale_id, related_sale_item_id,
               created_by_user_id, posted_at
             ) VALUES (?, ?, ?, 'sale', ?, 0, 0, 0, 0, ?, ?, ?, ?)",
        )
        .bind(uuid())
        .bind(&payload.store_id)
        .bind(&line.product_id)
        .bind(-line.quantity_base)
        .bind(&payload.sale_id)
        .bind(&line.sale_item_id)
        .bind(&payload.cashier_user_id)
        .bind(posted_at)
        .execute(db.pool())
        .await
        .expect("seed historical inventory movement");

        sqlx::query(
            "UPDATE products SET quantity_on_hand = quantity_on_hand - ?
              WHERE id = ? AND store_id = ?",
        )
        .bind(line.quantity_base)
        .bind(&line.product_id)
        .bind(&payload.store_id)
        .execute(db.pool())
        .await
        .expect("decrement stock for the historical sale");
    }

    // Change on the first cash row, exactly where the old command put it.
    let tendered: i64 = payload.payments.iter().map(|p| p.amount_usd_cents_equivalent).sum();
    let change_row = payload
        .payments
        .iter()
        .position(|p| p.method == "cash_usd")
        .or_else(|| payload.payments.iter().position(|p| p.method == "cash_lbp"));

    for (i, p) in payload.payments.iter().enumerate() {
        let change_usd = if Some(i) == change_row && p.currency == "USD" {
            tendered - total
        } else {
            0
        };
        sqlx::query(
            "INSERT INTO sale_payments (
               id, sale_id, store_id, method, currency,
               amount_native_usd_cents, amount_native_lbp, amount_usd_cents_equivalent,
               change_given_usd_cents, change_given_lbp, reference
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
        )
        .bind(&p.payment_id)
        .bind(&payload.sale_id)
        .bind(&payload.store_id)
        .bind(&p.method)
        .bind(&p.currency)
        .bind(p.amount_native_usd_cents)
        .bind(p.amount_native_lbp)
        .bind(p.amount_usd_cents_equivalent)
        .bind(change_usd)
        .bind(&p.reference)
        .execute(db.pool())
        .await
        .expect("seed historical sale payment");
    }

    // Seal it, exactly as `post_sale`'s last statement does.
    sqlx::query("UPDATE sales SET status = 'posted', posted_at = ? WHERE id = ?")
        .bind(posted_at)
        .bind(&payload.sale_id)
        .execute(db.pool())
        .await
        .expect("promote the historical sale");

    // The sequence has been consumed by receipt #1, as it would have been.
    sqlx::query("UPDATE app_settings SET value = '2' WHERE key = 'next_receipt_number'")
        .execute(db.pool())
        .await
        .expect("advance the receipt sequence past the historical sale");
}

// ============================================================================
// Purchase
// ============================================================================

/// `round(qty x num / den)`, half away from zero — what `lib/uom.ts::toBaseQty`
/// computes on the client and what `posting::derive_base_quantity` derives on
/// the server. The builder uses it so a legitimate line never looks like a
/// mismatch merely because the harness rounded differently.
fn base_qty(qty_in_uom: i64, num: i64, den: i64) -> i64 {
    (qty_in_uom * num + den / 2) / den
}

pub struct PurchaseLineBuilder {
    line: PostPurchaseLine,
}

impl PurchaseLineBuilder {
    pub fn new(product_id: &str, name: &str) -> Self {
        Self {
            line: PostPurchaseLine {
                purchase_item_id: uuid(),
                product_id: product_id.to_string(),
                product_name_snapshot: name.to_string(),
                product_sku_snapshot: None,
                product_uom_id_snapshot: None,
                uom_code_snapshot: "each".to_string(),
                factor_num_snapshot: 1,
                factor_den_snapshot: 1,
                quantity_in_uom: 1,
                quantity_base: 1,
                // The fixtures state the NET invoice price (`unit_cost_excl`),
                // so the default mode is the one that makes that figure the
                // authoritative one.
                vat_pricing_mode: Some("exclusive".to_string()),
                unit_cost_excl_vat_in_uom_cents: 0,
                unit_cost_incl_vat_in_uom_cents: 0,
                unit_cost_excl_vat_base_cents: 0,
                unit_cost_incl_vat_base_cents: 0,
                vat_rate_id_snapshot: VAT_STD_ID.to_string(),
                vat_rate_bps_snapshot: VAT_STD_BPS,
                line_subtotal_excl_vat_cents: 0,
                line_vat_cents: 0,
                line_total_incl_vat_cents: 0,
            },
        }
    }

    pub fn qty(mut self, qty_in_uom: i64) -> Self {
        self.line.quantity_in_uom = qty_in_uom;
        self.line.quantity_base = base_qty(
            qty_in_uom,
            self.line.factor_num_snapshot,
            self.line.factor_den_snapshot,
        );
        self
    }

    pub fn uom(mut self, code: &str, num: i64, den: i64) -> Self {
        self.line.uom_code_snapshot = code.to_string();
        self.line.factor_num_snapshot = num;
        self.line.factor_den_snapshot = den;
        self.line.quantity_base = base_qty(self.line.quantity_in_uom, num, den);
        self
    }

    /// Name a specific `product_uoms` row, the way the Purchases page does
    /// (`productUomIdSnapshot`). `post_purchase` cross-checks it against the row
    /// it resolves from `uom_code`.
    pub fn product_uom_id(mut self, id: &str) -> Self {
        self.line.product_uom_id_snapshot = Some(id.to_string());
        self
    }

    /// Override the declared base quantity independently of the factor — a stale
    /// or buggy client. Used only by the purchase-authority tests.
    pub fn raw_quantity_base(mut self, base: i64) -> Self {
        self.line.quantity_base = base;
        self
    }

    /// Declare a conversion factor that disagrees with the product's own, while
    /// leaving the derived base quantity consistent with the DECLARED factor —
    /// i.e. a client that is internally coherent but wrong about the product.
    /// Used only by the purchase-authority tests.
    pub fn raw_factor_snapshot(mut self, num: i64, den: i64) -> Self {
        self.line.factor_num_snapshot = num;
        self.line.factor_den_snapshot = den;
        self.line.quantity_base = base_qty(self.line.quantity_in_uom, num, den);
        self
    }

    pub fn vat(mut self, rate_id: &str, bps: i64) -> Self {
        self.line.vat_rate_id_snapshot = rate_id.to_string();
        self.line.vat_rate_bps_snapshot = bps;
        self
    }

    /// Per-UoM cost excluding VAT — i.e. an invoice that quotes the NET price,
    /// which is what `vat_pricing_mode = "exclusive"` declares. The gross
    /// counterpart is derived with the production `add_vat`, the same rule
    /// `post_purchase` now derives and cross-checks it with.
    ///
    /// Base cost is derived exactly as `lib/uom.ts::unitCostInUomToBase` does:
    /// round(cost × den ÷ num).
    pub fn unit_cost_excl(mut self, excl_per_uom: i64) -> Self {
        let bps = self.line.vat_rate_bps_snapshot;
        let incl_per_uom = add_vat(excl_per_uom, bps).expect("fixture cost must take VAT");
        self.line.vat_pricing_mode = Some("exclusive".to_string());
        self.line.unit_cost_excl_vat_in_uom_cents = excl_per_uom;
        self.line.unit_cost_incl_vat_in_uom_cents = incl_per_uom;
        let (num, den) = (self.line.factor_num_snapshot, self.line.factor_den_snapshot);
        self.line.unit_cost_excl_vat_base_cents =
            ((excl_per_uom * den) as f64 / num as f64).round() as i64;
        self.line.unit_cost_incl_vat_base_cents =
            ((incl_per_uom * den) as f64 / num as f64).round() as i64;
        self
    }

    /// Per-UoM cost INCLUDING VAT — an invoice that quotes the gross price,
    /// which is what `vat_pricing_mode = "inclusive"` declares. The net
    /// counterpart is stripped with the production rule.
    pub fn unit_cost_incl(mut self, incl_per_uom: i64) -> Self {
        let bps = self.line.vat_rate_bps_snapshot;
        let excl_per_uom = strip_vat(incl_per_uom, bps);
        self.line.vat_pricing_mode = Some("inclusive".to_string());
        self.line.unit_cost_incl_vat_in_uom_cents = incl_per_uom;
        self.line.unit_cost_excl_vat_in_uom_cents = excl_per_uom;
        let (num, den) = (self.line.factor_num_snapshot, self.line.factor_den_snapshot);
        self.line.unit_cost_excl_vat_base_cents =
            ((excl_per_uom * den) as f64 / num as f64).round() as i64;
        self.line.unit_cost_incl_vat_base_cents =
            ((incl_per_uom * den) as f64 / num as f64).round() as i64;
        self
    }

    /// Declare a pricing mode that is not the one the cost was stated in, or
    /// nothing at all (`None`, the pre-WP-05 wire shape, which makes
    /// `post_purchase` fall back to the product's own mode). Used only by the
    /// VAT-pair tests.
    pub fn raw_pricing_mode(mut self, mode: Option<&str>) -> Self {
        self.line.vat_pricing_mode = mode.map(|m| m.to_string());
        self
    }

    /// Replace ONE side of the cost pair, leaving the other and the line totals
    /// consistent with the REPLACED figure — i.e. a client that is internally
    /// coherent about a price it invented. This is the crafted line the WP-05
    /// release-gate review found: two unit costs that are not one price.
    ///
    /// `build()` extends whichever pair is in place, so the resulting line's
    /// declared totals still reconcile against its own (incoherent) costs and
    /// the only thing that can catch it is the VAT relationship.
    pub fn raw_unit_costs(mut self, excl_per_uom: i64, incl_per_uom: i64) -> Self {
        self.line.unit_cost_excl_vat_in_uom_cents = excl_per_uom;
        self.line.unit_cost_incl_vat_in_uom_cents = incl_per_uom;
        self
    }

    pub fn build(self) -> PostPurchaseLine {
        let qty = self.line.quantity_in_uom;
        let subtotal = self.line.unit_cost_excl_vat_in_uom_cents * qty;
        let total = self.line.unit_cost_incl_vat_in_uom_cents * qty;
        PostPurchaseLine {
            line_subtotal_excl_vat_cents: subtotal,
            line_vat_cents: total - subtotal,
            line_total_incl_vat_cents: total,
            ..self.line
        }
    }
}

pub fn purchase_payload(
    purchase_type: &str,
    supplier_id: Option<&str>,
    lines: Vec<PostPurchaseLine>,
) -> PostPurchasePayload {
    PostPurchasePayload {
        purchase_id: uuid(),
        store_id: STORE_ID.to_string(),
        supplier_id: supplier_id.map(|s| s.to_string()),
        purchase_type: purchase_type.to_string(),
        supplier_reference: None,
        purchase_date: "2026-02-01".to_string(),
        created_by_user_id: Some(USER_ID.to_string()),
        device_id: None,
        notes: None,
        lines,
    }
}

/// `purchase_payload`, quoting a supplier invoice reference — the field the
/// duplicate-invoice rule is scoped on.
pub fn purchase_payload_with_reference(
    purchase_type: &str,
    supplier_id: Option<&str>,
    reference: Option<&str>,
    lines: Vec<PostPurchaseLine>,
) -> PostPurchasePayload {
    PostPurchasePayload {
        supplier_reference: reference.map(|r| r.to_string()),
        ..purchase_payload(purchase_type, supplier_id, lines)
    }
}

/// A faithful replay of a purchase payload: the same document identity, the
/// same lines, the same figures — but freshly minted `purchase_item_id`s,
/// because that is what the Purchases page and `purchasesRepo.post` actually
/// send on a retry. Idempotency must key on the purchase identity alone.
pub fn replay_of_purchase(p: &PostPurchasePayload) -> PostPurchasePayload {
    PostPurchasePayload {
        purchase_id: p.purchase_id.clone(),
        store_id: p.store_id.clone(),
        supplier_id: p.supplier_id.clone(),
        purchase_type: p.purchase_type.clone(),
        supplier_reference: p.supplier_reference.clone(),
        purchase_date: p.purchase_date.clone(),
        created_by_user_id: p.created_by_user_id.clone(),
        device_id: p.device_id.clone(),
        notes: p.notes.clone(),
        lines: p.lines.iter().map(clone_purchase_line).collect(),
    }
}

pub fn clone_purchase_line(l: &PostPurchaseLine) -> PostPurchaseLine {
    PostPurchaseLine {
        // Fresh: a retry regenerates these.
        purchase_item_id: uuid(),
        product_id: l.product_id.clone(),
        product_name_snapshot: l.product_name_snapshot.clone(),
        product_sku_snapshot: l.product_sku_snapshot.clone(),
        product_uom_id_snapshot: l.product_uom_id_snapshot.clone(),
        uom_code_snapshot: l.uom_code_snapshot.clone(),
        factor_num_snapshot: l.factor_num_snapshot,
        factor_den_snapshot: l.factor_den_snapshot,
        quantity_in_uom: l.quantity_in_uom,
        quantity_base: l.quantity_base,
        vat_pricing_mode: l.vat_pricing_mode.clone(),
        unit_cost_excl_vat_in_uom_cents: l.unit_cost_excl_vat_in_uom_cents,
        unit_cost_incl_vat_in_uom_cents: l.unit_cost_incl_vat_in_uom_cents,
        unit_cost_excl_vat_base_cents: l.unit_cost_excl_vat_base_cents,
        unit_cost_incl_vat_base_cents: l.unit_cost_incl_vat_base_cents,
        vat_rate_id_snapshot: l.vat_rate_id_snapshot.clone(),
        vat_rate_bps_snapshot: l.vat_rate_bps_snapshot,
        line_subtotal_excl_vat_cents: l.line_subtotal_excl_vat_cents,
        line_vat_cents: l.line_vat_cents,
        line_total_incl_vat_cents: l.line_total_incl_vat_cents,
    }
}

// ============================================================================
// Adjustment / supplier payment
// ============================================================================

pub fn adjustment_payload(reason: &str, lines: Vec<PostAdjustmentLine>) -> PostAdjustmentPayload {
    PostAdjustmentPayload {
        store_id: STORE_ID.to_string(),
        created_by_user_id: Some(USER_ID.to_string()),
        device_id: None,
        reason: reason.to_string(),
        lines,
    }
}

pub fn adjustment_line(product_id: &str, delta_base: i64) -> PostAdjustmentLine {
    PostAdjustmentLine {
        movement_id: uuid(),
        product_id: product_id.to_string(),
        uom_code_snapshot: "each".to_string(),
        factor_num_snapshot: 1,
        factor_den_snapshot: 1,
        quantity_in_uom_signed: delta_base,
        quantity_base_signed: delta_base,
    }
}

/// A supplier-ledger entry payload, assembled the way
/// `db/repos/supplierLedger.ts::postEntry` assembles one: the positive
/// magnitude in `amountMagnitudeCents` and the legacy signed figure alongside
/// it. `amount_cents` is stated signed here because that is still the shape of
/// the wire and of every call site that predates WP-05.
pub fn supplier_payment_payload(
    supplier_id: &str,
    entry_type: &str,
    amount_cents: i64,
) -> PostSupplierPaymentPayload {
    PostSupplierPaymentPayload {
        ledger_entry_id: uuid(),
        store_id: STORE_ID.to_string(),
        supplier_id: supplier_id.to_string(),
        entry_type: entry_type.to_string(),
        amount_magnitude_cents: if amount_cents == 0 {
            None
        } else {
            Some(amount_cents.abs())
        },
        amount_cents,
        entry_date: "2026-02-02".to_string(),
        payment_reference: None,
        notes: Some("test entry".to_string()),
        created_by_user_id: Some(USER_ID.to_string()),
        device_id: None,
    }
}

/// The same entry, as a caller that only knows the OLD wire contract sends it:
/// a signed `amountCents` and no magnitude field at all. This is what proves
/// the compatibility path still works, and that its sign is not authoritative.
pub fn legacy_supplier_payment_payload(
    supplier_id: &str,
    entry_type: &str,
    signed_amount_cents: i64,
) -> PostSupplierPaymentPayload {
    PostSupplierPaymentPayload {
        amount_magnitude_cents: None,
        ..supplier_payment_payload(supplier_id, entry_type, signed_amount_cents)
    }
}

/// A faithful replay of a supplier-ledger entry: the same payment identity,
/// the same figures. What a retried payment sends after a lost answer.
pub fn replay_of_ledger_entry(p: &PostSupplierPaymentPayload) -> PostSupplierPaymentPayload {
    PostSupplierPaymentPayload {
        ledger_entry_id: p.ledger_entry_id.clone(),
        store_id: p.store_id.clone(),
        supplier_id: p.supplier_id.clone(),
        entry_type: p.entry_type.clone(),
        amount_magnitude_cents: p.amount_magnitude_cents,
        amount_cents: p.amount_cents,
        entry_date: p.entry_date.clone(),
        payment_reference: p.payment_reference.clone(),
        notes: p.notes.clone(),
        created_by_user_id: p.created_by_user_id.clone(),
        device_id: p.device_id.clone(),
    }
}

// ============================================================================
// Credit memo / sales return (WP-06)
// ============================================================================

/// One returned line. `quantity_in_uom` is the authoritative input, exactly as
/// it is on the wire; `quantity_base` is the client's cross-check and is
/// derived here with the same rounding the backend uses, so a legitimate line
/// never looks like a mismatch merely because the harness rounded differently.
pub struct ReturnLineBuilder {
    line: PostCreditMemoLine,
}

impl ReturnLineBuilder {
    /// Return one base unit of `sale_item_id`, back to the shelf.
    pub fn new(sale_item_id: &str) -> Self {
        Self {
            line: PostCreditMemoLine {
                credit_memo_line_id: uuid(),
                original_sale_item_id: sale_item_id.to_string(),
                quantity_in_uom: 1,
                quantity_base: 1,
                return_to_stock: true,
            },
        }
    }

    /// Quantity in the ORIGINAL line's unit of measure, with the base quantity
    /// following a `num/den` conversion (1/1 unless `uom` says otherwise).
    pub fn qty(mut self, qty_in_uom: i64) -> Self {
        self.line.quantity_in_uom = qty_in_uom;
        self.line.quantity_base = qty_in_uom;
        self
    }

    /// The original line was sold in a non-base UoM: restate the cross-check
    /// base quantity through that conversion.
    pub fn uom(mut self, num: i64, den: i64) -> Self {
        self.line.quantity_base = base_qty(self.line.quantity_in_uom, num, den);
        self
    }

    pub fn restock(mut self, restock: bool) -> Self {
        self.line.return_to_stock = restock;
        self
    }

    /// Override the declared base quantity independently of the conversion.
    /// Used only to prove the backend refuses a payload that contradicts the
    /// original line's own factor.
    pub fn raw_quantity_base(mut self, base: i64) -> Self {
        self.line.quantity_base = base;
        self
    }

    pub fn build(self) -> PostCreditMemoLine {
        self.line
    }
}

pub fn return_line(sale_item_id: &str) -> ReturnLineBuilder {
    ReturnLineBuilder::new(sale_item_id)
}

pub fn refund_cash_usd(cents: i64) -> PostCreditMemoRefund {
    PostCreditMemoRefund {
        refund_id: uuid(),
        method: "cash_usd".to_string(),
        currency: "USD".to_string(),
        amount_native_usd_cents: cents,
        amount_native_lbp: 0,
        amount_usd_cents_equivalent: cents,
        reference: None,
    }
}

pub fn refund_card_usd(cents: i64) -> PostCreditMemoRefund {
    PostCreditMemoRefund {
        refund_id: uuid(),
        method: "card_usd".to_string(),
        currency: "USD".to_string(),
        amount_native_usd_cents: cents,
        amount_native_lbp: 0,
        amount_usd_cents_equivalent: cents,
        reference: None,
    }
}

/// A refund in lira. The USD equivalent uses the fixture's locked rate through
/// the PRODUCTION helper, because the backend derives this value and refuses a
/// payload that declares a different one.
pub fn refund_cash_lbp(lbp: i64) -> PostCreditMemoRefund {
    PostCreditMemoRefund {
        refund_id: uuid(),
        method: "cash_lbp".to_string(),
        currency: "LBP".to_string(),
        amount_native_usd_cents: 0,
        amount_native_lbp: lbp,
        amount_usd_cents_equivalent: lbp_to_usd_cents(lbp, RATE_LBP_PER_USD)
            .expect("fixture LBP refund must convert"),
        reference: None,
    }
}

pub fn refund_card_lbp(lbp: i64) -> PostCreditMemoRefund {
    PostCreditMemoRefund {
        refund_id: uuid(),
        method: "card_lbp".to_string(),
        currency: "LBP".to_string(),
        amount_native_usd_cents: 0,
        amount_native_lbp: lbp,
        amount_usd_cents_equivalent: lbp_to_usd_cents(lbp, RATE_LBP_PER_USD)
            .expect("fixture LBP refund must convert"),
        reference: None,
    }
}

pub fn credit_memo_payload(
    original_sale_id: &str,
    lines: Vec<PostCreditMemoLine>,
    refunds: Vec<PostCreditMemoRefund>,
) -> PostCreditMemoPayload {
    PostCreditMemoPayload {
        credit_memo_id: uuid(),
        store_id: STORE_ID.to_string(),
        original_sale_id: original_sale_id.to_string(),
        // A new return must belong to an open shift of its store (WP-06,
        // following WP-04), so the default payload names the fixture shift. A
        // test that wants the "no shift" case clears this field explicitly.
        shift_id: Some(SHIFT_ID.to_string()),
        cashier_user_id: Some(USER_ID.to_string()),
        device_id: None,
        reason: Some("Customer changed their mind".to_string()),
        notes: None,
        // Left unstated on purpose: the backend locks the memo to the ORIGINAL
        // sale's rate. The tests that care send a declared value explicitly.
        exchange_rate_id: None,
        exchange_rate_lbp_per_usd: None,
        lines,
        refunds,
    }
}

/// A faithful replay: the same return identity, the same child identifiers, the
/// same figures. What a retried refund sends.
pub fn replay_of_credit_memo(p: &PostCreditMemoPayload) -> PostCreditMemoPayload {
    PostCreditMemoPayload {
        credit_memo_id: p.credit_memo_id.clone(),
        store_id: p.store_id.clone(),
        original_sale_id: p.original_sale_id.clone(),
        shift_id: p.shift_id.clone(),
        cashier_user_id: p.cashier_user_id.clone(),
        device_id: p.device_id.clone(),
        reason: p.reason.clone(),
        notes: p.notes.clone(),
        exchange_rate_id: p.exchange_rate_id.clone(),
        exchange_rate_lbp_per_usd: p.exchange_rate_lbp_per_usd,
        lines: p.lines.iter().map(clone_credit_memo_line).collect(),
        refunds: p.refunds.iter().map(clone_credit_memo_refund).collect(),
    }
}

/// `replay_of_credit_memo`, with freshly minted line and refund ids: the same
/// return identity carrying new child identifiers. Idempotency keys on the
/// return identity alone, so this is still one return.
pub fn replay_of_credit_memo_with_new_child_ids(
    p: &PostCreditMemoPayload,
) -> PostCreditMemoPayload {
    let mut replay = replay_of_credit_memo(p);
    for line in &mut replay.lines {
        line.credit_memo_line_id = uuid();
    }
    for refund in &mut replay.refunds {
        refund.refund_id = uuid();
    }
    replay
}

pub fn clone_credit_memo_line(l: &PostCreditMemoLine) -> PostCreditMemoLine {
    PostCreditMemoLine {
        credit_memo_line_id: l.credit_memo_line_id.clone(),
        original_sale_item_id: l.original_sale_item_id.clone(),
        quantity_in_uom: l.quantity_in_uom,
        quantity_base: l.quantity_base,
        return_to_stock: l.return_to_stock,
    }
}

pub fn clone_credit_memo_refund(r: &PostCreditMemoRefund) -> PostCreditMemoRefund {
    PostCreditMemoRefund {
        refund_id: r.refund_id.clone(),
        method: r.method.clone(),
        currency: r.currency.clone(),
        amount_native_usd_cents: r.amount_native_usd_cents,
        amount_native_lbp: r.amount_native_lbp,
        amount_usd_cents_equivalent: r.amount_usd_cents_equivalent,
        reference: r.reference.clone(),
    }
}

// ============================================================================
// Adjustment — UoM variants (WP-07)
// ============================================================================

/// An adjustment of `qty_in_uom_signed` in a NON-BASE unit of measure, with
/// the base delta derived the way `pages/Inventory.tsx::computeAdjLine` derives
/// it: `round(|qty| × num ÷ den)`, carrying the caller's sign.
///
/// Since WP-07 the backend resolves the product's own active `product_uoms`
/// row and derives the base delta from ITS factor, so a fixture that rounded
/// its own way would look like a crafted request rather than a legitimate
/// stock correction.
pub fn adjustment_line_in_uom(
    product_id: &str,
    uom_code: &str,
    num: i64,
    den: i64,
    qty_in_uom_signed: i64,
) -> PostAdjustmentLine {
    let magnitude = qty_in_uom_signed.abs();
    let base_magnitude = base_qty(magnitude, num, den);
    PostAdjustmentLine {
        movement_id: uuid(),
        product_id: product_id.to_string(),
        uom_code_snapshot: uom_code.to_string(),
        factor_num_snapshot: num,
        factor_den_snapshot: den,
        quantity_in_uom_signed: qty_in_uom_signed,
        quantity_base_signed: if qty_in_uom_signed < 0 {
            -base_magnitude
        } else {
            base_magnitude
        },
    }
}

/// Override an adjustment line's declared factor, leaving everything else
/// alone — a stale cart, an edited UoM, a hand-rolled integration.
pub fn with_raw_factor(mut line: PostAdjustmentLine, num: i64, den: i64) -> PostAdjustmentLine {
    line.factor_num_snapshot = num;
    line.factor_den_snapshot = den;
    line
}

/// Override an adjustment line's declared BASE delta independently of its
/// unit-of-measure quantity. This is the crafted request WP-07 exists for:
/// "−1 each" on the movement row, a far larger delta against the stock.
pub fn with_raw_base(mut line: PostAdjustmentLine, base_signed: i64) -> PostAdjustmentLine {
    line.quantity_base_signed = base_signed;
    line
}

/// Override the UoM code an adjustment line names, so a test can borrow
/// another product's unit or a retired one.
pub fn with_raw_uom_code(mut line: PostAdjustmentLine, uom_code: &str) -> PostAdjustmentLine {
    line.uom_code_snapshot = uom_code.to_string();
    line
}
