import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { POOLS, type PoolConfig } from "./pools.ts";
import {
  DAY_KEYS,
  PERIOD_KEYS,
  type PeriodKey,
  type PeriodSpan,
  type PoolResult,
  type PoolSchedule,
  type ResolvedDay,
  type SchedulesData,
  type WeeklySchedule,
} from "../src/types.ts";
import { fetchSchoolCalendar, type SchoolCalendar } from "./calendar.ts";
import { addDays, dateRange, dayKeyOf, todayInParis } from "./dates.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "public", "data", "schedules.json");

const MODEL = "claude-opus-4-8";
const MAX_HTML_CHARS = 40_000;
const WINDOW_RADIUS = 7; // days on either side of today

// --- Extraction schema (via forced tool use) ------------------------------

const SLOT_SCHEMA = {
  type: "object",
  properties: {
    start: { type: "string", description: 'Start time "HH:MM"' },
    end: { type: "string", description: 'End time "HH:MM"' },
    label: {
      type: ["string", "null"],
      description:
        'Slot type as written on the page (e.g. "Public", "Couloirs"), or null',
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
  name: "record_schedules",
  description: "Records the opening hours extracted for a swimming pool.",
  input_schema: {
    type: "object" as const,
    properties: {
      periods: {
        type: "object",
        description:
          "One weekly public-opening schedule per period type. If a period is not specified on the page, reuse the term-time schedule.",
        properties: Object.fromEntries(
          PERIOD_KEYS.map((k) => [k, WEEKLY_SCHEMA]),
        ),
        required: [...PERIOD_KEYS],
        additionalProperties: false,
      },
      events: {
        type: "array",
        description:
          "Exceptional closures, maintenance, public holidays or dated events. Empty if none.",
        items: {
          type: "object",
          properties: {
            start: { type: "string", description: 'Start date "YYYY-MM-DD"' },
            end: {
              type: ["string", "null"],
              description:
                'End date "YYYY-MM-DD" inclusive, or null for a single day',
            },
            description: { type: "string" },
            closed: {
              type: "boolean",
              description: "true if the pool is closed over that period",
            },
            slots: {
              type: ["array", "null"],
              description:
                "Exceptional hours announced for that date (they replace the weekly schedule). null when the page gives none or when closed=true.",
              items: SLOT_SCHEMA,
            },
          },
          required: ["start", "end", "description", "closed", "slots"],
          additionalProperties: false,
        },
      },
      periodOverrides: {
        type: "array",
        description:
          "Holiday dates explicitly announced on THIS page (current-info box). Empty if the page gives no dates.",
        items: {
          type: "object",
          properties: {
            period: { type: "string", enum: [...PERIOD_KEYS] },
            start: { type: "string", description: '"YYYY-MM-DD"' },
            end: { type: "string", description: '"YYYY-MM-DD" inclusive' },
          },
          required: ["period", "start", "end"],
          additionalProperties: false,
        },
      },
      notes: {
        type: ["string", "null"],
        description: "Any other useful information, otherwise null",
      },
    },
    required: ["periods", "events", "periodOverrides", "notes"],
    additionalProperties: false,
  },
};

// --- HTML cleanup ---------------------------------------------------------

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

// --- Extracting a single pool ---------------------------------------------

// The pages are in French, hence the French examples quoted below.
const SYSTEM_PROMPT = `You extract a swimming pool's public opening hours from the text of a web page, then you call the record_schedules tool.
Instructions:
- Only record slots open TO THE PUBLIC ("nage libre" / "grand public"). Ignore lessons, clubs and school groups unless they are the only access mentioned (in that case, say so in the label).
- Fill in three weekly schedules: "term" (période scolaire), "short_holidays" (Toussaint, Noël, hiver, printemps) and "summer_holidays" (été). If the page does not distinguish periods, reuse the same schedule for all three.
- If a day has no slot (closed), return an empty array for that day.
- Put every exceptional closure, maintenance period, public holiday or dated special opening in "events", with closed=true when the pool is closed.
- When an event announces exceptional hours (e.g. "le 15 août : ouverture 9h00-13h15 et 15h00-19h15"), also fill its "slots" with those slots: they will replace the weekly schedule for that day. Do not just describe them in "description".
- Use the two-digit "HH:MM" format for times (e.g. "09:00", not "9:00").
- If the current-info box gives precise holiday DATES (e.g. "vacances du 20 au 30 octobre"), report them in "periodOverrides": they take precedence over the official calendar.
- Convert every date to the "YYYY-MM-DD" format, using the current year provided.
- Never invent hours or dates: when something is missing or ambiguous, leave it empty and add a note.
- Labels and descriptions are shown as-is on a French website: keep them in French, as written on the page.`;

function emptyWeekly(): WeeklySchedule {
  return Object.fromEntries(
    DAY_KEYS.map((k) => [k, []]),
  ) as unknown as WeeklySchedule;
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
      error: "Missing url in scripts/pools.ts",
      ...emptySchedule(),
    };
  }

  try {
    const res = await fetch(pool.url, {
      headers: { "User-Agent": "pool-schedules-bot/1.0" },
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
          content: `Pool: ${pool.name}\nToday's date: ${today}\n\nPage content:\n${text}`,
        },
      ],
    });

    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("No tool call in the response");
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

// --- Resolving actual hours over the window -------------------------------

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
    const special = dayEvents.find(
      (e) => !e.closed && e.slots && e.slots.length > 0,
    );
    const exceptional = !closed && special !== undefined;
    const slots = closed
      ? []
      : exceptional
        ? special!.slots!
        : (sched.periods[period]?.[day] ?? []);

    return {
      date,
      day,
      period,
      slots,
      closed,
      exceptional,
      events: dayEvents.map((e) => e.description),
    };
  });
}

/** Official period spans (zone C) covering the window. */
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
  // Load .env when present (local dev). On CI the key comes from a secret.
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "❌ Missing ANTHROPIC_API_KEY. Run: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY

  const today = todayInParis();
  const windowStart = addDays(today, -WINDOW_RADIUS);
  const windowEnd = addDays(today, WINDOW_RADIUS);
  const dates = dateRange(windowStart, windowEnd);
  const calendar = await fetchSchoolCalendar(windowStart, windowEnd);

  // Dry-run mode: `npm run scrape -- <url> [<url> ...]`
  // -> tests those URLs, prints the resolved JSON, DOES NOT WRITE the file.
  const urlArgs = process.argv.slice(2).filter((a) => a.startsWith("http"));
  if (urlArgs.length > 0) {
    console.log(`🔎 Dry run on ${urlArgs.length} URL(s) (no file written)\n`);
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

  console.log(`Extracting ${POOLS.length} pool(s)...`);
  const pools: PoolResult[] = [];
  for (const pool of POOLS) {
    process.stdout.write(`  - ${pool.name}... `);
    const extracted = await extractPool(client, pool, today);
    console.log(extracted.status === "ok" ? "ok" : `error (${extracted.error})`);
    pools.push({
      ...extracted,
      resolved: resolveDays(extracted, dates, calendar),
    });
  }

  const data: SchedulesData = {
    generatedAt: new Date().toISOString(),
    window: { start: windowStart, end: windowEnd, dates },
    periodsInWindow: computePeriodsInWindow(dates, calendar),
    pools,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  const okCount = pools.filter((p) => p.status === "ok").length;
  console.log(`\nWrote ${OUTPUT_PATH} (${okCount}/${pools.length} ok)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
