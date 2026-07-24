import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { POOLS, type PoolConfig } from "./pools.ts";
import {
  DAY_KEYS,
  type HorairesData,
  type PoolResult,
  type PoolSchedule,
} from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "public", "data", "horaires.json");

const MODEL = "claude-opus-4-8";
const MAX_HTML_CHARS = 40_000;

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

const EXTRACTION_TOOL = {
  name: "record_horaires",
  description: "Enregistre les horaires extraits d'une piscine.",
  input_schema: {
    type: "object" as const,
    properties: {
      days: {
        type: "object",
        description: "Créneaux d'ouverture au public pour chaque jour",
        properties: Object.fromEntries(DAY_KEYS.map((k) => [k, DAY_SCHEMA])),
        required: [...DAY_KEYS],
        additionalProperties: false,
      },
      closures: {
        type: "array",
        items: { type: "string" },
        description:
          "Messages de fermeture exceptionnelle, travaux, jours fériés. Vide si aucun.",
      },
      notes: {
        type: ["string", "null"],
        description: "Autre info utile, sinon null",
      },
    },
    required: ["days", "closures", "notes"],
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
- Si un jour n'a aucun créneau (fermé), renvoie un tableau vide pour ce jour.
- Mets dans "closures" tout message de fermeture exceptionnelle, travaux, ou horaires spéciaux (vacances, jours fériés).
- N'invente jamais d'horaires : si l'information est absente ou ambiguë, laisse le jour vide et ajoute une note.`;

async function extractPool(
  client: Anthropic,
  pool: PoolConfig,
): Promise<PoolResult> {
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
          content: `Piscine : ${pool.name}\n\nContenu de la page :\n${text}`,
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

function emptySchedule(): PoolSchedule {
  return {
    days: Object.fromEntries(
      DAY_KEYS.map((k) => [k, [] as PoolSchedule["days"][keyof PoolSchedule["days"]]]),
    ) as PoolSchedule["days"],
    closures: [],
    notes: null,
  };
}

// --- Main -----------------------------------------------------------------

async function main() {
  const client = new Anthropic(); // lit ANTHROPIC_API_KEY

  console.log(`Extraction de ${POOLS.length} piscine(s)...`);
  const pools: PoolResult[] = [];
  for (const pool of POOLS) {
    process.stdout.write(`  - ${pool.name}... `);
    const result = await extractPool(client, pool);
    console.log(result.status === "ok" ? "ok" : `erreur (${result.error})`);
    pools.push(result);
  }

  const data: HorairesData = {
    generatedAt: new Date().toISOString(),
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
