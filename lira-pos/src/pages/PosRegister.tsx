// src/pages/PosRegister.tsx
//
// POS Register — Phase 3 v1.
//
// Workflow:
//   1. Cashier scans a barcode (Enter submits) or picks via the search box.
//   2. The line is added to the ACTIVE cart, defaulting to qty=1 in the
//      barcode's UoM (or the product's default sale UoM if no barcode was used).
//   3. Cashier may bump qty up/down or remove a line.
//   4. Totals panel shows: subtotal excl-VAT, VAT, total incl-VAT, and the
//      LBP equivalent at the LOCKED rate read on form open.
//   5. Payment panel takes any combination of cash USD, cash LBP, and card USD.
//      Live: total paid (USD-equiv), remaining (USD + LBP), change (USD + LBP).
//   6. Post Sale → one Rust call → success banner with receipt number.
//
// Multiple carts:
//   The cashier can park a cart and serve another customer. Each cart keeps its
//   own lines, discounts, and payment inputs. Scanning, F5-post, and posting
//   always act on the ACTIVE cart only. Carts are persisted to localStorage so
//   they survive page navigation within a session.
//
// POS setup (saved on this device via localStorage):
//   - Costing method (weighted_average | last_purchase). Default: last_purchase.
//   - Allow negative inventory (bool). Default: false.
//
// Business rules enforced here (defense-in-depth; backend also re-checks):
//   - Only active products are sellable.
//   - Stock products must have at least one barcode.
//   - quantity_in_uom must be a positive integer.
//   - For stock products, quantity_base must not exceed quantity_on_hand —
//     UNLESS "Allow negative inventory" is enabled in POS setup.
//   - Cannot post an empty cart.
//   - LBP payments are blocked if there's no exchange rate set today.
//   - Total paid (USD-equiv) must be >= total invoice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveContext } from "../state/activeContext";
import { productsRepo } from "../db/repos/products";
import { exchangeRatesRepo } from "../db/repos/exchangeRates";
import { salesRepo, type PostSaleLineInput, type PostSalePaymentInput } from "../db/repos/sales";
import { shiftsRepo } from "../db/repos/shifts";
import type {
  BarcodeScanResult,
  CogsMethod,
  ExchangeRate,
  ProductUom,
  ProductWithUoms,
  Shift,
  SaleWithDetails,
} from "../db/types";
import { query } from "../db/client";
import { ReceiptPrint } from "../components/ReceiptPrint";
import { Card, CardHeader, CardBody } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
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
import { fromBaseQty, type Factor } from "../lib/uom";
import { newId } from "../lib/ids";
import { useTranslation } from "../lib/i18n";
import clsx from "clsx";

// ============================================================================
// Safe stock display
// ============================================================================

/**
 * Format a (possibly negative or invalid) base stock quantity for UI display.
 *
 * `fromBaseQty` correctly rejects negative base quantities, but negative
 * inventory is an intended, supported condition (a product can be oversold
 * when negative inventory is allowed). This helper keeps the sign separate so
 * we only ever pass a non-negative value into `fromBaseQty`, and returns a
 * safe fallback for null/undefined/non-finite quantities — so one bad product
 * can never white-screen the POS page.
 *
 * Display-only: never use this in calculation or posting paths.
 */
function formatSignedStockQty(baseQty: number | null | undefined, factor: Factor): string {
  if (baseQty == null || !Number.isFinite(baseQty)) return "—";
  const sign = baseQty < 0 ? "-" : "";
  return `${sign}${fromBaseQty(Math.abs(baseQty), factor)}`;
}

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

// ============================================================================
// Cart state — one per open/parked cart
// ============================================================================

interface CartState {
  /** Stable id for React keys + active-cart selection. */
  id: string;
  /** Stable sequence number used for the "Cart N" label. */
  seq: number;
  lines: CartLine[];
  cashUsdInput: string;
  cashLbpInput: string;
  cardUsdInput: string;
  discountPctInput: string;
  discountAmountInput: string;
}

function createEmptyCart(seq: number): CartState {
  return {
    id: newId(),
    seq,
    lines: [],
    cashUsdInput: "",
    cashLbpInput: "",
    cardUsdInput: "",
    discountPctInput: "",
    discountAmountInput: "",
  };
}

// ============================================================================
// POS setup persistence (localStorage)
// ============================================================================

const COST_METHOD_KEY = "lira_pos_cost_method";
const ALLOW_NEG_KEY = "lira_pos_allow_negative_inventory";
const OPEN_CARTS_KEY = "lira_pos_open_carts";

function loadCostMethod(): CogsMethod {
  try {
    return localStorage.getItem(COST_METHOD_KEY) === "weighted_average"
      ? "weighted_average"
      : "last_purchase"; // default for a fresh install / no saved value
  } catch {
    return "last_purchase";
  }
}

