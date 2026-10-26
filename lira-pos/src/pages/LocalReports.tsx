import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import {
  reportsRepo,
  type DailySalesRow,
  type DailyReturnsRow,
  type ProductSalesRow,
  type ProductReturnsRow,
  type DailyPurchasesRow,
  type CogsCoverageRow,
} from "../db/repos/reports";
import { Card, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { formatUsd } from "../lib/money";
import {
  SALES_CHANNEL_OPTIONS,
  buildChannelMix,
  shareBps,
} from "../lib/salesChannel";
import { summariseDrivers, type DriverSettlementRow } from "../lib/driverCollection";
import { todayLocalDate, formatPrettyDate } from "../lib/dates";
import {
  costCoverage,
  formatCoverage,
  formatMargin,
  mergeDailyRows,
  mergeProductRows,
  periodTotals,
} from "../lib/reportMath";
import { cogsSourceLabelKey } from "../lib/standardCost";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

function firstDayOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function LocalReports() {
  const { storeId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  const [dateFrom, setDateFrom] = useState(firstDayOfMonth);
  const [dateTo, setDateTo] = useState(todayLocalDate);
  const [appliedFrom, setAppliedFrom] = useState(firstDayOfMonth);
  const [appliedTo, setAppliedTo] = useState(todayLocalDate);

  const [dailySales, setDailySales] = useState<DailySalesRow[]>([]);
  const [dailyReturns, setDailyReturns] = useState<DailyReturnsRow[]>([]);
  const [productSales, setProductSales] = useState<ProductSalesRow[]>([]);
  const [productReturns, setProductReturns] = useState<ProductReturnsRow[]>([]);
  const [dailyPurchases, setDailyPurchases] = useState<DailyPurchasesRow[]>([]);
  const [channelRows, setChannelRows] = useState<
    { channel: string; orderCount: number; grossInclVatCents: number; refundedInclVatCents: number }[]
  >([]);
  const [coverageRows, setCoverageRows] = useState<CogsCoverageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [driverRows, setDriverRows] = useState<DriverSettlementRow[]>([]);
  const [remittanceRows, setRemittanceRows] = useState<
    Awaited<ReturnType<typeof reportsRepo.driverRemittances>>
  >([]);

  const loadReports = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [ds, dr, ps, pr, dp, ch, drv, rem, cov] = await Promise.all([
        reportsRepo.dailySales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyReturns({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productSales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productReturns({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyPurchases({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.salesByChannel({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.driverSettlements({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.driverRemittances({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.cogsCoverage({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
      ]);
      setDailySales(ds);
      setDailyReturns(dr);
      setProductSales(ps);
      setProductReturns(pr);
      setDailyPurchases(dp);
      setChannelRows(ch);
      setDriverRows(drv);
      setRemittanceRows(rem);
      setCoverageRows(cov);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, appliedFrom, appliedTo]);

  useEffect(() => {
    if (hydrated) void loadReports();
  }, [hydrated, loadReports]);

  function handleApply() {
    setAppliedFrom(dateFrom);
    setAppliedTo(dateTo);
  }

  // Every figure on this page comes from `lib/reportMath`, so the KPI cards and
  // the two tables below them are derived by the SAME code and cannot disagree.
  // Returns stay their own series and are subtracted there — gross sales,
  // returns and net sales are then three visible figures that each mean what
  // they say, and the sales numbers keep the meaning they had before WP-06.
  const summary = useMemo(() => periodTotals(dailySales, dailyReturns), [
    dailySales,
    dailyReturns,
  ]);

  // Cost completeness (WP-B1). Derived from the SAME posted sale lines the
  // product table sums, scoped the same way, so the buckets reconcile to the
  // period's gross figures and this panel cannot disagree with the KPI cards.
  const coverage = useMemo(() => costCoverage(coverageRows), [coverageRows]);

  // The channel mix, over the SAME period as every other figure on the page.
  // Its totals are summed from the per-channel rows, so the breakdown cannot
  // disagree with itself — and because the rows come from `sales` filtered the
  // same way `dailySales` filters it, the channel gross reconciles to the
  // period's gross sales above.
  const channelMix = useMemo(() => buildChannelMix(channelRows), [channelRows]);

  // The driver figures. `summariseDrivers` re-derives each balance from its own
  // movements and NAMES any row that disagrees, so the report cannot quietly
  // print a balance that its own columns do not add up to.
  const driverTotals = useMemo(() => summariseDrivers(driverRows), [driverRows]);

  // Cash that came back from drivers over the period. Kept as its OWN figure
  // and never added to sales: the revenue was recognised when the delivery
  // order posted, so summing these alongside it would count every delivery
  // twice. Same separation the returns series has from the sales series.
  const remittedTotalCents = useMemo(
    () => remittanceRows.reduce((sum, r) => sum + r.totalUsdEquivalentCents, 0),
    [remittanceRows],
  );

  const purchasesTotal = useMemo(
    () => dailyPurchases.reduce((s, r) => s + r.totalInclVatCents, 0),
    [dailyPurchases],
  );

  const dailyRows = useMemo(
    () => mergeDailyRows(dailySales, dailyReturns),
    [dailySales, dailyReturns],
  );

  const productRows = useMemo(
    () => mergeProductRows(productSales, productReturns),
    [productSales, productReturns],
  );

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("common.loading")}</div>;
  }

  const dailySalesSubtitle = t(
    dailyRows.length === 1 ? "localReports.dailySalesSubtitleOne" : "localReports.dailySalesSubtitleMany",
    { from: appliedFrom, to: appliedTo, count: String(dailyRows.length) },
  );

  const productSalesSubtitle = t(
    productRows.length === 1 ? "localReports.productSalesSubtitleOne" : "localReports.productSalesSubtitleMany",
    { count: String(productRows.length) },
  );

  const purchasesSubtitle = t(
    dailyPurchases.length === 1 ? "localReports.purchasesSubtitleOne" : "localReports.purchasesSubtitleMany",
    { count: String(dailyPurchases.length) },
  );

  return (
    <div className="space-y-6">
      {/* Header + date filter */}
      <PageHeader
        title={t("localReports.title")}
        subtitle={t("localReports.subtitle")}
        actions={
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">{t("localReports.labelFrom")}</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm text-slate-900 shadow-soft transition-colors hover:border-slate-400 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">{t("localReports.labelTo")}</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm text-slate-900 shadow-soft transition-colors hover:border-slate-400 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
              />
            </div>
            <Button variant="primary" onClick={handleApply} disabled={loading}>
              {loading ? t("common.loading") : t("localReports.apply")}
            </Button>
          </>
        }
      />

      {loadError && (
        <div className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          {t("localReports.loadFailed", { error: loadError })}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          label={t("localReports.statRevenue")}
          value={formatUsd(summary.grossRevenueInclVatCents)}
        />
        <StatCard
          label={t("localReports.statReturns")}
          value={formatUsd(summary.returnedRevenueInclVatCents)}
          tone={summary.returnedRevenueInclVatCents > 0 ? "warn" : undefined}
        />
        <StatCard
          label={t("localReports.statNetRevenue")}
          value={formatUsd(summary.netRevenueInclVatCents)}
        />
        <StatCard
          label={t("localReports.statNetSales")}
          value={formatUsd(summary.netSalesExclVatCents)}
        />
        <StatCard
          label={t("localReports.statGrossProfit")}
          value={formatUsd(summary.grossProfitCents)}
          tone={
            summary.grossProfitCents > 0
              ? "good"
              : summary.grossProfitCents < 0
                ? "bad"
                : undefined
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label={t("localReports.statPurchases")} value={formatUsd(purchasesTotal)} />
      </div>

      {/* COST COVERAGE (WP-B1).
          Sits immediately under the gross-profit card because it is the figure
          that card has to be read against. Greaz has shown a 100% paper margin
          on food since the day it shipped — not because the margin was good
          but because nothing had been costed — and a profit number printed
          without this beside it is indistinguishable from one that is simply
          wrong.

          Four distinctions this panel exists to keep:

            * HAVING a cost and having a RECORDED SOURCE for it are different
              questions. A line posted before migration 020 carries the COGS it
              was posted with and no provenance at all, so it is cost-bearing
              with an unknown source — inside the first share, outside the
              second. Reporting it as uncosted claimed money was missing from a
              calculation that was complete.
            * MISSING COST is the only thing that overstates the profit above:
              a line whose source says nothing was configured, or a legacy line
              whose COGS snapshot is zero. The first is a to-do list the owner
              can work through on Products today; the second is a fact about
              the past and is never restated.
            * ESTIMATED (a manual cost somebody typed) is not the same claim as
              DOCUMENTED (a cost derived from a purchase invoice), and the two
              are separate rows rather than one "costed" total.
            * The shares are shares of REVENUE, not of line count: ten uncosted
              sides matter less than one uncosted platter, and it is the money
              that reaches the margin.

          Both shares divide by the SAME denominator — this period's gross
          sales excl. VAT, before returns — so the verified-source share is a
          share of gross sales and not of the cost-bearing subset, and both
          labels name that denominator rather than reading as a nested
          breakdown. The gross-profit card above is NET of returns, so neither
          share is a percentage of it; a returned line was still costed or not
          costed when it was sold, so excluding returns would answer a
          different question. The note under the table says both things.

          And the missing-cost figure is REVENUE, not the cost those lines are
          missing — that is the unknown itself — so the warning says profit MAY
          be overstated and never quantifies it. */}
      <Card>
        <CardHeader
          title={t("costing.coverage.title")}
          subtitle={t("costing.coverage.subtitle")}
        />

        {coverage.totalLineCount === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">{t("costing.coverage.empty")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 px-5 py-4 md:grid-cols-5">
              <StatCard
                label={t("costing.coverage.costBearing")}
                value={formatCoverage(coverage.costBearingRevenueFraction)}
                tone={
                  coverage.costBearingRevenueFraction === 1
                    ? "good"
                    : coverage.hasMissingCost
                      ? "warn"
                      : undefined
                }
              />
              <StatCard
                label={t("costing.coverage.verifiedSource")}
                value={formatCoverage(coverage.verifiedSourceRevenueFraction)}
              />
              <StatCard
                label={t("costing.coverage.missingCost")}
                value={formatUsd(coverage.missingCostRevenueExclVatCents)}
                tone={coverage.missingCostRevenueExclVatCents > 0 ? "warn" : undefined}
              />
              <StatCard
                label={t("costing.coverage.legacyCosted")}
                value={formatUsd(coverage.legacyCostedRevenueExclVatCents)}
              />
              <StatCard
                label={t("costing.coverage.estimated")}
                value={formatUsd(coverage.estimatedRevenueExclVatCents)}
              />
            </div>

            <div className="overflow-x-auto px-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-start text-xs uppercase text-fg-muted">
                    <th className="py-2 pe-3 font-semibold">{t("costing.coverage.colSource")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("costing.coverage.colLines")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("costing.coverage.colQty")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("costing.coverage.colRevenue")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("costing.coverage.colCost")}</th>
                    <th className="py-2 text-end font-semibold">{t("costing.coverage.colZeroRate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageRows.map((row) => {
                    // A legacy row is only a gap for the lines of it that carry
                    // no cost. Colouring the whole row warn would say the
                    // $2.00 COGS beside it was missing.
                    const missing =
                      row.source === "uncosted" ||
                      (row.source === null && row.costBearingLineCount < row.lineCount);
                    return (
                      <tr
                        key={row.source ?? "legacy"}
                        className="border-b border-line/60 last:border-0"
                      >
                        <td className="py-2 pe-3">
                          <span className={clsx(missing && "text-warn-fg")}>
                            {t(cogsSourceLabelKey(row.source))}
                          </span>
                        </td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.lineCount}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{row.totalQty}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">
                          {formatUsd(row.lineSubtotalExclVatCents)}
                        </td>
                        <td className="py-2 pe-3 text-end tabular-nums">
                          {formatUsd(row.lineCogsExclVatCents)}
                        </td>
                        <td className="py-2 text-end tabular-nums">{row.zeroRateLineCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 px-5 py-4 text-xs">
              {coverage.hasMissingCost ? (
                <p className="rounded border border-warn-line bg-warn-bg p-2 text-warn-fg">
                  {t("costing.coverage.missingCostWarning")}
                </p>
              ) : (
                <p className="text-fg-muted">{t("costing.coverage.noMissingCost")}</p>
              )}
              {coverage.hasUnknownSource && (
                <p className="text-fg-muted">{t("costing.coverage.unknownSourceNote")}</p>
              )}
              {coverage.estimatedRevenueExclVatCents > 0 && (
                <p className="text-fg-muted">{t("costing.coverage.estimatedNote")}</p>
              )}
              <p className="text-fg-muted">{t("costing.coverage.grossBasisNote")}</p>
            </div>
          </>
        )}
      </Card>

      {/* ORDERS BY CHANNEL (WP-4).
          Four figures the owner asked for — counter and online order counts and
          revenue — plus the two shares. Gross and net are BOTH shown: returns
          are a visible subtraction here exactly as they are in the cards above,
          so "revenue" is never a number that quietly changed meaning.

          The note at the foot is not decoration. The single most likely
          misreading of this panel is that an online order was settled by the
          platform, and it was not: the channel records where the order came
          from and nothing about how it was paid. */}
      <Card>
        <CardHeader title={t("channel.reportTitle")} />

        {channelMix.totalOrders === 0 && channelMix.totalRefundedInclVatCents === 0 ? (
          <p className="text-sm text-fg-muted">{t("channel.noOrders")}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-start text-xs uppercase text-fg-muted">
                    <th className="py-2 pe-3 font-semibold">{t("channel.groupLabel")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("channel.orders")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("channel.grossRevenue")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("channel.refunds")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("channel.netRevenue")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("channel.shareOfOrders")}</th>
                    <th className="py-2 text-end font-semibold">{t("channel.shareOfRevenue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {channelMix.byChannel.map((c) => {
                    const orderShare = shareBps(c.orderCount, channelMix.totalOrders);
                    const revenueShare = shareBps(
                      c.netInclVatCents,
                      channelMix.totalNetInclVatCents,
                    );
                    const label =
                      SALES_CHANNEL_OPTIONS.find((o) => o.id === c.channel)?.labelKey ??
                      "channel.counter";
                    return (
                      <tr key={c.channel} className="border-b border-line/60">
                        <td className="py-2 pe-3 font-semibold text-fg">{t(label)}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">{c.orderCount}</td>
                        <td className="py-2 pe-3 text-end tabular-nums">
                          {formatUsd(c.grossInclVatCents)}
                        </td>
                        <td className="py-2 pe-3 text-end tabular-nums">
                          {c.refundedInclVatCents > 0
                            ? `-${formatUsd(c.refundedInclVatCents)}`
                            : formatUsd(0)}
                        </td>
                        <td className="py-2 pe-3 text-end font-semibold tabular-nums">
                          {formatUsd(c.netInclVatCents)}
                        </td>
                        <td className="py-2 pe-3 text-end tabular-nums">
                          {orderShare === null ? "—" : `${(orderShare / 100).toFixed(1)}%`}
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {revenueShare === null ? "—" : `${(revenueShare / 100).toFixed(1)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-semibold text-fg">
                    <td className="py-2 pe-3">{t("channel.total")}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">{channelMix.totalOrders}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {formatUsd(channelMix.totalGrossInclVatCents)}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {channelMix.totalRefundedInclVatCents > 0
                        ? `-${formatUsd(channelMix.totalRefundedInclVatCents)}`
                        : formatUsd(0)}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {formatUsd(channelMix.totalNetInclVatCents)}
                    </td>
                    <td className="py-2 pe-3 text-end">—</td>
                    <td className="py-2 text-end">—</td>
                  </tr>
                </tfoot>
              </table>
            </div>

          </>
        )}

        {/* ALWAYS shown, including on an empty period. The single most likely
            misreading of this panel is that an online order was settled by the
            platform, and it was not — and an empty panel is exactly when
            someone is working out what the feature means. */}
        <p className="mt-3 text-[11px] leading-snug text-fg-muted">
          {t("channel.notAPaymentMethod")}
        </p>
      </Card>

      {/* DRIVERS (WP-6).
          Two different timeframes on purpose, and the headings say which is
          which. The delivery work and the charges are OVER THE PERIOD —
          that is flow. The balances are LIFETIME, because a balance is not a
          period quantity: a driver who collected in March and settled in April
          owes nothing, and a report showing only April would claim he was
          still holding the money. "What is in his pocket right now" is the
          question being asked.

          `deliveryFeesCents` is the driver's own income and is in NO figure
          above — not in gross sales, not in the channel mix, not in his
          balance. It is reported so the owner can see what his drivers charge
          and hand his accountant a real number; the tax treatment is still an
          open question (migration 015). */}
      <Card>
        <CardHeader title={t("drivers.reportTitle")} subtitle={t("drivers.reportSubtitle")} />

        {driverTotals.rows.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("drivers.reportEmpty")}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase text-fg-muted">
                    <th className="py-2 pe-3 text-start font-semibold">{t("drivers.colDriver")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("drivers.colOrders")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("drivers.colFees")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("drivers.colCollected")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("drivers.colRemitted")}</th>
                    <th className="py-2 pe-3 text-end font-semibold">{t("drivers.colReturns")}</th>
                    <th className="py-2 text-end font-semibold">{t("drivers.colOutstanding")}</th>
                  </tr>
                </thead>
                <tbody>
                  {driverTotals.rows.map((r) => (
                    <tr key={r.driverId} className="border-b border-line/60">
                      <td className="py-2 pe-3">{r.driverName}</td>
                      <td className="py-2 pe-3 text-end tabular-nums">{r.orderCount}</td>
                      <td className="py-2 pe-3 text-end tabular-nums">
                        {formatUsd(r.deliveryFeesCents)}
                      </td>
                      <td className="py-2 pe-3 text-end tabular-nums">
                        {formatUsd(r.collectedCents)}
                      </td>
                      <td className="py-2 pe-3 text-end tabular-nums">
                        {formatUsd(r.remittedCents)}
                      </td>
                      <td className="py-2 pe-3 text-end tabular-nums">
                        {formatUsd(r.returnCreditCents)}
                      </td>
                      <td className="py-2 text-end font-semibold tabular-nums">
                        {formatUsd(r.outstandingCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-2 pe-3">{t("common.total")}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">{driverTotals.orderCount}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {formatUsd(driverTotals.deliveryFeesCents)}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {formatUsd(driverTotals.collectedCents)}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {formatUsd(driverTotals.remittedCents)}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {formatUsd(driverTotals.returnCreditCents)}
                    </td>
                    <td className="py-2 text-end tabular-nums">
                      {formatUsd(driverTotals.outstandingCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {driverTotals.unreconciled.length > 0 && (
              <p className="mt-2 text-xs font-bold text-danger">
                {t("drivers.unreconciled", {
                  n: String(driverTotals.unreconciled.length),
                })}
              </p>
            )}

            {/* Cash in from drivers, over the period, as its own figure. */}
            <p className="mt-3 text-sm text-fg">
              {t("drivers.remittedInPeriod", {
                amount: formatUsd(remittedTotalCents),
                n: String(remittanceRows.reduce((s, r) => s + r.remittanceCount, 0)),
              })}
            </p>
          </>
        )}

        {/* ALWAYS shown, including on an empty period — which is exactly when
            someone is working out what these figures mean. */}
        <p className="mt-3 text-[11px] leading-snug text-fg-muted">
          {t("drivers.reportNote")}
        </p>
      </Card>

      {/* Daily Sales */}
      <Card>
        <CardHeader
          title={t("localReports.dailySalesTitle")}
          subtitle={dailySalesSubtitle}
        />
        {dailyRows.length === 0 && !loading ? (
          <EmptyState title={t("localReports.noSalesInPeriod")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">{t("localReports.colDate")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colSales")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colGrossSales")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colLessReturns")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colNetSales")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colVat")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colCogs")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colGrossProfit")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colMargin")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dailyRows.map((row) => {
                  const returnedRevenue = row.returnedRevenueInclVatCents;
                  const profit = row.grossProfitCents;
                  return (
                    <tr key={row.localDate} className="hover:bg-slate-50">
                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(row.localDate)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                        {row.saleCount}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                        {formatUsd(row.grossRevenueInclVatCents)}
                      </td>
                      <td
                        className={clsx(
                          "px-5 py-2 text-end tabular-nums",
                          returnedRevenue > 0 ? "text-warn-fg" : "text-fg-muted",
                        )}
                      >
                        {returnedRevenue > 0 ? `\u2212 ${formatUsd(returnedRevenue)}` : "\u2014"}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                        {formatUsd(row.netRevenueInclVatCents)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(row.netVatCents)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(row.netCogsCents)}
                      </td>
                      <td
                        className={clsx(
                          "px-5 py-2 text-end tabular-nums font-medium",
                          profit >= 0 ? "text-good-fg" : "text-danger-fg",
                        )}
                      >
                        {formatUsd(profit)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatMargin(profit, row.netSalesExclVatCents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Sales by Product */}
      <Card>
        <CardHeader
          title={t("localReports.productSalesTitle")}
          subtitle={productSalesSubtitle}
        />
        {productRows.length === 0 && !loading ? (
          <EmptyState title={t("localReports.noProductSales")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">{t("localReports.colProduct")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colQtySold")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colRevenue")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colCogs")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colGrossProfit")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colMargin")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {productRows.map((row) => {
                  const profit = row.grossProfitCents;
                  return (
                    <tr key={row.productId} className="hover:bg-slate-50">
                      <td className="px-5 py-2">
                        <div className="font-medium text-slate-900">
                          {row.productName}
                        </div>
                        {row.productSku && (
                          <div className="text-xs text-slate-500">
                            SKU {row.productSku}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                        {row.netQty}
                        {row.returnedQty > 0 && (
                          <div className="text-xs text-warn-fg">
                            {`\u2212${row.returnedQty}`}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                        {formatUsd(row.netRevenueInclVatCents)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(row.netCogsCents)}
                      </td>
                      <td
                        className={clsx(
                          "px-5 py-2 text-end tabular-nums font-medium",
                          profit >= 0 ? "text-good-fg" : "text-danger-fg",
                        )}
                      >
                        {formatUsd(profit)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatMargin(profit, row.netSalesExclVatCents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Returns — their own documents, listed as such */}
      <Card>
        <CardHeader
          title={t("localReports.returnsTitle")}
          subtitle={t(
            dailyReturns.length === 1
              ? "localReports.returnsSubtitleOne"
              : "localReports.returnsSubtitleMany",
            { count: String(dailyReturns.length) },
          )}
        />
        {dailyReturns.length === 0 && !loading ? (
          <EmptyState title={t("localReports.noReturnsInPeriod")} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-2">{t("localReports.colDate")}</th>
                    <th className="px-5 py-2 text-end">{t("localReports.colMemos")}</th>
                    <th className="px-5 py-2 text-end">{t("localReports.colRefunded")}</th>
                    <th className="px-5 py-2 text-end">{t("localReports.colVatReversed")}</th>
                    <th className="px-5 py-2 text-end">{t("localReports.colCogsReversed")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dailyReturns.map((row) => (
                    <tr key={row.localDate} className="hover:bg-slate-50">
                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(row.localDate)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                        {row.memoCount}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                        {formatUsd(row.totalInclVatCents)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(row.vatTotalCents)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(row.cogsReversedCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
              {t("localReports.netProfitNote")}
            </p>
          </>
        )}
      </Card>

      {/* Purchases */}
      <Card>
        <CardHeader
          title={t("localReports.purchasesTitle")}
          subtitle={purchasesSubtitle}
        />
        {dailyPurchases.length === 0 && !loading ? (
          <EmptyState title={t("localReports.noPurchasesInPeriod")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">{t("localReports.colDate")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colCount")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colSubtotalExcl")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colVat")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colTotalIncl")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dailyPurchases.map((row) => (
                  <tr key={row.localDate} className="hover:bg-slate-50">
                    <td className="px-5 py-2 text-slate-700">
                      {formatPrettyDate(row.localDate)}
                    </td>
                    <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                      {row.purchaseCount}
                    </td>
                    <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                      {formatUsd(row.subtotalExclVatCents)}
                    </td>
                    <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                      {formatUsd(row.vatTotalCents)}
                    </td>
                    <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                      {formatUsd(row.totalInclVatCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
