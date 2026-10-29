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
  // Craft-only auras (authored under "crafted" in auras.json) and the union the
  // lookup maps are built from. `auras` stays the roll pool — the roulette, the
  // odds mirror and every "what can drop" question read that one.
  specialAuras: [],
  allAuras: [],
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
  // Equipment definitions, straight from content/crafting.json.
  gear: [],
  gearById: {},
  gearSlots: [],
  gearSlotById: {},
  gearQualities: [],
  gearQualityById: {},
  gearBuffTypes: {},
  gearSalvage: { base: 250 },
  // Ascend tree + mining shaft, straight from content/ascendTree.json and
  // content/mining.json. The client draws both entirely from these.
  tree: [],
  treeById: {},
  treeEffectTypes: {},
  mining: {},
  miningOres: [],
  oreById: {},
  // The Spark Clicker minigame, from content/clicker.json — currency, pacing
  // and the whole upgrade shop. The client draws the shop from these alone.
  clicker: {},
  clickerUpgrades: [],
  clickerById: {},
  clickerEffectTypes: {},
  // Achievements, from content/achievements.json: the definitions and the
  // tiers. What a given player has measured towards each one is not here —
  // that is per account, and comes from GET /api/achievements.
  achievements: [],
  achievementById: {},
  achievementTiers: [],
  achievementTierById: {},
  achievementPointsTotal: 0,
  config: {},
};

export function setCatalog(c) {
  Object.assign(catalog, c);
  // The lookup covers every aura the game can hand you — rolled or crafted — so
  // a craft result, a feed row and an inventory slot all resolve the same way.
  const all = catalog.allAuras && catalog.allAuras.length ? catalog.allAuras : catalog.auras;
  catalog.auraById = Object.fromEntries(all.map((a) => [a.id, a]));
  catalog.biomeById = Object.fromEntries(catalog.biomes.map((b) => [b.id, b]));
  catalog.upgradeById = Object.fromEntries(catalog.upgrades.map((u) => [u.id, u]));
  catalog.itemById = Object.fromEntries(catalog.items.map((i) => [i.id, i]));
  catalog.tierIndexById = Object.fromEntries(catalog.rarityTiers.map((t, i) => [t.id, i]));
  catalog.gearById = Object.fromEntries(catalog.gear.map((g) => [g.id, g]));
  catalog.gearSlotById = Object.fromEntries(catalog.gearSlots.map((s) => [s.id, s]));
  catalog.gearQualityById = Object.fromEntries(catalog.gearQualities.map((q) => [q.id, q]));
  catalog.treeById = Object.fromEntries((catalog.tree || []).map((n) => [n.id, n]));
  catalog.oreById = Object.fromEntries((catalog.miningOres || []).map((o) => [o.id, o]));
  catalog.clickerById = Object.fromEntries((catalog.clickerUpgrades || []).map((u) => [u.id, u]));
  catalog.achievementById = Object.fromEntries((catalog.achievements || []).map((a) => [a.id, a]));
  catalog.achievementTierById = Object.fromEntries((catalog.achievementTiers || []).map((t) => [t.id, t]));
  return catalog;
}

export const getBiome = (id) => catalog.biomeById[id] || catalog.biomes[0];
export const getAura = (id) => catalog.auraById[id];

// --- deleted auras -------------------------------------------------------------
// A host editing auras.json can delete an id a player already owns. The server
// stamps every inventory slot with a copy of the aura it holds, so the card can
// still be drawn after the definition is gone — and the aura is filed under
// Special Auras instead of vanishing.
//
// Nothing here re-fetches or guesses: an id the catalog does not know and no slot
// describes is simply not renderable, and resolveAura says so with null.

/** Rebuild an aura-shaped record from the memory an inventory slot carries. */
export function deletedAura(id, slot) {
  return {
    id,
    name: slot?.name || id,
    color: slot?.color || '#8b95ad',
    fx: slot?.fx || 'soft',
    odds: Number(slot?.odds) || 1,
    tier: slot?.tier || 'deleted',
    tierName: slot?.tierName || 'Removed',
    tierColor: slot?.tierColor || '#8b95ad',
    native: false,
    biome: null,
    craftOnly: true,
    deleted: true,
  };
}

/** Any aura id → something renderable: the live definition, else the slot's memory. */
export function resolveAura(id, slot) {
  return catalog.auraById[id] || (slot ? deletedAura(id, slot) : null);
}

/** The Special Auras shelf: craft-only auras + owned ids the host deleted. */
export function specialShelf(inventory = {}) {
  const shelf = [...(catalog.specialAuras || [])];
  const seen = new Set(shelf.map((a) => a.id));
  for (const [id, slot] of Object.entries(inventory)) {
    if (!slot || seen.has(id) || catalog.auraById[id]) continue;
    seen.add(id);
    shelf.push(deletedAura(id, slot));
  }
  return shelf.sort((a, b) => b.odds - a.odds);
}

export const getItem = (id) => catalog.itemById[id];
export const getGear = (id) => catalog.gearById[id];
export const getSlot = (id) => catalog.gearSlotById[id];
export const getQuality = (id) => catalog.gearQualityById[id];

