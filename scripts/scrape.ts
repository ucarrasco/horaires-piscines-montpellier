import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { POOLS, type PoolConfig } from "./pools.ts";
import {
  DAY_KEYS,
  PERIOD_KEYS,
  type HorairesData,
  type PeriodKey,
  type PeriodSpan,
  type PoolResult,
  type PoolSchedule,
  type ResolvedDay,
  type WeeklySchedule,
} from "../src/types.ts";
import { fetchSchoolCalendar, type SchoolCalendar } from "./calendar.ts";
import { addDays, dateRange, dayKeyOf, todayInParis } from "./dates.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "public", "data", "horaires.json");

const MODEL = "claude-opus-4-8";
const MAX_HTML_CHARS = 40_000;
const WINDOW_RADIUS = 7; // jours de part et d'autre de la date du jour

// --- Schéma d'extraction (via forced tool use) ----------------------------

const SLOT_SCHEMA = {
  type: "object",
  properties: {
    start: { type: "string", description: 'Heure de début "HH:MM"' },
    end: { type: "string", description: 'Heure de fin "HH:MM"' },
    label: {
      type: ["string", "null"],
      description: 'Type de créneau (ex: "Public", "Couloirs") ou null',
    },
  },
  required: ["start", "end", "label"],
  additionalProperties: false,
} as const;

const DAY_SCHEMA = { type: "array", items: SLOT_SCHEMA } as const;

const WEEKLY_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(DAY_KEYS.map((k) => [k, DAY_SCHEMA])),
  required: [...DAY_KEYS],
  additionalProperties: false,
} as const;

const EXTRACTION_TOOL = {
  name: "record_horaires",
  description: "Enregistre les horaires extraits d'une piscine.",
  input_schema: {
    type: "object" as const,
    properties: {
      periods: {
        type: "object",
        description:
          "Une grille hebdomadaire d'ouverture au public par type de période. Si une période n'est pas précisée sur la page, réutilise la grille scolaire.",
        properties: Object.fromEntries(
          PERIOD_KEYS.map((k) => [k, WEEKLY_SCHEMA]),
        ),
        required: [...PERIOD_KEYS],
        additionalProperties: false,
      },
      events: {
        type: "array",
        description:
          "Fermetures exceptionnelles, travaux, jours fériés ou événements datés. Vide si aucun.",
        items: {
          type: "object",
          properties: {
            start: { type: "string", description: 'Date de début "YYYY-MM-DD"' },
            end: {
              type: ["string", "null"],
              description: 'Date de fin "YYYY-MM-DD" incluse, ou null si un seul jour',
            },
            description: { type: "string" },
            closed: {
              type: "boolean",
              description: "true si la piscine est fermée sur cette période",
            },
          },
          required: ["start", "end", "description", "closed"],
          additionalProperties: false,
        },
      },
      periodOverrides: {
        type: "array",
        description:
          "Dates de vacances explicitement annoncées sur CETTE page (encart infos du moment). Vide si la page ne donne pas de dates.",
        items: {
          type: "object",
          properties: {
            period: { type: "string", enum: [...PERIOD_KEYS] },
            start: { type: "string", description: '"YYYY-MM-DD"' },
            end: { type: "string", description: '"YYYY-MM-DD" incluse' },
          },
          required: ["period", "start", "end"],
          additionalProperties: false,
        },
      },
      notes: {
        type: ["string", "null"],
        description: "Autre info utile, sinon null",
      },
    },
    required: ["periods", "events", "periodOverrides", "notes"],
    additionalProperties: false,
  },
};

// --- Nettoyage HTML -------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&eacute;/gi, "é")
    .replace(/&egrave;/gi, "è")
    .replace(/&agrave;/gi, "à")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HTML_CHARS);
}

// --- Extraction d'une piscine ---------------------------------------------

const SYSTEM_PROMPT = `Tu extrais les horaires d'ouverture au public d'une piscine à partir du texte d'une page web, puis tu appelles l'outil record_horaires.
Consignes :
- Ne renseigne que les créneaux d'ouverture AU PUBLIC (nage libre / grand public). Ignore les cours, clubs et scolaires sauf s'ils sont le seul accès mentionné (dans ce cas, indique-le dans le label).
- Renseigne trois grilles hebdomadaires : "scolaire" (période scolaire), "petites_vacances" (Toussaint, Noël, hiver, printemps) et "vacances_ete" (été). Si la page ne distingue pas les périodes, réutilise la même grille pour les trois.
- Si un jour n'a aucun créneau (fermé), renvoie un tableau vide pour ce jour.
- Mets dans "events" toute fermeture exceptionnelle, travaux, jour férié ou horaire spécial daté, avec closed=true si la piscine est fermée.
- Si l'encart "informations du moment" donne des DATES précises de vacances (ex "vacances du 20 au 30 octobre"), reporte-les dans "periodOverrides" : elles priment sur le calendrier officiel.
- Convertis toutes les dates au format "YYYY-MM-DD" en utilisant l'année courante fournie.
- N'invente jamais d'horaires ni de dates : en cas d'absence ou d'ambiguïté, laisse vide et ajoute une note.`;

