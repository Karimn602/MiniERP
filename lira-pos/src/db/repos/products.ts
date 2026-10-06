import { invoke } from "@tauri-apps/api/core";
import { query } from "../client";
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

export class DuplicateBarcodeError extends Error {
  constructor() {
    super("Duplicate barcode");
    this.name = "DuplicateBarcodeError";
  }
}

/**
 * Raised when a stocked product with stock on the shelf is being turned into a
 * service. `quantityOnHand` is what the backend found.
 *
 * A metadata edit may not decide inventory (WP-07, GZ-HI-10): the operator
 * writes the stock off through the inventory-adjustment flow, which records the
 * movement, and only then reclassifies the product.
 */
export class StockedToServiceError extends Error {
  readonly quantityOnHand: number;
  constructor(quantityOnHand: number) {
    super(`Product still holds ${quantityOnHand} in stock`);
    this.name = "StockedToServiceError";
    this.quantityOnHand = quantityOnHand;
  }
}

/**
 * Translate a `save_product` / barcode-command refusal into the typed errors
 * the UI already branches on. The backend reports these by SENTINEL rather than
 * by a driver message, so this never has to sniff SQLite error text.
 */
function translateCatalogError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("DUPLICATE_SKU")) throw new DuplicateSkuError();
  if (message.includes("DUPLICATE_BARCODE")) throw new DuplicateBarcodeError();
  const stocked = message.match(/STOCKED_TO_SERVICE_WITH_STOCK:(-?\d+)/);
  if (stocked) throw new StockedToServiceError(Number(stocked[1]));
  throw e instanceof Error ? e : new Error(message);
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
  avg_cost_excl_vat_microcents: number;
  avg_cost_incl_vat_microcents: number;
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

/**
 * Everything a catalog save may write — and nothing else.
 *
 * NOTE WHAT IS ABSENT: `quantityOnHand` and the `avgCost*` fields. They used to
 * be on both the create and the update DTO, and the generic `UPDATE products`
 * wrote them, which is how ticking "service" on a product with ten units on the
 * shelf destroyed ten units of stock with no `inventory_movements` row behind
 * it (WP-07, GZ-HI-10). Stock and cost belong exclusively to the posting and
 * adjustment commands, which always write a movement alongside them, so
 * `SUM(inventory_movements.quantity_delta)` keeps reconciling to
 * `products.quantity_on_hand`.
 *
 * The authority is REMOVED rather than merely unused: there is no field here to
 * fill in, so no future caller can reintroduce it by accident.
 */
