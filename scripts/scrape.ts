import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * Pools re-extracted per run even though their page is unchanged, oldest read
 * first. Rotating a couple per run bounds both the bill and how long a bad
 * extraction can survive, without the every-N-days stampede a plain age
 * threshold would cause (all 15 are read within seconds of each other).
 */
const REVALIDATE_PER_RUN = 2;
/** Hard ceiling, should the rotation ever fall behind. */
const MAX_CACHE_AGE_DAYS = 10;

/**
 * Bump when htmlToText, the user-message template or the post-processing of
 * the tool output changes: those shape the extraction but are not part of
 * PROMPT_VERSION below, so nothing else would invalidate the stored hashes.
 */
const CACHE_VERSION = 1;

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
  // Everything relevant sits in <main>; the surrounding menus and footer are
  // three quarters of the text and cost as much per token as the schedules.
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0] ?? html;
  return main
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
- When the page gives BOTH the opening hours of the establishment and hours specific to one area ("bassin ludique", "bassin extérieur", "bassins intérieurs", "espaces extérieurs"), the weekly schedule is the ESTABLISHMENT's. Area hours never replace it: put them in the slot "label" or in "notes". Answering "can I swim right now?" with the hours of one restricted area would show the pool closed while it is open.
- If the page gives no establishment-wide hours but several areas, use the area open the most widely over the year and name it in every slot "label".
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
- Convert every date to the "YYYY-MM-DD" format. A date written without a year means its next occurrence on or after today's date.
- Never use today's date as a boundary, and never record a date that is not written on the page. The extraction must depend only on the page: an announcement that gives a single date ("les cours reprennent à partir du lundi 14 septembre") is that one date, with start = end. Do not turn it into a span running from today.
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

// --- Source fingerprint ---------------------------------------------------

/**
 * Identifies everything that shapes an extraction apart from the page itself.
 * Touching the prompt, the tool schema or the model changes it, which
 * invalidates every stored hash and re-reads all 15 pools on the next run —
 * that is how a prompt fix reaches pools whose page has not moved.
 */
const PROMPT_VERSION = createHash("sha256")
  .update(
    `${CACHE_VERSION}\n${MODEL}\n${SYSTEM_PROMPT}\n${JSON.stringify(EXTRACTION_TOOL)}`,
  )
  .digest("hex")
  .slice(0, 12);

const HASH_CUTOFF = /Documents\s+à\s+télécharger/i;
let cutoffWarned = false;

/**
 * The page text the fingerprint covers: everything up to the download list,
 * which closes all 15 pages and whose PDF sizes drift on their own (the pool
 * guide went from 878 KB to 21366 KB in a fortnight). Nothing after it
 * mentions opening hours, so cutting it only removes false re-reads.
 */
function hashableText(text: string): string {
  const m = text.match(HASH_CUTOFF);
  if (m) return text.slice(0, m.index);
  if (!cutoffWarned) {
    cutoffWarned = true;
    // Fails open on cost, so it has to be said out loud: without the cut the
    // hash moves whenever a PDF is reuploaded and the cache stops matching.
    console.warn(
      `\n⚠️  Repère "Documents à télécharger" introuvable : l'empreinte couvre toute la page.`,
    );
  }
  return text;
}

function sourceFingerprint(text: string, url: string): string {
  return createHash("sha256")
    .update(`${PROMPT_VERSION}\n${url}\n${hashableText(text)}`)
    .digest("hex")
    .slice(0, 32);
}

async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "pool-schedules-bot/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return htmlToText(await res.text());
}

/**
 * One extraction attempt on already-fetched text. Throws on any failure, so
 * the caller can retry. The text is passed in rather than fetched here so that
 * the fingerprint stored alongside the result is the one of the exact bytes
 * the model saw.
 */
async function extractOnce(
  client: Anthropic,
  pool: PoolConfig & { url: string },
  today: string,
  text: string,
): Promise<{ schedule: PoolSchedule; usage: string }> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    // Tools render before system, so this breakpoint caches both. Pools are
    // extracted back to back, well within the 5-minute TTL.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
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
  return {
    schedule: toolUse.input as PoolSchedule,
    usage: formatUsage(message.usage),
  };
}

function formatUsage(u: Anthropic.Usage): string {
  const k = (n: number | null | undefined) =>
    `${((n ?? 0) / 1000).toFixed(1)}k`;
  return `${k(u.input_tokens)} in, ${k(u.cache_read_input_tokens)} cached, ${k(u.output_tokens)} out`;
}

interface CacheContext {
  previous: Previous | null;
  /** Ignore the cache entirely (dry run, --force). */
  force: boolean;
  /** Pool ids the rotation re-reads this run whatever their fingerprint. */
  revalidate: Set<string>;
  today: string;
  window: { start: string; end: string };
}

