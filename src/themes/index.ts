// Design exploration scaffolding — TEMPORARY.
//
// Five alternative skins for the site, each a self-contained stylesheet scoped
// under [data-theme="<id>"]. They all ship in the bundle so the switcher can
// swap between them instantly, which is only acceptable while we are choosing:
// once a design is picked, its rules move into styles.css and this whole
// directory (plus ThemeSwitcher in App.tsx) goes away.

export interface ThemeDef {
  id: string;
  name: string;
  blurb: string;
}

export const THEME_KEY = "designTheme";

export const THEMES: ThemeDef[] = [
  { id: "tidal", name: "Tidal", blurb: "Aquatique profond" },
  { id: "swiss", name: "Swiss", blurb: "Produit net" },
  { id: "gazette", name: "Gazette", blurb: "Éditorial chaleureux" },
  { id: "blockparty", name: "Block Party", blurb: "Néo-brutaliste" },
  { id: "carrelage", name: "Carrelage", blurb: "Rétro municipal" },
];
