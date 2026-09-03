// Reports a failed CI run: prints a summary (also appended to the GitHub step
// summary), posts it to Discord, and exits non-zero when a pool could not be
// read — the scrape step is continue-on-error, so this is what turns the run
// red. Plain JavaScript on purpose: it must still run when `npm ci` is what
// failed, so no tsx and no dependencies.
//
// Env: DISCORD_WEBHOOK_URL (secret), RUN_URL, SCRAPE_FAILED="true" when the
// scrape step exited non-zero, JOB_FAILED="true" when any other step did.

import { appendFileSync, readFileSync } from "node:fs";

const { DISCORD_WEBHOOK_URL, RUN_URL, SCRAPE_FAILED, JOB_FAILED } = process.env;

// Discord caps a message at 2000 characters; API errors alone can be 300.
const MAX_ERROR_CHARS = 160;
const MAX_CONTENT_CHARS = 1900;

function readPools() {
  try {
    const path = new URL("../public/data/schedules.json", import.meta.url);
    return JSON.parse(readFileSync(path, "utf8")).pools;
  } catch {
    return [];
  }
}

const lines = [];
if (RUN_URL) lines.push(RUN_URL);

if (JOB_FAILED === "true") {
  lines.push("❌ **Le workflow a échoué** (build ou déploiement, voir le run)");
}

if (SCRAPE_FAILED === "true") {
  const pools = readPools();
  const bad = pools.filter((p) => p.status !== "ok");
  if (bad.length === 0) {
    lines.push(
      "❌ **Le relevé a planté avant d'écrire quoi que ce soit** (clé API absente ? réseau ?)",
    );
  } else {
    lines.push(`❌ **${bad.length}/${pools.length} piscine(s) non relevée(s)**`);
    // One line per distinct error: an API outage hits every pool the same way.
    const groups = new Map();
    for (const p of bad) {
      const error = String(p.error ?? "").slice(0, MAX_ERROR_CHARS);
      const kept =
        p.status === "stale"
          ? `horaires du ${p.scrapedAt.slice(0, 10)} conservés`
          : "aucun horaire affiché";
      const key = `\`${error}\` — ${kept}`;
      groups.set(key, [...(groups.get(key) ?? []), p.name]);
    }
    for (const [key, names] of groups) {
      lines.push(`- ${key}\n  ${names.join(", ")}`);
    }
  }
}

const content = lines.join("\n").slice(0, MAX_CONTENT_CHARS);
console.log(content);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, content + "\n");
}

if (DISCORD_WEBHOOK_URL) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (res.ok) console.log("\nPosted to Discord.");
  else console.error(`\nDiscord webhook failed: HTTP ${res.status}`);
} else {
  console.log("\nDISCORD_WEBHOOK_URL is not set: nothing posted.");
}

if (SCRAPE_FAILED === "true") process.exitCode = 1;
