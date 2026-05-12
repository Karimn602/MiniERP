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