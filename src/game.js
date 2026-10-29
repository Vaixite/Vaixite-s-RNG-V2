import crypto from 'node:crypto';
import { rollMany, bestOf, essenceFor, sellPrice } from './roll.js';
import { rollGear, pickQuality, gearValue, aggregateGear, gearView } from './gear.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';
import { isAdmin } from './admins.js';
import { settleAchievements, achievementRows, achievementSummary, baseCounters } from './achievements.js';

// ---------------------------------------------------------------------------
// GAME RULES — the single authority for every mutation.
//
// Two kinds of players:
//   • accounts  — username + scrypt-hashed password, persisted in db.json,
//                 sessions survive restarts.
//   • guests    — "guest-####", held in memory only. Nothing about a guest is
//                 ever written to disk; they vanish on restart. That is the
//                 deal: play instantly, no saving.
// ---------------------------------------------------------------------------

// Names are validated, not sanitised: silently deleting the junk out of
// "<script>x</script>" would hand out a name nobody asked for. Letters,
// numbers, dot, underscore and dash only — and the client still escapes
// output, so nothing here has to be HTML-aware.
const NAME_ALLOWED = /^[A-Za-z0-9_.-]+$/;

// --- players ---------------------------------------------------------------

export function cleanName(raw, cfg) {
  const base = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!base || !NAME_ALLOWED.test(base)) return '';
  if (base.length < (cfg.nameMin ?? 3)) return '';
  return base.slice(0, cfg.nameMax ?? 18);
}

export function basePlayer(name) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    lastSeenAt: now,
    essence: 0,
    money: 0,
    totalRolls: 0,
    lifetimeRolls: 0, // never reset by ascending — the true total
    ascensions: 0,
    ascendPoints: 0,   // currency of the ascend upgrade tree
    tree: {},          // nodeId -> level bought (permanent across ascensions)
    mining: null,      // current vein: { vein: [oreId], revealed: [bool], lastPickAt, autoAt, autoCarry }
    clicker: null,     // spark clicker: { sparks, totalSparks, totalClicks, totalCrits, levels, lastClickAt, autoAt, autoCarry, bestClick }
    levels: { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0 },
    inventory: {},
    items: {},
    gear: [], // crafted equipment instances — each craft rolls its own buffs
    equipped: {}, // slot -> gear instance uid
    buffs: [],
    best: null,
    lastRollAt: 0,
    counters: baseCounters(), // lifetime tallies; see baseCounters()
    biomesSeen: {},    // biomeId -> true, set by any roll made inside that biome
    achievements: {},  // achievementId -> the moment it unlocked; never removed
  };
}

// Counters are read and written through these three helpers rather than
// straight off the record. Accounts saved before the tallies existed have no
// `counters` key at all, and a badge should not hinge on a migration having
// run first — so the shape is created on first use.
function counters(player) {
  if (!player.counters || typeof player.counters !== 'object') player.counters = baseCounters();
  return player.counters;
}

function tally(player, key, amount = 1) {
  if (!(amount > 0)) return;
  const c = counters(player);
  c[key] = (Number(c[key]) || 0) + amount;
}

function tallyOre(player, oreId, amount = 1) {
  if (!(amount > 0) || !oreId) return;
  const c = counters(player);
  if (!c.ores || typeof c.ores !== 'object') c.ores = {};
  c.ores[oreId] = (Number(c.ores[oreId]) || 0) + amount;
}

function seeBiome(player, biomeId) {
  if (!biomeId) return;
  if (!player.biomesSeen || typeof player.biomesSeen !== 'object') player.biomesSeen = {};
  player.biomesSeen[biomeId] = true;
}

export function newAccount(ctx, username, password) {
  const { db, content } = ctx;
  const cfg = content.config;
  const name = cleanName(username, cfg);
  if (!name) return { error: 'bad_username' };
  if (String(password || '').length < (cfg.passwordMin ?? 6)) return { error: 'weak_password' };
  const taken = Object.values(db.data.players).some(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );
  if (taken) return { error: 'name_taken' };
  const player = basePlayer(name);
  const { salt, hash } = hashPassword(password);
  player.salt = salt;
  player.passwordHash = hash;
  db.data.players[player.id] = player;
  db.data.meta.nextPlayerId++;
  db.markDirty();
  return { player };
}

export function loginAccount(ctx, username, password) {
  const { db } = ctx;
  const wanted = String(username || '').trim().toLowerCase();
  const player = Object.values(db.data.players).find((p) => p.name.toLowerCase() === wanted);
  if (!player || !player.passwordHash) return { error: 'bad_credentials' };
  if (!verifyPassword(password, player.salt, player.passwordHash)) return { error: 'bad_credentials' };
  player.lastSeenAt = Date.now();
  return { player };
}

export function newGuest(ctx) {
  const { db, mem, content } = ctx;
  const cfg = content.config;
  const prefix = cfg.guestPrefix ?? 'guest-';
  const digits = cfg.guestDigits ?? 4;
  const taken = new Set([
    ...Object.values(db.data.players).map((p) => p.name.toLowerCase()),
    ...Object.values(mem.guests).map((p) => p.name.toLowerCase()),
  ]);
  let name;
  for (let tries = 0; tries < 50; tries++) {
    const span = Math.max(1, 9 * Math.pow(10, digits - 1));
    const n = 10 ** (digits - 1) + Math.floor(Math.random() * span);
    name = `${prefix}${n}`;
    if (!taken.has(name.toLowerCase())) break;
    name = `${prefix}${n}${Math.floor(Math.random() * 100)}`; // widen if crowded
    if (!taken.has(name.toLowerCase())) break;
  }
  const player = basePlayer(name);
  player.guest = true;
  mem.guests[player.id] = player;
  return { player };
}

export function allPlayers(ctx) {
  return { ...ctx.db.data.players, ...ctx.mem.guests };
}

export function touchPlayer(player) {
  player.lastSeenAt = Date.now();
  // Migration for accounts created before lifetime rolls were tracked: seed
  // the lifetime counter from the current run so Quick Roll and friends do
  // not make everyone start from zero.
  if (player.lifetimeRolls === undefined) player.lifetimeRolls = player.totalRolls || 0;
}

// --- sessions ----------------------------------------------------------------

export function createSession(ctx, player) {
  const { content } = ctx;
  const token = newToken();
  const ttl = (content.config.sessionDays ?? 30) * 86400000;
  const session = { playerId: player.id, createdAt: Date.now(), expiresAt: Date.now() + ttl };
  if (player.guest) ctx.mem.sessions.set(token, session);
  else {
    ctx.db.data.sessions[token] = session;
    ctx.db.markDirty();
  }
  return token;
}

export function resolveSession(ctx, token) {
  if (!token) return null;
  const now = Date.now();
  const mem = ctx.mem.sessions.get(token);
  if (mem) {
    if (now > mem.expiresAt) {
      ctx.mem.sessions.delete(token);
      return null;
    }
    const player = ctx.mem.guests[mem.playerId];
    if (!player) {
      ctx.mem.sessions.delete(token);
      return null;
    }
    touchPlayer(player);
    return player;
  }
  const stored = ctx.db.data.sessions[token];
  if (!stored) return null;
  if (now > stored.expiresAt) {
    delete ctx.db.data.sessions[token];
    ctx.db.markDirty();
    return null;
  }
  const player = ctx.db.data.players[stored.playerId];
  if (!player) {
    delete ctx.db.data.sessions[token];
    return null;
  }
  touchPlayer(player);
  return player;
}

export function destroySession(ctx, token) {
  if (ctx.mem.sessions.delete(token)) return;
  if (ctx.db.data.sessions[token]) {
    delete ctx.db.data.sessions[token];
    ctx.db.markDirty();
  }
}

export function destroyPlayerSessions(ctx, playerId) {
  for (const [token, s] of ctx.mem.sessions) if (s.playerId === playerId) ctx.mem.sessions.delete(token);
  for (const token of Object.keys(ctx.db.data.sessions))
    if (ctx.db.data.sessions[token].playerId === playerId) delete ctx.db.data.sessions[token];
}

// --- world biome -------------------------------------------------------------

// Derived from the wall clock, so every connected player always sees the same
// biome and a server restart cannot desync it.
//
// `override` is the admin panel's hand on the lever: { id, until } forces one
// biome for everyone until it expires (or forever, when until is null). A stale
// or unknown override id falls back to the rotation, never to a crash.
export function currentBiome(content, now = Date.now(), override = null) {
  const rotate = content.rotateMs;
  const slot = Math.floor(now / rotate);
  const endsAt = (slot + 1) * rotate;

  if (override?.id) {
    const forced = content.biomeById?.[override.id] || content.biomes.find((b) => b.id === override.id);
    if (forced && (override.until == null || now < override.until)) {
      const until = override.until ?? endsAt;
      return {
        ...forced,
        startedAt: slot * rotate,
        endsAt: until,
        rotatesInMs: Math.max(0, until - now),
        forced: true,
      };
    }
  }

  const biome = content.biomes[slot % content.biomes.length];
  return {
    ...biome,
    startedAt: slot * rotate,
    endsAt,
    rotatesInMs: endsAt - now,
  };
}

