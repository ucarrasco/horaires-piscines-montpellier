# Propager les annonces « réseau » entre piscines

## Context

Le pipeline de scraping est **strictement par piscine** : une page → un appel LLM → un
`PoolResult`. Aucune étape ne croise les piscines entre elles
([scrape.ts:336-345](scripts/scrape.ts#L336-L345)).

Conséquence, visible dans les données actuelles : la page d'Angelotti annonce
`"Jour férié du samedi 15 août : ouverture exceptionnelle de la Piscine Olympique Angelotti
(seule piscine du réseau ouverte)"` ([schedules.json:42](public/data/schedules.json#L42)).
Cette phrase implique la fermeture des 14 autres piscines, mais elle est enregistrée comme un
`event` d'Angelotti uniquement. Les autres piscines retombent sur leur horaire hebdomadaire
d'été et le site les affiche **ouvertes le 15 août** — un faux positif qui envoie les gens
devant une porte fermée.

Le cas est général : une page peut parler du réseau entier (« toutes les piscines seront
fermées le 1er mai ») ou nommer d'autres équipements. Objectif : capter ces affirmations à
l'extraction, puis les appliquer de façon déterministe aux piscines concernées.

**Décisions prises** : les fermetures déduites sont traitées **comme n'importe quelle
fermeture** côté affichage (aucune distinction visuelle, aucun changement frontend) ; la
détection se fait via un champ `networkClaims` ajouté au tool d'extraction, **sans appel API
supplémentaire**.

## Approche

Deux passes, la seconde purement déterministe :

```
pass 1 — 15 appels LLM (inchangés en nombre)
  chaque page → periods, events, periodOverrides, notes, networkClaims  ← nouveau

pass 2 — TypeScript pur, aucun appel
  networkClaims × POOLS → events injectés dans les piscines cibles
  puis resolveDays() comme aujourd'hui
```

`resolveDays()` n'a pas besoin d'être modifié : un event `closed: true` injecté produit déjà
`closed`, `slots: []` et la description dans `resolved[].events`. `ClosuresBanner`,
`PoolPage` et `seo.ts` le reprennent automatiquement.

---

## 1. Types — [src/types.ts](src/types.ts)

Nouveau type, à placer près de `PeriodOverride` (l. 59-67) :

```ts
/**
 * Une affirmation trouvée sur la page d'UNE piscine, mais qui concerne
 * D'AUTRES piscines ou le réseau entier.
 */
export interface NetworkClaim {
  start: string;        // "YYYY-MM-DD"
  end: string | null;   // inclusif, null = un seul jour
  scope: "all_pools" | "all_other_pools" | "named_pools";
  /** Noms tels qu'écrits sur la page ; utile seulement si scope === "named_pools". */
  pools: string[];
  closed: boolean;
  /** En français, rédigé du point de vue des piscines CONCERNÉES. */
  description: string;
}
```

- `PoolSchedule` (l. 70-77) : ajouter `networkClaims: NetworkClaim[]`.
- `DatedEvent` (l. 49-57) : ajouter un champ **optionnel** de traçabilité, non affiché —
  utile pour le débogage et la déduplication :
  ```ts
  /** Renseigné quand l'event vient de l'annonce d'une autre piscine. */
  inferredFrom?: { poolId: string; poolName: string; url: string };
  ```

## 2. Extraction — [scripts/scrape.ts](scripts/scrape.ts)

**`EXTRACTION_TOOL`** (l. 56-124) : ajouter la propriété `networkClaims` (et à `required`),
sur le modèle de `events` :

```ts
networkClaims: {
  type: "array",
  description:
    "Statements on THIS page about OTHER pools or the whole municipal network. Empty if none.",
  items: {
    type: "object",
    properties: {
      start: { type: "string", description: '"YYYY-MM-DD"' },
      end: { type: ["string", "null"], description: '"YYYY-MM-DD" inclusive, or null' },
      scope: { type: "string", enum: ["all_pools", "all_other_pools", "named_pools"] },
      pools: {
        type: "array",
        items: { type: "string" },
        description: 'Pool names exactly as written on the page. Empty unless scope is "named_pools".',
      },
      closed: { type: "boolean" },
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
```

**`SYSTEM_PROMPT`** (l. 149-160) : ajouter, après la ligne sur `events` (l. 154-155) :

```
- "events" only ever describes THIS pool. If the page states something about OTHER pools or
  about the whole municipal network — e.g. "seule piscine du réseau ouverte", "toutes les
  piscines municipales seront fermées le 1er mai", "la piscine Pitot est fermée pour travaux"
  — record it in "networkClaims" instead (in addition to this pool's own event, when the
  sentence also says something about this pool).
- Choose the scope: "all_other_pools" when the sentence implies every pool except this one
  (that is what "seule piscine ouverte" means), "all_pools" when it covers the whole network
  including this one, "named_pools" when specific pools are named — then list them in "pools"
  exactly as written.
- Write the networkClaim "description" for the pools it applies to. From "ouverture
  exceptionnelle de la Piscine X (seule piscine du réseau ouverte)", write something like
  "Fermeture le 15 août (jour férié) — seule la Piscine X est ouverte", not the original
  sentence.
- Only record a networkClaim when the page really says it. Never generalise this pool's own
  closure to the others.
```

**`emptySchedule()`** (l. 168-177) : ajouter `networkClaims: []`.

## 3. Résolution des noms de piscine — [scripts/pools.ts](scripts/pools.ts)

Nécessaire uniquement pour `scope: "named_pools"`. Deux fonctions exportées :

```ts
/** "Piscine Olympique Angelotti" -> "angelotti" ; "Centre aquatique Neptune" -> "neptune" */
export function normalizePoolName(s: string): string
/** Match unique dans POOLS, sinon null. */
export function matchPool(name: string): PoolConfig | null
```

`normalizePoolName` : `NFD` + suppression des diacritiques, minuscules, retrait des mots
génériques (`piscine`, `centre`, `aquatique`, `nautique`, `complexe`, `olympique`, `de`, `du`,
`des`, `la`, `le`, `les`, `et`, `d`), on ne garde que `[a-z0-9]`.

`matchPool` : égalité normalisée exacte, à défaut inclusion de sous-chaîne dans un sens ou
l'autre. **Un match ambigu (plusieurs candidats) renvoie `null`** — ne jamais deviner. Les
noms non résolus sont `console.warn`és avec le nom brut.

Vérifier que les 15 noms de `POOLS` donnent des formes normalisées deux à deux distinctes
(`jeanvives` / `jeantaris` / `alexjany` / `alfrednakache`… le sont).

## 4. Réconciliation — nouvelle fonction dans [scripts/scrape.ts](scripts/scrape.ts)

À insérer entre `extractPool` et `resolveDays`, appelée depuis `main()` **après** la boucle
d'extraction et **avant** `resolveDays` (ce qui impose de scinder la boucle actuelle
l. 336-345 : extraire d'abord les 15 `Omit<PoolResult, "resolved">`, réconcilier, puis mapper
`resolveDays`).

```ts
/** Applique les annonces « réseau » d'une piscine aux piscines qu'elles concernent. */
function applyNetworkClaims(pools: Omit<PoolResult, "resolved">[]): void
```

Algorithme :

1. Ne considérer que les sources `status === "ok"`, dans l'ordre de `POOLS` (déterministe).
   Lire `source.networkClaims ?? []` (tolère un JSON sans le champ).
2. Résoudre les cibles : `all_pools` → toutes ; `all_other_pools` → toutes sauf la source ;
   `named_pools` → `matchPool()` sur chaque entrée, en journalisant les échecs.
3. **Ignorer la source elle-même comme cible** : sa propre page fait autorité pour elle et a
   déjà produit ses `events`.
4. **Priorité au premier parti** : si la cible a déjà un `event` (non déduit) dont l'intervalle
   recoupe celui du claim, ne rien injecter. C'est la règle qui empêche de fermer une piscine
   qui a annoncé elle-même ses horaires du 15 août.
5. Sinon, pousser dans `target.events` :
   ```ts
   {
     start: claim.start,
     end: claim.end,
     description: claim.description,
     closed: claim.closed,
     slots: null,
     inferredFrom: { poolId: source.id, poolName: source.name, url: source.url },
   }
   ```
6. **Déduplication** : deux sources annonçant la même chose (même `start`/`end`/`closed`) pour
   la même cible → une seule injection, la première dans l'ordre `POOLS`.
7. **Contradiction** : deux claims recouvrant la même cible et le même intervalle avec des
   `closed` opposés → n'injecter **ni l'un ni l'autre** et `console.warn`. Mieux vaut
   l'horaire habituel qu'un arbitrage arbitraire.
8. Journaliser le bilan : `↳ N fermeture(s) déduite(s) depuis M annonce(s) réseau`.

Aucun changement dans `resolveDays`, `src/App.tsx`, `scripts/seo.ts` ou `scripts/prerender.ts`.

## 5. Outillage de test — [scripts/scrape.ts](scripts/scrape.ts), mode dry-run

Le dry-run actuel (l. 315-333) ne teste qu'une URL isolée, donc jamais la passe 2. Deux
ajouts :

- Dans le dry-run URL existant : afficher explicitement les `networkClaims` extraits, pour
  valider la passe 1 sur Angelotti en **un seul appel API**.
- Nouveau flag `npm run scrape -- --replay [chemin.json]` : lit un `schedules.json` existant,
  rejoue `applyNetworkClaims` + `resolveDays`, imprime le bilan et les jours dont le
  `closed` a changé, **sans écrire ni appeler l'API**. Testé sur une fixture où l'on colle à
  la main le `networkClaims` d'Angelotti, il couvre toute la passe 2 hors ligne (y compris
  les règles 4, 6 et 7).

---

## Vérification

1. `npx tsc --noEmit` — le projet n'a pas de suite de tests ; le typage est le premier filet.
2. **Passe 2 hors ligne, coût nul** : copier `public/data/schedules.json`, y ajouter à la main
   sur Angelotti
   ```json
   "networkClaims": [{ "start": "2026-08-15", "end": null, "scope": "all_other_pools",
     "pools": [], "closed": true,
     "description": "Fermeture le 15 août (jour férié) — seule la Piscine Olympique Angelotti est ouverte" }]
   ```
   puis `npm run scrape -- --replay /tmp/fixture.json`. Attendu : les 14 autres piscines
   passent à `closed: true` le 2026-08-15, Angelotti garde ses créneaux 09:00-13:15 /
   15:00-19:15, et toute piscine ayant son propre event du 15 août est laissée intacte
   (règle 4). Tester aussi une fixture avec deux claims contradictoires.
3. **Passe 1, un appel** : `npm run scrape -- https://www.montpellier.fr/territoire/lieux-equipements/piscine-olympique-angelotti`
   et vérifier que `networkClaims` contient bien le claim `all_other_pools` du 15 août, et que
   sa `description` est rédigée du point de vue des piscines fermées.
4. **Bout en bout** : `npm run scrape` (15 appels) puis `npm run build`, et contrôler dans
   `dist/` que le bandeau « Fermetures / événements » liste les fermetures déduites et que les
   pages piscine concernées affichent « Fermé » le 15 août.

## Hors périmètre

- Pas de liste codée en dur des jours fériés : le système reste piloté par ce que disent les
  pages. Si aucune page ne mentionne un férié, rien n'est déduit — c'est un manque connu,
  distinct de celui traité ici.
- Note annexe : le `schedules.json` commité est antérieur à `ef205da` (« fix pool names ») et
  contient encore `olympique-antigone` ; le prochain scrape changera l'URL de cette page
  piscine. Sans lien avec ce plan, mais à savoir avant de déployer.
