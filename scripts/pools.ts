export interface PoolConfig {
  id: string;
  name: string;
  url: string;
}

export const POOLS: PoolConfig[] = [
  {
    id: "olympique-angelotti",
    name: "Piscine Olympique Angelotti",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-olympique-angelotti",
  },
  {
    id: "neptune",
    name: "Centre aquatique Neptune",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/centre-aquatique-neptune",
  },
  {
    id: "poseidon",
    name: "Piscine Poséidon",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-poseidon",
  },

  {
    id: "heracles",
    name: "Piscine Héraclès",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-heracles",
  },

  {
    id: "suzanne-berlioux",
    name: "Piscine Suzanne Berlioux",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-suzanne-berlioux",
  },

  {
    id: "pitot",
    name: "Piscine Pitot",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-pitot",
  },

  {
    id: "marcel-spilliaert",
    name: "Piscine Marcel Spilliaert",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-marcel-spilliaert",
  },

  {
    id: "les-nereides",
    name: "Piscine Les Néréides",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-les-nereides",
  },

  {
    id: "jean-vives",
    name: "Piscine Jean Vivès",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-jean-vives",
  },

  {
    id: "jean-taris",
    name: "Piscine Jean Taris",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-jean-taris",
  },

  {
    id: "christine-caron",
    name: "Piscine Christine Caron",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-christine-caron",
  },

  {
    id: "amphitrite",
    name: "Piscine Amphitrite",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-amphitrite",
  },

  {
    id: "alfred-nakache",
    name: "Piscine Alfred Nakache",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-alfred-nakache",
  },

  {
    id: "alex-jany",
    name: "Piscine Alex Jany",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-alex-jany",
  },

  {
    id: "francoise-et-yves-jarrousse",
    name: "Piscine Françoise et Yves Jarrousse",
    url: "https://www.montpellier.fr/territoire/lieux-equipements/piscine-francoise-et-yves-jarrousse",
  },
];

// --- Matching a pool name written in free text ----------------------------
// Used to resolve the pool names quoted in a NetworkClaim (a sentence on one
// pool's page naming other pools) back to entries of POOLS.

/** Words that carry no identity: every pool is a "piscine" of some kind. */
const GENERIC_WORDS = new Set([
  "piscine",
  "piscines",
  "centre",
  "aquatique",
  "nautique",
  "complexe",
  "olympique",
  "municipale",
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "et",
  "d",
  "l",
]);

/** "Piscine Olympique Angelotti" -> "angelotti", "Centre aquatique Neptune" -> "neptune". */
export function normalizePoolName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !GENERIC_WORDS.has(w))
    .join("");
}

const NORMALIZED = POOLS.map((p) => ({ pool: p, key: normalizePoolName(p.name) }));

/**
 * Resolves a pool name written in free text to a POOLS entry.
 * Returns null when nothing matches, or when the match is ambiguous — we never
 * guess, since a wrong match would close the wrong pool.
 */
export function matchPool(name: string): PoolConfig | null {
  const key = normalizePoolName(name);
  if (!key) return null;

  const exact = NORMALIZED.filter((c) => c.key === key);
  if (exact.length === 1) return exact[0].pool;
  if (exact.length > 1) return null;

  const partial = NORMALIZED.filter(
    (c) => c.key.includes(key) || key.includes(c.key),
  );
  return partial.length === 1 ? partial[0].pool : null;
}
