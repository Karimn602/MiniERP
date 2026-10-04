import type { CreditMemoWithDetails } from "../db/types";
import { formatLbp, formatRate, formatUsd } from "../lib/money";

interface CreditMemoPrintProps {
  memo: CreditMemoWithDetails;
  storeName: string;
}

/**
 * The customer's copy of a return.
 *
 * Shaped like `ReceiptPrint` — same 72mm column, same monospace, same dashed
 * dividers — because it is handed over the same counter. What it must say
 * differently is that it is a CREDIT MEMO and which receipt it reverses: those
 * two facts are what make it a document the shop can be shown later.
 */
function isoToDisplayDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function isoToDisplayTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function CreditMemoPrint({ memo, storeName }: CreditMemoPrintProps) {
  const stamp = memo.postedAt ?? memo.createdAt;
  const hasLbpRefund = memo.refunds.some((r) => r.currency === "LBP");
  const vatRates = new Set(memo.lines.map((l) => l.vatRateBpsSnapshot));
  const vatLabel =
    vatRates.size === 1 ? `VAT reversed (${[...vatRates][0] / 100}%)` : "VAT reversed";

  return (
    <div id="credit-memo-print" className="w-72 p-4 font-mono text-xs text-slate-900">
      {/* Store header */}
      <div className="mb-3 text-center">
        <div className="text-sm font-bold uppercase tracking-wide">{storeName}</div>
        <div className="mt-1 text-sm font-bold uppercase tracking-wide">
          Credit Memo / Return
        </div>
        <div className="mt-0.5">Credit memo #{memo.creditMemoNumber}</div>
        {memo.originalReceiptNumber !== null && (
          <div>Against receipt #{memo.originalReceiptNumber}</div>
        )}
        <div className="text-slate-500">
          {isoToDisplayDate(stamp)} · {isoToDisplayTime(stamp)}
        </div>
        <div className="mt-0.5 font-medium uppercase">{memo.status}</div>
      </div>

      <Divider />

      {/* Returned lines */}
      <div className="space-y-2">
        {memo.lines.map((line) => (
          <div key={line.id}>
            <div className="font-semibold">{line.productNameSnapshot}</div>
            {line.productSkuSnapshot && (
              <div className="text-slate-500">SKU: {line.productSkuSnapshot}</div>
            )}
            <div className="flex justify-between">
              <span>
                {line.quantityInUom} {line.uomCodeSnapshot ?? ""} ×{" "}
                {formatUsd(line.unitPriceInclVatCents)}
              </span>
              <span className="font-medium">
                −{formatUsd(line.lineTotalInclVatCents)}
              </span>
            </div>
            {/* Whether the goods came back is a fact the customer's copy should
                carry: a written-off line was refunded without a restock. */}
            {!line.returnToStock && !line.isService && (
              <div className="text-slate-500">Not returned to stock</div>
            )}
          </div>
        ))}
      </div>

      <Divider />

      {/* Totals */}
      <div className="space-y-0.5">
        <ReceiptRow
          label="Subtotal (excl. VAT)"
          value={`−${formatUsd(memo.subtotalExclVatCents)}`}
        />
        <ReceiptRow label={vatLabel} value={`−${formatUsd(memo.vatTotalCents)}`} />
        {memo.discountCents > 0 && (
          <ReceiptRow
            label="Discount reversed"
            value={formatUsd(memo.discountCents)}
          />
        )}
        <div className="flex justify-between font-bold">
          <span>TOTAL REFUND</span>
          <span>−{formatUsd(memo.totalInclVatCents)}</span>
        </div>
      </div>

      <Divider />

      {/* Refund legs */}
      <div className="space-y-1">
        {memo.refunds.map((r) => (
          <div key={r.id}>
            <div className="flex justify-between">
              <span className="capitalize">{r.method.replace(/_/g, " ")}</span>
              <span>
                {r.currency === "USD"
                  ? formatUsd(r.amountNativeUsdCents)
                  : formatLbp(r.amountNativeLbp)}
              </span>
            </div>
            {r.currency === "LBP" && (
              <div className="flex justify-between text-slate-500">
                <span>≈ USD equiv.</span>
                <span>{formatUsd(r.amountUsdCentsEquivalent)}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* The rate is the SALE's, not today's — say so, because a customer
          holding both documents can check it. */}
      {hasLbpRefund && (
        <>
          <Divider />
          <div className="text-center text-slate-500">
            Rate at sale: {formatRate(memo.exchangeRateLbpPerUsd)}
          </div>
        </>
      )}

      {memo.reason && (
        <>
          <Divider />
          <div className="text-slate-500">Reason: {memo.reason}</div>
        </>
      )}

      <Divider />

      <div className="text-center text-slate-500">
        Keep this credit memo with your receipt.
      </div>
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
