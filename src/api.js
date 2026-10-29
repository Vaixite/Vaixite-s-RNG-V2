import {
  newAccount,
  loginAccount,
  newGuest,
  createSession,
  resolveSession,
  destroySession,
  destroyPlayerSessions,
  currentBiome,
  rollForPlayer,
  buyUpgrade,
  ascendForPlayer,
  sellAura,
  craftRecipe,
  buyItem,
  useItem,
  feedSince,
  worldFeed,
  leaderboard,
  leaderboardBoard,
  equipGear,
  unequipGear,
  salvageGear,
  buyTreeNode,
  mineReveal,
  mineReset,
  mineAutoTick,
  clickTap,
  clickAutoTick,
  buyClickerUpgrade,
  setLuckEnabled,
  achievementsView,
  publicProfile,
  allPlayers,
  cleanName,
} from './game.js';
import { oddsTable } from './roll.js';
import { adminHandle } from './admin.js';
import { isAdmin } from './admins.js';

const MAX_BODY = 64 * 1024;

// Routes that require a valid session token. Anything under /api/ that is not
// matched at all is a plain 404 — an unknown URL must not answer 401 and hint
// that a route exists.
const PROTECTED_ROUTES = new Set([
  'GET /api/me',
  'GET /api/achievements',
  'POST /api/rename',
  'POST /api/roll',
  'POST /api/upgrade',
  'POST /api/ascend',
  'POST /api/sell',
  'POST /api/craft',
  'POST /api/shop/buy',
  'POST /api/item/use',
  'POST /api/gear/equip',
  'POST /api/gear/unequip',
  'POST /api/gear/salvage',
  'POST /api/tree/buy',
  'POST /api/mine/reveal',
  'POST /api/mine/reset',
  'POST /api/mine/auto',
  'POST /api/click/tap',
  'POST /api/click/auto',
  'POST /api/click/buy',
  'POST /api/luck',
  'POST /api/delete',
  // Admin panel. Being on the list is checked again inside the dispatch —
  // these entries only stop an anonymous caller from learning the routes exist.
  'GET /api/admin/state',
  'GET /api/admin/players',
  'GET /api/admin/player',
  'POST /api/admin/give',
  'POST /api/admin/set',
  'POST /api/admin/buff',
  'POST /api/admin/gear',
  'POST /api/admin/reset',
  'POST /api/admin/kick',
  'POST /api/admin/delete',
  'POST /api/admin/biome',
  'POST /api/admin/announce',
  'POST /api/admin/save',
]);

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Shared world state every client agrees on.
function world(ctx) {
  const { db, content } = ctx;
  return {
    biome: currentBiome(content, Date.now(), ctx.mem?.biomeOverride),
    feed: worldFeed(ctx),
    leaderboard: leaderboard(ctx),
    totalRolls: db.data.meta.totalRolls,
    online: Object.values(allPlayers(ctx)).filter((p) => Date.now() - (p.lastSeenAt || 0) < 120000).length,
    playerCount: Object.keys(allPlayers(ctx)).length,
  };
}

// Odds table for the bestiary, computed with this player's luck + biome.
function oddsFor(ctx, luck) {
  return oddsTable(luck || 1, currentBiome(ctx.content, Date.now(), ctx.mem?.biomeOverride).id, ctx.content);
}

// The full tunable dataset. Read-only: content files live on the host machine
// and no HTTP route can write them — only the server owner can edit the game.
function catalog(ctx) {
  const c = ctx.content;
  return {
    auras: c.auras,
    // The Special Auras shelf: craft-only auras, never in the roll pool. The
    // bestiary draws two sections from these — "Auras" from `auras`, "Special
    // Auras" from here plus any owned id the host has since deleted.
    specialAuras: c.specialAuras,
    allAuras: c.allAuras,
    biomes: c.biomes,
    rotateMs: c.rotateMs,
    btMultiplier: c.btMultiplier,
    upgrades: c.upgrades,
    ascend: c.ascend,
    rarityTiers: c.rarityTiers,
    cutsceneTierIndex: c.cutsceneTierIndex,
    items: c.items,
    recipes: c.recipes,
    sell: c.sell,
    // Equipment definitions: the client draws the craft result ("2–4 random
    // buffs, quality rolled at the forge") and the gear bag from these.
    gear: c.gear,
    gearSlots: c.gearSlots,
    gearQualities: c.gearQualities.map((q) => ({
      id: q.id,
      name: q.name,
      color: q.color,
      buffs: q.buffs,
    })),
    gearBuffTypes: c.gearBuffTypes,
    gearSalvage: c.gearSalvage,
    // Ascend tree + mining: the client draws both entirely from these.
    tree: c.treeNodes,
    treeEffectTypes: c.treeEffectTypes,
    mining: c.mining,
    miningOres: c.miningOres,
    // The Spark Clicker — currency, crit rules, pacing and the whole upgrade
    // shop come from content/clicker.json, so the client can draw the entire
    // minigame without a line of code per upgrade.
    clicker: c.clicker,
    clickerUpgrades: c.clickerUpgrades,
    clickerEffectTypes: c.clickerEffectTypes,
    // Achievements: the definitions only. What a given player has measured
    // towards each one is theirs alone and comes from GET /api/achievements —
    // the catalog is shared, and the roll response has no room for 50 bars.
    achievements: c.achievements,
    achievementTiers: c.achievementTiers,
    achievementPointsTotal: c.achievementPointsTotal,
    config: {
      guestPrefix: c.config.guestPrefix,
      nameMin: c.config.nameMin,
      nameMax: c.config.nameMax,
      passwordMin: c.config.passwordMin,
      feedPin: c.config.feedPin,
      // The client mirrors the pin windows to keep an open page honest as they
      // expire, so it needs the same expiry rule the server prunes with.
      feedTtl: c.config.feedTtl,
      feedTierBg: c.config.feedTierBg,
      freeAutoRoll: c.config.freeAutoRoll,
      quickRoll: c.config.quickRoll,
    },
  };
}

