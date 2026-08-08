# Horaires des piscines de Montpellier

Site simple qui affiche, dans un tableau unifié, les horaires des piscines de
Montpellier. Un job quotidien (GitHub Actions) va lire chaque page de piscine,
extrait les horaires et les fermetures exceptionnelles avec Claude, et stocke le
résultat dans un fichier JSON statique lu par le frontend.

```
Cron quotidien (GitHub Actions)
  └─ scripts/scrape.ts : fetch HTML → Claude (extraction JSON) → public/data/horaires.json
Frontend (Vite + React)
  └─ lit public/data/horaires.json → tableau
Hébergement : GitHub Pages
```

Pas de base de données : les données tiennent dans un seul fichier JSON versionné.

## Prérequis

- Node 20+
- Une clé API Anthropic (`ANTHROPIC_API_KEY`)

## Démarrage local

```bash
npm install

# Lancer le site (utilise public/data/horaires.json existant)
npm run dev

# Régénérer les horaires (nécessite la clé API)
export ANTHROPIC_API_KEY=sk-ant-...
npm run scrape
```

## À faire avant la première vraie génération

1. **Complète la liste des piscines** dans [`scripts/pools.ts`](scripts/pools.ts) :
   renseigne l'`url` de la page horaires de chaque piscine (et ajuste les noms).
2. Lance `npm run scrape` en local pour vérifier le résultat.
3. Ouvre `npm run dev` pour visualiser le tableau.

## Déploiement (GitHub Pages)

1. Pousse le repo sur GitHub.
2. Dans **Settings → Secrets and variables → Actions**, ajoute le secret
   `ANTHROPIC_API_KEY`.
3. Dans **Settings → Pages**, choisis **Source : GitHub Actions**.
4. Le workflow [`.github/workflows/daily.yml`](.github/workflows/daily.yml) :
   - tourne chaque jour à 04:00 UTC (et manuellement via *Run workflow*),
   - régénère `public/data/horaires.json` et le committe s'il a changé,
   - build le site et le déploie sur Pages.

## Structure du JSON

Voir [`src/types.ts`](src/types.ts) pour le type exact.

Le LLM extrait, pour chaque piscine, **trois grilles hebdomadaires** (`scolaire`,
`petites_vacances`, `vacances_ete`), les **fermetures/événements datés** (`events`)
et d'éventuelles **dates de vacances annoncées sur la page** (`periodOverrides`).

Le scraper calcule ensuite, de façon déterministe, une **fenêtre de ±7 jours**
autour de la date de génération :

- `periodsInWindow` : les périodes scolaires (zone C) qui tombent dans la fenêtre,
  d'après le [calendrier officiel](https://data.education.gouv.fr) (les
  `periodOverrides` d'une piscine priment sur ce calendrier pour cette piscine) ;
- `pools[].resolved` : les **horaires réels jour par jour**, en croisant pour
  chaque date sa période et ses éventuelles fermetures.

```json
{
  "generatedAt": "2026-08-08T04:00:00.000Z",
  "window": { "start": "2026-08-01", "end": "2026-08-15", "dates": ["..."] },
  "periodsInWindow": [
    { "period": "vacances_ete", "label": "Vacances d'Été", "start": "2026-08-01", "end": "2026-08-15" }
  ],
  "pools": [
    {
      "id": "neptune",
      "name": "Piscine Neptune",
      "url": "https://...",
      "status": "ok",
      "periods": { "scolaire": { "monday": [], "...": [] }, "petites_vacances": {}, "vacances_ete": {} },
      "events": [
        { "start": "2026-08-15", "end": null, "description": "Assomption : horaires spéciaux",
          "closed": false, "slots": [{ "start": "09:00", "end": "13:15", "label": "Public" }] }
      ],
      "periodOverrides": [],
      "notes": null,
      "resolved": [
        { "date": "2026-08-08", "day": "saturday", "period": "vacances_ete",
          "slots": [{ "start": "14:00", "end": "20:00", "label": "Public" }],
          "closed": false, "exceptional": false, "events": [] }
      ]
    }
  ]
}
```

## Coût

L'extraction utilise le modèle `claude-opus-4-8`, une requête par piscine et par
jour. Pour ~5 piscines, le coût quotidien est de l'ordre de quelques centimes.
Tu peux passer à `claude-sonnet-5` dans `scripts/scrape.ts` pour réduire le coût.
