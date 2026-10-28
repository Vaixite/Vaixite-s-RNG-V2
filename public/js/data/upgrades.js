// ---------------------------------------------------------------------------
// UPGRADE ECONOMY
// Essence is earned per roll (rarer aura = more essence). Spending it here is
// the only way to raise luck, which is what bends the 1-in-N odds in your
// favour. `max: 0` means unlimited levels.
// ---------------------------------------------------------------------------

export const UPGRADES = [
  {
    id: 'luck',
    name: 'Fortune',
    icon: '🍀',
    desc: '+25% Luck per level. Lowers the effective rarity of every aura.',
    baseCost: 50,
    growth: 1.55,
    max: 0,
  },
  {
    id: 'quickroll',
    name: 'Quick Roll',
    icon: '⚡',
    desc: 'Shortens the cooldown between rolls.',
    baseCost: 120,
    growth: 1.9,
    max: 12,
  },
  {
    id: 'multiroll',
    name: 'Multi Roll',
    icon: '🎲',
    desc: '+1 aura per roll. Rolls independently at full odds.',
    baseCost: 900,
    growth: 3.4,
    max: 8,
  },
  {
    id: 'autoroll',
    name: 'Auto Roll',
    icon: '🤖',
    desc: 'Rolls by itself, even while the tab is in the background.',
    baseCost: 2500,
    growth: 2.6,
    max: 10,
  },
  {
    id: 'essence',
    name: 'Essence Tap',
    icon: '💠',
    desc: '+35% Essence gained from every roll.',
    baseCost: 400,
    growth: 1.75,
    max: 0,
  },
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

export function upgradeCost(def, level) {
  return Math.floor(def.baseCost * Math.pow(def.growth, level));
}

// Ascending resets levels + essence and grants a permanent luck multiplier.
export function ascendRequirement(ascensions) {
  return Math.floor(25 * Math.pow(6, ascensions));
}

export function ascendMultiplier(ascensions) {
  return 1 + ascensions * 0.75;
}

// Derived stats. Kept pure so the client can preview costs and the server can
// validate against the exact same numbers.
export function deriveStats(profile) {
  const lv = profile.levels || {};
  const luckLevel = lv.luck || 0;
  const essenceLevel = lv.essence || 0;

  const luck = (1 + luckLevel * 0.25) * ascendMultiplier(profile.ascensions || 0);
  const cooldownMs = Math.max(120, 1100 * Math.pow(0.87, lv.quickroll || 0));
  const rollsPerAction = 1 + (lv.multiroll || 0);
  const autoPerSec = lv.autoroll || 0;
  const essenceMult = 1 + essenceLevel * 0.35;

  return {
    luck,
    cooldownMs,
    rollsPerAction,
    autoPerSec,
    essenceMult,
    luckLevel,
    ascendMult: ascendMultiplier(profile.ascensions || 0),
  };
}
