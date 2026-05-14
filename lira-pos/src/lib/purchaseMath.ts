/**
 * Purchase line math — pure, integer-only.
 *
 * A purchase line is built up in the UI in this order:
 *   1. User picks a product (gives us VAT rate, base UoM, available UoMs)
 *   2. User picks a UoM (defaults to product's default purchase UoM)
 *   3. User types quantity (in the chosen UoM) and unit cost (in the chosen UoM)
 *   4. The UI also needs: cost-pricing-mode (VAT-incl vs VAT-excl on the
 *      supplier invoice — defaults to product's vat_pricing_mode)
 *
 * From those inputs we derive: base quantity, per-base unit cost (both
 * excl- and incl-VAT variants), line subtotal/VAT/total. All math in
 * USD cents with explicit rounding at every boundary.
 */

import { addVat, stripVat, type Bps } from "./vat";
import { type Factor, toBaseQty, unitCostInUomToBase } from "./uom";
import type { UsdCents } from "./money";
import type { VatPricingMode } from "../db/types";

export interface PurchaseLineMath {
  // What the user typed (already validated by caller).
  quantityInUom: number;
  unitCostInUomCents: UsdCents;       // the price they typed
  unitCostInUomMode: VatPricingMode;  // is what-they-typed gross or net?
  factor: Factor;
  vatBps: Bps;

  // (the math)
  unitCostExclVatInUomCents: UsdCents;
  unitCostInclVatInUomCents: UsdCents;
  unitCostExclVatBaseCents: UsdCents;
  unitCostInclVatBaseCents: UsdCents;
  quantityBase: number;

  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
}

export function computeLineMath(args: {
  quantityInUom: number;
  unitCostInUomCents: UsdCents;
  unitCostInUomMode: VatPricingMode;
  factor: Factor;
  vatBps: Bps;
}): PurchaseLineMath {
  const { quantityInUom, unitCostInUomCents, unitCostInUomMode, factor, vatBps } = args;

  // Derive both VAT variants of the per-UoM cost.
  const unitCostExclVatInUomCents =
    unitCostInUomMode === "exclusive"
      ? unitCostInUomCents
      : stripVat(unitCostInUomCents, vatBps);
  const unitCostInclVatInUomCents =
    unitCostInUomMode === "inclusive"
      ? unitCostInUomCents
      : addVat(unitCostInUomCents, vatBps);

  // Per-base cost (this is what inventory_movements stores; what drives WAC).
  const unitCostExclVatBaseCents = unitCostInUomToBase(unitCostExclVatInUomCents, factor);
  const unitCostInclVatBaseCents = unitCostInUomToBase(unitCostInclVatInUomCents, factor);

  // Quantity conversion.
  const quantityBase = toBaseQty(quantityInUom, factor);

  // Line totals. Compute from the per-UoM excl-VAT cost (this is what the
  // user actually typed, in the rounding-friendliest form).
  const lineSubtotalExclVatCents = unitCostExclVatInUomCents * quantityInUom;
  const lineTotalInclVatCents = unitCostInclVatInUomCents * quantityInUom;
  const lineVatCents = lineTotalInclVatCents - lineSubtotalExclVatCents;

  return {
    quantityInUom,
    unitCostInUomCents,
    unitCostInUomMode,
    factor,
    vatBps,
    unitCostExclVatInUomCents,
    unitCostInclVatInUomCents,
    unitCostExclVatBaseCents,
    unitCostInclVatBaseCents,
    quantityBase,
    lineSubtotalExclVatCents,
    lineVatCents,
    lineTotalInclVatCents,
  };
}
