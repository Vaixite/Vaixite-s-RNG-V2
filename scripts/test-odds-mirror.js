// Parity test: the browser's odds mirror vs the server's pool maths.
//
// The client recomputes the whole ladder between server polls (potions, buffs,
// biome hops move luck), and that mirror is what the roll roulette scrolls
// through, what the bestiary prints and what the dossier replays. When the two
// copies drift, the animation starts quoting odds the roll engine disagrees
// with — which is exactly what happened when the luck-floor rule changed.
//
// Run: node scripts/test-odds-mirror.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';
import { buildPool } from '../src/roll.js';
import { mirrorOdds } from '../public/js/oddsmirror.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = createContentLoader(path.join(root, 'content')).get();

let failed = 0;
const fail = (msg) => { failed++; console.log(`  ✖ ${msg}`); };
// Relative: shares run from 1e-4 to 3e-1 and odds from 1 to 1e8 in one table.
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

const LUCKS = [1, 1.2, 2, 4, 25, 1000, 50000, 1e6, 1e8];
const BIOMES = [...content.biomes.map((b) => b.id), 'nope'];

console.log('\n  server buildPool vs client mirrorOdds\n');
console.log('  LUCK        BIOME         ENTRIES  MAX SHARE  SUM        RESULT');
console.log('  ' + '-'.repeat(72));

for (const luck of LUCKS) {
  for (const biomeId of BIOMES) {
    const tag = `luck ${luck} biome ${biomeId}`;
    const before = failed;
    const pool = buildPool(luck, biomeId, content);
    const biome = content.biomeById[biomeId] || content.biomes[0];
    const mirror = mirrorOdds({
      auras: content.auras,
      luck,
      biome,
      btMultiplier: content.btMultiplier,
    });

    const inPool = new Set();
    for (const e of pool.entries) {
      inPool.add(e.aura.id);
      const m = mirror[e.aura.id];
      if (!m) { fail(`${tag}: ${e.aura.id} missing from the mirror`); continue; }
      if (!close(m.share, e.w)) fail(`${tag}: ${e.aura.id} share ${m.share} != server ${e.w}`);
      if (!close(m.odds, e.odds)) fail(`${tag}: ${e.aura.id} odds ${m.odds} != server ${e.odds}`);
      if (m.isBT !== e.isBT) fail(`${tag}: ${e.aura.id} isBT ${m.isBT} != server ${e.isBT}`);
    }
    // Floored auras must read as unreachable, or the roulette scrolls past
    // auras the player literally cannot roll and the bestiary shows a number.
    for (const aura of content.auras) {
      if (inPool.has(aura.id)) continue;
      const m = mirror[aura.id];
      if (!m) { fail(`${tag}: floored ${aura.id} missing from the mirror`); continue; }
      if (m.share !== 0 || m.odds !== Infinity) {
        fail(`${tag}: floored ${aura.id} is share ${m.share} / odds ${m.odds}, expected 0 / Infinity`);
      }
    }
    if (Object.keys(mirror).length !== content.auras.length) {
      fail(`${tag}: mirror covered ${Object.keys(mirror).length} of ${content.auras.length} auras`);
    }

    const sum = pool.entries.reduce((s, e) => s + e.w, 0);
    const top = Math.max(...pool.entries.map((e) => e.w));
    const ok = failed === before;
    console.log(
      `  ${String(luck).padEnd(11)} ${biomeId.padEnd(13)} ${String(pool.entries.length).padStart(7)}` +
        `  ${(top * 100).toFixed(2).padStart(9)}%  ${sum.toFixed(6).padStart(9)}  ${ok ? 'match' : 'see above'}`
    );
  }
}

// --- what the roulette actually reads ---------------------------------------
// fx.spin() draws its rows with weightOf = mirror share, so a wrong share makes
// the strip scroll past the wrong auras for the whole spin.
const luck = 50000;
const pool = buildPool(luck, 'normal', content);
const mirror = mirrorOdds({
  auras: content.auras,
  luck,
  biome: content.biomeById.normal,
  btMultiplier: content.btMultiplier,
});
const rows = content.auras
  .map((a) => ({ a, w: mirror[a.id].share, odds: mirror[a.id].odds }))
  .filter((r) => r.w > 0)
  .sort((x, y) => y.w - x.w);

console.log(`\n  roulette strip at ${luck.toLocaleString('en-US')} luck — ${rows.length} of ${content.auras.length} auras scroll past\n`);
for (const r of rows.slice(0, 6)) {
  console.log(`    ${r.a.name.padEnd(15)} authored 1/${r.a.odds.toLocaleString('en-US').padStart(11)}  row 1/${Math.round(r.odds)}`);
}
const hog = rows[0].w;
if (hog > 0.5) fail(`the strip would be ${(hog * 100).toFixed(0)}% "${rows[0].a.name}"`);
if (rows.length !== pool.entries.length) fail('the strip offers a different set of auras than the roll engine');

// The two auras from the original complaint, side by side.
const glitch = mirror.glitched;
const seraphic = mirror.seraphic;
if (!glitch || !seraphic) {
  fail('glitched/seraphic missing from the mirror — content changed?');
} else if (!(glitch.odds < seraphic.odds * 10)) {
  fail(`GLITCH 1/${Math.round(glitch.odds)} vs Seraphic 1/${Math.round(seraphic.odds)} — still an order of magnitude apart`);
} else {
  console.log(
    `\n  GLITCH 1/70,000 rolls 1/${Math.round(glitch.odds)} · Seraphic 1/50,000 rolls 1/${Math.round(seraphic.odds)}` +
      ` — neighbours, as they should be`
  );
}

console.log(failed ? `\n  ✖ FAILED: ${failed} problem(s)\n` : '\n  ✔ mirror matches the server\n');
process.exit(failed ? 1 : 0);
