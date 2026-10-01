/**
 * Checkout submission safety — pure, synchronous, framework-free.
 *
 * Two mechanisms the POS register needs and React state cannot provide:
 *
 *  1. A SUBMISSION GATE. `submitting` is React state, so it is invisible to a
 *     second handler that runs before the rerender: a mouse double-click, or a
 *     click and an F5 in the same frame, would both pass a `!submitting` check
 *     and launch two independent posts. A gate flips in the same tick as the
 *     first entrant, so the second is dropped.
 *
 *  2. A CHECKOUT REGISTRY. One checkout identity per cart, issued on the first
 *     post attempt and reused by every retry of that attempt. This is the
 *     `saleId` sent to `post_sale`, which is idempotent on it — see
 *     `db/repos/sales.ts::post`.
 *
 * The gate is a convenience, not a guarantee: it lives in one renderer process
 * and cannot see a retry that arrives after a reload or from another window.
 * The identity is what actually makes a retry safe, because the backend is the
 * authority. Both are here so both can be tested without a DOM.
 */

export interface SubmissionGate {
  /**
   * Take the lock. Returns true if this caller may proceed, false if a
   * submission is already in flight — in which case the caller must do
   * nothing at all, including calling `release`.
   */
  tryEnter(): boolean;
  /** Release the lock. Safe to call from a `finally`. */
  release(): void;
  /** Whether a submission currently holds the lock. */
  readonly busy: boolean;
}

export function createSubmissionGate(): SubmissionGate {
  let busy = false;
  return {
    tryEnter(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    release(): void {
      busy = false;
    },
    get busy(): boolean {
      return busy;
    },
  };
}

export interface IssuedCheckoutId {
  id: string;
  /** True when this call minted the id, false when it reused an existing one. */
  issued: boolean;
}

export interface CheckoutRegistry {
  /**
   * The checkout identity for this cart's current attempt, minting one if the
   * cart has none. Synchronous, so two handlers entering in the same frame get
   * the SAME identity and would be one checkout even at the backend.
   */
  idFor(cartId: string): IssuedCheckoutId;
  /** The cart's current identity, without minting one. */
  peek(cartId: string): string | undefined;
  /**
   * Take the cart's identity AND mark a posting attempt unresolved. Between
   * this call and `settleAttempt`, the identity cannot be retired.
   *
   * This is what makes a lost response safe. If the backend committed but the
   * answer never arrived, the cart still holds the identity that names that
   * sale, so the retry reconciles to it. Retiring it in that window — by
   * clearing or closing the cart — would send the next attempt under a fresh
   * identity and ring the same basket up twice.
   */
  beginAttempt(cartId: string): IssuedCheckoutId;
  /**
   * Mark the attempt resolved: the post reached a definitive state, either
   * success or failure. Idempotent, so it is safe in a `finally`.
   */
  settleAttempt(cartId: string): void;
  /** Whether this cart has a posting attempt that has not resolved yet. */
  isPosting(cartId: string): boolean;
  /**
   * Retire the cart's identity — whatever it held is finished, so the next
   * basket in that cart is a new transaction. Called after a sale posts, or
   * when the cart is cleared or closed.
   *
   * REFUSES while an attempt is unresolved, returning false and changing
   * nothing. Callers should not reach that state (Clear and Close are disabled
   * for a posting cart), but the rule lives here so no future caller can
   * retire an identity that a in-flight post may still need.
   */
  retire(cartId: string): boolean;
}

/**
 * @param mint  Identity generator (`lib/ids.ts::newId` in the app).
 * @param seed  Identities recovered from persisted carts, so a parked cart
 *              keeps its identity — and therefore its retry safety — across a
 *              reload.
 */
export function createCheckoutRegistry(
  mint: () => string,
  seed: Readonly<Record<string, string>> = {},
): CheckoutRegistry {
  const ids: Record<string, string> = { ...seed };
  const posting = new Set<string>();

  const idFor = (cartId: string): IssuedCheckoutId => {
    const existing = ids[cartId];
    if (existing) return { id: existing, issued: false };
    const id = mint();
    ids[cartId] = id;
    return { id, issued: true };
  };

  return {
    idFor,
    peek(cartId: string): string | undefined {
      return ids[cartId];
    },
    beginAttempt(cartId: string): IssuedCheckoutId {
      const issued = idFor(cartId);
      posting.add(cartId);
      return issued;
    },
    settleAttempt(cartId: string): void {
      posting.delete(cartId);
    },
    isPosting(cartId: string): boolean {
      return posting.has(cartId);
    },
    retire(cartId: string): boolean {
      if (posting.has(cartId)) return false;
      delete ids[cartId];
      return true;
    },
  };
}
