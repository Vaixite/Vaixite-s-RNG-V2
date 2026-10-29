// ---------------------------------------------------------------------------
// ACHIEVEMENTS — the measuring stick; content/achievements.json is the rulebook.
//
// A metric is one named number read off a player record. An achievement is that
// number plus a target. That is the whole model, and it is what makes the
// feature safe to bolt onto a running game:
//
//   • Nothing here is an event. There is no "onCraft" hook a future mutation
//     can forget to call — settleAchievements() re-reads the player from
//     scratch, so any action that ends up serialising a profile gets its badges
//     checked whether or not whoever wrote the action remembered.
//   • Unlocking is monotonic. Once an id is in `player.achievements` it stays
//     there, so a number falling back down — ascending wipes your levels,
//     selling empties your bag, spending Ascend Points drains the stash — can
//     never take a badge back.
//   • The only achievement state on a player is that id -> unlockedAt map.
//     Progress bars are computed, never stored, so a target edited in the JSON
//     is immediately true for every account, existing ones included.
//
// This module deliberately imports nothing from game.js: the caller hands over
// the derived stats it already computed, which keeps the dependency one-way.
// ---------------------------------------------------------------------------

const sumLevels = (obj) =>
  Object.values(obj && typeof obj === 'object' ? obj : {}).reduce((s, v) => s + (Number(v) || 0), 0);

const counter = (player, key) => Number(player?.counters?.[key]) || 0;
const oreCount = (player, oreId) => Number(player?.counters?.ores?.[oreId]) || 0;

/**
 * The starting shape of `player.counters`.
 *
 * These are the tallies a live player record cannot answer on its own: money
 * and essence get spent, auras get sold, upgrade levels are wiped by ascending.
 * A badge is about what you *did*, so the doing is counted once, at the moment
 * it happens, and nothing ever subtracts it. `ores` is a map rather than a
 * number because "have you ever struck Star Core" is a different question from
 * "how many rocks".
 *
 * It lives here rather than in game.js because this module is the only reader,
 * and both game.js (new players) and db.js (old saves) need to agree on it —
 * and this file is the one place in the tree that imports nothing.
 */
export function baseCounters() {
  return {
    moneyEarned: 0,
    essenceEarned: 0,
    pointsEarned: 0,
    upgradesBought: 0,
    sells: 0,
    crafts: 0,
    gearCrafted: 0,
    itemsUsed: 0,
    potions: 0,
    minePicks: 0,
    ores: {},
  };
}

/**
 * Every number an achievement is allowed to be about.
 *
 * `fmt` is only how the client words the value and the target — int / money /
 * essence / odds / mult / ms. `ref` names the content table a `ref` id has to
 * come from, so content.js can refuse an achievement pointing at an aura that
 * does not exist. `below: true` flips the comparison: those unlock by getting
 * *under* the target, and a missing measurement reads as 0, which must never
 * count as a success — meetsTarget() handles that.
 */
