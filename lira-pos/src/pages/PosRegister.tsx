// src/pages/PosRegister.tsx
//
// POS Register — Phase 3 v1.
//
// Workflow:
//   1. Cashier scans a barcode (Enter submits) or picks via the search box.
//   2. The line is added to the cart, defaulting to qty=1 in the barcode's
//      UoM (or the product's default sale UoM if no barcode was used).
//   3. Cashier may bump qty up/down or remove a line.
//   4. Totals panel shows: subtotal excl-VAT, VAT, total incl-VAT, and the
//      LBP equivalent at the LOCKED rate read on form open.
//   5. Payment panel takes any combination of cash USD, cash LBP, and card USD.
//      Live: total paid (USD-equiv), remaining (USD + LBP), change (USD + LBP).
//   6. Post Sale → one Rust call → success banner with receipt number.
//
// Business rules enforced here (defense-in-depth; backend also re-checks):
//   - Only active products are sellable.
//   - Stock products must have at least one barcode (the ProductPicker and
//     findByScan path both rely on barcodes; products without any barcode
//     simply will not surface in search the way scans do, and we double-
//     check the primary barcode at add-time below).
//   - quantity_in_uom must be a positive integer.
//   - For stock products, quantity_base must not exceed quantity_on_hand.
//   - Cannot post an empty cart.
//   - LBP payments are blocked if there's no exchange rate set today.
//   - Total paid (USD-equiv) must be >= total invoice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo } from "../db/repos/products";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import { salesRepo, type PostSaleLineInput, type PostSalePaymentInput } from "../db/repos/sales";
import type {
  BarcodeScanResult,
  ExchangeRate,
  ProductUom,
  ProductWithUoms,
} from "../db/types";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ProductPicker } from "../components/ProductPicker";
import {
  formatLbp,
  formatRate,
  formatUsd,
  lbpToUsdCents,
  parseLbpInput,
  parseUsdInput,
  usdCentsToLbp,
} from "../lib/money";
import { computeSaleLineMath, type SaleLineMath } from "../lib/saleMath";
import { fromBaseQty } from "../lib/uom";
import { newId } from "../lib/ids";
import clsx from "clsx";

// ============================================================================
// Cart line shape
// ============================================================================

interface CartLine {
  /** Stable id for React keys + line edits (not the eventual sale_item id). */
  draftId: string;
  product: ProductWithUoms;
  /** Which UoM the cart line is denominated in. */
  uom: ProductUom;
  /** Quantity as typed by the cashier (positive integer in `uom`). */
  quantityInUom: number;
  /** Snapshot of which barcode was scanned (null if added via search). */
  barcodeUsed: string | null;
  barcodeType: string | null;
  /** Live math; never null because qty defaults to 1 on add. */
  math: SaleLineMath;
}

function lineMathFor(product: ProductWithUoms, uom: ProductUom, qty: number): SaleLineMath {
  return computeSaleLineMath({
    quantityInUom: qty,
    factor: uom.factor,
    vatBps: product.vatRate.rateBps,
    basePriceExclVatCents: product.priceExclVatCents,
    basePriceInclVatCents: product.priceInclVatCents,
    uomOverrideExclVatCents: uom.salePriceExclVatCents,
    uomOverrideInclVatCents: uom.salePriceInclVatCents,
  });
}

// ============================================================================
// Page
// ============================================================================

