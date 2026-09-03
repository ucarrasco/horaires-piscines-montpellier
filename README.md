# Montpellier swimming pool schedules

A simple site showing the opening hours of every public swimming pool in
Montpellier, in a single unified view. A daily job (GitHub Actions) reads each
pool's page, extracts the opening hours and exceptional closures with Claude, and
stores the result in a static JSON file read by the frontend.

The site itself is in French; the codebase is in English.

```
Daily cron (GitHub Actions)
  └─ scripts/scrape.ts    : fetch HTML → Claude (JSON extraction) → public/data/schedules.json
  └─ scripts/prerender.ts : renders every route to static HTML → dist/
Frontend (Vite + React)
  └─ hydrates the prerendered page → agenda + per-pool tables
Hosting: GitHub Pages
```

No database: the data fits in a single versioned JSON file.

## Static rendering

The site is prerendered at build time so that the HTML contains the actual
opening hours — a client-rendered SPA would be an empty `<div>` to crawlers.
`npm run build` therefore runs three steps: the client build, an SSR bundle
(`src/entry-server.tsx`), then `scripts/prerender.ts`, which writes one page per
route plus `sitemap.xml`, `robots.txt` and, on a custom domain, `CNAME`.

Routes are `/` and `/piscine-<id>/`, listed by `allRoutes()` in
[`src/paths.ts`](src/paths.ts). Navigation between them uses plain links, so no
router is involved.

Each page inlines the data it needs in a `<script type="application/json">` tag,
which the client reads to hydrate without a second round trip.

**Anything that depends on the current time must render the same on the server
and on the first client pass**, otherwise React reports a hydration mismatch.
The pattern used throughout is to start from the build-time value and switch to
the real one in an effect: see `useNow` and `useNowMinutes` in
[`src/App.tsx`](src/App.tsx). The same applies to `localStorage` (the pool order),
which is read after mount.

## Requirements

- Node 20+
- An Anthropic API key (`ANTHROPIC_API_KEY`)

## Running locally

```bash
npm install

# Serve the site (uses the existing public/data/schedules.json)
npm run dev

# Regenerate the schedules (requires the API key)
export ANTHROPIC_API_KEY=sk-ant-...
npm run scrape

# Dry run on one or more URLs: prints the resolved JSON, writes nothing
npm run scrape -- https://www.montpellier.fr/territoire/lieux-equipements/piscine-pitot
```

The list of pools lives in [`scripts/pools.ts`](scripts/pools.ts) — add an entry
with its `id`, display `name` and the URL of its page.

## Deployment (GitHub Pages)

1. Push the repo to GitHub.
2. Under **Settings → Secrets and variables → Actions**, add the
   `ANTHROPIC_API_KEY` secret.
3. Under **Settings → Pages**, pick **Source: GitHub Actions**.
4. The [`.github/workflows/daily.yml`](.github/workflows/daily.yml) workflow:
   - runs every day at 04:00 UTC (and manually via *Run workflow*),
   - regenerates `public/data/schedules.json` and commits it when it changed,
   - builds, prerenders and deploys the site to Pages.

### Failure notifications

When a pool cannot be read, or the build or deploy fails, the last step of the
workflow posts a summary to a Discord channel and turns the run red. Add a
`DISCORD_WEBHOOK_URL` secret holding a channel webhook URL (*channel settings →
Integrations → Webhooks*). Without it, the run still goes red but nothing is
posted. [`scripts/notify.mjs`](scripts/notify.mjs) can be tried locally:

```bash
SCRAPE_FAILED=true DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... node scripts/notify.mjs
```

A pool whose page could not be read keeps the schedule of its last successful
read (`status: "stale"`, dated by `scrapedAt`), re-resolved over the current
window, so a bad day for the API or for montpellier.fr does not empty the site.
The site shows those pools normally, with a note giving the date of the read.

### Site URL and custom domain

Everything URL-related derives from `SITE_URL`, defined once in
[`scripts/site.ts`](scripts/site.ts): Vite's `base`, the canonical tags, the
sitemap entries and whether a `CNAME` file is emitted.

It defaults to the GitHub Pages URL. To move to a custom domain, add a
**repository variable** (not a secret) named `SITE_URL` under *Settings → Secrets
and variables → Actions → Variables*, for example
`https://piscines-montpellier.fr`. Nothing else changes: the next build emits the
`CNAME` file and rewrites every absolute URL. Point the domain's DNS at GitHub
Pages, then declare the site in the Google Search Console.

Locally, `SITE_URL=https://example.org npm run build` does the same.

## JSON shape

See [`src/types.ts`](src/types.ts) for the exact types.

For each pool, the LLM extracts **three weekly schedules** (`term`,
`short_holidays`, `summer_holidays`), the **dated closures and events**
(`events`) and any **holiday dates announced on the page itself**
(`periodOverrides`).

The scraper then deterministically computes a **±7 day window** around the
generation date:

- `periodsInWindow`: the school periods (zone C) falling inside the window,
  according to the [official calendar](https://data.education.gouv.fr) (a pool's
  own `periodOverrides` take precedence over that calendar, for that pool only);
- `pools[].resolved`: the **actual day-by-day hours**, crossing each date with
  its period and any closures or exceptional hours.

```json
{
  "generatedAt": "2026-08-08T04:00:00.000Z",
  "window": { "start": "2026-08-01", "end": "2026-08-15", "dates": ["..."] },
  "periodsInWindow": [
    { "period": "summer_holidays", "label": "Vacances d'Été", "start": "2026-08-01", "end": "2026-08-15" }
  ],
  "pools": [
    {
      "id": "neptune",
      "name": "Piscine Neptune",
      "url": "https://...",
      "status": "ok",
      "scrapedAt": "2026-08-08T04:00:00.000Z",
      "periods": { "term": { "monday": [], "...": [] }, "short_holidays": {}, "summer_holidays": {} },
      "events": [
        { "start": "2026-08-15", "end": null, "description": "Assomption : horaires spéciaux",
          "closed": false, "slots": [{ "start": "09:00", "end": "13:15", "label": "Public" }] }
      ],
      "periodOverrides": [],
      "notes": null,
      "resolved": [
        { "date": "2026-08-08", "day": "saturday", "period": "summer_holidays",
          "slots": [{ "start": "14:00", "end": "20:00", "label": "Public" }],
          "closed": false, "exceptional": false, "events": [] }
      ]
    }
  ]
}
```

`status` is `"ok"` when the page was read during that run, `"stale"` when it
could not be and the previous read is kept (`scrapedAt` says when), `"error"`
when there is nothing to show.

Note that `label`, `description` and `notes` hold text copied from the source
pages, so they are in French — they are displayed as-is on the site.

## Cost

Extraction uses the `claude-opus-4-8` model, one request per pool per day. For
~15 pools the daily cost is on the order of a few cents. Switch to
`claude-sonnet-5` in [`scripts/scrape.ts`](scripts/scrape.ts) to reduce it.
