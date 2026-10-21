/**
 * The open-carts localStorage record — and the one place a checkout ATTEMPT is
 * made durable before it is sent.
 *
 * ## Why this module exists
 *
 * `lib/postAttempt.ts` owns the DECISIONS about an attempt and deliberately
 * touches no storage. The register owned the effects, and it wrote them the
 * ordinary React way: mutate state, let a `useEffect` mirror the state into
 * localStorage. For every other field on a cart that is exactly right.
 *
 * For the attempt it was wrong, and the comment above the call said the
 * opposite of what the code did:
 *
 *     const attempt = beginAttempt(checkoutId, built, now);
 *     updateCartUnconditionally(cartId, (c) => ({ ...c, attempt }));  // queues
 *     await submitAttempt(cartId, attempt);                           // invokes
 *
 * `updateCartUnconditionally` only QUEUES a state update. The `setItem` that
 * mirrors it lives in an effect, and an effect runs after React commits the
 * render — whereas `submitAttempt` calls `salesRepo.post` synchronously, before
 * it yields. So the invoke was dispatched FIRST and the attempt reached
 * localStorage afterwards, if it ever did. A kill in that window left a cart
 * with no attempt and no identity, holding lines for a sale that may have
 * committed: the cashier rings it again, and `post_sale` sees a new identity
 * and a legitimate second sale. The idempotency contract never gets a chance
 * to fire, which is the one defect the whole attempt design exists to prevent.
 *
 * Second defect, independent of ordering: the mirroring effect was
 * `try { setItem } catch { /* ignore * / }`. A full or blocked store meant the
 * attempt was silently not written, and posting proceeded anyway. "Persist
 * before invoking" has to mean "and refuse to invoke if it did not persist",
 * or it is an intention rather than a guarantee.
 *
 * ## What this module guarantees
 *
 * `persistCarts` writes SYNCHRONOUSLY and then READS BACK and compares. It
 * returns a verdict instead of throwing, so the caller must look at it.
 *
 * The read-back is not ceremony. `setItem` throws on quota in every browser
 * worth naming, but it is not the only way a write fails to stick: a store
 * disabled by policy can accept a write and return nothing, a privacy mode can
 * silently drop it, and a record can be truncated at the quota boundary by a
 * concurrent writer. Comparing the exact string back out is the only check
 * that covers all of those, and the record is a handful of kilobytes, so it is
 * cheap. What it cannot promise is fsync — see `lib/postAttempt.ts` for the
 * durability envelope this sits inside. It promises the attempt is in the store
 * before the request is on the wire, not that the store survives a power cut.
 *
 * `requireAttemptFor` points the other way, at the CALLER. The string compare
 * already proves the round trip — any rewrite on the way in changes the bytes
 * — so what is left to check is that the thing being made durable is a
 * replayable attempt at all. It re-runs `isUsableAttempt` on the record as it
 * came back out, which is the same gate the restore path applies on the way in.
 * So the posting path cannot stake a charge on an attempt that a restart would
 * then refuse to recognise, and the two sides cannot drift apart.
 */

import { isUsableAttempt, type PostAttempt } from "./postAttempt";

/** The slice of `localStorage` this module uses. Injectable, so it is testable. */
export interface CartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Why a write could not be proven. The register shows one message for all of
 * them — a cashier can act on "the order was not saved, do not retake it", not
 * on a storage taxonomy — but the reason is carried for diagnostics and tests.
 */
export type PersistFailureReason =
  /** No storage object at all (SSR, a sandboxed frame, disabled by policy). */
  | "unavailable"
  /** The carts would not serialise — a cycle, or a value JSON cannot hold. */
  | "serialize"
  /** `setItem` threw. Quota, almost always. */
  | "write"
  /** The write returned, but the store does not hold what we wrote. */
  | "readback"
  /** A mirror write would have dropped an attempt storage is holding. */
  | "barrier";

export type PersistVerdict =
  | { ok: true }
  | { ok: false; reason: PersistFailureReason; message: string };

/**
 * Who is writing, and therefore what they are allowed to destroy.
 *
 * `"authoritative"` is a deliberate act by the posting path: open an attempt,
 * retire one, clear a settled cart. It may write anything.
 *
 * `"mirror"` is the React effect that keeps storage in step with cart state.
 * It runs on every change to `carts`, it has no idea what a checkout is, and
 * its view of state is whatever render scheduled it. It may NOT remove an
 * attempt that storage is holding — see `ATTEMPT_BARRIER` below.
 */
export type PersistMode = "authoritative" | "mirror";

