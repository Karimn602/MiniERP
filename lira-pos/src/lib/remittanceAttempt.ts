/**
 * A driver remittance ATTEMPT — the frozen request, its identity, its outcome.
 *
 * Pure: no React, no database, no `invoke`. The drivers screen owns the
 * effects; this module owns the decisions, so they can be tested without a
 * desktop. Deliberately shaped like `lib/postAttempt.ts`, because it is the
 * same problem with the same stakes.
 *
 * ## Why a remittance needs this at all now
 *
 * Until WP-7 a remittance moved a driver's balance and nothing else, and the
 * drivers screen minted a fresh `ledgerEntryId` on every submit. That was
 * already wrong and is now dangerous: since migration 016 a remittance
 * INCREASES THE EXPECTED CASH IN THE DRAWER. So a lost answer — a killed
 * window, a timeout, a cashier pressing the button twice — could post the same
 * hand-over under two identities, and the till would expect twice the money
 * that actually arrived. The shift would come up short by exactly the amount
 * the driver handed in once, and no count could explain it.
 *
 * `post_driver_remittance` is idempotent on `ledger_entry_id` and refuses a
 * replay whose content differs. That contract is the only thing standing
 * between a lost response and a double credit, and it is only usable if the
 * client can RE-SEND WHAT IT SENT. So the identity is minted once, frozen with
 * the complete request, persisted before the command is invoked, and reused by
 * every retry.
 *
 * ## Durability — what is actually guaranteed
 *
 * The attempt is written to `localStorage` and READ BACK before anything is
 * invoked (`lib/cartStore.ts` explains why a read-back rather than a bare
 * `setItem`). As there, that is not fsync and is not claimed to be: what is
 * promised is that the attempt is in the store before the request is on the
 * wire.
 *
 * Unlike the register's carts, nothing else writes this key — there is no
 * mirroring effect over it — so it needs no barrier. The only writers are
 * "open an attempt" and "resolve one", both deliberate.
 *
 * If the record is lost along with the answer, the balance itself is the
 * backstop: a remittance that posted shows in the driver's ledger and in the
 * shift's cash, and the screen reads both from the database.
 */

/** The complete request, exactly as `driversRepo.postRemittance` takes it. */
export interface FrozenRemittanceRequest {
  ledgerEntryId: string;
  storeId: string;
  driverId: string;
  entryType: "remittance" | "adjustment";
  entryDate: string;
  notes?: string | null;
  receivedCurrency?: "USD" | "LBP" | null;
  receivedNativeUsdCents?: number;
  receivedNativeLbp?: number;
  exchangeRateId?: string | null;
  exchangeRateLbpPerUsd?: number | null;
  direction?: "increase" | "decrease" | null;
  amountMagnitudeCents?: number;
  reference?: string | null;
  shiftId?: string | null;
  createdByUserId?: string | null;
  deviceId?: string | null;
}

/**
 * Where a remittance stands.
 *
 * Only these two are ever persisted. The other outcomes are terminal: a posted
 * remittance clears the attempt, and a refused one hands the form back.
 */
export type RemittanceAttemptState = "posting" | "unknown";

export interface RemittanceAttempt {
  /** The `ledgerEntryId` sent to the backend. Minted once, reused by retries. */
  entryId: string;
  /** The driver it belongs to, for the screen. */
  driverId: string;
  /** The request as first built. A retry replays THIS, never current state. */
  request: FrozenRemittanceRequest;
  /** ISO timestamp of the first attempt, for the operator-facing message. */
  startedAt: string;
  state: RemittanceAttemptState;
  /** Why the outcome is unknown, when it is. */
  message?: string;
}

export function beginRemittanceAttempt(
  request: FrozenRemittanceRequest,
  now: string,
): RemittanceAttempt {
  return {
    entryId: request.ledgerEntryId,
    driverId: request.driverId,
    request,
    startedAt: now,
    state: "posting",
  };
}

export function remittanceToUnknown(
  attempt: RemittanceAttempt,
  message: string,
): RemittanceAttempt {
  return { ...attempt, state: "unknown", message };
}

