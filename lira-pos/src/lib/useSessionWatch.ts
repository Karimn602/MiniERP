import { useEffect, useRef } from "react";
import * as auth from "../lib/auth";
import { useSession } from "../state/session";

/** Tell the backend somebody is still here, at most this often. */
const TOUCH_THROTTLE_MS = 30_000;

/** How often to ask the backend whether the session has locked itself. */
const POLL_MS = 15_000;

/**
 * Keep the renderer's view of the session in step with Rust's, and tell Rust
 * when the operator is active.
 *
 * TWO JOBS, AND NEITHER IS A SECURITY CONTROL.
 *
 * **Touching.** Real interaction defers the idle lock. This is throttled hard
 * (once every 30 s) because it runs on pointer and key events and a till during
 * service generates thousands of them. It is a courtesy to the backend, not a
 * boundary: the limit is enforced in Rust on a monotonic `Instant`, so a
 * renderer that never touched would simply lock on time, and one that touched
 * in a loop still re-locks the moment the Rust clock says so — `ensure_signed_in`
 * re-evaluates on every gate consultation.
 *
 * **Polling.** The lock has to APPEAR without the operator doing anything,
 * which means somebody has to ask. Fifteen seconds is chosen so a till left
 * unattended shows the lock screen within a quarter of a minute of the limit
 * expiring, at a cost of four cheap IPC calls a minute. This is also what makes
 * a session change in Rust — a lock, a logout, an expiry — reach the UI.
 *
 * Both stop when there is no session to watch, so a login screen is not
 * polling.
 */
export function useSessionWatch() {
  const status = useSession((s) => s.status);
  const adopt = useSession((s) => s.adopt);
  const refresh = useSession((s) => s.refresh);

  const hasSession = Boolean(status?.session);
  const locked = Boolean(status?.session?.locked);
  const lastTouch = useRef(0);

  // --- activity -> auth_touch ---------------------------------------------
  useEffect(() => {
    // Nothing to defer while locked or signed out, and touching a locked
    // session is refused by the backend anyway.
    if (!hasSession || locked) return;

    let cancelled = false;

    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouch.current < TOUCH_THROTTLE_MS) return;
      lastTouch.current = now;
      // Deliberately unawaited and deliberately silent on failure: the only
      // reasons this rejects are "no session" and "locked", both of which the
      // poll below will discover and act on properly. Surfacing it here would
      // put an error on screen for a keystroke.
      auth.touch().catch(() => {
        if (!cancelled) void refresh();
      });
    };

    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    for (const event of events) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      cancelled = true;
      for (const event of events) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [hasSession, locked, refresh]);

  // --- lock the SCREEN the moment the session locks -----------------------
  //
  // The poll below is a backstop, and on its own it is not good enough: at a
  // fifteen-second interval a till left unattended would keep SHOWING the
  // previous operator's screen for up to fifteen seconds after the idle limit
  // expired. No command would answer in that window — the Rust gate refuses
  // the moment its own clock says so — but product names, takings and customer
  // history would still be on the glass, which is the thing the lock exists to
  // cover.
  //
  // So the exact moment is scheduled instead. `auth_status` returns
  // `idleSecondsRemaining`, computed by Rust from the same monotonic clock the
  // gate uses, so the renderer knows precisely when to ask again. The authority
  // stays in Rust: this is a timer that triggers a QUESTION, not one that
  // decides the answer, and if it never fired the poll would still catch it.
  const idleSecondsRemaining = status?.session?.idleSecondsRemaining ?? null;
  useEffect(() => {
    if (!hasSession || locked || idleSecondsRemaining === null) return;

    let cancelled = false;
    // One second past the limit, so the backend has certainly crossed it by the
    // time we ask. Clamped so a clock oddity cannot schedule a tight loop.
    const delay = Math.max(1, Math.min(idleSecondsRemaining + 1, 3600)) * 1000;
    const timer = window.setTimeout(() => {
      auth
        .status()
        .then((next) => {
          if (!cancelled) adopt(next);
        })
        .catch(() => {
          if (!cancelled) void refresh();
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasSession, locked, idleSecondsRemaining, adopt, refresh]);

  // --- poll as a backstop -------------------------------------------------
  useEffect(() => {
    if (!hasSession) return;

    let cancelled = false;
    const timer = window.setInterval(() => {
      // `status()` rather than `refresh()`: refresh clears the cached status to
      // a loading state on every call, which would flicker the whole
      // application four times a minute. This adopts the answer instead, and
      // only when it is still wanted.
      auth
        .status()
        .then((next) => {
          if (!cancelled) adopt(next);
        })
        .catch(() => {
          // The database or the session has gone. `refresh` records the
          // message so the boot screen can show it.
          if (!cancelled) void refresh();
        });
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasSession, adopt, refresh]);
}