/**
 * The attempt a caller is staking a charge on: which cart, and which identity.
 *
 * Both halves are needed. A cart id alone proves only that SOMETHING
 * attempt-shaped came back, and the posting path does not invoke under
 * "something" — it invokes under one `checkoutId`, and that is the identity
 * `post_sale` will reconcile a retry against.
 */
export interface AttemptProof {
  cartId: string;
  /** The `checkoutId` that must be the one in storage when this returns ok. */
  checkoutId: string;
}

export interface PersistOptions {
  /**
   * Prove that this cart came back out of storage carrying THIS checkout
   * identity, as a usable attempt. Set by the posting path and by nothing else.
   */
  requireAttemptFor?: AttemptProof;
  /** Default `"authoritative"`. */
  mode?: PersistMode;
  /**
   * Attempts that were INTENTIONALLY retired and may therefore be dropped by a
   * mirror write: cart id → the `checkoutId` that was retired. The register
   * records one when it settles or discards a checkout, and clears the map once
   * the write lands.
   *
   * Without this a retired attempt could never leave storage — the barrier
   * would keep refusing to drop it — and the cart would come back after a
   * restart looking like an unresolved checkout for a sale that had already
   * posted or been refused.
   *
   * KEYED BY IDENTITY, not by cart id alone, and that is the GZ-P1-2 fix. A
   * cart id outlives any number of checkouts: the permission minted when
   * attempt #1 settled was still in the set when attempt #2's write landed, and
   * it authorised deleting an identity nobody had resolved. A permission now
   * only lifts the barrier for the exact attempt it was granted for.
   */
  allowDropFor?: ReadonlyMap<string, string>;
}

/** `localStorage`, or null where it cannot be reached. Never throws. */
export function browserCartStorage(): CartStorage | null {
  try {
    // Touching `localStorage` itself can throw when site data is blocked.
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Write the carts and prove they landed.
 *
 * Structural parameter type on purpose: this module never imports the
 * register's `CartState`, the same way `discount.ts` and `cartRestore.ts`
 * stay off it.
 */
export function persistCarts<C extends { id: string; attempt?: unknown }>(
  storage: CartStorage | null,
  key: string,
  carts: readonly C[],
  options: PersistOptions = {},
): PersistVerdict {
  if (!storage) {
    return { ok: false, reason: "unavailable", message: "Local storage is not available." };
  }

  // ---- THE ATTEMPT BARRIER ----
  //
  // A mirror write may not remove an attempt that storage is holding. This is
  // the structural half of the fix: it does not matter whether a given effect
  // is stale, how React schedules passive effects, or which render a closure
  // came from — a write that would drop a live attempt is REFUSED, by the one
  // function every writer goes through.
  //
  // The hazard it closes is a whole-array overwrite computed from a snapshot.
  // `runPost` writes the attempt synchronously, proves it landed, and only then
  // dispatches; a later write built from a `carts` value that predates it would
  // silently undo that proof, and the cart would come back from a restart with
  // no attempt and no identity while the sale may have committed. That is the
  // double-charge this whole mechanism exists to prevent, reintroduced by a
  // writer that knows nothing about checkouts.
  //
  // Refusing (rather than merging the attempt back in) is deliberate: a mirror
  // write is best-effort by definition, and a cart holding an attempt is LOCKED
  // against edits, so there is no pending cart change for the refusal to lose.
  if ((options.mode ?? "authoritative") === "mirror") {
    const violation = attemptThisWriteWouldLose(storage, key, carts, options.allowDropFor);
    if (violation !== null) {
      return {
        ok: false,
        reason: "barrier",
        message: `Refused: this write would ${violation.what} the open checkout on cart ${violation.cartId}.`,
      };
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(carts);
  } catch (e) {
    return {
      ok: false,
      reason: "serialize",
      message: `The order could not be serialised: ${describe(e)}`,
    };
  }

  try {
    storage.setItem(key, serialized);
  } catch (e) {
    return {
      ok: false,
      reason: "write",
      message: `Local storage refused the write: ${describe(e)}`,
    };
  }

  // ---- Read back ----
  let readBack: string | null;
  try {
    readBack = storage.getItem(key);
  } catch (e) {
    return {
      ok: false,
      reason: "readback",
      message: `Local storage could not be read back: ${describe(e)}`,
    };
  }
  if (readBack !== serialized) {
    return {
      ok: false,
      reason: "readback",
      message: "Local storage did not keep what was written.",
    };
  }

  // ---- Prove the attempt itself, when one is being staked on ----
  const proof = options.requireAttemptFor;
  if (proof !== undefined) {
    const { cartId, checkoutId } = proof;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readBack);
    } catch (e) {
      return {
        ok: false,
        reason: "readback",
        message: `The stored orders could not be parsed back: ${describe(e)}`,
      };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "readback", message: "The stored orders are not a list." };
    }
    const stored = (parsed as { id?: unknown; attempt?: unknown }[]).find(
      (c) => c && c.id === cartId,
    );
    if (!stored || !isUsableAttempt(stored.attempt)) {
      return {
        ok: false,
        reason: "readback",
        message: "The checkout attempt is not in storage after writing it.",
      };
    }
    // THE IDENTITY, not merely an identity (GZ-P1-2). A posting path that
    // serialises an array built from stale state can write the PREVIOUS
    // attempt, read it back intact, and satisfy a presence-only check — and
    // then invoke under an identity that was never persisted. Nothing
    // downstream could detect that: the response is ambiguous either way, and
    // the restart path would recover the wrong checkout.
    if (stored.attempt.checkoutId !== checkoutId) {
      return {
        ok: false,
        reason: "readback",
        message:
          `Storage holds checkout ${stored.attempt.checkoutId} for this order, not ` +
          `${checkoutId}. The attempt about to be sent is not the one that was saved.`,
      };
    }
  }

  return { ok: true };
}

