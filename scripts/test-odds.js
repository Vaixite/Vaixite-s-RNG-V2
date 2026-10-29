import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';
import {
  rollOnce,
  buildPool,
  normalizePool,
  oddsTable,
  seededRandom,
  essenceFor,
  sellPrice,
  MIN_BALANCER_SHARE,
  LUCK_LEAD,
} from '../src/roll.js';

// ---------------------------------------------------------------------------
// Verifies the V2 roll model: authored odds stay as written in auras.json, the
// engine normalises them once, and the most common aura ("Common") absorbs the
// difference so the pool always sums to exactly 100%.
//
// Two numbers per aura, on purpose:
//   odds  — what the player is told (Common: 1 in 2, forever)
//   share — what the engine actually rolls with (Common: whatever is left over)
//
// Everything here is read from content/*.json — the same files the server and
// the browser use — so retuning the game can never make this test lie.
//
// Tolerance is a Poisson z-score rather than a flat percentage: a 1-in-700k
// aura expected 3 times in 2M rolls will legitimately land 1 or 5 times, and
// flagging that as a failure would only be noise.
//
// Run:  node scripts/test-odds.js [rolls] [luck] [biomeId]
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const content = createContentLoader(path.join(__dirname, '..', 'content')).get();

const N = Number(process.argv[2] || 5_000_000);
const luck = Number(process.argv[3] || 1);
const biomeId = process.argv[4] || 'normal';
const Z_LIMIT = 6; // ~1-in-a-trillion two-sided; real bugs blow far past this

const pool = buildPool(luck, biomeId, content);
const rand = seededRandom(0xc0ffee);

const counts = new Map();
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const r = rollOnce(rand, pool);
  counts.set(r.auraId, (counts.get(r.auraId) || 0) + 1);
}
const ms = Date.now() - t0;

const problems = [];
const fail = (msg) => problems.push(msg);

// --- the roll must match the pool it was built from ------------------------
console.log(`\n  ${N.toLocaleString('en-US')} rolls @ luck ${luck}, biome "${biomeId}" — ${ms}ms\n`);
console.log('  AURA              TRUE ODDS   EXPECTED    ACTUAL     COUNT      Z  STATUS');
console.log('  ' + '-'.repeat(74));

let checked = 0;
let worstZ = 0;
const rows = [];
for (const e of pool.entries) {
  const count = counts.get(e.aura.id) || 0;
  const expected = e.w * N;
  if (expected < 5) continue; // too rare to assert at this sample size
  const z = (count - expected) / Math.sqrt(expected);
  worstZ = Math.max(worstZ, Math.abs(z));
  checked++;
  const ok = Math.abs(z) < Z_LIMIT;
  if (!ok) fail(`${e.aura.name}: z=${z.toFixed(2)} (expected ${expected.toFixed(0)}, got ${count})`);
  rows.push({ e, count, z, ok });
}

rows.sort((a, b) => b.e.w - a.e.w);
for (const r of rows.slice(0, 16)) {
  console.log(
    `  ${r.e.aura.name.padEnd(15)}  1/${Math.round(r.e.odds).toLocaleString('en-US').padStart(11)}` +
      `  ${(r.e.w * 100).toFixed(4).padStart(8)}%  ${((r.count / N) * 100).toFixed(4).padStart(8)}%` +
      `  ${String(r.count).padStart(8)}  ${r.z.toFixed(2).padStart(6)}   ${r.ok ? 'ok' : '◀ FAIL'}`
  );
}

const seen = new Set(counts.keys());
const neverRolled = pool.entries.filter((e) => !seen.has(e.aura.id) && e.w * N > 5);
const observedMass = [...counts.values()].reduce((s, c) => s + c, 0) / N;
const shareSum = pool.entries.reduce((s, e) => s + e.w, 0);

console.log('  ' + '-'.repeat(74));
console.log(
  `  asserted ${checked} auras · worst |z| ${worstZ.toFixed(2)} · ` +
    `pool sums to ${(shareSum * 100).toFixed(2)}%, rolls observed ${(observedMass * 100).toFixed(2)}%`
);

