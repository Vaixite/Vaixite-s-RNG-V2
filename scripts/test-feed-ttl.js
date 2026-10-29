// Feed expiry: the world feed is a ticker, so a roll leaves it once it is older
// than content/config.json → feedTtl.ms instead of waiting to be pushed out by
// the 60-entry cap.
//
// The rule lives in src/game.js (feedTtlMs / feedIsExpired / pruneFeed) and the
// client mirrors it in main.js, so these tests pin the rule itself — no server
// needed for that half — and then check the live feed agrees.
//
// Run: node scripts/test-feed-ttl.js      (server must be running: node server.js)
//      SKIP_HTTP=1 node scripts/test-feed-ttl.js
//      BASE=http://otherhost:3000 node scripts/test-feed-ttl.js
import { feedTtlMs, feedIsExpired, pruneFeed } from '../src/game.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}

const MIN = 60000;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const CFG = {
  feedTtl: { ms: 10 * MIN, keepAnnouncements: true },
  feedPin: {
    tiers: [
      { minOdds: 1000, holdMs: 2 * MIN },
      { minOdds: 1000000, holdMs: 60 * MIN },
    ],
  },
};
const at = (minsAgo) => NOW - minsAgo * MIN;

console.log('\n  feed expiry — the rule\n');

check('window read from config', feedTtlMs(CFG) === 10 * MIN);
check('no window means nothing ever expires', feedTtlMs({}) === 0 && feedTtlMs({ feedTtl: { ms: 0 } }) === 0);
check('a roll from a minute ago stays', !feedIsExpired(CFG, { at: at(1) }, NOW));
check('a roll from eleven minutes ago goes', feedIsExpired(CFG, { at: at(11) }, NOW));
check('still on the feed at exactly the window', !feedIsExpired(CFG, { at: at(10) }, NOW));
// The whole point of a pin: the feed is shouting about this row right now.
check('a pull holding its pin is exempt', !feedIsExpired(CFG, { at: at(30), odds: 2000000 }, NOW));
check('the same pull leaves once its pin lapses', feedIsExpired(CFG, { at: at(61), odds: 2000000 }, NOW));
check('an announcement is not a roll', !feedIsExpired(CFG, { at: at(90), announcement: true }, NOW));
const sweepAll = { ...CFG, feedTtl: { ms: 10 * MIN, keepAnnouncements: false } };
check('keepAnnouncements:false sweeps them too', feedIsExpired(sweepAll, { at: at(90), announcement: true }, NOW));
check('an entry with no timestamp is not kept forever', feedIsExpired(CFG, {}, NOW));

// --- pruneFeed: what it cuts, and that it says so -------------------------------

const mkFeed = () => [
  { id: 'pinned', at: at(30), odds: 2000000 },
  { id: 'announced', at: at(90), announcement: true },
  { id: 'stale', at: at(11) },
  { id: 'older', at: at(400) },
  { id: 'fresh', at: at(2) },
];
let dirtied = 0;
const ctx = {
  content: { config: CFG },
  db: { data: { feed: mkFeed() }, markDirty: () => dirtied++ },
};

check('prune cuts the aged ones', pruneFeed(ctx, NOW) === 2, `cut ${dirtied}`);
check('fresh, pinned and announced survive', ctx.db.data.feed.map((e) => e.id).join(',') === 'pinned,announced,fresh');
check('a prune marks the database dirty', dirtied === 1);
check('a second prune finds nothing', pruneFeed(ctx, NOW) === 0 && dirtied === 1);
check('an empty feed is not a write', pruneFeed({ content: { config: CFG }, db: { data: { feed: [] }, markDirty: () => dirtied++ } }, NOW) === 0 && dirtied === 1);
check(
  'expiry off means prune cuts nothing',
  pruneFeed({ content: { config: {} }, db: { data: { feed: mkFeed() }, markDirty: () => dirtied++ } }, NOW) === 0 && dirtied === 1
);

// --- the live server ------------------------------------------------------------

if (!process.env.SKIP_HTTP) {
  console.log(`\n  feed expiry — ${BASE}\n`);
  try {
    const cat = await (await fetch(`${BASE}/api/catalog`)).json();
    const ttl = Number(cat?.config?.feedTtl?.ms) || 0;
    check('catalog carries the window to the client', ttl > 0, `got ${ttl}`);

    const world = await (await fetch(`${BASE}/api/world`)).json();
    const feed = world.feed || [];
    // The rows still on it must all be inside the window — or still pinned,
    // which is the same exemption the unit tests above assert.
    const stale = feed.filter((e) => feedIsExpired(cat.config, e, Date.now()));
    check('nothing expired survives on the live feed', stale.length === 0, `${stale.length} stale rows`);
    check('every row carries a timestamp', feed.every((e) => Number(e.at) > 0));
  } catch (err) {
    fails.push('server reachable');
    console.log(`  ✖ server reachable — ${err.message}`);
  }
}

console.log(`\n  ${pass} passed, ${fails.length} failed${fails.length ? `: ${fails.join(', ')}` : ''}\n`);
process.exit(fails.length ? 1 : 0);
