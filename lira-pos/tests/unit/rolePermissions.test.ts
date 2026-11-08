/**
 * WHAT EACH ROLE IS OFFERED, AND WHETHER IT AGREES WITH THE BACKEND.
 * Gate 2B, Stage B.3.
 *
 * `src/lib/permissions.ts` is presentation — the rail and the router read it,
 * and `authz.rs` is what actually refuses. But a nav policy that disagrees with
 * the matrix is not harmless in either direction:
 *
 *   * offer too MUCH and a cashier is handed eight screens that refuse them,
 *     which is the shape a product takes when it looks broken;
 *   * offer too LITTLE and a manager cannot reach a job the backend would let
 *     them do, with nothing on screen saying why — the worse of the two,
 *     because there is no refusal to read and no owner to ask.
 *
 * So the last test in this file reads `authz.rs` and compares the two tables
 * directly. It is a source-text assertion, which is normally a poor way to test
 * anything; here it is the only way to catch the drift at all, because the two
 * halves are in different languages and nothing else connects them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_OPERATIONS,
  SCREENS,
  canDo,
  canSee,
  screensFor,
  type AppScreen,
  type Capability,
} from "../../src/lib/permissions";
import type { Role } from "../../src/lib/auth";

const ROLES: Role[] = ["owner", "manager", "cashier"];

describe("the screens a role is offered", () => {
  it("gives the owner everything", () => {
    const all = (Object.keys(SCREENS) as AppScreen[]).sort();
    expect(screensFor("owner").sort()).toEqual(all);
  });

  it("gives a cashier the till and nothing that reads a cost", () => {
    // THE WHOLE POINT OF THE STAGE, in one assertion. A cashier sells, runs
    // their own shift, and takes the driver's hand-over. Everything else is
    // either money out, a correction, the menu's prices or a report built on
    // costs — and the matrix says none of those is theirs.
    expect(screensFor("cashier").sort()).toEqual(["drivers", "register", "shift"]);
  });

  it("gives a manager everything except staff administration", () => {
    const manager = screensFor("manager");
    expect(manager).not.toContain("users");
    // And everything else. A manager who cannot reach a screen the backend
    // would let them use has no refusal to read and nobody to ask.
    for (const screen of Object.keys(SCREENS) as AppScreen[]) {
      if (screen === "users") continue;
      expect(manager, `manager should be offered ${screen}`).toContain(screen);
    }
  });

  it("offers nothing at all without a session", () => {
    // Which is what a LOCKED till is: `useActiveUser()` returns null while
    // locked, and a locked till should not be advertising the office screens
    // behind the glass.
    expect(screensFor(null)).toEqual([]);
    expect(screensFor(undefined)).toEqual([]);
    for (const screen of Object.keys(SCREENS) as AppScreen[]) {
      expect(canSee(null, screen)).toBe(false);
    }
  });

  it("names a distinct, leading-slash-free path for every screen", () => {
    // The rail writes `/${path}` and the router registers `path`, so a stray
    // leading slash would make a route unreachable in one of the two and a
    // duplicate would silently shadow a screen.
    const paths = Object.values(SCREENS).map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(false);
    }
    expect(SCREENS.register.path).toBe("");
  });

  it("gives every screen at least one role", () => {
    // A screen nobody is offered is a screen that is routed, maintained and
    // unreachable — a thing that rots.
    for (const [screen, policy] of Object.entries(SCREENS)) {
      expect(policy.roles.length, `${screen} is offered to nobody`).toBeGreaterThan(0);
    }
  });
});

describe("the frontend policy against the Rust matrix", () => {
  /**
   * `authz.rs::permits` for one (role, operation) pair, read out of the source.
   *
   * The matrix is a Rust `match` whose first arm is `(Owner, _) => true`, so
   * the owner is answered without a lookup. Every other arm is one line of the
   * form `(Manager | Cashier, Op) => bool` or `(Manager, Op) => bool`, which is
   * what makes this readable at all — and if that shape ever changes, this
   * helper throws rather than guessing.
   */
  function permits(role: Exclude<Role, "owner">, operation: string): boolean {
    const src = readFileSync(
      new URL("../../src-tauri/src/authz.rs", import.meta.url),
      "utf8",
    );
    const body = src.slice(src.indexOf("pub(crate) fn permits("));
    const rustRole = role === "manager" ? "Manager" : "Cashier";

    // `(Manager, Op) => true,` or `(Manager | Cashier, Op | Other) => false,`
    const pattern = new RegExp(
      String.raw`\(\s*([A-Za-z |]+?)\s*,\s*([A-Za-z |]+?)\s*\)\s*=>\s*(true|false)\s*,`,
      "g",
    );
    for (const m of body.matchAll(pattern)) {
      const roles = m[1].split("|").map((r) => r.trim());
      const ops = m[2].split("|").map((o) => o.trim());
      if (roles.includes(rustRole) && ops.includes(operation)) {
        return m[3] === "true";
      }
    }
    throw new Error(
      `authz.rs::permits has no arm for (${rustRole}, ${operation}). ` +
        `Either the operation was renamed or the matrix changed shape; ` +
        `this test cannot be trusted until it is updated.`,
    );
  }

  it("reads the Rust matrix at all", () => {
    // A guard on the guard. If the source moved or the match shape changed,
    // every assertion below would pass vacuously by throwing in a way nobody
    // reads — so the two ends of the matrix are asserted first.
    expect(permits("manager", "PostCreditMemo")).toBe(true);
    expect(permits("cashier", "PostCreditMemo")).toBe(false);
    expect(permits("cashier", "PostSale")).toBe(true);
    expect(permits("manager", "UserAdmin")).toBe(false);
  });

  it("offers each role exactly the screens whose operation the backend permits", () => {
    for (const [screen, policy] of Object.entries(SCREENS) as [
      AppScreen,
      (typeof SCREENS)[AppScreen],
    ][]) {
      // A screen may name several operations; the entry names the one it
      // EXISTS for, and the compound entries are checked against each.
      const operations = policy.operation.split("/").map((o) => o.trim());

      for (const role of ROLES) {
        if (role === "owner") {
          // `(Owner, _) => true`, so the owner is offered everything and
          // there is nothing to compare.
          expect(canSee("owner", screen)).toBe(true);
          continue;
        }
        const backend = operations.every((op) => permits(role, op));
        expect(
          canSee(role, screen),
          `${role} / ${screen}: the rail says ${canSee(role, screen)} but ` +
            `authz.rs::permits says ${backend} for ${policy.operation}`,
        ).toBe(backend);
      }
    }
  });
});

