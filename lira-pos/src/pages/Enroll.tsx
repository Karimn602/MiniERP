import { useEffect, useState } from "react";
import { AuthShell } from "../components/AuthShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import * as auth from "../lib/auth";
import { useSession } from "../state/session";
import { useTranslation } from "../lib/i18n";

/**
 * FIRST-RUN OWNER ENROLLMENT — Gate 2B, Stage A.1.
 *
 * This screen is the installation ceremony's user interface, and it has three
 * jobs that are easy to get wrong.
 *
 * **It must not let ownership be taken by accident.** The one-time code is in a
 * file the backend wrote; this screen names the file and asks for the code, so
 * creating the owner is a deliberate act by somebody who went and looked. On a
 * single shared Windows account that is NOT a defence against a determined
 * member of staff — they can read the file too — and the footer says so rather
 * than implying otherwise. What it prevents is the cashier who opens the
 * upgraded build first at eight in the morning becoming the owner by pressing
 * Next.
 *
 * **It must make the operator CHOOSE the owner row.** On a shop that has been
 * trading, there may be more than one. The old `activeContext.ts` picked
 * "whichever owner sorts first" with an `ORDER BY ... LIMIT 1`; this screen
 * lists them and selects nothing by default when there is a choice.
 *
 * **It must make the recovery code impossible to skip past.** It is shown once
 * and is the only supported way back from a forgotten passphrase, so the screen
 * will not continue until the operator has ticked that they have written it
 * down. That tick is not proof of anything — it is a speed bump in front of the
 * one irreversible moment in the flow.
 */
export default function Enroll() {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const adopt = useSession((s) => s.adopt);

  const candidates = status ? auth.enrollmentCandidates(status) : [];
  const onlyOne = candidates.length === 1 ? candidates[0] : undefined;

  const [userId, setUserId] = useState(onlyOne?.userId ?? "");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The one-time result, held only until the operator confirms they have it.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [wroteItDown, setWroteItDown] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<auth.AuthStatus | null>(null);

  useEffect(() => {
    if (!userId && onlyOne) setUserId(onlyOne.userId);
  }, [onlyOne, userId]);

  const legacy = status?.enrollmentState === "legacy_pending";
  const mismatch = confirm.length > 0 && confirm !== passphrase;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (passphrase !== confirm) {
      setError(t("auth.passphrasesDoNotMatch"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await auth.enrollOwner({
        enrollmentCode: code,
        userId,
        passphrase,
      });
      // Hold the status back until the recovery code has been acknowledged —
      // adopting it now would re-render the app into the till and take the
      // code off the screen for ever.
      setRecoveryCode(result.recoveryCode);
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

  // ---- The one-time recovery code -----------------------------------------
  if (recoveryCode && pendingStatus) {
    return (
      <AuthShell
        title={t("auth.recoveryCodeTitle")}
        subtitle={t("auth.recoveryCodeSubtitle")}
      >
        <div className="space-y-4">
          <div className="rounded-chip border border-brand bg-paper p-4 text-center">
            <code className="select-all break-all font-mono text-lg font-bold tracking-wider text-fg">
              {recoveryCode}
            </code>
          </div>

          <ul className="list-inside list-disc space-y-1.5 text-sm leading-relaxed text-fg-muted">
            <li>{t("auth.recoveryShownOnce")}</li>
            <li>{t("auth.recoveryKeepOffMachine")}</li>
            <li>{t("auth.recoveryOnlyRouteBack")}</li>
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
            onClick={() => adopt(pendingStatus)}
          >
            {t("auth.continueToTill")}
          </Button>
        </div>
      </AuthShell>
    );
  }

  // ---- The enrollment form ------------------------------------------------
  return (
    <AuthShell
      title={legacy ? t("auth.enrollLegacyTitle") : t("auth.enrollTitle")}
      subtitle={status?.storeName}
      footer={t("auth.windowsAccountNote")}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-chip border border-line bg-paper p-3 text-xs leading-relaxed text-fg-muted">
          {legacy ? t("auth.enrollLegacyExplainer") : t("auth.enrollExplainer")}
          {status?.enrollmentCodeFile ? (
            <>
              <div className="mt-2 font-semibold text-fg">
                {t("auth.codeFileLabel")}
              </div>
              <code className="select-all break-all font-mono text-[11px]">
                {status.enrollmentCodeFile}
              </code>
            </>
          ) : null}
        </div>

        {status?.enrollmentLocked ? (
          <div className="rounded-chip border border-danger-line bg-danger-bg p-3 text-xs text-danger-fg">
            {t("auth.enrollmentLockedOut")}
          </div>
        ) : null}

        <Input
          label={t("auth.enrollmentCode")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          disabled={busy}
        />

        {/* With exactly one candidate the choice is made and stating it is
            enough. With several, nothing is preselected: that is the automatic
            selection this stage exists to remove. */}
        {candidates.length === 1 ? (
          <div className="rounded-chip border border-line bg-paper px-3 py-2 text-sm">
            <span className="text-fg-muted">{t("auth.ownerAccount")}: </span>
            <span className="font-medium">{candidates[0].fullName}</span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-semibold text-fg">
              {t("auth.whichOwner")}
            </div>
            <div className="rounded-chip border border-line bg-paper p-3 text-xs text-fg-muted">
              {t("auth.whichOwnerExplainer")}
            </div>
            <div className="space-y-1.5">
              {candidates.map((account) => (
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
                    name="owner"
                    value={account.userId}
                    checked={account.userId === userId}
                    onChange={() => setUserId(account.userId)}
                    className="accent-brand"
                  />
                  <span className="flex-1 font-medium">{account.fullName}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {candidates.length === 0 ? (
          <div className="rounded-chip border border-danger-line bg-danger-bg p-3 text-xs text-danger-fg">
            {t("auth.noOwnerCandidates")}
          </div>
        ) : null}

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

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={
            busy ||
            !code ||
            !userId ||
            !passphrase ||
            passphrase !== confirm ||
            candidates.length === 0
          }
        >
          {busy ? t("auth.creatingOwner") : t("auth.createOwner")}
        </Button>
      </form>
    </AuthShell>
  );
}
