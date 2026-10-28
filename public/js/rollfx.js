import { $, el, h, clear, fmtOdds } from './dom.js';
import { catalog } from './catalog.js';

const tierIndex = (tierId) => catalog.tierIndexById[tierId] ?? 0;

// ---------------------------------------------------------------------------
// Roll presentation.
//
// Two layers:
//   spin()      — the "roulette" tick through candidate auras while the server
//                 round-trip is in flight, so the roll never feels instant/flat
//   reveal()    — paints the real result onto the stage
//   cutscene()  — the full-screen takeover for EPIC and above, gated exactly
//                 like Sol's RNG (tier index >= CUTSCENE_TIER_INDEX)
// ---------------------------------------------------------------------------

const stage = $('#auraStage');
const orb = $('#auraOrb');
const nameEl = $('#auraName');
const oddsEl = $('#auraOdds');
const tagsEl = $('#auraTags');

const FX_CLASSES = ['spin', 'pulse', 'orbit', 'shard', 'wave', 'smoke', 'burst', 'gear', 'eclipse', 'halo', 'glitch'];

let spinTimer = null;
let cutsceneTimer = null;

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

  clear(tagsEl);
  tagsEl.append(h('span', { class: 'tag', style: { color: aura.tierColor } }, aura.tierName));
  if (isBT) tagsEl.append(h('span', { class: 'tag tag-bt' }, 'Breakthrough'));
  if (isNew) tagsEl.append(h('span', { class: 'tag tag-new' }, 'New'));
  if (biomeName) tagsEl.append(h('span', { class: 'tag tag-biome' }, biomeName));
}

/**
 * Cycle through random aura names while waiting on the server.
 * Returns a stop() function that resolves with nothing; the caller reveals the
 * real result separately.
 */
export function spin(pool, { intervalMs = 55 } = {}) {
  stopSpin();
  let ticks = 0;
  spinTimer = setInterval(() => {
    const pick = pool[(Math.random() * pool.length) | 0];
    stage.style.setProperty('--aura', pick.color);
    nameEl.textContent = pick.name;
    oddsEl.textContent = fmtOdds(pick.odds);
    setFx(pick.fx);
    clear(tagsEl);
    orb.style.transform = `scale(${1 + Math.sin(ticks++ / 2.4) * 0.07})`;
  }, intervalMs);

  // Safety: never let a stalled request leave the roulette spinning forever.
  const hardStop = setTimeout(stopSpin, 4000);
  return () => {
    clearTimeout(hardStop);
    stopSpin();
  };
}

function stopSpin() {
  if (spinTimer) clearInterval(spinTimer);
  spinTimer = null;
  orb.style.transform = '';
}

/**
 * Full-screen cutscene for high tiers. Returns a promise that resolves once
 * the takeover has fully cleared, so the caller can queue sequential reveals.
 */
export function cutscene(result, { durationMs = 2600 } = {}) {
  const idx = tierIndex(result.tier);
  if (idx < catalog.cutsceneTierIndex) return Promise.resolve(false);

  const root = $('#cutscene');
  const aura = { color: result.color, name: result.name };

  root.style.setProperty('--aura', aura.color);
  $('#cutsceneTier').textContent = result.isBT ? `${result.tierName} · BREAKTHROUGH` : result.tierName;
  $('#cutsceneName').textContent = aura.name;
  $('#cutsceneOdds').textContent = fmtOdds(result.odds);

  root.classList.add('is-on');
  root.setAttribute('aria-hidden', 'false');

  clearTimeout(cutsceneTimer);
  return new Promise((resolve) => {
    // Rarer pulls hold the screen longer.
    const hold = durationMs + Math.min(1400, idx * 220);
    cutsceneTimer = setTimeout(() => {
      root.classList.remove('is-on');
      root.setAttribute('aria-hidden', 'true');
      resolve(true);
    }, hold);
  });
}

/** Reveal a roll: cutscene first when it earns one, then settle on the stage. */
export async function reveal(result, paintOpts) {
  paint(result, result.odds, paintOpts);
  await cutscene(result);
}

/** Neutral idle state (also used when switching accounts). */
export function reset() {
  stopSpin();
  stage.style.setProperty('--aura', '#4b5470');
  nameEl.textContent = 'Press Roll';
  oddsEl.textContent = 'every aura has a 1 in N chance';
  setFx(null);
  clear(tagsEl);
}
