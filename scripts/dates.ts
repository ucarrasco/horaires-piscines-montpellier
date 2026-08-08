import { DAY_KEYS, type DayKey } from "../src/types.ts";

// Tout est manipulé en dates "YYYY-MM-DD" interprétées dans le fuseau de Paris,
// pour rester stable quel que soit le fuseau du runner (CI = UTC).

const PARIS = "Europe/Paris";

/** Date du jour "YYYY-MM-DD" à Paris. */
export function todayInParis(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Décale une date "YYYY-MM-DD" de n jours (n peut être négatif). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Jour de la semaine d'une date "YYYY-MM-DD". */
export function dayKeyOf(iso: string): DayKey {
  const js = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = dimanche
  return DAY_KEYS[(js + 6) % 7];
}

/** Liste inclusive des dates de `start` à `end`. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Convertit un instant ISO (renvoyé par l'API gouv, ex "2025-10-18T22:00:00+00:00")
 * en date calendaire "YYYY-MM-DD" telle que vue à Paris.
 */
export function parisDateOf(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}
