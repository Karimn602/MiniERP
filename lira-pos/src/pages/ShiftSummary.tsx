import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import {
  shiftSummaryRepo,
  type ShiftSalesSummary,
  type ShiftPaymentRow,
} from "../db/repos/shiftSummary";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { formatUsd, formatLbp } from "../lib/money";
import { todayLocalDate, formatPrettyDate } from "../lib/dates";
import type { PaymentMethod } from "../db/types";
import clsx from "clsx";

// ---------- Helpers ----------

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash_usd: "Cash USD",
  cash_lbp: "Cash LBP",
  card_usd: "Card USD",
  card_lbp: "Card LBP",
  bank_transfer: "Bank Transfer",
  wallet: "Wallet",
  store_credit: "Store Credit",
  other: "Other",
};

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
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={clsx(
          "mt-1 text-lg font-semibold tabular-nums",
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
      <div className="text-right">
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
        {sub && (
          <div className="text-xs text-slate-400">{sub}</div>
        )}
      </div>
    </div>
  );
}

// ---------- Main page ----------

export default function ShiftSummary() {
  const { storeId, hydrated } = useActiveContext();

  const [date, setDate] = useState(todayLocalDate);
  const [appliedDate, setAppliedDate] = useState(todayLocalDate);

  const [salesSummary, setSalesSummary] = useState<ShiftSalesSummary | null>(null);
  const [payments, setPayments] = useState<ShiftPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [summary, breakdown] = await Promise.all([
        shiftSummaryRepo.salesSummary({ storeId, date: appliedDate }),
        shiftSummaryRepo.paymentBreakdown({ storeId, date: appliedDate }),
      ]);
      setSalesSummary(summary);
      setPayments(breakdown);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, appliedDate]);

  useEffect(() => {
    if (hydrated) void load();
  }, [hydrated, load]);

  // ---------- Derived cash drawer numbers ----------

  const drawer = useMemo(() => {
    const cashUsdRow = payments.find((p) => p.method === "cash_usd");
    const cashLbpRow = payments.find((p) => p.method === "cash_lbp");

    const cashUsdReceived = cashUsdRow?.amountNativeUsdCents ?? 0;
    const cashLbpReceived = cashLbpRow?.amountNativeLbp ?? 0;

    // All USD and LBP change given across ALL payment rows (change exits the drawer)
    const totalChangeUsd = payments.reduce((s, p) => s + p.changeGivenUsdCents, 0);
    const totalChangeLbp = payments.reduce((s, p) => s + p.changeGivenLbp, 0);

    return {
      cashUsdReceived,
      cashLbpReceived,
      totalChangeUsd,
      totalChangeLbp,
      netCashUsd: cashUsdReceived - totalChangeUsd,
      netCashLbp: cashLbpReceived - totalChangeLbp,
    };
  }, [payments]);

  // ---------- Render ----------

  if (!hydrated) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  const isEmpty = salesSummary?.receiptCount === 0 && !loading;

  return (
    <div className="space-y-6">

      {/* Header + date picker */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Shift Summary</h2>
          <p className="text-sm text-slate-600">
            Cash and payment reconciliation for a business day.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-0.5">
            <label className="text-xs font-medium text-slate-500">Business date</label>
            <input
              type="date"
              value={date}
              max={todayLocalDate()}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <Button variant="primary" onClick={() => setAppliedDate(date)} disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load shift data: {loadError}
        </div>
      )}

      {/* Period label */}
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        {formatPrettyDate(appliedDate)}
        {salesSummary && !loading && (
          <span className="ml-2 normal-case font-normal text-slate-400">
            · {salesSummary.receiptCount} receipt{salesSummary.receiptCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Section 1 — Sales Collection */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Sales Collection
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard
            label="Sales incl. VAT"
            value={salesSummary ? formatUsd(salesSummary.totalInclVatCents) : "—"}
            sub="gross collected"
          />
          <StatCard
            label="Net sales excl. VAT"
            value={salesSummary ? formatUsd(salesSummary.netSalesExclVatCents) : "—"}
            sub="after discounts"
          />
          <StatCard
            label="Output VAT"
            value={salesSummary ? formatUsd(salesSummary.vatTotalCents) : "—"}
            tone="muted"
            sub="owed to authority"
          />
          <StatCard
            label="Discounts"
            value={salesSummary ? formatUsd(salesSummary.discountCents) : "—"}
            tone={salesSummary && salesSummary.discountCents > 0 ? "warn" : undefined}
          />
          <StatCard
            label="Receipts"
            value={salesSummary ? String(salesSummary.receiptCount) : "—"}
          />
        </div>
      </div>

      {/* Section 2 — Payment Method Breakdown */}
      <Card>
        <CardHeader
          title="Payment Method Breakdown"
          subtitle="Collected payments by method and currency"
        />
        {isEmpty ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No posted sales on {formatPrettyDate(appliedDate)}.
          </div>
        ) : payments.length === 0 && !loading ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No payment records found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Method</th>
                  <th className="px-5 py-2 text-right">Native amount</th>
                  <th className="px-5 py-2 text-right">USD equivalent</th>
                  <th className="px-5 py-2 text-right">Change given</th>
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
                        {METHOD_LABELS[row.method]}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-slate-700">
                        {nativeDisplay}
                        {row.currency === "LBP" && row.amountUsdCentsEquivalent > 0 && (
                          <div className="text-xs text-slate-400">
                            ≈ {formatUsd(row.amountUsdCentsEquivalent)}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-slate-700">
                        {formatUsd(row.amountUsdCentsEquivalent)}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-slate-500">
                        {changeDisplay}
                      </td>
                    </tr>
                  );
                })}

                {/* Totals row */}
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
                      <td className="px-5 py-2.5 text-slate-900">Total</td>
                      <td className="px-5 py-2.5 text-right text-slate-400 text-xs">—</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-slate-900">
                        {formatUsd(totalUsd)}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-slate-700">
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

      {/* Section 3 — Cash Drawer */}
      <Card>
        <CardHeader
          title="Cash Drawer"
          subtitle="Expected cash to count at end of shift"
        />
        <CardBody>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">

            {/* USD column */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                USD
              </div>
              <div className="divide-y divide-slate-100">
                <DrawerRow
                  label="Opening cash"
                  value="Not tracked yet"
                  tone="muted"
                />
                <DrawerRow
                  label="Cash received"
                  value={formatUsd(drawer.cashUsdReceived)}
                />
                <DrawerRow
                  label="Change given (USD)"
                  value={drawer.totalChangeUsd > 0 ? `− ${formatUsd(drawer.totalChangeUsd)}` : "—"}
                  tone={drawer.totalChangeUsd > 0 ? "warn" : undefined}
                />
                <DrawerRow
                  label="Expected cash in drawer"
                  value={formatUsd(drawer.netCashUsd)}
                  isBold
                />
                <DrawerRow
                  label="Closing counted cash"
                  value="Not tracked yet"
                  tone="muted"
                />
              </div>
            </div>

            {/* LBP column */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                LBP
              </div>
              <div className="divide-y divide-slate-100">
                <DrawerRow
                  label="Opening cash"
                  value="Not tracked yet"
                  tone="muted"
                />
                <DrawerRow
                  label="Cash received"
                  value={formatLbp(drawer.cashLbpReceived)}
                />
                <DrawerRow
                  label="Change given (LBP)"
                  value={drawer.totalChangeLbp > 0 ? `− ${formatLbp(drawer.totalChangeLbp)}` : "—"}
                  tone={drawer.totalChangeLbp > 0 ? "warn" : undefined}
                />
                <DrawerRow
                  label="Expected cash in drawer"
                  value={formatLbp(drawer.netCashLbp)}
                  isBold
                />
                <DrawerRow
                  label="Closing counted cash"
                  value="Not tracked yet"
                  tone="muted"
                />
              </div>
            </div>

          </div>
        </CardBody>
      </Card>

      {/* Section 4 — Reconciliation (Phase 4 placeholder) */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-slate-400">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-700">
              Full reconciliation coming in Phase 4 — Shift Management
            </p>
            <p className="mt-1 text-xs text-slate-500">
              The database already has a <code className="rounded bg-slate-200 px-1 py-0.5 font-mono">shifts</code> table. Phase 4 will add:
            </p>
            <ul className="mt-1 list-inside list-disc text-xs text-slate-500 space-y-0.5">
              <li>Opening cash declared by cashier</li>
              <li>Cash in / cash out during shift</li>
              <li>Closing counted cash (physical count)</li>
              <li>Variance (counted − expected)</li>
              <li>Cashier and user attribution</li>
              <li>Shift open / close timestamps</li>
            </ul>
          </div>
        </div>
      </div>

    </div>
  );
}
