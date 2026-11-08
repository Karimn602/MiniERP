import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import * as auth from "../lib/auth";
import { useSession } from "../state/session";
import { useTranslation } from "../lib/i18n";

/**
 * THE LOCK SCREEN, and it is an OVERLAY rather than a route.
 *
 * That is the whole design decision. A route would unmount the register, and
 * the register is holding a cart — possibly a cart with a frozen checkout
 * attempt in it, which is the one thing standing between a lost response and a
 * double charge. Locking must cost the cashier nothing but the time it takes to
 * type their passphrase, so the till stays mounted underneath and the overlay
 * sits on top of it.
 *
 * It follows that the lock is NOT a logout. The session, the cart, the open
 * shift and any in-flight attempt all survive, and only the same person can
 * lift it: `auth_unlock` verifies the locked user's own credential, not any
 * valid one, because accepting a colleague's passphrase would hand them
 * somebody else's session and put their name on the next receipt.
 *
 * Signing out from here IS offered, for the case where the person who locked it
 * has gone home. It destroys the session and therefore abandons the screen
 * state, so it is the secondary action and it says what it costs.
 */
export function LockScreen() {
  const { t } = useTranslation();
  const session = useSession((s) => s.status?.session ?? null);
  const storeName = useSession((s) => s.status?.storeName ?? "");
  const adopt = useSession((s) => s.adopt);

  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const next = await auth.unlock({ secret });
      setSecret("");
      adopt(next);
    } catch (err) {
      setError(auth.authErrorMessage(err));
      setSecret("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      adopt(await auth.logout());
    } catch (err) {
      setError(auth.authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // `fixed inset-0` over the live application, with a high z-index: the till
    // underneath is still mounted and still holds its cart.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("auth.lockedTitle")}
    >
      <div className="w-full max-w-md space-y-4 rounded-lg border border-line bg-surface p-6 shadow-soft">
        <div className="space-y-1 text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-fg-muted">
            Greaz POS
          </div>
          <h2 className="text-xl font-bold tracking-tight text-fg">
            {t("auth.lockedTitle")}
          </h2>
          <div className="text-sm text-fg-muted">
            {session ? session.fullName : storeName}
          </div>
        </div>

        <div className="rounded-chip border border-line bg-paper p-3 text-xs leading-relaxed text-fg-muted">
          {t("auth.lockedNothingLost")}
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Input
            ref={inputRef}
            type="password"
            label={t("auth.passphrase")}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />

          {error ? (
            <pre className="whitespace-pre-wrap rounded-chip border border-danger-line bg-danger-bg p-3 text-xs text-danger-fg">
              {error}
            </pre>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={busy || !secret}
          >
            {busy ? t("auth.unlocking") : t("auth.unlock")}
          </Button>
        </form>

        <div className="border-t border-line pt-3 text-center">
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="text-xs text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-50"
          >
            {t("auth.signOutInstead")}
          </button>
          <div className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            {t("auth.signOutLosesScreen")}
          </div>
        </div>
      </div>
    </div>
  );
}
