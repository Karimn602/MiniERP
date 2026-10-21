/**
 * `lib/cartStore.ts` — the verified write that stands between a checkout
 * attempt and `post_sale`.
 *
 * The ordering half of the guarantee is pinned at the component boundary in
 * `postLifecycle.test.tsx` (P1-E), because only the register decides what
 * happens first. What is pinned here is the verdict: every way a write can
 * fail to stick must come back as `ok: false`, including the ways that do not
 * throw. A storage that accepts a write and keeps nothing is the case a
 * try/catch cannot see, and it is the reason this module reads back at all.
 */
import { describe, expect, it } from "vitest";
import { persistCarts, type CartStorage } from "../../src/lib/cartStore";

const KEY = "lira_pos_open_carts";

/** A minimal in-memory store, with each failure mode switchable. */
function fakeStorage(
  opts: {
    onSet?: (key: string, value: string) => void | string;
    throwOnGet?: boolean;
  } = {},
): CartStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      if (opts.throwOnGet) throw new Error("blocked");
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key, value) {
      if (opts.onSet) {
        const replaced = opts.onSet(key, value);
        if (typeof replaced === "string") {
          data.set(key, replaced);
          return;
        }
        return;
      }
      data.set(key, value);
    },
  };
}

/** A usable attempt, per `isUsableAttempt`. */
function attempt(checkoutId: string) {
  return {
    checkoutId,
    startedAt: "2026-10-21T10:00:00.000Z",
    state: "posting" as const,
    request: {
      saleId: checkoutId,
      storeId: "store-1",
      shiftId: "shift-1",
      exchangeRateId: "rate-1",
      exchangeRateLbpPerUsd: 89000,
      lines: [{ productId: "p-1" }],
      payments: [{ method: "cash_usd" }],
    },
  };
}

const cartWith = (a?: unknown) => [{ id: "cart-1", attempt: a }];

