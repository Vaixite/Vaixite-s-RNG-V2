// End-to-end test of the admin panel: the admins.json allowlist, hot reload,
// every admin action, and the moment the power is taken away again.
//
// It starts its OWN server on a throwaway database and a throwaway admins file,
// so it never touches data/db.json or the real admins.json.
//
// Run: node scripts/test-admin.js
//      PORT=4100 node scripts/test-admin.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'hunter2-hunter2';

const TMP_DB = path.join(ROOT, 'data', 'tmp-admin-test.json');
const TMP_ADMINS = path.join(ROOT, 'data', 'tmp-admins-test.json');
const TMP_LOG = path.join(ROOT, 'data', 'tmp-admin-server.log');

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, route, body, token) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + route, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, data, text };
}

// The allowlist is re-read on a timer, so a test that edits it has to wait out
// one reload cycle (the loader polls every 2 s).
const writeAdmins = (names) => fs.writeFileSync(TMP_ADMINS, JSON.stringify({ admins: names }, null, 2));
const RELOAD_MS = 2400;

function cleanup() {
  for (const f of [TMP_DB, `${TMP_DB}.backup`, TMP_ADMINS, TMP_LOG]) {
    try { fs.rmSync(f, { force: true }); } catch { /* gone already */ }
  }
}

cleanup();

// --- spawn a throwaway server ------------------------------------------------
// stdio goes to a log file, not a pipe: the child never needs to talk to us.
const logFd = fs.openSync(TMP_LOG, 'w');
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_FILE: TMP_DB,
    ADMINS_FILE: TMP_ADMINS,
  },
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  if (code !== 0 && code !== null) console.log(`  ! test server exited early with code ${code} — see ${TMP_LOG}`);
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (exited) return false;
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

