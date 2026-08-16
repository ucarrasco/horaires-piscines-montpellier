import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { POOLS, matchPool, type PoolConfig } from "./pools.ts";
import {
  DAY_KEYS,
  PERIOD_KEYS,
  type DatedEvent,
  type NetworkClaim,
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
const RETRIES = 1; // extra attempts per pool, on top of the first one
const RETRY_DELAY_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      networkClaims: {
        type: "array",
        description:
          "Statements made on THIS page about OTHER pools or about the whole municipal network. Empty if none.",
        items: {
          type: "object",
          properties: {
            start: { type: "string", description: 'Start date "YYYY-MM-DD"' },
            end: {
              type: ["string", "null"],
              description:
                'End date "YYYY-MM-DD" inclusive, or null for a single day',
            },
            scope: {
              type: "string",
              enum: ["all_pools", "all_other_pools", "named_pools"],
              description:
                'Which pools the statement is about: the whole network including this one, every pool EXCEPT this one, or only the ones listed in "pools".',
            },
            pools: {
              type: "array",
              items: { type: "string" },
              description:
                'Pool names exactly as written on the page. Empty unless scope is "named_pools".',
            },
            closed: {
              type: "boolean",
              description: "true if those pools are closed over that period",
            },
            description: {
              type: "string",
              description:
                "French, phrased from the point of view of the pools it applies TO, not of the page it was found on.",
            },
          },
          required: ["start", "end", "scope", "pools", "closed", "description"],
          additionalProperties: false,
        },
      },
      notes: {
        type: ["string", "null"],
        description: "Any other useful information, otherwise null",
      },
    },
    required: [
      "periods",
      "events",
      "periodOverrides",
      "networkClaims",
      "notes",
    ],
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
- "events" only ever describes THIS pool. When the page says something about OTHER pools or about the whole municipal network — "seule piscine du réseau ouverte", "toutes les piscines municipales seront fermées le 1er mai", "la piscine X est fermée pour travaux" — record it in "networkClaims" instead. A single sentence can produce both: an event for this pool AND a network claim for the others.
- Pick the network claim scope carefully: "all_other_pools" when the sentence implies every pool except this one (that is exactly what "seule piscine ouverte" means), "all_pools" when it covers the whole network including this one, "named_pools" when specific pools are named — then list them in "pools" exactly as written on the page.
- A network claim "description" is displayed on the pages of the pools it applies to, so write it from their point of view. From "ouverture exceptionnelle de la Piscine X (seule piscine du réseau ouverte)", write "Fermeture le 15 août (jour férié) — seule la Piscine X est ouverte", not the original sentence.
- Only record a network claim when the page really states it. Never generalise this pool's own closure to the others.
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
    networkClaims: [],
    notes: null,
  };
}

/** One extraction attempt. Throws on any failure, so the caller can retry. */
async function extractOnce(
  client: Anthropic,
  pool: PoolConfig & { url: string },
  today: string,
): Promise<PoolSchedule> {
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
  return toolUse.input as PoolSchedule;
}