describe("the router cannot drift from the policy", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const shell = readFileSync(
    new URL("../../src/components/AppShell.tsx", import.meta.url),
    "utf8",
  );

  /**
   * THE FAILURE THIS CATCHES is adding a screen and forgetting the guard.
   *
   * The rail and the guard are in different files, and a route registered
   * without a `<RequireRole>` is mounted for everybody — silently, because the
   * rail will not be offering it to a cashier and nobody will notice until a
   * redirect or a restored deep link lands there. Stage C has not yet gated the
   * read channel, so a wrongly-mounted Products or Sales History screen shows a
   * cashier the kitchen's food cost.
   */
  it("guards every route whose screen is restricted", () => {
    for (const [screen, policy] of Object.entries(SCREENS) as [
      AppScreen,
      (typeof SCREENS)[AppScreen],
    ][]) {
      const restricted = policy.roles.length < ROLES.length;
      const guarded = app.includes(`<RequireRole screen="${screen}">`);
      expect(
        guarded,
        restricted
          ? `the ${screen} route must be wrapped in <RequireRole screen="${screen}">`
          : `${screen} is offered to every role, so wrapping it is misleading`,
      ).toBe(restricted);
    }
  });

  it("registers no route this policy has never heard of", () => {
    // Every routed path must be a screen in `SCREENS`, so a new page cannot be
    // added to the router without a decision about who may see it. The index
    // route, the catch-all and the dev probe are the three deliberate
    // exceptions and are named here rather than pattern-matched away.
    const known = new Set(Object.values(SCREENS).map((s) => s.path));
    const exceptions = new Set(["*", "_dev"]);
    const paths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);

    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      if (exceptions.has(path)) continue;
      // `suppliers/:id` is the supplier detail screen, guarded as `suppliers`.
      const base = path.split("/")[0];
      expect(
        known.has(path) || known.has(base),
        `the route "${path}" has no entry in lib/permissions.ts — decide who ` +
          `may see it before routing it`,
      ).toBe(true);
    }
  });

  it("filters the rail through the same policy rather than its own list", () => {
    // The rail must ask `canSee`. A `NavLink` rendered unconditionally is a
    // screen offered to a cashier that the guard will then bounce them out of,
    // which reads as the application losing its place.
    expect(shell).toContain('from "../lib/permissions"');
    const navLinks = [...shell.matchAll(/<NavLink\s+to="([^"]+)"/g)].map((m) => m[1]);
    expect(navLinks.length).toBeGreaterThan(5);
    for (const to of navLinks) {
      if (to === "/_dev") continue;
      const path = to.replace(/^\//, "");
      const screen = (Object.keys(SCREENS) as AppScreen[]).find(
        (s) => SCREENS[s].path === path,
      );
      expect(screen, `the rail links to "${to}" with no policy entry`).toBeTruthy();
      // Unrestricted screens need no `show(...)`; restricted ones do.
      if (SCREENS[screen as AppScreen].roles.length < ROLES.length) {
        expect(
          shell.includes(`show("${screen}")`),
          `the rail must gate "${to}" with show("${screen}")`,
        ).toBe(true);
      }
    }
  });
});

