import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { baseCounters } from './achievements.js';

// ---------------------------------------------------------------------------
// JSON DATABASE
//
// A single JSON file is the whole database. Writes are:
//   1. debounced  — a burst of rolls produces one write, not hundreds
//   2. atomic     — serialise to <file>.tmp, fsync, then rename() over the
//                   target. rename() is atomic on every OS, so a crash mid
//                   write can never leave a half-written db.json.
//   3. serialised — a promise chain guarantees writes never interleave.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 2;

const EMPTY = {
  version: SCHEMA_VERSION,
  createdAt: 0,
  players: {},
  legacy: {},
  sessions: {},
  feed: [],
  meta: {
    totalRolls: 0,
    biomeIndex: 0,
    biomeStartedAt: 0,
    nextPlayerId: 1,
  },
};

export class JsonDb {
  constructor(file) {
    this.file = file;
    this.dir = path.dirname(file);
    this.tmp = `${file}.tmp`;
    this.data = structuredClone(EMPTY);
    this.data.createdAt = Date.now();
    this._dirty = false;
    this._timer = null;
    this._chain = Promise.resolve();
    this._saving = false;
    this.stats = { writes: 0, loads: 0, recovered: 0 };
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.data = structuredClone(EMPTY);
      this.data.createdAt = Date.now();
      this.saveSync();
      console.log(`[db] no database found — created ${this.file}`);
      return this.data;
    }

    const raw = fs.readFileSync(this.file, 'utf8');
    if (!raw.trim()) {
      console.warn('[db] file is empty, starting fresh');
      this.data = structuredClone(EMPTY);
      this.data.createdAt = Date.now();
      this.saveSync();
      return this.data;
    }

    try {
      const parsed = JSON.parse(raw);
      this.data = this._migrate(parsed);
      this.stats.loads++;
      const players = Object.keys(this.data.players).length;
      console.log(`[db] loaded ${this.file} — ${players} player(s)`);
    } catch (err) {
      // Never destroy data on a parse error: quarantine and start clean.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
        console.error(`[db] corrupt JSON (${err.message}). Backed up to ${backup}`);
      } catch {
        console.error('[db] corrupt JSON and backup failed; starting fresh');
      }
      this.stats.recovered++;
      this.data = structuredClone(EMPTY);
      this.data.createdAt = Date.now();
      this.saveSync();
    }
    return this.data;
  }

  // v1 → v2: accounts now carry a salted password hash and players gained a
  // money / items / buffs economy. Old records are filled in with the new
  // fields; anything that predates passwords is moved aside into `legacy`
  // rather than deleted — it can never sign in again, but nothing is lost.
  // Later fields (gear, equipped) are filled in here too, so an old save keeps
  // loading without a version bump.
  _migrate(parsed) {
    const next = structuredClone(EMPTY);
    const merged = { ...next, ...parsed };
    merged.meta = { ...next.meta, ...(parsed.meta || {}) };
    merged.sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    merged.feed = Array.isArray(parsed.feed) ? parsed.feed : [];
    merged.legacy = { ...(parsed.legacy || {}) };
    merged.version = SCHEMA_VERSION;

    const players = {};
    let moved = 0;
    for (const [id, p] of Object.entries(parsed.players || {})) {
      if (!p || typeof p !== 'object') continue;
      if (!p.passwordHash) {
        merged.legacy[id] = { ...p, note: 'pre-password profile — cannot sign in' };
        moved++;
        continue;
      }
      p.id = id;
      p.essence = Number(p.essence) || 0;
      p.money = Number(p.money) || 0;
      p.totalRolls = Number(p.totalRolls) || 0;
      p.ascensions = Number(p.ascensions) || 0;
      p.levels = { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0, ...(p.levels || {}) };
      p.inventory = p.inventory && typeof p.inventory === 'object' ? p.inventory : {};
      p.items = p.items && typeof p.items === 'object' ? p.items : {};
      p.buffs = Array.isArray(p.buffs) ? p.buffs.filter((b) => b && b.until > 0) : [];
      // Gear arrived after the first saves: fill the fields, then drop any slot
      // pointing at a piece the player does not own — a dangling pointer would
      // light up a buff nobody can see or unequip.
      p.gear = Array.isArray(p.gear)
        ? p.gear.filter((g) => g && g.uid && g.pieceId && Array.isArray(g.buffs))
        : [];
      p.equipped = p.equipped && typeof p.equipped === 'object' ? p.equipped : {};
      const owned = new Set(p.gear.map((g) => g.uid));
      for (const [slot, uid] of Object.entries(p.equipped)) {
        if (!owned.has(uid)) delete p.equipped[slot];
      }
      // Achievements measure a lifetime, and a lifetime starts before the
      // feature did. Anything the tallies cannot reconstruct — how many rocks
      // you opened, how many bottles you drank — simply starts counting today;
      // anything the record still shows (levels, collection, ascensions) needs
      // no back-fill at all, because the metric reads it live.
      p.counters = { ...baseCounters(), ...(p.counters || {}) };
      p.counters.ores = p.counters.ores && typeof p.counters.ores === 'object' ? p.counters.ores : {};
      p.biomesSeen = p.biomesSeen && typeof p.biomesSeen === 'object' ? p.biomesSeen : {};
      p.achievements = p.achievements && typeof p.achievements === 'object' ? p.achievements : {};
      players[id] = p;
    }
    merged.players = players;

    // Sessions pointing at a player that no longer exists are dead weight.
    for (const token of Object.keys(merged.sessions)) {
      if (!players[merged.sessions[token]?.playerId]) delete merged.sessions[token];
    }

    // Only warn when this load actually moved someone. Counting the whole
    // legacy bucket instead made every boot look like a migration had run.
    const parked = Object.keys(merged.legacy).length;
    if (moved) {
      console.warn(`[db] moved ${moved} pre-password profile(s) to "legacy" — kept, but they cannot sign in`);
    } else if (parked) {
      console.log(`[db] ${parked} pre-password profile(s) parked in "legacy" (cannot sign in)`);
    }
    return merged;
  }

  markDirty() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save().catch((e) => console.error('[db] async save failed:', e.message));
    }, JsonDb.DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  // Serialised, atomic, coalesced.
  save() {
    this._chain = this._chain.then(() => this._writeOnce()).catch((e) => {
      console.error('[db] write error:', e.message);
    });
    return this._chain;
  }

  async _writeOnce() {
    if (!this._dirty && this._saving) return;
    this._dirty = false;
    this._saving = true;
    const payload = JSON.stringify(this.data, null, 2);
    try {
      const fh = await fsp.open(this.tmp, 'w');
      try {
        await fh.writeFile(payload, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(this.tmp, this.file);
      this.stats.writes++;
    } finally {
      this._saving = false;
    }
  }

  saveSync() {
    const payload = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(this.tmp, payload, 'utf8');
    fs.renameSync(this.tmp, this.file);
    this._dirty = false;
    this.stats.writes++;
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._dirty = true;
    await this.save();
  }
}

JsonDb.DEBOUNCE_MS = 400;

export function createDb(file) {
  const db = new JsonDb(file);
  db.load();
  return db;
}

/** A pristine database object — used by scripts/reset-db.js. */
export function emptyDb() {
  const fresh = structuredClone(EMPTY);
  fresh.createdAt = Date.now();
  return fresh;
}
