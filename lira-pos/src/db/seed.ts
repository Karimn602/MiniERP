import { execute, query } from "./client";
import { newId } from "../lib/ids";
import { normalizeBarcode, type BarcodeType } from "../lib/barcode";

const STORE_ID = "00000000-0000-0000-0000-000000000001";

export async function seedDemoProducts(): Promise<{ created: number }> {
  const existing = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM products WHERE store_id = ?",
    [STORE_ID],
  );

  if ((existing[0]?.n ?? 0) >= 3) {
    return { created: 0 };
  }

  return { created: 0 };
}

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