/**
 * Re-checking a cart that came back from localStorage — pure, no React, no DB.
 *
 * ## Why this exists
 *
 * Open carts survive an application restart: they are written to localStorage
 * on every change and read back on mount. WP-0 verified that end to end on a
 * disposable identity, including a hard kill 50 ms after a line was added — the
 * cart, its id, its sequence number, its lines and its quantities all came back.
 *
 * What does NOT come back correct is the *catalog data frozen inside it*. A
 * restored `CartLine` carries a whole `ProductWithUoms` snapshot serialised at
 * the moment the line was rung: its price, its VAT rate and its UoM factors.
 * The register posts from exactly those fields — `handlePost` reads
 * `l.math.unitPrice*` and `l.product.vatRate.rateBps` — and `post_sale` takes
 * the price as given. So a cart parked on Friday and posted on Monday, across a
 * price rise or a VAT-rate change, posts at FRIDAY's price and FRIDAY's rate,
 * and `sale_items` snapshots that permanently.
 *
 * Nothing in the restore path noticed, because from its point of view a
 * restored line and a freshly rung one are the same shape.
 *
 * ## What this does
 *
 * Re-resolves every restored line against the catalog as it is NOW, and
 * recomputes the line math through the caller's own `recompute` — the very
 * function the add-to-cart path uses, so there is exactly one price path and no
 * second financial calculation. A line whose product or selling unit has gone
 * is dropped rather than carried; a line whose price, VAT rate or conversion
 * moved is kept at the CURRENT figures and reported, so the cashier is told
 * rather than surprised at the total.
 *
 * The parameter types are structural on purpose, the way `discount.ts` does it:
 * the register passes its own `CartLine[]` and this module never imports it.
 */

/** The minimum of a cart line this module needs to re-resolve it. */
export interface RestorableLine<P, U, M> {
  product: P;
  uom: U;
  math: M;
}

interface MinimalProduct {
  id: string;
  name: string;
  isActive: boolean;
}

interface MinimalUom {
  uomCode: string;
  isActive: boolean;
}

interface MinimalMath {
  quantityInUom: number;
  unitPriceExclVatCents: number;
  unitPriceInclVatCents: number;
  vatBps: number;
}

/** A line that could not be carried forward, and why. */
export interface DroppedLine {
  productName: string;
  /** `gone` — not in the catalog, or deactivated. `uom` — selling unit retired. */
  reason: "gone" | "uom";
}

/** A line that came back at different money than it was rung at. */
export interface RepricedLine {
  productName: string;
  beforeUnitInclVatCents: number;
  afterUnitInclVatCents: number;
  beforeVatBps: number;
  afterVatBps: number;
}

export interface RevalidationResult<L> {
  lines: L[];
  dropped: DroppedLine[];
  repriced: RepricedLine[];
  /** True when anything at all changed — the caller's cue to tell the cashier. */
  changed: boolean;
}

/**
 * Re-resolve restored lines against the current catalog.
 *
 * `current` is the live catalog keyed by product id. A product missing from it
 * is treated as unsellable — which is what `productsRepo.listEnriched` already
 * means, since it filters to `is_active = 1`.
 *
 * `recompute` must be the register's own line-math function. This module
 * deliberately does no arithmetic of its own: it decides WHICH product and unit
 * a line refers to, and hands the money back to the one function that owns it.
 */
export function revalidateRestoredLines<
  P extends MinimalProduct,
  U extends MinimalUom,
  M extends MinimalMath,
  L extends RestorableLine<P, U, M>,
>(
  lines: L[],
  current: Map<string, P & { uoms: U[] }>,
  recompute: (product: P, uom: U, quantityInUom: number) => M,
): RevalidationResult<L> {
  const kept: L[] = [];
  const dropped: DroppedLine[] = [];
  const repriced: RepricedLine[] = [];

  for (const line of lines) {
    const product = current.get(line.product.id);
    if (!product || !product.isActive) {
      dropped.push({ productName: line.product.name, reason: "gone" });
      continue;
    }

    // The selling unit is resolved by CODE against the product's own active
    // rows — the same lookup key `post_sale` uses. A retired conversion must
    // not be carried on a restored line, because the backend would refuse it
    // at post time and the cashier would learn that with a customer waiting.
    const uom = product.uoms.find((u) => u.uomCode === line.uom.uomCode && u.isActive);
    if (!uom) {
      dropped.push({ productName: line.product.name, reason: "uom" });
      continue;
    }

    const math = recompute(product, uom, line.math.quantityInUom);

    if (
      math.unitPriceInclVatCents !== line.math.unitPriceInclVatCents ||
      math.unitPriceExclVatCents !== line.math.unitPriceExclVatCents ||
      math.vatBps !== line.math.vatBps
    ) {
      repriced.push({
        productName: product.name,
        beforeUnitInclVatCents: line.math.unitPriceInclVatCents,
        afterUnitInclVatCents: math.unitPriceInclVatCents,
        beforeVatBps: line.math.vatBps,
        afterVatBps: math.vatBps,
      });
    }

    kept.push({ ...line, product, uom, math });
  }

  return {
    lines: kept,
    dropped,
    repriced,
    changed: dropped.length > 0 || repriced.length > 0,
  };
}

