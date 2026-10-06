import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
import {
  normalizeBarcode,
  type BarcodeType,
} from "../../lib/barcode";
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
  async findByScan(
    storeId: string,
    scannedInput: string,
  ): Promise<ProductBarcode | null> {
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

  /**
   * Add a barcode to a product, promoting it to primary as one step.
   *
   * Transactional, in Rust (WP-07, GZ-HI-09). Promoting used to be "demote
   * every current primary" followed by a separate INSERT, and the schema allows
   * only one primary (`uq_product_barcodes_one_primary`) — so a duplicate
   * barcode between those two statements left the product with barcodes and no
   * primary, which means nothing to print on a label.
   *
   * `makePrimary` defaults to "yes if this is the product's first barcode",
   * which is the rule this repo already had.
   */
  async addBarcode(args: {
    productId: string;
    barcode: string;
    barcodeType?: BarcodeType | null;
    makePrimary?: boolean;
    /** Accepted for call-site compatibility; the command does not set it. */
    productUomId?: string | null;
  }): Promise<{ id: string }> {
    return invoke<{ id: string }>("add_product_barcode", {
      payload: {
        productId: args.productId,
        barcode: args.barcode,
        barcodeType: args.barcodeType ?? null,
        makePrimary: args.makePrimary ?? null,
      },
    });
  },

  /**
   * Make one of a product's barcodes its primary.
   *
   * Transactional: demote-then-promote is one step, so a failure cannot leave
   * the product with no primary at all.
   */
  async setPrimary(productId: string, barcodeId: string): Promise<void> {
    return invoke("set_primary_product_barcode", {
      payload: { productId, barcodeId },
    });
  },

  /**
   * Deactivate a barcode and, if it was the primary, promote the oldest
   * survivor — as one transaction, so a product never ends up with barcodes
   * and no primary. The last barcode cannot be removed.
   *
   * Takes the product id as well as the barcode id because the command scopes
   * every statement by both; the old signature derived the product with a
   * separate read.
   */
  async remove(productId: string, barcodeId: string): Promise<void> {
    return invoke("remove_product_barcode", {
      payload: { productId, barcodeId },
    });
  },

  async deactivate(productId: string, barcodeId: string): Promise<void> {
    return this.remove(productId, barcodeId);
  },
};