// Boots the real client bundle inside a minimal DOM shim and drives the whole
// flow against a running server: sign up, roll, every tab, log out, then play
// as a guest. Not a substitute for a browser, but it catches undefined
// references, bad selectors and broken render paths that would otherwise only
// show up as a blank page.
//
// Run: node scripts/smoke-client.js      (server must be running)
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

// --- DOM shim ---------------------------------------------------------------
// Records custom properties the way a real CSSStyleDeclaration does, so a test
// can tell `style.setProperty('--aura', …)` apart from a stray JS assignment.
class Style {
  constructor() { this._custom = new Map(); }
  setProperty(k, v) { this._custom.set(k, String(v)); }
  removeProperty(k) { this._custom.delete(k); }
  getPropertyValue(k) { return this._custom.get(k) || ''; }
}

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    // h() branches on nodeType to tell nodes from strings. Without it every
    // nested element gets stringified into "[object Object]" and the whole
    // rendered tree silently collapses to junk text.
    this.nodeType = String(tag) === '#text' ? 3 : 1;
    this.children = [];
    this.style = new Style();
    this.dataset = {};
    this.attrs = {};
    this._class = new Set();
    this._text = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
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
  // Real elements derive textContent from their descendants. Without this the
  // shim reports '' for every node built by h(), and any test that looks for a
  // button by its label silently finds nothing.
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
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
  // Must actually detach, or toast()'s "cap the stack" loop spins forever:
  // `while (children.length > 5) firstChild.remove()` never shrinks the list.
  remove() { this._parent?.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._listeners ??= {})[t] = [...(this._listeners?.[t] || []), fn]; }
  removeEventListener() {}
  /**
   * Fire handlers for `type`, then bubble to ancestors like a real click does.
   * The tab strip listens on the #tabs container and resolves the tab through
   * e.target.closest(), so a shim that only fires an element's own listeners
   * makes every tab click a silent no-op.
   */
  dispatch(type, event = {}) {
    const ev = {
      preventDefault() {},
      stopPropagation() { ev._bubble = false; },
      target: this,
      _bubble: true,
      ...event,
    };
    let results = [];
    for (let node = this; node && ev._bubble; node = node._parent) {
      for (const f of node._listeners?.[type] || []) {
        try { results.push(f(ev)); } catch (e) { problems.push(`handler "${type}" threw: ${e.message}`); }
      }
    }
    return Promise.all(results);
  }
  matches() { return false; }
  // Enough for the tab strip and for a card that asks "did this click land on a
  // button?": class *and* tag selectors, walking up to the root like the real
  // Element.closest() does.
  closest(sel) {
    const s = String(sel).trim();
    const byTag = /^[a-zA-Z]/.test(s) && !s.startsWith('.');
    for (let node = this; node; node = node._parent) {
      if (byTag ? node.tagName === s.toUpperCase() : node._class.has(s.replace(/^\./, ''))) return node;
    }
    return null;
  }
  contains(n) {
    if (n == null) return false;
    let found = false;
    (function walk(x) {
      if (found) return;
      if (x === n) found = true;
      else for (const c of x.children || []) walk(c);
    })(this);
    return found;
  }
  querySelector(sel) { return registryEl(sel); }
  querySelectorAll(sel) { return [registryEl(sel)]; }
  insertAdjacentHTML() {}
  focus() {}
  select() {}
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
  querySelectorAll: (sel) => [registryEl(sel)],
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
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// rollfx asks matchMedia for the reduced-motion preference on every spin.
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};

// Resolve the bundle's relative fetch() calls against the test server.
const realFetch = globalThis.fetch;
// Some panels only exist once an account has earned them. Setting this filter
// makes every response that carries a profile pass through it first — a purely
// client-side lie used to render an unearned panel; the server never hears.
let profilePatch = null;
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url.startsWith('http') ? url : BASE + url, opts);
  if (!profilePatch || typeof url !== 'string' || !url.startsWith('/api/')) return res;
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON: hand back exactly what came */ }
  if (!data || !data.profile) return new Response(text, { status: res.status, headers: res.headers });
  profilePatch(data.profile);
  return new Response(JSON.stringify(data), { status: res.status, headers: { 'content-type': 'application/json' } });
};

