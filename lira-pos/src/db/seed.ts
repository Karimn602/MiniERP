import { execute, query } from "./client";
import { newId } from "../lib/ids";
import { normalizeBarcode, type BarcodeType } from "../lib/barcode";

const STORE_ID = "00000000-0000-0000-0000-000000000001";
const VAT_STANDARD_ID = "00000000-0000-0000-0000-000000000010";

/**
 * Seed a few demo products + their primary barcodes. Safe to call multiple
 * times — short-circuits if products already exist. Wire to a "Seed demo
 * data" button in dev only. Never call from production.
 *
 * Note: the THREE original demo products and their barcodes are already
 * seeded by migrations 001 and 002. This helper covers any ADDITIONAL
 * demo data you want to add in dev without writing more migrations.
 */
export async function seedDemoProducts(): Promise<{ created: number }> {
  const existing = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM products WHERE store_id = ?",
    [STORE_ID],
  );
  if ((existing[0]?.n ?? 0) >= 3) {
    // Migrations already seeded the original 3 demo products. Bail.
    return { created: 0 };
  }

  // (Reserved for future dev-only samples beyond the migration's initial 3.)
  return { created: 0 };
}

/**
 * Helper used by Phase 2's Products form. Centralized here because both
 * "create product" and "add additional barcode" need it, and getting the
 * lookup_value <-> barcode coupling right matters.
 */
export async function addProductBarcode(args: {
  productId: string;
  barcode: string;
  barcodeType: BarcodeType;
  isPrimary: boolean;
}): Promise<{ id: string }> {
  const id = newId();
  const lookup = normalizeBarcode(args.barcode);
  await execute(
    `INSERT INTO product_barcodes
       (id, store_id, product_id, barcode, lookup_value, barcode_type, is_primary, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      STORE_ID,
      args.productId,
      args.barcode,
      lookup,
      args.barcodeType,
      args.isPrimary ? 1 : 0,
    ],
  );
  return { id };
}