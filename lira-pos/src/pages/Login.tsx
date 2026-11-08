import { useEffect, useRef, useState } from "react";
import { AuthShell } from "../components/AuthShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import * as auth from "../lib/auth";
import { useSession } from "../state/session";
import { useTranslation } from "../lib/i18n";

/**
 * The sign-in screen — Gate 2B, Stage A.1.
 *
 * Two decisions worth stating.
 *
 * **The accounts are LISTED, including the ones that cannot sign in.** Naming
 * the staff is a deliberate disclosure: a login screen that cannot name its
 * accounts is one nobody can use, and the names are on the rota by the door
 * anyway. The alternative — a free-text username box — is worse at a till,
 * where the cashier is holding a tray. Accounts that cannot be used in this
 * build are shown and MARKED, because hiding a cashier's own name from them
 * leaves them no way to find out why the till will not let them in.
 *
 * **The refusal is the backend's own sentence.** `auth_login` returns text
 * written for the person at the counter — the same sentence for a wrong account
 * and a wrong passphrase, so the screen is not an account oracle — and this
 * shows it verbatim rather than translating it into something vaguer.
 */
export default function Login({ onRecover }: { onRecover: () => void }) {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const adopt = useSession((s) => s.adopt);

  const candidates = status ? auth.signInCandidates(status) : [];
  const firstUsable = candidates.find((a) => a.canSignIn) ?? candidates[0];

  const [userId, setUserId] = useState(firstUsable?.userId ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secretRef = useRef<HTMLInputElement>(null);

  // Pick up the default once the accounts arrive, without stamping on a choice
  // the operator has already made.
  useEffect(() => {
    if (!userId && firstUsable) setUserId(firstUsable.userId);
  }, [firstUsable, userId]);

  useEffect(() => {
    secretRef.current?.focus();
  }, []);

  const selected = candidates.find((a) => a.userId === userId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const next = await auth.login({ userId, secret });
      // Clear the typed secret from React state the moment it is no longer
      // needed. This is hygiene, not a security boundary — the string has
      // already been through the IPC layer and JavaScript makes no promises
      // about when a copy is collected — but leaving it in a live component is
      // gratuitous.
      setSecret("");
      adopt(next);
    } catch (err) {
      setError(auth.authErrorMessage(err));
      setSecret("");
      secretRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t("auth.signInTitle")}
      subtitle={status?.storeName}
      footer={
        <>
          {t("auth.windowsAccountNote")}
          <br />
          <button
            type="button"
            onClick={onRecover}
            className="mt-2 underline underline-offset-2 hover:text-fg"
          >
            {t("auth.forgotPassphrase")}
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm font-semibold text-fg">{t("auth.whoAreYou")}</div>
          <div className="space-y-1.5">
            {candidates.map((account) => (
              <label
                key={account.userId}
                className={
                  "flex cursor-pointer items-center gap-3 rounded-chip border px-3 py-2 text-sm transition-colors " +
                  (account.userId === userId
                    ? "border-brand bg-paper"
                    : "border-line hover:bg-paper") +
                  (account.canSignIn ? "" : " opacity-60")
                }
              >
                <input
                  type="radio"
                  name="account"
                  value={account.userId}
                  checked={account.userId === userId}
                  onChange={() => {
                    setUserId(account.userId);
                    setError(null);
                  }}
                  className="accent-brand"
                />
                <span className="flex-1 font-medium">{account.fullName}</span>
                <span className="text-xs uppercase tracking-wide text-fg-muted">
                  {t(`auth.role.${account.role}`)}
                </span>
              </label>
            ))}
          </div>

          {/* Why a listed account cannot be used, said plainly rather than by
              a greyed-out row the operator has to interpret. */}
          {selected && !selected.canSignIn ? (
            <div className="rounded-chip border border-line bg-paper p-3 text-xs leading-relaxed text-fg-muted">
              {!selected.hasCredential
                ? t("auth.noCredentialYet")
                : t("auth.ownerOnlyStage")}
            </div>
          ) : null}
        </div>

        <Input
          ref={secretRef}
          type="password"
          label={t("auth.passphrase")}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="current-password"
          disabled={busy || !selected?.canSignIn}
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
          disabled={busy || !secret || !selected?.canSignIn}
        >
          {busy ? t("auth.signingIn") : t("auth.signIn")}
        </Button>
      </form>
    </AuthShell>
  );
}
