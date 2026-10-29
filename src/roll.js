// ---------------------------------------------------------------------------
// THE ROLL
//
// Weighted selection over a pool that always adds up to exactly 100%.
//
// The odds in content/auras.json are TARGETS: 1/odds is the share of all rolls
// an aura should take. A hand-written table never sums to exactly 100%, so the
// most common aura is the joker — it absorbs whatever the rest leaves over or
// short. Overflow makes it rarer, shortfall makes it more common, and the pool
// lands on 100% either way.
//
// A roll is then one uniform number walked against the cumulative shares, so
// every "1 in N" in the game is literally true instead of approximately true.
//
// Two numbers per aura, on purpose:
//   aura.odds  — what the host typed. Never rewritten. Drives every display
//                and economy path (bestiary, reveal, sell price, essence), so
//                "common" stays a clean 1 in 2 on screen.
//   aura.share — the corrected probability the engine actually rolls with.
//
// Biome multipliers and breakthrough bend shares directly and the joker
// re-absorbs the difference, so the pool is 100% in every context. Once the
// luck floor has removed the joker there is nothing left to absorb, and the
// survivors are rescaled to 100% in proportion instead.
//
// Luck bends by rarity: every aura gains luck^luckExp, where luckExp runs from
// 0 on the most common aura to 1 on the rarest. At luck 1 that is a no-op and
// the table is exactly as authored; above it the rare end gains ground. A flat
// multiplier would be a lie — the joker can only shrink to its floor, so past
// a low ceiling extra luck would change nothing at all.
// ---------------------------------------------------------------------------

// The joker never drops below this share. Without a floor, a table whose rare
// auras alone sum past 100% would give the most common aura negative odds.
export const MIN_BALANCER_SHARE = 0.005;

// How much more common the joker stays than the aura in second place. Luck
// pulls the rare end up; this is the point where it stops, so the ladder never
// flips and "common" never becomes the rarest thing on the board.
export const LUCK_LEAD = 1.15;

/**
 * Turn authored aura rows into rollable ones by making the most common aura
 * absorb the difference to 100%.
 *
 * Pure: returns copies, so the parsed JSON is never mutated and the content
 * files are never touched. `odds` keeps the authored value; `share` is what the
 * roll uses.
 *
 * @param {Array<{id:string,odds:number}>} rows authored rows, in file order
 * @param {number} [minShare] floor for the joker's share
 * @returns {{auras: Array, report: object}}
 */
export function normalizePool(rows, minShare = MIN_BALANCER_SHARE) {
  const list = rows.map((r) => ({ ...r }));
  if (!list.length) return { auras: list, report: null };

  // The joker is the most common aura: lowest odds, first declared wins a tie.
  let joker = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].odds < list[joker].odds) joker = i;
  }

  const authored = list.map((r) => r.odds);
  const rawSum = authored.reduce((s, o) => s + 1 / o, 0);

  let others = 0;
  for (let i = 0; i < list.length; i++) if (i !== joker) others += 1 / authored[i];

  // The rare auras alone already fill the pool. Squeeze them proportionally so
  // the joker keeps a sliver of a chance instead of the maths going negative.
  let squeezed = 0;
  if (others > 1 - minShare) {
    squeezed = others;
    const k = (1 - minShare) / others;
    for (let i = 0; i < list.length; i++) if (i !== joker) list[i].odds = authored[i] / k;
    others = 1 - minShare;
  }

  const share = 1 - others;
  list.forEach((r, i) => {
    r.declaredOdds = authored[i];
    r.isBalancer = i === joker;
    r.share = i === joker ? share : 1 / list[i].odds;
  });

  return {
    auras: list,
    report: {
      balancerId: list[joker].id,
      balancerName: list[joker].name || list[joker].id,
      authoredOdds: authored[joker],
      effectiveOdds: 1 / share,
      share,
      rawSum,
      squeezed,
      count: list.length,
    },
  };
}

/**
 * The pool as it rolls right now: base shares bent by luck, biome multipliers
 * and breakthrough, with the joker re-absorbing so the weights sum to 1.
 *
 * The luck floor: luck multiplies the RNG. An aura whose authored odds are
 * below your luck is no longer reachable at all — at 4× luck the 1/2 Common is
 * gone and 1/4 Uncommon is the floor of what you can roll. Everything the floor
 * removes is redistributed proportionally over what remains, so the pool is
 * still exactly 100% at every luck level and the ladder keeps its shape: at
 * 50k luck the 1/70,000 rolls about as often as the 1/65,000 beside it, only
 * scaled by luck.
 *
 * Note what that sentence replaces. The authored balancer absorbs the
 * difference to 100%; nothing else may. Once the floor has eaten "Common",
 * handing the leftover to whatever aura happens to sit just above the floor
 * makes that one aura swallow the pool — 94% of every roll at 50k luck on the
 * shipped table, with the rare end left fighting over the crumbs. Absorbing is
 * the balancer's job precisely because its authored share was written to be
 * whatever the rest leaves over.
 */
