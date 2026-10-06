import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import {
  shiftsRepo,
  type ShiftSalesSummary,
  type ShiftPaymentRow,
  type ShiftDrawerExpectation,
  type ShiftRefundSummary,
  type ShiftRefundRow,
} from "../db/repos/shifts";
import type { Shift } from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { formatUsd, formatLbp, parseUsdInput, parseLbpInput } from "../lib/money";
import { useTranslation } from "../lib/i18n";
import type { PaymentMethod } from "../db/types";
import clsx from "clsx";

// ---------- Helpers ----------

function formatLocalDateTime(isoUtc: string): string {
  return new Date(isoUtc).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ---------- Sub-components ----------

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "muted" | "good" | "warn";
}) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-card transition-shadow hover:shadow-card-hover">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={clsx(
          "mt-1.5 text-2xl font-bold tabular-nums tracking-tight",
          tone === "good"
            ? "text-emerald-600"
            : tone === "warn"
              ? "text-amber-600"
              : tone === "muted"
                ? "text-slate-400"
                : "text-slate-900",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function DrawerRow({
  label,
  value,
  sub,
  isBold,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  isBold?: boolean;
  tone?: "good" | "warn" | "muted";
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span
        className={clsx(
          "text-sm",
          isBold ? "font-medium text-slate-900" : "text-slate-600",
        )}
      >
        {label}
      </span>
      <div className="text-end">
        <span
          className={clsx(
            "text-sm tabular-nums",
            isBold ? "font-semibold" : "",
            tone === "good"
              ? "text-emerald-700"
              : tone === "warn"
                ? "text-amber-700"
                : tone === "muted"
                  ? "text-slate-400"
                  : "text-slate-900",
          )}
        >
          {value}
        </span>
        {sub && <div className="text-xs text-slate-400">{sub}</div>}
      </div>
    </div>
  );
}

// ---------- Main page ----------