// --- stats ---------------------------------------------------------------------

export function ascendRequirement(ascensions, content) {
  const a = content.ascend;
  return Math.floor(a.requirementBase * Math.pow(a.requirementGrowth, ascensions));
}

export function ascendMultiplier(ascensions, content) {
  return 1 + ascensions * content.ascend.luckPerAscension;
}

export function activeBuffs(player, now = Date.now()) {
  if (!player.buffs) player.buffs = [];
  // A buff with no `until` does not expire on a clock: that is the Heavenly
  // Potion's promise — it waits for your next roll, even across a restart.
  const live = player.buffs.filter((b) => b.until == null || b.until > now);
  if (live.length !== player.buffs.length) player.buffs = live;
  return live;
}

// --- ascend tree -----------------------------------------------------------
// Permanent upgrades bought with Ascend Points. The tree survives every
// ascension — this is what makes ascending feel like progress instead of a
// pure reset. Everything the nodes grant is summed here once and applied in
// deriveStats, so the tree is the only place these bonuses are defined.

export function treeLevels(player) {
  return player.tree && typeof player.tree === 'object' ? player.tree : {};
}

export function treeStats(player, content) {
  const out = { luck: 1, cooldown: 1, rolls: 0, auto: 0, essence: 1, sell: 1, mine: 1, autoMine: 0, unlocks: {} };
  const levels = treeLevels(player);
  for (const [nodeId, level] of Object.entries(levels)) {
    const node = content.treeById?.[nodeId];
    const lv = Number(level) || 0;
    if (!node || lv < 1) continue;
    const eff = node.effect || {};
    const per = Number(eff.perLevel) || 0;
    switch (eff.type) {
      case 'luckMult': out.luck *= 1 + per * lv; break;
      case 'cooldownMult': out.cooldown *= Math.max(0.1, 1 - per * lv); break;
      case 'rollsFlat': out.rolls += per * lv; break;
      case 'autoFlat': out.auto += per * lv; break;
      case 'essenceMult': out.essence *= 1 + per * lv; break;
      case 'sellMult': out.sell *= 1 + per * lv; break;
      case 'mineMult': out.mine *= 1 + per * lv; break;
      case 'mineAuto': out.autoMine += per * lv; break;
      case 'unlock': if (eff.unlock) out.unlocks[eff.unlock] = true; break;
      default: break;
    }
    // Nodes can carry a secondary cooldown crush on top of their main effect.
    if (eff.bonusCooldownMult) out.cooldown *= Math.max(0.1, 1 - eff.bonusCooldownMult * lv);
  }
  return out;
}

export function treeUnlocked(player) {
  return (player.ascensions || 0) >= 1;
}

export function miningUnlocked(player, content) {
  const nodeId = content.mining?.unlockNode || 'mining';
  return (treeLevels(player)[nodeId] || 0) >= 1;
}

export function treeCost(node, level) {
  const growth = Number(node.costGrowth) || 1;
  return Math.max(1, Math.round((Number(node.cost) || 1) * Math.pow(growth, level)));
}

export function buyTreeNode(ctx, player, nodeId) {
  const { content } = ctx;
  const node = content.treeById?.[nodeId];
  if (!node) return { error: 'unknown_node' };
  if (!treeUnlocked(player)) return { error: 'must_ascend' };

  const levels = treeLevels(player);
  const level = levels[nodeId] || 0;
  if (node.maxLevel && level >= node.maxLevel) return { error: 'maxed' };
  for (const req of node.requires || []) {
    if ((levels[req] || 0) < 1) return { error: 'locked', missing: req };
  }

  const cost = treeCost(node, level);
  if ((player.ascendPoints || 0) < cost) {
    return { error: 'not_enough_points', cost, points: player.ascendPoints || 0 };
  }

  player.ascendPoints -= cost;
  player.tree = levels;
  player.tree[nodeId] = level + 1;
  ctx.db.markDirty();

  return {
    ok: true,
    node: nodeId,
    level: level + 1,
    cost,
    points: player.ascendPoints,
    stats: deriveStats(player, content),
    profile: publicProfile(player, ctx),
  };
}

// --- derive -------------------------------------------------------------------

export function deriveStats(player, content, now = Date.now()) {
  const lv = player.levels || {};
  const u = content.upgradeById;
  const g = aggregateGear(player, content); // everything currently equipped
  const t = treeStats(player, content);     // permanent ascend-tree bonuses
  const c = clickerStats(player, content);  // spark-clicker shop bonuses

  const ascendMult = ascendMultiplier(player.ascensions || 0, content);
  let luck = (1 + (lv.luck || 0) * (u.luck?.effect?.perLevel ?? 0.25)) * ascendMult;

  // Two kinds of buff live here. `luckBuff` is a timed multiplier (Luck
  // Elixir), `nextRollLuck` is a flat boost that survives until it has paid
  // for its rolls (Heavenly Potion). The flat bonus lands last, after every
  // multiplier, so "+150,000 Luck" means exactly that whatever you wear.
  let nextRollLuck = 0;
  for (const b of activeBuffs(player, now)) {
    if (b.type === 'luckBuff') luck *= b.mult;
    else if (b.type === 'nextRollLuck') nextRollLuck += Number(b.add) || 0;
  }

  luck *= 1 + g.luck; // equipment: a percentage on top of elixirs, not instead of them
  luck *= t.luck;     // ascend tree: permanent multiplier, the last word
  luck *= c.luck;     // spark clicker: the minigame pays back into the real game
  luck += nextRollLuck;

  const qr = u.quickroll?.effect ?? { baseMs: 1100, factor: 0.87, floorMs: 120 };
  // Roll-speed buffs divide the cooldown down, but never past the upgrade floor —
  // a full mythic set should feel fast, not free. The tree and the clicker
  // multiply on top.
  const cooldownMs = Math.round(
    Math.max(
      qr.floorMs,
      ((qr.baseMs * Math.pow(qr.factor, lv.quickroll || 0)) / (1 + g.cooldown)) * t.cooldown * c.cooldown
    )
  );

  // Auto roll is free for everyone — the upgrade and the tree stack on top.
  const freeAuto = Number(content.config?.freeAutoRoll?.perSec) || 0;

  return {
    luck,
    cooldownMs,
    rollsPerAction: 1 + (lv.multiroll || 0) * (u.multiroll?.effect?.perLevel ?? 1) + g.rolls + t.rolls,
    autoPerSec: freeAuto + (lv.autoroll || 0) * (u.autoroll?.effect?.perLevel ?? 1) + g.auto + t.auto,
    essenceMult: (1 + (lv.essence || 0) * (u.essence?.effect?.perLevel ?? 0.35)) * (1 + g.essence) * t.essence * c.essence,
    sellMult: (1 + g.sell) * t.sell * c.sell,
    ascendMult,
    autoMinePerSec: t.autoMine, // the Automated Drill's cells per second
    autoClickPerSec: c.autoClick, // the clicker's own auto-clicker
    nextRollLuck, // flat luck still pending from one-roll potions
    tree: t, // so the UI can say what the tree contributes
    gear: g, // per-axis breakdown so the UI can say where a bonus came from
    clicker: c, // and the same for the clicker shop
  };
}

// --- one-roll potions (Heavenly Potion and friends) -------------------------
// A `nextRollLuck` buff is not a timer, it is a debt the next roll collects:
// { type: 'nextRollLuck', add: 150000, rolls: 1, until: null }. Drinking a second
// bottle of the same kind banks another charge instead of wasting the first.

export function pendingNextRoll(player, now = Date.now()) {
  let charges = 0;
  for (const b of activeBuffs(player, now)) if (b.type === 'nextRollLuck') charges += Math.max(1, b.rolls || 1);
  return charges;
}

/** Spend one charge of every pending one-roll buff. Returns how many were spent. */
export function consumeNextRollBuffs(player, now = Date.now()) {
  let spent = 0;
  for (const b of activeBuffs(player, now)) {
    if (b.type !== 'nextRollLuck') continue;
    b.rolls = Math.max(1, b.rolls || 1) - 1;
    if (b.rolls <= 0) spent++;
  }
  if (spent) player.buffs = (player.buffs || []).filter((b) => b.type !== 'nextRollLuck' || (b.rolls || 0) > 0);
  return spent;
}

