import { api, getToken, setToken } from './api.js';
import { $, h, clear, fmt, fmtOdds, fmtMs, fmtClock, hexToRgba, toast, safeLocal } from './dom.js';
import { setCatalog, catalog, getBiome, ascendPoints, sellPrice, resolveAura, clickerCost, sparkIcon, achievementPoints } from './catalog.js';
import { renderView, renderTreeCanvas } from './views.js';
import { mirrorOdds } from './oddsmirror.js';
import * as fx from './rollfx.js';

// ---------------------------------------------------------------------------
// Vaixite's RNG V2 — client entry point.
//
// The server owns every truth (rolls, money, inventory, cooldowns, auth).
// This file mirrors state, drives the presentation and polls the shared world.
//
// Identity is a bearer token in localStorage:
//   • account token → the server loads the player from db.json (saved)
//   • guest token   → the server keeps the player in memory only (never saved)
// Losing the token or restarting the server therefore logs a guest out and
// throws their progress away, which is exactly the deal guests are shown.
// ---------------------------------------------------------------------------

const LS_AUTO = 'vrng2.auto';
const LB_SORT = 'vrng2.lbSort';
const LS_TRUE_ODDS = 'vrng2.trueOdds';
const LS_QUICK = 'vrng2.quick';
const LS_CUTSCENE = 'vrng2.cutsceneMin';
// The two idle switches. Like the rest they are a device preference, not save
// data: the server only ever sees "tick the drill / the clicker", and it pays
// out real elapsed time, so switching them off never loses anything earned.
const LS_AUTO_MINE = 'vrng2.autoMine';
const LS_AUTO_CLICK = 'vrng2.autoClick';
// Drag-resized side columns — a device preference like the rest: the server
// never hears about it, and double-clicking a gutter snaps it back.
const LS_FEED_W = 'vrng2.feedW';
const LS_SIDE_W = 'vrng2.sideW';

const state = {
  // Live views of the catalog singleton — setCatalog() replaces its fields, so
  // these have to be getters rather than snapshots.
  get catalog() { return catalog; },
  get auraById() { return catalog.auraById; },
  profile: null,
  oddsById: {},
  world: { biome: null, feed: [], leaderboard: [], online: 0 },
  // The feed panel's own list, newest-first by arrival. Order on screen is
  // derived from it (see renderFeed), never stored, so a pin expiring between
  // two polls cannot leave a stale row stuck at the top.
  feed: [],
  feedPainted: null,
  feedSeen: new Set(),
  // Live "📌 0:47" nodes of the rows currently on screen, refreshed by the
  // 500ms clock so a countdown never repaints the list.
  feedPins: [],
  // The ranked board, fetched on demand: it carries the sort list and your own
  // rank, which the world payload deliberately does not.
  board: null,
  lbSort: 'best',
  // The badge board, fetched on demand for the same reason. `achSeen` is what
  // this tab has already been told about: every profile carries the full
  // id -> unlockedAt map, so the difference between it and this set is what
  // just unlocked. Null until the first profile of the session primes it —
  // otherwise signing in would toast every badge you have ever earned.
  achievements: null,
  achSeen: null,
  achGroup: 'tier',
  achHideDone: false,
  view: 'inventory',
  newAuras: new Set(),
  rolling: false,
  nextRollAt: 0,
  lastFeedId: null,
  offline: false,
  authMode: 'login',
  // Presentation settings (localStorage) + overlay state.
  trueOdds: false,
  quick: false,
  // The aura whose dossier is open, or null. Only used to keep Esc / the
  // backdrop / signing out from leaving a stale card behind.
  auraInfo: null,
  treeOpen: false,
  treeZoom: 1,
  // Mining picks have a short server-side cooldown; this is the local echo of
  // it, so the rocks stop asking for a 429.
  mineLockUntil: 0,
  // Same trick for the clicker's tap cooldown (content/clicker.json). It is
  // only a throttle — the server answers a too-early tap with 429 anyway, and
  // the button stays clickable so a fast finger never feels a stutter.
  clickLockUntil: 0,
  // Idle switches, restored from localStorage on entry. They only decide
  // whether the client keeps asking for ticks — the server decides what a tick
  // is worth, so leaving them on is never worth more than being away.
  autoMine: false,
  autoClick: false,
  // Admin panel working set. Only ever populated for a player the server put
  // on admins.json; `form` holds what is typed in the fields so a re-render
  // after an action never throws it away.
  admin: {
    players: [],
    detail: null,
    server: null,
    admins: [],
    adminsFile: '',
    audit: [],
    biomeOverride: null,
    form: {},
    busy: false,
    loadedAt: 0,
  },
};

const ui = {
  who: $('#who'),
  luck: $('#hudLuck'), luckOff: $('#luckOffChip'), money: $('#hudMoney'), essence: $('#hudEssence'),
  rolls: $('#hudRolls'), lifetime: $('#hudLifetime'), best: $('#hudBest'), buffs: $('#buffs'),
  rollBtn: $('#rollBtn'), rollSub: $('#rollSub'), cooldown: $('#cooldownBar'),
  feed: $('#feed'), view: $('#view'), tabs: $('#tabs'),
  biomeName: $('#biomeName'), biomeTimer: $('#biomeTimer'), biomeDot: $('#biomeDot'), biomeChip: $('#biomeChip'),
  collectCount: $('#collectCount'), collectBar: $('#collectBar'), ascendInfo: $('#ascendInfo'),
  lifetimeInfo: $('#lifetimeInfo'),
  onlineCount: $('#onlineCount'), auto: $('#autoToggle'), quickBtn: $('#quickToggle'),
  settingsBtn: $('#settingsBtn'), settingsModal: $('#settingsModal'), settingsClose: $('#settingsClose'),
  auraModal: $('#auraModal'), auraModalCard: $('#auraModalCard'),
  setTrueOdds: $('#setTrueOdds'), setLuck: $('#setLuck'), setCutscene: $('#setCutscene'),
  tabTree: $('#tabTree'), tabMining: $('#tabMining'), tabClicker: $('#tabClicker'), tabAdmin: $('#tabAdmin'),
  achBadge: $('#achBadge'),
  treeOverlay: $('#treeOverlay'), treeCanvas: $('#treeCanvas'), treeTip: $('#treeTip'),
  treePoints: $('#treePoints'), treeReturn: $('#treeReturn'),
  authModal: $('#authModal'), authForm: $('#authForm'), authUser: $('#authUser'),
  authPass: $('#authPass'), authSubmit: $('#authSubmit'), authError: $('#authError'),
  guestBtn: $('#guestBtn'),
  accountBar: $('#accountBar'),
  sky: document.documentElement,
};

// --- helpers -----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgoText(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

// HUD numbers earn their animation: a repaint of the same value must not shake
// the row, so the bump only fires when the text actually changed.
function setNum(el, val) {
  const s = String(val);
  if (el.textContent === s) return;
  el.textContent = s;
  el.classList.remove('bump');
  void el.offsetWidth; // restart the keyframe even on back-to-back changes
  el.classList.add('bump');
}

// --- state application --------------------------------------------------------

function applyProfile(profile) {
  state.profile = profile;

  const tag = profile.guest
    ? ' <span class="guest-tag" title="Guests are never saved — refresh or restart the server and this account is gone.">no save</span>'
    : '';
  ui.who.innerHTML =
    `signed in as <b>${escapeHtml(profile.name)}</b>${tag} · ` +
    (profile.ascensions ? `✦ ${profile.ascensions} ascension${profile.ascensions > 1 ? 's' : ''}` : 'first roll awaits');

  // Luck reads as what it is: dimmed and badged while the player has it switched
  // off, because every number on screen is then the authored 1× table.
  ui.luck.textContent = `${profile.stats.luck.toFixed(2)}×`;
  ui.luck.classList.toggle('is-dim', !!profile.luckOff);
  ui.luckOff.hidden = !profile.luckOff;

  setNum(ui.money, fmt(profile.money));
  setNum(ui.essence, fmt(profile.essence));
  setNum(ui.rolls, fmt(profile.totalRolls));
  setNum(ui.lifetime, fmt(profile.lifetimeRolls || 0));
  ui.lifetimeInfo.textContent = `Lifetime rolls: ${(profile.lifetimeRolls || 0).toLocaleString('en-US')}`;

  const best = profile.best && state.auraById[profile.best.auraId];
  ui.best.textContent = best ? best.name : '—';
  ui.best.style.color = best ? best.color : '';
  ui.best.title = profile.best ? fmtOdds(profile.best.odds) : 'no rolls yet';

  // Clamped: owning an aura the host later deleted can push you past the count
  // of auras that still exist, and a bar cannot be 105% wide.
  const pct = profile.totalAuras ? Math.min(100, (profile.unique / profile.totalAuras) * 100) : 0;
  ui.collectCount.textContent = `${profile.unique} / ${profile.totalAuras}`;
  ui.collectBar.style.width = `${pct}%`;
  ui.ascendInfo.textContent = profile.canAscend
    ? 'Ascend is ready — trade your levels for permanent luck and Ascend Points.'
    : `${fmt(profile.ascendRequirement - profile.totalRolls)} more rolls to unlock Ascend.`;

  ui.auto.disabled = profile.stats.autoPerSec < 1;
  if (ui.auto.disabled) ui.auto.checked = false;

  // The two permanent-progression tabs only exist once they have been earned.
  ui.tabTree.style.display = profile.treeUnlocked ? '' : 'none';
  ui.tabMining.style.display = profile.miningUnlocked ? '' : 'none';
  // The clicker hangs off its own Ascend node, so it appears mid-run too.
  ui.tabClicker.style.display = profile.clickerUnlocked ? '' : 'none';
  // The Admin tab mirrors the server's allowlist and is never a switch: the
  // flag comes from admins.json, and every admin call re-checks it regardless.
  ui.tabAdmin.style.display = profile.isAdmin ? '' : 'none';
  if (!profile.isAdmin && state.view === 'admin') {
    state.view = 'inventory';
    for (const t of ui.tabs.children) t.classList.toggle('is-active', t.dataset.view === 'inventory');
  }
  // An admin can hand the Arcade Cabinet back, which strands the view you are
  // standing in — same fallback as the Admin tab above.
  if (!profile.clickerUnlocked && state.view === 'clicker') {
    state.view = 'inventory';
    for (const t of ui.tabs.children) t.classList.toggle('is-active', t.dataset.view === 'inventory');
  }
  paintAchBadge();
  announceAch(profile);
  syncQuickBtn(profile);
  if (ui.setLuck && document.activeElement !== ui.setLuck) ui.setLuck.checked = !profile.luckOff;

  renderBuffs();
  if (state.treeOpen) renderTreeOverlay();
  // Every rate the idle earners depend on arrives with the profile — a tree
  // level, an Auto Clicker upgrade, an admin taking a node back. Re-checking
  // here means the timers can never disagree with what the server just said.
  syncIdle();
}

