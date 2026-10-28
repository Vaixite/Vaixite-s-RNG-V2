// Biomes rotate server-wide (shared world state, like Sol's RNG biomes).
// `luck` multiplies the odds of every aura NATIVE to that biome while it is
// active. A native aura rolled while its biome is NOT active is a
// BREAKTHROUGH and is BT_MULTIPLIER times rarer.
export const BIOME_ROTATE_MS = 90000;
export const BT_MULTIPLIER = 12;

export const BIOMES = [
  { id: 'normal',     name: 'THE PLAINS',  luck: 1,   color: '#8fd3ff', desc: 'No biome active. Standard odds apply.',        sky: ['#0d1220', '#161d33'] },
  { id: 'dreamspace', name: 'DREAMSPACE',  luck: 2,   color: '#c4a2ff', desc: 'Dream-native auras are 2x more likely.',        sky: ['#1a103d', '#3b1e6e'] },
  { id: 'cyberspace', name: 'CYBERSPACE',  luck: 3,   color: '#3dffc0', desc: 'Corrupted data flows. 3x on native auras.',     sky: ['#021a16', '#053f33'] },
  { id: 'sandstorm',  name: 'SANDSTORM',   luck: 2.5, color: '#ffd27a', desc: 'Dunes shift the odds. 2.5x on native auras.',   sky: ['#2a1c07', '#6b4712'] },
  { id: 'windy',      name: 'THE Gales',   luck: 2,   color: '#a8f0ff', desc: 'High winds carry luck. 2x on native auras.',    sky: ['#0a2027', '#14535e'] },
  { id: 'abyss',      name: 'THE ABYSS',   luck: 3,   color: '#5b8cff', desc: 'Crushing depth. 3x on native auras.',           sky: ['#01060f', '#041a3d'] },
  { id: 'volcanic',   name: 'EMBERFALL',   luck: 2.5, color: '#ff8a5c', desc: 'Magma fuels the roll. 2.5x on native auras.',   sky: ['#280802', '#6b1d07'] },
  { id: 'void',       name: 'THE VOID',    luck: 4,   color: '#b06bff', desc: 'Reality thins out. 4x on native auras.',        sky: ['#0a0212', '#2a0a45'] },
  { id: 'heaven',     name: 'HEAVEN',      luck: 2,   color: '#fff3b0', desc: 'Blessed air. 2x on native auras.',              sky: ['#1d2540', '#5b6ea8'] },
];

export const BIOME_BY_ID = Object.fromEntries(BIOMES.map((b) => [b.id, b]));

export function getBiome(id) {
  return BIOME_BY_ID[id] || BIOMES[0];
}
