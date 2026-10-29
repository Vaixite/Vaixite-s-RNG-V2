import fs from 'node:fs';
import path from 'node:path';
import { normalizePool } from './roll.js';
import { DEFAULT_GEAR_BUFF_TYPES } from './gear.js';
import { CLICKER_EFFECT_TYPES } from './game.js';
import { ACHIEVEMENT_METRIC_IDS, metricRefKind, achievementPoints } from './achievements.js';

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

const FILES = ['config', 'rarity', 'auras', 'biomes', 'upgrades', 'crafting', 'shop', 'ascendTree', 'mining', 'clicker', 'achievements'];
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
    // Odds are authored as targets and almost never sum to 100%. They are
    // normalised here — never back into the file — so auras.json keeps the
    // numbers you wrote while the engine rolls a pool that hits exactly 100%.
    const rows = [
      ...(raw.auras.global || []).map((r) => ({ ...r, native: false })),
      ...(raw.auras.native || []).map((r) => ({ ...r, native: true })),
      // A third shelf in auras.json: anything listed under "crafted" is special
      // by definition, so the flag is implied instead of repeated per line.
      ...(raw.auras.crafted || []).map((r) => ({ ...r, native: false, craftOnly: true })),
    ];
    const broken = rows.filter((r) => !(Number(r.odds) > 0)).map((r) => r.id || r.name || '(unnamed)');
    if (broken.length) {
      throw new Error(`content validation failed:\n    aura(s) need odds > 0: ${broken.join(', ')}`);
    }

    // A craft-only aura is authored in this file, collected in the bestiary and
    // sold from the inventory — but it is never in the roll pool. Filtering it
    // out before the pool is normalised means every engine path (buildPool, the
    // odds table, the luck floor, the joker) simply never sees it.
    const isCraft = (r) => r.craftOnly === true;
    const rollable = rows.filter((r) => !isCraft(r));
    const crafted = rows.filter(isCraft);
    if (!rollable.length) {
      throw new Error('content validation failed:\n    auras.json has no rollable auras — every one is craftOnly');
    }

    const { auras: pool, report: oddsReport } = normalizePool(rollable);

    // Where an aura sits on the odds ladder, 0 for the most common and 1 for
    // the rarest. Luck multiplies each share by luck^luckExp, so it lifts the
    // rare end and barely touches the common end — see roll.js. Craft-only
    // auras are excluded: they are not on the ladder the roll walks.
    const oddsLogMax = Math.max(1e-9, Math.log(Math.max(...rollable.map((r) => Number(r.odds)))));
    const luckExp = (odds) => Math.max(0, Math.log(Number(odds)) / oddsLogMax);

    const mk = (row) => {
      const tier = tierForOdds(row.odds);
      return {
        id: row.id,
        name: row.name,
        odds: row.odds, // authored — drives every display and price
        share: row.share, // corrected probability the roll actually uses
        declaredOdds: row.declaredOdds,
        isBalancer: row.isBalancer,
        luckExp: luckExp(row.odds),
        color: row.color,
        fx: row.fx || 'soft',
        tier: tier.id,
        tierName: tier.name,
        tierColor: tier.color,
        tierGlow: tier.glow,
        biome: row.native ? row.biome : null,
        native: row.native,
        craftOnly: isCraft(row),
      };
    };
    const auras = pool.map(mk).sort((a, b) => b.odds - a.odds); // rarest first

    // Special auras: made in the cauldron, never rolled. They carry the same
    // shape as a rolled aura — tier, colour, odds, sell price — so one card
    // renders either kind. `share` is 0 because the engine never offers them.
    const specialAuras = crafted
      .map((row) => ({ ...mk(row), share: 0, isBalancer: false }))
      .sort((a, b) => b.odds - a.odds);
    const allAuras = [...auras, ...specialAuras].sort((a, b) => b.odds - a.odds);
    const auraById = Object.fromEntries(allAuras.map((a) => [a.id, a]));

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

    // --- gear ---------------------------------------------------------------------
    // Equipment definitions. A piece declares the buff pool a craft rolls from;
    // a quality decides how many buffs you get and how hot they land.
    const gearCfg = raw.crafting.gear || {};    const gearSlots = gearCfg.slots || [];
    const gearSlotById = Object.fromEntries(gearSlots.map((s) => [s.id, s]));
    const gearBuffTypes = { ...DEFAULT_GEAR_BUFF_TYPES, ...(gearCfg.buffTypes || {}) };
    const gearQualities = (gearCfg.qualities || []).map((q) => ({
      power: 1,
      value: 1,
      color: '#8b95ad',
      ...q,
      buffs: { min: q.buffs?.min ?? 2, max: q.buffs?.max ?? q.buffs?.min ?? 2 },
    }));
    const gearQualityById = Object.fromEntries(gearQualities.map((q) => [q.id, q]));
    const gear = (gearCfg.pieces || []).map((p) => ({
      ...p,
      buffs: (p.buffs || []).map((b) => ({ ...b, min: Number(b.min) || 0, max: Number(b.max) || 0 })),
    }));
    const gearById = Object.fromEntries(gear.map((g) => [g.id, g]));
    const gearSalvage = gearCfg.salvage || { base: 250 };

    // --- ascend tree -----------------------------------------------------------------
    // Permanent upgrade tree bought with Ascend Points (content/ascendTree.json).
    const treeNodes = raw.ascendTree.nodes || [];
    const treeById = Object.fromEntries(treeNodes.map((n) => [n.id, n]));

    // --- mining ------------------------------------------------------------------------
    // The mining shaft's ore table (content/mining.json). Its own RNG, its own odds.
    const mining = raw.mining || {};
    const miningOres = (mining.ores || []).map((o) => ({
      ...o,
      odds: Number(o.odds) || 1,
      money: Number(o.money) || 1,
      essence: Number(o.essence) || 1,
    }));
    const oreById = Object.fromEntries(miningOres.map((o) => [o.id, o]));

    // --- spark clicker ------------------------------------------------------------------
    // The clicker minigame's shop (content/clicker.json). Its own currency, its own
    // crit RNG — and the upgrades that pay back into the main loop (Luck, Roll
    // Speed) are applied by clickerStats() in game.js, like the ascend tree.
    const clicker = raw.clicker || {};
    const clickerUpgrades = (clicker.upgrades || []).map((u) => ({
      ...u,
      baseCost: Number(u.baseCost) || 1,
      growth: Number(u.growth) || 1,
      max: Number(u.max) || 0,
    }));
    const clickerById = Object.fromEntries(clickerUpgrades.map((u) => [u.id, u]));

    // --- achievements ------------------------------------------------------------
    // Badges are pure measurement: a tier for colour + score, a metric the engine
    // knows how to read off a player, and a target. Nothing here can change what
    // a badge measures — that list lives in achievements.js — so a line in this
    // file can only ever be "which number, how high, what colour, what prize".
    const achTiers = (raw.achievements.tiers || []).map((t) => ({
      points: 0,
      icon: '🏅',
      announce: false, // true = an unlock in this tier is worth the world feed
      ...t,
    }));
    const achievementTierById = Object.fromEntries(achTiers.map((t) => [t.id, t]));
    const achievements = (raw.achievements.achievements || []).map((a) => ({
      ...a,
      target: Number(a.target) || 0,
      reward: a.reward
        ? { money: Math.max(0, Number(a.reward.money) || 0), essence: Math.max(0, Number(a.reward.essence) || 0) }
        : null,
    }));
    const achievementById = Object.fromEntries(achievements.map((a) => [a.id, a]));
    const achievementPointsTotal = achievements.reduce(
      (s, a) => s + achievementPoints(a, achievementTierById[a.tier]),
      0
    );

    // --- cross-validation -------------------------------------------------------
    const problems = [];
    const ids = new Set();
    for (const a of allAuras) {
      if (ids.has(a.id)) problems.push(`duplicate aura id "${a.id}"`);
      ids.add(a.id);
      if (!(a.odds > 0)) problems.push(`aura ${a.id}: odds must be > 0`);
      if (a.native && !biomeById[a.biome]) problems.push(`aura ${a.id}: unknown biome "${a.biome}"`);
    }
    for (const b of biomes) if (!(b.luck > 0)) problems.push(`biome ${b.id}: luck must be > 0`);

    const gearIds = new Set();
    for (const g of gear) {
      if (gearIds.has(g.id)) problems.push(`duplicate gear id "${g.id}"`);
      gearIds.add(g.id);
      if (!g.name) problems.push(`gear ${g.id}: needs a name`);
      if (!gearSlotById[g.slot]) problems.push(`gear ${g.id}: unknown slot "${g.slot}"`);
      if ((g.buffs || []).length < 2) problems.push(`gear ${g.id}: needs at least 2 buffs — equipment is multi-buff by design`);
      if (!(g.buffs || []).some((b) => b.signature)) problems.push(`gear ${g.id}: needs one signature buff`);
      const seen = new Set();
      for (const b of g.buffs || []) {
        if (!gearBuffTypes[b.type]) problems.push(`gear ${g.id}: unknown buff type "${b.type}"`);
        if (seen.has(b.type)) problems.push(`gear ${g.id}: duplicate buff type "${b.type}"`);
        seen.add(b.type);
        if (!(b.max > 0) || b.min > b.max) problems.push(`gear ${g.id}.${b.type}: needs 0 < min <= max`);
      }
    }
    for (const q of gearQualities) {
      if (!(q.buffs.min > 0)) problems.push(`gear quality ${q.id}: buffs.min must be > 0`);
      if (q.buffs.max < q.buffs.min) problems.push(`gear quality ${q.id}: buffs.max < buffs.min`);
    }

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
      if (out.gear && !gearById[out.gear]) problems.push(`recipe ${r.id}: unknown gear output "${out.gear}"`);
      if (!out.aura && !out.item && !out.gear) problems.push(`recipe ${r.id}: output needs "aura", "item" or "gear"`);
      const quals = out.qualities || {};
      if (out.gear && !Object.keys(quals).length) problems.push(`recipe ${r.id}: gear output needs "qualities"`);
      for (const qid of Object.keys(quals)) {
        if (!gearQualityById[qid]) problems.push(`recipe ${r.id}: unknown gear quality "${qid}"`);
        if (!(Number(quals[qid]) > 0)) problems.push(`recipe ${r.id}: gear quality ${qid} weight must be > 0`);
      }
    }

    // A craft-only aura that nothing can craft is a dead collection slot, not a
    // broken file — so it warns on reload instead of refusing to load.
    const craftable = new Set(recipes.filter((r) => r.output?.aura).map((r) => r.output.aura));
    const uncraftableSpecial = specialAuras.filter((a) => !craftable.has(a.id)).map((a) => a.id);

    const treeIds = new Set();
    for (const n of treeNodes) {
      if (treeIds.has(n.id)) problems.push(`tree node duplicate id "${n.id}"`);
      treeIds.add(n.id);
      if (!n.name) problems.push(`tree node ${n.id}: needs a name`);
      if (!(Number(n.cost) > 0)) problems.push(`tree node ${n.id}: cost must be > 0`);
      if (!(Number(n.maxLevel) > 0)) problems.push(`tree node ${n.id}: maxLevel must be > 0`);
      for (const req of n.requires || []) {
        if (!treeNodes.some((m) => m.id === req)) problems.push(`tree node ${n.id}: unknown prerequisite "${req}"`);
      }
      if (n.effect?.type === 'unlock' && !n.effect.unlock) problems.push(`tree node ${n.id}: unlock effect needs an "unlock" id`);
    }
    // A node that can never be reached (cycle) would soft-lock the tree.
    const reachable = new Set();
    const canReach = (id, seen) => {
      if (reachable.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const n = treeById[id];
      if (!n) return false;
      const ok = !(n.requires || []).length || (n.requires || []).every((r) => canReach(r, seen));
      if (ok) reachable.add(id);
      return ok;
    };
    for (const n of treeNodes) {
      if (!canReach(n.id, new Set())) problems.push(`tree node ${n.id}: unreachable (prerequisite cycle?)`);
    }

    const oreIds = new Set();
    for (const o of miningOres) {
      if (oreIds.has(o.id)) problems.push(`duplicate ore id "${o.id}"`);
      oreIds.add(o.id);
      if (!(o.odds > 0)) problems.push(`ore ${o.id}: odds must be > 0`);
      if (!o.name) problems.push(`ore ${o.id}: needs a name`);
    }
    if (miningOres.length && !(Number(mining.grid?.cells) > 0)) problems.push('mining.json: grid.cells must be > 0');

    const clickerIds = new Set();
    for (const u of clickerUpgrades) {
      if (clickerIds.has(u.id)) problems.push(`duplicate clicker upgrade id "${u.id}"`);
      clickerIds.add(u.id);
      if (!u.name) problems.push(`clicker upgrade ${u.id}: needs a name`);
      if (!(Number(u.baseCost) > 0)) problems.push(`clicker upgrade ${u.id}: baseCost must be > 0`);
      if (!(Number(u.growth) >= 1)) problems.push(`clicker upgrade ${u.id}: growth must be >= 1 (1 = flat cost)`);
      if ((Number(u.max) || 0) < 0) problems.push(`clicker upgrade ${u.id}: max cannot be negative — 0 means unlimited`);
      // An effect the engine does not apply would be a shop line that silently
      // does nothing, which is the worst kind of content bug to chase.
      if (!CLICKER_EFFECT_TYPES.includes(u.effect?.type)) {
        problems.push(`clicker upgrade ${u.id}: unknown effect type "${u.effect?.type}"`);
      }
    }
    if (clickerUpgrades.length) {
      const crit = clicker.crit || {};
      const base = Number(crit.baseChance);
      if (!(base >= 0 && base <= 1)) problems.push('clicker.json: crit.baseChance must be between 0 and 1');
      if (!(Number(crit.maxChance) > 0)) problems.push('clicker.json: crit.maxChance must be > 0');
      if (!(Number(crit.baseMult) > 0)) problems.push('clicker.json: crit.baseMult must be > 0');
      if (!(Number(clicker.clickCooldownMs) >= 0)) problems.push('clicker.json: clickCooldownMs must be >= 0');
      if (!(Number(clicker.maxClicksPerTap) > 0)) problems.push('clicker.json: maxClicksPerTap must be > 0');
    }

    const achTierIds = new Set();
    for (const t of achTiers) {
      if (achTierIds.has(t.id)) problems.push(`duplicate achievement tier id "${t.id}"`);
      achTierIds.add(t.id);
      if (!t.name) problems.push(`achievement tier ${t.id}: needs a name`);
      if (!t.color) problems.push(`achievement tier ${t.id}: needs a color`);
      if ((Number(t.points) || 0) < 0) problems.push(`achievement tier ${t.id}: points cannot be negative`);
    }
    const achIds = new Set();
    for (const a of achievements) {
      if (achIds.has(a.id)) problems.push(`duplicate achievement id "${a.id}"`);
      achIds.add(a.id);
      if (!a.name) problems.push(`achievement ${a.id}: needs a name`);
      if (!a.desc) problems.push(`achievement ${a.id}: needs a desc`);
      if (!achievementTierById[a.tier]) problems.push(`achievement ${a.id}: unknown tier "${a.tier}"`);
      // The metric list is the whole contract: a badge may measure anything the
      // engine already tracks, and nothing else.
      if (!ACHIEVEMENT_METRIC_IDS.includes(a.metric)) problems.push(`achievement ${a.id}: unknown metric "${a.metric}"`);
      if (!(Number(a.target) > 0)) problems.push(`achievement ${a.id}: target must be > 0`);
      const refKind = metricRefKind(a.metric);
      if (refKind && !a.ref) problems.push(`achievement ${a.id}: metric "${a.metric}" needs a ref`);
      if (!refKind && a.ref) problems.push(`achievement ${a.id}: metric "${a.metric}" does not take a ref`);
      if (refKind === 'aura' && a.ref && !auraById[a.ref]) problems.push(`achievement ${a.id}: unknown aura ref "${a.ref}"`);
      if (refKind === 'ore' && a.ref && !oreIds.has(a.ref)) problems.push(`achievement ${a.id}: unknown ore ref "${a.ref}"`);
    }

    if (problems.length) throw new Error('content validation failed:\n    ' + problems.join('\n    '));

    return {
      config: raw.config,
      rarityTiers: tiers,
      cutsceneTierIndex: raw.rarity.cutsceneTierIndex ?? 3,
      oddsReport,
      auras,
      allAuras,
      specialAuras,
      uncraftableSpecial,
      auraById,
      biomes,
      biomeById,
      rotateMs: raw.biomes.rotateMs || 90000,
      btMultiplier: raw.biomes.breakthroughMultiplier || 12,
      upgrades,
      upgradeById,
      ascend: raw.upgrades.ascend || { requirementBase: 25, requirementGrowth: 6, luckPerAscension: 0.75, pointEssenceDiv: 10 },
      items,
      itemById,
      sell,
      recipes,
      recipeById,
      gear,
      gearById,
      gearSlots,
      gearSlotById,
      gearQualities,
      gearQualityById,
      gearBuffTypes,
      gearSalvage,
      treeNodes,
      treeById,
      treeEffectTypes: raw.ascendTree.effectTypes || {},
      mining,
      miningOres,
      oreById,
      clicker,
      clickerUpgrades,
      clickerById,
      clickerEffectTypes: raw.clicker?.effectTypes || {},
      achievements,
      achievementById,
      achievementTiers: achTiers,
      achievementTierById,
      achievementPointsTotal,
    };
  }

  function load() {
    const { raw, stamps: now } = readAll();
    try {
      const built = build(raw);
      stamps = now;
      current = built;
      console.log(
        `[content] loaded — ${built.auras.length} auras · ${built.specialAuras.length} special · ` +
          `${built.biomes.length} biomes · ` +
          `${built.upgrades.length} upgrades · ${built.recipes.length} recipes · ${built.items.length} items · ` +
          `${built.gear.length} gear pieces · ${built.treeNodes.length} tree nodes · ` +
          `${built.miningOres.length} ores · ${built.clickerUpgrades.length} clicker upgrades · ` +
          `${built.achievements.length} achievements in ${built.achievementTiers.length} tiers`
      );
      if (built.uncraftableSpecial.length) {
        console.warn(
          `[content] craft-only auras no recipe produces: ${built.uncraftableSpecial.join(', ')} — ` +
            'they can only be found in an existing inventory'
        );
      }
      const r = built.oddsReport;
      if (r) {
        const pct = (x) => `${(x * 100).toFixed(2)}%`;
        console.log(
          `[content] odds — authored pool summed ${pct(r.rawSum)} → normalised to 100% · ` +
            `"${r.balancerName}" absorbs: shows 1/${r.authoredOdds}, rolls 1/${r.effectiveOdds.toFixed(2)} (${pct(r.share)})` +
            (r.squeezed ? ` — rare auras squeezed down from ${pct(r.squeezed)}` : '')
        );
      }
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
