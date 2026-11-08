import { useState } from "react";
import { AuthShell } from "../components/AuthShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import * as auth from "../lib/auth";
import { useSession } from "../state/session";
import { useTranslation } from "../lib/i18n";

/**
 * OWNER RECOVERY — Gate 2B, Stage A.1.
 *
 * Reached from the login screen's "forgotten passphrase" link. It spends the
 * one-time recovery code, sets a new owner passphrase, and shows the
 * REPLACEMENT code — because a shop that used its only code and got nothing
 * back would be one forgotten passphrase away from needing a support engineer
 * with a database editor.
 *
 * It does NOT sign anybody in. Whoever just set the passphrase should prove it
 * on the login screen, which also confirms they typed it as they intended —
 * and a recovery that handed out a session would mean possession of the code
 * alone was enough to be the owner for the rest of the evening.
 *
 * The screen states the honest limit too: with no code, recovery needs somebody
 * who can edit the database file. Pretending otherwise would be the
 * `UNVERIFIED_APPROVAL_PREFIX` defect in a new place — a control that looks
 * stronger than it is.
 */
export default function Recover({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const adopt = useSession((s) => s.adopt);

  const owners = (status?.accounts ?? []).filter((a) => a.role === "owner");
  const [userId, setUserId] = useState(owners.length === 1 ? owners[0].userId : "");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [wroteItDown, setWroteItDown] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<auth.AuthStatus | null>(null);

  const mismatch = confirm.length > 0 && confirm !== passphrase;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await auth.recoverOwner({
        recoveryCode: code,
        userId,
        newPassphrase: passphrase,
      });
      setReplacement(result.recoveryCode);
      setPendingStatus(result.status);
      setCode("");
      setPassphrase("");
      setConfirm("");
    } catch (err) {
      setError(auth.authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (replacement && pendingStatus) {
    return (
      <AuthShell
        title={t("auth.newRecoveryCodeTitle")}
        subtitle={t("auth.newRecoveryCodeSubtitle")}
      >
        <div className="space-y-4">
          <div className="rounded-chip border border-brand bg-paper p-4 text-center">
            <code className="select-all break-all font-mono text-lg font-bold tracking-wider text-fg">
              {replacement}
            </code>
          </div>
          <ul className="list-inside list-disc space-y-1.5 text-sm leading-relaxed text-fg-muted">
            <li>{t("auth.recoveryShownOnce")}</li>
            <li>{t("auth.recoveryOldCodeDead")}</li>
            <li>{t("auth.recoveryKeepOffMachine")}</li>
          </ul>
          <label className="flex cursor-pointer items-start gap-2 rounded-chip border border-line bg-paper p-3 text-sm">
            <input
              type="checkbox"
              checked={wroteItDown}
              onChange={(e) => setWroteItDown(e.target.checked)}
              className="mt-0.5 accent-brand"
            />
            <span>{t("auth.recoveryWrittenDown")}</span>
          </label>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!wroteItDown}
            onClick={() => {
              adopt(pendingStatus);
              onCancel();
            }}
          >
            {t("auth.continueToSignIn")}
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("auth.recoverTitle")}
      subtitle={status?.storeName}
      footer={t("auth.recoverNoCodeNote")}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-chip border border-line bg-paper p-3 text-xs leading-relaxed text-fg-muted">
          {t("auth.recoverExplainer")}
        </div>

        <Input
          label={t("auth.recoveryCode")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          disabled={busy}
        />

        {owners.length === 1 ? (
          <div className="rounded-chip border border-line bg-paper px-3 py-2 text-sm">
            <span className="text-fg-muted">{t("auth.ownerAccount")}: </span>
            <span className="font-medium">{owners[0].fullName}</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="text-sm font-semibold text-fg">{t("auth.whichOwner")}</div>
            {owners.map((account) => (
              <label
                key={account.userId}
                className={
                  "flex cursor-pointer items-center gap-3 rounded-chip border px-3 py-2 text-sm " +
                  (account.userId === userId
                    ? "border-brand bg-paper"
                    : "border-line hover:bg-paper")
                }
              >
                <input
                  type="radio"
                  name="recover-owner"
                  value={account.userId}
                  checked={account.userId === userId}
                  onChange={() => setUserId(account.userId)}
                  className="accent-brand"
                />
                <span className="flex-1 font-medium">{account.fullName}</span>
              </label>
            ))}
          </div>
        )}

        <Input
          type="password"
          label={t("auth.chooseOwnerPassphrase")}
          hint={t("auth.passphraseHint")}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
        />
        <Input
          type="password"
          label={t("auth.confirmPassphrase")}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? t("auth.passphrasesDoNotMatch") : null}
          autoComplete="new-password"
          disabled={busy}
        />

        {error ? (
          <pre className="whitespace-pre-wrap rounded-chip border border-danger-line bg-danger-bg p-3 text-xs text-danger-fg">
            {error}
          </pre>
        ) : null}

        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            className="flex-1"
            disabled={busy || !code || !userId || !passphrase || passphrase !== confirm}
          >
            {busy ? t("auth.resetting") : t("auth.resetPassphrase")}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
