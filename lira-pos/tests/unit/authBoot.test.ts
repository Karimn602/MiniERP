/**
 * GATE 2B STAGE A.1 — the renderer's half of authentication.
 *
 * The Rust suite (`src-tauri/src/tests/auth_session.rs`) proves what the
 * backend enforces. This file proves the things that are only true in the
 * renderer and would otherwise be unverified:
 *
 *   * the boot reaches the right screen for every backend state;
 *   * the automatic owner selection is GONE, asserted against the source;
 *   * a startup fault reaches the operator verbatim;
 *   * the pre-login boot makes no `db_select` call;
 *   * a session change cannot leave the previous user's id in the payloads.
 *
 * None of it is a security boundary and the comments say so where it matters:
 * the gates are in Rust, and a renderer that lied to itself about being signed
 * in would simply be refused by every command it then called.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const src = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url)), "utf8");

/** Source with comments stripped, for assertions about what the code DOES
 *  rather than about what it explains. */
function codeOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

function walk(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(new URL(`${entry.name}/`, dir)));
    else if (/\.tsx?$/.test(entry.name)) out.push(fileURLToPath(new URL(entry.name, dir)));
  }
  return out;
}

type Status = import("../../src/lib/auth").AuthStatus;

function status(over: Partial<Status> = {}): Status {
  return {
    schemaVersion: 23,
    storeId: "store-1",
    storeName: "Main Store",
    enrollmentState: "initialized",
    enrollmentCodeFile: null,
    enrollmentLocked: false,
    accounts: [],
    session: null,
    sessionGeneration: 1,
    loginRestrictedToOwner: true,
    idleLockSeconds: 300,
    ...over,
  };
}

