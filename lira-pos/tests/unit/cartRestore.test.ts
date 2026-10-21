import { describe, expect, it } from "vitest";
import {
  revalidateRestoredCarts,
  revalidateRestoredLines,
} from "../../src/lib/cartRestore";

/**
 * GZ-WP0-05 — a cart restored from localStorage must not post at yesterday's money.
 *
 * Stress 001 reported that an unfinished order was lost across an application
 * restart. WP-0 could not reproduce that: on a disposable identity the cart came
 * back intact through a graceful restart AND a hard kill 50 ms after a line was
 * added. What the investigation DID find is the real hazard — the restored line
 * carries a frozen product snapshot, and the register posts from it. So a cart
 * parked across a price rise or a VAT-rate change would post at the old figures,
 * and `sale_items` would snapshot them permanently.
 *
 * These tests pin the re-check that now runs once, on the first catalog load.
 */

interface P {
  id: string;
  name: string;
  isActive: boolean;
  priceInclVatCents: number;
  priceExclVatCents: number;
  vatBps: number;
  uoms: U[];
}
interface U {
  uomCode: string;
  isActive: boolean;
}
interface M {
  quantityInUom: number;
  unitPriceExclVatCents: number;
  unitPriceInclVatCents: number;
  vatBps: number;
  lineTotalInclVatCents: number;
}

/** Stands in for the register's `lineMathFor` — one price path, as in the app. */
function recompute(product: P, _uom: U, quantityInUom: number): M {
  return {
    quantityInUom,
    unitPriceExclVatCents: product.priceExclVatCents,
    unitPriceInclVatCents: product.priceInclVatCents,
    vatBps: product.vatBps,
    lineTotalInclVatCents: product.priceInclVatCents * quantityInUom,
  };
}

function product(over: Partial<P> = {}): P {
  return {
    id: "p1",
    name: "Double Burger",
    isActive: true,
    priceInclVatCents: 600,
    priceExclVatCents: 541,
    vatBps: 1100,
    uoms: [{ uomCode: "pcs", isActive: true }],
    ...over,
  };
}

function line(p: P, qty = 2) {
  return { product: p, uom: p.uoms[0], math: recompute(p, p.uoms[0], qty) };
}

const catalog = (...ps: P[]) => new Map(ps.map((p) => [p.id, p]));

