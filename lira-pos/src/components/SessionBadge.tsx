import { useState } from "react";
import * as auth from "../lib/auth";
import { useSession } from "../state/session";
import { useTranslation } from "../lib/i18n";

/**
 * Who is signed in, and the two things they can do about it — Gate 2B, Stage
 * A.1.
 *
 * It sits in the top application bar because that is where the operator already
 * looks for the appearance and network controls, and because a till that cannot
 * be locked without hunting through a settings drawer will not be locked.
 *
 * **Lock is the primary action and sign out is the quiet one.** Locking keeps
 * the basket, the open shift and any in-flight checkout attempt, so it costs
 * the cashier the time it takes to retype a passphrase. Signing out destroys
 * the session and therefore abandons the screen, so it says so and it is a
 * plain link rather than a button.
 *
 * Neither is a security control: the backend refuses an unauthenticated till at
 * `posting::pool_for_state` and `read_api::read_pool_for_state` whatever this
 * component does, and the idle lock is enforced in Rust on a monotonic clock
 * whether or not anybody presses this.
 */
export function SessionBadge() {
  const { t } = useTranslation();
  const session = useSession((s) => s.status?.session ?? null);
  const adopt = useSession((s) => s.adopt);
  const [busy, setBusy] = useState(false);

  if (!session) return null;

  async function run(action: () => Promise<auth.AuthStatus>) {
    if (busy) return;
    setBusy(true);
    try {
      adopt(await action());
    } catch {
      // Both of these are refused only when there is no live session to act
      // on, which the session poll will discover and act on properly. Putting
      // an error beside the clock would be noise.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="hidden text-right leading-tight sm:block">
        <div className="truncate text-xs font-semibold text-fg">
          {session.fullName}
        </div>
        <div className="font-eyebrow text-[9px] text-fg-subtle">
          {t(`auth.role.${session.role}`)}
        </div>
      </div>

      <button
        type="button"
        onClick={() => void run(auth.lock)}
        disabled={busy}
        title={t("auth.lockedNothingLost")}
        className="rounded-chip border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-fg shadow-soft transition-colors hover:bg-paper disabled:opacity-50"
      >
        {t("auth.lockNow")}
      </button>

      <button
        type="button"
        onClick={() => void run(auth.logout)}
        disabled={busy}
        title={t("auth.signOutLosesScreen")}
        className="text-[11px] text-fg-muted underline underline-offset-2 transition-colors hover:text-fg disabled:opacity-50"
      >
        {t("auth.signOut")}
      </button>
    </div>
  );
}
