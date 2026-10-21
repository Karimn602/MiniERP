/**
 * A checkout ATTEMPT — the frozen request, its identity, and its outcome.
 *
 * Pure: no React, no database, no `invoke`. The register owns the effects; this
 * module owns the decisions, so they can be tested without a desktop.
 *
 * ## Why an attempt is a thing, and not just a flag
 *
 * `post_sale` is idempotent on `sales.id`, which the client mints as the
 * CHECKOUT IDENTITY. Replaying that identity with the same canonical content
 * returns the sale that already posted; replaying it with materially different
 * content is refused as a conflict (`posting.rs::CanonicalSale`). That contract
 * is the only thing standing between a lost response and a double charge, and
 * it is only usable if the client can re-send what it sent the first time.
 *
 * The register could not. It held a `checkoutId` on the cart and rebuilt the
 * payload from live React state on every press, so four things could go wrong
 * and did:
 *
 *   * **P1-A** — the cart stayed editable while a post was in flight and after
 *     an ambiguous failure. A quantity typed in that window changed the basket
 *     under a committed identity, turning the retry into a conflict.
 *   * **P1-B** — posting and receipt-loading shared one `try`, so a committed
 *     sale whose receipt query failed was reported to the cashier as a failure.
 *   * **P1-C** — the cart persisted its lines but not the SHIFT, the exchange
 *     rate, the cashier or the COGS method. After a restart those are re-read
 *     from today's context, and every one of them is compared on replay.
 *   * **P1-D** — a restored cart could post before its catalog revalidation
 *     had run or after it had failed, at prices nobody had checked.
 *
 * So an attempt is created ONCE, carries the complete canonical request, and is
 * the only thing posting ever sends.
 *
 * ## Durability — what is actually guaranteed
 *
 * An attempt is stored INSIDE its cart, in the carts' own localStorage record,
 * and that is a deliberate choice rather than a convenience.
 *
 * `localStorage.setItem` returns synchronously but does not fsync; WebView2
 * backs it with a LevelDB store that flushes on its own schedule. So a write
 * made microseconds before a hard kill can be lost, and no synchronous browser
 * API can promise otherwise. Claiming crash-proof durability here would be
 * false.
 *
 * What CAN be promised is that the attempt is exactly as durable as the cart it
 * belongs to, because they are one record written by one `setItem`. That closes
 * the case that actually causes a double charge:
 *
 *   * cart survives, attempt survives → recovery works. (The interesting case,
 *     and the one that is now sound.)
 *   * cart lost, attempt lost → there is no cart to ring up again, so there is
 *     nothing to double-charge. A sale that did commit is in `sales` and shows
 *     in Sales History.
 *
 * It does NOT close the case where the cart record is lost while a sale
 * committed and the cashier re-rings the order from memory. No client-side
 * store can: the only authority is the database, which is why the recovery
 * action probes it by identity rather than guessing.
 *
 * A backend-held pending-attempt table (a migration, plus a write before and a
 * delete after every post) would make the attempt durable INDEPENDENTLY of the
 * cart. It is not implemented here because it closes no case the paragraph
 * above leaves open — both records are lost together — and it would put two
 * extra synchronous round-trips on the hot path of every sale. If a future
 * requirement separates the two (a server-side cart, or a second terminal
 * resuming another's checkout), that is the design to reach for.
 */

import type { PostSaleInput, PostSaleLineInput, PostSalePaymentInput } from "../db/repos/sales";

/**
 * The complete canonical posting request, exactly as `salesRepo.post` takes it.
 *
 * Child identifiers are absent on purpose: `salesRepo.post` mints a fresh
 * `saleItemId` / `paymentId` per call and the backend excludes them from the
 * canonical comparison as request noise. Freezing them would be harmless but
 * misleading — it would suggest they matter.
 *
 * Everything the backend DOES compare is here: the store, shift, cashier,
 * device, locked exchange rate and its value, the COGS method, the notes, the
 * header discount, every line's product / UoM / quantity / prices / VAT /
 * subtotal / VAT amount / total / line discount, and every payment's method,
 * currency, native amounts, USD equivalent and reference.
 */
export type FrozenPostSaleRequest = Omit<PostSaleInput, "lines" | "payments"> & {
  lines: Omit<PostSaleLineInput, "saleItemId">[];
  payments: Omit<PostSalePaymentInput, "paymentId">[];
};

