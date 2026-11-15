// src/components/CreateReturnModal.tsx
//
// The Create Return screen.
//
// WHAT THIS COMPONENT DECIDES, AND WHAT IT DOES NOT.
//
// It collects four things: which lines are coming back, how much of each,
// whether each goes back on the shelf, and how the money is handed over. Every
// FIGURE it shows is a preview computed with the same rules the backend
// applies — `lib/creditMemoMath.ts` mirrors `posting.rs`'s cumulative
// proration, `lib/money.ts::lbpToUsdCents` mirrors its lira conversion, and
// the remaining quantities and refundable amounts come from the same SQL.
//
// None of it is authoritative. `post_credit_memo` re-derives all of it inside
// one transaction — against the original sale's snapshots, the quantity already
// returned, the tender the sale actually took and the drawer as it stands — and
// refuses anything that no longer holds. So a stale screen produces a clear
// refusal rather than a wrong refund, and this component's job is only to make
// the refusal unlikely.
//
// DOUBLE SUBMIT AND LOST ANSWERS (Codex V1.1 P0). The identity used to live in
// a `useRef`, i.e. only as long as this modal — so a refund that committed and
// lost its answer could be re-submitted after a restart under a NEW identity
// and pay the customer twice on a partly returned sale. Now every return is a
// FROZEN ATTEMPT (`lib/refundAttempt.ts`): the complete request, persisted and
// read back before `post_credit_memo` is invoked. Any failure is an UNKNOWN
// outcome, resolved by reading `sales_credit_memos` by that identity; while an
// attempt for this receipt is unresolved, no new return can be started, and a
// retry re-sends the frozen request exactly. A new identity is minted only for
// a deliberate NEW return.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { creditMemosRepo } from "../db/repos/creditMemos";
import { salesRepo } from "../db/repos/sales";
import { shiftsRepo } from "../db/repos/shifts";
import type {
  PaymentMethod,
  RefundAvailability,
  ReturnableLine,
  Shift,
} from "../db/types";
import { Button } from "./ui/Button";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Input } from "./ui/Input";
import {
  formatLbp,
  formatUsd,
  lbpToUsdCents,
  parseLbpInput,
  parseUsdInput,
  usdCentsToLbp,
} from "../lib/money";
import { returnedLineAmounts } from "../lib/creditMemoMath";
import {
  beginRefundAttempt,
  browserRefundStorage,
  loadPendingRefunds,
  pendingRefundForSale,
  clearRefundAttempt,
  refundFailureMessage,
  refundInFlight,
  sendRefundAttempt,
  type RefundAttempt,
} from "../lib/refundAttempt";
import { useTranslation } from "../lib/i18n";
import { newId } from "../lib/ids";
import clsx from "clsx";

interface CreateReturnModalProps {
  storeId: string;
  userId: string | null;
  saleId: string;
  receiptNumber: number;
  saleDateLabel: string;
  onClose: () => void;
  /** Called once a credit memo has posted, with its number. */
  onPosted: (creditMemoNumber: number) => void;
}

/** A refund leg keyed by (method, currency) — the scope the cap is stated in. */
function refundKey(a: { method: string; currency: string }): string {
  return `${a.method}|${a.currency}`;
}

