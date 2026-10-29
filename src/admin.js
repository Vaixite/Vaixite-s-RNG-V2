import crypto from 'node:crypto';
import {
  publicProfile,
  deriveStats,
  allPlayers,
  basePlayer,
  cleanName,
  grantGear,
  destroyPlayerSessions,
  activeBuffs,
  currentBiome,
  pushFeed,
  stampAuraSlot,
  clickerOf,
} from './game.js';
import { gearView } from './gear.js';
import { isAdmin } from './admins.js';

// ---------------------------------------------------------------------------
// ADMIN — everything behind the panel that admins.json unlocks.
//
// Two rules hold this whole module together:
//
//  1. The allowlist is the authority. api.js re-checks isAdmin on every single
//     call, so removing a name from admins.json cuts the power off mid-click.
//     Nothing here trusts a client-supplied flag.
//  2. Admins change players and world state, never the game's rules. Content
//     files stay read-only over HTTP (same as everywhere else): the panel can
//     hand you any aura in the game, it cannot invent one.
//
// Every action lands in a rolling audit log — in memory, newest first — so a
// server owner can always answer "who gave whom 900 million essence".
// ---------------------------------------------------------------------------

const AUDIT_LIMIT = 200;
const ONLINE_MS = 120000;

function persist(ctx) {
  ctx.db.markDirty();
  // An admin grant should survive a crash in the next 400 ms, so push it now
  // instead of waiting for the debounce.
  ctx.db.save().catch(() => {});
}

function audit(ctx, actor, action, target, detail) {
  const entry = {
    at: Date.now(),
    by: actor?.name || '?',
    action,
    target: target?.name || (typeof target === 'string' ? target : null),
    detail: detail || null,
  };
  ctx.mem.adminLog = ctx.mem.adminLog || [];
  ctx.mem.adminLog.unshift(entry);
  if (ctx.mem.adminLog.length > AUDIT_LIMIT) ctx.mem.adminLog.length = AUDIT_LIMIT;
  console.log(
    `[admin] ${entry.by} · ${action}${entry.target ? ` → ${entry.target}` : ''}${entry.detail ? ` · ${entry.detail}` : ''}`
  );
  return entry;
}

function fail(error, status, extra) {
  return { error, status, ...(extra || {}) };
}

function num(value, { min = null, max = null, def = null, int = false } = {}) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  let out = int ? Math.floor(n) : n;
  if (min !== null) out = Math.max(min, out);
  if (max !== null) out = Math.min(max, out);
  return out;
}

/** Id first, then username, case-insensitively — exactly how login finds people. */
export function findPlayer(ctx, query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const all = allPlayers(ctx);
  if (all[q]) return all[q];
  const lower = q.toLowerCase();
  return Object.values(all).find((p) => String(p.name).toLowerCase() === lower) || null;
}

function resolveTarget(ctx, body) {
  const player = findPlayer(ctx, body?.target ?? body?.id ?? body?.name);
  return player ? { player } : fail('unknown_target', 404);
}

function sessionCount(ctx, playerId) {
  let n = 0;
  for (const s of ctx.mem.sessions.values()) if (s.playerId === playerId) n++;
  for (const s of Object.values(ctx.db.data.sessions)) if (s.playerId === playerId) n++;
  return n;
}

// --- views -------------------------------------------------------------------

function adminRow(ctx, p, now = Date.now()) {
  const stats = deriveStats(p, ctx.content, now);
  return {
    id: p.id,
    name: p.name,
    guest: !!p.guest,
    createdAt: p.createdAt || 0,
    lastSeenAt: p.lastSeenAt || 0,
    online: now - (p.lastSeenAt || 0) < ONLINE_MS,
    essence: Math.floor(p.essence || 0),
    money: Math.floor(p.money || 0),
    totalRolls: p.totalRolls || 0,
    lifetimeRolls: p.lifetimeRolls || 0,
    ascensions: p.ascensions || 0,
    ascendPoints: p.ascendPoints || 0,
    unique: Object.keys(p.inventory || {}).length,
    items: Object.keys(p.items || {}).length,
    gear: (p.gear || []).length,
    luck: stats.luck,
    cooldownMs: stats.cooldownMs,
    rollsPerAction: stats.rollsPerAction,
    autoPerSec: stats.autoPerSec,
    best: p.best || null,
    luckOff: !!p.luckOff,
    isAdmin: isAdmin(ctx, p),
    sessions: sessionCount(ctx, p.id),
  };
}

