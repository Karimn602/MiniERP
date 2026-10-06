/**
 * Date utilities — all dates in this app are "local YYYY-MM-DD" strings.
 *
 * Why local, not UTC? Shop operations are local-time events. A sale at
 * 11:59pm in Beirut belongs to that day in Beirut, not the next day in UTC.
 *
 * We never store time-of-day on date columns. Times use TEXT ISO-8601 UTC
 * (handled elsewhere), but anything called "_date" or "effective_date" is
 * a local calendar date string.
 */

/** Today in local time, formatted YYYY-MM-DD. */
export function todayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The LOCAL calendar date of a stored UTC ISO timestamp, as YYYY-MM-DD.
 *
 * This is the one correct way to turn a `posted_at` into a report date, and it
 * is not `iso.slice(0, 10)` — that is the UTC date, which is a DIFFERENT DAY
 * for part of every day in Lebanon (UTC+2/+3, so local is always ahead). Sales
 * History and the Returns list both sliced, while `reports.ts` and
 * `shiftSummary.ts` group by `date(posted_at, 'localtime')`: a receipt posted
 * 00:30 Beirut landed on the previous day in the document lists and on the
 * correct day in Local Reports, with the time column beside it — rendered with
 * `toLocaleTimeString` — reading 00:30 next to yesterday's date.
 *
 * One interpretation, stated once: a shop event belongs to the local calendar
 * day it happened on, which is what the module header has always claimed.
 */
export function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Days between two YYYY-MM-DD strings. Positive if `b` is after `a`. */
export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  const ms = db.getTime() - da.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/** Human-friendly relative date. */
export function relativeFromToday(date: string): string {
  const diff = daysBetween(date, todayLocalDate());
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff > 0 && diff < 7) return `${diff} days ago`;
  if (diff >= 7 && diff < 30) {
    const w = Math.floor(diff / 7);
    return w === 1 ? "1 week ago" : `${w} weeks ago`;
  }
  if (diff >= 30 && diff < 365) {
    const m = Math.floor(diff / 30);
    return m === 1 ? "1 month ago" : `${m} months ago`;
  }
  if (diff >= 365) return `${Math.floor(diff / 365)} year(s) ago`;
  if (diff === -1) return "tomorrow";
  return `in ${-diff} days`;
}

/** Pretty format: "May 13, 2026" */
export function formatPrettyDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}