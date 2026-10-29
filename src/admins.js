import fs from 'node:fs';

// ---------------------------------------------------------------------------
// ADMINS — the host's allowlist, in admins.json next to server.js.
//
// The file is owned by the machine, never by HTTP: no route can write it, the
// same rule content/*.json plays by. Add a username, save, and within ~2s that
// player's session gains the Admin panel. Remove it and the panel is gone on
// their next request — the check runs server-side on every admin call, so the
// client flag is a convenience, never the authority.
//
// Hot-reload mirrors src/content.js: mtime check at most every RECHECK_MS, a
// broken edit logs and keeps the last good list, and a missing file simply
// means nobody is an admin. The server must never crash over a typo in a list
// of names.
//
// Accepted shapes (all equivalent):
//   ["vaixite", "friend"]
//   { "admins": ["vaixite"] }
//   { "admins": [{ "name": "vaixite" }] }
//
// Names are matched case-insensitively, exactly like login does, so a rename
// out of the list drops the power and a rename into it grants it.
// ---------------------------------------------------------------------------

const RECHECK_MS = 2000;

function normalizeName(n) {
  return String(n == null ? '' : n).trim();
}

function extract(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.admins)
      ? raw.admins
      : Array.isArray(raw?.users)
        ? raw.users
        : [];
  const names = [];
  const seen = new Set();
  for (const entry of list) {
    const name = normalizeName(typeof entry === 'string' ? entry : entry?.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return { names, lower: seen };
}

export function createAdminLoader(file) {
  let current = { names: [], lower: new Set() };
  let stamp = null; // mtimeMs of the copy we are holding; null = never read
  let missing = true; // last stat said the file is not there
  let lastCheck = 0;

  function load() {
    let stat = null;
    let text = null;
    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EPERM') {
        console.error('[admins]', err.message);
      }
      const changed = !missing;
      missing = true;
      stamp = null;
      if (changed || !current.names.length) {
        current = { names: [], lower: new Set() };
        if (changed) console.log('[admins] admins.json is gone — nobody is an admin right now');
      }
      return current;
    }

    // Unchanged since the last read: keep what we have, say nothing.
    if (stamp === stat.mtimeMs && !missing) return current;
    stamp = stat.mtimeMs;
    missing = false;

    try {
      const next = extract(JSON.parse(text));
      current = next;
      console.log(
        `[admins] ${next.names.length ? `admin${next.names.length === 1 ? '' : 's'}: ${next.names.join(', ')}` : 'nobody is on the list'}`
      );
    } catch (err) {
      // Broken JSON: keep the last good list and do not re-log every 2s.
      console.error(`[admins] admins.json is not readable (${err.message}) — keeping the previous list`);
    }
    return current;
  }

  return {
    get() {
      if (stamp === null) return load();
      const now = Date.now();
      if (now - lastCheck < RECHECK_MS) return current;
      lastCheck = now;
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs !== stamp || missing) return load();
      } catch {
        return load(); // file vanished
      }
      return current;
    },
    /** Case-insensitive username check. Guests can never be admins. */
    has(name) {
      const key = normalizeName(name).toLowerCase();
      return !!key && this.get().lower.has(key);
    },
    file,
  };
}

/**
 * The single authority for "may this player use the admin panel".
 * Guests are memory-only and have no stable identity to grant — an entry in
 * admins.json can only ever name a real account.
 */
export function isAdmin(ctx, player) {
  if (!player || player.guest) return false;
  return !!ctx?.admins?.has(player.name);
}
