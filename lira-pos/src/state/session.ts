import { create } from "zustand";
import * as auth from "../lib/auth";

/**
 * The renderer's cache of the Rust-held session — Gate 2B, Stage A.1.
 *
 * THIS IS A CACHE, NOT AN AUTHORITY. Everything in it came from `auth_status`,
 * and nothing in it is trusted by the backend: the gates in
 * `posting::pool_for_state` and `read_api::read_pool_for_state` consult Rust's
 * own session, so a renderer that lied to itself about being signed in would
 * simply get refusals from every command it then called. The store exists so
 * the UI can draw the right screen, not so it can decide anything.
 *
 * It holds no credential, no token and nothing in `localStorage`.
 */

interface SessionState {
  status: auth.AuthStatus | null;
  /** The last error from a refresh, for the boot screen to show. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<auth.AuthStatus | null>;
  /** Adopt a status a command already returned, instead of asking again. */
  adopt: (status: auth.AuthStatus) => void;
}

export const useSession = create<SessionState>((set) => ({
  status: null,
  error: null,
  loading: true,

  refresh: async () => {
    set({ loading: true });
    try {
      const status = await auth.status();
      set({ status, error: null, loading: false });
      return status;
    } catch (e) {
      // A failure here is one of two very different things and the message
      // distinguishes them, because the backend wrote it that way: either the
      // DATABASE did not start (GZ-WAL-01's operator text, which needs a
      // support call) or something else went wrong. Either way the boot screen
      // shows the sentence rather than a generic one.
      set({ status: null, error: auth.authErrorMessage(e), loading: false });
      return null;
    }
  },

  adopt: (status) => set({ status, error: null, loading: false }),
}));

/** Convenience reads. Components use these rather than poking at `status`. */
export function useAuthScreen(): auth.AuthScreen | "loading" | "error" {
  const { status, loading, error } = useSession();
  if (error) return "error";
  if (loading || !status) return "loading";
  return auth.screenFor(status);
}

/**
 * The signed-in user, or null.
 *
 * Returns null while locked, deliberately: a locked session has a user but no
 * authority, and a component that wants "who may act" should get nothing.
 * `useSession().status?.session` is there for the lock screen, which needs the
 * name of whoever walked away.
 */
export function useActiveUser(): auth.SessionView | null {
  const session = useSession((s) => s.status?.session ?? null);
  if (!session || session.locked) return null;
  return session;
}
