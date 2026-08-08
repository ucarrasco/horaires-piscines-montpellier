// Modèle de données partagé entre le job de scraping et le frontend.
// C'est le format du fichier public/data/horaires.json.

export const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  monday: "Lundi",
  tuesday: "Mardi",
  wednesday: "Mercredi",
  thursday: "Jeudi",
  friday: "Vendredi",
  saturday: "Samedi",
  sunday: "Dimanche",
};

export const PERIOD_KEYS = [
  "scolaire",
  "petites_vacances",
  "vacances_ete",
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  scolaire: "Période scolaire",
  petites_vacances: "Petites vacances",
  vacances_ete: "Vacances d'été",
};

/** Un créneau d'ouverture, ex: 12:00–13:45 "Nage libre". */
export interface Slot {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  label: string | null; // ex: "Public", "Couloirs", "Aquagym"... ou null
}

/** Une grille hebdomadaire (créneaux par jour de la semaine). */
export type WeeklySchedule = Record<DayKey, Slot[]>;

/** Fermeture exceptionnelle ou événement daté (travaux, jour férié...). */
export interface DatedEvent {
  start: string; // "YYYY-MM-DD"
  end: string | null; // "YYYY-MM-DD" inclus, ou null si un seul jour
  description: string;
  /** true si la piscine est fermée sur cette période. */
  closed: boolean;
}

/**
 * Dates de vacances explicitement annoncées sur la page d'une piscine
 * (encart "infos du moment"). Priment sur le calendrier officiel zone C.
 */
export interface PeriodOverride {
  period: PeriodKey;
  start: string; // "YYYY-MM-DD"
  end: string; // "YYYY-MM-DD" inclus
}

/** Ce que le scraper (LLM) extrait d'une page. */
export interface PoolSchedule {
  /** Une grille hebdomadaire par type de période. */
  periods: Record<PeriodKey, WeeklySchedule>;
  events: DatedEvent[];
  periodOverrides: PeriodOverride[];
  /** Autre info utile (tarifs, remarques), ou null. */
  notes: string | null;
}

/** Un jour concret de la fenêtre, avec ses horaires réels calculés. */
export interface ResolvedDay {
  date: string; // "YYYY-MM-DD"
  day: DayKey;
  period: PeriodKey;
  slots: Slot[]; // grille de la période, vide si fermé
  closed: boolean; // fermé par un événement daté
  events: string[]; // descriptions des événements ce jour
}

export interface PoolResult extends PoolSchedule {
  id: string;
  name: string;
  url: string;
  status: "ok" | "error";
  /** Message d'erreur si status === "error". */
  error?: string;
  /** Horaires réels jour par jour sur la fenêtre (calculé, non extrait). */
  resolved: ResolvedDay[];
}

/** Une plage de période qui touche la fenêtre (calendrier officiel zone C). */
export interface PeriodSpan {
  period: PeriodKey;
  label: string | null; // ex "Vacances de la Toussaint", null pour la période scolaire
  start: string; // "YYYY-MM-DD" (clampé à la fenêtre)
  end: string; // "YYYY-MM-DD" inclus (clampé à la fenêtre)
}

export interface HorairesData {
  /** Date ISO de génération du fichier. */
  generatedAt: string;
  /** Fenêtre ±7 jours autour de la date de génération. */
  window: { start: string; end: string; dates: string[] };
  /** Périodes scolaires (zone C) présentes dans la fenêtre. */
  periodsInWindow: PeriodSpan[];
  pools: PoolResult[];
}