describe("persistCarts", () => {
  it("writes, reads back and reports success", () => {
    const s = fakeStorage();
    expect(persistCarts(s, KEY, cartWith())).toEqual({ ok: true });
    expect(JSON.parse(s.data.get(KEY)!)).toEqual([{ id: "cart-1" }]);
  });

  it("proves a required attempt landed", () => {
    const s = fakeStorage();
    const verdict = persistCarts(s, KEY, cartWith(attempt("ck-1")), {
      requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-1" },
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("fails when there is no storage at all", () => {
    const v = persistCarts(null, KEY, cartWith());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unavailable");
  });

  it("fails on a quota throw rather than swallowing it", () => {
    const s = fakeStorage({
      onSet: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const v = persistCarts(s, KEY, cartWith(attempt("ck-1")), { requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-1" } });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("write");
      expect(v.message).toMatch(/QuotaExceeded/);
    }
  });

  it("fails when the write is ACCEPTED but nothing is kept", () => {
    // The silent case. `setItem` returns normally and the store is empty.
    const s = fakeStorage({ onSet: () => undefined });
    const v = persistCarts(s, KEY, cartWith(attempt("ck-1")), { requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-1" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("readback");
  });

  it("fails when the record is truncated on the way in", () => {
    const s = fakeStorage({ onSet: (_k, v) => v.slice(0, Math.floor(v.length / 2)) });
    const v = persistCarts(s, KEY, cartWith(attempt("ck-1")), { requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-1" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("readback");
  });

  it("fails when reading back throws", () => {
    const s = fakeStorage({ throwOnGet: true });
    const v = persistCarts(s, KEY, cartWith());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("readback");
  });

  it("fails when the carts will not serialise", () => {
    const cyclic: Record<string, unknown> = { id: "cart-1" };
    cyclic.self = cyclic;
    const v = persistCarts(fakeStorage(), KEY, [cyclic as { id: string }]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("serialize");
  });

  it("fails when the attempt is stripped out of a record that did land", () => {
    // Valid JSON, right shape, no attempt. Caught by the string compare rather
    // than by the identity check — any edit on the way in changes the bytes,
    // so the round trip is already proven by the time `requireAttemptFor` is
    // consulted. The identity check earns its place on the OTHER side: it
    // validates what the caller handed over (see the malformed case below).
    const s = fakeStorage({
      onSet: (_k, v) =>
        JSON.stringify(
          (JSON.parse(v) as Record<string, unknown>[]).map(({ attempt: _a, ...c }) => c),
        ),
    });
    const v = persistCarts(s, KEY, cartWith(attempt("ck-1")), { requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-1" } });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("readback");
      expect(v.message).toMatch(/did not keep/i);
    }
  });

  it("fails when a required attempt landed MALFORMED", () => {
    // An attempt that cannot be replayed canonically must not pass as one:
    // `isUsableAttempt` is the same gate the restore path uses.
    const s = fakeStorage();
    const broken = { ...attempt("ck-1"), request: { saleId: "ck-1" } };
    const v = persistCarts(s, KEY, cartWith(broken), { requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-1" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("readback");
  });

  it("fails when the required cart is not in the record", () => {
    const s = fakeStorage();
    const v = persistCarts(s, KEY, cartWith(attempt("ck-1")), { requireAttemptFor: { cartId: "cart-2", checkoutId: "ck-1" } });
    expect(v.ok).toBe(false);
  });

  it("does not require an attempt when none is asked for", () => {
    // The mirroring effect writes every ordinary cart edit through here, and
    // an empty cart has no attempt. It must still succeed.
    expect(persistCarts(fakeStorage(), KEY, [{ id: "cart-1" }])).toEqual({ ok: true });
  });
});

// ===========================================================================
// THE ATTEMPT BARRIER — a mirror write may not drop a live attempt
//
// `runPost` writes the attempt, proves it landed, and only then dispatches.
// That proof is worth nothing if some later writer can undo it, and the
// register has writers that compute a whole `carts` array from a SNAPSHOT:
// the restored-cart revalidation effect reads `carts` outside its dependency
// array (there is an eslint-disable on it saying so), and `closeCart` captures
// `carts` and then blocks on `window.confirm` before writing.
//
// Each test below first shows the LOSS — the write a stale writer would make,
// sent the way it used to be sent — and then shows the barrier refusing the
// same write. The loss case is the regression: with it, a cart comes back from
// a restart with no attempt and no identity while its sale may have committed,
// which is the double charge the whole mechanism exists to prevent.
// ===========================================================================

describe("the attempt barrier", () => {
  /** A cart record as storage holds it mid-checkout. */
  const openCheckout = () => cartWith(attempt("ck-live"));
  /** The same cart as a snapshot taken BEFORE the checkout opened. */
  const staleSnapshot = () => [{ id: "cart-1" }];

  function seeded() {
    const s = fakeStorage();
    expect(
      persistCarts(s, KEY, openCheckout(), {
        requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-live" },
      }),
    ).toEqual({ ok: true });
    return s;
  }

  it("REPRODUCES the loss when a stale write is sent authoritatively", () => {
    // This is the old behaviour, and the defect. One unguarded write from a
    // snapshot and the identity is gone from storage.
    const s = seeded();
    expect(persistCarts(s, KEY, staleSnapshot())).toEqual({ ok: true });

    const stored = JSON.parse(s.data.get(KEY)!) as { attempt?: unknown }[];
    expect(stored[0].attempt).toBeUndefined();
    // Nothing left to reconcile the sale against.
    expect(JSON.stringify(stored)).not.toContain("ck-live");
  });

  it("REFUSES the same write in mirror mode, which is how the effect sends it", () => {
    const s = seeded();
    const verdict = persistCarts(s, KEY, staleSnapshot(), { mode: "mirror" });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("barrier");
      expect(verdict.message).toMatch(/cart-1/);
    }
    // And storage still holds the attempt, untouched.
    const stored = JSON.parse(s.data.get(KEY)!) as { attempt?: { checkoutId: string } }[];
    expect(stored[0].attempt?.checkoutId).toBe("ck-live");
  });

  it("REFUSES a mirror write that removes the cart altogether", () => {
    // `closeCart` filters the array. Dropping the row is as much a loss as
    // rewriting it without its attempt: either way the identity stops being
    // recoverable.
    const s = seeded();
    const verdict = persistCarts(s, KEY, [{ id: "cart-other" }], { mode: "mirror" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("barrier");
  });

  it("REFUSES a mirror write that replaces a live attempt with a malformed one", () => {
    // An attempt that cannot be replayed canonically is not an attempt. Letting
    // one overwrite a usable attempt would lose the identity just as surely,
    // while leaving something attempt-shaped behind to hide it.
    const s = seeded();
    const broken = [{ id: "cart-1", attempt: { checkoutId: "ck-live" } }];
    const verdict = persistCarts(s, KEY, broken, { mode: "mirror" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("barrier");
  });

  it("ALLOWS a mirror write that keeps the attempt", () => {
    // The ordinary case: a cart field changed while a checkout is open. The
    // barrier is about attempts, not about freezing storage.
    const s = seeded();
    const sameAttempt = [{ id: "cart-1", attempt: attempt("ck-live"), note: "edited" }];
    expect(persistCarts(s, KEY, sameAttempt, { mode: "mirror" })).toEqual({ ok: true });
  });

  it("ALLOWS a mirror write to drop an attempt the register RETIRED", () => {
    // A committed sale, a proven refusal, or a discarded checkout. Without this
    // the retired attempt could never leave storage, and the cart would come
    // back from a restart looking unresolved for a sale already settled.
    const s = seeded();
    const verdict = persistCarts(s, KEY, staleSnapshot(), {
      mode: "mirror",
      allowDropFor: new Map([["cart-1", "ck-live"]]),
    });
    expect(verdict).toEqual({ ok: true });
    const stored = JSON.parse(s.data.get(KEY)!) as { attempt?: unknown }[];
    expect(stored[0].attempt).toBeUndefined();
  });

  it("does not let a permission for ANOTHER cart lift the barrier", () => {
    const s = fakeStorage();
    persistCarts(s, KEY, [
      { id: "cart-1", attempt: attempt("ck-1") },
      { id: "cart-2", attempt: attempt("ck-2") },
    ]);
    // cart-2 was settled; cart-1 is still live and must survive.
    const verdict = persistCarts(s, KEY, [{ id: "cart-1" }, { id: "cart-2" }], {
      mode: "mirror",
      allowDropFor: new Map([["cart-2", "ck-2"]]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/cart-1/);
  });

  it("still lets the AUTHORITATIVE path open and retire attempts", () => {
    // The barrier constrains the mirror, not the posting path. Opening a
    // checkout and settling it are both deliberate acts and must both work.
    const s = fakeStorage();
    expect(
      persistCarts(s, KEY, cartWith(attempt("ck-a")), {
        requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-a" },
      }),
    ).toEqual({ ok: true });
    expect(persistCarts(s, KEY, staleSnapshot())).toEqual({ ok: true });
  });

  it("does not block a mirror write when storage holds nothing yet", () => {
    expect(persistCarts(fakeStorage(), KEY, [{ id: "cart-1" }], { mode: "mirror" })).toEqual({
      ok: true,
    });
  });

  it("does not block a mirror write when storage cannot be read", () => {
    // Nothing is proven to be protecting, and a mirror write must not be
    // wedged by a store it cannot see into.
    const s = fakeStorage({ throwOnGet: true });
    const v = persistCarts(s, KEY, [{ id: "cart-1" }], { mode: "mirror" });
    // It fails on its own read-back, not on the barrier.
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("readback");
  });

  it("does not block a mirror write when the stored record is corrupt", () => {
    const s = fakeStorage();
    s.data.set(KEY, "{not json");
    expect(persistCarts(s, KEY, [{ id: "cart-1" }], { mode: "mirror" })).toEqual({ ok: true });
  });
});

// ===========================================================================
// GZ-P1-2 — the barrier compares the IDENTITY and the FROZEN REQUEST, not
// merely the presence of something attempt-shaped
//
// The barrier above asks one question of an incoming cart: "does it still have
// a usable attempt?" That is enough to stop a snapshot that predates the
// checkout, because such a snapshot has no attempt at all. It is NOT enough for
// the two writes that carry one:
//
//   * A STALE WRITE WITH AN OLDER ATTEMPT. A cart can hold two attempts in one
//     session — the first settles or is refused, the cashier re-rings, and a
//     second identity is minted. An effect scheduled from the render in
//     between carries attempt #1 and is structurally valid, so it passed the
//     barrier and overwrote attempt #2. The identity on the wire was then the
//     one NOT in storage: a restart recovers the settled checkout and the live
//     one is lost, which is the double charge the mechanism exists to prevent.
//
//   * A STALE RETIREMENT PERMISSION. `allowDropFor` was scoped by CART ID, and
//     a cart id outlives any number of checkouts. So the permission minted when
//     attempt #1 settled was still in the set when attempt #2's write landed,
//     and it authorised deleting attempt #2 — an identity nobody had resolved.
//
// Both are closed by comparing what is actually at stake: the exact checkout
// identity, the frozen canonical request under it, and the direction the
// outcome may move in. Retirement authority is scoped to the identity it was
// granted for.
// ===========================================================================

describe("the barrier compares identity and payload (GZ-P1-2)", () => {
  /** Two attempts on the same cart: #1 settled, #2 is live. */
  const older = () => attempt("ck-old");
  const newer = () => attempt("ck-new");

  /** Storage mid-checkout on the NEWER identity. */
  function seededWithNewer() {
    const s = fakeStorage();
    expect(
      persistCarts(s, KEY, [{ id: "cart-1", attempt: newer() }], {
        requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-new" },
      }),
    ).toEqual({ ok: true });
    return s;
  }

  function storedAttempt(s: { data: Map<string, string> }) {
    const rows = JSON.parse(s.data.get(KEY)!) as { attempt?: { checkoutId?: string } }[];
    return rows[0]?.attempt;
  }

  it("REFUSES a stale mirror write carrying an OLDER valid attempt", () => {
    // The regression. Before the fix this returned ok:true and storage came
    // out holding ck-old, while ck-new was the identity on the wire.
    const s = seededWithNewer();
    const verdict = persistCarts(s, KEY, [{ id: "cart-1", attempt: older() }], {
      mode: "mirror",
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("barrier");
      expect(verdict.message).toMatch(/cart-1/);
    }
    expect(storedAttempt(s)?.checkoutId).toBe("ck-new");
  });

  it("REFUSES a mirror write that moves the frozen request under a live identity", () => {
    // Same checkout id, different basket. `post_sale` compares the canonical
    // content of a replay, so a moved payload turns the retry into a CONFLICT
    // for a sale that may have committed — P1-A, reintroduced by a mirror.
    const s = seededWithNewer();
    const moved = newer();
    moved.request.lines = [{ productId: "p-1" }, { productId: "p-2" }];

    const verdict = persistCarts(s, KEY, [{ id: "cart-1", attempt: moved }], { mode: "mirror" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("barrier");
    expect(
      (JSON.parse(s.data.get(KEY)!) as { attempt: { request: { lines: unknown[] } } }[])[0].attempt
        .request.lines,
    ).toHaveLength(1);
  });

  it("REFUSES a mirror write that un-knows an attempt storage has resolved to UNKNOWN", () => {
    // A request timed out, the register recorded "outcome unknown", and an
    // effect from an earlier render still says "posting". Accepting it would
    // drop the one flag that makes the cart offer reconciliation on restart.
    const s = fakeStorage();
    const unknown = { ...newer(), state: "unknown" as const, message: "no answer" };
    persistCarts(s, KEY, [{ id: "cart-1", attempt: unknown }]);

    const verdict = persistCarts(s, KEY, [{ id: "cart-1", attempt: newer() }], { mode: "mirror" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("barrier");
    expect((storedAttempt(s) as { state?: string } | undefined)?.state).toBe("unknown");
  });

  it("ALLOWS the legitimate posting-to-unknown transition", () => {
    // The forward direction is how an unresolved checkout is recorded, and the
    // mirror is one of the writers that carries it.
    const s = seededWithNewer();
    const unknown = { ...newer(), state: "unknown" as const, message: "no answer" };
    expect(persistCarts(s, KEY, [{ id: "cart-1", attempt: unknown }], { mode: "mirror" })).toEqual({
      ok: true,
    });
    expect((storedAttempt(s) as { state?: string } | undefined)?.state).toBe("unknown");
  });

  it("REFUSES a STALE retirement permission against a newer attempt", () => {
    // The second half of the defect. The permission was minted when ck-old
    // settled; by the time this write lands, storage holds ck-new. A cart-id
    // scoped permission authorised deleting it.
    const s = seededWithNewer();
    const verdict = persistCarts(s, KEY, [{ id: "cart-1" }], {
      mode: "mirror",
      allowDropFor: new Map([["cart-1", "ck-old"]]),
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("barrier");
    expect(storedAttempt(s)?.checkoutId).toBe("ck-new");
  });

  it("ALLOWS a retirement permission for the identity storage actually holds", () => {
    const s = seededWithNewer();
    const verdict = persistCarts(s, KEY, [{ id: "cart-1" }], {
      mode: "mirror",
      allowDropFor: new Map([["cart-1", "ck-new"]]),
    });
    expect(verdict).toEqual({ ok: true });
    expect(storedAttempt(s)).toBeUndefined();
  });

  it("keeps carts isolated: one retired by identity, another still live", () => {
    const s = fakeStorage();
    persistCarts(s, KEY, [
      { id: "cart-1", attempt: attempt("ck-1") },
      { id: "cart-2", attempt: attempt("ck-2") },
    ]);

    // cart-2 settled under ck-2; cart-1's checkout is untouched and must stay.
    const verdict = persistCarts(
      s,
      KEY,
      [{ id: "cart-1", attempt: attempt("ck-1") }, { id: "cart-2" }],
      { mode: "mirror", allowDropFor: new Map([["cart-2", "ck-2"]]) },
    );
    expect(verdict).toEqual({ ok: true });

    const rows = JSON.parse(s.data.get(KEY)!) as { id: string; attempt?: { checkoutId: string } }[];
    expect(rows.find((r) => r.id === "cart-1")?.attempt?.checkoutId).toBe("ck-1");
    expect(rows.find((r) => r.id === "cart-2")?.attempt).toBeUndefined();
  });

  it("proves the EXACT identity landed, not merely that an attempt did", () => {
    // The caller's side of the contract. A posting path that serialises an
    // array built from stale state can write ck-old, read it back intact, and
    // satisfy a presence-only check — then invoke under ck-new, whose attempt
    // was never persisted. Nothing downstream could detect that.
    const s = fakeStorage();
    const verdict = persistCarts(s, KEY, [{ id: "cart-1", attempt: older() }], {
      requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-new" },
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("readback");
      expect(verdict.message).toMatch(/ck-new/);
    }
  });

  it("still proves a matching identity landed", () => {
    const s = fakeStorage();
    expect(
      persistCarts(s, KEY, [{ id: "cart-1", attempt: newer() }], {
        requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-new" },
      }),
    ).toEqual({ ok: true });
  });

  it("ALLOWS a mirror write that keeps the same identity and payload with other fields edited", () => {
    // Field order must not matter either: storage returns a re-parsed object,
    // and a structural comparison is what keeps an equal payload equal.
    const s = seededWithNewer();
    const sameByValue = {
      id: "cart-1",
      attempt: {
        request: { ...newer().request },
        state: "posting" as const,
        startedAt: newer().startedAt,
        checkoutId: "ck-new",
      },
      note: "edited",
    };
    expect(persistCarts(s, KEY, [sameByValue], { mode: "mirror" })).toEqual({ ok: true });
  });

  it("still lets the AUTHORITATIVE path retire and re-open a checkout", () => {
    // Opening ck-old, settling it, and opening ck-new on the same cart is the
    // ordinary two-sales-in-a-row case. The barrier constrains the mirror only.
    const s = fakeStorage();
    expect(
      persistCarts(s, KEY, [{ id: "cart-1", attempt: older() }], {
        requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-old" },
      }),
    ).toEqual({ ok: true });
    expect(persistCarts(s, KEY, [{ id: "cart-1" }])).toEqual({ ok: true });
    expect(
      persistCarts(s, KEY, [{ id: "cart-1", attempt: newer() }], {
        requireAttemptFor: { cartId: "cart-1", checkoutId: "ck-new" },
      }),
    ).toEqual({ ok: true });
    expect(storedAttempt(s)?.checkoutId).toBe("ck-new");
  });
});
