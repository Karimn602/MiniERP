// src/pages/SalesHistory.tsx

import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { salesRepo } from "../db/repos/sales";
import type { Sale, SaleItem, SalePayment, SaleWithDetails } from "../db/types";
import { query } from "../db/client";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { formatLbp, formatUsd, usdCentsToLbp } from "../lib/money";
import { formatPrettyDate, relativeFromToday } from "../lib/dates";
import { ReceiptPrint } from "../components/ReceiptPrint";
import { useTranslation } from "../lib/i18n";
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
  // subtotalExclVatCents is stored post-discount; discountCents is not subtracted again.
  return s.subtotalExclVatCents - s.cogsTotalCents;
}

function profitMargin(s: Sale): string {
  const netSales = s.subtotalExclVatCents; // already post-discount
  if (netSales <= 0) return "—";
  return `${Math.round((grossProfitCents(s) / netSales) * 1000) / 10}%`;
}

export default function SalesHistory() {
  const { storeId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  const [storeName, setStoreName] = useState("Store");
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<SaleWithDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId || !hydrated) return;
    query<{ name: string }>("SELECT name FROM stores WHERE id = ? LIMIT 1", [storeId])
      .then((rows) => { if (rows[0]) setStoreName(rows[0].name); })
      .catch(() => {});
  }, [storeId, hydrated]);

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
        acc.net += s.subtotalExclVatCents; // post-discount; do not subtract discountCents again
        acc.vat += s.vatTotalCents;
        acc.cost += totalCostCents(s);
        acc.profit += grossProfitCents(s);
        return acc;
      },
      { total: 0, net: 0, vat: 0, cost: 0, profit: 0 },
    );
  }, [sales]);

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("common.loading")}</div>;
  }

  const cardSubtitle = loading
    ? t("common.loading")
    : t(sales.length === 1 ? "salesHistory.countOne" : "salesHistory.countMany", {
        count: String(sales.length),
      });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">{t("salesHistory.title")}</h2>
        <p className="text-sm text-slate-600">{t("salesHistory.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MiniStat label={t("salesHistory.statInclVat")} value={formatUsd(summary.total)} />
        <MiniStat label={t("salesHistory.statTotalCost")} value={formatUsd(summary.cost)} />
        <MiniStat
          label={t("salesHistory.statGrossProfit")}
          value={formatUsd(summary.profit)}
          tone={summary.profit >= 0 ? "good" : "bad"}
        />
        <MiniStat label={t("salesHistory.statNetSales")} value={formatUsd(summary.net)} />
      </div>

      <div>
          <Card>
            <CardHeader
              title={t("salesHistory.cardTitle")}
              subtitle={cardSubtitle}
            />

            {loadError && (
              <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
                {t("salesHistory.loadFailed", { error: loadError })}
              </div>
            )}

            {sales.length === 0 && !loading && !loadError ? (
              <div className="px-5 py-8 text-center text-sm text-slate-500">
                {t("salesHistory.emptyState")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2">{t("salesHistory.colReceipt")}</th>
                      <th className="px-5 py-2">{t("salesHistory.colDate")}</th>
                      <th className="px-5 py-2">{t("salesHistory.colTime")}</th>
                      <th className="px-5 py-2 text-end">{t("salesHistory.colSubtotalExcl")}</th>
                      <th className="px-5 py-2 text-end">{t("salesHistory.colVat")}</th>
                      <th className="px-5 py-2 text-end">{t("salesHistory.colTotal")}</th>
                      <th className="px-5 py-2 text-end">{t("salesHistory.colTotalCost")}</th>
                      <th className="px-5 py-2 text-end">{t("salesHistory.colProfit")}</th>
                      <th className="px-5 py-2 text-end">{t("salesHistory.colMargin")}</th>
                      <th className="px-5 py-2">{t("salesHistory.colStatus")}</th>
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

                          <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                            {formatUsd(s.subtotalExclVatCents)}
                          </td>

                          <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                            {formatUsd(s.vatTotalCents)}
                          </td>

                          <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                            {formatUsd(s.totalInclVatCents)}
                          </td>

                          <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                            {formatUsd(cost)}
                          </td>

                          <td
                            className={clsx(
                              "px-5 py-2 text-end tabular-nums font-medium",
                              profit >= 0 ? "text-emerald-700" : "text-red-700",
                            )}
                          >
                            {formatUsd(profit)}
                          </td>

                          <td className="px-5 py-2 text-end tabular-nums text-slate-700">
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
                              {t(`salesHistory.status${s.status.charAt(0).toUpperCase() + s.status.slice(1)}` as Parameters<typeof t>[0])}
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
          <>
            <div
              className="fixed inset-0 z-40 bg-black/10"
              onClick={() => {
                setSelectedId(null);
                setDetails(null);
              }}
            />
            <div className="fixed inset-y-0 end-0 z-50 w-[820px] max-w-[80vw] overflow-y-auto border-s border-slate-200 bg-white shadow-xl">
              <SaleDetailCard
                sale={details}
                loading={detailsLoading}
                error={detailsError}
                onPrint={() => window.print()}
                onClose={() => {
                  setSelectedId(null);
                  setDetails(null);
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Print-only receipt root — outside the drawer so fixed positioning escapes correctly */}
      {details && (
        <div id="receipt-print-root" className="hidden print:block">
          <ReceiptPrint sale={details} storeName={storeName} />
        </div>
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
  onPrint,
  onClose,
}: {
  sale: SaleWithDetails | null;
  loading: boolean;
  error: string | null;
  onPrint: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const profit = sale ? grossProfitCents(sale) : 0;

  const title = sale
    ? t("salesHistory.detailReceiptTitle", { number: String(sale.receiptNumber) })
    : t("salesHistory.detailFallbackTitle");

  const subtitle = sale
    ? t("salesHistory.detailPostedAt", {
        date: sale.postedAt ? formatPrettyDate(isoToLocalDate(sale.postedAt)) : "—",
      })
    : undefined;

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {sale && (
              <Button variant="ghost" size="sm" className="print:hidden" onClick={onPrint}>
                {t("salesHistory.printReceipt")}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="print:hidden" onClick={onClose}>
              {t("common.close")}
            </Button>
          </>
        }
      />

      <CardBody className="space-y-5">
        {loading ? (
          <p className="text-sm text-slate-500">{t("salesHistory.detailLoading")}</p>
        ) : error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : sale ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <MiniStat label={t("salesHistory.detailStatInclVat")} value={formatUsd(sale.totalInclVatCents)} />
              <MiniStat label={t("salesHistory.detailStatCost")} value={formatUsd(sale.cogsTotalCents)} />
              <MiniStat
                label={t("salesHistory.detailStatProfit")}
                value={formatUsd(profit)}
                tone={profit >= 0 ? "good" : "bad"}
              />
              <MiniStat label={t("salesHistory.detailStatMargin")} value={profitMargin(sale)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">{t("salesHistory.detailSaleInfoTitle")}</div>
                <DetailRow label={t("salesHistory.detailStatus")} value={sale.status} />
                <DetailRow
                  label={t("salesHistory.detailExchangeRate")}
                  value={`${sale.exchangeRateLbpPerUsd.toLocaleString()} L.L. / USD`}
                />
                <DetailRow
                  label={t("salesHistory.detailLbpEquivalent")}
                  value={formatLbp(
                    usdCentsToLbp(
                      sale.totalInclVatCents,
                      sale.exchangeRateLbpPerUsd,
                    ),
                  )}
                />
                <DetailRow label={t("salesHistory.detailNotes")} value={sale.notes ?? "—"} />
              </div>

              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">{t("salesHistory.detailTotalsTitle")}</div>
                <DetailRow
                  label={t("salesHistory.detailSubtotalExcl")}
                  value={formatUsd(sale.subtotalExclVatCents)}
                />
                <DetailRow label={t("salesHistory.detailVat")} value={formatUsd(sale.vatTotalCents)} />
                <DetailRow
                  label={t("salesHistory.detailDiscount")}
                  value={formatUsd(sale.discountCents)}
                />
                <DetailRow
                  label={t("salesHistory.detailTotalIncl")}
                  value={formatUsd(sale.totalInclVatCents)}
                />
                <DetailRow
                  label={t("salesHistory.detailTotalCost")}
                  value={formatUsd(sale.cogsTotalCents)}
                />
                <DetailRow
                  label={t("salesHistory.detailGrossProfit")}
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
      <span className="text-end text-xs font-medium text-slate-800">
        {value}
      </span>
    </div>
  );
}

function LinesTable({ lines }: { lines: SaleItem[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">{t("salesHistory.linesColProduct")}</th>
            <th className="px-4 py-2">{t("salesHistory.linesColBarcode")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.linesColQty")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.linesColUnitPrice")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.linesColUnitCost")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.linesColLineTotal")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.linesColTotalCost")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.linesColProfit")}</th>
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
                      : t("salesHistory.noSkuLabel")}
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

                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {line.quantityInUom ?? line.quantity}{" "}
                  {line.uomCodeSnapshot ?? "base"}
                </td>

                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {formatUsd(line.unitPriceInclVatCents)}
                </td>

                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {formatUsd(line.unitCogsExclVatCents)}
                </td>

                <td className="px-4 py-2 text-end tabular-nums font-medium text-slate-900">
                  {formatUsd(line.lineTotalInclVatCents)}
                </td>

                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {formatUsd(line.lineCogsExclVatCents)}
                </td>

                <td
                  className={clsx(
                    "px-4 py-2 text-end tabular-nums font-medium",
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
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">{t("salesHistory.paymentsColMethod")}</th>
            <th className="px-4 py-2">{t("salesHistory.paymentsColCurrency")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.paymentsColNativeAmount")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.paymentsColUsdEquiv")}</th>
            <th className="px-4 py-2 text-end">{t("salesHistory.paymentsColChange")}</th>
            <th className="px-4 py-2">{t("salesHistory.paymentsColReference")}</th>
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100">
          {payments.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2 text-slate-700">
                {t(`shift.paymentMethods.${p.method}` as Parameters<typeof t>[0])}
              </td>
              <td className="px-4 py-2 text-slate-700">{p.currency}</td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {p.currency === "USD"
                  ? formatUsd(p.amountNativeUsdCents)
                  : formatLbp(p.amountNativeLbp)}
              </td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {formatUsd(p.amountUsdCentsEquivalent)}
              </td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
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
