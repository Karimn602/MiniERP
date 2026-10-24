import type { SaleWithDetails } from "../db/types";
import { formatLbp, formatRate, formatUsd } from "../lib/money";

interface ReceiptPrintProps {
  sale: SaleWithDetails;
  storeName: string;
  /** The driver carrying a delivery order, when the caller knows his name. */
  driverName?: string | null;
}

function isoToDisplayDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function isoToDisplayTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ReceiptPrint({ sale, storeName, driverName }: ReceiptPrintProps) {
  const dateStr = sale.postedAt ? isoToDisplayDate(sale.postedAt) : "—";
  const timeStr = sale.postedAt ? isoToDisplayTime(sale.postedAt) : "—";

  const hasLbpPayment = sale.payments.some((p) => p.currency === "LBP");

  /**
   * The delivery arrangement (WP-A4), and the ONE rule about printing it.
   *
   * `sale.totalInclVatCents` is the invoice: Greaz's own sale, with Greaz's own
   * VAT in it. The delivery charge is NOT in that figure and must never be
   * added to it here — it is the driver's money, it has no VAT rate, it is in
   * no sale total, no inventory movement and no receivable, and its fiscal
   * treatment is STILL UNCONFIRMED by the shop's accountant (migration 015
   * states the open question in full).
   *
   * So what the customer handed over is printed as a clearly separated,
   * clearly labelled SUPPLEMENTARY block below the tender — never as a total,
   * never above or beside the invoice total, and never summed into it. The
   * $9 invoice stays a $9 invoice; the $11 the customer paid is stated as
   * what it is, which is a fact about the evening rather than a tax figure.
   *
   * `customerPaidCents` is computed here and stored nowhere, exactly as it is
   * on the register: a total nobody owns is how a figure like this reaches a
   * revenue report.
   */
  const isDelivery = sale.channel === "online_delivery";
  const deliveryFeeCents = sale.deliveryFeeCents ?? 0;
  const showDeliverySummary = isDelivery && deliveryFeeCents > 0;
  const customerPaidCents = sale.totalInclVatCents + deliveryFeeCents;

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
        {/* Where the order came from, and who carried it (WP-A4). Only on a
            delivery order: on a counter sale there is nothing to say and a
            line saying "Counter" is noise on every receipt. */}
        {isDelivery && (
          <div className="mt-0.5 font-medium uppercase">
            WhatsApp / Delivery
            {driverName ? ` · ${driverName}` : ""}
          </div>
        )}
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
            {/* The kitchen instruction, if the line carried one (WP-A2).
                Shown with no amount beside it, because it has none: a note
                never changes a price, and printing it in the money column
                would suggest it had. */}
            {line.kitchenNote && (
              <div className="ps-2 text-slate-600">» {line.kitchenNote}</div>
            )}
          </div>
        ))}
      </div>

      <Divider />

      {/* Totals */}
      <div className="space-y-0.5">
        {sale.discountCents > 0 ? (
          <>
            {/* Pre-discount total shown as subtotal so customer sees: subtotal - discount = total */}
            <ReceiptRow
              label="Subtotal (before discount)"
              value={formatUsd(sale.totalInclVatCents + sale.discountCents)}
            />
            <ReceiptRow label="Discount" value={`-${formatUsd(sale.discountCents)}`} />
            <ReceiptRow label={vatLabel} value={formatUsd(sale.vatTotalCents)} />
          </>
        ) : (
          <>
            <ReceiptRow label="Subtotal (excl. VAT)" value={formatUsd(sale.subtotalExclVatCents)} />
            <ReceiptRow label={vatLabel} value={formatUsd(sale.vatTotalCents)} />
          </>
        )}
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

      {/* ── SUPPLEMENTARY: what the customer handed the driver (WP-A4) ──
          Below the tender and visibly fenced off, with the invoice total it
          is NOT part of named on its own line. The wording is deliberately
          provisional: nothing here claims a VAT treatment for the delivery
          charge, because nobody has approved one. */}
      {showDeliverySummary && (
        <>
          <Divider />
          <div className="border border-dashed border-slate-400 p-1.5">
            <div className="text-center font-bold uppercase">Paid to driver</div>
            <div className="mt-1 space-y-0.5">
              <ReceiptRow
                label="This invoice (food)"
                value={formatUsd(sale.totalInclVatCents)}
              />
              <ReceiptRow
                label="Delivery charge (driver's)"
                value={formatUsd(deliveryFeeCents)}
              />
              <div className="flex justify-between border-t border-slate-300 pt-0.5 font-bold">
                <span>Customer paid driver</span>
                <span>{formatUsd(customerPaidCents)}</span>
              </div>
            </div>
            <div className="mt-1 text-[9px] leading-tight text-slate-600">
              The delivery charge is collected by the driver and kept by him. It
              is not part of this invoice, not part of its VAT, and not a sale by
              {" "}
              {storeName}. Tax treatment of the delivery charge is pending
              confirmation.
            </div>
          </div>
        </>
      )}

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
