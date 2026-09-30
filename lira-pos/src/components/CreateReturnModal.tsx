import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { creditMemosRepo } from "../db/repos/creditMemos";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import { shiftsRepo } from "../db/repos/shifts";
import type {
  CreditMemoWithDetails,
  ExchangeRate,
  ReturnableLine,
} from "../db/types";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Badge } from "./ui/Badge";
import { CreditMemoPrint } from "./CreditMemoPrint";
import {
  formatLbp,
  formatUsd,
  lbpToUsdCents,
  parseLbpInput,
  parseUsdInput,
  usdCentsToLbp,
} from "../lib/money";
import { computeReturnLineAmounts } from "../lib/creditMemoMath";
import { formatPrettyDate } from "../lib/dates";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

interface CreateReturnModalProps {
  saleId: string;
  originalReceiptNumber: number;
  saleDateIso: string;
  storeName: string;
  onClose: () => void;
  onPosted: () => void;
}

interface LineState {
  returnUomInput: string; // quantity in the sold UoM
  restock: boolean;
}

// base units per 1 UoM unit for a sold line (exact integer by construction).
function basePerUom(line: ReturnableLine): number {
  const { quantity, quantityInUom } = line.saleItem;
  if (!quantityInUom || quantityInUom <= 0) return 1;
  return Math.round(quantity / quantityInUom);
}