describe("revalidateRestoredLines (GZ-WP0-05)", () => {
  it("leaves an unchanged cart completely alone", () => {
    const p = product();
    const res = revalidateRestoredLines([line(p)], catalog(p), recompute);
    expect(res.changed).toBe(false);
    expect(res.dropped).toEqual([]);
    expect(res.repriced).toEqual([]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].math.unitPriceInclVatCents).toBe(600);
  });

  it("re-rings a line at TODAY's price and reports the change", () => {
    const parked = line(product()); // rung at $6.00
    const today = product({ priceInclVatCents: 700, priceExclVatCents: 631 });

    const res = revalidateRestoredLines([parked], catalog(today), recompute);

    expect(res.changed).toBe(true);
    expect(res.lines[0].math.unitPriceInclVatCents).toBe(700); // NOT 600
    expect(res.lines[0].math.lineTotalInclVatCents).toBe(1400);
    expect(res.repriced).toEqual([
      {
        productName: "Double Burger",
        beforeUnitInclVatCents: 600,
        afterUnitInclVatCents: 700,
        beforeVatBps: 1100,
        afterVatBps: 1100,
      },
    ]);
  });

  it("re-rings a line whose VAT RATE changed, which no price check would catch", () => {
    const parked = line(product()); // 11%
    const today = product({ vatBps: 0, priceExclVatCents: 600 }); // reclassified exempt

    const res = revalidateRestoredLines([parked], catalog(today), recompute);

    expect(res.changed).toBe(true);
    expect(res.lines[0].math.vatBps).toBe(0);
    expect(res.repriced[0]).toMatchObject({ beforeVatBps: 1100, afterVatBps: 0 });
  });

  it("drops a line whose product is gone from the catalog", () => {
    const parked = line(product());
    const res = revalidateRestoredLines([parked], catalog(), recompute);

    expect(res.lines).toEqual([]);
    expect(res.dropped).toEqual([{ productName: "Double Burger", reason: "gone" }]);
    expect(res.changed).toBe(true);
  });

  it("drops a line whose product has been deactivated", () => {
    const parked = line(product());
    const res = revalidateRestoredLines([parked], catalog(product({ isActive: false })), recompute);
    expect(res.lines).toEqual([]);
    expect(res.dropped[0].reason).toBe("gone");
  });

  it("drops a line whose selling unit has been retired", () => {
    // post_sale resolves the UoM by (product, code, is_active) and refuses an
    // inactive one. Carrying the line would fail at the till with a customer
    // waiting, so it is dropped here instead.
    const parked = line(product());
    const today = product({ uoms: [{ uomCode: "pcs", isActive: false }] });
    const res = revalidateRestoredLines([parked], catalog(today), recompute);
    expect(res.lines).toEqual([]);
    expect(res.dropped).toEqual([{ productName: "Double Burger", reason: "uom" }]);
  });

  it("resolves the selling unit by CODE, not by position", () => {
    const parked = {
      product: product(),
      uom: { uomCode: "box", isActive: true },
      math: recompute(product(), { uomCode: "box", isActive: true }, 1),
    };
    const today = product({
      uoms: [
        { uomCode: "pcs", isActive: true },
        { uomCode: "box", isActive: true },
      ],
    });
    const res = revalidateRestoredLines([parked], catalog(today), recompute);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].uom.uomCode).toBe("box");
  });

  it("keeps the quantity the cashier rang", () => {
    const parked = line(product(), 7);
    const today = product({ priceInclVatCents: 900, priceExclVatCents: 811 });
    const res = revalidateRestoredLines([parked], catalog(today), recompute);
    expect(res.lines[0].math.quantityInUom).toBe(7);
    expect(res.lines[0].math.lineTotalInclVatCents).toBe(6300);
  });

  it("handles a mixed cart: one fine, one repriced, one gone", () => {
    const steady = product({ id: "a", name: "Fries", priceInclVatCents: 300, priceExclVatCents: 270 });
    const moved = product({ id: "b", name: "Wrap" });
    const removed = product({ id: "c", name: "Special" });

    const res = revalidateRestoredLines(
      [line(steady), line(moved), line(removed)],
      catalog(steady, product({ id: "b", name: "Wrap", priceInclVatCents: 650, priceExclVatCents: 586 })),
      recompute,
    );

    expect(res.lines.map((l) => l.product.name)).toEqual(["Fries", "Wrap"]);
    expect(res.repriced.map((r) => r.productName)).toEqual(["Wrap"]);
    expect(res.dropped).toEqual([{ productName: "Special", reason: "gone" }]);
  });

  it("is idempotent — running it twice changes nothing the second time", () => {
    const parked = line(product());
    const today = product({ priceInclVatCents: 700, priceExclVatCents: 631 });
    const once = revalidateRestoredLines([parked], catalog(today), recompute);
    const twice = revalidateRestoredLines(once.lines, catalog(today), recompute);
    expect(twice.changed).toBe(false);
    expect(twice.lines[0].math).toEqual(once.lines[0].math);
  });

  it("does nothing to an empty cart", () => {
    const res = revalidateRestoredLines([], catalog(product()), recompute);
    expect(res).toMatchObject({ lines: [], dropped: [], repriced: [], changed: false });
  });

  it("never returns a line whose product is not the current catalog object", () => {
    // The restored snapshot must be replaced, not merged: a leftover field from
    // the old object is exactly how stale money survives a re-check.
    const parked = line(product());
    const today = product({ priceInclVatCents: 700, priceExclVatCents: 631 });
    const res = revalidateRestoredLines([parked], catalog(today), recompute);
    expect(res.lines[0].product).toBe(today);
  });
});

// ===========================================================================
// GZ-WP0-08 — which restored carts may be re-priced at all
// ===========================================================================
//
// `revalidateRestoredLines` above is right about prices and says nothing about
// WHICH carts should be put through it. Applying it to every restored cart is
// the defect: a cart that comes back still carrying its `checkoutId` is a
// payment whose answer never arrived, and the only thing that can reconcile it
// to a sale that may already have committed is a replay of the payload it was
// SENT. `post_sale` compares a replay field by field — the unit prices, the VAT
// code and the line totals among them — so repricing such a cart turns its
// retry from a reconciliation into a conflict.
//
// The backend half of this is pinned in Rust:
// `src-tauri/src/tests/sales.rs::revalidating_an_unresolved_checkout_would_
// break_its_replay`, beside the test that the frozen payload DOES reconcile.

interface C {
  id: string;
  lines: ReturnType<typeof line>[];
  checkoutId?: string;
}

const cart = (id: string, lines: ReturnType<typeof line>[], checkoutId?: string): C =>
  checkoutId ? { id, lines, checkoutId } : { id, lines };

/** The same product at a new price — a rise while the register was down. */
const dearer = (p: P) => ({ ...p, priceInclVatCents: 900, priceExclVatCents: 811 });

