import type { SaleWithDetails } from "../db/types";
import { formatLbp, formatRate, formatUsd } from "../lib/money";

interface ReceiptPrintProps {
  sale: SaleWithDetails;
  storeName: string;
}

function isoToDisplayDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function isoToDisplayTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ReceiptPrint({ sale, storeName }: ReceiptPrintProps) {
  const dateStr = sale.postedAt ? isoToDisplayDate(sale.postedAt) : "—";
  const timeStr = sale.postedAt ? isoToDisplayTime(sale.postedAt) : "—";

  const hasLbpPayment = sale.payments.some((p) => p.currency === "LBP");

  const vatRates = new Set(sale.lines.map((l) => l.vatRateBpsSnapshot));
  const vatLabel =
    vatRates.size === 1 ? `VAT (${[...vatRates][0] / 100}%)` : "VAT";

  return (
    <div
      id="receipt-print"
      className="w-72 p-4 font-mono text-xs text-slate-900"
    >
      {/* Store header */}
      <div className="mb-3 text-center">
        <div className="text-sm font-bold uppercase tracking-wide">{storeName}</div>
        <div className="mt-0.5">Receipt #{sale.receiptNumber}</div>
        <div className="text-slate-500">
          {dateStr} · {timeStr}
        </div>
        <div className="mt-0.5 font-medium uppercase">{sale.status}</div>
      </div>

      <Divider />

      {/* Items */}
      <div className="space-y-2">
        {sale.lines.map((line) => (
          <div key={line.id}>
            <div className="font-semibold">{line.productNameSnapshot}</div>
            {(line.productSkuSnapshot || line.barcodeUsedSnapshot) && (
              <div className="text-slate-500">
                {line.productSkuSnapshot && <>SKU: {line.productSkuSnapshot}</>}
                {line.productSkuSnapshot && line.barcodeUsedSnapshot && " · "}
                {line.barcodeUsedSnapshot && <>BC: {line.barcodeUsedSnapshot}</>}
              </div>
            )}
            <div className="flex justify-between">
              <span>
                {line.quantityInUom ?? line.quantity}{" "}
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
        <ReceiptRow label="Subtotal (excl. VAT)" value={formatUsd(sale.subtotalExclVatCents)} />
        {sale.discountCents > 0 && (
          <ReceiptRow label="Discount" value={`-${formatUsd(sale.discountCents)}`} />
        )}
        <ReceiptRow label={vatLabel} value={formatUsd(sale.vatTotalCents)} />
        <div className="flex justify-between font-bold">
          <span>TOTAL</span>
          <span>{formatUsd(sale.totalInclVatCents)}</span>
        </div>
      </div>

      <Divider />

      {/* Payments */}
      <div className="space-y-1">
        {sale.payments.map((p) => (
          <div key={p.id}>
            <div className="flex justify-between">
              <span className="capitalize">{p.method.replace(/_/g, " ")}</span>
              <span>
                {p.currency === "USD"
                  ? formatUsd(p.amountNativeUsdCents)
                  : formatLbp(p.amountNativeLbp)}
              </span>
            </div>
            {p.currency === "LBP" && (
              <div className="flex justify-between text-slate-500">
                <span>≈ USD equiv.</span>
                <span>{formatUsd(p.amountUsdCentsEquivalent)}</span>
              </div>
            )}
            {(p.changeGivenUsdCents > 0 || p.changeGivenLbp > 0) && (
              <div className="flex justify-between text-slate-500">
                <span>Change</span>
                <span>
                  {p.changeGivenUsdCents > 0
                    ? formatUsd(p.changeGivenUsdCents)
                    : formatLbp(p.changeGivenLbp)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Exchange rate — shown only if LBP was used */}
      {hasLbpPayment && (
        <>
          <Divider />
          <div className="text-center text-slate-500">
            Rate: {formatRate(sale.exchangeRateLbpPerUsd)}
          </div>
        </>
      )}

      <Divider />

      <div className="text-center text-slate-500">Thank you for your purchase!</div>
    </div>
  );
}

function Divider() {
  return <div className="my-2 border-t border-dashed border-slate-300" />;
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