let failed = false;
try {
  if (!(await waitForServer())) throw new Error(`test server never answered on ${BASE} (see ${TMP_LOG})`);

  console.log(`\n  Admin tests against ${BASE} (throwaway db + admins.json)\n`);

  // The file starts empty on purpose: nobody is an admin, so the very first
  // assertions prove the door is locked before anyone has a key.
  writeAdmins([]);
  await sleep(RELOAD_MS);

  const suffix = Date.now().toString(36);
  const boss = `Boss${suffix}`;
  const victim = `Grind${suffix}`;

  const madeBoss = await req('POST', '/api/auth/register', { username: boss, password: PASSWORD });
  const madeVictim = await req('POST', '/api/auth/register', { username: victim, password: PASSWORD });
  const bossToken = madeBoss.data?.token;
  const victimToken = madeVictim.data?.token;
  check('two accounts registered', !!bossToken && !!victimToken, JSON.stringify(madeBoss.data));

  // --- locked door -----------------------------------------------------------
  const denied = await req('GET', '/api/admin/state', null, bossToken);
  check('admin/state is 403 before the allowlist knows you', denied.status === 403 && denied.data?.error === 'not_admin', JSON.stringify(denied.data));

  const deniedGive = await req('POST', '/api/admin/give', { target: victim, money: 1e9 }, bossToken);
  check('admin/give is 403 for a civilian', deniedGive.status === 403 && deniedGive.data?.error === 'not_admin', JSON.stringify(deniedGive.data));

  const anon = await req('GET', '/api/admin/players');
  check('admin/players is 401 with no session', anon.status === 401, `got ${anon.status}`);

  const noPeek = await req('GET', '/api/me', null, victimToken);
  check('profile says isAdmin false', noPeek.status === 200 && noPeek.data?.profile?.isAdmin === false, JSON.stringify(noPeek.data?.profile?.isAdmin));

  // --- hand out the key ------------------------------------------------------
  writeAdmins([boss]);
  await sleep(RELOAD_MS);

  const nowAdmin = await req('GET', '/api/me', null, bossToken);
  check('isAdmin flips to true after admins.json is saved', nowAdmin.data?.profile?.isAdmin === true, JSON.stringify(nowAdmin.data?.profile?.isAdmin));

  const state = await req('GET', '/api/admin/state', null, bossToken);
  check('state answers for an admin', state.status === 200 && state.data?.ok === true, JSON.stringify(state.data));
  check('state lists the allowlist', (state.data?.admins || []).includes(boss), JSON.stringify(state.data?.admins));
  check('state points at the throwaway admins file', String(state.data?.adminsFile || '').includes('tmp-admins-test.json'), state.data?.adminsFile);
  check('state reports server stats', state.data?.server?.accounts >= 2 && typeof state.data?.server?.uptimeSec === 'number', JSON.stringify(state.data?.server));
  check('state has no biome override yet', !state.data?.biomeOverride);

  const players = await req('GET', '/api/admin/players', null, bossToken);
  const rows = players.data?.rows || [];
  check('players lists both accounts', rows.length >= 2, `got ${rows.length}`);
  const victimRow = rows.find((r) => r.name === victim);
  check('players row marks the civilian', victimRow && victimRow.isAdmin === false, JSON.stringify(victimRow));
  check('players row carries roll stats', victimRow && typeof victimRow.totalRolls === 'number' && typeof victimRow.luck === 'number');

  const one = await req('GET', `/api/admin/player?target=${encodeURIComponent(victim)}`, null, bossToken);
  check('player detail loads by username', one.status === 200 && one.data?.row?.name === victim, JSON.stringify(one.data));
  check('player detail has the editor fields', one.data?.row && one.data.row.levels && one.data.row.inventory && Array.isArray(one.data.row.gear), JSON.stringify(Object.keys(one.data?.row || {})));

  const ghost = await req('GET', '/api/admin/player?target=nobody-at-all', null, bossToken);
  check('unknown target is 404', ghost.status === 404 && ghost.data?.error === 'unknown_target', JSON.stringify(ghost.data));

  // Admin routes are an exact-match allowlist, so an action that was never
  // registered never reaches the dispatcher at all — it 404s like any other
  // unknown route instead of leaking what the panel can do.
  const bogus = await req('POST', '/api/admin/teleport_to_the_moon', { target: victim }, bossToken);
  check('unknown action is 404', bogus.status === 404 && ['not_found', 'unknown_action'].includes(bogus.data?.error), JSON.stringify(bogus.data));

  // --- give ------------------------------------------------------------------
  const gaveMoney = await req('POST', '/api/admin/give', { target: victim, money: 1e6, essence: 5000, ascendPoints: 7 }, bossToken);
  check('give adds money, essence and points', gaveMoney.data?.row?.money >= 1e6 && gaveMoney.data?.row?.essence >= 5000 && gaveMoney.data?.row?.ascendPoints >= 7, JSON.stringify(gaveMoney.data?.row));

  const gaveAura = await req('POST', '/api/admin/give', { target: victim, auras: { common: 5, transcendence: 2 } }, bossToken);
  check('give grants named auras', gaveAura.data?.row?.unique >= 2, JSON.stringify(gaveAura.data?.gave));

  const gaveItem = await req('POST', '/api/admin/give', { target: victim, items: { luckElixir: 3 } }, bossToken);
  check('give grants items', gaveItem.status === 200 && gaveItem.data?.ok === true, JSON.stringify(gaveItem.data));

  const gaveLevel = await req('POST', '/api/admin/give', { target: victim, levels: { luck: 4 } }, bossToken);
  check('give sets upgrade levels', gaveLevel.data?.ok === true, JSON.stringify(gaveLevel.data));

  const badAura = await req('POST', '/api/admin/give', { target: victim, auras: { not_an_aura: 1 } }, bossToken);
  check('give rejects an unknown aura id', badAura.status === 400 && badAura.data?.error === 'unknown_aura', JSON.stringify(badAura.data));

  const nothing = await req('POST', '/api/admin/give', { target: victim }, bossToken);
  check('give with nothing to give is refused', nothing.data?.error === 'nothing_to_give', JSON.stringify(nothing.data));

  const everyAura = await req('POST', '/api/admin/give', { target: victim, allAuras: 1 }, bossToken);
  check('give every aura fills the collection', everyAura.data?.row?.unique >= 40, `unique=${everyAura.data?.row?.unique}`);

  // --- potions ---------------------------------------------------------------
  const potion = await req('POST', '/api/admin/buff', { target: victim, add: 150000, rolls: 1 }, bossToken);
  check('buff grants a one-roll potion', potion.data?.granted?.type === 'nextRollLuck' && potion.data?.granted?.add === 150000, JSON.stringify(potion.data));
  check('the potion shows up as pending luck', potion.data?.profile?.stats?.nextRollLuck === 150000, JSON.stringify(potion.data?.profile?.stats));

  const rolled = await req('POST', '/api/roll', null, victimToken);
  check('the next roll spends the potion', rolled.status === 200 && rolled.data?.potionBoost === 150000, JSON.stringify({ s: rolled.status, p: rolled.data?.potionBoost, e: rolled.data?.error }));
  check('the roll reports the bottle ran dry', rolled.data?.potionsSpent === 1, JSON.stringify(rolled.data?.potionsSpent));

  const afterPotion = await req('GET', '/api/me', null, victimToken);
  check('no potion is left after the roll', afterPotion.data?.profile?.stats?.nextRollLuck === 0, JSON.stringify(afterPotion.data?.profile?.stats?.nextRollLuck));

  const timed = await req('POST', '/api/admin/buff', { target: victim, mult: 2, minutes: 30 }, bossToken);
  check('buff grants a timed elixir', timed.data?.granted?.type === 'luckBuff' && timed.data?.granted?.mult === 2, JSON.stringify(timed.data));
  const timedProfile = await req('GET', '/api/me', null, victimToken);
  check('the timed elixir is on the buff bar', (timedProfile.data?.profile?.buffs || []).some((b) => b.type === 'luckBuff' && b.mult === 2), JSON.stringify(timedProfile.data?.profile?.buffs));
  check('the timed elixir lifts luck', timedProfile.data?.profile?.stats?.luck >= 2, JSON.stringify(timedProfile.data?.profile?.stats?.luck));

  const emptyBuff = await req('POST', '/api/admin/buff', { target: victim }, bossToken);
  check('buff with nothing to grant is refused', emptyBuff.data?.error === 'nothing_to_grant', JSON.stringify(emptyBuff.data));

  // --- gear ------------------------------------------------------------------
  const catalog = await req('GET', '/api/catalog');
  const piece = catalog.data?.gear?.[0]?.id;
  const quality = catalog.data?.gearQualities?.[0]?.id;
  const forged = await req('POST', '/api/admin/gear', { target: victim, piece, quality }, bossToken);
  check('gear forges a piece onto the account', forged.data?.ok === true && forged.data?.granted?.pieceId === piece, JSON.stringify(forged.data));
  check('the forged piece is in their bag', forged.data?.row?.gear >= 1, JSON.stringify(forged.data?.row?.gear));

  const badPiece = await req('POST', '/api/admin/gear', { target: victim, piece: 'nope' }, bossToken);
  check('gear rejects an unknown piece', badPiece.status === 400 && badPiece.data?.error === 'unknown_gear_piece', JSON.stringify(badPiece.data));

  // --- set -------------------------------------------------------------------
  const setAbs = await req('POST', '/api/admin/set', { target: victim, essence: 12345, money: 999, totalRolls: 500 }, bossToken);
  check('set writes absolute values', setAbs.data?.row?.essence === 12345 && setAbs.data?.row?.money === 999 && setAbs.data?.row?.totalRolls === 500, JSON.stringify(setAbs.data?.row));

  const nodeId = catalog.data?.tree?.[0]?.id;
  const setTree = await req('POST', '/api/admin/set', { target: victim, tree: { [nodeId]: 1 } }, bossToken);
  check('set buys a tree node', setTree.data?.ok === true && setTree.data?.profile?.tree?.[nodeId] === 1, JSON.stringify(setTree.data?.changed));

  const badNode = await req('POST', '/api/admin/set', { target: victim, tree: { nope: 1 } }, bossToken);
  check('set rejects an unknown node', badNode.data?.error === 'unknown_node', JSON.stringify(badNode.data));

  const clash = await req('POST', '/api/admin/set', { target: victim, name: boss }, bossToken);
  check('rename refuses a taken username', clash.data?.error === 'name_taken', JSON.stringify(clash.data));

  const badName = await req('POST', '/api/admin/set', { target: victim, name: '<b>x</b>' }, bossToken);
  check('rename refuses an illegal username', badName.data?.error === 'bad_username', JSON.stringify(badName.data));

  const renamed = await req('POST', '/api/admin/set', { target: victim, name: `${victim}Jr` }, bossToken);
  check('rename works', renamed.data?.ok === true && renamed.data?.row?.name === `${victim}Jr`, JSON.stringify(renamed.data?.changed));
  const victimName = `${victim}Jr`;

  const luckOff = await req('POST', '/api/admin/set', { target: victimName, luckOff: true }, bossToken);
  check('luck can be switched off', luckOff.data?.row?.luckOff === true, JSON.stringify(luckOff.data?.changed));
  await req('POST', '/api/admin/set', { target: victimName, luckOff: false }, bossToken);

  const noChange = await req('POST', '/api/admin/set', { target: victimName }, bossToken);
  check('set with nothing to change is refused', noChange.data?.error === 'nothing_to_change', JSON.stringify(noChange.data));

  // --- world -----------------------------------------------------------------
  const biomeId = catalog.data?.biomes?.find((b) => b.id !== catalog.data?.biomes?.[0]?.id)?.id || catalog.data?.biomes?.[0]?.id;
  const forced = await req('POST', '/api/admin/biome', { biome: biomeId, minutes: 5 }, bossToken);
  check('biome can be forced', forced.data?.ok === true && forced.data?.biomeOverride?.id === biomeId, JSON.stringify(forced.data));
  check('the forced biome reports who did it', forced.data?.biomeOverride?.by === boss, JSON.stringify(forced.data?.biomeOverride));

  const world = await req('GET', '/api/world');
  check('every player sees the forced biome', world.data?.biome?.id === biomeId && world.data?.biome?.forced === true, JSON.stringify(world.data?.biome));

  const badBiome = await req('POST', '/api/admin/biome', { biome: 'nowhere' }, bossToken);
  check('an unknown biome is refused', badBiome.data?.error === 'unknown_biome', JSON.stringify(badBiome.data));

  const cleared = await req('POST', '/api/admin/biome', { biome: 'auto' }, bossToken);
  check('the rotation can be restored', cleared.data?.ok === true && cleared.data?.biomeOverride === null, JSON.stringify(cleared.data));
  const world2 = await req('GET', '/api/world');
  check('the world goes back to the rotation', world2.data?.biome?.forced !== true, JSON.stringify(world2.data?.biome));

  const announced = await req('POST', '/api/admin/announce', { text: 'Double biome weekend starts now' }, bossToken);
  check('announce posts to the feed', announced.data?.ok === true && announced.data?.entry?.announcement === true, JSON.stringify(announced.data));
  const feed = await req('GET', '/api/feed');
  const mine = (feed.data?.feed || []).find((e) => e.announcement);
  check('the announcement is in everyone’s feed', !!mine && mine.auraName === 'Double biome weekend starts now', JSON.stringify(mine));
  const emptyAnnounce = await req('POST', '/api/admin/announce', { text: '   ' }, bossToken);
  check('an empty announcement is refused', emptyAnnounce.data?.error === 'empty_announcement', JSON.stringify(emptyAnnounce.data));

  // --- audit -----------------------------------------------------------------
  const audited = await req('GET', '/api/admin/state', null, bossToken);
  const log = audited.data?.audit || [];
  check('the audit log recorded the session', log.length >= 10, `got ${log.length}`);
  check('every audit line names the admin', log.every((e) => e.by === boss), JSON.stringify(log.slice(0, 3)));
  check('the audit log is newest first', log[0]?.action === 'announce', JSON.stringify(log[0]));

  const saved = await req('POST', '/api/admin/save', {}, bossToken);
  check('the database can be saved on demand', saved.data?.ok === true && saved.data?.db?.writes >= 1, JSON.stringify(saved.data));

  // --- destructive actions ----------------------------------------------------
  const reset = await req('POST', '/api/admin/reset', { target: victimName, mode: 'progress' }, bossToken);
  check('reset progress wipes the run', reset.data?.row?.essence === 0 && reset.data?.row?.unique === 0 && reset.data?.row?.money === 0, JSON.stringify(reset.data?.row));

  const stillIn = await req('POST', '/api/auth/login', { username: victimName, password: PASSWORD });
  check('reset keeps the login working', stillIn.status === 200 && !!stillIn.data?.token, JSON.stringify(stillIn.data));
  const victimToken2 = stillIn.data?.token || victimToken;

  const selfDelete = await req('POST', '/api/admin/delete', { target: boss }, bossToken);
  check('an admin cannot delete themselves', selfDelete.data?.error === 'cannot_delete_self', JSON.stringify(selfDelete.data));

  const kicked = await req('POST', '/api/admin/kick', { target: victimName }, bossToken);
  check('kick reports the sessions it destroyed', kicked.data?.ok === true && kicked.data?.sessions >= 1, JSON.stringify(kicked.data));
  const afterKick = await req('GET', '/api/me', null, victimToken2);
  check('a kicked player is logged out', afterKick.status === 401, `got ${afterKick.status}`);

  const reAuth = await req('POST', '/api/auth/login', { username: victimName, password: PASSWORD });
  const victimToken3 = reAuth.data?.token;
  check('the kicked player can sign back in', reAuth.status === 200 && !!victimToken3, JSON.stringify(reAuth.data));

  const deleted = await req('POST', '/api/admin/delete', { target: victimName }, bossToken);
  check('delete removes the account', deleted.data?.ok === true && deleted.data?.deleted === victimRow?.id, JSON.stringify(deleted.data));
  const gone = await req('GET', '/api/me', null, victimToken3);
  check('a deleted account has no session left', gone.status === 401, `got ${gone.status}`);
  const playersAfter = await req('GET', '/api/admin/players', null, bossToken);
  check('the deleted account is off the list', !(playersAfter.data?.rows || []).some((r) => r.name === victimName), JSON.stringify((playersAfter.data?.rows || []).map((r) => r.name)));

  // --- taking the key back -----------------------------------------------------
  writeAdmins([]);
  await sleep(RELOAD_MS);
  const revoked = await req('GET', '/api/admin/state', null, bossToken);
  check('removing the name cuts the power on the next click', revoked.status === 403 && revoked.data?.error === 'not_admin', JSON.stringify(revoked.data));
  const stillPlaying = await req('GET', '/api/me', null, bossToken);
  check('the ex-admin can still play the game', stillPlaying.status === 200, `got ${stillPlaying.status}`);

  // --- persistence -------------------------------------------------------------
  const persisted = JSON.parse(fs.readFileSync(TMP_DB, 'utf8'));
  const bossSaved = Object.values(persisted.players).find((p) => p.name === boss);
  check('the admin account is a normal saved account', !!bossSaved && !!bossSaved.passwordHash, 'saved account lookup');
  check('the deleted account is gone from disk', !Object.values(persisted.players).some((p) => p.name === victimName));
  check('admins.json is never written by the server', fs.readFileSync(TMP_ADMINS, 'utf8').includes('"admins": []'));
} catch (err) {
  failed = true;
  console.error(`\n  ✖ test run failed: ${err && err.stack ? err.stack : err}\n`);
} finally {
  child.kill('SIGTERM');
  await sleep(250);
  if (!exited) child.kill('SIGKILL');
  try { fs.closeSync(logFd); } catch { /* already closed */ }
  cleanup();
}

console.log(`\n  ${pass} passed, ${fails.length} failed${failed ? ' (run aborted)' : ''}`);
if (fails.length) {
  console.log('\n  Failed:');
  for (const f of fails) console.log(`    - ${f}`);
}
process.exit(fails.length || failed ? 1 : 0);
