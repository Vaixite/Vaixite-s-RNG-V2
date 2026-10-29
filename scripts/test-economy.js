import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';
import { verifyPassword } from '../src/auth.js';
import {
  newAccount,
  loginAccount,
  newGuest,
  createSession,
  resolveSession,
  destroySession,
  deriveStats,
  rollForPlayer,
  buyUpgrade,
  ascendForPlayer,
  sellAura,
  craftRecipe,
  buyItem,
  useItem,
  publicProfile,
  leaderboard,
  pushFeed,
  feedSince,
  feedOrder,
  feedHoldMs,
  feedIsPinned,
  worldFeed,
  sellPrice,
} from '../src/game.js';

// ---------------------------------------------------------------------------
// GAME RULE TESTS — no HTTP, no browser: this drives src/game.js directly with
// a throwaway in-memory database, so the money / crafting / shop / account
// rules are verified in milliseconds and deterministically.
//
// Run: node scripts/test-economy.js
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const content = createContentLoader(path.join(__dirname, '..', 'content')).get();

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A db stub with the same surface src/game.js touches.
function makeCtx() {
  return {
    db: {
      data: {
        players: {},
        sessions: {},
        feed: [],
        meta: { totalRolls: 0, nextPlayerId: 1 },
      },
      dirty: 0,
      markDirty() { this.dirty++; },
      save() { return Promise.resolve(); },
    },
    mem: { guests: {}, sessions: new Map() },
    rateLimit: () => true,
    content,
  };
}

const PASSWORD = 'correct horse battery';
console.log(`\n  Game rule tests · ${content.auras.length} auras, ${content.recipes.length} recipes, ${content.items.length} items\n`);

// --- accounts -----------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Vaixite', PASSWORD);
  check('account created', !!player?.id);
  check('password is hashed, never stored plain', player.passwordHash !== PASSWORD && !JSON.stringify(player).includes(PASSWORD));
  check('hash has a random salt', verifyPassword(PASSWORD, player.salt, player.passwordHash));
  check('wrong password fails verification', !verifyPassword('nope', player.salt, player.passwordHash));
  check('salt differs per account', newAccount(ctx, 'Someone', PASSWORD).player.salt !== player.salt);
  check('login accepts the right password', loginAccount(ctx, 'vaixite', PASSWORD).player?.id === player.id);
  check('login rejects the wrong password', loginAccount(ctx, 'vaixite', 'nope').error === 'bad_credentials');
  check('login rejects an unknown name', loginAccount(ctx, 'nobody', PASSWORD).error === 'bad_credentials');
  check('short password rejected', newAccount(ctx, 'Brevity', '123').error === 'weak_password');
  check('junk username rejected', newAccount(ctx, '<b>x</b>', PASSWORD).error === 'bad_username');
  check('duplicate name rejected', newAccount(ctx, 'VAIXITE', PASSWORD).error === 'name_taken');

  const token = createSession(ctx, player);
  check('session resolves to the player', resolveSession(ctx, token)?.id === player.id);
  check('session is persisted for accounts', !!ctx.db.data.sessions[token]);
  destroySession(ctx, token);
  check('logout destroys the session', resolveSession(ctx, token) === null);
  check('unknown token resolves to nobody', resolveSession(ctx, 'abcdef') === null);
}

// --- guests --------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newGuest(ctx);
  check('guest name is guest-####', /^guest-\d{4}$/.test(player.name), `got ${player.name}`);
  check('guest is flagged', player.guest === true);
  check('guest never touches the database file', Object.keys(ctx.db.data.players).length === 0);
  const token = createSession(ctx, player);
  check('guest session lives in memory only', ctx.mem.sessions.has(token) && !ctx.db.data.sessions[token]);
  check('guest session resolves', resolveSession(ctx, token)?.id === player.id);
  const second = newGuest(ctx);
  check('guest names do not collide', second.player.name !== player.name);
}