if (neverRolled.length) fail(`never rolled but expected: ${neverRolled.map((m) => m.aura.name).join(', ')}`);
if (Math.abs(shareSum - 1) > 1e-9) fail(`pool weights do not sum to 1 (${shareSum})`);
if (Math.abs(observedMass - 1) > 1e-9) fail(`rolls did not account for every draw (${observedMass})`);

// --- the display contract: Common stays 1 in 2, the engine fixes the rest --
const rep = content.oddsReport;
const balancer = pool.entries.find((e) => e.aura.isBalancer);
// The balancer contract is a property of the authored table. At a luck high
// enough to floor "Common" out of the pool there is nothing to assert here — and
// that is precisely the case where nothing else may absorb either, which the
// luck-floor section below guards on its own.
if (!content.auras.some((a) => a.isBalancer)) {
  fail('no aura is marked isBalancer — the pool has nothing to absorb the difference');
}
if (!balancer) console.log(`  balancer floored out at luck ${luck} — nothing absorbs, the survivors rescale`);
if (balancer) {
  if (balancer.odds !== balancer.aura.declaredOdds) {
    fail(`balancer "${balancer.aura.id}" is displayed as 1/${balancer.odds}, not the authored 1/${balancer.aura.declaredOdds}`);
  }
  const others = pool.entries.filter((e) => e !== balancer).reduce((s, e) => s + e.w, 0);
  if (Math.abs(balancer.w - (1 - others)) > 1e-12) fail('balancer did not absorb the remainder');
  if (balancer.w < MIN_BALANCER_SHARE - 1e-9) fail(`balancer share ${balancer.w} fell below the floor`);
  // The load report is the GLOBAL pool; buildPool bends biome natives first,
  // so a contextual share legitimately differs from it. What has to hold in
  // every context is the ladder: the balancer stays the most common aura.
  const topOther = Math.max(...pool.entries.filter((e) => e !== balancer).map((e) => e.w));
  if (balancer.w + 1e-12 < LUCK_LEAD * topOther) {
    fail(`balancer ${balancer.w} is no longer ahead of the rest (${topOther})`);
  }
  console.log(
    `  balancer "${balancer.aura.name}" — authored 1/${balancer.aura.declaredOdds}, ` +
      `rolls 1/${(1 / balancer.w).toFixed(2)} (${(balancer.w * 100).toFixed(2)}%)`
  );
}
if (pool.entries.filter((e) => e.aura.isBalancer).length > 1) fail('more than one balancer in the pool');
if (pool.joker !== balancer && balancer) fail('buildPool picked a different joker than the marked balancer');

