/**
 * Stand-in for `src/db/client.ts`.
 *
 * The real client talks to `@tauri-apps/plugin-sql`, which needs a running
 * Tauri shell. This module exposes the same `query` / `execute` / `getDb`
 * surface backed by a `node:sqlite` handle, so repository SQL can run in Node.
 *
 * Tests install it with:
 *   vi.mock("../../src/db/client", () => import("../helpers/mockClient"));
 * and point it at a database with `setTestDb(createSqlTestDb())`.
 */
import type { DatabaseSync } from "node:sqlite";

let current: DatabaseSync | null = null;

export function setTestDb(db: DatabaseSync | null): void {
  current = db;
}

function db(): DatabaseSync {
  if (!current) {
    throw new Error("No test database installed — call setTestDb() in beforeEach.");
  }
  return current;
}

export async function query<T = unknown>(sql: string, bindings: unknown[] = []): Promise<T[]> {
  return db()
    .prepare(sql)
    .all(...(bindings as never[])) as T[];
}

export async function execute(sql: string, bindings: unknown[] = []) {
  const result = db()
    .prepare(sql)
    .run(...(bindings as never[]));
  return {
    rowsAffected: Number(result.changes),
    lastInsertId: Number(result.lastInsertRowid),
  };
}

export async function getDb(): Promise<DatabaseSync> {
  return db();
}
