// Gear smoke test.
//
// Loads the real content/*.json (so the loader's cross-validation runs), crafts
// every gear recipe, and checks that rolled instances, equipping, stat math,
// selling and salvage all behave. Also covers the multi-sort leaderboard.
//
// It never touches data/db.json: the game runs against an in-memory fake ctx,
// and the one migration check uses a throwaway file under data/.
//
//   node scripts/test-gear.js
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';
import { createDb } from '../src/db.js';
import {
  newGuest,
  craftRecipe,
  equipGear,
  unequipGear,
  salvageGear,
  deriveStats,
  sellAura,
  publicProfile,
  leaderboard,
  leaderboardBoard,
} from '../src/game.js';
import { rollGear, gearValue, aggregateGear, gearView, pickQuality } from '../src/gear.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const content = createContentLoader(path.join(ROOT, 'content')).get();

// --- fake ctx ----------------------------------------------------------------
// Same shape as server.js's ctx, minus the disk.
function makeCtx() {
  return {
    content,
    mem: { guests: {}, sessions: new Map() },
    db: { data: { players: {}, feed: [] }, markDirty() {} },
  };
}

let failed = 0;
let checks = 0;
function check(ok, label, extra) {
  checks++;
  if (ok) return true;
  failed++;
  console.error(`  FAIL  ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  return false;
}
function section(name) {
  console.log(`\n${name}`);
}

// --- 1. content ---------------------------------------------------------------
section('content');
check(content.gear.length >= 6, 'loader exposes gear pieces', content.gear.length);
check(content.gearSlots.length >= 3, 'loader exposes slots');
check(content.gearQualities.length >= 3, 'loader exposes qualities');

const slotIds = new Set(content.gearSlots.map((s) => s.id));
for (const piece of content.gear) {
  check(slotIds.has(piece.slot), `${piece.id}: slot exists`, piece.slot);
  check(piece.buffs.some((b) => b.signature), `${piece.id}: has a signature buff`);
  check(piece.buffs.length >= 2, `${piece.id}: multi-buff`, piece.buffs.length);
  for (const b of piece.buffs) {
    check(!!content.gearBuffTypes[b.type], `${piece.id}.${b.type}: known buff type`);
  }
}

const gearRecipes = content.recipes.filter((r) => r.output && r.output.gear);
check(gearRecipes.length >= 6, 'gear recipes present', gearRecipes.length);
for (const r of gearRecipes) {
  check(!!content.gearById[r.output.gear], `${r.id}: output resolves to a piece`);
  for (const qid of Object.keys(r.output.qualities || {})) {
    check(!!content.gearQualityById[qid], `${r.id}: quality ${qid} exists`);
  }
}

// --- 2. rolling instances ------------------------------------------------------
section('rolled instances');
{
  const samples = 500;
  for (const piece of content.gear) {
    for (const q of content.gearQualities) {
      const counts = {};
      let sigSeen = 0;
      let ok = true;
      for (let i = 0; i < samples; i++) {
        const inst = rollGear(piece, q);
        const kind = (t) => content.gearBuffTypes[t]?.kind || 'pct';
        // A quality may want more buffs than the piece has to offer; the roller
        // clamps to the piece, so the expected floor is clamped the same way.
        const minBuffs = Math.min(q.buffs.min, piece.buffs.length);
        const maxBuffs = Math.min(q.buffs.max, piece.buffs.length);
        if (inst.buffs.length < minBuffs || inst.buffs.length > maxBuffs) ok = false;
        if (!inst.buffs.some((b) => b.signature)) sigSeen++;
        for (const b of inst.buffs) {
          const def = piece.buffs.find((d) => d.type === b.type);
          const power = q.power || 1;
          const lo = def.min * power;
          const hi = def.max * power;
          const eps = kind(b.type) === 'flat' ? 1.001 : 0.0011;
          if (b.value < lo - eps || b.value > hi + eps) ok = false;
          if (!Number.isFinite(b.value)) ok = false;
          counts[b.type] = (counts[b.type] || 0) + 1;
        }
        if (!inst.uid || !inst.craftedAt) ok = false;
      }
      check(ok, `${piece.id} @ ${q.id}: buffs in band and count in range`);
      check(sigSeen === 0, `${piece.id} @ ${q.id}: signature always present`, sigSeen);
      // The signature buff must show up every time; other buffs should vary.
      const sigType = piece.buffs.find((b) => b.signature).type;
      check(counts[sigType] === samples, `${piece.id} @ ${q.id}: signature always rolled`);
      const others = Object.keys(counts).filter((t) => t !== sigType);
      if (piece.buffs.length > 1 && q.buffs.max > 1) {
        check(others.length > 1 || samples < 50, `${piece.id} @ ${q.id}: buffs vary between crafts`, Object.keys(counts));
      }
    }
  }
}

// Quality should actually mean something: same piece, better quality ⇒ higher average.
{
  const piece = content.gear[0];
  const avg = (q) => {
    let sum = 0;
    for (let i = 0; i < 400; i++) {
      const inst = rollGear(piece, q);
      sum += inst.buffs.reduce((s, b) => s + (content.gearBuffTypes[b.type].kind === 'flat' ? b.value / 2 : b.value), 0);
    }
    return sum / 400;
  };
  const [worn, fine, radiant, mythic] = content.gearQualities;
  check(avg(fine) > avg(worn), 'fine rolls better than worn');
  check(avg(radiant) > avg(fine), 'radiant rolls better than fine');
  check(avg(mythic) > avg(radiant), 'mythic rolls better than radiant');
  check(
    gearValue(piece, rollGear(piece, mythic), mythic, content.gearSalvage) >
      gearValue(piece, rollGear(piece, worn), worn, content.gearSalvage),
    'mythic is worth more than worn',
  );
}

// pickQuality respects weights: a 0-weight quality never comes up.
{
  let hits = 0;
  for (let i = 0; i < 500; i++) if (pickQuality({ a: 0, b: 1 }) === 'a') hits++;
  check(hits === 0, 'pickQuality skips zero weight', hits);
  check(pickQuality({}) === null, 'pickQuality({}) is null');
  const spread = new Set();
  for (let i = 0; i < 400; i++) spread.add(pickQuality({ a: 1, b: 1, c: 1 }));
  check(spread.size === 3, 'pickQuality spreads over weights', [...spread]);
}

// --- 3. crafting ---------------------------------------------------------------
section('crafting');
const ctx = makeCtx();
const { player } = newGuest(ctx);

// Free everything: every aura, plenty of items and money.
function fund(p) {
  for (const a of content.auras) p.inventory[a.id] = { count: 9999, lastAt: 0, bestOdds: a.odds };
  for (const it of content.items) p.items[it.id] = 999;
  p.money = 100_000_000;
}
fund(player);

const crafted = {};
for (const r of gearRecipes) {
  const before = player.gear.length;
  const res = craftRecipe(ctx, player, r.id);
  if (!check(res.ok, `${r.id}: craft succeeded`, res.error)) continue;
  const got = res.received;
  check(got.kind === 'gear', `${r.id}: received gear`, got.kind);
  check(got.pieceId === r.output.gear, `${r.id}: correct piece`, got.pieceId);
  check(!!content.gearQualityById[got.quality.id], `${r.id}: quality is real`, got.quality);
  check(got.buffs.length >= 2 && got.buffs[0].signature, `${r.id}: signature buff first`, got.buffs);
  check(!!got.value && got.value > 0, `${r.id}: has a salvage value`, got.value);
  check(player.gear.length === before + 1, `${r.id}: exactly one instance added`);
  check(!!content.gearById[got.pieceId], `${r.id}: piece still resolves`);
  crafted[r.output.gear] = got;
}

// First craft of a piece fills its empty slot; the next one must not steal it.
{
  const pieceId = Object.keys(crafted)[0];
  const slot = content.gearById[pieceId].slot;
  const first = player.gear.find((g) => g.pieceId === pieceId);
  check(player.equipped[slot] === first.uid, 'first craft auto-equips', { slot, eq: player.equipped[slot] });

  const r = gearRecipes.find((x) => x.output.gear === pieceId);
  const second = craftRecipe(ctx, player, r.id);
  check(second.ok && second.received.equipped === false, 'second craft does not overwrite gear', second.received?.equipped);

  const swap = equipGear(ctx, player, second.received.uid);
  check(swap.ok && swap.swapped === first.uid, 'equipping returns the piece it replaced', swap);
  check(player.equipped[slot] === second.received.uid, 'slot now points at the new piece');

  const uneq = unequipGear(ctx, player, second.received.uid);
  check(uneq.ok && !player.equipped[slot], 'unequip clears the slot', uneq);
  check(unequipGear(ctx, player, second.received.uid).error === 'not_equipped', 'unequipping twice says not_equipped');
  check(equipGear(ctx, player, 'nope').error === 'unknown_gear', 'equip unknown uid');
  check(unequipGear(ctx, player, 'nope').error === 'unknown_gear', 'unequip unknown uid');
  check(salvageGear(ctx, player, 'nope').error === 'unknown_gear', 'salvage unknown uid');
}

// Costs are all-or-nothing.
{
  const poor = newGuest(ctx).player;
  check(craftRecipe(ctx, poor, gearRecipes[0].id).error === 'missing_inputs', 'missing inputs blocked');
  fund(poor);
  poor.money = 0;
  const res = craftRecipe(ctx, poor, gearRecipes[0].id);
  check('gear craft works with zero money', res.ok, res.error);
  check('gear craft added exactly one piece', poor.gear.length === 1);
  check(craftRecipe(ctx, poor, 'not_a_recipe').error === 'unknown_recipe', 'unknown recipe');
}

// --- 4. stats -------------------------------------------------------------------
section('stat math');
{
  const p = newGuest(ctx).player;
  const bare = deriveStats(p, content);
  check(bare.gear.luck === 0 && bare.sellMult === 1, 'no gear ⇒ neutral stats', bare.gear);
  const freeAuto = Number(content.config?.freeAutoRoll?.perSec) || 0;
  check(bare.rollsPerAction === 1 && bare.autoPerSec === freeAuto, 'no gear ⇒ only the free auto roll', bare);

  // Equip one of everything, then re-derive.
  for (const piece of content.gear) {
    const inst = rollGear(piece, content.gearQualityById['mythic']);
    p.gear.push(inst);
    p.equipped[inst.slot] = inst.uid;
  }
  const g = aggregateGear(p, content);
  const st = deriveStats(p, content);
  check(Object.keys(p.equipped).length >= 3, 'multiple slots filled at once', p.equipped);
  check(g.luck > 0 && g.cooldown > 0 && g.essence > 0 && g.sell > 0, 'multi-buff gear sums every axis', g);
  check(Math.abs(st.luck - bare.luck * (1 + g.luck)) < 1e-9, 'luck = base × (1 + gear luck)', { st: st.luck, bare: bare.luck, g: g.luck });
  check(st.rollsPerAction === bare.rollsPerAction + g.rolls, 'rollsPerAction gains flat rolls', st.rollsPerAction);
  check(st.autoPerSec === bare.autoPerSec + g.auto, 'autoPerSec gains flat auto', st.autoPerSec);
  check(Math.abs(st.essenceMult - bare.essenceMult * (1 + g.essence)) < 1e-9, 'essenceMult × (1 + gear essence)');
  check(Math.abs(st.sellMult - (1 + g.sell)) < 1e-9, 'sellMult = 1 + gear sell');
  check(st.cooldownMs < bare.cooldownMs, 'gear speeds rolls up', { before: bare.cooldownMs, after: st.cooldownMs });
  check(
    st.cooldownMs >= (content.upgradeById.quickroll.effect.floorMs ?? 0),
    'cooldown never drops under the upgrade floor',
    st.cooldownMs,
  );

  // Unequipping must take the bonuses back off.
  p.equipped = {};
  const off = deriveStats(p, content);
  check(Math.abs(off.luck - bare.luck) < 1e-9 && off.cooldownMs === bare.cooldownMs, 'unequipping removes the bonuses', off);

  // Buffs (consumables) and gear stack rather than replace each other.
  p.buffs = [{ type: 'luckBuff', mult: 2, until: Date.now() + 60000 }];
  p.equipped = {};
  const one = content.gear.find((x) => x.buffs.some((b) => b.type === 'luck' && b.signature));
  const inst = rollGear(one, content.gearQualityById.mythic);
  p.gear.push(inst);
  p.equipped[inst.slot] = inst.uid;
  const luckFromGear = aggregateGear(p, content).luck;
  const both = deriveStats(p, content);
  check(Math.abs(both.luck - bare.luck * 2 * (1 + luckFromGear)) < 1e-9, 'elixir × gear luck stack', {
    both: both.luck,
    bare: bare.luck,
    luckFromGear,
  });
}

// --- 5. selling ------------------------------------------------------------------
section('selling');
{
  const p = newGuest(ctx).player;
  const aura = content.auras.find((a) => a.odds >= 8);
  p.inventory[aura.id] = { count: 5, lastAt: 0, bestOdds: aura.odds };
  const plain = sellAura(ctx, p, aura.id, 1);
  check(plain.ok, 'sell works', plain.error);
  const baseUnit = plain.unit;

  const ring = content.gearById.gilded_ring || content.gear.find((x) => x.buffs.some((b) => b.type === 'sell' && b.signature));
  const inst = rollGear(ring, content.gearQualityById.mythic);
  p.gear.push(inst);
  p.equipped[inst.slot] = inst.uid;
  const mult = deriveStats(p, content).sellMult;
  p.inventory[aura.id] = { count: 5, lastAt: 0, bestOdds: aura.odds };
  const boosted = sellAura(ctx, p, aura.id, 1);
  check(boosted.unit === Math.max(1, Math.round(baseUnit * mult)), 'gear sell buff lifts the price', {
    baseUnit,
    boosted: boosted.unit,
    mult,
  });
  check(boosted.unit > baseUnit, 'and it is actually higher', { baseUnit, boosted: boosted.unit });
  check(sellAura(ctx, p, 'nope', 1).error === 'unknown_aura', 'sell unknown aura');
}

// --- 6. salvage -------------------------------------------------------------------
section('salvage');
{
  const p = newGuest(ctx).player;
  const piece = content.gear[0];
  const q = content.gearQualityById.mythic;
  const inst = rollGear(piece, q);
  p.gear.push(inst);
  p.equipped[inst.slot] = inst.uid;

  const shown = gearView(p, content).find((v) => v.uid === inst.uid);
  const expected = gearValue(piece, inst, q, content.gearSalvage);
  check(shown.value === expected, 'card value === salvage value', { shown: shown.value, expected });
  check(shown.equipped && shown.equippedIn === inst.slot, 'card knows it is worn', shown);
  check(shown.buffs.every((b) => b.label && b.icon), 'every buff has a label and icon', shown.buffs);

  const money = p.money;
  const res = salvageGear(ctx, p, inst.uid);
  check(res.ok && res.gained === expected, 'salvage pays the shown value', res);
  check(p.money === money + expected, 'money credited', { money, now: p.money });
  check(!p.gear.some((g) => g.uid === inst.uid), 'piece is gone');
  check(!Object.values(p.equipped).includes(inst.uid), 'and no dangling slot points at it', p.equipped);
}

// --- 7. profile + persistence ------------------------------------------------------
section('profile + migration');
{
  const p = newGuest(ctx).player;
  const inst = rollGear(content.gear[0], content.gearQualities[1]);
  p.gear.push(inst);
  p.equipped[inst.slot] = inst.uid;
  const prof = publicProfile(p, ctx);
  check(Array.isArray(prof.gear) && prof.gear.length === 1, 'profile exposes gear', prof.gear);
  check(prof.equipped[inst.slot] === inst.uid, 'profile exposes equipped slots');
  check(prof.stats.gear && typeof prof.stats.sellMult === 'number', 'profile stats carry the gear breakdown', prof.stats);

  // An old save with no gear fields must still load, and a slot pointing at a
  // piece the player never owned must be dropped, not crash. (Accounts carry a
  // password hash — a profile without one is filed under `legacy` instead.)
  const dir = fs.mkdtempSync(path.join(ROOT, 'data', '.gear-test-'));
  const file = path.join(dir, 'a.json');
  const file2 = path.join(dir, 'b.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      players: {
        old: { id: 'old', name: 'OldTimer', passwordHash: 'x', salt: 'y', totalRolls: 5, inventory: {}, items: { elixir: 2 }, equipped: { hands: 'ghost-uid' } },
      },
      sessions: {},
      feed: [],
    }),
  );
  const db = createDb(file);
  const old = db.data.players.old;
  check(Array.isArray(old.gear) && old.gear.length === 0, 'old save gains an empty gear list', old.gear);
  check(Object.keys(old.equipped).length === 0, 'dangling equip pointer pruned', old.equipped);
  check(old.items.elixir === 2, 'items survive the migration', old.items);

  // A real piece survives, a bogus slot does not, and a pre-password profile is
  // filed under legacy rather than deleted.
  const keep = { uid: 'abc', pieceId: content.gear[0].id, slot: content.gear[0].slot, quality: 'fine', buffs: [{ type: 'luck', value: 0.1 }], craftedAt: 1 };
  fs.writeFileSync(
    file2,
    JSON.stringify({ version: 1, players: { p2: { id: 'p2', name: 'Wearer', passwordHash: 'x', salt: 'y', totalRolls: 1, inventory: {}, items: {}, gear: [keep], equipped: { hands: 'abc', head: 'ghost' } }, ancient: { id: 'ancient', name: 'Ancient', totalRolls: 3 } }, sessions: {}, feed: [] }),
  );
  const db2 = createDb(file2);
  const p2 = db2.data.players.p2;
  check(p2.gear.length === 1 && p2.gear[0].uid === 'abc', 'gear survives the migration', p2.gear);
  check(p2.equipped.hands === 'abc' && !p2.equipped.head, 'only the real slot survives', p2.equipped);
  check(!db2.data.players.ancient && db2.data.legacy?.ancient?.name === 'Ancient', 'pre-password profile kept in legacy', Object.keys(db2.data.legacy || {}));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 8. leaderboard -----------------------------------------------------------------
section('leaderboard');
{
  const lctx = makeCtx();
  const mk = (name, patch) => {
    const p = newGuest(lctx).player;
    Object.assign(p, patch);
    return p;
  };
  const alice = mk('Alice', { totalRolls: 500, essence: 10, money: 5, best: { auraId: content.auras[0].id, odds: 100 } });
  const bob = mk('Bob', { totalRolls: 9000, essence: 900, money: 999999, best: { auraId: content.auras[0].id, odds: 4 } });
  const cara = mk('Cara', { totalRolls: 12, essence: 3, money: 3, best: { auraId: content.auras[0].id, odds: 5000 } });
  alice.inventory = { [content.auras[0].id]: { count: 1, lastAt: 0, bestOdds: 100 } };
  bob.inventory = Object.fromEntries(content.auras.slice(0, 9).map((a) => [a.id, { count: 1, lastAt: 0, bestOdds: a.odds }]));

  const arr = leaderboard(lctx);
  check(Array.isArray(arr), 'leaderboard() still returns an array');
  check(arr[0].id === cara.id, 'default sort is rarest pull', arr.map((r) => [r.name, r.bestOdds]));
  check(arr.every((r) => typeof r.gear === 'number'), 'rows carry a gear count');

  const byRolls = leaderboardBoard(lctx, { sort: 'rolls', viewerId: cara.id });
  check(byRolls.rows[0].id === bob.id, 'sort=rolls ranks the grinder first', byRolls.rows.map((r) => r.name));
  check(byRolls.you.rank === 3 && byRolls.you.inTop, 'you knows your rank', byRolls.you);
  check(byRolls.total === 3, 'total counts everyone on the board', byRolls.total);
  check(byRolls.sorts.some((s) => s.id === 'money' && s.icon), 'board advertises its sorts', byRolls.sorts);

  const byMoney = leaderboardBoard(lctx, { sort: 'money' });
  check(byMoney.rows[0].id === bob.id, 'sort=money works', byMoney.rows.map((r) => r.name));
  const byUnique = leaderboardBoard(lctx, { sort: 'unique' });
  check(byUnique.rows[0].id === bob.id, 'sort=unique works', byUnique.rows.map((r) => [r.name, r.unique]));
  check(leaderboardBoard(lctx, { sort: 'garbage' }).sort === 'best', 'unknown sort falls back to best');
  check(leaderboardBoard(lctx, { limit: 2 }).rows.length === 2, 'limit respected');
  check(leaderboardBoard(lctx, { viewerId: 'nobody' }).you === null, 'unknown viewer ⇒ you is null');

  // Gear is a rankable axis now that crafting exists.
  bob.gear = [1, 2, 3].map((n) => ({ uid: `b${n}`, pieceId: content.gear[0].id, slot: content.gear[0].slot, quality: 'fine', buffs: [], craftedAt: 1 }));
  check(leaderboardBoard(lctx, { sort: 'gear' }).rows[0].id === bob.id, 'sort=gear works');
}

// --- summary --------------------------------------------------------------------------
console.log(`\n${failed ? 'FAILED' : 'OK'} — ${checks - failed}/${checks} checks passed`);
if (failed) console.error(`${failed} check(s) failed`);
process.exit(failed ? 1 : 0);
