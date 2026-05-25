import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import {
  reportsRepo,
  type DailySalesRow,
  type ProductSalesRow,
  type DailyPurchasesRow,
} from "../db/repos/reports";
import { Card, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { formatUsd } from "../lib/money";
import { todayLocalDate, formatPrettyDate } from "../lib/dates";
import clsx from "clsx";

function firstDayOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function calcGrossProfit(subtotal: number, cogs: number): number {
  // subtotal is stored post-discount; discountCents is not subtracted again.
  return subtotal - cogs;
}

function calcMargin(profit: number, netSales: number): string {
  if (netSales <= 0) return "—";
  return `${Math.round((profit / netSales) * 1000) / 10}%`;
}

export default function LocalReports() {
  const { storeId, hydrated } = useActiveContext();

  const [dateFrom, setDateFrom] = useState(firstDayOfMonth);
  const [dateTo, setDateTo] = useState(todayLocalDate);
  const [appliedFrom, setAppliedFrom] = useState(firstDayOfMonth);
  const [appliedTo, setAppliedTo] = useState(todayLocalDate);

  const [dailySales, setDailySales] = useState<DailySalesRow[]>([]);
  const [productSales, setProductSales] = useState<ProductSalesRow[]>([]);
  const [dailyPurchases, setDailyPurchases] = useState<DailyPurchasesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [ds, ps, dp] = await Promise.all([
        reportsRepo.dailySales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.productSales({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
        reportsRepo.dailyPurchases({ storeId, dateFrom: appliedFrom, dateTo: appliedTo }),
      ]);
      setDailySales(ds);
      setProductSales(ps);
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

  const summary = useMemo(() => {
    const revenue = dailySales.reduce((s, r) => s + r.totalInclVatCents, 0);
    const net = dailySales.reduce((s, r) => s + r.subtotalExclVatCents, 0); // post-discount
    const cogs = dailySales.reduce((s, r) => s + r.cogsTotalCents, 0);
    const purchases = dailyPurchases.reduce((s, r) => s + r.totalInclVatCents, 0);
    return { revenue, net, cogs, profit: net - cogs, purchases };
  }, [dailySales, dailyPurchases]);

  if (!hydrated) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header + date filter */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Local Reports</h2>
          <p className="text-sm text-slate-600">
            Daily sales, gross profit, and top products for the selected period.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-0.5">
            <label className="text-xs font-medium text-slate-500">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-xs font-medium text-slate-500">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <Button variant="primary" onClick={handleApply} disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load reports: {loadError}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniStat label="Revenue (incl. VAT)" value={formatUsd(summary.revenue)} />
        <MiniStat label="Net sales (excl. VAT)" value={formatUsd(summary.net)} />
        <MiniStat
          label="Gross profit"
          value={formatUsd(summary.profit)}
          tone={summary.profit > 0 ? "good" : summary.profit < 0 ? "bad" : undefined}
        />
        <MiniStat label="Total purchases" value={formatUsd(summary.purchases)} />
      </div>

      {/* Daily Sales */}
      <Card>
        <CardHeader
          title="Daily Sales"
          subtitle={`${appliedFrom} → ${appliedTo} · ${dailySales.length} day${dailySales.length === 1 ? "" : "s"}`}
        />
        {dailySales.length === 0 && !loading ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No posted sales in this period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Date</th>
                  <th className="px-5 py-2 text-right">Sales</th>
                  <th className="px-5 py-2 text-right">Revenue (incl. VAT)</th>
                  <th className="px-5 py-2 text-right">VAT</th>
                  <th className="px-5 py-2 text-right">COGS</th>
                  <th className="px-5 py-2 text-right">Gross profit</th>
                  <th className="px-5 py-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dailySales.map((row) => {
                  const net = row.subtotalExclVatCents; // post-discount
                  const profit = calcGrossProfit(row.subtotalExclVatCents, row.cogsTotalCents);
                  return (
                    <tr key={row.localDate} className="hover:bg-slate-50">
                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(row.localDate)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {row.saleCount}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums font-medium text-slate-900">
                        {formatUsd(row.totalInclVatCents)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                        {formatUsd(row.vatTotalCents)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                        {formatUsd(row.cogsTotalCents)}
                      </td>
                      <td
                        className={clsx(
                          "px-5 py-2 text-right tabular-nums font-medium",
                          profit >= 0 ? "text-emerald-700" : "text-red-700",
                        )}
                      >
                        {formatUsd(profit)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-slate-600">
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
          title="Sales by Product"
          subtitle={`${productSales.length} product${productSales.length === 1 ? "" : "s"} · sorted by revenue`}
        />
        {productSales.length === 0 && !loading ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No product sales in this period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Product</th>
                  <th className="px-5 py-2 text-right">Qty sold</th>
                  <th className="px-5 py-2 text-right">Revenue (incl. VAT)</th>
                  <th className="px-5 py-2 text-right">COGS</th>
                  <th className="px-5 py-2 text-right">Gross profit</th>
                  <th className="px-5 py-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {productSales.map((row) => {
                  const net = row.lineSubtotalExclVatCents; // post-discount
                  const profit = calcGrossProfit(row.lineSubtotalExclVatCents, row.lineCogsCents);
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
                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {row.totalQty}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums font-medium text-slate-900">
                        {formatUsd(row.lineTotalInclVatCents)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                        {formatUsd(row.lineCogsCents)}
                      </td>
                      <td
                        className={clsx(
                          "px-5 py-2 text-right tabular-nums font-medium",
                          profit >= 0 ? "text-emerald-700" : "text-red-700",
                        )}
                      >
                        {formatUsd(profit)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-slate-600">
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
          title="Purchases"
          subtitle={`${dailyPurchases.length} day${dailyPurchases.length === 1 ? "" : "s"} · filtered by purchase date`}
        />
        {dailyPurchases.length === 0 && !loading ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No posted purchases in this period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Date</th>
                  <th className="px-5 py-2 text-right">Count</th>
                  <th className="px-5 py-2 text-right">Subtotal (excl. VAT)</th>
                  <th className="px-5 py-2 text-right">VAT</th>
                  <th className="px-5 py-2 text-right">Total (incl. VAT)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dailyPurchases.map((row) => (
                  <tr key={row.localDate} className="hover:bg-slate-50">
                    <td className="px-5 py-2 text-slate-700">
                      {formatPrettyDate(row.localDate)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                      {row.purchaseCount}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                      {formatUsd(row.subtotalExclVatCents)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                      {formatUsd(row.vatTotalCents)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums font-medium text-slate-900">
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

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={clsx(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "good"
            ? "text-emerald-700"
            : tone === "bad"
              ? "text-red-700"
              : "text-slate-900",
        )}
      >
        {value}
      </div>
    </div>
  );
}