// --- rolling ---------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Roller', PASSWORD);
  const now = Date.now();
  const out = rollForPlayer(ctx, player, 1, now);
  check('roll returns one result', out.results?.length === 1, JSON.stringify(out).slice(0, 120));
  check('roll result references a real aura', content.auraById[out.results[0].auraId] !== undefined);
  check('roll grants essence', player.essence > 0);
  check('roll records the aura', player.inventory[out.results[0].auraId]?.count === 1);
  check('roll marks it new', out.results[0].isNew === true);
  check('roll sets the personal best', player.best?.auraId === out.results[0].auraId);
  check('roll count incremented', player.totalRolls === 1);
  check('roll pushed to the world feed', ctx.db.data.feed.length === 1);

  const again = rollForPlayer(ctx, player, 1, now + 10);
  check('cooldown blocks a second roll', again.error === 'cooldown' && again.retryInMs > 0);
  const countsBefore = Object.fromEntries(Object.entries(player.inventory).map(([k, v]) => [k, v.count]));
  const later = rollForPlayer(ctx, player, 1, now + 5000);
  check('roll works again after the cooldown', later.results?.length === 1);
  const repeatId = later.results[0].auraId;
  check('isNew only ever fires on the first copy', later.results[0].isNew === !countsBefore[repeatId]);
  check('count is capped by rollsPerAction', rollForPlayer(ctx, player, 999, now + 99000).results.length === 1);

  const stats = deriveStats(player, content);
  check('base luck is 1 with no upgrades', stats.luck === 1);
  check('base cooldown is the configured 1100ms', Math.abs(stats.cooldownMs - 1100) < 1e-9);
}

// --- upgrades -----------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Buyer', PASSWORD);
  player.essence = 10_000;

  const first = buyUpgrade(ctx, player, 'luck');
  check('upgrade succeeds when affordable', first.ok && first.level === 1);
  check('upgrade charges essence', player.essence === 10_000 - first.cost, `left ${player.essence}`);
  check('luck upgrade raises luck', deriveStats(player, content).luck > 1);

  const second = buyUpgrade(ctx, player, 'luck');
  check('upgrade cost grows with level', second.cost > first.cost, `${first.cost} -> ${second.cost}`);

  check('unknown upgrade rejected', buyUpgrade(ctx, player, 'moon').error === 'unknown_upgrade');

  player.essence = 0;
  check('unaffordable upgrade rejected', buyUpgrade(ctx, player, 'luck').error === 'not_enough_essence');

  player.levels.quickroll = content.upgradeById.quickroll.max;
  check('maxed upgrade rejected', buyUpgrade(ctx, player, 'quickroll').error === 'maxed');

  player.levels.multiroll = 3;
  check('multiroll adds auras per roll', deriveStats(player, content).rollsPerAction === 4);
  player.levels.autoroll = 2;
  // Free auto roll (1/s) is everyone's baseline; the upgrade stacks on top.
  check('autoroll adds rolls per second', deriveStats(player, content).autoPerSec === 3);
}

// --- selling --------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Seller', PASSWORD);
  player.inventory.common = { count: 3, bestOdds: 2, firstAt: Date.now(), lastAt: Date.now() };

  const one = sellAura(ctx, player, 'common', 1);
  check('selling pays money', one.ok && one.gained > 0, JSON.stringify(one));
  check('selling removes one copy', player.inventory.common.count === 2);
  check('money balance updated', player.money === one.gained);

  const all = sellAura(ctx, player, 'common', 99);
  check('selling clamps to what you own', all.sold === 2);
  check('empty slot is removed', player.inventory.common === undefined);
  check('selling nothing fails', sellAura(ctx, player, 'common', 1).error === 'nothing_to_sell');
  check('unknown aura fails', sellAura(ctx, player, 'not_real', 1).error === 'unknown_aura');

  const rare = sellAura(ctx, { ...player, inventory: { transcendence: { count: 1 } }, money: 0 }, 'transcendence', 1);
  check('rarer auras sell for more', rare.gained > one.gained, `${one.gained} vs ${JSON.stringify(rare)}`);
}

