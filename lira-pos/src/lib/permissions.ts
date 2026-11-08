import type { Role } from "./auth";

/**
 * WHICH SCREENS A ROLE IS OFFERED — Gate 2B, Stage B.3.
 *
 * READ THIS FIRST: **NOTHING IN THIS FILE IS A SECURITY CONTROL.** What a role
 * may DO is decided in `src-tauri/src/authz.rs`, twice — once at the command
 * boundary and once inside the writing transaction — against the role on that
 * user's own `users` row, read from the database at the moment of the write. If
 * every line below were deleted, or replaced with `() => true`, a cashier would
 * still be refused a refund, a stock adjustment, a reprice and an exchange
 * rate. This file decides what the operator SEES.
 *
 * That is still worth having, and the reason is not cosmetic. A till that
 * offers a cashier eleven screens, nine of which refuse them, teaches the
 * cashier that Greaz is broken — and the ninth refusal is the one they ring the
 * owner about at eight in the evening. Offering three screens that all work is
 * a different product.
 *
 * ## It mirrors the matrix; it does not invent one
 *
 * Every entry below names the `Operation` in `authz.rs::permits` that makes the
 * screen useful, so the two can be compared by reading. Where a screen needs
 * several, the entry names the one the screen EXISTS for: Returns is offered to
 * whoever may `PostCreditMemo`, because a Returns screen that cannot post a
 * return is a search box.
 *
 * The one judgement call worth stating is SALES HISTORY. It is a read screen
 * and a cashier can reasonably want to look up a receipt — but the columns it
 * prints are the unit COGS, the line cost, the margin and the cost-source
 * provenance, which `ReadCostAndMargin` reserves for a manager. Stage C is what
 * will enforce the read side; until then this withholds the screen rather than
 * showing a cashier the kitchen's food cost, because a nav entry is a decision
 * about what is normal to look at. A cashier who needs a receipt number has it
 * on the printed copy and on the register's own last-sale panel.
 *
 * ## The cached role can be one poll interval stale, and that is safe
 *
 * This reads the role out of the session cache (`state/session.ts`), which is
 * refreshed by `useSessionWatch` every fifteen seconds. So for up to that long
 * after an owner demotes somebody, the demoted person's rail can still show a
 * screen they no longer have. Nothing follows from it: their next write is
 * authorized against the database and refused, and the refusal names what to do
 * — and the next poll takes the screen away. The alternative, re-asking the
 * backend before drawing each nav item, would put a command behind every
 * render for a guarantee the backend already makes.
 */

/** Every routed screen in the application, as a value the rail and the router
 *  can both name. */
export type AppScreen =
  | "register"
  | "shift"
  | "drivers"
  | "products"
  | "inventory"
  | "purchases"
  | "suppliers"
  | "sales"
  | "returns"
  | "reports"
  | "exchangeRate"
  | "manager"
  | "users";

interface ScreenPolicy {
  /** The route path, without a leading slash (`""` is the index). */
  path: string;
  /** The roles offered this screen. */
  roles: readonly Role[];
  /** The `authz.rs::permits` operation this screen exists to perform. */
  operation: string;
}

const ALL: readonly Role[] = ["owner", "manager", "cashier"];
const SUPERVISORY: readonly Role[] = ["owner", "manager"];
const OWNER_ONLY: readonly Role[] = ["owner"];

/**
 * THE ONE TABLE. The rail, the router and the tests all read it, so a screen
 * cannot be offered in the nav and refused by the router, or the other way
 * round — which is the failure this would otherwise grow into, because the two
 * lists live in different files.
 */
export const SCREENS: Record<AppScreen, ScreenPolicy> = {
  // --- front of house: a cashier's actual job ------------------------------
  register: { path: "", roles: ALL, operation: "PostSale" },
  shift: { path: "shift", roles: ALL, operation: "OpenShift / CloseOwnShift" },
  // A cashier takes the driver's hand-over at the till — `DriverRemittance` is
  // theirs in the matrix. Saving a driver and adjusting a balance are not, and
  // the screen refuses those on its own.
  drivers: { path: "drivers", roles: ALL, operation: "DriverRemittance" },

  // --- supervision --------------------------------------------------------
  products: { path: "products", roles: SUPERVISORY, operation: "SaveProduct" },
  inventory: { path: "inventory", roles: SUPERVISORY, operation: "PostAdjustment" },
  purchases: { path: "purchases", roles: SUPERVISORY, operation: "PostPurchase" },
  suppliers: { path: "suppliers", roles: SUPERVISORY, operation: "SupplierSave" },
  sales: { path: "sales", roles: SUPERVISORY, operation: "ReadCostAndMargin" },
  returns: { path: "returns", roles: SUPERVISORY, operation: "PostCreditMemo" },
  reports: { path: "reports", roles: SUPERVISORY, operation: "ReadProfitReports" },
  exchangeRate: {
    path: "exchange-rate",
    roles: SUPERVISORY,
    operation: "ExchangeRateSave",
  },
  manager: { path: "manager", roles: SUPERVISORY, operation: "ReadProfitReports" },

  // --- administration -----------------------------------------------------
  // BOTH operations, because the screen exists for both and withholding the
  // screen is what withholds them. Naming only `UserAdmin` left
  // `ResetAnotherCredential` unaccounted for, which the closure test in
  // `rolePermissions.test.ts` found the moment it existed.
  users: {
    path: "users",
    roles: OWNER_ONLY,
    operation: "UserAdmin / ResetAnotherCredential",
  },
};

