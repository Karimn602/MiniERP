/**
 * USERS — who works here, what they may do, and whether they can sign in yet.
 * Gate 2B, Stage B.3.
 *
 * This screen is the reason the sign-in restriction could be lifted. Until it
 * existed, a `users` row was created by migration 001 and by nothing else: a
 * shop that wanted a second member of staff needed somebody to edit the
 * database file, which is the route this whole gate exists to make unnecessary.
 * A staff account with no way to acquire a credential is not an account, so a
 * login screen offering one would have been a login screen nobody could get
 * through.
 *
 * ## Three states per person, named rather than inferred
 *
 * A row says whether somebody is ACTIVE, what their ROLE is, and whether they
 * CAN SIGN IN YET — and the third is a separate fact from the first two,
 * because a newly created account is active and has no passphrase. Showing only
 * "active" would present somebody who cannot get in as ready for work, and the
 * owner would find out at the start of a shift. So "no passphrase yet" is a
 * badge with an action beside it, not an absence.
 *
 * ## What this screen will not do
 *
 * There is no DELETE. A `users` row is referenced by every document that person
 * ever touched — every sale, shift, adjustment, refund and ledger entry — and
 * `active = 0` is how this schema has always said "not usable". Deleting one to
 * tidy up a list would be destroying the attribution on real financial records,
 * so the backend does not offer it and neither does this.
 *
 * It does not show, and cannot fetch, anybody's credential: `StaffView` carries
 * a `hasCredential` boolean and nothing else. The hash is unreadable to the
 * renderer by construction — `read_guard.rs` denies `users.pin_hash` at the
 * SQLite authorizer — so there is no query this page could be made to run that
 * would return it.
 *
 * It does not let the owner reset their OWN passphrase. That needs the current
 * one, through Change passphrase; allowing it here would turn "reset somebody
 * else's" into a way around it.
 *
 * ## And it decides nothing
 *
 * Every refusal below is a copy of a rule enforced in `src-tauri/src/users.rs`,
 * which authorizes at the command boundary and again inside each writing
 * transaction. The buttons are disabled so the owner is not invited to do
 * something that will fail; the backend is what makes it fail. Where the two
 * could drift, the backend's sentence is what gets displayed — it was written
 * for the person reading it and it says what to do.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as usersApi from "../lib/users";
import type { StaffView } from "../lib/users";
import type { Role } from "../lib/auth";
import { authErrorMessage } from "../lib/auth";
import { useSession } from "../state/session";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { useTranslation } from "../lib/i18n";

const ROLES: readonly Role[] = ["owner", "manager", "cashier"];

/** An edit in progress: a new person, or an existing one being changed. */
interface Draft {
  userId: string;
  fullName: string;
  role: Role;
  isNew: boolean;
}