// --- crafting ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Crafter', PASSWORD);
  const recipe = content.recipes.find((r) => r.output.aura === 'rare');
  player.inventory.uncommon = { count: 5, bestOdds: 4, firstAt: 0, lastAt: 0 };
  player.money = 1_000_000;

  const out = craftRecipe(ctx, player, recipe.id);
  check('craft succeeds with materials', out.ok, JSON.stringify(out));
  check('craft consumes the inputs', player.inventory.uncommon.count === 5 - recipe.inputs[0].count);
  check('craft grants the output', player.inventory.rare.count === recipe.output.count);
  check('craft is materials-only — money untouched', player.money === 1_000_000);
  check('crafted aura carries a best odds', player.inventory.rare.bestOdds === content.auraById.rare.odds);

  player.inventory.uncommon.count = 1;
  check('craft refuses without materials', craftRecipe(ctx, player, recipe.id).error === 'missing_inputs');
  check('failed craft consumed nothing', player.inventory.uncommon.count === 1 && player.money === 1_000_000);

  player.money = 0;
  player.inventory.uncommon.count = 9;
  check('craft works with zero money', craftRecipe(ctx, player, recipe.id).ok);
  check('unknown recipe rejected', craftRecipe(ctx, player, 'forge_gold').error === 'unknown_recipe');

  // Item output path.
  const itemRecipe = content.recipes.find((r) => r.output.item);
  for (const inp of itemRecipe.inputs || []) {
    player.inventory[inp.aura] = { count: 99, bestOdds: 1, firstAt: 0, lastAt: 0 };
  }
  player.money = 10_000_000;
  const brewed = craftRecipe(ctx, player, itemRecipe.id);
  check('craft can produce an item', brewed.ok && brewed.received.kind === 'item');
  check('item landed in the inventory', player.items[itemRecipe.output.item] === itemRecipe.output.count);
}

// --- special auras: crafted, never rolled, never lost ---------------------------------------
// "Special" is one shelf with two ways onto it: the host authored it under
// "crafted" so it can only be made, or the host deleted an aura you already
// rolled. Both rules below are the contract the Bestiary and the inventory draw.
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Curator', PASSWORD);
  const specialIds = new Set(content.specialAuras.map((a) => a.id));

  check('the game ships special auras', content.specialAuras.length > 0);
  check('craft-only auras are out of the roll pool', content.auras.every((a) => !a.craftOnly));
  check('every special aura is flagged craft-only', content.specialAuras.every((a) => a.craftOnly === true));
  check('every special aura has zero share', content.specialAuras.every((a) => a.share === 0));
  check('the lookup covers rolled and crafted auras',
    content.allAuras.length === content.auras.length + content.specialAuras.length);
  check('every special aura has a recipe', content.uncraftableSpecial.length === 0, content.uncraftableSpecial.join(', '));
  check('the collection counts the whole bestiary', publicProfile(player, ctx).totalAuras === content.allAuras.length);

  // The pool is the only door. 128k rolls with luck switched off (the authored
  // table, so the rare end is reachable) must never land on a special aura.
  const roller = newAccount(ctx, 'Grinder', PASSWORD).player;
  roller.luckOff = true;
  let leaked = 0;
  for (let i = 0; i < 4000; i++) {
    const out = rollForPlayer(ctx, roller, 32, 1_000_000_000_000 + i * 10_000);
    for (const r of out.results || []) if (specialIds.has(r.auraId)) leaked++;
  }
  check('128,000 rolls never produce a special aura', leaked === 0, `${leaked} leak(s)`);

  // Craft one: it lands stamped, so the slot describes itself forever after.
  const recipe = content.recipes.find((r) => r.output.aura === 'reliquary');
  for (const inp of recipe.inputs || []) {
    player.inventory[inp.aura] = { count: 99, bestOdds: 1, firstAt: 0, lastAt: 0 };
  }
  player.money = 1_000_000_000;
  const sealed = craftRecipe(ctx, player, recipe.id);
  check('a special aura can be crafted', sealed.ok && sealed.received.auraId === 'reliquary', JSON.stringify(sealed));
  check('a crafted special is stamped craft-only', player.inventory.reliquary.craftOnly === true);
  check('a crafted special describes itself',
    player.inventory.reliquary.name === content.auraById.reliquary.name &&
      !!player.inventory.reliquary.color && !!player.inventory.reliquary.tierName);
  const soldSpecial = sellAura(ctx, player, 'reliquary', 1);
  check('a special aura sells', soldSpecial.gained > 0, JSON.stringify(soldSpecial));

  // Now the host deletes it: the definition is gone, the collection is not.
  const def = content.auraById.reliquary;
  const orphan = newAccount(ctx, 'Orphan', PASSWORD).player;
  orphan.inventory.reliquary = {
    count: 2, bestOdds: def.odds, firstAt: 0, lastAt: 0,
    name: def.name, color: def.color, fx: def.fx, odds: def.odds,
    tier: def.tier, tierName: def.tierName, tierColor: def.tierColor, craftOnly: true,
  };
  const orphanCtx = {
    ...ctx,
    content: { ...content, auraById: { ...content.auraById } },
  };
  delete orphanCtx.content.auraById.reliquary;

  const soldDeleted = sellAura(orphanCtx, orphan, 'reliquary', 1);
  check('a deleted aura still sells from its snapshot', soldDeleted.gained > 0, JSON.stringify(soldDeleted));
  check('a deleted aura sells for what it was worth', soldDeleted.unit === sellPrice(content.sell, def.odds),
    `${soldDeleted.unit} vs ${sellPrice(content.sell, def.odds)}`);
  check('selling one leaves the rest', orphan.inventory.reliquary.count === 1);
  check('an unknown id nobody owns is still a typo', sellAura(orphanCtx, orphan, 'not_real', 1).error === 'unknown_aura');
}