// --- achievements ----------------------------------------------------------------
// The profile already carries the id -> unlockedAt map on every response, so
// noticing a badge needs no extra polling: the client remembers what it has
// seen and reads the difference. The board itself — a progress bar for every
// metric — is a separate fetch, because a roll response has no business
// carrying measurements for a tab you are not looking at.

/** Count what is owned straight off the catalog + the profile's map, so the
 *  tab badge is always current even when the board itself was never fetched. */
function achTally() {
  const owned = state.profile?.achievements || {};
  const defs = catalog.achievements || [];
  let unlocked = 0;
  let points = 0;
  for (const d of defs) {
    if (!owned[d.id]) continue;
    unlocked++;
    points += achievementPoints(d);
  }
  return { unlocked, points, total: defs.length, pointsTotal: Number(catalog.achievementPointsTotal) || 0 };
}

function paintAchBadge() {
  if (!ui.achBadge) return;
  const t = achTally();
  ui.achBadge.textContent = `${t.unlocked}/${t.total}`;
  ui.achBadge.title =
    `${t.unlocked} of ${t.total} badges · ${t.points.toLocaleString('en-US')} of ` +
    `${t.pointsTotal.toLocaleString('en-US')} Achievement Points`;
}

/** Toast whatever this profile added, and drop the now-stale cached board. */
function announceAch(profile) {
  const owned = profile.achievements || {};
  if (!state.achSeen) {
    // First profile of the session. Everything in here happened before this tab
    // was open, so it is remembered quietly — signing in must not fire a toast
    // for a badge you earned last week.
    state.achSeen = new Set(Object.keys(owned));
    return;
  }
  const fresh = Object.keys(owned).filter((id) => !state.achSeen.has(id));
  for (const id of fresh) state.achSeen.add(id);
  if (!fresh.length) return;

  // The cached board was measured before these landed.
  state.achievements = null;
  if (state.view === 'achievements') loadAchievements();

  const byId = catalog.achievementById || {};
  const tiers = catalog.achievementTierById || {};
  // One roll can finish half a dozen badges; shout about the best three.
  const sorted = fresh
    .map((id) => byId[id])
    .filter(Boolean)
    .sort((a, b) => achievementPoints(b) - achievementPoints(a));
  for (const def of sorted.slice(0, 3)) {
    const tier = tiers[def.tier] || {};
    toast(`${def.icon || '🏅'} ${def.name} — ${tier.name || 'badge'} · +${achievementPoints(def)} pts`, 'gold', 4200);
  }
  if (sorted.length > 3) toast(`🏅 ${sorted.length - 3} more badges unlocked`, 'gold', 4200);
}

// Quick Roll is a lifetime reward: 100 rolls and it is there forever.
function syncQuickBtn(profile) {
  const unlocked = !!profile.quickRollUnlocked;
  const need = catalog.config?.quickRoll?.unlockRolls ?? 100;
  ui.quickBtn.disabled = !unlocked;
  ui.quickBtn.classList.toggle('is-on', unlocked && state.quick);
  ui.quickBtn.setAttribute('aria-pressed', String(unlocked && state.quick));
  ui.quickBtn.title = unlocked
    ? 'Skip the roulette — the reveal is instant, cutscenes still play.'
    : `Unlocks at ${need} rolls — ${(profile.lifetimeRolls || 0).toLocaleString('en-US')}/${need}`;
  if (!unlocked && state.quick) {
    state.quick = false;
    safeLocal(LS_QUICK, '0');
  }
}

function applyOdds(list) {
  state.oddsById = {};
  for (const o of list) state.oddsById[o.id] = o;
}

// --- ascend tree overlay -------------------------------------------------------
// The Tree is a full-screen constellation, not a side panel: opening it is like
// stepping into a shop, and "Return to World" steps back out. Nodes are drawn by
// views.renderTreeCanvas from content/ascendTree.json coordinates.

function renderTreeOverlay() {
  if (!state.profile) return;
  ui.treePoints.textContent = `✦ ${fmt(state.profile.ascendPoints || 0)}`;
  ui.treeCanvas.style.transform = `scale(${state.treeZoom})`;
  renderTreeCanvas(ui.treeCanvas, ui.treeTip, state, actions);
}

function openTree() {
  if (!state.profile?.treeUnlocked) return;
  state.treeOpen = true;
  ui.treeOverlay.classList.add('is-on');
  ui.treeOverlay.setAttribute('aria-hidden', 'false');
  for (const t of ui.tabs.children) t.classList.toggle('is-active', t === ui.tabTree);
  renderTreeOverlay();
}

function closeTree() {
  if (!state.treeOpen) return;
  state.treeOpen = false;
  ui.treeOverlay.classList.remove('is-on');
  ui.treeOverlay.setAttribute('aria-hidden', 'true');
  // Hand the active-tab highlight back to whatever panel is actually showing.
  for (const t of ui.tabs.children) t.classList.toggle('is-active', t.dataset.view === state.view);
}

function setTreeZoom(z) {
  state.treeZoom = Math.min(1.6, Math.max(0.6, Math.round(z * 10) / 10));
  ui.treeCanvas.style.transform = `scale(${state.treeZoom})`;
}

async function buyNode(nodeId) {
  try {
    const res = await api.buyNode(nodeId);
    adopt(res.profile); // applyProfile repaints the tree while it is open
    toast('Node upgraded — permanent, forever.', 'ok', 1700);
  } catch (err) {
    if (err.code === 'not_enough_points') toast(`Needs ✦${fmt(err.data?.cost || 0)} — not enough Ascend Points.`, 'bad', 2200);
    else if (err.code === 'locked') toast('Buy its prerequisite first.', 'bad', 1900);
    else if (err.code === 'maxed') toast('Already maxed out.', 'bad', 1600);
    else if (err.code === 'must_ascend') toast('Ascend once to unlock the Tree.', 'bad', 1900);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Purchase failed: ${err.message}`, 'bad');
  }
}

// --- mining shaft ----------------------------------------------------------------
// One cell per click; the server owns the pick cooldown and answers 429 while it
// swings. mineLockUntil is the local echo so the rocks stop asking.

async function mineCell(cell) {
  if (Date.now() < state.mineLockUntil) return;
  try {
    const res = await api.mineReveal(cell);
    state.mineLockUntil = Date.now() + (catalog.mining?.pickCooldownMs || 600);
    adopt(res.profile);
    const o = res.ore;
    // Dig results get their own toast flavour — same stack as the roll
    // toasts, but they pop up from below instead of sliding in from the
    // right, so the two can never be confused mid-session.
    toast(`${o.icon} ${o.name}! +💰${fmt(res.money)} +💠${fmt(res.essence)}`, o.odds >= 350 ? 'dig gold' : 'dig ok', 2600);
    if (res.depleted) toast('✨ Vein depleted — dig a new one.', 'dig gold', 3800);
  } catch (err) {
    if (err.code === 'cooldown') state.mineLockUntil = Date.now() + (err.data?.retryInMs || 600);
    else if (err.code === 'already_revealed' || err.code === 'bad_cell') { /* stale click, ignore */ }
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Dig failed: ${err.message}`, 'bad');
    if (state.view === 'mining') renderCurrentView();
  }
}

async function digVein() {
  try {
    const res = await api.mineReset();
    state.mineLockUntil = 0;
    adopt(res.profile);
    toast('⛏ A fresh vein — twelve cells of hidden ore. Swing away.', 'dig ok', 2400);
  } catch (err) {
    if (err.code === 'locked') toast('The Mining License is a node in the Ascend Tree.', 'bad', 2400);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Dig failed: ${err.message}`, 'bad');
  }
}

// --- spark clicker -----------------------------------------------------------------
// The arcade cabinet: click for Sparks, spend Sparks. The server rolls every
// click (crits included) and owns the tap cooldown, so this is only the echo —
// the button never disables itself for 60 ms, it just stops asking.

/** The currency is data too (content/clicker.json → currency.name). */
function sparkName() {
  return (catalog.clicker && catalog.clicker.currency && catalog.clicker.currency.name) || 'Sparks';
}

/** A `+N ⚡` that floats up from wherever the tap happened and removes itself. */
function sparkFloat(e, gained, crit) {
  const el = h('span', { class: `spark-float${crit ? ' is-crit' : ''}` }, `+${fmt(gained)} ${sparkIcon()}`);
  let x = e && e.clientX;
  let y = e && e.clientY;
  if (!x && !y && e && e.currentTarget && e.currentTarget.getBoundingClientRect) {
    const r = e.currentTarget.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  el.style.left = `${Math.round(x || window.innerWidth / 2)}px`;
  el.style.top = `${Math.round(y || window.innerHeight / 2)}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 760);
}

