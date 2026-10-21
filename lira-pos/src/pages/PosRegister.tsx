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
import {
  allocateLineDiscounts,
  discountBlocksPosting,
  evaluateCartDiscount,
  percentToDiscountCents,
  postDiscountLineTotals,
} from "../lib/discount";
import {
  createCheckoutRegistry,
  createSubmissionGate,
  type CheckoutRegistry,
  type SubmissionGate,
} from "../lib/checkout";
import { resolveIcon } from "../lib/menuCategories";
import {
  DEFAULT_SALES_CHANNEL,
  SALES_CHANNEL_OPTIONS,
  resolveSalesChannel,
  type SalesChannel,
} from "../lib/salesChannel";
import { fromBaseQty, type Factor } from "../lib/uom";
import { newId } from "../lib/ids";
import {
  revalidateRestoredCarts,
  type RevalidationResult,
} from "../lib/cartRestore";
import { browserCartStorage, persistCarts } from "../lib/cartStore";
import {
  DRIVER_COLLECTION,
  deliveryBlocker,
  deliveryTotals,
  parseFeeCents,
} from "../lib/driverCollection";
import { driversRepo } from "../db/repos/drivers";
import type { Driver } from "../db/types";
import {
  attemptOnRestore,
  beginAttempt,
  checkoutStatus,
  classifyPostFailure,
  failureMessage,
  isLegacyUnresolvedCart,
  isUsableAttempt,
  toUnknown,
  type FrozenPostSaleRequest,
  type PostAttempt,
} from "../lib/postAttempt";
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
  /**
   * The frozen checkout attempt, when one is open (P1-A / P1-C).
   *
   * Written BEFORE `post_sale` is invoked and carried until the outcome is
   * known, so it is exactly as durable as the cart record it lives in. While
   * it is present the cart is LOCKED: its canonical request is either on the
   * wire or is the key to a sale that may already have committed, and in
   * neither case may it move. See `lib/postAttempt.ts`.
   */
  attempt?: PostAttempt;
  /**
   * Where this order came from (WP-4). Per-cart, so two open orders can be one
   * counter and one delivery, and persisted with the cart so it survives a
   * reload.
   *
   * Immutable once a posting attempt opens, and that needs no extra guard: the
   * channel is part of the frozen canonical request, and the cart's own edit
   * choke points already refuse everything while an attempt is live. It is
   * also compared on replay, so a retry cannot re-attribute the sale.
   */
  channel?: SalesChannel;
  /**
   * The shop's own driver carrying this delivery order (WP-6).
   *
   * Per-cart and persisted, like the channel, and frozen into the canonical
   * request — so a retry owes the receivable to the driver the cashier chose,
   * and a replay naming a different one is refused as a conflict.
   */
  driverId?: string | null;
  /** The delivery charge, exactly as typed. Parsed by `parseFeeCents`. */
  deliveryFeeInput?: string;
  /**
   * Settle this order by DRIVER COLLECTION rather than cash or card.
   *
   * A separate flag rather than an inferred one: "this delivery is collected
   * for by the driver" is a decision the cashier makes, and inferring it from
   * the channel would have made every delivery order raise a receivable —
   * including one the customer already paid for by card.
   */
  driverCollect?: boolean;
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
    channel: DEFAULT_SALES_CHANNEL,
    driverId: null,
    deliveryFeeInput: "",
    driverCollect: false,
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

/**
 * The carts as they come back from storage, with their attempts normalised.
 *
 * A persisted attempt in state `posting` means the process went away while a
 * request was on the wire — which is the definition of an UNKNOWN outcome, not
 * of a post still running. Promoting it here means the cashier never sees a
 * spinner for a request that no longer exists, and the cart is locked for
 * reconciliation from the very first render (P1-A).
 */
function restoreCarts(): CartState[] {
  return loadOpenCarts().map((c) =>
    isUsableAttempt(c.attempt)
      ? { ...c, attempt: attemptOnRestore(c.attempt, RESTORED_IN_FLIGHT) }
      : c,
  );
}

/**
 * The `message` stamped on an attempt promoted by `restoreCarts`.
 *
 * Not translated, and not shown on its own: the operator-facing explanation is
 * a locale string chosen from the attempt's STATE, and this is the supplementary
 * detail beside it. Keeping it out of the dictionary means a cart persisted
 * under one language reads correctly under another.
 */
