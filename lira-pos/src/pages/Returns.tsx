// src/pages/Returns.tsx
//
// Posted credit memos, newest first, with a drawer showing one in full.
//
// A return is CREATED from the receipt it reverses, because every figure on it
// is derived from that receipt and choosing a sale is the first decision a
// cashier makes. V1.1: that choice can now be made HERE — type the receipt
// number, pick the items, confirm — as well as from a Sales History receipt.
// Every role may post a sale-linked return (founder decision); the backend's
// quantity, tender and drawer caps are unchanged.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { creditMemosRepo } from "../db/repos/creditMemos";
import { query } from "../db/client";
import type {
  CreditMemo,
  CreditMemoLine,
  CreditMemoRefund,
  CreditMemoWithDetails,
  PaymentMethod,
} from "../db/types";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { formatLbp, formatUsd } from "../lib/money";
import { formatPrettyDate, isoToLocalDate, relativeFromToday } from "../lib/dates";
import { CreditMemoPrint } from "../components/CreditMemoPrint";
import { CreateReturnModal } from "../components/CreateReturnModal";
import { Input } from "../components/ui/Input";
import { costsVisible } from "../db/projection";
import { browserRefundStorage, loadPendingRefunds, type RefundAttempt } from "../lib/refundAttempt";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

type CreditMemoRow = CreditMemo & { originalReceiptNumber: number | null };

/** A cost the session may not read is NULL: shown as a dash, never "$0.00".
 *  (The columns are hidden for such a session anyway; this is the backstop.) */
function costCell(cents: number | null): string {
  return cents === null ? "—" : formatUsd(cents);
}

function isoToTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function Returns() {
  const { storeId, userId, hydrated } = useActiveContext();
  const { t } = useTranslation();
  const showCost = costsVisible();

  // V1.1: start a return from a receipt number.
  const [receiptInput, setReceiptInput] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [returning, setReturning] = useState<
    { saleId: string; receiptNumber: number; postedAt: string } | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Codex V1.1 P0: refunds whose outcome never confirmed, from storage — so
  // after a restart or a lock they are on screen without anyone having to
  // remember the receipt. Each one is resolved inside the return screen.
  const readPending = useCallback(
    () => loadPendingRefunds(browserRefundStorage()).filter((a) => a.storeId === storeId),
    [storeId],
  );
  const [pendingRefunds, setPendingRefunds] = useState<RefundAttempt[]>(readPending);
  useEffect(() => setPendingRefunds(readPending()), [readPending]);

  async function openPending(a: RefundAttempt) {
    setNotice(null);
    setLookupError(null);
    try {
      const rows = await query<{ posted_at: string | null; created_at: string }>(
        "SELECT posted_at, created_at FROM sales WHERE id = ? AND store_id = ? LIMIT 1",
        [a.saleId, a.storeId],
      );
      const row = rows[0];
      setReturning({
        saleId: a.saleId,
        receiptNumber: a.receiptNumber,
        postedAt: row ? (row.posted_at ?? row.created_at) : a.startedAt,
      });
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : String(e));
    }
  }

  async function findReceipt() {
    if (!storeId) return;
    setLookupError(null);
    setNotice(null);
    const n = receiptInput.trim();
    if (!/^\d{1,9}$/.test(n)) {
      setLookupError(t("returns.lookupInvalid"));
      return;
    }
    try {
      const rows = await query<{ id: string; receipt_number: number; posted_at: string | null; created_at: string }>(
        `SELECT id, receipt_number, posted_at, created_at FROM sales
          WHERE store_id = ? AND receipt_number = ? AND status = 'posted' LIMIT 1`,
        [storeId, Number(n)],
      );
      const row = rows[0];
      if (!row) {
        setLookupError(t("returns.lookupNotFound", { number: n }));
        return;
      }
      setReturning({
        saleId: row.id,
        receiptNumber: row.receipt_number,
        postedAt: row.posted_at ?? row.created_at,
      });
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : String(e));
    }
  }

  const [storeName, setStoreName] = useState("Store");
  const [memos, setMemos] = useState<CreditMemoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<CreditMemoWithDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId || !hydrated) return;
    query<{ name: string }>("SELECT name FROM stores WHERE id = ? LIMIT 1", [storeId])
      .then((rows) => {
        if (rows[0]) setStoreName(rows[0].name);
      })
      .catch(() => {});
  }, [storeId, hydrated]);

  const reload = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setMemos(await creditMemosRepo.list({ storeId, limit: 200 }));
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
      const row = await creditMemosRepo.findByIdWithDetails(id);
      if (!row) throw new Error("Credit memo not found.");
      setDetails(row);
    } catch (e) {
      setDetailsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailsLoading(false);
    }
  }

  const summary = useMemo(
    () =>
      memos
        .filter((m) => m.status === "posted")
        .reduce(
          (acc, m) => {
            acc.refunded += m.totalInclVatCents;
            acc.vat += m.vatTotalCents;
            // NULL is withheld (a cashier); it is only ever summed where
            // costs are visible, and then every memo carries its figure.
            acc.cost += m.cogsReversedCents ?? 0;
            return acc;
          },
          { refunded: 0, vat: 0, cost: 0 },
        ),
    [memos],
  );

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("common.loading")}</div>;
  }

  const cardSubtitle = loading
    ? t("common.loading")
    : t(memos.length === 1 ? "returns.countOne" : "returns.countMany", {
        count: String(memos.length),
      });

  return (
    <div className="space-y-6">
      <PageHeader title={t("returns.title")} subtitle={t("returns.subtitle")} />

      <Card>
        <CardHeader title={t("returns.startTitle")} subtitle={t("returns.startSubtitle")} />
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void findReceipt();
            }}
          >
            <div className="w-48">
              <Input
                label={t("returns.receiptNumberLabel")}
                inputMode="numeric"
                value={receiptInput}
                onChange={(e) => setReceiptInput(e.target.value)}
                error={lookupError}
                autoFocus
              />
            </div>
            <Button type="submit" variant="primary">
              {t("returns.startButton")}
            </Button>
          </form>
          {notice && <p className="mt-3 text-sm font-semibold text-good-fg">{notice}</p>}
          {pendingRefunds.map((a) => (
            <div
              key={a.memoId}
              role="alert"
              data-testid="pending-refund-banner"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn-line bg-warn-bg px-4 py-2 text-sm text-warn-fg"
            >
              <span>
                {t("returns.pendingBanner", {
                  number: String(a.receiptNumber),
                  total: formatUsd(a.totalUsdCents),
                })}
              </span>
              <Button size="sm" variant="primary" onClick={() => void openPending(a)}>
                {t("returns.pendingResolve")}
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className={clsx("grid grid-cols-1 gap-3", showCost ? "md:grid-cols-3" : "md:grid-cols-2")}>
        <StatCard
          label={t("returns.statRefund")}
          value={formatUsd(summary.refunded)}
          tone={summary.refunded > 0 ? "warn" : undefined}
        />
        <StatCard label={t("returns.statVatReversed")} value={formatUsd(summary.vat)} />
        {showCost && (
          <StatCard label={t("returns.statCostReversed")} value={formatUsd(summary.cost)} />
        )}
      </div>

      <div>
        <Card>
          <CardHeader title={t("returns.listTitle")} subtitle={cardSubtitle} />

          {loadError && (
            <div className="border-b border-danger-line bg-danger-bg px-5 py-3 text-xs text-danger-fg">
              {t("returns.loadFailed", { error: loadError })}
            </div>
          )}

          {memos.length === 0 && !loading && !loadError ? (
            <EmptyState title={t("returns.emptyState")} />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-2">{t("returns.colMemo")}</th>
                    <th className="px-5 py-2">{t("returns.colReceipt")}</th>
                    <th className="px-5 py-2">{t("returns.colDate")}</th>
                    <th className="px-5 py-2">{t("returns.colTime")}</th>
                    <th className="px-5 py-2 text-end">{t("returns.colRefunded")}</th>
                    <th className="px-5 py-2 text-end">{t("returns.colVatReversed")}</th>
                    {showCost && (
                      <th className="px-5 py-2 text-end">{t("returns.colCostReversed")}</th>
                    )}
                    <th className="px-5 py-2">{t("returns.colStatus")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {memos.map((m) => {
                    const stamp = m.postedAt ?? m.createdAt;
                    const localDate = isoToLocalDate(stamp);
                    return (
                      <tr
                        key={m.id}
                        className={clsx(
                          "cursor-pointer transition-colors hover:bg-slate-50",
                          selectedId === m.id && "bg-brand/5",
                        )}
                        onClick={() => void openDetails(m.id)}
                      >
                        <td className="px-5 py-2 font-medium text-slate-900">
                          #{m.creditMemoNumber}
                        </td>
                        <td className="px-5 py-2 text-slate-700">
                          {m.originalReceiptNumber !== null
                            ? `#${m.originalReceiptNumber}`
                            : "—"}
                        </td>
                        <td className="px-5 py-2 text-slate-700">
                          {formatPrettyDate(localDate)}
                          <div className="text-xs text-slate-500">
                            {relativeFromToday(localDate)}
                          </div>
                        </td>
                        <td className="px-5 py-2 text-slate-600">{isoToTime(stamp)}</td>
                        <td className="px-5 py-2 text-end tabular-nums font-medium text-slate-900">
                          {formatUsd(m.totalInclVatCents)}
                        </td>
                        <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                          {formatUsd(m.vatTotalCents)}
                        </td>
                        {showCost && (
                          <td className="px-5 py-2 text-end tabular-nums text-slate-700">
                            {costCell(m.cogsReversedCents)}
                          </td>
                        )}
                        <td className="px-5 py-2">
                          <Badge
                            tone={
                              m.status === "posted"
                                ? "good"
                                : m.status === "draft"
                                  ? "warn"
                                  : "neutral"
                            }
                            className={clsx(m.status === "voided" && "line-through")}
                          >
                            {t(
                              `returns.status${m.status.charAt(0).toUpperCase() + m.status.slice(1)}`,
                            )}
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
              <CreditMemoDetail
                memo={details}
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

      {/* Print-only root — outside the drawer so fixed positioning escapes. */}
      {details && (
        <div id="credit-memo-print-root" className="hidden print:block">
          <CreditMemoPrint memo={details} storeName={storeName} />
        </div>
      )}

      {returning && storeId && (
        <CreateReturnModal
          storeId={storeId}
          userId={userId}
          saleId={returning.saleId}
          receiptNumber={returning.receiptNumber}
          saleDateLabel={formatPrettyDate(isoToLocalDate(returning.postedAt))}
          onClose={() => {
            setReturning(null);
            setPendingRefunds(readPending());
          }}
          onPosted={async (creditMemoNumber) => {
            setReturning(null);
            setPendingRefunds(readPending());
            setReceiptInput("");
            setNotice(t("returns.postedNotice", { number: String(creditMemoNumber) }));
            await reload();
          }}
        />
      )}
    </div>
  );
}

function CreditMemoDetail({
  memo,
  loading,
  error,
  onPrint,
  onClose,
}: {
  memo: CreditMemoWithDetails | null;
  loading: boolean;
  error: string | null;
  onPrint: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const showCost = costsVisible();

  const title = memo
    ? t("returns.detailTitle", { number: String(memo.creditMemoNumber) })
    : t("returns.detailFallbackTitle");

  const subtitle =
    memo && memo.originalReceiptNumber !== null
      ? t("returns.detailAgainst", { receipt: String(memo.originalReceiptNumber) })
      : undefined;

  return (
    <Card className="border-0 shadow-none">
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {memo && (
              <Button variant="ghost" size="sm" className="print:hidden" onClick={onPrint}>
                {t("returns.printMemo")}
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
          <p className="text-sm text-slate-500">{t("returns.detailLoading")}</p>
        ) : error ? (
          <p className="text-sm text-danger-fg">{error}</p>
        ) : memo ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label={t("returns.statRefund")}
                value={formatUsd(memo.totalInclVatCents)}
                tone="warn"
              />
              <StatCard
                label={t("returns.statVatReversed")}
                value={formatUsd(memo.vatTotalCents)}
              />
              {showCost && (
                <StatCard
                  label={t("returns.statCostReversed")}
                  value={costCell(memo.cogsReversedCents)}
                />
              )}
              <StatCard
                label={t("returns.statDiscountReversed")}
                value={formatUsd(memo.discountCents)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">{t("returns.infoTitle")}</div>
                <DetailRow label={t("returns.infoStatus")} value={memo.status} />
                <DetailRow label={t("returns.infoReason")} value={memo.reason ?? "—"} />
                <DetailRow
                  label={t("returns.infoExchangeRate")}
                  value={`${memo.exchangeRateLbpPerUsd.toLocaleString()} L.L. / USD`}
                />
                <DetailRow label={t("returns.infoNotes")} value={memo.notes ?? "—"} />
              </div>

              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-medium text-slate-900">{t("returns.totalsTitle")}</div>
                <DetailRow
                  label={t("returns.totalsSubtotal")}
                  value={formatUsd(memo.subtotalExclVatCents)}
                />
                <DetailRow
                  label={t("returns.totalsVat")}
                  value={formatUsd(memo.vatTotalCents)}
                />
                <DetailRow
                  label={t("returns.totalsDiscount")}
                  value={formatUsd(memo.discountCents)}
                />
                <DetailRow
                  label={t("returns.totalsTotal")}
                  value={formatUsd(memo.totalInclVatCents)}
                />
                {showCost && (
                  <DetailRow
                    label={t("returns.totalsCost")}
                    value={costCell(memo.cogsReversedCents)}
                  />
                )}
              </div>
            </div>

            <ReturnedLinesTable lines={memo.lines} showCost={showCost} />
            <RefundsTable refunds={memo.refunds} />
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
      <span className="text-end text-xs font-medium text-slate-800">{value}</span>
    </div>
  );
}

function ReturnedLinesTable({
  lines,
  showCost,
}: {
  lines: CreditMemoLine[];
  showCost: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">{t("returns.linesColProduct")}</th>
            <th className="px-4 py-2 text-end">{t("returns.linesColQty")}</th>
            <th className="px-4 py-2 text-end">{t("returns.linesColUnitPrice")}</th>
            <th className="px-4 py-2 text-end">{t("returns.linesColVat")}</th>
            <th className="px-4 py-2 text-end">{t("returns.linesColLineTotal")}</th>
            <th className="px-4 py-2">{t("returns.linesColRestock")}</th>
            {showCost && <th className="px-4 py-2 text-end">{t("returns.linesColCost")}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((line) => (
            <tr key={line.id}>
              <td className="px-4 py-2">
                <div className="font-medium text-slate-900">
                  {line.productNameSnapshot}
                </div>
                <div className="text-xs text-slate-500">
                  {line.productSkuSnapshot
                    ? `SKU ${line.productSkuSnapshot}`
                    : t("returns.noSkuLabel")}
                  {line.uomCodeSnapshot ? ` · ${line.uomCodeSnapshot}` : ""}
                </div>
              </td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {line.quantityInUom} {line.uomCodeSnapshot ?? "base"}
              </td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {formatUsd(line.unitPriceInclVatCents)}
              </td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {formatUsd(line.lineVatCents)}
              </td>
              <td className="px-4 py-2 text-end tabular-nums font-medium text-slate-900">
                {formatUsd(line.lineTotalInclVatCents)}
              </td>
              <td className="px-4 py-2">
                <Badge
                  tone={
                    line.isService
                      ? "neutral"
                      : line.returnToStock
                        ? "good"
                        : "warn"
                  }
                >
                  {line.isService
                    ? t("returns.restockService")
                    : line.returnToStock
                      ? t("returns.restockYes")
                      : t("returns.restockNo")}
                </Badge>
              </td>
              {showCost && (
                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                  {costCell(line.lineCogsExclVatCents)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefundsTable({ refunds }: { refunds: CreditMemoRefund[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">{t("returns.refundsColMethod")}</th>
            <th className="px-4 py-2">{t("returns.refundsColCurrency")}</th>
            <th className="px-4 py-2 text-end">{t("returns.refundsColNative")}</th>
            <th className="px-4 py-2 text-end">{t("returns.refundsColUsd")}</th>
            <th className="px-4 py-2">{t("returns.refundsColReference")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {refunds.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2 text-slate-700">
                {t(`shift.paymentMethods.${r.method as PaymentMethod}`)}
              </td>
              <td className="px-4 py-2 text-slate-700">{r.currency}</td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {r.currency === "USD"
                  ? formatUsd(r.amountNativeUsdCents)
                  : formatLbp(r.amountNativeLbp)}
              </td>
              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                {formatUsd(r.amountUsdCentsEquivalent)}
              </td>
              <td className="px-4 py-2 text-xs text-slate-600">{r.reference ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
