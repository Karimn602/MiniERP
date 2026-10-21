/**
 * Drivers — the shop's own delivery drivers, their balances and their
 * settlements (WP-6).
 *
 * One screen, three jobs, in the order the owner needs them:
 *
 *   1. WHO OWES WHAT. The list is ordered by outstanding amount, descending,
 *      because the only urgent question is which driver is holding the most of
 *      the shop's money.
 *   2. TAKE A SETTLEMENT. The amount, the currency it arrived in, and nothing
 *      else to fill in. Capped at what he owes, and the cap is re-checked by
 *      `post_driver_remittance` inside its own transaction — this form just
 *      says so first.
 *   3. SHOW THE HISTORY, with every row traceable to the receipt or the credit
 *      memo behind it.
 *
 * The write path is `driversRepo.postRemittance`, which is an `invoke` into
 * the Rust command. This page never inserts a ledger row and never computes a
 * balance: both come from the same rows the command enforces against, so the
 * figure on the screen and the figure in the rule cannot drift.
 *
 * A settlement is NOT a sale, and nothing here can make one. There is no path
 * from this screen into `sales`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { driversRepo } from "../db/repos/drivers";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import { shiftsRepo } from "../db/repos/shifts";
import type { Driver, DriverBalance, DriverLedgerEntry, ExchangeRate } from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { formatUsd, lbpToUsdCents } from "../lib/money";
import { newId } from "../lib/ids";
import { remittanceBlocker, summariseDrivers } from "../lib/driverCollection";
import { createSubmissionGate } from "../lib/checkout";
import {
  beginRemittanceAttempt,
  classifyRemittanceFailure,
  remittanceOnRestore,
  remittanceToUnknown,
  remittanceVerdictFromProbe,
  type FrozenRemittanceRequest,
  type RemittanceAttempt,
} from "../lib/remittanceAttempt";
import {
  browserRemittanceStorage,
  loadPendingRemittances,
  persistPendingRemittances,
  removeAttempt,
  upsertAttempt,
} from "../lib/remittanceStore";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

type Tab = "balances" | "people";

export default function Drivers() {
  const { storeId, userId } = useActiveContext();
  const { t } = useTranslation();

  const [tab, setTab] = useState<Tab>("balances");
  const [people, setPeople] = useState<Driver[]>([]);
  const [balances, setBalances] = useState<DriverBalance[]>([]);
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  // Settlement form
  const [settleFor, setSettleFor] = useState<DriverBalance | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [currency, setCurrency] = useState<"USD" | "LBP">("USD");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /**
   * Unresolved remittances: a hand-over whose outcome never reached us.
   *
   * Since migration 016 a remittance moves DRAWER CASH, so re-sending one
   * under a fresh identity would make the till expect twice the money that
   * arrived. These carry the original identity, which is the only thing that
   * lets `post_driver_remittance` recognise a retry — see
   * `lib/remittanceAttempt.ts`.
   *
   * Promoted on the way in: a persisted `posting` means the window went away
   * mid-flight, which IS an unknown outcome rather than a request still
   * running.
   */
  const [pending, setPending] = useState<RemittanceAttempt[]>(() =>
    loadPendingRemittances(browserRemittanceStorage()).map((a) =>
      remittanceOnRestore(a, "The application closed while this hand-over was being recorded."),
    ),
  );
  const [probeNotice, setProbeNotice] = useState<string | null>(null);

  /**
   * Synchronous duplicate-submit guard.
   *
   * `submitting` is React state and is invisible to a second handler that runs
   * before the rerender — a double-click on "Record money in" would pass a
   * `!submitting` check twice and launch two independent posts. The gate flips
   * in the same tick, so the second is dropped. It is a convenience, not the
   * guarantee: the identity below is what actually makes a retry safe, because
   * the backend is the authority.
   */
  const gateRef = useRef<ReturnType<typeof createSubmissionGate>>(createSubmissionGate());
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // History
  const [historyFor, setHistoryFor] = useState<DriverBalance | null>(null);
  const [history, setHistory] = useState<DriverLedgerEntry[]>([]);

  // New / edited driver
  const [editing, setEditing] = useState<Driver | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");

  const reload = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const [bals, list] = await Promise.all([
        driversRepo.balances({ storeId, includeInactive }),
        driversRepo.list({ storeId, includeInactive: true }),
      ]);
      setBalances(bals);
      setPeople(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBalances([]);
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, [storeId, includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The rate a LIRA settlement is converted at. Read once; a lira remittance
  // is refused outright without one, because the stored USD equivalent would
  // otherwise come from a number nobody can point at.
  useEffect(() => {
    if (!storeId) return;
    void (async () => {
      try {
        setRate(await exchangeRatesRepo.getCurrentForToday(storeId));
      } catch {
        setRate(null);
      }
    })();
  }, [storeId]);

  const totals = useMemo(
    () =>
      summariseDrivers(
        balances.map((b) => ({
          driverId: b.driverId,
          driverName: b.driverName,
          isActive: b.isActive,
          orderCount: b.collectionCount,
          collectedCents: b.collectedCents,
          remittedCents: b.remittedCents,
          returnCreditCents: b.returnCreditCents,
          adjustmentCents: b.adjustmentCents,
          outstandingCents: b.outstandingCents,
          // Not a balance figure at all — the driver keeps his fees. The
          // period figure lives in the report; this screen is about balances.
          deliveryFeesCents: 0,
          lastActivityAt: b.lastActivityAt,
        })),
      ),
    [balances],
  );

  /**
   * The typed amount as a positive USD-cent magnitude, or null if unusable.
   *
   * A lira amount is converted through the SAME helper the backend uses, at the
   * rate on record, so the cap this form checks is the cap the command checks.
   */
  const amountCents = useMemo(() => {
    const text = amountInput.trim();
    if (text === "") return null;
    if (currency === "USD") {
      if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
      return Math.round(Number(text) * 100);
    }
    if (!/^\d+$/.test(text)) return null; // whole lira only
    if (!rate) return null;
    return lbpToUsdCents(Number(text), rate.rateLbpPerUsd);
  }, [amountInput, currency, rate]);

  const blocker = settleFor
    ? remittanceBlocker(amountCents, settleFor.outstandingCents)
    : null;

  async function openHistory(b: DriverBalance) {
    setHistoryFor(b);
    try {
      setHistory(await driversRepo.ledger({ driverId: b.driverId }));
    } catch {
      setHistory([]);
    }
  }

  /**
   * Persist the pending list and PROVE it landed.
   *
   * `requireEntry` is passed when a cash movement is about to be staked on a
   * specific attempt. A failed write is fatal to that submission: a remittance
   * we cannot recognise again is one the till could end up expecting twice.
   */
  function writePending(
    next: RemittanceAttempt[],
    requireEntry?: string,
  ): { ok: true } | { ok: false; message: string } {
    const verdict = persistPendingRemittances(browserRemittanceStorage(), next, {
      requireEntry,
    });
    if (verdict.ok) {
      setPending(next);
      return { ok: true };
    }
    return { ok: false, message: verdict.message };
  }

  /**
   * Send ONE frozen attempt and deal with every outcome it can have.
   *
   * The attempt is already persisted before this runs, so a kill at any point
   * inside it leaves a record carrying the exact request that went out.
   */
  async function sendAttempt(attempt: RemittanceAttempt) {
    setSubmitting(true);
    setFormError(null);
    setProbeNotice(null);
    try {
      // THE FROZEN REQUEST — never a rebuild from current form state. The
      // backend compares a replay against what posted, so rebuilding it from
      // today's rate or today's shift is how a retry becomes a conflict.
      const result = await driversRepo.postRemittance(attempt.request);

      // Posted. Retire the attempt and tell the operator what moved.
      writePending(removeAttempt(pending, attempt.entryId));
      const name =
        balances.find((b) => b.driverId === attempt.driverId)?.driverName ??
        people.find((d) => d.id === attempt.driverId)?.name ??
        "";
      setNotice(
        t("drivers.settledNotice", {
          name,
          amount: formatUsd(-result.amountCents),
          balance: formatUsd(result.newBalanceCents),
        }),
      );
      setSettleFor(null);
      setAmountInput("");
      setReference("");
      await reload();
    } catch (e) {
      // EVERY failure is unknown — see `classifyRemittanceFailure` for why a
      // plain-string backend error cannot safely be read as "nothing was
      // written". The attempt keeps its identity and its request, and the
      // operator is offered a read-only check rather than a blind retry.
      const failure = classifyRemittanceFailure(e);
      const unresolved = remittanceToUnknown(attempt, failure.message);
      writePending(upsertAttempt(pending, unresolved));
      setFormError(failure.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSettlement() {
    if (!storeId || !settleFor || amountCents === null || blocker) return;

    // Synchronous, so a double-click cannot launch two hand-overs.
    if (!gateRef.current.tryEnter()) return;
    try {
      // A remittance is drawer cash, so it must name an OPEN shift of this
      // store. Read before the attempt is frozen, because the shift is part of
      // the request a retry replays.
      let shiftId: string | null = null;
      try {
        shiftId = (await shiftsRepo.getOpenShift(storeId))?.id ?? null;
      } catch {
        shiftId = null;
      }
      if (!shiftId) {
        setFormError(t("drivers.err.noOpenShift"));
        return;
      }

      const request: FrozenRemittanceRequest = {
        // THE REMITTANCE IDENTITY, minted once here and reused by every retry
        // of this hand-over. This is what `post_driver_remittance` is
        // idempotent on, and the whole reason the attempt exists.
        ledgerEntryId: newId(),
        storeId,
        driverId: settleFor.driverId,
        entryType: "remittance",
        entryDate: new Date().toISOString().slice(0, 10),
        receivedCurrency: currency,
        receivedNativeUsdCents: currency === "USD" ? amountCents : 0,
        receivedNativeLbp: currency === "LBP" ? Number(amountInput.trim()) : 0,
        exchangeRateId: currency === "LBP" ? (rate?.id ?? null) : null,
        exchangeRateLbpPerUsd: currency === "LBP" ? (rate?.rateLbpPerUsd ?? null) : null,
        reference: reference.trim() || null,
        shiftId,
        createdByUserId: userId,
      };

      const attempt = beginRemittanceAttempt(request, new Date().toISOString());

      // PERSIST BEFORE INVOKING — synchronously, proven, and fatal if it
      // fails. The same rule the register follows before `post_sale`, and for
      // the same reason: this request moves money, and a request we cannot
      // re-send is one we cannot reconcile.
      const written = writePending(upsertAttempt(pending, attempt), attempt.entryId);
      if (!written.ok) {
        setFormError(`${t("drivers.err.notPersisted")} (${written.message})`);
        return;
      }

      await sendAttempt(attempt);
    } finally {
      gateRef.current.release();
    }
  }

  /**
   * Resolve an unknown outcome by asking the database.
   *
   * Read-only and authoritative: `post_driver_remittance` consumes an identity
   * on exactly one commit, so a row under that id proves the hand-over posted
   * and the absence of one proves it had not, as of this read. Offered as the
   * FIRST action, because it writes nothing and answers definitively.
   */
  async function reconcileAttempt(attempt: RemittanceAttempt) {
    setProbeNotice(null);
    setFormError(null);
    try {
      const found = await driversRepo.findLedgerEntry(attempt.entryId);
      const verdict = remittanceVerdictFromProbe(found !== null);
      if (verdict.kind === "posted") {
        writePending(removeAttempt(pending, attempt.entryId));
        setNotice(t("drivers.probePosted"));
        await reload();
      } else {
        setProbeNotice(t("drivers.probeNotPosted"));
      }
    } catch (e) {
      // The probe itself failed, so nothing is proven either way. The attempt
      // stays unresolved rather than being guessed at.
      setProbeNotice(
        `${t("drivers.probeIndeterminate")} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  /**
   * Abandon an unresolved remittance.
   *
   * Throws away the only key that could reconcile it to an entry that may
   * exist, so it asks first. Offered because an attempt the operator knows was
   * never sent should not sit on the screen for ever.
   */
  function discardAttempt(attempt: RemittanceAttempt) {
    if (!window.confirm(t("drivers.confirmDiscard"))) return;
    writePending(removeAttempt(pending, attempt.entryId));
  }

  async function saveDriver() {
    if (!storeId || nameInput.trim() === "") return;
    setFormError(null);
    try {
      if (editing) {
        await driversRepo.update({ id: editing.id, name: nameInput, phone: phoneInput });
      } else {
        await driversRepo.create({ storeId, name: nameInput, phone: phoneInput });
      }
      setFormOpen(false);
      setEditing(null);
      setNameInput("");
      setPhoneInput("");
      await reload();
    } catch (e) {
      // A duplicate name lands here: one driver must have one balance, so the
      // unique index refuses a second "Ali" in the same store.
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t("drivers.title")} subtitle={t("drivers.subtitle")} />

      {error !== null && (
        <Card>
          <CardBody>
            <p className="text-sm font-bold text-danger">{error}</p>
          </CardBody>
        </Card>
      )}

      {/* UNRESOLVED HAND-OVERS (WP-7 §4).
          A remittance whose answer never reached us. Since migration 016 one
          of these moves drawer cash, so it must never be re-sent under a new
          identity — the till would expect twice the money that arrived. The
          attempt carries the ORIGINAL identity, and the first action offered is
          a read-only check that answers definitively.

          Shown above everything, because a shift must not be closed and
          counted while one of these is outstanding. */}
      {pending.length > 0 && (
        <Card>
          <CardHeader
            title={t("drivers.unresolvedTitle")}
            subtitle={t("drivers.unresolvedSubtitle")}
          />
          <CardBody>
            <ul className="divide-y divide-line">
              {pending.map((a) => {
                const name =
                  balances.find((b) => b.driverId === a.driverId)?.driverName ??
                  people.find((d) => d.id === a.driverId)?.name ??
                  a.driverId;
                const native =
                  a.request.receivedCurrency === "LBP"
                    ? `${(a.request.receivedNativeLbp ?? 0).toLocaleString()} LBP`
                    : formatUsd(a.request.receivedNativeUsdCents ?? 0);
                return (
                  <li key={a.entryId} className="space-y-2 py-3">
                    <p className="text-sm font-bold text-fg">
                      {t("drivers.unresolvedLine", { name, amount: native })}
                    </p>
                    {a.message && (
                      <p className="text-xs text-fg-muted">{a.message}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {/* Read-only, and therefore first. */}
                      <Button onClick={() => void reconcileAttempt(a)}>
                        {t("drivers.checkThis")}
                      </Button>
                      {/* Re-sends the FROZEN request under its original
                          identity, which is what the backend recognises. */}
                      <Button
                        variant="secondary"
                        disabled={submitting}
                        onClick={() => void sendAttempt(a)}
                      >
                        {t("drivers.sendAgain")}
                      </Button>
                      <Button variant="ghost" onClick={() => discardAttempt(a)}>
                        {t("drivers.discardAttempt")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {probeNotice !== null && (
              <p className="mt-3 text-sm font-bold text-fg">{probeNotice}</p>
            )}
          </CardBody>
        </Card>
      )}

      {notice !== null && (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-fg">{notice}</p>
              <Button variant="ghost" onClick={() => setNotice(null)}>
                {t("common.dismiss")}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <div role="tablist" aria-label={t("drivers.title")} className="flex gap-2">
        <Button
          role="tab"
          aria-selected={tab === "balances"}
          variant={tab === "balances" ? "primary" : "ghost"}
          onClick={() => setTab("balances")}
        >
          {t("drivers.tabBalances")}
        </Button>
        <Button
          role="tab"
          aria-selected={tab === "people"}
          variant={tab === "people" ? "primary" : "ghost"}
          onClick={() => setTab("people")}
        >
          {t("drivers.tabPeople")}
        </Button>
      </div>

      {tab === "balances" && (
        <Card>
          <CardHeader
            title={t("drivers.outstandingTitle")}
            actions={
              <label className="flex items-center gap-2 text-xs font-bold text-fg-muted">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(e) => setIncludeInactive(e.target.checked)}
                />
                {t("drivers.includeInactive")}
              </label>
            }
          />
          <CardBody>
            {loading ? (
              <p className="text-sm text-fg-muted">{t("common.loading")}</p>
            ) : balances.length === 0 ? (
              <EmptyState title={t("drivers.emptyTitle")} description={t("drivers.emptyBody")} />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-start text-xs uppercase text-fg-muted">
                        <th className="py-2">{t("drivers.colDriver")}</th>
                        <th className="py-2 text-end">{t("drivers.colCollected")}</th>
                        <th className="py-2 text-end">{t("drivers.colRemitted")}</th>
                        <th className="py-2 text-end">{t("drivers.colReturns")}</th>
                        <th className="py-2 text-end">{t("drivers.colOutstanding")}</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {balances.map((b) => (
                        <tr key={b.driverId} className="border-b border-line/60">
                          <td className="py-2 font-bold text-fg">
                            {b.driverName}
                            {!b.isActive && (
                              <Badge className="ms-2" tone="neutral">
                                {t("drivers.retired")}
                              </Badge>
                            )}
                          </td>
                          <td className="py-2 text-end">{formatUsd(b.collectedCents)}</td>
                          <td className="py-2 text-end">{formatUsd(b.remittedCents)}</td>
                          <td className="py-2 text-end">{formatUsd(b.returnCreditCents)}</td>
                          <td
                            className={clsx(
                              "py-2 text-end font-extrabold",
                              b.outstandingCents > 0 && "text-fg",
                              // A negative balance is the shop owing the
                              // driver — reachable only through a signed-off
                              // adjustment or a return he funded. Labelled, not
                              // hidden.
                              b.outstandingCents < 0 && "text-good-fg",
                            )}
                          >
                            {b.outstandingCents < 0
                              ? t("drivers.creditOnFile", {
                                  amount: formatUsd(-b.outstandingCents),
                                })
                              : formatUsd(b.outstandingCents)}
                          </td>
                          <td className="py-2 text-end">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setSettleFor(b);
                                  setFormError(null);
                                  setAmountInput("");
                                }}
                                disabled={b.outstandingCents <= 0}
                              >
                                {t("drivers.settle")}
                              </Button>
                              <Button variant="ghost" onClick={() => void openHistory(b)}>
                                {t("drivers.history")}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-extrabold text-fg">
                        <td className="py-2">{t("common.total")}</td>
                        <td className="py-2 text-end">{formatUsd(totals.collectedCents)}</td>
                        <td className="py-2 text-end">{formatUsd(totals.remittedCents)}</td>
                        <td className="py-2 text-end">{formatUsd(totals.returnCreditCents)}</td>
                        <td className="py-2 text-end">{formatUsd(totals.outstandingCents)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {/* A row whose balance disagrees with its own components can
                    only mean a new ledger entry type was added without being
                    given a column here. Said out loud rather than rendered as
                    two numbers that quietly differ. */}
                {totals.unreconciled.length > 0 && (
                  <p className="mt-2 text-xs font-bold text-danger">
                    {t("drivers.unreconciled", { n: String(totals.unreconciled.length) })}
                  </p>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "people" && (
        <Card>
          <CardHeader
            title={t("drivers.peopleTitle")}
            actions={
              <Button
                onClick={() => {
                  setEditing(null);
                  setNameInput("");
                  setPhoneInput("");
                  setFormOpen(true);
                  setFormError(null);
                }}
              >
                {t("drivers.addDriver")}
              </Button>
            }
          />
          <CardBody>
            {formOpen && (
              <div className="mb-4 space-y-2 rounded-chip border border-line bg-paper p-3">
                <Input
                  label={t("drivers.name")}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                />
                <Input
                  label={t("drivers.phone")}
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                />
                {formError !== null && (
                  <p className="text-xs font-bold text-danger">{formError}</p>
                )}
                <div className="flex gap-2">
                  <Button onClick={() => void saveDriver()} disabled={nameInput.trim() === ""}>
                    {t("common.save")}
                  </Button>
                  <Button variant="ghost" onClick={() => setFormOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            )}

            {people.length === 0 ? (
              <EmptyState title={t("drivers.emptyTitle")} description={t("drivers.emptyBody")} />
            ) : (
              <ul className="divide-y divide-line">
                {people.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="font-bold text-fg">
                        {d.name}
                        {!d.isActive && (
                          <Badge className="ms-2" tone="neutral">
                            {t("drivers.retired")}
                          </Badge>
                        )}
                      </p>
                      {d.phone && <p className="text-xs text-fg-muted">{d.phone}</p>}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEditing(d);
                          setNameInput(d.name);
                          setPhoneInput(d.phone ?? "");
                          setFormOpen(true);
                        }}
                      >
                        {t("common.edit")}
                      </Button>
                      {/* Retire, never delete: his name is on posted receipts
                          and ledger rows, and the foreign keys are RESTRICT. */}
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          await driversRepo.setActive(d.id, !d.isActive);
                          await reload();
                        }}
                      >
                        {d.isActive ? t("drivers.retire") : t("drivers.reinstate")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {/* ---- Settlement form ---- */}
      {settleFor !== null && (
        <Card>
          <CardHeader
            title={t("drivers.settleTitle", { name: settleFor.driverName })}
            subtitle={t("drivers.settleSubtitle", {
              amount: formatUsd(settleFor.outstandingCents),
            })}
          />
          <CardBody>
            <div className="space-y-2">
              <div role="group" aria-label={t("drivers.currency")} className="flex gap-2">
                {(["USD", "LBP"] as const).map((c) => (
                  <Button
                    key={c}
                    variant={currency === c ? "primary" : "ghost"}
                    aria-pressed={currency === c}
                    onClick={() => setCurrency(c)}
                  >
                    {c}
                  </Button>
                ))}
              </div>
              <Input
                label={
                  currency === "USD" ? t("drivers.amountUsd") : t("drivers.amountLbp")
                }
                value={amountInput}
                inputMode="decimal"
                onChange={(e) => setAmountInput(e.target.value)}
              />
              {/* A lira settlement needs a rate on record, and says so rather
                  than failing at the backend. */}
              {currency === "LBP" && !rate && (
                <p className="text-xs font-bold text-danger">{t("drivers.noRate")}</p>
              )}
              {currency === "LBP" && rate && amountCents !== null && (
                <p className="text-xs text-fg-muted">
                  {t("drivers.lbpEquivalent", { amount: formatUsd(amountCents) })}
                </p>
              )}
              <Input
                label={t("drivers.reference")}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              {blocker !== null && amountInput.trim() !== "" && (
                <p className="text-xs font-bold text-danger">{t(`drivers.err.${blocker}`)}</p>
              )}
              {formError !== null && (
                <p className="text-xs font-bold text-danger">{formError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  onClick={() => void submitSettlement()}
                  disabled={submitting || blocker !== null}
                >
                  {submitting ? t("drivers.recording") : t("drivers.recordSettlement")}
                </Button>
                <Button variant="ghost" onClick={() => setSettleFor(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
              <p className="text-xs leading-snug text-fg-muted">{t("drivers.settleNote")}</p>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---- History ---- */}
      {historyFor !== null && (
        <Card>
          <CardHeader
            title={t("drivers.historyTitle", { name: historyFor.driverName })}
            actions={
              <Button variant="ghost" onClick={() => setHistoryFor(null)}>
                {t("common.close")}
              </Button>
            }
          />
          <CardBody>
            {history.length === 0 ? (
              <p className="text-sm text-fg-muted">{t("drivers.noHistory")}</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {history.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="font-bold text-fg">{t(`drivers.entry.${e.entryType}`)}</p>
                      <p className="text-xs text-fg-muted">
                        {e.entryDate}
                        {/* Source traceability, as Priority 4 requires: every
                            row points at the document that caused it. */}
                        {e.relatedSaleId && ` · ${t("drivers.fromOrder")}`}
                        {e.relatedCreditMemoId && ` · ${t("drivers.fromReturn")}`}
                        {e.receivedCurrency === "LBP" &&
                          ` · ${e.receivedNativeLbp.toLocaleString()} LBP`}
                        {e.reference && ` · ${e.reference}`}
                      </p>
                      {e.notes && <p className="text-xs text-fg-muted">{e.notes}</p>}
                    </div>
                    <p
                      className={clsx(
                        "font-extrabold",
                        e.amountCents > 0 ? "text-fg" : "text-good-fg",
                      )}
                    >
                      {e.amountCents > 0 ? "+" : "−"}
                      {formatUsd(Math.abs(e.amountCents))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
