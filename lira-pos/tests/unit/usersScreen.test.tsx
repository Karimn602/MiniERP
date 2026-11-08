// @vitest-environment jsdom
/**
 * THE USERS SCREEN — Gate 2B, Stage B.3.
 *
 * Three layers decide what a shop's staff list can become, and only the last
 * one is enforcement. They are pinned separately and on purpose:
 *
 *   * the POLICY — which role is offered which screen — in
 *     `tests/unit/rolePermissions.test.ts`, including a direct comparison
 *     against `authz.rs::permits`;
 *   * the SCREEN — what the owner is offered, what it refuses to offer, and
 *     what it sends — here;
 *   * the WRITE — what the database ends up holding, and every rule about it —
 *     in `src-tauri/src/tests/user_admin.rs`, against a real SQLite database,
 *     because `users.rs` in Rust is the only thing that writes a `users` row.
 *
 * A test at this layer proves nothing about persistence and does not try to.
 * What it proves is that the owner is not INVITED to do something the backend
 * will refuse — and, more importantly, that the controls which would be
 * dangerous if they existed do not exist: there is no delete, and nothing on
 * this screen can display a credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { StaffView } from "../../src/lib/users";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import Users from "../../src/pages/Users";
import { useSession } from "../../src/state/session";

const OWNER: StaffView = {
  userId: "u-owner",
  fullName: "Rania",
  role: "owner",
  active: true,
  hasCredential: true,
  mustChangeCredential: false,
  isYou: true,
};
const MANAGER: StaffView = {
  userId: "u-manager",
  fullName: "Mona",
  role: "manager",
  active: true,
  hasCredential: true,
  mustChangeCredential: false,
  isYou: false,
};
const NEW_CASHIER: StaffView = {
  userId: "u-cashier",
  fullName: "Sami",
  role: "cashier",
  active: true,
  hasCredential: false,
  mustChangeCredential: false,
  isYou: false,
};
const RETIRED: StaffView = {
  userId: "u-gone",
  fullName: "Karim",
  role: "cashier",
  active: false,
  hasCredential: true,
  mustChangeCredential: false,
  isYou: false,
};

/** The command log, so a test can assert what was SENT rather than what the
 *  screen then drew. */
let sent: { cmd: string; args: unknown }[] = [];

function serve(staff: StaffView[], overrides: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    sent.push({ cmd, args });
    if (cmd in overrides) {
      const value = overrides[cmd];
      if (value instanceof Error) throw value;
      return value;
    }
    switch (cmd) {
      case "users_list":
        return staff;
      case "users_save":
        return "u-new";
      case "users_set_active":
      case "users_set_credential":
        return null;
      case "auth_status":
        // `run()` refreshes the session after a write, so the rail stops
        // offering what the backend has just stopped allowing.
        return {
          schemaVersion: 23,
          storeId: "s1",
          storeName: "Greaz",
          enrollmentState: "initialized",
          enrollmentCodeFile: null,
          enrollmentLocked: false,
          accounts: [],
          session: {
            userId: OWNER.userId,
            fullName: OWNER.fullName,
            storeId: "s1",
            role: "owner",
            locked: false,
            mustChangeCredential: false,
            idleSecondsRemaining: 900,
            openedSecondsAgo: 1,
          },
          sessionGeneration: 1,
          loginRestrictedToOwner: false,
          idleLockSeconds: 900,
        };
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
}

function draw() {
  return render(
    <I18nProvider>
      <Users />
    </I18nProvider>,
  );
}

beforeEach(() => {
  sent = [];
  invoke.mockReset();
  useSession.setState({ status: null, error: null, loading: false });
});
afterEach(() => cleanup());

describe("what the screen shows", () => {
  it("names the three states separately, because they are three different facts", async () => {
    // Active-with-a-passphrase, active-WITHOUT-one, and retired. Showing only
    // "active" would present somebody who cannot get in as ready for work, and
    // the owner would find out at the start of a shift.
    serve([OWNER, MANAGER, NEW_CASHIER, RETIRED]);
    draw();

    await waitFor(() => expect(screen.getByText("Rania")).toBeTruthy());
    expect(screen.getByText("Sami")).toBeTruthy();
    expect(screen.getByText("No passphrase yet")).toBeTruthy();
    expect(screen.getByText("Retired")).toBeTruthy();
    // The signed-in owner's own row is marked, because two controls behave
    // differently on it.
    expect(screen.getByText("(you)")).toBeTruthy();
  });

  it("offers no way to delete anybody", async () => {
    // A `users` row is referenced by every document that person ever touched.
    // `active = 0` is how this schema says "not usable"; deleting one to tidy
    // up a list would be destroying the attribution on real financial records.
    // The backend does not offer it, and neither does this — asserted here
    // because a delete button is the kind of thing a later convenience adds.
    serve([OWNER, MANAGER, RETIRED]);
    draw();
    await waitFor(() => expect(screen.getByText("Mona")).toBeTruthy());

    for (const label of [/delete/i, /remove/i]) {
      expect(screen.queryAllByRole("button", { name: label })).toEqual([]);
    }
    // And the retired row offers the reverse instead.
    expect(screen.getByRole("button", { name: "Bring back" })).toBeTruthy();
  });

  it("asks the backend for the list and sends no store of its own", async () => {
    // The store is the signed-in owner's, taken in Rust. There is no field on
    // the wire through which one branch could administer another, and this
    // asserts the renderer does not invent one.
    serve([OWNER]);
    draw();
    await waitFor(() => expect(screen.getByText("Rania")).toBeTruthy());

    const call = sent.find((c) => c.cmd === "users_list");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call?.args ?? {})).not.toMatch(/store/i);
  });
});

