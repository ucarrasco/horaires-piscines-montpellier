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

/** Un créneau d'ouverture, ex: 12:00–13:45 "Nage libre". */
export interface Slot {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  label: string | null; // ex: "Public", "Couloirs", "Aquagym"... ou null
}

/** Horaires extraits pour une piscine. */
export interface PoolSchedule {
  days: Record<DayKey, Slot[]>;
  /** Messages de fermeture exceptionnelle / travaux / jours fériés. */
  closures: string[];
  /** Autre info utile (tarifs, remarques), ou null. */
  notes: string | null;
}

export interface PoolResult extends PoolSchedule {
  id: string;
  name: string;
  url: string;
  status: "ok" | "error";
  /** Message d'erreur si status === "error". */
  error?: string;
}

export interface HorairesData {
  /** Date ISO de génération du fichier. */
  generatedAt: string;
  pools: PoolResult[];
}
