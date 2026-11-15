/**
 * A REFUND (credit memo) ATTEMPT — the frozen request, its identity, its
 * outcome — and the verified localStorage record that holds it.
 *
 * Codex V1.1 P0. The return screen minted the credit-memo identity in a React
 * `useRef`, so it lived exactly as long as the modal. A refund could commit,
 * lose its answer (a killed window, a lock, a crash), and be submitted again
 * after a restart under a NEW identity — and for a partially returned sale the
 * backend's quantity and tender caps would still have room, so the customer was
 * paid twice. `post_credit_memo` is idempotent on `credit_memo_id`; that
 * contract only helps if the client can re-send WHAT IT SENT.
 *
 * So this is `lib/remittanceAttempt.ts` + `lib/remittanceStore.ts` again, for
 * the same problem with the same stakes:
 *
 *   * the COMPLETE request (memo id, line ids, refund-leg ids, quantities,
 *     restock flags, legs, shift, recorded cashier) is frozen once;
 *   * it is written to localStorage and READ BACK before `post_credit_memo` is
 *     invoked, and the invoke is refused if that cannot be proven;
 *   * every failure is UNKNOWN — the command returns a plain `String`, there is
 *     no refusal envelope to key on, and matching message text is what
 *     `classifyPostFailure` refuses to do;
 *   * an unknown attempt is resolved by a READ of `sales_credit_memos` by
 *     identity, never by a guess, and blocks a new return on that receipt
 *     until it is resolved;
 *   * a retry re-sends the frozen request byte for byte. No retry ever mints a
 *     new identity; only a deliberate NEW return does, and only once no attempt
 *     for the receipt is unresolved.
 *
 * Durability is what `lib/cartStore.ts` states: in the store before the request
 * is on the wire, not fsync. If the record is lost WITH the answer, the
 * backstop is the receipt itself — a posted memo shows in the receipt's return
 * history and reduces what remains returnable, both read from the database.
 *
 * The record holds no cost: it is the request, and the request has no cost in
 * it. Any role may see it, which is right — the next person at the till is the
 * one who has to resolve it.
 */
import type { PostCreditMemoInput } from "../db/repos/creditMemos";

export const PENDING_REFUNDS_KEY = "lira_pos_pending_refunds";

export type RefundAttemptState = "posting" | "unknown";

export interface RefundAttempt {
  /** The `creditMemoId` sent. Minted once; every retry reuses it. */
  memoId: string;
  storeId: string;
  saleId: string;
  /** For the operator: which receipt this refund was against. */
  receiptNumber: number;
  /** The total the operator was refunding, for the recovery message. */
  totalUsdCents: number;
  /** The request as first built. A retry replays THIS, never current state. */
  request: PostCreditMemoInput;
  startedAt: string;
  state: RefundAttemptState;
  message?: string;
}

export function beginRefundAttempt(
  request: PostCreditMemoInput,
  meta: { receiptNumber: number; totalUsdCents: number },
  now: string,
): RefundAttempt {
  return {
    memoId: request.creditMemoId,
    storeId: request.storeId,
    saleId: request.originalSaleId,
    receiptNumber: meta.receiptNumber,
    totalUsdCents: meta.totalUsdCents,
    request,
    startedAt: now,
    state: "posting",
  };
}

export function refundToUnknown(a: RefundAttempt, message: string): RefundAttempt {
  return { ...a, state: "unknown", message };
}

/**
 * Storage is not a trusted input. An attempt that cannot be replayed exactly
 * must not masquerade as one: a partial request would be refused as a
 * conflict, or post something nobody authorised.
 */
export function isUsableRefundAttempt(value: unknown): value is RefundAttempt {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<RefundAttempt>;
  const nonEmpty = (s: unknown) => typeof s === "string" && s.length > 0;
  if (!nonEmpty(a.memoId) || !nonEmpty(a.storeId) || !nonEmpty(a.saleId)) return false;
  if (a.state !== "posting" && a.state !== "unknown") return false;
  if (typeof a.receiptNumber !== "number" || typeof a.totalUsdCents !== "number") return false;
  const r = a.request as PostCreditMemoInput | undefined;
  if (typeof r !== "object" || r === null) return false;
  if (r.creditMemoId !== a.memoId || r.storeId !== a.storeId || r.originalSaleId !== a.saleId) {
    return false;
  }
  if (!nonEmpty(r.shiftId)) return false;
  if (!Array.isArray(r.lines) || r.lines.length === 0) return false;
  if (!Array.isArray(r.refunds) || r.refunds.length === 0) return false;
  if (!r.lines.every((l) => nonEmpty(l?.creditMemoLineId) && nonEmpty(l?.originalSaleItemId))) {
    return false;
  }
  if (!r.refunds.every((l) => nonEmpty(l?.refundId) && nonEmpty(l?.method))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// In flight in THIS process
// ---------------------------------------------------------------------------

/**
 * Identities whose request is on the wire right now, in this process. Module
 * level, so it survives the modal unmounting and remounting (navigating away
 * mid-post) but not a restart — after a restart nothing is in flight, and a
 * persisted `posting` is an unknown outcome. While an id is here, the screen
 * shows "still posting" and offers neither a resend nor a discard.
 */
const inFlight = new Set<string>();
export const refundInFlight = {
  has: (id: string) => inFlight.has(id),
  add: (id: string) => void inFlight.add(id),
  delete: (id: string) => void inFlight.delete(id),
  /** Tests only. */
  clear: () => inFlight.clear(),
};

// ---------------------------------------------------------------------------
// The verified store
// ---------------------------------------------------------------------------

export interface RefundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RefundPersistVerdict = { ok: true } | { ok: false; message: string };

export function browserRefundStorage(): RefundStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPendingRefunds(storage: RefundStorage | null): RefundAttempt[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_REFUNDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUsableRefundAttempt) : [];
  } catch {
    return [];
  }
}