async function tapClicker(e) {
  if (Date.now() < state.clickLockUntil) return;
  state.clickLockUntil = Date.now() + (catalog.clicker?.clickCooldownMs || 60);
  try {
    const res = await api.clickTap();
    applyProfile(res.profile);
    paintClicker(res.profile);
    sparkFloat(e, res.gained, res.crit);
    if (res.crit) toast(`💥 Crit click! +${fmt(res.gained)} ${sparkIcon()}`, 'gold', 1800);
  } catch (err) {
    if (err.code === 'cooldown') state.clickLockUntil = Date.now() + (err.data?.retryInMs || 60);
    else if (err.code === 'locked') {
      toast('The Arcade Cabinet is a node in the Ascend Tree.', 'bad', 2400);
      renderCurrentView();
    } else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Click failed: ${err.message}`, 'bad');
  }
}

async function buyClickerUpgrade(id) {
  const def = catalog.clickerById[id];
  try {
    const res = await api.clickBuy(id);
    applyProfile(res.profile);
    toast(`${def?.icon || sparkIcon()} ${def?.name || id} → Lv ${res.level}`, 'ok', 2200);
    // Effects change the whole panel (per-click, luck, roll speed), so this one
    // really does want the full repaint, then a re-timed idle loop.
    renderCurrentView();
    syncIdle();
  } catch (err) {
    if (err.code === 'not_enough_sparks') toast(`Not enough ${sparkName()} for that yet.`, 'bad', 1800);
    else if (err.code === 'maxed') toast('That one is already maxed out.', 'bad', 1800);
    else if (err.code === 'locked') toast('The Arcade Cabinet is a node in the Ascend Tree.', 'bad', 2400);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Purchase failed: ${err.message}`, 'bad');
  }
}

/**
 * Write the numbers that move between repaints straight into the clicker panel.
 * Auto clicks land about once a second and a fast finger taps far more often
 * than that, so a full renderView here would replace the button mid-press.
 */
function paintClicker(profile) {
  const live = ui.view.__clicker;
  if (!live || state.view !== 'clicker' || !profile || !profile.clicker) return;
  const c = profile.clicker;
  const sparks = Number(c.sparks) || 0;
  live.sparks.textContent = fmt(sparks);
  live.life.textContent = fmt(Number(c.totalSparks) || 0);
  for (const [id, card] of live.cards) {
    const level = Number(c.levels?.[id]) || 0;
    const maxed = card.def.max > 0 && level >= card.def.max;
    const cost = clickerCost(card.def, level);
    card.lvl.textContent = maxed ? 'MAX' : `Lv ${level}`;
    card.btn.textContent = maxed ? 'MAXED' : `${sparkIcon()} ${fmt(cost)}`;
    card.btn.disabled = maxed || sparks < cost;
    card.btn.classList.toggle('maxed', maxed);
  }
}

// --- idle earners --------------------------------------------------------------------
// The auto drill and the arcade auto-clicker are both banked real time on the
// server: a tick pays for the wall-clock time since the last one, capped per
// tick. So the interval below only decides how often the numbers move — never
// how much you earn. Spamming the route is worthless, and so is leaving these
// switched on overnight.

let mineTimer = null;
let clickTimer = null;
let idleToastAt = 0;

function syncIdle() {
  const stats = (state.profile && state.profile.stats) || {};

  const mineRate = Number(stats.autoMinePerSec) || 0;
  if (mineTimer && !(state.autoMine && mineRate > 0)) {
    clearInterval(mineTimer);
    mineTimer = null;
  }
  if (!mineTimer && state.autoMine && mineRate > 0) {
    mineTimer = setInterval(idleMineTick, Math.max(500, Math.ceil(1000 / mineRate)));
  }

  const clickRate = Number(stats.autoClickPerSec) || 0;
  if (clickTimer && !(state.autoClick && clickRate > 0)) {
    clearInterval(clickTimer);
    clickTimer = null;
  }
  if (!clickTimer && state.autoClick && clickRate > 0) {
    clickTimer = setInterval(idleClickTick, Math.max(500, Math.ceil(1000 / clickRate)));
  }
}

/** Idle ticks only repaint the two views they actually move. */
function idleAdopt(profile) {
  applyProfile(profile);
  if (state.view === 'clicker') paintClicker(profile);
  else if (state.view === 'mining') renderCurrentView();
}

/** Switch an earner off from the server side (node gone, level gone). */
function stopIdle(key, message) {
  state[key] = false;
  safeLocal(key === 'autoMine' ? LS_AUTO_MINE : LS_AUTO_CLICK, '0');
  syncIdle();
  renderCurrentView();
  if (message) toast(message, 'bad', 2600);
}

// The two switches are pure preference: they decide whether this device keeps
// asking for ticks, and they are remembered per browser, never in the save.
function setAutoMine(on) {
  state.autoMine = !!on;
  safeLocal(LS_AUTO_MINE, on ? '1' : '0');
  syncIdle();
  renderCurrentView();
  if (on) toast('🦾 The drill is running.', 'dig ok', 1800);
}

function setAutoClick(on) {
  state.autoClick = !!on;
  safeLocal(LS_AUTO_CLICK, on ? '1' : '0');
  syncIdle();
  renderCurrentView();
  if (on) toast('🤖 The cabinet is clicking by itself.', 'ok', 1800);
}

async function idleMineTick() {
  try {
    const res = await api.mineAuto();
    idleAdopt(res.profile);
    if (!(res.dug > 0)) return;
    const top = res.finds[0];
    // One toast every fifteen seconds at most — a drill that never stops should
    // not be a toast that never stops. Rare hits and new veins always speak.
    const rare = top && top.odds >= 350;
    if ((rare || res.newVein || Date.now() - idleToastAt > 15000) && top) {
      idleToastAt = Date.now();
      toast(
        `🦾 ${top.count > 1 ? `${top.count}× ` : ''}${top.icon} ${top.name} · +💰${fmt(res.money)} +💠${fmt(res.essence)}`,
        rare ? 'dig gold' : 'dig ok',
        2400
      );
    }
    if (res.newVein) toast('⛏ The drill broke through into a fresh vein.', 'dig ok', 2800);
  } catch (err) {
    if (err.code === 'no_auto') stopIdle('autoMine', 'The Auto Drill needs a level of Auto Drill.');
    else if (err.code === 'locked') stopIdle('autoMine', 'Mining is a node in the Ascend Tree.');
    else if (err.code === 'unauthorized') forceRelogin();
    // Anything else stays quiet: the next tick tries again.
  }
}

async function idleClickTick() {
  try {
    const res = await api.clickAuto();
    idleAdopt(res.profile);
    if (!(res.clicks > 0)) return;
    if (Date.now() - idleToastAt > 15000) {
      idleToastAt = Date.now();
      toast(`🤖 +${fmt(res.gained)} ${sparkIcon()} from the cabinet${res.crits ? ' 💥' : ''}`, 'ok', 2200);
    }
  } catch (err) {
    if (err.code === 'no_auto') stopIdle('autoClick', 'The Auto Clicker needs an Auto Clicker upgrade.');
    else if (err.code === 'locked') stopIdle('autoClick', 'The Arcade Cabinet is a node in the Ascend Tree.');
    else if (err.code === 'unauthorized') forceRelogin();
  }
}

// --- settings modal ---------------------------------------------------------------

function setSettingsOpen(on) {
  ui.settingsModal.classList.toggle('is-on', on);
  ui.settingsModal.setAttribute('aria-hidden', String(!on));
  ui.settingsBtn.setAttribute('aria-expanded', String(on));
}

// The cutscene threshold is pure presentation: the dropdown lists every tier
// plus "Never", and rollfx gates the takeover exactly like a real pull. The
// saved value is a tier index (or the Never sentinel); anything unparseable
// falls back to the game default from the catalog.
const CUTSCENE_NEVER = 999;

function fillCutsceneChoices() {
  clear(ui.setCutscene);
  (catalog.rarityTiers || []).forEach((t, i) => {
    ui.setCutscene.append(h('option', { value: String(i), style: { color: t.color } }, t.name));
  });
  ui.setCutscene.append(h('option', { value: String(CUTSCENE_NEVER) }, 'Never'));
}

