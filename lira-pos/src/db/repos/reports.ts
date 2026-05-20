import { query } from "../client";

export interface DailySalesRow {
  localDate: string;
  saleCount: number;
  subtotalExclVatCents: number;
  discountCents: number;
  vatTotalCents: number;
  totalInclVatCents: number;
  cogsTotalCents: number;
}

export interface ProductSalesRow {
  productId: string;
  productName: string;
  productSku: string | null;
  totalQty: number;
  lineSubtotalExclVatCents: number;
  lineDiscountCents: number;
  lineTotalInclVatCents: number;
  lineCogsCents: number;
}

export interface DailyPurchasesRow {
  localDate: string;
  purchaseCount: number;
  subtotalExclVatCents: number;
  vatTotalCents: number;
  totalInclVatCents: number;
}

// sales.posted_at is UTC ISO — convert local date boundaries to UTC ISO strings.
function utcFrom(localDate: string): string {
  return new Date(`${localDate}T00:00:00`).toISOString();
}

function utcTo(localDate: string): string {
  return new Date(`${localDate}T23:59:59.999`).toISOString();
}

export const reportsRepo = {
  async dailySales(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<DailySalesRow[]> {
    interface Row {
      local_date: string;
      sale_count: number;
      subtotal_excl_vat_cents: number;
      discount_cents: number;
      vat_total_cents: number;
      total_incl_vat_cents: number;
      cogs_total_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         date(posted_at, 'localtime') AS local_date,
         COUNT(*) AS sale_count,
         SUM(subtotal_excl_vat_cents) AS subtotal_excl_vat_cents,
         SUM(discount_cents) AS discount_cents,
         SUM(vat_total_cents) AS vat_total_cents,
         SUM(total_incl_vat_cents) AS total_incl_vat_cents,
         SUM(cogs_total_cents) AS cogs_total_cents
       FROM sales
       WHERE store_id = ?
         AND status = 'posted'
         AND posted_at >= ?
         AND posted_at <= ?
       GROUP BY local_date
       ORDER BY local_date ASC`,
      [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
    );

    return rows.map((r) => ({
      localDate: r.local_date,
      saleCount: r.sale_count,
      subtotalExclVatCents: r.subtotal_excl_vat_cents,
      discountCents: r.discount_cents,
      vatTotalCents: r.vat_total_cents,
      totalInclVatCents: r.total_incl_vat_cents,
      cogsTotalCents: r.cogs_total_cents,
    }));
  },

  async productSales(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<ProductSalesRow[]> {
    interface Row {
      product_id: string;
      product_name: string;
      product_sku: string | null;
      total_qty: number;
      line_subtotal_excl_vat_cents: number;
      line_discount_cents: number;
      line_total_incl_vat_cents: number;
      line_cogs_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         si.product_id,
         si.product_name_snapshot AS product_name,
         si.product_sku_snapshot AS product_sku,
         SUM(si.quantity) AS total_qty,
         SUM(si.line_subtotal_excl_vat_cents) AS line_subtotal_excl_vat_cents,
         SUM(si.line_discount_cents) AS line_discount_cents,
         SUM(si.line_total_incl_vat_cents) AS line_total_incl_vat_cents,
         SUM(si.line_cogs_excl_vat_cents) AS line_cogs_cents
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.store_id = ?
         AND s.status = 'posted'
         AND s.posted_at >= ?
         AND s.posted_at <= ?
       GROUP BY si.product_id, si.product_name_snapshot, si.product_sku_snapshot
       ORDER BY line_total_incl_vat_cents DESC`,
      [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
    );

    return rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      productSku: r.product_sku,
      totalQty: r.total_qty,
      lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
      lineDiscountCents: r.line_discount_cents,
      lineTotalInclVatCents: r.line_total_incl_vat_cents,
      lineCogsCents: r.line_cogs_cents,
    }));
  },

  // purchases.purchase_date is local YYYY-MM-DD — filter directly.
  async dailyPurchases(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<DailyPurchasesRow[]> {
    interface Row {
      purchase_date: string;
      purchase_count: number;
      subtotal_excl_vat_cents: number;
      vat_total_cents: number;
      total_incl_vat_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         purchase_date,
         COUNT(*) AS purchase_count,
         SUM(subtotal_excl_vat_cents) AS subtotal_excl_vat_cents,
         SUM(vat_total_cents) AS vat_total_cents,
         SUM(total_incl_vat_cents) AS total_incl_vat_cents
       FROM purchases
       WHERE store_id = ?
         AND status = 'posted'
         AND purchase_date >= ?
         AND purchase_date <= ?
       GROUP BY purchase_date
       ORDER BY purchase_date ASC`,
      [args.storeId, args.dateFrom, args.dateTo],
    );

    return rows.map((r) => ({
      localDate: r.purchase_date,
      purchaseCount: r.purchase_count,
      subtotalExclVatCents: r.subtotal_excl_vat_cents,
      vatTotalCents: r.vat_total_cents,
      totalInclVatCents: r.total_incl_vat_cents,
    }));
  },
};
