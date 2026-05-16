
import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import { normalizeBarcode, classifyBarcode, type BarcodeType } from "../../lib/barcode";
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
  async addBarcode(args: {
  productId: string;
  barcode: string;
  productUomId?: string | null;
}): Promise<{ id: string }> {
  const productRows = await query<{ store_id: string }>(
    `SELECT store_id FROM products WHERE id = ?`,
    [args.productId],
  );

  const storeId = productRows[0]?.store_id;
  if (!storeId) {
    throw new Error(`Product not found: ${args.productId}`);
  }

  const activeRows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM product_barcodes
     WHERE product_id = ? AND is_active = 1`,
    [args.productId],
  );

  const isFirstBarcode = (activeRows[0]?.n ?? 0) === 0;
  const id = newId();
  const lookup = normalizeBarcode(args.barcode);

  await execute(
    `INSERT INTO product_barcodes
       (id, store_id, product_id, barcode, lookup_value, barcode_type,
        is_primary, is_active, product_uom_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id,
      storeId,
      args.productId,
      args.barcode,
      lookup,
      classifyBarcode(args.barcode),
      isFirstBarcode ? 1 : 0,
      args.productUomId ?? null,
    ],
  );

  return { id };
},

async setPrimary(productId: string, barcodeId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id
     FROM product_barcodes
     WHERE id = ? AND product_id = ? AND is_active = 1`,
    [barcodeId, productId],
  );

  if (!rows[0]) {
    throw new Error("Barcode not found or inactive.");
  }

  await execute(
    `UPDATE product_barcodes
     SET is_primary = 0
     WHERE product_id = ?`,
    [productId],
  );

  await execute(
    `UPDATE product_barcodes
     SET is_primary = 1
     WHERE id = ? AND product_id = ?`,
    [barcodeId, productId],
  );
},

async remove(barcodeId: string): Promise<void> {
  const rows = await query<{ product_id: string }>(
    `SELECT product_id
     FROM product_barcodes
     WHERE id = ? AND is_active = 1`,
    [barcodeId],
  );

  const productId = rows[0]?.product_id;
  if (!productId) {
    throw new Error("Barcode not found or already inactive.");
  }

  const countRows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM product_barcodes
     WHERE product_id = ? AND is_active = 1`,
    [productId],
  );

  if ((countRows[0]?.n ?? 0) <= 1) {
    throw new Error("Cannot remove the last barcode.");
  }

  await execute(
    `UPDATE product_barcodes
     SET is_active = 0,
         is_primary = 0
     WHERE id = ?`,
    [barcodeId],
  );

  const primaryRows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM product_barcodes
     WHERE product_id = ? AND is_active = 1 AND is_primary = 1`,
    [productId],
  );

  if ((primaryRows[0]?.n ?? 0) === 0) {
    const nextRows = await query<{ id: string }>(
      `SELECT id
       FROM product_barcodes
       WHERE product_id = ? AND is_active = 1
       ORDER BY created_at ASC
       LIMIT 1`,
      [productId],
    );

    if (nextRows[0]) {
      await execute(
        `UPDATE product_barcodes
         SET is_primary = 1
         WHERE id = ?`,
        [nextRows[0].id],
      );
    }
  }
},
};