// --- the pool must be sane for every luck × biome combination --------------
// Swept far past anything a player can reach: the interesting failures (a pool
// with no balancer in it, luck so high only a handful of auras survive) all
// happen out there.
const biomeFactor = (e) => (e.isBT ? 1 / content.btMultiplier : e.biomeLuck || 1);
for (const l of [1, 1.5, 4, 25, 1000, 50000, 5e6, 1e8]) {
  for (const b of [...content.biomes.map((x) => x.id), 'nope']) {
    const p = buildPool(l, b, content);
    const sum = p.entries.reduce((s, e) => s + e.w, 0);
    if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-9) fail(`luck ${l} biome ${b}: weights sum to ${sum}`);
    if (p.total !== sum) fail(`luck ${l} biome ${b}: total ${p.total} != sum ${sum}`);
    for (const e of p.entries) {
      if (!(e.w > 0)) fail(`luck ${l} biome ${b}: ${e.aura.id} has share ${e.w}`);
      if (e.aura.isBalancer) continue;
      if (Math.abs(e.w * e.odds - 1) > 1e-9) fail(`${e.aura.id}: odds 1/${e.odds} does not match share ${e.w}`);
    }
    if (p.absorbs) {
      if (p.joker.w < MIN_BALANCER_SHARE - 1e-9) fail(`luck ${l} biome ${b}: joker starved to ${p.joker.w}`);
      const top = Math.max(...p.entries.filter((e) => e !== p.joker).map((e) => e.w));
      if (p.joker.w + 1e-12 < LUCK_LEAD * top) {
        fail(`luck ${l} biome ${b}: "common" is no longer the most common aura (${p.joker.w} vs ${top})`);
      }
    } else {
      // Nothing absorbs, so every aura keeps its luck-bent weight scaled by one
      // shared factor. Ratios between any two entries must therefore be exactly
      // what the authored shares, luck^luckExp and the biome say — no aura may
      // quietly gain ground on its neighbours because the pool needed padding.
      const ref = p.entries[0];
      for (const e of p.entries) {
        const want = (e.aura.share / ref.aura.share)
          * Math.pow(l, (e.aura.luckExp ?? 1) - (ref.aura.luckExp ?? 1))
          * (biomeFactor(e) / biomeFactor(ref));
        if (Math.abs(e.w / ref.w - want) > 1e-9 * Math.max(1, want)) {
          fail(`luck ${l} biome ${b}: ${e.aura.id} is ${e.w / ref.w}× ${ref.aura.id}, expected ${want}`);
        }
      }
    }
  }
}

// --- the luck floor must not hand the pool to one aura ---------------------
// The bug this guards: once luck had floored "Common" out of the pool, the aura
// sitting just above the floor took over the absorbing and swallowed 94% of
// every roll. A player at 50k luck saw the 1/50,000 constantly and the 1/70,000
// beside it almost never — luck making the rare end *harder* to reach.
let floorMaxRatio = 0;
for (const l of [4, 25, 1000, 50000, 1e6, 1e8]) {
  const p = buildPool(l, 'normal', content);
  if (p.absorbs) continue;
  // Only meaningful while there is a pool to spread over: once the floor climbs
  // past the second-rarest authored odds, one aura legitimately IS the pool.
  if (p.entries.length >= 5) {
    const top = Math.max(...p.entries.map((e) => e.w));
    if (top > 0.5) fail(`luck ${l}: one aura alone is ${(top * 100).toFixed(1)}% of every roll`);
  }

  // Among global auras the ladder keeps its authored order: a rarer aura may
  // never roll more often than the one below it.
  const globals = p.entries.filter((e) => !e.aura.native).sort((a, b) => a.aura.odds - b.aura.odds);
  for (let i = 1; i < globals.length; i++) {
    if (globals[i].w > globals[i - 1].w + 1e-15) {
      fail(
        `luck ${l}: ${globals[i].aura.name} (1/${globals[i].aura.odds}) rolls more often than ` +
          `${globals[i - 1].aura.name} (1/${globals[i - 1].aura.odds})`
      );
    }
  }
  // And the aura at the floor may not dwarf its neighbour — "1/50k but never
  // 1/70k" is exactly what this looks like from the player's side.
  if (globals.length > 1) {
    const ratio = globals[0].w / globals[1].w;
    floorMaxRatio = Math.max(floorMaxRatio, ratio);
    if (ratio > 8) fail(`luck ${l}: the floor aura is ${ratio.toFixed(1)}× the next aura up`);
  }
}
console.log(
  `  luck floor — nothing absorbs above luck 2; the floor aura peaks at ` +
    `${floorMaxRatio.toFixed(2)}× the aura above it (was 94% of every roll before)`
);

