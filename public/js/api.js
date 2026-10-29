// Thin fetch wrapper around the game API.
// Every call returns parsed JSON and throws an Error carrying the server's
// `error` code so callers can branch on things like "cooldown".
//
// The session token (account or guest) lives in localStorage and rides along
// as an Authorization: Bearer header on every call.

const JSON_HEADERS = { 'content-type': 'application/json' };
const LS_TOKEN = 'vrng2.token';

export function getToken() {
  try {
    return localStorage.getItem(LS_TOKEN) || null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(LS_TOKEN, token);
    else localStorage.removeItem(LS_TOKEN);
  } catch {
    /* private mode — the session just won't survive a reload */
  }
}

async function request(method, path, body, { auth = true } = {}) {
  const headers = body ? { ...JSON_HEADERS } : {};
  const token = auth ? getToken() : null;
  if (token) headers['authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('offline');
    err.code = 'offline';
    throw err;
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(`bad response from ${path}`);
      err.code = 'bad_response';
      throw err;
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || `http ${res.status}`);
    err.code = data?.error || 'http_error';
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // public
  catalog: () => request('GET', '/api/catalog', null, { auth: false }),
  world: () => request('GET', '/api/world', null, { auth: false }),
  feed: (after) => request('GET', '/api/feed' + (after ? `?after=${encodeURIComponent(after)}` : ''), null, { auth: false }),
  // Public, but the token rides along when there is one so the server can tell
  // us where *we* rank. `sort` is one of the ids the board itself advertises.
  leaderboard: (sort) =>
    request('GET', '/api/leaderboard' + (sort ? `?sort=${encodeURIComponent(sort)}` : '')),

  // auth
  register: (username, password) => request('POST', '/api/auth/register', { username, password }, { auth: false }),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }, { auth: false }),
  guest: () => request('POST', '/api/auth/guest', {}, { auth: false }),
  logout: () => request('POST', '/api/auth/logout', {}),

  // session
  me: () => request('GET', '/api/me'),
  // The badge board, measured server-side for this player. On demand like the
  // leaderboard: the tab is opened occasionally, and the roll response already
  // carries which badges you own — just not fifty progress bars.
  achievements: () => request('GET', '/api/achievements'),
  rename: (name) => request('POST', '/api/rename', { name }),
  roll: (count) => request('POST', '/api/roll', { count }),
  buy: (upgradeId) => request('POST', '/api/upgrade', { upgradeId }),
  ascend: () => request('POST', '/api/ascend', {}),
  sell: (auraId, count) => request('POST', '/api/sell', { auraId, count }),
  craft: (recipeId) => request('POST', '/api/craft', { recipeId }),
  shopBuy: (itemId) => request('POST', '/api/shop/buy', { itemId }),
  useItem: (itemId) => request('POST', '/api/item/use', { itemId }),
  // Crafted equipment: unique instances addressed by uid, never by count.
  equipGear: (uid) => request('POST', '/api/gear/equip', { uid }),
  unequipGear: (uid) => request('POST', '/api/gear/unequip', { uid }),
  salvageGear: (uid) => request('POST', '/api/gear/salvage', { uid }),

  // Ascend tree: permanent nodes bought with Ascend Points.
  buyNode: (nodeId) => request('POST', '/api/tree/buy', { nodeId }),

  // Mining shaft: one cell at a time, or a brand-new vein.
  mineReveal: (cell) => request('POST', '/api/mine/reveal', { cell }),
  mineReset: () => request('POST', '/api/mine/reset', {}),
  // The Automated Drill: banked real time turned into picks. Cheap to poll —
  // an empty tick is the normal answer and pays nothing extra.
  mineAuto: () => request('POST', '/api/mine/auto', {}),

  // Spark Clicker: one manual click, the idle tick, and the upgrade shop.
  clickTap: () => request('POST', '/api/click/tap', {}),
  clickAuto: () => request('POST', '/api/click/auto', {}),
  clickBuy: (upgradeId) => request('POST', '/api/click/buy', { upgradeId }),

  // Per-player luck switch: rolls use the authored table while it is off.
  setLuck: (on) => request('POST', '/api/luck', { on: !!on }),

  remove: () => request('POST', '/api/delete', {}),

  // Admin panel. Every one of these answers 403 unless the account name is in
  // the server's admins.json — the server decides, this file just asks.
  admin: {
    state: () => request('GET', '/api/admin/state'),
    players: () => request('GET', '/api/admin/players'),
    player: (target) => request('GET', '/api/admin/player?target=' + encodeURIComponent(target)),
    give: (body) => request('POST', '/api/admin/give', body),
    set: (body) => request('POST', '/api/admin/set', body),
    buff: (body) => request('POST', '/api/admin/buff', body),
    gear: (body) => request('POST', '/api/admin/gear', body),
    reset: (body) => request('POST', '/api/admin/reset', body),
    kick: (body) => request('POST', '/api/admin/kick', body),
    del: (body) => request('POST', '/api/admin/delete', body),
    biome: (body) => request('POST', '/api/admin/biome', body),
    announce: (body) => request('POST', '/api/admin/announce', body),
    save: () => request('POST', '/api/admin/save', {}),
  },
};
