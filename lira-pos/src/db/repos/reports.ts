/**
 * Reporting read models.
 *
 * THE CANONICAL REPORTING VOCABULARY. Stated here because every screen that
 * shows money is downstream of this file; the long form, with the invariants,
 * is in tests/README.md › "Canonical reporting vocabulary".
 *
 * What the persisted sale header MEANS (WP-02 `posting.rs::prepare_sale`):
 * `post_sale` sums line values the register has ALREADY discounted
 * (`lib/discount.ts::postDiscountLineTotals`), so
 *
 *   subtotal_excl_vat_cents  post-discount revenue excl. VAT
 *   vat_total_cents          post-discount output VAT
 *   total_incl_vat_cents     what the customer owed  (== subtotal + VAT, checked)
 *   discount_cents           INFORMATIONAL — already out of all three
 *   cogs_total_cents         cost of the goods that left
 *
 * So a report must NEVER subtract `discount_cents` from a sales total: that was
 * GP-A04, and it understated net sales and margin by the whole discount.
 * Discount is reportable on its own and nowhere else.
 *
 * GROSS means BEFORE RETURNS, not before discounts — there is no pre-discount
 * figure persisted on the header, and every label in the app that says "gross"
 * already sits on a post-discount column. NET means after returns. Returns live
 * in their own documents (migration 011) and are their own series here, never
 * folded into the sales aggregate: `saleCount` must keep counting sales, and
 * only the memo knows whether the goods came back.
 *
 *   net revenue incl. VAT = dailySales.totalInclVatCents    − dailyReturns.totalInclVatCents
 *   net sales   excl. VAT = dailySales.subtotalExclVatCents − dailyReturns.subtotalExclVatCents
 *   net VAT               = dailySales.vatTotalCents        − dailyReturns.vatTotalCents
 *   net COGS              = dailySales.cogsTotalCents       − dailyReturns.cogsReversedCents
 *   gross profit          = net sales excl. VAT − net COGS
 *
 * `cogsReversedCents` counts RESTOCKED lines only, which is what makes one
 * formula right for both return policies: a write-off reverses the revenue and
 * leaves the cost consumed, losing its whole margin, which is the truth about
 * discarded food.
 *
 * POPULATION: `status = 'posted'` everywhere, which excludes both the voided
 * documents and the drafts that WP-07's draft-then-promote commands hold
 * mid-transaction. Every figure is integer cents, summed in SQL; formatting to
 * dollars happens at the presentation boundary and nowhere earlier.
 */
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
  /**
   * The line's own SNAPSHOT name and SKU — what the product was called when it
   * sold, never what it is called today.
   *
   * These are a DISPLAY dimension, not an aggregation key. This query groups by
   * the snapshot triple, so a product renamed or re-SKU'd between two sales
   * legitimately comes back as SEVERAL rows for one `productId`, each carrying
   * its own historical label. `lib/reportMath.ts::mergeProductRows` sums them
   * into one row per product and picks one label; nothing numeric may depend on
   * that choice.
   */
  productName: string;
  productSku: string | null;
  /**
   * The latest `posted_at` of any sale in this snapshot group, which is how the
   * composition step decides WHICH historical label to show: the most recent
   * one. Carried rather than joined to `products` so the label stays a
   * snapshot, consistent with every other figure on a product report.
   */
  latestPostedAt: string;
  totalQty: number;
  lineSubtotalExclVatCents: number;
  lineDiscountCents: number;
  lineTotalInclVatCents: number;
  lineCogsCents: number;
}

/**
 * Returns for one local day. ADDITIVE: the sales rows above stay GROSS, and
 * net sales are gross less these — so a report can show all three figures and
 * nothing that existed before this work package changed meaning.
 */
export interface DailyReturnsRow {
  localDate: string;
  memoCount: number;
  subtotalExclVatCents: number;
  vatTotalCents: number;
  discountCents: number;
  totalInclVatCents: number;
  /** COGS put back into inventory — restocked lines only. */
  cogsReversedCents: number;
}

/**
 * Returns per product, shaped exactly like `ProductSalesRow` so the two series
 * compose symmetrically.
 *
 * Grouped by the same snapshot triple for the same reason, and with the same
 * consequence: one `productId` may come back as several rows. The snapshots are
 * carried so a product returned in a period it was not SOLD in can still be
 * named — `productSales` has no row for it at all, and dropping the return
 * would stop the product table reconciling to the headline.
 */