describe("capabilities inside a screen", () => {
  /**
   * A SCREEN IS TOO COARSE A UNIT, and an independent review of Stage B.3 found
   * two places where that mattered: the Shift screen carried every operator's
   * closed-shift reconciliation behind a cashier's own-shift controls, and the
   * Drivers screen carried the driver records behind the hand-over a cashier
   * takes. The capability table is the finer grain, and it is compared against
   * the Rust matrix exactly as the screen table is — the comparison is the
   * whole value of having named the operations.
   */
  it("matches the Rust matrix for every capability", () => {
    const src = readFileSync(
      new URL("../../src-tauri/src/authz.rs", import.meta.url),
      "utf8",
    );
    const body = src.slice(src.indexOf("pub(crate) fn permits("));
    const pattern =
      /\(\s*([A-Za-z |]+?)\s*,\s*([A-Za-z |]+?)\s*\)\s*=>\s*(true|false)\s*,/g;
    const arms = [...body.matchAll(pattern)].map((m) => ({
      roles: m[1].split("|").map((r) => r.trim()),
      ops: m[2].split("|").map((o) => o.trim()),
      allowed: m[3] === "true",
    }));

    for (const [capability, operation] of Object.entries(CAPABILITY_OPERATIONS) as [
      Capability,
      string,
    ][]) {
      for (const role of ["manager", "cashier"] as const) {
        const rustRole = role === "manager" ? "Manager" : "Cashier";
        const arm = arms.find(
          (a) => a.roles.includes(rustRole) && a.ops.includes(operation),
        );
        expect(arm, `authz.rs has no arm for (${rustRole}, ${operation})`).toBeTruthy();
        expect(
          canDo(role, capability),
          `${role} / ${capability}: the UI says ${canDo(role, capability)} but ` +
            `authz.rs::permits says ${arm?.allowed} for ${operation}`,
        ).toBe(arm?.allowed);
      }
      // `(Owner, _) => true`.
      expect(canDo("owner", capability)).toBe(true);
    }
  });

  it("gives a cashier none of them, and nothing without a session", () => {
    // The cashier row is the one the review was about. Each of these is a
    // control or a READ that the backend does not refuse yet — the read channel
    // is ungated until Stage C — so withholding it is what currently enforces
    // it, and a regression here would be silent.
    for (const capability of Object.keys(CAPABILITY_OPERATIONS) as Capability[]) {
      expect(canDo("cashier", capability)).toBe(false);
      expect(canDo(null, capability)).toBe(false);
    }
  });

  it("is used by the screens that hold the capability, not just declared", () => {
    // A capability nothing calls is a comment. Each is asserted at its own
    // call site, because that is the thing that would be deleted by accident.
    const used: [Capability, string][] = [
      ["readShiftHistory", "src/pages/ShiftSummary.tsx"],
      ["driverAdmin", "src/pages/Drivers.tsx"],
      ["productCost", "src/pages/Products.tsx"],
    ];
    for (const [capability, file] of used) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(src, `${file} must gate on "${capability}"`).toContain(
        `"${capability}"`,
      );
      expect(src).toContain('from "../lib/permissions"');
    }
  });
});

