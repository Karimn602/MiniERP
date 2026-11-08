import { invoke } from "@tauri-apps/api/core";

/**
 * The renderer's view of authentication — Gate 2B, Stage A.1.
 *
 * WHAT IS AND IS NOT HERE, BECAUSE IT MATTERS
 *
 * There is NO TOKEN in this module, and there is nothing in `localStorage`.
 * The session lives in Rust process memory and the renderer holds no handle to
 * it: every call below simply asks the backend what the state is, or asks it to
 * change. Three consequences worth stating, because each one was a design
 * requirement rather than a convenience:
 *
 *   1. **`lib/postAttempt.ts` is untouched.** The frozen checkout request — the
 *      only thing between a lost response and a double charge — does not gain a
 *      field, so no replay, canonical comparison or recovery path has to learn
 *      to ignore one.
 *   2. **Nothing here is a security control.** The screens this module feeds
 *      decide what the operator SEES. What they may DO is decided in Rust, at
 *      `posting::pool_for_state` and `read_api::read_pool_for_state`, which
 *      refuse before a pool is even opened. If every function in this file were
 *      deleted, the backend would still refuse an unauthenticated till.
 *   3. **An F5 does not sign the operator out.** `status()` rediscovers the
 *      session the Rust side is still holding, and a LOCKED session comes back
 *      locked.
 *
 * Stage A.1 admits the OWNER only (`loginRestrictedToOwner`). Manager and
 * cashier rows exist and are real, but until Stage B enforces permissions a
 * staff login would be an account with owner powers and a different name on it.
 */

export type Role = "owner" | "manager" | "cashier";

export type EnrollmentState = "virgin" | "legacy_pending" | "initialized";

export interface SessionView {
  userId: string;
  fullName: string;
  storeId: string;
  role: Role;
  locked: boolean;
  mustChangeCredential: boolean;
  idleSecondsRemaining: number;
  openedSecondsAgo: number;
}

export interface AccountView {
  userId: string;
  fullName: string;
  role: Role;
  /** Whether this account can be signed into AT ALL in this build. */
  canSignIn: boolean;
  hasCredential: boolean;
}

export interface AuthStatus {
  schemaVersion: number;
  storeId: string;
  storeName: string;
  enrollmentState: EnrollmentState;
  /** Where the installer will find the one-time code. Never the code itself. */
  enrollmentCodeFile: string | null;
  enrollmentLocked: boolean;
  accounts: AccountView[];
  session: SessionView | null;
  sessionGeneration: number;
  loginRestrictedToOwner: boolean;
  idleLockSeconds: number;
}

export interface EnrollmentResult {
  status: AuthStatus;
  /** Shown ONCE. Stored only as a hash; it cannot be recovered afterwards. */
  recoveryCode: string;
}

/**
 * The only call that works before anybody has signed in, and the whole of the
 * pre-login boot.
 *
 * `App.tsx` used to call `ensureDbReady()` (a `db_select`) and then
 * `hydrateActiveContext()` (two more) before showing anything. All three are
 * now refused by the session gate, so this one command returns everything those
 * three needed — the schema version, the store, and the accounts — which is
 * what lets the read channel be gated with no allowlist of "harmless"
 * pre-login queries.
 */
export function status(): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_status");
}

/** Create the owner credential against the one-time enrollment code. */
export function enrollOwner(args: {
  enrollmentCode: string;
  userId: string;
  passphrase: string;
}): Promise<EnrollmentResult> {
  return invoke<EnrollmentResult>("auth_enroll_owner", args);
}

export function login(args: { userId: string; secret: string }): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_login", args);
}

export function logout(): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_logout");
}

/** Lock the screen. KEEPS the session, the cart and the open shift. */
export function lock(): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_lock");
}

/** Unlock. Only the locked user's own credential will do. */
export function unlock(args: { secret: string }): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_unlock", args);
}

/**
 * Defer the idle lock.
 *
 * NOT a security control: the limit is enforced in Rust on a monotonic clock,
 * and this only tells the backend that somebody is still there. A renderer that
 * never called it would simply lock on time; one that called it in a loop could
 * keep a session alive, which is why the backend ALSO re-locks on its own clock
 * whenever the gate is consulted.
 *
 * Resolves to the idle limit in seconds, or rejects when there is no live
 * session — which the caller treats as "stop asking", not as an error worth
 * showing.
 */
export function touch(): Promise<number> {
  return invoke<number>("auth_touch");
}

export function changeCredential(args: {
  current: string;
  next: string;
}): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_change_credential", args);
}

export function recoverOwner(args: {
  recoveryCode: string;
  userId: string;
  newPassphrase: string;
}): Promise<EnrollmentResult> {
  return invoke<EnrollmentResult>("auth_recover_owner", args);
}

/**
 * Where the boot should send the operator.
 *
 * Derived in one place so `App.tsx` does not grow a second, slightly different
 * opinion about it. The order is deliberate: a locked session is still a
 * session, so it outranks the login screen; and enrollment outranks everything,
 * because a shop with no owner credential has nobody who could sign in.
 */
export type AuthScreen = "enroll" | "login" | "locked" | "ready";

export function screenFor(status: AuthStatus): AuthScreen {
  if (status.enrollmentState !== "initialized") return "enroll";
  if (!status.session) return "login";
  if (status.session.locked) return "locked";
  return "ready";
}

/**
 * The accounts the login screen should offer, in the order it should offer
 * them.
 *
 * Accounts that cannot be signed into are still LISTED rather than hidden —
 * hiding a cashier's own name from them during Stage A.1 leaves them no way to
 * find out why the till will not let them in, which is the kind of silence that
 * turns into a support call. They are listed and marked.
 */
export function signInCandidates(status: AuthStatus): AccountView[] {
  return [...status.accounts].sort((a, b) => {
    if (a.canSignIn !== b.canSignIn) return a.canSignIn ? -1 : 1;
    return a.fullName.localeCompare(b.fullName);
  });
}

/** Owner rows that may be enrolled: active owners with no credential yet. */
export function enrollmentCandidates(status: AuthStatus): AccountView[] {
  return status.accounts.filter((a) => a.role === "owner" && !a.hasCredential);
}

/**
 * Turn whatever `invoke` rejected with into something worth putting on screen.
 *
 * Tauri rejects a command returning `Err(String)` with that string, so the
 * backend's own sentence is almost always the right thing to show — it was
 * written for the person at the till and it says what to do. This only covers
 * the case where something else went wrong.
 */
export function authErrorMessage(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return "Something went wrong talking to Greaz. Close it completely and open it again.";
}
