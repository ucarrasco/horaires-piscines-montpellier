# Montpellier swimming pool schedules

A simple site showing the opening hours of every public swimming pool in
Montpellier, in a single unified view. A daily job (GitHub Actions) reads each
pool's page, extracts the opening hours and exceptional closures with Claude, and
stores the result in a static JSON file read by the frontend.

The site itself is in French; the codebase is in English.

```
Daily cron (GitHub Actions)
  └─ scripts/scrape.ts : fetch HTML → Claude (JSON extraction) → public/data/schedules.json
Frontend (Vite + React)
  └─ reads public/data/schedules.json → agenda + per-pool tables
Hosting: GitHub Pages
```

No database: the data fits in a single versioned JSON file.

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
   - builds the site and deploys it to Pages.

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

Note that `label`, `description` and `notes` hold text copied from the source
pages, so they are in French — they are displayed as-is on the site.

## Cost

Extraction uses the `claude-opus-4-8` model, one request per pool per day. For
~15 pools the daily cost is on the order of a few cents. Switch to
`claude-sonnet-5` in [`scripts/scrape.ts`](scripts/scrape.ts) to reduce it.
