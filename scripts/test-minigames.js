import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';
import {
  basePlayer,
  deriveStats,
  treeStats,
  clickerStats,
  clickerOf,
  clickerCost,
  clickTap,
  clickAutoTick,
  buyClickerUpgrade,
  mineAutoTick,
  mineReveal,
  publicProfile,
} from '../src/game.js';

// ---------------------------------------------------------------------------
// MINIGAME RULE TESTS — the Automated Drill (ascend tree) and the Spark Clicker
// (content/clicker.json), driven straight through src/game.js with a throwaway
// db and an explicit clock, so banked time is tested instead of slept on.
//
// Run: node scripts/test-minigames.js
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const content = createContentLoader(path.join(__dirname, '..', 'content')).get();

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}

function makeCtx() {
  return {
    db: {
      data: { players: {}, sessions: {}, feed: [], meta: { totalRolls: 0, nextPlayerId: 1 } },
      dirty: 0,
      markDirty() { this.dirty++; },
      save() { return Promise.resolve(); },
    },
    mem: { guests: {}, sessions: new Map() },
    rateLimit: () => true,
    content,
  };
}

const T0 = 1_700_000_000_000;
const mk = (tree = {}) => {
  const p = basePlayer('Tester');
  p.tree = { ...tree };
  return p;
};
const up = (id) => content.clickerUpgrades.find((u) => u.id === id);

console.log(
  `\n  Minigame tests · ${content.treeNodes.length} tree nodes · ` +
    `${content.clickerUpgrades.length} clicker upgrades\n`
);

// --- the shop is data -----------------------------------------------------------------
{
  check('clicker.json declares its unlock node', !!content.clicker.unlockNode, content.clicker.unlockNode);
  check('every clicker upgrade has a cost curve', content.clickerUpgrades.every((u) => u.baseCost > 0 && u.growth >= 1));
  check('cost grows with the authored curve', clickerCost(up('grip'), 3) === Math.floor(15 * Math.pow(1.15, 3)));
  const types = new Set(content.clickerUpgrades.map((u) => u.effect.type));
  check('the shop covers luck and roll speed', types.has('luck') && types.has('cooldown'), [...types].join(','));
}

// --- locking ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const p = mk();
  const now = T0;
  check('clicking is locked without the arcade node', clickTap(ctx, p, now).error === 'locked');
  check('the drill is locked without the tree node', mineAutoTick(ctx, p, now).error === 'locked');
  check('a profile says nothing is unlocked', publicProfile(p, ctx, now).clickerUnlocked === false);
}

// --- the clicker: one tap ------------------------------------------------------------------
{
  const ctx = makeCtx();
  const p = mk({ arcade: 1 });
  let out = clickTap(ctx, p, T0);
  check('a click pays sparks', out.ok === true && out.gained >= 1, JSON.stringify(out));
  check('the first click is one click', out.clicks === 1);
  check('sparks are banked on the profile', publicProfile(p, ctx, T0).clicker.sparks === out.gained);

  const tooSoon = clickTap(ctx, p, T0 + 10);
  check('the server enforces a floor between clicks', tooSoon.error === 'cooldown' && tooSoon.retryInMs > 0);
  check('a rejected click pays nothing', p.clicker.sparks === out.gained);

  const late = clickTap(ctx, p, T0 + content.clicker.clickCooldownMs);
  check('a click after the cooldown lands', late.ok === true);
}

// --- the clicker: buying ----------------------------------------------------------------------
{
  const ctx = makeCtx();
  const p = mk({ arcade: 1 });
  const grip = up('grip');
  check('an unaffordable upgrade is refused', buyClickerUpgrade(ctx, p, 'grip').error === 'not_enough_sparks');

  p.clicker.sparks = clickerCost(grip, 0);
  const bought = buyClickerUpgrade(ctx, p, 'grip');
  check('buying an upgrade takes exactly its cost', bought.ok && p.clicker.sparks === 0, JSON.stringify(bought));
  check('the upgrade level is remembered', p.clicker.levels.grip === 1);
  check('the next level costs more', clickerCost(grip, 1) > clickerCost(grip, 0));

  check('an unknown upgrade id is refused', buyClickerUpgrade(ctx, p, 'everything').error === 'unknown_upgrade');

  const capped = up('double_click');
  p.clicker.levels[capped.id] = capped.max;
  p.clicker.sparks = 1e12;
  check('a maxed upgrade cannot be bought', buyClickerUpgrade(ctx, p, capped.id).error === 'maxed');
}