export type ProductSaveArgs = {
  /** "create" mints a new product; "update" needs `productId`. */
  mode: "create" | "update";
  /** Required for an update. Ignored (a fresh id is minted) for a create. */
  productId?: string;
  storeId: string;
  sku: string | null;
  name: string;
  description: string | null;
  vatRateId: VatPricingMode extends never ? never : string;
  vatPricingMode: VatPricingMode;
  priceExclVatCents: number;
  priceInclVatCents: number;
  reorderPoint: number | null;
  isService: boolean;
  /** Create defaults to active; an update states it. */
  isActive?: boolean;
  baseUomCode: string;
  saleUomCode: string;
  saleFactor: Factor;
  salePriceExclVatCents: number | null;
  salePriceInclVatCents: number | null;
  /** An optional first barcode. Create only. */
  barcode?: string | null;
  barcodeType?: BarcodeType | null;
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
    avgCostExclVatMicrocents: r.avg_cost_excl_vat_microcents,
    avgCostInclVatMicrocents: r.avg_cost_incl_vat_microcents,
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

export interface InventoryValuationRow {
  productId: string;
  name: string;
  sku: string | null;
  quantityOnHand: number;
  /**
   * Costs here are RATES in microcents, not amounts in cents: an inventory
   * valuation of a gram-stocked ingredient has to multiply by the precise rate
   * before it rounds, or a whole shelf of flour is worth $0.00 (GP-A03).
   */
  avgCostExclVatMicrocents: number;
  lastPurchaseCostExclVatMicrocents: number | null;
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

  async nextAutoSku(storeId: string): Promise<string> {
    const rows = await query<{ n: number }>(
      `SELECT MAX(CAST(SUBSTR(sku, 6) AS INTEGER)) AS n
       FROM products
       WHERE store_id = ? AND sku LIKE 'Item-%' AND LENGTH(sku) = 10`,
      [storeId],
    );
    const next = (rows[0]?.n ?? 0) + 1;
    return `Item-${String(next).padStart(5, "0")}`;
  },

  /**
   * Create or edit a product, its unit-of-measure configuration and (on create)
   * its first barcode — as ONE transaction.
   *
   * Transactional, in Rust (WP-07, GZ-HI-09). This used to be two to four
   * separate `execute()` calls dispatched across tauri-plugin-sql's connection
   * pool, where there is no usable BEGIN/COMMIT, so an ordinary duplicate SKU
   * or duplicate barcode could leave a product with no base UoM or no default
   * sale UoM — a catalog object `enrich` then REFUSES to load, which breaks the
   * product list for everything else too. `save_product` commits all of it or
   * none of it.
   *
   * Returns the saved product, read back after the commit, so the caller never
   * has to reason about a partially-applied edit.
   */
  async save(args: ProductSaveArgs): Promise<ProductWithUoms> {
    const productId =
      args.mode === "create" ? newId() : (args.productId ?? "");
    if (args.mode === "update" && !productId) {
      throw new Error("An update needs a product id.");
    }

    try {
      await invoke<{ productId: string }>("save_product", {
        payload: {
          productId,
          storeId: args.storeId,
          mode: args.mode,
          sku: args.sku,
          name: args.name,
          description: args.description,
          vatRateId: args.vatRateId,
          vatPricingMode: args.vatPricingMode,
          priceExclVatCents: args.priceExclVatCents,
          priceInclVatCents: args.priceInclVatCents,
          reorderPoint: args.reorderPoint,
          isService: args.isService,
          isActive: args.isActive ?? true,
          baseUomCode: args.baseUomCode,
          saleUomCode: args.saleUomCode,
          saleFactorNum: args.saleFactor.num,
          saleFactorDen: args.saleFactor.den,
          salePriceExclVatCents: args.salePriceExclVatCents,
          salePriceInclVatCents: args.salePriceInclVatCents,
          barcode: args.mode === "create" ? (args.barcode ?? null) : null,
          barcodeType: args.mode === "create" ? (args.barcodeType ?? null) : null,
        },
      });
    } catch (e) {
      translateCatalogError(e);
    }

    const saved = await this.findByIdEnriched(productId);
    if (!saved) {
      throw new Error("Product was saved but could not be loaded.");
    }
    return saved;
  },

  async listForValuation(storeId: string): Promise<InventoryValuationRow[]> {
    interface ValRow {
      product_id: string;
      name: string;
      sku: string | null;
      quantity_on_hand: number;
      avg_cost_excl_vat_microcents: number;
      last_purchase_cost_excl_vat_microcents: number | null;
    }
    const rows = await query<ValRow>(
      `SELECT
         p.id              AS product_id,
         p.name,
         p.sku,
         p.quantity_on_hand,
         p.avg_cost_excl_vat_microcents,
         (
           SELECT pi.unit_cost_excl_vat_base_microcents
           FROM purchase_items pi
           JOIN purchases pur ON pur.id = pi.purchase_id
           WHERE pi.product_id = p.id
             AND pur.store_id  = p.store_id
             AND pur.status    = 'posted'
           ORDER BY pur.posted_at DESC, pur.id DESC
           LIMIT 1
         ) AS last_purchase_cost_excl_vat_microcents
       FROM products p
       WHERE p.store_id  = ?
         AND p.is_active  = 1
         AND p.is_service = 0
       ORDER BY p.name
       LIMIT 500`,
      [storeId],
    );
    return rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      sku: r.sku,
      quantityOnHand: r.quantity_on_hand,
      avgCostExclVatMicrocents: r.avg_cost_excl_vat_microcents,
      lastPurchaseCostExclVatMicrocents: r.last_purchase_cost_excl_vat_microcents,
    }));
  },
};