// Achievements: content/achievements.json is the rulebook and src/achievements.js
// is the measuring stick. The two halves of the contract are tested separately —
// the engine against a synthetic player (fast, and it can build states a live
// account cannot reach on demand), then the running server over HTTP with a guest
// account, which never touches db.json.
//
// Run: node scripts/test-achievements.js      (server must be running: node server.js)
//      SKIP_HTTP=1 node scripts/test-achievements.js
//      BASE=http://otherhost:3000 node scripts/test-achievements.js
import {
  settleAchievements,
  achievementRows,
  achievementSummary,
  achievementValue,
  achievementPoints,
  meetsTarget,
  baseCounters,
  ACHIEVEMENT_METRIC_IDS,
} from '../src/achievements.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}

const TIERS = {
  bronze: { id: 'bronze', name: 'Bronze', points: 1 },
  gold: { id: 'gold', name: 'Gold', points: 8 },
};
const DEFS = [
  { id: 'first_roll', name: 'First Light', icon: '✨', desc: 'Roll your very first aura.', metric: 'rolls', target: 1, tier: 'bronze', reward: { money: 25 } },
  { id: 'find_5', name: "Collector's Case", icon: '📚', desc: 'Have 5 different auras at once.', metric: 'uniqueAuras', target: 5, tier: 'gold', reward: { money: 150, essence: 10 } },
  { id: 'fast_300', name: 'Quick Fingers', icon: '⚡', desc: 'Get your cooldown under 300 ms.', metric: 'cooldownMs', target: 300, tier: 'bronze' },
  { id: 'own_star', name: 'Caught A Star', icon: '⭐', desc: 'Roll the star.', metric: 'ownAura', ref: 'star', target: 1, tier: 'gold', points: 40 },
];
const content = { achievements: DEFS, achievementTierById: TIERS };

const player = (over = {}) => ({
  money: 0,
  essence: 0,
  lifetimeRolls: 0,
  inventory: {},
  counters: baseCounters(),
  biomesSeen: {},
  achievements: {},
  ...over,
});

console.log('\n  achievements — the engine\n');

// --- unlocking and paying --------------------------------------------------------

const p = player({ lifetimeRolls: 1 });
let out = settleAchievements(p, content, { luck: 1, cooldownMs: 1000 }, 1000);
check('the first roll unlocks its badge', out.unlocked.map((d) => d.id).join() === 'first_roll');
check('the reward is paid on the spot', p.money === 25, `money ${p.money}`);
check('the unlock is stamped with a time', p.achievements.first_roll === 1000);
check('the unlock carries its score', out.unlocked[0].points === 1);

out = settleAchievements(p, content, { luck: 1, cooldownMs: 1000 }, 2000);
check('a second settle in the same tick finds nothing', out.unlocked.length === 0 && p.money === 25);
settleAchievements(p, content, { luck: 1, cooldownMs: 1000 }, 3000);
check('and never pays twice', p.money === 25);

// --- monotonic: a number falling back down cannot take a badge back --------------

const p2 = player({ lifetimeRolls: 9, inventory: { a: { count: 1 }, b: { count: 1 }, c: { count: 1 }, d: { count: 1 }, e: { count: 1 } } });
settleAchievements(p2, content, {}, 10);
check('five auras in the bag unlocks the collector', !!p2.achievements.find_5);
const paid = p2.money;
p2.inventory = { a: { count: 1 } }; // sold the lot
settleAchievements(p2, content, {}, 20);
check('selling cannot take a badge back', !!p2.achievements.find_5);
check('and cannot pay it out again', p2.money === paid);

// --- smaller is better ------------------------------------------------------------

check('a 1,100 ms cooldown is not quick', !meetsTarget({ metric: 'cooldownMs', target: 300 }, 1100));
check('a 250 ms cooldown is', meetsTarget({ metric: 'cooldownMs', target: 300 }, 250));
// An unmeasured cooldown reads 0, and 0 ms is "unknown", not "instant".
check('an unmeasured cooldown wins nothing', !meetsTarget({ metric: 'cooldownMs', target: 300 }, 0));
check('a bigger number is better for everything else', meetsTarget({ metric: 'rolls', target: 5 }, 5));
check('a target of 0 can never be won', !meetsTarget({ metric: 'rolls', target: 0 }, 999));

// --- measuring ----------------------------------------------------------------------

check('an unknown metric reads 0', achievementValue({ metric: 'nonsense', target: 1 }, player(), {}) === 0);
check('a badge on an unknown metric never unlocks', settleAchievements(player({ lifetimeRolls: 99 }), { achievements: [{ id: 'x', metric: 'nonsense', target: 1, tier: 'bronze' }], achievementTierById: TIERS }, {}).unlocked.length === 0);
check('ownAura reads the bag', achievementValue({ metric: 'ownAura', ref: 'star', target: 1 }, player({ inventory: { star: { count: 1 } } }), {}) === 1);
check('and reads 0 for a stranger', achievementValue({ metric: 'ownAura', ref: 'star', target: 1 }, player(), {}) === 0);
check('lifetime counters read the tally', achievementValue({ metric: 'moneyEarned', target: 1 }, player({ counters: { ...baseCounters(), moneyEarned: 4200 } }), {}) === 4200);
check('luck comes from the derived stats', achievementValue({ metric: 'luck', target: 1 }, player(), { luck: 12.5 }) === 12.5);

// --- score ---------------------------------------------------------------------------