// --- inventory slots -------------------------------------------------------------
// A slot is `{ count, bestOdds, lastOdds, firstAt, lastAt }` plus a snapshot of
// the aura as it looked the moment it landed: name, colour, odds, tier.
//
// `odds` in the snapshot is the aura's *normal* pool odds — that is the number
// the Inventory card advertises. `bestOdds` / `lastOdds` are the luck-bent odds a
// pull actually landed at, which is a fact about the pull and not about the aura,
// so the card keeps them off it and the dossier shows them on click.
//
// The snapshot exists for one reason — DELETED auras. A host editing auras.json
// can drop an id the player already owns, and then nothing about that aura can be
// looked up any more. Instead of a blank card or a lost collection, the slot keeps
// describing itself: it still renders, still sells, and the client files it under
// Special Auras. Content is never rewritten from a player record, so this is a
// copy, not a link.
export function stampAuraSlot(slot, aura) {
  slot.name = aura.name;
  slot.color = aura.color;
  slot.fx = aura.fx;
  slot.odds = aura.odds;
  slot.tier = aura.tier;
  slot.tierName = aura.tierName;
  slot.tierColor = aura.tierColor;
  if (aura.craftOnly) slot.craftOnly = true;
  else delete slot.craftOnly;
  return slot;
}

// --- rolling ---------------------------------------------------------------------

// Per-player "luck off" switch. When disabled, rolls use the base table as
// authored (effective luck 1 — no luck floor, no luck bending). Levels,
// elixirs and tree bonuses keep existing; they are just ignored while off.
export function setLuckEnabled(ctx, player, on) {
  player.luckOff = !on;
  ctx.db.markDirty();
  return { ok: true, luckOff: !!player.luckOff, stats: deriveStats(player, ctx.content), profile: publicProfile(player, ctx) };
}

export function rollForPlayer(ctx, player, requestedCount, now = Date.now()) {
  const { content } = ctx;
  const cfg = content.config;
  const stats = deriveStats(player, content, now);
  const biome = currentBiome(content, now, ctx.mem?.biomeOverride);

  const wanted = Math.floor(Number(requestedCount) || 1);
  const count = Math.min(Math.max(wanted, 1), stats.rollsPerAction, cfg.maxRollsPerRequest ?? 32);

  // Server-side cooldown. The client also gates the button, but this is the
  // authority — a scripted browser cannot roll faster than the cooldown.
  const elapsed = now - (player.lastRollAt || 0);
  if (elapsed < stats.cooldownMs) {
    return { error: 'cooldown', retryInMs: Math.ceil(stats.cooldownMs - elapsed), stats };
  }

  const rollLuck = player.luckOff ? 1 : stats.luck;
  // Flat one-roll boost that is about to be paid out (0 when luck is off —
  // nothing gets boosted, so nothing is owed).
  const potionBoost = player.luckOff ? 0 : stats.nextRollLuck || 0;
  const results = rollMany(count, rollLuck, biome.id, Math.random, content);
  player.lastRollAt = now;
  // The potion pays for the roll it just powered: one charge per roll action,
  // whatever the multi-roll count.
  const potionsSpent = potionBoost ? consumeNextRollBuffs(player, now) : 0;

  const payload = [];
  let essenceGained = 0;
  let newAuras = 0;
  const feedThreshold = cfg.feedOddsThreshold ?? 1000;

  for (const r of results) {
    const aura = content.auraById[r.auraId];
    const payout = essenceFor(r.odds, stats.essenceMult);
    essenceGained += payout;

    const slot = player.inventory[aura.id] || { count: 0, bestOdds: 0, lastOdds: 0, firstAt: now, lastAt: 0 };
    if (slot.count === 0) newAuras++;
    slot.count++;
    slot.lastAt = now;
    // Rarest wins: a higher 1-in-N is a better pull. `lastOdds` remembers the
    // odds of the most recent one, which is what "you got it at" means.
    slot.bestOdds = slot.bestOdds ? Math.max(slot.bestOdds, r.odds) : r.odds;
    slot.lastOdds = r.odds;
    player.inventory[aura.id] = stampAuraSlot(slot, aura);

    if (!player.best || r.odds > player.best.odds) {
      player.best = { auraId: aura.id, odds: r.odds, isBT: r.isBT, at: now };
    }

    payload.push({
      auraId: aura.id,
      name: aura.name,
      odds: r.odds,
      baseOdds: aura.odds,
      isBT: r.isBT,
      biomeLuck: r.biomeLuck,
      essence: payout,
      tier: aura.tier,
      tierName: aura.tierName,
      tierColor: aura.tierColor,
      color: aura.color,
      fx: aura.fx,
      isNew: slot.count === 1,
    });

    ctx.db.data.meta.totalRolls++;

    // Only genuinely interesting rolls reach the global feed.
    if (r.odds >= feedThreshold || slot.count === 1) {
      pushFeed(ctx, {
        id: crypto.randomUUID(),
        player: player.name,
        auraId: aura.id,
        auraName: aura.name,
        color: aura.color,
        tier: aura.tier,
        tierName: aura.tierName,
        odds: r.odds,
        isBT: r.isBT,
        biome: biome.id,
        biomeName: biome.name,
        at: now,
      });
    }
  }

  player.essence += essenceGained;
  player.totalRolls += results.length;
  player.lifetimeRolls = (player.lifetimeRolls || 0) + results.length;
  // Two things only a roll can leave behind: which sky it happened under, and
  // what it paid out. Both outlive the run they happened in.
  seeBiome(player, biome.id);
  tally(player, 'essenceEarned', essenceGained);
  tally(player, 'potions', potionsSpent);
  ctx.db.markDirty();

  const highlight = bestOf(results);

  return {
    results: payload,
    essenceGained,
    newAuras,
    best: highlight ? highlight.auraId : null,
    bestOdds: highlight ? highlight.odds : 0,
    potionBoost,   // flat luck the potions added to this roll
    potionsSpent,  // how many bottles ran dry
    stats,
    biome,
    profile: publicProfile(player, ctx, now),
  };
}

// --- economy: upgrades --------------------------------------------------------

export function buyUpgrade(ctx, player, upgradeId) {
  const { content } = ctx;
  const def = content.upgradeById[upgradeId];
  if (!def) return { error: 'unknown_upgrade' };

  const level = player.levels[upgradeId] || 0;
  if (def.max && level >= def.max) return { error: 'maxed' };

  const cost = upgradeCost(def, level);
  if (player.essence < cost) return { error: 'not_enough_essence', cost, essence: player.essence };

  player.essence -= cost;
  player.levels[upgradeId] = level + 1;
  // Levels are wiped by ascending; how many you ever bought is not.
  tally(player, 'upgradesBought');
  ctx.db.markDirty();

  return {
    ok: true,
    level: level + 1,
    cost,
    stats: deriveStats(player, content),
    profile: publicProfile(player, ctx),
  };
}

export function upgradeCost(def, level) {
  return Math.floor(def.baseCost * Math.pow(def.growth, level));
}

// Ascending resets levels + essence and grants a permanent luck multiplier
// plus Ascend Points for the upgrade tree. The requirement is expressed in
// total rolls: an honest "put in the work" gate rather than a pure luck check.
// Collection, money, records, the tree and the lifetime counters survive.
export function ascendForPlayer(ctx, player) {
  const { content } = ctx;
  const req = ascendRequirement(player.ascensions || 0, content);
  if (player.totalRolls < req) {
    return { error: 'not_ready', required: req, current: player.totalRolls };
  }

  // Points are paid by essence: ascending burns the essence stash, and the
  // bigger the stash the more Ascend Points the burn converts — square-rooted,
  // so hoarding essence pays but never linearly. Money is deliberately kept.
  const a = content.ascend;
  const div = Number(a.pointEssenceDiv) || 10;
  const points = Math.max(1, Math.floor(Math.sqrt(Math.max(0, player.essence || 0) / div)));

  player.ascensions = (player.ascensions || 0) + 1;
  player.ascendPoints = (player.ascendPoints || 0) + points;
  tally(player, 'pointsEarned', points); // the stash gets spent; the total does not
  player.essence = 0;
  player.levels = { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0 };
  player.totalRolls = 0;
  // Deliberately not touched: money, auras, items, buffs, gear — the tree,
  // ascend points, the mining shaft and the lifetime roll counter.
  ctx.db.markDirty();

  return {
    ok: true,
    ascensions: player.ascensions,
    pointsGained: points,
    ascendPoints: player.ascendPoints,
    luckMult: ascendMultiplier(player.ascensions, content),
    stats: deriveStats(player, content),
    profile: publicProfile(player, ctx),
  };
}

// --- mining shaft ----------------------------------------------------------
// A grid of hidden ores with their own odds, unlocked by the Mining License
// tree node. The vein is rolled server-side when it is first needed; each
// pick reveals one cell and pays out that ore's money + essence.

