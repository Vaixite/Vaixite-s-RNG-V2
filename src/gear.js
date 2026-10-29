// ---------------------------------------------------------------------------
// GEAR — craftable equipment.
//
// A gear *piece* (Luck Glove, Speed Gauntlet, …) is a definition that lives in
// content/crafting.json under "gear". Crafting one rolls 2..N buffs off that
// piece's buff table, scaled by the quality that came out of the forge, and the
// result is stored on the player as an *instance*. That indirection is the whole
// point of the module: two Luck Gloves are never the same glove, so gear cannot
// be a stack count like a consumable potion.
//
// Buff kinds (declared in content, one per buff type):
//   pct  — a bonus that is summed, then applied as (1 + total) on the stat
//   flat — added straight onto the stat (auras per roll, auto rolls per second)
//
// Nothing here touches the database or the content files; game.js owns storage,
// this file only does the maths so tests can roll gear with a seeded RNG.
// ---------------------------------------------------------------------------

// Safety net for a crafting.json that declares pieces but no buffTypes block.
export const DEFAULT_GEAR_BUFF_TYPES = {
  luck: { name: 'Luck', icon: '🍀', kind: 'pct' },
  cooldown: { name: 'Roll Speed', icon: '⚡', kind: 'pct' },
  essence: { name: 'Essence', icon: '💠', kind: 'pct' },
  sell: { name: 'Sale Price', icon: '💰', kind: 'pct' },
  rolls: { name: 'Auras per Roll', icon: '🎲', kind: 'flat' },
  auto: { name: 'Auto Rolls / s', icon: '🤖', kind: 'flat' },
};

// Stats a piece of gear can bend. Anything else is a content typo.
export const GEAR_STAT_AXES = ['luck', 'cooldown', 'essence', 'sell', 'rolls', 'auto'];

export function buffKind(type, buffTypes = DEFAULT_GEAR_BUFF_TYPES) {
  const t = buffTypes[type] || DEFAULT_GEAR_BUFF_TYPES[type];
  return t?.kind === 'flat' ? 'flat' : 'pct';
}

// Roll one buff value inside its declared band. `roll` on a buff definition
// shrinks the band from the top so a designer can keep the advertised maximum
// aspirational instead of guaranteed.
function rollValue(def, quality, rand, buffTypes) {
  const lo = Number(def.min) || 0;
  const hi = Math.max(lo, Number(def.max) ?? lo);
  const headroom = Math.min(1, Math.max(0.05, Number(def.roll) || 1));
  const t = Math.max(0, Math.min(0.999, rand() * headroom));
  const power = Number(quality?.power) || 1;
  const raw = (lo + (hi - lo) * t) * power;
  if (buffKind(def.type, buffTypes) === 'flat') return Math.max(1, Math.round(raw));
  return Math.round(raw * 1000) / 1000;
}

// How far into its band a rolled value sits, 0..1 — feeds salvage value.
function strengthOf(piece, buff) {
  const def = (piece?.buffs || []).find((b) => b.type === buff.type);
  if (!def) return 0.5;
  const lo = Number(def.min) || 0;
  const hi = Math.max(lo, Number(def.max) ?? lo);
  if (hi <= lo) return 0.5;
  return Math.max(0, Math.min(1, (buff.value - lo) / (hi - lo)));
}

// Roll a fresh instance of `piece` at `quality`.
// Returns { uid, pieceId, slot, quality, buffs:[{type,value}], craftedAt }.
export function rollGear(piece, quality, rand = Math.random, buffTypes = DEFAULT_GEAR_BUFF_TYPES) {
  const forced = piece.buffs.filter((b) => b.signature);
  const rest = piece.buffs.filter((b) => !b.signature);
  const minB = Math.max(1, Number(quality?.buffs?.min) || 1);
  const maxB = Math.max(minB, Number(quality?.buffs?.max) || minB);
  const want = Math.min(piece.buffs.length, minB + Math.floor(rand() * (maxB - minB + 1)));

  const picked = forced.slice(0, want);
  while (picked.length < want && rest.length) {
    picked.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
  }

  const buffs = picked.map((def) => ({
    type: def.type,
    value: rollValue(def, quality, rand, buffTypes),
    signature: !!def.signature,
  }));
  // Signature buff first, then strongest — the card reads top-down.
  buffs.sort((a, b) => (b.signature - a.signature) || (b.value - a.value));

  return {
    uid: Math.random().toString(36).slice(2, 10),
    pieceId: piece.id,
    slot: piece.slot,
    quality: quality?.id || 'fine',
    buffs,
    craftedAt: Date.now(),
  };
}

