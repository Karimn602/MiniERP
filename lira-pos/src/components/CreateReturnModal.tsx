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
// DOUBLE SUBMIT. The credit-memo identity is minted ONCE per modal and held in
// a ref, so a second click, a retry after a failure, or a resend after an
// answer that never arrived all carry the same identity — which
// `post_credit_memo` is idempotent on. The button is also disabled while a
// post is in flight, but the identity is what makes the guarantee.

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

  // ONE identity for this return, for the lifetime of the modal. Every attempt
  // — first click, retry after an error, resend after a lost answer — carries
  // it, and `post_credit_memo` reconciles a replay to the memo it may already
  // have written instead of refunding the customer twice.
  const returnIdentity = useRef<string | null>(null);
  if (returnIdentity.current === null) returnIdentity.current = newId();

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
    if (!canSubmit || !shift) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await creditMemosRepo.post({
        creditMemoId: returnIdentity.current!,
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
      onPosted(result.creditMemoNumber);
    } catch (e) {
      // The backend owns every one of these decisions, so its refusal is the
      // truth and this screen may be stale. Re-read the authoritative state
      // and then state the refusal.
      const message = e instanceof Error ? e.message : String(e);
      await load();
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }

  // ---------- Render ----------

  const nothingReturnable =
    !loading && lines.length > 0 && lines.every((l) => l.remainingQuantityBase <= 0);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm"
        onClick={submitting ? undefined : onClose}
      />
      <div className="fixed inset-y-0 end-0 z-50 w-[880px] max-w-[92vw] animate-fade-in overflow-y-auto border-s border-slate-200 bg-white shadow-2xl">
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
              <p className="text-sm text-red-700">
                {t("createReturn.loadFailed", { error: loadError })}
              </p>
            ) : (
              <>
                {!shift && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {t("createReturn.noOpenShift")}
                  </div>
                )}

                {submitError && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
                                {chosen && (
                                  <div className="mt-0.5 text-xs font-medium text-brand">
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
                                  className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-end text-sm tabular-nums shadow-soft focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 disabled:bg-slate-100 disabled:text-slate-400"
                                />
                              </td>
                              <td className="px-4 py-2">
                                {line.isService ? (
                                  <span className="text-xs text-slate-400">
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
                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
                                    <div className="text-xs text-slate-400">
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
                                      "w-32 rounded-lg border bg-white px-2 py-1.5 text-end text-sm tabular-nums shadow-soft focus:outline-none focus:ring-4",
                                      over
                                        ? "border-red-400 focus:border-red-500 focus:ring-red-100"
                                        : "border-slate-300 focus:border-brand focus:ring-brand/15",
                                    )}
                                  />
                                  {leg && a.currency === "LBP" && (
                                    <div className="text-xs text-slate-400">
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
                        remainderCents === 0 ? "text-emerald-700" : "text-amber-700",
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
                    <p className="mt-2 text-xs text-amber-700">
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