function rollVein(content, rand = Math.random) {
  const ores = content.miningOres || [];
  const cells = Math.max(1, Number(content.mining?.grid?.cells) || 12);
  // Weighted pick: weight = 1/odds, normalised — the same idea as the aura
  // pool, kept tiny and independent so mining has its own honest RNG.
  const weights = ores.map((o) => 1 / Math.max(1, o.odds));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const vein = [];
  for (let i = 0; i < cells; i++) {
    let t = rand() * total;
    let idx = ores.length - 1;
    for (let j = 0; j < ores.length; j++) {
      t -= weights[j];
      if (t <= 0) { idx = j; break; }
    }
    vein.push(ores[idx]?.id || 'stone');
  }
  return { vein, revealed: vein.map(() => false), lastPickAt: 0, autoAt: 0, autoCarry: 0 };
}

/** Everything that multiplies a mining payout: the tree's Rich Veins and the
 *  clicker's Vein Resonance. Luck deliberately stays out — the shaft is its own
 *  RNG, and so is the clicker. */
export function miningMult(player, content) {
  return treeStats(player, content).mine * clickerStats(player, content).mine;
}

export function mineReveal(ctx, player, index, now = Date.now()) {
  const { content } = ctx;
  if (!miningUnlocked(player, content)) return { error: 'locked' };

  if (!player.mining || !Array.isArray(player.mining.vein)) {
    player.mining = rollVein(content);
  }
  const m = player.mining;
  const i = Math.floor(Number(index));
  if (!Number.isInteger(i) || i < 0 || i >= m.vein.length) return { error: 'bad_cell' };
  if (m.revealed[i]) return { error: 'already_revealed' };

  const cd = Number(content.mining?.pickCooldownMs) || 600;
  const elapsed = now - (m.lastPickAt || 0);
  if (elapsed < cd) return { error: 'cooldown', retryInMs: Math.ceil(cd - elapsed) };

  m.revealed[i] = true;
  m.lastPickAt = now;

  const ore = content.oreById[m.vein[i]];
  const mult = miningMult(player, content);
  const money = Math.max(1, Math.round((ore?.money || 1) * mult));
  const essence = Math.max(1, Math.round((ore?.essence || 1) * mult));
  player.money += money;
  player.essence += essence;
  tally(player, 'minePicks');
  tally(player, 'moneyEarned', money);
  tally(player, 'essenceEarned', essence);
  tallyOre(player, ore?.id);

  const depleted = m.revealed.every(Boolean);
  ctx.db.markDirty();

  return {
    ok: true,
    cell: i,
    ore: { id: ore.id, name: ore.name, icon: ore.icon, color: ore.color, odds: ore.odds },
    money,
    essence,
    depleted,
    profile: publicProfile(player, ctx),
  };
}

export function mineReset(ctx, player) {
  const { content } = ctx;
  if (!miningUnlocked(player, content)) return { error: 'locked' };
  player.mining = rollVein(content);
  ctx.db.markDirty();
  return { ok: true, profile: publicProfile(player, ctx) };
}

// --- banked time -------------------------------------------------------------
// Shared accounting for everything that works on its own: the automated drill
// and the clicker's auto clicker. Real elapsed time is converted into whole
// units of work at `rate` per second, capped at `maxBankedMs` per tick so a tab
// that fell asleep for an hour pays an hour and not a week. Because the work is
// bought with time and not with requests, hammering the endpoint cannot earn a
// thing — the second call in the same millisecond simply has nothing to spend.
// The caller writes `autoAt` / `autoCarry` back onto its state object.

function bankedWork(state, now, rate, { maxBankedMs = 0, cap = Infinity } = {}) {
  const since = Number(state.autoAt) || now;
  let elapsed = Math.max(0, now - since);
  if (maxBankedMs > 0) elapsed = Math.min(maxBankedMs, elapsed);
  const budget = (Number(state.autoCarry) || 0) + (elapsed / 1000) * rate;
  const whole = Math.floor(budget);
  // Not a whole unit yet: keep the clock where it was so the fraction is still
  // there next tick, and remember it if this is the first tick of all.
  if (whole < 1) return { whole: 0, autoAt: since, autoCarry: budget };
  const spent = Math.min(whole, cap);
  return {
    whole: spent,
    // Anything the cap left unspent stays banked — as time, so it can be spent
    // by a later tick instead of evaporating.
    autoAt: now - Math.max(0, ((budget - spent) / rate) * 1000),
    autoCarry: 0,
  };
}

/**
 * The Automated Drill (ascend-tree `mineAuto`): digs the unrevealed cells of the
 * current vein on its own, pays them out, and rolls a fresh vein the moment this
 * one runs dry — the shaft keeps running as an idle game while you do something
 * else. Manual picks and the drill share one vein and never fight over it: the
 * drill only ever takes cells nobody has opened.
 */
export function mineAutoTick(ctx, player, now = Date.now()) {
  const { content } = ctx;
  if (!miningUnlocked(player, content)) return { error: 'locked' };

  const rate = treeStats(player, content).autoMine;
  if (!(rate > 0)) return { error: 'no_auto' };

  if (!player.mining || !Array.isArray(player.mining.vein)) {
    player.mining = rollVein(content);
  }
  const m = player.mining;
  const cfg = content.mining?.auto || {};
  const w = bankedWork(m, now, rate, {
    maxBankedMs: Number(cfg.maxBankedMs) || 120000,
    cap: Math.max(1, Number(cfg.maxCellsPerTick) || 60),
  });
  m.autoAt = w.autoAt;
  m.autoCarry = w.autoCarry;
  if (w.whole < 1) {
    return { ok: true, dug: 0, money: 0, essence: 0, finds: [], depleted: false, newVein: false, autoMinePerSec: rate, profile: publicProfile(player, ctx, now) };
  }

  const mult = miningMult(player, content);
  const finds = new Map();
  let money = 0;
  let essence = 0;
  let dug = 0;
  for (let i = 0; i < m.vein.length && dug < w.whole; i++) {
    if (m.revealed[i]) continue;
    m.revealed[i] = true;
    dug++;
    const ore = content.oreById[m.vein[i]];
    const pay = Math.max(1, Math.round((ore?.money || 1) * mult));
    const ess = Math.max(1, Math.round((ore?.essence || 1) * mult));
    money += pay;
    essence += ess;
    const row = finds.get(ore?.id) || {
      id: ore?.id, name: ore?.name, icon: ore?.icon, color: ore?.color, odds: ore?.odds || 1,
      count: 0, money: 0, essence: 0,
    };
    row.count++;
    row.money += pay;
    row.essence += ess;
    finds.set(ore?.id, row);
    tallyOre(player, ore?.id);
  }

  player.money += money;
  player.essence += essence;
  // The drill's digging counts exactly like a pick does — a badge about how
  // much of the shaft you saw should not care which end held the shovel.
  tally(player, 'minePicks', dug);
  tally(player, 'moneyEarned', money);
  tally(player, 'essenceEarned', essence);
  const depleted = m.revealed.every(Boolean);

  // A drill with nothing left to dig just starts a new shaft.
  let newVein = false;
  if (depleted) {
    player.mining = rollVein(content);
    player.mining.autoAt = m.autoAt;
    player.mining.autoCarry = m.autoCarry;
    newVein = true;
  }

  ctx.db.markDirty();
  return {
    ok: true,
    dug,
    money,
    essence,
    // Rarest first — that is the order worth reading in a toast.
    finds: [...finds.values()].sort((a, b) => b.odds - a.odds),
    depleted,
    newVein,
    autoMinePerSec: rate,
    profile: publicProfile(player, ctx, now),
  };
}

// --- spark clicker ----------------------------------------------------------
// A side minigame of its own, unlocked by the Arcade Cabinet tree node and
// defined end to end by content/clicker.json: the currency, the crit rules, the
// auto-click pacing and the whole upgrade shop. Click for Sparks, spend Sparks
// on upgrades. Half the shop makes the clicking stronger; the half that matters
// pays back into the real game — `luck` and `cooldown` are applied in
// deriveStats, exactly like the ascend tree, so a clicker upgrade shows up on
// every roll from here on.
//
// Permanent on purpose: ascending never touches it. It is the one kind of
// progress you earn by doing something other than rolling.

/** Effect types the engine knows how to apply. content.js refuses an upgrade
 *  that asks for anything else, so a typo in the JSON is a load error and not a
 *  silently dead upgrade. */
export const CLICKER_EFFECT_TYPES = [
  'clickFlat', 'clickMult', 'clicksPerClick', 'autoClick', 'critChance', 'critMult',
  'luck', 'cooldown', 'essenceMult', 'sellMult', 'mineMult',
];

export function clickerLevels(player) {
  const c = player.clicker;
  return c && typeof c === 'object' && c.levels && typeof c.levels === 'object' ? c.levels : {};
}

