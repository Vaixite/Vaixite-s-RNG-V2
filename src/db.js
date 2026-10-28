import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

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

  _migrate(parsed) {
    const next = structuredClone(EMPTY);
    const merged = { ...next, ...parsed };
    merged.meta = { ...next.meta, ...(parsed.meta || {}) };
    merged.players = parsed.players || {};
    merged.sessions = parsed.sessions || {};
    merged.feed = Array.isArray(parsed.feed) ? parsed.feed : [];
    merged.version = SCHEMA_VERSION;
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