function applyBiome(biome) {
  if (!biome) return;
  state.world.biome = biome;
  const b = getBiome(biome.id) || biome;
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

// Active consumable effects (luck elixirs and friends) as countdown chips.
function renderBuffs() {
  const buffs = state.profile?.buffs || [];
  clear(ui.buffs);
  for (const b of buffs) {
    // A one-roll potion has no clock — it waits for the next roll, even across
    // a restart — so its chip counts charges, not seconds.
    if (b.type === 'nextRollLuck') {
      const rolls = Math.max(1, b.rolls || 1);
      ui.buffs.append(
        h(
          'span',
          {
            class: 'buff is-potion',
            title: `+${fmt(b.add || 0)} Luck on your next roll${rolls > 1 ? ` · ${rolls} charges banked` : ''}`,
          },
          `✨ +${fmt(b.add || 0)} luck`,
          h('b', {}, rolls > 1 ? `×${rolls}` : 'next roll')
        )
      );
      continue;
    }
    const left = b.until - Date.now();
    if (left <= 0) continue;
    ui.buffs.append(
      h(
        'span',
        { class: 'buff', title: `${b.mult}× luck for ${fmtMs(left)} left` },
        `🧪 ${b.mult}× luck`,
        h('b', {}, fmtMs(left))
      )
    );
  }
  ui.buffs.classList.toggle('is-on', ui.buffs.children.length > 0);
}

// --- world feed ----------------------------------------------------------------
// Two clocks run on this panel. A rare pull holds the top for a window that
// scales with how rare it was (content/config.json → feedPin), then drops back
// into the chronological list; and every roll leaves the feed altogether once it
// is older than feedTtl.ms. The server prunes and orders the same way; this
// mirror is what keeps an already-open page honest as those windows expire,
// since nothing else repaints the panel when a timer runs out.

const FEED_CAP = 60;

function feedHoldMs(e) {
  const tiers = catalog.config?.feedPin?.tiers || [];
  let hold = 0;
  for (const t of tiers) if (e.odds >= t.minOdds && t.holdMs > hold) hold = t.holdMs;
  return hold;
}

const feedPinned = (e, now) => now - e.at < feedHoldMs(e);

// The same age limit the server prunes with (content/config.json → feedTtl).
// Mirrored here because this panel keeps its rows between polls: without it a
// row would sit on screen until the next full re-seed, which on a quiet server
// is never. Pinned rows are exempt while they hold, and an announcement is not a
// roll, so it stays until the cap pushes it out.
function feedTtlMs() {
  const ms = Number(catalog.config?.feedTtl?.ms);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function feedExpired(e, now) {
  const ttl = feedTtlMs();
  if (!ttl) return false;
  if (e.announcement && catalog.config?.feedTtl?.keepAnnouncements !== false) return false;
  if (feedPinned(e, now)) return false;
  return now - (Number(e.at) || 0) > ttl;
}

// Rows worth shouting about get their rarity tier as a background wash; the
// rest of the ticker stays plain. Threshold: content/config.json → feedTierBg.
function tierTint(e) {
  const min = catalog.config?.feedTierBg?.minOdds ?? Infinity;
  if (!(e.odds >= min)) return null;
  const color = (catalog.rarityTiers || []).find((t) => t.id === e.tier)?.color || e.color;
  if (!color) return null;
  return {
    color,
    background: `linear-gradient(90deg, ${hexToRgba(color, 0.26)}, ${hexToRgba(color, 0.07)} 72%, transparent)`,
  };
}

// Pinned entries first (rarest pull wins), then everything else newest-first.
function sortFeed(entries, now) {
  return [...entries].sort((a, b) => {
    const pa = feedPinned(a, now);
    const pb = feedPinned(b, now);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb && a.odds !== b.odds) return b.odds - a.odds;
    return b.at - a.at;
  });
}

// Fold a poll into the local feed: dedupe by id, drop what has aged out, newest
// first, capped. The filter is what makes a row vanish while you are looking at
// it — the server stops sending it, but this list is additive, so it has to be
// told to let go as well.
function mergeFeed(entries) {
  const now = Date.now();
  const byId = new Map(state.feed.map((e) => [e.id, e]));
  for (const e of entries) byId.set(e.id, e);
  state.feed = [...byId.values()]
    .filter((e) => !feedExpired(e, now))
    .sort((a, b) => b.at - a.at)
    .slice(0, FEED_CAP);
}

// Replace the feed wholesale — signing in, or the first world payload we see.
function seedFeed(entries) {
  state.feed = [];
  state.feedSeen = new Set();
  mergeFeed(entries);
  // The cursor is the *newest* entry, not the one on top of the panel: a pinned
  // pull sits at the top without being the newest thing the server has, and
  // /api/feed?after= counts on a chronological cursor.
  state.lastFeedId = state.feed[0]?.id ?? null;
  state.feedPainted = null;
  renderFeed();
}

// Repaint only when the order or the pin flags actually moved, so the 500ms clock
// does not churn the list — or replay the slide-in — on an idle feed.
function renderFeed() {
  const now = Date.now();
  // Filtered here as well as in mergeFeed: the 500ms clock calls this, so a row
  // leaves within half a second of its window instead of at the next poll. A row
  // disappearing changes the signature below, so the repaint needs no nudge.
  const ordered = sortFeed(state.feed, now).filter((e) => !feedExpired(e, now));
  const sig = ordered.map((e) => `${e.id}${feedPinned(e, now) ? '!' : ''}`).join(',');
  if (sig === state.feedPainted) return;
  state.feedPainted = sig;

  clear(ui.feed);
  state.feedPins = [];
  if (!ordered.length) {
    ui.feed.append(h('p', { class: 'muted' }, 'Waiting for rolls…'));
    return;
  }
  for (const e of ordered) {
    const aura = state.auraById[e.auraId];
    const fresh = !state.feedSeen.has(e.id);
    state.feedSeen.add(e.id);
    const pinned = feedPinned(e, now);
    const tint = tierTint(e);
    const row = h(
      'div',
      {
        class: `feed-item${pinned ? ' is-pinned has-pin' : ''}${tint ? ' is-tinted' : ''}${fresh ? ' is-new' : ''}${e.announcement ? ' is-announcement' : ''}`,
        style: {
          color: e.color || aura?.color,
          background: tint?.background,
          borderLeftColor: tint?.color,
        },
        title: `${e.biomeName} · ${timeAgoText(e.at)}`,
      },
      h('span', { class: 'who-name' }, e.player),
      // A staff announcement is a sentence, not a roll — no "rolled", no odds.
      ...(e.announcement
        ? [h('span', { class: 'aura-name' }, e.auraName)]
        : [
            h('span', { class: 'muted' }, 'rolled'),
            h('span', { class: 'aura-name' }, e.auraName),
            e.isBT ? h('span', { class: 'bt-flag' }, 'BT') : null,
            // The feed always shows the true odds the server sent — it is a
            // report of what actually happened, not the player's own preference.
            h('span', { class: 'odds' }, fmtOdds(e.odds)),
          ])
    );
    if (pinned) {
      // A thin countdown to unpinning. The clock writes into these nodes instead
      // of repainting the list, so a ticking pin never replays any animation.
      const pin = h('span', { class: 'pin-line' }, `📌 ${fmtClock(e.at + feedHoldMs(e) - now)}`);
      row.append(pin);
      state.feedPins.push({ node: pin, until: e.at + feedHoldMs(e) });
    }
    ui.feed.append(row);
  }
  // Keep the seen-set from growing for the length of an open tab.
  if (state.feedSeen.size > FEED_CAP * 3) state.feedSeen = new Set(ordered.map((e) => e.id));
}

function updateFeedPins(now) {
  for (const p of state.feedPins) {
    p.node.textContent = `📌 ${fmtClock(p.until - now)}`;
  }
}

async function pollFeed() {
  try {
    const { feed } = await api.feed(state.lastFeedId);
    if (feed.length) {
      // /api/feed is chronological newest-first, so its head is the new cursor.
      state.lastFeedId = feed[0].id;
      mergeFeed(feed);
      renderFeed();
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

// --- rolling --------------------------------------------------------------------

function setRollEnabled(on) {
  ui.rollBtn.disabled = !on || !state.profile;
}

async function doRoll() {
  if (state.rolling || !state.profile) return;
  if (Date.now() < state.nextRollAt) return;

  state.rolling = true;
  ui.rollBtn.disabled = true;
  // Quick Roll (unlocked at 100 lifetime rolls) skips the roulette entirely —
  // the reveal is instant, cutscenes still play.
  const spinner = state.quick
    ? null
    : fx.spin(catalog.auras, {
        oddsOf: (a) => (state.trueOdds ? state.oddsById[a.id]?.odds ?? a.odds : a.odds),
        // The strip scrolls past what you can actually roll right now: rows are
        // drawn with the live luck-bent shares, and auras the luck floor has
        // removed (share 0) never appear at all.
        weightOf: (a) => state.oddsById[a.id]?.share ?? 1 / a.odds,
      });

  try {
    const res = await api.roll(state.profile.stats.rollsPerAction);
    markOnline();

    state.nextRollAt = Date.now() + res.stats.cooldownMs;
    applyProfile(res.profile);

    // A Heavenly Potion is spent by the roll it just powered — say so, because
    // the luck number on the HUD drops back the instant it is gone.
    if (res.potionBoost) {
      toast(
        `✨ Potion spent: +${fmt(res.potionBoost)} Luck on that roll${res.potionsSpent ? ' · bottle empty' : ''}`,
        'gold',
        3200
      );
    }

    // Rarest first for the big reveal.
    const results = [...res.results].sort((a, b) => b.odds - a.odds);
    const top = results[0];

    // Let the strip decelerate onto the real result before anything is painted.
    if (spinner) await spinner.land(top);

    // Multi-roll: every aura gets its own sphere under the stage, popping in
    // rarity order. Single rolls clear the row.
    fx.showOrbs(results);

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
    if (spinner) spinner(); // stop the roulette on any failure path
    if (err.code === 'cooldown') {
      state.nextRollAt = Date.now() + (err.data?.retryInMs || 300);
    } else if (err.code === 'unauthorized') {
      forceRelogin();
    } else if (err.code === 'offline' || err.code === 'bad_response' || err.status >= 500) {
      markOffline();
    } else {
      toast(`Roll failed: ${err.message}`, 'bad');
    }
  } finally {
    state.rolling = false;
    setTimeout(() => state.newAuras.clear(), 2500);
  }
}

// Mirror of the server's pool maths, so the bestiary, the dossier and the roll
// roulette stay current between polls. The arithmetic itself lives in
// oddsmirror.js, which scripts/test-odds-mirror.js pins against buildPool.
function applyOddsForCurrent() {
  const biome = getBiome(state.world.biome?.id);
  if (!biome) return;
  // With luck switched off the server rolls the authored 1× table — the mirror
  // has to bend the same way or the bestiary and the roulette would lie.
  const luck = state.profile?.luckOff ? 1 : Math.max(1, state.profile?.stats.luck || 1);
  Object.assign(
    state.oddsById,
    mirrorOdds({ auras: catalog.auras, luck, biome, btMultiplier: catalog.btMultiplier })
  );
}

// --- loops ------------------------------------------------------------------------

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
      if (ui.rollBtn.disabled && !ui.auto.checked) {
        // The instant the cooldown lapses: one shine across the button, so the
        // "you may roll again" moment is felt without watching the sub-text.
        // Auto roll skips it — at that pace the shine would just strobe.
        ui.rollBtn.classList.remove('is-ready');
        void ui.rollBtn.offsetWidth;
        ui.rollBtn.classList.add('is-ready');
      }
      ui.rollBtn.disabled = false;
      const n = state.profile.stats.rollsPerAction;
      ui.rollSub.textContent = n > 1 ? `${n} auras per roll` : 'one aura per roll';
    }
  }
  requestAnimationFrame(tickCooldown);
}

function tickClock() {
  const b = state.world.biome;
  if (b?.endsAt) {
    const left = b.endsAt - Date.now();
    if (left <= 0) refreshWorld();
    else ui.biomeTimer.textContent = `${fmtMs(left)} · ${b.luck > 1 ? `${b.luck}× native` : 'no bonus'}`;
  }
  if (state.profile?.buffs?.length) renderBuffs();
  // The "📌 0:47" countdowns tick by writing into their own nodes — never by
  // repainting the feed, which would replay the slide-in on every row.
  if (state.feedPins.length) updateFeedPins(Date.now());
  // A pin expiring is a change nothing else notices: no poll, no click. This is
  // what lets a held pull sink back down the feed on its own. Cheap when the
  // order has not moved — renderFeed bails out on an unchanged signature.
  if (state.feed.length) renderFeed();
  // When the pick cooldown runs out the rocks become clickable again; repaint
  // the shaft once at that moment so they light up without a click.
  if (state.view === 'mining' && state.mineLockUntil && Date.now() >= state.mineLockUntil) {
    state.mineLockUntil = 0;
    renderCurrentView();
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
    const changed = w.biome.id !== state.world.biome?.id;
    applyBiome(w.biome);
    state.world = { ...state.world, ...w };
    ui.onlineCount.textContent = w.online;
    if (changed && state.profile) {
      toast(`${w.biome.name} is now active — ${w.biome.desc}`, 'gold', 4200);
    }
    // The board is live world data, so a world refresh repaints it while you are
    // looking at it. Without this the "↻ Refresh" button would write a fresh
    // board into state that nothing ever reads again, and the click looks dead.
    if (state.view === 'leaderboard') await loadBoard();
    if (state.profile && (changed || state.view === 'leaderboard')) renderCurrentView();
    if (!state.feed.length && w.feed.length) seedFeed(w.feed);
    markOnline();
  } catch {
    markOffline();
  }
}

// --- leaderboard ------------------------------------------------------------------

// The board is a separate call from /api/world because it is sortable and
// personal: the server returns the column list plus where *you* rank.
async function loadBoard() {
  try {
    state.board = await api.leaderboard(state.lbSort);
    markOnline();
  } catch {
    /* keep the last board on screen — a failed poll is not a reason to blank it */
  }
}

async function refreshBoard() {
  await loadBoard();
  if (state.view === 'leaderboard') renderCurrentView();
}

function setBoardSort(sortId) {
  if (state.lbSort === sortId) return;
  state.lbSort = sortId;
  safeLocal(LB_SORT, sortId);
  refreshBoard();
}

// --- achievements board --------------------------------------------------------
// Same bargain as the leaderboard: the tab paints from a cache, the cache is only
// filled when somebody opens the tab, and a failed poll leaves the last board on
// screen instead of blanking it. The measurements are server-side — this file
// never recomputes a metric, so the two can never disagree about who earned what.

async function loadAchievements() {
  try {
    state.achievements = await api.achievements();
    markOnline();
  } catch {
    /* keep the last board on screen — a failed poll is not a reason to blank it */
  }
}

/** Drop the cache so the fetch is visible, then refill and repaint. */
async function refreshAchievements() {
  state.achievements = null;
  renderCurrentView();
  await loadAchievements();
  if (state.view === 'achievements') renderCurrentView();
}

function setAchGroup(mode) {
  if (state.achGroup === mode) return;
  state.achGroup = mode;
  if (state.view === 'achievements') renderCurrentView();
}

function toggleAchDone() {
  state.achHideDone = !state.achHideDone;
  if (state.view === 'achievements') renderCurrentView();
}

// --- admin panel ---------------------------------------------------------------
// A thin client over /api/admin/*: it decides nothing. If admins.json changes
// under a signed-in admin, the next call answers 403, the tab goes away with
// the next profile, and that is the whole story.

const ADMIN_ERRORS = {
  not_admin: 'You are not on admins.json.',
  unknown_target: 'No player by that name.',
  cannot_delete_self: 'You cannot delete the account you are signed in with.',
  name_taken: 'That username is taken.',
  bad_username: 'That username is not allowed.',
  nothing_to_give: 'Nothing to give — fill a field first.',
  nothing_to_change: 'Nothing to change.',
  nothing_to_grant: 'Nothing to grant.',
  empty_announcement: 'Write something first.',
  gear_full: 'That gear bag is full.',
  unknown_action: 'That admin call does not exist.',
};

function adminToast(err) {
  toast(ADMIN_ERRORS[err.code] || `Admin call failed: ${err.code || err.message}`, 'bad', 2600);
  // A 403 means the list moved under us — let the next profile hide the tab.
  if (err.code === 'not_admin') api.me().then((res) => adopt(res.profile)).catch(() => {});
}

async function adminLoad() {
  const a = state.admin;
  const [st, players] = await Promise.all([api.admin.state(), api.admin.players()]);
  a.server = st.server;
  a.admins = st.admins || [];
  a.adminsFile = st.adminsFile || 'admins.json';
  a.audit = st.audit || [];
  a.biomeOverride = st.biomeOverride || null;
  a.players = players.rows || [];
  a.loadedAt = Date.now();
  if (st.you) applyProfile(st.you);
}

async function adminRefresh() {
  const a = state.admin;
  if (a.busy) return;
  a.busy = true;
  try {
    await adminLoad();
    if (a.detail) a.detail = (await api.admin.player(a.detail.name || a.detail.id)).row;
  } catch (err) {
    adminToast(err);
  } finally {
    a.busy = false;
    if (state.view === 'admin') renderCurrentView();
  }
}

async function adminSelect(target) {
  const a = state.admin;
  if (a.busy) return;
  a.busy = true;
  try {
    const out = await api.admin.player(String(target || '').trim());
    a.detail = out.row;
    // Fresh numbers in the editor; keep the search box as the admin left it.
    a.form = { ...a.form, target: out.row.name };
  } catch (err) {
    adminToast(err);
  } finally {
    a.busy = false;
    renderCurrentView();
  }
}

function adminSummary(action, out) {
  if (action === 'save') return `Database written (${out.db?.writes ?? '?'} writes total).`;
  if (action === 'announce') return 'Announced to the world feed.';
  if (action === 'kick') return `Signed them out of ${out.sessions ?? 0} session(s).`;
  if (action === 'delete') return `${out.name} deleted.`;
  if (action === 'biome') return out.biomeOverride ? `Biome forced to ${out.biome.name}.` : 'Biome rotation restored.';
  if (action === 'reset') return out.mode === 'full' ? 'Account wiped to a fresh start.' : 'Progress reset.';
  if (action === 'gear') return `${out.granted?.icon || '⚒'} ${out.granted?.name || 'Gear'} forged${out.granted?.quality ? ` (${out.granted.quality.name})` : ''}.`;
  if (action === 'buff') {
    return out.granted?.type === 'nextRollLuck'
      ? `✨ +${fmt(out.granted.add)} Luck ×${out.granted.rolls} banked.`
      : `🧪 ${out.granted?.mult}× Luck granted.`;
  }
  if (action === 'give') return `Gave ${out.gave?.length || 0} thing(s).`;
  if (action === 'set') return `Updated ${out.changed?.length || 0} field(s).`;
  return 'Done.';
}

async function adminCall(action, body) {
  const a = state.admin;
  if (a.busy) return;
  const fn = api.admin[action === 'delete' ? 'del' : action];
  if (typeof fn !== 'function') return;
  a.busy = true;
  try {
    const out = await fn(body || {});
    // An admin editing themselves must see their own HUD move.
    if (out?.profile && state.profile && out.profile.id === state.profile.id) applyProfile(out.profile);
    toast(adminSummary(action, out), 'ok', 2200);
    await adminLoad();
    if (a.detail) {
      // Keep the editor honest — the target may just have been renamed or deleted.
      try {
        a.detail = (await api.admin.player(a.detail.name || a.detail.id)).row;
      } catch {
        a.detail = null;
      }
    }
  } catch (err) {
    adminToast(err);
  } finally {
    a.busy = false;
    if (state.view === 'admin') renderCurrentView();
  }
}

// Opening the tab pulls once; the Refresh button is honest about being manual,
// so an admin reading the audit log is not yanked around by a timer.
function adminEnter() {
  if (Date.now() - state.admin.loadedAt < 15000) return;
  adminRefresh();
}

// --- views ------------------------------------------------------------------------

const actions = {
  buy: buyUpgrade,
  ascend: doAscend,
  sell: sellAura,
  craft: doCraft,
  shopBuy: buyShopItem,
  useItem: useInventoryItem,
  equipGear: wearGear,
  unequipGear: takeOffGear,
  salvageGear: scrapGear,
  buyNode,
  mineReveal: mineCell,
  mineReset: digVein,
  clickTap: tapClicker,
  clickBuy: buyClickerUpgrade,
  toggleAutoMine: setAutoMine,
  toggleAutoClick: setAutoClick,
  auraInfo: openAuraInfo,
  refreshWorld,
  refreshBoard,
  lbSort: setBoardSort,
  refreshAchievements,
  achGroup: setAchGroup,
  achToggleDone: toggleAchDone,
  adminCall,
  adminSelect,
  adminRefresh,
};

function renderCurrentView() {
  if (!state.profile) return;
  applyOddsForCurrent();
  renderView(state.view, ui.view, state, actions);
  // An open dossier is a live view too — luck, biome and ownership all move the
  // numbers it prints. Skipped while a control inside it has focus, so a 20s
  // world refresh cannot yank the keyboard out from under the player.
  if (state.auraInfo && !ui.auraModalCard.contains(document.activeElement)) {
    openAuraInfo(state.auraInfo);
  }
}

// Every mutation returns a fresh profile — apply it and repaint, so the HUD can
// never drift from the server's numbers.
function adopt(profile) {
  applyProfile(profile);
  renderCurrentView();
}

async function buyUpgrade(upgradeId) {
  try {
    adopt((await api.buy(upgradeId)).profile);
    toast('Upgrade purchased.', 'ok', 1600);
    syncAuto();
  } catch (err) {
    if (err.code === 'not_enough_essence') toast('Not enough essence yet.', 'bad', 1800);
    else if (err.code === 'maxed') toast('Already maxed out.', 'bad', 1800);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Purchase failed: ${err.message}`, 'bad');
  }
}

async function doAscend() {
  if (!state.profile?.canAscend) return;
  const per = catalog.ascend?.luckPerAscension ?? 0.5;
  const nextMult = 1 + (state.profile.ascensions + 1) * per;
  const pts = ascendPoints(state.profile.essence);
  const first = !state.profile.treeUnlocked;
  if (!confirm(
    `Ascend now?\n\nYou lose all levels and your 💠${fmt(state.profile.essence)} essence (it converts into ✦ points).\nYou keep every aura, ALL your money, your records and the Tree.\nPermanent luck becomes ${nextMult.toFixed(2)}× and you gain ✦${pts} Ascend Points.`
  )) return;
  try {
    const res = await api.ascend();
    adopt(res.profile);
    syncAuto();
    // The takeover plays first; the toast lands when the light clears.
    fx.playAscend().then(() => {
      toast(`✦ Ascended! Permanent luck is now ${res.luckMult.toFixed(2)}× · +${res.pointsGained} ✦ Ascend Points`, 'gold', 6000);
      if (first) toast('The Ascend Tree is open — spend your points in the Tree tab.', 'ok', 6500);
    });
  } catch (err) {
    toast(err.code === 'not_ready' ? 'Not enough rolls to ascend yet.' : `Ascend failed: ${err.message}`, 'bad');
  }
}

async function sellAura(auraId, count = 1) {
  try {
    const res = await api.sell(auraId, count);
    adopt(res.profile);
    toast(`Sold ${res.sold}× for 💰${fmt(res.gained)}`, 'gold', 1800);
  } catch (err) {
    if (err.code === 'nothing_to_sell') toast('None left to sell.', 'bad', 1600);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Sell failed: ${err.message}`, 'bad');
  }
}