/** The player's clicker record, created on first touch. */
export function clickerOf(player) {
  if (!player.clicker || typeof player.clicker !== 'object') {
    player.clicker = {
      sparks: 0, totalSparks: 0, totalClicks: 0, totalCrits: 0, bestClick: 0,
      levels: {}, lastClickAt: 0, autoAt: 0, autoCarry: 0,
    };
  }
  const st = player.clicker;
  if (!st.levels || typeof st.levels !== 'object') st.levels = {};
  st.sparks = Number(st.sparks) || 0;
  return st;
}

export function clickerUnlocked(player, content) {
  const nodeId = content.clicker?.unlockNode || 'arcade';
  return (treeLevels(player)[nodeId] || 0) >= 1;
}

/** Cost of the next level — same curve the shop advertises. */
export function clickerCost(def, level) {
  const growth = Number(def.growth) || 1;
  return Math.floor((Number(def.baseCost) || 1) * Math.pow(growth, Math.max(0, Number(level) || 0)));
}

/**
 * Everything the clicker shop grants, in one sum. The main-game axes (luck,
 * cooldown, essence, sell, mine) come back as multipliers for deriveStats; the
 * clicker-local ones (sparks per click, clicks per click, crits, auto clicks)
 * are what clickTap and the auto tick spend.
 */
export function clickerStats(player, content) {
  const cfg = content.clicker || {};
  const out = {
    luck: 1, cooldown: 1, essence: 1, sell: 1, mine: 1,
    clickFlat: 0, clickMult: 1, clicksPerClick: 1, autoClick: 0,
    critChance: 0, critMult: 0,
  };
  const levels = clickerLevels(player);
  const byId = content.clickerById || {};
  for (const [id, level] of Object.entries(levels)) {
    const def = byId[id];
    const lv = Number(level) || 0;
    if (!def || lv < 1) continue;
    const eff = def.effect || {};
    const per = Number(eff.perLevel) || 0;
    switch (eff.type) {
      case 'clickFlat': out.clickFlat += per * lv; break;
      case 'clickMult': out.clickMult += per * lv; break;
      case 'clicksPerClick': out.clicksPerClick += per * lv; break;
      case 'autoClick': out.autoClick += per * lv; break;
      case 'critChance': out.critChance += per * lv; break;
      case 'critMult': out.critMult += per * lv; break;
      case 'luck': out.luck *= 1 + per * lv; break;
      case 'cooldown': out.cooldown *= Math.max(0.1, 1 - per * lv); break;
      case 'essenceMult': out.essence *= 1 + per * lv; break;
      case 'sellMult': out.sell *= 1 + per * lv; break;
      case 'mineMult': out.mine *= 1 + per * lv; break;
      default: break;
    }
  }
  // Crits are the clicker's own luck: authored floor, upgrades on top, and a
  // ceiling so a maxed shop cannot turn every click into a lottery win.
  const crit = cfg.crit || {};
  const maxChance = Number(crit.maxChance) || 1;
  out.critChance = Math.min(maxChance, Math.max(0, (Number(crit.baseChance) || 0) + out.critChance));
  out.critMult = (Number(crit.baseMult) || 0) + out.critMult;
  out.clicksPerClick = Math.max(1, Math.floor(out.clicksPerClick));
  out.perClick = Math.max(1, (1 + out.clickFlat) * out.clickMult);
  return out;
}

/** Sparks + shop state as the client draws them. */
export function clickerView(player, content) {
  const st = player.clicker && typeof player.clicker === 'object' ? player.clicker : {};
  const cs = clickerStats(player, content);
  return {
    sparks: Math.floor(Number(st.sparks) || 0),
    totalSparks: Math.floor(Number(st.totalSparks) || 0),
    totalClicks: Math.floor(Number(st.totalClicks) || 0),
    totalCrits: Math.floor(Number(st.totalCrits) || 0),
    bestClick: Math.floor(Number(st.bestClick) || 0),
    levels: { ...clickerLevels(player) },
    perClick: Math.round(cs.perClick * 100) / 100,
    clicksPerClick: cs.clicksPerClick,
    critChance: Math.round(cs.critChance * 10000) / 10000,
    critMult: Math.round(cs.critMult * 100) / 100,
    autoClickPerSec: cs.autoClick,
  };
}

/** Roll `n` clicks and pay them out. Shared by the tap and the auto clicker. */
function rollClicks(n, cs) {
  let gained = 0;
  let crits = 0;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const isCrit = Math.random() < cs.critChance;
    const amount = Math.max(1, Math.round(cs.perClick * (isCrit ? cs.critMult : 1)));
    if (isCrit) crits++;
    gained += amount;
    if (amount > best) best = amount;
  }
  return { gained, crits, best };
}

/** One manual click. Server-authoritative, like everything else here. */
export function clickTap(ctx, player, now = Date.now()) {
  const { content } = ctx;
  if (!clickerUnlocked(player, content)) return { error: 'locked' };

  const st = clickerOf(player);
  const cs = clickerStats(player, content);
  const cd = Math.max(0, Number(content.clicker?.clickCooldownMs) || 0);
  const elapsed = now - (Number(st.lastClickAt) || 0);
  if (elapsed < cd) return { error: 'cooldown', retryInMs: Math.ceil(cd - elapsed) };
  st.lastClickAt = now;

  // One tap resolves every click the shop says it is worth — but never more
  // than the content file allows through a single request.
  const cap = Math.max(1, Number(content.clicker?.maxClicksPerTap) || 1);
  const clicks = Math.min(Math.max(1, Math.floor(cs.clicksPerClick)), cap);
  const { gained, crits, best } = rollClicks(clicks, cs);

  st.sparks += gained;
  st.totalSparks = (Number(st.totalSparks) || 0) + gained;
  st.totalClicks = (Number(st.totalClicks) || 0) + clicks;
  if (best > (Number(st.bestClick) || 0)) st.bestClick = best;
  st.totalCrits = (Number(st.totalCrits) || 0) + crits;
  ctx.db.markDirty();

  return {
    ok: true,
    clicks,
    crits,
    crit: crits > 0,
    gained,
    best,
    sparks: Math.floor(st.sparks),
    clicker: clickerView(player, content),
    stats: deriveStats(player, content, now),
    profile: publicProfile(player, ctx, now),
  };
}

/**
 * The clicker's auto clicker: banked real time converted into clicks, so it
 * keeps earning on a background tab and cannot be farmed by spamming the route.
 */
export function clickAutoTick(ctx, player, now = Date.now()) {
  const { content } = ctx;
  if (!clickerUnlocked(player, content)) return { error: 'locked' };

  const st = clickerOf(player);
  const cs = clickerStats(player, content);
  const rate = cs.autoClick;
  if (!(rate > 0)) return { error: 'no_auto' };

  const cfg = content.clicker?.auto || {};
  const w = bankedWork(st, now, rate, {
    maxBankedMs: Number(cfg.maxBankedMs) || 120000,
    cap: Math.max(1, Number(cfg.maxClicksPerTick) || 400),
  });
  st.autoAt = w.autoAt;
  st.autoCarry = w.autoCarry;
  if (w.whole < 1) {
    return { ok: true, clicks: 0, crits: 0, gained: 0, sparks: Math.floor(st.sparks), autoClickPerSec: rate, clicker: clickerView(player, content), profile: publicProfile(player, ctx, now) };
  }

  const { gained, crits, best } = rollClicks(w.whole, cs);
  st.sparks += gained;
  st.totalSparks = (Number(st.totalSparks) || 0) + gained;
  st.totalClicks = (Number(st.totalClicks) || 0) + w.whole;
  if (best > (Number(st.bestClick) || 0)) st.bestClick = best;
  st.totalCrits = (Number(st.totalCrits) || 0) + crits;
  ctx.db.markDirty();

  return {
    ok: true,
    clicks: w.whole,
    crits,
    gained,
    best,
    sparks: Math.floor(st.sparks),
    autoClickPerSec: rate,
    clicker: clickerView(player, content),
    profile: publicProfile(player, ctx, now),
  };
}

export function buyClickerUpgrade(ctx, player, upgradeId) {
  const { content } = ctx;
  const def = content.clickerById?.[upgradeId];
  if (!def) return { error: 'unknown_upgrade' };
  if (!clickerUnlocked(player, content)) return { error: 'locked' };

  const st = clickerOf(player);
  const level = Number(st.levels[upgradeId]) || 0;
  if (def.max && level >= def.max) return { error: 'maxed', level, max: def.max };

  const cost = clickerCost(def, level);
  if (st.sparks < cost) return { error: 'not_enough_sparks', cost, sparks: Math.floor(st.sparks) };

  st.sparks -= cost;
  st.levels[upgradeId] = level + 1;
  ctx.db.markDirty();

  return {
    ok: true,
    upgrade: upgradeId,
    level: level + 1,
    cost,
    sparks: Math.floor(st.sparks),
    stats: deriveStats(player, content),
    clicker: clickerView(player, content),
    profile: publicProfile(player, ctx),
  };
}

