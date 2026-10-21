import { describe, expect, it } from "vitest";
import {
  DEFAULT_SALES_CHANNEL,
  SALES_CHANNELS,
  buildChannelMix,
  isSalesChannel,
  resolveSalesChannel,
  shareBps,
} from "../../src/lib/salesChannel";

/**
 * WP-4 — order channel reporting.
 *
 * The owner wants four numbers (counter orders, online orders, counter
 * revenue, online revenue) and two shares. The hard requirement is not the
 * arithmetic, it is that the channel figures RECONCILE to the overall sales
 * figures: a breakdown whose parts do not add up to the whole is worse than no
 * breakdown, because it makes every other number on the page suspect.
 */

describe("resolveSalesChannel", () => {
  it("accepts the two stored values", () => {
    expect(resolveSalesChannel("counter")).toBe("counter");
    expect(resolveSalesChannel("online_delivery")).toBe("online_delivery");
  });

  it.each([[null], [undefined], [""], ["phone"], ["COUNTER"], ["online"]])(
    "folds %s into Counter rather than inventing a third bucket",
    (raw) => {
      // Unlike a menu category, an unrecognised channel gets no bucket of its
      // own: a third bucket would break the reconciliation, and Counter is the
      // same claim migration 014 makes about every historical sale.
      expect(resolveSalesChannel(raw)).toBe("counter");
    },
  );

  it("agrees with isSalesChannel on what is genuinely a channel", () => {
    expect(isSalesChannel("counter")).toBe(true);
    expect(isSalesChannel("online_delivery")).toBe(true);
    expect(isSalesChannel("COUNTER")).toBe(false);
    expect(isSalesChannel(null)).toBe(false);
    expect(isSalesChannel(7)).toBe(false);
  });

  it("defaults a new cart to Counter", () => {
    expect(DEFAULT_SALES_CHANNEL).toBe("counter");
  });
});

describe("shareBps", () => {
  it("reports a share in integer basis points", () => {
    expect(shareBps(1, 4)).toBe(2500);
    expect(shareBps(1, 3)).toBe(3333);
    expect(shareBps(2, 3)).toBe(6667);
  });

  it("is null, not zero, when there is nothing to share", () => {
    // "0% of nothing" invites the reader to conclude the online channel
    // underperformed on a day the shop was shut.
    expect(shareBps(0, 0)).toBeNull();
    expect(shareBps(5, 0)).toBeNull();
    expect(shareBps(0, -1)).toBeNull();
  });

  it("reaches exactly 100% when one channel took everything", () => {
    expect(shareBps(7, 7)).toBe(10000);
  });
});