async function doCraft(recipeId) {
  try {
    const res = await api.craft(recipeId);
    adopt(res.profile);
    const r = res.received;
    if (r.kind === 'gear') {
      // A crafted piece announces the buffs *it* rolled — that is the whole
      // point of crafting the same glove twice.
      toast(`⚒ ${r.name} · ${r.quality?.name || 'Fine'} — ${(r.buffs || []).map((b) => b.label).join(' · ')}`, 'gold', 6000);
      toast(r.equipped ? `Equipped in the ${r.slot} slot.` : `${r.slot} slot already worn — swap it in the Gear tab.`, 'ok', 3600);
      syncAuto();
    } else {
      toast(`Crafted ${r.count}× ${r.name}`, 'ok', 2400);
    }
  } catch (err) {
    if (err.code === 'missing_inputs') toast('Not enough materials for that.', 'bad', 1800);
    else if (err.code === 'not_enough_money') toast(`Needs 💰${fmt(err.data?.cost || 0)} — not enough money.`, 'bad', 2000);
    else if (err.code === 'gear_full') toast(`Your gear bag is full (${err.data?.cap}). Salvage something first.`, 'bad', 2600);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Craft failed: ${err.message}`, 'bad');
  }
}

// --- aura dossier ------------------------------------------------------------------
// Clicking any aura in the Bestiary (or in your own collection) opens a card
// with everything the catalog knows about it: what the host authored versus what
// your luck actually pays this second, where it lives in the biome rotation, and
// a replay of the reveal it earns. Nothing here talks to the server — it is a
// pure read of the catalog plus the live odds mirror.

const FX_LABEL = {
  soft: 'Soft glow',
  orbit: 'Orbiting motes',
  shard: 'Crystal shards',
  spin: 'Slow spin',
  pulse: 'Heartbeat pulse',
  smoke: 'Smoke trail',
  burst: 'Radial burst',
  gear: 'Clockwork',
  eclipse: 'Eclipse',
  halo: 'Halo',
  wave: 'Drifting wave',
  glitch: 'Glitch / RGB split',
};

function setAuraModalOpen(on) {
  ui.auraModal.classList.toggle('is-on', on);
  ui.auraModal.setAttribute('aria-hidden', String(!on));
  if (!on) state.auraInfo = null;
}

const dossierRow = (k, v, color) =>
  h(
    'div',
    { class: 'ad-row' },
    h('span', { class: 'ad-k' }, k),
    h('span', { class: 'ad-v', style: { color: color || null } }, v)
  );

function openAuraInfo(auraId) {
  if (!state.profile) return;
  const slot = state.profile.inventory?.[auraId] || null;
  // Deleted auras resolve from the slot's snapshot, so a dossier opens for
  // anything you own — even an aura the host has since taken out of the game.
  const aura = resolveAura(auraId, slot);
  if (!aura) return;

  const live = state.oddsById[auraId];
  // Infinity is the mirror's mark for "your luck left this one behind".
  const floored = !!live && !Number.isFinite(live.odds);
  // The odds a pull actually landed at (luck + biome + breakthrough folded in).
  // The Inventory card leaves these off on purpose — the dossier is where they
  // belong, next to the aura's normal pool odds.
  const gotAt = Number(slot?.lastOdds) || Number(slot?.bestOdds) || 0;
  const bestPull = Number(slot?.bestOdds) || 0;
  const biome = aura.native ? getBiome(aura.biome) : null;
  const crafted = !!aura.craftOnly;
  const earnsCutscene =
    (catalog.tierIndexById[aura.tier] ?? 0) >= fx.cutsceneThreshold();

  state.auraInfo = auraId;
  clear(ui.auraModalCard);
  ui.auraModalCard.style.setProperty('--aura', aura.color);

  ui.auraModalCard.append(
    h(
      'div',
      { class: 'ad-head' },
      h('div', { class: `ad-orb${slot ? '' : ' is-locked'}` }),
      h(
        'div',
        {},
        h('div', { class: 'ad-name' }, slot ? aura.name : '? ? ?'),
        h(
          'div',
          { class: 'ad-sub' },
          slot
            ? `${aura.tierName} · owned ×${fmt(slot.count)}${crafted ? ' · special' : ''}`
            : `${aura.tierName} · not yet rolled`
        )
      )
    ),
    h(
      'div',
      { class: 'ad-rows' },
      dossierRow('Normal odds', fmtOdds(aura.odds)),
      crafted
        ? dossierRow(
            'How you get it',
            aura.deleted
              ? 'Removed from the game by the host — still yours'
              : 'Crafted at the forge, never rolled',
            aura.deleted ? 'var(--bad)' : 'var(--gold)'
          )
        : dossierRow(
            'Odds right now',
            floored ? '🔒 below your luck' : fmtOdds(live ? live.odds : aura.odds),
            floored ? 'var(--bad)' : null
          ),
      crafted ? null : dossierRow('Where it drops', biome ? `${biome.name} native` : 'Global pool', biome ? biome.color : null),
      biome ? dossierRow('Breakthrough', `×${catalog.btMultiplier || 12} rarer anywhere else`) : null,
      // Only a real roll has "the odds you got it at" — a forge output was never
      // rolled, and its "How you get it" row already says so.
      slot && !crafted && gotAt
        ? dossierRow('You got it at', fmtOdds(gotAt), gotAt > aura.odds ? 'var(--gold)' : null)
        : null,
      slot && !crafted && bestPull > gotAt ? dossierRow('Best pull', fmtOdds(bestPull)) : null,
      dossierRow('Sell value', `💰 ${fmt(sellPrice(aura.odds))}`),
      dossierRow('Effect', FX_LABEL[aura.fx] || aura.fx),
      dossierRow(
        'Cutscene',
        earnsCutscene ? 'Yes — full-screen takeover' : 'No — below the takeover tier',
        earnsCutscene ? 'var(--gold)' : null
      )
    ),
    h(
      'div',
      { class: 'ad-btns' },
      h(
        'button',
        { class: 'buy-btn', type: 'button', onclick: () => replayAuraFx(aura) },
        `${slot ? '▶' : '✦'} ${slot ? 'Replay' : 'Preview'} ${earnsCutscene ? 'cutscene' : 'reveal'}`
      ),
      h('button', { class: 'ghost-btn', type: 'button', onclick: () => setAuraModalOpen(false) }, 'Close')
    )
  );

  ui.auraModal.classList.add('is-on');
  ui.auraModal.setAttribute('aria-hidden', 'false');
}

/**
 * Re-run an aura's reveal on the centre stage: the stage paint always, the
 * takeover too when the tier earns one (rollfx.cutscene gates it exactly like
 * a real pull). The dossier closes first — the cutscene sits *under* the modals
 * (z-index 60 vs 70), so it would otherwise play behind the card.
 */
async function replayAuraFx(aura) {
  if (state.rolling) {
    toast('Wait for the roll in flight to land.', 'bad', 1800);
    return;
  }
  setAuraModalOpen(false);
  // Let the card finish fading out (.modal transitions for 0.25s). The takeover
  // sits under the modals, so starting it on the same frame begins the reveal
  // behind a half-faded scrim.
  await new Promise((r) => setTimeout(r, 260));
  const live = state.oddsById[aura.id];
  const contextual = live && Number.isFinite(live.odds) ? live.odds : aura.odds;
  // fx.displayOdds() picks authored vs contextual from the player's setting, so
  // hand it both and let it decide.
  await fx.reveal({ ...aura, odds: contextual, baseOdds: aura.odds, isBT: false, isNew: false }, {});
}

// --- gear ---------------------------------------------------------------------------
// Each call returns a fresh profile: wearing a glove moves luck, cooldown, sale
// price and auto-roll speed all at once, so the HUD repaints every time.
async function wearGear(uid) {
  try {
    const res = await api.equipGear(uid);
    adopt(res.profile);
    toast(res.swapped ? `Swapped it out in the ${res.slot} slot.` : `Equipped in the ${res.slot} slot.`, 'ok', 1800);
    syncAuto();
  } catch (err) {
    if (err.code === 'unknown_gear') toast('That piece is gone.', 'bad', 1600);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Equip failed: ${err.message}`, 'bad');
  }
}