// Luck bends by rarity, exactly: a non-native aura's contextual odds are
// authoredOdds / luck^luckExp, as long as the pool has room to absorb it.
// Checked on a hand-sized pool so the balancer never has to squeeze.
const tiny = {
  auras: [
    { id: 'c', odds: 2, share: 0.625, isBalancer: true, luckExp: 0 },
    { id: 'u', odds: 4, share: 0.25, isBalancer: false, luckExp: 0.5 },
    { id: 'r', odds: 8, share: 0.125, isBalancer: false, luckExp: 1 },
  ],
  biomes: [{ id: 'normal', luck: 1 }],
  biomeById: { normal: { id: 'normal', luck: 1 } },
  btMultiplier: 12,
};
for (const [id, authored, exp] of [['u', 4, 0.5], ['r', 8, 1]]) {
  for (const l of [1, 1.2, 1.5]) {
    const e = buildPool(l, 'normal', tiny).entries.find((x) => x.aura.id === id);
    const want = authored / Math.pow(l, exp);
    if (Math.abs(e.odds - want) > 1e-9) fail(`luck ${l}: ${id} shows 1/${e.odds}, expected 1/${want}`);
  }
}
const tinyAt15 = buildPool(1.5, 'normal', tiny);
const tinyOthers = tinyAt15.entries.filter((e) => !e.aura.isBalancer).reduce((s, e) => s + e.w, 0);
if (Math.abs(tinyAt15.joker.w - (1 - tinyOthers)) > 1e-12) fail('tiny pool: joker stopped absorbing');

// And on the real table luck must keep paying off forever. A flat multiplier
// saturates once the rest of the pool fills 99.5% of it — around luck 1.46 on
// this content — after which every luck source is inert. Rarity-weighted luck
// cannot saturate: each point keeps moving mass up the ladder.
const rarest = content.auras.filter((a) => !a.native && !a.isBalancer).sort((a, b) => b.odds - a.odds)[0];
const oddsWith = (l) => buildPool(l, 'normal', content).entries.find((e) => e.aura.id === rarest.id).odds;
let prevOdds = oddsWith(1);
for (const l of [1.2, 1.5, 2, 4, 10, 50, 250, 5000, 100000, 1e6]) {
  const o = oddsWith(l);
  if (!(o < prevOdds * 0.999)) {
    fail(`luck ${l} stopped helping ${rarest.name}: 1/${prevOdds.toFixed(0)} -> 1/${o.toFixed(0)}`);
  }
  prevOdds = o;
}
console.log(
  `  luck — ${rarest.name} at 1/${oddsWith(1).toFixed(0)} · 1/${oddsWith(4).toFixed(0)} at 4x · ` +
    `1/${oddsWith(100).toFixed(0)} at 100x`
);

// A biome-native aura must be far rarer when its biome is NOT active
// (Breakthrough) and more likely while it IS active.
const native = content.auras.find((x) => x.native);
const entryIn = (biome) => buildPool(1, biome, content).entries.find((e) => e.aura.id === native.id);
const base = 1 / native.share;
const outside = entryIn('normal');
const inBio = entryIn(native.biome);
if (!(outside.isBT && outside.w < native.share)) fail(`breakthrough not rarer than base for ${native.name}`);
if (!(inBio.w > native.share)) fail(`native not boosted in-biome for ${native.name}`);
if (Math.abs(native.share / outside.w - content.btMultiplier) > 1e-9) {
  fail(`breakthrough multiplier is not ${content.btMultiplier}x for ${native.name}`);
}
if (Math.abs(inBio.w / native.share - content.biomeById[native.biome].luck) > 1e-9) {
  fail(`biome luck is not ${content.biomeById[native.biome].luck}x for ${native.name}`);
}
if (inBio.isBT) fail(`${native.name} flagged BREAKTHROUGH while at home`);

// A global aura must be completely unaffected by which biome is active.
for (const id of ['common', 'jackpot', 'transcendence']) {
  const a = content.auraById[id];
  if (!a) continue;
  const at = (b) => buildPool(1, b, content).entries.find((e) => e.aura.id === id).odds;
  if (at('normal') !== at('void')) fail(`global aura ${id} was affected by biome change`);
}

