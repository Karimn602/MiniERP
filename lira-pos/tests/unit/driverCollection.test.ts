/**
 * `lib/driverCollection.ts` — the delivery arrangement's arithmetic and rules.
 *
 * The three figures on a delivery order are the whole point: the food (Greaz's
 * sale), the delivery charge (the driver's), and what the customer hands over
 * (nobody's, a display sum). Every test here is ultimately about not letting
 * the second one leak into the first.
 */
import { describe, expect, it } from "vitest";
import {
  DRIVER_COLLECTION,
  deliveryBlocker,
  deliveryTotals,
  isDrawerCash,
  parseFeeCents,
  remittanceBlocker,
  summariseDrivers,
  type DriverSettlementRow,
} from "../../src/lib/driverCollection";

describe("isDrawerCash", () => {
  it("counts only the two cash tenders", () => {
    expect(isDrawerCash("cash_usd")).toBe(true);
    expect(isDrawerCash("cash_lbp")).toBe(true);
  });

  it("does NOT count a driver collection", () => {
    // The single most important assertion in this file. Everything that keeps
    // the till honest — the expected-cash figure, the change rules, the refund
    // guard — keys on this answer. The money is in the driver's pocket.
    expect(isDrawerCash(DRIVER_COLLECTION)).toBe(false);
  });

  it("does not count a card either", () => {
    expect(isDrawerCash("card_usd")).toBe(false);
    expect(isDrawerCash("bank_transfer")).toBe(false);
  });
});

describe("deliveryTotals", () => {
  it("keeps the food, the fee and the customer's payment apart", () => {
    const t = deliveryTotals(1_000, 300);
    expect(t.foodInclVatCents).toBe(1_000);
    expect(t.deliveryFeeCents).toBe(300);
    expect(t.customerPaysCents).toBe(1_300);
  });

  it("never folds the fee into the food", () => {
    // If these two were ever equal the fee would have become revenue.
    const t = deliveryTotals(1_000, 300);
    expect(t.foodInclVatCents).not.toBe(t.customerPaysCents);
  });

  it("handles a free delivery", () => {
    const t = deliveryTotals(1_000, 0);
    expect(t).toEqual({
      foodInclVatCents: 1_000,
      deliveryFeeCents: 0,
      customerPaysCents: 1_000,
    });
  });

  it("clamps a negative fee rather than rendering a total below the food", () => {
    const t = deliveryTotals(1_000, -500);
    expect(t.deliveryFeeCents).toBe(0);
    expect(t.customerPaysCents).toBe(1_000);
  });

  it("stays in integer cents", () => {
    const t = deliveryTotals(999, 1);
    expect(Number.isInteger(t.customerPaysCents)).toBe(true);
    expect(t.customerPaysCents).toBe(1_000);
  });
});

describe("parseFeeCents", () => {
  it("reads whole and fractional amounts", () => {
    expect(parseFeeCents("3")).toBe(300);
    expect(parseFeeCents("3.5")).toBe(350);
    expect(parseFeeCents("3.50")).toBe(350);
    expect(parseFeeCents("0")).toBe(0);
  });

  it("treats an EMPTY box as a free delivery, not an error", () => {
    // Most orders are rung up before the charge is agreed, and refusing to
    // post a free delivery would be wrong.
    expect(parseFeeCents("")).toBe(0);
    expect(parseFeeCents("   ")).toBe(0);
  });

  it("refuses anything that is not a non-negative amount", () => {
    expect(parseFeeCents("-1")).toBeNull();
    expect(parseFeeCents("abc")).toBeNull();
    expect(parseFeeCents("3.456")).toBeNull();
    expect(parseFeeCents("1,5")).toBeNull();
    expect(parseFeeCents("3 ")).toBe(300); // trailing space is fine
  });
});

