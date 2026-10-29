import { $, h, clear, fmtOdds } from './dom.js';
import { catalog } from './catalog.js';

const tierIndex = (tierId) => catalog.tierIndexById[tierId] ?? 0;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Roll presentation.
//
// Three layers:
//   spin() / land() — the slot-machine roulette. A vertical strip of aura rows
//                     scrolls fast while the server round-trip is in flight,
//                     then decelerates (easeOut) and stops centred on the row
//                     that *is* the real result. Nothing is revealed until it
//                     has landed, so a 40ms response still feels like a pull.
//   reveal()        — paints the real result onto the stage.
//   cutscene()      — the full-screen takeover for EPIC and above, with its own
//                     visual per tier, gated exactly like Sol's RNG.
//
// Odds wording follows the player's setting: by default the game shows the
// odds the host authored (luck never visibly changes a 1-in-N); "show true luck
// odds" switches every reveal over to the live contextual number.
// ---------------------------------------------------------------------------

const stage = $('#auraStage');
const orb = $('#auraOrb');
const nameEl = $('#auraName');
const oddsEl = $('#auraOdds');
const tagsEl = $('#auraTags');
const rollerEl = $('#roller');
const roulette = $('#roulette');
const rrWindow = $('#rrWindow');
const strip = $('#rrStrip');
const orbRow = $('#orbRow');

const FX_CLASSES = ['spin', 'pulse', 'orbit', 'shard', 'wave', 'smoke', 'burst', 'gear', 'eclipse', 'halo', 'glitch'];

// Roulette geometry. The row height is written inline as well as in CSS so the
// landing maths can never drift from what the browser actually lays out.
const RR_ROW = 56;
const RR_WINDOW = 224;
const RR_ROWS = 260;

let spinTimer = null;
let cutsceneTimer = null;
let rr = null; // the live roulette, or null
let trueOdds = false;
let cutsceneMin = null; // the player's cutscene threshold; null = the game default

/** Which 1-in-N the client shows on reveals and on the roulette rows. */
export function setOddsMode(on) {
  trueOdds = !!on;
}

/**
 * The lowest tier index that earns the full-screen takeover. `null` puts it
 * back on the game default (content/rarity.json → cutsceneTierIndex); a number
 * raises or lowers it for this player only — it is pure presentation, the
 * server never hears about it.
 */
export function setCutsceneMin(idx) {
  cutsceneMin = Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : null;
}

/** The threshold a reveal is actually gated by right now. */
export const cutsceneThreshold = () => cutsceneMin ?? (catalog.cutsceneTierIndex ?? 3);

/** The odds a roll result should be displayed with. */
export const displayOdds = (r) => (trueOdds ? r.odds : (r.baseOdds ?? r.odds));

function setFx(fx) {
  for (const f of FX_CLASSES) stage.classList.remove(`fx-${f}`);
  if (fx) stage.classList.add(`fx-${fx}`);
}

/** Paint an aura onto the centre stage. */
export function paint(aura, odds, { isBT = false, isNew = false, biomeName = null } = {}) {
  stage.style.setProperty('--aura', aura.color);
  nameEl.textContent = aura.name;
  oddsEl.textContent = `1/${Math.round(odds).toLocaleString('en-US')}`;
  setFx(aura.fx);

  // One-shot reveal: the orb blooms and the name settles in. Restarted by hand
  // because the same aura twice in a row must still feel like an event.
  stage.classList.remove('is-reveal');
  void stage.offsetWidth;
  stage.classList.add('is-reveal');

  clear(tagsEl);
  tagsEl.append(h('span', { class: 'tag', style: { color: aura.tierColor } }, aura.tierName));
  if (isBT) tagsEl.append(h('span', { class: 'tag tag-bt' }, 'Breakthrough'));
  if (isNew) tagsEl.append(h('span', { class: 'tag tag-new' }, 'New'));
  if (biomeName) tagsEl.append(h('span', { class: 'tag tag-biome' }, biomeName));
}

/**
 * Multi-roll spheres: one glowing orb per aura the roll produced, in rarity
 * order, each coloured with its own aura. Single rolls hide the row again.
 */
export function showOrbs(results) {
  if (!orbRow) return;
  clear(orbRow);
  if (!results || results.length < 2) return;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    orbRow.append(
      h('span', {
        class: 'orb',
        style: { '--aura': r.color || '#8b95ad', '--i': String(i) },
        title: `${r.name} · ${fmtOdds(displayOdds(r))}${r.isNew ? ' · NEW' : ''}`,
      })
    );
  }
}

// --- the roulette -------------------------------------------------------------

function rrPaint(offset) {
  strip.style.transform = `translate3d(0, ${(RR_WINDOW - RR_ROW) / 2 - offset}px, 0)`;
}

function rrRowNode(aura, odds) {
  return h(
    'div',
    { class: 'rr-row', style: { height: `${RR_ROW}px`, '--rr': aura.color || '#8b95ad' } },
    h('div', { class: 'rr-name' }, aura.name),
    h('div', { class: 'rr-odds' }, fmtOdds(odds))
  );
}

