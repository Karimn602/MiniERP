import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import {
  reportsRepo,
  type DailySalesRow,
  type ProductSalesRow,
  type DailyPurchasesRow,
  type DailyReturnsRow,
  type ProductReturnsRow,
} from "../db/repos/reports";
import { Card, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { formatUsd } from "../lib/money";
import { todayLocalDate, formatPrettyDate } from "../lib/dates";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

function firstDayOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function calcMargin(profit: number, netSales: number): string {
  if (netSales <= 0) return "—";
  return `${Math.round((profit / netSales) * 1000) / 10}%`;
}

export default function LocalReports() {
  const { storeId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  const [dateFrom, setDateFrom] = useState(firstDayOfMonth);
  const [dateTo, setDateTo] = useState(todayLocalDate);
  const [appliedFrom, setAppliedFrom] = useState(firstDayOfMonth);
  const [appliedTo, setAppliedTo] = useState(todayLocalDate);

  const [dailySales, setDailySales] = useState<DailySalesRow[]>([]);
  const [productSales, setProductSales] = useState<ProductSalesRow[]>([]);
  const [dailyPurchases, setDailyPurchases] = useState<DailyPurchasesRow[]>([]);
  const [dailyReturns, setDailyReturns] = useState<DailyReturnsRow[]>([]);
  const [productReturns, setProductReturns] = useState<ProductReturnsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [ds, ps, dp, dr, pr] = await Promise.all([
        reportsRepo.dailySales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productSales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyPurchases({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyReturns({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productReturns({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
      ]);
      setDailySales(ds);
      setProductSales(ps);
      setDailyPurchases(dp);
      setDailyReturns(dr);
      setProductReturns(pr);
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

  // Returns indexed for netting against sales.
  const returnsByDate = useMemo(() => {
    const map = new Map<string, DailyReturnsRow>();
    for (const r of dailyReturns) map.set(r.localDate, r);
    return map;
  }, [dailyReturns]);

  const returnsByProduct = useMemo(() => {
    const map = new Map<string, ProductReturnsRow>();
    for (const r of productReturns) map.set(r.productId, r);
    return map;
  }, [productReturns]);

  const summary = useMemo(() => {
    const grossRevenue = dailySales.reduce((s, r) => s + r.totalInclVatCents, 0);
    const grossNet = dailySales.reduce((s, r) => s + r.subtotalExclVatCents, 0); // post-discount
    const grossCogs = dailySales.reduce((s, r) => s + r.cogsTotalCents, 0);

    const returnsTotal = dailyReturns.reduce((s, r) => s + r.totalInclVatCents, 0);
    const returnsNet = dailyReturns.reduce((s, r) => s + r.subtotalExclVatCents, 0);
    const returnsCogs = dailyReturns.reduce((s, r) => s + r.cogsReversedCents, 0);

    const revenue = grossRevenue - returnsTotal;
    const net = grossNet - returnsNet;
    const cogs = grossCogs - returnsCogs;
    const purchases = dailyPurchases.reduce((s, r) => s + r.totalInclVatCents, 0);
    return { revenue, net, cogs, profit: net - cogs, purchases, returnsTotal };
  }, [dailySales, dailyPurchases, dailyReturns]);

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("common.loading")}</div>;
  }

  const dailySalesSubtitle = t(
    dailySales.length === 1 ? "localReports.dailySalesSubtitleOne" : "localReports.dailySalesSubtitleMany",
    { from: appliedFrom, to: appliedTo, count: String(dailySales.length) },
  );

  const productSalesSubtitle = t(
    productSales.length === 1 ? "localReports.productSalesSubtitleOne" : "localReports.productSalesSubtitleMany",
    { count: String(productSales.length) },
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
        <StatCard label={t("localReports.statRevenue")} value={formatUsd(summary.revenue)} />
        <StatCard label={t("localReports.statNetSales")} value={formatUsd(summary.net)} />
        <StatCard
          label={t("localReports.statGrossProfit")}
          value={formatUsd(summary.profit)}
          tone={summary.profit > 0 ? "good" : summary.profit < 0 ? "bad" : undefined}
        />
        <StatCard
          label={t("localReports.statReturns")}
          value={formatUsd(summary.returnsTotal)}
          tone={summary.returnsTotal > 0 ? "warn" : undefined}
        />
        <StatCard label={t("localReports.statPurchases")} value={formatUsd(summary.purchases)} />
      </div>
      {summary.returnsTotal > 0 && (
        <p className="-mt-3 text-xs text-slate-500">{t("localReports.returnsNote")}</p>
      )}

      {/* Daily Sales */}
      <Card>
        <CardHeader
          title={t("localReports.dailySalesTitle")}
          subtitle={dailySalesSubtitle}
        />
        {dailySales.length === 0 && !loading ? (
          <EmptyState title={t("localReports.noSalesInPeriod")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">{t("localReports.colDate")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colSales")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colRevenue")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colVat")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colCogs")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colGrossProfit")}</th>
                  <th className="px-5 py-2 text-end">{t("localReports.colMargin")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dailySales.map((row) => {
                  const ret = returnsByDate.get(row.localDate);
                  const revenue = row.totalInclVatCents - (ret?.totalInclVatCents ?? 0);
                  const vat = row.vatTotalCents - (ret?.vatTotalCents ?? 0);
                  const cogs = row.cogsTotalCents - (ret?.cogsReversedCents ?? 0);
                  const net = row.subtotalExclVatCents - (ret?.subtotalExclVatCents ?? 0);
                  const profit = net - cogs;
                  return (
                    <tr key={row.localDate} className="hover:bg-slate-50">
                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(row.localDate)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                        {row.saleCount}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                        {formatUsd(revenue)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(vat)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(cogs)}
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
                        {calcMargin(profit, net)}
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
        {productSales.length === 0 && !loading ? (
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
                {productSales.map((row) => {
                  const ret = returnsByProduct.get(row.productId);
                  const qty = row.totalQty - (ret?.totalQtyBase ?? 0);
                  const revenue = row.lineTotalInclVatCents - (ret?.totalInclVatCents ?? 0);
                  const cogs = row.lineCogsCents - (ret?.cogsReversedCents ?? 0);
                  const net = row.lineSubtotalExclVatCents - (ret?.subtotalExclVatCents ?? 0);
                  const profit = net - cogs;
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
                        {qty}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                        {formatUsd(revenue)}
                      </td>
                      <td className="px-5 py-2 text-end tabular-nums text-slate-600">
                        {formatUsd(cogs)}
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
                        {calcMargin(profit, net)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