// --- economy: selling -----------------------------------------------------------

export function sellAura(ctx, player, auraId, count) {
  const { content } = ctx;
  const aura = content.auraById[auraId];
  const slot = player.inventory[auraId];
  // An id the game never had and this player never held is a typo, not a sale.
  if (!aura && !slot) return { error: 'unknown_aura' };
  if (!slot || slot.count < 1) return { error: 'nothing_to_sell' };

  // A DELETED aura still sells. Once the host drops an id from auras.json there
  // is no definition to price it from, so the slot's own snapshot is used —
  // otherwise removing content would silently freeze part of a collection.
  const odds = aura ? aura.odds : Number(slot.odds) || 1;

  const n = Math.min(Math.floor(Number(count) || 1), slot.count);
  if (n < 1) return { error: 'nothing_to_sell' };

  // Gear "sell" buffs lift the price; with nothing equipped sellMult is 1 and
  // the payout is exactly the shop curve.
  const { sellMult } = deriveStats(player, content);
  const unit = Math.max(1, Math.round(sellPrice(content.sell, odds) * sellMult));
  const total = unit * n;
  slot.count -= n;
  if (slot.count <= 0) delete player.inventory[auraId];
  player.money += total;
  tally(player, 'sells', n);
  tally(player, 'moneyEarned', total);
  ctx.db.markDirty();

  return { ok: true, sold: n, unit, gained: total, profile: publicProfile(player, ctx) };
}

// --- economy: crafting ------------------------------------------------------------

export function craftRecipe(ctx, player, recipeId) {
  const { content } = ctx;
  const recipe = content.recipeById[recipeId];
  if (!recipe) return { error: 'unknown_recipe' };

  // Check everything first — a craft is all-or-nothing.
  for (const inp of recipe.inputs || []) {
    const have = inp.aura
      ? player.inventory[inp.aura]?.count || 0
      : player.items[inp.item] || 0;
    if (have < inp.count) {
      return { error: 'missing_inputs', need: inp, have };
    }
  }
  const moneyCost = recipe.money || 0;
  if (player.money < moneyCost) {
    return { error: 'not_enough_money', cost: moneyCost, money: player.money };
  }
  // Gear is a pile of unique instances, so it needs a ceiling or a long-running
  // account grows db.json forever. Checked before paying, like everything else.
  if (recipe.output?.gear && (player.gear?.length || 0) >= GEAR_CAP) {
    return { error: 'gear_full', cap: GEAR_CAP, owned: player.gear?.length || 0 };
  }

  // Pay.
  for (const inp of recipe.inputs || []) {
    if (inp.aura) {
      const slot = player.inventory[inp.aura];
      slot.count -= inp.count;
      if (slot.count <= 0) delete player.inventory[inp.aura];
    } else {
      player.items[inp.item] -= inp.count;
      if (player.items[inp.item] <= 0) delete player.items[inp.item];
    }
  }
  player.money -= moneyCost;

  // Receive.
  const out = recipe.output;
  const outCount = out.count || 1;
  let received;
  if (out.aura) {
    const aura = content.auraById[out.aura];
    const slot = player.inventory[aura.id] || { count: 0, bestOdds: 0, lastOdds: 0, firstAt: Date.now(), lastAt: 0 };
    slot.count += outCount;
    slot.lastAt = Date.now();
    slot.bestOdds = slot.bestOdds ? Math.max(slot.bestOdds, aura.odds) : aura.odds;
    // A forge output was never rolled, so the odds it "landed at" are its normal
    // pool odds — the dossier says so instead of inventing a lucky number.
    slot.lastOdds = aura.odds;
    player.inventory[aura.id] = stampAuraSlot(slot, aura);
    received = { kind: 'aura', auraId: aura.id, name: aura.name, color: aura.color, count: outCount };
  } else if (out.gear) {
    received = craftGear(player, content, out);
  } else {
    const item = content.itemById[out.item];
    player.items[item.id] = (player.items[item.id] || 0) + outCount;
    received = { kind: 'item', itemId: item.id, name: item.name, icon: item.icon, count: outCount };
  }

  tally(player, 'crafts');
  // One craft, one instance — gear is rolled per piece, never stacked.
  if (out.gear) tally(player, 'gearCrafted');
  ctx.db.markDirty();
  return { ok: true, recipeId, received, profile: publicProfile(player, ctx) };
}

// --- gear: wearing and scrapping ---------------------------------------------------
// Equipment is a list of rolled instances, not a stack count: the buffs are rolled
// per craft, so *which* glove you own matters and equipping is a pointer
// (player.equipped[slot] -> uid), never a quantity. One piece per slot.

const GEAR_CAP = 120;

function findGear(player, uid) {
  return (player.gear || []).find((g) => g && g.uid === uid) || null;
}

// A craft produces a one-off instance — two Luck Gloves are never the same glove.
function craftGear(player, content, out) {
  const piece = content.gearById[out.gear];
  const qualityId = pickQuality(out.qualities) || content.gearQualities[0]?.id || 'fine';
  const quality = content.gearQualityById[qualityId] || content.gearQualities[0];
  const inst = rollGear(piece, quality);

  player.gear = Array.isArray(player.gear) ? player.gear : [];
  player.gear.push(inst);
  player.equipped = player.equipped && typeof player.equipped === 'object' ? player.equipped : {};
  // Drop it into an empty slot so a fresh craft does something the moment it
  // lands; replacing what was already worn stays a deliberate click.
  const equipped = !player.equipped[inst.slot];
  if (equipped) player.equipped[inst.slot] = inst.uid;

  const view = gearView(player, content).find((v) => v.uid === inst.uid) || {};
  return {
    kind: 'gear',
    uid: inst.uid,
    pieceId: piece.id,
    name: piece.name,
    icon: piece.icon,
    slot: inst.slot,
    quality: view.quality,
    buffs: view.buffs || [],
    value: view.value,
    equipped,
  };
}

// The admin panel's forge: hand over one specific piece at a chosen quality
// (default: the best quality the game knows). It produces exactly the instance
// shape a craft produces, so nothing downstream can tell the difference.
export function grantGear(player, content, pieceId, qualityId = null) {
  const piece = content.gearById?.[pieceId];
  if (!piece) return { error: 'unknown_gear_piece' };
  if ((player.gear?.length || 0) >= GEAR_CAP) {
    return { error: 'gear_full', cap: GEAR_CAP, owned: player.gear?.length || 0 };
  }
  const qualities = content.gearQualities || [];
  const quality = (qualityId ? content.gearQualityById?.[qualityId] : null) || qualities[qualities.length - 1];

  const inst = rollGear(piece, quality);
  player.gear = Array.isArray(player.gear) ? player.gear : [];
  player.gear.push(inst);
  player.equipped = player.equipped && typeof player.equipped === 'object' ? player.equipped : {};
  const equipped = !player.equipped[inst.slot];
  if (equipped) player.equipped[inst.slot] = inst.uid;

  const view = gearView(player, content).find((v) => v.uid === inst.uid) || {};
  return {
    ok: true,
    kind: 'gear',
    uid: inst.uid,
    pieceId: piece.id,
    name: piece.name,
    icon: piece.icon,
    slot: inst.slot,
    quality: view.quality,
    buffs: view.buffs || [],
    value: view.value,
    equipped,
  };
}

export function equipGear(ctx, player, uid) {
  const { content } = ctx;
  const inst = findGear(player, uid);
  if (!inst) return { error: 'unknown_gear' };
  const slot = inst.slot || content.gearById[inst.pieceId]?.slot;
  if (!content.gearSlotById?.[slot]) return { error: 'unknown_slot', slot };

  player.equipped = player.equipped && typeof player.equipped === 'object' ? player.equipped : {};
  const previous = player.equipped[slot];
  player.equipped[slot] = inst.uid;
  ctx.db.markDirty();
  // `swapped` lets the UI say "glove for glove" instead of silently losing a slot.
  return { ok: true, slot, equipped: inst.uid, swapped: previous && previous !== inst.uid ? previous : null, profile: publicProfile(player, ctx) };
}

export function unequipGear(ctx, player, uid) {
  const inst = findGear(player, uid);
  if (!inst) return { error: 'unknown_gear' };
  const equipped = player.equipped && typeof player.equipped === 'object' ? player.equipped : {};
  const slot = Object.keys(equipped).find((s) => equipped[s] === inst.uid);
  if (!slot) return { error: 'not_equipped', uid };
  delete equipped[slot];
  ctx.db.markDirty();
  return { ok: true, slot, unequipped: inst.uid, profile: publicProfile(player, ctx) };
}