function loadAllowNegative(): boolean {
  try {
    return localStorage.getItem(ALLOW_NEG_KEY) === "true"; // default false
  } catch {
    return false;
  }
}

function loadOpenCarts(): CartState[] {
  try {
    const raw = localStorage.getItem(OPEN_CARTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CartState[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((c) => c && c.id)) {
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  return [createEmptyCart(1)];
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

// Allocate a sale-level discount proportionally across lines by incl-VAT weight.
// Guarantees sum(result) === totalDiscountCents exactly via largest-remainder rounding.
function allocateLineDiscounts(lines: CartLine[], totalDiscountCents: number): number[] {
  if (lines.length === 0 || totalDiscountCents <= 0) return lines.map(() => 0);
  const preTotal = lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0);
  if (preTotal <= 0) return lines.map(() => 0);

  const allocated = lines.map((l) =>
    Math.floor((totalDiscountCents * l.math.lineTotalInclVatCents) / preTotal),
  );

  let remainder = totalDiscountCents - allocated.reduce((s, x) => s + x, 0);
  if (remainder > 0) {
    const sorted = lines
      .map((l, i) => ({ i, total: l.math.lineTotalInclVatCents }))
      .sort((a, b) => b.total - a.total);
    let idx = 0;
    while (remainder > 0) {
      allocated[sorted[idx % sorted.length].i]++;
      remainder--;
      idx++;
    }
  }
  return allocated;
}

// Back-calculate post-discount excl-VAT and VAT for a single line.
// Returns values that always satisfy: subtotalExclVat + vat === totalInclVat.
function postDiscountLineTotals(
  lineTotalInclVat: number,
  lineDiscountCents: number,
  vatBps: number,
): { subtotalExclVat: number; vat: number; totalInclVat: number } {
  const discountedTotal = lineTotalInclVat - lineDiscountCents;
  if (vatBps === 0) {
    return { subtotalExclVat: discountedTotal, vat: 0, totalInclVat: discountedTotal };
  }
  const subtotalExclVat = Math.round((discountedTotal * 10000) / (10000 + vatBps));
  return { subtotalExclVat, vat: discountedTotal - subtotalExclVat, totalInclVat: discountedTotal };
}

// ============================================================================
// Page
// ============================================================================

export default function PosRegister() {
  const { storeId, userId, hydrated } = useActiveContext();
  const { t } = useTranslation();

  // ----- Multi-cart state (loaded once from localStorage) -----
  const initialCartsRef = useRef<CartState[] | null>(null);
  if (initialCartsRef.current === null) initialCartsRef.current = loadOpenCarts();
  const [carts, setCarts] = useState<CartState[]>(initialCartsRef.current);
  const [activeCartId, setActiveCartId] = useState<string>(initialCartsRef.current[0].id);

  const activeCart = useMemo(
    () => carts.find((c) => c.id === activeCartId) ?? carts[0],
    [carts, activeCartId],
  );

  // Convenience views into the active cart.
  const lines = activeCart.lines;
  const { cashUsdInput, cashLbpInput, cardUsdInput, discountPctInput, discountAmountInput } =
    activeCart;

  // Persist carts (survives page navigation within a session).
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_CARTS_KEY, JSON.stringify(carts));
    } catch {
      /* ignore */
    }
  }, [carts]);

  // ----- POS setup -----
  const [costMethod, setCostMethod] = useState<CogsMethod>(loadCostMethod);
  const [allowNegativeInventory, setAllowNegativeInventory] = useState<boolean>(loadAllowNegative);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COST_METHOD_KEY, costMethod);
    } catch {
      /* ignore */
    }
  }, [costMethod]);

  useEffect(() => {
    try {
      localStorage.setItem(ALLOW_NEG_KEY, String(allowNegativeInventory));
    } catch {
      /* ignore */
    }
  }, [allowNegativeInventory]);

  // Active shift — null = no open shift; undefined = still loading
  const [activeShift, setActiveShift] = useState<Shift | null | undefined>(undefined);

  // Exchange rate (read once on mount; locked into the sale at post time).
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);

  // Scan box
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const focusScanInput = useCallback(() => {
    requestAnimationFrame(() => scanRef.current?.focus());
  }, []);

  // Store name (for receipt header)
  const [storeName, setStoreName] = useState("Store");

  // Post lifecycle
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receiptSale, setReceiptSale] = useState<SaleWithDetails | null>(null);

  // ----- Active-cart mutation helpers -----
  const updateActiveCart = useCallback(
    (updater: (c: CartState) => CartState) => {
      setCarts((prev) => prev.map((c) => (c.id === activeCartId ? updater(c) : c)));
    },
    [activeCartId],
  );

  const setLines = useCallback(
    (updater: (prev: CartLine[]) => CartLine[]) => {
      setCarts((prev) =>
        prev.map((c) => (c.id === activeCartId ? { ...c, lines: updater(c.lines) } : c)),
      );
    },
    [activeCartId],
  );

  const setCashUsdInput = useCallback(
    (v: string) => updateActiveCart((c) => ({ ...c, cashUsdInput: v })),
    [updateActiveCart],
  );
  const setCashLbpInput = useCallback(
    (v: string) => updateActiveCart((c) => ({ ...c, cashLbpInput: v })),
    [updateActiveCart],
  );
  const setCardUsdInput = useCallback(
    (v: string) => updateActiveCart((c) => ({ ...c, cardUsdInput: v })),
    [updateActiveCart],
  );
  const setDiscountPctInput = useCallback(
    (v: string) => updateActiveCart((c) => ({ ...c, discountPctInput: v })),
    [updateActiveCart],
  );
  const setDiscountAmountInput = useCallback(
    (v: string) => updateActiveCart((c) => ({ ...c, discountAmountInput: v })),
    [updateActiveCart],
  );

  useEffect(() => {
    if (!storeId || !hydrated) return;
    query<{ name: string }>("SELECT name FROM stores WHERE id = ? LIMIT 1", [storeId])
      .then((rows) => { if (rows[0]) setStoreName(rows[0].name); })
      .catch(() => {});
  }, [storeId, hydrated]);

  // ----- Hydrate rate and active shift on mount -----
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

  const reloadShift = useCallback(async () => {
    if (!storeId) return;
    try {
      const shift = await shiftsRepo.getOpenShift(storeId);
      setActiveShift(shift);
    } catch {
      setActiveShift(null);
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) {
      void reloadRate();
      void reloadShift();
    }
  }, [hydrated, reloadRate, reloadShift]);

  // ----- Scan handler -----
  async function handleScan() {
    const raw = scanInput.trim();
    if (!raw || !storeId) return;
    setScanError(null);
    try {
      const hit: BarcodeScanResult | null = await productsRepo.findByScan(storeId, raw);
      if (!hit) {
        setScanError(t("pos.errNoProductForBarcode", { barcode: raw }));
        return;
      }
      addProductToCart(hit.product, hit.resolvedUom, {
        barcode: hit.matchedBarcode.barcode,
        barcodeType: hit.matchedBarcode.barcodeType,
      });
      setScanInput("");
      focusScanInput();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    }
  }

  // ----- Add a product via the search picker -----
  function handlePick(product: ProductWithUoms) {
    addProductToCart(product, product.defaultSaleUom, null);
    focusScanInput();
  }

  /**
   * Core cart-add logic. Reusable from scan and search paths. Operates on the
   * ACTIVE cart only.
   *
   * Rules:
   *   - Active products only.
   *   - Non-service products without a primary barcode are not sellable
   *     (catalog policy: "barcode-first" for stock items).
   *   - If the same (product, uom) is already in the cart, bump its qty
   *     by 1 rather than adding a duplicate row.
   *   - Stock cap: refuse to push qty_base beyond product.quantity_on_hand,
   *     UNLESS "Allow negative inventory" is enabled in POS setup.
   */
  function addProductToCart(
    product: ProductWithUoms,
    uom: ProductUom,
    scanned: { barcode: string; barcodeType: string } | null,
  ) {
    setSubmitError(null);
    if (!product.isActive) {
      setScanError(t("pos.errInactiveProduct", { name: product.name }));
      return;
    }
    if (!product.isService && product.primaryBarcode === null) {
      setScanError(t("pos.errNoBarcode", { name: product.name }));
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
        if (!allowNegativeInventory && !product.isService && probedBase > product.quantityOnHand) {
          setScanError(
            t("pos.errStockExceeded", {
              qty: String(product.quantityOnHand),
              uom: product.baseUom.uomCode,
              name: product.name,
            }),
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
      if (!allowNegativeInventory && !product.isService && math.quantityBase > product.quantityOnHand) {
        setScanError(
          t("pos.errStockExceeded", {
            qty: String(product.quantityOnHand),
            uom: product.baseUom.uomCode,
            name: product.name,
          }),
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
        if (!allowNegativeInventory && !l.product.isService && probedBase > l.product.quantityOnHand) {
          setScanError(
            t("pos.errStockExceeded", {
              qty: String(l.product.quantityOnHand),
              uom: l.product.baseUom.uomCode,
              name: l.product.name,
            }),
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

  // Clear the ACTIVE cart's contents (lines, discounts, payments).
  function clearActiveCart() {
    updateActiveCart((c) => ({
      ...c,
      lines: [],
      cashUsdInput: "",
      cashLbpInput: "",
      cardUsdInput: "",
      discountPctInput: "",
      discountAmountInput: "",
    }));
    setSubmitError(null);
    setScanError(null);
  }

  // ----- Multi-cart controls -----
  function switchCart(id: string) {
    if (id === activeCartId) return;
    setActiveCartId(id);
    setSubmitError(null);
    setScanError(null);
    focusScanInput();
  }

  function addCart() {
    const nextSeq = carts.reduce((m, c) => Math.max(m, c.seq), 0) + 1;
    const cart = createEmptyCart(nextSeq);
    setCarts((prev) => [...prev, cart]);
    setActiveCartId(cart.id);
    setSubmitError(null);
    setScanError(null);
    focusScanInput();
  }

  function closeCart(id: string) {
    if (carts.length <= 1) return; // never delete the only remaining cart
    const cart = carts.find((c) => c.id === id);
    if (!cart) return;
    if (cart.lines.length > 0 && !window.confirm(t("pos.confirmCloseCart"))) return;

    const remaining = carts.filter((c) => c.id !== id);
    setCarts(remaining);
    if (id === activeCartId) {
      setActiveCartId(remaining[0].id);
      setSubmitError(null);
      setScanError(null);
      focusScanInput();
    }
  }

  // ----- Discount cents (derived from amount input; clamped so total stays ≥ 1 cent) -----
  const discountCents = useMemo(() => {
    const preTotal = lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0);
    if (preTotal <= 0 || !discountAmountInput.trim()) return 0;
    try {
      const raw = parseUsdInput(discountAmountInput);
      return Math.min(Math.max(raw, 0), Math.max(preTotal - 1, 0));
    } catch {
      return 0;
    }
  }, [discountAmountInput, lines]);

  // ----- Discount input handlers (keep % and $ in sync) -----
  function handleDiscountPctChange(value: string) {
    setDiscountPctInput(value);
    const preTotal = lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0);
    const pct = parseFloat(value);
    if (!isNaN(pct) && pct > 0 && preTotal > 0) {
      const cents = Math.min(Math.floor((preTotal * pct) / 100), Math.max(preTotal - 1, 0));
      setDiscountAmountInput(cents > 0 ? (cents / 100).toFixed(2) : "");
    } else {
      setDiscountAmountInput("");
    }
  }

  function handleDiscountAmountChange(value: string) {
    setDiscountAmountInput(value);
    const preTotal = lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0);
    if (!value.trim() || preTotal <= 0) {
      setDiscountPctInput("");
      return;
    }
    try {
      const cents = parseUsdInput(value);
      const clamped = Math.min(Math.max(cents, 0), Math.max(preTotal - 1, 0));
      const pct = Math.round((clamped / preTotal) * 10000) / 100;
      setDiscountPctInput(pct > 0 ? String(pct) : "");
    } catch {
      setDiscountPctInput("");
    }
  }

  // ----- Totals (all post-discount) -----
  const totals = useMemo(() => {
    const preDiscountSubtotalExclVat = lines.reduce(
      (s, l) => s + l.math.lineSubtotalExclVatCents, 0,
    );
    const preDiscountTotal = lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0);

    const lineAllocations = allocateLineDiscounts(lines, discountCents);

    let postDiscountSubtotalExclVat = 0;
    let postDiscountVat = 0;
    let postDiscountTotal = 0;

    for (let i = 0; i < lines.length; i++) {
      const pd = postDiscountLineTotals(
        lines[i].math.lineTotalInclVatCents,
        lineAllocations[i],
        lines[i].math.vatBps,
      );
      postDiscountSubtotalExclVat += pd.subtotalExclVat;
      postDiscountVat += pd.vat;
      postDiscountTotal += pd.totalInclVat;
    }

    return {
      preDiscountSubtotalExclVat,
      preDiscountTotal,
      discount: discountCents,
      postDiscountVat,
      postDiscountTotal,
      lineAllocations,
    };
  }, [lines, discountCents]);

  // Parse the three payment inputs into USD-cents equivalents.
  const payments = useMemo(() => {
    const errs: string[] = [];

    let cashUsdCents = 0;
    if (cashUsdInput.trim() !== "") {
      try {
        cashUsdCents = parseUsdInput(cashUsdInput);
      } catch {
        errs.push(t("pos.errCashUsdInvalid"));
      }
    }

    let cashLbp = 0;
    if (cashLbpInput.trim() !== "") {
      if (!rate) {
        errs.push(t("pos.errCashLbpNoRate"));
      } else {
        try {
          cashLbp = parseLbpInput(cashLbpInput);
        } catch {
          errs.push(t("pos.errCashLbpInvalid"));
        }
      }
    }

    let cardUsdCents = 0;
    if (cardUsdInput.trim() !== "") {
      try {
        cardUsdCents = parseUsdInput(cardUsdInput);
      } catch {
        errs.push(t("pos.errCardUsdInvalid"));
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
  }, [cashUsdInput, cashLbpInput, cardUsdInput, rate, t]);

  const remainingCents = totals.postDiscountTotal - payments.totalPaidUsdCents;
  const changeCents = payments.totalPaidUsdCents - totals.postDiscountTotal;

  const allPaymentsEmpty =
    cashUsdInput.trim() === "" &&
    cashLbpInput.trim() === "" &&
    cardUsdInput.trim() === "";
  const isAutoPayMode = allPaymentsEmpty && lines.length > 0 && totals.postDiscountTotal > 0;

  const isFullyPaid =
    lines.length > 0 &&
    payments.errors.length === 0 &&
    (isAutoPayMode || remainingCents <= 0);

  const canPost =
    !submitting &&
    lines.length > 0 &&
    isFullyPaid &&
    rate !== null &&
    !!activeShift;

  // ----- Post (active cart only) -----
  async function handlePost() {
    if (!storeId || !rate || !activeShift) return;
    setSubmitError(null);
    if (lines.length === 0) {
      setSubmitError(t("pos.errCartEmpty"));
      return;
    }
    if (payments.errors.length > 0) {
      setSubmitError(payments.errors[0]);
      return;
    }
    if (!isAutoPayMode && payments.totalPaidUsdCents < totals.postDiscountTotal) {
      setSubmitError(
        t("pos.errUnderpaid", {
          tendered: formatUsd(payments.totalPaidUsdCents),
          total: formatUsd(totals.postDiscountTotal),
        }),
      );
      return;
    }

    setSubmitting(true);
    try {
      // Build post-discount line payloads. Line values sent to Rust are post-discount
      // so that Rust sums produce the correct discounted header totals automatically.
      const linePayloads: Omit<PostSaleLineInput, "saleItemId">[] = lines.map((l, i) => {
        const lineDiscount = totals.lineAllocations[i];
        const pd = postDiscountLineTotals(
          l.math.lineTotalInclVatCents,
          lineDiscount,
          l.math.vatBps,
        );
        return {
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
          lineSubtotalExclVatCents: pd.subtotalExclVat,
          lineVatCents: pd.vat,
          lineTotalInclVatCents: pd.totalInclVat,
          lineDiscountCents: lineDiscount,
          barcodeUsedSnapshot: l.barcodeUsed,
          barcodeTypeSnapshot: l.barcodeType,
          isService: l.product.isService,
        };
      });

      const paymentPayloads: Omit<PostSalePaymentInput, "paymentId">[] = [];
      if (isAutoPayMode) {
        paymentPayloads.push({
          method: "cash_usd",
          currency: "USD",
          amountNativeUsdCents: totals.postDiscountTotal,
          amountNativeLbp: 0,
          amountUsdCentsEquivalent: totals.postDiscountTotal,
          reference: null,
        });
      } else {
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
      }

      const result = await salesRepo.post({
        storeId,
        cashierUserId: userId,
        deviceId: null,
        shiftId: activeShift.id,
        exchangeRateId: rate.id,
        exchangeRateLbpPerUsd: rate.rateLbpPerUsd,
        notes: null,
        cogsMethod: costMethod,
        discountCents: totals.discount,
        allowNegativeInventory,
        lines: linePayloads,
        payments: paymentPayloads,
      });

      const details = await salesRepo.findByIdWithDetails(result.saleId);
      clearActiveCart();
      setReceiptSale(details);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // ----- New sale (after receipt): hop to a parked cart if the current one is empty -----
  function handleNewSale() {
    setReceiptSale(null);
    const act = carts.find((c) => c.id === activeCartId);
    if (act && act.lines.length === 0) {
      const parked = carts.find((c) => c.id !== activeCartId && c.lines.length > 0);
      if (parked) setActiveCartId(parked.id);
    }
    focusScanInput();
  }

  // ----- F5 keyboard shortcut -----
  const canPostRef = useRef(canPost);
  canPostRef.current = canPost;
  const receiptOpenRef = useRef(receiptSale !== null);
  receiptOpenRef.current = receiptSale !== null;
  const handlePostRef = useRef<() => Promise<void>>(() => Promise.resolve());
  handlePostRef.current = handlePost;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "F5") return;
      if (e.repeat) return;
      e.preventDefault();
      if (receiptOpenRef.current) return;
      if (!canPostRef.current) return;
      void handlePostRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ============================================================================
  // Render
  // ============================================================================

  if (!hydrated) {
    return <div className="text-sm text-slate-500">{t("pos.loadingRegister")}</div>;
  }

  const costingMethodLabel =
    costMethod === "weighted_average" ? t("pos.weightedAverage") : t("pos.lastPurchase");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("pos.title")}
        subtitle={t("pos.subtitle")}
        actions={
          <>
            {rate ? (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-soft">
                <span className="font-semibold text-slate-800">{t("pos.rateLocked")}</span>{" "}
                <span className="tabular-nums">{formatRate(rate.rateLbpPerUsd)}</span>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800">
                {t("pos.noExchangeRate")}
              </div>
            )}
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-soft">
              <span className="font-semibold text-slate-800">{t("pos.costingLabel")}:</span>{" "}
              {costingMethodLabel}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>
              {t("pos.posSettings")}
            </Button>
          </>
        }
      />

      {/* Shift warning */}
      {activeShift === null && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-amber-500">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            <span className="font-semibold">{t("pos.noOpenShiftBold")}</span>{" "}
            {t("pos.goTo")} <strong>{t("nav.shiftSummary")}</strong> {t("pos.toOpenShift")}
          </span>
        </div>
      )}

      {/* Print-only receipt root — outside modal so print:hidden on the modal doesn't suppress it */}
      {receiptSale && (
        <div id="receipt-print-root" className="hidden print:block">
          <ReceiptPrint sale={receiptSale} storeName={storeName} />
        </div>
      )}

      {receiptSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm print:hidden">
          <div className="max-h-[90vh] w-full max-w-sm animate-scale-in overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <ReceiptPrint sale={receiptSale} storeName={storeName} />
            <div className="flex gap-2 border-t border-slate-200 p-4 print:hidden">
              <Button variant="primary" className="flex-1" onClick={() => window.print()}>
                {t("pos.printReceipt")}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={handleNewSale}>
                {t("pos.newSale")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* POS Register setup drawer */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-sm print:hidden"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="h-full w-full max-w-sm animate-fade-in overflow-y-auto border-slate-200 bg-white shadow-2xl ltr:border-l rtl:border-r"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{t("pos.setupTitle")}</h3>
                <p className="text-xs text-slate-500">{t("pos.setupSubtitle")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(false)}>
                {t("common.close")}
              </Button>
            </div>

            <div className="space-y-6 p-4">
              {/* Costing method */}
              <div className="space-y-2">
                <div>
                  <p className="text-sm font-medium text-slate-800">{t("pos.costMethodTitle")}</p>
                  <p className="text-xs text-slate-500">{t("pos.costMethodSubtitle")}</p>
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-3 text-sm transition-colors hover:bg-slate-50">
                  <input
                    type="radio"
                    name="cogs-method"
                    checked={costMethod === "weighted_average"}
                    onChange={() => setCostMethod("weighted_average")}
                    className="mt-1 accent-brand"
                  />
                  <span>
                    <span className="block font-medium text-slate-800">{t("pos.weightedAverage")}</span>
                    <span className="text-xs text-slate-500">{t("pos.weightedAverageDesc")}</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-3 text-sm transition-colors hover:bg-slate-50">
                  <input
                    type="radio"
                    name="cogs-method"
                    checked={costMethod === "last_purchase"}
                    onChange={() => setCostMethod("last_purchase")}
                    className="mt-1 accent-brand"
                  />
                  <span>
                    <span className="block font-medium text-slate-800">{t("pos.lastPurchase")}</span>
                    <span className="text-xs text-slate-500">{t("pos.lastPurchaseDesc")}</span>
                  </span>
                </label>
              </div>

              {/* Allow negative inventory */}
              <div className="border-t border-slate-200 pt-4">
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={allowNegativeInventory}
                    onChange={(e) => setAllowNegativeInventory(e.target.checked)}
                    className="mt-1 h-4 w-4 accent-brand"
                  />
                  <span>
                    <span className="block font-medium text-slate-800">
                      {t("pos.allowNegativeInventory")}
                    </span>
                    <span className="text-xs text-slate-500">
                      {t("pos.allowNegativeInventoryHelp")}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ─── LEFT: Scan + cart ───────────────────────────────────────── */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title={t("pos.addItemTitle")} subtitle={t("pos.addItemSubtitle")} />
            <CardBody className="space-y-3">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute inset-y-0 flex items-center text-slate-400 ltr:left-3.5 rtl:right-3.5">
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                      <path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </span>
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
                    placeholder={t("pos.scanBarcodePlaceholder")}
                    autoFocus
                    className="w-full rounded-lg border border-slate-300 bg-white py-2.5 text-base shadow-soft transition-colors hover:border-slate-400 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 ltr:pl-11 ltr:pr-3 rtl:pr-11 rtl:pl-3"
                  />
                </div>
                <Button variant="primary" onClick={handleScan} disabled={!scanInput.trim()}>
                  {t("common.add")}
                </Button>
              </div>
              <div>
                <p className="mb-1 text-xs text-slate-500">{t("pos.orSearchByName")}</p>
                <ProductPicker
                  storeId={storeId!}
                  onPick={handlePick}
                  excludeIds={[]}
                  placeholder={t("pos.searchProductsPlaceholder")}
                />
              </div>
              {scanError && <p className="text-xs text-red-600">{scanError}</p>}
            </CardBody>
          </Card>

          {/* Cart tabs */}
          <div className="flex flex-wrap items-center gap-2">
            {carts.map((c) => {
              const isActive = c.id === activeCartId;
              return (
                <div
                  key={c.id}
                  className={clsx(
                    "inline-flex items-center rounded-lg border shadow-soft transition-colors",
                    isActive
                      ? "border-brand bg-brand/10 ring-1 ring-brand/20"
                      : "border-slate-200 bg-white hover:bg-slate-50",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => switchCart(c.id)}
                    className={clsx(
                      "px-3 py-1.5 text-sm",
                      isActive ? "font-semibold text-brand" : "text-slate-700",
                    )}
                  >
                    {t("pos.cartLabel", { n: String(c.seq) })}
                    {c.lines.length > 0 ? (
                      <span className="tabular-nums"> ({c.lines.length})</span>
                    ) : (
                      <span className="text-slate-400"> · {t("pos.cartEmpty")}</span>
                    )}
                  </button>
                  {carts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => closeCart(c.id)}
                      aria-label={t("pos.closeCart")}
                      title={t("pos.closeCart")}
                      className="px-2 py-1.5 text-slate-400 hover:text-red-600"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            <Button variant="secondary" size="sm" onClick={addCart}>
              + {t("pos.newCart")}
            </Button>
          </div>

          <Card>
            <CardHeader
              title={t("pos.cartTitle")}
              subtitle={
                lines.length === 0
                  ? t("pos.cartEmpty")
                  : t("pos.cartLinesCount", { count: String(lines.length) })
              }
              actions={
                lines.length > 0 ? (
                  <Button variant="ghost" onClick={() => { clearActiveCart(); focusScanInput(); }}>
                    {t("pos.clearCart")}
                  </Button>
                ) : undefined
              }
            />
            {lines.length === 0 ? (
              <EmptyState
                title={t("pos.cartEmptyMessage")}
                icon={
                  <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
                    <path d="M3 6h18l-1.5 9h-12L6 6Zm0 0L5 3H2m6 18a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50/80 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2.5 font-semibold">{t("pos.colProduct")}</th>
                      <th className="px-5 py-2.5 font-semibold">{t("pos.colUom")}</th>
                      <th className="px-5 py-2.5 text-end font-semibold">{t("pos.colUnitPrice")}</th>
                      <th className="px-5 py-2.5 text-center font-semibold">{t("pos.colQty")}</th>
                      <th className="px-5 py-2.5 text-end font-semibold">{t("pos.colLineTotal")}</th>
                      <th className="px-5 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l) => (
                      <tr key={l.draftId} className="transition-colors hover:bg-slate-50/70">
                        <td className="px-5 py-3">
                          <div className="font-medium text-slate-900">{l.product.name}</div>
                          <div className="text-xs text-slate-500">
                            {l.product.sku && <>SKU: {l.product.sku} · </>}
                            {!l.product.isService && (
                              <>
                                {t("pos.stockLabel")}{" "}
                                {formatSignedStockQty(l.product.quantityOnHand, l.uom.factor)}{" "}
                                {l.uom.uomCode}
                              </>
                            )}
                            {l.product.isService && (
                              <span className="italic">{t("pos.serviceLabel")}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-slate-600">{l.uom.uomCode}</td>
                        <td className="px-5 py-3 text-end tabular-nums text-slate-700">
                          {formatUsd(l.math.unitPriceInclVatCents)}
                        </td>
                        <td className="px-5 py-3 text-center">
                          <QuantityStepper
                            value={l.quantityInUom}
                            onChange={(n) => setLineQty(l.draftId, n)}
                            onAfterStep={focusScanInput}
                          />
                        </td>
                        <td className="px-5 py-3 text-end font-semibold tabular-nums text-slate-900">
                          {formatUsd(l.math.lineTotalInclVatCents)}
                        </td>
                        <td className="px-5 py-3 text-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { removeLine(l.draftId); focusScanInput(); }}
                          >
                            {t("common.remove")}
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
            <CardHeader title={t("pos.totalsTitle")} />
            <CardBody className="space-y-3 text-sm">
              {/* Discount inputs */}
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-600">
                  {t("pos.discountSectionTitle")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="min-w-0">
                    <Input
                      label={t("pos.discountPct")}
                      inputMode="decimal"
                      placeholder="0"
                      suffix="%"
                      value={discountPctInput}
                      onChange={(e) => handleDiscountPctChange(e.target.value)}
                    />
                  </div>
                  <div className="min-w-0">
                    <Input
                      label={t("pos.discountAmt")}
                      inputMode="decimal"
                      placeholder="0.00"
                      prefix="$"
                      value={discountAmountInput}
                      onChange={(e) => handleDiscountAmountChange(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <TotalsRow
                  label={t("pos.subtotalExclVat")}
                  value={formatUsd(totals.preDiscountSubtotalExclVat)}
                />
                {totals.discount > 0 && (
                  <TotalsRow
                    label={t("pos.discount")}
                    value={`-${formatUsd(totals.discount)}`}
                    tone="warn"
                  />
                )}
                <TotalsRow label={t("pos.vat")} value={formatUsd(totals.postDiscountVat)} />
              </div>

              <div className="-mx-5 -mb-5 mt-1 rounded-b-xl border-t border-slate-200 bg-slate-50/70 px-5 py-4">
                <div className="flex items-end justify-between gap-3">
                  <span className="text-sm font-medium text-slate-600">
                    {t("pos.totalInclVat")}
                  </span>
                  <span className="text-3xl font-bold tabular-nums tracking-tight text-slate-900">
                    {formatUsd(totals.postDiscountTotal)}
                  </span>
                </div>
                {rate && (
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                    <span>{t("pos.lbpEquivalent")}</span>
                    <span className="tabular-nums">
                      {formatLbp(usdCentsToLbp(totals.postDiscountTotal, rate.rateLbpPerUsd))}
                    </span>
                  </div>
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t("pos.paymentTitle")} subtitle={t("pos.paymentSubtitle")} />
            <CardBody className="space-y-3">
              <Input
                label={t("pos.cashUsdReceived")}
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cashUsdInput}
                onChange={(e) => setCashUsdInput(e.target.value)}
              />
              <Input
                label={rate ? t("pos.cashLbpReceived") : t("pos.cashLbpNoRate")}
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
                label={t("pos.cardUsdReceived")}
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cardUsdInput}
                onChange={(e) => setCardUsdInput(e.target.value)}
              />

              <div className="space-y-1 rounded-lg border border-slate-200/70 bg-slate-50 p-3 text-sm">
                <TotalsRow
                  label={t("pos.totalPaidUsdEquiv")}
                  value={formatUsd(payments.totalPaidUsdCents)}
                />
                {remainingCents > 0 ? (
                  <>
                    <TotalsRow
                      label={t("pos.remaining")}
                      value={formatUsd(remainingCents)}
                      tone="warn"
                    />
                    {rate && (
                      <TotalsRow
                        label={t("pos.lbpRemaining")}
                        value={formatLbp(usdCentsToLbp(remainingCents, rate.rateLbpPerUsd))}
                        tone="warn"
                        muted
                      />
                    )}
                  </>
                ) : changeCents > 0 ? (
                  <>
                    <TotalsRow
                      label={t("pos.changeDue")}
                      value={formatUsd(changeCents)}
                      tone="good"
                      strong
                    />
                    {rate && (
                      <TotalsRow
                        label={t("pos.lbpChange")}
                        value={formatLbp(usdCentsToLbp(changeCents, rate.rateLbpPerUsd))}
                        tone="good"
                        muted
                      />
                    )}
                  </>
                ) : lines.length > 0 ? (
                  <TotalsRow label={t("pos.statusLabel")} value={t("pos.exactPayment")} tone="good" />
                ) : null}
              </div>

              {payments.errors.length > 0 && (
                <p className="text-xs text-red-600">{payments.errors[0]}</p>
              )}
              {rateError === "NO_EXCHANGE_RATE_SET" && (
                <p className="text-xs text-amber-700">{t("pos.noRateHint")}</p>
              )}
              {submitError && <p className="text-xs text-red-600">{submitError}</p>}

              <Button
                variant="primary"
                className="w-full py-3 text-base"
                disabled={!canPost}
                onClick={handlePost}
              >
                {submitting ? t("pos.posting") : t("pos.postSale")}
                {!submitting && (
                  <kbd className="ms-2 rounded border border-white/30 bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none">
                    F5
                  </kbd>
                )}
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
  onAfterStep,
}: {
  value: number;
  onChange: (n: number) => void;
  onAfterStep?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white shadow-soft">
      <button
        type="button"
        onClick={() => { onChange(value - 1); onAfterStep?.(); }}
        disabled={value <= 1}
        className="flex h-8 w-8 items-center justify-center text-lg text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40 ltr:rounded-l-lg rtl:rounded-r-lg"
        aria-label={t("pos.decreaseQty")}
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
        className="h-8 w-11 border-x border-slate-200 bg-white text-center text-sm font-medium tabular-nums focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand/30"
      />
      <button
        type="button"
        onClick={() => { onChange(value + 1); onAfterStep?.(); }}
        className="flex h-8 w-8 items-center justify-center text-lg text-slate-600 transition-colors hover:bg-slate-100 ltr:rounded-r-lg rtl:rounded-l-lg"
        aria-label={t("pos.increaseQty")}
      >
        +
      </button>
    </div>
  );
}