function adminDetail(ctx, p, now = Date.now()) {
  return {
    ...adminRow(ctx, p, now),
    levels: { ...(p.levels || {}) },
    tree: { ...(p.tree || {}) },
    inventory: p.inventory || {},
    items: p.items || {},
    gear: gearView(p, ctx.content),
    equipped: { ...(p.equipped || {}) },
    buffs: activeBuffs(p, now).map((b) => ({ type: b.type, mult: b.mult, until: b.until, add: b.add, rolls: b.rolls })),
    mining: p.mining || null,
  };
}

// --- grants ------------------------------------------------------------------

function grantAura(ctx, target, auraId, count, now) {
  const aura = ctx.content.auraById?.[auraId];
  if (!aura) return null;
  const slot = target.inventory[auraId] || { count: 0, bestOdds: aura.odds, lastOdds: aura.odds, firstAt: now, lastAt: 0 };
  slot.count = Math.max(0, (slot.count || 0) + count);
  slot.lastAt = now;
  slot.bestOdds = Math.max(slot.bestOdds || 0, aura.odds);
  if (slot.count <= 0) {
    delete target.inventory[auraId];
    return { aura, gone: true };
  }
  // Stamped like every other grant, so an admin handing out a special aura
  // leaves the same self-describing slot a craft would.
  target.inventory[auraId] = stampAuraSlot(slot, aura);
  if (!target.best || aura.odds > (target.best.odds || 0)) {
    target.best = { auraId: aura.id, odds: aura.odds, isBT: false, at: now };
  }
  return { aura };
}

function grantItem(ctx, target, itemId, count) {
  const item = ctx.content.itemById?.[itemId];
  if (!item) return null;
  const next = Math.max(0, (target.items[itemId] || 0) + count);
  if (next <= 0) delete target.items[itemId];
  else target.items[itemId] = next;
  return { item };
}

// --- actions -----------------------------------------------------------------

