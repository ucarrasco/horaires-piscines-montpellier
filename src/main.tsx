import { StrictMode, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App.tsx";
import { routeFromPathname } from "./site.ts";
import type { SchedulesData } from "./types.ts";
import "./styles.css";

// Design exploration scaffolding — TEMPORARY. All five skins ship together so
// the switcher can swap them without a reload; the chosen one will be folded
// into styles.css and these imports deleted.
import "./themes/switcher.css";
import "./themes/tidal.css";
import "./themes/swiss.css";
import "./themes/gazette.css";
import "./themes/blockparty.css";
import "./themes/carrelage.css";

const container = document.getElementById("root")!;
const inlined = document.getElementById("schedules-data")?.textContent;

function tree(data: SchedulesData): ReactNode {
  return (
    <StrictMode>
      <App data={data} route={routeFromPathname(location.pathname)} />
    </StrictMode>
  );
}

if (inlined) {
  // Prerendered page: the markup is already there, just attach to it.
  hydrateRoot(container, tree(JSON.parse(inlined) as SchedulesData));
} else {
  // Dev server: no prerender step, so fetch the data first.
  fetch(`${import.meta.env.BASE_URL}data/schedules.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<SchedulesData>;
    })
    .then((data) => createRoot(container).render(tree(data)))
    .catch((e) => {
      container.textContent = `Impossible de charger les horaires : ${e}`;
    });
}
