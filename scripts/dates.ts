import { DAY_KEYS, type DayKey } from "../src/types.ts";

// Everything is handled as "YYYY-MM-DD" dates interpreted in the Paris time
// zone, so results stay stable whatever the runner's zone is (CI runs in UTC).

const PARIS = "Europe/Paris";

/** Today's date as "YYYY-MM-DD" in Paris. */
export function todayInParis(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Shifts a "YYYY-MM-DD" date by n days (n may be negative). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Day of the week of a "YYYY-MM-DD" date. */
export function dayKeyOf(iso: string): DayKey {
  const js = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return DAY_KEYS[(js + 6) % 7];
}

/** Inclusive list of dates from `start` to `end`. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Converts an ISO instant (as returned by the government API, e.g.
 * "2025-10-18T22:00:00+00:00") to the calendar date "YYYY-MM-DD" as seen in Paris.
 */
export function parisDateOf(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}
