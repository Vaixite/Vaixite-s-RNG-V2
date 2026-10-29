// Ladder inspector: what every aura actually rolls at a given luck, in a given
// biome — authored odds, luck exponent, share, true odds, and whether it is a
// biome native taking the breakthrough penalty.
//
// The question it answers: "I have N luck, so why am I not seeing aura X?"
//
// Run: node scripts/diag-luck.js [luck] [biomeId]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';
import { buildPool } from '../src/roll.js';

const ctx = createContentLoader(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'content')).get();
const luck = Number(process.argv[2] || 50000);
const biomeId = process.argv[3] || 'normal';

console.log(`\n  btMultiplier=${ctx.btMultiplier}  biome="${biomeId}"  luck=${luck}\n`);

const pool = buildPool(luck, biomeId, ctx);
const rows = pool.entries.map((e) => ({
  name: e.aura.name,
  authored: e.aura.odds,
  native: e.aura.native ? `${e.aura.biome}` : '-',
  bt: e.isBT ? 'BT' : '  ',
  luckExp: e.aura.luckExp,
  share: e.w,
  odds: e.odds,
  joker: e.joker ? 'JOKER' : '',
}));
rows.sort((a, b) => b.authored - a.authored);
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log(`  ${pad('AURA', 16)}${padl('AUTHORED', 12)}${padl('LUCKEXP', 9)} ${padl('SHARE', 10)} ${padl('TRUE ODDS', 14)}  NOTE`);
for (const r of rows) {
  if (r.share < 1e-7 && r.authored < 1e9) continue;
  console.log(`  ${pad(r.name, 16)}${padl(`1/${Math.round(r.authored).toLocaleString('en-US')}`, 12)}${padl(r.luckExp.toFixed(3), 9)} ${padl(`${(r.share * 100).toFixed(4)}%`, 10)} ${padl(`1/${Math.round(r.odds).toLocaleString('en-US')}`, 14)}  ${r.native === '-' ? '' : `native ${r.native}`}${r.bt}`);
}
console.log(`  joker=${pool.joker.aura.name}  entries=${pool.entries.length}  sum=${pool.entries.reduce((s, e) => s + e.w, 0).toFixed(6)}`);

// Where does the luck floor cut, and how many auras survive it?
const eligible = ctx.auras.filter((a) => a.odds >= luck);
console.log(`\n  luck floor ${luck}: ${eligible.length}/${ctx.auras.length} auras eligible`);
console.log(`  eligible authored odds: ${eligible.map((a) => Math.round(a.odds)).join(', ')}`);

// The gap the player feels: authored odds vs what the roll actually pays.
console.log('\n  authored -> true odds for the rarest 12 at several luck levels');
const rare = [...ctx.auras].sort((a, b) => b.odds - a.odds).slice(0, 12);
for (const l of [1, 1000, 10000, 50000, 200000]) {
  const p = buildPool(l, biomeId, ctx);
  const line = rare.slice(0, 6).map((a) => {
    const e = p.entries.find((x) => x.aura.id === a.id);
    return `${a.name.slice(0, 6)} 1/${e ? Math.round(e.odds).toLocaleString('en-US') : 'gone'}`;
  }).join(' | ');
  console.log(`  luck ${String(l).padStart(7)}: ${line}`);
}
