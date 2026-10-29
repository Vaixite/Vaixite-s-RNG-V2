// ---------------------------------------------------------------------------
// Renders the gear bag, the crafting cards and the leaderboard with the real
// client modules and a tiny DOM shim — no server, no browser.
//
// The point is the multi-buff promise: a Luck Glove is one card showing every
// buff *that* glove rolled, with Equip/Unequip/Salvage wired to the right uid.
// A blank page or a card that only ever shows the signature buff is exactly the
// bug this catches.
//
// Run: node scripts/test-gear-ui.js
// ---------------------------------------------------------------------------

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentLoader } from '../src/content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// --- DOM shim ----------------------------------------------------------------
class Style {
  constructor() { this._custom = new Map(); }
  setProperty(k, v) { this._custom.set(k, String(v)); }
  removeProperty(k) { this._custom.delete(k); }
  getPropertyValue(k) { return this._custom.get(k) || ''; }
}

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = String(tag) === '#text' ? 3 : 1;
    this.children = [];
    this.style = new Style();
    this.dataset = {};
    this.attrs = {};
    this._class = new Set();
    this._text = '';
    this.value = '';
    this.classList = {
      add: (...c) => c.forEach((x) => this._class.add(x)),
      remove: (...c) => c.forEach((x) => this._class.delete(x)),
      toggle: (c, force) => (force ? this._class.add(c) : this._class.delete(c)),
      contains: (c) => this._class.has(c),
    };
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  set innerHTML(v) { this._text = v; this.children = []; }
  get innerHTML() { return this._text; }
  append(...n) {
    for (const x of n) {
      if (x == null || x === false) continue;
      const node = typeof x === 'string' ? Object.assign(new El('#text'), { textContent: x }) : x;
      node._parent = this;
      this.children.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); if (n) n._parent = null; return n; }
  remove() { this._parent?.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this._listeners ??= {})[t] = [...(this._listeners?.[t] || []), fn]; }
  dispatch(type) {
    const results = [];
    for (let node = this; node; node = node._parent) {
      for (const f of node._listeners?.[type] || []) results.push(f({ target: this, preventDefault() {} }));
    }
    return Promise.all(results);
  }
  focus() {}
  select() {}
  insertAdjacentHTML() {}
  matches() { return false; }
  closest() { return null; }
  querySelector() { return new El('div'); }
  querySelectorAll() { return []; }
}

