// Data model shared between the scraping job and the frontend.
// This is the shape of public/data/schedules.json.
//
// Note: user-facing labels stay in French, since the site itself is in French.

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

export const PERIOD_KEYS = ["term", "short_holidays", "summer_holidays"] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  term: "Période scolaire",
  short_holidays: "Petites vacances",
  summer_holidays: "Vacances d'été",
};

/** An opening slot, e.g. 12:00–13:45 "Nage libre". */
export interface Slot {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  label: string | null; // e.g. "Public", "Couloirs", "Aquagym"... or null
}

/** A weekly schedule (slots per day of the week). */
export type WeeklySchedule = Record<DayKey, Slot[]>;

/** A dated closure or event (maintenance, public holiday...). */
export interface DatedEvent {
  start: string; // "YYYY-MM-DD"
  end: string | null; // "YYYY-MM-DD" inclusive, or null for a single day
  description: string;
  /** true when the pool is closed over that period. */
  closed: boolean;
  /** Exceptional opening hours replacing the weekly schedule, or null. */
  slots: Slot[] | null;
}

/**
 * Holiday dates explicitly announced on a pool's own page ("infos du moment"
 * box). These take precedence over the official zone C calendar.
 */
export interface PeriodOverride {
  period: PeriodKey;
  start: string; // "YYYY-MM-DD"
  end: string; // "YYYY-MM-DD" inclusive
}

/** What the scraper (LLM) extracts from a page. */
export interface PoolSchedule {
  /** One weekly schedule per period type. */
  periods: Record<PeriodKey, WeeklySchedule>;
  events: DatedEvent[];
  periodOverrides: PeriodOverride[];
  /** Any other useful information (pricing, remarks), or null. */
  notes: string | null;
}

/** A concrete day of the window, with its resolved opening hours. */
export interface ResolvedDay {
  date: string; // "YYYY-MM-DD"
  day: DayKey;
  period: PeriodKey;
  slots: Slot[]; // the period's schedule, empty when closed
  closed: boolean; // closed by a dated event
  /** true when the slots come from an event rather than the weekly schedule. */
  exceptional: boolean;
  events: string[]; // descriptions of that day's events
}

export interface PoolResult extends PoolSchedule {
  id: string;
  name: string;
  url: string;
  status: "ok" | "error";
  /** Error message when status === "error". */
  error?: string;
  /** Actual day-by-day hours over the window (computed, not extracted). */
  resolved: ResolvedDay[];
}

/** A period span overlapping the window (official zone C calendar). */
export interface PeriodSpan {
  period: PeriodKey;
  label: string | null; // e.g. "Vacances de la Toussaint", null during term time
  start: string; // "YYYY-MM-DD" (clamped to the window)
  end: string; // "YYYY-MM-DD" inclusive (clamped to the window)
}

export interface SchedulesData {
  /** ISO timestamp of when the file was generated. */
  generatedAt: string;
  /** ±7 day window around the generation date. */
  window: { start: string; end: string; dates: string[] };
  /** School periods (zone C) present in the window. */
  periodsInWindow: PeriodSpan[];
  pools: PoolResult[];
}