export function CreateReturnModal({
  storeId,
  userId,
  saleId,
  receiptNumber,
  saleDateLabel,
  onClose,
  onPosted,
}: CreateReturnModalProps) {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<ReturnableLine[]>([]);
  const [availability, setAvailability] = useState<RefundAvailability[]>([]);
  const [shift, setShift] = useState<Shift | null>(null);
  const [lockedRate, setLockedRate] = useState<number | null>(null);

  /** Return quantity per sale-item id, as typed (in the line's own UoM). */
  const [qtyInput, setQtyInput] = useState<Record<string, string>>({});
  /** Restock decision per sale-item id. */
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  /** Refund amount per (method, currency), as typed in that currency. */
  const [refundInput, setRefundInput] = useState<Record<string, string>>({});

  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // A synchronous gate: two clicks in one frame both see `submitting` false.
  const submitGate = useRef(false);

  /** The unresolved attempt for THIS receipt, from storage — survives restart. */
  const [pending, setPending] = useState<RefundAttempt | null>(() =>
    pendingRefundForSale(loadPendingRefunds(browserRefundStorage()), storeId, saleId),
  );
  const [recovery, setRecovery] = useState<
    | { kind: "checking" }
    | { kind: "inFlight" }
    | { kind: "notPosted"; message: string | null }
    | { kind: "indeterminate"; message: string }
    /** It POSTED, but this till could not remove its record (Codex V1.1 P3). */
    | { kind: "cleanupFailed"; creditMemoNumber: number; message: string }
    | null
  >(null);
  /** A discard whose record removal did not stick. */
  const [storageError, setStorageError] = useState<string | null>(null);
  const [recoveredNumber, setRecoveredNumber] = useState<number | null>(null);

  // ---------- Load ----------

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [returnable, refundable, openShift, sale] = await Promise.all([
        creditMemosRepo.returnableLines({ storeId, saleId }),
        creditMemosRepo.refundAvailability({ storeId, saleId }),
        shiftsRepo.getOpenShift(storeId),
        salesRepo.findById(saleId),
      ]);
      setLines(returnable);
      setAvailability(refundable);
      setShift(openShift);
      setLockedRate(sale?.exchangeRateLbpPerUsd ?? null);
      setRestock(
        Object.fromEntries(
          returnable.map((l) => [l.saleItemId, !l.isService]),
        ),
      );
      setQtyInput({});
      setRefundInput({});
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, saleId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------- Resolving an earlier, uncertain attempt ----------

  /** Read the database for the attempt's identity. Never a guess. */
  const resolvePending = useCallback(
    async (attempt: RefundAttempt) => {
      if (refundInFlight.has(attempt.memoId)) {
        setRecovery({ kind: "inFlight" });
        return;
      }
      setRecovery({ kind: "checking" });
      try {
        const found = await creditMemosRepo.probeIdentity(storeId, attempt.memoId);
        if (found && found.status === "posted") {
          const cleared = clearRefundAttempt(browserRefundStorage(), attempt.memoId);
          if (!cleared.ok) {
            // The record is still there, so the screen keeps showing it —
            // blocking a new return on this receipt is the safe failure.
            setRecovery({
              kind: "cleanupFailed",
              creditMemoNumber: found.creditMemoNumber,
              message: cleared.message,
            });
            await load();
            return;
          }
          setStorageError(null);
          setPending(null);
          setRecovery(null);
          setRecoveredNumber(found.creditMemoNumber);
          await load();
        } else if (found) {
          setRecovery({ kind: "indeterminate", message: `status "${found.status}"` });
        } else {
          setRecovery({ kind: "notPosted", message: attempt.message ?? null });
        }
      } catch (e) {
        setRecovery({ kind: "indeterminate", message: refundFailureMessage(e) });
      }
    },
    [storeId, load],
  );

  // On mount only: an attempt left on record (a restart, a lock, a remount)
  // is reconciled before anything else can be submitted for this receipt.
  const resolvedOnMount = useRef(false);
  useEffect(() => {
    if (resolvedOnMount.current) return;
    resolvedOnMount.current = true;
    if (pending) void resolvePending(pending);
  }, [pending, resolvePending]);

  /** Re-send the SAME frozen request — same identity, same content. */
  async function resendPending() {
    if (!pending || submitGate.current) return;
    submitGate.current = true;
    setSubmitting(true);
    setRecovery({ kind: "inFlight" });
    try {
      const outcome = await sendRefundAttempt(
        browserRefundStorage(),
        pending,
        creditMemosRepo.postFrozen,
        { fresh: false },
      );
      if (outcome.kind === "posted") {
        if (outcome.cleanupError !== undefined) {
          setRecovery({
            kind: "cleanupFailed",
            creditMemoNumber: outcome.creditMemoNumber,
            message: outcome.cleanupError,
          });
          await load();
          return;
        }
        setPending(null);
        setRecovery(null);
        onPosted(outcome.creditMemoNumber);
        return;
      }
      const again: RefundAttempt = { ...pending, state: "unknown", message: outcome.message };
      setPending(again);
      await resolvePending(again);
    } finally {
      submitGate.current = false;
      setSubmitting(false);
    }
  }

  /** Only after a READ proved the identity never posted. */
  function discardPending() {
    if (!pending || recovery?.kind !== "notPosted") return;
    const cleared = clearRefundAttempt(browserRefundStorage(), pending.memoId);
    if (!cleared.ok) {
      // Not discarded: say so, keep it on screen, and keep the receipt blocked.
      setStorageError(cleared.message);
      return;
    }
    setStorageError(null);
    setPending(null);
    setRecovery(null);
    void load();
  }

  // ---------- Derived: the returned lines and the memo total ----------

  const selected = useMemo(() => {
    return lines
      .map((line) => {
        const raw = (qtyInput[line.saleItemId] ?? "").trim();
        if (raw === "") return null;
        const qtyInUom = Number(raw);
        if (!Number.isInteger(qtyInUom) || qtyInUom <= 0) return null;
        if (qtyInUom > line.remainingQuantityInUom) return null;

        // The base quantity follows the ORIGINAL line's own factor, which is
        // what the backend derives it from too.
        const quantityBase = Math.round(
          (qtyInUom * line.factorNumSnapshot) / line.factorDenSnapshot,
        );
        if (quantityBase <= 0 || quantityBase > line.remainingQuantityBase) return null;

        // What the backend will credit, by the same component-wise
        // cumulative rule it uses: subtotal and VAT each on their own series,
        // the total their sum. Previewing it any other way would show the
        // cashier a figure the command then refuses.
        const amounts = returnedLineAmounts({
          originalSubtotalExclVatCents: line.lineSubtotalExclVatCents,
          originalVatCents: line.lineVatCents,
          originalDiscountCents: line.lineDiscountCents,
          originalQty: line.soldQuantityBase,
          alreadyReturnedQty: line.returnedQuantityBase,
          returningQty: quantityBase,
        });
        const lineRefundCents = amounts.totalInclVatCents;

        return {
          line,
          qtyInUom,
          quantityBase,
          lineRefundCents,
          returnToStock: line.isService ? false : (restock[line.saleItemId] ?? true),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [lines, qtyInput, restock]);

  const memoTotalCents = useMemo(
    () => selected.reduce((s, x) => s + x.lineRefundCents, 0),
    [selected],
  );

  // ---------- Derived: the refund legs ----------

  const refundLegs = useMemo(() => {
    if (lockedRate === null) return [];
    return availability
      .map((a) => {
        const raw = (refundInput[refundKey(a)] ?? "").trim();
        if (raw === "") return null;
        let native: number;
        try {
          native =
            a.currency === "USD" ? parseUsdInput(raw) : parseLbpInput(raw);
        } catch {
          return null;
        }
        if (native <= 0) return null;
        // The USD equivalent at the ORIGINAL SALE's locked rate — the same
        // conversion `post_credit_memo` performs and cross-checks.
        const usdEquivalent =
          a.currency === "USD" ? native : lbpToUsdCents(native, lockedRate);
        return { availability: a, native, usdEquivalent };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [availability, refundInput, lockedRate]);

  const refundTotalCents = useMemo(
    () => refundLegs.reduce((s, l) => s + l.usdEquivalent, 0),
    [refundLegs],
  );

  const remainderCents = memoTotalCents - refundTotalCents;

  const overCap = refundLegs.filter((l) => l.native > l.availability.remainingNative);

  const canSubmit =
    !submitting &&
    pending === null &&
    !loading &&
    shift !== null &&
    lockedRate !== null &&
    selected.length > 0 &&
    memoTotalCents > 0 &&
    remainderCents === 0 &&
    overCap.length === 0;

  // ---------- Actions ----------

  /** Put what is still unallocated onto this method, within its own cap. */
  function fillRemaining(a: RefundAvailability) {
    const key = refundKey(a);
    if (lockedRate === null) return;
    const alreadyOnOthers = refundLegs
      .filter((l) => refundKey(l.availability) !== key)
      .reduce((s, l) => s + l.usdEquivalent, 0);
    const wantUsdCents = Math.max(0, memoTotalCents - alreadyOnOthers);
    if (wantUsdCents === 0) {
      setRefundInput((prev) => ({ ...prev, [key]: "" }));
      return;
    }

    if (a.currency === "USD") {
      const native = Math.min(wantUsdCents, a.remainingNative);
      setRefundInput((prev) => ({
        ...prev,
        [key]: (native / 100).toFixed(2),
      }));
      return;
    }
    // Lira: convert the wanted USD to lira at the locked rate, then cap it.
    const wantLbp = usdCentsToLbp(wantUsdCents, lockedRate);
    const native = Math.min(wantLbp, a.remainingNative);
    setRefundInput((prev) => ({ ...prev, [key]: String(native) }));
  }

  async function handleSubmit() {
    if (!canSubmit || !shift || submitGate.current) return;
    // Storage, not this component, is the record of what is unresolved.
    const onRecord = pendingRefundForSale(
      loadPendingRefunds(browserRefundStorage()),
      storeId,
      saleId,
    );
    if (onRecord) {
      setPending(onRecord);
      void resolvePending(onRecord);
      return;
    }
    submitGate.current = true;
    setSubmitError(null);
    setRecoveredNumber(null);
    setSubmitting(true);
    try {
      // A NEW physical return: the only place a return identity is minted.
      const request = creditMemosRepo.freeze({
        creditMemoId: newId(),
        storeId,
        originalSaleId: saleId,
        shiftId: shift.id,
        cashierUserId: userId,
        deviceId: null,
        reason: reason.trim() === "" ? null : reason.trim(),
        notes: notes.trim() === "" ? null : notes.trim(),
        lines: selected.map((x) => ({
          originalSaleItemId: x.line.saleItemId,
          quantityInUom: x.qtyInUom,
          quantityBase: x.quantityBase,
          returnToStock: x.returnToStock,
        })),
        refunds: refundLegs.map((l) => ({
          method: l.availability.method,
          currency: l.availability.currency,
          amountNativeUsdCents:
            l.availability.currency === "USD" ? l.native : 0,
          amountNativeLbp: l.availability.currency === "LBP" ? l.native : 0,
          amountUsdCentsEquivalent: l.usdEquivalent,
          reference: null,
        })),
      });
      const attempt = beginRefundAttempt(
        request,
        { receiptNumber, totalUsdCents: memoTotalCents },
        new Date().toISOString(),
      );
      const outcome = await sendRefundAttempt(
        browserRefundStorage(),
        attempt,
        creditMemosRepo.postFrozen,
        { fresh: true },
      );
      if (outcome.kind === "posted" && outcome.cleanupError !== undefined) {
        // Posted, but its record is stuck in storage: keep it on screen.
        setPending(attempt);
        setRecovery({
          kind: "cleanupFailed",
          creditMemoNumber: outcome.creditMemoNumber,
          message: outcome.cleanupError,
        });
        await load();
      } else if (outcome.kind === "posted") {
        onPosted(outcome.creditMemoNumber);
      } else if (outcome.kind === "notSent") {
        // Proven: nothing was sent, so this is an ordinary failure.
        setSubmitError(t("createReturn.notSent", { error: outcome.message }));
      } else {
        // UNKNOWN: it may have posted. Never shown as a plain failure that
        // invites a second submission; resolved by identity instead.
        const unknown: RefundAttempt = { ...attempt, state: "unknown", message: outcome.message };
        setPending(unknown);
        await resolvePending(unknown);
      }
    } finally {
      submitGate.current = false;
      setSubmitting(false);
    }
  }

  // ---------- Render ----------

  const nothingReturnable =
    !loading && lines.length > 0 && lines.every((l) => l.remainingQuantityBase <= 0);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-scrim/30 backdrop-blur-sm"
        onClick={submitting ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("createReturn.title")}
        className="fixed inset-y-0 end-0 z-50 w-[880px] max-w-[92vw] animate-fade-in overflow-y-auto border-s border-slate-200 bg-surface shadow-2xl"
      >
        <Card className="border-0 shadow-none">
          <CardHeader
            title={t("createReturn.title")}
            subtitle={t("createReturn.subtitleReceipt", {
              number: String(receiptNumber),
              date: saleDateLabel,
            })}
            actions={
              <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
                {t("common.close")}
              </Button>
            }
          />

          <CardBody className="space-y-5">
            {loading ? (
              <p className="text-sm text-slate-500">{t("createReturn.loading")}</p>
            ) : loadError ? (
              <p className="text-sm text-danger-fg">
                {t("createReturn.loadFailed", { error: loadError })}
              </p>
            ) : (
              <>
                {!shift && (
                  <div className="rounded-md border border-warn-line bg-warn-bg px-4 py-3 text-sm text-warn-fg">
                    {t("createReturn.noOpenShift")}
                  </div>
                )}

                {recoveredNumber !== null && (
                  <div
                    role="status"
                    className="rounded-md border border-good-line bg-good-bg px-4 py-3 text-sm text-good-fg"
                  >
                    {t("createReturn.recoveredPosted", { number: String(recoveredNumber) })}
                  </div>
                )}

                {pending && (
                  <div
                    role="alert"
                    data-testid="refund-recovery"
                    className="space-y-2 rounded-md border border-warn-line bg-warn-bg px-4 py-3 text-sm text-warn-fg"
                  >
                    <div className="font-semibold">
                      {t("createReturn.pendingTitle", { total: formatUsd(pending.totalUsdCents) })}
                    </div>
                    <div>
                      {recovery?.kind === "checking" && t("createReturn.pendingChecking")}
                      {recovery?.kind === "inFlight" && t("createReturn.pendingInFlight")}
                      {recovery?.kind === "notPosted" && (
                        <>
                          {t("createReturn.pendingNotPosted")}
                          {recovery.message && (
                            <div className="mt-1 text-xs">
                              {t("createReturn.pendingLastError", { error: recovery.message })}
                            </div>
                          )}
                        </>
                      )}
                      {recovery?.kind === "indeterminate" &&
                        t("createReturn.pendingIndeterminate", { error: recovery.message })}
                      {recovery?.kind === "cleanupFailed" &&
                        t("createReturn.pendingCleanupFailed", {
                          number: String(recovery.creditMemoNumber),
                          error: recovery.message,
                        })}
                      {storageError && (
                        <div className="mt-1 font-medium">
                          {t("createReturn.pendingDiscardFailed", { error: storageError })}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={submitting || recovery?.kind === "checking"}
                        onClick={() => void resolvePending(pending)}
                      >
                        {t("createReturn.pendingCheck")}
                      </Button>
                      {(recovery?.kind === "notPosted" || recovery?.kind === "indeterminate") && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={submitting}
                          onClick={() => void resendPending()}
                        >
                          {t("createReturn.pendingResend")}
                        </Button>
                      )}
                      {recovery?.kind === "notPosted" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={submitting}
                          onClick={discardPending}
                        >
                          {t("createReturn.pendingDiscard")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {submitError && (
                  <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger-fg">
                    {t("createReturn.failed", { error: submitError })}
                  </div>
                )}

                {nothingReturnable && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    {t("createReturn.nothingReturnable")}
                  </div>
                )}

                {/* ---- Returned lines ---- */}
                <section>
                  <h4 className="text-sm font-semibold tracking-tight text-slate-900">
                    {t("createReturn.linesTitle")}
                  </h4>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {t("createReturn.linesSubtitle")}
                  </p>

                  <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
                    <table className="min-w-full text-sm">
                      <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-4 py-2">{t("createReturn.colProduct")}</th>
                          <th className="px-4 py-2 text-end">{t("createReturn.colSold")}</th>
                          <th className="px-4 py-2 text-end">{t("createReturn.colReturned")}</th>
                          <th className="px-4 py-2 text-end">{t("createReturn.colRemaining")}</th>
                          <th className="px-4 py-2 text-end">{t("createReturn.colReturnQty")}</th>
                          <th className="px-4 py-2">{t("createReturn.colRestock")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lines.map((line) => {
                          const exhausted = line.remainingQuantityBase <= 0;
                          const unit = line.uomCodeSnapshot ?? "";
                          const chosen = selected.find(
                            (x) => x.line.saleItemId === line.saleItemId,
                          );
                          return (
                            <tr
                              key={line.saleItemId}
                              className={clsx(exhausted && "bg-slate-50/60")}
                            >
                              <td className="px-4 py-2">
                                <div className="font-medium text-slate-900">
                                  {line.productNameSnapshot}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {line.productSkuSnapshot
                                    ? `SKU ${line.productSkuSnapshot}`
                                    : t("returns.noSkuLabel")}
                                  {` · ${formatUsd(line.unitPriceInclVatCents)}`}
                                  {unit ? ` / ${unit}` : ""}
                                </div>
                                {/* The instruction this line was made to
                                    (WP-A2). Two lines of one product are
                                    otherwise indistinguishable here, and the
                                    note is often the reason one of them is
                                    coming back. It changes no figure: the
                                    refund is prorated from the line's
                                    persisted components. */}
                                {line.kitchenNote && (
                                  <div className="mt-0.5 inline-block rounded border border-warn-line bg-warn-bg px-1.5 py-0.5 text-xs text-warn-fg">
                                    {line.kitchenNote}
                                  </div>
                                )}
                                {chosen && (
                                  <div className="mt-0.5 text-xs font-medium text-brand-ink">
                                    {formatUsd(chosen.lineRefundCents)}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                                {line.soldQuantityInUom} {unit}
                              </td>
                              <td className="px-4 py-2 text-end tabular-nums text-slate-500">
                                {line.returnedQuantityInUom || "—"}
                              </td>
                              <td className="px-4 py-2 text-end tabular-nums font-medium text-slate-900">
                                {exhausted
                                  ? t("createReturn.fullyReturned")
                                  : `${line.remainingQuantityInUom} ${unit}`}
                              </td>
                              <td className="px-4 py-2 text-end">
                                <input
                                  type="number"
                                  min={0}
                                  max={line.remainingQuantityInUom}
                                  step={1}
                                  inputMode="numeric"
                                  disabled={exhausted || submitting}
                                  value={qtyInput[line.saleItemId] ?? ""}
                                  onChange={(e) =>
                                    setQtyInput((prev) => ({
                                      ...prev,
                                      [line.saleItemId]: e.target.value,
                                    }))
                                  }
                                  className="w-24 rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-end text-sm tabular-nums shadow-soft focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 disabled:bg-slate-100 disabled:text-fg-muted"
                                />
                              </td>
                              <td className="px-4 py-2">
                                {line.isService ? (
                                  <span className="text-xs text-fg-muted">
                                    {t("createReturn.restockService")}
                                  </span>
                                ) : (
                                  <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                                    <input
                                      type="checkbox"
                                      disabled={exhausted || submitting}
                                      checked={restock[line.saleItemId] ?? true}
                                      onChange={(e) =>
                                        setRestock((prev) => ({
                                          ...prev,
                                          [line.saleItemId]: e.target.checked,
                                        }))
                                      }
                                      className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand/30"
                                    />
                                    {t("createReturn.colRestock")}
                                  </label>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">
                    {t("createReturn.restockHint")}
                  </p>
                </section>

                {/* ---- Reason / notes ---- */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input
                    label={t("createReturn.reasonLabel")}
                    placeholder={t("createReturn.reasonPlaceholder")}
                    value={reason}
                    disabled={submitting}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Input
                    label={t("createReturn.notesLabel")}
                    value={notes}
                    disabled={submitting}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>

                {/* ---- Refund ---- */}
                <section>
                  <h4 className="text-sm font-semibold tracking-tight text-slate-900">
                    {t("createReturn.refundTitle")}
                  </h4>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {t("createReturn.refundSubtitle")}
                  </p>

                  {availability.length === 0 ? (
                    <div className="mt-3 rounded-md border border-warn-line bg-warn-bg px-4 py-3 text-sm text-warn-fg">
                      {t("createReturn.refundNoMethods")}
                    </div>
                  ) : (
                    <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
                      <table className="min-w-full text-sm">
                        <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-4 py-2">{t("createReturn.refundColMethod")}</th>
                            <th className="px-4 py-2 text-end">
                              {t("createReturn.refundColRefundable")}
                            </th>
                            <th className="px-4 py-2 text-end">
                              {t("createReturn.refundColAmount")}
                            </th>
                            <th className="px-4 py-2" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {availability.map((a) => {
                            const key = refundKey(a);
                            const leg = refundLegs.find(
                              (l) => refundKey(l.availability) === key,
                            );
                            const over = leg ? leg.native > a.remainingNative : false;
                            return (
                              <tr key={key}>
                                <td className="px-4 py-2 font-medium text-slate-900">
                                  {t(
                                    `shift.paymentMethods.${a.method as PaymentMethod}`,
                                  )}
                                </td>
                                <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                                  {a.currency === "USD"
                                    ? formatUsd(a.remainingNative)
                                    : formatLbp(a.remainingNative)}
                                  {a.refundedNative > 0 && (
                                    <div className="text-xs text-fg-muted">
                                      {a.currency === "USD"
                                        ? formatUsd(a.availableNative)
                                        : formatLbp(a.availableNative)}
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-2 text-end">
                                  <input
                                    inputMode={a.currency === "USD" ? "decimal" : "numeric"}
                                    disabled={submitting}
                                    placeholder={a.currency === "USD" ? "0.00" : "0"}
                                    value={refundInput[key] ?? ""}
                                    onChange={(e) =>
                                      setRefundInput((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                      }))
                                    }
                                    className={clsx(
                                      "w-32 rounded-lg border bg-surface px-2 py-1.5 text-end text-sm tabular-nums shadow-soft focus:outline-none focus:ring-4",
                                      over
                                        ? "border-danger focus:border-danger focus:ring-danger-line"
                                        : "border-slate-300 focus:border-brand focus:ring-brand/15",
                                    )}
                                  />
                                  {leg && a.currency === "LBP" && (
                                    <div className="text-xs text-fg-muted">
                                      ≈ {formatUsd(leg.usdEquivalent)}
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={submitting || memoTotalCents <= 0}
                                    onClick={() => fillRemaining(a)}
                                  >
                                    {t("createReturn.fillRemaining")}
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="mt-1.5 text-xs text-slate-500">
                    {t("createReturn.cashDrawerHint")}
                  </p>
                </section>

                {/* ---- Totals + submit ---- */}
                <div className="rounded-md border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between py-1 text-sm">
                    <span className="text-slate-600">{t("createReturn.totalLabel")}</span>
                    <span className="font-semibold tabular-nums text-slate-900">
                      {formatUsd(memoTotalCents)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1 text-sm">
                    <span className="text-slate-600">
                      {t("createReturn.refundTotalLabel")}
                    </span>
                    <span className="font-semibold tabular-nums text-slate-900">
                      {formatUsd(refundTotalCents)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-200 py-1 pt-2 text-sm">
                    <span className="text-slate-600">
                      {t("createReturn.remainderLabel")}
                    </span>
                    <span
                      className={clsx(
                        "font-semibold tabular-nums",
                        remainderCents === 0 ? "text-good-fg" : "text-warn-fg",
                      )}
                    >
                      {formatUsd(remainderCents)}
                    </span>
                  </div>

                  {selected.length === 0 && (
                    <p className="mt-2 text-xs text-slate-500">
                      {t("createReturn.nothingSelected")}
                    </p>
                  )}
                  {selected.length > 0 && remainderCents !== 0 && (
                    <p className="mt-2 text-xs text-warn-fg">
                      {t("createReturn.mustMatch")}
                    </p>
                  )}

                  <div className="mt-4">
                    <Button
                      variant="primary"
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                    >
                      {submitting
                        ? t("createReturn.submitting")
                        : t("createReturn.submit")}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