check('a badge takes its tier score', achievementPoints({ tier: 'gold' }, TIERS.gold) === 8);
check('unless it sets its own', achievementPoints({ tier: 'gold', points: 40 }, TIERS.gold) === 40);
check('an unknown tier is worth nothing', achievementPoints({ tier: 'prism' }, undefined) === 0);

// --- the board -------------------------------------------------------------------------

const p3 = player({ lifetimeRolls: 3, inventory: { a: { count: 1 }, b: { count: 1 } }, achievements: { first_roll: 1 } });
const rows = achievementRows(p3, content, { luck: 1, cooldownMs: 1200 });
check('one row per definition', rows.length === DEFS.length);
const rollsRow = rows.find((r) => r.id === 'first_roll');
const bagRow = rows.find((r) => r.id === 'find_5');
const fastRow = rows.find((r) => r.id === 'fast_300');
check('a won badge reads done', rollsRow.done === true && rollsRow.at === 1);
check('progress is a fraction of the target', bagRow.pct === 0.4, `pct ${bagRow.pct}`);
check('a won bar never reads past full', rollsRow.pct === 1 && rollsRow.value === 1);
check('a smaller-is-better bar closes from the other side', fastRow.pct === 0.25, `pct ${fastRow.pct}`);
check('and prints the honest number beside it', fastRow.raw === 1200 && fastRow.below === true);
check('every row carries what the client draws', rows.every((r) => r.name && r.icon && r.desc && r.tier && r.fmt && r.points > 0 && r.target > 0));

const sum = achievementSummary(p3, content);
check('the header counts what is owned', sum.unlocked === 1 && sum.total === DEFS.length);
check('and adds up the score', sum.points === 1 && sum.pointsTotal === 1 + 8 + 1 + 40, `${sum.points}/${sum.pointsTotal}`);

// --- the shape of a fresh account -------------------------------------------------------

const fresh = player();
check('a new player starts with the tallies in place', Object.keys(fresh.counters).length > 0 && fresh.counters.ores && typeof fresh.counters.ores === 'object');
check('and nothing unlocked', Object.keys(fresh.achievements).length === 0);

// --- the running server -------------------------------------------------------------------

if (!process.env.SKIP_HTTP) {
  console.log(`\n  achievements — ${BASE}\n`);
  const req = async (method, path, body, token) => {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const cat = (await req('GET', '/api/catalog')).data;
  check('the catalog ships the definitions', (cat?.achievements?.length || 0) > 40, `got ${cat?.achievements?.length}`);
  check('and the tiers, weakest first', cat?.achievementTiers?.length === 4);
  check('and a score total worth chasing', (cat?.achievementPointsTotal || 0) > 100, `got ${cat?.achievementPointsTotal}`);
  check('every definition names a real tier', cat.achievements.every((a) => cat.achievementTiers.some((t) => t.id === a.tier)));
  check('every definition names a metric the engine knows', cat.achievements.every((a) => ACHIEVEMENT_METRIC_IDS.includes(a.metric)),
    cat.achievements.filter((a) => !ACHIEVEMENT_METRIC_IDS.includes(a.metric)).map((a) => `${a.id}:${a.metric}`).join(', '));
  check('ids are unique', new Set(cat.achievements.map((a) => a.id)).size === cat.achievements.length);

  check('the board needs a session', (await req('GET', '/api/achievements')).status === 401);

  // A guest lives in memory only, so none of this touches db.json.
  const { data: guest } = await req('POST', '/api/auth/guest');
  const token = guest.token;
  check('a new account has nothing unlocked yet', guest.profile.achievements && Object.keys(guest.profile.achievements).length === 0);

  const board0 = (await req('GET', '/api/achievements', null, token)).data;
  check('the board answers with one row per badge', board0.rows.length === cat.achievements.length);
  check('and a fresh account has won nothing', board0.unlocked === 0 && board0.points === 0);

  const rolled = (await req('POST', '/api/roll', {}, token)).data;
  check('the first roll unlocks First Light', !!rolled.profile.achievements.first_roll);
  check('and its reward is already in the money', rolled.profile.money >= 25, `money ${rolled.profile.money}`);

  const a = (await req('GET', '/api/me', null, token)).data.profile;
  const b = (await req('GET', '/api/me', null, token)).data.profile;
  check('reading the profile never pays a badge twice', a.money === b.money && Object.keys(a.achievements).length === Object.keys(b.achievements).length);

  const board = (await req('GET', '/api/achievements', null, token)).data;
  const rollsRow = board.rows.find((r) => r.metric === 'rolls');
  const fastRow = board.rows.find((r) => r.metric === 'cooldownMs');
  check('the board measures the roll that just happened', rollsRow.done === true && rollsRow.raw >= 1);
  check('a smaller-is-better row reads the real cooldown', fastRow.below === true && fastRow.raw > 0 && fastRow.pct > 0 && fastRow.pct <= 1);
  check('the header agrees with the rows', board.unlocked === board.rows.filter((r) => r.done).length);
  check('and so does the score', board.points === board.rows.reduce((s, r) => s + (r.done ? r.points : 0), 0));

  const owned = (await req('GET', '/api/leaderboard?sort=ach', null, token)).data;
  check('the leaderboard can rank by badges', (owned.sorts || []).some((s) => s.id === 'ach'));
  check('rows carry the score', owned.rows.every((r) => typeof r.achPoints === 'number'));
  check('and the badge count', owned.rows.every((r) => typeof r.achUnlocked === 'number'));

  await req('POST', '/api/auth/logout', {}, token);
}

console.log(`\n  ${pass} passed, ${fails.length} failed${fails.length ? `: ${fails.join(', ')}` : ''}\n`);
process.exit(fails.length ? 1 : 0);