/**
 * Extracts one pool, with a single retry after RETRY_DELAY_MS.
 *
 * The city pages fail transiently often enough that one blip should not be
 * reported as a broken pool — and since a failure now turns the whole run red,
 * a false alarm costs an email. The retry covers the API call too: an overload
 * there is just as transient as an HTTP 503 from montpellier.fr.
 */
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

  const withUrl = { ...pool, url: pool.url };

  for (let attempt = 1; attempt <= 1 + RETRIES; attempt++) {
    try {
      const parsed = await extractOnce(client, withUrl, today);
      return { ...base, status: "ok", ...parsed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt <= RETRIES) {
        // Same line as the "  - Pool name... " prefix already written.
        process.stdout.write(
          `${msg}, retrying in ${RETRY_DELAY_MS / 1000}s... `,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { ...base, status: "error", error: msg, ...emptySchedule() };
    }
  }

  // Unreachable: the loop either returns or exhausts its attempts above.
  throw new Error("unreachable");
}

// --- Cross-pool reconciliation --------------------------------------------
// A pool's page sometimes talks about the OTHER pools ("seule piscine du réseau
// ouverte"). Pass 1 records those sentences as networkClaims; this pass turns
// them into ordinary events on the pools they concern. No API call involved.

type Extracted = Omit<PoolResult, "resolved">;

interface Candidate {
  claim: NetworkClaim;
  source: Extracted;
}

/**
 * Does this event actually settle whether the pool opens? A closure or an
 * announced set of hours does; a dated note ("stages enfants du 17 au 21 août")
 * does not, and must not veto what another page says about that day.
 */
function isDecisive(event: DatedEvent): boolean {
  return event.closed || (event.slots?.length ?? 0) > 0;
}

/** Do two inclusive date ranges (null end = single day) overlap? */
function overlaps(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string | null,
): boolean {
  return aStart <= (bEnd ?? bStart) && bStart <= (aEnd ?? aStart);
}

/** The pools a claim is about, minus its source: a page rules over itself. */
function claimTargets(
  claim: NetworkClaim,
  source: Extracted,
  pools: Extracted[],
  onWarn: (msg: string) => void,
): Extracted[] {
  let targets: Extracted[];

  if (claim.scope === "named_pools") {
    targets = [];
    for (const name of claim.pools) {
      const matched = matchPool(name);
      if (!matched) {
        onWarn(
          `Unresolved pool name "${name}" in a claim from ${source.name} — ignored.`,
        );
        continue;
      }
      const target = pools.find((p) => p.id === matched.id);
      if (target) targets.push(target);
    }
  } else {
    // all_pools / all_other_pools: the source is filtered out either way.
    targets = pools;
  }

  // Skip pools we know nothing about: their page failed to load, and "closed"
  // would read as knowledge where the site otherwise says "indisponible".
  return targets.filter((t) => t.id !== source.id && t.status === "ok");
}

/**
 * Applies every pool's network claims to the pools they name. Mutates `pools`.
 * Three rules: claims that contradict each other are all dropped rather than
 * arbitrated; identical claims from several pages count once; and a pool's own
 * page wins over what another page says about it, as long as it says something
 * decisive about that day (see isDecisive).
 */
function applyNetworkClaims(
  pools: Extracted[],
  onWarn: (msg: string) => void = console.warn,
): { claims: number; injected: number } {
  // Snapshotted (copied, not aliased) before injecting anything, so that an
  // inferred event never becomes first-party evidence against a later claim.
  const ownEvents = new Map(pools.map((p) => [p.id, [...(p.events ?? [])]]));
  const candidates = new Map<string, Candidate[]>();

  let claims = 0;
  for (const source of pools) {
    if (source.status !== "ok") continue;
    for (const claim of source.networkClaims ?? []) {
      claims++;
      for (const target of claimTargets(claim, source, pools, onWarn)) {
        const list = candidates.get(target.id);
        if (list) list.push({ claim, source });
        else candidates.set(target.id, [{ claim, source }]);
      }
    }
  }

  let injected = 0;
  for (const [targetId, list] of candidates) {
    const target = pools.find((p) => p.id === targetId)!;
    const seen = new Set<string>();

    for (const { claim, source } of list) {
      const contradicted = list.some(
        (o) =>
          o.claim !== claim &&
          o.claim.closed !== claim.closed &&
          overlaps(o.claim.start, o.claim.end, claim.start, claim.end),
      );
      if (contradicted) {
        onWarn(
          `Contradictory claims about ${target.name} around ${claim.start} — none applied.`,
        );
        continue;
      }

      const key = `${claim.start}|${claim.end ?? ""}|${claim.closed}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const firstParty = ownEvents
        .get(targetId)!
        .some(
          (e) =>
            isDecisive(e) && overlaps(e.start, e.end, claim.start, claim.end),
        );
      if (firstParty) continue;

      const event: DatedEvent = {
        start: claim.start,
        end: claim.end,
        description: claim.description,
        closed: claim.closed,
        slots: null,
        inferredFrom: {
          poolId: source.id,
          poolName: source.name,
          url: source.url,
        },
      };
      target.events.push(event);
      injected++;
    }
  }

  return { claims, injected };
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

/** Rebuilds a calendar from the spans stored in a schedules.json (offline). */
function calendarFromSpans(spans: PeriodSpan[]): SchoolCalendar {
  const byDate = new Map<string, { period: PeriodKey; label: string | null }>();
  for (const span of spans) {
    for (const date of dateRange(span.start, span.end)) {
      byDate.set(date, { period: span.period, label: span.label });
    }
  }
  return {
    periodFor: (iso) => byDate.get(iso) ?? { period: "term", label: null },
  };
}

/**
 * Replays pass 2 over an existing schedules.json: re-applies the network claims
 * and re-resolves the days, then prints the days whose closure changed.
 * Offline, no API key, writes nothing — meant to be run on a hand-edited
 * fixture to exercise the reconciliation rules.
 */
async function replay(path: string) {
  const data = JSON.parse(await readFile(path, "utf8")) as SchedulesData;
  console.log(`🔁 Replay of ${path} (no file written)\n`);

  // Dropping the previously inferred events keeps a replay idempotent.
  const pools: Extracted[] = data.pools.map((pool) => ({
    ...pool,
    events: (pool.events ?? []).filter((e) => !e.inferredFrom),
  }));

  const wasClosed = new Map(
    data.pools.flatMap((p) =>
      (p.resolved ?? []).map((d) => [`${p.id}|${d.date}`, d.closed] as const),
    ),
  );

  const { claims, injected } = applyNetworkClaims(pools);
  console.log(
    `${claims} annonce(s) réseau → ${injected} évènement(s) déduit(s)\n`,
  );

  const calendar = calendarFromSpans(data.periodsInWindow);
  let changes = 0;
  for (const pool of pools) {
    for (const day of resolveDays(pool, data.window.dates, calendar)) {
      const before = wasClosed.get(`${pool.id}|${day.date}`);
      if (before === day.closed) continue;
      changes++;
      console.log(
        `  ${day.date}  ${pool.name} : ${before ? "fermé" : "ouvert"} → ${
          day.closed ? "fermé" : "ouvert"
        }`,
      );
    }
  }
  if (changes === 0) console.log("  (aucun jour modifié)");
}

// --- Main -----------------------------------------------------------------

async function main() {
  // Load .env when present (local dev). On CI the key comes from a secret.
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const args = process.argv.slice(2);

  // Replay mode: `npm run scrape -- --replay [file.json]`
  // -> re-runs the cross-pool pass only. No API key needed, nothing written.
  const replayIdx = args.indexOf("--replay");
  if (replayIdx !== -1) {
    await replay(args[replayIdx + 1] ?? OUTPUT_PATH);
    return;
  }

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
  const urlArgs = args.filter((a) => a.startsWith("http"));
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
      // Called out on its own: a single pool run never applies them, so this
      // is the only way to check what pass 2 would receive.
      console.log(
        `\n↳ networkClaims: ${JSON.stringify(extracted.networkClaims ?? [], null, 2)}\n`,
      );
    }
    return;
  }

  console.log(`Extracting ${POOLS.length} pool(s)...`);
  const extracted: Extracted[] = [];
  for (const pool of POOLS) {
    process.stdout.write(`  - ${pool.name}... `);
    const result = await extractPool(client, pool, today);
    console.log(result.status === "ok" ? "ok" : `error (${result.error})`);
    extracted.push(result);
  }

  const { claims, injected } = applyNetworkClaims(extracted);
  if (claims > 0) {
    console.log(
      `\n↳ ${claims} annonce(s) réseau → ${injected} évènement(s) déduit(s)`,
    );
  }

  const pools: PoolResult[] = extracted.map((pool) => ({
    ...pool,
    resolved: resolveDays(pool, dates, calendar),
  }));

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

  // The file is written first on purpose: the pools that did work should still
  // reach the site. Failing only afterwards turns the run red so the failure is
  // noticed, without throwing away the good data.
  const failed = pools.filter((p) => p.status !== "ok");
  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length}/${pools.length} pool(s) failed:`);
    for (const p of failed) console.error(`   - ${p.name}: ${p.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
