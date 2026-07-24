import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" -> chemins relatifs, fonctionne aussi bien en local que sur
// GitHub Pages (site servi sous /<nom-du-repo>/).
export default defineConfig({
  base: "./",
  plugins: [react()],
});