/** Write, read back, and (optionally) prove one identity is in the record. */
export function persistPendingRefunds(
  storage: RefundStorage | null,
  attempts: readonly RefundAttempt[],
  options: { requireMemo?: string } = {},
): RefundPersistVerdict {
  if (!storage) return { ok: false, message: "Local storage is not available." };
  let serialized: string;
  try {
    serialized = JSON.stringify(attempts);
  } catch (e) {
    return { ok: false, message: `The refund could not be serialised: ${describe(e)}` };
  }
  try {
    storage.setItem(PENDING_REFUNDS_KEY, serialized);
  } catch (e) {
    return { ok: false, message: `Local storage refused the write: ${describe(e)}` };
  }
  let readBack: string | null;
  try {
    readBack = storage.getItem(PENDING_REFUNDS_KEY);
  } catch (e) {
    return { ok: false, message: `Local storage could not be read back: ${describe(e)}` };
  }
  if (readBack !== serialized) {
    return { ok: false, message: "Local storage did not keep what was written." };
  }
  if (
    options.requireMemo !== undefined &&
    !loadPendingRefunds(storage).some((a) => a.memoId === options.requireMemo)
  ) {
    return { ok: false, message: "The refund attempt is not in storage after writing it." };
  }
  return { ok: true };
}

export function upsertRefundAttempt(
  attempts: readonly RefundAttempt[],
  attempt: RefundAttempt,
): RefundAttempt[] {
  return [...attempts.filter((a) => a.memoId !== attempt.memoId), attempt];
}

export function withoutRefundAttempt(
  attempts: readonly RefundAttempt[],
  memoId: string,
): RefundAttempt[] {
  return attempts.filter((a) => a.memoId !== memoId);
}

/**
 * Remove one attempt from the record and PROVE it is gone (Codex V1.1 P3).
 * Callers must act on the verdict: if the removal did not stick, the attempt
 * is still on record and the screen must keep showing it, never report that
 * the cleanup happened. Failing this way is safe — a stale record only blocks
 * a new return on that receipt until "Check again" clears it.
 */
export function clearRefundAttempt(
  storage: RefundStorage | null,
  memoId: string,
): RefundPersistVerdict {
  const verdict = persistPendingRefunds(
    storage,
    withoutRefundAttempt(loadPendingRefunds(storage), memoId),
  );
  if (!verdict.ok) return verdict;
  if (loadPendingRefunds(storage).some((a) => a.memoId === memoId)) {
    return { ok: false, message: "The refund record is still in storage after removing it." };
  }
  return { ok: true };
}

/** The unresolved attempt for one receipt, if any. At most one is ever opened. */
export function pendingRefundForSale(
  attempts: readonly RefundAttempt[],
  storeId: string,
  saleId: string,
): RefundAttempt | null {
  return attempts.find((a) => a.storeId === storeId && a.saleId === saleId) ?? null;
}

export function refundFailureMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// The one way a refund is sent
// ---------------------------------------------------------------------------

export type RefundOutcome =
  /** `cleanupError`: it posted, but its record could not be removed. */
  | { kind: "posted"; creditMemoNumber: number; cleanupError?: string }
  /** No verdict reached us. The memo may exist; resolve by identity. */
  | { kind: "unknown"; message: string }
  /** The attempt could not be PROVEN persisted, so nothing was sent. */
  | { kind: "notSent"; message: string };

/**
 * Send (or re-send) a frozen attempt. Not React: it records its own outcome in
 * storage, so a modal that unmounted mid-post still has its result recorded.
 *
 * `fresh` attempts are written and proven BEFORE the invoke; a re-send of an
 * attempt already on record needs no new proof — its identity is committed and
 * a storage failure must not block the recovery.
 */
export async function sendRefundAttempt(
  storage: RefundStorage | null,
  attempt: RefundAttempt,
  invoke: (request: PostCreditMemoInput) => Promise<{ creditMemoNumber: number }>,
  options: { fresh: boolean },
): Promise<RefundOutcome> {
  const posting: RefundAttempt = { ...attempt, state: "posting", message: undefined };
  const verdict = persistPendingRefunds(
    storage,
    upsertRefundAttempt(loadPendingRefunds(storage), posting),
    options.fresh ? { requireMemo: attempt.memoId } : {},
  );
  if (options.fresh && !verdict.ok) {
    // Leave nothing half-recorded: the request was never sent.
    clearRefundAttempt(storage, attempt.memoId);
    return { kind: "notSent", message: verdict.message };
  }
  refundInFlight.add(attempt.memoId);
  try {
    const result = await invoke(attempt.request);
    const cleared = clearRefundAttempt(storage, attempt.memoId);
    return {
      kind: "posted",
      creditMemoNumber: result.creditMemoNumber,
      cleanupError: cleared.ok ? undefined : cleared.message,
    };
  } catch (err) {
    const message = refundFailureMessage(err);
    persistPendingRefunds(
      storage,
      upsertRefundAttempt(loadPendingRefunds(storage), refundToUnknown(attempt, message)),
    );
    return { kind: "unknown", message };
  } finally {
    refundInFlight.delete(attempt.memoId);
  }
}
