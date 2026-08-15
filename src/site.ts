// Browser-side URL helpers. The absolute site URL only matters at build time
// (canonical tags, sitemap), so it lives in scripts/site.ts; here we only need
// the base path Vite was built with.

import { ABOUT_PATH, type Route } from "./paths.ts";

export const BASE_PATH = import.meta.env.BASE_URL;

export const GITHUB_URL =
  "https://github.com/ucarrasco/horaires-piscines-montpellier";

export const AUTHOR_URL = "https://x.com/nien_ugo";

/** Href usable in a link, from a route path such as "" or "piscine-neptune/". */
export function href(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** Route matching a browser pathname; unknown paths fall back to the home page. */
export function routeFromPathname(pathname: string): Route {
  const path = pathname.startsWith(BASE_PATH)
    ? pathname.slice(BASE_PATH.length)
    : pathname.replace(/^\//, "");
  const trimmed = path.replace(/\/$/, "");
  if (trimmed === ABOUT_PATH.replace(/\/$/, "")) return { kind: "about" };
  const match = trimmed.match(/^piscine-(.+)$/);
  return match ? { kind: "pool", id: match[1] } : { kind: "home" };
}
