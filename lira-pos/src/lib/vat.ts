/**
 * VAT (Value Added Tax) math — Lebanon.
 *
 * Current standard rate: 11% (as of 2026).
 * Stored everywhere as integer BASIS POINTS: 11% → 1100, 5% → 500, 0% → 0.
 * Basis points let us represent any whole-percent-or-finer rate without floats.
 *
 * EVERY product references a vat_rate row (not a value). EVERY sale_item
 * SNAPSHOTS the rate at the time of posting — so changing the VAT rate later
 * doesn't retroactively alter historical sales.
 *
 * Two pricing models are supported (configurable per product in later phases):
 *
 *   1. VAT-EXCLUSIVE pricing — "price" entered is the net price; tax is added
 *      at checkout.   gross = net * (1 + rate)
 *
 *   2. VAT-INCLUSIVE pricing — "price" entered is the gross price; net is
 *      derived.    net = gross / (1 + rate)
 *
 * All math in USD cents (integer).
 */

import type { UsdCents } from "./money";

export type Bps = number; // basis points; 1100 = 11.00%

/** Net → Gross. e.g. net=10000c, bps=1100 → 11100c. */
export function addVat(netCents: UsdCents, bps: Bps): UsdCents {
  if (!Number.isInteger(netCents) || !Number.isInteger(bps)) {
    throw new Error("addVat requires integer inputs");
  }
  // gross = net + net * bps / 10000
  const tax = Math.round((netCents * bps) / 10000);
  return netCents + tax;
}

/** Gross → Net. e.g. gross=11100c, bps=1100 → 10000c. */
export function stripVat(grossCents: UsdCents, bps: Bps): UsdCents {
  if (!Number.isInteger(grossCents) || !Number.isInteger(bps)) {
    throw new Error("stripVat requires integer inputs");
  }
  // net = gross * 10000 / (10000 + bps)
  return Math.round((grossCents * 10000) / (10000 + bps));
}

/** Tax portion only, from a net amount. */
export function vatFromNet(netCents: UsdCents, bps: Bps): UsdCents {
  return Math.round((netCents * bps) / 10000);
}

/** Tax portion only, from a gross amount. */
export function vatFromGross(grossCents: UsdCents, bps: Bps): UsdCents {
  return grossCents - stripVat(grossCents, bps);
}

/** Format a bps rate as a human percent: 1100 → "11%", 1050 → "10.5%". */
export function formatBps(bps: Bps): string {
  if (bps % 100 === 0) return `${bps / 100}%`;
  return `${(bps / 100).toFixed(2)}%`;
}