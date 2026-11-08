/**
 * GATE 2A — the frontend half of the database write boundary.
 *
 * The Rust suite (`src-tauri/src/tests/sql_boundary.rs`) proves what the
 * backend refuses. This file proves the other half: that the frontend has no
 * way to ask. Both are needed, because a read-only backend is no use if the
 * renderer still ships a raw-write helper beside it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const src = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url)), "utf8");

/** Every .ts/.tsx file under a directory, so a boundary claim covers the whole
 *  renderer rather than the one file somebody remembered. */
function walk(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...walk(new URL(`${entry.name}/`, dir)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(fileURLToPath(new URL(entry.name, dir)));
    }
  }
  return out;
}

describe("the frontend database client", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("routes reads through the db_select command, not the SQL plugin", async () => {
    const { query } = await import("../../src/db/client");
    await query("SELECT id FROM products WHERE is_active = ?", [1]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("db_select", {
      sql: "SELECT id FROM products WHERE is_active = ?",
      params: [1],
    });
  });

  it("defaults to no parameters rather than sending undefined", async () => {
    const { query } = await import("../../src/db/client");
    await query("SELECT 1");
    expect(invokeMock).toHaveBeenCalledWith("db_select", { sql: "SELECT 1", params: [] });
  });

  it("returns the rows the command returns, unchanged", async () => {
    invokeMock.mockResolvedValue([{ id: "p1", price_incl_vat_cents: 999 }]);
    const { query } = await import("../../src/db/client");
    const rows = await query<{ id: string; price_incl_vat_cents: number }>("SELECT 1");
    expect(rows).toEqual([{ id: "p1", price_incl_vat_cents: 999 }]);
  });

  it("exports no write helper at all", async () => {
    const mod = await import("../../src/db/client");
    expect(Object.keys(mod)).toEqual(["query"]);
    expect((mod as Record<string, unknown>).execute).toBeUndefined();
    expect((mod as Record<string, unknown>).getDb).toBeUndefined();
  });
});

describe("no module reaches the database except through the client", () => {
  /**
   * The capability file grants the renderer no `sql:*` permission, so a
   * `plugin-sql` import would fail at runtime rather than open a hole. This
   * asserts it anyway: an import that cannot work is a trap for the next
   * person, and the fix is to notice it here instead of at the till.
   */
  it("leaves no @tauri-apps/plugin-sql import anywhere in src/", async () => {
    const { globSync } = await import("node:fs");
    const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }) as string[];
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((f) =>
      readFileSync(f, "utf8").includes('from "@tauri-apps/plugin-sql"'),
    );
    expect(offenders).toEqual([]);
  });

  it("leaves no execute() import from the db client anywhere in src/", async () => {
    const { globSync } = await import("node:fs");
    const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }) as string[];

    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /import\s*\{[^}]*\bexecute\b[^}]*\}\s*from\s*"[^"]*client"/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe("the startup path", () => {
  /**
   * `journal_mode = WAL` is what the whole Gate 1 backup procedure rests on,
   * and it was once set from the renderer. Gate 2A moved it to Rust
   * (`db_init`), and Stage A.1 deleted the module that used to do it —
   * `src/db/migrate.ts` — because its one job, confirming the schema version,
   * is now answered by `auth_status` before anybody has signed in.
   *
   * This asserts the renderer is no longer the one asking, ACROSS THE WHOLE
   * FRONTEND rather than in one file: a build where both sides quietly stopped
   * setting it would still start, and the operator's `-wal` / `-shm` check
   * would silently mean something else.
   */
  it("issues no PRAGMA from anywhere in the renderer", () => {
    const offenders: string[] = [];
    for (const file of walk(new URL("../../src/", import.meta.url))) {
      const text = readFileSync(file, "utf8");
      if (/PRAGMA\s+(foreign_keys|journal_mode|query_only)/i.test(text)) {
        // The read-only client's own history note names the PRAGMAs it no
        // longer issues; a mention is not a call.
        if (/\bexecute\s*\(/.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The dead module is GONE, not merely unused.
   *
   * A module nobody calls but the tests still point at is how a test comes to
   * prove nothing. `ensureDbReady` was the boot's schema probe; the boot now
   * runs on `auth_status`, so the probe has no caller and no reason to exist.
   */
  it("no longer ships the old frontend startup probe", () => {
    expect(() => src("db/migrate.ts")).toThrow();
    for (const file of walk(new URL("../../src/", import.meta.url))) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from\s+["'][^"']*db\/migrate["']/);
    }
  });

  /**
   * GZ-WAL-01, carried forward to the new boot.
   *
   * A startup fault is refused by the backend before any pool is opened, and
   * the refusal IS the operator-facing message — multi-line, numbered, and
   * telling them not to delete the database files. The boot must pass it
   * through UNTOUCHED, because `App.tsx`'s "Startup failed" screen is the only
   * place it is ever shown. Wrapping it in "something went wrong" would leave
   * the person at the till with a dead application and no instruction.
   *
   * The path is now `auth_status` -> `session.refresh()` rather than
   * `db_select` -> `ensureDbReady()`, and the guarantee is the same one.
   */
  it("shows a startup fault to the operator instead of replacing it", async () => {
    const fault = [
      "GREAZ CANNOT TRADE \u2014 the database did not start up correctly.",
      "",
      "The database is not in WAL journal mode: a second, independent connection reports `delete`.",
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
  });

  /**
   * THE PRE-LOGIN BOOT MAKES NO `db_select` CALL AT ALL.
   *
   * This is the property that lets the read channel be session-gated without an
   * allowlist of "harmless" pre-login queries — and an allowlist is a thing
   * that grows. `auth_status` returns the schema version, the store and the
   * accounts in one command, so there is nothing for the boot to read.
   */
  it("asks only auth_status before anybody has signed in", async () => {
    invokeMock.mockResolvedValue({
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
    });

    const { useSession } = await import("../../src/state/session");
    await useSession.getState().refresh();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("auth_status");
    expect(
      invokeMock.mock.calls.some(([command]) => command === "db_select"),
    ).toBe(false);
    expect(useSession.getState().status?.schemaVersion).toBe(23);
  });
});
