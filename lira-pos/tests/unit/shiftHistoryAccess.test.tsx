// @vitest-environment jsdom
/**
 * WHO IS OFFERED THE SHIFT HISTORY — Gate 2B, Stage B.3, round 2.
 *
 * An independent review found this as a P1 and the severity is right. The Shift
 * screen does two jobs: a cashier's own shift, which is their job, and the
 * CLOSED-SHIFT HISTORY of every operator in the store — who closed it, what
 * they counted, what was expected, and the variance they were held to.
 * `authz.rs::permits` denies a cashier `ReadAnotherShiftHistory` explicitly. The
 * screen was offered to every role on the strength of `OpenShift` alone, so a
 * cashier could read another cashier's drawer variance through the ordinary UI.
 *
 * WHY THIS IS TESTED BEHAVIOURALLY RATHER THAN BY READING THE SOURCE. Every
 * other role rule in this application is enforced in Rust and the UI merely
 * declines to invite a refusal. This one is different: `ShiftHistoryPanel`
 * composes ordinary repository reads, and the read channel is not role-gated
 * until Stage C, so NOT RENDERING THE TAB is what currently enforces the rule.
 * A grep for a capability string would not have caught the tab being rendered
 * anyway.
 *
 * The companion assertions — that the capability table matches the Rust matrix,
 * and that every role is offered the right screens — are in
 * `tests/unit/rolePermissions.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { Role } from "../../src/lib/auth";

vi.mock("../../src/db/client", () => ({ query: vi.fn(async () => []) }));

/** The history panel, stubbed to a marker. What is under test is whether it is
 *  MOUNTED, not what it draws. */
vi.mock("../../src/components/ShiftHistoryPanel", () => ({
  ShiftHistoryPanel: () => <div data-testid="history-panel">history</div>,
}));

vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({
    hydrated: true,
    storeId: "s1",
    userId: "u1",
    deviceId: "d1",
  }),
}));

/** The open shift the screen is looking at, or null. Set per test. */
let openShift: Record<string, unknown> | null = null;

vi.mock("../../src/db/repos/shifts", () => ({
  shiftsRepo: {
    getOpenShift: vi.fn(async () => openShift),
    getSalesSummary: vi.fn(async () => null),
    getPaymentBreakdown: vi.fn(async () => []),
    getDrawerExpectation: vi.fn(async () => null),
    getRefundSummary: vi.fn(async () => null),
    getRefundBreakdown: vi.fn(async () => []),
    openShift: vi.fn(),
    closeShift: vi.fn(),
  },
}));

/** A shift this store has open, opened by whoever is named. */
function shiftOpenedBy(userId: string) {
  return {
    id: "shift-1",
    storeId: "s1",
    deviceId: null,
    openedByUserId: userId,
    closedByUserId: null,
    openedAt: "2026-11-09T08:00:00.000Z",
    closedAt: null,
    openingCashUsdCents: 0,
    openingCashLbp: 0,
    closingCashUsdCents: null,
    closingCashLbp: null,
    expectedCashUsdCents: null,
    expectedCashLbp: null,
    varianceUsdCents: null,
    varianceLbp: null,
    status: "open",
    notes: null,
  };
}

import ShiftSummary from "../../src/pages/ShiftSummary";
import { useSession } from "../../src/state/session";

function signedInAs(role: Role) {
  useSession.setState({
    loading: false,
    error: null,
    status: {
      schemaVersion: 24,
      storeId: "s1",
      storeName: "Greaz",
      enrollmentState: "initialized",
      enrollmentCodeFile: null,
      enrollmentLocked: false,
      accounts: [],
      session: {
        userId: "u1",
        fullName: "Whoever",
        storeId: "s1",
        role,
        locked: false,
        mustChangeCredential: false,
        idleSecondsRemaining: 900,
        openedSecondsAgo: 5,
      },
      sessionGeneration: 1,
      loginRestrictedToOwner: false,
      idleLockSeconds: 900,
    },
  });
}

function draw() {
  return render(
    <I18nProvider>
      <ShiftSummary />
    </I18nProvider>,
  );
}

