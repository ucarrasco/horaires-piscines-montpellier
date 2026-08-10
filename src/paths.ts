// Routes and their paths. Kept free of any Vite/browser API so that the
// build-time scripts (which run under tsx, without import.meta.env) can use it.

import type { SchedulesData } from "./types.ts";

export type Route = { kind: "home" } | { kind: "pool"; id: string };

/** Path of a pool page, relative to the base and without leading slash. */
export function poolPath(id: string): string {
  return `piscine-${id}/`;
}

/** Path of a route, relative to the base: "" or "piscine-neptune/". */
export function routePath(route: Route): string {
  return route.kind === "home" ? "" : poolPath(route.id);
}

/** Every route the site prerenders, in sitemap order. */
export function allRoutes(data: SchedulesData): Route[] {
  return [
    { kind: "home" },
    ...data.pools.map((p): Route => ({ kind: "pool", id: p.id })),
  ];
}