// ─── Which restored carts may be revalidated at all (GZ-WP0-08) ──────────────
//
// Revalidating EVERY restored cart is wrong, and the way it is wrong is worse
// than the staleness it fixes.
//
// A cart is persisted with its `checkoutId` — the `saleId` sent to `post_sale`
// — from the moment Post is first pressed. So a cart that comes back from
// localStorage *carrying* one is not an ordinary parked order: it is a payment
// attempt that never reached a definitive answer. The app died, or was killed,
// or the window went away, between the request and its response. Whether the
// sale committed is unknown to the client and knowable only by replaying that
// identity.
//
// That replay is only safe while the payload is UNCHANGED. `post_sale`'s
// idempotency compares the canonical content of the replay against the sale
// that posted (`posting.rs::CanonicalSale`), and the fields it compares are
// exactly the ones revalidation rewrites: `unit_price_excl_vat_cents`,
// `unit_price_incl_vat_cents`, `vat_rate_id`, `vat_rate_bps` and the line
// subtotal / VAT / total. Reprice a restored checkout and its retry no longer
// reconciles — it is a CONFLICT. The sale that exists is not returned, the
// cashier gets a hard refusal with a customer in front of them, and the one
// mechanism built to recover a lost response has been disabled by the one
// built to keep prices current.
//
// So the two kinds of restored cart are separated here:
//
//   * no `checkoutId` — an ordinary saved cart. Nobody has tried to pay for
//     it, no identity exists, nothing downstream depends on its figures.
//     Revalidated against the current catalog, exactly as before.
//
//   * `checkoutId` present — an unresolved checkout. FROZEN: not revalidated,
//     not editable, and retryable only as it stands. Its id is returned so the
//     register can lock it and say so.
//
// Freezing does mean a retry can post at the prices the cart was rung at. That
// is the correct trade: those ARE the prices of the transaction under way, and
// if the sale already committed they are the prices it committed at. A cashier
// who wants today's prices discards the attempt — which retires the identity
// deliberately, with the double-charge risk stated — and rings the order again.

/** The minimum of a cart this module needs to classify it. */
export interface RestorableCart<L> {
  id: string;
  lines: L[];
  /** Present once a post has been attempted for this cart. */
  checkoutId?: string;
  /**
   * The frozen attempt, when WP-1 wrote one. Its mere PRESENCE freezes the
   * cart; this module never looks inside it, so it stays independent of
   * `lib/postAttempt.ts` and of the request's shape.
   */
  attempt?: unknown;
}

export interface CartRevalidationOutcome<C> {
  /** Every cart, in input order: revalidated, frozen, or untouched. */
  carts: C[];
  dropped: DroppedLine[];
  repriced: RepricedLine[];
  /**
   * Ids of restored carts frozen because they carry an unresolved checkout
   * identity. The register locks these against editing and offers retry or
   * discard.
   */
  locked: string[];
  /** True when any cart's lines were rewritten — the cue to tell the cashier. */
  changed: boolean;
}

/**
 * Revalidate the ordinary restored carts and freeze the unresolved ones.
 *
 * `restoredIds` is the set of cart ids that came from localStorage on this
 * mount; a cart created since is not a restored cart and is never touched.
 *
 * This is the whole restore decision, so the register can call it and hold no
 * policy of its own — and so the policy can be tested without a DOM.
 */
export function revalidateRestoredCarts<
  P extends MinimalProduct,
  U extends MinimalUom,
  M extends MinimalMath,
  L extends RestorableLine<P, U, M>,
  C extends RestorableCart<L>,
>(
  carts: C[],
  restoredIds: ReadonlySet<string>,
  current: Map<string, P & { uoms: U[] }>,
  recompute: (product: P, uom: U, quantityInUom: number) => M,
): CartRevalidationOutcome<C> {
  const dropped: DroppedLine[] = [];
  const repriced: RepricedLine[] = [];
  const locked: string[] = [];
  let changed = false;

  const next = carts.map((cart) => {
    if (!restoredIds.has(cart.id) || cart.lines.length === 0) return cart;

    // An unresolved checkout attempt. Its canonical payload is the only thing
    // that can reconcile a lost response, so nothing here may rewrite it.
    // Either marker freezes the cart: a WP-1 frozen attempt, or a bare
    // `checkoutId` from a build that stored no request. The second kind cannot
    // be replayed at all, which makes repricing it even more pointless — but
    // it is still an identity that may name a committed sale, so it is still
    // not editable.
    if (cart.attempt !== undefined || cart.checkoutId) {
      locked.push(cart.id);
      return cart;
    }

    const res = revalidateRestoredLines(cart.lines, current, recompute);
    if (!res.changed) return cart;
    changed = true;
    dropped.push(...res.dropped);
    repriced.push(...res.repriced);
    return { ...cart, lines: res.lines };
  });

  return { carts: next, dropped, repriced, locked, changed };
}