async function takeOffGear(uid) {
  try {
    const res = await api.unequipGear(uid);
    adopt(res.profile);
    toast(`Unequipped — the ${res.slot} slot is open.`, 'ok', 1800);
    syncAuto();
  } catch (err) {
    if (err.code === 'not_equipped') toast('That piece is not worn.', 'bad', 1600);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Unequip failed: ${err.message}`, 'bad');
  }
}

async function scrapGear(piece) {
  const worth = fmt(piece.value || 0);
  if (!confirm(`Salvage ${piece.name} (${piece.quality?.name || 'Fine'})?\n\nYou get 💰${worth} and the piece is gone forever.`)) return;
  try {
    const res = await api.salvageGear(piece.uid);
    adopt(res.profile);
    toast(`Salvaged ${res.name} for 💰${fmt(res.gained)}`, 'gold', 2400);
    syncAuto();
  } catch (err) {
    if (err.code === 'unknown_gear') toast('That piece is already gone.', 'bad', 1600);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Salvage failed: ${err.message}`, 'bad');
  }
}

async function buyShopItem(itemId) {
  try {
    const res = await api.shopBuy(itemId);
    adopt(res.profile);
    toast('Purchased — check Inventory → Items.', 'ok', 1800);
  } catch (err) {
    if (err.code === 'not_enough_money') toast(`Needs 💰${fmt(err.data?.cost || 0)}. Sell more auras.`, 'bad', 2000);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Purchase failed: ${err.message}`, 'bad');
  }
}

async function useInventoryItem(itemId) {
  try {
    const res = await api.useItem(itemId);
    adopt(res.profile);
    const a = res.applied || {};
    toast(
      a.type === 'luckBuff'
        ? `${a.mult}× luck engaged.`
        : a.type === 'nextRollLuck'
          ? `✨ +${fmt(a.add || 0)} Luck banked for your next roll${a.rolls > 1 ? ` (${a.rolls} charges)` : ''}.`
          : `+${fmt(a.amount || 0)} essence.`,
      'ok',
      2000
    );
  } catch (err) {
    if (err.code === 'no_item') toast('You do not have that item.', 'bad', 1600);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Use failed: ${err.message}`, 'bad');
  }
}

