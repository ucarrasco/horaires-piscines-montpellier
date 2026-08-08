// Liste des piscines à scraper.
//
// ⚠️ À COMPLÉTER : remplis `url` avec la page officielle de chaque piscine
// (celle qui affiche les horaires). Tu peux ajouter/supprimer des entrées.
// `id` doit être unique et stable (sert de clé). `name` est le nom affiché.

export interface PoolConfig {
  id: string;
  name: string;
  url: string;
}

export const POOLS: PoolConfig[] = [
  // Exemples (noms de piscines de Montpellier — VÉRIFIE / COMPLÈTE les URLs) :
  {
    id: "olympique-antigone",
    name: "Piscine Olympique d'Antigone",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-olympique-angelotti", // TODO: URL de la page horaires
  },
  {
    id: "neptune",
    name: "Piscine Neptune",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/centre-aquatique-neptune", // TODO
  },
];
