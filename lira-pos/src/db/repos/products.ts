import { execute, query } from "../client";
import { newId } from "../../lib/ids";
import { barcodesRepo } from "./barcodes";
import type {
  BarcodeScanResult,
  Product,
  ProductUom,
  ProductWithUoms,
  VatPricingMode,
  VatRate,
} from "../types";

// ---------- Row shapes ----------

interface ProductRow {
  id: string;
  store_id: string;
  sku: string | null;
  name: string;
  description: string | null;
  vat_rate_id: string;
  vat_pricing_mode: VatPricingMode;
  price_excl_vat_cents: number;
  price_incl_vat_cents: number;
  avg_cost_excl_vat_cents: number;
  avg_cost_incl_vat_cents: number;
  quantity_on_hand: number;
  reorder_point: number | null;
  is_active: number;
  is_service: number;
  created_at: string;
  updated_at: string;
}

interface ProductUomRow {
  id: string;
  product_id: string;
  uom_code: string;
  factor_num: number;
  factor_den: number;
  is_base: number;
  is_default_sale_uom: number;
  is_default_purchase_uom: number;
  is_active: number;
  sale_price_excl_vat_cents: number | null;
  sale_price_incl_vat_cents: number | null;
}

interface VatRateRow {
  id: string;
  name: string;
  rate_bps: number;
  is_exempt: number;
  effective_from: string;
  effective_to: string | null;
}

// ---------- Mappers ----------