describe("deliveryBlocker", () => {
  const base = {
    channel: "online_delivery",
    driverId: "d-1",
    feeInput: "3.00",
    collectsByDriver: true,
  };

  it("passes a complete delivery order", () => {
    expect(deliveryBlocker(base)).toBeNull();
  });

  it("passes a plain counter order", () => {
    expect(
      deliveryBlocker({
        channel: "counter",
        driverId: null,
        feeInput: "",
        collectsByDriver: false,
      }),
    ).toBeNull();
  });

  it("refuses a driver collection with nobody to owe it", () => {
    expect(deliveryBlocker({ ...base, driverId: null })).toBe("driverRequired");
  });

  it("refuses a DELIVERY order with no driver at all", () => {
    // Stronger than the old rule, which only asked for a driver once a
    // collection had been toggled on. Every WhatsApp order is carried by one of
    // the shop's own drivers under the confirmed workflow, and without one the
    // register's auto-pay path would turn the blank tender into cashier cash.
    expect(deliveryBlocker({ ...base, driverId: null, collectsByDriver: false })).toBe(
      "driverRequired",
    );
    expect(deliveryBlocker({ ...base, driverId: null, feeInput: "" })).toBe("driverRequired");
  });

  it("still refuses a fee with no driver on a COUNTER order", () => {
    // The fee rule has its own verdict, and this is where it is reachable: a
    // delivery charge typed against a walk-in receipt.
    expect(
      deliveryBlocker({
        channel: "counter",
        driverId: null,
        feeInput: "3.00",
        collectsByDriver: false,
      }),
    ).toBe("feeNeedsDriver");
  });

  it("refuses a driver on a counter order", () => {
    // Checked before the others: a courier on a walk-in receipt is the
    // incoherence to report, not the missing tender.
    expect(
      deliveryBlocker({ ...base, channel: "counter", collectsByDriver: false }),
    ).toBe("driverNeedsDelivery");
  });

  it("refuses an unparseable fee", () => {
    expect(deliveryBlocker({ ...base, feeInput: "3.456" })).toBe("feeInvalid");
    expect(deliveryBlocker({ ...base, feeInput: "-2" })).toBe("feeInvalid");
  });

  it("allows a delivery order once a driver is assigned", () => {
    // `collectsByDriver` is derived from the channel plus the driver in the
    // register now, so it carries no independent meaning here.
    expect(deliveryBlocker({ ...base, collectsByDriver: false })).toBeNull();
  });

  it("allows a free delivery with a driver assigned", () => {
    expect(deliveryBlocker({ ...base, feeInput: "" })).toBeNull();
  });
});

describe("remittanceBlocker", () => {
  it("passes a partial settlement", () => {
    expect(remittanceBlocker(500, 1_000)).toBeNull();
  });

  it("passes a settlement of exactly the balance", () => {
    expect(remittanceBlocker(1_000, 1_000)).toBeNull();
  });

  it("refuses more than he is holding", () => {
    // The shop carries no driver advance, and the ledger is immutable, so an
    // overshoot could never be unwound.
    expect(remittanceBlocker(1_001, 1_000)).toBe("exceedsOutstanding");
  });

  it("refuses a settlement from a driver who owes nothing", () => {
    expect(remittanceBlocker(100, 0)).toBe("nothingOutstanding");
    expect(remittanceBlocker(100, -250)).toBe("nothingOutstanding");
  });

  it("refuses nothing typed, or zero", () => {
    expect(remittanceBlocker(null, 1_000)).toBe("amountInvalid");
    expect(remittanceBlocker(0, 1_000)).toBe("amountZero");
    expect(remittanceBlocker(-5, 1_000)).toBe("amountZero");
  });
});

describe("summariseDrivers", () => {
  const row = (over: Partial<DriverSettlementRow> = {}): DriverSettlementRow => ({
    driverId: "d-1",
    driverName: "Ali",
    isActive: true,
    orderCount: 2,
    collectedCents: 3_000,
    remittedCents: 1_000,
    returnCreditCents: 0,
    adjustmentCents: 0,
    outstandingCents: 2_000,
    deliveryFeesCents: 500,
    lastActivityAt: null,
    ...over,
  });

  it("totals every column", () => {
    const t = summariseDrivers([row(), row({ driverId: "d-2", driverName: "Hassan" })]);
    expect(t.collectedCents).toBe(6_000);
    expect(t.remittedCents).toBe(2_000);
    expect(t.outstandingCents).toBe(4_000);
    expect(t.deliveryFeesCents).toBe(1_000);
    expect(t.orderCount).toBe(4);
  });

  it("reports nothing unreconciled when each balance matches its parts", () => {
    const t = summariseDrivers([
      row(),
      row({
        driverId: "d-2",
        collectedCents: 1_000,
        remittedCents: 200,
        returnCreditCents: 100,
        adjustmentCents: -50,
        outstandingCents: 650,
      }),
    ]);
    expect(t.unreconciled).toEqual([]);
  });

  it("NAMES a driver whose balance disagrees with his own movements", () => {
    // Only reachable if a new ledger entry type were added without a column
    // here — which is exactly the mistake worth catching loudly rather than
    // rendering as two numbers that quietly differ.
    const t = summariseDrivers([row({ outstandingCents: 1_234 })]);
    expect(t.unreconciled).toEqual(["d-1"]);
  });

  it("handles an empty list without inventing zeroes that mean something", () => {
    const t = summariseDrivers([]);
    expect(t.rows).toEqual([]);
    expect(t.outstandingCents).toBe(0);
    expect(t.unreconciled).toEqual([]);
  });

  it("keeps a negative balance negative in the total", () => {
    // Credit on file is real: the shop can owe a driver after a return he
    // funded. Clamping it would overstate what the shop is owed.
    const t = summariseDrivers([
      row({ outstandingCents: 2_000 }),
      row({
        driverId: "d-2",
        collectedCents: 0,
        remittedCents: 0,
        returnCreditCents: 500,
        adjustmentCents: 0,
        outstandingCents: -500,
      }),
    ]);
    expect(t.outstandingCents).toBe(1_500);
  });
});