/**
 * CAPABILITIES INSIDE A SCREEN — Gate 2B, Stage B.3, round 2.
 *
 * A screen is too coarse a unit, and an independent review found two places
 * where that mattered. Some screens do several jobs at different authority
 * levels, and offering the screen offers all of them:
 *
 *   * SHIFT holds the cashier's own shift AND the closed-shift history of every
 *     operator in the store — counted cash, expected cash and each variance.
 *     `OpenShift` is a cashier's; `ReadAnotherShiftHistory` is explicitly not.
 *     This was the P1: the read channel is not role-gated until Stage C, so a
 *     cashier offered that tab could read other people's drawer variances
 *     through the ordinary UI. The same screen also offered the CLOSE button on
 *     whichever shift the store had open — which is somebody else's whenever
 *     the cashier did not open it, since the shift scope is the STORE.
 *     `CloseAnotherShift` is a manager's, and closing a shift writes its
 *     reconciliation once and immutably (migration 009), so the refusal has to
 *     arrive before the cash is counted rather than after.
 *   * DRIVERS holds taking a hand-over, which is a cashier's job, beside adding,
 *     editing and retiring a driver, which is a manager's.
 *   * PRODUCTS holds the menu, which is a manager's, beside what an item COSTS,
 *     which is the owner's alone.
 *
 * Three remarks about what this is and is not.
 *
 * It is still not a control. `authz.rs` refuses each of these at the command,
 * and the cost fields are refused by `catalog.rs::cost_fields_would_change`
 * comparing what is stored. Withholding the control stops the operator being
 * invited to do something that will fail; in the shift-history case it also
 * withholds a READ that nothing else yet refuses, which is the part that
 * matters before Stage C.
 *
 * A LARGE DISCOUNT IS DELIBERATELY NOT HERE. `PostSaleLargeDiscount` governs
 * the SIZE of a discount, not the control: a cashier may round thirty cents off
 * a cold coffee and is refused thirty per cent, with the limit stated in the
 * refusal. Hiding the discount box from a cashier would remove the small
 * kindnesses the policy exists to keep available. That is a decision in
 * `authz.rs`, and the register already follows it.
 */
export type Capability =
  /** `ReadAnotherShiftHistory` — the closed-shift reconciliation of any operator. */
  | "readShiftHistory"
  /** `CloseAnotherShift` — close a shift somebody else opened. */
  | "closeAnotherShift"
  /** `DriverSave` — add, edit or retire a driver. */
  | "driverAdmin"
  /** `DriverLedgerAdjustment` — write a driver's balance up or down by hand. */
  | "driverLedgerAdjustment"
  /** `SaveProductCost` — what an item costs. Owner only; see the note in `authz.rs`. */
  | "productCost";

const CAPABILITIES: Record<Capability, readonly Role[]> = {
  readShiftHistory: SUPERVISORY,
  closeAnotherShift: SUPERVISORY,
  driverAdmin: SUPERVISORY,
  driverLedgerAdjustment: SUPERVISORY,
  productCost: OWNER_ONLY,
};

/** Whether a role may use a capability inside a screen it has been offered. */
export function canDo(
  role: Role | null | undefined,
  capability: Capability,
): boolean {
  if (!role) return false;
  return CAPABILITIES[capability].includes(role);
}

/** The `authz.rs::permits` operation each capability mirrors, for the test that
 *  compares the two tables. */
export const CAPABILITY_OPERATIONS: Record<Capability, string> = {
  readShiftHistory: "ReadAnotherShiftHistory",
  closeAnotherShift: "CloseAnotherShift",
  driverAdmin: "DriverSave",
  driverLedgerAdjustment: "DriverLedgerAdjustment",
  productCost: "SaveProductCost",
};

/** Whether a role is offered a screen. A missing role (no session) is offered
 *  nothing, which is what the locked and login states already render. */
export function canSee(role: Role | null | undefined, screen: AppScreen): boolean {
  if (!role) return false;
  return SCREENS[screen].roles.includes(role);
}

/** The screens a role is offered, for the rail and for the tests. */
export function screensFor(role: Role | null | undefined): AppScreen[] {
  return (Object.keys(SCREENS) as AppScreen[]).filter((s) => canSee(role, s));
}

/**
 * Where a role should land.
 *
 * Always the register: it is the one screen every role has, and it is where a
 * till should be sitting when nobody is doing anything else to it.
 */
export const HOME_PATH = "/";