// The landing row is a placeholder until the response arrives — then it is
// rewritten in place, which is what lets the strip stop on a row that already
// existed instead of teleporting the whole thing.
function rrFill(node, aura, odds) {
  node.style.setProperty('--rr', aura.color || '#8b95ad');
  node.firstChild.textContent = aura.name;
  node.lastChild.textContent = fmtOdds(odds);
}

function stopSpin() {
  const st = rr;
  rr = null;
  if (st) {
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.timer) clearTimeout(st.timer);
    if (st.guard) clearTimeout(st.guard);
    if (st.resolve) st.resolve(false); // never leave a caller awaiting a dead spin
  }
  if (spinTimer) clearInterval(spinTimer);
  spinTimer = null;
  if (roulette) {
    roulette.classList.remove('is-on');
    roulette.setAttribute('aria-hidden', 'true');
    if (strip) clear(strip);
  }
  if (rollerEl) rollerEl.classList.remove('is-spinning');
  if (orb) orb.style.transform = '';
}

/**
 * Start the idle roulette.
 *
 * Returns a stop() function (so old callers keep working) carrying a `land()`
 * that decelerates onto the real result and resolves once it has settled —
 * that is the moment the caller is allowed to reveal.
 *
 * @param {Array} pool   auras to scroll through
 * @param {object} opts  { oddsOf(aura) → number, weightOf(aura) → number, minMs, intervalMs }
 *
 * `weightOf` makes the strip honest: rows are drawn with the live luck-bent
 * weights, and auras the luck floor removed (weight 0) never scroll past.
 */
export function spin(pool, { oddsOf = null, weightOf = null, minMs = 1100 } = {}) {
  stopSpin();
  const list = (pool && pool.length ? pool : catalog.auras).filter((a) => a && a.name);
  const noop = () => {};
  noop.land = () => Promise.resolve(false);
  if (!list.length || !roulette || !strip || !rrWindow) return noop;

  const oddsOfAura = oddsOf || ((a) => a.odds);
  const quiet = reducedMotion();

  // Cumulative weight table for the row picks (linear pool, ~40 entries — a
  // binary walk per row is noise next to the animation frames).
  let bag = null;
  if (weightOf) {
    const weights = [];
    let total = 0;
    for (const a of list) {
      const w = Math.max(0, Number(weightOf(a)) || 0);
      weights.push(w);
      total += w;
    }
    if (total > 0) {
      const cum = [];
      let acc = 0;
      for (const w of weights) { acc += w; cum.push(acc); }
      bag = { cum, total };
    }
  }
  const pick = () => {
    if (!bag) return list[(Math.random() * list.length) | 0];
    const t = Math.random() * bag.total;
    let lo = 0;
    let hi = bag.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t < bag.cum[mid]) hi = mid;
      else lo = mid + 1;
    }
    return list[lo];
  };

  rrWindow.style.height = `${RR_WINDOW}px`;
  clear(strip);
  if (orbRow) clear(orbRow); // last pull's spheres are gone with its spin
  const rows = [];
  for (let i = 0; i < RR_ROWS; i++) {
    const aura = pick();
    rows.push(rrRowNode(aura, oddsOfAura(aura)));
  }
  strip.append(...rows);

  roulette.classList.add('is-on');
  roulette.setAttribute('aria-hidden', 'false');
  rollerEl.classList.add('is-spinning');

  const st = {
    offset: 0,
    speed: quiet ? 0 : 1750,
    raf: 0,
    timer: null,
    guard: null,
    last: performance.now(),
    startedAt: performance.now(),
    landing: null,
    resolve: null,
    rows,
  };
  rr = st;
  rrPaint(0);

  if (!quiet) {
    const idle = (t) => {
      if (rr !== st) return;
      const dt = Math.min(64, t - st.last);
      st.last = t;
      st.offset = Math.min(st.offset + (st.speed * dt) / 1000, (RR_ROWS - 4) * RR_ROW);
      rrPaint(st.offset);
      st.raf = requestAnimationFrame(idle);
    };
    st.raf = requestAnimationFrame(idle);
  }

  // Safety: a stalled request must never leave the roulette running forever.
  st.guard = setTimeout(stopSpin, 12000);

  const stop = () => stopSpin();
  stop.land = (result) => land(result, minMs);
  return stop;
}

/**
 * Decelerate the running strip and stop it on `result`.
 * Resolves true once the row has landed (false if there was nothing to land).
 */