export const ACHIEVEMENT_METRICS = {
  rolls:          { name: 'Lifetime rolls',      fmt: 'int',     value: (p) => Number(p.lifetimeRolls) || 0 },
  uniqueAuras:    { name: 'Auras in your bag',   fmt: 'int',     value: (p) => Object.keys(p.inventory || {}).length },
  bestOdds:       { name: 'Rarest pull',         fmt: 'odds',    value: (p) => Number(p.best?.odds) || 0 },
  ownAura:        { name: 'Own an aura',         fmt: 'int', ref: 'aura', value: (p, d) => (p.inventory?.[d.ref]?.count > 0 ? 1 : 0) },
  auraCount:      { name: 'Copies of one aura',  fmt: 'int', ref: 'aura', value: (p, d) => Number(p.inventory?.[d.ref]?.count) || 0 },
  ascensions:     { name: 'Ascensions',          fmt: 'int',     value: (p) => Number(p.ascensions) || 0 },
  pointsEarned:   { name: 'Ascend Points earned', fmt: 'int',    value: (p) => counter(p, 'pointsEarned') },
  treeLevels:     { name: 'Tree levels bought',  fmt: 'int',     value: (p) => sumLevels(p.tree) },
  upgradesBought: { name: 'Upgrade levels',      fmt: 'int',     value: (p) => counter(p, 'upgradesBought') },
  luck:           { name: 'Luck',                fmt: 'mult',    value: (p, d, s) => Number(s?.luck) || 0 },
  cooldownMs:     { name: 'Roll cooldown',  fmt: 'ms', below: true, value: (p, d, s) => Number(s?.cooldownMs) || 0 },
  moneyEarned:    { name: 'Money earned',        fmt: 'money',   value: (p) => counter(p, 'moneyEarned') },
  essenceEarned:  { name: 'Essence earned',      fmt: 'essence', value: (p) => counter(p, 'essenceEarned') },
  sells:          { name: 'Auras sold',          fmt: 'int',     value: (p) => counter(p, 'sells') },
  crafts:         { name: 'Recipes crafted',     fmt: 'int',     value: (p) => counter(p, 'crafts') },
  gearCrafted:    { name: 'Gear forged',         fmt: 'int',     value: (p) => counter(p, 'gearCrafted') },
  gearEquipped:   { name: 'Gear worn',           fmt: 'int',     value: (p) => Object.keys(p.equipped || {}).length },
  itemsUsed:      { name: 'Items used',          fmt: 'int',     value: (p) => counter(p, 'itemsUsed') },
  potions:        { name: 'Potion charges',      fmt: 'int',     value: (p) => counter(p, 'potions') },
  minePicks:      { name: 'Shaft picks',         fmt: 'int',     value: (p) => counter(p, 'minePicks') },
  oreFind:        { name: 'Ore found',           fmt: 'int', ref: 'ore', value: (p, d) => oreCount(p, d.ref) },
  clicks:         { name: 'Clicks',              fmt: 'int',     value: (p) => Number(p.clicker?.totalClicks) || 0 },
  sparks:         { name: 'Sparks earned',       fmt: 'int',     value: (p) => Number(p.clicker?.totalSparks) || 0 },
  bestClick:      { name: 'Best click',          fmt: 'int',     value: (p) => Number(p.clicker?.bestClick) || 0 },
  crits:          { name: 'Crit clicks',         fmt: 'int',     value: (p) => Number(p.clicker?.totalCrits) || 0 },
  biomesSeen:     { name: 'Biomes rolled in',    fmt: 'int',     value: (p) => Object.keys(p.biomesSeen || {}).length },
};

export const ACHIEVEMENT_METRIC_IDS = Object.keys(ACHIEVEMENT_METRICS);

/** The content table a metric's `ref` has to name, or null when it takes none. */
export function metricRefKind(metric) {
  return ACHIEVEMENT_METRICS[metric]?.ref || null;
}

