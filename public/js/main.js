import { api } from './api.js';
import { $, h, clear, fmt, fmtOdds, fmtMs, toast, safeLocal } from './dom.js';
import { renderView } from './views.js';
import * as fx from './rollfx.js';
import { getBiome } from './data/biomes.js';

// ---------------------------------------------------------------------------
// Vaixite's RNG V2 — client entry point.
//
// The server owns the truth (rolls, currency, cooldowns). This file only
// mirrors state, drives the presentation, and polls the shared world.
// ---------------------------------------------------------------------------

const LS_PLAYER = 'vrng2.playerId';
const LS_AUTO = 'vrng2.auto';

const state = {
  catalog: { auras: [], biomes: [], upgrades: [], rarityTiers: [] },
  auraById: {},
  oddsById: {},
  profile: null,
  world: { biome: getBiome('normal'), feed: [], leaderboard: [] },
  view: 'inventory',
  newAuras: new Set(),
  rolling: false,
  nextRollAt: 0,
  lastFeedId: null,
  offline: false,
};

const ui = {
  who: $('#who'), luck: $('#hudLuck'), essence: $('#hudEssence'), rolls: $('#hudRolls'), best: $('#hudBest'),
  rollBtn: $('#rollBtn'), rollSub: $('#rollSub'), cooldown: $('#cooldownBar'),
  feed: $('#feed'), view: $('#view'), tabs: $('#tabs'),
  biomeName: $('#biomeName'), biomeTimer: $('#biomeTimer'), biomeDot: $('#biomeDot'), biomeChip: $('#biomeChip'),
  collectCount: $('#collectCount'), collectBar: $('#collectBar'), ascendInfo: $('#ascendInfo'),
  onlineCount: $('#onlineCount'), auto: $('#autoToggle'),
  joinModal: $('#joinModal'), joinForm: $('#joinForm'), joinName: $('#joinName'),
  sky: document.documentElement,
};

// --- state application -----------------------------------------------------

function applyProfile(profile) {
  state.profile = profile;
  ui.who.innerHTML = `signed in as <b>${escapeHtml(profile.name)}</b> · ${profile.ascensions ? `✦ ${profile.ascensions} ascension${profile.ascensions > 1 ? 's' : ''}` : 'first roll awaits'}`;
  ui.luck.textContent = `${profile.stats.luck.toFixed(2)}×`;
  ui.essence.textContent = fmt(profile.essence);
  ui.rolls.textContent = fmt(profile.totalRolls);

  const best = profile.best && state.auraById[profile.best.auraId];
  ui.best.textContent = best ? best.name : '—';
  ui.best.style.color = best ? best.color : '';
  ui.best.title = profile.best ? fmtOdds(profile.best.odds) : 'no rolls yet';

  const pct = profile.totalAuras ? (profile.unique / profile.totalAuras) * 100 : 0;
  ui.collectCount.textContent = `${profile.unique} / ${profile.totalAuras}`;
  ui.collectBar.style.width = `${pct}%`;
  ui.ascendInfo.textContent = profile.canAscend
    ? 'Ascend is ready — trade your levels for permanent luck.'
    : `${fmt(profile.ascendRequirement - profile.totalRolls)} more rolls to unlock Ascend.`;

  ui.auto.disabled = profile.stats.autoPerSec < 1;
  if (ui.auto.disabled) ui.auto.checked = false;
}

function applyOdds(list) {
  state.oddsById = {};
  for (const o of list) state.oddsById[o.id] = o;
}

