import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { BASE_PATH } from "./scripts/site.ts";

// The base is derived from SITE_URL: pages live in sub-directories
// (/piscine-neptune/), so relative asset paths would not resolve.
export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
});
