import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import {
  reportsRepo,
  type DailySalesRow,
  type DailyReturnsRow,
  type ProductSalesRow,
  type ProductReturnsRow,
  type DailyPurchasesRow,
} from "../db/repos/reports";
import { Card, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { formatUsd } from "../lib/money";
import { todayLocalDate, formatPrettyDate } from "../lib/dates";
import {
  formatMargin,
  mergeDailyRows,
  mergeProductRows,
  periodTotals,
} from "../lib/reportMath";
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [ds, dr, ps, pr, dp] = await Promise.all([
        reportsRepo.dailySales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyReturns({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productSales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productReturns({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyPurchases({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
      ]);
      setDailySales(ds);
      setDailyReturns(dr);
      setProductSales(ps);
      setProductReturns(pr);
      setDailyPurchases(dp);
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
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 shadow-soft transition-colors hover:border-slate-400 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">{t("localReports.labelTo")}</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 shadow-soft transition-colors hover:border-slate-400 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
              />
            </div>
            <Button variant="primary" onClick={handleApply} disabled={loading}>
              {loading ? t("common.loading") : t("localReports.apply")}
            </Button>
          </>
        }
      />

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
                          returnedRevenue > 0 ? "text-amber-700" : "text-slate-400",
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
                          profit >= 0 ? "text-emerald-700" : "text-red-700",
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
                          <div className="text-xs text-amber-700">
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
                          profit >= 0 ? "text-emerald-700" : "text-red-700",
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
