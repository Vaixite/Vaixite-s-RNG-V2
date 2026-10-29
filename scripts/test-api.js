// End-to-end HTTP test of the whole API: content, static files, accounts,
// guest sessions, the economy routes and the security rules around all of them.
//
// Run: node scripts/test-api.js          (server must be running: node server.js)
//      BASE=http://otherhost:3000 node scripts/test-api.js
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PASSWORD = 'hunter2-hunter2';

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}

async function req(method, path, body, token) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, data, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n  API tests against ${BASE}\n`);

// --- public endpoints ------------------------------------------------------
const health = await req('GET', '/api/health');
check('health responds', health.status === 200 && health.data.ok === true, JSON.stringify(health.data));

const cat = await req('GET', '/api/catalog');
check('catalog has auras', cat.data?.auras?.length > 40, `got ${cat.data?.auras?.length}`);
check('catalog has biomes', cat.data?.biomes?.length >= 8);
check('catalog has upgrades', cat.data?.upgrades?.length >= 5);
check('catalog has shop items', cat.data?.items?.length >= 3, `got ${cat.data?.items?.length}`);
check('catalog has crafting recipes', cat.data?.recipes?.length >= 10, `got ${cat.data?.recipes?.length}`);
check('catalog exposes the sell curve', typeof cat.data?.sell?.coefficient === 'number');
check('catalog hides nothing secret', !JSON.stringify(cat.data).includes('passwordHash'));
check('auras sorted rarest-first', cat.data.auras[0].odds > cat.data.auras.at(-1).odds);
check('every aura carries a tier', cat.data.auras.every((a) => a.tier && a.tierName && a.color));
check('every recipe references a real aura/item', cat.data.recipes.every((r) =>
  (r.inputs || []).every((i) => (i.aura && cat.data.allAuras.some((a) => a.id === i.aura)) ||
    (i.item && cat.data.items.some((x) => x.id === i.item)))));

// --- special auras ----------------------------------------------------------
// Craft-only auras live on their own shelf: authored in auras.json under
// "crafted", never in the roll pool, and always reachable through the forge.
const rollIds = new Set(cat.data.auras.map((a) => a.id));
check('catalog publishes special auras', cat.data.specialAuras?.length >= 3, `got ${cat.data.specialAuras?.length}`);
check('no special aura is in the roll pool', cat.data.specialAuras.every((a) => !rollIds.has(a.id)));
check('special auras are flagged craft-only', cat.data.specialAuras.every((a) => a.craftOnly === true));
check('rolled auras are not flagged craft-only', cat.data.auras.every((a) => a.craftOnly !== true));
check('allAuras is the union of both shelves',
  cat.data.allAuras?.length === cat.data.auras.length + cat.data.specialAuras.length,
  `${cat.data.allAuras?.length} vs ${cat.data.auras.length}+${cat.data.specialAuras?.length}`);
check('every special aura is craftable', cat.data.specialAuras.every((a) => cat.data.recipes.some((r) => r.output?.aura === a.id)),
  cat.data.specialAuras.filter((a) => !cat.data.recipes.some((r) => r.output?.aura === a.id)).map((a) => a.id).join(', '));
check('a special aura has the same shape as a rolled one',
  cat.data.specialAuras.every((a) => a.tier && a.tierName && a.color && a.odds > 0));

// --- equipment definitions --------------------------------------------------
check('catalog has gear pieces', cat.data.gear?.length >= 6, `got ${cat.data.gear?.length}`);
check('every gear piece carries several buffs', cat.data.gear.every((g) => (g.buffs || []).length >= 2),
  JSON.stringify(cat.data.gear.map((g) => [g.id, (g.buffs || []).length])));
check('every gear piece has a signature buff', cat.data.gear.every((g) => (g.buffs || []).some((b) => b.signature)));
check('gear slots are published', cat.data.gearSlots?.length >= 4);
check('gear qualities roll 2..5 buffs', cat.data.gearQualities?.length >= 4 &&
  cat.data.gearQualities.every((q) => q.buffs?.min >= 2 && q.buffs?.max <= 5), JSON.stringify(cat.data.gearQualities?.map((q) => q.buffs)));
check('gear buff types describe their kind', Object.values(cat.data.gearBuffTypes || {}).every((t) => t.kind === 'pct' || t.kind === 'flat'));
check('gear recipes name a real piece and its qualities', cat.data.recipes.filter((r) => r.output?.gear).every((r) =>
  cat.data.gear.some((g) => g.id === r.output.gear) &&
  Object.keys(r.output.qualities || {}).every((q) => cat.data.gearQualities.some((x) => x.id === q))));
check('gear recipes are a real share of the forge', cat.data.recipes.filter((r) => r.output?.gear).length >= 6);

const idx = await req('GET', '/');
check('serves index.html', idx.status === 200 && idx.text.includes("Vaixite's RNG V2"));
check('index has the crafting tab', idx.text.includes('data-view="crafting"'));
check('index has the shop tab', idx.text.includes('data-view="shop"'));
check('index has the gear tab', idx.text.includes('data-view="gear"'));
check('index has the money HUD', idx.text.includes('id="hudMoney"'));
const css = await req('GET', '/css/game.css');
check('serves stylesheet', css.status === 200 && css.text.includes('.roll-btn'));
const jsmod = await fetch(BASE + '/js/main.js');
check('serves JS as a module', jsmod.headers.get('content-type')?.includes('javascript'));
const trav = await fetch(BASE + '/%2e%2e%2f%2e%2e%2fpackage.json');
check('blocks path traversal', trav.status === 403 || trav.status === 404, `got ${trav.status}`);
const contentFile = await fetch(BASE + '/../content/auras.json');
check('content/*.json is not served over HTTP', contentFile.status === 403 || contentFile.status === 404, `got ${contentFile.status}`);
check('unknown api is 404', (await req('GET', '/api/nope')).status === 404);

// --- auth ------------------------------------------------------------------
const suffix = Date.now().toString(36);
const user = `Test${suffix}`;

const weak = await req('POST', '/api/auth/register', { username: user, password: '123' });
check('rejects a short password', weak.status === 400 && weak.data.error === 'weak_password', JSON.stringify(weak.data));

const badName = await req('POST', '/api/auth/register', { username: '<script>x</script>', password: PASSWORD });
check('rejects an illegal username', badName.status === 400 && badName.data.error === 'bad_username', JSON.stringify(badName.data));

const made = await req('POST', '/api/auth/register', { username: user, password: PASSWORD });
check('registers an account', made.status === 201 && !!made.data.token, JSON.stringify(made.data));
const token = made.data.token;
check('register returns a profile', made.data.profile?.name === user, JSON.stringify(made.data.profile?.name));
check('new account starts broke', made.data.profile?.money === 0 && made.data.profile?.essence === 0);

const dupe = await req('POST', '/api/auth/register', { username: user, password: PASSWORD });
check('rejects a duplicate name', dupe.status === 409, `got ${dupe.status}`);

const wrongPass = await req('POST', '/api/auth/login', { username: user, password: 'not-the-password' });
check('rejects a wrong password', wrongPass.status === 401 && wrongPass.data.error === 'bad_credentials');
const noUser = await req('POST', '/api/auth/login', { username: `nope${suffix}`, password: PASSWORD });
check('rejects an unknown username', noUser.status === 401);

const logged = await req('POST', '/api/auth/login', { username: user.toLowerCase(), password: PASSWORD });
check('logs in (case-insensitive name)', logged.status === 200 && !!logged.data.token, JSON.stringify(logged.data));

const guest = await req('POST', '/api/auth/guest', {});
check('guest session works', guest.status === 201 && !!guest.data.token);
check('guest name looks like guest-1234', /^guest-\d+$/.test(guest.data.profile?.name || ''), `got ${guest.data.profile?.name}`);
check('guest is flagged as unsaved', guest.data.profile?.guest === true);
const guestRoll = await req('POST', '/api/roll', { count: 1 }, guest.data.token);
check('guest can roll', guestRoll.status === 200 && guestRoll.data.results.length === 1, JSON.stringify(guestRoll.data));

check('me without a token is 401', (await req('GET', '/api/me')).status === 401);
check('me with a bogus token is 401', (await req('GET', '/api/me', null, 'deadbeef')).status === 401);
check('roll without a token is 401', (await req('POST', '/api/roll', { count: 1 })).status === 401);

// --- rolling ---------------------------------------------------------------
// Cooldown is ~1.1s at level 0, so pace the loop just above it.
let profile = made.data.profile;
const seen = new Map();
let totalResults = 0;
for (let i = 0; i < 10; i++) {
  const r = await req('POST', '/api/roll', { count: 1 }, token);
  if (r.status !== 200) { check(`roll ${i} succeeded`, false, JSON.stringify(r.data)); break; }
  for (const res of r.data.results) seen.set(res.auraId, (seen.get(res.auraId) || 0) + 1);
  totalResults += r.data.results.length;
  profile = r.data.profile;
  await sleep(1150);
}
check('rolls returned results', totalResults >= 10, `got ${totalResults}`);
check('profile roll count advanced', profile.totalRolls >= 10, `got ${profile.totalRolls}`);
check('essence accumulated', profile.essence > 0, `got ${profile.essence}`);
check('inventory populated', Object.keys(profile.inventory).length >= 1);
check('personal best recorded', !!profile.best && profile.best.odds >= 2, JSON.stringify(profile.best));
check('collection count matches inventory', profile.unique === Object.keys(profile.inventory).length);
check('every result is a real aura', [...seen.keys()].every((k) => cat.data.auras.some((a) => a.id === k)));
// Badges pay rewards, so "a roll never mints money out of thin air" now reads
// "money comes from selling, or from a badge the profile says it owns". The two
// are easy to tell apart: the profile carries the id -> unlockedAt map and the
// catalog carries what each of those ids paid.
const badgeMoney = (p) => (cat.data.achievements || [])
  .filter((d) => p.achievements?.[d.id])
  .reduce((s, d) => s + (d.reward?.money || 0), 0);

check('rolls mint nothing but badge rewards', profile.money === badgeMoney(profile), `got ${profile.money}, badges paid ${badgeMoney(profile)}`);

await req('POST', '/api/roll', { count: 1 }, token);
const spam = await req('POST', '/api/roll', { count: 1 }, token);
check('server enforces cooldown', spam.status === 429 && spam.data.error === 'cooldown', `got ${spam.status}`);
check('cooldown reports retry window', spam.data.retryInMs > 0, JSON.stringify(spam.data));

const greedy = await req('POST', '/api/roll', { count: 9999 }, token);
if (greedy.status === 200) {
  check('multi-roll respects the rollsPerAction cap', greedy.data.results.length <= profile.stats.rollsPerAction,
    `got ${greedy.data.results.length}`);
} else {
  check('multi-roll blocked by cooldown', greedy.status === 429);
}

// --- economy routes --------------------------------------------------------
const bogusUpgrade = await req('POST', '/api/upgrade', { upgradeId: 'hack_the_game' }, token);
check('rejects an unknown upgrade id', bogusUpgrade.status === 400 && bogusUpgrade.data.error === 'unknown_upgrade');

const bought = await req('POST', '/api/upgrade', { upgradeId: 'luck' }, token);
if (bought.status === 400) {
  check('rejects an unaffordable upgrade', bought.data.error === 'not_enough_essence', JSON.stringify(bought.data));
} else {
  check('affordable upgrade purchased', bought.data.level === 1, JSON.stringify(bought.data));
  check('luck increased after purchase', bought.data.profile.stats.luck > 1);
}

check('rejects selling an unknown aura',
  (await req('POST', '/api/sell', { auraId: 'not_real' }, token)).data?.error === 'unknown_aura');

const sellable = Object.keys(profile.inventory)[0];
const sold = await req('POST', '/api/sell', { auraId: sellable, count: 1 }, token);
check('selling an aura pays money', sold.status === 200 && sold.data.gained > 0, JSON.stringify(sold.data));
check('selling pays exactly its price', sold.data.profile.money === sold.data.gained + badgeMoney(sold.data.profile),
  `got ${sold.data.profile?.money}, sale ${sold.data.gained}, badges ${badgeMoney(sold.data.profile)}`);

const broke = await req('POST', '/api/shop/buy', { itemId: cat.data.items[0].id }, token);
check('shop refuses money you do not have', broke.status === 400 && broke.data.error === 'not_enough_money', JSON.stringify(broke.data));
check('shop rejects an unknown item',
  (await req('POST', '/api/shop/buy', { itemId: 'free_stuff' }, token)).data?.error === 'unknown_item');
check('using an item you do not own fails',
  (await req('POST', '/api/item/use', { itemId: cat.data.items[0].id }, token)).data?.error === 'no_item');

check('craft rejects an unknown recipe',
  (await req('POST', '/api/craft', { recipeId: 'forge_the_universe' }, token)).data?.error === 'unknown_recipe');
const hardRecipe = cat.data.recipes.find((r) => (r.inputs || []).some((i) => (profile.inventory[i.aura]?.count || 0) < i.count));
if (hardRecipe) {
  const miss = await req('POST', '/api/craft', { recipeId: hardRecipe.id }, token);
  check('craft refuses when materials are missing', miss.status === 400 && miss.data.error === 'missing_inputs', JSON.stringify(miss.data));
}

// --- gear routes -------------------------------------------------------------
for (const path of ['/api/gear/equip', '/api/gear/unequip', '/api/gear/salvage']) {
  check(`${path} requires a session`, (await req('POST', path, { uid: 'x' })).status === 401);
  const nope = await req('POST', path, { uid: 'no-such-piece' }, token);
  check(`${path} rejects a piece you do not own`,
    nope.status === 400 && nope.data.error === 'unknown_gear', JSON.stringify(nope.data));
}
check('a fresh account starts with an empty gear bag', Array.isArray(profile.gear) && profile.gear.length === 0,
  JSON.stringify(profile.gear));
check('profile exposes the equip slots', profile.equipped && typeof profile.equipped === 'object');
check('profile stats carry the gear breakdown', !!profile.stats?.gear && typeof profile.stats.sellMult === 'number',
  JSON.stringify(profile.stats));

// --- world -----------------------------------------------------------------
const world = await req('GET', '/api/world');
check('world exposes a biome', !!world.data.biome?.id && typeof world.data.biome.endsAt === 'number');
check('biome countdown is in the future', world.data.biome.endsAt > Date.now());
check('world exposes leaderboard', Array.isArray(world.data.leaderboard));
check('world exposes feed', Array.isArray(world.data.feed));

const rows = (await req('GET', '/api/leaderboard')).data.leaderboard;
check('leaderboard includes our account', rows.some((r) => r.id === profile.id));
check('leaderboard marks guests', rows.some((r) => r.id === guest.data.profile.id && r.guest === true));
const best = rows.filter((r) => r.bestOdds !== null).map((r) => r.bestOdds);
check('leaderboard ranked rarest-first', best.every((v, i) => i === 0 || best[i - 1] >= v), JSON.stringify(best));

// --- the sortable board ------------------------------------------------------
const board = await req('GET', '/api/leaderboard');
check('board advertises every column it can rank by',
  Array.isArray(board.data.sorts) && board.data.sorts.length >= 6, JSON.stringify(board.data.sorts?.map((s) => s.id)));
check('board defaults to the rarest-pull column', board.data.sort === 'best');
check('board counts the players it ranked', typeof board.data.total === 'number' && board.data.total >= 1);
check('anonymous board has no personal row', board.data.you === null);

const byRolls = await req('GET', '/api/leaderboard?sort=rolls');
const rollCol = byRolls.data.rows.map((r) => r.totalRolls);
check('board sorts by total rolls', rollCol.every((v, i) => i === 0 || rollCol[i - 1] >= v), JSON.stringify(rollCol));
const byMoney = await req('GET', '/api/leaderboard?sort=money');
const moneyCol = byMoney.data.rows.map((r) => r.money);
check('board sorts by money', moneyCol.every((v, i) => i === 0 || moneyCol[i - 1] >= v), JSON.stringify(moneyCol));
check('unknown sort falls back to best', (await req('GET', '/api/leaderboard?sort=everything')).data.sort === 'best');
check('board limit is respected', (await req('GET', '/api/leaderboard?limit=1')).data.rows.length <= 1);

const mineBoard = await req('GET', '/api/leaderboard?sort=rolls', null, token);
check('signed-in board reports your rank', mineBoard.data.you?.row?.id === profile.id, JSON.stringify(mineBoard.data.you));
check('your rank is a real position', mineBoard.data.you?.rank >= 1, JSON.stringify(mineBoard.data.you?.rank));

const after = world.data.feed[0]?.id;
const inc = await req('GET', `/api/feed?after=${after || ''}`);
check('incremental feed poll works', inc.status === 200 && Array.isArray(inc.data.feed));
check('incremental poll excludes seen entries', !inc.data.feed.some((e) => e.id === after));

const me = await req('GET', '/api/me', null, token);
check('me returns profile + odds', me.data.profile?.id === profile.id && Array.isArray(me.data.odds));
check('odds table covers every aura', me.data.odds.length === cat.data.auras.length);
check('me exposes money and items', typeof me.data.profile.money === 'number' && typeof me.data.profile.items === 'object');

// The renamed identity is unique per run so the suite can be pointed at a
// database that already has yesterday's test accounts in it.
const renamed = `Renamed${suffix}`;
const ren = await req('POST', '/api/rename', { name: renamed }, token);
check('rename works', ren.data.profile.name === renamed, JSON.stringify(ren.data));
check('rename rejects an empty name', (await req('POST', '/api/rename', { name: '  ' }, token)).status === 400);
const clash = await req('POST', '/api/rename', { name: renamed }, guest.data.token);
check('rename rejects a taken name', clash.status === 409, `got ${clash.status}`);

// --- persistence + password security ---------------------------------------
// Read back the same file the server was told to write: run the suite against a
// throwaway database with DATA_FILE=… and it checks that one, never the real one.
const DB_FILE = process.env.DATA_FILE
  ? new URL(`file:///${path.resolve(process.env.DATA_FILE).replace(/\\/g, '/')}`)
  : new URL('../data/db.json', import.meta.url);
