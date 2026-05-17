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
  unitCogsExclVatCents: UsdCents;
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