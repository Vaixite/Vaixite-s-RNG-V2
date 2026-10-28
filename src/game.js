import crypto from 'node:crypto';
import { effectiveOdds, rollMany, bestOf, essenceFor, sellPrice } from './roll.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';

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

const NAME_ALLOWED = /[^a-z0-9_.-]/gi;

// --- players ---------------------------------------------------------------

export function cleanName(raw, cfg) {
  const base = String(raw || '').replace(NAME_ALLOWED, '').replace(/\s+/g, ' ').trim();
  if (base.length < (cfg.nameMin ?? 3)) return '';
  return base.slice(0, cfg.nameMax ?? 18);
}

function basePlayer(name) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    lastSeenAt: now,
    essence: 0,
    money: 0,
    totalRolls: 0,
    ascensions: 0,
    levels: { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0 },
    inventory: {},
    items: {},
    buffs: [],
    best: null,
    lastRollAt: 0,
  };
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
export function currentBiome(content, now = Date.now()) {
  const rotate = content.rotateMs;
  const slot = Math.floor(now / rotate);
  const biome = content.biomes[slot % content.biomes.length];
  return {
    ...biome,
    startedAt: slot * rotate,
    endsAt: (slot + 1) * rotate,
    rotatesInMs: (slot + 1) * rotate - now,
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
  const live = player.buffs.filter((b) => b.until > now);
  if (live.length !== player.buffs.length) player.buffs = live;
  return live;
}

export function deriveStats(player, content, now = Date.now()) {
  const lv = player.levels || {};
  const u = content.upgradeById;

  const ascendMult = ascendMultiplier(player.ascensions || 0, content);
  let luck = (1 + (lv.luck || 0) * (u.luck?.effect?.perLevel ?? 0.25)) * ascendMult;
  for (const b of activeBuffs(player, now)) if (b.type === 'luckBuff') luck *= b.mult;

  const qr = u.quickroll?.effect ?? { baseMs: 1100, factor: 0.87, floorMs: 120 };
  const cooldownMs = Math.max(qr.floorMs, qr.baseMs * Math.pow(qr.factor, lv.quickroll || 0));

  return {
    luck,
    cooldownMs,
    rollsPerAction: 1 + (lv.multiroll || 0) * (u.multiroll?.effect?.perLevel ?? 1),
    autoPerSec: (lv.autoroll || 0) * (u.autoroll?.effect?.perLevel ?? 1),
    essenceMult: 1 + (lv.essence || 0) * (u.essence?.effect?.perLevel ?? 0.35),
    ascendMult,
  };
}

// --- rolling ---------------------------------------------------------------------

export function rollForPlayer(ctx, player, requestedCount, now = Date.now()) {
  const { content } = ctx;
  const cfg = content.config;
  const stats = deriveStats(player, content, now);
  const biome = currentBiome(content, now);

  const wanted = Math.floor(Number(requestedCount) || 1);
  const count = Math.min(Math.max(wanted, 1), stats.rollsPerAction, cfg.maxRollsPerRequest ?? 32);

  // Server-side cooldown. The client also gates the button, but this is the
  // authority — a scripted browser cannot roll faster than the cooldown.
  const elapsed = now - (player.lastRollAt || 0);
  if (elapsed < stats.cooldownMs) {
    return { error: 'cooldown', retryInMs: Math.ceil(stats.cooldownMs - elapsed), stats };
  }

  const results = rollMany(count, stats.luck, biome.id, Math.random, content);
  player.lastRollAt = now;

  const payload = [];
  let essenceGained = 0;
  let newAuras = 0;
  const feedThreshold = cfg.feedOddsThreshold ?? 1000;

  for (const r of results) {
    const aura = content.auraById[r.auraId];
    const payout = essenceFor(r.odds, stats.essenceMult);
    essenceGained += payout;

    const slot = player.inventory[aura.id] || { count: 0, bestOdds: 0, firstAt: now, lastAt: 0 };
    if (slot.count === 0) newAuras++;
    slot.count++;
    slot.lastAt = now;
    // Rarest wins: a higher 1-in-N is a better pull.
    slot.bestOdds = slot.bestOdds ? Math.max(slot.bestOdds, r.odds) : r.odds;
    player.inventory[aura.id] = slot;

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
  ctx.db.markDirty();

  const highlight = bestOf(results);

  return {
    results: payload,
    essenceGained,
    newAuras,
    best: highlight ? highlight.auraId : null,
    bestOdds: highlight ? highlight.odds : 0,
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

// Ascending resets levels + essence and grants a permanent luck multiplier.
// The requirement is expressed in total rolls: an honest "put in the work"
// gate rather than a pure luck check. Collection, money and records survive.
export function ascendForPlayer(ctx, player) {
  const { content } = ctx;
  const req = ascendRequirement(player.ascensions || 0, content);
  if (player.totalRolls < req) {
    return { error: 'not_ready', required: req, current: player.totalRolls };
  }

  player.ascensions = (player.ascensions || 0) + 1;
  player.essence = 0;
  player.levels = { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0 };
  player.totalRolls = 0;
  ctx.db.markDirty();

  return {
    ok: true,
    ascensions: player.ascensions,
    luckMult: ascendMultiplier(player.ascensions, content),
    stats: deriveStats(player, content),
    profile: publicProfile(player, ctx),
  };
}

// --- economy: selling -----------------------------------------------------------

export function sellAura(ctx, player, auraId, count) {
  const { content } = ctx;
  const aura = content.auraById[auraId];
  if (!aura) return { error: 'unknown_aura' };
  const slot = player.inventory[auraId];
  if (!slot || slot.count < 1) return { error: 'nothing_to_sell' };

  const n = Math.min(Math.floor(Number(count) || 1), slot.count);
  if (n < 1) return { error: 'nothing_to_sell' };

  const unit = sellPrice(content.sell, aura.odds);
  const total = unit * n;
  slot.count -= n;
  if (slot.count <= 0) delete player.inventory[auraId];
  player.money += total;
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
    const slot = player.inventory[aura.id] || { count: 0, bestOdds: 0, firstAt: Date.now(), lastAt: 0 };
    slot.count += outCount;
    slot.lastAt = Date.now();
    slot.bestOdds = slot.bestOdds ? Math.max(slot.bestOdds, aura.odds) : aura.odds;
    player.inventory[aura.id] = slot;
    received = { kind: 'aura', auraId: aura.id, name: aura.name, color: aura.color, count: outCount };
  } else {
    const item = content.itemById[out.item];
    player.items[item.id] = (player.items[item.id] || 0) + outCount;
    received = { kind: 'item', itemId: item.id, name: item.name, icon: item.icon, count: outCount };
  }

  ctx.db.markDirty();
  return { ok: true, recipeId, received, profile: publicProfile(player, ctx) };
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
  } else if (eff.type === 'essence') {
    player.essence += eff.amount || 0;
    applied = { type: 'essence', amount: eff.amount || 0 };
  } else {
    return { error: 'unknown_effect' };
  }

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
  ctx.db.data.feed.unshift(entry);
  if (ctx.db.data.feed.length > limit) ctx.db.data.feed.length = limit;
}

// Incremental poll: everything newer than the entry the client last saw.
export function feedSince(ctx, afterId) {
  if (!afterId) return ctx.db.data.feed;
  const idx = ctx.db.data.feed.findIndex((e) => e.id === afterId);
  if (idx === -1) return ctx.db.data.feed;
  return ctx.db.data.feed.slice(0, idx);
}

export function leaderboard(ctx, limit = 25) {
  const { content } = ctx;
  const rows = Object.values(allPlayers(ctx))
    .filter((p) => p.totalRolls > 0 || p.best)
    .map((p) => {
      const stats = deriveStats(p, content);
      const unique = Object.keys(p.inventory).length;
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
        totalAuras: content.auras.length,
        bestAuraId: p.best ? p.best.auraId : null,
        bestOdds: p.best ? p.best.odds : null,
      };
    });

  // Ranked by rarest pull — a HIGHER 1-in-N is the rarer, better pull — then
  // by collection size as the tie-break.
  rows.sort((a, b) => {
    const ao = a.bestOdds === null ? -Infinity : a.bestOdds;
    const bo = b.bestOdds === null ? -Infinity : b.bestOdds;
    if (ao !== bo) return bo - ao;
    return b.unique - a.unique;
  });

  return rows.slice(0, limit);
}

// --- serialisation -------------------------------------------------------------------

export function publicProfile(player, ctx, now = Date.now()) {
  const { content } = ctx;
  const stats = deriveStats(player, content, now);
  const unique = Object.keys(player.inventory).length;
  const req = ascendRequirement(player.ascensions || 0, content);
  return {
    id: player.id,
    name: player.name,
    guest: !!player.guest,
    createdAt: player.createdAt,
    essence: Math.floor(player.essence),
    money: Math.floor(player.money),
    totalRolls: player.totalRolls,
    ascensions: player.ascensions || 0,
    levels: player.levels,
    inventory: player.inventory,
    items: player.items,
    buffs: activeBuffs(player, now).map((b) => ({ type: b.type, mult: b.mult, until: b.until })),
    best: player.best,
    stats: {
      luck: stats.luck,
      cooldownMs: stats.cooldownMs,
      rollsPerAction: stats.rollsPerAction,
      autoPerSec: stats.autoPerSec,
      essenceMult: stats.essenceMult,
      ascendMult: stats.ascendMult,
    },
    unique,
    totalAuras: content.auras.length,
    ascendRequirement: req,
    canAscend: player.totalRolls >= req,
  };
}

export { effectiveOdds, sellPrice };
