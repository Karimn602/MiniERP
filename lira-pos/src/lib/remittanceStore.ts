/**
 * The pending-remittance record: a verified write, before any money moves.
 *
 * Same contract as `lib/cartStore.ts::persistCarts` — write synchronously,
 * read back, compare, and return a verdict the caller must look at — applied
 * to the one other command in the application that now moves drawer cash.
 *
 * It is a separate key and a separate function rather than a reuse of
 * `persistCarts` because the two records validate differently: a cart's
 * attempt is a frozen SALE and `isUsableAttempt` checks a sale's fields. A
 * remittance has its own shape and its own rules (a remittance must name the
 * shift its cash landed in; an adjustment must not pretend to be cash), and
 * sharing one validator would mean neither record was really checked.
 *
 * No barrier is needed here, unlike the carts: nothing mirrors React state
 * into this key, so the only writers are "open an attempt" and "resolve one",
 * both deliberate acts of the drivers screen.
 */

import {
  isUsableRemittanceAttempt,
  type RemittanceAttempt,
} from "./remittanceAttempt";

export const PENDING_REMITTANCES_KEY = "lira_pos_pending_remittances";

/** The slice of `localStorage` this module uses. Injectable, so it is testable. */
export interface RemittanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RemittancePersistFailure =
  | "unavailable"
  | "serialize"
  | "write"
  | "readback";

export type RemittancePersistVerdict =
  | { ok: true }
  | { ok: false; reason: RemittancePersistFailure; message: string };

/** `localStorage`, or null where it cannot be reached. Never throws. */
export function browserRemittanceStorage(): RemittanceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the pending attempts, dropping anything unusable.
 *
 * A record that fails `isUsableRemittanceAttempt` is discarded rather than
 * offered: it cannot be replayed canonically, and showing it would invite the
 * operator to re-send something nobody authorised. The money is not lost by
 * discarding it — a remittance that posted is in the driver's ledger and in
 * the shift's cash, which is where the screen reads the balance from anyway.
 */
export function loadPendingRemittances(
  storage: RemittanceStorage | null,
): RemittanceAttempt[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_REMITTANCES_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isUsableRemittanceAttempt);
}

/**
 * Write the pending attempts and PROVE they landed.
 *
 * `requireEntry` asserts the specific attempt the caller is about to stake a
 * cash movement on, by identity. The caller passes it when opening an attempt
 * and omits it when resolving one.
 */
export function persistPendingRemittances(
  storage: RemittanceStorage | null,
  attempts: readonly RemittanceAttempt[],
  options: { requireEntry?: string } = {},
): RemittancePersistVerdict {
  if (!storage) {
    return { ok: false, reason: "unavailable", message: "Local storage is not available." };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(attempts);
  } catch (e) {
    return {
      ok: false,
      reason: "serialize",
      message: `The remittance could not be serialised: ${describe(e)}`,
    };
  }

  try {
    storage.setItem(PENDING_REMITTANCES_KEY, serialized);
  } catch (e) {
    return {
      ok: false,
      reason: "write",
      message: `Local storage refused the write: ${describe(e)}`,
    };
  }

  let readBack: string | null;
  try {
    readBack = storage.getItem(PENDING_REMITTANCES_KEY);
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

  const entryId = options.requireEntry;
  if (entryId !== undefined) {
    const stored = loadPendingRemittances(storage);
    if (!stored.some((a) => a.entryId === entryId)) {
      return {
        ok: false,
        reason: "readback",
        message: "The remittance attempt is not in storage after writing it.",
      };
    }
  }

  return { ok: true };
}

/** Add or replace one attempt in a list, by identity. */
export function upsertAttempt(
  attempts: readonly RemittanceAttempt[],
  attempt: RemittanceAttempt,
): RemittanceAttempt[] {
  const without = attempts.filter((a) => a.entryId !== attempt.entryId);
  return [...without, attempt];
}

/** Drop one attempt from a list, by identity. */
export function removeAttempt(
  attempts: readonly RemittanceAttempt[],
  entryId: string,
): RemittanceAttempt[] {
  return attempts.filter((a) => a.entryId !== entryId);
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