/**
 * Where a cart's checkout stands.
 *
 * Only `posting` and `unknown` are ever persisted: the other outcomes are
 * terminal for the attempt. `committed` clears the cart, and `rejected` hands
 * it back to the cashier to edit.
 */
export type PostAttemptState = "posting" | "unknown";

export interface PostAttempt {
  /** The `saleId` sent to `post_sale`. Minted once, reused by every retry. */
  checkoutId: string;
  /** The request as first built. Posting replays this, never current state. */
  request: FrozenPostSaleRequest;
  /** ISO timestamp of the first attempt, for the operator-facing message. */
  startedAt: string;
  state: PostAttemptState;
  /** Why the outcome is unknown, when it is. */
  message?: string;
}

/** How many times Post has been pressed against this identity, for display. */
export interface PostAttemptView {
  attempt: PostAttempt;
  /** True while a request is genuinely in flight in THIS session. */
  inFlight: boolean;
}

// ---------------------------------------------------------------------------
// Failure classification — the one reader of the backend's refusal contract
// ---------------------------------------------------------------------------

export type PostFailure =
  /**
   * The backend reached a verdict and committed nothing. Proven, not inferred:
   * see `posting.rs::PostSaleFailure`. The cart is safe to edit and re-post.
   */
  | { kind: "rejected"; message: string }
  /**
   * No verdict reached us. The sale may or may not have committed, and the
   * only way to find out is to ask the database by identity.
   */
  | { kind: "unknown"; message: string };

/** Is this the backend's typed refusal envelope? */
function isRefusalEnvelope(err: unknown): err is { refused: true; message?: unknown } {
  return (
    typeof err === "object" &&
    err !== null &&
    "refused" in err &&
    (err as { refused: unknown }).refused === true
  );
}

