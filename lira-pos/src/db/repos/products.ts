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
  BarcodeType,
} from "../types";
import type { Factor } from "../../lib/uom";

export class DuplicateSkuError extends Error {
  constructor() {
    super("Duplicate SKU");
    this.name = "DuplicateSkuError";
  }
}

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

type ProductListArgs = {
  storeId: string;
  search?: string;
  includeInactive?: boolean;
  limit?: number;
};

type ProductCreateArgs = {
  storeId: string;
  sku: string | null;
  name: string;
  description: string | null;
  vatRateId: string;
  vatPricingMode: VatPricingMode;
  priceExclVatCents: number;
  priceInclVatCents: number;
  avgCostExclVatCents: number;
  avgCostInclVatCents: number;
  quantityOnHand: number;
  reorderPoint: number | null;
  isService: boolean;
  barcode?: string | null;
  barcodeType?: BarcodeType | null;
  baseUomCode: string;
  saleUomCode: string;
  saleFactor: Factor;
  salePriceExclVatCents: number | null;
  salePriceInclVatCents: number | null;
};

type ProductUpdateArgs = {
  sku: string | null;
  name: string;
  description: string | null;
  vatRateId: string;
  vatPricingMode: VatPricingMode;
  priceExclVatCents: number;
  priceInclVatCents: number;
  avgCostExclVatCents: number;
  avgCostInclVatCents: number;
  quantityOnHand: number;
  reorderPoint: number | null;
  isService: boolean;
  isActive: boolean;
};

type ProductAddUomArgs = {
  productId: string;
  uomCode: string;
  factor: Factor;
  isDefaultSale: boolean;
  isDefaultPurchase: boolean;
  salePriceExclVatCents: number | null;
  salePriceInclVatCents: number | null;
};

type ProductUpdateUomArgs = {
  factor: Factor;
  isDefaultSale: boolean;
  salePriceExclVatCents: number | null;
  salePriceInclVatCents: number | null;
};

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