export default function PosRegister() {
  const { storeId, userId, hydrated } = useActiveContext();

  // Cart
  const [lines, setLines] = useState<CartLine[]>([]);

  // Exchange rate (read once on mount; locked into the sale at post time).
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);

  // Payments — three independent inputs. Empty string = "not entered".
  const [cashUsdInput, setCashUsdInput] = useState("");
  const [cashLbpInput, setCashLbpInput] = useState("");
  const [cardUsdInput, setCardUsdInput] = useState("");

  // Scan box
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // Post lifecycle
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justPosted, setJustPosted] = useState<{
    receiptNumber: number;
    changeUsdCents: number;
  } | null>(null);

  // ----- Hydrate rate once (and on demand if user just set one) -----
  const reloadRate = useCallback(async () => {
    if (!storeId) return;
    setRateError(null);
    try {
      const r = await exchangeRatesRepo.getCurrentForToday(storeId);
      setRate(r);
    } catch (e) {
      setRate(null);
      const msg = e instanceof Error ? e.message : String(e);
      setRateError(msg === "NO_EXCHANGE_RATE_SET" ? "NO_EXCHANGE_RATE_SET" : msg);
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) void reloadRate();
  }, [hydrated, reloadRate]);

  // ----- Scan handler -----
  async function handleScan() {
    const raw = scanInput.trim();
    if (!raw || !storeId) return;
    setScanError(null);
    try {
      const hit: BarcodeScanResult | null = await productsRepo.findByScan(storeId, raw);
      if (!hit) {
        setScanError(`No product matches barcode "${raw}".`);
        return;
      }
      addProductToCart(hit.product, hit.resolvedUom, {
        barcode: hit.matchedBarcode.barcode,
        barcodeType: hit.matchedBarcode.barcodeType,
      });
      setScanInput("");
      scanRef.current?.focus();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    }
  }

  // ----- Add a product via the search picker -----
  function handlePick(product: ProductWithUoms) {
    addProductToCart(product, product.defaultSaleUom, null);
    scanRef.current?.focus();
  }

  /**
   * Core cart-add logic. Reusable from scan and search paths.
   *
   * Rules:
   *   - Active products only.
   *   - Non-service products without a primary barcode are not sellable
   *     (catalog policy: "barcode-first" for stock items).
   *   - If the same (product, uom) is already in the cart, bump its qty
   *     by 1 rather than adding a duplicate row.
   *   - Stock cap: refuse to push qty_base beyond product.quantity_on_hand.
   */
  function addProductToCart(
    product: ProductWithUoms,
    uom: ProductUom,
    scanned: { barcode: string; barcodeType: string } | null,
  ) {
    setSubmitError(null);
    if (!product.isActive) {
      setScanError(`"${product.name}" is inactive and cannot be sold.`);
      return;
    }
    if (!product.isService && product.primaryBarcode === null) {
      setScanError(
        `"${product.name}" has no barcode. Add one in Products before selling.`,
      );
      return;
    }

    setLines((prev) => {
      const existingIdx = prev.findIndex(
        (l) => l.product.id === product.id && l.uom.id === uom.id,
      );
      if (existingIdx >= 0) {
        const next = prev.slice();
        const newQty = next[existingIdx].quantityInUom + 1;
        const probedBase = (newQty * uom.factor.num) / uom.factor.den;
        if (!product.isService && probedBase > product.quantityOnHand) {
          setScanError(
            `Only ${product.quantityOnHand} ${product.baseUom.uomCode} of "${product.name}" in stock.`,
          );
          return prev;
        }
        next[existingIdx] = {
          ...next[existingIdx],
          quantityInUom: newQty,
          math: lineMathFor(product, uom, newQty),
        };
        return next;
      }

      // New line. Default qty = 1.
      const math = lineMathFor(product, uom, 1);
      if (!product.isService && math.quantityBase > product.quantityOnHand) {
        setScanError(
          `Only ${product.quantityOnHand} ${product.baseUom.uomCode} of "${product.name}" in stock.`,
        );
        return prev;
      }
      const line: CartLine = {
        draftId: newId(),
        product,
        uom,
        quantityInUom: 1,
        barcodeUsed: scanned?.barcode ?? null,
        barcodeType: scanned?.barcodeType ?? null,
        math,
      };
      return [...prev, line];
    });
  }

  // ----- Edit a line's quantity -----
  function setLineQty(draftId: string, newQty: number) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.draftId !== draftId) return l;
        if (!Number.isInteger(newQty) || newQty <= 0) return l;
        const probedBase = (newQty * l.uom.factor.num) / l.uom.factor.den;
        if (!l.product.isService && probedBase > l.product.quantityOnHand) {
          setScanError(
            `Only ${l.product.quantityOnHand} ${l.product.baseUom.uomCode} of "${l.product.name}" in stock.`,
          );
          return l;
        }
        return {
          ...l,
          quantityInUom: newQty,
          math: lineMathFor(l.product, l.uom, newQty),
        };
      }),
    );
  }

  function removeLine(draftId: string) {
    setLines((prev) => prev.filter((l) => l.draftId !== draftId));
  }

  function clearCart() {
    setLines([]);
    setCashUsdInput("");
    setCashLbpInput("");
    setCardUsdInput("");
    setSubmitError(null);
    setScanError(null);
  }

  // ----- Totals -----
  const totals = useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    let total = 0;
    for (const l of lines) {
      subtotal += l.math.lineSubtotalExclVatCents;
      vat += l.math.lineVatCents;
      total += l.math.lineTotalInclVatCents;
    }
    return { subtotal, vat, total };
  }, [lines]);

  // Parse the three payment inputs into USD-cents equivalents.
  const payments = useMemo(() => {
    const errs: string[] = [];

    let cashUsdCents = 0;
    if (cashUsdInput.trim() !== "") {
      try {
        cashUsdCents = parseUsdInput(cashUsdInput);
      } catch {
        errs.push("Cash USD: not a valid amount.");
      }
    }

    let cashLbp = 0;
    if (cashLbpInput.trim() !== "") {
      if (!rate) {
        errs.push("Cash LBP: exchange rate not set.");
      } else {
        try {
          cashLbp = parseLbpInput(cashLbpInput);
        } catch {
          errs.push("Cash LBP: not a valid whole-lira amount.");
        }
      }
    }

    let cardUsdCents = 0;
    if (cardUsdInput.trim() !== "") {
      try {
        cardUsdCents = parseUsdInput(cardUsdInput);
      } catch {
        errs.push("Card USD: not a valid amount.");
      }
    }

    const cashLbpAsUsdCents =
      rate && cashLbp > 0 ? lbpToUsdCents(cashLbp, rate.rateLbpPerUsd) : 0;
    const totalPaidUsdCents = cashUsdCents + cashLbpAsUsdCents + cardUsdCents;

    return {
      cashUsdCents,
      cashLbp,
      cashLbpAsUsdCents,
      cardUsdCents,
      totalPaidUsdCents,
      errors: errs,
    };
  }, [cashUsdInput, cashLbpInput, cardUsdInput, rate]);

  const remainingCents = totals.total - payments.totalPaidUsdCents;
  const changeCents = payments.totalPaidUsdCents - totals.total;
  const isFullyPaid =
    lines.length > 0 && remainingCents <= 0 && payments.errors.length === 0;

  const canPost = !submitting && lines.length > 0 && isFullyPaid && rate !== null;

  // ----- Post -----
  async function handlePost() {
    if (!storeId || !rate) return;
    setSubmitError(null);
    if (lines.length === 0) {
      setSubmitError("Cart is empty.");
      return;
    }
    if (payments.errors.length > 0) {
      setSubmitError(payments.errors[0]);
      return;
    }
    if (payments.totalPaidUsdCents < totals.total) {
      setSubmitError(
        `Underpaid: tendered ${formatUsd(
          payments.totalPaidUsdCents,
        )}, total ${formatUsd(totals.total)}.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const linePayloads: Omit<PostSaleLineInput, "saleItemId">[] = lines.map((l) => ({
        productId: l.product.id,
        productNameSnapshot: l.product.name,
        productSkuSnapshot: l.product.sku,
        uomCodeSnapshot: l.uom.uomCode,
        factorNumSnapshot: l.uom.factor.num,
        factorDenSnapshot: l.uom.factor.den,
        quantityInUom: l.math.quantityInUom,
        quantityBase: l.math.quantityBase,
        unitPriceExclVatCents: l.math.unitPriceExclVatCents,
        unitPriceInclVatCents: l.math.unitPriceInclVatCents,
        vatRateIdSnapshot: l.product.vatRateId,
        vatRateBpsSnapshot: l.product.vatRate.rateBps,
        lineSubtotalExclVatCents: l.math.lineSubtotalExclVatCents,
        lineVatCents: l.math.lineVatCents,
        lineTotalInclVatCents: l.math.lineTotalInclVatCents,
        barcodeUsedSnapshot: l.barcodeUsed,
        barcodeTypeSnapshot: l.barcodeType,
        isService: l.product.isService,
      }));

      const paymentPayloads: Omit<PostSalePaymentInput, "paymentId">[] = [];
      if (payments.cashUsdCents > 0) {
        paymentPayloads.push({
          method: "cash_usd",
          currency: "USD",
          amountNativeUsdCents: payments.cashUsdCents,
          amountNativeLbp: 0,
          amountUsdCentsEquivalent: payments.cashUsdCents,
          reference: null,
        });
      }
      if (payments.cashLbp > 0) {
        paymentPayloads.push({
          method: "cash_lbp",
          currency: "LBP",
          amountNativeUsdCents: 0,
          amountNativeLbp: payments.cashLbp,
          amountUsdCentsEquivalent: payments.cashLbpAsUsdCents,
          reference: null,
        });
      }
      if (payments.cardUsdCents > 0) {
        paymentPayloads.push({
          method: "card_usd",
          currency: "USD",
          amountNativeUsdCents: payments.cardUsdCents,
          amountNativeLbp: 0,
          amountUsdCentsEquivalent: payments.cardUsdCents,
          reference: null,
        });
      }

      const result = await salesRepo.post({
        storeId,
        cashierUserId: userId,
        deviceId: null,
        shiftId: null, // Shifts wired in a later phase.
        exchangeRateId: rate.id,
        exchangeRateLbpPerUsd: rate.rateLbpPerUsd,
        notes: null,
        lines: linePayloads,
        payments: paymentPayloads,
      });

      setJustPosted({
        receiptNumber: result.receiptNumber,
        changeUsdCents: result.changeTotalUsdCents,
      });
      clearCart();
      // Dismiss the banner after a few seconds; the receipt # also lives
      // in Sales History.
      setTimeout(() => setJustPosted(null), 6000);
      scanRef.current?.focus();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // ============================================================================
  // Render
  // ============================================================================

  if (!hydrated) {
    return <div className="text-sm text-slate-500">Loading register…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">POS Register</h2>
          <p className="text-sm text-slate-600">
            Scan or search to add items, then take payment.
          </p>
        </div>
        {rate ? (
          <div className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm">
            <span className="font-medium text-slate-800">Rate locked:</span>{" "}
            {formatRate(rate.rateLbpPerUsd)}
          </div>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            No exchange rate — LBP payments disabled
          </div>
        )}
      </div>

      {justPosted && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          ✓ Posted Sale #{justPosted.receiptNumber}
          {justPosted.changeUsdCents > 0 && (
            <> · Change due: {formatUsd(justPosted.changeUsdCents)}</>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ─── LEFT: Scan + cart ───────────────────────────────────────── */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Add item" subtitle="Scan a barcode or search the catalog." />
            <CardBody className="space-y-3">
              <div className="flex gap-2">
                <input
                  ref={scanRef}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleScan();
                    }
                  }}
                  placeholder="Scan barcode…"
                  autoFocus
                  className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                />
                <Button variant="primary" onClick={handleScan} disabled={!scanInput.trim()}>
                  Add
                </Button>
              </div>
              <div>
                <p className="mb-1 text-xs text-slate-500">Or search by name / SKU:</p>
                <ProductPicker
                  storeId={storeId!}
                  onPick={handlePick}
                  excludeIds={[]}
                  placeholder="Type to search products…"
                />
              </div>
              {scanError && <p className="text-xs text-red-600">{scanError}</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Cart"
              subtitle={lines.length === 0 ? "Empty" : `${lines.length} line(s)`}
              actions={
                lines.length > 0 ? (
                  <Button variant="ghost" onClick={clearCart}>
                    Clear cart
                  </Button>
                ) : undefined
              }
            />
            {lines.length === 0 ? (
              <CardBody>
                <p className="text-sm text-slate-500">
                  Scan or search to add the first item.
                </p>
              </CardBody>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2">Product</th>
                      <th className="px-5 py-2">UoM</th>
                      <th className="px-5 py-2 text-right">Unit price (incl-VAT)</th>
                      <th className="px-5 py-2 text-center">Qty</th>
                      <th className="px-5 py-2 text-right">Line total</th>
                      <th className="px-5 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l) => (
                      <tr key={l.draftId}>
                        <td className="px-5 py-2">
                          <div className="font-medium text-slate-900">{l.product.name}</div>
                          <div className="text-xs text-slate-500">
                            {l.product.sku && <>SKU: {l.product.sku} · </>}
                            {!l.product.isService && (
                              <>
                                stock:{" "}
                                {fromBaseQty(l.product.quantityOnHand, l.uom.factor)}{" "}
                                {l.uom.uomCode}
                              </>
                            )}
                            {l.product.isService && (
                              <span className="italic">service</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-2 text-slate-600">{l.uom.uomCode}</td>
                        <td className="px-5 py-2 text-right text-slate-700">
                          {formatUsd(l.math.unitPriceInclVatCents)}
                        </td>
                        <td className="px-5 py-2 text-center">
                          <QuantityStepper
                            value={l.quantityInUom}
                            onChange={(n) => setLineQty(l.draftId, n)}
                          />
                        </td>
                        <td className="px-5 py-2 text-right font-medium text-slate-900">
                          {formatUsd(l.math.lineTotalInclVatCents)}
                        </td>
                        <td className="px-5 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeLine(l.draftId)}
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* ─── RIGHT: Totals + payment ─────────────────────────────────── */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Totals" />
            <CardBody className="space-y-2 text-sm">
              <TotalsRow label="Subtotal (excl-VAT)" value={formatUsd(totals.subtotal)} />
              <TotalsRow label="VAT" value={formatUsd(totals.vat)} />
              <div className="border-t border-slate-200 pt-2">
                <TotalsRow
                  label="Total (incl-VAT)"
                  value={formatUsd(totals.total)}
                  strong
                />
                {rate && (
                  <TotalsRow
                    label="= LBP equivalent"
                    value={formatLbp(usdCentsToLbp(totals.total, rate.rateLbpPerUsd))}
                    muted
                  />
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Payment" subtitle="Mix any combination of USD and LBP." />
            <CardBody className="space-y-3">
              <Input
                label="Cash USD received"
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cashUsdInput}
                onChange={(e) => setCashUsdInput(e.target.value)}
              />
              <Input
                label={`Cash LBP received${rate ? "" : " (no rate set)"}`}
                inputMode="numeric"
                placeholder={rate ? "0" : "—"}
                suffix="L.L."
                value={cashLbpInput}
                disabled={!rate}
                onChange={(e) => setCashLbpInput(e.target.value)}
                hint={
                  rate && payments.cashLbp > 0
                    ? `≈ ${formatUsd(payments.cashLbpAsUsdCents)}`
                    : undefined
                }
              />
              <Input
                label="Card USD received"
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cardUsdInput}
                onChange={(e) => setCardUsdInput(e.target.value)}
              />

              <div className="space-y-1 rounded-md bg-slate-50 p-3 text-sm">
                <TotalsRow
                  label="Total paid (USD-equiv)"
                  value={formatUsd(payments.totalPaidUsdCents)}
                />
                {remainingCents > 0 ? (
                  <>
                    <TotalsRow
                      label="Remaining"
                      value={formatUsd(remainingCents)}
                      tone="warn"
                    />
                    {rate && (
                      <TotalsRow
                        label="= LBP remaining"
                        value={formatLbp(usdCentsToLbp(remainingCents, rate.rateLbpPerUsd))}
                        tone="warn"
                        muted
                      />
                    )}
                  </>
                ) : changeCents > 0 ? (
                  <>
                    <TotalsRow
                      label="Change due"
                      value={formatUsd(changeCents)}
                      tone="good"
                      strong
                    />
                    {rate && (
                      <TotalsRow
                        label="= LBP change"
                        value={formatLbp(usdCentsToLbp(changeCents, rate.rateLbpPerUsd))}
                        tone="good"
                        muted
                      />
                    )}
                  </>
                ) : lines.length > 0 ? (
                  <TotalsRow label="Status" value="Exact payment" tone="good" />
                ) : null}
              </div>

              {payments.errors.length > 0 && (
                <p className="text-xs text-red-600">{payments.errors[0]}</p>
              )}
              {rateError === "NO_EXCHANGE_RATE_SET" && (
                <p className="text-xs text-amber-700">
                  No exchange rate is set for today. Set one in the Exchange Rate
                  page to enable LBP payments.
                </p>
              )}
              {submitError && <p className="text-xs text-red-600">{submitError}</p>}

              <Button
                variant="primary"
                className="w-full"
                disabled={!canPost}
                onClick={handlePost}
              >
                {submitting ? "Posting…" : "Post Sale"}
              </Button>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Small presentational helpers
// ============================================================================

function TotalsRow({
  label,
  value,
  strong,
  muted,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
  tone?: "good" | "warn";
}) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={clsx(
          "text-xs",
          muted ? "text-slate-400" : "text-slate-600",
          tone === "warn" && "text-amber-700",
          tone === "good" && "text-emerald-700",
        )}
      >
        {label}
      </span>
      <span
        className={clsx(
          "tabular-nums",
          strong ? "text-base font-semibold text-slate-900" : "text-sm",
          muted && !strong && "text-slate-500",
          tone === "warn" && !strong && "text-amber-800",
          tone === "good" && !strong && "text-emerald-800",
          tone === "warn" && strong && "text-amber-900",
          tone === "good" && strong && "text-emerald-900",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function QuantityStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= 1}
        className="h-7 w-7 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        aria-label="Decrease quantity"
      >
        −
      </button>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n > 0) onChange(n);
        }}
        className="h-7 w-12 rounded-md border border-slate-300 bg-white text-center text-sm tabular-nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="h-7 w-7 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50"
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}