/** Best-effort human text for anything that can be thrown. */
export function failureMessage(err: unknown): string {
  if (isRefusalEnvelope(err) && typeof err.message === "string") return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Decide whether a failed post proves the sale did not commit.
 *
 * `rejected` requires the backend's own envelope. EVERYTHING else is `unknown`
 * — a thrown `Error`, a bare string, a timeout, a torn-down window, a
 * serialization failure, `undefined`. That asymmetry is the whole point: the
 * safe answer is the uncertain one, so an unrecognised failure degrades to
 * "reconcile on the identity" rather than to "the cashier may ring it again".
 *
 * Nothing here matches on message text. A refusal is identified by the shape
 * the backend promises and by nothing else, so a reworded error, a translated
 * one, or a driver error that happens to read like a validation failure cannot
 * move an outcome from unknown to proven.
 */
export function classifyPostFailure(err: unknown): PostFailure {
  const message = failureMessage(err);
  return isRefusalEnvelope(err) ? { kind: "rejected", message } : { kind: "unknown", message };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Open an attempt. Called once per checkout, before the backend is invoked. */
export function beginAttempt(
  checkoutId: string,
  request: FrozenPostSaleRequest,
  now: string,
): PostAttempt {
  return { checkoutId, request, startedAt: now, state: "posting" };
}

/** Move an attempt to `unknown`, keeping its identity and its request. */
export function toUnknown(attempt: PostAttempt, message: string): PostAttempt {
  return { ...attempt, state: "unknown", message };
}

/**
 * Normalise an attempt recovered from storage.
 *
 * A persisted `posting` means the process went away while a request was in
 * flight, which is the definition of an unknown outcome — so it is promoted on
 * the way in and the cashier is never shown a spinner for a request that no
 * longer exists.
 */
export function attemptOnRestore(attempt: PostAttempt, message: string): PostAttempt {
  return attempt.state === "posting" ? toUnknown(attempt, message) : attempt;
}

/**
 * Is this value a usable attempt?
 *
 * Storage is not a trusted input: a cart record can be hand-edited, truncated
 * or written by an older build. An attempt that fails this check cannot be
 * replayed canonically, so it must not masquerade as one.
 */
export function isUsableAttempt(value: unknown): value is PostAttempt {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<PostAttempt>;
  if (typeof a.checkoutId !== "string" || a.checkoutId.length === 0) return false;
  if (a.state !== "posting" && a.state !== "unknown") return false;
  const r = a.request as FrozenPostSaleRequest | undefined;
  if (typeof r !== "object" || r === null) return false;
  if (typeof r.saleId !== "string" || r.saleId !== a.checkoutId) return false;
  if (typeof r.storeId !== "string" || typeof r.shiftId !== "string") return false;
  if (typeof r.exchangeRateId !== "string") return false;
  if (typeof r.exchangeRateLbpPerUsd !== "number") return false;
  if (!Array.isArray(r.lines) || r.lines.length === 0) return false;
  if (!Array.isArray(r.payments)) return false;
  return true;
}

/**
 * A cart carrying a `checkoutId` from a build that stored no frozen request.
 *
 * Such a cart is still an unresolved checkout and must still be locked, but it
 * CANNOT be replayed: the request the backend would compare against is not
 * recoverable, and rebuilding it from the cart plus today's shift and rate is
 * exactly the P1-C defect. So it is offered reconciliation by identity — a
 * read-only probe of the database — and never a blind re-post.
 */
export function isLegacyUnresolvedCart(cart: {
  checkoutId?: string;
  attempt?: unknown;
  lines: unknown[];
}): boolean {
  return (
    !isUsableAttempt(cart.attempt) &&
    typeof cart.checkoutId === "string" &&
    cart.checkoutId.length > 0 &&
    cart.lines.length > 0
  );
}

// ---------------------------------------------------------------------------
// What the register may do with a cart
// ---------------------------------------------------------------------------

/**
 * A cart's checkout, as the register needs to reason about it.
 *
 * `locked` is the one the UI guards on, and it is true for an in-flight post
 * AND for an unresolved one. Both are states in which the canonical request
 * must not move: the first because the request is already on the wire, the
 * second because it is the key to a sale that may exist.
 */
export interface CheckoutStatus {
  locked: boolean;
  /** A request is on the wire right now, in this session. */
  inFlight: boolean;
  /** An attempt whose outcome is unknown; reconcilable by identity. */
  unresolved: boolean;
  /** Unresolved, but with no frozen request — reconcile only, never replay. */
  legacy: boolean;
  /** The identity to reconcile on, when there is one. */
  checkoutId: string | null;
  /** The request to replay, when there is one. */
  request: FrozenPostSaleRequest | null;
}

export function checkoutStatus(
  cart: { checkoutId?: string; attempt?: unknown; lines: unknown[] },
  inFlightCartIds: ReadonlySet<string>,
  cartId: string,
): CheckoutStatus {
  const inFlight = inFlightCartIds.has(cartId);
  const attempt = isUsableAttempt(cart.attempt) ? cart.attempt : null;
  const legacy = isLegacyUnresolvedCart(cart);

  if (attempt) {
    return {
      locked: true,
      inFlight,
      unresolved: attempt.state === "unknown",
      legacy: false,
      checkoutId: attempt.checkoutId,
      request: attempt.request,
    };
  }

  if (legacy) {
    return {
      locked: true,
      inFlight,
      unresolved: true,
      legacy: true,
      checkoutId: cart.checkoutId ?? null,
      request: null,
    };
  }

  // No attempt. A post in flight still locks the cart — the attempt is written
  // before the invoke, so this is belt-and-braces rather than a live path.
  return {
    locked: inFlight,
    inFlight,
    unresolved: false,
    legacy: false,
    checkoutId: cart.checkoutId ?? null,
    request: null,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * The verdict of probing the database for a checkout identity.
 *
 * This is how an unknown outcome is resolved, and it needs no write: the sale
 * either exists under that identity or it does not. `post_sale` consumes the
 * identity on exactly one commit, so finding a row is proof it committed and
 * finding none is proof it had not, as of the read.
 */
export type ReconcileVerdict =
  /** The sale is there. It committed; show it and clear the cart. */
  | { kind: "committed" }
  /** No sale under this identity. The attempt may be posted for real. */
  | { kind: "notCommitted" }
  /** The probe itself failed. Nothing is proven; stay unresolved. */
  | { kind: "indeterminate"; message: string };

export function reconcileFromProbe(found: boolean): ReconcileVerdict {
  return found ? { kind: "committed" } : { kind: "notCommitted" };
}