// --- auth ---------------------------------------------------------------------------

function showAuth(message) {
  ui.authError.textContent = message || '';
  ui.authModal.classList.add('is-on');
  ui.authModal.setAttribute('aria-hidden', 'false');
  // Nobody should come back to a dossier of someone else's collection.
  setAuraModalOpen(false);
  setSettingsOpen(false);
  ui.accountBar.classList.remove('is-on');
  setRollEnabled(false);
  setTimeout(() => (ui.authUser.value ? ui.authPass : ui.authUser).focus(), 60);
}

function hideAuth() {
  ui.authModal.classList.remove('is-on');
  ui.authModal.setAttribute('aria-hidden', 'true');
  ui.accountBar.classList.add('is-on');
  ui.authPass.value = '';
}

function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  for (const btn of document.querySelectorAll('.auth-tab')) {
    btn.classList.toggle('is-active', btn.dataset.mode === state.authMode);
  }
  ui.authSubmit.textContent = state.authMode === 'register' ? 'Create account' : 'Log in';
  ui.authPass.autocomplete = state.authMode === 'register' ? 'new-password' : 'current-password';
  ui.authError.textContent = '';
}

const AUTH_MESSAGES = {
  bad_credentials: 'Wrong username or password.',
  bad_username: 'Names are 3-18 letters, numbers, . _ or -.',
  name_taken: 'That name is already taken.',
  weak_password: 'Password must be at least 6 characters.',
  too_many_attempts: 'Too many attempts — wait a minute and try again.',
};

async function submitAuth(e) {
  e.preventDefault();
  const username = ui.authUser.value.trim();
  const password = ui.authPass.value;
  if (!username) return ui.authUser.focus();
  if (!password) return ui.authPass.focus();

  const btn = ui.authSubmit;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = state.authMode === 'register'
      ? await api.register(username, password)
      : await api.login(username, password);
    setToken(res.token);
    await enterGame();
    toast(state.authMode === 'register' ? `Account created. Welcome, ${res.profile.name}.` : `Welcome back, ${res.profile.name}.`, 'ok', 3600);
  } catch (err) {
    showAuth(AUTH_MESSAGES[err.code] || `Could not sign in: ${err.message}`);
    ui.authPass.select();
  } finally {
    btn.disabled = false;
    setAuthMode(state.authMode);
  }
}

async function startGuest() {
  ui.guestBtn.disabled = true;
  try {
    const res = await api.guest();
    setToken(res.token);
    await enterGame();
    toast(`Playing as ${res.profile.name}. Nothing is saved for guests.`, 'gold', 5200);
  } catch (err) {
    showAuth(`Could not start a guest session: ${err.message}`);
  } finally {
    ui.guestBtn.disabled = false;
  }
}

async function enterGame() {
  const data = await api.me();
  applyProfile(data.profile);
  applyOdds(data.odds);
  applyBiome(data.biome);
  state.world = { ...state.world, ...data };
  // Restore the two idle switches before the first paint so the drill strip and
  // the cabinet agree with what is about to start running. They only need the
  // rate to be non-zero — the server refuses to pay for anything not earned.
  state.autoMine = safeLocal(LS_AUTO_MINE) === '1' && data.profile.stats.autoMinePerSec > 0;
  state.autoClick = safeLocal(LS_AUTO_CLICK) === '1' && data.profile.stats.autoClickPerSec > 0;
  ui.onlineCount.textContent = data.online;
  fx.reset();
  seedFeed(data.feed);
  renderCurrentView();
  // Warm the board now so the first click on the tab has something to show.
  state.lbSort = safeLocal(LB_SORT) || 'best';
  loadBoard().then(() => {
    if (state.view === 'leaderboard') renderCurrentView();
  });
  ui.auto.checked = safeLocal(LS_AUTO) === '1' && data.profile.stats.autoPerSec >= 1;
  syncAuto();
  // Last, once the two switches above have been restored: the profile paint ran
  // before they existed, so this is what actually starts the timers on login.
  syncIdle();
  hideAuth();
  setRollEnabled(true);
}

function resetToAuth(message) {
  setToken(null);
  state.profile = null;
  state.board = null;
  // The badge board is another account's measurements, and `achSeen` is the
  // baseline the next session diffs against — both go, or the next player to
  // sign in inherits a stale board and a wrong "what just unlocked" set.
  state.achievements = null;
  state.achSeen = null;
  state.lastFeedId = null;
  // The feed is public, but the previous session's rows and cursor are not
  // theirs to keep — drop both and let the next poll re-seed from scratch.
  state.feed = [];
  state.feedSeen = new Set();
  state.feedPainted = null;
  renderFeed();
  state.nextRollAt = 0;
  syncAuto();
  // profile is gone, so this drops the drill and the cabinet timers too.
  syncIdle();
  fx.reset();
  clear(ui.view);
  clear(ui.buffs);
  ui.who.textContent = 'not signed in';
  showAuth(message);
}

