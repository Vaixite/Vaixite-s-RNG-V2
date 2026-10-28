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
  leaderboard,
  publicProfile,
  allPlayers,
  cleanName,
} from './game.js';
import { effectiveOdds } from './roll.js';

const MAX_BODY = 64 * 1024;

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
    biome: currentBiome(content),
    feed: db.data.feed.slice(0, 25),
    leaderboard: leaderboard(ctx),
    totalRolls: db.data.meta.totalRolls,
    online: Object.values(allPlayers(ctx)).filter((p) => Date.now() - (p.lastSeenAt || 0) < 120000).length,
    playerCount: Object.keys(allPlayers(ctx)).length,
  };
}

// Odds table for the bestiary, computed with this player's luck + biome.
function oddsFor(ctx, luck) {
  const biome = currentBiome(ctx.content);
  return ctx.content.auras.map((a) => {
    const eff = effectiveOdds(a, luck || 1, biome.id, ctx.content);
    return { id: a.id, odds: eff.odds, isBT: eff.isBT };
  });
}

// The full tunable dataset. Read-only: content files live on the host machine
// and no HTTP route can write them — only the server owner can edit the game.
function catalog(ctx) {
  const c = ctx.content;
  return {
    auras: c.auras,
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
    config: {
      guestPrefix: c.config.guestPrefix,
      nameMin: c.config.nameMin,
      nameMax: c.config.nameMax,
      passwordMin: c.config.passwordMin,
    },
  };
}

export async function handleApi(req, res, url, ctx) {
  const route = `${req.method} ${url.pathname}`;

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

    if (route === 'GET /api/leaderboard') {
      return send(res, 200, { leaderboard: leaderboard(ctx) });
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

    const token = bearer(req);
    const player = resolveSession(ctx, token);

    if (route === 'POST /api/auth/logout') {
      if (token) destroySession(ctx, token);
      return send(res, 200, { ok: true });
    }

    if (!player) return send(res, 401, { error: 'unauthorized' });

    if (route === 'GET /api/me') {
      const profile = publicProfile(player, ctx);
      return send(res, 200, { profile, odds: oddsFor(ctx, profile.stats.luck), ...world(ctx) });
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

    if (route === 'POST /api/shop/buy') {
      const body = await readBody(req);
      const out = buyItem(ctx, player, body.itemId);
      if (out.error) return send(res, 400, out);
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
