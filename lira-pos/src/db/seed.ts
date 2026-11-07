import { query } from "./client";
import { barcodesRepo } from "./repos/barcodes";
import type { BarcodeType } from "../lib/barcode";

/**
 * Development seeding helpers.
 *
 * Nothing in the application imports this module. It is kept because it is
 * occasionally useful from `_Dev.tsx` while working, and migration 019
 * deliberately retired the demo catalogue that used to be created for every
 * installation, so `seedDemoProducts` is a stub that creates nothing: a test
 * that wants a demonstration catalogue calls
 * `test_support::activate_demo_catalogue` instead, which is the one visible
 * place a fixture gets made.
 *
 * GATE 2A. `addProductBarcode` used to be a raw `INSERT INTO product_barcodes`
 * issued straight from here. That was the last `execute()` caller in the
 * frontend and it was also a second writer to a table the catalog commands
 * own: it skipped `add_product_barcode`'s normalisation, its EAN-13 check
 * digit, its uniqueness proof and its primary-barcode handling, so a row
 * written this way could be one no supported path would accept. It now
 * delegates to `barcodesRepo`, which invokes that command — same effect where
 * the data was valid, a refusal where it was not.
 */

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
  return barcodesRepo.addBarcode({
    productId: args.productId,
    barcode: args.barcode,
    barcodeType: args.barcodeType,
    makePrimary: args.isPrimary,
  });
}