/**
 * Normalise an attempt recovered from storage.
 *
 * A persisted `posting` means the process went away while a request was on the
 * wire, which IS an unknown outcome — so it is promoted on the way in and the
 * operator is never shown a spinner for a request that no longer exists.
 */
export function remittanceOnRestore(
  attempt: RemittanceAttempt,
  message: string,
): RemittanceAttempt {
  return attempt.state === "posting" ? remittanceToUnknown(attempt, message) : attempt;
}

/**
 * Is this value a usable attempt?
 *
 * Storage is not a trusted input: the record can be hand-edited, truncated, or
 * written by an older build. An attempt that cannot be replayed canonically
 * must not masquerade as one — replaying a partial request would either be
 * refused as a conflict or, worse, post something nobody authorised.
 */
export function isUsableRemittanceAttempt(value: unknown): value is RemittanceAttempt {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<RemittanceAttempt>;
  if (typeof a.entryId !== "string" || a.entryId.length === 0) return false;
  if (typeof a.driverId !== "string" || a.driverId.length === 0) return false;
  if (a.state !== "posting" && a.state !== "unknown") return false;
  const r = a.request as FrozenRemittanceRequest | undefined;
  if (typeof r !== "object" || r === null) return false;
  if (r.ledgerEntryId !== a.entryId) return false;
  if (r.driverId !== a.driverId) return false;
  if (typeof r.storeId !== "string" || r.storeId.length === 0) return false;
  if (r.entryType !== "remittance" && r.entryType !== "adjustment") return false;
  if (typeof r.entryDate !== "string" || r.entryDate.length === 0) return false;
  // A remittance must carry the cash that arrived; an adjustment must not.
  if (r.entryType === "remittance") {
    if (r.receivedCurrency !== "USD" && r.receivedCurrency !== "LBP") return false;
    const usd = r.receivedNativeUsdCents ?? 0;
    const lbp = r.receivedNativeLbp ?? 0;
    const usdOk = usd > 0 && lbp === 0 && r.receivedCurrency === "USD";
    const lbpOk = lbp > 0 && usd === 0 && r.receivedCurrency === "LBP";
    if (!usdOk && !lbpOk) return false;
    if (typeof r.shiftId !== "string" || r.shiftId.length === 0) return false;
  } else {
    if ((r.amountMagnitudeCents ?? 0) <= 0) return false;
    if (r.direction !== "increase" && r.direction !== "decrease") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type RemittanceFailure =
  /** The backend reached a verdict and wrote nothing. Safe to re-enter. */
  | { kind: "rejected"; message: string }
  /** No verdict reached us. The entry may exist; reconcile on the identity. */
  | { kind: "unknown"; message: string };

/**
 * Decide whether a failed remittance proves nothing was written.
 *
 * `post_driver_remittance` returns a plain `String` error rather than the typed
 * refusal envelope `post_sale` uses, so there is no shape to key on — and
 * matching on message text is exactly what `classifyPostFailure` refuses to do,
 * because a reworded or translated error would silently move an outcome from
 * unknown to proven.
 *
 * So EVERYTHING is unknown, and the safe answer is the uncertain one. The cost
 * is that a plainly-refused remittance also asks to be reconciled; the probe is
 * a read, it is one click, and it answers definitively. The alternative — a
 * guess that the money did not move — is how a drawer ends up short.
 */
export function classifyRemittanceFailure(err: unknown): RemittanceFailure {
  return { kind: "unknown", message: remittanceFailureMessage(err) };
}

export function remittanceFailureMessage(err: unknown): string {
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

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * The verdict of probing the database for a remittance identity.
 *
 * No write is needed: the entry either exists under that id or it does not.
 * `post_driver_remittance` consumes the identity on exactly one commit, so
 * finding a row proves it posted and finding none proves it had not, as of the
 * read.
 */
export type RemittanceVerdict =
  | { kind: "posted" }
  | { kind: "notPosted" }
  | { kind: "indeterminate"; message: string };

export function remittanceVerdictFromProbe(found: boolean): RemittanceVerdict {
  return found ? { kind: "posted" } : { kind: "notPosted" };
}