function applyBiome(biome) {
  state.world.biome = biome;
  const b = getBiome(biome.id);
  ui.biomeName.textContent = b.name;
  ui.biomeName.style.color = b.color;
  ui.biomeDot.style.background = b.color;
  ui.biomeDot.style.boxShadow = `0 0 14px 3px ${b.color}`;
  ui.biomeChip.title = b.desc;
  // Wash the page in the biome's palette.
  ui.sky.style.setProperty('--sky-a', b.sky[0]);
  ui.sky.style.setProperty('--sky-b', b.sky[1]);
  ui.sky.style.setProperty('--accent', b.color);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- world feed ------------------------------------------------------------

function renderFeed(entries, { prepend = false } = {}) {
  if (!entries.length) return;
  if (!prepend) clear(ui.feed);
  if (ui.feed.querySelector('p')) clear(ui.feed);

  for (const e of (prepend ? [...entries].reverse() : entries)) {
    const aura = state.auraById[e.auraId];
    ui.feed.append(
      h(
        'div',
        { class: 'feed-item', style: { color: e.color || aura?.color }, title: `${e.biomeName} · ${timeAgoText(e.at)}` },
        h('span', { class: 'who-name' }, e.player),
        h('span', { class: 'muted' }, 'rolled'),
        h('span', { class: 'aura-name' }, e.auraName),
        e.isBT ? h('span', { class: 'bt-flag' }, 'BT') : null,
        h('span', { class: 'odds' }, fmtOdds(e.odds))
      )
    );
  }
  while (ui.feed.children.length > 40) ui.feed.lastChild.remove();
  state.lastFeedId = state.lastFeedId || entries[0]?.id;
}

function timeAgoText(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

async function pollFeed() {
  try {
    const { feed } = await api.feed(state.lastFeedId);
    if (feed.length) {
      state.lastFeedId = feed[0].id;
      renderFeed(feed, { prepend: true });
    }
    markOnline();
  } catch {
    /* transient */
  }
}

function markOnline() {
  if (state.offline) {
    state.offline = false;
    toast('Reconnected to the world.', 'ok');
  }
}
function markOffline() {
  if (!state.offline) {
    state.offline = true;
    toast('Lost the server — rolls are paused until it is back.', 'bad', 5000);
  }
}

// --- rolling ---------------------------------------------------------------

function setRollEnabled(on) {
  ui.rollBtn.disabled = !on || !state.profile;
}

async function doRoll() {
  if (state.rolling || !state.profile) return;
  if (Date.now() < state.nextRollAt) return;

  state.rolling = true;
  ui.rollBtn.disabled = true;
  const stopSpin = fx.spin(state.catalog.auras);

  try {
    const res = await api.roll(state.profile.id, state.profile.stats.rollsPerAction);
    stopSpin();
    markOnline();

    state.nextRollAt = Date.now() + res.stats.cooldownMs;
    applyProfile(res.profile);

    // Rarest first for the big reveal.
    const results = [...res.results].sort((a, b) => b.odds - a.odds);
    const top = results[0];

    state.newAuras = new Set(res.results.filter((r) => r.isNew).map((r) => r.auraId));
    await fx.reveal(top, { isBT: top.isBT, isNew: top.isNew, biomeName: res.biome.name });

    for (const r of results.slice(1)) {
      if (r.odds >= 1000 || r.isNew) {
        toast(`${r.name} ${fmtOdds(r.odds)}${r.isNew ? ' · NEW' : ''}`, r.isNew ? 'ok' : 'gold');
      }
    }
    if (res.newAuras > 0) toast(`${res.newAuras} new aura${res.newAuras > 1 ? 's' : ''}!`, 'ok');

    renderCurrentView();
  } catch (err) {
    stopSpin();
    if (err.code === 'cooldown') {
      state.nextRollAt = Date.now() + (err.data?.retryInMs || 300);
    } else if (err.code === 'offline' || err.code === 'bad_response' || err.status >= 500) {
      markOffline();
    } else if (err.code !== 'no_such_player') {
      toast(`Roll failed: ${err.message}`, 'bad');
    }
  } finally {
    state.rolling = false;
    setTimeout(() => state.newAuras.clear(), 2500);
  }
}

// Recompute the live odds table locally from the same shared data the server
// used, so the bestiary stays current between polls.
function applyOddsForCurrent() {
  const luck = state.profile?.stats.luck || 1;
  const biome = getBiome(state.world.biome.id);
  for (const aura of state.catalog.auras) {
    let odds = aura.odds;
    let isBT = false;
    if (aura.native) {
      if (aura.biome === biome.id) odds = aura.odds / biome.luck;
      else { odds = aura.odds * 12; isBT = true; }
    }
    odds /= Math.max(1, luck);
    state.oddsById[aura.id] = { id: aura.id, odds: Math.max(1.0000001, odds), isBT };
  }
}

// --- loops -----------------------------------------------------------------

function tickCooldown() {
  const left = state.nextRollAt - Date.now();
  if (left > 0) {
    const total = state.profile?.stats.cooldownMs || 1000;
    ui.cooldown.style.width = `${Math.min(100, (left / total) * 100)}%`;
    ui.rollSub.textContent = `ready in ${(left / 1000).toFixed(1)}s`;
    ui.rollBtn.disabled = true;
  } else {
    ui.cooldown.style.width = '0%';
    if (!state.rolling && state.profile) {
      ui.rollBtn.disabled = false;
      const n = state.profile.stats.rollsPerAction;
      ui.rollSub.textContent = n > 1 ? `${n} auras per roll` : 'one aura per roll';
    }
  }
  requestAnimationFrame(tickCooldown);
}

function tickClock() {
  const b = state.world.biome;
  if (!b?.endsAt) return;
  const left = b.endsAt - Date.now();
  if (left <= 0) {
    refreshWorld();
  } else {
    ui.biomeTimer.textContent = `${fmtMs(left)} · ${b.luck > 1 ? `${b.luck}× native` : 'no bonus'}`;
  }
}

let autoTimer = null;
function syncAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  const perSec = state.profile?.stats.autoPerSec || 0;
  if (!ui.auto.checked || perSec < 1) return;
  // Auto roll is paced by the cooldown rather than a separate faster clock,
  // so it can never out-run the server-side limit.
  autoTimer = setInterval(() => {
    if (!state.rolling && Date.now() >= state.nextRollAt) doRoll();
  }, Math.max(120, (state.profile?.stats.cooldownMs || 1000) / perSec));
}

async function refreshWorld() {
  try {
    const w = await api.world();
    const changed = w.biome.id !== state.world.biome.id;
    applyBiome(w.biome);
    state.world = { ...state.world, ...w };
    ui.onlineCount.textContent = w.online;
    if (changed && state.profile) {
      toast(`${w.biome.name} is now active — ${w.biome.desc}`, 'gold', 4200);
      renderCurrentView();
    }
    if (!state.lastFeedId && w.feed.length) renderFeed(w.feed);
    markOnline();
  } catch {
    markOffline();
  }
}

// --- views -----------------------------------------------------------------

const actions = { buy: buyUpgrade, ascend: doAscend, refreshWorld };

function renderCurrentView() {
  if (!state.profile) return;
  applyOddsForCurrent();
  renderView(state.view, ui.view, state, actions);
}

async function buyUpgrade(upgradeId) {
  try {
    const res = await api.buy(state.profile.id, upgradeId);
    applyProfile(res.profile);
    toast('Upgrade purchased.', 'ok', 1600);
    syncAuto();
    renderCurrentView();
  } catch (err) {
    if (err.code === 'not_enough_essence') toast('Not enough essence yet.', 'bad', 1800);
    else if (err.code === 'maxed') toast('Already maxed out.', 'bad', 1800);
    else toast(`Purchase failed: ${err.message}`, 'bad');
  }
}

async function doAscend() {
  if (!state.profile?.canAscend) return;
  const nextMult = 1 + (state.profile.ascensions + 1) * 0.75;
  if (!confirm(`Ascend now?\n\nYou lose all levels and essence.\nYou keep every aura and record.\nPermanent luck becomes ${nextMult.toFixed(2)}×.`)) return;
  try {
    const res = await api.ascend(state.profile.id);
    applyProfile(res.profile);
    toast(`✦ Ascended! Permanent luck is now ${res.luckMult.toFixed(2)}×`, 'gold', 5000);
    syncAuto();
    renderCurrentView();
  } catch (err) {
    toast(err.code === 'not_ready' ? 'Not enough rolls to ascend yet.' : `Ascend failed: ${err.message}`, 'bad');
  }
}

// --- accounts --------------------------------------------------------------

function showJoin(message) {
  if (message) {
    const p = ui.joinModal.querySelector('p');
    p.textContent = message;
  }
  ui.joinModal.classList.add('is-on');
  ui.joinModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => ui.joinName.focus(), 60);
}

