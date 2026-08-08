import { type PeriodKey } from "../src/types.ts";
import { parisDateOf } from "./dates.ts";

// Official school calendar (zone C, which covers Montpellier), from the
// education.gouv.fr open data. Used to tell, for a given date, whether we are
// in term time, in short holidays or in the summer holidays.

const DATASET =
  "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records";

interface Vacation {
  start: string; // "YYYY-MM-DD" inclusive
  end: string; // "YYYY-MM-DD" EXCLUSIVE (first day back at school)
  period: PeriodKey; // short_holidays | summer_holidays
  label: string; // e.g. "Vacances de la Toussaint"
}

export interface SchoolCalendar {
  /** Official period of a "YYYY-MM-DD" date. */
  periodFor(iso: string): { period: PeriodKey; label: string | null };
}

function isSummer(description: string): boolean {
  return description
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .includes("ete");
}

/**
 * Fetches the zone C holidays overlapping [windowStart, windowEnd].
 * On network failure, returns a calendar that treats everything as term time
 * (non-blocking degradation) and reports it through `onWarn`.
 */
export async function fetchSchoolCalendar(
  windowStart: string,
  windowEnd: string,
  onWarn: (msg: string) => void = console.warn,
): Promise<SchoolCalendar> {
  const where = `zones="Zone C" and start_date<="${windowEnd}" and end_date>="${windowStart}"`;
  const url = `${DATASET}?where=${encodeURIComponent(where)}&limit=100`;

  let vacations: Vacation[] = [];
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pool-schedules-bot/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      results: {
        description: string;
        start_date: string;
        end_date: string;
        population: string | null;
      }[];
    };

    vacations = json.results
      .filter((r) => r.population !== "Enseignants")
      .map((r) => ({
        start: parisDateOf(r.start_date),
        end: parisDateOf(r.end_date),
        period: isSummer(r.description) ? "summer_holidays" : "short_holidays",
        label: r.description,
      }));
  } catch (err) {
    onWarn(
      `School calendar unavailable (${
        err instanceof Error ? err.message : String(err)
      }): everything is treated as term time.`,
    );
  }

  return {
    periodFor(iso: string) {
      const v = vacations.find((x) => x.start <= iso && iso < x.end);
      return v
        ? { period: v.period, label: v.label }
        : { period: "term", label: null };
    },
  };
}
