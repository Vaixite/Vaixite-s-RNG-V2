#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ODDS NORMALISER — read-only.
//
// Shows exactly what the engine will do with the odds in content/auras.json:
// the pool is summed, the most common aura absorbs the difference to 100%, and
// every aura's real drop chance is printed next to the number you typed.
//
// It never writes anything. Not to data/db.json, not to content/*.json. It does
// not even import the content loader, so a half-finished or invalid auras.json
// still gets a full report instead of a stack trace.
//
//   node scripts/normalize-odds.js              report the live content folder
//   node scripts/normalize-odds.js --file x.json report a candidate file first
//   node scripts/normalize-odds.js --all        list every aura, not just the top
//   node scripts/normalize-odds.js --json       machine-readable output
//   node scripts/normalize-odds.js --check      exit 1 if the pool is unusable
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePool, buildPool, MIN_BALANCER_SHARE } from '../src/roll.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const CONTENT_DIR = path.join(ROOT, 'content');
const problems = [];
const notes = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${path.basename(file)}: ${err.message}`);
    return null;
  }
}

// --- load the raw tables, tolerating anything -------------------------------
const candidate = value('file');
const aurasFile = candidate ? path.resolve(ROOT, candidate) : path.join(CONTENT_DIR, 'auras.json');

const rawAuras = readJson(aurasFile);
const rawRarity = readJson(path.join(CONTENT_DIR, 'rarity.json'));
const rawBiomes = readJson(path.join(CONTENT_DIR, 'biomes.json'));

if (!rawAuras) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const rows = [
  ...(Array.isArray(rawAuras.global) ? rawAuras.global : []).map((r) => ({ ...r, native: false })),
  ...(Array.isArray(rawAuras.native) ? rawAuras.native : []).map((r) => ({ ...r, native: true })),
];
if (!rows.length) problems.push('auras.json: no auras in "global" or "native"');

// Sanity-check the raw numbers the way the loader will, but without throwing.
const seen = new Set();
for (const r of rows) {
  const label = r.id || r.name || '(unnamed)';
  if (seen.has(r.id)) problems.push(`duplicate aura id "${r.id}"`);
  seen.add(r.id);
  if (typeof r.odds !== 'number' || !Number.isFinite(r.odds)) {
    problems.push(`aura ${label}: odds must be a finite number, got ${JSON.stringify(r.odds)}`);
  } else if (!(r.odds > 0)) {
    problems.push(`aura ${label}: odds must be greater than 0 (got ${r.odds})`);
  } else if (r.odds < 1) {
    notes.push(`aura ${label}: odds ${r.odds} is below 1 — that is a >100% chance on its own`);
  }
}

const biomes = rawBiomes?.biomes || [];
const btMultiplier = rawBiomes?.breakthroughMultiplier || 12;
const usable = rows.filter((r) => typeof r.odds === 'number' && Number.isFinite(r.odds) && r.odds > 0);

// --- normalise ---------------------------------------------------------------
const { auras, report } = usable.length ? normalizePool(usable) : { auras: [], report: null };

if (report?.squeezed) {
  problems.push(
    `the rarer auras alone sum to ${(report.squeezed * 100).toFixed(2)}% — there is nothing left to absorb. ` +
      `They will be squeezed proportionally so "${report.balancerName}" keeps a ${(MIN_BALANCER_SHARE * 100).toFixed(1)}% floor.`
  );
}

// Per-biome view: natives and biome multipliers change what the absorber is left with.
const perBiome = [];
if (report) {
  const fake = {
    auras,
    biomes,
    biomeById: Object.fromEntries(biomes.map((b) => [b.id, b])),
    btMultiplier,
  };
  for (const b of biomes.length ? biomes : [{ id: 'none', name: 'no biomes.json', luck: 1 }]) {
    const pool = buildPool(1, b.id, fake);
    perBiome.push({
      id: b.id,
      luck: b.luck,
      share: pool.joker.w,
      odds: 1 / pool.joker.w,
      natives: auras.filter((a) => a.native && a.biome === b.id).length,
      squeezed: pool.squeezed,
    });
    if (pool.squeezed) problems.push(`biome ${b.id}: weights exceed 100% at base luck and get squeezed`);
  }
}

// --- output ------------------------------------------------------------------
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const odds = (x) => (x >= 1000 ? `1/${Math.round(x).toLocaleString('en-US')}` : `1/${x.toFixed(x < 100 ? 2 : 0)}`);

if (flag('json')) {
  console.log(
    JSON.stringify(
      {
        file: path.relative(ROOT, aurasFile).replace(/\\/g, '/'),
        count: auras.length,
        report,
        perBiome,
        problems,
        notes,
        auras: auras
          .map((a) => ({
            id: a.id,
            name: a.name,
            native: a.native,
            authoredOdds: a.declaredOdds,
            effectiveOdds: 1 / a.share,
            share: a.share,
            balancer: a.isBalancer,
          }))
          .sort((x, y) => y.share - x.share),
      },
      null,
      2
    )
  );
  process.exit(problems.length && flag('check') ? 1 : 0);
}

console.log('\nVaixite RNG — odds normaliser  (read-only: nothing here writes to disk)\n');
console.log(`  file        : ${path.relative(ROOT, aurasFile).replace(/\\/g, '/')}`);
console.log(
  `  auras       : ${rows.length} (${rows.filter((r) => !r.native).length} global, ${rows.filter((r) => r.native).length} native)`
);

if (report) {
  const drift = report.rawSum - 1;
  console.log(`  authored    : ${(report.rawSum * 100).toFixed(4)}% of pool  (${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(2)}pt vs 100%)`);
  console.log(`  absorber    : ${report.balancerId} — the most common aura, picked automatically`);
  console.log(
    `                shows ${odds(report.authoredOdds)} in game · rolls ${odds(report.effectiveOdds)} (${pct(report.share)})`
  );
  console.log(`  everyone else: typed odds are the real odds, exactly`);

  console.log('\n  what players will actually pull (top of the curve):');
  console.log(`    ${'aura'.padEnd(16)}${'typed'.padStart(12)}${'typed share'.padStart(12)}${'real share'.padStart(12)}`);
  const sorted = [...auras].sort((a, b) => b.share - a.share);
  const shown = flag('all') ? sorted : sorted.slice(0, 12);
  for (const a of shown) {
    console.log(
      `    ${a.id.padEnd(16)}${odds(a.declaredOdds).padStart(12)}${pct(1 / a.declaredOdds).padStart(12)}${pct(a.share).padStart(12)}${a.isBalancer ? '  ← absorbs' : ''}`
    );
  }
  if (!flag('all') && sorted.length > shown.length) {
    console.log(`    … ${sorted.length - shown.length} more (pass --all to see every aura)`);
  }

  if (perBiome.length) {
    console.log('\n  absorber share per biome (natives + biome luck shift it):');
    for (const b of perBiome) {
      console.log(
        `    ${b.id.padEnd(12)} luck ${String(b.luck).padEnd(5)} ${String(b.natives).padStart(2)} native · ` +
          `${b.id === 'normal' ? '' : 'common rolls '}${odds(b.odds)} (${pct(b.share)})`
      );
    }
  }
}

for (const n of notes) console.log(`\n  note: ${n}`);
if (problems.length) {
  console.log('\n  problems the server would reject:');
  for (const p of problems) console.log(`    - ${p}`);
} else if (report) {
  console.log('\n  ✔ this table loads and lands on exactly 100%');
}
console.log('');

process.exit(problems.length && flag('check') ? 1 : 0);
