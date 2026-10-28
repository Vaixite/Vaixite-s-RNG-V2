import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CONTENT LOADER
//
// Every tunable in the game lives in content/*.json. This loader parses them,
// cross-validates references (recipes → auras/items, auras → biomes), and
// hot-reloads: every 2s it stats the files and rebuilds if any mtime changed.
// A broken edit logs an error and keeps the last good content, so the server
// never dies because of a typo in a JSON file.
//
// Only someone with file access to this machine can change the game — the
// HTTP API is read-only with respect to content.
// ---------------------------------------------------------------------------

const FILES = ['config', 'rarity', 'auras', 'biomes', 'upgrades', 'crafting', 'shop'];
const RECHECK_MS = 2000;

export function createContentLoader(dir) {
  let current = null;
  let stamps = {};
  let lastCheck = 0;

  function fileOf(name) {
    return path.join(dir, `${name}.json`);
  }

  function readAll() {
    const raw = {};
    const now = {};
    for (const name of FILES) {
      const file = fileOf(name);
      now[name] = fs.statSync(file).mtimeMs;
      raw[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return { raw, stamps: now };
  }

  function build(raw) {
    // --- rarity tiers ------------------------------------------------------
    const tiers = (raw.rarity.tiers || []).map((t) => ({
      ...t,
      max: t.max === null || t.max === undefined ? Infinity : t.max,
    }));
    if (!tiers.length) throw new Error('rarity.json: no tiers');
    const tierForOdds = (odds) =>
      tiers.find((t) => odds >= t.min && odds <= t.max) || tiers[tiers.length - 1];

    // --- auras ---------------------------------------------------------------
    const mk = (row, native) => {
      const tier = tierForOdds(row.odds);
      return {
        id: row.id,
        name: row.name,
        odds: row.odds,
        color: row.color,
        fx: row.fx || 'soft',
        tier: tier.id,
        tierName: tier.name,
        tierColor: tier.color,
        tierGlow: tier.glow,
        biome: native ? row.biome : null,
        native,
      };
    };
    const auras = [
      ...(raw.auras.global || []).map((r) => mk(r, false)),
      ...(raw.auras.native || []).map((r) => mk(r, true)),
    ].sort((a, b) => b.odds - a.odds); // rarest first — the roll walks top-down
    const auraById = Object.fromEntries(auras.map((a) => [a.id, a]));

    // --- biomes ---------------------------------------------------------------
    const biomes = raw.biomes.biomes || [];
    const biomeById = Object.fromEntries(biomes.map((b) => [b.id, b]));

    // --- upgrades -------------------------------------------------------------
    const upgrades = raw.upgrades.upgrades || [];
    const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));

    // --- shop -----------------------------------------------------------------
    const items = raw.shop.items || [];
    const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
    const sell = raw.shop.sell || { coefficient: 10, exponent: 2.5, min: 1 };

    // --- crafting ---------------------------------------------------------------
    const recipes = raw.crafting.recipes || [];
    const recipeById = Object.fromEntries(recipes.map((r) => [r.id, r]));

    // --- cross-validation -------------------------------------------------------
    const problems = [];
    const ids = new Set();
    for (const a of auras) {
      if (ids.has(a.id)) problems.push(`duplicate aura id "${a.id}"`);
      ids.add(a.id);
      if (!(a.odds > 0)) problems.push(`aura ${a.id}: odds must be > 0`);
      if (a.native && !biomeById[a.biome]) problems.push(`aura ${a.id}: unknown biome "${a.biome}"`);
    }
    for (const b of biomes) if (!(b.luck > 0)) problems.push(`biome ${b.id}: luck must be > 0`);
    for (const r of recipes) {
      for (const inp of r.inputs || []) {
        if (inp.aura && !auraById[inp.aura]) problems.push(`recipe ${r.id}: unknown aura input "${inp.aura}"`);
        if (inp.item && !itemById[inp.item]) problems.push(`recipe ${r.id}: unknown item input "${inp.item}"`);
        if (!inp.aura && !inp.item) problems.push(`recipe ${r.id}: input without "aura" or "item"`);
        if (!(inp.count > 0)) problems.push(`recipe ${r.id}: input count must be > 0`);
      }
      const out = r.output || {};
      if (out.aura && !auraById[out.aura]) problems.push(`recipe ${r.id}: unknown aura output "${out.aura}"`);
      if (out.item && !itemById[out.item]) problems.push(`recipe ${r.id}: unknown item output "${out.item}"`);
      if (!out.aura && !out.item) problems.push(`recipe ${r.id}: output needs "aura" or "item"`);
    }
    if (problems.length) throw new Error('content validation failed:\n    ' + problems.join('\n    '));

    return {
      config: raw.config,
      rarityTiers: tiers,
      cutsceneTierIndex: raw.rarity.cutsceneTierIndex ?? 3,
      auras,
      auraById,
      biomes,
      biomeById,
      rotateMs: raw.biomes.rotateMs || 90000,
      btMultiplier: raw.biomes.breakthroughMultiplier || 12,
      upgrades,
      upgradeById,
      ascend: raw.upgrades.ascend || { requirementBase: 25, requirementGrowth: 6, luckPerAscension: 0.75 },
      items,
      itemById,
      sell,
      recipes,
      recipeById,
    };
  }

  function load() {
    const { raw, stamps: now } = readAll();
    try {
      const built = build(raw);
      stamps = now;
      current = built;
      console.log(
        `[content] loaded — ${built.auras.length} auras · ${built.biomes.length} biomes · ` +
          `${built.upgrades.length} upgrades · ${built.recipes.length} recipes · ${built.items.length} items`
      );
    } catch (err) {
      console.error('[content]', err.message);
      if (!current) throw err; // first load must succeed; later ones keep the old copy
      stamps = now; // don't re-log the same broken file every 2s
    }
    return current;
  }

  return {
    get() {
      if (!current) return load();
      const now = Date.now();
      if (now - lastCheck < RECHECK_MS) return current;
      lastCheck = now;
      try {
        for (const name of FILES) {
          if (fs.statSync(fileOf(name)).mtimeMs !== stamps[name]) {
            console.log(`[content] ${name}.json changed — reloading`);
            return load();
          }
        }
      } catch (err) {
        console.error('[content] reload check failed:', err.message);
      }
      return current;
    },
  };
}