function hideJoin() {
  ui.joinModal.classList.remove('is-on');
  ui.joinModal.setAttribute('aria-hidden', 'true');
}

async function createAccount(name) {
  const res = await api.createPlayer(name);
  safeLocal(LS_PLAYER, res.id);
  await enterGame(res.id);
  toast(`Welcome, ${res.profile.name}. Roll something stupid.`, 'ok', 4000);
}

async function enterGame(id) {
  const data = await api.state(id);
  applyProfile(data.profile);
  applyOdds(data.odds);
  applyBiome(data.biome);
  state.world = { ...state.world, ...data };
  state.lastFeedId = null;
  ui.onlineCount.textContent = data.online;
  fx.reset();
  renderFeed(data.feed);
  renderCurrentView();
  ui.auto.checked = safeLocal(LS_AUTO) === '1' && data.profile.stats.autoPerSec >= 1;
  syncAuto();
  hideJoin();
  setRollEnabled(true);
}

async function switchAccount() {
  if (!confirm(`Delete "${state.profile.name}" and start over?\n\nThis permanently removes this profile from the database.`)) return;
  const old = state.profile.id;
  try { await api.remove(old); } catch { /* already gone — just forget it */ }
  safeLocal(LS_PLAYER, '');
  state.profile = null;
  state.lastFeedId = null;
  fx.reset();
  clear(ui.view);
  setRollEnabled(false);
  showJoin('Account deleted. Pick a name to start fresh.');
}