beforeEach(() => {
  openShift = null;
  useSession.setState({ status: null, error: null, loading: false });
});
afterEach(() => cleanup());

describe("the shift history tab", () => {
  it("is offered to a manager and to the owner", async () => {
    for (const role of ["owner", "manager"] as const) {
      signedInAs(role);
      draw();
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Shift history" })).toBeTruthy(),
      );
      expect(screen.getByRole("tab", { name: "Current shift" })).toBeTruthy();
      cleanup();
    }
  });

  it("IS NOT OFFERED TO A CASHIER, and the panel is not mounted", async () => {
    signedInAs("cashier");
    draw();

    // The Current tab's own content still arrives, so this is the screen
    // working rather than the screen failing to render.
    await waitFor(() => expect(screen.getByText("Shift Summary")).toBeTruthy());

    expect(screen.queryByRole("tab", { name: "Shift history" })).toBeNull();
    // NOT MERELY HIDDEN. The panel is what reads other operators' variances,
    // and nothing below the render would refuse it, so it must not be mounted.
    expect(screen.queryByTestId("history-panel")).toBeNull();

    // And no tab strip at all, because a cashier has one tab. A tablist with a
    // single tab is a label pretending to be a control.
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("is not offered while the till is locked, or before anybody signs in", async () => {
    // `useActiveUser()` returns null for both, deliberately: a locked session
    // has a user but no authority, and the lock is an OVERLAY over a mounted
    // router — so the office screens behind the glass must not be advertising
    // what they hold.
    signedInAs("owner");
    useSession.setState((s) => ({
      status: s.status && {
        ...s.status,
        session: s.status.session && { ...s.status.session, locked: true },
      },
    }));
    draw();
    await waitFor(() => expect(screen.getByText("Shift Summary")).toBeTruthy());
    expect(screen.queryByTestId("history-panel")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Shift history" })).toBeNull();
    cleanup();

    useSession.setState({ status: null, error: null, loading: false });
    draw();
    await waitFor(() => expect(screen.getByText("Shift Summary")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Shift history" })).toBeNull();
  });
});

describe("closing somebody else's shift", () => {
  /**
   * `CloseOwnShift` is every role's; `CloseAnotherShift` is a manager's and the
   * owner's. The shift scope is the STORE — `getOpenShift(storeId)` — so the
   * open shift a cashier is looking at is frequently NOT theirs, and the close
   * button was offered regardless (independent review, Stage B.3 round 2).
   *
   * Why this matters more than an ordinary refused control: closing a shift
   * computes `expected_cash_*` and both variances once, inside the transaction
   * that closes it, and migration 009 makes them immutable. There is no second
   * attempt. So the refusal has to arrive BEFORE the cashier counts the drawer,
   * not after they have typed the figures and pressed the button.
   */
  it("offers the close control on a cashier's OWN shift", async () => {
    openShift = shiftOpenedBy("u1");
    signedInAs("cashier");
    draw();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close shift" })).toBeTruthy(),
    );
  });

  it("WITHHOLDS it on somebody else's, and says who may close it", async () => {
    openShift = shiftOpenedBy("somebody-else");
    signedInAs("cashier");
    draw();

    await waitFor(() => expect(screen.getByText("Shift Summary")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Close shift" })).toBeNull();
    expect(
      screen.getByText(/Only a manager or the owner can close/),
    ).toBeTruthy();
  });

  it("offers it to a manager on anybody's shift", async () => {
    openShift = shiftOpenedBy("somebody-else");
    signedInAs("manager");
    draw();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close shift" })).toBeTruthy(),
    );
  });

  it("withholds it while the till is locked", async () => {
    // A locked session has a user but no authority, and the lock is an overlay
    // over a mounted router. Nothing behind the glass should be offering to
    // write an immutable reconciliation.
    openShift = shiftOpenedBy("u1");
    signedInAs("owner");
    useSession.setState((s) => ({
      status: s.status && {
        ...s.status,
        session: s.status.session && { ...s.status.session, locked: true },
      },
    }));
    draw();

    await waitFor(() => expect(screen.getByText("Shift Summary")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Close shift" })).toBeNull();
  });
});
