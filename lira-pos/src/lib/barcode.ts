/**
 * Barcode utilities.
 *
 * Phase 1 scope:
 *   - normalize(): the canonical lookup form. Trim + uppercase.
 *     Always called before INSERT into product_barcodes.lookup_value
 *     and before any SELECT WHERE lookup_value = ?.
 *   - classify(): best-effort barcode_type guess from input length/shape.
 *     Caller can override.
 *
 * Phase 2 will add:
 *   - validateEan13Checksum()
 *   - validateUpcAChecksum()
 *   - validateEan8Checksum()
 *   - validateUpcEChecksum()
 */

export type BarcodeType =
  | "EAN13"
  | "EAN8"
  | "UPC_A"
  | "UPC_E"
  | "INTERNAL"
  | "SUPPLIER"
  | "OTHER";

/**
 * Canonical lookup form. ALWAYS use the return value for the lookup_value
 * column and for WHERE clauses. NEVER for the `barcode` column itself —
 * that one preserves the original input.
 */
export function normalizeBarcode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Best-effort type classification from raw input. Pure digit strings get
 * matched to standard symbologies by length; everything else is OTHER.
 * The user can override this in the product form.
 */
export function classifyBarcode(raw: string): BarcodeType {
  const norm = normalizeBarcode(raw);
  if (!/^\d+$/.test(norm)) return "OTHER";
  switch (norm.length) {
    case 13: return "EAN13";
    case 12: return "UPC_A";
    case 8:  return "EAN8";
    // UPC_E is also 8 digits but compressed; ambiguous without context — leave to user.
    default: return "OTHER";
  }
}

/**
 * Quick boolean: does this string look plausibly scannable?
 * Used only for UI affordances (button enabled state), never for storage.
 */
export function looksLikeBarcode(raw: string): boolean {
  const norm = normalizeBarcode(raw);
  return norm.length >= 4 && norm.length <= 48 && !/\s/.test(norm);
}
export function isValidEan13(raw: string): boolean {
  const code = normalizeBarcode(raw);

  if (!/^\d{13}$/.test(code)) {
    return false;
  }

  const digits = code.split("").map(Number);
  const checkDigit = digits[12];

  let sum = 0;

  for (let i = 0; i < 12; i++) {
    sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  }

  const calculatedCheckDigit = (10 - (sum % 10)) % 10;

  return calculatedCheckDigit === checkDigit;
}


// ---------------------------------------------------------------------------
// Which barcode a FORM may refuse (GZ-WP2-A)
// ---------------------------------------------------------------------------

/**
 * Does the EAN-13 checksum apply to this input, and does it fail?
 *
 * Scoped to 13 pure digits on purpose: a shop's own internal codes, supplier
 * references and shelf labels are not EAN-13 and must not be measured against
 * its checksum.
 */
export function failsEan13Checksum(raw: string): boolean {
  const code = raw.trim();
  return code.length === 13 && /^\d+$/.test(code) && !isValidEan13(code);
}

/**
 * The reason a product form must refuse to save, or `null` to let it through.
 *
 * ## Why this is a function and not two lines in the page
 *
 * The Products form validated its barcode box on EVERY save, including an
 * UPDATE — which does not submit the barcode at all. `productsRepo.save` has
 * no `barcode` field in update mode, and the form shows `BarcodeManager`
 * rather than an input there, so the value being judged was simply the
 * existing primary barcode, pre-filled for display.
 *
 * Plenty of real shelf stock carries a printed code that fails the modern
 * EAN-13 checksum — a mis-keyed label, a re-used internal code, a supplier's
 * own numbering. Those products exist and are perfectly sellable. The form
 * made them UNEDITABLE: a cashier could not fix a typo in the name or put the
 * price up, because saving was refused over a field the save would not have
 * written, and the only way out was to change a barcode that was working fine.
 *
 * So the rule is scoped to what is actually being submitted. A barcode is
 * refused when the form will WRITE it — on create — and a new or changed
 * barcode is validated where it is genuinely entered, in
 * `BarcodeManager.handleAdd`. Nothing here rewrites or removes a historical
 * code; the form has no authority to, and silently "fixing" a barcode would
 * break every scan of the goods already on the shelf.
 */
export function productFormBarcodeError(
  mode: "new" | "edit",
  barcode: string,
  isService: boolean,
): "required" | "badEan13" | null {
  const code = barcode.trim();

  // On an UPDATE the barcode is not part of the payload, so the form has
  // nothing to validate and no standing to refuse. Barcodes are managed
  // separately, with their own validation at the point of entry.
  if (mode === "edit") return null;

  // A stocked product must be scannable to be sold at the till. A service has
  // nothing to scan.
  if (!isService && !code) return "required";

  // An empty box is a product with no barcode, which is allowed for a service
  // and already refused above for goods.
  if (!code) return null;

  return failsEan13Checksum(code) ? "badEan13" : null;
}
