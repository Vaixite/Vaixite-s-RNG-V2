// ---------------------------------------------------------------------------
// DOM helpers shared by every view. Kept free of game logic.
// ---------------------------------------------------------------------------

// "1,234,567" with compact suffixes for the absurd ones.
export function compact(n) {
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function trim(x) {
  return x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export const $ = (sel, root = document) => root.querySelector(sel);

export const el = document.createElement.bind(document);

/** Tiny hyperscript: h('div', { class: 'x' }, 'text', child) */
export function h(tag, props, ...kids) {
  const node = el(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// --- formatting ------------------------------------------------------------

export function fmt(n) {
  if (!Number.isFinite(n)) return '∞';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 2 : 1) + 'K';
  return compact(n);
}

export function fmtOdds(odds) {
  if (!Number.isFinite(odds)) return '1/∞';
  if (odds < 100000) return `1/${Math.round(odds).toLocaleString('en-US')}`;
  return `1/${compact(odds)}`;
}

export function fmtMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// --- toasts ----------------------------------------------------------------

const toastRoot = $('#toasts');

export function toast(message, kind = '', ttl = 3200) {
  const node = h('div', { class: `toast ${kind}` }, message);
  toastRoot.append(node);
  // Cap the stack so a burst of rolls cannot bury the UI.
  while (toastRoot.children.length > 5) toastRoot.firstChild.remove();
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, ttl);
}

// --- misc ------------------------------------------------------------------

/** Coalesce rapid-fire calls into one trailing call. */
export function debounce(fn, ms = 120) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function safeLocal(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
    return value;
  } catch {
    return null; // private mode / storage disabled — game still works
  }
}
