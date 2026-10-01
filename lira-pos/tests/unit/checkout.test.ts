import { describe, expect, it } from "vitest";
import {
  createCheckoutRegistry,
  createSubmissionGate,
} from "../../src/lib/checkout";

// ============================================================================
// Submission gate — frontend re-entry protection (WP-02, requirement 6)
// ============================================================================
//
// These model the register's posting handler: `handlePost` takes the gate,
// awaits the post, and releases it in a `finally`. The point of the gate is
// that it is SYNCHRONOUS — React's `submitting` state is not visible to a
// second handler that runs before the rerender.

/** A stand-in for `PosRegister.handlePost`: gate → post → release. */
function postingHandler(
  gate: ReturnType<typeof createSubmissionGate>,
  post: () => Promise<void>,
): () => Promise<boolean> {
  return async () => {
    if (!gate.tryEnter()) return false; // dropped
    try {
      await post();
      return true;
    } finally {
      gate.release();
    }
  };
}

describe("createSubmissionGate", () => {
  it("lets the first caller in and drops the second", () => {
    const gate = createSubmissionGate();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(false);
    expect(gate.busy).toBe(true);
    gate.release();
    expect(gate.busy).toBe(false);
    expect(gate.tryEnter()).toBe(true);
  });

  it("a mouse double-click launches exactly one post", async () => {
    const gate = createSubmissionGate();
    let posts = 0;
    const handle = postingHandler(gate, async () => {
      posts++;
      await Promise.resolve(); // the await the real handler has
    });

    // Both clicks fire before anything awaits — the same frame.
    const [first, second] = await Promise.all([handle(), handle()]);

    expect(posts).toBe(1);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("rapid F5 presses launch exactly one post", async () => {
    const gate = createSubmissionGate();
    let posts = 0;
    const handle = postingHandler(gate, async () => {
      posts++;
      await Promise.resolve();
    });

    const results = await Promise.all([handle(), handle(), handle(), handle(), handle()]);

    expect(posts).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a click and an F5 together launch exactly one post", async () => {
    const gate = createSubmissionGate();
    let posts = 0;
    const handle = postingHandler(gate, async () => {
      posts++;
      await new Promise((r) => setTimeout(r, 1));
    });

    const click = handle();
    const f5 = handle(); // entered before the click's post resolved
    await Promise.all([click, f5]);

    expect(posts).toBe(1);
  });

  it("releases the gate when the post throws, so the cashier can retry", async () => {
    const gate = createSubmissionGate();
    let attempts = 0;
    const handle = postingHandler(gate, async () => {
      attempts++;
      throw new Error("insufficient stock");
    });

    await expect(handle()).rejects.toThrow("insufficient stock");
    expect(gate.busy).toBe(false);

    await expect(handle()).rejects.toThrow("insufficient stock");
    expect(attempts).toBe(2);
  });

  it("allows the next sale once the previous one finishes", async () => {
    const gate = createSubmissionGate();
    let posts = 0;
    const handle = postingHandler(gate, async () => {
      posts++;
      await Promise.resolve();
    });

    await handle();
    await handle();
    expect(posts).toBe(2);
  });
});

// ============================================================================
// Checkout registry — one identity per cart, reused across retries
// ============================================================================

function sequentialMint(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("createCheckoutRegistry", () => {
  it("mints an identity on the first attempt and reuses it on every retry", () => {
    const registry = createCheckoutRegistry(sequentialMint());

    const first = registry.idFor("cart-a");
    expect(first).toEqual({ id: "id-1", issued: true });

    // Every retry of the same checkout sends the same identity — which is what
    // makes post_sale able to recognise it as a replay.
    for (let i = 0; i < 5; i++) {
      expect(registry.idFor("cart-a")).toEqual({ id: "id-1", issued: false });
    }
  });

  it("gives the next sale a fresh identity once the previous one is retired", () => {
    const registry = createCheckoutRegistry(sequentialMint());

    expect(registry.idFor("cart-a").id).toBe("id-1");
    registry.retire("cart-a"); // posted, or the cart was cleared
    expect(registry.peek("cart-a")).toBeUndefined();

    const next = registry.idFor("cart-a");
    expect(next).toEqual({ id: "id-2", issued: true });
  });

  it("keeps each cart's identity independent", () => {
    const registry = createCheckoutRegistry(sequentialMint());

    expect(registry.idFor("cart-a").id).toBe("id-1");
    expect(registry.idFor("cart-b").id).toBe("id-2");
    expect(registry.idFor("cart-c").id).toBe("id-3");

    // Retiring one cart's identity leaves the parked carts untouched.
    registry.retire("cart-b");
    expect(registry.peek("cart-a")).toBe("id-1");
    expect(registry.peek("cart-b")).toBeUndefined();
    expect(registry.peek("cart-c")).toBe("id-3");

    // And switching back to a parked cart resumes its own checkout.
    expect(registry.idFor("cart-a")).toEqual({ id: "id-1", issued: false });
  });

  it("recovers a parked cart's identity from persisted carts", () => {
    // What the register does on mount: seed from the carts it loaded out of
    // localStorage, so a reload mid-checkout does not mint a second identity
    // for a sale that may already have posted.
    const registry = createCheckoutRegistry(sequentialMint(), { "cart-a": "saved-id" });

    expect(registry.idFor("cart-a")).toEqual({ id: "saved-id", issued: false });
    expect(registry.idFor("cart-b")).toEqual({ id: "id-1", issued: true });
  });

  it("does not mutate the seed it was given", () => {
    const seed = { "cart-a": "saved-id" };
    const registry = createCheckoutRegistry(sequentialMint(), seed);
    registry.retire("cart-a");
    registry.idFor("cart-b");
    expect(seed).toEqual({ "cart-a": "saved-id" });
  });
});

// ============================================================================
// Clear / Close during an unresolved post (WP-02 correction, blocker 2)
// ============================================================================
//
// The danger: the cashier presses Post, the backend COMMITS, the response is
// lost or slow, and the cashier then clears or closes that cart. Retiring the
// checkout identity in that window means the next attempt goes out under a
// fresh one, and the same basket is rung up twice.
//
// So an identity stays attached to its cart until the attempt reaches a
// definitive state. `PosRegister` disables Clear and Close for a posting cart
// and guards both handlers with `isPosting`; the registry refuses the retire
// outright, so no future caller can get it wrong either.

/**
 * A stand-in for the register's cart controls, modelling exactly what
 * `PosRegister.clearCart` / `closeCart` / `runPost` do with the registry.
 */
function cartControls(registry: ReturnType<typeof createCheckoutRegistry>) {
  const contents: Record<string, string[]> = {};
  const open = new Set<string>();

  return {
    contents,
    open,
    add(cartId: string, ...items: string[]) {
      open.add(cartId);
      contents[cartId] = [...(contents[cartId] ?? []), ...items];
    },
    /** `clearCart`: refuses while that cart's post is unresolved. */
    clear(cartId: string): boolean {
      if (registry.isPosting(cartId)) return false;
      registry.retire(cartId);
      contents[cartId] = [];
      return true;
    },
    /** `closeCart`: same rule. */
    close(cartId: string): boolean {
      if (registry.isPosting(cartId)) return false;
      registry.retire(cartId);
      delete contents[cartId];
      open.delete(cartId);
      return true;
    },
    /** Whether the UI would render Clear/Close disabled for this cart. */
    controlsDisabled(cartId: string): boolean {
      return registry.isPosting(cartId);
    },
  };
}

describe("cart controls during an unresolved post", () => {
  it("blocks clear for an in-flight cart and keeps the identity intact", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee", "water");

    const identity = registry.beginAttempt("cart-a").id;
    expect(carts.controlsDisabled("cart-a")).toBe(true);

    expect(carts.clear("cart-a")).toBe(false);
    expect(registry.peek("cart-a")).toBe(identity);
    expect(carts.contents["cart-a"]).toEqual(["coffee", "water"]);
  });

  it("blocks close for an in-flight cart and keeps the identity intact", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");

    const identity = registry.beginAttempt("cart-a").id;

    expect(carts.close("cart-a")).toBe(false);
    expect(registry.peek("cart-a")).toBe(identity);
    expect(carts.open.has("cart-a")).toBe(true);
  });

  it("refuses to retire an in-flight identity even when called directly", () => {
    // Defence in depth: the rule lives in the registry, not only in the UI.
    const registry = createCheckoutRegistry(sequentialMint());
    const identity = registry.beginAttempt("cart-a").id;

    expect(registry.retire("cart-a")).toBe(false);
    expect(registry.peek("cart-a")).toBe(identity);
  });

  it("keeps the identity unchanged for the whole unresolved window", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");

    const identity = registry.beginAttempt("cart-a").id;
    carts.clear("cart-a");
    carts.close("cart-a");
    registry.retire("cart-a");

    expect(registry.peek("cart-a")).toBe(identity);
    // A retry during the window reuses it, which is what makes it safe.
    expect(registry.beginAttempt("cart-a")).toEqual({ id: identity, issued: false });
  });

  it("retires the identity normally once the post succeeds", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");

    registry.beginAttempt("cart-a");
    // What runPost does on success: settle, then clear.
    registry.settleAttempt("cart-a");
    expect(carts.clear("cart-a")).toBe(true);

    expect(registry.peek("cart-a")).toBeUndefined();
    expect(carts.contents["cart-a"]).toEqual([]);
    // The next customer in this cart is a new transaction.
    expect(registry.beginAttempt("cart-a").issued).toBe(true);
  });

  it("keeps the identity available for retry after a failure", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const identity = registry.beginAttempt("cart-a").id;

    // Definitive failure: settle the attempt but do NOT retire the identity.
    registry.settleAttempt("cart-a");

    expect(registry.peek("cart-a")).toBe(identity);
    expect(registry.beginAttempt("cart-a")).toEqual({ id: identity, issued: false });
  });

  it("clears normally once posting has settled", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");

    registry.beginAttempt("cart-a");
    registry.settleAttempt("cart-a");

    expect(carts.controlsDisabled("cart-a")).toBe(false);
    expect(carts.clear("cart-a")).toBe(true);
    expect(registry.peek("cart-a")).toBeUndefined();
  });

  it("closes normally once posting has settled", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");

    registry.beginAttempt("cart-a");
    registry.settleAttempt("cart-a");

    expect(carts.close("cart-a")).toBe(true);
    expect(registry.peek("cart-a")).toBeUndefined();
    expect(carts.open.has("cart-a")).toBe(false);
  });

  it("leaves other carts fully usable while one is posting", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");
    carts.add("cart-b", "water");

    const aIdentity = registry.beginAttempt("cart-a").id;
    const bIdentity = registry.idFor("cart-b").id;

    expect(carts.controlsDisabled("cart-b")).toBe(false);
    expect(carts.clear("cart-b")).toBe(true);
    expect(registry.peek("cart-b")).toBeUndefined();
    expect(carts.close("cart-b")).toBe(true);

    // Cart A is untouched by any of it.
    expect(registry.peek("cart-a")).toBe(aIdentity);
    expect(aIdentity).not.toBe(bIdentity);
    expect(carts.contents["cart-a"]).toEqual(["coffee"]);
    expect(carts.controlsDisabled("cart-a")).toBe(true);
  });

  it("settleAttempt is idempotent, so a finally block is safe", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    registry.beginAttempt("cart-a");

    registry.settleAttempt("cart-a");
    registry.settleAttempt("cart-a");
    registry.settleAttempt("never-posted");

    expect(registry.isPosting("cart-a")).toBe(false);
  });

  it("a cart that never posted is not in flight", () => {
    const registry = createCheckoutRegistry(sequentialMint());
    registry.idFor("cart-a"); // identity minted, but no attempt opened

    expect(registry.isPosting("cart-a")).toBe(false);
    expect(registry.retire("cart-a")).toBe(true);
  });

  it("survives the lost-response scenario end to end", () => {
    // 1. cashier posts, 2. backend commits, 3. response never arrives,
    // 4. cashier hits Clear, 5. cashier retries.
    const registry = createCheckoutRegistry(sequentialMint());
    const carts = cartControls(registry);
    carts.add("cart-a", "coffee");

    const firstAttempt = registry.beginAttempt("cart-a").id;
    carts.clear("cart-a"); // blocked — the attempt is unresolved
    const retryAttempt = registry.beginAttempt("cart-a").id;

    expect(retryAttempt).toBe(firstAttempt);
    // Same identity on the wire ⇒ the backend recognises the retry and hands
    // back the sale it already committed instead of posting a second one.
  });
});