/** The number this achievement is about, right now. Unknown metrics read 0. */
export function achievementValue(def, player, stats) {
  const m = ACHIEVEMENT_METRICS[def.metric];
  if (!m) return 0;
  const v = Number(m.value(player, def, stats)) || 0;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Has the metric reached the target?
 *
 * Which way "reached" points belongs to the metric, not to the line in the
 * content file: a cooldown is a smaller-is-better number no matter who asks
 * about it, and letting the JSON flip the comparison would let one typo turn
 * "under 300 ms" into "over 300 ms" on a badge everyone already owns.
 */
export function meetsTarget(def, value) {
  const v = Number(value) || 0;
  const t = Number(def.target) || 0;
  if (!(t > 0)) return false;
  // An unmeasured cooldown reads 0, and 0 ms is not "fast" — it is "unknown",
  // so a `below` badge needs a real number before it can be won.
  if (ACHIEVEMENT_METRICS[def.metric]?.below) return v > 0 && v <= t;
  return v >= t;
}

/** Score one badge is worth: its own `points`, else its tier's. */
export function achievementPoints(def, tier) {
  const own = Number(def.points);
  if (Number.isFinite(own) && own >= 0) return own;
  return Number(tier?.points) || 0;
}

/**
 * Bring the player's badge list up to date and pay out whatever is new.
 *
 * Returns the achievements that unlocked on this call along with the reward
 * they added, so the caller can toast them, announce the big ones and mark the
 * database dirty. Idempotent: a second call in the same tick finds nothing new.
 */
export function settleAchievements(player, content, stats, now = Date.now()) {
  const defs = content.achievements || [];
  if (!player.achievements || typeof player.achievements !== 'object') player.achievements = {};
  const out = { unlocked: [], money: 0, essence: 0 };
  if (!defs.length) return out;

  const tiers = content.achievementTierById || {};
  for (const def of defs) {
    if (player.achievements[def.id]) continue;
    if (!meetsTarget(def, achievementValue(def, player, stats))) continue;
    player.achievements[def.id] = now;
    // Content objects are shared and read-only — hand the caller a copy with
    // the score resolved instead of writing the number back into the file's
    // parsed shape.
    out.unlocked.push({ ...def, points: achievementPoints(def, tiers[def.tier]) });
    out.money += Number(def.reward?.money) || 0;
    out.essence += Number(def.reward?.essence) || 0;
  }
  if (out.money) player.money = (Number(player.money) || 0) + out.money;
  if (out.essence) player.essence = (Number(player.essence) || 0) + out.essence;
  return out;
}

/**
 * The whole board for one player: every definition, measured, with the unlock
 * timestamp when it has one. This is what GET /api/achievements answers with —
 * the tab is opened occasionally, so it is cheaper and far less stale than
 * shipping 50 measurements inside every profile.
 */
export function achievementRows(player, content, stats) {
  const tiers = content.achievementTierById || {};
  return (content.achievements || []).map((def) => {
    const at = player.achievements?.[def.id] || null;
    const value = achievementValue(def, player, stats);
    const tier = tiers[def.tier] || {};
    const m = ACHIEVEMENT_METRICS[def.metric] || {};
    const below = !!m.below;
    // The bar never reads past 100% — a badge earned long ago keeps reading
    // done. A `below` badge closes on it from the other side: the smaller the
    // number the nearer the target, so the fill is target/raw (1100 ms against
    // a 300 ms goal is 27% of the way there, and hits 100% the moment it lands).
    const pct = below
      ? (value > 0 ? Math.min(1, def.target / value) : 0)
      : Math.min(1, def.target > 0 ? value / def.target : 0);
    return {
      id: def.id,
      name: def.name,
      icon: def.icon,
      desc: def.desc,
      tier: def.tier,
      tierName: tier.name || def.tier,
      color: tier.color || '#8b95ad',
      glow: tier.glow,
      points: achievementPoints(def, tier),
      metric: def.metric,
      ref: def.ref || null,
      fmt: m.fmt || 'int',
      below,
      target: def.target,
      // What to print next to the bar. For a `below` badge that is the honest
      // measurement — clamping it to the target would be a lie about a number
      // you are trying to get *under*.
      value: below ? value : Math.min(value, def.target),
      pct,
      raw: value,
      done: !!at,
      at,
      reward: def.reward || null,
    };
  });
}

/** Counters for the header: how many, how many, how many points. */
export function achievementSummary(player, content) {
  const tiers = content.achievementTierById || {};
  const defs = content.achievements || [];
  const owned = player.achievements || {};
  let points = 0;
  let pointsTotal = 0;
  for (const def of defs) {
    const p = achievementPoints(def, tiers[def.tier]);
    pointsTotal += p;
    if (owned[def.id]) points += p;
  }
  return { unlocked: defs.filter((d) => owned[d.id]).length, total: defs.length, points, pointsTotal };
}
