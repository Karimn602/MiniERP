/**
 * Domain types — the shape of data as the application sees it.
 *
 * These intentionally diverge from raw DB rows:
 *   - snake_case → camelCase
 *   - INTEGER 0/1 → boolean
 *   - TEXT NULL → string | null
 *   - composite factor → Factor object
 *
 * Repos do the translation in one place. Components never see raw rows.
 */

import type { Factor } from "../lib/uom";
import type { UsdCents } from "../lib/money";
import type { Microcents } from "../lib/cost";

// A note on COST fields (WP-03, GP-A03). Money is `UsdCents` everywhere. A UNIT
// COST is a rate, not an amount, and is `Microcents` (1 cent = 1,000,000) so a
// cost below one cent per base unit survives — flour at $2.50/kg stocked in
// grams is $0.0025/g. Where a `*Microcents` and a `*Cents` field sit side by
// side, the microcent one is the accounting value and the cents one is its
// rounded display mirror. Never compute from the mirror.

// ---------- VAT ----------

export interface VatRate {
  id: string;
  name: string;
  rateBps: number;
  isExempt: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

// ---------- Units of Measure ----------

export interface UnitOfMeasure {
  code: string;
  name: string;
  category: "count" | "weight" | "volume" | "length" | "other";
  symbol: string;
  isActive: boolean;
}

export interface ProductUom {
  id: string;
  productId: string;
  uomCode: string;
  factor: Factor;
  isBase: boolean;
  isDefaultSale: boolean;
  isDefaultPurchase: boolean;
  isActive: boolean;
  salePriceExclVatCents: UsdCents | null;
  salePriceInclVatCents: UsdCents | null;
}

// ---------- Products ----------

export type VatPricingMode = "inclusive" | "exclusive";

export interface Product {
  id: string;
  storeId: string;
  sku: string | null;
  name: string;
  description: string | null;
  vatRateId: string;
  vatPricingMode: VatPricingMode;
  priceExclVatCents: UsdCents;
  priceInclVatCents: UsdCents;
  avgCostExclVatMicrocents: Microcents;
  avgCostInclVatMicrocents: Microcents;
  /** Rounded mirror of the two above. Display only. */
  avgCostExclVatCents: UsdCents;
  avgCostInclVatCents: UsdCents;
  quantityOnHand: number;
  reorderPoint: number | null;
  isActive: boolean;
  isService: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductWithUoms extends Product {
  uoms: ProductUom[];
  baseUom: ProductUom;
  defaultSaleUom: ProductUom;
  primaryBarcode: ProductBarcode | null;
  vatRate: VatRate;
}

// ---------- Barcodes ----------

export type BarcodeType =
  | "EAN13"
  | "EAN8"
  | "UPC_A"
  | "UPC_E"
  | "INTERNAL"
  | "SUPPLIER"
  | "OTHER";

export interface ProductBarcode {
  id: string;
  storeId: string;
  productId: string;
  barcode: string;
  lookupValue: string;
  barcodeType: BarcodeType;
  isPrimary: boolean;
  isActive: boolean;
  productUomId: string | null;
}

export interface BarcodeScanResult {
  product: ProductWithUoms;
  resolvedUom: ProductUom;
  matchedBarcode: ProductBarcode;
}

// ---------- Exchange Rates ----------

export interface ExchangeRate {
  id: string;
  storeId: string;
  effectiveDate: string;
  rateLbpPerUsd: number;
  source: "manual" | "api" | "imported";
  notes: string | null;
  createdAt: string;
}

// ---------- Suppliers ----------

export interface Supplier {
  id: string;
  storeId: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------- Purchases ----------

export type PurchaseStatus = "draft" | "posted" | "voided";
export type PurchaseType = "normal" | "opening";

export interface Purchase {
  id: string;
  storeId: string;
  supplierId: string | null;
  purchaseType: PurchaseType;
  supplierReference: string | null;
  purchaseNumber: number;
  purchaseDate: string;
  subtotalExclVatCents: UsdCents;
  vatTotalCents: UsdCents;
  totalInclVatCents: UsdCents;
  status: PurchaseStatus;
  createdByUserId: string | null;
  deviceId: string | null;
  createdAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  notes: string | null;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  storeId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  productUomIdSnapshot: string | null;
  uomCodeSnapshot: string;
  factorNumSnapshot: number;
  factorDenSnapshot: number;
  quantityInUom: number;
  quantityBase: number;
  unitCostExclVatInUomCents: UsdCents;
  unitCostInclVatInUomCents: UsdCents;
  unitCostExclVatBaseMicrocents: Microcents;
  unitCostInclVatBaseMicrocents: Microcents;
  /** Rounded mirror of the two above. Display only. */
  unitCostExclVatBaseCents: UsdCents;
  unitCostInclVatBaseCents: UsdCents;
  vatRateIdSnapshot: string;
  vatRateBpsSnapshot: number;
  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
  relatedMovementId: string | null;
}

export interface PurchaseWithLines extends Purchase {
  lines: PurchaseItem[];
  supplier: Supplier | null;
}

// ---------- Inventory movements ----------

export type MovementType =
  | "purchase"
  | "sale"
  | "return_in"
  | "return_out"
  | "adjustment"
  | "transfer_in"
  | "transfer_out"
  | "opening";

export interface InventoryMovement {
  id: string;
  storeId: string;
  productId: string;
  movementType: MovementType;
  quantityDelta: number;
  unitCostExclVatMicrocents: Microcents;
  unitCostInclVatMicrocents: Microcents;
  /** Rounded mirror of the two above. Display only. */
  unitCostExclVatCents: UsdCents;
  unitCostInclVatCents: UsdCents;
  relatedSaleId: string | null;
  relatedSaleItemId: string | null;
  relatedPurchaseId: string | null;
  relatedPurchaseItemId: string | null;
  supplierReference: string | null;
  notes: string | null;
  createdByUserId: string | null;
  deviceId: string | null;
  postedAt: string;
  quantityInUom: number | null;
  uomCodeSnapshot: string | null;
  factorNumSnapshot: number | null;
  factorDenSnapshot: number | null;
}

// ---------- Supplier ledger ----------

export type SupplierLedgerEntryType =
  | "purchase"
  | "payment"
  | "credit_note"
  | "opening_balance"
  | "adjustment";

export type LedgerEntryType = SupplierLedgerEntryType;

export interface SupplierLedgerEntry {
  id: string;
  storeId: string;
  supplierId: string;
  entryDate: string;
  entryType: SupplierLedgerEntryType;
  amountSignedCents: UsdCents;
  relatedPurchaseId: string | null;
  relatedPaymentId: string | null;
  notes: string | null;
  createdByUserId: string | null;
  deviceId: string | null;
  createdAt: string;
  postedAt: string;
}

export interface SupplierWithBalance extends Supplier {
  balanceCents: UsdCents;
  lastActivityAt: string | null;
}

// ---------- Sales ----------

export type SaleStatus = "draft" | "posted" | "voided";
export type SaleType = "normal" | "credit_memo";
export type CogsMethod = "weighted_average" | "last_purchase";

export type PaymentMethod =
  | "cash_usd"
  | "cash_lbp"
  | "card_usd"
  | "card_lbp"
  | "bank_transfer"
  | "wallet"
  | "store_credit"
  | "other";

export type PaymentCurrency = "USD" | "LBP";

export interface Sale {
  id: string;
  storeId: string;
  shiftId: string | null;
  deviceId: string | null;
  cashierUserId: string | null;
  receiptNumber: number;
  exchangeRateLbpPerUsd: number;
  exchangeRateId: string | null;
  subtotalExclVatCents: UsdCents;
  vatTotalCents: UsdCents;
  totalInclVatCents: UsdCents;
  discountCents: UsdCents;
  cogsTotalCents: UsdCents;
  cogsMethod: CogsMethod;
  saleType: SaleType;
  originalSaleId: string | null;
  status: SaleStatus;
  createdAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  notes: string | null;
}

export interface SaleItem {
  id: string;
  saleId: string;
  storeId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  vatRateIdSnapshot: string;
  vatRateBpsSnapshot: number;
  quantity: number;
  unitPriceExclVatCents: UsdCents;
  unitPriceInclVatCents: UsdCents;
  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
  lineDiscountCents: UsdCents;
  /** The COGS rate this line was costed at, snapshotted at post time. */
  unitCogsExclVatMicrocents: Microcents;
  /** Rounded mirror of the rate above. Display only. */
  unitCogsExclVatCents: UsdCents;
  /** The line's COGS as money: round(rate x quantity). */
  lineCogsExclVatCents: UsdCents;
  barcodeUsedSnapshot: string | null;
  barcodeTypeSnapshot: string | null;
  quantityInUom: number | null;
  uomCodeSnapshot: string | null;
  factorNumSnapshot: number | null;
  factorDenSnapshot: number | null;
}

export interface SalePayment {
  id: string;
  saleId: string;
  storeId: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: UsdCents;
  amountNativeLbp: number;
  amountUsdCentsEquivalent: UsdCents;
  changeGivenUsdCents: UsdCents;
  changeGivenLbp: number;
  reference: string | null;
  createdAt: string;
}

export interface SaleWithDetails extends Sale {
  lines: SaleItem[];
  payments: SalePayment[];
}

// ---------- Shifts ----------

export type ShiftStatus = "open" | "closed" | "voided";

export interface Shift {
  id: string;
  storeId: string;
  deviceId: string | null;
  openedByUserId: string;
  closedByUserId: string | null;
  openedAt: string;
  closedAt: string | null;
  openingCashUsdCents: number;
  openingCashLbp: number;
  closingCashUsdCents: number | null;
  closingCashLbp: number | null;
  expectedCashUsdCents: number | null;
  expectedCashLbp: number | null;
  varianceUsdCents: number | null;
  varianceLbp: number | null;
  status: ShiftStatus;
  notes: string | null;
}
// ---------- Sales returns / credit memos (WP-06) ----------

export type CreditMemoStatus = "draft" | "posted" | "voided";

/**
 * A refund method. `store_credit` is absent on purpose: Greaz has no
 * customer-credit ledger, so a store-credit refund would be a liability
 * recorded nowhere. Migration 011's CHECK says the same thing in the engine.
 */
export type RefundMethod = Exclude<PaymentMethod, "store_credit">;

/**
 * The header of one return document.
 *
 * Every amount on it was derived by `post_credit_memo` from the ORIGINAL
 * sale's snapshots — price, VAT, discount allocation, COGS rate and locked
 * exchange rate — never from today's product, rate or cost pool.
 */
export interface CreditMemo {
  id: string;
  storeId: string;
  originalSaleId: string;
  creditMemoNumber: number;
  shiftId: string | null;
  deviceId: string | null;
  cashierUserId: string | null;
  /** The ORIGINAL sale's locked rate, copied at post time. */
  exchangeRateLbpPerUsd: number;
  exchangeRateId: string | null;
  reason: string | null;
  subtotalExclVatCents: UsdCents;
  vatTotalCents: UsdCents;
  discountCents: UsdCents;
  totalInclVatCents: UsdCents;
  /** COGS put back into inventory — restocked lines only. */
  cogsReversedCents: UsdCents;
  /** Equal to `totalInclVatCents` exactly; there is no unpaid-credit model. */
  refundTotalUsdCents: UsdCents;
  status: CreditMemoStatus;
  createdAt: string;
  postedAt: string | null;
  notes: string | null;
}

export interface CreditMemoLine {
  id: string;
  creditMemoId: string;
  storeId: string;
  originalSaleItemId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  vatRateIdSnapshot: string;
  vatRateBpsSnapshot: number;
  /** The canonical returned quantity, in base units. */
  quantityBase: number;
  /** The same quantity in the original line's own display unit. */
  quantityInUom: number;
  uomCodeSnapshot: string | null;
  factorNumSnapshot: number | null;
  factorDenSnapshot: number | null;
  unitPriceExclVatCents: UsdCents;
  unitPriceInclVatCents: UsdCents;
  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
  lineDiscountCents: UsdCents;
  /** The ORIGINAL sale's COGS rate for this line. */
  unitCogsExclVatMicrocents: Microcents;
  /** Rounded mirror of the rate above. Display only. */
  unitCogsExclVatCents: UsdCents;
  /** The COGS actually reversed — zero when the line did not restock. */
  lineCogsExclVatCents: UsdCents;
  /** True when the original sale line moved no stock. */
  isService: boolean;
  returnToStock: boolean;
  relatedMovementId: string | null;
}

export interface CreditMemoRefund {
  id: string;
  creditMemoId: string;
  storeId: string;
  method: RefundMethod;
  currency: PaymentCurrency;
  amountNativeUsdCents: UsdCents;
  amountNativeLbp: number;
  /** Derived at the ORIGINAL sale's locked rate. */
  amountUsdCentsEquivalent: UsdCents;
  reference: string | null;
  createdAt: string;
}

export interface CreditMemoWithDetails extends CreditMemo {
  lines: CreditMemoLine[];
  refunds: CreditMemoRefund[];
  /** The receipt number of the sale this memo reverses, for display. */
  originalReceiptNumber: number | null;
}

/**
 * How much of a sale has come back. DERIVED from credit-memo lines — the sale
 * itself is never marked.
 */
export type SaleReturnStatus = "none" | "partial" | "full";

/** One line of a sale, with what is still returnable on it. */
export interface ReturnableLine {
  saleItemId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  uomCodeSnapshot: string | null;
  factorNumSnapshot: number;
  factorDenSnapshot: number;
  /** Sold, in base units and in the line's own display unit. */
  soldQuantityBase: number;
  soldQuantityInUom: number;
  /** Already returned by POSTED credit memos, in both units. */
  returnedQuantityBase: number;
  returnedQuantityInUom: number;
  /** What is left, in both units. */
  remainingQuantityBase: number;
  remainingQuantityInUom: number;
  unitPriceInclVatCents: UsdCents;
  /**
   * The ORIGINAL line's persisted components. All three are needed to preview
   * what a return will credit, because each is prorated on its own series —
   * see `lib/creditMemoMath.ts`.
   */
  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
  lineDiscountCents: UsdCents;
  vatRateBpsSnapshot: number;
  /** True when the original line moved no stock, so it can never restock. */
  isService: boolean;
}

/** How much a sale may still be refunded through one of its own tenders. */
export interface RefundAvailability {
  method: RefundMethod;
  currency: PaymentCurrency;
  /** Received through this method, NET of any change given, in native units. */
  availableNative: number;
  /** Already refunded through it by posted memos, in native units. */
  refundedNative: number;
  /** What is left, in native units. */
  remainingNative: number;
}
