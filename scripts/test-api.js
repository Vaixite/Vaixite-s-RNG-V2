// End-to-end API test. Requires the server to be running (node server.js).
// Run: node scripts/test-api.js
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, data, text };
}

console.log(`\n  API tests against ${BASE}\n`);

// --- health + catalog ------------------------------------------------------
const health = await req('GET', '/api/health');
check('health responds', health.status === 200 && health.data.ok === true, JSON.stringify(health.data));

const cat = await req('GET', '/api/catalog');
check('catalog has auras', cat.data?.auras?.length > 40, `got ${cat.data?.auras?.length}`);
check('catalog has biomes', cat.data?.biomes?.length >= 8);
check('catalog has upgrades', cat.data?.upgrades?.length === 5);
check('auras sorted rarest-first', cat.data.auras[0].odds > cat.data.auras.at(-1).odds);
check('every aura carries a tier', cat.data.auras.every((a) => a.tier && a.tierName && a.color));

// --- static + traversal ----------------------------------------------------
const idx = await req('GET', '/');
check('serves index.html', idx.status === 200 && idx.text.includes("Vaixite's RNG V2"));
const css = await req('GET', '/css/game.css');
check('serves stylesheet', css.status === 200 && css.text.includes('.roll-btn'));
const jsmod = await fetch(BASE + '/js/main.js');
check('serves JS as a module', jsmod.headers.get('content-type')?.includes('javascript'));
const trav = await fetch(BASE + '/%2e%2e%2f%2e%2e%2fpackage.json');
check('blocks path traversal', trav.status === 403 || trav.status === 404, `got ${trav.status}`);
const missing = await req('GET', '/api/nope');
check('unknown api is 404', missing.status === 404);

// --- player lifecycle ------------------------------------------------------
const name = `Test${Date.now().toString(36)}`;
const made = await req('POST', '/api/player', { name });
check('creates a player', made.status === 201 && !!made.data.id, JSON.stringify(made.data));
const id = made.data.id;

const dupe = await req('POST', '/api/player', { name });
check('rejects duplicate name', dupe.status === 409, `got ${dupe.status}`);
const empty = await req('POST', '/api/player', { name: '   ' });
check('rejects empty name', empty.status === 400, `got ${empty.status}`);
const injected = await req('POST', '/api/player', { name: '<script>alert(1)</script>' });
check('strips HTML from names', injected.status === 400 || !injected.data?.profile?.name?.includes('<'),
  JSON.stringify(injected.data));

const badRoll = await req('POST', '/api/roll', { id: 'not-a-real-id' });
check('roll with bad id is 404', badRoll.status === 404);

// --- rolling ---------------------------------------------------------------
// Cooldown is ~1.1s at level 0, so pace the loop just above it.
let profile = made.data.profile;
const seen = new Map();
let totalResults = 0;

for (let i = 0; i < 14; i++) {
  const r = await req('POST', '/api/roll', { id, count: 1 });
  if (r.status !== 200) { check(`roll ${i} succeeded`, false, JSON.stringify(r.data)); break; }
  for (const res of r.data.results) seen.set(res.auraId, (seen.get(res.auraId) || 0) + 1);
  totalResults += r.data.results.length;
  profile = r.data.profile;
  await new Promise((s) => setTimeout(s, 1150));
}

check('rolls returned results', totalResults >= 14, `got ${totalResults}`);
check('profile roll count advanced', profile.totalRolls >= 14, `got ${profile.totalRolls}`);
check('essence accumulated', profile.essence > 0, `got ${profile.essence}`);
check('inventory populated', Object.keys(profile.inventory).length >= 1);
check('personal best recorded', !!profile.best && profile.best.odds >= 2, JSON.stringify(profile.best));
check('collection count matches inventory', profile.unique === Object.keys(profile.inventory).length);
check('every result carries display data', [...seen.keys()].every((k) => cat.data.auras.some((a) => a.id === k)));

