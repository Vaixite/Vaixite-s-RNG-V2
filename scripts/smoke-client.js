// Boots the real client bundle inside a minimal DOM shim and drives a few
// rolls against a running server. Not a substitute for a browser, but it
// catches undefined references, bad selectors and broken render paths that
// would otherwise only show up as a blank page.
//
// Run: node scripts/smoke-client.js      (server must be running)
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

// --- DOM shim ---------------------------------------------------------------
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.attrs = {};
    this._class = new Set();
    this.textContent = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.classList = {
      add: (...c) => c.forEach((x) => this._class.add(x)),
      remove: (...c) => c.forEach((x) => this._class.delete(x)),
      toggle: (c, force) =>
        force === undefined
          ? this._class.has(c) ? this._class.delete(c) : this._class.add(c)
          : force ? this._class.add(c) : this._class.delete(c),
      contains: (c) => this._class.has(c),
    };
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  append(...n) {
    for (const x of n) {
      if (x == null || x === false) continue;
      this.children.push(typeof x === 'string' ? Object.assign(new El('#text'), { textContent: x }) : x);
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._listeners ??= {})[t] = [...(this._listeners?.[t] || []), fn]; }
  removeEventListener() {}
  /** Fire stored handlers; returns their results so callers can await async ones. */
  dispatch(type, event = {}) {
    const fns = this._listeners?.[type] || [];
    const ev = { preventDefault() {}, stopPropagation() {}, target: this, ...event };
    return Promise.all(
      fns.map((f) => {
        try { return f(ev); } catch (e) { problems.push(`handler "${type}" threw: ${e.message}`); }
      })
    );
  }
  matches() { return false; }
  closest() { return null; }
  querySelector(sel) { return registryEl(sel); }
  querySelectorAll() { return []; }
  insertAdjacentHTML() {}
  focus() {}
}

const registry = new Map();
function registryEl(sel) {
  if (!registry.has(sel)) registry.set(sel, new El('div'));
  return registry.get(sel);
}

const body = new El('body');
const doc = {
  hidden: false,
  body,
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createTextNode: (t) => Object.assign(new El('#text'), { textContent: t }),
  querySelector: (sel) => registryEl(sel),
  querySelectorAll: () => [],
  addEventListener() {},
};

// --- globals ----------------------------------------------------------------
globalThis.document = doc;
globalThis.window = globalThis;
// Node 21+ defines navigator as a getter-only global; redefine it to shim.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' },
  configurable: true,
  writable: true,
});
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.confirm = () => true;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
globalThis.addEventListener = () => {};

// Resolve the bundle's relative fetch() calls against the test server.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(url.startsWith('http') ? url : BASE + url, opts);

// --- run --------------------------------------------------------------------
const problems = [];
process.on('uncaughtException', (e) => problems.push(`uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e?.message || e}`));

const name = `Smoke${Date.now().toString(36)}`;
console.log(`\n  Booting client bundle against ${BASE} as "${name}"\n`);

// Pre-seed the join form so boot()'s account flow can create a profile.
const joinForm = registryEl('#joinForm');
registryEl('#joinName').value = name;

await import('../public/js/main.js');
await new Promise((r) => setTimeout(r, 400));

// Submit the join form exactly like a user would.
await joinForm.dispatch('submit');
await new Promise((r) => setTimeout(r, 700));

const who = registryEl('#who').innerHTML || '';
console.log(`  #who        → ${who || '(empty)'}`);
if (!who.includes(name)) problems.push(`profile did not load (got "${who}")`);

const id = globalThis.localStorage.getItem('vrng2.playerId');
if (!id) problems.push('player id was not persisted to localStorage');

const luck = registryEl('#hudLuck').textContent;
const essence = registryEl('#hudEssence').textContent;
console.log(`  #hudLuck    → ${luck}`);
console.log(`  #hudEssence → ${essence}`);
if (!luck) problems.push('luck HUD never rendered');

const biome = registryEl('#biomeName').textContent;
console.log(`  #biomeName  → ${biome}`);
if (!biome) problems.push('biome chip never rendered');

const feedKids = registryEl('#feed').children.length;
const viewKids = registryEl('#view').children.length;
console.log(`  #feed kids  → ${feedKids}`);
console.log(`  #view kids  → ${viewKids}`);
if (viewKids === 0) problems.push('side view rendered nothing');

// Click the real roll button — this exercises doRoll(), the spin, the reveal,
// the cutscene gate and every HUD re-render.
const rollBtn = registryEl('#rollBtn');
let clicked = 0;
let lastName = '';
for (let i = 0; i < 4; i++) {
  await rollBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 1400));
  clicked++;
  lastName = registryEl('#auraName').textContent;
  if (!lastName) problems.push('aura name was not painted after rolling');
}
console.log(`  rolls made  → ${clicked} (last shown: ${lastName})`);

const essenceAfter = registryEl('#hudEssence').textContent;
console.log(`  #hudEssence → ${essenceAfter}`);
if (essenceAfter === '0' || !essenceAfter) problems.push('essence HUD did not update after rolling');

// Switch to each tab and confirm it renders something.
for (const view of ['bestiary', 'upgrades', 'leaderboard', 'inventory']) {
  const tab = registryEl(`[data-view="${view}"]`);
  tab.dataset.view = view;
  await tab.dispatch('click');
  await new Promise((r) => setTimeout(r, 120));
  const kids = registryEl('#view').children.length;
  console.log(`  view ${view.padEnd(11)} → ${kids} node(s)`);
  if (kids === 0) problems.push(`view "${view}" rendered nothing`);
}

// Clean up the throwaway profile.
await realFetch(`${BASE}/api/delete`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id }),
});

if (problems.length) {
  console.log('\n  ✖ client problems:');
  for (const p of [...new Set(problems)]) console.log(`    - ${p}`);
  process.exit(1);
}
console.log('\n  ✔ client booted, rendered and rolled cleanly\n');
process.exit(0);