export interface ProductReturnsRow {
  productId: string;
  productName: string;
  productSku: string | null;
  /** Latest `posted_at` of any credit memo in this snapshot group. */
  latestPostedAt: string;
  totalQty: number;
  lineSubtotalExclVatCents: number;
  lineTotalInclVatCents: number;
  /** Reversed COGS, which is zero for a line that was written off. */
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
      latest_posted_at: string;
      total_qty: number;
      line_subtotal_excl_vat_cents: number;
      line_discount_cents: number;
      line_total_incl_vat_cents: number;
      line_cogs_cents: number;
    }

    // Grouped by the snapshot triple, so a product renamed between two sales
    // returns SEVERAL rows — one per historical label — each with its own
    // correct economics. That is deliberate: the snapshot is what the receipt
    // said. Collapsing them into one product row is the composition step's job
    // (`lib/reportMath.ts::mergeProductRows`), and it sums every row sharing a
    // `product_id` rather than letting one label's figures stand for the lot.
    const rows = await query<Row>(
      `SELECT
         si.product_id,
         si.product_name_snapshot AS product_name,
         si.product_sku_snapshot AS product_sku,
         MAX(s.posted_at) AS latest_posted_at,
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
      latestPostedAt: r.latest_posted_at,
      totalQty: r.total_qty,
      lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
      lineDiscountCents: r.line_discount_cents,
      lineTotalInclVatCents: r.line_total_incl_vat_cents,
      lineCogsCents: r.line_cogs_cents,
    }));
  },

  /**
   * Returns per local day, keyed the same way `dailySales` is so the two join
   * on `localDate`.
   *
   * WHY THIS IS A SEPARATE QUERY, AND NOT A SIGN FLIP INSIDE `dailySales`.
   * A credit memo is its own document (migration 011): it is not a negative
   * sale and its lines are not in `sale_items`. Folding it into the sales
   * aggregate would silently restate `saleCount`, and would lose the one
   * distinction that matters for profit — whether the goods came back.
   *
   * `cogsReversedCents` counts only RESTOCKED lines, which is what makes the
   * profit arithmetic correct for both policies at once:
   *
   *   restocked:     revenue reversed AND the returned cost reversed
   *   not restocked: revenue reversed, the cost stays consumed
   *
   * so net profit = (gross net sales − returned net) − (gross COGS − reversed).
   */
  async dailyReturns(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<DailyReturnsRow[]> {
    interface Row {
      local_date: string;
      memo_count: number;
      subtotal_excl_vat_cents: number;
      vat_total_cents: number;
      discount_cents: number;
      total_incl_vat_cents: number;
      cogs_reversed_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         date(posted_at, 'localtime') AS local_date,
         COUNT(*) AS memo_count,
         COALESCE(SUM(subtotal_excl_vat_cents), 0) AS subtotal_excl_vat_cents,
         COALESCE(SUM(vat_total_cents), 0)         AS vat_total_cents,
         COALESCE(SUM(discount_cents), 0)          AS discount_cents,
         COALESCE(SUM(total_incl_vat_cents), 0)    AS total_incl_vat_cents,
         COALESCE(SUM(cogs_reversed_cents), 0)     AS cogs_reversed_cents
       FROM sales_credit_memos
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
      memoCount: r.memo_count,
      subtotalExclVatCents: r.subtotal_excl_vat_cents,
      vatTotalCents: r.vat_total_cents,
      discountCents: r.discount_cents,
      totalInclVatCents: r.total_incl_vat_cents,
      cogsReversedCents: r.cogs_reversed_cents,
    }));
  },

  /** Returns per product, to net off `productSales` row for row. */
  async productReturns(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<ProductReturnsRow[]> {
    interface Row {
      product_id: string;
      product_name: string;
      product_sku: string | null;
      latest_posted_at: string;
      total_qty: number;
      line_subtotal_excl_vat_cents: number;
      line_total_incl_vat_cents: number;
      line_cogs_cents: number;
    }

    // Grouped by the SAME snapshot triple `productSales` uses, so the two
    // series have one shape and compose symmetrically. This used to group by
    // `product_id` alone with the label taken as `MAX(name)` — which kept the
    // money right, but made the two sides disagree about what a row IS and
    // relied on the composition step treating this one as pre-collapsed. Now
    // either side may split, the composition sums both, and the label rule is
    // stated in exactly one place.
    const rows = await query<Row>(
      `SELECT
         l.product_id,
         l.product_name_snapshot AS product_name,
         l.product_sku_snapshot  AS product_sku,
         MAX(m.posted_at)        AS latest_posted_at,
         SUM(l.quantity_base) AS total_qty,
         SUM(l.line_subtotal_excl_vat_cents) AS line_subtotal_excl_vat_cents,
         SUM(l.line_total_incl_vat_cents)    AS line_total_incl_vat_cents,
         SUM(l.line_cogs_excl_vat_cents)     AS line_cogs_cents
       FROM sales_credit_memo_lines l
       JOIN sales_credit_memos m ON m.id = l.credit_memo_id
       WHERE m.store_id = ?
         AND m.status = 'posted'
         AND m.posted_at >= ?
         AND m.posted_at <= ?
       GROUP BY l.product_id, l.product_name_snapshot, l.product_sku_snapshot`,
      [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
    );

    return rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      productSku: r.product_sku,
      latestPostedAt: r.latest_posted_at,
      totalQty: r.total_qty,
      lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
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