describe("buildChannelMix", () => {
  const rows = [
    { channel: "counter", orderCount: 12, grossInclVatCents: 24_000, refundedInclVatCents: 500 },
    {
      channel: "online_delivery",
      orderCount: 4,
      grossInclVatCents: 12_000,
      refundedInclVatCents: 1_500,
    },
  ];

  it("reports each channel's orders, gross, refunds and net", () => {
    const mix = buildChannelMix(rows);
    const counter = mix.byChannel.find((c) => c.channel === "counter")!;
    const online = mix.byChannel.find((c) => c.channel === "online_delivery")!;

    expect(counter.orderCount).toBe(12);
    expect(counter.grossInclVatCents).toBe(24_000);
    expect(counter.refundedInclVatCents).toBe(500);
    expect(counter.netInclVatCents).toBe(23_500);

    expect(online.orderCount).toBe(4);
    expect(online.netInclVatCents).toBe(10_500);
  });

  it("RECONCILES: the parts sum to the whole, on every measure", () => {
    // The requirement that matters. The totals are summed from the same rows
    // the per-channel figures come from, so they cannot drift — which reading
    // the overall total from a second query over `sales` would have allowed.
    const mix = buildChannelMix(rows);
    const sum = (f: (c: (typeof mix.byChannel)[number]) => number) =>
      mix.byChannel.reduce((s, c) => s + f(c), 0);

    expect(mix.totalOrders).toBe(sum((c) => c.orderCount));
    expect(mix.totalGrossInclVatCents).toBe(sum((c) => c.grossInclVatCents));
    expect(mix.totalRefundedInclVatCents).toBe(sum((c) => c.refundedInclVatCents));
    expect(mix.totalNetInclVatCents).toBe(sum((c) => c.netInclVatCents));

    // And net is gross minus refunds at the top level too.
    expect(mix.totalNetInclVatCents).toBe(
      mix.totalGrossInclVatCents - mix.totalRefundedInclVatCents,
    );
  });

  it("keeps gross and net DISTINCT, so returns are a visible subtraction", () => {
    const mix = buildChannelMix(rows);
    expect(mix.totalGrossInclVatCents).toBe(36_000);
    expect(mix.totalRefundedInclVatCents).toBe(2_000);
    expect(mix.totalNetInclVatCents).toBe(34_000);
    expect(mix.totalNetInclVatCents).not.toBe(mix.totalGrossInclVatCents);
  });

  it("reports a channel with NO orders rather than omitting it", () => {
    // "How many online orders were there?" — none is an answer, and a missing
    // row is not.
    const mix = buildChannelMix([rows[0]]);
    const online = mix.byChannel.find((c) => c.channel === "online_delivery")!;
    expect(online).toBeDefined();
    expect(online.orderCount).toBe(0);
    expect(online.netInclVatCents).toBe(0);
  });

  it("always lists every channel, in a stable order", () => {
    expect(buildChannelMix([]).byChannel.map((c) => c.channel)).toEqual([...SALES_CHANNELS]);
  });

  it("is all zeroes, and reconciles, on an empty period", () => {
    const mix = buildChannelMix([]);
    expect(mix.totalOrders).toBe(0);
    expect(mix.totalGrossInclVatCents).toBe(0);
    expect(mix.totalNetInclVatCents).toBe(0);
    expect(shareBps(0, mix.totalOrders)).toBeNull();
  });

  it("folds an unrecognised channel into Counter instead of losing it", () => {
    // A hand-edited row must not vanish from the breakdown while still
    // counting in the overall total — that is precisely the reconciliation
    // failure the resolver exists to prevent.
    const mix = buildChannelMix([
      { channel: "counter", orderCount: 1, grossInclVatCents: 1_000, refundedInclVatCents: 0 },
      { channel: "pigeon", orderCount: 1, grossInclVatCents: 500, refundedInclVatCents: 0 },
    ]);
    const counter = mix.byChannel.find((c) => c.channel === "counter")!;
    expect(counter.orderCount).toBe(2);
    expect(counter.grossInclVatCents).toBe(1_500);
    expect(mix.totalGrossInclVatCents).toBe(1_500);
  });

  it("handles several rows per channel, as a GROUP BY can return", () => {
    const mix = buildChannelMix([
      { channel: "counter", orderCount: 2, grossInclVatCents: 200, refundedInclVatCents: 10 },
      { channel: "counter", orderCount: 3, grossInclVatCents: 300, refundedInclVatCents: 0 },
    ]);
    const counter = mix.byChannel.find((c) => c.channel === "counter")!;
    expect(counter.orderCount).toBe(5);
    expect(counter.grossInclVatCents).toBe(500);
    expect(counter.netInclVatCents).toBe(490);
  });

  it("reports a refund in a channel that took no new orders that period", () => {
    // A return given today against a sale from last week: the period has a
    // refund and no gross, and net goes negative. That is the truth about the
    // period and must not be clamped to zero.
    const mix = buildChannelMix([
      {
        channel: "online_delivery",
        orderCount: 0,
        grossInclVatCents: 0,
        refundedInclVatCents: 2_500,
      },
    ]);
    const online = mix.byChannel.find((c) => c.channel === "online_delivery")!;
    expect(online.netInclVatCents).toBe(-2_500);
    expect(mix.totalNetInclVatCents).toBe(-2_500);
  });

  it("computes shares that are consistent with the totals", () => {
    const mix = buildChannelMix(rows);
    const online = mix.byChannel.find((c) => c.channel === "online_delivery")!;

    expect(shareBps(online.orderCount, mix.totalOrders)).toBe(2500); // 4 of 16
    expect(shareBps(online.grossInclVatCents, mix.totalGrossInclVatCents)).toBe(3333);

    // The two channel shares of orders add to 100%, give or take the rounding
    // of one basis point that integer shares necessarily have.
    const counter = mix.byChannel.find((c) => c.channel === "counter")!;
    const both =
      shareBps(counter.orderCount, mix.totalOrders)! +
      shareBps(online.orderCount, mix.totalOrders)!;
    expect(Math.abs(both - 10000)).toBeLessThanOrEqual(1);
  });
});