const ACTIONS = {
  // Everything the panel needs to draw itself: who is an admin right now, how
  // the server is doing, whose hand is on the world, and what was done lately.
  state(ctx, actor) {
    return {
      ok: true,
      you: publicProfile(actor, ctx),
      admins: ctx.admins.get().names,
      adminsFile: ctx.admins.file,
      server: {
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        totalRolls: ctx.db.data.meta.totalRolls,
        accounts: Object.keys(ctx.db.data.players).length,
        guests: Object.keys(ctx.mem.guests).length,
        sessions: ctx.mem.sessions.size,
        feed: ctx.db.data.feed.length,
        db: ctx.db.stats,
      },
      biome: currentBiome(ctx.content, Date.now(), ctx.mem.biomeOverride),
      biomeOverride: ctx.mem.biomeOverride || null,
      audit: (ctx.mem.adminLog || []).slice(0, 50),
    };
  },

  players(ctx) {
    const now = Date.now();
    const rows = Object.values(allPlayers(ctx))
      .map((p) => adminRow(ctx, p, now))
      .sort((a, b) => (b.online - a.online) || (b.lastSeenAt - a.lastSeenAt) || String(a.name).localeCompare(b.name));
    return { ok: true, rows, admins: ctx.admins.get().names };
  },

  player(ctx, actor, body, query) {
    const t = resolveTarget(ctx, { ...query, ...body });
    if (t.error) return t;
    return { ok: true, row: adminDetail(ctx, t.player) };
  },

  // Additive grants. Negative amounts take away again, floored at zero, so the
  // same field is both a gift and a claw-back.
  give(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const target = t.player;
    const now = Date.now();
    const gave = [];

    for (const [field, label] of [
      ['essence', 'essence'],
      ['money', 'money'],
      ['ascendPoints', 'ascend points'],
    ]) {
      const n = num(body[field]);
      if (!n) continue;
      target[field] = Math.max(0, (target[field] || 0) + n);
      gave.push(`${label} ${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`);
    }

    const asc = num(body.ascensions, { int: true });
    if (asc) {
      target.ascensions = Math.max(0, (target.ascensions || 0) + asc);
      gave.push(`ascensions ${asc > 0 ? '+' : '−'}${Math.abs(asc)}`);
    }

    // Sparks are the clicker's own currency — the same claw-back rule as money.
    const sparks = num(body.sparks, { min: -1e15, max: 1e15 });
    if (sparks) {
      const st = clickerOf(target);
      st.sparks = Math.max(0, (st.sparks || 0) + sparks);
      if (sparks > 0) st.totalSparks = (st.totalSparks || 0) + sparks;
      gave.push(`sparks ${sparks > 0 ? '+' : '−'}${Math.abs(sparks).toLocaleString('en-US')}`);
    }

    if (body.allAuras) {
      const count = num(body.allAuras, { min: 1, max: 1e6, int: true, def: 1 });
      let n = 0;
      // allAuras, not auras: "every aura" means the craft-only ones too.
      for (const aura of ctx.content.allAuras) if (grantAura(ctx, target, aura.id, count, now)) n++;
      gave.push(`${ctx.content.allAuras.length} aura kinds ×${count}`);
      if (!n) return fail('no_auras_in_content', 500);
    }
    if (body.allItems) {
      const count = num(body.allItems, { min: 1, max: 1e6, int: true, def: 1 });
      for (const item of ctx.content.items) grantItem(ctx, target, item.id, count);
      gave.push(`${ctx.content.items.length} item kinds ×${count}`);
    }

    for (const [id, raw] of Object.entries(body.auras || {})) {
      const count = num(raw, { min: -1e9, max: 1e9, int: true, def: 0 });
      if (!count) continue;
      if (!grantAura(ctx, target, id, count, now)) return fail('unknown_aura', 400, { id });
      gave.push(`${id} ${count > 0 ? '+' : '−'}${Math.abs(count)}`);
    }

    for (const [id, raw] of Object.entries(body.items || {})) {
      const count = num(raw, { min: -1e9, max: 1e9, int: true, def: 0 });
      if (!count) continue;
      if (!grantItem(ctx, target, id, count)) return fail('unknown_item', 400, { id });
      gave.push(`${id} ${count > 0 ? '+' : '−'}${Math.abs(count)}`);
    }

    for (const [id, raw] of Object.entries(body.levels || {})) {
      const def = ctx.content.upgradeById?.[id];
      if (!def) return fail('unknown_upgrade', 400, { id });
      const level = num(raw, { min: 0, max: Number(def.max) || 1e6, int: true, def: 0 });
      target.levels = target.levels || {};
      target.levels[id] = level;
      gave.push(`${id} lvl ${level}`);
    }

    if (!gave.length) return fail('nothing_to_give');
    persist(ctx);
    audit(ctx, actor, 'give', target, gave.join(', '));
    return { ok: true, gave, row: adminRow(ctx, target, now), profile: publicProfile(target, ctx, now) };
  },

  // Absolute values: the editor for one account.
  set(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const target = t.player;
    const changed = [];

    if (body.name !== undefined) {
      const name = cleanName(body.name, ctx.content.config);
      if (!name) return fail('bad_username');
      const clash = Object.values(allPlayers(ctx)).find(
        (p) => p.id !== target.id && String(p.name).toLowerCase() === name.toLowerCase()
      );
      if (clash) return fail('name_taken');
      // Renaming is the other half of the allowlist: move a name out of
      // admins.json and the panel goes away on the next request.
      changed.push(`name → ${name}`);
      target.name = name;
    }

    for (const [field, label, int] of [
      ['essence', 'essence', false],
      ['money', 'money', false],
      ['ascendPoints', 'ascend points', true],
      ['ascensions', 'ascensions', true],
      ['totalRolls', 'rolls', true],
      ['lifetimeRolls', 'lifetime rolls', true],
    ]) {
      if (body[field] === undefined) continue;
      const n = num(body[field], { min: 0, int });
      if (n === null) return fail('bad_number', 400, { field });
      target[field] = n;
      changed.push(`${label} = ${n.toLocaleString('en-US')}`);
    }

    if (body.luckOff !== undefined) {
      target.luckOff = !!body.luckOff;
      changed.push(`luck ${target.luckOff ? 'off' : 'on'}`);
    }

    for (const [id, raw] of Object.entries(body.levels || {})) {
      const def = ctx.content.upgradeById?.[id];
      if (!def) return fail('unknown_upgrade', 400, { id });
      const level = num(raw, { min: 0, max: Number(def.max) || 1e6, int: true, def: 0 });
      target.levels = target.levels || {};
      target.levels[id] = level;
      changed.push(`${id} = lvl ${level}`);
    }

    for (const [id, raw] of Object.entries(body.tree || {})) {
      const node = ctx.content.treeById?.[id];
      if (!node) return fail('unknown_node', 400, { id });
      const level = num(raw, { min: 0, max: Number(node.maxLevel) || 999, int: true, def: 0 });
      target.tree = target.tree || {};
      if (level <= 0) delete target.tree[id];
      else target.tree[id] = level;
      changed.push(`tree ${id} = ${level}`);
    }

    if (body.mining === 'reset') {
      target.mining = null;
      changed.push('mining vein rerolled');
    }

    // The clicker shop is set like any other level list — validated against
    // content/clicker.json, so the panel cannot hand out an upgrade that is not
    // in the file. 'reset' wipes the minigame back to zero Sparks.
    for (const [id, raw] of Object.entries(body.clickerLevels || {})) {
      const def = ctx.content.clickerById?.[id];
      if (!def) return fail('unknown_upgrade', 400, { id });
      const level = num(raw, { min: 0, max: Number(def.max) || 1e6, int: true, def: 0 });
      const st = clickerOf(target);
      if (level <= 0) delete st.levels[id];
      else st.levels[id] = level;
      changed.push(`clicker ${id} = ${level}`);
    }

    if (body.clicker === 'reset') {
      target.clicker = null;
      changed.push('clicker wiped');
    }

    if (!changed.length) return fail('nothing_to_change');
    persist(ctx);
    audit(ctx, actor, 'set', target, changed.join(', '));
    return { ok: true, changed, row: adminRow(ctx, target), profile: publicProfile(target, ctx) };
  },

  // Potions and timed elixirs, without the shop or the cauldron.
  buff(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const target = t.player;
    const now = Date.now();
    target.buffs = Array.isArray(target.buffs) ? target.buffs : [];

    const add = num(body.add, { min: 0, max: 1e12 });
    const mult = num(body.mult, { min: 0, max: 1e9 });

    if (add) {
      const rolls = num(body.rolls, { min: 1, max: 1000, int: true, def: 1 });
      const existing = target.buffs.find((b) => b.type === 'nextRollLuck' && b.add === add);
      if (existing) existing.rolls = Math.max(1, existing.rolls || 1) + rolls;
      else target.buffs.push({ type: 'nextRollLuck', add, rolls, until: null });
      persist(ctx);
      audit(ctx, actor, 'buff', target, `+${add.toLocaleString('en-US')} luck ×${rolls} roll(s)`);
      return { ok: true, granted: { type: 'nextRollLuck', add, rolls }, profile: publicProfile(target, ctx, now) };
    }

    if (mult) {
      const minutes = num(body.minutes, { min: 0.02, max: 60 * 24 * 365, def: 10 });
      const until = now + Math.round(minutes * 60000);
      const existing = target.buffs.find((b) => b.type === 'luckBuff' && b.mult === mult);
      if (existing) existing.until = Math.max(existing.until || 0, until);
      else target.buffs.push({ type: 'luckBuff', mult, until });
      persist(ctx);
      audit(ctx, actor, 'buff', target, `${mult}× luck for ${minutes} min`);
      return { ok: true, granted: { type: 'luckBuff', mult, until }, profile: publicProfile(target, ctx, now) };
    }

    return fail('nothing_to_grant');
  },

  gear(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const target = t.player;
    const out = grantGear(target, ctx.content, body.piece, body.quality || null);
    if (out.error) return fail(out.error, out.error === 'gear_full' ? 409 : 400, { cap: out.cap });
    persist(ctx);
    audit(ctx, actor, 'gear', target, `${out.pieceId}${body.quality ? `/${body.quality}` : ''}`);
    return { ok: true, granted: out, row: adminRow(ctx, target), profile: publicProfile(target, ctx) };
  },

  // Two depths: 'progress' wipes the run and keeps the account, 'full' wipes
  // everything but the login itself.
  reset(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const target = t.player;
    const full = body.mode === 'full';

    if (full) {
      const keep = {
        id: target.id,
        name: target.name,
        createdAt: target.createdAt,
        lastSeenAt: Date.now(),
      };
      if (target.salt) {
        keep.salt = target.salt;
        keep.passwordHash = target.passwordHash;
      }
      if (target.guest) keep.guest = true;
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, basePlayer(keep.name), keep);
    } else {
      target.essence = 0;
      target.money = 0;
      target.inventory = {};
      target.items = {};
      target.gear = [];
      target.equipped = {};
      target.buffs = [];
      target.best = null;
      target.levels = { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0 };
      target.totalRolls = 0;
      target.lastRollAt = 0;
    }

    persist(ctx);
    audit(ctx, actor, 'reset', target, full ? 'full' : 'progress');
    return { ok: true, mode: full ? 'full' : 'progress', row: adminRow(ctx, target), profile: publicProfile(target, ctx) };
  },

  kick(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const before = sessionCount(ctx, t.player.id);
    destroyPlayerSessions(ctx, t.player.id);
    persist(ctx);
    audit(ctx, actor, 'kick', t.player, `${before} session(s)`);
    return { ok: true, sessions: before, row: adminRow(ctx, t.player) };
  },

  del(ctx, actor, body) {
    const t = resolveTarget(ctx, body);
    if (t.error) return t;
    const target = t.player;
    if (target.id === actor.id) return fail('cannot_delete_self');
    const name = target.name;
    destroyPlayerSessions(ctx, target.id);
    if (target.guest) delete ctx.mem.guests[target.id];
    else delete ctx.db.data.players[target.id];
    persist(ctx);
    audit(ctx, actor, 'delete', target, name);
    return { ok: true, deleted: target.id, name };
  },

  // The whole server's biome, for everyone, right now.
  biome(ctx, actor, body) {
    const id = body.biome ?? body.id;
    if (id === null || id === '' || id === 'auto' || body.clear) {
      ctx.mem.biomeOverride = null;
      audit(ctx, actor, 'biome', null, 'rotation restored');
      return { ok: true, biomeOverride: null, biome: currentBiome(ctx.content, Date.now(), null) };
    }
    const biome = ctx.content.biomeById?.[id];
    if (!biome) return fail('unknown_biome', 400, { id });
    const minutes = num(body.minutes, { min: 0, max: 60 * 24 * 30, def: 0 });
    ctx.mem.biomeOverride = {
      id,
      until: minutes > 0 ? Date.now() + minutes * 60000 : null,
      by: actor.name,
      at: Date.now(),
    };
    audit(ctx, actor, 'biome', null, `${id}${minutes > 0 ? ` for ${minutes} min` : ' until cleared'}`);
    return {
      ok: true,
      biomeOverride: ctx.mem.biomeOverride,
      biome: currentBiome(ctx.content, Date.now(), ctx.mem.biomeOverride),
    };
  },

  // A line in everyone's world feed, marked as staff speech.
  announce(ctx, actor, body) {
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text) return fail('empty_announcement');
    const entry = {
      id: crypto.randomUUID(),
      player: 'ADMIN',
      auraId: null,
      auraName: text,
      color: body.color || '#ffd966',
      tier: null,
      tierName: 'Announcement',
      odds: 0,
      isBT: false,
      biome: 'admin',
      biomeName: 'Admin',
      at: Date.now(),
      announcement: true,
    };
    pushFeed(ctx, entry);
    ctx.db.markDirty();
    audit(ctx, actor, 'announce', null, text);
    return { ok: true, entry };
  },

  // Do not wait for the debounce.
  save(ctx, actor) {
    ctx.db.markDirty();
    ctx.db.saveSync();
    audit(ctx, actor, 'save', null, `writes=${ctx.db.stats.writes}`);
    return { ok: true, db: ctx.db.stats };
  },
};

/**
 * Dispatch one admin call. `action` is the path segment after /api/admin/.
 * The caller (api.js) has already verified the actor is on the list.
 */
export function adminHandle(ctx, actor, action, body, query) {
  const name = action === 'delete' ? 'del' : action;
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  if (!fn) return fail('unknown_action', 404, { action });
  return fn(ctx, actor, body || {}, query || {});
}

export const ADMIN_ACTIONS = Object.keys(ACTIONS).map((a) => (a === 'del' ? 'delete' : a));