describe("the controls that must not be offered", () => {
  it("will not retire the account the owner is signed in to", async () => {
    serve([OWNER, MANAGER]);
    draw();
    await waitFor(() => expect(screen.getByText("Rania")).toBeTruthy());

    const retires = screen.getAllByRole("button", { name: "Retire" });
    // Two active people, so two Retire buttons — the owner's own is disabled
    // and says why, the manager's is live.
    const own = retires.find((b) => b.getAttribute("title")?.includes("signed in"));
    expect(own).toBeTruthy();
    expect((own as HTMLButtonElement).disabled).toBe(true);
    expect(retires.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("will not retire or offer a reset for the shop's only active owner", async () => {
    // Both rules are enforced in Rust (`users.rs::require_another_active_owner_remains`
    // and the self-reset refusal); these disable the control so the owner is
    // not invited to try. With a SECOND active owner the first becomes
    // retirable, which is the next test.
    serve([OWNER, NEW_CASHIER]);
    draw();
    await waitFor(() => expect(screen.getByText("Rania")).toBeTruthy());

    const own = screen
      .getAllByRole("button", { name: "Retire" })
      .find((b) => b.getAttribute("title"));
    expect((own as HTMLButtonElement).disabled).toBe(true);

    // No passphrase control on your own row at all: changing your own needs
    // the current one, through Change passphrase.
    expect(screen.queryAllByRole("button", { name: "Reset passphrase" })).toEqual([]);
    // The cashier with no passphrase does get one.
    expect(screen.getByRole("button", { name: "Set passphrase" })).toBeTruthy();
  });

  it("frees the last-owner lock once a second owner exists", async () => {
    const second: StaffView = {
      userId: "u-owner-2",
      fullName: "Ziad",
      role: "owner",
      active: true,
      hasCredential: true,
      mustChangeCredential: false,
      isYou: false,
    };
    serve([OWNER, second]);
    draw();
    await waitFor(() => expect(screen.getByText("Ziad")).toBeTruthy());

    const retires = screen.getAllByRole("button", { name: "Retire" });
    // The other owner may now be retired; the signed-in one still may not, for
    // its own separate reason.
    const other = retires.find((b) => !b.getAttribute("title")?.includes("signed in"));
    expect((other as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("what it sends", () => {
  it("creates a member of staff with a fresh identity and no store", async () => {
    serve([OWNER]);
    draw();
    await waitFor(() => expect(screen.getByText("Rania")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Add a member of staff" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rami" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "cashier" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(sent.some((c) => c.cmd === "users_save")).toBe(true),
    );
    const call = sent.find((c) => c.cmd === "users_save");
    const args = (call?.args as { args: Record<string, unknown> }).args;
    expect(args.fullName).toBe("Rami");
    expect(args.role).toBe("cashier");
    // A real identity, minted once by the caller — the same discipline every
    // other document here follows.
    expect(String(args.userId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(args).not.toHaveProperty("storeId");
  });

  it("edits a person under their EXISTING identity, not a new one", async () => {
    // A rename that minted a new id would create a second person and leave
    // every document the first one touched attributed to a row the owner can
    // no longer see.
    serve([OWNER, MANAGER]);
    draw();
    await waitFor(() => expect(screen.getByText("Mona")).toBeTruthy());

    // The manager's row is the second Edit button (the owner's is first).
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Mona Haddad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent.some((c) => c.cmd === "users_save")).toBe(true));
    const args = (
      sent.find((c) => c.cmd === "users_save")?.args as {
        args: Record<string, unknown>;
      }
    ).args;
    expect(args.userId).toBe(MANAGER.userId);
    expect(args.fullName).toBe("Mona Haddad");
    expect(args.role).toBe("manager");
  });

  it("refuses to send a passphrase that was typed twice differently", async () => {
    serve([OWNER, NEW_CASHIER]);
    draw();
    await waitFor(() => expect(screen.getByText("Sami")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Set passphrase" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "123456" },
    });
    fireEvent.change(screen.getByLabelText("Type it again"), {
      target: { value: "123457" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Give them this passphrase" }));

    await waitFor(() =>
      expect(screen.getByText("The two passphrases are not the same.")).toBeTruthy(),
    );
    // NOTHING WAS SENT. A mistyped confirmation that reached the backend would
    // set a passphrase neither the owner nor the cashier knows, and the only
    // way back is another reset.
    expect(sent.some((c) => c.cmd === "users_set_credential")).toBe(false);
  });

  it("sends a matching passphrase and keeps it out of the rendered page", async () => {
    serve([OWNER, NEW_CASHIER]);
    const { container } = draw();
    await waitFor(() => expect(screen.getByText("Sami")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Set passphrase" }));
    const field = screen.getByLabelText("Passphrase") as HTMLInputElement;
    // A password field, so it is not shoulder-readable over a counter.
    expect(field.type).toBe("password");

    fireEvent.change(field, { target: { value: "olive-tree-copper" } });
    fireEvent.change(screen.getByLabelText("Type it again"), {
      target: { value: "olive-tree-copper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Give them this passphrase" }));

    await waitFor(() =>
      expect(sent.some((c) => c.cmd === "users_set_credential")).toBe(true),
    );
    const args = (
      sent.find((c) => c.cmd === "users_set_credential")?.args as {
        args: Record<string, unknown>;
      }
    ).args;
    expect(args.userId).toBe(NEW_CASHIER.userId);
    expect(args.secret).toBe("olive-tree-copper");

    // The form is cleared and the secret is nowhere in the markup.
    await waitFor(() =>
      expect(screen.queryByLabelText("Type it again")).toBeNull(),
    );
    expect(container.innerHTML).not.toContain("olive-tree-copper");
  });
});

describe("when the backend refuses", () => {
  it("shows the backend's own sentence and does not invent one", async () => {
    // Every refusal in `users.rs` names the rule, says nothing has been
    // changed, and says what to do instead. A screen that replaced it with
    // "Could not save" would throw away the only part that helps.
    const refusal =
      "This is the shop's only active owner. Make somebody else an owner first — " +
      "with no owner, nobody could add staff, reset a passphrase or change a role. " +
      "Nothing has been changed.";
    serve([OWNER, MANAGER], { users_save: new Error(refusal) });
    draw();
    await waitFor(() => expect(screen.getByText("Mona")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText(refusal)).toBeTruthy());
    // The editor stays OPEN on a refusal, with what was typed still in it:
    // the owner has to change something, and closing the form would make them
    // start again.
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("reports a failed list rather than rendering an empty shop", async () => {
    // An empty table would say "nobody works here", which about a staff list
    // is a statement, not a loading state.
    serve([], { users_list: new Error("cannot list the staff: database is locked") });
    draw();

    await waitFor(() =>
      expect(screen.getByText(/cannot list the staff/)).toBeTruthy(),
    );
    expect(screen.queryByText("Nobody has been added yet.")).toBeNull();
  });
});
