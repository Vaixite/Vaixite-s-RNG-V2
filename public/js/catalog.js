// ---------------------------------------------------------------------------
// CLIENT CATALOG
//
// The server is the source of truth for every tunable (content/*.json on the
// host machine). main.js fetches /api/catalog once at boot and fills this
// singleton; every other client module reads from here instead of importing
// hardcoded data. That is what makes the game fully data-driven in the browser
// too — edit a JSON on the server, reload, and the client follows.
// ---------------------------------------------------------------------------

export const catalog = {
  auras: [],
  auraById: {},
  biomes: [],
  biomeById: {},
  rotateMs: 90000,
  btMultiplier: 12,
  upgrades: [],
  upgradeById: {},
  ascend: { requirementBase: 25, requirementGrowth: 6, luckPerAscension: 0.75 },
  rarityTiers: [],
  tierIndexById: {},
  cutsceneTierIndex: 3,
  items: [],
  itemById: {},
  recipes: [],
  sell: { coefficient: 10, exponent: 2.5, min: 1 },
  config: {},
};

export function setCatalog(c) {
  Object.assign(catalog, c);
  catalog.auraById = Object.fromEntries(catalog.auras.map((a) => [a.id, a]));
  catalog.biomeById = Object.fromEntries(catalog.biomes.map((b) => [b.id, b]));
  catalog.upgradeById = Object.fromEntries(catalog.upgrades.map((u) => [u.id, u]));
  catalog.itemById = Object.fromEntries(catalog.items.map((i) => [i.id, i]));
  catalog.tierIndexById = Object.fromEntries(catalog.rarityTiers.map((t, i) => [t.id, i]));
  return catalog;
}

export const getBiome = (id) => catalog.biomeById[id] || catalog.biomes[0];
export const getAura = (id) => catalog.auraById[id];
export const getItem = (id) => catalog.itemById[id];

export function upgradeCost(def, level) {
  return Math.floor(def.baseCost * Math.pow(def.growth, level));
}

export function sellPrice(odds) {
  const s = catalog.sell;
  const raw = (s.coefficient ?? 10) * Math.pow(Math.log10(1 + Math.max(1, odds)), s.exponent ?? 2.5);
  return Math.max(s.min ?? 1, Math.round(raw));
}

export function ascendRequirement(ascensions) {
  const a = catalog.ascend;
  return Math.floor(a.requirementBase * Math.pow(a.requirementGrowth, ascensions));
}