// Same wording the server uses on the profile's gear list, so a recipe card and
// an owned gear card never describe the same axis in two different ways.
export function buffLabel(type, value) {
  const t = catalog.gearBuffTypes[type] || { name: type, icon: '✦' };
  if (t.kind === 'flat') return `+${value} ${t.name}`;
  return `+${Math.round(value * 1000) / 10}% ${t.name}`;
}

// The advertised band on a recipe card: "Luck +6–30%".
export function buffRangeLabel(type, min, max) {
  const t = catalog.gearBuffTypes[type] || { name: type };
  if (t.kind === 'flat') return `${t.name} +${min}–${max}`;
  return `${t.name} +${Math.round(min * 1000) / 10}–${Math.round(max * 1000) / 10}%`;
}

export function buffIcon(type) {
  return (catalog.gearBuffTypes[type] || {}).icon || '✦';
}

// "Worn 30% · Fine 48% · Radiant 18% · Mythic 4%" for a gear recipe.
export function qualityChances(qualities) {
  const entries = Object.entries(qualities || {});
  const total = entries.reduce((s, [, w]) => s + (Number(w) || 0), 0);
  if (!total) return [];
  return entries
    .map(([id, w]) => ({ id, pct: (Number(w) / total) * 100, quality: catalog.gearQualityById[id] }))
    .sort((a, b) => b.pct - a.pct);
}

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

// --- ascend tree -------------------------------------------------------------
// Mirrors treeCost() in src/game.js exactly, so the price a node advertises is
// always the price the server charges.
export function treeCost(node, level) {
  const growth = Number(node.costGrowth) || 1;
  return Math.max(1, Math.round((Number(node.cost) || 1) * Math.pow(growth, level)));
}

// Feature ids an `unlock` node can hand out, phrased the way the UI names them.
const UNLOCK_LABEL = { mining: 'Mining Shaft', clicker: 'Arcade Cabinet' };

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * What a node gives, worded from catalog.treeEffectTypes:
 *   pct  → "+12% Luck"      flat → "+1 Auras / Roll"     none → "Unlocks Mining Shaft"
 *
 * `level` defaults to 1 so the same helper writes both the per-level line and
 * the "currently +36%" line the tooltip shows.
 */
export function treeEffectLabel(node, level = 1) {
  const eff = node.effect || {};
  const t = catalog.treeEffectTypes[eff.type] || { name: eff.type || 'Bonus', fmt: 'none' };
  const per = Number(eff.perLevel) || 0;
  const lv = Number(level) || 0;
  let main;
  if (t.fmt === 'pct') main = `+${round1(per * lv * 100)}% ${t.name}`;
  else if (t.fmt === 'flat') main = `+${round1(per * lv)} ${t.name}`;
  else if (eff.unlock) main = `Unlocks ${UNLOCK_LABEL[eff.unlock] || String(eff.unlock).replace(/_/g, ' ')}`;
  else main = t.name;
  // Some nodes carry a secondary cooldown crush on top of their main effect.
  if (eff.bonusCooldownMult) main += ` · −${round1(eff.bonusCooldownMult * lv * 100)}% cooldown`;
  return main;
}

/** Ascend Points a player would be granted right now (mirrors ascendForPlayer):
 *  the essence stash they ascend with, square-rooted into points. */
export function ascendPoints(essence) {
  const a = catalog.ascend || {};
  const div = Number(a.pointEssenceDiv) || 10;
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, Number(essence) || 0) / div)));
}

export const getOre = (id) => catalog.oreById[id];

// --- the spark clicker ---------------------------------------------------------
// Mirrors clickerCost() in src/game.js exactly, so the price on a shop card is
// always the price the server charges.
export function clickerCost(def, level) {
  const growth = Number(def.growth) || 1;
  return Math.floor((Number(def.baseCost) || 1) * Math.pow(growth, Math.max(0, Number(level) || 0)));
}

/** What an upgrade grants, worded from catalog.clickerEffectTypes. */
export function clickerEffectLabel(effect, level = 1) {
  const t = catalog.clickerEffectTypes[(effect || {}).type] || { name: (effect || {}).type || 'Bonus', fmt: 'none' };
  const per = Number((effect || {}).perLevel) || 0;
  const lv = Number(level) || 0;
  if (t.fmt === 'pct') return `+${round1(per * lv * 100)}% ${t.name}`;
  if (t.fmt === 'flat') return `+${round1(per * lv)} ${t.name}`;
  return t.name;
}

/** "⚡" — the clicker's currency glyph, with a sane fallback. */
export const sparkIcon = () => (catalog.clicker && catalog.clicker.currency && catalog.clicker.currency.icon) || '⚡';

// --- achievements ----------------------------------------------------------------
// Mirrors achievementPoints() in src/achievements.js: a badge may set its own
// score, otherwise it inherits the tier's. The tab badge and the unlock toast
// both need the number, and neither should have to wait on a fetch to say it.
export function achievementPoints(def) {
  if (!def) return 0;
  const own = Number(def.points);
  if (Number.isFinite(own) && own >= 0) return own;
  return Number((catalog.achievementTierById || {})[def.tier]?.points) || 0;
}