// --- run --------------------------------------------------------------------
const problems = [];
process.on('uncaughtException', (e) => problems.push(`uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${e?.message || e}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SMOKE_USER lets a harness pre-author this exact account in admins.json before
// it starts, so the admin tab can be walked for real instead of assumed.
const user = process.env.SMOKE_USER || `Smoke${Date.now().toString(36)}`;
const password = 'smoke-testing-123';

console.log(`\n  Booting the client bundle against ${BASE}\n`);
await import('../public/js/main.js');
await sleep(500);

// The bundle must land on the sign-in modal, not straight into the game.
if (!registryEl('#authModal').classList.contains('is-on')) problems.push('auth modal did not open');
if (globalThis.localStorage.getItem('vrng2.token')) problems.push('a token existed before signing in');

// --- create an account -------------------------------------------------------
const registerTab = registryEl('.auth-tab');
registerTab.className = 'auth-tab';
registerTab.dataset.mode = 'register';
await registerTab.dispatch('click');

registryEl('#authUser').value = user;
registryEl('#authPass').value = password;
await registryEl('#authForm').dispatch('submit');
await sleep(700);

const who = registryEl('#who').innerHTML || '';
console.log(`  #who        → ${who.replace(/<[^>]+>/g, '') || '(empty)'}`);
if (!who.includes(user)) problems.push(`account did not load (got "${who}")`);
if (registryEl('#authModal').classList.contains('is-on')) problems.push('auth modal stayed open after signing in');

const token = globalThis.localStorage.getItem('vrng2.token');
if (!token) problems.push('session token was not persisted to localStorage');

console.log(`  #hudLuck    → ${registryEl('#hudLuck').textContent}`);
console.log(`  #hudMoney   → ${registryEl('#hudMoney').textContent}`);
console.log(`  #hudEssence → ${registryEl('#hudEssence').textContent}`);
console.log(`  #biomeName  → ${registryEl('#biomeName').textContent}`);
if (!registryEl('#hudLuck').textContent) problems.push('luck HUD never rendered');
if (!registryEl('#biomeName').textContent) problems.push('biome chip never rendered');
if (registryEl('#hudMoney').textContent !== '0') problems.push('a new account should start with 0 money');

if (registryEl('#view').children.length === 0) problems.push('side view rendered nothing');

// --- roll ----------------------------------------------------------------------
const rollBtn = registryEl('#rollBtn');
let lastName = '';
for (let i = 0; i < 4; i++) {
  await rollBtn.dispatch('click');
  await sleep(1400);
  lastName = registryEl('#auraName').textContent;
  if (!lastName) problems.push('aura name was not painted after rolling');
}
const rolls = registryEl('#hudRolls').textContent;
const essence = registryEl('#hudEssence').textContent;
console.log(`  rolls       → ${rolls} (last shown: ${lastName})`);
console.log(`  #hudEssence → ${essence}`);
if (rolls === '0' || !rolls) problems.push('roll counter did not move');
if (essence === '0' || !essence) problems.push('essence HUD did not update after rolling');

// --- helpers ---------------------------------------------------------------
// Post-order, so a container whose aggregated text also matches never shadows
// the actual button inside it.
function findButton(node, text) {
  let found = null;
  (function walk(n) {
    for (const child of n.children || []) {
      walk(child);
      if (!found && String(child.textContent).includes(text)) found = child;
    }
  })(node);
  return found;
}

function findAll(node, cls, out = []) {
  for (const child of node.children || []) {
    if (String(child.className).includes(cls)) out.push(child);
    findAll(child, cls, out);
  }
  return out;
}

// --- the reveal carries its tier colour --------------------------------------
// The cutscene/tag layer reads tierColor off the roll payload.
const tierTag = registryEl('#auraTags').children[0];
const tierColor = tierTag?.style?.color || '';
console.log(`  tier tag    → ${tierTag?.textContent || '(none)'} ${tierColor}`);
if (!tierTag) problems.push('roll reveal painted no tags');
else if (!tierColor) problems.push('reveal tier tag has no colour (roll payload is missing tierColor)');

// The real page has the tab buttons inside #tabs; the shim registry hands out
// detached elements, so wire them up or the delegated click handler never runs.
const tabsRoot = registryEl('#tabs');
function tabFor(view) {
  const tab = registryEl(`[data-view="${view}"]`);
  tab.className = 'tab';
  tab.dataset.view = view;
  if (tab._parent !== tabsRoot) tabsRoot.append(tab);
  return tab;
}

// --- every tab renders ----------------------------------------------------------
const VIEWS_TO_VISIT = ['bestiary', 'crafting', 'gear', 'upgrades', 'shop', 'leaderboard'];
// The Admin tab only ever exists for a name listed in admins.json, so it is not
// in the default walk. A harness that pre-seeded the allowlist for SMOKE_USER
// can ask for it with SMOKE_ADMIN=1 — and then the tab has to actually work.
if (process.env.SMOKE_ADMIN) VIEWS_TO_VISIT.push('admin');
// Inventory stays last: the checks after this loop read the cards it paints.
VIEWS_TO_VISIT.push('inventory');
for (const view of VIEWS_TO_VISIT) {
  await tabFor(view).dispatch('click');
  await sleep(120);
  const kids = registryEl('#view').children.length;
  console.log(`  view ${view.padEnd(11)} → ${kids} node(s)`);
  if (kids === 0) problems.push(`view "${view}" rendered nothing`);
  if (state_view() !== view) problems.push(`clicking the "${view}" tab did not switch the view`);
}

function state_view() {
  const active = tabsRoot.children.find((t) => t.classList.contains('is-active'));
  return active?.dataset.view || null;
}

// --- cards carry their aura colour ---------------------------------------------
// Cards are tinted through the --aura custom property; if h() drops it they all
// render in the default grey and the collection looks broken.
const cards = findAll(registryEl('#view'), 'card');
const tinted = cards.filter((c) => c.style.getPropertyValue('--aura'));
console.log(`  --aura      → ${tinted.length}/${cards.length} card(s) tinted`);
if (!cards.length) problems.push('inventory rendered no cards');
else if (tinted.length !== cards.length) problems.push('cards render without their --aura colour');

// The card body advertises the aura's normal pool odds; the odds the pull
// actually landed at are demoted to the tooltip and the dossier.
const cardTitle = String(cards[0]?.getAttribute('title') || '');
console.log(`  card title  → ${cardTitle.split('\n').join(' / ').slice(0, 96) || '(none)'}`);
if (cards.length) {
  if (!/normal odds/.test(cardTitle)) problems.push('inventory card does not advertise the normal odds');
  if (!/you got it at/.test(cardTitle)) problems.push('inventory card does not say what the aura was pulled at');
}

// --- selling works through the UI -------------------------------------------------
const sellBtn = findButton(registryEl('#view'), 'Sell');
if (sellBtn) {
  await sellBtn.dispatch('click');
  await sleep(400);
  const money = registryEl('#hudMoney').textContent;
  console.log(`  #hudMoney   → ${money} (after selling one aura)`);
  if (money === '0' || !money) problems.push('money HUD did not update after selling');
} else {
  problems.push('owned aura offers no Sell button');
}

// --- the clicker tab is data-gated ----------------------------------------------
// A brand new account has not bought the 🕹 Arcade Cabinet node, so the tab has to
// stay hidden and the view has to answer with its locked panel instead of a shop.
// (The shop itself — costs, crits, luck payback — is covered by test-minigames.js;
// this only proves the client half never renders it empty or unearned.)
if (registryEl('#tabClicker').style.display !== 'none') {
  problems.push('clicker tab is visible before the Arcade Cabinet node is bought');
}
// The tab handler renders synchronously, so no sleep: a poll landing here would
// legitimately knock an unearned view back to the inventory.
await tabFor('clicker').dispatch('click');
const lockedPanel = findAll(registryEl('#view'), 'clk-locked');
console.log(`  clicker     → ${lockedPanel.length ? 'locked panel' : 'NO LOCKED PANEL'}`);
if (!lockedPanel.length) problems.push('locked clicker view renders no locked panel');

// --- the shop renders once the cabinet is earned ---------------------------------
// Buying the node for real means burning a whole ascend, so the profile is patched
// in flight instead: same catalog, same renderer, earned flag flipped on.
const withClass = (root, cls) => findAll(root, cls).filter((n) => String(n.className).split(/\s+/).includes(cls));
profilePatch = (p) => {
  p.clickerUnlocked = true;
  p.tree = { ...p.tree, arcade: 1 };
  p.clicker = {
    sparks: 815, totalSparks: 999, totalClicks: 4242, bestClick: 77,
    levels: { grip: 3, lucky_finger: 40, auto_clicker: 1 },
    perClick: 3.4, clicksPerClick: 2, critChance: 0.04, critMult: 5, autoClickPerSec: 1,
  };
  p.stats.clicker = { luck: 1.2, cooldown: 0.9, essence: 1.15, sell: 1, mine: 1 };
  p.stats.autoClickPerSec = 1;
};
await registryEl('#rollBtn').dispatch('click');
await sleep(1400);
profilePatch = null;
if (registryEl('#tabClicker').style.display === 'none') {
  problems.push('clicker tab stayed hidden with the Arcade Cabinet node bought');
}
await tabFor('clicker').dispatch('click');
const clkRoot = registryEl('#view');
const shopCards = withClass(clkRoot, 'upg');
const giftRows = withClass(clkRoot, 'clk-gift');
const purse = String(withClass(clkRoot, 'clk-purse')[0]?.textContent || '');
console.log(`  clicker     → unlocked: ${withClass(clkRoot, 'clk-big').length ? 'button' : 'NO BUTTON'}, ${shopCards.length} upgrade card(s), ${giftRows.length} payback row(s), purse ${purse.replace(/\s+/g, ' ').trim()}`);
if (!withClass(clkRoot, 'clk-big').length) problems.push('clicker view renders no click button');
if (!withClass(clkRoot, 'clk-auto').length) problems.push('clicker view hides the auto-clicker strip it has earned');
if (shopCards.length < 10) problems.push(`clicker shop rendered ${shopCards.length} upgrade cards, expected one per content entry`);
if (giftRows.length !== 5) problems.push(`clicker view shows ${giftRows.length} payback rows, expected 5`);
if (!/815/.test(purse)) problems.push(`spark purse did not paint the balance (got "${purse.trim()}")`);
// A maxed card must read MAXED and its button must be inert, or the shop lies.
const maxedCard = shopCards.find((c) => String(c.textContent).includes('MAXED'));
if (!maxedCard) problems.push('a maxed upgrade card does not say MAXED');
else if (!maxedCard.children.some((n) => n.getAttribute('disabled') != null)) problems.push('a maxed upgrade card still offers a live buy button');
await tabFor('inventory').dispatch('click');
await sleep(120);

// --- the auto drill strip shows up with the node -------------------------------
// Same trick: an Auto Drill level is Ascend Points deep, so the profile says the
// shaft is unlocked and the drill rate is non-zero, and the strip has to appear.
profilePatch = (p) => {
  p.miningUnlocked = true;
  p.stats.autoMinePerSec = 0.5;
};
await registryEl('#rollBtn').dispatch('click');
await sleep(1400);
profilePatch = null;
if (registryEl('#tabMining').style.display === 'none') problems.push('mining tab stayed hidden with the shaft unlocked');
await tabFor('mining').dispatch('click');
const strip = withClass(registryEl('#view'), 'drill-strip')[0];
console.log(`  drill strip → ${strip ? String(strip.textContent).replace(/\s+/g, ' ').trim() : 'MISSING'}`);
if (!strip) problems.push('auto drill strip does not render with an Auto Drill rate');
else if (!strip.children.some((n) => n.tagName === 'LABEL')) problems.push('drill strip renders without its run/off switch');
await tabFor('inventory').dispatch('click');
await sleep(120);

// --- settings opens as a modal --------------------------------------------------
// It used to be a popover anchored to the ⚙ button, which the screen edge cut
// off on short windows. As a modal it must open, switch and dismiss anywhere.
const settingsModal = registryEl('#settingsModal');
await registryEl('#settingsBtn').dispatch('click');
await sleep(60);
console.log(`  settings    → ${settingsModal.classList.contains('is-on') ? 'modal open' : 'DID NOT OPEN'}`);
if (!settingsModal.classList.contains('is-on')) problems.push('the ⚙ button did not open the settings modal');
if (registryEl('#settingsBtn').getAttribute('aria-expanded') !== 'true') problems.push('settings button aria-expanded did not follow the modal');

// True-odds is pure presentation: flipping it must repaint without a server call.
registryEl('#setTrueOdds').checked = true;
await registryEl('#setTrueOdds').dispatch('change');
await sleep(80);
if (globalThis.localStorage.getItem('vrng2.trueOdds') !== '1') problems.push('true-odds setting was not remembered');
registryEl('#setTrueOdds').checked = false;
await registryEl('#setTrueOdds').dispatch('change');
await sleep(80);

// Luck is a server-side roll rule: the profile comes back with luckOff set and
// the HUD badges it.
registryEl('#setLuck').checked = false;
await registryEl('#setLuck').dispatch('change');
await sleep(500);
const luckOff = registryEl('#luckOffChip').hidden === false;
console.log(`  luck switch → ${luckOff ? 'off, HUD badged' : 'HUD did not badge luck-off'}`);
if (!luckOff) problems.push('switching luck off did not come back as a badged HUD');
registryEl('#setLuck').checked = true;
await registryEl('#setLuck').dispatch('change');
await sleep(500);

// The cutscene threshold is a dropdown of every tier plus Never. Pure
// presentation: changing it must be remembered without any server call.
const cutSel = registryEl('#setCutscene');
const cutDefault = cutSel.value;
const catForCut = await (await fetch('/api/catalog')).json();
console.log(`  cutscene    → ${cutSel.children.length} options, default ${cutDefault}`);
if (cutSel.children.length < 2) problems.push('the cutscene dropdown has no tier options');
if (cutDefault !== String(catForCut.cutsceneTierIndex ?? 3)) problems.push('the cutscene dropdown does not default to the game threshold');
cutSel.value = '999'; // Never
await cutSel.dispatch('change');
await sleep(60);
if (globalThis.localStorage.getItem('vrng2.cutsceneMin') !== '999') problems.push('the cutscene threshold was not remembered');
// Back to the game default so the rest of the run sees normal behaviour.
cutSel.value = cutDefault;
await cutSel.dispatch('change');
await sleep(60);

await registryEl('#settingsClose').dispatch('click');
await sleep(60);
if (settingsModal.classList.contains('is-on')) problems.push('the Close button did not dismiss the settings modal');

// --- clicking an aura opens its dossier ------------------------------------------
await tabFor('bestiary').dispatch('click');
await sleep(150);
const dossierCard = findAll(registryEl('#view'), 'is-clickable')[0];
if (!dossierCard) {
  problems.push('bestiary cards are not clickable');
} else {
  await dossierCard.dispatch('click');
  await sleep(80);
  const auraModal = registryEl('#auraModal');
  const card = registryEl('#auraModalCard');
  const txt = (card.textContent || '').replace(/\s+/g, ' ');
  console.log(`  dossier     → ${txt.slice(0, 78) || '(empty)'}…`);
  if (!auraModal.classList.contains('is-on')) problems.push('clicking an aura did not open its dossier');
  if (!/Normal odds/.test(txt)) problems.push('dossier is missing its odds rows');
  // The card you clicked came off the Bestiary's roll shelf, so it was rolled —
  // and a rolled aura's dossier must also say what the pull actually landed at.
  if (!/You got it at/.test(txt)) problems.push('dossier is missing the odds the aura was pulled at');
  if (!/Sell value/.test(txt)) problems.push('dossier is missing the sell value');
  if (!card.style.getPropertyValue('--aura')) problems.push('dossier card is not tinted with the aura colour');

  const replay = findButton(card, 'cutscene') || findButton(card, 'reveal');
  if (!replay) {
    problems.push('dossier offers no way to replay the cutscene');
  } else {
    // The card fades out (0.25s) before the takeover starts, so give the
    // handoff its time and then check the stage actually re-painted. The
    // stage is wiped to a sentinel first: comparing before/after names used
    // to pass by luck and fail whenever the replayed aura happened to be
    // the one already on stage.
    registryEl('#auraName').textContent = '__stage__';
    // Not awaited: the takeover itself runs ~4s and the paint is the point.
    replay.dispatch('click');
    await sleep(600);
    if (auraModal.classList.contains('is-on')) problems.push('replaying a cutscene left the dossier in the way');
    const stageAfter = registryEl('#auraName').textContent;
    console.log(`  replay      → ${replay.textContent}: "${stageAfter}" on stage`);
    if (!stageAfter || stageAfter === '__stage__') problems.push('the replay did not re-paint the stage with the aura');
  }

  // Backdrop click dismisses it, and so does signing out.
  await auraModal.dispatch('click');
  await sleep(60);
  if (auraModal.classList.contains('is-on')) problems.push('a backdrop click did not close the dossier');
}

// --- unowned auras are sealed ------------------------------------------------------
// The Bestiary is not a content-file viewer: an aura you have not found shows no
// name and cannot be clicked, and the craft-only Special Auras shelf is held to
// exactly the same rule.
await tabFor('bestiary').dispatch('click');
await sleep(150);
const bestRoot = registryEl('#view');
const sealed = findAll(bestRoot, 'is-locked');
const sealedClickable = sealed.filter((c) => String(c.className).includes('is-clickable'));
const sealedNamed = sealed.filter((c) => !String(c.textContent).includes('? ? ?'));
const shelfTitles = findAll(bestRoot, 'section-title').map((n) => String(n.textContent));
console.log(`  sealed      → ${sealed.length} card(s), ${sealedClickable.length} clickable, ${sealedNamed.length} named`);
if (!sealed.length) problems.push('a freshly rolled account should still have sealed auras in the Bestiary');
if (sealedClickable.length) problems.push('an unowned aura is clickable');
if (sealedNamed.length) problems.push('an unowned aura reveals its name');
if (sealed[0]) {
  await sealed[0].dispatch('click');
  await sleep(80);
  if (registryEl('#auraModal').classList.contains('is-on')) problems.push('clicking a sealed aura opened a dossier');
}
if (!shelfTitles.some((t) => /Special Auras/i.test(t))) problems.push('the Bestiary has no Special Auras shelf');
if (!shelfTitles.some((t) => /^Auras/i.test(t.trim()))) problems.push('the Bestiary has no normal Auras shelf');

// --- the Craft button reaches the server ------------------------------------------
// Look for the actual button, not any node whose text mentions crafting: the
// view's intro paragraph says "Crafting only costs…" and has no handler, which
// is what this test used to click — and pass, on toasts left over from earlier
// steps. A fresh account usually cannot afford a recipe, and the honest contract
// then is a disabled button that says what is missing.
await tabFor('crafting').dispatch('click');
await sleep(120);
const craftBtn = findAll(registryEl('#view'), 'buy-btn').find((b) => String(b.textContent).trim() === 'Craft');
if (!craftBtn) {
  problems.push('crafting view offers no Craft button');
} else if (craftBtn.getAttribute('disabled') === 'true') {
  const why = craftBtn.getAttribute('title') || '';
  console.log(`  craft btn     → disabled: ${why.slice(0, 64) || '(no reason given)'}`);
  if (!/you have/i.test(why)) problems.push('a disabled Craft button does not say what is missing');
} else {
  // Only the toasts this click produces. Compare by node identity: older
  // toasts from earlier steps expire mid-test and drop out of the stack, so an
  // index offset would silently read nothing (and used to read *their* text).
  const toastRoot = registryEl('#toasts');
  const before = new Set(toastRoot.children);
  await craftBtn.dispatch('click');
  await sleep(400);
  const toasts = toastRoot.children.filter((t) => !before.has(t)).map((t) => t.textContent).join(' | ');
  console.log(`  craft toast   → ${toasts || '(none)'}`);
  if (!toasts) problems.push('clicking Craft produced no feedback at all');
  else if (/Craft failed/.test(toasts)) problems.push(`Craft button errored: ${toasts}`);
}

// --- the leaderboard refresh actually repaints -------------------------------------
await tabFor('leaderboard').dispatch('click');
await sleep(150);
const board = registryEl('#view');
if (!findAll(board, 'lb-row').length) problems.push('leaderboard rendered no rows');
const boardBefore = board.children[0];
const refreshBtn = findButton(registryEl('#view'), 'Refresh');
if (!refreshBtn) {
  problems.push('leaderboard offers no refresh button');
} else {
  await refreshBtn.dispatch('click');
  await sleep(500);
  if (registryEl('#view').children[0] === boardBefore) {
    problems.push('leaderboard refresh did not repaint the board');
  } else {
    console.log('  board       → repainted on refresh');
  }
}

// --- the board re-ranks when you pick another column ---------------------------------
const sortBtn = findAll(registryEl('#view'), 'sort-btn').find((b) => !b.classList.contains('is-active'));
if (!sortBtn) {
  problems.push('leaderboard offers no alternative sort');
} else {
  const label = sortBtn.textContent;
  await sortBtn.dispatch('click');
  await sleep(600);
  const active = findAll(registryEl('#view'), 'sort-btn').find((b) => b.classList.contains('is-active'));
  console.log(`  board sort  → ${active?.textContent || '(none)'} (clicked "${label}")`);
  if (!active || active.textContent !== label) problems.push('clicking a sort column did not re-rank the board');
  if (!findAll(registryEl('#view'), 'lb-row').length) problems.push('re-ranked board rendered no rows');
}

// --- the gear tab shows the slots you can wear ---------------------------------------
await tabFor('gear').dispatch('click');
await sleep(150);
const gearRoot = registryEl('#view');
const slotNodes = gearRoot.children.length ? findAll(gearRoot, 'slot-row') : [];
console.log(`  gear tab    → ${slotNodes.length} slot strip(s), ${findAll(gearRoot, 'slot').length} slot cell(s)`);
if (!slotNodes.length) problems.push('gear tab rendered no equipment slot strip');
if (!findAll(gearRoot, 'slot').length) problems.push('gear tab shows no slots to wear gear in');

// --- the admin panel edits a real account ---------------------------------------
// Only when the harness pre-authorised this account in admins.json: the panel is
// server-gated, so a normal run must not even try to open it.
if (process.env.SMOKE_ADMIN) {
  await tabFor('admin').dispatch('click');
  await sleep(250);

  const findInput = (n) => {
    for (const child of n.children || []) {
      const hit = child.tagName === 'INPUT' ? child : findInput(child);
      if (hit) return hit;
    }
    return null;
  };

  const field = findInput(registryEl('#view'));
  const load = findButton(registryEl('#view'), 'Load');
  if (!field || !load) {
    problems.push('admin panel rendered no target field / Load button');
  } else {
    field.value = user;
    await field.dispatch('input');
    await load.dispatch('click');
    await sleep(700);

    const text = () => String(registryEl('#view').textContent);
    console.log(`  admin edit  → ${text().includes('Editing ·') ? 'loaded ' + user : 'NO EDITOR'}`);
    if (!text().includes('Editing ·')) problems.push('admin panel did not load the player editor');
    for (const label of ['Set essence', 'Give auras', 'Forge gear', 'Delete account', 'Announce']) {
      if (!text().includes(label)) problems.push(`admin editor is missing "${label}"`);
    }

    // One real write, so the panel is proven against the server and not merely
    // rendered — and so a throw inside the refresh path lands in `problems`.
    const before = registryEl('#hudMoney').textContent;
    const give = findButton(registryEl('#view'), '1M');
    if (!give) problems.push('admin editor has no quick money button');
    else {
      await give.dispatch('click');
      await sleep(900);
      console.log(`  admin give  → 💰 ${before} → ${registryEl('#hudMoney').textContent}`);
      if (!text().includes('Editing ·')) problems.push('the panel lost the editor after an action');
    }
  }
}

// --- the client's own odds mirror, at 50k luck ------------------------------------
// The browser recomputes the whole ladder between server polls (oddsmirror.js) —
// the bestiary, the dossier and the roll roulette all read it, so a mirror that
// drifts from src/roll.js makes the animation quote odds the engine disagrees
// with. Pin it through the real render path: everything the luck floor left
// behind locks, and exactly the auras the roll engine still offers stay live.
{
  const { auras, allAuras } = await (await realFetch(`${BASE}/api/catalog`)).json();
  const LUCK = 50000;
  profilePatch = (p) => { p.stats.luck = LUCK; };
  await sleep(1600); // clear the cooldown so the roll below actually lands
  await rollBtn.dispatch('click');
  await sleep(1500);
  await tabFor('bestiary').dispatch('click');
  await sleep(200);

  const cards = withClass(registryEl('#view'), 'card');
  const floored = cards.filter((c) => String(c.className).split(/\s+/).includes('is-floored'));
  // Craft-only auras are never in the pool, so the floor has nothing to say
  // about them — they stay readable at any luck.
  const wantFloored = auras.filter((a) => a.odds < LUCK).length;
  const wantLive = allAuras.length - wantFloored;
  const viewText = String(registryEl('#view').textContent);
  console.log(
    `  mirror @50k   → ${cards.length} card(s) · ${floored.length} floored · ` +
      `${cards.length - floored.length} live (expected ${wantFloored} / ${wantLive})`
  );
  if (!floored.length) problems.push('at 50k luck nothing is floored — the client mirror is not applying the luck floor');
  if (cards.length !== allAuras.length) problems.push(`bestiary shows ${cards.length} cards, catalog has ${allAuras.length} auras`);
  if (floored.length !== wantFloored) {
    problems.push(`mirror floors ${floored.length} auras at ${LUCK} luck, the roll engine floors ${wantFloored}`);
  }
  if (!viewText.includes('below luck')) problems.push('floored cards do not say they are below your luck');

  profilePatch = null;
  await tabFor('inventory').dispatch('click');
  await sleep(120);
}

// --- log out, then play as a guest ---------------------------------------------------
await registryEl('#logoutBtn').dispatch('click');
await sleep(300);
if (!registryEl('#authModal').classList.contains('is-on')) problems.push('logout did not return to the sign-in modal');
if (globalThis.localStorage.getItem('vrng2.token')) problems.push('logout left the token behind');

await registryEl('#guestBtn').dispatch('click');
await sleep(700);
const guestWho = registryEl('#who').innerHTML || '';
console.log(`  guest       → ${guestWho.replace(/<[^>]+>/g, '') || '(empty)'}`);
if (!/guest-\d+/.test(guestWho)) problems.push(`guest session did not load (got "${guestWho}")`);

await rollBtn.dispatch('click');
await sleep(1400);
if (!registryEl('#hudRolls').textContent || registryEl('#hudRolls').textContent === '0') {
  problems.push('guest could not roll');
}

// --- clean up the throwaway account ---------------------------------------------------
await realFetch(`${BASE}/api/delete`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

if (problems.length) {
  console.log('\n  ✖ client problems:');
  for (const p of [...new Set(problems)]) console.log(`    - ${p}`);
  process.exit(1);
}
console.log('\n  ✔ client booted, signed in, rolled, rendered every tab and played as a guest\n');
process.exit(0);