// --- shop + items --------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Shopper', PASSWORD);
  const elixir = content.items.find((i) => i.effect?.type === 'luckBuff');
  const surge = content.items.find((i) => i.effect?.type === 'essence');

  check('shop refuses when broke', buyItem(ctx, player, elixir.id).error === 'not_enough_money');
  player.money = elixir.buyPrice * 2;
  const bought = buyItem(ctx, player, elixir.id);
  check('shop sells an item', bought.ok && player.items[elixir.id] === 1);
  check('shop charges money', player.money === elixir.buyPrice);
  check('unknown item rejected', buyItem(ctx, player, 'admin_panel').error === 'unknown_item');

  const before = deriveStats(player, content).luck;
  const now = Date.now();
  const used = useItem(ctx, player, elixir.id, now);
  check('using an item works', used.ok);
  check('item is consumed', player.items[elixir.id] === undefined);
  check('luck buff is active', deriveStats(player, content, now).luck === before * elixir.effect.mult);
  check('buff is visible on the profile', publicProfile(player, ctx, now).buffs.length === 1);
  // Checked last: pruning an expired buff mutates the player.
  check('luck buff expires', deriveStats(player, content, now + elixir.effect.durationMs + 1).luck === before);

  player.essence = 5;
  player.items[surge.id] = 1;
  const surged = useItem(ctx, player, surge.id, now);
  check('essence item grants essence', player.essence === 5 + surge.effect.amount, JSON.stringify(surged));
  check('using what you do not have fails', useItem(ctx, player, elixir.id, now).error === 'no_item');
}

// --- ascend -------------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const { player } = newAccount(ctx, 'Ascendant', PASSWORD);
  check('ascend blocked too early', ascendForPlayer(ctx, player).error === 'not_ready');

  player.totalRolls = content.ascend.requirementBase;
  player.essence = 500;
  player.levels.luck = 4;
  player.money = 777;
  player.inventory.common = { count: 2, bestOdds: 2, firstAt: 0, lastAt: 0 };

  const achBefore = new Set(Object.keys(player.achievements || {}));
  const up = ascendForPlayer(ctx, player);
  check('ascend succeeds at the requirement', up.ok && up.ascensions === 1);
  check(
    'ascend points come from essence',
    up.pointsGained === Math.floor(Math.sqrt(500 / content.ascend.pointEssenceDiv)),
    `got ${up.pointsGained}`
  );
  check('ascend resets levels', eq(player.levels, { luck: 0, quickroll: 0, multiroll: 0, autoroll: 0, essence: 0 }));
  check('ascend resets essence', player.essence === 0);
  check('ascend keeps the collection', player.inventory.common.count === 2);
  // Ascend itself never touches money — but serialising the fresh profile
  // settles achievements, and the first ascension is a money badge. The only
  // legitimate delta is exactly what those brand-new badges pay out.
  const badgeMoney = Object.keys(player.achievements || {})
    .filter((id) => !achBefore.has(id))
    .reduce((s, id) => s + (content.achievementById[id]?.reward?.money || 0), 0);
  check('ascend keeps money (badge rewards aside)', player.money === 777 + badgeMoney,
    `money ${player.money}, badges +${badgeMoney}`);
  check('first ascension unlocks its badge', !!player.achievements?.ascend_1);
  check('ascend grants permanent luck', Math.abs(up.luckMult - (1 + content.ascend.luckPerAscension)) < 1e-9);
  check('second ascend needs more rolls', ascendForPlayer(ctx, player).error === 'not_ready');
}