function isDuplicateSkuError(e: unknown): boolean {
  return (
    e instanceof Error &&
    e.message.includes("UNIQUE constraint failed") &&
    e.message.includes("products")
  );
}

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
    throw new Error(`Product ${p.id} (${p.name}) has no base UoM.`);
  }

  if (!defaultSaleUom) {
    throw new Error(`Product ${p.id} (${p.name}) has no default sale UoM.`);
  }

  if (!vatRows[0]) {
    throw new Error(
      `Product ${p.id} (${p.name}) references missing VAT rate ${p.vatRateId}`,
    );
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

  async list(args: ProductListArgs): Promise<Product[]> {
    const includeInactive = args.includeInactive ?? false;
    const limit = args.limit ?? 200;

    if (!args.search || args.search.trim() === "") {
      const rows = await query<ProductRow>(
        `SELECT * FROM products
         WHERE store_id = ?
         ${includeInactive ? "" : "AND is_active = 1"}
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

  async findByScan(
    storeId: string,
    scannedInput: string,
  ): Promise<BarcodeScanResult | null> {
    const matchedBarcode = await barcodesRepo.findByScan(storeId, scannedInput);
    if (!matchedBarcode) return null;

    const product = await this.findByIdEnriched(matchedBarcode.productId);
    if (!product) return null;

    const resolvedUom = matchedBarcode.productUomId
      ? product.uoms.find((u) => u.id === matchedBarcode.productUomId) ??
        product.defaultSaleUom
      : product.defaultSaleUom;

    return { product, resolvedUom, matchedBarcode };
  },

  async count(
    storeId: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM products
       WHERE store_id = ?
       ${opts.includeInactive ? "" : "AND is_active = 1"}`,
      [storeId],
    );

    return rows[0]?.n ?? 0;
  },

  async create(args: ProductCreateArgs): Promise<ProductWithUoms> {
    const productId = newId();

    try {
      await execute(
        `INSERT INTO products (
           id, store_id, sku, name, description,
           vat_rate_id, vat_pricing_mode,
           price_excl_vat_cents, price_incl_vat_cents,
           avg_cost_excl_vat_cents, avg_cost_incl_vat_cents,
           quantity_on_hand, reorder_point,
           is_active, is_service
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          productId,
          args.storeId,
          args.sku,
          args.name,
          args.description,
          args.vatRateId,
          args.vatPricingMode,
          args.priceExclVatCents,
          args.priceInclVatCents,
          args.avgCostExclVatCents,
          args.avgCostInclVatCents,
          args.quantityOnHand,
          args.reorderPoint,
          args.isService ? 1 : 0,
        ],
      );
    } catch (e) {
      if (isDuplicateSkuError(e)) throw new DuplicateSkuError();
      throw e;
    }

    const baseUomId = newId();

    if (args.baseUomCode === args.saleUomCode) {
      await execute(
        `INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
           sale_price_excl_vat_cents, sale_price_incl_vat_cents
         ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 1, ?, ?)`,
        [
          baseUomId,
          args.storeId,
          productId,
          args.baseUomCode,
          args.salePriceExclVatCents,
          args.salePriceInclVatCents,
        ],
      );
    } else {
      await execute(
        `INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
           sale_price_excl_vat_cents, sale_price_incl_vat_cents
         ) VALUES (?, ?, ?, ?, 1, 1, 1, 0, 1, 1, NULL, NULL)`,
        [baseUomId, args.storeId, productId, args.baseUomCode],
      );

      await execute(
        `INSERT INTO product_uoms (
           id, store_id, product_id, uom_code, factor_num, factor_den,
           is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
           sale_price_excl_vat_cents, sale_price_incl_vat_cents
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, 1, ?, ?)`,
        [
          newId(),
          args.storeId,
          productId,
          args.saleUomCode,
          args.saleFactor.num,
          args.saleFactor.den,
          args.salePriceExclVatCents,
          args.salePriceInclVatCents,
        ],
      );
    }

    if (args.barcode) {
      await barcodesRepo.addBarcode({
        productId,
        barcode: args.barcode,
        barcodeType: args.barcodeType ?? undefined,
        makePrimary: true,
      });
    }

    const created = await this.findByIdEnriched(productId);

    if (!created) {
      throw new Error("Product was created but could not be loaded.");
    }

    return created;
  },

  async update(id: string, args: ProductUpdateArgs): Promise<void> {
    try {
      await execute(
        `UPDATE products
            SET sku = ?,
                name = ?,
                description = ?,
                vat_rate_id = ?,
                vat_pricing_mode = ?,
                price_excl_vat_cents = ?,
                price_incl_vat_cents = ?,
                avg_cost_excl_vat_cents = ?,
                avg_cost_incl_vat_cents = ?,
                quantity_on_hand = ?,
                reorder_point = ?,
                is_service = ?,
                is_active = ?
          WHERE id = ?`,
        [
          args.sku,
          args.name,
          args.description,
          args.vatRateId,
          args.vatPricingMode,
          args.priceExclVatCents,
          args.priceInclVatCents,
          args.avgCostExclVatCents,
          args.avgCostInclVatCents,
          args.quantityOnHand,
          args.reorderPoint,
          args.isService ? 1 : 0,
          args.isActive ? 1 : 0,
          id,
        ],
      );
    } catch (e) {
      if (isDuplicateSkuError(e)) throw new DuplicateSkuError();
      throw e;
    }
  },

  async addUom(args: ProductAddUomArgs): Promise<{ id: string }> {
    const id = newId();

    const productRows = await query<{ store_id: string }>(
      `SELECT store_id FROM products WHERE id = ?`,
      [args.productId],
    );

    const storeId = productRows[0]?.store_id;

    if (!storeId) {
      throw new Error("Product not found while adding UoM.");
    }

    if (args.isDefaultSale) {
      await execute(
        `UPDATE product_uoms
         SET is_default_sale_uom = 0
         WHERE product_id = ?`,
        [args.productId],
      );
    }

    if (args.isDefaultPurchase) {
      await execute(
        `UPDATE product_uoms
         SET is_default_purchase_uom = 0
         WHERE product_id = ?`,
        [args.productId],
      );
    }

    await execute(
      `INSERT INTO product_uoms (
         id, store_id, product_id, uom_code, factor_num, factor_den,
         is_base, is_default_sale_uom, is_default_purchase_uom, is_active,
         sale_price_excl_vat_cents, sale_price_incl_vat_cents
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`,
      [
        id,
        storeId,
        args.productId,
        args.uomCode,
        args.factor.num,
        args.factor.den,
        args.isDefaultSale ? 1 : 0,
        args.isDefaultPurchase ? 1 : 0,
        args.salePriceExclVatCents,
        args.salePriceInclVatCents,
      ],
    );

    return { id };
  },

  async updateUom(id: string, args: ProductUpdateUomArgs): Promise<void> {
    const rows = await query<{ product_id: string }>(
      `SELECT product_id FROM product_uoms WHERE id = ?`,
      [id],
    );

    const productId = rows[0]?.product_id;

    if (!productId) {
      throw new Error("Product UoM not found.");
    }

    if (args.isDefaultSale) {
      await execute(
        `UPDATE product_uoms
         SET is_default_sale_uom = 0
         WHERE product_id = ?`,
        [productId],
      );
    }

    await execute(
      `UPDATE product_uoms
          SET factor_num = ?,
              factor_den = ?,
              is_default_sale_uom = ?,
              sale_price_excl_vat_cents = ?,
              sale_price_incl_vat_cents = ?
        WHERE id = ?`,
      [
        args.factor.num,
        args.factor.den,
        args.isDefaultSale ? 1 : 0,
        args.salePriceExclVatCents,
        args.salePriceInclVatCents,
        id,
      ],
    );
  },
};