describe("revalidateRestoredCarts (GZ-WP0-08)", () => {
  it("re-prices an ordinary restored cart", () => {
    const p = product();
    const c = cart("c1", [line(p)]);
    const res = revalidateRestoredCarts([c], new Set(["c1"]), catalog(dearer(p)), recompute);

    expect(res.changed).toBe(true);
    expect(res.locked).toEqual([]);
    expect(res.repriced).toHaveLength(1);
    expect(res.carts[0].lines[0].math.unitPriceInclVatCents).toBe(900);
  });

  it("FREEZES a restored cart that still holds a checkout identity", () => {
    const p = product();
    const c = cart("c1", [line(p)], "checkout-1");
    const res = revalidateRestoredCarts([c], new Set(["c1"]), catalog(dearer(p)), recompute);

    // Locked, reported, and bit-for-bit the cart that was persisted.
    expect(res.locked).toEqual(["c1"]);
    expect(res.changed).toBe(false);
    expect(res.repriced).toEqual([]);
    expect(res.dropped).toEqual([]);
    expect(res.carts[0]).toBe(c); // the same object: nothing was rewritten
    expect(res.carts[0].lines[0].math.unitPriceInclVatCents).toBe(600);
    expect(res.carts[0].checkoutId).toBe("checkout-1");
  });

  it("freezes an unresolved cart even when its product is GONE", () => {
    // The strongest form of the rule. Dropping the line would change the
    // basket, and a replay of a different basket is a conflict — so the cart
    // is still frozen and the cashier still gets to replay or discard. A
    // product that has since been deactivated cannot retract a sale that may
    // already have taken the customer's money.
    const p = product();
    const c = cart("c1", [line(p)], "checkout-1");
    const res = revalidateRestoredCarts([c], new Set(["c1"]), catalog(), recompute);

    expect(res.locked).toEqual(["c1"]);
    expect(res.dropped).toEqual([]);
    expect(res.carts[0].lines).toHaveLength(1);
  });

  it("decides each cart on its own", () => {
    const p = product();
    const ordinary = cart("c1", [line(p)]);
    const frozen = cart("c2", [line(p)], "checkout-2");
    const res = revalidateRestoredCarts(
      [ordinary, frozen],
      new Set(["c1", "c2"]),
      catalog(dearer(p)),
      recompute,
    );

    expect(res.locked).toEqual(["c2"]);
    expect(res.carts[0].lines[0].math.unitPriceInclVatCents).toBe(900); // re-priced
    expect(res.carts[1].lines[0].math.unitPriceInclVatCents).toBe(600); // frozen
    // One repricing reported, from the ordinary cart only.
    expect(res.repriced).toHaveLength(1);
  });

  it("never touches a cart that was not restored", () => {
    // A cart rung up in this session was already priced against the catalog in
    // hand, and one holding a live `checkoutId` from a post attempt made in
    // this session is governed by the submission gate, not by this pass.
    const p = product();
    const fresh = cart("c9", [line(p)], "checkout-9");
    const res = revalidateRestoredCarts([fresh], new Set(), catalog(dearer(p)), recompute);

    expect(res.locked).toEqual([]);
    expect(res.changed).toBe(false);
    expect(res.carts[0]).toBe(fresh);
  });

  it("does not freeze or re-price an EMPTY restored cart", () => {
    // An empty cart has no payload to preserve. Freezing it would lock the
    // cashier out of a cart with nothing in it.
    const emptyWithId = cart("c1", [], "checkout-1");
    const res = revalidateRestoredCarts(
      [emptyWithId],
      new Set(["c1"]),
      catalog(product()),
      recompute,
    );

    expect(res.locked).toEqual([]);
    expect(res.changed).toBe(false);
  });

  it("reports no change when an ordinary restored cart is still current", () => {
    const p = product();
    const c = cart("c1", [line(p)]);
    const res = revalidateRestoredCarts([c], new Set(["c1"]), catalog(p), recompute);

    expect(res.changed).toBe(false);
    expect(res.locked).toEqual([]);
    expect(res.carts[0]).toBe(c);
  });

  it("preserves cart order and count whatever it decides", () => {
    const p = product();
    const carts = [
      cart("a", [line(p)]),
      cart("b", [line(p)], "ck-b"),
      cart("c", []),
      cart("d", [line(p)]),
    ];
    const res = revalidateRestoredCarts(
      carts,
      new Set(["a", "b", "c", "d"]),
      catalog(dearer(p)),
      recompute,
    );

    expect(res.carts.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(res.locked).toEqual(["b"]);
  });
});
