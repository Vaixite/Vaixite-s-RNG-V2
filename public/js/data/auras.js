import { tierForOdds } from './rarity.js';

// ---------------------------------------------------------------------------
// THE AURA POOL  —  [id, name, odds (1 in N), color, fx]
// `odds` is the BASE rarity. The server turns it into an effective rarity
// using luck and the active biome before rolling.
// ---------------------------------------------------------------------------

const GLOBAL = [
  ['common',      'Common',        2,        '#b6c2cf', 'soft'],
  ['uncommon',    'Uncommon',      4,        '#8fe3a8', 'soft'],
  ['good',        'Good',          6,        '#7be0c4', 'soft'],
  ['natural',     'Natural',       8,        '#a6e07b', 'soft'],
  ['rare',        'Rare',          16,       '#5fb8ff', 'orbit'],
  ['divinus',     'Divinus',       32,       '#ffe98a', 'orbit'],
  ['crystallized','Crystallized',  64,       '#9fdcff', 'shard'],
  ['dizzy',       'Dizzy',         128,      '#ffb3f0', 'spin'],
  ['rage',        'Rage',          192,      '#ff5c5c', 'pulse'],
  ['topaz',       'Topaz',         256,      '#ffc24d', 'shard'],
  ['ruby',        'Ruby',          384,      '#ff2d55', 'shard'],
  ['forbidden',   'Forbidden',     512,      '#8b5cf6', 'pulse'],
  ['emerald',     'Emerald',       640,      '#2ee59f', 'shard'],
  ['gilded',      'Gilded',        768,      '#ffd700', 'orbit'],
  ['ink',         'Ink',           960,      '#6b7280', 'smoke'],
  ['jackpot',     'Jackpot',       1024,     '#fbbf24', 'burst'],
  ['sapphire',    'Sapphire',      1536,     '#3b82f6', 'shard'],
  ['aquamarine',  'Aquamarine',    2048,     '#22d3ee', 'wave'],
  ['wind',        'Wind',          3072,     '#a8f0ff', 'wave'],
  ['twilight',    'Twilight',      4096,     '#7c6cff', 'wave'],
  ['prowler',     'Prowler',       6144,     '#f97316', 'pulse'],
  ['clockwork',   'Clockwork',     8192,     '#d4a373', 'gear'],
  ['attorney',    'Attorney',      12288,    '#60a5fa', 'orbit'],
  ['nebula',      'Nebula',        16384,    '#e879f9', 'smoke'],
  ['verdict',     'Verdict',       24576,    '#f8fafc', 'burst'],
  ['aurora',      'Aurora',        32768,    '#5eead4', 'wave'],
  ['spectral',    'Spectral',      49152,    '#a5b4fc', 'smoke'],
  ['eclipse',     'Eclipse',       65536,    '#312e81', 'eclipse'],
  ['phantom',     'Phantom',       98304,    '#94a3b8', 'smoke'],
  ['genesis',     'Genesis',       131072,   '#fca5a5', 'burst'],
  ['apex',        'Apex',          196608,   '#f43f5e', 'burst'],
  ['singularity', 'Singularity',   262144,   '#a78bfa', 'eclipse'],
  ['voidwalker',  'Voidwalker',    393216,   '#6d28d9', 'eclipse'],
  ['chronos',     'Chronos',       524288,   '#fbbf24', 'gear'],
  ['apeiron',     'Apeiron',       786432,   '#22d3ee', 'eclipse'],
  ['empyrean',    'Empyrean',      1048576,  '#fef08a', 'burst'],
  ['seraph',      'Seraph',        2097152,  '#fdf2f8', 'halo'],
  ['oblivion',    'Oblivion',      4194304,  '#1e1b4b', 'eclipse'],
  ['aeon',        'Aeon',          8388608,  '#c084fc', 'halo'],
  ['infinity',    'Infinity',      16777216, '#67e8f9', 'halo'],
  ['primordium',  'Primordium',    33554432, '#f0abfc', 'halo'],
  ['absolute',    'Absolute',      67108864, '#ffffff', 'halo'],
  ['transcendence','Transcendence',134217728,'#ffffff', 'halo'],
];

// [id, name, odds, color, fx, biomeId]
const NATIVE = [
  ['lucid',     'Lucid',     3000,   '#c4a2ff', 'wave',  'dreamspace'],
  ['star',      '★',         100000, '#fff3b0', 'halo',  'dreamspace'],
  ['nightmare', 'Nightmare', 45000,  '#4c1d95', 'smoke', 'dreamspace'],
  ['fault',     'FAULT',     2500,   '#3dffc0', 'glitch','cyberspace'],
  ['glitched',  'GLITCH',    70000,  '#22ff88', 'glitch','cyberspace'],
  ['kromatik',  'KROMAT1K',  250000, '#00ffe1', 'glitch','cyberspace'],
  ['mirage',    'Mirage',    1800,   '#ffd27a', 'wave',  'sandstorm'],
  ['pharaoh',   'Pharaoh',   30000,  '#facc15', 'halo',  'sandstorm'],
  ['zephyr',    'Zephyr',    1200,   '#a8f0ff', 'wave',  'windy'],
  ['tempest',   'Tempest',   22000,  '#38bdf8', 'wave',  'windy'],
  ['leviathan', 'Leviathan', 8000,   '#1d4ed8', 'wave',  'abyss'],
  ['abyssal',   'Abyssal',   120000, '#0ea5e9', 'eclipse','abyss'],
  ['ember',     'Ember',     1400,   '#ff8a5c', 'pulse', 'volcanic'],
  ['inferno',   'Inferno',   35000,  '#ef4444', 'burst', 'volcanic'],
  ['null',      'NULL',      15000,  '#b06bff', 'eclipse','void'],
  ['entropy',   'Entropy',   300000, '#7c3aed', 'eclipse','void'],
  ['hallowed',  'Hallowed',  1600,   '#fff3b0', 'halo',  'heaven'],
  ['seraphic',  'Seraphic',  50000,  '#fde68a', 'halo',  'heaven'],
];

function build(row, native) {
  const [id, name, odds, color, fx, biome] = row;
  const tier = tierForOdds(odds);
  return {
    id,
    name,
    odds,
    color,
    fx,
    tier: tier.id,
    tierName: tier.name,
    tierColor: tier.color,
    tierGlow: tier.glow,
    biome: native ? biome : null,
    native: !!native,
  };
}

export const AURAS = [...GLOBAL.map((r) => build(r, false)), ...NATIVE.map((r) => build(r, true))]
  // Rarest first: the roll algorithm walks this list top-to-bottom.
  .sort((a, b) => b.odds - a.odds);

export const AURA_BY_ID = Object.fromEntries(AURAS.map((a) => [a.id, a]));
export const AURA_COUNT = AURAS.length;

// A native aura rolled outside its own biome. Odds are inflated so it stays a
// genuine trophy chase rather than an accident.
export function breakthroughOdds(aura) {
  return aura.odds * 12;
}