const RESTORED_IN_FLIGHT = "The application closed while this payment was being sent.";

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
  if (initialCartsRef.current === null) initialCartsRef.current = restoreCarts();
  const [carts, setCarts] = useState<CartState[]>(initialCartsRef.current);
  const [activeCartId, setActiveCartId] = useState<string>(initialCartsRef.current[0].id);

  const activeCart = useMemo(
    () => carts.find((c) => c.id === activeCartId) ?? carts[0],
    [carts, activeCartId],
  );

  // Convenience views into the active cart.
  const lines = activeCart.lines;
  const activeChannel = resolveSalesChannel(activeCart?.channel);
  const isDelivery = activeChannel === "online_delivery";
  const activeDriverId = activeCart?.driverId ?? null;
  const deliveryFeeInput = activeCart?.deliveryFeeInput ?? "";
  /**
   * A delivery order IS collected for by its driver (WP-7 SS3).
   *
   * Not a toggle any more. The confirmed workflow has one shape — the driver
   * takes the food out, collects from the customer and brings the food money
   * back — so "WhatsApp Delivery, settled some other way" is not a thing the
   * cashier should be able to ring up. Deriving it from the channel and the
   * driver, rather than storing a flag, means:
   *
   *   * blank tender can NEVER become cashier cash on a delivery order, which
   *     is what the auto-pay path would otherwise do with it;
   *   * a cart persisted by an older build, or hand-edited, cannot post a
   *     receivable with no driver behind it, nor a delivery order as cash.
   *
   * The stored `driverCollect` field is kept on the cart only so an older
   * record stays readable; nothing reads it as authority.
   */
  const driverCollect = isDelivery && !!activeDriverId;
  const deliveryFeeCents = parseFeeCents(deliveryFeeInput);

  const { cashUsdInput, cashLbpInput, cardUsdInput, discountPctInput, discountAmountInput } =
    activeCart;

  // ----- Restored carts are re-checked against the live catalog once -----
  //
  // The carts above came out of localStorage with a whole product snapshot
  // frozen inside each line — price, VAT rate and UoM factors as they were
  // when the line was rung. The register posts from exactly those fields, so
  // without this a cart parked across a price change or a VAT-rate change
  // would post at the OLD money and `sale_items` would snapshot it for ever
  // (GZ-WP0-05). See `lib/cartRestore.ts`.
  //
  // Runs once, on the first catalog load after boot: re-ringing a cashier's
  // open order underneath them on every menu refresh would be its own kind of
  // surprise, and every later change is already rung against fresh data.
  const [restoreNotice, setRestoreNotice] = useState<RevalidationResult<CartLine> | null>(null);
  const restoreCheckedRef = useRef(false);

  /**
   * Checkout attempts that were INTENTIONALLY retired: cart id → the
   * `checkoutId` that was retired.
   *
   * The attempt barrier in `lib/cartStore.ts` stops a mirror write dropping a
   * live attempt. That protection has to be lifted for the one case where
   * removing it is the whole point — a sale that committed, or a refusal that
   * proved nothing committed, or a checkout the cashier discarded. Without this
   * the retired attempt could never leave storage and the cart would come back
   * after a restart looking unresolved for a sale that is already settled.
   *
   * It records the IDENTITY, not just the cart (GZ-P1-2). A cart id outlives
   * any number of checkouts, so a permission minted when one attempt settled
   * would still have been in the set when the NEXT attempt's write landed —
   * authorising the deletion of an identity nobody had resolved.
   */
  const retiredAttemptsRef = useRef<Map<string, string>>(new Map());
  /**
   * Record that THIS cart's THIS attempt is being retired on purpose.
   *
   * Called from inside the state updater that retires it, which is the only
   * place the live attempt is readable synchronously: React hands the updater
   * the current cart, whereas a snapshot captured outside can predate an
   * attempt that landed in between — and a permission minted from a stale
   * snapshot is the second half of GZ-P1-2. Writing a ref inside an updater is
   * a deliberate exception to keeping them pure; the write is idempotent (the
   * same cart id and identity), so a double invocation in development changes
   * nothing.
   *
   * A cart with no usable attempt needs no permission at all: the barrier only
   * protects attempts it can read.
   */
  const permitAttemptDrop = useCallback((cart: CartState) => {
    if (!isUsableAttempt(cart.attempt)) return;
    const next = new Map(retiredAttemptsRef.current);
    next.set(cart.id, cart.attempt.checkoutId);
    retiredAttemptsRef.current = next;
  }, []);
  /**
   * Whether the restored carts have been re-checked against the catalog (P1-D).
   *
   * This was a bare ref, which triggers no rerender and so could gate nothing:
   * Post Sale and F5 were live from the first frame, and a restored cart could
   * post at its frozen snapshot while the catalog was still loading — or after
   * the load had FAILED, which the old pass treated as "try again later" and
   * silently never did. Prices, VAT rates and conversions nobody had checked.
   *
   * `pending` blocks posting an ordinary restored cart. `failed` blocks it and
   * says so with a retry. `done` is the only state that permits it.
   */
  const [restoreCheck, setRestoreCheck] = useState<"pending" | "done" | "failed">("pending");
  // Only a cart that actually came back from storage needs re-checking; a cart
  // created in this session was rung against the catalog already in hand.
  const restoredCartIdsRef = useRef<Set<string>>(
    new Set((initialCartsRef.current ?? []).filter((c) => c.lines.length > 0).map((c) => c.id)),
  );

  /**
   * Carts frozen because they hold an unresolved checkout attempt (GZ-WP0-08).
   *
   * A restored cart that still carries its `checkoutId` is a payment whose
   * answer never arrived. The ONLY safe operation on it is replaying that
   * identity with the payload byte-for-byte as it was sent, because that is
   * what `post_sale` compares a retry against. So the cart is not revalidated
   * and not editable: every content edit is refused at the two choke points
   * below, and the cashier is offered Retry or Discard.
   *
   * Kept as state for rendering AND as a ref for the guards — the guards run
   * inside `useCallback`s that must not be rebuilt on every lock change, and a
   * ref is readable synchronously, which is what a refusal needs.
   */

  // Mirror the carts into storage (survives page navigation within a session).
  //
  // Best-effort BY DESIGN, and the asymmetry with the posting path below is the
  // point. A cart edit that fails to persist costs the cashier a re-ring after
  // a restart and can charge nobody twice, so failing the edit would be worse
  // than losing it. A checkout ATTEMPT that fails to persist is the opposite:
  // it is the only key to a sale that may exist, so `runPost` writes it through
  // `persistCarts` itself and refuses to invoke unless the write is proven.
  useEffect(() => {
    // MODE: mirror. `persistCarts` refuses a mirror write that would remove an
    // attempt storage is holding, whatever render this effect's `carts` came
    // from — so the verified write `runPost` makes before dispatching cannot
    // be undone by a writer that knows nothing about checkouts.
    //
    // `retiredAttemptsRef` is the one exception: an attempt the register
    // deliberately settled or discarded. Cleared only once the write lands, so
    // a refused or failed write does not lose the permission.
    const verdict = persistCarts(browserCartStorage(), OPEN_CARTS_KEY, carts, {
      mode: "mirror",
      allowDropFor: retiredAttemptsRef.current,
    });
    if (verdict.ok) retiredAttemptsRef.current = new Map();
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

  // The shop's own delivery drivers (WP-6).
  //
  // Active only: these are the people an order may be assigned to, and a
  // retired driver must not appear in that list. A failure here is NOT fatal to
  // the register — counter trade must keep working if the driver list cannot be
  // read — so it leaves the list empty, and the delivery flow reports that it
  // has nobody to assign rather than posting without one.
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driversError, setDriversError] = useState<string | null>(null);

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

  //
  // DERIVED from the carts themselves, never held as a second piece of state.
  //
  // An earlier version kept a `lockedCartIds` set alongside the carts and had
  // to remember to add and remove ids as attempts opened and closed. Two
  // records of one fact drift: the restore pass set it, `clearCart` unset it,
  // and anything that forgot left a cart either wedged or unguarded. The lock
  // is a property OF a cart — does it hold an unresolved attempt? — so it is
  // read off the cart every render and cannot disagree with it.
  //
  // It also cannot depend on the catalog loading. The restore pass waits for
  // the menu and gives up when it is empty, so a lock applied from there left
  // a frozen checkout fully editable on exactly the morning the menu would not
  // load. `checkoutStatus` reads the persisted cart and nothing else.
  const inFlightCartIds = useMemo(
    () => new Set(postingCartId ? [postingCartId] : []),
    [postingCartId],
  );

  const lockedCartIds = useMemo(
    () =>
      new Set(
        carts.filter((c) => checkoutStatus(c, inFlightCartIds, c.id).locked).map((c) => c.id),
      ),
    [carts, inFlightCartIds],
  );
  const lockedCartIdsRef = useRef<ReadonlySet<string>>(lockedCartIds);
  lockedCartIdsRef.current = lockedCartIds;

  // Read synchronously by `clearCart` and `discardUnresolvedCheckout`, which
  // are plain functions called from handlers and cannot wait for a rerender.
  const postingCartIdRef = useRef<string | null>(postingCartId);
  postingCartIdRef.current = postingCartId;

  /**
   * Mark this cart's request no longer on the wire.
   *
   * Writes the REF first and the state after. `clearCart` and
   * `discardUnresolvedCheckout` read the ref synchronously, and the success
   * path calls `clearCart` in the same tick — so leaving the ref until the
   * rerender made the guard refuse the very clear that follows a posted sale,
   * and the basket stayed on screen after the customer had paid.
   */
  const settleInFlight = useCallback((cartId: string) => {
    if (postingCartIdRef.current === cartId) postingCartIdRef.current = null;
    setPostingCartId((current) => (current === cartId ? null : current));
  }, []);

  // Synchronous submission safety — see lib/checkout.ts for why React state
  // cannot do this job. The gate drops a second entry in the same frame; the
  // registry keeps one checkout identity per cart across retries.
  const gateRef = useRef<SubmissionGate | null>(null);
  if (gateRef.current === null) gateRef.current = createSubmissionGate();

  const checkoutsRef = useRef<CheckoutRegistry | null>(null);
  if (checkoutsRef.current === null) {
    checkoutsRef.current = createCheckoutRegistry(
      newId,
      // Either marker carries an identity: a WP-1 frozen attempt, or a bare
      // `checkoutId` from an older build.
      Object.fromEntries(
        initialCartsRef.current
          .map((c) => {
            const id = isUsableAttempt(c.attempt) ? c.attempt.checkoutId : c.checkoutId;
            return id ? ([c.id, id] as const) : null;
          })
          .filter((e): e is readonly [string, string] => e !== null),
      ),
    );
  }

  /**
   * A sale that POSTED but whose receipt could not be shown (P1-B).
   *
   * Deliberately not an error: the money is taken and the sale is in the
   * ledger. All that failed is a read, so this carries the receipt number the
   * cashier needs and a retry, and never suggests ringing the order again.
   */
  const [receiptNotice, setReceiptNotice] = useState<{
    saleId: string;
    receiptNumber: number;
    message: string;
  } | null>(null);

  /** Which cart is being probed against the database right now. */
  const [reconciling, setReconciling] = useState<string | null>(null);
  /** The outcome of the last probe, for the cart it was run against. */
  const [reconcileVerdict, setReconcileVerdict] = useState<{
    cartId: string;
    kind: "notCommitted" | "indeterminate";
    message?: string;
  } | null>(null);

  // ----- Cart mutation helpers -----
  const updateCartById = useCallback(
    (cartId: string, updater: (c: CartState) => CartState) => {
      setCarts((prev) => prev.map((c) => (c.id === cartId ? updater(c) : c)));
    },
    [],
  );

  // The two choke points for editing the ACTIVE cart's content: every input
  // setter goes through `updateActiveCart`, every line change through
  // `setLines`. Both refuse while the cart is locked, which is what makes
  // "frozen" true of the cart rather than merely true of the buttons — a
  // keyboard shortcut, a barcode scan and a menu tile all land here (GZ-WP0-08).
  const updateActiveCart = useCallback(
    (updater: (c: CartState) => CartState) => {
      if (lockedCartIdsRef.current.has(activeCartId)) return;
      setCarts((prev) => prev.map((c) => (c.id === activeCartId ? updater(c) : c)));
    },
    [activeCartId],
  );

  const setLines = useCallback(
    (updater: (prev: CartLine[]) => CartLine[]) => {
      if (lockedCartIdsRef.current.has(activeCartId)) return;
      setCarts((prev) =>
        prev.map((c) => (c.id === activeCartId ? { ...c, lines: updater(c.lines) } : c)),
      );
    },
    [activeCartId],
  );

  // ----- Attempt lifecycle (P1-A) -----
  //
  // These go through `updateCartById`, which carries no lock guard: they are
  // how a locked cart is legitimately resolved, so guarding them would wedge
  // every cart they are meant to free.

  /**
   * Retire the attempt. The cart becomes editable again.
   *
   * Drops the legacy `checkoutId` too. On the refusal path nothing committed,
   * so letting the cart come back under a fresh identity is safe — whereas
   * leaving the field behind would make the cart read as a legacy unresolved
   * one and lock it again for a checkout that provably never happened.
   */
  const clearAttempt = useCallback(
    (cartId: string) => {
      // Permit the mirror to drop THIS attempt, recorded from the cart React
      // hands the updater: by the time the effect observes the change the
      // permission is already in hand, and it names the identity being retired
      // rather than the cart, so it cannot authorise dropping the next one.
      updateCartById(cartId, (c) => {
        permitAttemptDrop(c);
        const { attempt: _a, checkoutId: _c, ...rest } = c;
        return rest;
      });
    },
    [permitAttemptDrop, updateCartById],
  );

  /** Keep the identity and the request; record that the outcome is unknown. */
  const setAttemptUnknown = useCallback(
    (cartId: string, message: string) => {
      updateCartById(cartId, (c) =>
        isUsableAttempt(c.attempt) ? { ...c, attempt: toUnknown(c.attempt, message) } : c,
      );
    },
    [updateCartById],
  );

  /** Write a brand-new attempt onto a cart, lock guard or not. */
  const updateCartUnconditionally = updateCartById;

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
  /**
   * Change the active cart's channel.
   *
   * Goes through `updateActiveCart`, so it is refused while the cart holds a
   * posting attempt — the same gate that stops a line or a tender moving.
   */
  const setChannel = useCallback(
    (channel: SalesChannel) =>
      updateActiveCart((c) =>
        // Leaving delivery clears everything that only means something there.
        // Otherwise a cart switched to Counter would still be carrying a driver
        // and a fee, which `post_sale` refuses — and rightly: a courier booked
        // against a walk-in receipt describes nothing that happened.
        channel === "online_delivery"
          ? { ...c, channel }
          : { ...c, channel, driverId: null, deliveryFeeInput: "" },
      ),
    [updateActiveCart],
  );

  /**
   * Assign (or unassign) the driver carrying the active order.
   *
   * Assigning one on a delivery order is what makes it driver-collected, so it
   * also RETIRES any tender already typed. That is a correctness fix rather
   * than tidiness: `buildFrozenRequest` emits ONE `driver_collection` leg for
   * the food total and nothing else, so cash or card still sitting in those
   * boxes would be silently dropped — money on the screen that the receipt
   * would never show. A parked cart carrying a legacy card amount is cleared
   * for the same reason.
   *
   * Unassigning him retires the tender with him, and needs no second field to
   * keep in step: `driverCollect` is derived from this plus the channel.
   */
  const setDriverId = useCallback(
    (driverId: string | null) =>
      updateActiveCart((c) =>
        driverId
          ? { ...c, driverId, cashUsdInput: "", cashLbpInput: "", cardUsdInput: "" }
          : { ...c, driverId: null },
      ),
    [updateActiveCart],
  );

  const setDeliveryFeeInput = useCallback(
    (v: string) => updateActiveCart((c) => ({ ...c, deliveryFeeInput: v })),
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

  const reloadDrivers = useCallback(async () => {
    if (!storeId) return;
    try {
      setDrivers(await driversRepo.list({ storeId }));
      setDriversError(null);
    } catch (e) {
      // Counter trade must keep working, so this is reported and not thrown.
      setDrivers([]);
      setDriversError(e instanceof Error ? e.message : String(e));
    }
  }, [storeId]);

  useEffect(() => {
    if (hydrated) {
      void reloadRate();
      void reloadShift();
      void reloadMenu();
      void reloadDrivers();
    }
  }, [hydrated, reloadRate, reloadShift, reloadMenu, reloadDrivers]);

  // Re-check restored carts once the catalog is actually in hand. `menuLoading`
  // gates it so an empty `menu` mid-load cannot be read as "every product was
  // deleted" and empty the cashier's order.
  useEffect(() => {
    if (menuLoading || restoreCheckedRef.current) return;
    if (restoredCartIdsRef.current.size === 0) {
      restoreCheckedRef.current = true;
      setRestoreCheck("done");
      return;
    }
    if (menu.length === 0) {
      // A failed or empty load is NOT an empty catalog, so nothing is dropped
      // — but it is also not a successful re-check, so it must not read as one.
      // Left un-checked (the ref stays false) so a later successful reload
      // still runs the pass, and reported as `failed` so posting stays blocked
      // in the meantime instead of proceeding on unverified prices (P1-D).
      setRestoreCheck("failed");
      return;
    }
    restoreCheckedRef.current = true;
    setRestoreCheck("done");

    // Computed BEFORE the state update, not inside the updater. A `setCarts`
    // updater runs when React gets round to it, so collecting the findings
    // from inside one left both arrays empty on the very next line and the
    // cashier got a silently re-priced cart with no notice — the exact failure
    // this fix exists to prevent, reintroduced one level down.
    //
    // The policy itself lives in `lib/cartRestore.ts`: which carts may be
    // repriced and which are frozen unresolved checkouts is one decision, and
    // this page holds no copy of it (GZ-WP0-08).
    const current = new Map(menu.map((p) => [p.id, p]));
    const outcome = revalidateRestoredCarts(
      carts,
      restoredCartIdsRef.current,
      current,
      lineMathFor,
    );

    // `outcome.locked` is not applied here: the lock is derived from each
    // cart's own attempt every render, so there is nothing to apply. The two
    // agree by construction — both ask whether the cart holds an unresolved
    // checkout.
    if (!outcome.changed) return;
    // FUNCTIONAL update, merged against the latest state rather than assigned
    // from this effect's snapshot. `carts` is read outside the dependency array
    // above (see the eslint note), so `outcome.carts` is computed from whatever
    // render scheduled this effect — assigning it wholesale would discard any
    // cart change committed since, including a checkout attempt opened by a
    // post that is already on the wire.
    //
    // The revalidation outcome is applied per cart, by id, and only to carts
    // that are still present and still attempt-free: `cartRestore` freezes a
    // cart holding an unresolved checkout and never reprices it, so a cart that
    // has since acquired an attempt must keep it untouched.
    const revalidated = new Map(outcome.carts.map((c) => [c.id, c]));
    setCarts((prev) =>
      prev.map((c) => {
        const next = revalidated.get(c.id);
        if (!next) return c;
        if (isUsableAttempt(c.attempt) || c.checkoutId) return c;
        return next;
      }),
    );
    setRestoreNotice({
      lines: [],
      dropped: outcome.dropped,
      repriced: outcome.repriced,
      changed: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; the
    // `restoreCheckedRef` guard above is what makes `carts` safe to read here.
  }, [menu, menuLoading]);

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
    // IN-FLIGHT is the one state this must refuse. `submitAttempt` calls this
    // itself on a committed sale, so the guard cannot be "is there an attempt"
    // — it has to be "is a request on the wire right now".
    //
    // The registry's own `isPosting` used to answer that, and no longer can:
    // WP-1 mints identities with `idFor` and never calls `beginAttempt`, so
    // that flag is permanently false and the check it guarded was dead. The
    // live answer is `postingCartId`, which `submitAttempt` sets and clears.
    // The Clear and Close buttons are disabled in that window too; this covers
    // every other path to the same function.
    if (postingCartIdRef.current === cartId) return;
    checkoutsRef.current?.retire(cartId);
    // Clearing a cart retires its attempt intentionally — a committed sale, or
    // a checkout the cashier discarded — so the mirror is allowed to drop it.
    // Without this the barrier would hold the attempt in storage for ever and
    // the cart would come back from a restart looking unresolved for a sale
    // that is already settled.
    updateCartById(cartId, (c) => {
      permitAttemptDrop(c);
      return {
        ...c,
        lines: [],
        cashUsdInput: "",
        cashLbpInput: "",
        cardUsdInput: "",
        discountPctInput: "",
        discountAmountInput: "",
        checkoutId: undefined,
        // The attempt goes with it, which is also what unlocks the cart: the
        // lock is derived from this field, so there is nothing else to reset.
        attempt: undefined,
        // And the channel resets. A cleared cart is the NEXT customer, who is at
        // the counter until someone says otherwise. Letting it stick would
        // silently post the next counter order as a delivery — mis-attributed
        // revenue with nothing on screen to say so, which is a worse failure
        // than a cashier having to press Online again.
        channel: DEFAULT_SALES_CHANNEL,
        // And so do the delivery fields, for exactly the same reason (WP-7 SS3).
        // The channel reset alone was not enough: a cleared cart kept its driver
        // and its delivery charge, so the next order could post a receivable
        // against a driver who never saw it, or a fee the customer never agreed,
        // the moment anyone switched it back to Delivery. Nothing about one
        // customer may survive into the next.
        driverId: null,
        deliveryFeeInput: "",
        driverCollect: false,
      };
    });
    setSubmitError(null);
    setScanError(null);
  }

  function clearActiveCart() {
    clearCart(activeCartId);
  }

  /**
   * Resolve an unknown outcome by asking the database (P1-A).
   *
   * Read-only and authoritative. `post_sale` consumes a checkout identity on
   * exactly one commit, so a sale under that id is proof the attempt committed
   * and the absence of one is proof it had not, as of this read. Nothing here
   * posts, retries or writes — which is what makes it safe to offer as the
   * FIRST action on an unresolved cart, including a legacy cart whose canonical
   * request was never frozen and so can never be replayed.
   */
  async function reconcileCheckout(cartId: string) {
    const cart = carts.find((c) => c.id === cartId);
    if (!cart) return;
    const status = checkoutStatus(cart, inFlightCartIds, cartId);
    if (!status.checkoutId || status.inFlight) return;

    setReconciling(cartId);
    setSubmitError(null);
    try {
      const found = await salesRepo.findByIdWithDetails(status.checkoutId);
      if (found) {
        // It committed. Clear the cart and show the receipt it earned.
        clearCart(cartId);
        setReceiptSale(found);
        void reloadMenu();
        return;
      }
      // No sale under this identity. The attempt is safe to post for real.
      setReconcileVerdict({ cartId, kind: "notCommitted" });
    } catch (e) {
      // The probe itself failed. NOTHING is proven, so the cart stays locked.
      setReconcileVerdict({ cartId, kind: "indeterminate", message: failureMessage(e) });
    } finally {
      setReconciling(null);
    }
  }

  /**
   * Abandon a frozen checkout attempt (GZ-WP0-08).
   *
   * This is the ONE way out of a locked cart other than a successful retry,
   * and it is deliberately the only destructive one. Retiring the identity
   * throws away the only key that could reconcile the attempt to a sale that
   * may already have committed, so if it did commit this order is now invisible
   * to the register and a re-ring would charge the customer twice. The cashier
   * is told exactly that and has to agree; nothing here can decide it for them,
   * because only the receipt list and the drawer can say what really happened.
   */
  function discardUnresolvedCheckout(cartId: string) {
    if (!lockedCartIdsRef.current.has(cartId)) return;
    // Never while the request is still on the wire: the answer may be seconds
    // away, and throwing the identity away now is the one move that cannot be
    // undone. The cashier waits for a verdict and then decides.
    if (postingCartIdRef.current === cartId) return;
    if (!window.confirm(t("pos.confirmDiscardUnresolved"))) return;
    clearCart(cartId);
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
    // Closing a FROZEN cart discards its checkout identity exactly as the
    // rail's Discard does, so it asks the same question. "Close it and discard
    // them?" is about losing the lines; this is about possibly losing a sale
    // that already took the customer's money (GZ-WP0-08).
    const prompt = lockedCartIdsRef.current.has(id)
      ? t("pos.confirmDiscardUnresolved")
      : t("pos.confirmCloseCart");
    if (cart.lines.length > 0 && !window.confirm(prompt)) return;

    checkoutsRef.current?.retire(id);
    // FUNCTIONAL, and filtered by id rather than assigned from `carts`: this
    // runs after a blocking `window.confirm`, so the snapshot taken above can
    // be arbitrarily old by the time the cashier answers — and an in-flight
    // post's attempt may have landed in the meantime.
    //
    // The retirement permission is taken from `prev` for the same reason. The
    // cart being closed may have acquired its attempt while the confirm dialog
    // was open, and a permission minted from the stale snapshot would have
    // named the wrong identity — or none (GZ-P1-2).
    const remaining = carts.filter((c) => c.id !== id);
    setCarts((prev) => {
      const closing = prev.find((c) => c.id === id);
      if (closing) permitAttemptDrop(closing);
      return prev.filter((c) => c.id !== id);
    });
    if (id === activeCartId) {
      setActiveCartId(remaining[0].id);
      setSubmitError(null);
      setScanError(null);
      focusScanInput();
    }
  }

  // ----- Discount: evaluated, never silently clamped (GZ-WP0-03) -----
  //
  // `discount` carries BOTH the money and the verdict. A refused request
  // contributes zero to the totals and blocks posting, so what the cashier
  // typed, what the rail shows and what gets posted can never disagree.
  const preDiscountTotalCents = useMemo(
    () => lines.reduce((s, l) => s + l.math.lineTotalInclVatCents, 0),
    [lines],
  );

  // BOTH boxes, one verdict. The percentage box used to be evaluated nowhere at
  // all: an unusable percentage blanked the derived amount, so the amount box
  // reported "nothing typed" and the order posted at FULL PRICE with the typed
  // percentage still on screen (GZ-WP0-07). `evaluateCartDiscount` judges the
  // pair, and the money, the message and the posting block all come off it.
  const discount = useMemo(
    () => evaluateCartDiscount(discountPctInput, discountAmountInput, preDiscountTotalCents),
    [discountPctInput, discountAmountInput, preDiscountTotalCents],
  );
  const discountCents = discount.cents;

  const discountPanelRef = useRef<HTMLParagraphElement | null>(null);

  const discountMessage = (() => {
    switch (discount.kind) {
      case "none":
      case "ok":
        return null;
      case "pctInvalid":
        return t("pos.discountPctInvalid");
      case "pctExceeds":
        return t("pos.discountPctTooLarge", { requested: String(discount.requestedPct) });
      case "pctTooSmall":
        return t("pos.discountPctTooSmall", { requested: String(discount.requestedPct) });
      case "amountInvalid":
        return t("pos.discountInvalid");
      case "amountExceeds":
        return t("pos.discountTooLarge", {
          requested: formatUsd(discount.requestedCents),
          max: formatUsd(discount.maxCents),
        });
    }
  })();

  // A refusal the cashier cannot see is not feedback. The order rail scrolls
  // its lines, the discount editor and the totals through one region, so on a
  // cart of any length the message lands below the fold — and all the cashier
  // sees is a greyed-out Post Sale with no stated reason.
  useEffect(() => {
    if (discountMessage === null) return;
    // The message itself, not the panel: aligning the panel's top leaves the
    // sentence clipped against the bottom of the scroll region on a full cart.
    discountPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [discountMessage]);

  // ----- Discount input handlers (keep % and $ in sync) -----
  //
  // The percentage box writes the EXACT cash value of the percentage, even
  // when that is more than the cart can bear. Clamping it here is what used to
  // make the two boxes describe different discounts; letting the refusal
  // surface once, in one place, is what keeps them honest.
  function handleDiscountPctChange(value: string) {
    setDiscountPctInput(value);
    const cents = percentToDiscountCents(value, preDiscountTotalCents);
    setDiscountAmountInput(cents !== null && cents > 0 ? (cents / 100).toFixed(2) : "");
  }

  function handleDiscountAmountChange(value: string) {
    setDiscountAmountInput(value);
    if (!value.trim() || preDiscountTotalCents <= 0) {
      setDiscountPctInput("");
      return;
    }
    try {
      const cents = parseUsdInput(value);
      const pct = Math.round((cents / preDiscountTotalCents) * 10000) / 100;
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
      // The figure the rail must show, and the one that was always missing.
      // It is computed here, posted to Rust as the line subtotals, and now
      // displayed — one value, three uses, so the screen cannot disagree with
      // the receipt (GZ-WP0-04).
      postDiscountSubtotalExclVat,
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

  /** Is the cart on screen a frozen, unresolved checkout attempt? */
  const isActiveCartLocked = lockedCartIds.has(activeCartId);

  /** The checkout state of the cart on screen, in one place. */
  const activeCheckout = useMemo(
    () =>
      checkoutStatus(
        activeCart ?? { lines: [] },
        inFlightCartIds,
        activeCartId,
      ),
    [activeCart, inFlightCartIds, activeCartId],
  );

  /**
   * An ordinary restored cart that has not been re-checked yet (P1-D).
   *
   * Scoped to carts that actually came back from storage: one rung up in this
   * session was priced against the catalog in hand. And scoped AWAY from a cart
   * holding a frozen attempt, whose request is already fixed and depends on no
   * catalog at all — blocking its retry would strand the one operation that can
   * reconcile a lost response.
   */
  const activeCartAwaitsRevalidation =
    lines.length > 0 &&
    restoredCartIdsRef.current.has(activeCartId) &&
    !activeCheckout.locked &&
    restoreCheck !== "done";

  const remainingCents = totals.postDiscountTotal - payments.totalPaidUsdCents;
  const changeCents = payments.totalPaidUsdCents - totals.postDiscountTotal;

  const allPaymentsEmpty =
    cashUsdInput.trim() === "" &&
    cashLbpInput.trim() === "" &&
    cardUsdInput.trim() === "";
  const isAutoPayMode = allPaymentsEmpty && lines.length > 0 && totals.postDiscountTotal > 0;

  /**
   * The delivery arrangement's own verdict, or null when there is nothing
   * wrong. Mirrors `prepare_sale`'s three rules so the cashier is told BEFORE
   * pressing Post rather than refused after; the backend remains the authority.
   */
  const deliveryVerdict = deliveryBlocker({
    channel: activeChannel,
    driverId: activeDriverId,
    feeInput: deliveryFeeInput,
    collectsByDriver: driverCollect,
  });

  const isFullyPaid =
    lines.length > 0 &&
    payments.errors.length === 0 &&
    // A driver-collected order IS settled: the driver has taken
    // responsibility for the food money, which is what the tender records.
    // There is no cash to count and no remainder to chase.
    (driverCollect || isAutoPayMode || remainingCents <= 0);

  /**
   * A cart holding a replayable frozen attempt may ALWAYS be re-sent.
   *
   * Every gate below exists to validate a request that is about to be BUILT,
   * and this cart's request was built and frozen long ago. Requiring today's
   * rate and today's open shift for a replay would strand recovery exactly
   * when it is needed most — the morning after, before anyone has opened a
   * shift or entered a rate, which is precisely when an unresolved checkout
   * from last night is sitting on the screen. The backend resolves the replay
   * on the identity before it looks at anything else, so a reconciliation does
   * not need a shift of its own (P1-A).
   */
  const canReplayFrozenAttempt =
    activeCheckout.request !== null && !submitting && !activeCheckout.inFlight;

  const canPost =
    canReplayFrozenAttempt ||
    (!submitting &&
    lines.length > 0 &&
    isFullyPaid &&
    rate !== null &&
    !!activeShift &&
    // An unresolved discount is a disagreement between what was asked for and
    // what the cart can do. Posting through it would settle that disagreement
    // silently, in the customer's disfavour or the shop's (GZ-WP0-03) — and for
    // an unusable PERCENTAGE it would post the order at full price while the
    // screen still showed the discount the cashier typed (GZ-WP0-07).
    //
    // Gated on the verdict, not on the message: a message is a translated
    // string and a missing key would re-enable posting through a refused
    // discount. The verdict is the authority. F5 reads `canPost` through
    // `canPostRef`, so this blocks the shortcut too.
    !discountBlocksPosting(discount) &&
    // A restored cart posts only once its prices have been re-checked (P1-D).
    !activeCartAwaitsRevalidation &&
    // And a delivery order must name who carried it and what he charged.
    // Gated on the verdict rather than its message, for the same reason the
    // discount is: a missing translation must not re-enable posting.
    deliveryVerdict === null);

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

  /**
   * Build the complete canonical request for the cart on screen, or explain
   * why it cannot be built.
   *
   * Everything the backend compares on replay is decided HERE and once: the
   * shift, the locked rate and its value, the cashier, the COGS method, the
   * lines and the tender. The result is then frozen onto the cart, and posting
   * never reads live state again (P1-C).
   */
  function buildFrozenRequest(checkoutId: string): FrozenPostSaleRequest | string {
    if (!storeId) return t("pos.errCartEmpty");
    if (!rate) return t("pos.noExchangeRate");
    if (!activeShift) return t("pos.noOpenShiftBold");
    if (lines.length === 0) return t("pos.errCartEmpty");
    // Before the tender is read, because a driver-collection leg is only
    // meaningful once there is a driver to owe it.
    if (deliveryVerdict !== null) return t(`delivery.err.${deliveryVerdict}`);
    if (payments.errors.length > 0) return payments.errors[0];
    if (!isAutoPayMode && payments.totalPaidUsdCents < totals.postDiscountTotal) {
      return t("pos.errUnderpaid", {
        tendered: formatUsd(payments.totalPaidUsdCents),
        total: formatUsd(totals.postDiscountTotal),
      });
    }

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
    if (driverCollect) {
      // ONE leg, for the food total, tendered `driver_collection`.
      //
      // Not cash and not card: the money is in the driver's pocket, so the
      // drawer must not count it and the card rail was never touched. The
      // backend turns this into a receivable against the named driver, in the
      // same transaction as the sale.
      //
      // The DELIVERY FEE IS NOT IN IT. He keeps the fee and the customer pays
      // it to him, so putting it here would make the shop claim money it has
      // agreed is his — and would make the tender exceed the sale total, which
      // `post_sale` refuses anyway.
      paymentPayloads.push({
        method: DRIVER_COLLECTION,
        currency: "USD",
        amountNativeUsdCents: totals.postDiscountTotal,
        amountNativeLbp: 0,
        amountUsdCentsEquivalent: totals.postDiscountTotal,
        reference: null,
      });
    } else if (isAutoPayMode) {
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

    return {
      saleId: checkoutId,
      storeId,
      cashierUserId: userId,
      deviceId: null,
      shiftId: activeShift.id,
      exchangeRateId: rate.id,
      exchangeRateLbpPerUsd: rate.rateLbpPerUsd,
      notes: null,
      // Frozen with the rest of the request, so the channel a retry posts is
      // the channel the cashier chose — not whatever the cart says by the time
      // the retry happens (P1-C), and not something a replay can change.
      channel: activeChannel,
      // Frozen with the rest of the request: the receivable a retry raises is
      // owed by the driver the cashier chose, and the fee is the one that was
      // on the screen. Both are compared on replay.
      driverId: isDelivery ? activeDriverId : null,
      deliveryFeeCents: isDelivery ? (deliveryFeeCents ?? 0) : 0,
      cogsMethod: costMethod,
      discountCents: totals.discount,
      allowNegativeInventory,
      lines: linePayloads,
      payments: paymentPayloads,
    };
  }

  /**
   * Load and show a posted sale's receipt — a SEPARATE step from posting.
   *
   * It used to share `runPost`'s one `try`, so a receipt query that failed
   * reported a committed sale as a failed one and invited the cashier to ring
   * it again (P1-B). A receipt is a view of a sale that already exists; it can
   * fail, be retried and be reprinted, and none of that is a financial event.
   */
  async function showReceiptFor(saleId: string, receiptNumber: number) {
    setReceiptNotice(null);
    try {
      const details = await salesRepo.findByIdWithDetails(saleId);
      if (!details) {
        setReceiptNotice({ saleId, receiptNumber, message: t("pos.receiptNotFound") });
        return;
      }
      setReceiptSale(details);
    } catch (e) {
      // The sale is posted and the money is taken. All that failed is a read.
      setReceiptNotice({ saleId, receiptNumber, message: failureMessage(e) });
    }
  }

  /**
   * Send one frozen attempt and deal with every outcome it can have.
   *
   * The attempt is already persisted on its cart before this runs, so a kill
   * at any point inside it leaves a cart that comes back locked, holding the
   * exact request that went out.
   */
  async function submitAttempt(cartId: string, attempt: PostAttempt) {
    setSubmitError(null);
    setPostingCartId(cartId);
    setSubmitting(true);

    try {
      // THE FROZEN REQUEST — never a rebuild from current state.
      const result = await salesRepo.post(attempt.request);

      // Committed, and that is authoritative on its own, before any receipt
      // is fetched. The in-flight marker is released FIRST, because `clearCart`
      // refuses a cart whose request is still on the wire — the ordering WP-0
      // established and WP-1 keeps.
      settleInFlight(cartId);
      clearAttempt(cartId);
      clearCart(cartId);
      // Stock moved, so the grid's out-of-stock tiles are stale. Fire and
      // forget: a failed refresh must not turn a posted sale into an error.
      void reloadMenu();
      await showReceiptFor(result.saleId, result.receiptNumber);
    } catch (e) {
      const failure = classifyPostFailure(e);
      if (failure.kind === "rejected") {
        // PROVEN not committed, by the backend's own contract. The cart goes
        // back to the cashier to fix, keeping its identity: nothing posted
        // under it, so a retry of the corrected basket is still one checkout.
        clearAttempt(cartId);
        setSubmitError(failure.message);
      } else {
        // No verdict reached us. The sale may exist. Keep the identity AND the
        // frozen request, leave the cart locked, and offer reconciliation.
        setAttemptUnknown(cartId, failure.message);
        setSubmitError(null);
      }
    } finally {
      // Idempotent; the success path has normally settled already. Here so no
      // path can leave a cart wedged as "posting".
      settleInFlight(cartId);
      setSubmitting(false);
    }
  }

  async function runPost() {
    const cartId = activeCartId;
    const cart = carts.find((c) => c.id === cartId);
    if (!cart) return;

    // A cart holding a replayable attempt posts THAT, unchanged. This is the
    // retry path, and the only one that can reconcile a lost response.
    const existing = isUsableAttempt(cart.attempt) ? cart.attempt : null;
    if (existing) {
      await submitAttempt(cartId, existing);
      return;
    }

    // A legacy unresolved cart has an identity but no frozen request, so it
    // cannot be replayed canonically — rebuilding one from the cart plus
    // today's shift and rate is precisely the P1-C defect. Reconciling by
    // identity is the only safe move, and it is read-only.
    if (isLegacyUnresolvedCart(cart)) {
      setSubmitError(t("pos.errLegacyUnresolved"));
      return;
    }

    const checkoutId = checkoutsRef.current!.idFor(cartId).id;
    const built = buildFrozenRequest(checkoutId);
    if (typeof built === "string") {
      setSubmitError(built);
      return;
    }

    // PERSIST BEFORE INVOKING — synchronously, proven, and fatal if it fails.
    //
    // The attempt is written into the cart record, so it is exactly as durable
    // as the cart itself; `lib/postAttempt.ts` states what that does and does
    // not guarantee, and `lib/cartStore.ts` states why this write cannot go
    // through the mirroring effect above. In short: an effect runs after React
    // commits, `salesRepo.post` is dispatched before this function yields, so
    // the effect would have mirrored the attempt AFTER the request was already
    // on the wire — and would have swallowed a quota failure on the way.
    //
    // The attempt CARRIES its identity, so `checkoutId` is not written beside
    // it. That field now means one thing only — "an identity from a build that
    // froze no request" — which is what `isLegacyUnresolvedCart` tests for.
    // Writing both made a cart whose attempt had just been cleared look legacy,
    // and re-locked it after a refusal that had proven nothing was committed.
    const attempt = beginAttempt(checkoutId, built, new Date().toISOString());
    const persisted = persistCarts(
      browserCartStorage(),
      OPEN_CARTS_KEY,
      carts.map((c) => (c.id === cartId ? { ...c, attempt } : c)),
      // The proof names the IDENTITY as well as the cart (GZ-P1-2): the array
      // above is built from `carts`, and a presence-only check would be
      // satisfied by a previous attempt that a stale snapshot had left in it,
      // while this call went on to invoke under `checkoutId`.
      { requireAttemptFor: { cartId, checkoutId } },
    );
    if (!persisted.ok) {
      // Nothing has been sent, and nothing will be. The cart is left EDITABLE
      // and attempt-free: locking it would strand the order behind a
      // reconciliation offer for a request that was never made, and the
      // identity is still unconsumed, so the next press is a first attempt.
      setSubmitError(`${t("pos.errAttemptNotPersisted")} (${persisted.message})`);
      return;
    }
    updateCartUnconditionally(cartId, (c) => ({ ...c, attempt }));
    await submitAttempt(cartId, attempt);
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

      {/* A restored order was re-checked and something had moved. Dismissible
          and non-blocking: the cart is already correct — it was re-rung at
          today's catalog before this appeared — so this is a notification, not
          a decision. It names every line it touched, because "prices changed"
          without saying which is worse than silence (GZ-WP0-05). */}
      {restoreNotice && (
        <div
          role="status"
          className="flex flex-wrap items-start gap-3 rounded-panel border border-warn-line bg-warn-bg px-4 py-2.5 text-sm text-warn-fg"
        >
          <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-warn-fg">
            <path d="M12 8v5m0 3h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1 space-y-1">
            <p className="font-semibold">{t("pos.cartRestoredTitle")}</p>
            {restoreNotice.repriced.map((r, i) => (
              <p key={`r${i}`}>
                {t("pos.cartRestoredRepriced", {
                  name: r.productName,
                  before: formatUsd(r.beforeUnitInclVatCents),
                  after: formatUsd(r.afterUnitInclVatCents),
                })}
              </p>
            ))}
            {restoreNotice.dropped.map((d, i) => (
              <p key={`d${i}`}>
                {t(d.reason === "uom" ? "pos.cartRestoredUomGone" : "pos.cartRestoredGone", {
                  name: d.productName,
                })}
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRestoreNotice(null)}
            className="shrink-0 rounded-chip border border-warn-line px-3 py-1.5 text-xs font-bold transition-colors hover:brightness-95"
          >
            {t("common.close")}
          </button>
        </div>
      )}

      {/* A sale that POSTED but whose receipt could not be shown (P1-B).
          Deliberately a `status`, not an `alert`: nothing is wrong with the
          sale. It names the receipt number so the cashier can write it down,
          and offers the read again. It never suggests ringing the order up. */}
      {receiptNotice && (
        <div
          role="status"
          className="flex flex-wrap items-start gap-3 rounded-panel border border-warn-line bg-warn-bg px-4 py-2.5 text-sm text-warn-fg"
        >
          <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-warn-fg">
            <path d="M9 12.5 11 14.5 15 10M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1 space-y-1">
            <p className="font-semibold">
              {t("pos.receiptUnavailableTitle", {
                receipt: String(receiptNotice.receiptNumber),
              })}
            </p>
            <p>{t("pos.receiptUnavailableBody")}</p>
          </div>
          <button
            type="button"
            onClick={() =>
              void showReceiptFor(receiptNotice.saleId, receiptNotice.receiptNumber)
            }
            className="shrink-0 rounded-chip border border-warn-line px-3 py-1.5 text-xs font-bold transition-colors hover:brightness-95"
          >
            {t("pos.receiptRetry")}
          </button>
          <button
            type="button"
            onClick={() => setReceiptNotice(null)}
            className="shrink-0 rounded-chip border border-warn-line px-3 py-1.5 text-xs font-bold transition-colors hover:brightness-95"
          >
            {t("common.close")}
          </button>
        </div>
      )}

      {/* An IN-FLIGHT post. The cart is locked while the request is on the
          wire, and this says why nothing responds to typing (P1-A). */}
      {activeCheckout.inFlight && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-panel border border-line bg-paper px-4 py-2.5 text-sm text-fg"
        >
          <span className="font-semibold">{t("pos.postingInFlightTitle")}</span>
          <span className="flex-1 text-fg-muted">{t("pos.postingInFlightBody")}</span>
        </div>
      )}

      {/* An UNRESOLVED checkout (P1-A). Not dismissible and not a
          notification: the cart is frozen and the cashier has a decision.
          The actions are ordered by safety —
            1. Check this order: a read-only probe of the database by identity,
               which is the only action that can PROVE what happened.
            2. Post Sale (in the rail): replays the frozen request, which
               reconciles to the sale if it committed.
            3. Discard: throws the identity away, and says what that costs. */}
      {isActiveCartLocked && !activeCheckout.inFlight && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-3 rounded-panel border border-danger-line bg-danger-bg px-4 py-2.5 text-sm text-danger-fg"
        >
          <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-danger-fg">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1 space-y-1">
            <p className="font-semibold">{t("pos.unresolvedCheckoutTitle")}</p>
            <p>
              {activeCheckout.legacy
                ? t("pos.unresolvedCheckoutLegacyBody")
                : t("pos.unresolvedCheckoutBody")}
            </p>
            {reconcileVerdict?.cartId === activeCartId && (
              <p className="font-semibold">
                {reconcileVerdict.kind === "notCommitted"
                  ? activeCheckout.legacy
                    ? t("pos.reconcileNotCommittedLegacy")
                    : t("pos.reconcileNotCommitted")
                  : t("pos.reconcileIndeterminate")}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={reconciling === activeCartId}
            onClick={() => void reconcileCheckout(activeCartId)}
            className="shrink-0 rounded-chip border border-danger-line px-3 py-1.5 text-xs font-bold transition-colors hover:brightness-95 disabled:opacity-50"
          >
            {reconciling === activeCartId
              ? t("pos.reconcileChecking")
              : t("pos.reconcileCheck")}
          </button>
          <button
            type="button"
            onClick={() => discardUnresolvedCheckout(activeCartId)}
            className="shrink-0 rounded-chip border border-danger-line px-3 py-1.5 text-xs font-bold transition-colors hover:brightness-95"
          >
            {t("pos.discardUnresolved")}
          </button>
        </div>
      )}

      {/* A restored cart whose prices have not been re-checked (P1-D). The
          refusal is visible and retryable rather than a silently disabled
          button, because the cashier has a customer waiting and needs to know
          whether to wait or to re-ring. */}
      {activeCartAwaitsRevalidation && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-3 rounded-panel border border-warn-line bg-warn-bg px-4 py-2.5 text-sm text-warn-fg"
        >
          <svg viewBox="0 0 24 24" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-warn-fg">
            <path d="M12 8v5m0 3h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1 space-y-1">
            <p className="font-semibold">{t("pos.awaitRevalidationTitle")}</p>
            <p>
              {restoreCheck === "failed"
                ? t("pos.awaitRevalidationFailed")
                : t("pos.awaitRevalidationPending")}
            </p>
          </div>
          {restoreCheck === "failed" && (
            <button
              type="button"
              onClick={() => void reloadMenu()}
              className="shrink-0 rounded-chip border border-warn-line px-3 py-1.5 text-xs font-bold transition-colors hover:brightness-95"
            >
              {t("pos.awaitRevalidationRetry")}
            </button>
          )}
        </div>
      )}

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
                    // WP-3: the tile's two reserved slots, now fed from the
                    // catalog. `meta` is the product's own description — the
                    // "BBQ or buffalo sauce" line a cashier is asked about —
                    // and `symbol` is its icon, falling back to its section's
                    // glyph so an uncategorised product still looks deliberate.
                    // Neither is matched on the product NAME: a shop that
                    // renames an item, or sells in Arabic, would silently get
                    // the wrong picture.
                    meta={p.description ?? undefined}
                    symbol={resolveIcon(p.icon, p.category)}
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
                  {!(discountOpen || discountCents > 0 || discountMessage !== null) && (
                    <TinyButton onClick={() => setDiscountOpen(true)}>
                      + {t("pos.discountSectionTitle")}
                    </TinyButton>
                  )}
                  {lines.length > 0 && (
                    <TinyButton
                      // Same reason as Close: clearing retires the identity.
                      disabled={postingCartId === activeCartId}
                      // On a FROZEN cart, Clear is the destructive escape and
                      // must ask: it throws away the only key that could
                      // reconcile a payment that may already have gone through.
                      // Routing it through the same confirmed path as the
                      // banner's Discard means there is no quiet way out
                      // (GZ-WP0-08).
                      onClick={() => {
                        if (isActiveCartLocked) discardUnresolvedCheckout(activeCartId);
                        else clearActiveCart();
                        focusScanInput();
                      }}
                    >
                      {isActiveCartLocked ? t("pos.discardUnresolved") : t("pos.clearCart")}
                    </TinyButton>
                  )}
                </>
              }
            >
              {t("pos.cartLabel", { n: String(activeCart.seq) })}
            </RailHeading>

            {/* WHERE THIS ORDER CAME FROM (WP-4).
                Two segments rather than a dropdown: the cashier has to be able
                to see which one is selected without opening anything, and at a
                glance from across the counter. Counter is first and is the
                default, because it is the overwhelming majority of orders.

                Disabled, not hidden, while the cart is locked: hiding it would
                leave the cashier unable to see which channel an unresolved
                order was taken on, at exactly the moment they need to know.

                It is NOT a payment control and says nothing about settlement —
                an online order still has to be paid for before it will post.
                See lib/salesChannel.ts. */}
            <div
              role="group"
              aria-label={t("channel.groupLabel")}
              className="mt-2 flex items-center gap-1.5 squat:mt-1.5"
            >
              {SALES_CHANNEL_OPTIONS.map((opt) => {
                const selected = activeChannel === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={isActiveCartLocked}
                    onClick={() => setChannel(opt.id)}
                    className={clsx(
                      "flex-1 rounded-chip border px-2 py-1.5 text-[11px] font-extrabold uppercase tracking-wide transition-colors",
                      selected
                        ? "border-brand bg-brand text-brand-fg"
                        : "border-line bg-paper text-fg-muted hover:text-fg",
                      isActiveCartLocked && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {t(opt.shortLabelKey)}
                  </button>
                );
              })}
            </div>

            {/* THE DELIVERY ARRANGEMENT (WP-6).
                Only on a delivery order, because a driver and a delivery
                charge mean nothing on a counter sale — and `post_sale` refuses
                them there.

                Three things the cashier must be able to tell apart, so they
                are three separate controls and three separate figures: WHO
                carried it, WHAT he charged, and the fact that HE collects for
                it. The totals block below spells out the food, the fee and
                what the customer hands over.

                Disabled rather than hidden while the cart is locked, like the
                channel segments: an unresolved delivery order is exactly when
                the cashier needs to see which driver it was assigned to. */}
            {isDelivery && (
              <div className="mt-2 space-y-1.5 rounded-chip border border-line bg-paper p-2 squat:mt-1.5">
                <label
                  className="block text-[10px] font-extrabold uppercase tracking-wide text-fg-muted"
                  htmlFor="pos-driver"
                >
                  {t("delivery.driver")}
                </label>
                <select
                  id="pos-driver"
                  value={activeDriverId ?? ""}
                  disabled={isActiveCartLocked}
                  onChange={(e) => setDriverId(e.target.value || null)}
                  className={clsx(
                    "w-full rounded-chip border border-line bg-surface px-2 py-1.5 text-xs font-bold text-fg",
                    isActiveCartLocked && "cursor-not-allowed opacity-50",
                  )}
                >
                  <option value="">{t("delivery.driverUnassigned")}</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                {driversError !== null && (
                  <p className="text-[10px] font-bold text-danger">{t("delivery.driversUnavailable")}</p>
                )}
                {driversError === null && drivers.length === 0 && (
                  <p className="text-[10px] font-bold text-fg-muted">{t("delivery.noDrivers")}</p>
                )}

                <label
                  className="block pt-0.5 text-[10px] font-extrabold uppercase tracking-wide text-fg-muted"
                  htmlFor="pos-delivery-fee"
                >
                  {t("delivery.fee")}
                </label>
                <input
                  id="pos-delivery-fee"
                  inputMode="decimal"
                  value={deliveryFeeInput}
                  disabled={isActiveCartLocked}
                  onChange={(e) => setDeliveryFeeInput(e.target.value)}
                  placeholder="0.00"
                  aria-invalid={deliveryFeeCents === null}
                  className={clsx(
                    "w-full rounded-chip border bg-surface px-2 py-1.5 text-xs font-bold text-fg",
                    deliveryFeeCents === null ? "border-danger" : "border-line",
                    isActiveCartLocked && "cursor-not-allowed opacity-50",
                  )}
                />
                {/* The fee is the DRIVER's, and the screen says so rather than
                    leaving the cashier to infer it from a layout. */}
                <p className="text-[10px] leading-snug text-fg-muted">{t("delivery.feeNote")}</p>

                {/* NOT a toggle (WP-7 SS3). A WhatsApp order is settled by its
                    driver collecting — that is the whole workflow — so this
                    STATES the tender rather than offering a choice. Offering
                    one is what let a delivery order fall through to the
                    auto-pay path and become cashier cash.

                    It reads as active once a driver is assigned; until then the
                    message below says what is missing. */}
                <p
                  data-testid="driver-collection-tender"
                  // Whether this order IS driver-collected, for the tests and
                  // for anything reading the DOM. Derived, like the tender.
                  data-active={driverCollect ? "true" : "false"}
                  className={clsx(
                    "mt-1 rounded-chip border px-2 py-2 text-center text-[11px] font-extrabold uppercase tracking-wide",
                    driverCollect
                      ? "border-brand bg-brand text-brand-fg"
                      : "border-line bg-surface text-fg-muted",
                  )}
                >
                  {t("delivery.collectByDriver")}
                </p>

                {/* THE THREE FIGURES. `customerPays` is computed here and
                    stored nowhere: it is the only one of the three that is
                    nobody's revenue and nobody's receivable. */}
                {(() => {
                  const split = deliveryTotals(totals.postDiscountTotal, deliveryFeeCents ?? 0);
                  return (
                    <dl className="mt-1 space-y-0.5 border-t border-line pt-1.5 text-[11px]">
                      <div className="flex justify-between">
                        <dt className="text-fg-muted">{t("delivery.foodTotal")}</dt>
                        <dd className="font-bold text-fg">{formatUsd(split.foodInclVatCents)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-fg-muted">{t("delivery.driverFee")}</dt>
                        <dd className="font-bold text-fg">{formatUsd(split.deliveryFeeCents)}</dd>
                      </div>
                      <div className="flex justify-between border-t border-line pt-0.5">
                        <dt className="font-extrabold text-fg">{t("delivery.customerPays")}</dt>
                        <dd className="font-extrabold text-fg">
                          {formatUsd(split.customerPaysCents)}
                        </dd>
                      </div>
                    </dl>
                  );
                })()}

                {driverCollect && (
                  <p className="text-[10px] font-bold leading-snug text-fg-muted">
                    {t("delivery.collectNote")}
                  </p>
                )}
                {deliveryVerdict !== null && (
                  <p className="text-[10px] font-bold leading-snug text-danger">
                    {t(`delivery.err.${deliveryVerdict}`)}
                  </p>
                )}
              </div>
            )}

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
              {(discountOpen || discountCents > 0 || discountMessage !== null) && (
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
                      {discountCents > 0 || discountMessage !== null
                        ? t("pos.discountClear")
                        : t("common.close")}
                    </button>
                  </div>
                  {/* Says what was asked for, what the most this cart can take
                      is, and — by being here at all — that nothing has been
                      applied. Post Sale is disabled until it clears. */}
                  {discountMessage && (
                    <p
                      ref={discountPanelRef}
                      role="alert"
                      className="mt-2 text-[11px] font-semibold leading-snug text-danger-fg"
                    >
                      {discountMessage}
                    </p>
                  )}
                </div>
              </div>
            )}


              {/* Totals. Real VAT, unlike the prototype's "to confirm in POS
                  setup" placeholder — this till computes it. They scroll with
                  the lines rather than being pinned: the AMOUNT DUE block
                  below is the figure that must always be on screen, and these
                  three sit immediately above it. */}
              {/* Every adjacent pair of figures here ties EXACTLY, and all of
                  them come from the one totals memo that also builds the
                  posting payload — no second calculation anywhere.

                  Without a discount:  subtotal + VAT = total.
                  With one:            items − discount = total, and
                                       net + VAT = total.

                  The strip used to print the PRE-discount subtotal beside a
                  post-discount VAT and total, so the three numbers a cashier
                  reads to a customer did not add up — by a cent on a
                  VAT-inclusive price even with no discount, and by the whole
                  discount with one (GZ-WP0-04). The discount is deducted from
                  the VAT-INCLUSIVE amount, which is why it is shown against
                  the items line and not against the net: subtracting a gross
                  discount from a net subtotal would be a new, wrong sum. */}
              <div className="mt-3 space-y-1 border-t border-line pt-2.5 squat:mt-2 squat:pt-2">
              {totals.discount > 0 ? (
                <>
                  <AmountLine
                    label={t("pos.itemsInclVat")}
                    value={formatUsd(totals.preDiscountTotal)}
                  />
                  <AmountLine
                    label={t("pos.discount")}
                    value={`-${formatUsd(totals.discount)}`}
                    tone="warn"
                  />
                  <AmountLine
                    label={t("pos.netExclVat")}
                    value={formatUsd(totals.postDiscountSubtotalExclVat)}
                  />
                </>
              ) : (
                <AmountLine
                  label={t("pos.subtotalExclVat")}
                  value={formatUsd(totals.postDiscountSubtotalExclVat)}
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

            {/* The payment panel's one job is to say what is being taken HERE.
                On a driver-collected order that is nothing, and saying so is
                what stops a cashier hunting for a drawer figure that will not
                appear. */}
            {driverCollect && (
              <p className="mt-2 rounded-chip border border-line bg-paper px-2.5 py-2 text-[11px] font-bold leading-snug text-fg-muted">
                {t("delivery.noCashHere")}
              </p>
            )}

            <div className="mt-3 space-y-2.5 squat:mt-1.5 squat:space-y-1.5 tiny:grid tiny:grid-cols-2 tiny:gap-2 tiny:space-y-0">
              <Input
                label={t("pos.cashUsdReceived")}
                inputMode="decimal"
                placeholder="0.00"
                prefix="$"
                value={cashUsdInput}
                // Nothing is taken at the counter on a driver-collected order,
                // so the boxes are closed rather than left to be filled in and
                // then ignored at post time.
                disabled={driverCollect}
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
                disabled={!rate || driverCollect}
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
