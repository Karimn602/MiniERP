/**
 * Sale line math — pure, integer-only. Sister to purchaseMath.ts.
 *
 * A POS sale line is built up like this:
 *   1. The cashier scans a barcode or picks a product → we get the
 *      ProductWithUoms and a resolvedUom.
 *   2. The cashier types a quantity, as an integer, in the resolved UoM.
 *
 * From those inputs we derive:
 *   - per-UoM unit price excluding VAT and including VAT
 *   - quantity_base
 *   - line subtotal / VAT / total in USD cents
 */

import { type Factor, resolvePriceForUom, toBaseQty } from "./uom";
import type { Bps } from "./vat";
import type { UsdCents } from "./money";

export interface SaleLineMath {
  quantityInUom: number;
  factor: Factor;
  vatBps: Bps;

  unitPriceExclVatCents: UsdCents;
  unitPriceInclVatCents: UsdCents;

  quantityBase: number;

  lineSubtotalExclVatCents: UsdCents;
  lineVatCents: UsdCents;
  lineTotalInclVatCents: UsdCents;
}

export function computeSaleLineMath(args: {
  quantityInUom: number;
  factor: Factor;
  vatBps: Bps;
  basePriceExclVatCents: UsdCents;
  basePriceInclVatCents: UsdCents;
  uomOverrideExclVatCents: UsdCents | null;
  uomOverrideInclVatCents: UsdCents | null;
}): SaleLineMath {
  const {
    quantityInUom,
    factor,
    vatBps,
    basePriceExclVatCents,
    basePriceInclVatCents,
    uomOverrideExclVatCents,
    uomOverrideInclVatCents,
  } = args;

  const {
    exclVatCents: unitPriceExclVatCents,
    inclVatCents: unitPriceInclVatCents,
  } = resolvePriceForUom({
    basePriceExclVatCents,
    basePriceInclVatCents,
    uomOverrideExclVatCents,
    uomOverrideInclVatCents,
    factor,
  });

  const quantityBase = toBaseQty(quantityInUom, factor);

  const lineSubtotalExclVatCents = unitPriceExclVatCents * quantityInUom;
  const lineTotalInclVatCents = unitPriceInclVatCents * quantityInUom;
  const lineVatCents = lineTotalInclVatCents - lineSubtotalExclVatCents;

  return {
    quantityInUom,
    factor,
    vatBps,
    unitPriceExclVatCents,
    unitPriceInclVatCents,
    quantityBase,
    lineSubtotalExclVatCents,
    lineVatCents,
    lineTotalInclVatCents,
  };
}