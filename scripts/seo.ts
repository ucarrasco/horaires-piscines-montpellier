// Per-page <head> content: meta tags and schema.org structured data.
// Build-time only — the strings are injected into the prerendered HTML.

import {
  DAY_KEYS,
  PERIOD_KEYS,
  type DayKey,
  type PoolResult,
  type SchedulesData,
} from "../src/types.ts";
import { ABOUT_PATH, poolPath } from "../src/paths.ts";
import { SITE_NAME, SITE_URL, absoluteUrl } from "./site.ts";

/** schema.org day names, in the same order as DAY_KEYS. */
const SCHEMA_DAYS: Record<DayKey, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON embedded in a <script> must not be able to close the tag early. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function metaTags(opts: {
  title: string;
  description: string;
  canonical: string;
}): string {
  const { title, description, canonical } = opts;
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:locale" content="fr_FR" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join("\n    ");
}

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${safeJson(value)}</script>`;
}

/**
 * Opening hours of a pool, merged across the three weekly schedules: schema.org
 * has no notion of school terms, so the union is the honest approximation of
 * "when is this pool usually open".
 */
function openingHours(pool: PoolResult) {
  const seen = new Set<string>();
  const specs: unknown[] = [];

  for (const period of PERIOD_KEYS) {
    for (const day of DAY_KEYS) {
      for (const slot of pool.periods[period][day]) {
        const key = `${day}-${slot.start}-${slot.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        specs.push({
          "@type": "OpeningHoursSpecification",
          dayOfWeek: `https://schema.org/${SCHEMA_DAYS[day]}`,
          opens: slot.start,
          closes: slot.end,
        });
      }
    }
  }
  return specs;
}

/** Dated closures and exceptional hours, as schema.org special opening hours. */
function specialOpeningHours(pool: PoolResult, today: string) {
  return pool.events
    .filter((e) => (e.end ?? e.start) >= today)
    .map((e) => ({
      "@type": "OpeningHoursSpecification",
      validFrom: e.start,
      validThrough: e.end ?? e.start,
      description: e.description,
      ...(e.closed
        ? { opens: "00:00", closes: "00:00" }
        : e.slots && e.slots.length > 0
          ? { opens: e.slots[0].start, closes: e.slots[e.slots.length - 1].end }
          : {}),
    }));
}

export function homeHead(data: SchedulesData): string {
  const canonical = absoluteUrl("");
  const title = `Horaires des piscines de Montpellier — mis à jour chaque jour`;
  const description = `Les horaires d'ouverture au public des ${data.pools.length} piscines de Montpellier, réunis sur une seule page et mis à jour automatiquement depuis les pages officielles.`;

  return [
    metaTags({ title, description, canonical }),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: canonical,
      inLanguage: "fr-FR",
    }),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Piscines de Montpellier",
      itemListElement: data.pools.map((pool, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: pool.name,
        url: absoluteUrl(poolPath(pool.id)),
      })),
    }),
  ].join("\n    ");
}

export function aboutHead(): string {
  const canonical = absoluteUrl(ABOUT_PATH);
  const title = `À propos — ${SITE_NAME}`;
  const description = `Comment ce site relève les horaires des piscines de Montpellier : lecture par IA des pages officielles, prise en compte des messages d'information du moment et recalcul des horaires réels jour par jour.`;

  return [
    metaTags({ title, description, canonical }),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "AboutPage",
      name: title,
      description,
      url: canonical,
      inLanguage: "fr-FR",
      isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${SITE_URL}/` },
    }),
  ].join("\n    ");
}

export function poolHead(pool: PoolResult, today: string): string {
  const canonical = absoluteUrl(poolPath(pool.id));
  const title = `${pool.name} — horaires d'ouverture`;
  const description = `Horaires d'ouverture au public de la ${pool.name} à Montpellier : créneaux de la semaine, vacances scolaires et fermetures exceptionnelles, mis à jour chaque jour.`;

  return [
    metaTags({ title, description, canonical }),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "PublicSwimmingPool",
      name: pool.name,
      url: canonical,
      ...(pool.url ? { sameAs: pool.url } : {}),
      address: {
        "@type": "PostalAddress",
        addressLocality: "Montpellier",
        addressCountry: "FR",
      },
      openingHoursSpecification: openingHours(pool),
      specialOpeningHoursSpecification: specialOpeningHours(pool, today),
    }),
    jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: SITE_NAME,
          item: `${SITE_URL}/`,
        },
        { "@type": "ListItem", position: 2, name: pool.name, item: canonical },
      ],
    }),
  ].join("\n    ");
}
