import { AURAS, AURA_BY_ID } from '../public/js/data/auras.js';
import { rollOnce, seededRandom, effectiveOdds, essenceFor } from '../src/roll.js';

// ---------------------------------------------------------------------------
// Verifies the roll algorithm actually produces the advertised 1-in-N odds.
//
// The sequential rarest-first walk gives:
//     P(aura i) = (1 / odds_i) * Π over rarer j of (1 - 1 / odds_j)
// with ONE exception: the last (most common) aura is also the loop's fallback,
// so it absorbs all remaining probability mass. The model below reproduces
// that exactly, so any mismatch here is a real bug.
//
// Tolerance is a Poisson z-score rather than a flat percentage: a 1-in-700k
// aura expected 3 times in 2M rolls will legitimately land 1 or 5 times, and
// flagging that as a failure would only be noise.
//
// Run:  node scripts/test-odds.js [rolls] [luck] [biomeId]
// ---------------------------------------------------------------------------

const N = Number(process.argv[2] || 5_000_000);
const luck = Number(process.argv[3] || 1);
const biomeId = process.argv[4] || 'normal';
const Z_LIMIT = 6; // ~1-in-a-trillion two-sided; real bugs blow far past this

const rand = seededRandom(0xc0ffee);
const counts = new Map();

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const r = rollOnce(rand, luck, biomeId);
  counts.set(r.auraId, (counts.get(r.auraId) || 0) + 1);
}
const ms = Date.now() - t0;

// --- theoretical model -----------------------------------------------------
const eff = AURAS.map((a) => ({ aura: a, o: effectiveOdds(a, luck, biomeId).odds }));
const theory = new Map();
let survival = 1;
eff.forEach(({ aura, o }, i) => {
  const p = survival * (1 / o);
  theory.set(aura.id, i === eff.length - 1 ? survival : p); // last absorbs remainder
  survival -= p;
});

console.log(`\n  ${N.toLocaleString('en-US')} rolls @ luck ${luck}, biome "${biomeId}" — ${ms}ms\n`);
console.log('  AURA              TRUE ODDS   EXPECTED    ACTUAL     COUNT      Z  STATUS');
console.log('  ' + '-'.repeat(74));

let checked = 0;
let worstZ = 0;
const failures = [];
const rows = [];

for (const { aura, o } of eff) {
  const count = counts.get(aura.id) || 0;
  const p = theory.get(aura.id);
  const expected = p * N;
  if (expected < 5) continue; // too rare to assert at this sample size
  const z = (count - expected) / Math.sqrt(expected);
  worstZ = Math.max(worstZ, Math.abs(z));
  checked++;
  const ok = Math.abs(z) < Z_LIMIT;
  if (!ok) failures.push(`${aura.name}: z=${z.toFixed(2)}`);
  rows.push({ aura, o, p, count, z, ok });
}

rows.sort((a, b) => b.p - a.p);
for (const r of rows.slice(0, 16)) {
  console.log(
    `  ${r.aura.name.padEnd(15)}  1/${Math.round(r.o).toLocaleString('en-US').padStart(11)}` +
      `  ${(r.p * 100).toFixed(4).padStart(8)}%  ${(r.count / N * 100).toFixed(4).padStart(8)}%` +
      `  ${String(r.count).padStart(8)}  ${r.z.toFixed(2).padStart(6)}   ${r.ok ? 'ok' : '◀ FAIL'}`
  );
}

const seen = new Set(counts.keys());
const neverRolled = AURAS.filter((a) => !seen.has(a.id) && (theory.get(a.id) || 0) * N > 5);
const observedMass = [...counts.values()].reduce((s, c) => s + c, 0) / N;

console.log('  ' + '-'.repeat(74));
console.log(
  `  asserted ${checked} auras · worst |z| ${worstZ.toFixed(2)} · ` +
    `model sums to ${(theoryTotal() * 100).toFixed(2)}%, rolls observed ${(observedMass * 100).toFixed(2)}%`
);
function theoryTotal() {
  let s = 0;
  for (const v of theory.values()) s += v;
  return s;
}

// --- invariants that must always hold --------------------------------------
const problems = [];
if (neverRolled.length) problems.push(`never rolled but expected: ${neverRolled.map((m) => m.name).join(', ')}`);
if (failures.length) problems.push(`statistical failures:\n      ${failures.join('\n      ')}`);
if (Math.abs(theoryTotal() - 1) > 1e-9) problems.push(`model does not sum to 1 (${theoryTotal()})`);

// Luck must scale odds linearly.
const lo = effectiveOdds(AURA_BY_ID.jackpot, 1, 'normal').odds;
const hi = effectiveOdds(AURA_BY_ID.jackpot, 4, 'normal').odds;
if (Math.abs(lo / hi - 4) > 1e-9) problems.push(`luck did not scale odds 4x (${lo} -> ${hi})`);

// A biome-native aura must be far rarer when its biome is NOT active
// (Breakthrough) and more likely while it IS active.
const native = AURAS.find((x) => x.native);
const outside = effectiveOdds(native, 1, 'normal').odds; // its biome is not 'normal'
const inBio = effectiveOdds(native, 1, native.biome).odds;
if (!(outside > native.odds)) problems.push(`breakthrough not rarer than base for ${native.name}`);
if (!(inBio < native.odds)) problems.push(`native not boosted in-biome for ${native.name}`);
if (Math.abs(outside / native.odds - 12) > 1e-9) problems.push(`breakthrough multiplier is not 12x for ${native.name}`);
// A global aura must be completely unaffected by which biome is active.
for (const id of ['common', 'jackpot', 'transcendence']) {
  const a = AURA_BY_ID[id];
  if (effectiveOdds(a, 1, 'normal').odds !== effectiveOdds(a, 1, 'void').odds) {
    problems.push(`global aura ${id} was affected by biome change`);
  }
}

// Essence must increase with rarity.
if (!(essenceFor(1000, 1) > essenceFor(2, 1))) problems.push('essence does not scale with rarity');

// Every aura must resolve to a known rarity tier.
for (const a of AURAS) {
  if (!a.tier || !a.tierName) problems.push(`aura ${a.id} has no rarity tier`);
}

if (problems.length) {
  console.log('\n  ✖ FAILED:');
  for (const p of problems) console.log(`    - ${p}`);
  process.exit(1);
}
console.log('\n  ✔ all checks passed\n');