await sleep(700); // let the debounced write land
const onDisk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const disk = onDisk.players[profile.id];
check('database file contains the account', !!disk, 'account missing from db.json');
check('database persisted rolls', disk.totalRolls >= 10, `got ${disk?.totalRolls}`);
check('password is stored hashed', typeof disk.passwordHash === 'string' && disk.passwordHash.length >= 64, JSON.stringify(disk?.passwordHash?.slice(0, 12)));
check('password has a per-account salt', typeof disk.salt === 'string' && disk.salt.length >= 16);
check('plain password is nowhere in the database', !JSON.stringify(onDisk).includes(PASSWORD));
check('session token is persisted for accounts', Object.values(onDisk.sessions).some((s) => s.playerId === profile.id));
// The world feed is global and does show a guest's display name — that is a
// ticker entry, not saved progress. What must never happen is a guest record.
check('guest accounts are never written to disk',
  !Object.values(onDisk.players).some((p) => p.guest || p.name === guest.data.profile.name),
  'guest found in db.json players');
check('guest session is not persisted', !Object.values(onDisk.sessions).some((s) => s.playerId === guest.data.profile.id));

// --- guest isolation --------------------------------------------------------
const guestMe = await req('GET', '/api/me', null, guest.data.token);
check('guest has its own profile', guestMe.data.profile.id === guest.data.profile.id);
check('guest rolls do not leak into the account', guestMe.data.profile.totalRolls === 1 && profile.totalRolls >= 10,
  `guest ${guestMe.data.profile.totalRolls} vs account ${profile.totalRolls}`);

// --- cleanup ----------------------------------------------------------------
const loggedOut = await req('POST', '/api/auth/logout', {}, token);
check('logout succeeds', loggedOut.status === 200 && loggedOut.data.ok);
check('logout kills the token', (await req('GET', '/api/me', null, token)).status === 401);

const relogin = await req('POST', '/api/auth/login', { username: renamed, password: PASSWORD });
check('can log back in after logout', relogin.status === 200 && !!relogin.data.token);

const del = await req('POST', '/api/delete', {}, relogin.data.token);
check('delete account works', del.status === 200 && del.data.ok);
check('deleted account cannot sign in', (await req('POST', '/api/auth/login', { username: renamed, password: PASSWORD })).status === 401);
check('deleted guest session dies too', (await req('POST', '/api/auth/logout', {}, guest.data.token)).status === 200);

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  console.log('  Failed:');
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
