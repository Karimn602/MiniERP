/**
 * Reporting arithmetic — pure, integer-only. The single definition of every
 * figure Greaz calls sales, returns, net sales, COGS or profit.
 *
 * Extracted from pages/LocalReports.tsx (WP-08) for the reason WP-01 extracted
 * `discount.ts` from PosRegister: the equations are the thing that has to be
 * right, and they cannot be tested through a React page. Having one module own
 * them also means the KPI cards and the tables below them derive from the same
 * code, so they cannot drift apart — which is how a screen ends up showing a
 * headline that its own rows do not add up to.
 *
 * THE VOCABULARY (the long form is in tests/README.md, the schema reasoning in
 * db/repos/reports.ts):
 *
 *   GROSS   posted, post-discount, BEFORE returns
 *   NET     the same, less posted credit memos
 *
 * "Gross" is not "before discounts". No pre-discount figure is persisted on a
 * sale header — `post_sale` sums lines the register already discounted — so
 * `discountCents` is INFORMATIONAL: it reports what the shop gave away and is
 * never subtracted from a sales total. Subtracting it was GP-A04.
 *
 *   netRevenueInclVat = grossRevenueInclVat − returnedRevenueInclVat
 *   netSalesExclVat   = grossSalesExclVat   − returnedSalesExclVat
 *   netVat            = grossVat            − returnedVat
 *   netCogs           = grossCogs           − reversedCogs   (restocked only)
 *   grossProfit       = netSalesExclVat     − netCogs
 *
 * `reversedCogs` counts RESTOCKED lines only, which is what makes one profit
 * formula correct for both return policies: a write-off reverses the revenue
 * and leaves the cost consumed, losing its whole margin — the truth about
 * discarded food.
 *
 * AGGREGATION IDENTITY. Where a figure is per-product, the identity is
 * `product_id` and nothing else. The snapshot name and SKU are a DISPLAY
 * dimension: both product queries group by them, so one product arrives as
 * several rows once it has been renamed, and composition must sum those rows
 * rather than let one label's figures stand for the lot. See
 * `mergeProductRows`.
 */
import type {
  DailySalesRow,
  DailyReturnsRow,
  ProductSalesRow,
  ProductReturnsRow,
} from "../db/repos/reports";

export interface PeriodTotals {
  saleCount: number;
  memoCount: number;

  // Gross — posted, post-discount, before returns.
  grossRevenueInclVatCents: number;
  grossSalesExclVatCents: number;
  grossVatCents: number;
  grossCogsCents: number;
  /** Informational only. Already out of every figure above. */
  discountCents: number;

  // Returns — posted credit memos only.
  returnedRevenueInclVatCents: number;
  returnedSalesExclVatCents: number;
  returnedVatCents: number;
  /** Restocked lines only; a write-off reverses no cost. */
  reversedCogsCents: number;

  // Net — gross less returns.
  netRevenueInclVatCents: number;
  netSalesExclVatCents: number;
  netVatCents: number;
  netCogsCents: number;
  grossProfitCents: number;
}

function sum<T>(rows: readonly T[], f: (r: T) => number): number {
  return rows.reduce((s, r) => s + f(r), 0);
}

/** Every figure for one period, from the two series as the repos return them. */
export function periodTotals(
  sales: readonly DailySalesRow[],
  returns: readonly DailyReturnsRow[],
): PeriodTotals {
  const grossRevenueInclVatCents = sum(sales, (r) => r.totalInclVatCents);
  const grossSalesExclVatCents = sum(sales, (r) => r.subtotalExclVatCents);
  const grossVatCents = sum(sales, (r) => r.vatTotalCents);
  const grossCogsCents = sum(sales, (r) => r.cogsTotalCents);

  const returnedRevenueInclVatCents = sum(returns, (r) => r.totalInclVatCents);
  const returnedSalesExclVatCents = sum(returns, (r) => r.subtotalExclVatCents);
  const returnedVatCents = sum(returns, (r) => r.vatTotalCents);
  const reversedCogsCents = sum(returns, (r) => r.cogsReversedCents);

  const netSalesExclVatCents = grossSalesExclVatCents - returnedSalesExclVatCents;
  const netCogsCents = grossCogsCents - reversedCogsCents;

  return {
    saleCount: sum(sales, (r) => r.saleCount),
    memoCount: sum(returns, (r) => r.memoCount),

    grossRevenueInclVatCents,
    grossSalesExclVatCents,
    grossVatCents,
    grossCogsCents,
    discountCents: sum(sales, (r) => r.discountCents),

    returnedRevenueInclVatCents,
    returnedSalesExclVatCents,
    returnedVatCents,
    reversedCogsCents,

    netRevenueInclVatCents: grossRevenueInclVatCents - returnedRevenueInclVatCents,
    netSalesExclVatCents,
    netVatCents: grossVatCents - returnedVatCents,
    netCogsCents,
    grossProfitCents: netSalesExclVatCents - netCogsCents,
  };
}