function forceRelogin() {
  resetToAuth('Your session ended. Sign in again.');
}

async function logOut() {
  try { await api.logout(); } catch { /* token is already useless */ }
  resetToAuth('Signed out. See you soon.');
}

async function deleteAccount() {
  const who = state.profile?.name || 'this account';
  const extra = state.profile?.guest ? '' : '\nThis permanently removes the account from the server database.';
  if (!confirm(`Delete "${who}"?${extra}`)) return;
  try { await api.remove(); } catch { /* already gone */ }
  resetToAuth('Account deleted.');
}

async function renameSelf() {
  const name = prompt('New name:', state.profile.name);
  if (name === null) return;
  try {
    const res = await api.rename(name);
    applyProfile(res.profile);
    toast('Name updated.', 'ok', 1600);
  } catch (err) {
    if (err.code === 'name_taken') toast('That name is taken.', 'bad', 2000);
    else if (err.code === 'name_required') toast('That name is empty or has illegal characters.', 'bad', 2200);
    else if (err.code === 'unauthorized') forceRelogin();
    else toast(`Rename failed: ${err.message}`, 'bad');
  }
}

// --- events ----------------------------------------------------------------------------

// --- resizable side columns ---------------------------------------------------
// Each gutter drags its column's width into a CSS var on .stage and persists
// it. Pointer capture keeps the drag alive even when the cursor runs over the
// panels; double-click snaps back to the default.
function initGutters() {
  const stageEl = $('.stage');
  if (!stageEl) return;
  const bind = (gutter, varName, lsKey, def, min, max, invert) => {
    if (!gutter) return;
    const saved = Number(safeLocal(lsKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) {
      stageEl.style.setProperty(varName, `${saved}px`);
    }
    const current = () => {
      const v = parseFloat(getComputedStyle(stageEl).getPropertyValue(varName));
      return Number.isFinite(v) ? v : def;
    };
    let startX = 0;
    let startW = def;
    let dragging = false;
    gutter.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = current();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add('is-drag');
      document.body.classList.add('is-resizing');
    });
    gutter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const w = Math.round(Math.min(max, Math.max(min, startW + (invert ? -dx : dx))));
      stageEl.style.setProperty(varName, `${w}px`);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      gutter.classList.remove('is-drag');
      document.body.classList.remove('is-resizing');
      safeLocal(lsKey, String(current()));
    };
    gutter.addEventListener('pointerup', stop);
    gutter.addEventListener('pointercancel', stop);
    gutter.addEventListener('dblclick', () => {
      stageEl.style.setProperty(varName, `${def}px`);
      safeLocal(lsKey, String(def));
    });
  };
  bind($('#gutterFeed'), '--feed-w', LS_FEED_W, 340, 240, 560, false);
  bind($('#gutterSide'), '--side-w', LS_SIDE_W, 400, 280, 640, true);
}

function wireEvents() {
  initGutters();
  ui.rollBtn.addEventListener('click', doRoll);

  addEventListener('keydown', (e) => {
    if (ui.authModal.classList.contains('is-on')) return;
    if (e.key === 'Escape') {
      if (ui.auraModal.classList.contains('is-on')) { setAuraModalOpen(false); return; }
      if (state.treeOpen) { closeTree(); return; }
      setSettingsOpen(false);
      return;
    }
    // Space rolls — unless an overlay owns the screen right now.
    if (
      e.code === 'Space' &&
      !state.treeOpen &&
      !ui.settingsModal.classList.contains('is-on') &&
      !ui.auraModal.classList.contains('is-on') &&
      !e.target.matches('input, textarea, button')
    ) {
      e.preventDefault();
      doRoll();
    }
  });

  ui.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    // The Tree is an overlay, not a panel: it takes over the screen and the
    // "Return to World" button (or Esc) puts the panel back.
    if (btn.dataset.view === 'tree') { openTree(); return; }
    closeTree();
    for (const t of ui.tabs.children) t.classList.toggle('is-active', t === btn);
    state.view = btn.dataset.view;
    renderCurrentView();
    // Paint the cached board first, then the live one — the tab must never look
    // empty just because a request is in flight.
    if (state.view === 'leaderboard') {
      loadBoard().then(() => {
        if (state.view === 'leaderboard') renderCurrentView();
      });
    }
    // Same here: the cached board paints from renderCurrentView() above, the
    // fetch lands under it. A badge unlocked while you were on another tab is
    // already in the profile, so the bars you see are one round trip from true.
    if (state.view === 'achievements') {
      loadAchievements().then(() => {
        if (state.view === 'achievements') renderCurrentView();
      });
    }
    if (state.view === 'admin') adminEnter();
  });

  ui.treeReturn.addEventListener('click', closeTree);
  $('#treeZoomIn').addEventListener('click', () => setTreeZoom(state.treeZoom + 0.2));
  $('#treeZoomOut').addEventListener('click', () => setTreeZoom(state.treeZoom - 0.2));
  $('#treeZoomReset').addEventListener('click', () => setTreeZoom(1));

  // Quick Roll: a lifetime toggle once earned, remembered across sessions.
  ui.quickBtn.addEventListener('click', () => {
    if (ui.quickBtn.disabled) return;
    state.quick = !state.quick;
    safeLocal(LS_QUICK, state.quick ? '1' : '0');
    syncQuickBtn(state.profile);
  });

  // Settings: a real modal now — anchored to the button, the old popover got
  // pushed off-screen on short windows. True-odds display is pure presentation
  // (localStorage); the luck switch is a server-side roll rule and comes back
  // as a new profile.
  ui.settingsBtn.addEventListener('click', () => setSettingsOpen(!ui.settingsModal.classList.contains('is-on')));
  ui.settingsClose.addEventListener('click', () => setSettingsOpen(false));
  // Clicking the dim backdrop — never the card itself — dismisses either modal.
  for (const [modal, close] of [
    [ui.settingsModal, () => setSettingsOpen(false)],
    [ui.auraModal, () => setAuraModalOpen(false)],
  ]) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
  }
  ui.setTrueOdds.addEventListener('change', () => {
    state.trueOdds = ui.setTrueOdds.checked;
    safeLocal(LS_TRUE_ODDS, state.trueOdds ? '1' : '0');
    fx.setOddsMode(state.trueOdds);
    renderCurrentView();
  });
  ui.setCutscene.addEventListener('change', () => {
    fx.setCutsceneMin(Number(ui.setCutscene.value));
    // Store what is now in force, not what was typed — a bad value falls back
    // to the game default and the file should say so.
    safeLocal(LS_CUTSCENE, String(fx.cutsceneThreshold()));
  });
  ui.setLuck.addEventListener('change', async () => {
    const on = ui.setLuck.checked;
    try {
      const res = await api.setLuck(on);
      adopt(res.profile);
      toast(on ? 'Luck on — the table bends with you again.' : 'Luck off — every roll uses the authored 1× table.', 'ok', 2600);
    } catch (err) {
      ui.setLuck.checked = !on; // put the switch back where the server disagrees
      if (err.code === 'unauthorized') forceRelogin();
      else toast(`Setting failed: ${err.message}`, 'bad');
    }
  });

  ui.auto.addEventListener('change', () => {
    safeLocal(LS_AUTO, ui.auto.checked ? '1' : '0');
    syncAuto();
  });

  $('#renameBtn').addEventListener('click', renameSelf);
  $('#logoutBtn').addEventListener('click', logOut);
  $('#deleteBtn').addEventListener('click', deleteAccount);

  ui.authForm.addEventListener('submit', submitAuth);
  ui.guestBtn.addEventListener('click', startGuest);
  document.querySelectorAll('.auth-tab').forEach((btn) => {
    btn.addEventListener('click', () => setAuthMode(btn.dataset.mode));
  });

  // Re-sync the world when the tab comes back to the foreground. The cooldown
  // needs no resyncing: nextRollAt is an absolute epoch timestamp, so a
  // throttled background tab still reads correctly — clamping it here used to
  // cancel a cooldown that had not elapsed and buy a guaranteed 429.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.profile) refreshWorld();
  });
}

// --- boot ---------------------------------------------------------------------------------

async function boot() {
  try {
    setCatalog(await api.catalog());
  } catch {
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div style="padding:1rem;background:#7f1d1d;color:#fff;font:14px system-ui">Could not reach the game server. Start it with <b>node server.js</b> and reload.</div>'
    );
    return;
  }

  // Presentation settings survive the session: true-odds display + quick roll.
  state.trueOdds = safeLocal(LS_TRUE_ODDS) === '1';
  state.quick = safeLocal(LS_QUICK) === '1';
  fx.setOddsMode(state.trueOdds);
  ui.setTrueOdds.checked = state.trueOdds;
  fillCutsceneChoices();
  const savedCut = safeLocal(LS_CUTSCENE);
  fx.setCutsceneMin(savedCut === null ? null : Number(savedCut));
  ui.setCutscene.value = String(fx.cutsceneThreshold());

  wireEvents();
  applyBiome((await api.world()).biome);
  requestAnimationFrame(tickCooldown);
  setInterval(tickClock, 500);
  setInterval(pollFeed, 2500);
  setInterval(() => { if (state.profile) refreshWorld(); }, 20000);
  tickClock();

  if (getToken()) {
    try {
      await enterGame();
      return;
    } catch (err) {
      if (err.code === 'offline') {
        showAuth('The server is not reachable right now.');
        return;
      }
      setToken(null);
      showAuth('That saved session is no longer valid — sign in again.');
      return;
    }
  }
  showAuth();
}

boot();
