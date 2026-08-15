// Turns the client build into a set of static pages: one per route, each with
// its markup, its <head> and the schedules inlined so the browser hydrates
// without a second round trip.
//
// Runs after `vite build` (client) and `vite build --ssr` (server bundle).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { allRoutes, routePath, type Route } from "../src/paths.ts";
import type { SchedulesData } from "../src/types.ts";
import { aboutHead, homeHead, poolHead, safeJson } from "./seo.ts";
import { HAS_CUSTOM_DOMAIN, SITE_URL, absoluteUrl } from "./site.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SSR_ENTRY = join(ROOT, "dist-ssr", "entry-server.js");
const DATA_PATH = join(ROOT, "public", "data", "schedules.json");

type Renderer = (route: Route, data: SchedulesData) => string;

function headFor(route: Route, data: SchedulesData, today: string): string {
  if (route.kind === "home") return homeHead(data);
  if (route.kind === "about") return aboutHead();
  const pool = data.pools.find((p) => p.id === route.id)!;
  return poolHead(pool, today);
}

/**
 * Data inlined in a page: a pool page only ever reads its own pool, so shipping
 * the other fifteen would multiply the page weight for nothing. The server
 * renders from this same object, which is what keeps hydration consistent.
 */
function dataFor(route: Route, data: SchedulesData): SchedulesData {
  if (route.kind === "home") return data;
  // The about page reads no schedules at all.
  if (route.kind === "about") return { ...data, pools: [] };
  return { ...data, pools: data.pools.filter((p) => p.id === route.id) };
}

function buildPage(opts: {
  template: string;
  head: string;
  body: string;
  data: SchedulesData;
}): string {
  const inlined = `<script type="application/json" id="schedules-data">${safeJson(
    opts.data,
  )}</script>`;

  return opts.template
    // The template keeps a title and description for the dev server; each page
    // brings its own, so drop the defaults rather than emit them twice.
    .replace(/\s*<title>[\s\S]*?<\/title>/, "")
    .replace(/\s*<meta\s+name="description"[\s\S]*?\/>/, "")
    .replace("<!--head-->", opts.head)
    .replace("<!--app-->", opts.body)
    .replace("</body>", `  ${inlined}\n  </body>`);
}

function sitemap(data: SchedulesData): string {
  const lastmod = data.generatedAt.slice(0, 10);
  const urls = allRoutes(data)
    .map(
      (route) =>
        `  <url><loc>${absoluteUrl(routePath(route))}</loc><lastmod>${lastmod}</lastmod></url>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

async function main() {
  const [template, rawData, { render }] = await Promise.all([
    readFile(join(DIST, "index.html"), "utf8"),
    readFile(DATA_PATH, "utf8"),
    import(pathToFileURL(SSR_ENTRY).href) as Promise<{ render: Renderer }>,
  ]);

  const data = JSON.parse(rawData) as SchedulesData;
  // The prerendered HTML is dated: it says "today" as of the build, which the
  // daily job keeps fresh. The client corrects it on mount.
  const today = data.generatedAt.slice(0, 10);

  const routes = allRoutes(data);
  for (const route of routes) {
    const path = routePath(route);
    const pageData = dataFor(route, data);
    const page = buildPage({
      template,
      head: headFor(route, data, today),
      body: render(route, pageData),
      data: pageData,
    });

    const outPath = join(DIST, path, "index.html");
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, page, "utf8");
  }

  await writeFile(join(DIST, "sitemap.xml"), sitemap(data), "utf8");
  await writeFile(
    join(DIST, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl("sitemap.xml")}\n`,
    "utf8",
  );
  if (HAS_CUSTOM_DOMAIN) {
    await writeFile(
      join(DIST, "CNAME"),
      `${new URL(SITE_URL).hostname}\n`,
      "utf8",
    );
  }

  console.log(
    `Prerendered ${routes.length} page(s) for ${SITE_URL} (+ sitemap, robots${
      HAS_CUSTOM_DOMAIN ? ", CNAME" : ""
    })`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
