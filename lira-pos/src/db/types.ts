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
  rateBps: number;          // 1100 = 11%
  isExempt: boolean;
  effectiveFrom: string;    // ISO date
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
  /** Override prices in USD cents. Null means derive from product base price × factor. */
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
  /** Base-UoM price, USD cents. */
  priceExclVatCents: UsdCents;
  priceInclVatCents: UsdCents;
  /** Base-UoM weighted-average cost, USD cents. */
  avgCostExclVatCents: UsdCents;
  avgCostInclVatCents: UsdCents;
  /** Quantity in BASE UoM. */
  quantityOnHand: number;
  reorderPoint: number | null;
  isActive: boolean;
  isService: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Product enriched with its UoMs and primary barcode — what the Products
 * list screen and POS scan resolution both consume.
 */
export interface ProductWithUoms extends Product {
  uoms: ProductUom[];
  /** Convenience: the row where isBase=1. Always present. */
  baseUom: ProductUom;
  /** Convenience: the row where isDefaultSale=1. Always present. */
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
  /** The barcode as scanned/entered (preserve exactly). */
  barcode: string;
  /** Normalized form, used for lookup. */
  lookupValue: string;
  barcodeType: BarcodeType;
  isPrimary: boolean;
  isActive: boolean;
  /** If set, scanning this barcode auto-picks that UoM. */
  productUomId: string | null;
}

/** What a successful POS scan resolves to. */
export interface BarcodeScanResult {
  product: ProductWithUoms;
  /** The UoM resolved from the barcode (or the product's default if barcode wasn't UoM-specific). */
  resolvedUom: ProductUom;
  /** The barcode row that matched. */
  matchedBarcode: ProductBarcode;
}

// ---------- Exchange Rates ----------

export interface ExchangeRate {
  id: string;
  storeId: string;
  /** 'YYYY-MM-DD' local date. */
  effectiveDate: string;
  /** Integer LBP per 1 USD. */
  rateLbpPerUsd: number;
  source: "manual" | "api" | "imported";
  notes: string | null;
  createdAt: string;
}

// ---------- Phase 2C: Suppliers ----------

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

// ---------- Phase 2C: Purchases ----------

export type PurchaseStatus = "draft" | "posted" | "voided";
export type PurchaseType = "normal" | "opening";

export interface Purchase {
  id: string;
  storeId: string;
  supplierId: string | null;
  purchaseType: PurchaseType;
  supplierReference: string | null;
  purchaseNumber: number;
  purchaseDate: string; // YYYY-MM-DD
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