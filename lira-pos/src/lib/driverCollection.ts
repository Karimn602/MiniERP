/**
 * Greaz delivery: the driver collects, the driver keeps the fee (WP-6).
 *
 * Pure — no React, no database, no `invoke`. The register and the drivers
 * screen own the effects; this module owns the arithmetic and the decisions,
 * so they can be tested without a desktop. Same split as `lib/discount.ts` and
 * `lib/postAttempt.ts`.
 *
 * ## The arrangement, as the founder confirmed it
 *
 * An order arrives on WhatsApp. The cashier types it in. Greaz assigns one of
 * its OWN drivers and agrees a delivery charge with the customer. The driver
 * takes the food out, collects ONE amount from the customer — food plus
 * delivery — keeps the delivery charge, and brings the food money back.
 *
 * So there are three different numbers on one screen, and the whole feature is
 * about never confusing them:
 *
 *   * **the food total** — Greaz's sale. VAT applies, it is what the receipt
 *     is for, and it is what the driver owes the shop from the moment the food
 *     leaves. `sales.total_incl_vat_cents`.
 *   * **the delivery fee** — the driver's. It never enters the shop, so it is
 *     not revenue, it is not in any sale total, and it is not in his
 *     receivable. `sales.delivery_fee_cents`.
 *   * **what the customer pays** — the sum of the two, which exists only as a
 *     figure on a screen. Nothing stores it, because storing a total nobody
 *     owns is how it ends up in a revenue report.
 *
 * ## What is NOT settled
 *
 * The VAT and invoicing treatment of the delivery fee is an open question for
 * Greaz's accountant, and this module is written so the answer can be applied
 * later without restating a posted row. The fee is tracked and displayed, and
 * it is attributed to nobody's revenue and given no VAT rate. If the
 * accountant rules it is Greaz's supply, it becomes a priced line in a later
 * change and history stands as recorded; if it is the driver's own income,
 * nothing needs to change. Guessing would put the wrong VAT on real receipts.
 *
 * ## What this is NOT
 *
 * Not a third-party platform, not a commission, not a platform settlement, and
 * not an external receivable. Migration 014 deferred that design; the confirmed
 * process has no third party in it at all, so it is cancelled rather than
 * postponed. There is no payroll, no commission, no GPS and no dispatch here.
 */

import type { PaymentMethod } from "../db/types";

/** The tender that raises a driver receivable instead of taking money in. */
export const DRIVER_COLLECTION: PaymentMethod = "driver_collection";

/**
 * Does this tender put money in the drawer?
 *
 * `driver_collection` does NOT, and that single fact is what keeps the till
 * honest: the shift's expected cash, the change rules and the refund guard all
 * key on it. Mirrors `posting.rs::is_cash_method`.
 */
export function isDrawerCash(method: PaymentMethod): boolean {
  return method === "cash_usd" || method === "cash_lbp";
}

// ---------------------------------------------------------------------------
// The three numbers
// ---------------------------------------------------------------------------

export interface DeliveryTotals {
  /** Greaz's sale: the food, VAT included. What the driver will owe. */
  foodInclVatCents: number;
  /** The driver's charge. Not revenue. */
  deliveryFeeCents: number;
  /** What the customer hands the driver. A display figure; nothing stores it. */
  customerPaysCents: number;
}

/**
 * Split one delivery order into the three figures the cashier must see apart.
 *
 * Addition in integer cents, like all money here (`lib/money.ts`). A negative
 * fee is not representable in the schema and is refused by `post_sale`, but it
 * is clamped here too so a half-typed input cannot render a total below the
 * food it contains.
 */
export function deliveryTotals(
  foodInclVatCents: number,
  deliveryFeeCents: number,
): DeliveryTotals {
  const fee = Math.max(0, Math.trunc(deliveryFeeCents));
  const food = Math.trunc(foodInclVatCents);
  return {
    foodInclVatCents: food,
    deliveryFeeCents: fee,
    customerPaysCents: food + fee,
  };
}

// ---------------------------------------------------------------------------
// What the register may post
// ---------------------------------------------------------------------------

/**
 * Why a delivery order cannot be confirmed yet, or null when it can.
 *
 * These mirror `posting.rs::prepare_sale`'s three delivery rules and migration
 * 015's triggers. The backend is the authority; this exists so the cashier is
 * told before pressing Post rather than refused after, and so the reason is a
 * translatable key rather than a backend sentence.
 */
export type DeliveryBlocker =
  /** A driver collection with nobody to owe it. */
  | "driverRequired"
  /** A fee with no driver who collected it. */
  | "feeNeedsDriver"
  /** A driver on a counter order. */
  | "driverNeedsDelivery"
  /** The fee box does not hold a number. */
  | "feeInvalid";

export interface DeliveryIntent {
  channel: string;
  driverId: string | null;
  /** The raw fee input, exactly as typed. */
  feeInput: string;
  /** Does the tender include a driver collection? */
  collectsByDriver: boolean;
}

