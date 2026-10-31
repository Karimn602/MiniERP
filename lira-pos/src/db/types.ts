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
import type { CogsSource, CostingMethod } from "../lib/standardCost";

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
  /**
   * Menu section id, or null for uncategorised (migration 013).
   *
   * A stable id such as `"burgers"`, never a label — see
   * `lib/menuCategories.ts`, which owns the canonical list, the normalisation
   * and the localized labels. Presentational: no posting command reads it and
   * it is snapshotted onto no sale line.
   */
  category: string | null;
  /** Short decorative glyph for the menu tile, or null to use the section's. */
  icon: string | null;
  /**
   * How a sale of this product is costed (WP-B1, migration 020).
   *
   * `"purchase_average"` is the default and the behaviour every product had
   * before: the weighted average, or the last purchase rate when the SALE asks
   * for that. `"standard"` is the owner's typed cost, read from
   * `standardCostExclVatMicrocents`. See `lib/standardCost.ts`.
   */
  costingMethod: CostingMethod;
  /**
   * The typed cost: a RATE per base unit, EXCLUSIVE of VAT, in microcents.
   *
   * `null` means NOT CONFIGURED and is deliberately distinct from `0`, which
   * is the owner asserting the item costs nothing. There is no VAT-inclusive
   * sibling: every COGS figure any report reads is net.
   */
  standardCostExclVatMicrocents: Microcents | null;
  /**
   * When the manual cost was last stated, or `null` if none is.
   *
   * A standard cost is an assertion by a person rather than a figure derived
   * from documents, so when it was made is part of reading it. It moves only
   * when the figure moves — an ordinary edit does not restamp it.
   */
  standardCostSetAt: string | null;
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
  /**
   * The shop's own driver carried a WhatsApp order and collected for it (WP-6).
   *
   * Non-cash, like a card: it settles the sale in full, it puts nothing in the
   * drawer, and the money arrives later. What it raises is a receivable against
   * the named driver, in `driver_ledger`. See `lib/driverCollection.ts`.
   */
  | "driver_collection"
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
  /**
   * Where the order came from (WP-4): `"counter"` or `"online_delivery"`.
   *
   * A bare string rather than an import of `SalesChannel`, to keep this module
   * off `lib/` beyond the three value types at the top. The column is NOT NULL
   * with a CHECK, so every row holds one of the two.
   */
  channel: string;
  /**
   * The shop's own driver who carried a delivery order (WP-6), or null.
   *
   * Here because a receipt and a kitchen ticket both have to be able to say who
   * took the order. The RECEIVABLE is a `driver_ledger` row and is not this
   * field.
   */
  driverId: string | null;
  /**
   * What the customer paid the DRIVER for the delivery, in USD cents (WP-6).
   *
   * Outside every sale total, never VAT-rated, not a `sale_items` row, and not
   * in the driver's receivable — he keeps it. It is on the sale so the shop can
   * state what the customer's whole payment was; see `lib/driverCollection.ts`.
   */
  deliveryFeeCents: UsdCents;
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
  /**
   * WHERE the COGS rate above came from (WP-B1, migration 020).
   *
   * `null` means the line was posted before the column existed, which is the
   * truth about it — no posted row was rewritten. Provenance only: no total is
   * derived from it, no posting command reads it, and it is not part of the
   * sale's canonical content, because the backend derives it from the product
   * row rather than accepting it on the wire.
   */
  cogsSource: CogsSource | null;
  /**
   * WHICH published recipe version supplied the rate (WP-B2-B, migration 022).
   *
   * Both are `null` unless `cogsSource === "recipe"`, and migration 022's
   * `trg_sale_items_recipe_coherence` refuses every way the three could
   * disagree. They exist so a posted cost stays explainable after version 2 is
   * published and version 1 retired: `sale_item_recipe_costs` holds the
   * per-ingredient breakdown under the same identity.
   */
  recipeId: string | null;
  recipeVersion: number | null;
  barcodeUsedSnapshot: string | null;
  barcodeTypeSnapshot: string | null;
  quantityInUom: number | null;
  uomCodeSnapshot: string | null;
  factorNumSnapshot: number | null;
  factorDenSnapshot: number | null;
  /**
   * The kitchen's instruction for this line, as it was given (WP-A2).
   *
   * A snapshot in exactly the sense the name and the price beside it are: it
   * is what the kitchen was told, at the moment the order was taken, and
   * migration 012's seal means it can never be rewritten. Carries no money —
   * a PAID modifier is a priced line of its own.
   */
  kitchenNote: string | null;
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
/**
 * `driver_collection` IS included, deliberately: a return on a delivery order
 * credits the DRIVER's balance, because he is holding the money being given
 * back. The existing cap keeps it honest — a memo may refund only a method the
 * sale actually took — so it is reachable on a driver-collected sale and on no
 * other. `store_credit` stays excluded; Greaz has no customer ledger.
 */
export type RefundMethod = Exclude<PaymentMethod, "store_credit">;

// ---------------------------------------------------------------------------
// Drivers and the driver clearing subledger (WP-6)
// ---------------------------------------------------------------------------

/** One of the shop's own delivery drivers. */
export interface Driver {
  id: string;
  storeId: string;
  name: string;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a driver owes the shop, and how he got there — the `driver_balances`
 * view. Every figure is summed from the SAME ledger rows, so the parts always
 * add up to `outstandingCents`.
 */
export interface DriverBalance {
  driverId: string;
  storeId: string;
  driverName: string;
  isActive: boolean;
  /** Positive = he is holding the shop's money. */
  outstandingCents: UsdCents;
  /** Food money collected on delivery orders, ever. */
  collectedCents: UsdCents;
  /** Handed back to the shop, ever. Positive. */
  remittedCents: UsdCents;
  /** Credited back through returns, ever. Positive. */
  returnCreditCents: UsdCents;
  /** Signed-off corrections, net and signed. */
  adjustmentCents: UsdCents;
  collectionCount: number;
  lastActivityAt: string | null;
}

export type DriverLedgerEntryType =
  /** A delivery sale posted; the driver is holding its food money. */
  | "collection"
  /** He handed cash over. */
  | "remittance"
  /** A credit memo reduced what the order was worth. */
  | "return_credit"
  /** A signed-off correction, in either direction. */
  | "adjustment";

/**
 * One append-only row of the driver subledger. `amountCents` is SIGNED:
 * positive means he owes the shop more.
 */
export interface DriverLedgerEntry {
  id: string;
  storeId: string;
  driverId: string;
  entryType: DriverLedgerEntryType;
  amountCents: UsdCents;
  entryDate: string;
  notes: string | null;
  /** Source traceability: the receipt, or the credit memo. */
  relatedSaleId: string | null;
  relatedCreditMemoId: string | null;
  /** Remittance only: the cash that physically arrived, in its own unit. */
  receivedCurrency: PaymentCurrency | null;
  receivedNativeUsdCents: UsdCents;
  receivedNativeLbp: number;
  exchangeRateId: string | null;
  exchangeRateLbpPerUsd: number | null;
  reference: string | null;
  shiftId: string | null;
  createdByUserId: string | null;
  deviceId: string | null;
  postedAt: string;
}

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
  /**
   * The instruction this line was made to (WP-A2), or null.
   *
   * Carried into the return dialog because two lines of one product are
   * otherwise identical there — and the instruction is frequently the reason
   * one of them is coming back. It affects no figure: a memo's amounts are
   * prorated from the line's persisted components, never from its note.
   */
  kitchenNote: string | null;
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