function emptyWeekly(): WeeklySchedule {
  return Object.fromEntries(DAY_KEYS.map((k) => [k, []])) as unknown as WeeklySchedule;
}

function emptySchedule(): PoolSchedule {
  return {
    periods: Object.fromEntries(
      PERIOD_KEYS.map((k) => [k, emptyWeekly()]),
    ) as PoolSchedule["periods"],
    events: [],
    periodOverrides: [],
    notes: null,
  };
}

async function extractPool(
  client: Anthropic,
  pool: PoolConfig,
  today: string,
): Promise<Omit<PoolResult, "resolved">> {
  const base = { id: pool.id, name: pool.name, url: pool.url };

  if (!pool.url) {
    return {
      ...base,
      status: "error",
      error: "URL non renseignée dans scripts/pools.ts",
      ...emptySchedule(),
    };
  }

  try {
    const res = await fetch(pool.url, {
      headers: { "User-Agent": "horaires-piscine-bot/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = htmlToText(await res.text());

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
      messages: [
        {
          role: "user",
          content: `Piscine : ${pool.name}\nDate du jour : ${today}\n\nContenu de la page :\n${text}`,
        },
      ],
    });

    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Aucun appel d'outil dans la réponse");
    }
    const parsed = toolUse.input as PoolSchedule;

    return { ...base, status: "ok", ...parsed };
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      ...emptySchedule(),
    };
  }
}

// --- Résolution des horaires réels sur la fenêtre -------------------------

function resolveDays(
  sched: PoolSchedule,
  dates: string[],
  calendar: SchoolCalendar,
): ResolvedDay[] {
  return dates.map((date) => {
    const day = dayKeyOf(date);
    const override = sched.periodOverrides.find(
      (o) => o.start <= date && date <= o.end,
    );
    const period: PeriodKey = override
      ? override.period
      : calendar.periodFor(date).period;

    const dayEvents = sched.events.filter(
      (e) => e.start <= date && date <= (e.end ?? e.start),
    );
    const closed = dayEvents.some((e) => e.closed);
    const slots = closed ? [] : (sched.periods[period]?.[day] ?? []);

    return { date, day, period, slots, closed, events: dayEvents.map((e) => e.description) };
  });
}

/** Plages de période officielle (zone C) qui couvrent la fenêtre. */
function computePeriodsInWindow(
  dates: string[],
  calendar: SchoolCalendar,
): PeriodSpan[] {
  const spans: PeriodSpan[] = [];
  for (const date of dates) {
    const { period, label } = calendar.periodFor(date);
    const last = spans[spans.length - 1];
    if (last && last.period === period && last.label === label) {
      last.end = date;
    } else {
      spans.push({ period, label, start: date, end: date });
    }
  }
  return spans;
}

// --- Main -----------------------------------------------------------------

async function main() {
  // Charge .env s'il existe (dev local). En CI la clé vient d'un secret.
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "❌ ANTHROPIC_API_KEY manquante. Fais: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }

  const client = new Anthropic(); // lit ANTHROPIC_API_KEY

  const today = todayInParis();
  const windowStart = addDays(today, -WINDOW_RADIUS);
  const windowEnd = addDays(today, WINDOW_RADIUS);
  const dates = dateRange(windowStart, windowEnd);
  const calendar = await fetchSchoolCalendar(windowStart, windowEnd);

  // Mode dry-run : `npm run scrape -- <url> [<url> ...]`
  // -> teste ces URLs, imprime le JSON résolu, N'ÉCRIT PAS le fichier.
  const urlArgs = process.argv.slice(2).filter((a) => a.startsWith("http"));
  if (urlArgs.length > 0) {
    console.log(`🔎 Dry-run sur ${urlArgs.length} URL(s) (aucun fichier écrit)\n`);
    for (const url of urlArgs) {
      const extracted = await extractPool(
        client,
        { id: "dry-run", name: url, url },
        today,
      );
      const result: PoolResult = {
        ...extracted,
        resolved: resolveDays(extracted, dates, calendar),
      };
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  console.log(`Extraction de ${POOLS.length} piscine(s)...`);
  const pools: PoolResult[] = [];
  for (const pool of POOLS) {
    process.stdout.write(`  - ${pool.name}... `);
    const extracted = await extractPool(client, pool, today);
    console.log(extracted.status === "ok" ? "ok" : `erreur (${extracted.error})`);
    pools.push({ ...extracted, resolved: resolveDays(extracted, dates, calendar) });
  }

  const data: HorairesData = {
    generatedAt: new Date().toISOString(),
    window: { start: windowStart, end: windowEnd, dates },
    periodsInWindow: computePeriodsInWindow(dates, calendar),
    pools,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  const okCount = pools.filter((p) => p.status === "ok").length;
  console.log(`\nÉcrit ${OUTPUT_PATH} (${okCount}/${pools.length} ok)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
