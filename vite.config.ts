import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" -> relative paths, which work both locally and on GitHub Pages
// (where the site is served under /<repo-name>/).
export default defineConfig({
  base: "./",
  plugins: [react()],
});