// Weighted pick over a { qualityId: weight } map, e.g. { worn: 30, fine: 48, … }.
// Deterministic under a seeded rand so a craft can be reproduced in tests.
export function pickQuality(weights, rand = Math.random) {
  const entries = Object.entries(weights || {}).filter(([, w]) => Number(w) > 0);
  if (!entries.length) return null;
  const total = entries.reduce((sum, [, w]) => sum + Number(w), 0);
  let t = rand() * total;
  for (const [id, w] of entries) {
    t -= Number(w);
    if (t <= 0) return id;
  }
  return entries[entries.length - 1][0];
}

// Money you get back for scrapping it. Better quality, more buffs and hotter
// rolls are all worth more, so salvage is a real choice and not free money.
export function gearValue(piece, inst, quality, cfg = {}) {
  const base = Number(cfg.base) || 250;
  const qvalue = Number(quality?.value) || 1;
  let strength = 0;
  for (const b of inst.buffs || []) strength += strengthOf(piece, b);
  strength /= Math.max(1, (inst.buffs || []).length);
  const breadth = 0.7 + 0.22 * (inst.buffs || []).length;
  return Math.max(1, Math.round(base * qvalue * breadth * (0.72 + 0.55 * strength)));
}

// Sum the buffs of everything the player has equipped, per stat axis.
// pct buffs add into one bonus (so a glove and a ring both feed "luck"),
// flat buffs add onto the flat axis.
export function aggregateGear(player, content) {
  const total = { luck: 0, cooldown: 0, essence: 0, sell: 0, rolls: 0, auto: 0 };
  const equipped = player?.equipped || {};
  const gear = player?.gear || [];
  const byUid = Object.fromEntries(gear.map((g) => [g.uid, g]));
  for (const uid of Object.values(equipped)) {
    const inst = byUid[uid];
    if (!inst) continue;
    for (const b of inst.buffs || []) {
      if (!(b.type in total)) continue;
      total[b.type] += Number(b.value) || 0;
    }
  }
  for (const k of GEAR_STAT_AXES) total[k] = Math.round((total[k] || 0) * 1000) / 1000;
  return total;
}

// "+18% luck" / "+2 auras per roll" — one place so the tooltip, the buff strip
// and the gear card never disagree about how a number is worded.
export function buffLabel(type, value, buffTypes = DEFAULT_GEAR_BUFF_TYPES) {
  const t = buffTypes[type] || DEFAULT_GEAR_BUFF_TYPES[type] || { name: type, icon: '✦' };
  if (buffKind(type, buffTypes) === 'flat') return `+${value} ${t.name}`;
  return `+${Math.round(value * 1000) / 10}% ${t.name}`;
}

// Everything the client needs to draw one owned piece of gear.
export function gearView(player, content) {
  const gear = player?.gear || [];
  const equipped = player?.equipped || {};
  const equippedUids = new Set(Object.values(equipped));
  const buffTypes = content?.gearBuffTypes || DEFAULT_GEAR_BUFF_TYPES;
  return gear.map((inst) => {
    const piece = content?.gearById?.[inst.pieceId] || { name: inst.pieceId, icon: '❔', buffs: [] };
    const quality = content?.gearQualityById?.[inst.quality] || { id: inst.quality, name: inst.quality, color: '#8b95ad' };
    return {
      uid: inst.uid,
      pieceId: inst.pieceId,
      name: piece.name,
      icon: piece.icon,
      desc: piece.desc || '',
      slot: inst.slot || piece.slot,
      quality: { id: quality.id, name: quality.name, color: quality.color },
      equipped: equippedUids.has(inst.uid),
      equippedIn: Object.keys(equipped).find((s) => equipped[s] === inst.uid) || null,
      craftedAt: inst.craftedAt || 0,
      value: gearValue(piece, inst, quality, content?.gearSalvage),
      buffs: (inst.buffs || []).map((b) => ({
        type: b.type,
        value: b.value,
        signature: !!b.signature,
        label: buffLabel(b.type, b.value, buffTypes),
        icon: (buffTypes[b.type] || DEFAULT_GEAR_BUFF_TYPES[b.type] || {}).icon || '✦',
      })),
    };
  });
}