/**
 * Parse a typed delivery fee into cents.
 *
 * Returns null when the box holds something that is not a non-negative amount.
 * An EMPTY box is zero, not an error: most delivery orders in a small shop are
 * rung up before the fee is agreed, and refusing to post a free delivery would
 * be wrong.
 */
export function parseFeeCents(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

export function deliveryBlocker(intent: DeliveryIntent): DeliveryBlocker | null {
  const fee = parseFeeCents(intent.feeInput);
  if (fee === null) return "feeInvalid";

  const isDelivery = intent.channel === "online_delivery";
  if (intent.driverId && !isDelivery) return "driverNeedsDelivery";

  // A DELIVERY ORDER ALWAYS NEEDS A DRIVER (WP-7 SS3).
  //
  // Stronger than the old rule, which only asked for one when a driver
  // collection had been toggled on. Under the confirmed workflow every
  // WhatsApp order is carried by one of the shop's own drivers and settled by
  // him collecting, so "delivery with nobody assigned" is not a state the till
  // should be able to post.
  //
  // It is also the guard that stops blank tender becoming cashier cash: the
  // register's auto-pay path turns an empty tender into a `cash_usd` row for
  // the full amount, and without a driver a delivery order would take that
  // path — putting money in a drawer nobody handed anything to.
  if (isDelivery && !intent.driverId) return "driverRequired";
  if (intent.collectsByDriver && !intent.driverId) return "driverRequired";
  if (fee > 0 && !intent.driverId) return "feeNeedsDriver";
  return null;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

/**
 * Why a remittance cannot be recorded, or null when it can.
 *
 * `post_driver_remittance` is the authority and reads the balance inside its
 * own transaction — which is what makes over-settlement impossible under
 * concurrency, not this. This is the screen telling the user first.
 */
export type RemittanceBlocker =
  /** Nothing typed, or not an amount. */
  | "amountInvalid"
  /** Zero records nothing. */
  | "amountZero"
  /** He is holding nothing (or the shop owes him). */
  | "nothingOutstanding"
  /** More than he is holding. The shop carries no driver advance. */
  | "exceedsOutstanding";

/**
 * Check a remittance against a displayed balance.
 *
 * `amountCents` is the USD-equivalent magnitude, always positive — the caller
 * converts a lira amount at the rate on record first, exactly as the backend
 * does, so the comparison happens in one unit.
 */
export function remittanceBlocker(
  amountCents: number | null,
  outstandingCents: number,
): RemittanceBlocker | null {
  if (amountCents === null) return "amountInvalid";
  if (amountCents <= 0) return "amountZero";
  if (outstandingCents <= 0) return "nothingOutstanding";
  if (amountCents > outstandingCents) return "exceedsOutstanding";
  return null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** One driver's figures over a period, for the owner's report. */
export interface DriverSettlementRow {
  driverId: string;
  driverName: string;
  isActive: boolean;
  /** Delivery orders he carried that raised a receivable. */
  orderCount: number;
  /** Food money collected, ever. */
  collectedCents: number;
  /** Handed back, ever. Positive. */
  remittedCents: number;
  /** Credited back through returns, ever. Positive. */
  returnCreditCents: number;
  /** Signed-off corrections, net and signed. */
  adjustmentCents: number;
  /** What he still owes. */
  outstandingCents: number;
  /** Delivery charges he kept, over the period. NOT Greaz revenue. */
  deliveryFeesCents: number;
  lastActivityAt: string | null;
}

/**
 * Prove a set of driver rows adds up, and total it.
 *
 * The reason this exists rather than a `reduce` at the call site: the owner
 * reads "outstanding" against "collected − remitted" and expects them to
 * agree. Each row's balance comes from the view, which sums the ledger; this
 * recomputes it from the components and reports a disagreement instead of
 * rendering two numbers that quietly differ. A mismatch can only mean a new
 * entry type was added without being given a column here, which is exactly the
 * mistake worth catching loudly.
 */
export interface DriverSettlementTotals {
  rows: DriverSettlementRow[];
  orderCount: number;
  collectedCents: number;
  remittedCents: number;
  returnCreditCents: number;
  adjustmentCents: number;
  outstandingCents: number;
  deliveryFeesCents: number;
  /** Rows whose balance does not equal its own components. Should be empty. */
  unreconciled: string[];
}

export function summariseDrivers(
  rows: readonly DriverSettlementRow[],
): DriverSettlementTotals {
  const unreconciled: string[] = [];
  for (const r of rows) {
    const derived =
      r.collectedCents - r.remittedCents - r.returnCreditCents + r.adjustmentCents;
    if (derived !== r.outstandingCents) unreconciled.push(r.driverId);
  }
  const sum = (pick: (r: DriverSettlementRow) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);
  return {
    rows: [...rows],
    orderCount: sum((r) => r.orderCount),
    collectedCents: sum((r) => r.collectedCents),
    remittedCents: sum((r) => r.remittedCents),
    returnCreditCents: sum((r) => r.returnCreditCents),
    adjustmentCents: sum((r) => r.adjustmentCents),
    outstandingCents: sum((r) => r.outstandingCents),
    deliveryFeesCents: sum((r) => r.deliveryFeesCents),
    unreconciled,
  };
}
