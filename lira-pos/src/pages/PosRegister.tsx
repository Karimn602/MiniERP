// src/pages/PosRegister.tsx
//
// POS Register — Phase 3 v1.
//
// Workflow (restaurant-first since the Greaz UX pass):
//   1. Cashier CLICKS the item the customer ordered on the menu tile grid.
//      Clicking the same tile again increments that line — it is the same
//      `addProductToCart` the scanner has always used, so there are no second
//      cart semantics to keep in step. Typing in the menu filter narrows the
//      grid; a barcode scan (secondary, collapsed) and the name search still
//      reach the identical function.
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
//   - quantity_in_uom must be a positive integer.
//   - For stock products, quantity_base must not exceed quantity_on_hand —
//     UNLESS "Allow negative inventory" is enabled in POS setup.
//   - Cannot post an empty cart.
//   - LBP payments are blocked if there's no exchange rate set today.
//   - Total paid (USD-equiv) must be >= total invoice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { ProductPicker } from "../components/ProductPicker";
import { MenuTile } from "../components/pos/MenuTile";
import { MenuPane, MenuChip } from "../components/pos/MenuPane";
import {
  AmountLine,
  CartLineRow,
  RailHeading,
  ShiftChip,
  TinyButton,
  TotalBlock,
} from "../components/pos/OrderRail";
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
import {
  MENU_GROUP_ALL,
  deriveMenuGroups,
  filterMenu,
  filterMenuByGroup,
  isMenuOutOfStock,
  isMenuSellable,
  menuTilePriceInclVatCents,
  sortMenu,
} from "../lib/menuGrid";
import { allocateLineDiscounts, postDiscountLineTotals } from "../lib/discount";
import {
  createCheckoutRegistry,
  createSubmissionGate,
  type CheckoutRegistry,
  type SubmissionGate,
} from "../lib/checkout";
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
  /**
   * Checkout identity for this cart's current checkout attempt — the `saleId`
   * sent to `post_sale`. Minted on the first Post press and reused by every
   * retry of that attempt, which is what makes the backend able to recognise a
   * retry (see `salesRepo.post`). Retired once the sale posts, so the next
   * customer is a new transaction. Persisted with the cart, so a parked cart
   * keeps its identity across a reload.
   */
  checkoutId?: string;
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

  // ----- Menu tile grid (the primary way a Greaz cashier adds items) -----
  const [menu, setMenu] = useState<ProductWithUoms[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [menuFilter, setMenuFilter] = useState("");
  const [menuGroupId, setMenuGroupId] = useState<string>(MENU_GROUP_ALL);

  // Barcode is TERTIARY here: collapsed by default so it does not hold the
  // focus or the eye on a till where nothing gets scanned.
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  // Discount is likewise folded away until asked for, so it stops occupying
  // prime selling space and stops inviting an accidental discount.
  const [discountOpen, setDiscountOpen] = useState(false);

  // Scan box
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // Only meaningful while the barcode panel is open — when it is closed the ref
  // is null and this is a no-op, which is what we want: a restaurant cashier
  // should not have the caret parked in a scanner field.
  const focusScanInput = useCallback(() => {
    requestAnimationFrame(() => scanRef.current?.focus());
  }, []);

  // Store name (for receipt header)
  const [storeName, setStoreName] = useState("Store");

  // Post lifecycle
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receiptSale, setReceiptSale] = useState<SaleWithDetails | null>(null);
  /**
   * Which cart, if any, has a post that has not resolved yet. Mirrors the
   * registry's own in-flight flag so the UI can disable that cart's Clear and
   * Close — the registry is a ref and cannot trigger a rerender on its own.
   */
  const [postingCartId, setPostingCartId] = useState<string | null>(null);

  // Synchronous submission safety — see lib/checkout.ts for why React state
  // cannot do this job. The gate drops a second entry in the same frame; the
  // registry keeps one checkout identity per cart across retries.
  const gateRef = useRef<SubmissionGate | null>(null);
  if (gateRef.current === null) gateRef.current = createSubmissionGate();

  const checkoutsRef = useRef<CheckoutRegistry | null>(null);
  if (checkoutsRef.current === null) {
    checkoutsRef.current = createCheckoutRegistry(
      newId,
      Object.fromEntries(
        initialCartsRef.current
          .filter((c) => c.checkoutId)
          .map((c) => [c.id, c.checkoutId as string]),
      ),
    );
  }

  // ----- Cart mutation helpers -----
  const updateCartById = useCallback(
    (cartId: string, updater: (c: CartState) => CartState) => {
      setCarts((prev) => prev.map((c) => (c.id === cartId ? updater(c) : c)));
    },
    [],
  );

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

  /**
   * Load the sellable menu.
   *
   * `listEnriched` is the existing read-only repo call and already filters to
   * `is_active = 1`; `isMenuSellable` re-checks client-side so a tile can never
   * outlive a deactivation in a stale list. Reloaded after every posted sale
   * because `quantity_on_hand` has moved and the out-of-stock tiles with it.
   */
  const reloadMenu = useCallback(async () => {
    setMenuError(null);
    try {
      // Guarded inside the try so the `finally` always clears the loading flag.
      // Returning early above it would strand the grid on "Loading menu…".
      if (!storeId) return;
      const rows = await productsRepo.listEnriched({ storeId });
      setMenu(sortMenu(rows.filter(isMenuSellable)));
    } catch (e) {
      // One unloadable product throws for the whole list (productsRepo.enrich
      // refuses a product with no base or default sale UoM). Report it instead
      // of white-screening the till — the cashier can still scan and search.
      setMenu([]);
      setMenuError(e instanceof Error ? e.message : String(e));
    } finally {
      setMenuLoading(false);
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
      void reloadMenu();
    }
  }, [hydrated, reloadRate, reloadShift, reloadMenu]);

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
   * Add a product by clicking its menu tile — the primary Greaz gesture.
   *
   * Nothing special: the product's own default sale UoM, qty 1, no barcode.
   * Clicking the same tile again lands on `addProductToCart`'s existing
   * "already in the cart → bump the qty" branch, which is why repeat-clicking
   * increments instead of stacking duplicate rows.
   */
  function handleTileClick(product: ProductWithUoms) {
    addProductToCart(product, product.defaultSaleUom, null);
  }

  /** Chips above the grid. See `deriveMenuGroups` for why these are not
   *  "Burgers / Wraps / Drinks" yet. */
  const menuGroups = useMemo(
    () => deriveMenuGroups(menu, allowNegativeInventory),
    [menu, allowNegativeInventory],
  );

  /** The tiles actually shown: group chip first, then the text filter. */
  const visibleMenu = useMemo(
    () => filterMenu(filterMenuByGroup(menu, menuGroupId, allowNegativeInventory), menuFilter),
    [menu, menuGroupId, allowNegativeInventory, menuFilter],
  );

  /**
   * Core cart-add logic. Reusable from scan and search paths. Operates on the
   * ACTIVE cart only.
   *
   * Rules:
   *   - Active products only.
   *   - If the same (product, uom) is already in the cart, bump its qty
   *     by 1 rather than adding a duplicate row. This is what makes clicking a
   *     menu tile twice mean "two of those" — the tile path adds nothing new,
   *     it just calls this.
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
    // NOTE — a stocked product used to be refused here unless it carried a
    // primary barcode ("barcode-first" catalog policy). That rule made a
    // restaurant menu unsellable: a Double has no barcode, so every burger was
    // refused by every path, tile, search and scan alike. It was a FRONTEND
    // policy only — `post_sale` treats `barcode_used_snapshot` as an optional
    // receipt snapshot (`Option<String>`) and has never required or validated
    // one — so dropping it changes no payload, no posting rule and no catalog
    // semantics. A tile adds a line with `barcodeUsed: null`, exactly as the
    // name-search path already did for services.

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

  // Clear one cart's contents (lines, discounts, payments) and retire its
  // checkout identity: whatever it held is finished, so the next basket in this
  // cart is a new transaction.
  //
  // Refused while that cart's post is unresolved. If the backend committed but
  // the answer was lost, the identity is the only thing that lets the retry
  // reconcile to the sale that exists; retiring it here would ring the same
  // basket up a second time. The button is disabled in that window too — this
  // check covers every other path to the same function.
  function clearCart(cartId: string) {
    if (checkoutsRef.current?.isPosting(cartId)) return;
    checkoutsRef.current?.retire(cartId);
    updateCartById(cartId, (c) => ({
      ...c,
      lines: [],
      cashUsdInput: "",
      cashLbpInput: "",
      cardUsdInput: "",
      discountPctInput: "",
      discountAmountInput: "",
      checkoutId: undefined,
    }));
    setSubmitError(null);
    setScanError(null);
  }

  function clearActiveCart() {
    clearCart(activeCartId);
  }

  /**
   * Open a posting attempt on this cart and return its checkout identity,
   * minting one if this is the first attempt. Synchronous: two handlers
   * entering in the same frame get the SAME id, so even if both reached the
   * backend they would be one checkout there.
   *
   * The attempt is marked unresolved until `settleAttempt`, which is what
   * makes the identity un-retirable in the meantime.
   */
  /** Mark this cart's posting attempt resolved. Safe to call more than once. */
  function settleCheckoutAttempt(cartId: string) {
    checkoutsRef.current!.settleAttempt(cartId);
    setPostingCartId((current) => (current === cartId ? null : current));
  }

  function beginCheckoutAttempt(cartId: string): string {
    const { id, issued } = checkoutsRef.current!.beginAttempt(cartId);
    setPostingCartId(cartId);
    // Persist a newly minted identity with the cart, so a parked cart keeps it
    // across a reload.
    if (issued) updateCartById(cartId, (c) => ({ ...c, checkoutId: id }));
    return id;
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
    // Closing a cart mid-post would discard the identity its unresolved
    // attempt still needs — see clearCart. Disabled in the UI; guarded here.
    if (checkoutsRef.current?.isPosting(id)) return;
    const cart = carts.find((c) => c.id === id);
    if (!cart) return;
    if (cart.lines.length > 0 && !window.confirm(t("pos.confirmCloseCart"))) return;

    checkoutsRef.current?.retire(id);
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

    // A card may never be charged more than the bill (WP-04, GZ-HI-04): change
    // is cash out of the drawer, and there is no card refund to give. The
    // backend refuses this outright; catching it here is what keeps the Post
    // button honest instead of letting the cashier swipe and then fail.
    if (cardUsdCents > totals.postDiscountTotal && totals.postDiscountTotal > 0) {
      errs.push(
        t("pos.errCardOverpaid", {
          card: formatUsd(cardUsdCents),
          total: formatUsd(totals.postDiscountTotal),
        }),
      );
    }

    return {
      cashUsdCents,
      cashLbp,
      cashLbpAsUsdCents,
      cardUsdCents,
      totalPaidUsdCents,
      errors: errs,
    };
  }, [cashUsdInput, cashLbpInput, cardUsdInput, rate, totals.postDiscountTotal, t]);

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
  //
  // Two guards, in this order:
  //   1. the submission gate — synchronous, drops a second entry in the same
  //      frame (double-click, or a click and an F5 together).
  //   2. the checkout identity — reused by every retry, so the backend
  //      recognises one and returns the sale that exists.
  // Only the second is authoritative; the first just keeps the UI honest.
  async function handlePost() {
    const gate = gateRef.current!;
    if (!gate.tryEnter()) return;
    try {
      await runPost();
    } finally {
      gate.release();
    }
  }

  async function runPost() {
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

    // The cart this attempt belongs to, and its checkout identity. Both are
    // captured now: the cashier may switch carts while the post is in flight,
    // and the sale that comes back belongs to THIS cart.
    const cartId = activeCartId;
    const checkoutId = beginCheckoutAttempt(cartId);

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
        saleId: checkoutId,
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
      // Definitive success. Settle the attempt FIRST — clearCart refuses to
      // retire the identity of a cart that is still posting — then clear.
      settleCheckoutAttempt(cartId);
      clearCart(cartId);
      setReceiptSale(details);
      // Stock moved, so the grid's out-of-stock tiles are stale. Fire and
      // forget: a failed refresh must not turn a posted sale into an error.
      void reloadMenu();
    } catch (e) {
      // Definitive failure. The identity is deliberately KEPT: if the cashier
      // fixes the problem and posts again, that is the same checkout, and if
      // the sale actually did commit before the error reached us, the retry
      // reconciles to it instead of ringing it up twice.
      settleCheckoutAttempt(cartId);
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      // Idempotent; the success and failure paths have normally settled
      // already. Here so no path can leave a cart wedged as "posting".
      settleCheckoutAttempt(cartId);
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
    return <div className="text-sm text-fg-muted">{t("pos.loadingRegister")}</div>;
  }

  const costingMethodLabel =
    costMethod === "weighted_average" ? t("pos.weightedAverage") : t("pos.lastPurchase");

  return (
    <div className="flex flex-col gap-3.5 squat:gap-2 tiny:gap-1.5 lg:min-h-0 lg:flex-1">
      {/* The POS is the one HERO screen — the approved restaurant banner.
          Warm paper inside a border with a red kicker on Classic, a solid
          #BD1029 field on Midnight; one component, two token sets. Every other
          page keeps the plain header, so the band means "you are selling"
          rather than "this app has a coloured header". */}
      <PageHeader
        variant="hero"
        eyebrow={t("pos.eyebrow")}
        title={t("pos.title")}
        subtitle={t("pos.subtitle")}
        actions={
          <>
            {/* The prototype's status chip. The dot is green on an open shift
                and amber when the till is blocked, so the state of the
                register is readable from across the counter. */}
            <ShiftChip
              tone={activeShift === null ? "warn" : "good"}
              title={
                activeShift === null ? t("pos.noOpenShiftBold") : t("pos.shiftOpenChip")
              }
              detail={
                rate
                  ? `${formatRate(rate.rateLbpPerUsd)} · ${costingMethodLabel}`
                  : t("pos.noExchangeRate")
              }
            />
            <TinyButton onClick={() => setSettingsOpen(true)}>
              {t("pos.posSettings")}
            </TinyButton>
          </>
        }
      />

      {/* Shift warning — unchanged in force, and now it carries the way out.
          A novice should not have to hunt the sidebar for the page that unblocks
          the till. The link NAVIGATES only; nothing here opens a shift. */}
      {activeShift === null && (
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-warn-line bg-warn-bg px-4 py-2.5 text-sm text-warn-fg">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0 text-warn-fg">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="flex-1">
            <span className="font-semibold">{t("pos.noOpenShiftBold")}</span>{" "}
            {t("pos.goTo")} <strong>{t("nav.shiftSummary")}</strong> {t("pos.toOpenShift")}
          </span>
          <Link
            to="/shift"
            className="inline-flex shrink-0 items-center justify-center rounded-chip bg-warn px-3 py-1.5 text-xs font-bold text-ink-900 shadow-soft transition-colors hover:brightness-95"
          >
            {t("pos.openShiftAction")}
          </Link>
        </div>
      )}

      {/* No-rate warning. This used to be a small header chip reading "LBP
          payments disabled", which understated it: `post_sale` locks an exchange
          rate on EVERY sale, so without one nothing can post — a pure USD-cash
          sale included. The requirement is unchanged; only the sentence now
          matches it. Suppressed while the shift banner is already showing, so a
          cold start does not stack two red walls above the menu. */}
      {rate === null && activeShift !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-warn-line bg-warn-bg px-4 py-2.5 text-sm text-warn-fg">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0 text-warn-fg">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="flex-1">
            <span className="font-semibold">{t("pos.noRateTitle")}</span>{" "}
            {t("pos.noRateBody")}
          </span>
          <Link
            to="/exchange-rate"
            className="inline-flex shrink-0 items-center justify-center rounded-chip bg-warn px-3 py-1.5 text-xs font-bold text-ink-900 shadow-soft transition-colors hover:brightness-95"
          >
            {t("pos.goToExchangeRate")}
          </Link>
        </div>
      )}

      {/* Print-only receipt root — outside modal so print:hidden on the modal doesn't suppress it */}
      {receiptSale && (
        <div id="receipt-print-root" className="hidden print:block">
          <ReceiptPrint sale={receiptSale} storeName={storeName} />
        </div>
      )}

      {receiptSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4 backdrop-blur-sm print:hidden">
          <div className="greaz-paper-doc max-h-[90vh] w-full max-w-sm animate-scale-in overflow-y-auto rounded-panel shadow-2xl">
            <ReceiptPrint sale={receiptSale} storeName={storeName} />
            <div className="flex gap-2 border-t border-line p-4 print:hidden">
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
          className="fixed inset-0 z-40 flex justify-end bg-scrim/40 backdrop-blur-sm print:hidden"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="h-full w-full max-w-sm animate-fade-in overflow-y-auto border-line bg-surface shadow-2xl ltr:border-l rtl:border-r"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line p-4">
              <div>
                <h3 className="greaz-display text-lg uppercase text-fg">{t("pos.setupTitle")}</h3>
                <p className="text-xs text-fg-muted">{t("pos.setupSubtitle")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(false)}>
                {t("common.close")}
              </Button>
            </div>

            <div className="space-y-6 p-4">
              {/* Costing method */}
              <div className="space-y-2">
                <div>
                  <p className="text-sm font-semibold text-fg">{t("pos.costMethodTitle")}</p>
                  <p className="text-xs text-fg-muted">{t("pos.costMethodSubtitle")}</p>
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-chip border border-line p-3 text-sm transition-colors hover:bg-paper">
                  <input
                    type="radio"
                    name="cogs-method"
                    checked={costMethod === "weighted_average"}
                    onChange={() => setCostMethod("weighted_average")}
                    className="mt-1 accent-brand"
                  />
                  <span>
                    <span className="block font-semibold text-fg">{t("pos.weightedAverage")}</span>
                    <span className="text-xs text-fg-muted">{t("pos.weightedAverageDesc")}</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-chip border border-line p-3 text-sm transition-colors hover:bg-paper">
                  <input
                    type="radio"
                    name="cogs-method"
                    checked={costMethod === "last_purchase"}
                    onChange={() => setCostMethod("last_purchase")}
                    className="mt-1 accent-brand"
                  />
                  <span>
                    <span className="block font-semibold text-fg">{t("pos.lastPurchase")}</span>
                    <span className="text-xs text-fg-muted">{t("pos.lastPurchaseDesc")}</span>
                  </span>
                </label>
              </div>

              {/* Allow negative inventory */}
              <div className="border-t border-line pt-4">
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={allowNegativeInventory}
                    onChange={(e) => setAllowNegativeInventory(e.target.checked)}
                    className="mt-1 h-4 w-4 accent-brand"
                  />
                  <span>
                    <span className="block font-semibold text-fg">
                      {t("pos.allowNegativeInventory")}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {t("pos.allowNegativeInventoryHelp")}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tighter gaps than the rest of the app on purpose: at 1366x768 this one
          screen has to hold the menu, the cart and the whole payment panel
          without the cashier scrolling to find Post Sale. */}
      {/* ─── THE COUNTER ───────────────────────────────────────────────────
          The approved layout, and the reason this is not a generic POS: a
          quick-service till is a wall of food on the left and ONE narrow
          column on the right carrying the order from first tap to cash.

          The cart used to be a six-column table BELOW the menu in a two-span
          left column, which pushed the payment panel and the Post Sale button
          off the bottom of a 768px-tall screen. Nothing the table showed was
          dropped to fit the 325px rail — the UoM and the unit price moved onto
          a muted sub-line under each item name. */}
      <div className="grid grid-cols-1 gap-3.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_325px]">
        {/* ─── LEFT: the menu. Tap an item, it goes in the cart. ────────── */}
        <MenuPane
          title={t("pos.menuTitle")}
          subtitle={t("pos.menuSubtitle")}
          search={
            <>
              {/* SECONDARY: narrow the grid. Instant, client-side over the
                  loaded menu — no round trip while a queue is waiting. */}
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 flex items-center text-fg-subtle ltr:left-3 rtl:right-3">
                  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                    <path d="m21 21-4.3-4.3M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  value={menuFilter}
                  onChange={(e) => setMenuFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setMenuFilter("");
                      return;
                    }
                    // Enter on a narrowed-to-one grid adds that item, so a
                    // cashier who prefers typing never has to reach for the
                    // mouse. Anything else needs a deliberate tap.
                    if (e.key === "Enter" && visibleMenu.length === 1) {
                      e.preventDefault();
                      handleTileClick(visibleMenu[0]);
                      setMenuFilter("");
                    }
                  }}
                  placeholder={t("pos.menuFilterPlaceholder")}
                  aria-label={t("pos.menuFilterPlaceholder")}
                  className="w-[168px] rounded-chip border border-line bg-paper py-2.5 text-[11px] text-fg placeholder-fg-subtle transition-colors hover:border-fg-subtle focus:border-brand focus:outline-none ltr:pl-8 ltr:pr-3 rtl:pr-8 rtl:pl-3"
                />
              </div>
              {/* TERTIARY: barcode / full-catalog search, folded away. */}
              <Button
                variant={barcodeOpen ? "primary" : "secondary"}
                size="sm"
                onClick={() => {
                  const next = !barcodeOpen;
                  setBarcodeOpen(next);
                  if (next) focusScanInput();
                }}
                aria-expanded={barcodeOpen}
                title={t("pos.moreWaysToAdd")}
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                {t("pos.scanLabel")}
              </Button>
            </>
          }
        >
          {/* Collapsed secondary input row */}
          {barcodeOpen && (
            <div className="mt-3 space-y-2.5 rounded-chip border border-line bg-paper p-3">
              <p className="text-[11px] font-semibold text-fg-muted">{t("pos.moreWaysToAdd")}</p>
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
                  placeholder={t("pos.scanBarcodePlaceholder")}
                  aria-label={t("pos.scanBarcodePlaceholder")}
                  className="w-full flex-1 rounded-chip border border-line bg-surface px-3 py-2 text-sm text-fg placeholder-fg-subtle transition-colors hover:border-fg-subtle focus:border-brand focus:outline-none"
                />
                <Button variant="secondary" onClick={handleScan} disabled={!scanInput.trim()}>
                  {t("common.add")}
                </Button>
              </div>
              {/* Full catalog search — reaches products beyond the loaded menu
                  page, and matches an exact barcode too. */}
              <ProductPicker
                storeId={storeId!}
                onPick={handlePick}
                excludeIds={[]}
                placeholder={t("pos.searchProductsPlaceholder")}
              />
            </div>
          )}

          {scanError && (
            <p className="mt-3 rounded-chip bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg">
              {scanError}
            </p>
          )}
          {menuError && (
            <p className="mt-3 rounded-chip bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg">
              {menuError}
            </p>
          )}

          {/* GROUP CHIPS. Shown only when there is more than one group — a lone
              "All" chip is a control that filters nothing, and a cashier should
              not have to learn that.

              These are NOT the prototype's Burgers / Sides / Wraps row, and
              cannot be until `products` has a category column. That caveat
              used to be printed under the grid, where a cashier mid-service
              could do nothing with it; it lives in docs/MENU-CATEGORIES.md
              now. See `lib/menuGrid.ts::deriveMenuGroups` for the seam. */}
          {menuGroups.length > 1 && (
            <div className="mt-[15px] flex shrink-0 flex-wrap items-center gap-[7px] squat:mt-2.5 squat:flex-nowrap squat:overflow-x-auto squat:pb-1">
              {menuGroups.map((g) => (
                <MenuChip
                  key={g.id}
                  selected={g.id === menuGroupId}
                  count={g.count}
                  onClick={() => setMenuGroupId(g.id)}
                >
                  {t(g.labelKey)}
                </MenuChip>
              ))}
            </div>
          )}

          {/* The grid. Four across where there is room, three at 125% Windows
              scaling. Capped and internally scrolled so the page itself never
              grows past the viewport — that is what keeps the order rail, and
              with it the Post Sale button, on screen at 1366x768. */}
          {menuLoading ? (
            <p className="py-6 text-center text-sm text-fg-muted">{t("pos.menuLoading")}</p>
          ) : menu.length === 0 ? (
            <EmptyState title={t("pos.menuEmpty")} />
          ) : visibleMenu.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-muted">
              {t("pos.menuNoMatches", { term: menuFilter.trim() })}
            </p>
          ) : (
            <div className="-mx-1 mt-3.5 max-h-[32rem] min-h-0 overflow-y-auto px-1 py-0.5 squat:mt-2.5 lg:max-h-none lg:flex-1">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                {visibleMenu.map((p) => (
                  <MenuTile
                    key={p.id}
                    name={p.name}
                    price={formatUsd(menuTilePriceInclVatCents(p))}
                    outOfStock={isMenuOutOfStock(p, allowNegativeInventory)}
                    outOfStockLabel={t("pos.menuOutOfStock")}
                    onClick={() => handleTileClick(p)}
                  />
                ))}
              </div>
            </div>
          )}
        </MenuPane>

        {/* ─── RIGHT: the order rail ─────────────────────────────────────
            Bounded to the height actually available, and split in two: a
            SCROLLING upper region (tabs, order lines, discount, totals, amount
            due) and a PINNED cash panel. The payment card is the rail's own
            footer rather than content inside the scroller, so Post Sale and
            the cash fields are always on screen without covering anything —
            they are outside the scrolled box, not floating over it.

            This replaces a stack of per-element size trims that still left
            Post Sale ~35px below the fold at 1366x768 once a discount was
            expanded, and further at 125% scaling. Nothing is hidden to make
            it fit now: the lira remaining/change lines, the conversion hint
            and the discount labels are all back. */}
          <div className="flex min-w-0 flex-col gap-3 squat:gap-2 lg:h-full lg:min-h-0 lg:overflow-y-auto">
          {/* Cart tabs. Not in the prototype — Greaz can park an order and
              serve the next customer, which a single-order mockup has no slot
              for. Kept compact so it reads as a strip above the order, not as
              a second navigation. */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {carts.map((c) => {
              const isActive = c.id === activeCartId;
              return (
                <div
                  key={c.id}
                  className={clsx(
                    "inline-flex items-center rounded-chip border transition-colors",
                    isActive
                      ? "border-brand bg-brand-soft"
                      : "border-line bg-surface hover:bg-paper",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => switchCart(c.id)}
                    className={clsx(
                      "px-2.5 py-1.5 text-[11px] font-extrabold",
                      isActive ? "text-brand-700" : "text-fg-muted",
                    )}
                  >
                    {t("pos.cartLabel", { n: String(c.seq) })}
                    {c.lines.length > 0 && (
                      <span className="tabular-nums"> ({c.lines.length})</span>
                    )}
                  </button>
                  {carts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => closeCart(c.id)}
                      // A cart with an unresolved post must keep its checkout
                      // identity until the attempt settles, or a retry would
                      // ring the same basket up under a fresh one.
                      disabled={postingCartId === c.id}
                      aria-label={t("pos.closeCart")}
                      title={t("pos.closeCart")}
                      className="px-1.5 py-1.5 text-fg-subtle hover:text-danger-fg disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={addCart}
              className="rounded-chip border border-dashed border-line px-2.5 py-1.5 text-[11px] font-extrabold text-fg-muted transition-colors hover:border-brand hover:text-brand-ink"
            >
              + {t("pos.newCart")}
            </button>
          </div>

          {/* ── ORDER ────────────────────────────────────────────────────
              The card is BOUNDED and never scrolls as a whole. Its heading,
              its totals and the AMOUNT DUE block are fixed; the lines and the
              discount editor share the one scroll region between them. That
              ordering is the whole point: the figure the customer is being
              asked to pay, and the button that takes it, can never be scrolled
              off, however long the order or however the discount is open. */}
          <section className="flex flex-col overflow-hidden rounded-panel border border-line bg-surface p-[15px] shadow-panel squat:p-2.5 tiny:p-2 lg:min-h-[6.75rem] lg:flex-1">
            <RailHeading
              actions={
                <>
                  {/* The discount TRIGGER rides in the heading rather than
                      taking a full row of its own. At 1366x768 that row was
                      ~42px the order lines could not spare, and a control that
                      is used on a minority of sales should not outrank the
                      lines on every sale. The panel it opens still appears
                      below, in full. */}
                  {!(discountOpen || discountCents > 0) && (
                    <TinyButton onClick={() => setDiscountOpen(true)}>
                      + {t("pos.discountSectionTitle")}
                    </TinyButton>
                  )}
                  {lines.length > 0 && (
                    <TinyButton
                      // Same reason as Close: clearing retires the identity.
                      disabled={postingCartId === activeCartId}
                      onClick={() => { clearActiveCart(); focusScanInput(); }}
                    >
                      {t("pos.clearCart")}
                    </TinyButton>
                  )}
                </>
              }
            >
              {t("pos.cartLabel", { n: String(activeCart.seq) })}
            </RailHeading>

            {/* The order lines are the primary independently scrollable
                region: a long order scrolls HERE first, so the discount, the
                totals and the amount due stay where the cashier last saw them
                instead of sliding about. */}
            <div className="-mx-1 mt-3 min-h-[2.75rem] flex-1 scroll-p-2 overflow-y-auto tiny:min-h-0 px-1 squat:mt-1.5">
              {lines.length === 0 ? (
                <div className="rounded-chip border border-dashed border-line bg-paper px-2.5 py-8 text-center text-xs text-fg-muted squat:py-4">
                  {t("pos.cartEmptyMessage")}
                </div>
              ) : (
                <div>
                  {lines.map((l) => (
                    <CartLineRow
                      key={l.draftId}
                      name={l.product.name}
                      detail={
                        <>
                          {formatUsd(l.math.unitPriceInclVatCents)} · {l.uom.uomCode}
                          {!l.product.isService && (
                            <>
                              {" · "}
                              {t("pos.stockLabel")}{" "}
                              {formatSignedStockQty(l.product.quantityOnHand, l.uom.factor)}
                            </>
                          )}
                          {l.product.isService && <> · {t("pos.serviceLabel")}</>}
                        </>
                      }
                      amount={formatUsd(l.math.lineTotalInclVatCents)}
                      quantity={l.quantityInUom}
                      onDecrease={() => { setLineQty(l.draftId, l.quantityInUom - 1); focusScanInput(); }}
                      onIncrease={() => { setLineQty(l.draftId, l.quantityInUom + 1); focusScanInput(); }}
                      onRemove={() => { removeLine(l.draftId); focusScanInput(); }}
                      decreaseLabel={t("pos.decreaseQty")}
                      increaseLabel={t("pos.increaseQty")}
                      removeLabel={t("common.remove")}
                    />
                  ))}
                </div>
              )}

              {/* Discount — folded away by default. It used to sit permanently
                as two always-open fields on the one panel the cashier uses
                every sale, inviting a mis-keyed discount. The controls and the
                formulas behind them are untouched; only their disclosure
                changed.

                Forced open whenever a discount is actually in effect, so a
                discount can never be applied and invisible — including one
                restored with a parked cart from localStorage. */}
              {(discountOpen || discountCents > 0) && (
                <div className="mt-3 squat:mt-2">
                <div className="rounded-chip border border-line bg-paper p-2.5 squat:p-2">
                  {/* No heading row: the two fields already say "Discount %"
                      and "Discount $", so a third label repeating the word was
                      ~24px the order lines could not spare. Clear moves onto
                      the row, keeping a full-size target. */}
                  <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
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
                    <button
                      type="button"
                      onClick={() => {
                        // Clearing goes through the same handler the inputs
                        // use, so the % / $ pair stays in sync exactly as it
                        // does on any other edit.
                        handleDiscountAmountChange("");
                        setDiscountOpen(false);
                      }}
                      className="h-[34px] shrink-0 rounded-chip border border-line px-2.5 text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg"
                    >
                      {discountCents > 0 ? t("pos.discountClear") : t("common.close")}
                    </button>
                  </div>
                </div>
              </div>
            )}


              {/* Totals. Real VAT, unlike the prototype's "to confirm in POS
                  setup" placeholder — this till computes it. They scroll with
                  the lines rather than being pinned: the AMOUNT DUE block
                  below is the figure that must always be on screen, and these
                  three sit immediately above it. */}
              <div className="mt-3 space-y-1 border-t border-line pt-2.5 squat:mt-2 squat:pt-2">
              <AmountLine
                label={t("pos.subtotalExclVat")}
                value={formatUsd(totals.preDiscountSubtotalExclVat)}
              />
              {totals.discount > 0 && (
                <AmountLine
                  label={t("pos.discount")}
                  value={`-${formatUsd(totals.discount)}`}
                  tone="warn"
                />
              )}
                <AmountLine label={t("pos.vat")} value={formatUsd(totals.postDiscountVat)} />
              </div>
            </div>

            {/* The amount to collect — the loudest figure on the screen, and
                pinned: it is what the customer is being asked to pay, so it
                must never be the thing that scrolls away. */}
            <TotalBlock
              label={t("pos.totalInclVat")}
              value={formatUsd(totals.postDiscountTotal)}
              secondaryLabel={rate ? t("pos.lbpEquivalent") : undefined}
              secondaryValue={
                rate
                  ? formatLbp(usdCentsToLbp(totals.postDiscountTotal, rate.rateLbpPerUsd))
                  : undefined
              }
            />
          </section>

          {/* ── TAKE CASH ──────────────────────────────────────────────── */}
          {/* `shrink-0`, and the order card above it scrolls instead. The Post
              Sale button is the one control that must never need a scroll to
              reach: at 1366x768 the rail is capped to the viewport, the ORDER
              gives up height first, and the cash panel stays put. */}
          {/* The rail's pinned footer — a sibling of the order card, not
              content inside it, so it can never be scrolled away and never
              overlaps a figure. */}
          <section className="shrink-0 rounded-panel border border-line bg-surface p-[15px] shadow-panel squat:p-2.5">
            <h3 className="greaz-display text-[19px] uppercase leading-none text-fg squat:text-[18px] tiny:sr-only">
              {t("pos.paymentTitle")}
            </h3>

            <div className="mt-3 space-y-2.5 squat:mt-1.5 squat:space-y-1.5 tiny:grid tiny:grid-cols-2 tiny:gap-2 tiny:space-y-0">
              <Input
                label={t("pos.cashUsdReceived")}
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cashUsdInput}
                onChange={(e) => setCashUsdInput(e.target.value)}
              />
              <Input
                label={
                  rate
                    ? payments.cashLbp > 0
                      ? `${t("pos.cashLbpReceived")} · ≈ ${formatUsd(payments.cashLbpAsUsdCents)}`
                      : t("pos.cashLbpReceived")
                    : t("pos.cashLbpNoRate")
                }
                inputMode="numeric"
                placeholder={rate ? "0" : "—"}
                suffix="L.L."
                value={cashLbpInput}
                disabled={!rate}
                onChange={(e) => setCashLbpInput(e.target.value)}
              />
              {/* Card tender is HIDDEN, not removed. Greaz takes physical cash,
                  so the field was noise on every sale. Everything behind it is
                  untouched and still reachable: `cardUsdInput` state, the
                  parse, the card-overpayment guard, the `card_usd` payment
                  payload, the Rust command, the schema and the tests.

                  What is NOT acceptable is money that pays silently: a cart
                  parked in localStorage before this change can still carry a
                  card amount, and it would keep counting toward "total paid"
                  with no field on screen to explain the number. So a non-empty
                  card value surfaces itself, with a way to clear it. */}
              {cardUsdInput.trim() !== "" && (
                <div className="flex items-start justify-between gap-2 rounded-chip border border-warn-line bg-warn-bg px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-extrabold text-warn-fg">
                      {t("pos.cardUsdReceived")}:{" "}
                      <span className="tabular-nums">{cardUsdInput}</span>
                    </p>
                    <p className="text-[10px] leading-snug text-warn-fg opacity-90">
                      {t("pos.cardLegacyNotice")}
                    </p>
                  </div>
                  <TinyButton onClick={() => setCardUsdInput("")}>
                    {t("common.remove")}
                  </TinyButton>
                </div>
              )}
            </div>

            {/* The prototype's `.paycalc` box. */}
            <div className="mt-3 space-y-1 rounded-chip border border-line bg-paper p-2.5 squat:mt-1.5 squat:p-2">
              <AmountLine
                label={t("pos.totalPaidUsdEquiv")}
                value={formatUsd(payments.totalPaidUsdCents)}
              />
              {remainingCents > 0 ? (
                <>
                  <AmountLine
                    label={t("pos.remaining")}
                    value={formatUsd(remainingCents)}
                    tone="warn"
                  />
                  {rate && (
                    <AmountLine
                      label={t("pos.lbpRemaining")}
                      value={formatLbp(usdCentsToLbp(remainingCents, rate.rateLbpPerUsd))}
                      tone="warn"
                      muted
                    />
                  )}
                </>
              ) : changeCents > 0 ? (
                <>
                  <AmountLine
                    label={t("pos.changeDue")}
                    value={formatUsd(changeCents)}
                    tone="good"
                    strong
                  />
                  {rate && (
                    <AmountLine
                      label={t("pos.lbpChange")}
                      value={formatLbp(usdCentsToLbp(changeCents, rate.rateLbpPerUsd))}
                      tone="good"
                      muted
                    />
                  )}
                </>
              ) : lines.length > 0 ? (
                <AmountLine
                  label={t("pos.statusLabel")}
                  value={t("pos.exactPayment")}
                  tone="good"
                />
              ) : null}
            </div>

            {payments.errors.length > 0 && (
              <p className="mt-2 text-[11px] text-danger-fg">{payments.errors[0]}</p>
            )}
            {rateError === "NO_EXCHANGE_RATE_SET" && (
              <p className="mt-2 text-[11px] text-warn-fg">{t("pos.noRateHint")}</p>
            )}
            {submitError && <p className="mt-2 text-[11px] text-danger-fg">{submitError}</p>}

            {/* The one unmistakable action on the page — the prototype's
                `.payaction`: full width, solid brand red, display face. Nothing
                else on this screen is allowed to look like it. */}
            <button
              type="button"
              disabled={!canPost}
              onClick={handlePost}
              className="greaz-display mt-3 w-full rounded-chip bg-brand px-4 py-3.5 text-[15px] uppercase tracking-wide text-brand-fg transition-all hover:bg-brand-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-brand squat:mt-2 squat:py-2.5"
            >
              {submitting ? t("pos.posting") : t("pos.postSale")}
              {!submitting && (
                // The key cap is DARKENED, not lightened. `bg-white/15`
                // lifted the pill to #D83D51 / #E93D59 under a white glyph —
                // 4.46:1 on Classic and 3.98:1 on Midnight, so the shortcut on
                // the one button that posts money was under AA in both
                // appearances. A black wash instead reads as an inset cap and
                // takes the glyph to 7.53:1 / 6.62:1; the white hairline keeps
                // the cap's edge against the button.
                <kbd className="ms-2 rounded border border-white/30 bg-black/20 px-1.5 py-0.5 text-[10px] font-semibold leading-none">
                  F5
                </kbd>
              )}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