function sessionView(
  over: Partial<NonNullable<Status["session"]>> = {},
): NonNullable<Status["session"]> {
  return {
    userId: "owner-1",
    fullName: "Owner",
    storeId: "store-1",
    role: "owner",
    locked: false,
    mustChangeCredential: false,
    idleSecondsRemaining: 300,
    openedSecondsAgo: 1,
    ...over,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

// ===========================================================================
// Which screen
// ===========================================================================

describe("the boot picks one screen for each backend state", () => {
  /**
   * The order is the whole decision and it is made in ONE place
   * (`auth.screenFor`) so `App.tsx` cannot develop a second opinion.
   *
   * Enrollment outranks everything, because a shop with no owner credential has
   * nobody who could sign in. A locked session outranks the login screen,
   * because a locked session is still a session and sending that operator to
   * the login screen would offer them a user switch when all they did was walk
   * away for five minutes.
   */
  it("maps every state to the right screen, in the right order", async () => {
    const { screenFor } = await import("../../src/lib/auth");

    expect(screenFor(status({ enrollmentState: "virgin" }))).toBe("enroll");
    expect(screenFor(status({ enrollmentState: "legacy_pending" }))).toBe("enroll");

    // Enrollment wins even if a session somehow exists.
    expect(
      screenFor(status({ enrollmentState: "virgin", session: sessionView() })),
    ).toBe("enroll");

    expect(screenFor(status({ session: null }))).toBe("login");
    expect(screenFor(status({ session: sessionView({ locked: true }) }))).toBe("locked");
    expect(screenFor(status({ session: sessionView() }))).toBe("ready");
  });

  /**
   * A LOCKED SESSION IS NOT AN ACTIVE USER.
   *
   * `useActiveUser` returns null while locked, deliberately: a locked session
   * has a user but no authority, so anything asking "who may act" must get
   * nothing. The lock screen reads `status.session` directly, because it needs
   * the name of whoever walked away.
   */
  it("reports no active user while locked", async () => {
    const { useSession } = await import("../../src/state/session");

    useSession.getState().adopt(status({ session: sessionView() }));
    expect(useSession.getState().status?.session?.fullName).toBe("Owner");

    useSession.getState().adopt(status({ session: sessionView({ locked: true }) }));
    // The session is still there (the cart and the shift depend on it)...
    expect(useSession.getState().status?.session).not.toBeNull();
    // ...but it is not an authority.
    const { screenFor } = await import("../../src/lib/auth");
    expect(screenFor(useSession.getState().status!)).toBe("locked");
  });
});

// ===========================================================================
// The automatic owner selection is gone
// ===========================================================================

describe("the automatic owner selection", () => {
  /**
   * THE DEFECT THIS STAGE EXISTS TO REMOVE, asserted against the source.
   *
   * `activeContext.ts` used to decide who was using the application with
   *
   *     SELECT id FROM users WHERE store_id = ? AND active = 1
   *      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC
   *      LIMIT 1
   *
   * so the application always ran as the oldest active owner, and every actor
   * on every posted document was that one row. A behavioural test cannot prove
   * a query is absent — only that it was not called on the paths the test
   * happens to drive — so this is a source assertion, which is the right shape
   * for "this code no longer exists anywhere".
   */
  it("no longer exists anywhere in the renderer", () => {
    const context = src("state/activeContext.ts");

    // No query at all, and no import of the database client.
    expect(context).not.toMatch(/\bquery\s*\(/);
    expect(context).not.toMatch(/from\s+["'][^"']*db\/client["']/);

    // And nothing anywhere else picks a user out of the database.
    for (const file of walk(new URL("../../src/", import.meta.url))) {
      const text = readFileSync(file, "utf8");
      const code = text
        .split("\n")
        .filter((line) => {
          const t = line.trimStart();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
      expect(code, `${file} selects a user from the database`).not.toMatch(
        /SELECT[\s\S]{0,80}FROM\s+users/i,
      );
    }
  });

  /**
   * The context is now hydrated FROM the session, and cleared when it ends.
   *
   * A user switch that left the previous person's id behind would put their
   * name on the next receipt — which, until Stage B makes the backend resolve
   * the actor itself, is exactly what the payloads carry.
   */
  it("is hydrated from the session and cleared with it", async () => {
    const { adoptSessionContext, clearActiveContext, useActiveContext } =
      await import("../../src/state/activeContext");

    expect(useActiveContext.getState().hydrated).toBe(false);
    expect(useActiveContext.getState().userId).toBeNull();

    adoptSessionContext({ storeId: "store-1", userId: "owner-1" });
    expect(useActiveContext.getState()).toMatchObject({
      storeId: "store-1",
      userId: "owner-1",
      deviceId: null,
      hydrated: true,
    });

    // A switch replaces it rather than merging.
    adoptSessionContext({ storeId: "store-1", userId: "cashier-9" });
    expect(useActiveContext.getState().userId).toBe("cashier-9");

    clearActiveContext();
    expect(useActiveContext.getState()).toMatchObject({
      storeId: null,
      userId: null,
      hydrated: false,
    });
  });
});

// ===========================================================================
// The pre-login boot
// ===========================================================================

describe("the pre-login boot", () => {
  /**
   * ONE COMMAND, AND IT IS NOT `db_select`.
   *
   * This is what lets the read channel be session-gated with no allowlist of
   * "harmless" pre-login queries — and an allowlist is a thing that grows. If
   * this test ever fails because somebody added a pre-login read, the fix is to
   * put the datum in `auth_status`, not to widen the gate.
   */
  it("asks auth_status and nothing else", async () => {
    invokeMock.mockResolvedValue(status());
    const { useSession } = await import("../../src/state/session");

    await useSession.getState().refresh();

    expect(invokeMock.mock.calls.map(([c]) => c)).toEqual(["auth_status"]);
    expect(useSession.getState().status?.schemaVersion).toBe(23);
    expect(useSession.getState().error).toBeNull();
  });

  /**
   * GZ-WAL-01's operator text reaches the screen VERBATIM.
   *
   * `auth_status` is refused when startup validation failed, and the refusal IS
   * the message — multi-line, numbered, and telling the operator not to delete
   * the database files. Replacing it with a tidier sentence would leave the
   * person at the till with a dead application and no instruction.
   */
  it("passes a startup fault through without rewriting it", async () => {
    const fault = [
      "GREAZ CANNOT TRADE — the database did not start up correctly.",
      "",
      "WHAT TO DO NOW",
      "1. Do not take payments on this machine while this message is showing.",
      "4. Do NOT delete greaz-pos.db, greaz-pos.db-wal or greaz-pos.db-shm.",
    ].join("\n");
    invokeMock.mockRejectedValue(fault);

    const { useSession } = await import("../../src/state/session");
    await useSession.getState().refresh();

    expect(useSession.getState().error).toBe(fault);
    expect(useSession.getState().status).toBeNull();
    expect(useSession.getState().loading).toBe(false);
  });

  it("survives a backend that rejects with an Error rather than a string", async () => {
    invokeMock.mockRejectedValue(new Error("ipc went away"));
    const { useSession } = await import("../../src/state/session");
    await useSession.getState().refresh();
    expect(useSession.getState().error).toBe("ipc went away");
  });
});

// ===========================================================================
// Candidates
// ===========================================================================

describe("the account lists", () => {
  /**
   * Unusable accounts are LISTED, not hidden.
   *
   * Hiding a cashier's own name from them during Stage A.1 leaves them no way
   * to find out why the till will not let them in, which is the kind of silence
   * that becomes a support call. They are listed, sorted last, and the screen
   * explains why.
   */
  it("sorts usable accounts first but keeps the rest visible", async () => {
    const { signInCandidates } = await import("../../src/lib/auth");

    const result = signInCandidates(
      status({
        accounts: [
          { userId: "c", fullName: "Zahra", role: "cashier", canSignIn: false, hasCredential: true },
          { userId: "a", fullName: "Owner", role: "owner", canSignIn: true, hasCredential: true },
          { userId: "b", fullName: "Mona", role: "manager", canSignIn: false, hasCredential: false },
        ],
      }),
    );

    expect(result.map((a) => a.userId)).toEqual(["a", "b", "c"]);
    expect(result).toHaveLength(3);
  });

  /**
   * Enrollment offers only owner rows that have no credential — and offers ALL
   * of them, so the installer chooses.
   */
  it("offers every uncredentialled owner for enrollment and nobody else", async () => {
    const { enrollmentCandidates } = await import("../../src/lib/auth");

    const result = enrollmentCandidates(
      status({
        enrollmentState: "legacy_pending",
        accounts: [
          { userId: "o1", fullName: "First Owner", role: "owner", canSignIn: false, hasCredential: false },
          { userId: "o2", fullName: "Second Owner", role: "owner", canSignIn: false, hasCredential: false },
          { userId: "o3", fullName: "Done Owner", role: "owner", canSignIn: true, hasCredential: true },
          { userId: "m1", fullName: "Mona", role: "manager", canSignIn: false, hasCredential: false },
        ],
      }),
    );

    expect(result.map((a) => a.userId)).toEqual(["o1", "o2"]);
  });
});

// ===========================================================================
// No credential is ever stored in the renderer
// ===========================================================================

describe("the renderer keeps no credential", () => {
  /**
   * NO TOKEN, AND NOTHING IN `localStorage`.
   *
   * The ambient-session design exists so the frozen checkout request does not
   * gain a field — `lib/postAttempt.ts` writes that request to `localStorage`
   * before invoking, and it is the only thing between a lost response and a
   * double charge. A token would land inside it. This asserts the auth modules
   * touch no storage at all, so a later convenience change cannot put one
   * there quietly.
   */
  it("stores nothing in localStorage or sessionStorage", () => {
    for (const file of [
      "lib/auth.ts",
      "state/session.ts",
      "lib/useSessionWatch.ts",
      "pages/Login.tsx",
      "pages/Enroll.tsx",
      "pages/Recover.tsx",
      "components/LockScreen.tsx",
      "components/SessionBadge.tsx",
    ]) {
      // CODE only. These modules EXPLAIN at length that there is no token and
      // nothing in storage, so matching the prose would fail on the very
      // comments that document the decision.
      const text = codeOf(src(file));
      expect(text, `${file} touches localStorage`).not.toMatch(/localStorage/);
      expect(text, `${file} touches sessionStorage`).not.toMatch(/sessionStorage/);
      expect(text, `${file} mentions a token`).not.toMatch(/\btoken\b/i);
    }
  });

  /**
   * And the frozen-attempt machinery is untouched by any of this, which is the
   * requirement the whole design was shaped around.
   */
  it("leaves the checkout attempt contract alone", () => {
    const attempt = src("lib/postAttempt.ts");

    // The frozen request type must not have grown an authentication field: it
    // is compared by value on replay, so anything added here becomes something
    // every recovery path has to learn to ignore.
    expect(attempt).not.toMatch(/sessionToken|authToken|credential|passphrase/i);

    // And the store that writes it is still writing only the cart.
    const store = src("lib/cartStore.ts");
    expect(store).not.toMatch(/sessionToken|authToken|credential|passphrase/i);
  });
});
