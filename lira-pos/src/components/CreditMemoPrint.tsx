import type { CreditMemoWithDetails } from "../db/types";
import { formatLbp, formatRate, formatUsd } from "../lib/money";
import { useTranslation } from "../lib/i18n";

interface CreditMemoPrintProps {
  memo: CreditMemoWithDetails;
  storeName: string;
  originalReceiptNumber: number | null;
}

function isoToDisplayDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function isoToDisplayTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Customer-facing credit memo. Deliberately shows NO cost / margin / profit.
export function CreditMemoPrint({ memo, storeName, originalReceiptNumber }: CreditMemoPrintProps) {
  const { t } = useTranslation();
  const dateIso = memo.postedAt ?? memo.createdAt;
  const dateStr = isoToDisplayDate(dateIso);
  const timeStr = isoToDisplayTime(dateIso);

  const hasLbpRefund = memo.refunds.some((r) => r.currency === "LBP");

  const vatRates = new Set(memo.lines.map((l) => l.vatRateBpsSnapshot));
  const vatLabel =
    vatRates.size === 1 ? `${t("returns.vatReversed")} (${[...vatRates][0] / 100}%)` : t("returns.vatReversed");

  return (
    <div id="credit-memo-print" className="w-72 p-4 font-mono text-xs text-slate-900">
      {/* Store header */}
      <div className="mb-3 text-center">
        <div className="text-sm font-bold uppercase tracking-wide">{storeName}</div>
        <div className="mt-1 font-bold uppercase tracking-wide">
          {t("returns.modalTitle")} · {t("returns.creditMemoLabel")}
        </div>
        <div className="mt-0.5">{t("returns.detailTitle", { number: String(memo.creditMemoNumber) })}</div>
        {originalReceiptNumber != null && (
          <div className="text-slate-500">
            {t("returns.originalReceipt", { number: String(originalReceiptNumber) })}
          </div>
        )}
        <div className="text-slate-500">
          {dateStr} · {timeStr}
        </div>
      </div>

      <Divider />

      {/* Returned items */}
      <div className="space-y-2">
        {memo.lines.map((line) => (
          <div key={line.id}>
            <div className="font-semibold">{line.productNameSnapshot}</div>
            {line.productSkuSnapshot && (
              <div className="text-slate-500">SKU: {line.productSkuSnapshot}</div>
            )}
            <div className="flex justify-between">
              <span>
                {line.quantityInUom ?? line.quantityBase}{" "}
                {line.uomCodeSnapshot ?? ""} × {formatUsd(line.unitPriceInclVatCents)}
              </span>
              <span className="font-medium">{formatUsd(line.lineTotalInclVatCents)}</span>
            </div>
          </div>
        ))}
      </div>

      <Divider />

      {/* Totals */}
      <div className="space-y-0.5">
        <Row label={t("returns.subtotalExcl")} value={formatUsd(memo.subtotalExclVatCents)} />
        <Row label={vatLabel} value={formatUsd(memo.vatTotalCents)} />
        <div className="flex justify-between font-bold">
          <span>{t("returns.totalRefund")}</span>
          <span>{formatUsd(memo.totalInclVatCents)}</span>
        </div>
      </div>

      <Divider />

      {/* Refund methods */}
      <div className="space-y-1">
        <div className="font-semibold">{t("returns.refundMethod")}</div>
        {memo.refunds.map((r) => (
          <div key={r.id}>
            <div className="flex justify-between">
              <span>{t(`shift.paymentMethods.${r.method}`)}</span>
              <span>
                {r.currency === "USD"
                  ? formatUsd(r.amountNativeUsdCents)
                  : formatLbp(r.amountNativeLbp)}
              </span>
            </div>
            {r.currency === "LBP" && (
              <div className="flex justify-between text-slate-500">
                <span>≈ USD</span>
                <span>{formatUsd(r.amountUsdCentsEquivalent)}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {hasLbpRefund && (
        <>
          <Divider />
          <div className="text-center text-slate-500">
            {t("salesHistory.detailExchangeRate")}: {formatRate(memo.exchangeRateLbpPerUsd)}
          </div>
        </>
      )}

      <Divider />
      <div className="text-center text-slate-500">{storeName}</div>
    </div>
  );
}

function Divider() {
  return <div className="my-2 border-t border-dashed border-slate-300" />;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
