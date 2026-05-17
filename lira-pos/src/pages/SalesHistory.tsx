// src/pages/SalesHistory.tsx

import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { salesRepo } from "../db/repos/sales";
import type { Sale, SaleItem, SalePayment, SaleWithDetails } from "../db/types";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { formatLbp, formatUsd, usdCentsToLbp } from "../lib/money";
import { formatPrettyDate, relativeFromToday } from "../lib/dates";
import clsx from "clsx";

function isoToLocalDate(iso: string): string {
  return iso.slice(0, 10);
}

function isoToTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function totalCostCents(s: Sale): number {
  return s.cogsTotalCents;
}

function grossProfitCents(s: Sale): number {
  return s.subtotalExclVatCents - s.discountCents - s.cogsTotalCents;
}

function profitMargin(s: Sale): string {
  const netSales = s.subtotalExclVatCents - s.discountCents;
  if (netSales <= 0) return "—";
  return `${Math.round((grossProfitCents(s) / netSales) * 1000) / 10}%`;
}

export default function SalesHistory() {
  const { storeId, hydrated } = useActiveContext();

  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<SaleWithDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!storeId) return;

    setLoading(true);
    setLoadError(null);

    try {
      const rows = await salesRepo.list({ storeId, limit: 200 });
      setSales(rows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) void reload();
  }, [hydrated, reload]);

  async function openDetails(id: string) {
    if (selectedId === id && details) {
      setSelectedId(null);
      setDetails(null);
      return;
    }

    setSelectedId(id);
    setDetails(null);
    setDetailsError(null);
    setDetailsLoading(true);

    try {
      const row = await salesRepo.findByIdWithDetails(id);
      if (!row) throw new Error("Sale not found.");
      setDetails(row);
    } catch (e) {
      setDetailsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailsLoading(false);
    }
  }

  const summary = useMemo(() => {
    return sales.reduce(
      (acc, s) => {
        acc.total += s.totalInclVatCents;
        acc.net += s.subtotalExclVatCents - s.discountCents;
        acc.vat += s.vatTotalCents;
        acc.cost += totalCostCents(s);
        acc.profit += grossProfitCents(s);
        return acc;
      },
      { total: 0, net: 0, vat: 0, cost: 0, profit: 0 },
    );
  }, [sales]);

  if (!hydrated) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">Sales History</h2>
        <p className="text-sm text-slate-600">
          Click a sale to view receipt lines, payments, unit costs, total cost,
          and profit.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MiniStat label="Sales total" value={formatUsd(summary.total)} />
        <MiniStat label="Total cost" value={formatUsd(summary.cost)} />
        <MiniStat
          label="Gross profit"
          value={formatUsd(summary.profit)}
          tone={summary.profit >= 0 ? "good" : "bad"}
        />
        <MiniStat label="Net sales" value={formatUsd(summary.net)} />
      </div>

      <Card>
        <CardHeader
          title="Sales"
          subtitle={
            loading
              ? "Loading…"
              : `${sales.length} record${sales.length === 1 ? "" : "s"}`
          }
        />

        {loadError && (
          <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
            Failed to load sales: {loadError}
          </div>
        )}

        {sales.length === 0 && !loading && !loadError ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No sales yet. Post your first sale from the POS Register.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Receipt #</th>
                  <th className="px-5 py-2">Date</th>
                  <th className="px-5 py-2">Time</th>
                  <th className="px-5 py-2 text-right">Subtotal</th>
                  <th className="px-5 py-2 text-right">VAT</th>

                  {/* requested order */}
                  <th className="px-5 py-2 text-right">Total</th>
                  <th className="px-5 py-2 text-right">Total cost</th>
                  <th className="px-5 py-2 text-right">Profit</th>

                  <th className="px-5 py-2 text-right">Margin</th>
                  <th className="px-5 py-2">Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {sales.map((s) => {
                  const dateIso = s.postedAt ?? s.createdAt;
                  const localDate = isoToLocalDate(dateIso);
                  const cost = totalCostCents(s);
                  const profit = grossProfitCents(s);

                  return (
                    <tr
                      key={s.id}
                      className={clsx(
                        "cursor-pointer transition-colors hover:bg-slate-50",
                        selectedId === s.id && "bg-brand/5",
                      )}
                      onClick={() => void openDetails(s.id)}
                    >
                      <td className="px-5 py-2 font-medium text-slate-900">
                        #{s.receiptNumber}
                      </td>

                      <td className="px-5 py-2 text-slate-700">
                        {formatPrettyDate(localDate)}
                        <div className="text-xs text-slate-500">
                          {relativeFromToday(localDate)}
                        </div>
                      </td>

                      <td className="px-5 py-2 text-slate-600">
                        {isoToTime(dateIso)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {formatUsd(s.subtotalExclVatCents)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {formatUsd(s.vatTotalCents)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums font-medium text-slate-900">
                        {formatUsd(s.totalInclVatCents)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {formatUsd(cost)}
                      </td>

                      <td
                        className={clsx(
                          "px-5 py-2 text-right tabular-nums font-medium",
                          profit >= 0 ? "text-emerald-700" : "text-red-700",
                        )}
                      >
                        {formatUsd(profit)}
                      </td>

                      <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                        {profitMargin(s)}
                      </td>

                      <td className="px-5 py-2">
                        <span
                          className={clsx(
                            "rounded px-2 py-0.5 text-xs font-medium",
                            s.status === "posted" &&
                              "bg-emerald-100 text-emerald-800",
                            s.status === "draft" &&
                              "bg-amber-100 text-amber-800",
                            s.status === "voided" &&
                              "bg-slate-200 text-slate-600 line-through",
                          )}
                        >
                          {s.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedId && (
        <SaleDetailCard
          sale={details}
          loading={detailsLoading}
          error={detailsError}
          onClose={() => {
            setSelectedId(null);
            setDetails(null);
          }}
        />
      )}
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

function SaleDetailCard({
  sale,
  loading,
  error,
  onClose,
}: {
  sale: SaleWithDetails | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const profit = sale ? grossProfitCents(sale) : 0;

  return (
    <Card>
      <CardHeader
        title={sale ? `Receipt #${sale.receiptNumber}` : "Sale details"}
        subtitle={
          sale
            ? `Posted ${
                sale.postedAt
                  ? formatPrettyDate(isoToLocalDate(sale.postedAt))
                  : "—"
              }`
            : undefined
        }
        actions={
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      />

      <CardBody className="space-y-5">
        {loading ? (
          <p className="text-sm text-slate-500">Loading sale details…</p>
        ) : error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : sale ? (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <MiniStat label="Total" value={formatUsd(sale.totalInclVatCents)} />
              <MiniStat label="Total cost" value={formatUsd(sale.cogsTotalCents)} />
              <MiniStat
                label="Gross profit"
                value={formatUsd(profit)}
                tone={profit >= 0 ? "good" : "bad"}
              />
              <MiniStat label="Margin" value={profitMargin(sale)} />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">Sale info</div>
                <DetailRow label="Status" value={sale.status} />
                <DetailRow
                  label="Exchange rate"
                  value={`${sale.exchangeRateLbpPerUsd.toLocaleString()} L.L. / USD`}
                />
                <DetailRow
                  label="LBP equivalent"
                  value={formatLbp(
                    usdCentsToLbp(
                      sale.totalInclVatCents,
                      sale.exchangeRateLbpPerUsd,
                    ),
                  )}
                />
                <DetailRow label="Notes" value={sale.notes ?? "—"} />
              </div>

              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">Totals</div>
                <DetailRow
                  label="Subtotal excl. VAT"
                  value={formatUsd(sale.subtotalExclVatCents)}
                />
                <DetailRow label="VAT" value={formatUsd(sale.vatTotalCents)} />
                <DetailRow
                  label="Discount"
                  value={formatUsd(sale.discountCents)}
                />
                <DetailRow
                  label="Total incl. VAT"
                  value={formatUsd(sale.totalInclVatCents)}
                />
                <DetailRow
                  label="Total cost"
                  value={formatUsd(sale.cogsTotalCents)}
                />
                <DetailRow
                  label="Profit"
                  value={formatUsd(grossProfitCents(sale))}
                />
              </div>
            </div>

            <LinesTable lines={sale.lines} />
            <PaymentsTable payments={sale.payments} />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-xs font-medium text-slate-800">
        {value}
      </span>
    </div>
  );
}

function LinesTable({ lines }: { lines: SaleItem[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Product</th>
            <th className="px-4 py-2">Barcode</th>
            <th className="px-4 py-2 text-right">Qty</th>
            <th className="px-4 py-2 text-right">Unit price</th>

            {/* replaces cost method with unit cost */}
            <th className="px-4 py-2 text-right">Unit cost</th>

            <th className="px-4 py-2 text-right">Line total</th>
            <th className="px-4 py-2 text-right">Total cost</th>
            <th className="px-4 py-2 text-right">Profit</th>
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100">
          {lines.map((line) => {
            const profit =
              line.lineSubtotalExclVatCents -
              line.lineDiscountCents -
              line.lineCogsExclVatCents;

            return (
              <tr key={line.id}>
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-900">
                    {line.productNameSnapshot}
                  </div>
                  <div className="text-xs text-slate-500">
                    {line.productSkuSnapshot
                      ? `SKU ${line.productSkuSnapshot}`
                      : "No SKU"}
                    {line.uomCodeSnapshot ? ` · ${line.uomCodeSnapshot}` : ""}
                  </div>
                </td>

                <td className="px-4 py-2 text-xs text-slate-600">
                  {line.barcodeUsedSnapshot ? (
                    <code>{line.barcodeUsedSnapshot}</code>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>

                <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                  {line.quantityInUom ?? line.quantity}{" "}
                  {line.uomCodeSnapshot ?? "base"}
                </td>

                <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                  {formatUsd(line.unitPriceInclVatCents)}
                </td>

                <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                  {formatUsd(line.unitCogsExclVatCents)}
                </td>

                <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-900">
                  {formatUsd(line.lineTotalInclVatCents)}
                </td>

                <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                  {formatUsd(line.lineCogsExclVatCents)}
                </td>

                <td
                  className={clsx(
                    "px-4 py-2 text-right tabular-nums font-medium",
                    profit >= 0 ? "text-emerald-700" : "text-red-700",
                  )}
                >
                  {formatUsd(profit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PaymentsTable({ payments }: { payments: SalePayment[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Method</th>
            <th className="px-4 py-2">Currency</th>
            <th className="px-4 py-2 text-right">Native amount</th>
            <th className="px-4 py-2 text-right">USD equivalent</th>
            <th className="px-4 py-2 text-right">Change</th>
            <th className="px-4 py-2">Reference</th>
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100">
          {payments.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2 text-slate-700">{p.method}</td>
              <td className="px-4 py-2 text-slate-700">{p.currency}</td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {p.currency === "USD"
                  ? formatUsd(p.amountNativeUsdCents)
                  : formatLbp(p.amountNativeLbp)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {formatUsd(p.amountUsdCentsEquivalent)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                {p.changeGivenUsdCents > 0
                  ? formatUsd(p.changeGivenUsdCents)
                  : p.changeGivenLbp > 0
                    ? formatLbp(p.changeGivenLbp)
                    : "—"}
              </td>
              <td className="px-4 py-2 text-xs text-slate-600">
                {p.reference ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}