export default function ShiftSummary() {
  const { storeId, userId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  // null = no open shift; undefined = still loading
  const [activeShift, setActiveShift] = useState<Shift | null | undefined>(undefined);
  const [salesSummary, setSalesSummary] = useState<ShiftSalesSummary | null>(null);
  const [payments, setPayments] = useState<ShiftPaymentRow[]>([]);
  const [drawerCash, setDrawerCash] = useState<ShiftDrawerExpectation | null>(null);
  // Returns are kept as their OWN figures rather than folded into
  // `salesSummary`: a refund is not a negative sale, so the sales numbers above
  // stay gross and the net collection below is a visible subtraction.
  const [refundSummary, setRefundSummary] = useState<ShiftRefundSummary | null>(null);
  const [refunds, setRefunds] = useState<ShiftRefundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Open shift form inputs
  const [openingUsdInput, setOpeningUsdInput] = useState("");
  const [openingLbpInput, setOpeningLbpInput] = useState("");

  // Close shift form inputs
  const [closingUsdInput, setClosingUsdInput] = useState("");
  const [closingLbpInput, setClosingLbpInput] = useState("");

  const [submitting, setSubmitting] = useState(false);

  // ---------- Load ----------

  const loadShiftData = useCallback(async (shift: Shift) => {
    if (!storeId) return;
    const [summary, breakdown, cash, refundTotals, refundRows] = await Promise.all([
      shiftsRepo.getSalesSummary(shift.id, storeId),
      shiftsRepo.getPaymentBreakdown(shift.id, storeId),
      shiftsRepo.getDrawerExpectation(shift.id, storeId),
      shiftsRepo.getRefundSummary(shift.id, storeId),
      shiftsRepo.getRefundBreakdown(shift.id, storeId),
    ]);
    setSalesSummary(summary);
    setPayments(breakdown);
    setDrawerCash(cash);
    setRefundSummary(refundTotals);
    setRefunds(refundRows);
  }, [storeId]);

  const loadShift = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setError(null);
    try {
      const shift = await shiftsRepo.getOpenShift(storeId);
      setActiveShift(shift);
      if (shift) {
        await loadShiftData(shift);
      } else {
        setSalesSummary(null);
        setPayments([]);
        setDrawerCash(null);
        setRefundSummary(null);
        setRefunds([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, loadShiftData]);

  useEffect(() => {
    if (hydrated) void loadShift();
  }, [hydrated, loadShift]);

  // Refresh sales data only (without re-checking shift status)
  const refreshSummary = useCallback(async () => {
    if (!activeShift) return;
    try {
      await loadShiftData(activeShift);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeShift, loadShiftData]);

  // ---------- Drawer math ----------

  const drawer = useMemo(() => {
    // Cash in, change out and (since WP-06) cash refunded out all come from
    // `getDrawerExpectation`, which runs the same SQL `close_shift` runs inside
    // its transaction. This preview must not compute the drawer a second way in
    // React: the figure the cashier counts against is the one that gets
    // persisted (WP-04, parts E/K). In particular all three terms are cash-only
    // there, so a card tender and a card refund alike can neither inflate nor
    // reduce what the till is expected to hold.
    const cashUsdReceived = drawerCash?.cashUsdInCents ?? 0;
    const cashLbpReceived = drawerCash?.cashLbpIn ?? 0;
    const changeUsd = drawerCash?.changeUsdOutCents ?? 0;
    const changeLbp = drawerCash?.changeLbpOut ?? 0;
    const refundUsd = drawerCash?.refundUsdOutCents ?? 0;
    const refundLbp = drawerCash?.refundLbpOut ?? 0;

    const openingUsd = activeShift?.openingCashUsdCents ?? 0;
    const openingLbp = activeShift?.openingCashLbp ?? 0;

    const expectedUsd = openingUsd + cashUsdReceived - changeUsd - refundUsd;
    const expectedLbp = openingLbp + cashLbpReceived - changeLbp - refundLbp;

    // Live variance from closing inputs
    let closingUsd = 0;
    let closingLbp = 0;
    let closingUsdValid = false;
    let closingLbpValid = false;
    try {
      if (closingUsdInput.trim() !== "") {
        closingUsd = parseUsdInput(closingUsdInput);
        closingUsdValid = true;
      }
    } catch { /* invalid input — leave 0 */ }
    try {
      if (closingLbpInput.trim() !== "") {
        closingLbp = parseLbpInput(closingLbpInput);
        closingLbpValid = true;
      }
    } catch { /* invalid input — leave 0 */ }

    return {
      openingUsd,
      openingLbp,
      cashUsdReceived,
      cashLbpReceived,
      changeUsd,
      changeLbp,
      refundUsd,
      refundLbp,
      expectedUsd,
      expectedLbp,
      closingUsd,
      closingLbp,
      closingUsdValid,
      closingLbpValid,
      varianceUsd: closingUsdValid ? closingUsd - expectedUsd : null,
      varianceLbp: closingLbpValid ? closingLbp - expectedLbp : null,
    };
  }, [drawerCash, activeShift, closingUsdInput, closingLbpInput]);

  // ---------- Actions ----------

  async function handleOpenShift() {
    if (!storeId || !userId) return;
    setError(null);
    setSubmitting(true);
    try {
      let openingUsdCents = 0;
      if (openingUsdInput.trim() !== "") {
        openingUsdCents = parseUsdInput(openingUsdInput);
      }
      let openingLbp = 0;
      if (openingLbpInput.trim() !== "") {
        openingLbp = parseLbpInput(openingLbpInput);
      }
      const shift = await shiftsRepo.openShift({
        storeId,
        userId,
        openingCashUsdCents: openingUsdCents,
        openingCashLbp: openingLbp,
      });
      setActiveShift(shift);
      setSalesSummary({ receiptCount: 0, totalInclVatCents: 0, subtotalExclVatCents: 0, discountCents: 0, vatTotalCents: 0, netSalesExclVatCents: 0 });
      setPayments([]);
      setDrawerCash({
        cashUsdInCents: 0,
        cashLbpIn: 0,
        changeUsdOutCents: 0,
        changeLbpOut: 0,
        refundUsdOutCents: 0,
        refundLbpOut: 0,
      });
      setRefundSummary({
        memoCount: 0,
        subtotalExclVatCents: 0,
        vatTotalCents: 0,
        totalInclVatCents: 0,
        cogsReversedCents: 0,
      });
      setRefunds([]);
      setOpeningUsdInput("");
      setOpeningLbpInput("");
      setClosingUsdInput("");
      setClosingLbpInput("");
    } catch (e) {
      // The backend owns this decision now, so its refusal is the truth and the
      // local view may be stale — "a shift is already open" means one exists
      // that this page never saw. Re-read the real state, then state the
      // refusal: `loadShift` clears `error` on entry, so setting it first would
      // make the message flash and vanish.
      await resyncAfterFailure(e);
    } finally {
      setSubmitting(false);
    }
  }

  /** Re-read the authoritative shift state, then show why the command failed. */
  async function resyncAfterFailure(e: unknown): Promise<void> {
    const message = e instanceof Error ? e.message : String(e);
    await loadShift();
    setError(message);
  }

  async function handleCloseShift() {
    if (!activeShift || !storeId || !userId) return;
    setError(null);
    setSubmitting(true);
    try {
      let closingUsdCents = 0;
      if (closingUsdInput.trim() !== "") {
        closingUsdCents = parseUsdInput(closingUsdInput);
      }
      let closingLbp = 0;
      if (closingLbpInput.trim() !== "") {
        closingLbp = parseLbpInput(closingLbpInput);
      }
      await shiftsRepo.closeShift({
        shiftId: activeShift.id,
        storeId,
        userId,
        closingCashUsdCents: closingUsdCents,
        closingCashLbp: closingLbp,
      });
      setClosingUsdInput("");
      setClosingLbpInput("");
      // Re-read rather than assume: the committed shift state is whatever
      // `close_shift` wrote, and the store may already have a new shift open.
      await loadShift();
    } catch (e) {
      await resyncAfterFailure(e);
    } finally {
      setSubmitting(false);
    }
  }

  // ---------- Render ----------

  if (!hydrated || activeShift === undefined) {
    return <div className="text-sm text-slate-500">{t("shift.loading")}</div>;
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">{t("shift.title")}</h2>
          <p className="text-sm text-slate-600">{t("shift.subtitle")}</p>
        </div>
        {activeShift && (
          <Button variant="ghost" onClick={refreshSummary} disabled={loading || submitting}>
            {t("shift.refresh")}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── NO OPEN SHIFT ────────────────────────────────────────── */}
      {!activeShift && (
        <Card>
          <CardHeader
            title={t("shift.noOpenShiftTitle")}
            subtitle={t("shift.noOpenShiftSubtitle")}
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label={t("shift.openingCashUsd")}
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={openingUsdInput}
                onChange={(e) => setOpeningUsdInput(e.target.value)}
              />
              <Input
                label={t("shift.openingCashLbp")}
                inputMode="numeric"
                placeholder="0"
                suffix="L.L."
                value={openingLbpInput}
                onChange={(e) => setOpeningLbpInput(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              onClick={handleOpenShift}
              disabled={submitting}
            >
              {submitting ? t("shift.opening") : t("shift.openShift")}
            </Button>
          </CardBody>
        </Card>
      )}

      {/* ── OPEN SHIFT ───────────────────────────────────────────── */}
      {activeShift && (
        <>
          {/* Shift status banner */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-3">
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <div className="flex-1">
              <span className="text-sm font-semibold text-emerald-800">
                {t("shift.shiftOpen")}
              </span>
              <span className="ms-3 text-sm text-emerald-700">
                {t("shift.openedAt")} {formatLocalDateTime(activeShift.openedAt)}
              </span>
            </div>
            <div className="flex gap-6 text-sm">
              <span className="text-slate-600">
                {t("shift.openingUsd")}{" "}
                <span className="font-medium text-slate-900">
                  {formatUsd(activeShift.openingCashUsdCents)}
                </span>
              </span>
              <span className="text-slate-600">
                {t("shift.openingLbp")}{" "}
                <span className="font-medium text-slate-900">
                  {formatLbp(activeShift.openingCashLbp)}
                </span>
              </span>
            </div>
          </div>

          {/* Section 1 — Sales Collection */}
          <div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
              {t("shift.salesCollection")}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                label={t("shift.receipts")}
                value={salesSummary ? String(salesSummary.receiptCount) : "—"}
              />
              <StatCard
                label={t("shift.salesInclVat")}
                value={salesSummary ? formatUsd(salesSummary.totalInclVatCents) : "—"}
                sub={t("shift.grossCollected")}
              />
              <StatCard
                label={t("shift.netExclVat")}
                value={salesSummary ? formatUsd(salesSummary.netSalesExclVatCents) : "—"}
                sub={t("shift.afterDiscounts")}
              />
              <StatCard
                label={t("shift.outputVat")}
                value={salesSummary ? formatUsd(salesSummary.vatTotalCents) : "—"}
                tone="muted"
                sub={t("shift.owedToAuthority")}
              />
              <StatCard
                label={t("shift.discounts")}
                value={salesSummary ? formatUsd(salesSummary.discountCents) : "—"}
                tone={salesSummary && salesSummary.discountCents > 0 ? "warn" : undefined}
              />
            </div>
          </div>

          {/* Section 2 — Payment Method Breakdown */}
          <Card>
            <CardHeader
              title={t("shift.paymentBreakdownTitle")}
              subtitle={t("shift.paymentBreakdownSubtitle")}
            />
            {payments.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-500">
                {t("shift.noPaymentsYet")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2">{t("shift.colMethod")}</th>
                      <th className="px-5 py-2 text-end">{t("shift.colNativeAmount")}</th>
                      <th className="px-5 py-2 text-end">{t("shift.colUsdEquivalent")}</th>
                      <th className="px-5 py-2 text-end">{t("shift.colChangeGiven")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {payments.map((row) => {
                      const nativeDisplay =
                        row.currency === "LBP"
                          ? formatLbp(row.amountNativeLbp)
                          : formatUsd(row.amountNativeUsdCents);

                      const changeDisplay =
                        row.changeGivenUsdCents > 0 && row.changeGivenLbp > 0
                          ? `${formatUsd(row.changeGivenUsdCents)} + ${formatLbp(row.changeGivenLbp)}`
                          : row.changeGivenUsdCents > 0
                            ? formatUsd(row.changeGivenUsdCents)
                            : row.changeGivenLbp > 0
                              ? formatLbp(row.changeGivenLbp)
                              : "—";

                      return (
                        <tr key={`${row.method}-${row.currency}`} className="hover:bg-slate-50">
                          <td className="px-5 py-2.5 font-medium text-slate-900">
                            {t(`shift.paymentMethods.${row.method as PaymentMethod}`)}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-700">
                            {nativeDisplay}
                            {row.currency === "LBP" && row.amountUsdCentsEquivalent > 0 && (
                              <div className="text-xs text-slate-400">
                                ≈ {formatUsd(row.amountUsdCentsEquivalent)}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-700">
                            {formatUsd(row.amountUsdCentsEquivalent)}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-500">
                            {changeDisplay}
                          </td>
                        </tr>
                      );
                    })}

                    {payments.length > 1 && (() => {
                      const totalUsd = payments.reduce((s, p) => s + p.amountUsdCentsEquivalent, 0);
                      const totalChangeUsd = payments.reduce((s, p) => s + p.changeGivenUsdCents, 0);
                      const totalChangeLbp = payments.reduce((s, p) => s + p.changeGivenLbp, 0);
                      const changeSummary =
                        totalChangeUsd > 0 && totalChangeLbp > 0
                          ? `${formatUsd(totalChangeUsd)} + ${formatLbp(totalChangeLbp)}`
                          : totalChangeUsd > 0
                            ? formatUsd(totalChangeUsd)
                            : totalChangeLbp > 0
                              ? formatLbp(totalChangeLbp)
                              : "—";
                      return (
                        <tr className="bg-slate-50 font-semibold">
                          <td className="px-5 py-2.5 text-slate-900">{t("common.total")}</td>
                          <td className="px-5 py-2.5 text-end text-xs text-slate-400">—</td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-900">
                            {formatUsd(totalUsd)}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-700">
                            {changeSummary}
                          </td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Section 3 — Returns / Refunds (WP-06) */}
          <div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
              {t("shift.returnsTitle")}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                label={t("shift.returnsCount")}
                value={refundSummary ? String(refundSummary.memoCount) : "—"}
              />
              <StatCard
                label={t("shift.refundsInclVat")}
                value={refundSummary ? formatUsd(refundSummary.totalInclVatCents) : "—"}
                tone={refundSummary && refundSummary.totalInclVatCents > 0 ? "warn" : undefined}
                sub={t("shift.refundsPaidOut")}
              />
              <StatCard
                label={t("shift.vatReversed")}
                value={refundSummary ? formatUsd(refundSummary.vatTotalCents) : "—"}
                tone="muted"
                sub={t("shift.vatReversedHint")}
              />
              <StatCard
                label={t("shift.netCollection")}
                value={
                  salesSummary && refundSummary
                    ? formatUsd(
                        salesSummary.totalInclVatCents - refundSummary.totalInclVatCents,
                      )
                    : "—"
                }
                sub={t("shift.netCollectionHint")}
              />
              {/*
                The shift's NET SALES, on exactly the definition Local Reports
                uses: post-discount revenue excl. VAT less the revenue posted
                credit memos reversed. Stated here rather than in the sales
                section above, because that section is deliberately before
                returns — and net sales is the figure the shift's gross profit
                would be built on, so the two screens must not mean different
                things by it. Cash is a separate concept and lives below.
              */}
              <StatCard
                label={t("shift.netSalesExclVat")}
                value={
                  salesSummary && refundSummary
                    ? formatUsd(
                        salesSummary.netSalesExclVatCents -
                          refundSummary.subtotalExclVatCents,
                      )
                    : "—"
                }
                sub={t("shift.netSalesExclVatHint")}
              />
            </div>

            {refunds.length > 0 && (
              <Card className="mt-3">
                <CardHeader
                  title={t("shift.refundBreakdownTitle")}
                  subtitle={t("shift.refundBreakdownSubtitle")}
                />
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-5 py-2">{t("shift.colMethod")}</th>
                        <th className="px-5 py-2 text-end">{t("shift.colNativeAmount")}</th>
                        <th className="px-5 py-2 text-end">{t("shift.colUsdEquivalent")}</th>
                        <th className="px-5 py-2">{t("shift.colTouchesDrawer")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {refunds.map((row) => (
                        <tr key={`${row.method}-${row.currency}`} className="hover:bg-slate-50">
                          <td className="px-5 py-2.5 font-medium text-slate-900">
                            {t(`shift.paymentMethods.${row.method as PaymentMethod}`)}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-700">
                            {row.currency === "LBP"
                              ? formatLbp(row.amountNativeLbp)
                              : formatUsd(row.amountNativeUsdCents)}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-slate-700">
                            {formatUsd(row.amountUsdCentsEquivalent)}
                          </td>
                          <td className="px-5 py-2.5 text-xs text-slate-500">
                            {row.method === "cash_usd" || row.method === "cash_lbp"
                              ? t("shift.drawerYes")
                              : t("shift.drawerNo")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>

          {/* Section 4 — Cash Drawer + Close Shift */}
          <Card>
            <CardHeader
              title={t("shift.cashDrawerTitle")}
              subtitle={t("shift.cashDrawerSubtitle")}
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">

                {/* USD column */}
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {t("shift.usdLabel")}
                  </div>
                  <div className="divide-y divide-slate-100">
                    <DrawerRow
                      label={t("shift.openingCash")}
                      value={formatUsd(drawer.openingUsd)}
                    />
                    <DrawerRow
                      label={t("shift.cashReceived")}
                      value={formatUsd(drawer.cashUsdReceived)}
                    />
                    <DrawerRow
                      label={t("shift.changeGiven")}
                      value={drawer.changeUsd > 0 ? `− ${formatUsd(drawer.changeUsd)}` : "—"}
                      tone={drawer.changeUsd > 0 ? "warn" : undefined}
                    />
                    <DrawerRow
                      label={t("shift.cashRefunded")}
                      value={drawer.refundUsd > 0 ? `− ${formatUsd(drawer.refundUsd)}` : "—"}
                      tone={drawer.refundUsd > 0 ? "warn" : undefined}
                    />
                    <DrawerRow
                      label={t("shift.expectedInDrawer")}
                      value={formatUsd(drawer.expectedUsd)}
                      isBold
                    />
                  </div>

                  <div className="mt-3">
                    <Input
                      label={t("shift.closingCashUsd")}
                      inputMode="decimal"
                      placeholder="0.00"
                      prefix="$"
                      value={closingUsdInput}
                      onChange={(e) => setClosingUsdInput(e.target.value)}
                    />
                  </div>

                  {drawer.varianceUsd !== null && (
                    <div className="mt-2 divide-y divide-slate-100">
                      <DrawerRow
                        label={t("shift.variance")}
                        value={
                          drawer.varianceUsd === 0
                            ? t("shift.exact")
                            : `${drawer.varianceUsd > 0 ? "+" : ""}${formatUsd(drawer.varianceUsd)}`
                        }
                        isBold
                        tone={
                          drawer.varianceUsd === 0
                            ? "good"
                            : drawer.varianceUsd > 0
                              ? "good"
                              : "warn"
                        }
                      />
                    </div>
                  )}
                </div>

                {/* LBP column */}
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {t("shift.lbpLabel")}
                  </div>
                  <div className="divide-y divide-slate-100">
                    <DrawerRow
                      label={t("shift.openingCash")}
                      value={formatLbp(drawer.openingLbp)}
                    />
                    <DrawerRow
                      label={t("shift.cashReceived")}
                      value={formatLbp(drawer.cashLbpReceived)}
                    />
                    <DrawerRow
                      label={t("shift.changeGiven")}
                      value={drawer.changeLbp > 0 ? `− ${formatLbp(drawer.changeLbp)}` : "—"}
                      tone={drawer.changeLbp > 0 ? "warn" : undefined}
                    />
                    <DrawerRow
                      label={t("shift.cashRefunded")}
                      value={drawer.refundLbp > 0 ? `− ${formatLbp(drawer.refundLbp)}` : "—"}
                      tone={drawer.refundLbp > 0 ? "warn" : undefined}
                    />
                    <DrawerRow
                      label={t("shift.expectedInDrawer")}
                      value={formatLbp(drawer.expectedLbp)}
                      isBold
                    />
                  </div>

                  <div className="mt-3">
                    <Input
                      label={t("shift.closingCashLbp")}
                      inputMode="numeric"
                      placeholder="0"
                      suffix="L.L."
                      value={closingLbpInput}
                      onChange={(e) => setClosingLbpInput(e.target.value)}
                    />
                  </div>

                  {drawer.varianceLbp !== null && (
                    <div className="mt-2 divide-y divide-slate-100">
                      <DrawerRow
                        label={t("shift.variance")}
                        value={
                          drawer.varianceLbp === 0
                            ? t("shift.exact")
                            : `${drawer.varianceLbp > 0 ? "+" : ""}${formatLbp(drawer.varianceLbp)}`
                        }
                        isBold
                        tone={
                          drawer.varianceLbp === 0
                            ? "good"
                            : drawer.varianceLbp > 0
                              ? "good"
                              : "warn"
                        }
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6 border-t border-slate-100 pt-5">
                <Button
                  variant="primary"
                  onClick={handleCloseShift}
                  disabled={submitting}
                >
                  {submitting ? t("shift.closing") : t("shift.closeShift")}
                </Button>
                <p className="mt-2 text-xs text-slate-500">
                  {t("shift.closingFieldsOptional")}
                </p>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