// --- the clicker: what the shop actually does ---------------------------------------------------
{
  const ctx = makeCtx();
  const p = mk({ arcade: 1 });
  clickerOf(p).levels = { grip: 4, double_click: 1 };
  const cs = clickerStats(p, content);
  check('firm grip adds sparks per click', cs.perClick === 5, String(cs.perClick));
  check('double click makes one click count twice', cs.clicksPerClick === 2);

  const out = clickTap(ctx, p, T0);
  check('a tap resolves every click it is worth', out.clicks === 2);
  check('and pays for all of them', out.gained >= 10, String(out.gained));

  // Crits are the clicker's own luck: floor from the file, upgrades on top.
  const base = clickerStats(mk(), content).critChance;
  const lucky = clickerStats(Object.assign(mk(), { clicker: { levels: { lucky_finger: 10 } } }), content);
  check('crit chance starts from the authored floor', base === content.clicker.crit.baseChance, String(base));
  check('crit chance climbs with the shop', Math.abs(lucky.critChance - (base + 0.1)) < 1e-9);
  const capped = clickerStats(Object.assign(mk(), { clicker: { levels: { lucky_finger: 999 } } }), content);
  check('crit chance never passes its ceiling', capped.critChance === content.clicker.crit.maxChance);
}

// --- the clicker: paying back into the real game ------------------------------------------
{
  const ctx = makeCtx();
  const plain = mk({ arcade: 1 });
  const before = deriveStats(plain, content, T0);

  const boosted = mk({ arcade: 1 });
  boosted.clicker = { levels: { golden_touch: 4, quick_hands: 3, essence_filter: 2, merchant_hands: 2, vein_resonance: 2 } };
  const after = deriveStats(boosted, content, T0);

  check('clicker luck multiplies main-game luck', Math.abs(after.luck / before.luck - 1.2) < 1e-9, `${before.luck} → ${after.luck}`);
  check('clicker roll speed cuts the cooldown', after.cooldownMs < before.cooldownMs, `${before.cooldownMs} → ${after.cooldownMs}`);
  check('the cooldown floor still holds', after.cooldownMs >= content.upgradeById.quickroll.effect.floorMs);
  check('clicker essence multiplies essence', Math.abs(after.essenceMult / before.essenceMult - 1.3) < 1e-9);
  check('clicker sale price multiplies sales', Math.abs(after.sellMult / before.sellMult - 1.24) < 1e-9);
  check('the profile reports where it came from', after.clicker.luck > 1 && after.clicker.cooldown < 1);

  // The tree and the clicker are independent sources of the same bonuses.
  const both = mk({ arcade: 1, ascended_luck: 1 });
  both.clicker = { levels: { golden_touch: 1 } };
  const s = deriveStats(both, content, T0);
  const treeOnly = deriveStats(mk({ ascended_luck: 1 }), content, T0);
  check('tree and clicker luck stack multiplicatively', Math.abs(s.luck / treeOnly.luck - 1.05) < 1e-9);
}

// --- the clicker: auto clicks ---------------------------------------------------------------
{
  const ctx = makeCtx();
  const p = mk({ arcade: 1 });
  check('no drill, no auto tick', clickAutoTick(ctx, p, T0).error === 'no_auto');

  clickerOf(p).levels = { auto_clicker: 2, grip: 1 };
  const first = clickAutoTick(ctx, p, T0);
  check('the first tick only starts the clock', first.ok && first.clicks === 0);

  const tick = clickAutoTick(ctx, p, T0 + 5000);
  check('five seconds at 2/s is ten clicks', tick.clicks === 10, String(tick.clicks));
  check('and they paid out', tick.gained >= 20, String(tick.gained));
  // Spamming the route must not mint sparks: the work is bought with time.
  const before = p.clicker.sparks;
  const spam = clickAutoTick(ctx, p, T0 + 5000);
  check('a second tick in the same instant earns nothing', spam.ok && spam.clicks === 0 && p.clicker.sparks === before);

  // Banked time is capped, so a tab asleep for an hour pays the cap and no more.
  const cap = content.clicker.auto.maxBankedMs;
  const slept = clickAutoTick(ctx, p, T0 + 5000 + 1000 * 60 * 60);
  check('a long sleep pays the banked cap, not the whole hour', slept.clicks <= Math.floor((cap / 1000) * 2), String(slept.clicks));
  check('and never more than one response may hold', slept.clicks <= content.clicker.auto.maxClicksPerTick);

  const profile = publicProfile(p, ctx, T0 + 1e9);
  check('the profile advertises the auto rate', profile.stats.autoClickPerSec === 2);
  check('and the clicker totals', profile.clicker.totalClicks > 10 && profile.clicker.autoClickPerSec === 2);
}

