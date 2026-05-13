import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import { normalizeBarcode, type BarcodeType } from "../../lib/barcode";
import type { ProductBarcode } from "../types";

interface BarcodeRow {
  id: string;
  store_id: string;
  product_id: string;
  barcode: string;
  lookup_value: string;
  barcode_type: BarcodeType;
  is_primary: number;
  is_active: number;
  product_uom_id: string | null;
}

function toDomain(row: BarcodeRow): ProductBarcode {
  return {
    id: row.id,
    storeId: row.store_id,
    productId: row.product_id,
    barcode: row.barcode,
    lookupValue: row.lookup_value,
    barcodeType: row.barcode_type,
    isPrimary: row.is_primary === 1,
    isActive: row.is_active === 1,
    productUomId: row.product_uom_id,
  };
}

export const barcodesRepo = {
  /** Hot path. Scan input → normalized lookup → barcode row. */
  async findByScan(storeId: string, scannedInput: string): Promise<ProductBarcode | null> {
    const lookup = normalizeBarcode(scannedInput);
    const rows = await query<BarcodeRow>(
      `SELECT id, store_id, product_id, barcode, lookup_value, barcode_type,
              is_primary, is_active, product_uom_id
       FROM product_barcodes
       WHERE store_id = ? AND lookup_value = ? AND is_active = 1
       LIMIT 1`,
      [storeId, lookup],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async listForProduct(productId: string): Promise<ProductBarcode[]> {
    const rows = await query<BarcodeRow>(
      `SELECT id, store_id, product_id, barcode, lookup_value, barcode_type,
              is_primary, is_active, product_uom_id
       FROM product_barcodes
       WHERE product_id = ?
       ORDER BY is_primary DESC, is_active DESC, created_at ASC`,
      [productId],
    );
    return rows.map(toDomain);
  },

  async getPrimaryForProduct(productId: string): Promise<ProductBarcode | null> {
    const rows = await query<BarcodeRow>(
      `SELECT id, store_id, product_id, barcode, lookup_value, barcode_type,
              is_primary, is_active, product_uom_id
       FROM product_barcodes
       WHERE product_id = ? AND is_primary = 1 AND is_active = 1
       LIMIT 1`,
      [productId],
    );
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async add(args: {
    storeId: string;
    productId: string;
    barcode: string;
    barcodeType: BarcodeType;
    isPrimary: boolean;
    productUomId?: string | null;
  }): Promise<{ id: string }> {
    const id = newId();
    await execute(
      `INSERT INTO product_barcodes
         (id, store_id, product_id, barcode, lookup_value, barcode_type,
          is_primary, is_active, product_uom_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        args.storeId,
        args.productId,
        args.barcode,
        normalizeBarcode(args.barcode),
        args.barcodeType,
        args.isPrimary ? 1 : 0,
        args.productUomId ?? null,
      ],
    );
    return { id };
  },

  async deactivate(id: string): Promise<void> {
    await execute(
      `UPDATE product_barcodes SET is_active = 0, is_primary = 0 WHERE id = ?`,
      [id],
    );
  },
};