export interface DailyReportRow {
  localDate: string;
  saleCount: number;
  grossRevenueInclVatCents: number;
  returnedRevenueInclVatCents: number;
  netRevenueInclVatCents: number;
  netSalesExclVatCents: number;
  netVatCents: number;
  netCogsCents: number;
  grossProfitCents: number;
}

/**
 * The two daily series joined on the UNION of their dates.
 *
 * Not on the sales dates alone. A credit memo is its own document, so it can
 * fall on a date this period recorded no SALE for — a receipt from last week
 * returned this morning. Walking the sales rows and looking the return up
 * dropped exactly those days from the table while `periodTotals` kept counting
 * them, so the column sums stopped matching the headline.
 */
export function mergeDailyRows(
  sales: readonly DailySalesRow[],
  returns: readonly DailyReturnsRow[],
): DailyReportRow[] {
  const byDate = new Map(sales.map((r) => [r.localDate, r] as const));
  const retByDate = new Map(returns.map((r) => [r.localDate, r] as const));
  const dates = [...new Set([...byDate.keys(), ...retByDate.keys()])].sort();

  return dates.map((localDate) => {
    const s = byDate.get(localDate);
    const r = retByDate.get(localDate);
    const netSalesExclVatCents =
      (s?.subtotalExclVatCents ?? 0) - (r?.subtotalExclVatCents ?? 0);
    const netCogsCents = (s?.cogsTotalCents ?? 0) - (r?.cogsReversedCents ?? 0);
    return {
      localDate,
      saleCount: s?.saleCount ?? 0,
      grossRevenueInclVatCents: s?.totalInclVatCents ?? 0,
      returnedRevenueInclVatCents: r?.totalInclVatCents ?? 0,
      netRevenueInclVatCents:
        (s?.totalInclVatCents ?? 0) - (r?.totalInclVatCents ?? 0),
      netSalesExclVatCents,
      netVatCents: (s?.vatTotalCents ?? 0) - (r?.vatTotalCents ?? 0),
      netCogsCents,
      grossProfitCents: netSalesExclVatCents - netCogsCents,
    };
  });
}

export interface ProductReportRow {
  productId: string;
  productName: string;
  productSku: string | null;
  netQty: number;
  returnedQty: number;
  netRevenueInclVatCents: number;
  netSalesExclVatCents: number;
  netCogsCents: number;
  grossProfitCents: number;
}

/**
 * One accumulator per product, while the rows of both series are folded in.
 *
 * `label` is the display dimension and is decided separately from the money —
 * see `chooseLabel`.
 */
interface ProductAccumulator {
  productId: string;
  label: { name: string; sku: string | null; at: string } | null;
  soldQty: number;
  soldSubtotalExclVatCents: number;
  soldRevenueInclVatCents: number;
  soldCogsCents: number;
  returnedQty: number;
  returnedSubtotalExclVatCents: number;
  returnedRevenueInclVatCents: number;
  reversedCogsCents: number;
}

/**
 * THE DISPLAY LABEL RULE: the most recent snapshot wins.
 *
 * Of all the historical names a product sold or came back under in this period,
 * show the one from the latest posted document, breaking a tie on the same
 * timestamp by name then SKU ascending so the result is fully deterministic
 * (and independent of SQL row order, which is revenue-ordered and therefore not
 * stable under a rename).
 *
 * It is a snapshot, not `products.name` as it reads today — consistent with
 * every other figure on a product report, and it needs no join. And it is only
 * a LABEL: `mergeProductRows` sums the economics of every row sharing a
 * `productId` before any of this is consulted, so which label wins can never
 * change a number.
 */
function chooseLabel(
  current: ProductAccumulator["label"],
  candidate: { name: string; sku: string | null; at: string },
): ProductAccumulator["label"] {
  if (current === null) return candidate;
  if (candidate.at > current.at) return candidate;
  if (candidate.at < current.at) return current;
  if (candidate.name !== current.name) {
    return candidate.name < current.name ? candidate : current;
  }
  const a = candidate.sku ?? "";
  const b = current.sku ?? "";
  return a < b ? candidate : current;
}