// The bestiary table must agree with the pool and never leak the correction.
for (const row of oddsTable(luck, biomeId, content)) {
  const e = pool.entries.find((x) => x.aura.id === row.id);
  if (!e || Math.abs(e.odds - row.odds) > 1e-9) fail(`oddsTable disagrees with buildPool for ${row.id}`);
  if (e.aura.isBalancer && row.odds !== e.aura.declaredOdds) fail(`oddsTable leaked the corrected odds for ${row.id}`);
}

// Essence must increase with rarity, and so must the sell price.
if (!(essenceFor(1000, 1) > essenceFor(2, 1))) fail('essence does not scale with rarity');
if (!(sellPrice(content.sell, 100000) > sellPrice(content.sell, 2))) fail('sell price does not scale with rarity');

// Every aura must resolve to a known rarity tier.
for (const a of content.auras) {
  if (!a.tier || !a.tierName) fail(`aura ${a.id} has no rarity tier`);
}

// The pool must be walkable top-down, or the cumulative walk is wrong.
for (let i = 1; i < content.auras.length; i++) {
  if (content.auras[i - 1].odds < content.auras[i].odds) fail(`auras are not sorted rarest-first at index ${i}`);
}

// --- normalisation must survive almost any odds you write in auras.json ----
const cases = [
  { name: 'under-summed (87.5%)', odds: [2, 4, 8] },
  { name: 'exactly 100%', odds: [2, 4, 4] },
  { name: 'over-summed (150%)', odds: [2, 2, 2] },
  { name: 'hopelessly over-summed', odds: [2, 2, 2, 2] },
  { name: 'one aura only', odds: [2] },
  { name: 'two identical', odds: [3, 3] },
  { name: 'dust-rare tail', odds: [2, 1_000_000, 100_000_000] },
  { name: 'all one-in-a-million', odds: [1_000_000, 1_000_000, 1_000_000] },
  { name: 'real content ladder', odds: content.auras.map((a) => a.odds) },
];
console.log('\n  normalisation stress');
for (const c of cases) {
  const rowsIn = c.odds.map((o, i) => ({ id: `a${i}`, name: `a${i}`, odds: o }));
  const { auras, report } = normalizePool(rowsIn);
  const sum = auras.reduce((s, a) => s + a.share, 0);
  const notes = [];
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-9) notes.push(`sums to ${sum}`);
  if (auras.filter((a) => a.isBalancer).length !== 1) notes.push('not exactly one balancer');
  const bal = auras.find((a) => a.isBalancer);
  // The joker is the most common aura, i.e. the LOWEST 1-in-N.
  if (bal && bal.odds !== Math.min(...c.odds)) notes.push('balancer is not the most common aura');
  if (bal && bal.share < MIN_BALANCER_SHARE - 1e-9) notes.push(`balancer starved to ${bal.share}`);
  for (const a of auras) {
    if (!(a.share > 0)) notes.push(`${a.id} share ${a.share}`);
    if (a.declaredOdds !== c.odds[Number(a.id.slice(1))]) notes.push(`${a.id} lost its authored odds`);
    if (!a.isBalancer && Math.abs(a.share * a.odds - 1) > 1e-9) notes.push(`${a.id} odds/share mismatch`);
  }
  // Input rows must never be mutated — content is shared with the server.
  if (rowsIn.some((r, i) => r.odds !== c.odds[i])) notes.push('mutated the caller rows');
  const bad = notes.length ? `✖ ${notes.join('; ')}` : 'ok';
  console.log(
    `  ${c.name.padEnd(24)} raw ${(report.rawSum * 100).toFixed(2).padStart(7)}% → 100%` +
      ` · "${report.balancerName}" 1/${report.authoredOdds} rolls 1/${report.effectiveOdds.toFixed(2)}` +
      `${report.squeezed ? ' · squeezed' : ''}  ${bad}`
  );
  if (notes.length) fail(`${c.name}: ${notes.join('; ')}`);
}

if (problems.length) {
  console.log('\n  ✖ FAILED:');
  for (const p of problems) console.log(`    - ${p}`);
  process.exit(1);
}
console.log('\n  ✔ all checks passed\n');
