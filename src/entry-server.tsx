import { renderToString } from "react-dom/server";

import App from "./App.tsx";
import type { Route } from "./paths.ts";
import type { SchedulesData } from "./types.ts";

/** Renders one route to HTML. Used by scripts/prerender.ts at build time. */
export function render(route: Route, data: SchedulesData): string {
  return renderToString(<App data={data} route={route} />);
}