export function buildPool(luck, biomeId, content) {
  const biome = content.biomeById[biomeId] || content.biomes[0];
  const mult = Math.max(1, Number(luck) || 1);
  const luckLog = Math.log(mult);

  // Luck floor — drop everything the player has out-leveled. If luck somehow
  // passes the rarest aura, the rarest aura is all that is left (and rolls).
  let eligible = content.auras.filter((a) => a.odds >= mult);
  if (!eligible.length) eligible = [content.auras[0]];

  const entries = eligible.map((aura) => {
    const joker = aura.isBalancer === true;
    let w = aura.share ?? 1 / aura.odds;
    let isBT = false;
    let biomeLuck = 1;

    // The joker is the shock absorber, so luck and biomes only bend the others.
    if (!joker && aura.native) {
      if (aura.biome === biome.id) {
        w *= biome.luck; // at home: the biome multiplier applies
        biomeLuck = biome.luck;
      } else {
        w /= content.btMultiplier; // away: BREAKTHROUGH, far rarer
        isBT = true;
      }
    }
    if (!joker && luckLog > 0) w *= Math.exp(luckLog * (aura.luckExp ?? 1));

    return { aura, w, isBT, biomeLuck, joker };
  });

  // The joker is the marked balancer whenever the luck floor left it in. Once
  // luck has out-levelled even "Common" there is no authored balancer left, and
  // that is the case where absorbing has to stop: the aura sitting just above
  // the floor would otherwise inherit the entire remainder. On the shipped
  // ladder at 50k luck that is 94% of every roll landing on the 1/50,000 while
  // the 1/70,000 beside it barely exists — luck making the rare end *harder* to
  // reach, which is the opposite of what luck is for.
  //
  // So: the joker absorbs while it is the aura the table was balanced around.
  // Without it the survivors already describe the whole pool — their luck-bent
  // weights are scaled to 100% instead, which keeps every ratio intact and
  // keeps each 1-in-N the exact reciprocal of its share.
  const joker = entries.find((e) => e.joker)
    || entries.reduce((m, e) => (e.aura.odds < m.aura.odds ? e : m), entries[0]);
  joker.joker = true;
  const absorbs = joker.aura.isBalancer === true;

  let squeezed = 0;
  if (absorbs) {
    let others = 0;
    let leader = 0;
    for (const e of entries) {
      if (e === joker) continue;
      others += e.w;
      if (e.w > leader) leader = e.w;
    }

    // The joker absorbs the remainder, with two floors: it never starves below
    // MIN_BALANCER_SHARE, and it never becomes rarer than the aura behind it —
    // a table where "common" stops being common is broken, not lucky. Either way
    // the rest is squeezed by one factor, which keeps the luck-bent ratios intact
    // so luck keeps paying off instead of saturating.
    const lead = others > 0 ? (LUCK_LEAD * leader) / others : 0;
    const floor = Math.max(MIN_BALANCER_SHARE, lead / (1 + lead));
    if (1 - others < floor) {
      squeezed = others;
      const k = (1 - floor) / others;
      for (const e of entries) if (e !== joker) e.w *= k;
      others = 1 - floor;
    }
    joker.w = Math.max(1e-9, 1 - others);
  } else {
    const sum = entries.reduce((s, e) => s + e.w, 0);
    if (sum > 0) for (const e of entries) e.w /= sum;
  }

  // Cumulative bounds, so a roll is one subtraction walk.
  let acc = 0;
  for (const e of entries) {
    // Only the authored balancer keeps its declared 1-in-N; a fallback joker
    // (and everything else) shows the true contextual odds.
    e.odds = e.joker && e.aura.isBalancer ? e.aura.odds : 1 / e.w;
    acc += e.w;
    e.to = acc;
  }

  return { entries, joker, total: acc, biome, luck: mult, squeezed, absorbs };
}

/** One roll against a prepared pool. */
export function rollOnce(rand, pool) {
  const r = rand() * pool.total;
  for (const e of pool.entries) {
    if (r < e.to) return { auraId: e.aura.id, odds: e.odds, isBT: e.isBT, biomeLuck: e.biomeLuck };
  }
  const last = pool.entries[pool.entries.length - 1];
  return { auraId: last.aura.id, odds: last.odds, isBT: last.isBT, biomeLuck: last.biomeLuck };
}

export function rollMany(count, luck, biomeId, rand, content) {
  const pool = buildPool(luck, biomeId, content);
  const out = [];
  for (let i = 0; i < count; i++) out.push(rollOnce(rand, pool));
  return out;
}

// Rarest aura in a batch, used for cutscene gating + "best roll" bookkeeping.
export function bestOf(results) {
  return results.reduce((best, r) => (r.odds > (best ? best.odds : 0) ? r : best), null);
}

// Essence payout: logarithmic so a 1/2 roll still pays something but the
// jackpot stays exciting.
export function essenceFor(odds, essenceMult) {
  const base = 1 + Math.log10(Math.max(1, odds)) * 2.5;
  return Math.max(1, Math.round(base * essenceMult));
}

// Money payout for selling one copy of an aura. Configurable curve so the
// host can retune the whole economy from shop.json.
export function sellPrice(sellCfg, odds) {
  const raw =
    (sellCfg.coefficient ?? 10) * Math.pow(Math.log10(1 + Math.max(1, odds)), sellCfg.exponent ?? 2.5);
  return Math.max(sellCfg.min ?? 1, Math.round(raw));
}

// Full odds table for the bestiary, reflecting current luck + biome. The joker
// reports its authored odds — the correction stays in the engine.
export function oddsTable(luck, biomeId, content) {
  const pool = buildPool(luck, biomeId, content);
  return pool.entries.map((e) => ({
    id: e.aura.id,
    odds: e.odds,
    isBT: e.isBT,
    share: e.w,
  }));
}

// --- RNG sources -----------------------------------------------------------

// mulberry32: tiny, fast, seedable. Used by the test suite so odds can be
// verified against expected values deterministically.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
