// Build-time site configuration, shared by vite.config.ts and the prerenderer.
//
// Set SITE_URL when moving to a custom domain (a repository variable in CI):
// Vite's base, the canonical URLs, the sitemap and the CNAME file all derive
// from it.

const DEFAULT_SITE_URL =
  "https://ucarrasco.github.io/horaires-piscines-montpellier";

export const SITE_URL = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(
  /\/+$/,
  "",
);

export const SITE_NAME = "Piscines de Montpellier";

/** Vite `base`: the path part of SITE_URL, with leading and trailing slash. */
export const BASE_PATH = `${new URL(SITE_URL).pathname.replace(/\/+$/, "")}/`;

/** True when the site is served from a custom domain, which needs a CNAME file. */
export const HAS_CUSTOM_DOMAIN = !new URL(SITE_URL).hostname.endsWith(
  "github.io",
);

/** Absolute URL of a route path such as "" or "piscine-neptune/". */
export function absoluteUrl(path: string): string {
  return new URL(`${BASE_PATH}${path}`, SITE_URL).toString();
}