// --- cooldown enforcement --------------------------------------------------
// Roll once (the loop's trailing sleep guarantees this one lands), then hit
// the endpoint again immediately so we are definitely inside the window.
await req('POST', '/api/roll', { id, count: 1 });
const spam = await req('POST', '/api/roll', { id, count: 1 });
check('server enforces cooldown', spam.status === 429 && spam.data.error === 'cooldown', `got ${spam.status}`);
check('cooldown reports retry window', spam.data.retryInMs > 0, JSON.stringify(spam.data));

// --- multi-roll cap --------------------------------------------------------
const greedy = await req('POST', '/api/roll', { id, count: 9999 });
if (greedy.status === 200) {
  check('multi-roll respects rollsPerAction cap', greedy.data.results.length <= profile.stats.rollsPerAction,
    `got ${greedy.data.results.length}`);
} else {
  check('multi-roll blocked by cooldown', greedy.status === 429);
}

// --- upgrades --------------------------------------------------------------
const bought = await req('POST', '/api/upgrade', { id, upgradeId: 'luck' });
if (bought.status === 400) {
  check('rejects unaffordable upgrade', bought.data.error === 'not_enough_essence', JSON.stringify(bought.data));
} else {
  check('affordable upgrade purchased', bought.data.level === 1, JSON.stringify(bought.data));
  check('luck increased after purchase', bought.data.profile.stats.luck > 1, JSON.stringify(bought.data.profile.stats));
}
const bogus = await req('POST', '/api/upgrade', { id, upgradeId: 'hack_the_game' });
check('rejects unknown upgrade id', bogus.status === 400 && bogus.data.error === 'unknown_upgrade');

// --- feed + leaderboard ----------------------------------------------------
const world = await req('GET', '/api/world');
check('world exposes a biome', !!world.data.biome?.id && typeof world.data.biome.endsAt === 'number');
check('biome countdown is in the future', world.data.biome.endsAt > Date.now());
check('world exposes leaderboard', Array.isArray(world.data.leaderboard));
check('world exposes feed', Array.isArray(world.data.feed));

const lb = await req('GET', '/api/leaderboard');
const rows = lb.data.leaderboard;
check('leaderboard includes our player', rows.some((r) => r.id === id));
const odds = rows.filter((r) => r.bestOdds !== null).map((r) => r.bestOdds);
check('leaderboard ranked rarest-first', odds.every((v, i) => i === 0 || odds[i - 1] >= v), JSON.stringify(odds));

const after = world.data.feed[0]?.id;
const inc = await req('GET', `/api/feed?after=${after || ''}`);
check('incremental feed poll works', inc.status === 200 && Array.isArray(inc.data.feed));
check('incremental poll excludes seen entries', !inc.data.feed.some((e) => e.id === after));

// --- state + rename --------------------------------------------------------
const st = await req('GET', `/api/state?id=${id}`);
check('state returns profile + odds', st.data.profile?.id === id && Array.isArray(st.data.odds));
check('odds table covers every aura', st.data.odds.length === cat.data.auras.length);
check('no_such_player is 404', (await req('GET', '/api/state?id=nope')).status === 404);

const ren = await req('POST', '/api/rename', { id, name: 'Renamed' });
check('rename works', ren.data.profile.name === 'Renamed');

// --- persistence -----------------------------------------------------------
const fs = await import('node:fs');
const onDisk = JSON.parse(fs.readFileSync(new URL('../data/db.json', import.meta.url), 'utf8'));
check('database file contains the player', !!onDisk.players[id], 'player missing from db.json');
check('database persisted rolls', onDisk.players[id].totalRolls >= 14);
check('db.json is valid JSON', typeof onDisk.version === 'number');

// --- cleanup ---------------------------------------------------------------
const del = await req('POST', '/api/delete', { id });
check('delete account works', del.status === 200 && del.data.ok);
check('deleted account is gone', (await req('GET', `/api/state?id=${id}`)).status === 404);

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  console.log('  Failed:');
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