async function renameSelf() {
  const name = prompt('New name:', state.profile.name);
  if (name === null) return;
  try {
    const res = await api.rename(state.profile.id, name);
    applyProfile(res.profile);
    toast('Name updated.', 'ok', 1600);
  } catch (err) {
    toast(err.code === 'name_required' ? 'That name is empty.' : `Rename failed: ${err.message}`, 'bad');
  }
}

// --- events ----------------------------------------------------------------

function wireEvents() {
  ui.rollBtn.addEventListener('click', doRoll);

  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input, textarea, button')) {
      e.preventDefault();
      doRoll();
    }
  });

  ui.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    for (const t of ui.tabs.children) t.classList.toggle('is-active', t === btn);
    state.view = btn.dataset.view;
    renderCurrentView();
  });

  ui.auto.addEventListener('change', () => {
    safeLocal(LS_AUTO, ui.auto.checked ? '1' : '0');
    syncAuto();
  });

  $('#renameBtn').addEventListener('click', renameSelf);
  $('#resetBtn').addEventListener('click', switchAccount);

  ui.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = ui.joinForm.querySelector('button');
    const name = ui.joinName.value.trim();
    if (!name) return ui.joinName.focus();
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await createAccount(name);
      ui.joinName.value = '';
    } catch (err) {
      toast(err.code === 'name_taken' ? 'That name is taken — try another.' : `Could not join: ${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start rolling';
    }
  });

  // Re-sync the biome and cooldown when the tab comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshWorld();
      state.nextRollAt = Math.min(state.nextRollAt, Date.now());
    }
  });
}

// --- boot ------------------------------------------------------------------

async function boot() {
  try {
    state.catalog = await api.catalog();
    state.auraById = Object.fromEntries(state.catalog.auras.map((a) => [a.id, a]));
  } catch {
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div style="padding:1rem;background:#7f1d1d;color:#fff;font:14px system-ui">Could not reach the game server. Start it with <b>node server.js</b> and reload.</div>'
    );
    return;
  }

  wireEvents();
  applyBiome((await api.world()).biome);
  requestAnimationFrame(tickCooldown);
  setInterval(tickClock, 500);
  setInterval(pollFeed, 2500);
  setInterval(() => { if (state.profile) refreshWorld(); }, 20000);
  tickClock();

  const saved = safeLocal(LS_PLAYER);
  if (saved) {
    try {
      await enterGame(saved);
    } catch {
      safeLocal(LS_PLAYER, '');
      showJoin('That saved account no longer exists. Pick a name to start fresh.');
    }
  } else {
    showJoin();
  }
}

boot();
