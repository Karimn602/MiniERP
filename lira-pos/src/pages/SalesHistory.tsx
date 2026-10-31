// src/pages/SalesHistory.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { salesRepo } from "../db/repos/sales";
import { creditMemosRepo } from "../db/repos/creditMemos";
import { shiftsRepo } from "../db/repos/shifts";
import type {
  CreditMemo,
  Sale,
  SaleItem,
  SalePayment,
  SaleReturnStatus,
  SaleWithDetails,
} from "../db/types";
import { query } from "../db/client";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { formatLbp, formatUsd, usdCentsToLbp } from "../lib/money";
import { formatUnitCostUsd } from "../lib/cost";
import { formatPrettyDate, isoToLocalDate, relativeFromToday } from "../lib/dates";
import { ReceiptPrint } from "../components/ReceiptPrint";
import { driversRepo } from "../db/repos/drivers";
import { CreateReturnModal } from "../components/CreateReturnModal";
import { useTranslation } from "../lib/i18n";
import { cogsSourceLabelKey, isCostBearingLine } from "../lib/standardCost";
import { recipesRepo, type PostedRecipeCostRow } from "../db/repos/recipes";
import { formatQuantity } from "../lib/recipeQuantity";
import clsx from "clsx";

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
  const { storeId, userId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  const [storeName, setStoreName] = useState("Store");
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<SaleWithDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  // How much of each receipt has come back. DERIVED from credit-memo lines —
  // the sale itself is never marked (see migration 011's preamble), so this map
  // is the only thing that knows.
  const [returnStatus, setReturnStatus] = useState<Map<string, SaleReturnStatus>>(
    new Map(),
  );
  const [memosForSale, setMemosForSale] = useState<CreditMemo[]>([]);
  /**
   * The name of the driver who carried the open receipt (WP-A4), or null.
   *
   * Looked up BY ID rather than taken from a list of active drivers: a receipt
   * from last month may name somebody who has since been retired, and a
   * historical document that stopped saying who carried it would be worse than
   * one that never said.
   */
  const [detailsDriverName, setDetailsDriverName] = useState<string | null>(null);
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [returningSaleId, setReturningSaleId] = useState<string | null>(null);
  const [returnNotice, setReturnNotice] = useState<string | null>(null);

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
      // POSTED ONLY. This page is a financial screen — the stat cards above the
      // table sum revenue, VAT, cost and profit straight off these rows — so
      // the population decision belongs at the query, not in one summary
      // afterwards. See `salesRepo.listPostedForReporting`.
      const [rows, statuses, openShift] = await Promise.all([
        salesRepo.listPostedForReporting({ storeId, limit: 200 }),
        creditMemosRepo.returnStatusForStore(storeId),
        shiftsRepo.getOpenShift(storeId),
      ]);
      setSales(rows);
      setReturnStatus(statuses);
      setHasOpenShift(openShift !== null);
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
      setMemosForSale([]);
      return;
    }

    setSelectedId(id);
    setDetails(null);
    setMemosForSale([]);
    setDetailsDriverName(null);
    setDetailsError(null);
    setDetailsLoading(true);

    try {
      const [row, memos] = await Promise.all([
        salesRepo.findByIdWithDetails(id),
        creditMemosRepo.listForSale(id),
      ]);
      if (!row) throw new Error("Sale not found.");
      setDetails(row);
      setMemosForSale(memos);
      // A second, dependent read rather than a join: it is needed only for the
      // receipt of a delivery order, and a driver row that cannot be read must
      // not stop the sale's own detail from opening.
      if (row.driverId) {
        try {
          const driver = await driversRepo.findById(row.driverId);
          setDetailsDriverName(driver?.name ?? null);
        } catch {
          setDetailsDriverName(null);
        }
      }
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
      <PageHeader title={t("salesHistory.title")} subtitle={t("salesHistory.subtitle")} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <StatCard label={t("salesHistory.statInclVat")} value={formatUsd(summary.total)} />
        <StatCard label={t("salesHistory.statTotalCost")} value={formatUsd(summary.cost)} />
        <StatCard
          label={t("salesHistory.statGrossProfit")}
          value={formatUsd(summary.profit)}
          tone={summary.profit >= 0 ? "good" : "bad"}
        />
        <StatCard label={t("salesHistory.statNetSales")} value={formatUsd(summary.net)} />
      </div>

      <div>
          <Card>
            <CardHeader
              title={t("salesHistory.cardTitle")}
              subtitle={cardSubtitle}
            />

            {loadError && (
              <div className="border-b border-danger-line bg-danger-bg px-5 py-3 text-xs text-danger-fg">
                {t("salesHistory.loadFailed", { error: loadError })}
              </div>
            )}

            {sales.length === 0 && !loading && !loadError ? (
              <EmptyState title={t("salesHistory.emptyState")} />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                      <th className="px-5 py-2">{t("salesHistory.colReturn")}</th>
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
                              profit >= 0 ? "text-good-fg" : "text-danger-fg",
                            )}
                          >
                            {formatUsd(profit)}
                          </td>

                          <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                            {profitMargin(s)}
                          </td>

                          <td className="px-5 py-2">
                            <ReturnBadge
                              status={returnStatus.get(s.id) ?? "none"}
                            />
                          </td>

                          <td className="px-5 py-2">
                            <Badge
                              tone={
                                s.status === "posted"
                                  ? "good"
                                  : s.status === "draft"
                                    ? "warn"
                                    : "neutral"
                              }
                              className={clsx(s.status === "voided" && "line-through")}
                            >
                              {t(`salesHistory.status${s.status.charAt(0).toUpperCase() + s.status.slice(1)}` as Parameters<typeof t>[0])}
                            </Badge>
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
              className="fixed inset-0 z-40 bg-scrim/20 backdrop-blur-sm"
              onClick={() => {
                setSelectedId(null);
                setDetails(null);
              }}
            />
            <div className="fixed inset-y-0 end-0 z-50 w-[820px] max-w-[80vw] animate-fade-in overflow-y-auto border-s border-slate-200 bg-surface shadow-2xl">
              <SaleDetailCard
                sale={details}
                loading={detailsLoading}
                error={detailsError}
                memos={memosForSale}
                returnStatus={
                  details ? (returnStatus.get(details.id) ?? "none") : "none"
                }
                hasOpenShift={hasOpenShift}
                onCreateReturn={() => details && setReturningSaleId(details.id)}
                onPrint={() => window.print()}
                onClose={() => {
                  setSelectedId(null);
                  setDetails(null);
                  setMemosForSale([]);
                  setDetailsDriverName(null);
                }}
              />
            </div>
          </>
        )}
      </div>

      {returnNotice && (
        <div className="fixed bottom-6 end-6 z-[60] rounded-lg border border-good-line bg-good-bg px-4 py-3 text-sm text-good-fg shadow-card print:hidden">
          {returnNotice}
        </div>
      )}

      {returningSaleId && storeId && details && (
        <CreateReturnModal
          storeId={storeId}
          userId={userId}
          saleId={returningSaleId}
          receiptNumber={details.receiptNumber}
          saleDateLabel={formatPrettyDate(
            isoToLocalDate(details.postedAt ?? details.createdAt),
          )}
          onClose={() => setReturningSaleId(null)}
          onPosted={async (creditMemoNumber) => {
            setReturningSaleId(null);
            setReturnNotice(
              t("returns.detailTitle", { number: String(creditMemoNumber) }),
            );
            // Re-read rather than patch local state: the authoritative figures
            // are whatever `post_credit_memo` committed.
            const id = details.id;
            await reload();
            await openDetails(id);
          }}
        />
      )}

      {/* Print-only receipt root — outside the drawer so fixed positioning escapes correctly */}
      {details && (
        <div id="receipt-print-root" className="hidden print:block">
          <ReceiptPrint
            sale={details}
            storeName={storeName}
            driverName={detailsDriverName}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The return-status pill. "None / part returned / returned" is derived by
 * comparing sold quantity against what posted credit memos sent back; nothing
 * is written onto the sale, so this is the only place the state exists.
 */
function ReturnBadge({ status }: { status: SaleReturnStatus }) {
  const { t } = useTranslation();
  if (status === "none") {
    return <span className="text-xs text-fg-muted">{t("salesHistory.returnStatusNone")}</span>;
  }
  return (
    <Badge tone={status === "full" ? "bad" : "warn"}>
      {status === "full"
        ? t("salesHistory.returnStatusFull")
        : t("salesHistory.returnStatusPartial")}
    </Badge>
  );
}

function SaleDetailCard({
  sale,
  loading,
  error,
  memos,
  returnStatus,
  hasOpenShift,
  onCreateReturn,
  onPrint,
  onClose,
}: {
  sale: SaleWithDetails | null;
  loading: boolean;
  error: string | null;
  memos: CreditMemo[];
  returnStatus: SaleReturnStatus;
  hasOpenShift: boolean;
  onCreateReturn: () => void;
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
              <CreateReturnButton
                sale={sale}
                returnStatus={returnStatus}
                hasOpenShift={hasOpenShift}
                onCreateReturn={onCreateReturn}
              />
            )}
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
          <p className="text-sm text-danger-fg">{error}</p>
        ) : sale ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label={t("salesHistory.detailStatInclVat")} value={formatUsd(sale.totalInclVatCents)} />
              <StatCard label={t("salesHistory.detailStatCost")} value={formatUsd(sale.cogsTotalCents)} />
              <StatCard
                label={t("salesHistory.detailStatProfit")}
                value={formatUsd(profit)}
                tone={profit >= 0 ? "good" : "bad"}
              />
              <StatCard label={t("salesHistory.detailStatMargin")} value={profitMargin(sale)} />
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
            <ReturnsOnThisSale memos={memos} />
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
  // WP-B2-B: which line's frozen recipe breakdown is open, by sale-line id.
  // One at a time, and closed by default: it explains a figure rather than
  // being part of reading the receipt.
  const [recipeBreakdownFor, setRecipeBreakdownFor] = useState<string | null>(null);
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
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
            // `line_subtotal_excl_vat_cents` is persisted POST-discount
            // (`lib/discount.ts::postDiscountLineTotals`), so
            // `lineDiscountCents` must not come off it again — the same
            // GP-A04 mistake, at line level. Subtracting it understated every
            // discounted line's profit and stopped the line profits summing to
            // the receipt's gross profit shown just above this table.
            const profit =
              line.lineSubtotalExclVatCents - line.lineCogsExclVatCents;

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
                  {/* The kitchen instruction this line was made to (WP-A2).
                      Shown because it is often the answer to "why was this
                      refunded?", and because two lines of one product are
                      otherwise indistinguishable on this table — including in
                      the return dialog that reads from it. */}
                  {line.kitchenNote && (
                    <div className="mt-0.5 inline-block rounded border border-warn-line bg-warn-bg px-1.5 py-0.5 text-xs text-warn-fg">
                      {line.kitchenNote}
                    </div>
                  )}
                </td>

                <td className="px-4 py-2 text-xs text-slate-600">
                  {line.barcodeUsedSnapshot ? (
                    <code>{line.barcodeUsedSnapshot}</code>
                  ) : (
                    <span className="text-fg-muted">—</span>
                  )}
                </td>

                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {line.quantityInUom ?? line.quantity}{" "}
                  {line.uomCodeSnapshot ?? "base"}
                </td>

                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {formatUsd(line.unitPriceInclVatCents)}
                </td>

                {/* The rate this line was costed at, and WHERE that rate came
                    from (WP-B1). The provenance matters most where the figure
                    is $0.00: a deliberate manual zero and a line nobody ever
                    costed print the same number and are not the same claim,
                    and the profit column two cells along reads as a 100%
                    margin either way. A line posted before migration 020
                    carries no source at all, which is the truth about it and
                    is labelled as such rather than guessed. */}
                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  <div>{formatUnitCostUsd(line.unitCogsExclVatMicrocents)}</div>
                  <div
                    className={clsx(
                      "mt-0.5 text-[11px]",
                      // Warn only where no cost exists. A legacy line carrying
                      // a real COGS rate — printed in the cell directly above
                      // — is unverifiable, not uncosted, and colouring it as a
                      // gap contradicted the figure beside it.
                      isCostBearingLine(
                        line.cogsSource,
                        line.unitCogsExclVatMicrocents,
                        line.lineCogsExclVatCents,
                      )
                        ? "text-fg-muted"
                        : "text-warn-fg",
                    )}
                  >
                    {t(cogsSourceLabelKey(line.cogsSource))}
                    {/* WP-B2-B: WHICH published version. A recipe-costed line
                        says "Recipe" either way, and after version 2 is
                        published that label alone no longer identifies what
                        the figure above was worked out from. */}
                    {line.recipeVersion !== null && (
                      <> · v{line.recipeVersion}</>
                    )}
                  </div>
                  {line.recipeVersion !== null && (
                    <button
                      type="button"
                      className="mt-0.5 text-[11px] underline decoration-dotted text-fg-muted hover:text-slate-900"
                      onClick={() =>
                        setRecipeBreakdownFor(
                          recipeBreakdownFor === line.id ? null : line.id,
                        )
                      }
                    >
                      {recipeBreakdownFor === line.id
                        ? t("common.hide")
                        : t("costing.recipeBreakdown.title", {
                            version: String(line.recipeVersion),
                          })}
                    </button>
                  )}
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
                    profit >= 0 ? "text-good-fg" : "text-danger-fg",
                  )}
                >
                  {formatUsd(profit)}
                </td>
              </tr>
            );
          })}
          {/* The frozen explanation of whichever recipe-costed line is open.
              A row of its own spanning the table, so the figures above keep
              their columns. */}
          {recipeBreakdownFor !== null && (
            <RecipeBreakdownRow
              saleItemId={recipeBreakdownFor}
              colSpan={8}
              unitCogsExclVatMicrocents={
                lines.find((l) => l.id === recipeBreakdownFor)
                  ?.unitCogsExclVatMicrocents ?? 0
              }
            />
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The frozen per-ingredient explanation of one posted recipe-costed line.
 *
 * Loaded on demand and LATEST-REQUEST-ONLY, the WP-A1 rule: the row this
 * belongs to changes by ordinary clicking, two answers are routinely in
 * flight, and nothing promises they return in order — so a superseded request
 * writes nothing, not the rows and not the error.
 *
 * Every figure comes out of `sale_item_recipe_costs` exactly as it was
 * written. Nothing is recomputed from today's rates, today's recipe or today's
 * units, which is the whole reason the table exists.
 */
function RecipeBreakdownRow({
  saleItemId,
  colSpan,
  unitCogsExclVatMicrocents,
}: {
  saleItemId: string;
  colSpan: number;
  /**
   * The LINE's own posted rate, per selling unit. Passed in rather than
   * re-read, because it is already on the row above and because it is the
   * figure the batch below has to be reconciled against by eye.
   */
  unitCogsExclVatMicrocents: number;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PostedRecipeCostRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const got = await recipesRepo.postedCostBreakdown({ saleItemId });
        if (mine !== generation.current) return;
        setRows(got);
      } catch (e) {
        if (mine !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [saleItemId]);

  const version = rows?.[0]?.recipeVersion ?? null;
  const yieldBase = rows?.[0]?.yieldQuantityBase ?? null;
  // The batch, as the sum of what the evidence says each ingredient
  // contributed to it. Summed for DISPLAY only and labelled as a batch: the
  // authoritative figure is the per-unit rate on the line, which
  // `recipe_cost.rs` derives from the accumulator and not from these rounded
  // microcents. Showing it is what makes a multi-serving recipe readable —
  // without it the four ingredient figures read as if they all belonged to one
  // plate, which overstates a twenty-portion sauce twentyfold.
  const batchMicrocents =
    rows === null
      ? null
      : rows.reduce((sum, r) => sum + r.contributionMicrocents, 0);

  return (
    <tr className="bg-slate-50/60">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {version === null
            ? t("costing.recipeBreakdown.title", { version: "—" })
            : t("costing.recipeBreakdown.title", { version: String(version) })}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-muted">
          {t("costing.recipeBreakdown.subtitle")}
        </div>

        {/* THREE DIFFERENT NUMBERS, named. The quantities below are for one
            BATCH; a batch yields `yieldBase` selling units; and the line was
            costed at the third figure, which is the first divided by the
            second. Before this the panel showed only the first and called the
            whole thing the item's recipe cost. */}
        {yieldBase !== null && batchMicrocents !== null && (
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
            <div>
              <dt className="inline text-fg-muted">
                {t("costing.recipeBreakdown.batchYield")}
              </dt>{" "}
              <dd className="inline font-medium tabular-nums text-slate-700">
                {yieldBase}
              </dd>
            </div>
            <div>
              <dt className="inline text-fg-muted">
                {t("costing.recipeBreakdown.batchCost")}
              </dt>{" "}
              <dd className="inline font-medium tabular-nums text-slate-700">
                {formatUnitCostUsd(batchMicrocents)}
              </dd>
            </div>
            <div>
              <dt className="inline text-fg-muted">
                {t("costing.recipeBreakdown.perSellingUnit")}
              </dt>{" "}
              <dd className="inline font-medium tabular-nums text-slate-900">
                {formatUnitCostUsd(unitCogsExclVatMicrocents)}
              </dd>
            </div>
          </dl>
        )}
        {yieldBase !== null && yieldBase > 1 && (
          <div className="mt-1 text-[11px] text-warn-fg">
            {t("costing.recipeBreakdown.batchNote", { yield: String(yieldBase) })}
          </div>
        )}

        {error !== null && (
          <div className="mt-2 text-xs text-danger-fg">{error}</div>
        )}
        {error === null && rows === null && (
          <div className="mt-2 text-xs text-fg-muted">{t("common.loading")}</div>
        )}
        {error === null && rows !== null && rows.length === 0 && (
          <div className="mt-2 text-xs text-fg-muted">
            {t("costing.recipeBreakdown.none")}
          </div>
        )}
        {error === null && rows !== null && rows.length > 0 && (
          <table className="mt-2 min-w-full text-xs">
            <thead className="text-start text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 pe-4 text-start">
                  {t("costing.recipeBreakdown.colIngredient")}
                </th>
                <th className="py-1 pe-4 text-start">
                  {t("costing.recipeBreakdown.colQuantity")}
                </th>
                <th className="py-1 pe-4 text-end">
                  {t("costing.recipeBreakdown.colRate")}
                </th>
                <th className="py-1 text-end">
                  {t("costing.recipeBreakdown.colContribution")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.componentProductId} className="border-t border-slate-200">
                  <td className="py-1 pe-4">
                    {r.componentName}
                    <span className="ms-1 text-fg-muted">
                      ({t(`costing.sourceShort.${r.costSource}`)})
                    </span>
                  </td>
                  <td className="py-1 pe-4 tabular-nums">
                    {formatQuantity(r.quantity)} {r.uomCode}
                    {r.wasteBps > 0 && (
                      <span className="ms-1 text-fg-muted">
                        +{(r.wasteBps / 100).toFixed(2).replace(/\.?0+$/, "")}%
                      </span>
                    )}
                  </td>
                  <td className="py-1 pe-4 text-end tabular-nums">
                    {formatUnitCostUsd(r.unitCostExclVatMicrocents)}
                  </td>
                  <td className="py-1 text-end tabular-nums">
                    {formatUnitCostUsd(r.contributionMicrocents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

function PaymentsTable({ payments }: { payments: SalePayment[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
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

/**
 * Create return, or the reason it is unavailable.
 *
 * The button is hidden rather than merely disabled when there is nothing to
 * return, because an action a cashier can never take is noise. When it is
 * unavailable for a reason they CAN fix — no open shift — it says so.
 *
 * None of this is a guard. `post_credit_memo` refuses a voided sale, a
 * fully-returned line and a missing shift on its own terms, inside the posting
 * transaction; this is only the affordance.
 */
function CreateReturnButton({
  sale,
  returnStatus,
  hasOpenShift,
  onCreateReturn,
}: {
  sale: SaleWithDetails;
  returnStatus: SaleReturnStatus;
  hasOpenShift: boolean;
  onCreateReturn: () => void;
}) {
  const { t } = useTranslation();

  if (sale.status !== "posted") {
    return (
      <span className="text-xs text-fg-muted print:hidden">
        {t("salesHistory.createReturnDisabledVoided")}
      </span>
    );
  }
  if (returnStatus === "full") {
    return (
      <span className="text-xs text-fg-muted print:hidden">
        {t("salesHistory.createReturnDisabledFull")}
      </span>
    );
  }
  if (!hasOpenShift) {
    return (
      <span className="text-xs text-warn-fg print:hidden">
        {t("salesHistory.createReturnDisabledNoShift")}
      </span>
    );
  }
  return (
    <Button variant="primary" size="sm" className="print:hidden" onClick={onCreateReturn}>
      {t("salesHistory.createReturn")}
    </Button>
  );
}

/** The credit memos already posted against this receipt. */
function ReturnsOnThisSale({ memos }: { memos: CreditMemo[] }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-slate-900">
        {t("salesHistory.returnsOnThisSaleTitle")}
      </div>
      {memos.length === 0 ? (
        <p className="text-xs text-slate-500">
          {t("salesHistory.returnsOnThisSaleNone")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">{t("salesHistory.returnsColMemo")}</th>
                <th className="px-4 py-2">{t("salesHistory.returnsColDate")}</th>
                <th className="px-4 py-2 text-end">
                  {t("salesHistory.returnsColRefunded")}
                </th>
                <th className="px-4 py-2">{t("salesHistory.returnsColReason")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {memos.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 font-medium text-slate-900">
                    #{m.creditMemoNumber}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {m.postedAt
                      ? formatPrettyDate(isoToLocalDate(m.postedAt))
                      : "\u2014"}
                  </td>
                  <td className="px-4 py-2 text-end tabular-nums text-slate-900">
                    {formatUsd(m.totalInclVatCents)}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {m.reason ?? "\u2014"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
