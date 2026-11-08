/**
 * GATE 2A — the frontend half of the database write boundary.
 *
 * The Rust suite (`src-tauri/src/tests/sql_boundary.rs`) proves what the
 * backend refuses. This file proves the other half: that the frontend has no
 * way to ask. Both are needed, because a read-only backend is no use if the
 * renderer still ships a raw-write helper beside it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const src = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url)), "utf8");

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
   * and it used to be set from here. It now lives in Rust (`db_init`), so this
   * asserts the frontend is no longer the one asking — a build where both
   * sides quietly stopped setting it would still start, and the operator's
   * `-wal` / `-shm` check would silently mean something else.
   */
  it("no longer issues PRAGMAs from the renderer", () => {
    const migrate = src("db/migrate.ts");
    expect(migrate).not.toContain("PRAGMA foreign_keys");
    expect(migrate).not.toContain("PRAGMA journal_mode");
    // A call, not the word: the module's own history note mentions
    // `sql:allow-execute`, which is the thing being explained rather than used.
    expect(migrate).not.toMatch(/\bexecute\s*\(/);
    expect(migrate).not.toContain("db.execute");
  });

  /**
   * GZ-WAL-01. A startup fault is refused by `db_select` itself — the Rust
   * side shuts a gate before any pool is opened — and the refusal IS the
   * operator-facing message. This asserts the renderer passes it through
   * untouched, because `App.tsx`'s "Startup failed" screen is the only place
   * it is ever shown. Wrapping it in "something went wrong" would leave the
   * person at the till with a dead application and no instruction.
   */
  it("shows a startup fault to the operator instead of replacing it", async () => {
    const fault = [
      "GREAZ CANNOT TRADE — the database did not start up correctly.",
      "",
      "The database is not in WAL journal mode: a second, independent connection reports `delete`.",
      "",
      "WHAT TO DO NOW",
      "1. Do not take payments on this machine while this message is showing.",
    ].join("\n");
    invokeMock.mockRejectedValue(fault);

    const { ensureDbReady } = await import("../../src/db/migrate");
    await expect(ensureDbReady()).rejects.toBe(fault);
  });

  it("still probes the applied schema version, and refuses an unmigrated database", async () => {
    invokeMock.mockResolvedValue([{ version: 22 }]);
    const { ensureDbReady } = await import("../../src/db/migrate");
    await expect(ensureDbReady()).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("db_select", {
      sql: "SELECT MAX(version) AS version FROM _sqlx_migrations",
      params: [],
    });

    invokeMock.mockResolvedValue([{ version: null }]);
    vi.resetModules();
    const again = await import("../../src/db/migrate");
    await expect(again.ensureDbReady()).rejects.toThrow(/no applied migrations/);
  });
});