/** Why this pool is, or is not, being sent to the model. Shown in the log. */
function cacheDecision(
  pool: PoolConfig,
  sourceHash: string,
  ctx: CacheContext,
): { reuse: boolean; reason: string } {
  if (ctx.force) return { reuse: false, reason: "forcé" };

  // What makes a pool uncacheable is checked before the rotation, so that the
  // log names the real blocker ("page modifiée") instead of the rotation that
  // would have re-read it anyway.
  const prev = ctx.previous?.pools.get(pool.id);
  if (!prev) return { reuse: false, reason: "jamais relevée" };
  if (prev.status !== "ok")
    return { reuse: false, reason: "relevé précédent en échec" };
  if (!prev.sourceHash) return { reuse: false, reason: "pas d'empreinte" };
  if (!prev.scrapedAt) return { reuse: false, reason: "pas de date de relevé" };
  if (prev.sourceHash !== sourceHash)
    return { reuse: false, reason: "page modifiée" };
  if (prev.scrapedAt.slice(0, 4) !== ctx.today.slice(0, 4)) {
    // Bare dates ("1er janvier") are resolved against the year of the run, so
    // an extraction made last year carries dates this window cannot match.
    return { reuse: false, reason: "changement d'année" };
  }
  if (
    (prev.networkClaims ?? []).some(
      (c) =>
        c.closed && overlaps(c.start, c.end, ctx.window.start, ctx.window.end),
    )
  ) {
    // Pass 2 copies this pool's claims onto the 14 others, so a frozen closure
    // would shut the whole network on a day it is open. Only closures are
    // worth a re-read: the informational ones ("reprise des cours le 14") sit
    // on all 15 pages for weeks and would never let anything cache.
    return { reuse: false, reason: "fermeture réseau annoncée" };
  }

  if (ctx.revalidate.has(pool.id))
    return { reuse: false, reason: "revalidation" };

  return { reuse: true, reason: "page inchangée" };
}

/**
 * Extracts one pool, with a single retry after RETRY_DELAY_MS.
 *
 * The city pages fail transiently often enough that one blip should not be
 * reported as a broken pool — and since a failure now turns the whole run red,
 * a false alarm costs an email. The retry covers the API call too: an overload
 * there is just as transient as an HTTP 503 from montpellier.fr.
 *
 * The page is fetched on every run even when the model is not called: the
 * fetch is free and it is what tells us whether anything changed.
 */