// --- feed + leaderboard ----------------------------------------------------------------------
{
  const ctx = makeCtx();
  const a = newAccount(ctx, 'Alpha', PASSWORD).player;
  const b = newAccount(ctx, 'Bravo', PASSWORD).player;
  const g = newGuest(ctx).player;
  a.totalRolls = 10; a.best = { auraId: 'common', odds: 2 };
  b.totalRolls = 5; b.best = { auraId: 'transcendence', odds: 134217728 };
  g.totalRolls = 1; g.best = { auraId: 'ruby', odds: 384 };

  const rows = leaderboard(ctx);
  check('leaderboard lists accounts and guests', rows.length === 3);
  check('leaderboard ranks by rarest pull', rows[0].name === 'Bravo' && rows[1].name === g.name && rows[2].name === 'Alpha',
    rows.map((r) => `${r.name}:${r.bestOdds}`).join(', '));
  check('leaderboard marks guests', rows.find((r) => r.guest)?.name === g.name);
  check('leaderboard reports the collection size', rows[0].totalAuras === content.allAuras.length);
}

// --- feed pinning + expiry ---------------------------------------------------------------
// A big pull holds the top of the world feed for a while, then drops back into
// the chronological list — and once it is older than the feed TTL it is swept
// off the ticker for good. Every window here is read back out of config.json,
// so retuning the ladder can never make this test lie.
{
  const cfg = content.config;
  const tiers = [...cfg.feedPin.tiers].sort((a, b) => a.minOdds - b.minOdds);
  const now = Date.now();
  const mk = (id, odds, ageMs) => ({ id, odds, at: now - ageMs, player: 'P', auraName: 'Aura' });
  const below = tiers[0].minOdds - 1;

  check('a pull below every tier is never held', feedHoldMs(cfg, mk('x', below, 0)) === 0);
  check('a pull keeps the longest tier it clears', feedHoldMs(cfg, mk('x', tiers.at(-1).minOdds, 0)) === tiers.at(-1).holdMs);
  check('a bigger pull is held longer', tiers.every((t, i) => i === 0 || t.holdMs > tiers[i - 1].holdMs),
    JSON.stringify(tiers.map((t) => t.holdMs)));
  check('a pull inside its window is pinned', feedIsPinned(cfg, mk('x', tiers[0].minOdds, 1), now));
  check('a pull past its window is not', !feedIsPinned(cfg, mk('x', tiers.at(-1).minOdds, tiers.at(-1).holdMs + 1), now));

  const ctx = makeCtx();
  const top = mk('top', tiers.at(-1).minOdds, 0);   // newest and rarest
  const mid = mk('mid', tiers[1].minOdds, 1000);    // held, but not the newest
  const low = mk('low', tiers[0].minOdds, 2000);    // held, oldest of the three
  const plain = mk('plain', below, 500);            // never held, fresher than mid and low
  const dead = mk('dead', tiers.at(-1).minOdds, Math.max(tiers.at(-1).holdMs, cfg.feedTtl?.ms || 0) + 1000); // pin lapsed and past the feed TTL
  // pushFeed unshifts, so feed oldest-first to end up newest-first.
  for (const e of [dead, low, mid, plain, top]) pushFeed(ctx, e);

  const ordered = feedOrder(ctx.db.data.feed, cfg, now).map((e) => e.id);
  check('held pulls sit above everything else', ordered.slice(0, 3).join(',') === 'top,mid,low', ordered.join(','));
  check('held pulls rank rarest first, not newest first', ordered.join(',') === 'top,mid,low,plain', ordered.join(','));
  check('an expired pin past the feed TTL is swept away', !ctx.db.data.feed.some((e) => e.id === 'dead'),
    JSON.stringify(ctx.db.data.feed.map((e) => e.id)));
  check('the incremental cursor stays chronological', eq(feedSince(ctx, 'mid').map((e) => e.id), ['top', 'plain']),
    JSON.stringify(feedSince(ctx, 'mid').map((e) => e.id)));

  // A held pull must survive being buried: 30 unremarkable rolls newer than it.
  const busy = makeCtx();
  pushFeed(busy, mk('giant', tiers.at(-1).minOdds, 20000));
  for (let i = 0; i < 30; i++) pushFeed(busy, mk(`n${i}`, below, i * 100));
  const wf = worldFeed(busy, 25);
  check('a buried pull is still outside the newest slice', !busy.db.data.feed.slice(0, 25).some((e) => e.id === 'giant'));
  check('a held pull is never pushed off a fresh load', wf.some((e) => e.id === 'giant'));
  check('and it leads the feed', wf[0]?.id === 'giant', wf[0]?.id);
}

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  console.log('  Failed:');
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
