// Payload builders for the posting tests.
//
// These mirror how the frontend assembles payloads (lib/saleMath.ts and
// lib/purchaseMath.ts): line totals are unit price × quantity-in-UoM, and VAT
// is the difference between the incl- and excl-VAT totals. Tests still assert
// against explicit expected numbers; the builders only remove boilerplate.

use crate::posting::{
    PostAdjustmentLine, PostAdjustmentPayload, PostPurchaseLine, PostPurchasePayload,
    PostSaleLine, PostSalePayload, PostSalePayment, PostSupplierPaymentPayload,
};
use crate::test_support::{RATE_ID, RATE_LBP_PER_USD, STORE_ID, USER_ID, VAT_STD_BPS, VAT_STD_ID};

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// net = round(gross * 10000 / (10000 + bps)) — the same decomposition
/// `lib/vat.ts::stripVat` performs.
pub fn strip_vat(gross: i64, bps: i64) -> i64 {
    ((gross * 10000) as f64 / (10000 + bps) as f64).round() as i64
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
/// like `lib/money.ts::lbpToUsdCents`.
pub fn cash_lbp(lbp: i64) -> PostSalePayment {
    PostSalePayment {
        payment_id: uuid(),
        method: "cash_lbp".to_string(),
        currency: "LBP".to_string(),
        amount_native_usd_cents: 0,
        amount_native_lbp: lbp,
        amount_usd_cents_equivalent: ((lbp * 100) as f64 / RATE_LBP_PER_USD as f64).round() as i64,
        reference: None,
    }
}

pub fn sale_payload(lines: Vec<PostSaleLine>, payments: Vec<PostSalePayment>) -> PostSalePayload {
    PostSalePayload {
        sale_id: uuid(),
        store_id: STORE_ID.to_string(),
        cashier_user_id: Some(USER_ID.to_string()),
        device_id: None,
        shift_id: None,
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

// ============================================================================
// Purchase
// ============================================================================

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

    pub fn vat(mut self, rate_id: &str, bps: i64) -> Self {
        self.line.vat_rate_id_snapshot = rate_id.to_string();
        self.line.vat_rate_bps_snapshot = bps;
        self
    }

    /// Per-UoM cost excluding VAT. Base cost is derived exactly as
    /// `lib/uom.ts::unitCostInUomToBase` does: round(cost × den ÷ num).
    pub fn unit_cost_excl(mut self, excl_per_uom: i64) -> Self {
        let bps = self.line.vat_rate_bps_snapshot;
        let incl_per_uom = excl_per_uom + ((excl_per_uom * bps) as f64 / 10000.0).round() as i64;
        self.line.unit_cost_excl_vat_in_uom_cents = excl_per_uom;
        self.line.unit_cost_incl_vat_in_uom_cents = incl_per_uom;
        let (num, den) = (self.line.factor_num_snapshot, self.line.factor_den_snapshot);
        self.line.unit_cost_excl_vat_base_cents =
            ((excl_per_uom * den) as f64 / num as f64).round() as i64;
        self.line.unit_cost_incl_vat_base_cents =
            ((incl_per_uom * den) as f64 / num as f64).round() as i64;
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
        amount_cents,
        entry_date: "2026-02-02".to_string(),
        payment_reference: None,
        notes: Some("test entry".to_string()),
        created_by_user_id: Some(USER_ID.to_string()),
        device_id: None,
    }
}
