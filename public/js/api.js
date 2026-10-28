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
  leaderboard: () => request('GET', '/api/leaderboard', null, { auth: false }),

  // auth
  register: (username, password) => request('POST', '/api/auth/register', { username, password }, { auth: false }),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }, { auth: false }),
  guest: () => request('POST', '/api/auth/guest', {}, { auth: false }),
  logout: () => request('POST', '/api/auth/logout', {}),

  // session
  me: () => request('GET', '/api/me'),
  rename: (name) => request('POST', '/api/rename', { name }),
  roll: (count) => request('POST', '/api/roll', { count }),
  buy: (upgradeId) => request('POST', '/api/upgrade', { upgradeId }),
  ascend: () => request('POST', '/api/ascend', {}),
  sell: (auraId, count) => request('POST', '/api/sell', { auraId, count }),
  craft: (recipeId) => request('POST', '/api/craft', { recipeId }),
  shopBuy: (itemId) => request('POST', '/api/shop/buy', { itemId }),
  useItem: (itemId) => request('POST', '/api/item/use', { itemId }),
  remove: () => request('POST', '/api/delete', {}),
};