const doc = {
  hidden: false,
  body: new El('body'),
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createTextNode: (t) => Object.assign(new El('#text'), { textContent: t }),
  querySelector: () => new El('div'),
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// The client modules read the catalog singleton, so fill it with exactly what
// /api/catalog would send — built from the same content/*.json the server uses.
const { setCatalog, catalog } = await import('../public/js/catalog.js');
const { renderGear, renderCrafting, renderLeaderboard } = await import('../public/js/views.js');
const content = createContentLoader(path.join(ROOT, 'content')).get();

setCatalog({
  auras: content.auras,
  biomes: content.biomes,
  rotateMs: content.rotateMs,
  btMultiplier: content.btMultiplier,
  upgrades: content.upgrades,
  ascend: content.ascend,
  rarityTiers: content.rarityTiers,
  cutsceneTierIndex: content.cutsceneTierIndex,
  items: content.items,
  recipes: content.recipes,
  sell: content.sell,
  gear: content.gear,
  gearSlots: content.gearSlots,
  gearQualities: content.gearQualities.map((q) => ({ id: q.id, name: q.name, color: q.color, buffs: q.buffs })),
  gearBuffTypes: content.gearBuffTypes,
  gearSalvage: content.gearSalvage,
  config: content.config,
});

// --- helpers -----------------------------------------------------------------
let pass = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fails.push(name); console.log(`  ✖ ${name} ${extra}`); }
}
const findAll = (node, cls, out = []) => {
  for (const c of node.children || []) {
    if (String(c.className).includes(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
};
const findButton = (node, text) => {
  let found = null;
  (function walk(n) {
    for (const c of n.children || []) {
      walk(c);
      if (!found && String(c.textContent).includes(text)) found = c;
    }
  })(node);
  return found;
};
const text = (node) => String(node.textContent);

// --- fake player ---------------------------------------------------------------
const glove = {
  uid: 'glove1', pieceId: 'luck_glove', name: 'Luck Glove', icon: '🧤', desc: 'Topaz thread.',
  slot: 'hands', quality: { id: 'radiant', name: 'Radiant', color: '#60a5fa' },
  equipped: true, equippedIn: 'hands', craftedAt: Date.now(), value: 4200,
  buffs: [
    { type: 'luck', value: 0.24, signature: true, label: '+24% Luck', icon: '🍀' },
    { type: 'essence', value: 0.12, signature: false, label: '+12% Essence', icon: '💠' },
    { type: 'sell', value: 0.08, signature: false, label: '+8% Sale Price', icon: '💰' },
  ],
};
const ring = {
  uid: 'ring1', pieceId: 'gilded_ring', name: 'Gilded Ring', icon: '💍', desc: 'A merchant habit.',
  slot: 'trinket', quality: { id: 'mythic', name: 'Mythic', color: '#c084fc' },
  equipped: false, equippedIn: null, craftedAt: Date.now(), value: 9100,
  buffs: [
    { type: 'sell', value: 0.41, signature: true, label: '+41% Sale Price', icon: '💰' },
    { type: 'luck', value: 0.15, signature: false, label: '+15% Luck', icon: '🍀' },
  ],
};

const calls = [];
const actions = {
  craft: (id) => calls.push(['craft', id]),
  equipGear: (uid) => calls.push(['equip', uid]),
  unequipGear: (uid) => calls.push(['unequip', uid]),
  salvageGear: (g) => calls.push(['salvage', g.uid]),
  refreshBoard: () => calls.push(['refresh']),
  lbSort: (id) => calls.push(['sort', id]),
};

const state = {
  catalog: null, // filled by the getters below, mirroring main.js
  get auraById() { return Object.fromEntries(content.auras.map((a) => [a.id, a])); },
  profile: {
    id: 'me', name: 'Me', guest: false, money: 1200, essence: 40, totalRolls: 900,
    ascensions: 1, levels: {}, inventory: {}, items: {},
    gear: [glove, ring], equipped: { hands: 'glove1' }, buffs: [],
    stats: { luck: 2.4, cooldownMs: 900, rollsPerAction: 1, autoPerSec: 0, essenceMult: 1.12, sellMult: 1.24, gear: { luck: 0.24, essence: 0.12, sell: 0.08 } },
  },
  board: null,
};
// `catalog` is a const singleton mutated in place by setCatalog(), so the
// imported binding is already live — no dynamic import needed here.
Object.defineProperty(state, 'catalog', { get: () => catalog });

// --- 1. the gear bag ------------------------------------------------------------
console.log('\n  gear bag\n');
const root = new El('div');
renderGear(root, state, actions);

const cards = findAll(root, 'gear-card');
check('one card per owned piece', cards.length === 2, `got ${cards.length}`);
check('worn piece is marked', cards.some((c) => c.classList.contains('is-worn')));
check('slot strip lists every slot', findAll(root, 'slot').filter((s) => text(s) === 'empty').length === 3,
  `${findAll(root, 'slot').length} slot nodes`);
check('worn slot shows the piece name', text(root).includes('Luck Glove'));

const gloveCard = cards.find((c) => text(c).includes('Luck Glove'));
// findAll matches on className, so it can never find an <li> — count the
// list's own children by tag instead.
const buffList = findAll(gloveCard, 'gc-buffs')[0];
check('buffs render as a list element', buffList?.tagName === 'UL', buffList?.tagName);
check('a glove shows every buff it rolled', buffList.children.filter((c) => c.tagName === 'LI').length === 3,
  `got ${buffList.children.filter((c) => c.tagName === 'LI').length}`);
check('buff labels are the rolled ones', ['+24% Luck', '+12% Essence', '+8% Sale Price'].every((l) => text(gloveCard).includes(l)),
  text(gloveCard));
check('the signature buff is flagged', text(gloveCard).includes('★'));
check('quality is on the card', text(gloveCard).includes('Radiant'));
// fmt() keeps two decimals below 10K, so 4200 reads "4.20K".
check('salvage value is on the card', text(gloveCard).includes('4.20K'), text(gloveCard));

// The bag puts what you are wearing first, then ranks by quality.
check('the worn piece sorts to the front of the bag', cards[0] === gloveCard);
const bareRoot = new El('div');
renderGear(
  bareRoot,
  {
    ...state,
    profile: {
      ...state.profile,
      gear: [glove, ring].map((g) => ({ ...g, equipped: false, equippedIn: null })),
      equipped: {},
    },
  },
  actions
);
const ranked = findAll(bareRoot, 'gear-card');
check('mythic ring sorts above a radiant glove', text(ranked[0]).includes('Gilded Ring'), text(ranked[0]));
const ringCard = cards.find((c) => text(c).includes('Gilded Ring'));
check('unequipped piece offers Equip', !!findButton(ringCard, 'Equip'));
check('worn piece offers Unequip', !!findButton(gloveCard, 'Unequip'));
check('set bonus chips add up across slots', ['+24% Luck', '+12% Essence', '+8% Sale Price'].every((l) => text(root).includes(l)));

await findButton(ringCard, 'Equip').dispatch('click');
check('Equip calls through with the right uid', JSON.stringify(calls.at(-1)) === '["equip","ring1"]', JSON.stringify(calls.at(-1)));
await findButton(gloveCard, 'Unequip').dispatch('click');
check('Unequip calls through with the right uid', JSON.stringify(calls.at(-1)) === '["unequip","glove1"]', JSON.stringify(calls.at(-1)));
await findButton(ringCard, 'Salvage').dispatch('click');
check('Salvage calls through with the piece', JSON.stringify(calls.at(-1)) === '["salvage","ring1"]', JSON.stringify(calls.at(-1)));

// An empty bag must still explain itself instead of rendering a blank panel.
const emptyRoot = new El('div');
renderGear(emptyRoot, { ...state, profile: { ...state.profile, gear: [], equipped: {} } }, actions);
check('an empty bag still renders the slots', findAll(emptyRoot, 'slot-row').length === 1);
check('an empty bag says where to go', text(emptyRoot).includes('Crafting'));

// --- 2. crafting cards advertise the buff pool -----------------------------------
console.log('\n  crafting\n');
const craftRoot = new El('div');
renderCrafting(craftRoot, state, actions);
const gearNotes = findAll(craftRoot, 'craft-gear');
check('every gear recipe explains its roll', gearNotes.length === content.recipes.filter((r) => r.output?.gear).length,
  `${gearNotes.length} notes for ${content.recipes.filter((r) => r.output?.gear).length} gear recipes`);
const gloveNote = gearNotes.find((n) => text(n).includes('Luck'));
check('the note lists the whole buff band', text(gloveNote).includes('Luck +6–30%'), text(gloveNote));
check('the note shows the quality odds', /Radiant \d+(\.\d)?%/.test(text(gloveNote)), text(gloveNote));
check('the note says how many buffs roll', /Rolls \d–\d buffs/.test(text(gloveNote)), text(gloveNote));
check('a signature buff is starred on the recipe', text(gloveNote).includes('★'));
check('gear recipes still have a Craft button', !!findButton(craftRoot, 'Craft'));

// --- 3. the global board ----------------------------------------------------------
console.log('\n  leaderboard\n');
state.board = {
  sort: 'rolls',
  sorts: [
    { id: 'best', name: 'Rarest pull', icon: '💎' },
    { id: 'rolls', name: 'Total rolls', icon: '🎲' },
    { id: 'money', name: 'Money', icon: '💰' },
  ],
  rows: [
    { id: 'a', name: 'Alice', guest: false, totalRolls: 9000, unique: 30, totalAuras: 61, essence: 900, money: 5000, ascensions: 3, luck: 4, gear: 4, bestAuraId: content.auras[0].id, bestOdds: 128 },
    { id: 'b', name: 'guest-1234', guest: true, totalRolls: 400, unique: 4, totalAuras: 61, essence: 9, money: 12, ascensions: 0, luck: 1, gear: 0, bestAuraId: null, bestOdds: null },
  ],
  you: { rank: 47, row: { id: 'me', name: 'Me', guest: false, totalRolls: 900, unique: 12, totalAuras: 61, essence: 40, money: 1200, ascensions: 1, luck: 2.4, gear: 2, bestAuraId: content.auras[0].id, bestOdds: 64 }, inTop: false },
  total: 47,
};
const boardRoot = new El('div');
renderLeaderboard(boardRoot, state, actions);
const sorts = findAll(boardRoot, 'sort-btn');
check('one button per rankable column', sorts.length === 3, `got ${sorts.length}`);
check('the active column is marked', sorts.filter((s) => s.classList.contains('is-active')).length === 1);
check('rows are ranked', findAll(boardRoot, 'lb-row').length === 3, `${findAll(boardRoot, 'lb-row').length} rows`);
check('the metric follows the sort', text(boardRoot).includes('9.00K rolls'), text(boardRoot));
check('guests are tagged', text(boardRoot).includes('guest'));
check('your own row shows with its real rank', text(boardRoot).includes('47'));
check('the board says how many players it ranks', text(boardRoot).includes('47 player'));
await sorts[0].dispatch('click');
check('clicking a column asks for that sort', JSON.stringify(calls.at(-1)) === '["sort","best"]', JSON.stringify(calls.at(-1)));
await findButton(boardRoot, 'Refresh').dispatch('click');
check('refresh asks the server for a fresh board', calls.at(-1)[0] === 'refresh');

const emptyBoard = new El('div');
renderLeaderboard(emptyBoard, { ...state, board: null }, actions);
check('a board still loading says so', text(emptyBoard).includes('Loading'));

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  console.log('  Failed:');
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