async function extractPool(
  client: Anthropic,
  pool: PoolConfig,
  ctx: CacheContext,
): Promise<Extracted> {
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
      const text = await fetchPageText(withUrl.url);
      const sourceHash = sourceFingerprint(text, withUrl.url);
      const verdict = cacheDecision(pool, sourceHash, ctx);

      if (verdict.reuse) {
        const prev = ctx.previous!.pools.get(pool.id)!;
        return {
          ...base,
          status: "ok",
          scrapedAt: prev.scrapedAt,
          sourceHash,
          reason: verdict.reason,
          // Field by field on purpose: spreading prev would drag the previous
          // run's "resolved", "status" and "error" along with the schedule.
          periods: prev.periods,
          events: prev.events,
          periodOverrides: prev.periodOverrides,
          networkClaims: prev.networkClaims ?? [],
          notes: prev.notes,
        };
      }

      const { schedule, usage } = await extractOnce(
        client,
        withUrl,
        ctx.today,
        text,
      );
      return {
        ...base,
        status: "ok",
        scrapedAt: new Date().toISOString(),
        sourceHash,
        usage,
        reason: verdict.reason,
        ...schedule,
      };
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

// --- Falling back on the previous run -------------------------------------

/** Log-only fields, stripped by forOutput before the file is written. */
type Extracted = Omit<PoolResult, "resolved"> & {
  usage?: string;
  reason?: string;
};

const forOutput = ({
  usage: _usage,
  reason: _reason,
  ...pool
}: Extracted): Omit<PoolResult, "resolved"> => pool;

interface Previous {
  generatedAt: string;
  pools: Map<string, PoolResult>;
}

async function loadPrevious(): Promise<Previous | null> {
  if (!existsSync(OUTPUT_PATH)) return null;
  const data = JSON.parse(await readFile(OUTPUT_PATH, "utf8")) as SchedulesData;
  return {
    generatedAt: data.generatedAt,
    pools: new Map(
      data.pools.map((p) => [
        p.id,
        // Inferred events are dropped once here, for every consumer of the
        // previous run. Pass 2 re-derives them from this run's claims, and
        // letting one through would make it first-party evidence in
        // applyNetworkClaims — a silent veto against a fresh contradicting
        // claim, that nothing would ever clear.
        { ...p, events: (p.events ?? []).filter((e) => !e.inferredFrom) },
      ]),
    ),
  };
}

/**
 * A pool whose page could not be read this time keeps the schedule of its last
 * successful read, marked "stale". The weekly hours hardly ever change and the
 * events are dated, so yesterday's read still answers "is it open today?" —
 * far better than the empty column an "error" pool shows. Without this, one
 * bad API day (expired key, empty credit) wiped every pool off the site.
 */
function fallBackOnPrevious(
  result: Extracted,
  previous: Previous | null,
): Extracted {
  if (result.status !== "error" || !previous) return result;
  const prev = previous.pools.get(result.id);
  if (!prev || prev.status === "error") return result;

  return {
    ...result,
    status: "stale",
    // Files written before scrapedAt existed only carry the run timestamp.
    scrapedAt: prev.scrapedAt ?? previous.generatedAt,
    // Deliberately no sourceHash: the page may well have changed, and storing
    // this run's fingerprint next to the previous run's schedule would make
    // every later run a cache hit on hours nobody ever read.
    sourceHash: undefined,
    periods: prev.periods,
    events: prev.events,
    periodOverrides: prev.periodOverrides,
    networkClaims: prev.networkClaims ?? [],
    notes: prev.notes,
  };
}

// --- Cross-pool reconciliation --------------------------------------------
// A pool's page sometimes talks about the OTHER pools ("seule piscine du réseau
// ouverte"). Pass 1 records those sentences as networkClaims; this pass turns
// them into ordinary events on the pools they concern. No API call involved.

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
  return targets.filter((t) => t.id !== source.id && t.status !== "error");
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
    if (source.status === "error") continue;
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

// --- Cache rotation and inspection ----------------------------------------

/**
 * The pools to re-read even though their page is unchanged: the oldest reads
 * first, plus anything past MAX_CACHE_AGE_DAYS as a safety net.
 *
 * A plain age threshold would not do: the 15 reads are seconds apart, so they
 * would all expire on the same day and the run would cost 15 calls every N
 * days. Taking the k oldest spreads it evenly, and since any re-extraction
 * (rotation or changed page) resets scrapedAt, the queue balances itself.
 */
function rotationDue(previous: Previous | null): Set<string> {
  if (!previous) return new Set();

  const dated = POOLS.map((p) => ({ id: p.id, prev: previous.pools.get(p.id) }))
    .filter((c) => c.prev?.status === "ok" && c.prev.scrapedAt)
    .sort((a, b) =>
      a.prev!.scrapedAt === b.prev!.scrapedAt
        ? a.id.localeCompare(b.id)
        : a.prev!.scrapedAt! < b.prev!.scrapedAt!
          ? -1
          : 1,
    );

  const due = new Set(dated.slice(0, REVALIDATE_PER_RUN).map((c) => c.id));
  const now = Date.now();
  for (const c of dated) {
    const ageDays = (now - Date.parse(c.prev!.scrapedAt!)) / 86_400_000;
    if (ageDays > MAX_CACHE_AGE_DAYS) due.add(c.id);
  }
  return due;
}

/**
 * Everything in an extraction that decides what the site shows — prose left
 * out. The model rewords notes and descriptions on every read, so comparing
 * the whole payload would flag every revalidation and signal nothing.
 */
const decisivePayload = (p: Omit<PoolResult, "resolved">) =>
  JSON.stringify({
    periods: p.periods,
    events: (p.events ?? [])
      .filter((e) => !e.inferredFrom)
      .map((e) => [e.start, e.end, e.closed, e.slots]),
    periodOverrides: p.periodOverrides,
    networkClaims: (p.networkClaims ?? []).map((c) => [
      c.start,
      c.end,
      c.closed,
      c.scope,
      c.pools,
    ]),
  });

/**
 * Dry inspection: fetches the 15 pages, prints what a real run would do and
 * why, then stops. No API key, no call, nothing written — the only way to tell
 * a working cache from a silently broken one without paying for it.
 */
async function checkCache(
  today: string,
  window: { start: string; end: string },
) {
  const previous = await loadPrevious();
  const ctx: CacheContext = {
    previous,
    force: false,
    revalidate: rotationDue(previous),
    today,
    window,
  };

  console.log(`🔍 Inspection du cache (aucun appel, rien d'écrit)\n`);
  let reuse = 0;
  for (const pool of POOLS) {
    process.stdout.write(`  - ${pool.name}... `);
    if (!pool.url) {
      console.log("pas d'url");
      continue;
    }
    try {
      const text = await fetchPageText(pool.url);
      const hash = sourceFingerprint(text, pool.url);
      const verdict = cacheDecision(pool, hash, ctx);
      if (verdict.reuse) reuse++;
      // The fingerprint is printed so a cache that stopped matching can be
      // diagnosed by comparing it with the one stored in schedules.json.
      console.log(
        `${verdict.reuse ? "cache" : "LLM  "} ${hash.slice(0, 8)} (${verdict.reason})`,
      );
    } catch (err) {
      console.log(
        `échec (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  console.log(
    `\n${reuse}/${POOLS.length} en cache → ${POOLS.length - reuse} appel(s) LLM`,
  );
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
    const next = args[replayIdx + 1];
    await replay(next && !next.startsWith("-") ? next : OUTPUT_PATH);
    return;
  }

  const today = todayInParis();
  const windowStart = addDays(today, -WINDOW_RADIUS);
  const windowEnd = addDays(today, WINDOW_RADIUS);
  const window = { start: windowStart, end: windowEnd };

  // Inspection mode: `npm run scrape -- --check`
  // -> says which pools would be sent to the model, without calling it.
  if (args.includes("--check")) {
    await checkCache(today, window);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "❌ Missing ANTHROPIC_API_KEY. Run: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY

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
        // force: a dry run exists to exercise the prompt, so it must always
        // reach the model, even on a URL that matches a known pool.
        { previous: null, force: true, revalidate: new Set(), today, window },
      );
      const rest = forOutput(extracted);
      const result: PoolResult = {
        ...rest,
        resolved: resolveDays(rest, dates, calendar),
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

  const previous = await loadPrevious();
  const ctx: CacheContext = {
    previous,
    force: args.includes("--force"),
    revalidate: rotationDue(previous),
    today,
    window,
  };

  console.log(`Extracting ${POOLS.length} pool(s)...`);
  const extracted: Extracted[] = [];
  for (const pool of POOLS) {
    process.stdout.write(`  - ${pool.name}... `);
    const result = fallBackOnPrevious(
      await extractPool(client, pool, ctx),
      previous,
    );
    console.log(
      result.status === "stale"
        ? `error (${result.error}), keeping the read of ${result.scrapedAt}`
        : result.status === "error"
          ? `error (${result.error})`
          : result.usage
            ? `llm (${result.reason}) — ${result.usage}`
            : `cache (${result.reason}, relevé du ${result.scrapedAt?.slice(0, 10)})`,
    );

    // A re-read of an unchanged page that comes back different is the model
    // being non-deterministic. Worth seeing: it is what the cache freezes.
    const prev = previous?.pools.get(pool.id);
    if (
      result.reason === "revalidation" &&
      prev &&
      decisivePayload(prev) !== decisivePayload(result)
    ) {
      console.log(
        `      ↳ horaires ou évènements différents sur une page inchangée`,
      );
    }

    extracted.push(result);
  }

  const { claims, injected } = applyNetworkClaims(extracted);
  if (claims > 0) {
    console.log(
      `\n↳ ${claims} annonce(s) réseau → ${injected} évènement(s) déduit(s)`,
    );
  }

  const pools: PoolResult[] = extracted.map((pool) => ({
    ...forOutput(pool),
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

  const count = (status: PoolResult["status"]) =>
    pools.filter((p) => p.status === status).length;

  // One line saying how many calls this run cost and why. Also written to the
  // job summary: notify.mjs only runs on failure, so a green run would
  // otherwise leave no trace outside the raw logs.
  const called = extracted.filter((p) => p.usage);
  const reused = extracted.filter((p) => p.status === "ok" && !p.usage);
  const byReason = new Map<string, number>();
  for (const p of called)
    byReason.set(p.reason ?? "?", (byReason.get(p.reason ?? "?") ?? 0) + 1);
  const summary =
    `LLM ${called.length}/${POOLS.length}` +
    (called.length > 0
      ? ` — ${[...byReason].map(([r, n]) => `${r} ×${n}`).join(", ")}`
      : "") +
    `, ${reused.length} réutilisée(s)` +
    (count("stale") + count("error") > 0
      ? `, ${count("stale")} stale, ${count("error")} error`
      : "");
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  console.log(
    `\nWrote ${OUTPUT_PATH} (${count("ok")} ok, ${count("stale")} stale, ${count("error")} error)`,
  );

  // The file is written first on purpose: the pools that did work should still
  // reach the site. Failing only afterwards turns the run red so the failure is
  // noticed, without throwing away the good data.
  const failed = pools.filter((p) => p.status !== "ok");
  if (failed.length > 0) {
    console.error(
      `\n❌ ${failed.length}/${pools.length} pool(s) could not be read:`,
    );
    for (const p of failed) {
      const kept =
        p.status === "stale" ? ` (showing the read of ${p.scrapedAt})` : "";
      console.error(`   - ${p.name}: ${p.error}${kept}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