export default function Users() {
  const { t } = useTranslation();
  const refreshSession = useSession((s) => s.refresh);

  const [staff, setStaff] = useState<StaffView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [credentialFor, setCredentialFor] = useState<StaffView | null>(null);
  const [secret, setSecret] = useState("");
  const [secretAgain, setSecretAgain] = useState("");

  const load = useCallback(async () => {
    try {
      setStaff(await usersApi.list());
      setError(null);
    } catch (e) {
      setError(authErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run a write, then re-read.
   *
   * The list is re-read from the backend rather than patched in place, because
   * the backend's answer is the one that matters — and because several of these
   * writes change more than the row that was touched (promoting somebody can
   * change whether anybody else may be demoted). A screen that patched one row
   * would then be wrong about the others.
   */
  const run = useCallback(
    async (what: () => Promise<unknown>, success: string) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await what();
        await load();
        // A role change can be the SIGNED-IN owner's own, and the rail and the
        // route guard read the cached session. Refreshed here so the screen
        // stops offering what the backend has just stopped allowing, rather
        // than waiting for the fifteen-second poll.
        await refreshSession();
        setNotice(success);
        return true;
      } catch (e) {
        // The backend's own sentence, verbatim. It names the rule, says
        // nothing has been changed, and says what to do instead.
        setError(authErrorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load, refreshSession],
  );

  const activeOwners = useMemo(
    () => (staff ?? []).filter((s) => s.role === "owner" && s.active).length,
    [staff],
  );

  async function saveDraft() {
    if (!draft) return;
    const ok = await run(
      () =>
        usersApi.save({
          userId: draft.userId,
          fullName: draft.fullName,
          role: draft.role,
        }),
      draft.isNew ? t("users.created") : t("users.saved"),
    );
    if (ok) setDraft(null);
  }

  async function saveCredential() {
    if (!credentialFor) return;
    if (secret !== secretAgain) {
      setError(t("auth.passphrasesDoNotMatch"));
      return;
    }
    const ok = await run(
      () => usersApi.setCredential({ userId: credentialFor.userId, secret }),
      t("users.credentialSet"),
    );
    if (ok) {
      setCredentialFor(null);
      setSecret("");
      setSecretAgain("");
    }
  }

  const roleName = (role: Role) => t(`auth.role.${role}`);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("users.title")}
        subtitle={t("users.subtitle")}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setCredentialFor(null);
              setDraft({
                userId: usersApi.newUserId(),
                fullName: "",
                role: "cashier",
                isNew: true,
              });
            }}
          >
            {t("users.addStaff")}
          </Button>
        }
      />

      {error && (
        <div className="rounded-panel border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-panel border border-good-line bg-good-bg px-4 py-3 text-sm text-good-fg">
          {notice}
        </div>
      )}

      {/* THE EDITOR. One form for creating and for changing, because they are
          the same write — the backend decides which by whether the row exists,
          so two forms would be two spellings of one command. */}
      {draft && (
        <Card>
          <CardHeader
            title={draft.isNew ? t("users.addStaff") : t("users.editStaff")}
            subtitle={draft.isNew ? t("users.newHasNoPassphrase") : undefined}
          />
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t("users.fullName")}
                value={draft.fullName}
                autoFocus
                onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
                hint={t("users.fullNameHint")}
              />
              <div className="space-y-1">
                <label
                  htmlFor="staff-role"
                  className="block text-[11px] font-extrabold text-fg"
                >
                  {t("users.role")}
                </label>
                <select
                  id="staff-role"
                  value={draft.role}
                  onChange={(e) =>
                    setDraft({ ...draft, role: e.target.value as Role })
                  }
                  className="w-full rounded-chip border border-line bg-paper px-3 py-2 text-sm text-fg"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleName(r)}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-fg-muted">
                  {t(`users.roleExplainer.${draft.role}`)}
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" onClick={() => void saveDraft()} disabled={busy}>
                {busy ? t("common.saving") : t("common.save")}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                {t("common.cancel")}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* SETTING A PASSPHRASE. Separate from the name-and-role form, because it
          is a separate command with a separate permission and a separate
          consequence — and because mixing them would mean every rename
          offered a passphrase box. */}
      {credentialFor && (
        <Card>
          <CardHeader
            title={
              credentialFor.hasCredential
                ? t("users.resetPassphraseFor", { name: credentialFor.fullName })
                : t("users.setPassphraseFor", { name: credentialFor.fullName })
            }
            subtitle={t("users.temporaryByConstruction")}
          />
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t("auth.passphrase")}
                type="password"
                value={secret}
                autoFocus
                autoComplete="new-password"
                onChange={(e) => setSecret(e.target.value)}
                hint={
                  credentialFor.role === "cashier"
                    ? t("users.pinHint")
                    : t("auth.passphraseHint")
                }
              />
              <Input
                label={t("auth.confirmPassphrase")}
                type="password"
                value={secretAgain}
                autoComplete="new-password"
                onChange={(e) => setSecretAgain(e.target.value)}
              />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void saveCredential()}
                disabled={busy || !secret}
              >
                {busy ? t("common.saving") : t("users.givePassphrase")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCredentialFor(null);
                  setSecret("");
                  setSecretAgain("");
                }}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title={t("users.whoWorksHere")} subtitle={t("users.listNote")} />
        <CardBody>
          {staff === null ? (
            <p className="text-sm text-fg-muted">{t("common.loading")}</p>
          ) : staff.length === 0 ? (
            <EmptyState title={t("users.nobodyYet")} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-start font-eyebrow text-[10px] text-fg-subtle">
                    <th className="py-2 text-start">{t("users.fullName")}</th>
                    <th className="py-2 text-start">{t("users.role")}</th>
                    <th className="py-2 text-start">{t("users.canSignIn")}</th>
                    <th className="py-2 text-end">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((person) => {
                    // The last active owner may not be demoted or retired, and
                    // nobody may retire or reset the account they are signed
                    // in to. Both are enforced in Rust; these disable the
                    // control so the owner is not invited to try.
                    const lastOwner =
                      person.role === "owner" && person.active && activeOwners <= 1;
                    return (
                      <tr key={person.userId} className="border-b border-line/60">
                        <td className="py-2.5">
                          <span className={person.active ? "text-fg" : "text-fg-muted"}>
                            {person.fullName}
                          </span>
                          {person.isYou && (
                            <span className="ms-2 text-[11px] text-fg-subtle">
                              {t("users.you")}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <Badge tone={person.role === "owner" ? "brand" : "neutral"}>
                            {roleName(person.role)}
                          </Badge>
                        </td>
                        <td className="py-2.5">
                          {!person.active ? (
                            <Badge tone="neutral">{t("users.retired")}</Badge>
                          ) : !person.hasCredential ? (
                            <Badge tone="warn">{t("users.noPassphraseYet")}</Badge>
                          ) : person.mustChangeCredential ? (
                            <Badge tone="info">{t("users.mustChange")}</Badge>
                          ) : (
                            <Badge tone="good">{t("users.yes")}</Badge>
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                setCredentialFor(null);
                                setDraft({
                                  userId: person.userId,
                                  fullName: person.fullName,
                                  role: person.role,
                                  isNew: false,
                                });
                              }}
                              disabled={busy}
                            >
                              {t("common.edit")}
                            </Button>

                            {person.active && !person.isYou && (
                              <Button
                                size="sm"
                                onClick={() => {
                                  setDraft(null);
                                  setSecret("");
                                  setSecretAgain("");
                                  setCredentialFor(person);
                                }}
                                disabled={busy}
                              >
                                {person.hasCredential
                                  ? t("users.resetPassphrase")
                                  : t("users.setPassphrase")}
                              </Button>
                            )}

                            {person.active ? (
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busy || person.isYou || lastOwner}
                                title={
                                  person.isYou
                                    ? t("users.cannotRetireYourself")
                                    : lastOwner
                                      ? t("users.cannotRetireLastOwner")
                                      : undefined
                                }
                                onClick={() =>
                                  void run(
                                    () =>
                                      usersApi.setActive({
                                        userId: person.userId,
                                        isActive: false,
                                      }),
                                    t("users.retiredNotice", { name: person.fullName }),
                                  )
                                }
                              >
                                {t("users.retire")}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () =>
                                      usersApi.setActive({
                                        userId: person.userId,
                                        isActive: true,
                                      }),
                                    t("users.broughtBackNotice", {
                                      name: person.fullName,
                                    }),
                                  )
                                }
                              >
                                {t("users.bringBack")}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* The limit of what any of this protects, stated on the screen where
          somebody is deciding how much to rely on it. A passphrase keeps a
          cashier out of the owner's reports; it does nothing about the database
          file, which is an ordinary file on this computer. */}
      <p className="px-1 text-xs text-fg-muted">{t("auth.windowsAccountNote")}</p>
    </div>
  );
}
