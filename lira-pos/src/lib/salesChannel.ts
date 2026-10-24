/**
 * Where an order came from — Counter, or Online / Delivery.
 *
 * ## What this is for
 *
 * Greaz takes orders online and the owner needs two numbers: how many orders
 * came that way, and how much money they brought. Nothing more. The orders are
 * rung up on the till exactly like counter orders — the same products, the same
 * VAT, the same posting command, the same inventory — and the cashier's only
 * extra job is to say which kind it is.
 *
 * ## What this is NOT
 *
 * **It is not a payment method.** This is the single most important thing about
 * the feature and the easiest mistake to make. Marking an order "Online" says
 * nothing about how it was paid, and the register invents no tender for it: an
 * online order with no payment entered is refused for being unpaid, exactly as
 * a counter order is. There is no platform account, no receivable, no courier
 * balance, no commission and no delivery fee anywhere in this release.
 *
 * A delivery platform that collects from the customer and settles weekly, net
 * of commission, genuinely is an accounts-receivable problem: money is owed to
 * the shop by a third party, it arrives later, and it arrives short. Modelling
 * that needs a counterparty ledger and a settlement workflow — the shape
 * `supplier_ledger` has for the other direction. Pretending the cash drawer
 * can absorb it would put money in the till that is not in the till, and that
 * is a worse answer than not having the feature. So it is recorded as a
 * separate business requirement and NOT approximated here.
 *
 * Which also means: a shop whose online orders are prepaid by the platform has
 * no honest way to post them yet, and should keep taking them as whatever
 * tender actually reaches it until that design exists.
 *
 * ## SUPERSEDED IN PART BY WP-6 — read this before the paragraphs above
 *
 * Everything above is still true of the CHANNEL, which is all this module
 * owns: it is a reporting dimension, it is not a payment method, and marking
 * an order "Delivery" still settles nothing.
 *
 * What is no longer true is the claim that there is "no courier balance and no
 * delivery fee anywhere in this release". Greaz's confirmed process has no
 * third-party platform in it at all — the shop's OWN driver collects food plus
 * a delivery charge, keeps the charge, and owes the food money back. So the
 * deferred platform-AR design that paragraph is about was CANCELLED rather
 * than postponed, and what exists instead is a driver subledger
 * (`driver_ledger`), a `driver_collection` tender, and a delivery charge that
 * is in no sale total. `lib/driverCollection.ts` owns that arrangement; this
 * module still owns only where the order came from.
 */

/** The stored values. These are the `sales.channel` CHECK, in TypeScript. */
export const SALES_CHANNELS = ["counter", "online_delivery"] as const;

export type SalesChannel = (typeof SALES_CHANNELS)[number];

/** A new cart is a counter order until the cashier says otherwise. */
export const DEFAULT_SALES_CHANNEL: SalesChannel = "counter";

export interface SalesChannelOption {
  id: SalesChannel;
  /** i18n key for the control and the report labels. */
  labelKey: string;
  /** i18n key for the short form used in tight spaces. */
  shortLabelKey: string;
}

export const SALES_CHANNEL_OPTIONS: readonly SalesChannelOption[] = [
  { id: "counter", labelKey: "channel.counter", shortLabelKey: "channel.counterShort" },
  {
    id: "online_delivery",
    labelKey: "channel.onlineDelivery",
    shortLabelKey: "channel.onlineDeliveryShort",
  },
] as const;

/**
 * Coerce a stored or restored value to a channel.
 *
 * Unlike a menu category, an unrecognised channel does NOT get its own bucket:
 * the column is `NOT NULL` with a CHECK, so the only ways to see one are a
 * hand-edited row or a cart persisted by a future build. Both resolve to
 * Counter, which is the same claim migration 014 makes about every historical
 * sale — and it keeps the channel figures summing to the overall total, which
 * a third bucket would quietly break.
 */
export function resolveSalesChannel(raw: string | null | undefined): SalesChannel {
  return SALES_CHANNELS.includes(raw as SalesChannel)
    ? (raw as SalesChannel)
    : DEFAULT_SALES_CHANNEL;
}

export function isSalesChannel(raw: unknown): raw is SalesChannel {
  return typeof raw === "string" && SALES_CHANNELS.includes(raw as SalesChannel);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** One channel's figures over a period. */
export interface ChannelTotals {
  channel: SalesChannel;
  /** Posted sales in this channel. */
  orderCount: number;
  /** GROSS revenue, VAT-inclusive, before returns. */
  grossInclVatCents: number;
  /** Refunded through credit memos against this channel's sales. */
  refundedInclVatCents: number;
  /** `gross − refunded`. The figure the owner should read as "revenue". */
  netInclVatCents: number;
}

export interface ChannelMix {
  byChannel: ChannelTotals[];
  totalOrders: number;
  totalGrossInclVatCents: number;
  totalRefundedInclVatCents: number;
  totalNetInclVatCents: number;
}

/**
 * Online's share, in basis points, or null when there is nothing to share.
 *
 * Basis points rather than a float, because the rest of the application keeps
 * rates as integers and a percentage rendered from a float is how "33.33%" and
 * "33.34%" end up on two screens describing one number. Null rather than zero
 * on an empty period: "0% of nothing" invites the reader to conclude the online
 * channel underperformed on a day the shop was shut.
 */
export function shareBps(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part * 10000) / whole);
}

/**
 * Assemble the mix from per-channel rows.
 *
 * Every channel is present in the output even when it has no sales, so the
 * report shows "Online: 0 orders" rather than omitting the row — the owner
 * asked how many online orders there were, and none is an answer.
 *
 * The totals are summed from the SAME rows the per-channel figures come from,
 * so the parts cannot fail to add up to the whole. They are deliberately not
 * read from a separate overall-sales query: two queries over one table is
 * exactly how a channel report comes to disagree with the sales report beside
 * it.
 */
export function buildChannelMix(
  rows: readonly {
    channel: string;
    orderCount: number;
    grossInclVatCents: number;
    refundedInclVatCents: number;
  }[],
): ChannelMix {
  const byChannel: ChannelTotals[] = SALES_CHANNELS.map((channel) => {
    // Folded by RESOLVED channel, so a hand-edited row lands in Counter rather
    // than vanishing from the breakdown while still counting in the total.
    const mine = rows.filter((r) => resolveSalesChannel(r.channel) === channel);
    const orderCount = mine.reduce((s, r) => s + r.orderCount, 0);
    const grossInclVatCents = mine.reduce((s, r) => s + r.grossInclVatCents, 0);
    const refundedInclVatCents = mine.reduce((s, r) => s + r.refundedInclVatCents, 0);
    return {
      channel,
      orderCount,
      grossInclVatCents,
      refundedInclVatCents,
      netInclVatCents: grossInclVatCents - refundedInclVatCents,
    };
  });

  return {
    byChannel,
    totalOrders: byChannel.reduce((s, c) => s + c.orderCount, 0),
    totalGrossInclVatCents: byChannel.reduce((s, c) => s + c.grossInclVatCents, 0),
    totalRefundedInclVatCents: byChannel.reduce((s, c) => s + c.refundedInclVatCents, 0),
    totalNetInclVatCents: byChannel.reduce((s, c) => s + c.netInclVatCents, 0),
  };
}