export async function handleApi(req, res, url, ctx) {
  const route = `${req.method} ${url.pathname}`;
  // Read early: the public board wants to know who is asking so it can report
  // their rank, without turning the route into a protected one.
  const token = bearer(req);

  try {
    // ---- public ------------------------------------------------------------

    if (route === 'GET /api/health') {
      return send(res, 200, { ok: true, uptime: process.uptime(), db: ctx.db.stats });
    }

    if (route === 'GET /api/catalog') {
      return send(res, 200, catalog(ctx));
    }

    if (route === 'GET /api/world') {
      return send(res, 200, world(ctx));
    }

    // The board is public. `?sort=` picks the column (rarest pull by default)
    // and a signed-in caller also gets their own rank back, so the UI can show
    // "you are #47" underneath the top slice instead of hiding it.
    if (route === 'GET /api/leaderboard') {
      const viewer = token ? resolveSession(ctx, token) : null;
      const board = leaderboardBoard(ctx, {
        sort: url.searchParams.get('sort') || 'best',
        limit: Number(url.searchParams.get('limit')) || 25,
        viewerId: viewer ? viewer.id : null,
      });
      // `leaderboard` stays as the plain array — older clients and world() use it.
      return send(res, 200, { leaderboard: board.rows, ...board });
    }

    if (route === 'GET /api/feed') {
      return send(res, 200, { feed: feedSince(ctx, url.searchParams.get('after')) });
    }

    // ---- auth ---------------------------------------------------------------

    if (route === 'POST /api/auth/register') {
      const body = await readBody(req);
      const out = newAccount(ctx, body.username, body.password);
      if (out.error === 'bad_username') return send(res, 400, { error: 'bad_username' });
      if (out.error === 'weak_password')
        return send(res, 400, { error: 'weak_password', min: ctx.content.config.passwordMin });
      if (out.error === 'name_taken') return send(res, 409, { error: 'name_taken' });
      const token = createSession(ctx, out.player);
      return send(res, 201, { token, profile: publicProfile(out.player, ctx) });
    }

    if (route === 'POST /api/auth/login') {
      const cfg = ctx.content.config;
      const ip = req.socket.remoteAddress || 'unknown';
      if (!ctx.rateLimit(`login:${ip}`, cfg.loginRate?.max ?? 10, cfg.loginRate?.windowMs ?? 60000)) {
        return send(res, 429, { error: 'too_many_attempts' });
      }
      const body = await readBody(req);
      const out = loginAccount(ctx, body.username, body.password);
      if (out.error) return send(res, 401, { error: 'bad_credentials' });
      const token = createSession(ctx, out.player);
      return send(res, 200, { token, profile: publicProfile(out.player, ctx) });
    }

    if (route === 'POST /api/auth/guest') {
      const { player } = newGuest(ctx);
      const token = createSession(ctx, player);
      return send(res, 201, { token, profile: publicProfile(player, ctx) });
    }

    // ---- everything below requires a valid session ----------------------------

    if (route === 'POST /api/auth/logout') {
      if (token) destroySession(ctx, token);
      return send(res, 200, { ok: true });
    }

    // Unknown route → 404 before we say anything about authentication.
    if (!PROTECTED_ROUTES.has(route)) return send(res, 404, { error: 'not_found', route });

    const player = resolveSession(ctx, token);
    if (!player) return send(res, 401, { error: 'unauthorized' });

    // ---- admin panel ----------------------------------------------------------
    // The allowlist is re-read on every call, so taking a name out of
    // admins.json revokes the panel mid-click. Guests are never on it.
    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(ctx, player)) return send(res, 403, { error: 'not_admin' });
      const action = decodeURIComponent(url.pathname.slice('/api/admin/'.length));
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = adminHandle(ctx, player, action, body, Object.fromEntries(url.searchParams));
      if (out.error) return send(res, out.status || 400, out);
      return send(res, 200, out);
    }

    if (route === 'GET /api/me') {
      const profile = publicProfile(player, ctx);
      // With luck switched off the rolls use the authored table, so the odds
      // table shown to this player must be the 1× one too.
      return send(res, 200, { profile, odds: oddsFor(ctx, player.luckOff ? 1 : profile.stats.luck), ...world(ctx) });
    }

    // The full badge board, measured for this player. Fetched on demand for the
    // same reason the leaderboard is: a tab you open, not a number you watch,
    // and measuring every definition is work worth keeping out of the roll path.
    if (route === 'GET /api/achievements') {
      return send(res, 200, achievementsView(ctx, player));
    }

    if (route === 'POST /api/rename') {
      const body = await readBody(req);
      const name = cleanName(body.name, ctx.content.config);
      if (!name) return send(res, 400, { error: 'name_required' });
      const taken = Object.values(allPlayers(ctx)).some(
        (p) => p.id !== player.id && p.name.toLowerCase() === name.toLowerCase()
      );
      if (taken) return send(res, 409, { error: 'name_taken' });
      player.name = name;
      ctx.db.markDirty();
      return send(res, 200, { profile: publicProfile(player, ctx) });
    }

    if (route === 'POST /api/roll') {
      const body = await readBody(req);
      const out = rollForPlayer(ctx, player, body.count);
      if (out.error === 'cooldown') return send(res, 429, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/upgrade') {
      const body = await readBody(req);
      const out = buyUpgrade(ctx, player, body.upgradeId);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/ascend') {
      const out = ascendForPlayer(ctx, player);
      if (out.error) return send(res, 400, out);
      ctx.db.save();
      return send(res, 200, out);
    }

    if (route === 'POST /api/sell') {
      const body = await readBody(req);
      const out = sellAura(ctx, player, body.auraId, body.count);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/craft') {
      const body = await readBody(req);
      const out = craftRecipe(ctx, player, body.recipeId);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    // Equipment. Every piece is a unique rolled instance, so these take a uid
    // and not a count — and every one of them hands back a fresh profile,
    // because equipping a glove changes luck, cooldown and sale price at once.
    if (route === 'POST /api/gear/equip') {
      const body = await readBody(req);
      const out = equipGear(ctx, player, body.uid);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/gear/unequip') {
      const body = await readBody(req);
      const out = unequipGear(ctx, player, body.uid);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/gear/salvage') {
      const body = await readBody(req);
      const out = salvageGear(ctx, player, body.uid);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/shop/buy') {
      const body = await readBody(req);
      const out = buyItem(ctx, player, body.itemId);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    // Ascend tree: permanent upgrades bought with Ascend Points.
    if (route === 'POST /api/tree/buy') {
      const body = await readBody(req);
      const out = buyTreeNode(ctx, player, body.nodeId);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    // Mining shaft: reveal one cell of the current vein, or dig a new one.
    if (route === 'POST /api/mine/reveal') {
      const body = await readBody(req);
      const out = mineReveal(ctx, player, body.cell);
      if (out.error) return send(res, out.error === 'cooldown' ? 429 : 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/mine/reset') {
      const out = mineReset(ctx, player);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    // The Automated Drill: banked real time turned into picks. Calling it more
    // often than the drill can dig earns nothing, so an empty tick is a normal
    // answer and not an error — 409 is reserved for "you have no drill".
    if (route === 'POST /api/mine/auto') {
      const out = mineAutoTick(ctx, player);
      if (out.error) return send(res, out.error === 'no_auto' ? 409 : 400, out);
      return send(res, 200, out);
    }

    // Spark Clicker: one click, the idle tick, and the upgrade shop. All three
    // are defined by content/clicker.json — the routes never mention an upgrade.
    if (route === 'POST /api/click/tap') {
      const out = clickTap(ctx, player);
      if (out.error) return send(res, out.error === 'cooldown' ? 429 : 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/click/auto') {
      const out = clickAutoTick(ctx, player);
      if (out.error) return send(res, out.error === 'no_auto' ? 409 : 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/click/buy') {
      const body = await readBody(req);
      const out = buyClickerUpgrade(ctx, player, body.upgradeId);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    // Per-player luck switch (rolls use the base table while disabled).
    if (route === 'POST /api/luck') {
      const body = await readBody(req);
      const out = setLuckEnabled(ctx, player, body.on !== false);
      return send(res, 200, out);
    }

    if (route === 'POST /api/item/use') {
      const body = await readBody(req);
      const out = useItem(ctx, player, body.itemId);
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }

    if (route === 'POST /api/delete') {
      destroyPlayerSessions(ctx, player.id);
      if (player.guest) {
        delete ctx.mem.guests[player.id];
      } else {
        delete ctx.db.data.players[player.id];
        ctx.db.save();
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not_found', route });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
}
