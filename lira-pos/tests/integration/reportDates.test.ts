/**
 * ONE interpretation of a stored timestamp (WP-08).
 *
 * Greaz stores `posted_at` as UTC ISO and reports on LOCAL calendar days — the
 * rule `lib/dates.ts` has always stated, because a sale at 11:59pm in Beirut
 * belongs to that day in Beirut. Two layers implement it:
 *
 *   SQL   `date(posted_at, 'localtime')`     — reports.ts, shiftSummary.ts
 *   JS    `lib/dates.ts::isoToLocalDate`     — Sales History, Returns, Purchases
 *
 * They must agree, or the same receipt sits on two different dates depending on
 * which screen you are looking at. The document lists used `iso.slice(0, 10)`,
 * which is the UTC date — a different day for part of every day in Lebanon,
 * where local time is always AHEAD of UTC. These tests pin the two layers to
 * each other rather than to any particular offset, so they are meaningful in
 * whatever timezone they run in (including a UTC CI box, where the old code
 * also happened to be right and the bug was invisible).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { isoToLocalDate } from "../../src/lib/dates";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  db.close();
});

/** What the report queries would group this timestamp under. */
function sqlLocalDate(iso: string): string {
  const row = db
    .prepare("SELECT date(?, 'localtime') AS d")
    .get(iso) as { d: string };
  return row.d;
}

// A timestamp in every hour of the day, so whatever the host offset is, some
// of these fall on a different UTC day than local day.
const EVERY_HOUR = Array.from(
  { length: 24 },
  (_, h) => `2026-03-15T${String(h).padStart(2, "0")}:30:00.000Z`,
);

const EDGES = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T23:59:59.999Z",
  "2026-12-31T22:45:00.000Z",
  "2026-06-30T21:15:00.000Z",
  // Across a DST boundary, where Lebanon's offset changes.
  "2026-03-28T22:30:00.000Z",
  "2026-10-25T00:30:00.000Z",
  "2026-02-28T23:30:00.000Z",
  "2024-02-29T23:30:00.000Z", // leap day
];

describe("isoToLocalDate", () => {
  it("agrees with SQLite's date(x,'localtime') for every hour of a day", () => {
    for (const iso of EVERY_HOUR) {
      expect(isoToLocalDate(iso)).toBe(sqlLocalDate(iso));
    }
  });

  it("agrees with SQLite at month, year, DST and leap-day boundaries", () => {
    for (const iso of EDGES) {
      expect(isoToLocalDate(iso)).toBe(sqlLocalDate(iso));
    }
  });

  it("returns a well-formed local calendar date", () => {
    for (const iso of [...EVERY_HOUR, ...EDGES]) {
      expect(isoToLocalDate(iso)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("is NOT a UTC slice wherever the host is not on UTC", () => {
    // The control. On a UTC host every slice is already correct and there is
    // nothing to catch, so this asserts the relationship instead of a value:
    // the helper matches SQL in both cases, and where it differs from the
    // slice, the slice is the one that disagreed with the reports.
    const offsetMinutes = new Date("2026-03-15T12:00:00.000Z").getTimezoneOffset();
    const divergent = [...EVERY_HOUR, ...EDGES].filter(
      (iso) => isoToLocalDate(iso) !== iso.slice(0, 10),
    );

    if (offsetMinutes === 0) {
      expect(divergent).toEqual([]);
    } else {
      expect(divergent.length).toBeGreaterThan(0);
      for (const iso of divergent) {
        expect(isoToLocalDate(iso)).toBe(sqlLocalDate(iso));
        expect(iso.slice(0, 10)).not.toBe(sqlLocalDate(iso));
      }
    }
  });

  it("falls back to the raw date part rather than throwing on a bad value", () => {
    // Defensive: a malformed stored timestamp must not blank a whole page.
    expect(isoToLocalDate("not-a-timestamp")).toBe("not-a-time");
  });
});