describe("no operation the backend withholds is forgotten by the UI", () => {
  /**
   * THE TEST THAT CAN DISCOVER AN OMISSION.
   *
   * The two comparisons above check the entries the policy ALREADY NAMES
   * against `authz.rs`, which is exactly the shape of mistake they cannot
   * catch: an operation the matrix withholds from a cashier and the policy
   * never mentions passes both of them, because nothing asks whether it exists.
   * That is how `CloseAnotherShift` survived a round of review — the Shift
   * screen offered the close button on whichever shift the store had open, the
   * policy named only `OpenShift / CloseOwnShift`, and the comparison agreed
   * with itself.
   *
   * So the set is CLOSED. Every operation `permits` denies a cashier must be
   * accounted for in one of three ways, and a new one that is not fails this
   * test by name:
   *
   *   1. it is the operation a whole SCREEN exists for, so withholding the
   *      screen withholds it;
   *   2. it is a CAPABILITY inside a screen the cashier does have;
   *   3. it is in `DELIBERATELY_UNGATED` below, with a stated reason — which is
   *      a decision, reviewable in one place, rather than an oversight.
   *
   * Operations a cashier IS permitted need no entry: there is nothing to
   * withhold.
   */
  const DELIBERATELY_UNGATED: Record<string, string> = {
    // The role governs the SIZE of a discount, not the control. A cashier
    // rounding thirty cents off a cold coffee is daily practice and making them
    // fetch a manager for it would mean the manager's passphrase is shared
    // within a week; thirty per cent off is not daily practice. So the box
    // stays, the backend refuses the large one, and the refusal states the
    // limit. Hiding the box would remove the small kindnesses the policy exists
    // to keep available.
    PostSaleLargeDiscount:
      "a cashier may give a small discount; the backend refuses a large one and says so",

    // Reached ONLY from the Products screen and its recipe editor, both of
    // which are supervisory, so the `products` screen already withholds them. A
    // capability would be a second lock on the same door.
    RecipeDraft: "reached only from Products, which is supervisory",
    RecipeActivate: "reached only from Products, which is supervisory",
    RecipeRetire: "reached only from Products, which is supervisory",

    // Barcodes are edited from the Products screen only (BarcodeManager is
    // mounted inside the product form), so the same argument applies.
    ProductBarcode: "reached only from Products, which is supervisory",

    // Suppliers' payment and record screens are both behind the `suppliers`
    // screen, which is supervisory.
    SupplierPayment: "reached only from Suppliers, which is supervisory",
    SupplierSave: "reached only from Suppliers, which is supervisory",

    // The Purchases screen is supervisory and is the only way to enter one.
    PostPurchase: "reached only from Purchases, which is supervisory",

    // NO UI READS THE SIGN-IN LOG YET. When one is built it needs a screen
    // entry or a capability, and this line is what will make that explicit
    // rather than remembered.
    ReadAuthAudit: "no screen reads the security log yet (Stage C)",
  };

  it("accounts for every operation a cashier is denied", () => {
    const src = readFileSync(
      new URL("../../src-tauri/src/authz.rs", import.meta.url),
      "utf8",
    );

    // The enum's variants, from the declaration rather than from the match, so
    // an operation that has an arm but no variant (or the reverse) cannot hide.
    const enumBody = src
      .slice(src.indexOf("pub(crate) enum Operation {"))
      .split("\n}")[0];
    const variants = [...enumBody.matchAll(/^\s{4}([A-Z][A-Za-z]*),$/gm)].map(
      (m) => m[1],
    );
    expect(variants.length).toBeGreaterThan(20);

    const body = src.slice(src.indexOf("pub(crate) fn permits("));
    const pattern =
      /\(\s*([A-Za-z |]+?)\s*,\s*([A-Za-z |]+?)\s*\)\s*=>\s*(true|false)\s*,/g;
    const arms = [...body.matchAll(pattern)].map((m) => ({
      roles: m[1].split("|").map((r) => r.trim()),
      ops: m[2].split("|").map((o) => o.trim()),
      allowed: m[3] === "true",
    }));

    const screenOperations = new Set(
      Object.values(SCREENS).flatMap((p) => p.operation.split("/").map((o) => o.trim())),
    );
    const capabilityOperations = new Set(Object.values(CAPABILITY_OPERATIONS));

    const unaccounted: string[] = [];
    for (const operation of variants) {
      const arm = arms.find(
        (a) => a.roles.includes("Cashier") && a.ops.includes(operation),
      );
      expect(
        arm,
        `authz.rs declares Operation::${operation} but permits() has no cashier arm for it`,
      ).toBeTruthy();
      if (arm?.allowed) continue; // nothing withheld, nothing to gate

      if (
        screenOperations.has(operation) ||
        capabilityOperations.has(operation) ||
        operation in DELIBERATELY_UNGATED
      ) {
        continue;
      }
      unaccounted.push(operation);
    }

    expect(
      unaccounted,
      `these operations are withheld from a cashier by authz.rs and the UI ` +
        `policy says nothing about them. Give each one a screen entry, a ` +
        `capability, or a line in DELIBERATELY_UNGATED with the reason`,
    ).toEqual([]);
  });

  it("keeps DELIBERATELY_UNGATED honest", () => {
    // An entry for an operation that no longer exists, or that a cashier is in
    // fact allowed, is a stale decision pretending to be a current one.
    const src = readFileSync(
      new URL("../../src-tauri/src/authz.rs", import.meta.url),
      "utf8",
    );
    const body = src.slice(src.indexOf("pub(crate) fn permits("));
    const pattern =
      /\(\s*([A-Za-z |]+?)\s*,\s*([A-Za-z |]+?)\s*\)\s*=>\s*(true|false)\s*,/g;
    const arms = [...body.matchAll(pattern)].map((m) => ({
      roles: m[1].split("|").map((r) => r.trim()),
      ops: m[2].split("|").map((o) => o.trim()),
      allowed: m[3] === "true",
    }));

    for (const [operation, reason] of Object.entries(DELIBERATELY_UNGATED)) {
      const arm = arms.find(
        (a) => a.roles.includes("Cashier") && a.ops.includes(operation),
      );
      expect(arm, `DELIBERATELY_UNGATED names ${operation}, which authz.rs does not`)
        .toBeTruthy();
      expect(
        arm?.allowed,
        `${operation} is permitted to a cashier, so it does not belong here`,
      ).toBe(false);
      expect(reason.length, `${operation} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
