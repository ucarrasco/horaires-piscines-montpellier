import { type PeriodKey } from "../src/types.ts";
import { parisDateOf } from "./dates.ts";

// Calendrier scolaire officiel (zone C, dont Montpellier), via l'open data
// education.gouv.fr. Sert à savoir, pour une date donnée, si on est en période
// scolaire, en petites vacances ou en vacances d'été.

const DATASET =
  "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records";

interface Vacation {
  start: string; // "YYYY-MM-DD" inclus
  end: string; // "YYYY-MM-DD" EXCLUS (jour de la rentrée)
  period: PeriodKey; // petites_vacances | vacances_ete
  label: string; // ex "Vacances de la Toussaint"
}

export interface SchoolCalendar {
  /** Période officielle d'une date "YYYY-MM-DD". */
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
 * Récupère les vacances zone C recouvrant [windowStart, windowEnd].
 * En cas d'échec réseau, renvoie un calendrier qui considère tout en période
 * scolaire (dégradation non bloquante) et le signale via `onWarn`.
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
      headers: { "User-Agent": "horaires-piscine-bot/1.0" },
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
        period: isSummer(r.description) ? "vacances_ete" : "petites_vacances",
        label: r.description,
      }));
  } catch (err) {
    onWarn(
      `Calendrier scolaire indisponible (${
        err instanceof Error ? err.message : String(err)
      }) : tout est traité comme période scolaire.`,
    );
  }

  return {
    periodFor(iso: string) {
      const v = vacations.find((x) => x.start <= iso && iso < x.end);
      return v
        ? { period: v.period, label: v.label }
        : { period: "scolaire", label: null };
    },
  };
}
