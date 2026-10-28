// ---------------------------------------------------------------------------
// THE ROLL
//
// Sequential rarest-first selection. We walk the pool from the rarest aura
// down and give each one a chance of 1 / effectiveOdds. Because every rarer
// aura has a vanishingly small chance, the resulting probability of landing
// aura i collapses to almost exactly 1 / effectiveOdds(i) — which is what
// makes "1 in N" read truthfully on screen, and why luck scales cleanly.
//
// All data (auras, biomes, breakthrough multiplier) comes from content/*.json
// via the loader — nothing is hardcoded here.
// ---------------------------------------------------------------------------

// Turn a base aura into the odds that actually apply right now.
export function effectiveOdds(aura, luck, biomeId, content) {
  const biome = content.biomeById[biomeId] || content.biomes[0];
  let odds = aura.odds;
  let isBT = false;

  if (aura.native) {
    if (aura.biome === biome.id) {
      odds = aura.odds / biome.luck; // at home: biome multiplier applies
    } else {
      odds = aura.odds * content.btMultiplier; // away: BREAKTHROUGH, far rarer
      isBT = true;
    }
  }

  odds /= Math.max(1, luck);
  // Never better than a guaranteed hit, or the loop above degenerates.
  return {
    odds: Math.max(1.0000001, odds),
    isBT,
    biomeLuck: aura.native && aura.biome === biome.id ? biome.luck : 1,
  };
}

export function rollOnce(rand, luck, biomeId, content) {
  for (const aura of content.auras) {
    const eff = effectiveOdds(aura, luck, biomeId, content);
    if (rand() < 1 / eff.odds) {
      return { auraId: aura.id, odds: eff.odds, isBT: eff.isBT, biomeLuck: eff.biomeLuck };
    }
  }
  const fallback = content.auras.at(-1); // the most common aura absorbs the rest
  return { auraId: fallback.id, odds: fallback.odds, isBT: false, biomeLuck: 1 };
}

export function rollMany(count, luck, biomeId, rand, content) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(rollOnce(rand, luck, biomeId, content));
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

// Full odds table for the bestiary, reflecting current luck + biome.
export function oddsTable(luck, biomeId, content) {
  return content.auras.map((aura) => {
    const eff = effectiveOdds(aura, luck, biomeId, content);
    return { id: aura.id, odds: eff.odds, isBT: eff.isBT };
  });
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
