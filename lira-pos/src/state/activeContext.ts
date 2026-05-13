import { create } from "zustand";
import { query } from "../db/client";

/**
 * Active context — the "who/where" of the running session. Hydrated once
 * on app boot, then read freely via useActiveContext().
 *
 * Components READ from this store. They DO NOT mutate it; only
 * hydrateActiveContext() does.
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

export async function hydrateActiveContext(): Promise<void> {
  const settingsRows = await query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'active_store_id'`,
  );
  const storeId = settingsRows[0]?.value ?? null;
  if (!storeId) {
    throw new Error("No active_store_id in app_settings — schema corrupt");
  }

  const userRows = await query<{ id: string }>(
    `SELECT id FROM users
     WHERE store_id = ? AND active = 1
     ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC
     LIMIT 1`,
    [storeId],
  );
  const userId = userRows[0]?.id ?? null;

  useActiveContext.getState()._set({
    storeId,
    userId,
    deviceId: null, // Phase 6 will create/persist a device row
    hydrated: true,
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