function land(result, minMs = 1100) {
  const st = rr;
  if (!st) return Promise.resolve(false);
  if (st.landing) return st.landing;

  st.landing = new Promise((resolve) => {
    st.resolve = resolve;
    const finish = (ok) => {
      if (rr !== st) return;
      rr = null;
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st.guard) clearTimeout(st.guard);
      roulette.classList.remove('is-on');
      roulette.setAttribute('aria-hidden', 'true');
      clear(strip);
      rollerEl.classList.remove('is-spinning');
      resolve(ok);
    };

    const quiet = reducedMotion();
    const elapsed = performance.now() - st.startedAt;
    // A fast response still gets a full pull: never under `minMs` in total,
    // and never a deceleration so short it reads as a flash.
    const dur = quiet ? 1 : Math.max(minMs - elapsed, 850) + Math.random() * 380;
    const from = st.offset;
    const travel = Math.max(RR_ROW * 5, st.speed * (dur / 1000) * 0.4);
    const idx = Math.min(Math.round((from + travel) / RR_ROW), RR_ROWS - 3);
    const target = idx * RR_ROW;
    const row = st.rows[idx];
    if (row && result) rrFill(row, result, displayOdds(result));

    if (st.raf) cancelAnimationFrame(st.raf);
    const t0 = performance.now();
    const step = (t) => {
      if (rr !== st) return;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic — fast, then a long glide
      st.offset = from + (target - from) * e;
      rrPaint(st.offset);
      if (p < 1) {
        st.raf = requestAnimationFrame(step);
        return;
      }
      if (row) row.classList.add('is-landed');
      st.timer = setTimeout(() => finish(true), quiet ? 0 : 240);
    };
    st.raf = requestAnimationFrame(step);
  });
  return st.landing;
}

/**
 * Full-screen cutscene for high tiers. Returns a promise that resolves once
 * the takeover has fully cleared, so the caller can queue sequential reveals.
 *
 * Every tier gets its own look through a `cs-<tierId>` class on the root —
 * the visuals themselves live in game.css as extra layers on .cutscene.
 *
 * The hold ramps hard with rarity (a DIVINE should feel like an event), and
 * a click or Escape dismisses it early — long is allowed to be long only
 * because it is never a cage.
 */
export function cutscene(result, { durationMs = 2600 } = {}) {
  const idx = tierIndex(result.tier);
  if (idx < cutsceneThreshold()) return Promise.resolve(false);

  const root = $('#cutscene');
  const aura = { color: result.color, name: result.name };
  const tierClass = `cs-${String(result.tier || 'epic').replace(/[^a-z0-9_-]/gi, '')}`;

  root.style.setProperty('--aura', aura.color);
  $('#cutsceneTier').textContent = result.isBT ? `${result.tierName} · BREAKTHROUGH` : result.tierName;
  $('#cutsceneName').textContent = aura.name;
  $('#cutsceneOdds').textContent = fmtOdds(displayOdds(result));

  root.classList.add('is-on', tierClass);
  root.setAttribute('aria-hidden', 'false');

  clearTimeout(cutsceneTimer);
  return new Promise((resolve) => {
    // Rarer pulls hold the screen much longer: epic ~3.6s up to ~8.6s for the
    // top tiers. Reduced motion keeps it brief — the info, without the show.
    const hold = reducedMotion()
      ? 900
      : durationMs + Math.min(6000, Math.pow(Math.max(0, idx - 2), 1.35) * 1000);

    const done = () => {
      clearTimeout(cutsceneTimer);
      root.removeEventListener('pointerdown', done);
      document.removeEventListener('keydown', onKey);
      root.classList.remove('is-on', tierClass);
      root.setAttribute('aria-hidden', 'true');
      resolve(true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done();
    };

    cutsceneTimer = setTimeout(done, hold);
    root.addEventListener('pointerdown', done);
    document.addEventListener('keydown', onKey);
  });
}

/** Reveal a roll: cutscene first when it earns one, then settle on the stage. */
export async function reveal(result, paintOpts) {
  paint(result, displayOdds(result), paintOpts);
  await cutscene(result);
}

/**
 * The ascension takeover: white flash → expanding rings → the word ASCENSION
 * opening up its letter-spacing while ✦ drift up. ~2.4s, promise-based so the
 * caller can toast right after it clears.
 */
export function playAscend({ durationMs = 2400 } = {}) {
  const root = $('#ascendFx');
  if (!root) return Promise.resolve();
  const dur = reducedMotion() ? 260 : durationMs;

  root.classList.remove('is-on');
  void root.offsetWidth; // restart every keyframe from the top
  root.classList.add('is-on');
  root.setAttribute('aria-hidden', 'false');

  return new Promise((resolve) => {
    setTimeout(() => {
      root.classList.remove('is-on');
      root.setAttribute('aria-hidden', 'true');
      resolve();
    }, dur);
  });
}

/** Neutral idle state (also used when switching accounts). */
export function reset() {
  stopSpin();
  clearTimeout(cutsceneTimer);
  stage.classList.remove('is-reveal');
  stage.style.setProperty('--aura', '#4b5470');
  nameEl.textContent = 'Press Roll';
  oddsEl.textContent = 'every aura has a 1 in N chance';
  setFx(null);
  clear(tagsEl);
  if (orbRow) clear(orbRow);
}