// Scrap it for money. The number is the same one the card shows, because both go
// through gearValue — no surprise at the counter.
export function salvageGear(ctx, player, uid) {
  const { content } = ctx;
  const inst = findGear(player, uid);
  if (!inst) return { error: 'unknown_gear' };

  const piece = content.gearById?.[inst.pieceId] || {};
  const quality = content.gearQualityById?.[inst.quality] || {};
  const gained = gearValue(piece, inst, quality, content.gearSalvage);

  const equipped = player.equipped && typeof player.equipped === 'object' ? player.equipped : {};
  const slot = Object.keys(equipped).find((s) => equipped[s] === inst.uid);
  if (slot) delete equipped[slot];
  player.gear = (player.gear || []).filter((g) => g.uid !== inst.uid);
  player.money += gained;
  tally(player, 'moneyEarned', gained);
  ctx.db.markDirty();

  return {
    ok: true,
    salvaged: inst.uid,
    name: piece.name || inst.pieceId,
    icon: piece.icon || '🧧',
    gained,
    profile: publicProfile(player, ctx),
  };
}

// --- economy: shop + items ---------------------------------------------------------

export function buyItem(ctx, player, itemId) {
  const { content } = ctx;
  const item = content.itemById[itemId];
  if (!item) return { error: 'unknown_item' };
  if (player.money < item.buyPrice) {
    return { error: 'not_enough_money', cost: item.buyPrice, money: player.money };
  }
  player.money -= item.buyPrice;
  player.items[item.id] = (player.items[item.id] || 0) + 1;
  ctx.db.markDirty();
  return { ok: true, item: item.id, profile: publicProfile(player, ctx) };
}

export function useItem(ctx, player, itemId, now = Date.now()) {
  const { content } = ctx;
  const item = content.itemById[itemId];
  if (!item) return { error: 'unknown_item' };
  if (!player.items[itemId] || player.items[itemId] < 1) return { error: 'no_item' };

  const eff = item.effect || {};
  let applied;
  if (eff.type === 'luckBuff') {
    player.buffs = player.buffs || [];
    // Re-using refreshes the duration instead of stacking.
    const existing = player.buffs.find((b) => b.type === 'luckBuff' && b.mult === eff.mult);
    const until = now + (eff.durationMs || 0);
    if (existing) existing.until = Math.max(existing.until, until);
    else player.buffs.push({ type: 'luckBuff', mult: eff.mult, until });
    applied = { type: 'luckBuff', mult: eff.mult, until };
  } else if (eff.type === 'nextRollLuck') {
    // Heavenly Potion: a flat luck boost the next roll collects. No timer —
    // it waits in the bottle until you actually roll, even across a restart.
    player.buffs = player.buffs || [];
    const add = Number(eff.add) || 0;
    const rolls = Math.max(1, Math.floor(Number(eff.rolls) || 1));
    const existing = player.buffs.find((b) => b.type === 'nextRollLuck' && b.add === add);
    if (existing) {
      // Same bottle twice banks another charge instead of overwriting the first.
      existing.rolls = Math.max(1, existing.rolls || 1) + rolls;
      applied = { type: 'nextRollLuck', add, rolls: existing.rolls };
    } else {
      player.buffs.push({ type: 'nextRollLuck', add, rolls, until: null });
      applied = { type: 'nextRollLuck', add, rolls };
    }
  } else if (eff.type === 'essence') {
    player.essence += eff.amount || 0;
    tally(player, 'essenceEarned', eff.amount || 0);
    applied = { type: 'essence', amount: eff.amount || 0 };
  } else {
    return { error: 'unknown_effect' };
  }

  // Counted only once the effect actually landed — an unknown effect above
  // returns early and the bottle is still in the bag.
  tally(player, 'itemsUsed');
  player.items[itemId] -= 1;
  if (player.items[itemId] <= 0) delete player.items[itemId];
  ctx.db.markDirty();
  return {
    ok: true,
    item: itemId,
    applied,
    stats: deriveStats(player, content, now),
    profile: publicProfile(player, ctx, now),
  };
}

// --- feed + leaderboard -------------------------------------------------------------

export function pushFeed(ctx, entry) {
  const limit = ctx.content.config.feedLimit ?? 60;
  const all = ctx.db.data.feed;
  all.unshift(entry);
  if (all.length > limit) all.length = limit;
  // A roll is the one moment there is certainly a write happening, so the age
  // sweep rides along for free.
  pruneFeed(ctx);
}

// Incremental poll: everything newer than the entry the client last saw.
// Always chronological (newest first) — pinning is a display concern, and the
// client's "after=" cursor depends on this order.
export function feedSince(ctx, afterId) {
  // The most frequent read there is, and the one that has to answer "what is on
  // the feed *now*" — so it prunes first. A cursor that has aged out simply
  // re-sends the whole feed, which is what the client does with a first poll.
  pruneFeed(ctx);
  if (!afterId) return ctx.db.data.feed;
  const idx = ctx.db.data.feed.findIndex((e) => e.id === afterId);
  if (idx === -1) return ctx.db.data.feed;
  return ctx.db.data.feed.slice(0, idx);
}

// --- feed pinning ----------------------------------------------------------------
// A big pull holds the top of the world feed for a while instead of being buried
// by the next dozen commons. The window scales with how rare the pull was
// (content/config.json → feedPin.tiers) and an entry keeps the longest tier it
// clears. When the window runs out the entry is not removed — it simply rejoins
// the chronological list wherever it falls, until the feed TTL below sweeps it
// off the ticker for good.

// Milliseconds this entry still gets to sit at the top; 0 once its window is up.
export function feedHoldMs(cfg, entry) {
  const tiers = cfg?.feedPin?.tiers || [];
  let hold = 0;
  for (const t of tiers) if (entry.odds >= t.minOdds && t.holdMs > hold) hold = t.holdMs;
  return hold;
}

export function feedIsPinned(cfg, entry, now = Date.now()) {
  return now - entry.at < feedHoldMs(cfg, entry);
}

// Pinned entries first (rarest pull wins), then everything else newest-first.
export function feedOrder(entries, cfg, now = Date.now()) {
  return [...entries].sort((a, b) => {
    const pa = feedIsPinned(cfg, a, now);
    const pb = feedIsPinned(cfg, b, now);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb && a.odds !== b.odds) return b.odds - a.odds;
    return b.at - a.at;
  });
}

// --- feed expiry ----------------------------------------------------------------
// The feed is a ticker, not a ledger. Before this the only thing that ever
// cleared it was the 60-entry cap, so on a quiet day the panel still greeted you
// with last week's rolls. Anything older than config.json → feedTtl.ms is gone.
//
// Two exemptions, both deliberate:
//   • A pull still holding its pin is never cut while it holds. The feed is
//     shouting about that row right now; deleting it mid-shout is the wrong kind
//     of tidy. It leaves on the next prune after its window lapses.
//   • A staff announcement is not a roll. Nobody can ask the admin to post it
//     again, so it stays until the cap pushes it out — unless the host sets
//     feedTtl.keepAnnouncements to false.