/**
 * How far along a checkout is. An attempt may move FORWARD through these and
 * never back: `"unknown"` is the record that an answer never arrived, and it is
 * what makes the cart offer reconciliation after a restart. A write that
 * returned it to `"posting"` would erase that, and the only writer that could
 * is one whose snapshot predates the timeout.
 */
const ATTEMPT_PROGRESS: Record<PostAttempt["state"], number> = {
  posting: 0,
  unknown: 1,
};

/**
 * What a mirror write would do to an attempt storage is holding, or null if it
 * disturbs none.
 *
 * The question is NOT "does the incoming cart still have an attempt?" — a write
 * carrying an older but structurally valid attempt passes that, and replacing
 * the live identity with a settled one loses exactly as much as deleting it.
 * So three things are compared, and all three have to still hold:
 *
 *   1. the checkout IDENTITY, which is what `post_sale` reconciles a retry on;
 *   2. the FROZEN REQUEST under it, because the canonical content of a replay
 *      is compared too, and a payload that moved turns a retry into a conflict
 *      for a sale that may have committed (the P1-A defect, reintroduced by a
 *      writer that knows nothing about checkouts);
 *   3. the DIRECTION of the outcome, per `ATTEMPT_PROGRESS`.
 *
 * Unreadable or unparseable storage returns null: there is nothing proven to
 * protect, and a mirror write must not be blocked by a store it cannot see
 * into. The authoritative path does its own read-back proof regardless.
 */
function attemptThisWriteWouldLose<C extends { id: string; attempt?: unknown }>(
  storage: CartStorage,
  key: string,
  carts: readonly C[],
  allowDropFor: ReadonlyMap<string, string> | undefined,
): { cartId: string; what: string } | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(stored)) return null;

  const incoming = new Map(carts.map((c) => [c.id, c]));
  for (const row of stored as { id?: unknown; attempt?: unknown }[]) {
    if (!row || typeof row.id !== "string") continue;
    if (!isUsableAttempt(row.attempt)) continue;
    const held = row.attempt;
    // Retirement authority is scoped to the identity it was granted for, so a
    // permission left over from a settled checkout cannot delete the next one.
    if (allowDropFor?.get(row.id) === held.checkoutId) continue;

    const next = incoming.get(row.id);
    // A cart REMOVED entirely is as much a loss as one rewritten without its
    // attempt: either way the identity stops being recoverable.
    if (next === undefined) return { cartId: row.id, what: "drop" };
    if (!isUsableAttempt(next.attempt)) return { cartId: row.id, what: "drop" };

    const arriving = next.attempt;
    if (arriving.checkoutId !== held.checkoutId) {
      return { cartId: row.id, what: "replace the identity of" };
    }
    if (!deepEqual(arriving.request, held.request)) {
      return { cartId: row.id, what: "move the frozen request of" };
    }
    if (ATTEMPT_PROGRESS[arriving.state] < ATTEMPT_PROGRESS[held.state]) {
      return { cartId: row.id, what: "un-resolve" };
    }
  }
  return null;
}

/**
 * Structural equality for frozen requests.
 *
 * `JSON.stringify` comparison would be shorter and wrong: one side is a live
 * object and the other came back through `JSON.parse`, so two payloads equal in
 * every value could serialise with their keys in a different order and be
 * reported as a move. A false refusal here would wedge the mirror for an
 * ordinary cart edit, so the comparison is by value.
 *
 * `undefined` members are treated as absent, which is what a JSON round trip
 * does to them.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    if (x[k] === undefined && y[k] === undefined) continue;
    if (!deepEqual(x[k], y[k])) return false;
  }
  return true;
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
