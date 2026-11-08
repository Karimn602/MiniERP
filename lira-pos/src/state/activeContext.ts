import { create } from "zustand";

/**
 * Active context — the "who/where" of the running session.
 *
 * WHAT CHANGED IN GATE 2B STAGE A.1, AND WHY IT MATTERED
 *
 * This module used to decide who was using the application, with two queries at
 * boot. The second one was the entire identity model:
 *
 * ```sql
 *     SELECT id FROM users
 *      WHERE store_id = ? AND active = 1
 *      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC
 *      LIMIT 1
 * ```
 *
 * So the application always ran as the oldest active owner. It took no input,
 * could not be changed from the UI, and every actor on every posted document —
 * `sales.cashier_user_id`, `shifts.opened_by_user_id`,
 * `inventory_movements.created_by_user_id`, all eight columns — was that one
 * seeded row, asserted by the caller. On a shop with two owner rows the
 * application simply picked one.
 *
 * **BOTH QUERIES ARE GONE.** The identity now comes from the authenticated
 * session that Rust holds (`state/session.ts`, backed by `auth_status`), and
 * this store is hydrated FROM it rather than from the database. That is what
 * removes the automatic owner selection: there is no longer any code anywhere
 * that chooses a user.
 *
 * It also had to change for a second, duller reason: those two queries were
 * `db_select` calls, and `db_select` now requires a session. They ran before
 * login, so they would be refused.
 *
 * WHAT THIS STORE IS NOW: a convenience read of `storeId` and `userId` for the
 * ~15 screens that pass them into command payloads. It is NOT an authority.
 * From Stage B the backend resolves the actor from the session itself and treats
 * a payload's `cashierUserId` / `createdByUserId` as a cross-check to be
 * refused on mismatch — the same pattern this codebase already applies to
 * `quantity_base` and `factor_*_snapshot`. Until then these values are what the
 * payloads carry, and the honest description of them is "the signed-in user's
 * id", which is a great deal better than "whichever owner sorted first".
 */

interface ActiveContextState {
  storeId: string | null;
  userId: string | null;
  deviceId: string | null;
  hydrated: boolean;
  _set: (s: Partial<Omit<ActiveContextState, "_set">>) => void;
}

export const useActiveContext = create<ActiveContextState>((set) => ({
  storeId: null,
  userId: null,
  deviceId: null,
  hydrated: false,
  _set: (s) => set(s),
}));

/**
 * Adopt the authenticated session as the active context.
 *
 * Called by `App.tsx` once a session exists, and again whenever it changes, so
 * a user switch cannot leave the previous person's id in the payloads. There is
 * no database access here at all — which is the point.
 */
export function adoptSessionContext(args: {
  storeId: string;
  userId: string;
}): void {
  useActiveContext.getState()._set({
    storeId: args.storeId,
    userId: args.userId,
    // Phase 6 will create and persist a `devices` row. Until then this is NULL
    // in the schema too, and inventing an id here would put an unverifiable
    // value on every posted document.
    deviceId: null,
    hydrated: true,
  });
}

/** Clear it on sign-out, so nothing is left pointing at the previous user. */
export function clearActiveContext(): void {
  useActiveContext.getState()._set({
    storeId: null,
    userId: null,
    deviceId: null,
    hydrated: false,
  });
}

/** Helper that guarantees a non-null storeId. Throws if called pre-hydration. */
export function useStoreId(): string {
  const { storeId, hydrated } = useActiveContext();
  if (!hydrated || !storeId) {
    throw new Error("useStoreId called before context hydration");
  }
  return storeId;
}
