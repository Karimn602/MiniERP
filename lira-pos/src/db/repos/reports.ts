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
import type { DriverSettlementRow } from "../../lib/driverCollection";
import { normalizeCogsSource, type CogsSource } from "../../lib/standardCost";

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

/**
 * One `cogs_source` bucket of the posted sale lines in a period (WP-B1).
 *
 * This is the "cost completeness" series, and it exists because a gross-profit
 * figure alone cannot be read honestly. Every line in this application is
 * costed at SOMETHING, and before migration 020 a line costed at nothing
 * looked identical to one costed at zero on purpose: both printed $0.00 and
 * both produced a 100% margin. The buckets separate them.
 *
 * It is a SERIES BESIDE the sales figures, exactly as returns are, and for the
 * same reason: it is not folded into any total, so no existing number changes
 * meaning. `lineSubtotalExclVatCents` and `lineCogsExclVatCents` here are the
 * same columns `productSales` sums, scoped the same way, so the buckets add up
 * to the period's gross figures and the panel cannot disagree with the KPI
 * cards above it.
 */
export interface CogsCoverageRow {
  /** `null` for lines posted before migration 020 existed. */
  source: CogsSource | null;
  lineCount: number;
  /** Base units sold on those lines. */
  totalQty: number;
  lineSubtotalExclVatCents: number;
  lineCogsExclVatCents: number;
  /**
   * How many of those lines carry a COGS rate of exactly zero.
   *
   * Reported per bucket rather than summed, because a zero means something
   * different in each: in `standard` it is the owner's deliberate assertion;
   * in `uncosted` it is the absence of an answer; in `purchase_average` it is
   * a receipt that stated zero, since WP-B1's P1-A correction records a
   * product with no valuation basis at all as `uncosted` instead.
   */
  zeroRateLineCount: number;
  /**
   * The lines of this bucket whose persisted COGS snapshot is NOT zero, and
   * the revenue earned on them.
   *
   * This exists for ONE bucket: `source === null`. A legacy line was posted
   * before migration 020 and carries no provenance, but it does carry the COGS
   * figure it was posted with — and that figure is what a gross-profit number
   * is actually built from. Reporting every NULL-source line as uncosted
   * claimed a cost was missing while the cost sat in the row, and told the
   * owner their profit was overstated when the arithmetic behind it was
   * complete. So presence-of-cost and knowledge-of-source are measured
   * separately, and only the NULL bucket needs the former: every other bucket
   * states its own answer.
   *
   * Both persisted forms are consulted — the authoritative microcent rate and
   * the line's rounded money — so a legacy row written by any path counts as
   * cost-bearing if either says a cost was recorded.
   */
  costBearingLineCount: number;
  costBearingSubtotalExclVatCents: number;
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
  /**
   * Sales by CHANNEL over a period — counts, gross, and refunds (WP-4).
   *
   * ## Why gross and refunds come from one query each, side by side
   *
   * A return is its own document (`sales_credit_memos`), and the sale it
   * reverses stands exactly as posted — so a channel's refunds cannot be read
   * off `sales` at all. They are summed from the memos that point at that
   * channel's sales, which is also what attributes a refund to the channel of
   * the ORDER it reverses rather than to wherever the customer happened to
   * bring it back. An online order refunded at the counter is still an online
   * order going wrong.
   *
   * Both halves are aggregated BY channel in SQL and then combined in
   * `buildChannelMix`, whose totals are summed from these same rows. That is
   * deliberate: reading the overall total from a separate query over `sales`
   * is exactly how a channel report comes to disagree with the sales report
   * printed beside it. The parts here cannot fail to add up to the whole,
   * because the whole is the sum of the parts.
   *
   * `status = 'posted'` on both sides, and no `sale_type` filter — matching
   * every other financial read model in the application (see the note on
   * returns in CLAUDE.md).
   */
  async salesByChannel(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<
    { channel: string; orderCount: number; grossInclVatCents: number; refundedInclVatCents: number }[]
  > {
    interface GrossRow {
      channel: string;
      order_count: number;
      gross_incl_vat_cents: number;
    }
    interface RefundRow {
      channel: string;
      refunded_incl_vat_cents: number;
    }

    const [gross, refunds] = await Promise.all([
      query<GrossRow>(
        `SELECT
           channel,
           COUNT(*) AS order_count,
           COALESCE(SUM(total_incl_vat_cents), 0) AS gross_incl_vat_cents
         FROM sales
         WHERE store_id = ?
           AND status = 'posted'
           AND posted_at >= ?
           AND posted_at <= ?
         GROUP BY channel`,
        [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
      ),
      // Attributed to the channel of the ORIGINAL sale, and dated by the
      // MEMO's own posting time — a refund belongs to the period it was given
      // in, which is the period whose drawer and whose VAT return it affects.
      query<RefundRow>(
        `SELECT
           s.channel AS channel,
           COALESCE(SUM(m.total_incl_vat_cents), 0) AS refunded_incl_vat_cents
         FROM sales_credit_memos m
         JOIN sales s ON s.id = m.original_sale_id
         WHERE m.store_id = ?
           AND m.status = 'posted'
           AND m.posted_at >= ?
           AND m.posted_at <= ?
         GROUP BY s.channel`,
        [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
      ),
    ]);

    const refundByChannel = new Map(
      refunds.map((r) => [r.channel, r.refunded_incl_vat_cents]),
    );

    // Every channel that appears on either side gets a row, so a period with
    // refunds but no new sales in a channel is still reported rather than
    // dropped.
    const channels = new Set<string>([
      ...gross.map((r) => r.channel),
      ...refunds.map((r) => r.channel),
    ]);

    return [...channels].map((channel) => {
      const g = gross.find((r) => r.channel === channel);
      return {
        channel,
        orderCount: g?.order_count ?? 0,
        grossInclVatCents: g?.gross_incl_vat_cents ?? 0,
        refundedInclVatCents: refundByChannel.get(channel) ?? 0,
      };
    });
  },

  /**
   * The driver report (WP-6): what each driver collected, remitted and still
   * owes, plus the delivery charges he kept over the period.
   *
   * ## What is over the PERIOD and what is not, and why they differ
   *
   * `outstandingCents` and the three movement figures come from
   * `driver_balances`, which is LIFETIME — and deliberately so. A balance is
   * not a period quantity: a driver who collected in March and settles in
   * April owes nothing, and a report that showed only April's rows would say
   * he owed the shop money he had already handed over. "What is in his pocket
   * right now" is the question the owner is actually asking.
   *
   * `deliveryFeesCents` and `orderCount` ARE over the period, because those
   * are flow: how much delivery work he did this week, and what the customers
   * paid him for it. The fee is not in the balance at all — he keeps it — so
   * mixing the two timeframes in one row cannot make either figure wrong, and
   * the column headings say which is which.
   *
   * The fees are read from `sales.delivery_fee_cents`, which is NOT part of any
   * sale total, so nothing here can leak a delivery charge into a revenue
   * figure. It is reported so the owner can see what his drivers are charging
   * and hand his accountant a real number — the tax treatment is still an open
   * question (migration 015).
   *
   * Every driver with a balance is included even if he carried nothing this
   * period, and every driver who carried something is included even at a zero
   * balance. A balance missing from its own report is how a shop's money goes
   * astray.
   */
  async driverSettlements(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    includeInactive?: boolean;
  }): Promise<DriverSettlementRow[]> {
    interface BalanceRow {
      driver_id: string;
      driver_name: string;
      is_active: number;
      outstanding_cents: number;
      collected_cents: number;
      remitted_cents: number;
      return_credit_cents: number;
      adjustment_cents: number;
      last_activity_at: string | null;
    }
    interface PeriodRow {
      driver_id: string;
      order_count: number;
      delivery_fees_cents: number;
    }

    const [balances, period] = await Promise.all([
      query<BalanceRow>(
        `SELECT driver_id, driver_name, is_active, outstanding_cents,
                collected_cents, remitted_cents, return_credit_cents,
                adjustment_cents, last_activity_at
           FROM driver_balances
          WHERE store_id = ?
          ORDER BY outstanding_cents DESC, driver_name`,
        [args.storeId],
      ),
      // Delivery work done IN the period. Grouped from `sales`, so the order
      // count here is the same count the channel report gives for delivery.
      query<PeriodRow>(
        `SELECT driver_id,
                COUNT(*) AS order_count,
                COALESCE(SUM(delivery_fee_cents), 0) AS delivery_fees_cents
           FROM sales
          WHERE store_id = ?
            AND status = 'posted'
            AND driver_id IS NOT NULL
            AND posted_at >= ?
            AND posted_at <= ?
          GROUP BY driver_id`,
        [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
      ),
    ]);

    const periodByDriver = new Map(period.map((r) => [r.driver_id, r]));

    return balances
      .filter(
        (b) =>
          args.includeInactive ||
          b.is_active === 1 ||
          b.outstanding_cents !== 0 ||
          periodByDriver.has(b.driver_id),
      )
      .map((b) => {
        const p = periodByDriver.get(b.driver_id);
        return {
          driverId: b.driver_id,
          driverName: b.driver_name,
          isActive: b.is_active === 1,
          orderCount: p?.order_count ?? 0,
          collectedCents: b.collected_cents,
          remittedCents: b.remitted_cents,
          returnCreditCents: b.return_credit_cents,
          adjustmentCents: b.adjustment_cents,
          outstandingCents: b.outstanding_cents,
          deliveryFeesCents: p?.delivery_fees_cents ?? 0,
          lastActivityAt: b.last_activity_at,
        };
      });
  },

  /**
   * Driver remittances received over a period — the cash that actually came
   * back, in the currency it came back in.
   *
   * These are NOT sales and must never be added to one. They are the
   * settlement side of revenue that was already recognised when the delivery
   * order posted, so a report that summed them alongside sales would count
   * every delivery twice. Kept as its own series for exactly that reason —
   * the same separation the returns series has from the sales series.
   */
  async driverRemittances(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<{
    driverId: string;
    driverName: string;
    remittanceCount: number;
    usdCents: number;
    lbp: number;
    totalUsdEquivalentCents: number;
  }[]> {
    interface Row {
      driver_id: string;
      driver_name: string;
      remittance_count: number;
      usd_cents: number;
      lbp: number;
      total_usd_equivalent_cents: number;
    }
    const rows = await query<Row>(
      `SELECT l.driver_id AS driver_id,
              d.name      AS driver_name,
              COUNT(*)    AS remittance_count,
              COALESCE(SUM(l.received_native_usd_cents), 0) AS usd_cents,
              COALESCE(SUM(l.received_native_lbp), 0)       AS lbp,
              -- Stored negative (a remittance pays the balance down), so the
              -- magnitude is negated once, here, rather than at each caller.
              COALESCE(SUM(-l.amount_cents), 0) AS total_usd_equivalent_cents
         FROM driver_ledger l
         JOIN drivers d ON d.id = l.driver_id
        WHERE l.store_id = ?
          AND l.entry_type = 'remittance'
          AND l.posted_at >= ?
          AND l.posted_at <= ?
        GROUP BY l.driver_id, d.name
        ORDER BY total_usd_equivalent_cents DESC, d.name`,
      [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
    );
    return rows.map((r) => ({
      driverId: r.driver_id,
      driverName: r.driver_name,
      remittanceCount: r.remittance_count,
      usdCents: r.usd_cents,
      lbp: r.lbp,
      totalUsdEquivalentCents: r.total_usd_equivalent_cents,
    }));
  },

  /**
   * Posted sale lines of the period, bucketed by how they were costed (WP-B1).
   *
   * Grouped on the raw column so a value this build does not recognise still
   * appears rather than vanishing into another bucket — the mapping normalises
   * it to `null` ("not a source I can explain"), which is honest, where
   * dropping the row would silently shrink the denominator a coverage
   * percentage is taken over.
   */
  async cogsCoverage(args: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<CogsCoverageRow[]> {
    interface Row {
      cogs_source: string | null;
      line_count: number;
      total_qty: number;
      line_subtotal_excl_vat_cents: number;
      line_cogs_excl_vat_cents: number;
      zero_rate_line_count: number;
      cost_bearing_line_count: number;
      cost_bearing_subtotal_excl_vat_cents: number;
    }

    const rows = await query<Row>(
      `SELECT
         si.cogs_source,
         COUNT(*) AS line_count,
         COALESCE(SUM(si.quantity), 0) AS total_qty,
         COALESCE(SUM(si.line_subtotal_excl_vat_cents), 0) AS line_subtotal_excl_vat_cents,
         COALESCE(SUM(si.line_cogs_excl_vat_cents), 0) AS line_cogs_excl_vat_cents,
         COALESCE(SUM(CASE WHEN si.unit_cogs_excl_vat_microcents = 0 THEN 1 ELSE 0 END), 0)
           AS zero_rate_line_count,
         COALESCE(SUM(
           CASE WHEN si.unit_cogs_excl_vat_microcents <> 0
                      OR si.line_cogs_excl_vat_cents <> 0
                THEN 1 ELSE 0 END), 0)
           AS cost_bearing_line_count,
         COALESCE(SUM(
           CASE WHEN si.unit_cogs_excl_vat_microcents <> 0
                      OR si.line_cogs_excl_vat_cents <> 0
                THEN si.line_subtotal_excl_vat_cents ELSE 0 END), 0)
           AS cost_bearing_subtotal_excl_vat_cents
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.store_id = ?
         AND s.status = 'posted'
         AND s.posted_at >= ?
         AND s.posted_at <= ?
       GROUP BY si.cogs_source
       ORDER BY line_count DESC`,
      [args.storeId, utcFrom(args.dateFrom), utcTo(args.dateTo)],
    );

    return rows.map((r) => ({
      source: normalizeCogsSource(r.cogs_source),
      lineCount: r.line_count,
      totalQty: r.total_qty,
      lineSubtotalExclVatCents: r.line_subtotal_excl_vat_cents,
      lineCogsExclVatCents: r.line_cogs_excl_vat_cents,
      zeroRateLineCount: r.zero_rate_line_count,
      costBearingLineCount: r.cost_bearing_line_count,
      costBearingSubtotalExclVatCents: r.cost_bearing_subtotal_excl_vat_cents,
    }));
  },

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
