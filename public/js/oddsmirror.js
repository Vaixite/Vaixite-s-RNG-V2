// Client-side mirror of buildPool() in src/roll.js.
//
// The server sends an authoritative odds table at login and on world refreshes,
// but luck moves between those polls — potions, buffs, gear, a biome hop — and
// the bestiary, the dossier and the roll roulette all need current numbers on
// the frame they draw them. So the pool maths lives twice, and this file is the
// second copy: pure arithmetic, no DOM, no catalog import, so a test can run it
// against the real thing (scripts/test-odds-mirror.js).
//
// The rules that matter, in one place:
//   · Luck floor — an aura whose authored odds sit below your luck is out of
//     reach entirely, and shows as Infinity / share 0.
//   · Luck bends by rarity (luck^luckExp), biome natives get their biome's
//     multiplier at home and the breakthrough penalty away from it.
//   · Only the authored balancer absorbs the remainder to 100%. With it floored
//     out the survivors are scaled to 100% in proportion — never let the aura
//     at the floor absorb, or it swallows the whole pool.
//
// If you change any of that here, change src/roll.js too. The parity test fails
// loudly when the two drift.

export const MIN_BALANCER_SHARE = 0.005;
export const LUCK_LEAD = 1.15;

/**
 * @param {object} src
 * @param {Array}  src.auras        catalog.auras: needs odds, share, luckExp,
 *                                  isBalancer, native, biome
 * @param {number} src.luck         already floored to >= 1 (pass 1 when the
 *                                  player switched luck off)
 * @param {object} src.biome        the biome being stood in: { id, luck }
 * @param {number} src.btMultiplier catalog.btMultiplier
 * @returns {object} aura id → { id, odds, share, isBT }, for every aura passed
 *                   in, floored ones included (odds Infinity, share 0)
 */
export function mirrorOdds({ auras, luck = 1, biome, btMultiplier = 12 }) {
  const out = {};
  if (!auras || !auras.length || !biome) return out;

  const mult = Math.max(1, Number(luck) || 1);
  const luckLog = Math.log(mult);

  let eligible = auras.filter((a) => a.odds >= mult);
  if (!eligible.length) eligible = [auras[0]]; // auras arrive rarest first
  const inPool = new Set(eligible.map((a) => a.id));
  for (const aura of auras) {
    if (!inPool.has(aura.id)) out[aura.id] = { id: aura.id, odds: Infinity, share: 0, isBT: false };
  }

  const entries = eligible.map((aura) => {
    const joker = aura.isBalancer === true;
    let w = aura.share ?? 1 / aura.odds;
    let isBT = false;
    // The joker is the shock absorber, so luck and biomes only bend the others.
    if (!joker && aura.native) {
      if (aura.biome === biome.id) w *= biome.luck;
      else { w /= btMultiplier; isBT = true; }
    }
    if (!joker && luckLog > 0) w *= Math.exp(luckLog * (aura.luckExp ?? 1));
    return { aura, w, isBT, joker };
  });

  const joker = entries.find((e) => e.joker)
    || entries.reduce((m, e) => (e.aura.odds < m.aura.odds ? e : m), entries[0]);
  joker.joker = true;

  if (joker.aura.isBalancer) {
    let others = 0;
    let leader = 0;
    for (const e of entries) {
      if (e === joker) continue;
      others += e.w;
      if (e.w > leader) leader = e.w;
    }
    // Two floors: the balancer never starves, and never ends up rarer than the
    // aura behind it. The rest is squeezed by one factor, which keeps the
    // luck-bent ratios intact so luck keeps paying off instead of saturating.
    const lead = others > 0 ? (LUCK_LEAD * leader) / others : 0;
    const floor = Math.max(MIN_BALANCER_SHARE, lead / (1 + lead));
    if (1 - others < floor) {
      const k = (1 - floor) / others;
      for (const e of entries) if (e !== joker) e.w *= k;
      others = 1 - floor;
    }
    joker.w = Math.max(1e-9, 1 - others);
  } else {
    const sum = entries.reduce((s, e) => s + e.w, 0);
    if (sum > 0) for (const e of entries) e.w /= sum;
  }

  for (const e of entries) {
    out[e.aura.id] = {
      id: e.aura.id,
      // Only the authored balancer keeps its declared 1-in-N.
      odds: e.joker && e.aura.isBalancer ? e.aura.odds : 1 / e.w,
      share: e.w,
      isBT: e.isBT,
    };
  }
  return out;
}