/**
 * The two product series folded into one row per product, ordered by net
 * revenue.
 *
 * PRODUCT ID IS THE AGGREGATION IDENTITY. Both queries group by the snapshot
 * triple `(product_id, name, sku)`, so one product legitimately arrives as
 * SEVERAL rows once it has been renamed or re-SKU'd — each row correct for the
 * label it carries. This used to build `new Map(rows.map(r => [r.productId, r]))`
 * on each side, which does not sum but OVERWRITE: the last row for a product id
 * replaced every earlier one, and the rest of that product's revenue, quantity
 * and COGS vanished from the table while the headline still counted them. Two
 * sales of one burger, renamed between them, reported a third of the money.
 *
 * So every row is ADDED into an accumulator keyed on `productId` alone, and the
 * net fields are derived once at the end, after all of it is in. Each series is
 * folded independently — there is no join between them, so no row of one can
 * multiply a row of the other.
 *
 * A product present in only one series still appears: a sales-only product has
 * nothing to subtract, and a returns-only product (a line returned after the
 * period it sold in) reports negative net figures, which is what actually
 * happened that period.
 */
export function mergeProductRows(
  sales: readonly ProductSalesRow[],
  returns: readonly ProductReturnsRow[],
): ProductReportRow[] {
  const acc = new Map<string, ProductAccumulator>();

  const open = (productId: string): ProductAccumulator => {
    let a = acc.get(productId);
    if (a === undefined) {
      a = {
        productId,
        label: null,
        soldQty: 0,
        soldSubtotalExclVatCents: 0,
        soldRevenueInclVatCents: 0,
        soldCogsCents: 0,
        returnedQty: 0,
        returnedSubtotalExclVatCents: 0,
        returnedRevenueInclVatCents: 0,
        reversedCogsCents: 0,
      };
      acc.set(productId, a);
    }
    return a;
  };

  for (const r of sales) {
    const a = open(r.productId);
    a.label = chooseLabel(a.label, {
      name: r.productName,
      sku: r.productSku,
      at: r.latestPostedAt,
    });
    a.soldQty += r.totalQty;
    a.soldSubtotalExclVatCents += r.lineSubtotalExclVatCents;
    a.soldRevenueInclVatCents += r.lineTotalInclVatCents;
    a.soldCogsCents += r.lineCogsCents;
  }

  for (const r of returns) {
    const a = open(r.productId);
    a.label = chooseLabel(a.label, {
      name: r.productName,
      sku: r.productSku,
      at: r.latestPostedAt,
    });
    a.returnedQty += r.totalQty;
    a.returnedSubtotalExclVatCents += r.lineSubtotalExclVatCents;
    a.returnedRevenueInclVatCents += r.lineTotalInclVatCents;
    a.reversedCogsCents += r.lineCogsCents;
  }

  const rows = [...acc.values()].map((a) => {
    const netSalesExclVatCents =
      a.soldSubtotalExclVatCents - a.returnedSubtotalExclVatCents;
    const netCogsCents = a.soldCogsCents - a.reversedCogsCents;
    return {
      productId: a.productId,
      productName: a.label?.name ?? a.productId,
      productSku: a.label?.sku ?? null,
      netQty: a.soldQty - a.returnedQty,
      returnedQty: a.returnedQty,
      netRevenueInclVatCents:
        a.soldRevenueInclVatCents - a.returnedRevenueInclVatCents,
      netSalesExclVatCents,
      netCogsCents,
      grossProfitCents: netSalesExclVatCents - netCogsCents,
    };
  });

  // Ordered by net revenue, tie-broken by product id so the order is total.
  return rows.sort(
    (x, y) =>
      y.netRevenueInclVatCents - x.netRevenueInclVatCents ||
      (x.productId < y.productId ? -1 : x.productId > y.productId ? 1 : 0),
  );
}

/**
 * Margin as a percentage string, on the SAME revenue basis as the profit it is
 * given. Presentation only — the division is the one place a report leaves
 * integer arithmetic, and it produces a label, never a figure anything else
 * consumes.
 */
export function formatMargin(profitCents: number, netSalesCents: number): string {
  if (netSalesCents <= 0) return "—";
  return `${Math.round((profitCents / netSalesCents) * 1000) / 10}%`;
}
