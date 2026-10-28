// Rarity tiers, modelled on Sol's RNG: the tier is derived purely from the
// "1 in N" odds of an aura, never stored per-aura. Keep ranges contiguous.
export const RARITY_TIERS = [
  { id: 'common',      name: 'COMMON',      min: 1,          max: 15,          color: '#b6c2cf', glow: '#7d8894' },
  { id: 'uncommon',    name: 'UNCOMMON',    min: 16,         max: 99,          color: '#6ee7a0', glow: '#22c55e' },
  { id: 'rare',        name: 'RARE',        min: 100,        max: 499,         color: '#5fb8ff', glow: '#2563eb' },
  { id: 'epic',        name: 'EPIC',        min: 500,        max: 999,         color: '#c084fc', glow: '#9333ea' },
  { id: 'legendary',   name: 'LEGENDARY',   min: 1000,       max: 9999,        color: '#fbd24a', glow: '#f59e0b' },
  { id: 'mythic',      name: 'MYTHIC',      min: 10000,      max: 99999,       color: '#fb7185', glow: '#e11d48' },
  { id: 'exalted',     name: 'EXALTED',     min: 100000,     max: 999999,      color: '#22d3ee', glow: '#0891b2' },
  { id: 'celestial',   name: 'CELESTIAL',   min: 1000000,    max: 9999999,     color: '#f0abfc', glow: '#c026d3' },
  { id: 'divine',      name: 'DIVINE',      min: 10000000,   max: 99999999,    color: '#fde68a', glow: '#facc15' },
  { id: 'transcendent',name: 'TRANSCENDENT',min: 100000000,  max: Infinity,    color: '#ffffff', glow: '#f472b6' },
];

// Tiers at or above this index play the big screen-filling cutscene.
export const CUTSCENE_TIER_INDEX = 3; // EPIC and above

export function tierForOdds(odds) {
  for (const tier of RARITY_TIERS) {
    if (odds >= tier.min && odds <= tier.max) return tier;
  }
  return RARITY_TIERS[RARITY_TIERS.length - 1];
}

export function tierIndex(tierId) {
  return RARITY_TIERS.findIndex((t) => t.id === tierId);
}

// "1 in 1,234,567" with compact suffixes for the absurd ones.
export function formatOdds(odds) {
  if (odds < 100000) return `1/${odds.toLocaleString('en-US')}`;
  return `1/${compact(odds)}`;
}

export function compact(n) {
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function trim(x) {
  return x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