export function CreateReturnModal({
  saleId,
  originalReceiptNumber,
  saleDateIso,
  storeName,
  onClose,
  onPosted,
}: CreateReturnModalProps) {
  const { storeId, userId, deviceId } = useActiveContext();
  const { t } = useTranslation();

  const [lines, setLines] = useState<ReturnableLine[]>([]);
  const [lineState, setLineState] = useState<Record<string, LineState>>({});
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [rateMissing, setRateMissing] = useState(false);
  const [shiftId, setShiftId] = useState<string | null>(null);

  const [reason, setReason] = useState("");
  const [cashUsdInput, setCashUsdInput] = useState("");
  const [cashLbpInput, setCashLbpInput] = useState("");
  const [cardUsdInput, setCardUsdInput] = useState("");
  const [refundTouched, setRefundTouched] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [postedMemo, setPostedMemo] = useState<CreditMemoWithDetails | null>(null);

  // ---------- Load ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!storeId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const returnable = await creditMemosRepo.getReturnableForSale(saleId);
        let resolvedRate: ExchangeRate | null = null;
        try {
          resolvedRate = await exchangeRatesRepo.getCurrentForToday(storeId);
        } catch {
          resolvedRate = null;
        }
        const openShift = await shiftsRepo.getOpenShift(storeId);
        if (cancelled) return;
        setLines(returnable);
        setLineState(
          Object.fromEntries(
            returnable.map((l) => [
              l.saleItem.id,
              { returnUomInput: "", restock: !l.isService },
            ]),
          ),
        );
        setRate(resolvedRate);
        setRateMissing(resolvedRate === null);
        setShiftId(openShift?.id ?? null);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saleId, storeId]);

  // ---------- Per-line computed amounts ----------
  const computed = useMemo(() => {
    let totalIncl = 0;
    let subtotalExcl = 0;
    let vat = 0;
    const perLine = lines.map((l) => {
      const bpu = basePerUom(l);
      const returnableUom = Math.floor(l.returnableQtyBase / bpu);
      const raw = lineState[l.saleItem.id]?.returnUomInput ?? "";
      let returnUom = 0;
      if (raw.trim() !== "") {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          returnUom = Math.min(parsed, returnableUom);
        }
      }
      const returnBase = returnUom * bpu;
      const amounts =
        returnBase > 0
          ? computeReturnLineAmounts({
              returnQtyBase: returnBase,
              origQtyBase: l.saleItem.quantity,
              origLineTotalInclVatCents: l.saleItem.lineTotalInclVatCents,
              origLineDiscountCents: l.saleItem.lineDiscountCents,
              unitCogsExclVatCents: l.saleItem.unitCogsExclVatCents,
              vatBps: l.saleItem.vatRateBpsSnapshot,
            })
          : null;
      if (amounts) {
        totalIncl += amounts.lineTotalInclVatCents;
        subtotalExcl += amounts.lineSubtotalExclVatCents;
        vat += amounts.lineVatCents;
      }
      return { line: l, bpu, returnableUom, returnUom, returnBase, amounts };
    });
    return { perLine, totalIncl, subtotalExcl, vat };
  }, [lines, lineState]);

  const total = computed.totalIncl;

  // Default the whole refund to Cash USD until the cashier edits a refund field.
  useEffect(() => {
    if (refundTouched) return;
    setCashUsdInput(total > 0 ? (total / 100).toFixed(2) : "");
    setCashLbpInput("");
    setCardUsdInput("");
  }, [total, refundTouched]);

  // ---------- Refund allocation ----------
  const refunds = useMemo(() => {
    const errs: string[] = [];
    let cashUsdCents = 0;
    if (cashUsdInput.trim() !== "") {
      try {
        cashUsdCents = parseUsdInput(cashUsdInput);
      } catch {
        errs.push(t("returns.errCashUsdInvalid"));
      }
    }
    let cashLbp = 0;
    if (cashLbpInput.trim() !== "") {
      if (!rate) {
        errs.push(t("returns.errNoRate"));
      } else {
        try {
          cashLbp = parseLbpInput(cashLbpInput);
        } catch {
          errs.push(t("returns.errCashLbpInvalid"));
        }
      }
    }
    let cardUsdCents = 0;
    if (cardUsdInput.trim() !== "") {
      try {
        cardUsdCents = parseUsdInput(cardUsdInput);
      } catch {
        errs.push(t("returns.errCardUsdInvalid"));
      }
    }
    const cashLbpAsUsd = rate && cashLbp > 0 ? lbpToUsdCents(cashLbp, rate.rateLbpPerUsd) : 0;
    const allocated = cashUsdCents + cashLbpAsUsd + cardUsdCents;
    return { cashUsdCents, cashLbp, cashLbpAsUsd, cardUsdCents, allocated, errors: errs };
  }, [cashUsdInput, cashLbpInput, cardUsdInput, rate, t]);

  const remaining = total - refunds.allocated;
  const hasSelection = total > 0;
  const canPost =
    !submitting &&
    hasSelection &&
    refunds.errors.length === 0 &&
    remaining === 0 &&
    !!storeId &&
    !!rate;

  function editRefund(setter: (v: string) => void, value: string) {
    setRefundTouched(true);
    setter(value);
  }

  function setRestockAll(value: boolean) {
    setLineState((prev) => {
      const next = { ...prev };
      for (const l of lines) {
        if (!l.isService) next[l.saleItem.id] = { ...next[l.saleItem.id], restock: value };
      }
      return next;
    });
  }

  // ---------- Post ----------
  const handlePost = useCallback(async () => {
    if (!storeId || !rate) return;
    setSubmitError(null);

    const lineInputs = computed.perLine
      .filter((p) => p.returnBase > 0)
      .map((p) => ({
        originalSaleItemId: p.line.saleItem.id,
        quantityBase: p.returnBase,
        quantityInUom: p.returnUom,
        returnToStock: p.line.isService
          ? false
          : (lineState[p.line.saleItem.id]?.restock ?? false),
      }));

    if (lineInputs.length === 0) {
      setSubmitError(t("returns.errNothingSelected"));
      return;
    }
    if (refunds.errors.length > 0) {
      setSubmitError(refunds.errors[0]);
      return;
    }
    if (remaining !== 0) {
      setSubmitError(t("returns.errRefundMismatch"));
      return;
    }

    const refundInputs: {
      method: "cash_usd" | "cash_lbp" | "card_usd";
      currency: "USD" | "LBP";
      amountNativeUsdCents: number;
      amountNativeLbp: number;
      amountUsdCentsEquivalent: number;
      reference: string | null;
    }[] = [];
    if (refunds.cashUsdCents > 0) {
      refundInputs.push({
        method: "cash_usd",
        currency: "USD",
        amountNativeUsdCents: refunds.cashUsdCents,
        amountNativeLbp: 0,
        amountUsdCentsEquivalent: refunds.cashUsdCents,
        reference: null,
      });
    }
    if (refunds.cashLbp > 0) {
      refundInputs.push({
        method: "cash_lbp",
        currency: "LBP",
        amountNativeUsdCents: 0,
        amountNativeLbp: refunds.cashLbp,
        amountUsdCentsEquivalent: refunds.cashLbpAsUsd,
        reference: null,
      });
    }
    if (refunds.cardUsdCents > 0) {
      refundInputs.push({
        method: "card_usd",
        currency: "USD",
        amountNativeUsdCents: refunds.cardUsdCents,
        amountNativeLbp: 0,
        amountUsdCentsEquivalent: refunds.cardUsdCents,
        reference: null,
      });
    }

    setSubmitting(true);
    try {
      const result = await creditMemosRepo.post({
        storeId,
        originalSaleId: saleId,
        cashierUserId: userId,
        deviceId,
        shiftId,
        exchangeRateId: rate.id,
        exchangeRateLbpPerUsd: rate.rateLbpPerUsd,
        reason: reason.trim() || null,
        lines: lineInputs,
        refunds: refundInputs,
      });
      const memo = await creditMemosRepo.findByIdWithDetails(result.creditMemoId);
      setPostedMemo(memo);
    } catch (e) {
      setSubmitError(
        t("returns.postFailed", { error: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    storeId, rate, computed, lineState, refunds, remaining, saleId, userId,
    deviceId, shiftId, reason, t,
  ]);

  // ---------- Success view ----------
  if (postedMemo) {
    return (
      <>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm print:hidden">
          <Card className="w-full max-w-md">
            <CardHeader title={t("returns.successTitle")} />
            <CardBody className="space-y-4">
              <p className="text-sm text-slate-600">
                {t("returns.successBody", {
                  number: String(postedMemo.creditMemoNumber),
                  amount: formatUsd(postedMemo.totalInclVatCents),
                })}
              </p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => window.print()}>
                  {t("returns.printCreditMemo")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    onPosted();
                    onClose();
                  }}
                >
                  {t("returns.done")}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
        <div id="credit-memo-print-root" className="hidden print:block">
          <CreditMemoPrint
            memo={postedMemo}
            storeName={storeName}
            originalReceiptNumber={originalReceiptNumber}
          />
        </div>
      </>
    );
  }

  // ---------- Main modal ----------
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 backdrop-blur-sm print:hidden">
      <Card className="my-4 w-full max-w-3xl">
        <CardHeader
          title={`${t("returns.modalTitle")} · ${t("returns.creditMemoLabel")}`}
          subtitle={t("returns.modalSubtitle", {
            number: String(originalReceiptNumber),
            date: formatPrettyDate(saleDateIso.slice(0, 10)),
          })}
          actions={
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("returns.cancel")}
            </Button>
          }
        />
        <CardBody className="space-y-5">
          {loading ? (
            <p className="text-sm text-slate-500">{t("salesHistory.detailLoading")}</p>
          ) : loadError ? (
            <p className="text-sm text-red-700">{loadError}</p>
          ) : (
            <>
              {rateMissing && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {t("returns.errNoRate")}
                </div>
              )}

              {/* Lines */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700">
                    {t("returns.selectLines")}
                  </h3>
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300"
                      onChange={(e) => setRestockAll(e.target.checked)}
                    />
                    {t("returns.restockAll")}
                  </label>
                </div>
                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <table className="min-w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50/80 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-2">{t("returns.colProduct")}</th>
                        <th className="px-4 py-2 text-end">{t("returns.colSold")}</th>
                        <th className="px-4 py-2 text-end">{t("returns.colReturned")}</th>
                        <th className="px-4 py-2 text-end">{t("returns.colReturnable")}</th>
                        <th className="px-4 py-2 text-end">{t("returns.colReturnQty")}</th>
                        <th className="px-4 py-2 text-center">{t("returns.colRestock")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {computed.perLine.map(({ line, returnableUom, returnUom }) => {
                        const id = line.saleItem.id;
                        const bpu = basePerUom(line);
                        const soldUom = line.saleItem.quantityInUom ?? line.saleItem.quantity;
                        const returnedUom = Math.round(line.returnedQtyBase / bpu);
                        const uom = line.saleItem.uomCodeSnapshot ?? "";
                        const fullyReturned = returnableUom <= 0;
                        const st = lineState[id];
                        return (
                          <tr key={id} className={clsx(fullyReturned && "opacity-50")}>
                            <td className="px-4 py-2">
                              <div className="font-medium text-slate-900">
                                {line.saleItem.productNameSnapshot}
                              </div>
                              <div className="flex items-center gap-2 text-xs text-slate-500">
                                {line.saleItem.productSkuSnapshot
                                  ? `SKU ${line.saleItem.productSkuSnapshot}`
                                  : t("salesHistory.noSkuLabel")}
                                {line.isService && (
                                  <Badge tone="neutral">{t("returns.serviceTag")}</Badge>
                                )}
                                {fullyReturned && (
                                  <Badge tone="neutral">{t("returns.fullyReturnedTag")}</Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-2 text-end tabular-nums text-slate-700">
                              {soldUom} {uom}
                            </td>
                            <td className="px-4 py-2 text-end tabular-nums text-slate-500">
                              {returnedUom} {uom}
                            </td>
                            <td className="px-4 py-2 text-end tabular-nums font-medium text-slate-900">
                              {returnableUom} {uom}
                            </td>
                            <td className="px-4 py-2">
                              <input
                                type="number"
                                min={0}
                                max={returnableUom}
                                step={1}
                                disabled={fullyReturned}
                                value={st?.returnUomInput ?? ""}
                                onChange={(e) =>
                                  setLineState((prev) => ({
                                    ...prev,
                                    [id]: { ...prev[id], returnUomInput: e.target.value },
                                  }))
                                }
                                className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-end text-sm tabular-nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:bg-slate-50"
                                placeholder="0"
                              />
                            </td>
                            <td className="px-4 py-2 text-center">
                              {line.isService ? (
                                <span className="text-xs text-slate-400">—</span>
                              ) : (
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-slate-300"
                                  checked={st?.restock ?? false}
                                  disabled={returnUom <= 0}
                                  onChange={(e) =>
                                    setLineState((prev) => ({
                                      ...prev,
                                      [id]: { ...prev[id], restock: e.target.checked },
                                    }))
                                  }
                                />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Reason */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  {t("returns.reasonLabel")}
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder={t("returns.reasonPlaceholder")}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-soft focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
                />
              </div>

              {/* Totals */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1 rounded-lg border border-slate-200/70 bg-slate-50 p-3 text-sm">
                  <Row label={t("returns.subtotalExcl")} value={formatUsd(computed.subtotalExcl)} />
                  <Row label={t("returns.vatReversed")} value={formatUsd(computed.vat)} />
                  <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
                    <span>{t("returns.totalRefund")}</span>
                    <span className="tabular-nums">{formatUsd(total)}</span>
                  </div>
                  {rate && total > 0 && (
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>{t("returns.lbpEquivalent")}</span>
                      <span className="tabular-nums">
                        {formatLbp(usdCentsToLbp(total, rate.rateLbpPerUsd))}
                      </span>
                    </div>
                  )}
                </div>

                {/* Refund inputs */}
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-700">
                    {t("returns.refundTitle")}
                  </div>
                  <Input
                    label={t("returns.cashUsdRefund")}
                    inputMode="decimal"
                    placeholder="0.00"
                    prefix="$"
                    value={cashUsdInput}
                    onChange={(e) => editRefund(setCashUsdInput, e.target.value)}
                  />
                  <Input
                    label={rate ? t("returns.cashLbpRefund") : t("returns.cashLbpNoRate")}
                    inputMode="numeric"
                    placeholder={rate ? "0" : "—"}
                    suffix="L.L."
                    disabled={!rate}
                    value={cashLbpInput}
                    onChange={(e) => editRefund(setCashLbpInput, e.target.value)}
                    hint={
                      rate && refunds.cashLbp > 0
                        ? `≈ ${formatUsd(refunds.cashLbpAsUsd)}`
                        : undefined
                    }
                  />
                  <Input
                    label={t("returns.cardUsdRefund")}
                    inputMode="decimal"
                    placeholder="0.00"
                    prefix="$"
                    value={cardUsdInput}
                    onChange={(e) => editRefund(setCardUsdInput, e.target.value)}
                  />
                  <div className="space-y-1 rounded-lg border border-slate-200/70 bg-slate-50 p-3 text-sm">
                    <Row label={t("returns.allocated")} value={formatUsd(refunds.allocated)} />
                    {remaining > 0 ? (
                      <Row label={t("returns.remaining")} value={formatUsd(remaining)} tone="warn" />
                    ) : remaining < 0 ? (
                      <Row
                        label={t("returns.overAllocated")}
                        value={formatUsd(-remaining)}
                        tone="warn"
                      />
                    ) : null}
                  </div>
                </div>
              </div>

              {refunds.errors.length > 0 && (
                <p className="text-xs text-red-600">{refunds.errors[0]}</p>
              )}
              {submitError && <p className="text-xs text-red-600">{submitError}</p>}

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
                <Button variant="ghost" onClick={onClose}>
                  {t("returns.cancel")}
                </Button>
                <Button variant="primary" disabled={!canPost} onClick={handlePost}>
                  {submitting ? t("returns.posting") : t("returns.postReturn")}
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-600">{label}</span>
      <span
        className={clsx(
          "tabular-nums",
          tone === "warn" ? "font-medium text-amber-700" : "text-slate-900",
        )}
      >
        {value}
      </span>
    </div>
  );
}