function rowToProduct(r: ProductRow): Product {
  return {
    id: r.id,
    storeId: r.store_id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    vatRateId: r.vat_rate_id,
    vatPricingMode: r.vat_pricing_mode,
    priceExclVatCents: r.price_excl_vat_cents,
    priceInclVatCents: r.price_incl_vat_cents,
    avgCostExclVatCents: r.avg_cost_excl_vat_cents,
    avgCostInclVatCents: r.avg_cost_incl_vat_cents,
    quantityOnHand: r.quantity_on_hand,
    reorderPoint: r.reorder_point,
    isActive: r.is_active === 1,
    isService: r.is_service === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProductUom(r: ProductUomRow): ProductUom {
  return {
    id: r.id,
    productId: r.product_id,
    uomCode: r.uom_code,
    factor: { num: r.factor_num, den: r.factor_den },
    isBase: r.is_base === 1,
    isDefaultSale: r.is_default_sale_uom === 1,
    isDefaultPurchase: r.is_default_purchase_uom === 1,
    isActive: r.is_active === 1,
    salePriceExclVatCents: r.sale_price_excl_vat_cents,
    salePriceInclVatCents: r.sale_price_incl_vat_cents,
  };
}

function rowToVatRate(r: VatRateRow): VatRate {
  return {
    id: r.id,
    name: r.name,
    rateBps: r.rate_bps,
    isExempt: r.is_exempt === 1,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

// ---------- Composition helper ----------

async function enrich(p: Product): Promise<ProductWithUoms> {
  const [uomRows, vatRows, primaryBarcode] = await Promise.all([
    query<ProductUomRow>(
      `SELECT id, product_id, uom_code, factor_num, factor_den,
              is_base, is_default_sale_uom, is_default_purchase_uom,
              is_active, sale_price_excl_vat_cents, sale_price_incl_vat_cents
       FROM product_uoms
       WHERE product_id = ? AND is_active = 1
       ORDER BY is_base DESC, is_default_sale_uom DESC, uom_code`,
      [p.id],
    ),
    query<VatRateRow>(
      `SELECT id, name, rate_bps, is_exempt, effective_from, effective_to
       FROM vat_rates WHERE id = ?`,
      [p.vatRateId],
    ),
    barcodesRepo.getPrimaryForProduct(p.id),
  ]);

  const uoms = uomRows.map(rowToProductUom);
  const baseUom = uoms.find((u) => u.isBase);
  const defaultSaleUom = uoms.find((u) => u.isDefaultSale);

  if (!baseUom) {
    throw new Error(`Product ${p.id} (${p.name}) has no base UoM — data corruption`);
  }
  if (!defaultSaleUom) {
    throw new Error(`Product ${p.id} (${p.name}) has no default sale UoM — data corruption`);
  }
  if (!vatRows[0]) {
    throw new Error(`Product ${p.id} (${p.name}) references missing VAT rate ${p.vatRateId}`);
  }

  return {
    ...p,
    uoms,
    baseUom,
    defaultSaleUom,
    primaryBarcode,
    vatRate: rowToVatRate(vatRows[0]),
  };
}

// ---------- Create ----------

export type CreateProductInput = {
  storeId: string;
  name: string;
  sku: string | null;
  description: string | null;
  vatRateId: string;
  vatPricingMode: VatPricingMode;
  /** Pre-computed by the caller using `addVat`/`stripVat` so both sides agree exactly. */
  priceExclVatCents: number;
  priceInclVatCents: number;
  /** UoM code (must exist in units_of_measure). Becomes the product's base UoM with factor (1,1). */
  baseUomCode: string;
  reorderPoint: number | null;
  isService: boolean;
};

/**
 * Thrown when the SKU collides with an existing product in the same store.
 * The UI catches this specifically to highlight the SKU field.
 */
export class DuplicateSkuError extends Error {
  readonly sku: string;
  constructor(sku: string) {
    super(`A product with SKU "${sku}" already exists in this store.`);
    this.name = "DuplicateSkuError";
    this.sku = sku;
  }
}

// ---------- Repo ----------
type ProductListArgs = {
  storeId: string;
  search?: string;
  includeInactive?: boolean;
  limit?: number;
};
export const productsRepo = {
  async findById(id: string): Promise<Product | null> {
    const rows = await query<ProductRow>(
      `SELECT * FROM products WHERE id = ?`,
      [id],
    );
    return rows[0] ? rowToProduct(rows[0]) : null;
  },

  async findByIdEnriched(id: string): Promise<ProductWithUoms | null> {
    const p = await this.findById(id);
    return p ? enrich(p) : null;
  },

  /**
   * List products with optional search. Search matches BOTH name (LIKE) AND
   * barcode (exact, normalized). Barcode hits take priority via match_priority.
   */
  async list(args: ProductListArgs): Promise<Product[]> {
    const includeInactive = args.includeInactive ?? false;
    const limit = args.limit ?? 200;

    if (!args.search || args.search.trim() === "") {
      const rows = await query<ProductRow>(
        `SELECT * FROM products
         WHERE store_id = ? ${includeInactive ? "" : "AND is_active = 1"}
         ORDER BY name
         LIMIT ?`,
        [args.storeId, limit],
      );
      return rows.map(rowToProduct);
    }

    const term = args.search.trim();
    const normalizedTerm = term.toUpperCase();
    const likePattern = `%${term}%`;

    const rows = await query<ProductRow & { match_priority: number }>(
      `SELECT p.*, 1 AS match_priority FROM products p
         JOIN product_barcodes pb ON pb.product_id = p.id
        WHERE p.store_id = ?
          AND pb.lookup_value = ?
          AND pb.is_active = 1
          ${includeInactive ? "" : "AND p.is_active = 1"}
       UNION
       SELECT p.*, 2 AS match_priority FROM products p
        WHERE p.store_id = ?
          AND (p.name LIKE ? OR p.sku LIKE ?)
          ${includeInactive ? "" : "AND p.is_active = 1"}
       ORDER BY match_priority, name
       LIMIT ?`,
      [args.storeId, normalizedTerm, args.storeId, likePattern, likePattern, limit],
    );

    // Dedupe by id (barcode hit wins due to ORDER BY match_priority).
    const seen = new Set<string>();
    const deduped: ProductRow[] = [];
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        deduped.push(r);
      }
    }
    return deduped.map(rowToProduct);
  },

 async listEnriched(args: ProductListArgs): Promise<ProductWithUoms[]> {
  const products = await this.list(args);
  return Promise.all(products.map(enrich));
},
  /** POS scan path: barcode → barcode row → enriched product → resolved UoM. */
  async findByScan(storeId: string, scannedInput: string): Promise<BarcodeScanResult | null> {
    const matchedBarcode = await barcodesRepo.findByScan(storeId, scannedInput);
    if (!matchedBarcode) return null;

    const product = await this.findByIdEnriched(matchedBarcode.productId);
    if (!product) return null;

    const resolvedUom = matchedBarcode.productUomId
      ? product.uoms.find((u) => u.id === matchedBarcode.productUomId) ?? product.defaultSaleUom
      : product.defaultSaleUom;

    return { product, resolvedUom, matchedBarcode };
  },

  async count(storeId: string, opts: { includeInactive?: boolean } = {}): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM products
       WHERE store_id = ?
         ${opts.includeInactive ? "" : "AND is_active = 1"}`,
      [storeId],
    );
    return rows[0]?.n ?? 0;
  },

 /**
   * Create a new product plus its base UoM row.
   *
   * NOTE on atomicity: we do NOT use BEGIN/COMMIT because tauri-plugin-sql's
   * connection pool dispatches each execute() to potentially-different
   * connections, which makes SQL-level transactions unreliable across calls
   * (COMMIT ends up on a connection that never saw BEGIN, raising
   * "cannot commit - no transaction is active").
   *
   * Instead we use a saga pattern: do INSERT 1, then INSERT 2, and if INSERT 2
   * fails we compensate with a DELETE of the product. The `product_uoms`
   * table has `ON DELETE CASCADE` on `product_id`, so the delete cleans up
   * any partial UoM rows automatically.
   *
   * The only window of inconsistency is between the two INSERTs — if the
   * app process dies right there, we'd leave an orphan product. We accept
   * that for now; a periodic integrity check (Phase 5) can scrub orphans.
   */
  async create(input: CreateProductInput): Promise<Product> {
    const productId = newId();
    const baseUomRowId = newId();

    // INSERT 1: the product itself.
    try {
      await execute(
        `INSERT INTO products (
           id, store_id, sku, name, description,
           vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents,
           reorder_point, is_service
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          input.storeId,
          input.sku,
          input.name,
          input.description,
          input.vatRateId,
          input.vatPricingMode,
          input.priceExclVatCents,
          input.priceInclVatCents,
          input.reorderPoint,
          input.isService ? 1 : 0,
        ],
      );
    } catch (e) {
      // Nothing was written; no cleanup needed.
      if (
        e instanceof Error &&
        /UNIQUE constraint failed/i.test(e.message) &&
        /sku/i.test(e.message)
      ) {
        throw new DuplicateSkuError(input.sku ?? "(empty)");
      }
      throw e;
    }

    // INSERT 2: the base UoM. If this fails, compensate by deleting the product.
    try {
      await execute(
        `INSERT INTO product_uoms (
           id, store_id, product_id, uom_code,
           factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active
         ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 1)`,
        [baseUomRowId, input.storeId, productId, input.baseUomCode],
      );
    } catch (e) {
      try {
        await execute(`DELETE FROM products WHERE id = ?`, [productId]);
      } catch {
        // Best effort; surface the original error.
      }
      throw e;
    }

    const created = await this.findById(productId);
    if (!created) {
      throw new Error(
        "Product was created but could not be re-fetched. The database may be in an inconsistent state.",
      );
    }
    return created;
  },
};