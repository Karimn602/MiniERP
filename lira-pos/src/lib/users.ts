import { invoke } from "@tauri-apps/api/core";
import type { Role } from "./auth";

/**
 * STAFF ADMINISTRATION, from the renderer's side — Gate 2B, Stage B.3.
 *
 * `users` was a table nothing owned: migration 001 created it, seeded one
 * owner, and until this stage no command in the application wrote to it. So the
 * only way a shop acquired a second member of staff was somebody editing the
 * database file — the route this whole gate exists to make unnecessary.
 *
 * Four commands, all owner-only, all enforced in Rust (`src-tauri/src/users.rs`
 * authorizes at the boundary and again inside each writing transaction). The
 * screen this feeds decides what is OFFERED; it decides nothing.
 *
 * NOTHING HERE CARRIES A SECRET BACK. `StaffView` has a `hasCredential`
 * boolean and nothing else about the credential: no hash, no algorithm, no
 * failed-attempt count and no lockout time. The hash is unreadable to the
 * renderer by construction — `read_guard.rs` denies `users.pin_hash` to the
 * `db_select` channel at the SQLite authorizer, so there is no query that could
 * fetch it even if somebody wrote one.
 */

export interface StaffView {
  userId: string;
  fullName: string;
  role: Role;
  active: boolean;
  /** Whether a passphrase has been set. NOT the passphrase, and not its hash. */
  hasCredential: boolean;
  /** Set by a reset: they are told to change it once they are in. */
  mustChangeCredential: boolean;
  /** The signed-in owner's own row, which the screen treats differently. */
  isYou: boolean;
}

export function list(): Promise<StaffView[]> {
  return invoke<StaffView[]>("users_list");
}

/**
 * Create a member of staff, or change their name or role.
 *
 * `userId` is minted by the caller for a new person, exactly as every other
 * document identity in this application is. The STORE is not a parameter: the
 * backend takes it from the signed-in owner, so there is no field through which
 * one branch could administer another.
 */
export function save(args: {
  userId: string;
  fullName: string;
  role: Role;
}): Promise<string> {
  return invoke<string>("users_save", { args });
}

/**
 * Retire a member of staff, or bring them back.
 *
 * Deleting is not offered at all, by the backend or here. A `users` row is
 * referenced by every document that person ever touched, and `active = 0` is
 * how this schema has always said "not usable"; deleting one to tidy up would
 * be destroying the attribution on real financial records.
 */
export function setActive(args: {
  userId: string;
  isActive: boolean;
}): Promise<void> {
  return invoke<void>("users_set_active", { args });
}

/**
 * Set or reset somebody else's passphrase.
 *
 * Refused for the owner's OWN row: changing your own requires the current one
 * (`auth.changeCredential`), and allowing it here would turn "reset somebody
 * else's" into a way to skip that.
 */
export function setCredential(args: {
  userId: string;
  secret: string;
}): Promise<void> {
  return invoke<void>("users_set_credential", { args });
}

/** A fresh identity for a new member of staff. */
export function newUserId(): string {
  return crypto.randomUUID();
}