// --- the automated drill ----------------------------------------------------------------------
{
  const ctx = makeCtx();
  const p = mk({ mining: 1, rich_veins: 1 });
  check('a shaft without a drill says so', mineAutoTick(ctx, p, T0).error === 'no_auto');

  p.tree.auto_drill = 2; // 1 cell/second at 0.5 per level
  check('the tree reports the drill rate', treeStats(p, content).autoMine === 1);

  const first = mineAutoTick(ctx, p, T0);
  check('the first tick only starts the clock', first.ok && first.dug === 0);
  check('and it rolled a vein to dig', Array.isArray(p.mining.vein));

  const cells = content.mining.grid.cells;
  const tick = mineAutoTick(ctx, p, T0 + 5000);
  check('five seconds at 1/s digs five cells', tick.dug === 5, String(tick.dug));
  check('every dig paid money', tick.money >= 5 && tick.finds.length >= 1);
  check('the finds are grouped by ore', tick.finds.reduce((s, f) => s + f.count, 0) === 5);
  check('finds are listed rarest first', tick.finds.every((f, i) => i === 0 || tick.finds[i - 1].odds >= f.odds));
  check('the digs are marked revealed', p.mining.revealed.filter(Boolean).length === 5);

  const before = p.money;
  const spam = mineAutoTick(ctx, p, T0 + 5000);
  check('spamming the drill earns nothing', spam.dug === 0 && p.money === before);

  // Rich Veins multiplies what the drill pulls up. Same vein, same clock, so
  // the only variable left is the multiplier — no luck involved.
  const plain = mk({ mining: 1, auto_drill: 1 });
  mineAutoTick(ctx, plain, T0);
  const rich = mk({ mining: 1, rich_veins: 5, auto_drill: 1 });
  rich.mining = structuredClone(plain.mining);
  const a = mineAutoTick(ctx, rich, T0 + 10000);
  const b = mineAutoTick(ctx, plain, T0 + 10000);
  check('rich veins pay the drill more', a.money > b.money, `${a.money} vs ${b.money}`);

  // A finished vein is replaced automatically — that is the idle part.
  const nearly = mk({ mining: 1, auto_drill: 5 });
  mineAutoTick(ctx, nearly, T0);
  const done = mineAutoTick(ctx, nearly, T0 + 10000);
  check('the drill empties the vein', done.dug === cells, String(done.dug));
  check('and starts a fresh one', done.newVein === true);
  check('the new vein is fully diggable', nearly.mining.revealed.every((r) => !r));

  const prof = publicProfile(nearly, ctx, T0 + 10000);
  check('the profile reports the drill rate', prof.stats.autoMinePerSec === 2.5, String(prof.stats.autoMinePerSec));
}

// --- manual picks still work next to the drill ----------------------------------------------
{
  const ctx = makeCtx();
  const p = mk({ mining: 1, auto_drill: 1 });
  const pick = mineReveal(ctx, p, 0, T0);
  check('a manual pick still works', pick.ok === true);
  mineAutoTick(ctx, p, T0); // starts the drill clock; the vein already exists
  const dug = mineAutoTick(ctx, p, T0 + 2000);
  check('the drill starts from the next open cell', dug.ok && dug.dug === 1, JSON.stringify(dug));
  check('and never re-digs a picked cell', p.mining.revealed[0] === true && p.mining.revealed.filter(Boolean).length === 2);
}

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  console.error('  failed: ' + fails.join(' | '));
  process.exit(1);
}