/** The window a roll is kept for; 0 or less switches expiry off entirely. */
export function feedTtlMs(cfg) {
  const ms = Number(cfg?.feedTtl?.ms);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function feedIsExpired(cfg, entry, now = Date.now()) {
  const ttl = feedTtlMs(cfg);
  if (!ttl) return false;
  if (entry.announcement && cfg?.feedTtl?.keepAnnouncements !== false) return false;
  if (feedIsPinned(cfg, entry, now)) return false;
  return now - (Number(entry.at) || 0) > ttl;
}

/**
 * Drop whatever has aged out and say how much went.
 *
 * Called on write (pushFeed) and on the two read paths, because a server nobody
 * is rolling on is exactly the server whose feed has gone stale — and pruning on
 * the way out is the same bargain activeBuffs() already strikes: the read is the
 * moment we are certain what is still true.
 */
export function pruneFeed(ctx, now = Date.now()) {
  const cfg = ctx.content.config;
  if (!feedTtlMs(cfg)) return 0;
  const all = ctx.db.data.feed;
  if (!all.length) return 0;
  const kept = all.filter((e) => !feedIsExpired(cfg, e, now));
  const cut = all.length - kept.length;
  if (cut) {
    ctx.db.data.feed = kept;
    ctx.db.markDirty();
  }
  return cut;
}

// What a fresh page load shows: the newest slice, plus anything still holding the
// top so a busy feed can never push a live pin off screen.
export function worldFeed(ctx, limit = 25) {
  const cfg = ctx.content.config;
  const now = Date.now();
  pruneFeed(ctx, now);
  const all = ctx.db.data.feed;
  const head = all.slice(0, limit);
  const seen = new Set(head.map((e) => e.id));
  const held = all.filter((e) => !seen.has(e.id) && feedIsPinned(cfg, e, now));
  return feedOrder([...head, ...held], cfg, now);
}

// --- global leaderboard -------------------------------------------------------------
// One row per player, in no particular order. Everything the board can rank by lives
// on the row, so adding a column never means touching the query again.
export function leaderboardRows(ctx) {
  const { content } = ctx;
  return Object.values(allPlayers(ctx))
    .filter((p) => p.totalRolls > 0 || p.best)
    .map((p) => {
      const stats = deriveStats(p, content);
      const unique = Object.keys(p.inventory).length;
      const ach = achievementSummary(p, content);
      return {
        id: p.id,
        name: p.name,
        guest: !!p.guest,
        totalRolls: p.totalRolls,
        essence: Math.floor(p.essence),
        money: Math.floor(p.money),
        ascensions: p.ascensions || 0,
        luck: stats.luck,
        unique,
        totalAuras: content.allAuras.length,
        gear: (p.gear || []).length,
        achPoints: ach.points,
        achUnlocked: ach.unlocked,
        bestAuraId: p.best ? p.best.auraId : null,
        bestOdds: p.best ? p.best.odds : null,
      };
    });
}

// Every way the board can be ranked. Higher `value` wins; the tie-break chain is
// shared, so two refreshes never shuffle equal scores around.
export const LB_SORTS = [
  { id: 'best', name: 'Rarest pull', icon: '💎', value: (r) => (r.bestOdds === null ? -Infinity : r.bestOdds) },
  { id: 'rolls', name: 'Total rolls', icon: '🎲', value: (r) => r.totalRolls },
  { id: 'unique', name: 'Auras found', icon: '📚', value: (r) => r.unique },
  // Achievement Points — the only column that ranks what you *did* rather than
  // what you happen to be holding right now.
  { id: 'ach', name: 'Achievements', icon: '🏆', value: (r) => r.achPoints },
  { id: 'luck', name: 'Luck', icon: '🍀', value: (r) => r.luck },
  { id: 'essence', name: 'Essence', icon: '💠', value: (r) => r.essence },
  { id: 'money', name: 'Money', icon: '💰', value: (r) => r.money },
  { id: 'ascend', name: 'Ascensions', icon: '🌀', value: (r) => r.ascensions },
  { id: 'gear', name: 'Gear', icon: '🧤', value: (r) => r.gear },
];

const LB_SORT_BY_ID = Object.fromEntries(LB_SORTS.map((s) => [s.id, s]));

function sortRows(rows, sortId) {
  const value = (LB_SORT_BY_ID[sortId] || LB_SORTS[0]).value;
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av !== bv) return bv - av;
    if (a.unique !== b.unique) return b.unique - a.unique;
    if (a.totalRolls !== b.totalRolls) return b.totalRolls - a.totalRolls;
    return String(a.name).localeCompare(String(b.name));
  });
}

// Ranked list, best first. Returns a plain array — `world()` and the client
// renderer both treat it as one.
export function leaderboard(ctx, limit = 25, sortId = 'best') {
  return sortRows(leaderboardRows(ctx), sortId).slice(0, limit);
}

// The board with its chrome: which sort produced it, what else you could sort by,
// and where *you* sit when you are not in the top slice at all.
export function leaderboardBoard(ctx, { sort = 'best', limit = 25, viewerId = null } = {}) {
  const rows = sortRows(leaderboardRows(ctx), sort);
  const top = rows.slice(0, Math.max(1, Math.min(Number(limit) || 25, 100)));
  let you = null;
  if (viewerId) {
    const idx = rows.findIndex((r) => r.id === viewerId);
    if (idx >= 0) you = { rank: idx + 1, row: rows[idx], inTop: idx < top.length };
  }
  return {
    sort: LB_SORT_BY_ID[sort] ? sort : 'best',
    sorts: LB_SORTS.map(({ id, name, icon }) => ({ id, name, icon })),
    rows: top,
    you,
    total: rows.length,
  };
}

// --- achievements -------------------------------------------------------------
// Badges are settled here, in the one place every mutation already passes
// through on its way out, instead of from a dozen call sites that someone
// would eventually forget. This is the same bargain activeBuffs() strikes
// above — pruning expired buffs while "reading": serialising a player is the
// moment the server is certain what they have earned, so it is the moment it
// says so out loud.
//
// Rewards are paid *before* the profile is built, so the money and essence a
// badge just granted are already inside the numbers the client adopts. One
// response, no second round trip, and a client that never has to ask twice.
function settlePlayerAchievements(player, ctx, stats, now) {
  const res = settleAchievements(player, ctx.content, stats, now);
  if (!res.unlocked.length) return res;
  ctx.db.markDirty();

  // Only the tiers marked `announce` reach the world feed, and only the best
  // of a batch: one roll can finish half a dozen badges and the ticker is not
  // a wall of text. They ride the feed as announcements — a sentence, not a
  // pull — so the renderer shows no "rolled" and no odds.
  const tiers = ctx.content.achievementTierById || {};
  const loud = res.unlocked
    .filter((d) => tiers[d.tier]?.announce)
    .sort((a, b) => b.points - a.points)[0];
  if (loud) {
    pushFeed(ctx, {
      id: crypto.randomUUID(),
      player: player.name,
      achievement: true,
      announcement: true,
      auraName: `${loud.icon || '🏅'} ${loud.name}`,
      color: tiers[loud.tier]?.color || '#fbd24a',
      odds: 0,
      biomeName: 'Achievements',
      at: now,
    });
  }
  return res;
}

/** The whole board for one player: every badge, measured, with its score. */
export function achievementsView(ctx, player, now = Date.now()) {
  const stats = deriveStats(player, ctx.content, now);
  return {
    rows: achievementRows(player, ctx.content, stats),
    ...achievementSummary(player, ctx.content),
  };
}

// --- serialisation -------------------------------------------------------------------

export function publicProfile(player, ctx, now = Date.now()) {
  const { content } = ctx;
  const stats = deriveStats(player, content, now);
  // May add money and essence, so it has to happen before they are read below.
  settlePlayerAchievements(player, ctx, stats, now);
  const unique = Object.keys(player.inventory).length;
  const req = ascendRequirement(player.ascensions || 0, content);
  const m = player.mining;
  return {
    id: player.id,
    name: player.name,
    guest: !!player.guest,
    createdAt: player.createdAt,
    essence: Math.floor(player.essence),
    money: Math.floor(player.money),
    totalRolls: player.totalRolls,
    lifetimeRolls: player.lifetimeRolls || 0,
    quickRollUnlocked:
      (player.lifetimeRolls || 0) >= (content.config?.quickRoll?.unlockRolls ?? 100),
    ascensions: player.ascensions || 0,
    ascendPoints: player.ascendPoints || 0,
    treeUnlocked: treeUnlocked(player),
    tree: { ...treeLevels(player) },
    miningUnlocked: miningUnlocked(player, content),
    mining: m && Array.isArray(m.vein)
      ? { vein: m.vein, revealed: [...(m.revealed || [])], depleted: (m.revealed || []).every(Boolean) }
      : null,
    clickerUnlocked: clickerUnlocked(player, content),
    clicker: clickerView(player, content),
    luckOff: !!player.luckOff,
    // Purely a display hint — every /api/admin/* call re-checks the list, so
    // revoking a name takes effect on the admin's very next request.
    isAdmin: isAdmin(ctx, player),
    levels: player.levels,
    inventory: player.inventory,
    items: player.items,
    gear: gearView(player, content),
    equipped: { ...(player.equipped || {}) },
    buffs: activeBuffs(player, now).map((b) => ({
      type: b.type,
      mult: b.mult,
      until: b.until,
      add: b.add,
      rolls: b.rolls,
    })),
    best: player.best,
    // achievementId -> the moment it unlocked. The client diffs this map
    // between responses and toasts whatever is new; the progress bars live in
    // a separate on-demand call (GET /api/achievements) so the hot roll path
    // never carries 50 measurements it has no room to show.
    achievements: { ...(player.achievements || {}) },
    stats: {
      luck: stats.luck,
      cooldownMs: stats.cooldownMs,
      rollsPerAction: stats.rollsPerAction,
      autoPerSec: stats.autoPerSec,
      essenceMult: stats.essenceMult,
      sellMult: stats.sellMult,
      ascendMult: stats.ascendMult,
      autoMinePerSec: stats.autoMinePerSec,
      autoClickPerSec: stats.autoClickPerSec,
      nextRollLuck: stats.nextRollLuck,
      tree: stats.tree,
      gear: stats.gear,
      clicker: stats.clicker,
    },
    unique,
    totalAuras: content.allAuras.length,
    ascendRequirement: req,
    canAscend: player.totalRolls >= req,
  };
}

export { sellPrice };
