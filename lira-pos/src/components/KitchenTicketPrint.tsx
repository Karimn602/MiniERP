import type { SaleWithDetails } from "../db/types";
import { useTranslation } from "../lib/i18n";
import { SALES_CHANNEL_OPTIONS, resolveSalesChannel } from "../lib/salesChannel";

/**
 * The KITCHEN TICKET — the same posted sale, printed for the people cooking it.
 *
 * ## Why it is a separate document and not the receipt
 *
 * A receipt is a financial document: it has to show the money, because that is
 * what the customer is checking. A kitchen ticket has to show the FOOD, in the
 * order it is to be made, at a size that is readable on a rail across a hot
 * room — and it must not show the money at all, because a price on a prep
 * ticket is something to be read out, queried and mistaken for a total.
 *
 * So: no prices, no VAT, no tender, no change, no delivery figures. Quantity,
 * item, and the instruction attached to that line. The one money-adjacent
 * thing it carries is NONE.
 *
 * ## What it is printed FROM
 *
 * The posted sale, by identity — never the cart. The ticket the kitchen holds
 * must be the order that committed, including its receipt number, so a
 * question at the pass ("which order is this?") has one answer that matches
 * the till, the receipt and Sales History. Printing from the cart would make a
 * ticket for an order that might not exist.
 *
 * Instructions come from `sale_items.kitchen_note`, which is an immutable
 * snapshot (migration 018, sealed by 012): a ticket reprinted an hour later
 * says exactly what the first one said.
 *
 * ## Localised, unlike the receipt
 *
 * `ReceiptPrint` is English-only, which is defensible for a customer document
 * in a dual-language shop. This one is read by the kitchen staff, who work in
 * Arabic, so its labels go through `t()`. The instructions themselves are
 * reproduced exactly as typed in whatever language they were typed in — that
 * is the whole point of storing them verbatim.
 */
export function KitchenTicketPrint({
  sale,
  storeName,
  driverName,
}: {
  sale: SaleWithDetails;
  storeName: string;
  /** The driver carrying a delivery order, when one is known. */
  driverName?: string | null;
}) {
  const { t } = useTranslation();
  const when = sale.postedAt ?? sale.createdAt;
  const timeStr = new Date(when).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  // Resolved rather than indexed, so a row carrying anything unexpected still
  // prints a ticket — a kitchen that gets no ticket is a worse failure than
  // one that gets a mislabelled channel.
  const channelId = resolveSalesChannel(sale.channel);
  const channel = SALES_CHANNEL_OPTIONS.find((o) => o.id === channelId)!;

  return (
    <div id="kitchen-ticket-print" className="w-72 p-4 font-mono text-xs text-slate-900">
      <div className="mb-2 text-center">
        <div className="text-sm font-bold uppercase tracking-wide">{storeName}</div>
        {/* The loudest thing on the ticket, because it is what the pass calls
            out and what matches the receipt in the customer's hand. */}
        <div className="mt-1 text-xl font-black">
          {t("kitchen.orderNumber", { number: String(sale.receiptNumber) })}
        </div>
        <div className="mt-0.5 text-slate-600">{timeStr}</div>
      </div>

      <div className="my-2 border-t-2 border-slate-400" />

      {/* Where the order is going. A delivery ticket is packed differently
          from a counter one, and the driver's name is how the kitchen knows
          whose bag it belongs in. No fee and no total: see the note above. */}
      <div className="mb-2 text-center text-[11px] font-bold uppercase">
        {t(channel.shortLabelKey)}
        {driverName ? ` · ${driverName}` : ""}
      </div>

      <div className="my-2 border-t border-dashed border-slate-300" />

      <div className="space-y-2.5">
        {sale.lines.map((line) => (
          <div key={line.id}>
            <div className="flex items-start gap-2">
              {/* Quantity first and bold: the kitchen reads counts before
                  names. The UoM quantity is what was rung ("2 pcs"), falling
                  back to the base quantity for a historical row that has
                  none. */}
              <span className="min-w-[2.25rem] text-base font-black tabular-nums">
                {line.quantityInUom ?? line.quantity}×
              </span>
              <span className="flex-1 text-sm font-bold uppercase leading-tight">
                {line.productNameSnapshot}
              </span>
            </div>
            {line.kitchenNote && (
              // Indented under its own line and unmistakably an instruction
              // rather than another item. A note that could be misread as a
              // line would have the kitchen making a dish called "no
              // pickles".
              <div className="ms-[2.25rem] mt-0.5 border-s-2 border-slate-400 ps-1.5 text-[11px] font-bold uppercase">
                {t("kitchen.notePrefix")} {line.kitchenNote}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* The order's own note, if the cashier left one on the whole ticket. */}
      {sale.notes && (
        <>
          <div className="my-2 border-t border-dashed border-slate-300" />
          <div className="text-[11px] font-bold">{sale.notes}</div>
        </>
      )}

      <div className="my-2 border-t-2 border-slate-400" />

      {/* Said out loud, because a prep ticket that looks like a bill is how a
          customer ends up being shown one. */}
      <div className="text-center text-[10px] uppercase text-slate-600">
        {t("kitchen.notAReceipt")}
      </div>
    </div>
  );
}
