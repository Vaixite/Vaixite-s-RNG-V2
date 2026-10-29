import { h, clear, fmt, fmtOdds } from './dom.js';
import {
  upgradeCost,
  sellPrice,
  getAura,
  getItem,
  getGear,
  getSlot,
  getOre,
  resolveAura,
  specialShelf,
  buffLabel,
  buffIcon,
  buffRangeLabel,
  qualityChances,
  treeCost,
  treeEffectLabel,
  ascendPoints,
  clickerCost,
  clickerEffectLabel,
  sparkIcon,
} from './catalog.js';

// ---------------------------------------------------------------------------
// Right-hand panel views. Pure render: they read `state` and write DOM, and
// signal intent through the `actions` callbacks passed in by main.js.
// ---------------------------------------------------------------------------

/** fmt() rounds to whole numbers; small rates and per-click values should not. */
const num1 = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000) return fmt(v);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
};

export function renderInventory(root, state, actions) {
  clear(root);
  // Driven by the inventory, not by the catalog: an aura the host has deleted is
  // still in your bag, so it still gets a card — rendered from the snapshot the
  // slot carries. The Bestiary files those same auras under Special Auras.
  const owned = Object.entries(state.profile.inventory || {})
    .filter(([, slot]) => slot && slot.count > 0)
    .map(([id, slot]) => ({ aura: resolveAura(id, slot), slot }))
    .filter((row) => row.aura)
    .sort((a, b) => b.aura.odds - a.aura.odds);
  const items = Object.entries(state.profile.items || {}).filter(([, n]) => n > 0);

  // --- consumable items ----------------------------------------------------
  if (items.length) {
    root.append(h('h3', { class: 'section-title' }, 'Items'));
    const iGrid = h('div', { class: 'view-grid' });
    for (const [id, count] of items) {
      const item = getItem(id);
      if (!item) continue;
      iGrid.append(
        h(
          'div',
          { class: 'card item-card', style: { '--aura': '#ffd700' }, title: item.desc },
          h('div', { class: 'c-name' }, `${item.icon} ${item.name}`),
          h('div', { class: 'c-count' }, `×${fmt(count)}`),
          h('button', { class: 'mini-btn', onclick: () => actions.useItem(id) }, 'Use')
        )
      );
    }
    root.append(iGrid);
  }

  // --- auras -----------------------------------------------------------------
  // Same shelves as the Bestiary: the normal roll pool first, then the Special
  // shelf — crafted auras plus anything the host deleted after you owned it.
  const normal = owned.filter((row) => !row.aura.craftOnly && !row.aura.deleted);
  const special = owned.filter((row) => row.aura.craftOnly || row.aura.deleted);

  if (!owned.length) {
    root.append(h('h3', { class: 'section-title' }, 'Auras'));
    root.append(h('p', { class: 'muted small' }, 'No auras yet. Hit ROLL to get your first one.'));
    return;
  }

  const auraCard = ({ aura, slot }) => {
    const price = sellPrice(aura.odds);
    // The card advertises the aura's normal odds — the number the Bestiary shows
    // and the number the pool actually carries. The luck-bent odds a pull happened
    // to land at are a fact about that pull, not about the aura, so they live in
    // the tooltip and in the dossier one click away.
    const gotAt = Number(slot.lastOdds) || Number(slot.bestOdds) || 0;
    const best = Number(slot.bestOdds) || 0;
    return h(
      'div',
      {
        class:
          `card is-clickable${state.newAuras.has(aura.id) ? ' is-new' : ''}` +
          `${aura.craftOnly ? ' is-special' : ''}${aura.deleted ? ' is-deleted' : ''}`,
        style: { '--aura': aura.color },
        title:
          `${aura.tierName} · ${aura.deleted ? 'held' : 'rolled'} ${slot.count}×\n` +
          `normal odds ${fmtOdds(aura.odds)}\n` +
          `you got it at ${fmtOdds(gotAt)}` +
          (best > gotAt ? ` · best ${fmtOdds(best)}` : '') + '\n' +
          (aura.deleted ? 'removed from the game by the host — still yours, still sellable\n' : '') +
          'click for the full dossier',
        // The card body opens the dossier; the Sell button inside it sells.
        onclick: (e) => {
          if (!e.target.closest('button')) actions.auraInfo(aura.id);
        },
      },
      h('div', { class: 'c-name' }, aura.deleted ? `${aura.name} ⚠` : aura.name),
      h('div', { class: 'c-odds' }, fmtOdds(aura.odds)),
      h('div', { class: 'c-count' }, `×${fmt(slot.count)}`),
      h('button', { class: 'mini-btn sell', onclick: () => actions.sell(aura.id, 1), title: `Sell 1 for ${fmt(price)} money` }, `Sell 💰${fmt(price)}`)
    );
  };

  if (normal.length) {
    root.append(h('h3', { class: 'section-title' }, 'Normal Auras ', h('small', {}, `${normal.length}`)));
    const grid = h('div', { class: 'view-grid', style: { marginBottom: '1.1rem' } });
    for (const row of normal) grid.append(auraCard(row));
    root.append(grid);
  }
  if (special.length) {
    root.append(h('h3', { class: 'section-title' }, 'Special Auras ', h('small', {}, `${special.length}`)));
    root.append(
      h(
        'p',
        { class: 'muted small', style: { marginBottom: '0.5rem' } },
        'Crafted auras, and auras the host removed from the game — still yours, still sellable.'
      )
    );
    const grid = h('div', { class: 'view-grid', style: { marginBottom: '1.1rem' } });
    for (const row of special) grid.append(auraCard(row));
    root.append(grid);
  }
}

// --- bestiary ------------------------------------------------------------------
// Two shelves. "Auras" is the roll pool; "Special Auras" is everything crafted
// plus everything the host deleted after you had already rolled it.
//
// An aura you do not own stays a secret: the card keeps its colour and its 1-in-N
// but no name, and it is not clickable, so browsing the bestiary cannot be used
// to read the host's content file. Own one and the full dossier opens — including
// the special ones, which are locked like any other until you make or find one.

function bestiaryCard(aura, state, actions, { showTrue, special }) {
  const slot = state.profile.inventory?.[aura.id] || null;
  const live = state.oddsById[aura.id];
  // Infinity is the mirror's mark for "the luck floor removed this one": at
  // 4× luck the 1/2 Common simply cannot be rolled any more.
  const floored = !!live && !Number.isFinite(live.odds);
  const odds = showTrue && live ? live.odds : aura.odds;
  const oddsText = floored ? (showTrue ? '—' : '🔒 below luck') : fmtOdds(odds);
  const cls =
    `card${slot ? ' is-clickable' : ' is-locked'}${floored ? ' is-floored' : ''}` +
    `${special ? ' is-special' : ''}${aura.deleted ? ' is-deleted' : ''}`;
  const style = { '--aura': aura.color };

  if (!slot) {
    return h(
      'div',
      { class: cls, style, title: 'Not found yet — no dossier until you own it' },
      h('div', { class: 'c-name' }, '? ? ?'),
      h('div', { class: `c-odds${floored ? ' is-floored' : ''}` }, oddsText),
      h('div', { class: 'c-count' }, '—')
    );
  }

  const open = () => actions.auraInfo(aura.id);
  return h(
    'div',
    {
      class: cls,
      style,
      role: 'button',
      tabindex: '0',
      title: [
        aura.tierName,
        `owned ×${slot.count}`,
        floored ? 'below your luck — no longer rollable' : live?.isBT ? 'Breakthrough outside its biome' : null,
        special ? (aura.deleted ? 'removed from the game — kept here so you never lose it' : 'crafted — never rolled') : null,
        'click for the full dossier',
      ]
        .filter(Boolean)
        .join(' · '),
      onclick: open,
      // Enter/Space open the dossier; stop the bubble so the Space does not
      // also reach the window handler and burn a roll.
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        open();
      },
    },
    h('div', { class: 'c-name' }, aura.deleted ? `${aura.name} ⚠` : aura.name),
    h('div', { class: `c-odds${floored ? ' is-floored' : ''}` }, oddsText),
    h('div', { class: 'c-count' }, `×${fmt(slot.count)}`)
  );
}

function bestiaryShelf(root, state, actions, { title, note, list, special, showTrue }) {
  const found = list.filter((a) => state.profile.inventory?.[a.id]).length;
  root.append(h('h3', { class: 'section-title' }, `${title} `, h('small', {}, `${found}/${list.length}`)));
  root.append(h('p', { class: 'muted small', style: { marginBottom: '0.5rem' } }, note));
  if (!list.length) {
    root.append(h('p', { class: 'muted small', style: { marginBottom: '0.75rem' } }, 'Nothing here yet.'));
    return;
  }
  const grid = h('div', { class: 'view-grid', style: { marginBottom: '1.1rem' } });
  for (const aura of list) grid.append(bestiaryCard(aura, state, actions, { showTrue, special }));
  root.append(grid);
}

export function renderBestiary(root, state, actions) {
  clear(root);
  const showTrue = !!state.trueOdds;
  // Craft-only auras from the content file, plus any owned id the host has
  // since removed — the inventory slot remembers what it is.
  const shelf = specialShelf(state.profile.inventory || {});

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.5rem' } },
      showTrue
        ? 'True luck odds — the live 1-in-N after your luck, the biome and the luck floor. "—" means your luck has out-levelled the aura entirely. Switch the setting off to see the odds the host authored.'
        : 'Authored odds — what the host wrote, so a 1/2 stays a 1/2 no matter your luck. 🔒 marks an aura your luck has left behind: it cannot be rolled at all. ⚙ → "Show true luck odds" for the live numbers.',
    ),
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.75rem' } },
      'An aura you have not found is sealed — no name, nothing to click. Own one and its dossier opens: authored vs live odds, where it drops, what it sells for, and a replay of the cutscene it earns.'
    )
  );

  bestiaryShelf(root, state, actions, {
    title: 'Auras',
    note: 'The roll pool. Every aura here can drop on any roll, rarer ones first.',
    list: state.catalog.auras,
    special: false,
    showTrue,
  });
  bestiaryShelf(root, state, actions, {
    title: 'Special Auras',
    note: 'Crafted, never rolled — you will not find these in the pool. An aura the host deletes after you rolled it lands here too, so a collection is never lost: it stays in your inventory and still sells.',
    list: shelf,
    special: true,
    showTrue,
  });
}

export function renderCrafting(root, state, actions) {
  clear(root);
  const { profile } = state;
  const recipes = state.catalog.recipes || [];

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.5rem' } },
      'Combine auras (and items) into rarer ones, or forge equipment that carries several buffs at once. Crafting only costs the materials — money comes from selling duplicates and is spent in the Shop.'
    )
  );

  for (const recipe of recipes) {
    const moneyCost = recipe.money || 0;
    let canCraft = profile.money >= moneyCost;
    // A disabled button must say *why* — otherwise a player sitting on 4,000
    // uncommons with 0 money just sees "crafting is broken".
    const missing = [];
    if (!canCraft) missing.push(`💰${fmt(moneyCost)} (you have ${fmt(profile.money)})`);

    // One chip per input, showing how many you actually hold.
    const inputNodes = [];
    for (const inp of recipe.inputs || []) {
      const isAura = !!inp.aura;
      const def = isAura ? getAura(inp.aura) : getItem(inp.item);
      const have = isAura ? profile.inventory[inp.aura]?.count || 0 : profile.items[inp.item] || 0;
      const enough = have >= inp.count;
      const label = isAura ? def?.name || inp.aura : `${def?.icon || ''} ${def?.name || inp.item}`.trim();
      if (!enough) {
        canCraft = false;
        missing.push(`${inp.count}× ${label} (you have ${have})`);
      }
      inputNodes.push(
        h(
          'span',
          { class: `chip ${enough ? 'ok' : 'no'}`, title: `${have} held, ${inp.count} needed` },
          `${label} ${have}/${inp.count}`
        )
      );
    }

    const out = recipe.output;
    const piece = out.gear ? getGear(out.gear) : null;
    const outDef = out.aura ? getAura(out.aura) : piece || getItem(out.item);
    const outLabel = out.aura
      ? outDef?.name || out.aura
      : `${outDef?.icon || ''} ${outDef?.name || out.gear || out.item}`.trim();
    const outColor = out.aura ? outDef?.color || 'var(--text)' : 'var(--gold)';

    root.append(
      h(
        'div',
        { class: 'craft-row' },
        h('div', { class: 'craft-io' }, ...inputNodes),
        h('div', { class: 'craft-arrow' }, '→'),
        h('div', { class: 'craft-out' }, h('span', { class: 'chip', style: { color: outColor } }, `${outLabel}${out.count > 1 ? `×${out.count}` : ''}`)),
        // Recipes are materials-only by default; the cost column only appears
        // if a modded crafting.json puts a money price back on a recipe.
        moneyCost
          ? h(
              'div',
              {
                class: `craft-cost${profile.money < moneyCost ? ' short' : ''}`,
                title: profile.money < moneyCost ? `You have 💰${fmt(profile.money)}` : null,
              },
              `💰${fmt(moneyCost)}`
            )
          : null,
        h(
          'button',
          {
            class: 'buy-btn',
            disabled: !canCraft,
            title: canCraft ? 'Craft it' : `Needs ${missing.join(' · ')}`,
            onclick: () => actions.craft(recipe.id),
          },
          'Craft'
        )
      )
    );

    // Equipment is not a stack: the forge rolls its buffs fresh on every craft,
    // so the card spells out the pool and the quality odds before you pay.
    if (piece) root.append(gearRecipeNote(piece, out.qualities));
  }
}

// The expandable strip under a gear recipe: what can roll, and how often.
function gearRecipeNote(piece, qualities) {
  const chances = qualityChances(qualities);
  const bands = chances.map((c) => c.quality?.buffs || { min: 2, max: 3 });
  const minBuffs = Math.min(...bands.map((b) => b.min));
  const maxBuffs = Math.max(...bands.map((b) => b.max));
  const chanceText = chances
    .map((c) => `${c.quality?.name || c.id} ${c.pct < 10 ? c.pct.toFixed(1) : Math.round(c.pct)}%`)
    .join(' · ');

  return h(
    'div',
    { class: 'craft-gear' },
    h(
      'div',
      { class: 'cg-buffs' },
      ...(piece.buffs || []).map((b) =>
        h(
          'span',
          {
            class: `chip cg-buff${b.signature ? ' sig' : ''}`,
            title: b.signature
              ? 'Signature buff — always on the piece'
              : "Rolled from this piece's buff pool",
          },
          `${buffIcon(b.type)} ${buffRangeLabel(b.type, b.min, b.max)}${b.signature ? ' ★' : ''}`
        )
      )
    ),
    h('div', { class: 'cg-quality' }, `${piece.desc} Rolls ${minBuffs}–${maxBuffs} buffs · ${chanceText}`)
  );
}

export function renderShop(root, state, actions) {
  clear(root);
  const { profile } = state;
  const items = state.catalog.items || [];

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.5rem' } },
      'Spend money on consumables. Money comes from selling auras.'
    )
  );

  for (const item of items) {
    const afford = profile.money >= item.buyPrice;
    const owned = profile.items[item.id] || 0;
    root.append(
      h(
        'div',
        { class: 'upg' },
        h('div', { class: 'upg-icon' }, item.icon),
        h(
          'div',
          { class: 'upg-body' },
          h('strong', {}, item.name, owned ? h('span', { class: 'lvl' }, `×${owned}`) : null),
          h('p', {}, item.desc)
        ),
        h(
          'button',
          { class: 'buy-btn', disabled: !afford, onclick: () => actions.shopBuy(item.id) },
          `💰 ${fmt(item.buyPrice)}`
        )
      )
    );
  }
}

export function renderUpgrades(root, state, actions) {
  clear(root);
  const { profile } = state;

  for (const def of state.catalog.upgrades) {
    const level = profile.levels[def.id] || 0;
    const maxed = def.max > 0 && level >= def.max;
    const cost = upgradeCost(def, level);
    const afford = profile.essence >= cost;

    root.append(
      h(
        'div',
        { class: 'upg' },
        h('div', { class: 'upg-icon' }, def.icon),
        h(
          'div',
          { class: 'upg-body' },
          h('strong', {}, def.name, h('span', { class: 'lvl' }, maxed ? 'MAX' : `Lv ${level}`)),
          h('p', {}, def.desc)
        ),
        h(
          'button',
          {
            class: `buy-btn${maxed ? ' maxed' : ''}`,
            disabled: maxed || !afford,
            onclick: () => actions.buy(def.id),
          },
          maxed ? 'MAXED' : `💠 ${fmt(cost)}`
        )
      )
    );
  }

  const req = profile.ascendRequirement;
  const ready = profile.canAscend;
  const nextMult = 1 + (profile.ascensions + 1) * (state.catalog.ascend?.luckPerAscension ?? 0.75);
  const pts = ascendPoints(profile.essence);

  // Ascend Points are the tree's currency — say what ascending actually pays.
  if (profile.treeUnlocked) {
    root.append(
      h(
        'p',
        { class: 'asc-points', title: 'Ascend Points are permanent. The tree survives every ascension.' },
        h('b', {}, `✦ ${fmt(profile.ascendPoints || 0)}`),
        ' Ascend Points — spend them in the Tree.'
      )
    );
  }

  root.append(
    h(
      'button',
      {
        class: 'ascend-btn',
        disabled: !ready,
        onclick: () => actions.ascend(),
        title: 'Resets levels and essence. Your collection, money, records and the Ascend Tree are kept.',
      },
      ready
        ? `✦ ASCEND → ${nextMult.toFixed(2)}× LUCK`
        : `Ascend at ${fmt(req)} rolls (${fmt(profile.totalRolls)}/${fmt(req)})`,
      ready
        ? h('span', { class: 'ascend-sub' }, `+${fmt(pts)} ✦ from your 💠${fmt(profile.essence)} essence · 💰 money is kept`)
        : h('span', { class: 'ascend-sub' }, `Ascend burns essence into ✦ points — save up · 💰 money is kept`)
    )
  );
}

export function renderLeaderboard(root, state, actions) {
  clear(root);
  const board = state.board;

  if (!board) {
    root.append(h('p', { class: 'muted small' }, 'Loading the board…'));
    return;
  }

  const sort = board.sort || 'best';
  const rows = board.rows || [];

  // One button per column the board can rank by — the server advertises the
  // list, so adding a column in game.js needs no change here.
  if ((board.sorts || []).length) {
    root.append(
      h(
        'div',
        { class: 'lb-sorts' },
        ...board.sorts.map((s) =>
          h(
            'button',
            {
              class: `sort-btn${s.id === sort ? ' is-active' : ''}`,
              title: `Rank by ${s.name}`,
              onclick: () => actions.lbSort(s.id),
            },
            `${s.icon} ${s.name}`
          )
        )
      )
    );
  }

  if (!rows.length) {
    root.append(h('p', { class: 'muted small' }, 'Nobody on the board yet. Roll something rare.'));
  } else {
    rows.forEach((row, i) => root.append(lbRow(row, i + 1, state, sort)));
  }

  // Off the top slice? Your own row still gets shown, with its real rank.
  if (board.you && !board.you.inTop) {
    root.append(h('div', { class: 'lb-gap' }, '· · ·'));
    root.append(lbRow(board.you.row, board.you.rank, state, sort, true));
  }

  root.append(
    h(
      'button',
      { class: 'ghost-btn', style: { marginTop: '0.5rem' }, onclick: () => actions.refreshBoard() },
      '↻ Refresh'
    )
  );
  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginTop: '0.4rem' } },
      `${board.total || rows.length} player${board.total === 1 ? '' : 's'} on the global board — accounts and guests, ranked live.`
    )
  );
}

// One ranked row. The right-hand cell is whatever the current sort measures.
function lbRow(row, rank, state, sort, isYou = false) {
  const aura = row.bestAuraId ? state.auraById[row.bestAuraId] : null;
  const cells = {
    rolls: `${fmt(row.totalRolls)} rolls`,
    unique: `${row.unique}/${row.totalAuras} auras`,
    luck: `${Number(row.luck || 1).toFixed(2)}× luck`,
    essence: `💠 ${fmt(row.essence)}`,
    money: `💰 ${fmt(row.money)}`,
    ascend: `✦ ${row.ascensions} ascension${row.ascensions === 1 ? '' : 's'}`,
    gear: `🧤 ${row.gear} piece${row.gear === 1 ? '' : 's'}`,
    ach: `🏆 ${row.achUnlocked || 0} badges · ${fmt(row.achPoints || 0)} pts`,
  };
  const mine = row.id === state.profile?.id;
  return h(
    'div',
    { class: `lb-row${mine ? ' me' : ''}${isYou ? ' you' : ''}${rank === 1 ? ' top' : ''}` },
    h('div', { class: 'lb-rank' }, rank),
    h(
      'div',
      { class: 'lb-name' },
      row.name,
      row.guest ? h('span', { class: 'guest-tag' }, 'guest') : null,
      h('small', {}, `${fmt(row.totalRolls)} rolls · ${row.unique}/${row.totalAuras}`)
    ),
    h(
      'div',
      { class: 'lb-best', style: sort === 'best' && aura ? { color: aura.color } : null },
      sort === 'best' ? (aura ? `${aura.name} ${fmtOdds(row.bestOdds)}` : '—') : cells[sort]
    )
  );
}

// --- achievements -------------------------------------------------------------------
// The board is measured server-side (GET /api/achievements); this is pure
// drawing. Every number on screen arrives already measured and already turned
// into a bar fraction, so a metric the server invents tomorrow needs nothing
// here beyond a `fmt` case below.
const achNum = (row, v) => {
  const n = Number(v) || 0;
  if (row.fmt === 'odds') return fmtOdds(n);
  if (row.fmt === 'mult') return `${fmt(n)}×`;
  if (row.fmt === 'ms') return `${fmt(n)} ms`;
  if (row.fmt === 'money') return `💰 ${fmt(n)}`;
  if (row.fmt === 'essence') return `💠 ${fmt(n)}`;
  return fmt(n);
};

function achReward(row) {
  const r = row.reward;
  if (!r) return null;
  const bits = [];
  if (r.money) bits.push(`💰 ${fmt(r.money)}`);
  if (r.essence) bits.push(`💠 ${fmt(r.essence)}`);
  return bits.length ? bits.join(' + ') : null;
}

function achCard(row) {
  const reward = achReward(row);
  // A `below` badge reads the other way round: the number you have is the one
  // you are trying to get under, so printing "1,100 ms / 300 ms" would look
  // like it was already won.
  const measure = row.below
    ? `${achNum(row, row.raw)} → under ${achNum(row, row.target)}`
    : `${achNum(row, row.value)} / ${achNum(row, row.target)}`;
  const pct = Math.round(Math.max(0, Math.min(1, Number(row.pct) || 0)) * 100);

  return h(
    'div',
    {
      class: `ach-card${row.done ? ' is-done' : ' is-locked'}`,
      style: { '--tier': row.color, '--tier-glow': row.glow || row.color },
      title: row.done && row.at ? `Unlocked ${new Date(row.at).toLocaleString()}` : row.desc,
    },
    h('div', { class: 'ach-icon' }, row.done ? row.icon : '🔒'),
    h(
      'div',
      { class: 'ach-body' },
      h(
        'div',
        { class: 'ach-top' },
        h('span', { class: 'ach-name' }, row.name),
        h('span', { class: 'ach-pts' }, `${row.points} pt${row.points === 1 ? '' : 's'}`)
      ),
      h('div', { class: 'ach-desc' }, row.desc),
      h(
        'div',
        { class: 'ach-bar' },
        h('i', { style: { width: `${pct}%` } })
      ),
      h(
        'div',
        { class: 'ach-foot' },
        h('span', { class: 'ach-measure' }, row.done ? '✓ Done' : measure),
        reward ? h('span', { class: 'ach-reward' }, row.done ? `reward paid ${reward}` : `reward ${reward}`) : null
      )
    )
  );
}

export function renderAchievements(root, state, actions) {
  clear(root);
  const data = state.achievements;
  if (!data) {
    root.append(h('p', { class: 'muted small' }, 'Measuring your badges…'));
    return;
  }

  const rows = data.rows || [];
  const tiers = state.catalog.achievementTiers || [];
  const group = state.achGroup || 'tier';

  // --- score --------------------------------------------------------------
  const pct = data.pointsTotal ? Math.min(1, (data.points || 0) / data.pointsTotal) : 0;
  root.append(
    h(
      'div',
      { class: 'ach-head' },
      h(
        'div',
        { class: 'ach-score' },
        h('b', {}, `🏆 ${data.unlocked} / ${data.total}`),
        h('span', { class: 'muted small' }, 'badges unlocked')
      ),
      h(
        'div',
        { class: 'progress-wrap' },
        h(
          'div',
          { class: 'progress-head' },
          h('span', {}, `${fmt(data.points || 0)} / ${fmt(data.pointsTotal || 0)} Achievement Points`),
          h('span', { class: 'muted' }, `${Math.round(pct * 100)}%`)
        ),
        h('div', { class: 'progress ach-total' }, h('i', { style: { width: `${pct * 100}%` } }))
      )
    )
  );

  root.append(
    h(
      'div',
      { class: 'lb-sorts' },
      h(
        'button',
        { class: `sort-btn${group === 'tier' ? ' is-active' : ''}`, onclick: () => actions.achGroup('tier') },
        '📚 By tier'
      ),
      h(
        'button',
        { class: `sort-btn${group === 'near' ? ' is-active' : ''}`, onclick: () => actions.achGroup('near') },
        '🎯 Closest first'
      ),
      h(
        'button',
        {
          class: `sort-btn${state.achHideDone ? ' is-active' : ''}`,
          title: 'Hide the badges you already have',
          onclick: () => actions.achToggleDone(),
        },
        '✓ Hide earned'
      ),
      h('button', { class: 'sort-btn', onclick: () => actions.refreshAchievements() }, '↻ Refresh')
    )
  );

  const visible = state.achHideDone ? rows.filter((r) => !r.done) : rows;
  if (!visible.length) {
    root.append(h('p', { class: 'muted small' }, 'Every badge on the board is yours. What else is there to do?'));
    return;
  }

  if (group === 'near') {
    // Nearest first, and the ones already won sink to the bottom.
    const ordered = [...visible].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (Number(b.pct) || 0) - (Number(a.pct) || 0);
    });
    root.append(h('div', { class: 'ach-grid' }, ...ordered.map(achCard)));
    root.append(
      h(
        'p',
        { class: 'muted small', style: { marginTop: '0.5rem' } },
        'Sorted by how close the bar is to full — a badge you already own still reads 100%, so they wait at the bottom.'
      )
    );
    return;
  }

  // Grouped by tier, weakest first, in the order content/achievements.json
  // lists them — the file owns the order, this just follows it.
  const byTier = new Map(tiers.map((t) => [t.id, []]));
  for (const r of visible) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, []);
    byTier.get(r.tier).push(r);
  }
  for (const [tierId, list] of byTier) {
    if (!list.length) continue;
    const tier = tiers.find((t) => t.id === tierId) || {};
    const all = rows.filter((r) => r.tier === tierId);
    const got = all.filter((r) => r.done).length;
    const pts = all.reduce((s, r) => s + (r.points || 0), 0);
    const earned = all.reduce((s, r) => s + (r.done ? r.points || 0 : 0), 0);
    root.append(
      h(
        'h3',
        { class: 'section-title ach-tier-title', style: { '--tier': tier.color || 'var(--accent)' } },
        `${tier.icon || '🏅'} ${tier.name || tierId}`,
        h('small', {}, `${got}/${all.length} · ${fmt(earned)}/${fmt(pts)} pts`)
      )
    );
    root.append(h('div', { class: 'ach-grid' }, ...list.map(achCard)));
  }

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginTop: '0.6rem' } },
      'Badges never lock again — ascending, selling and spending cannot take one back. Rewards are paid the moment a badge lands.'
    )
  );
}

// --- equipment ----------------------------------------------------------------------
// Crafted gear is a pile of unique instances, so this view is a bag of cards and
// not a count: each one shows the buffs *that* piece rolled.
export function renderGear(root, state, actions) {
  clear(root);
  const { profile } = state;
  const slots = state.catalog.gearSlots || [];
  const owned = profile.gear || [];
  const equipped = profile.equipped || {};
  const byUid = Object.fromEntries(owned.map((g) => [g.uid, g]));

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.5rem' } },
      'Every craft rolls its own buffs, so two Luck Gloves are never the same glove. One piece per slot — the buffs add up across slots.'
    )
  );

  // --- what is worn, and what the whole set adds up to ----------------------
  root.append(h('h3', { class: 'section-title' }, 'Equipped'));
  const slotRow = h('div', { class: 'slot-row' });
  for (const slot of slots) {
    const g = byUid[equipped[slot.id]];
    slotRow.append(
      h(
        'div',
        {
          class: `slot${g ? ' filled' : ''}`,
          style: { '--aura': g?.quality?.color || 'var(--line)' },
          title: g ? `${g.name} · ${g.quality?.name || ''}` : `${slot.name} — nothing worn`,
        },
        h('div', { class: 'slot-icon' }, slot.icon),
        h('div', { class: 'slot-name' }, g ? g.name : 'empty'),
        h('div', { class: 'slot-sub' }, g ? g.quality?.name || '' : slot.name)
      )
    );
  }
  root.append(slotRow);

  const totals = profile.stats?.gear || {};
  const bonusChips = Object.entries(totals)
    .filter(([, v]) => Number(v) > 0)
    .map(([type, value]) => h('span', { class: 'chip ok' }, `${buffIcon(type)} ${buffLabel(type, value)}`));

  root.append(
    bonusChips.length
      ? h('div', { class: 'gear-totals' }, h('span', { class: 'gt-label' }, 'Set bonus'), ...bonusChips)
      : h('p', { class: 'muted small' }, 'Nothing equipped — craft a piece and it drops into an empty slot by itself.')
  );

  // --- the bag ---------------------------------------------------------------
  root.append(h('h3', { class: 'section-title' }, `Gear bag · ${owned.length}`));
  if (!owned.length) {
    root.append(
      h('p', { class: 'muted small' }, 'Empty. The Crafting tab has the Luck Glove, the Speed Gauntlet and friends.')
    );
    return;
  }

  const order = (state.catalog.gearQualities || []).map((q) => q.id);
  const rank = (g) => order.indexOf(g.quality?.id);
  const sorted = [...owned].sort(
    (a, b) =>
      (b.equipped ? 1 : 0) - (a.equipped ? 1 : 0) ||
      rank(b) - rank(a) ||
      (b.value || 0) - (a.value || 0)
  );

  const grid = h('div', { class: 'gear-grid' });
  for (const g of sorted) {
    grid.append(
      h(
        'div',
        {
          class: `card gear-card${g.equipped ? ' is-worn' : ''}`,
          style: { '--aura': g.quality?.color || '#8b95ad' },
          title: g.desc,
        },
        h(
          'div',
          { class: 'gc-head' },
          h('span', { class: 'gc-icon' }, g.icon),
          h(
            'div',
            { class: 'gc-title' },
            h('div', { class: 'c-name' }, g.name),
            h(
              'div',
              { class: 'gc-quality', style: { color: g.quality?.color } },
              `${g.quality?.name || '?'} · ${(getSlot(g.slot) || {}).name || g.slot}`
            )
          )
        ),
        h(
          'ul',
          { class: 'gc-buffs' },
          ...(g.buffs || []).map((b) =>
            h(
              'li',
              { class: b.signature ? 'sig' : '', title: b.signature ? 'Signature buff' : null },
              `${b.icon} ${b.label}${b.signature ? ' ★' : ''}`
            )
          )
        ),
        h(
          'div',
          { class: 'gc-foot' },
          h('span', { class: 'gc-value', title: 'What salvaging this piece is worth' }, `💰${fmt(g.value || 0)}`),
          h(
            'button',
            {
              class: 'mini-btn',
              onclick: () => (g.equipped ? actions.unequipGear(g.uid) : actions.equipGear(g.uid)),
            },
            g.equipped ? 'Unequip' : 'Equip'
          ),
          h('button', { class: 'mini-btn sell', onclick: () => actions.salvageGear(g) }, 'Salvage')
        )
      )
    );
  }
  root.append(grid);
}

// --- mining shaft ----------------------------------------------------------------
// A 12-cell vein rolled server-side. The client only ever asks for one cell at a
// time; the pick cooldown is the server's (429 + retryInMs), mirrored here just
// long enough to stop the rocks from being clickable while the pick swings.
export function renderMining(root, state, actions) {
  clear(root);
  const { profile } = state;
  const cfg = state.catalog.mining || {};
  const ores = state.catalog.miningOres || [];
  const vein = profile.mining?.vein || null;
  const cells = Math.max(1, Number(cfg.grid?.cells) || vein?.length || 12);
  const revealed = profile.mining?.revealed || [];
  const dug = revealed.filter(Boolean).length;
  const depleted = !!vein && dug >= cells;
  const cooling = (state.mineLockUntil || 0) > Date.now();

  root.append(
    h(
      'div',
      { class: 'mine-head' },
      h(
        'div',
        { class: 'mh-text' },
        h('h3', { class: 'section-title' }, '⛏ Mining Shaft'),
        h(
          'p',
          { class: 'muted small' },
          vein
            ? `${dug}/${cells} cells dug · the shaft has its own RNG — luck does not touch it.`
            : 'No vein exposed yet. One swing opens the shaft.'
        )
      ),
      h(
        'button',
        {
          class: `ghost-btn mine-dig${depleted ? ' is-pulse' : ''}`,
          disabled: !vein,
          onclick: () => actions.mineReset(),
          title: vein
            ? 'Abandon what is left and roll a fresh 12-cell vein.'
            : 'Roll your first vein.',
        },
        '⛏ Dig New Vein'
      )
    )
  );

  if (!vein) {
    root.append(
      h(
        'div',
        { class: 'mine-start' },
        h('div', { class: 'ms-icon' }, '🪨'),
        h(
          'p',
          { class: 'muted small' },
          'Twelve cells of hidden ore. Every cell you dig pays money and essence — the rarer the ore, the more of both.'
        ),
        h('button', { class: 'buy-btn mine-open', onclick: () => actions.mineReset() }, '⛏ Open the Shaft')
      )
    );
  } else {
    const grid = h('div', { class: 'mine-grid' });
    for (let i = 0; i < cells; i++) {
      if (revealed[i]) {
        const ore = getOre(vein[i]) || { name: vein[i], icon: '•', color: '#8b95ad', money: 0, essence: 0, odds: 1 };
        grid.append(
          h(
            'div',
            {
              class: 'mine-cell is-ore',
              style: { '--ore': ore.color },
              title: `${ore.name} · ${fmtOdds(ore.odds)} in a vein`,
            },
            h('div', { class: 'mc-icon' }, ore.icon),
            h('div', { class: 'mc-name' }, ore.name),
            h('div', { class: 'mc-pay' }, `+💰${fmt(ore.money)} +💠${fmt(ore.essence)}`)
          )
        );
      } else {
        grid.append(
          h(
            'button',
            {
              class: 'mine-cell is-rock',
              disabled: cooling || depleted,
              onclick: () => actions.mineReveal(i),
              title: cooling ? 'The pick is still swinging…' : 'Dig here',
            },
            '🪨'
          )
        );
      }
    }
    root.append(grid);

    if (depleted) {
      root.append(h('div', { class: 'mine-banner' }, '✨ Vein depleted — every cell is out. Dig a new one.'));
    }
  }

  // --- auto drill -------------------------------------------------------------
  // Bought on the Ascend Tree (Auto Drill), so this strip only exists once a
  // level of it has been paid for. The switch itself is a client preference:
  // the server turns real elapsed time into cells, so leaving it on and walking
  // away earns the same as watching it — and spamming the route earns nothing.
  const drillRate = Number(profile.stats?.autoMinePerSec) || 0;
  if (drillRate > 0) {
    const on = !!state.autoMine;
    root.append(
      h(
        'div',
        { class: `drill-strip${on ? ' is-on' : ''}` },
        h('div', { class: 'ds-icon' }, '🦾'),
        h(
          'div',
          { class: 'ds-text' },
          h('strong', {}, `Auto Drill · ${num1(drillRate)} cells/s`),
          h(
            'p',
            { class: 'muted small' },
            on
              ? 'Running — it opens the next vein by itself when this one runs dry.'
              : 'Idle. Flip it on and the shaft digs itself while you roll somewhere else.'
          )
        ),
        h(
          'label',
          { class: 'ds-switch', title: 'Remembered on this device.' },
          h('input', {
            type: 'checkbox',
            checked: on,
            onchange: (e) => actions.toggleAutoMine(e.target.checked),
          }),
          h('span', {}, on ? 'RUNNING' : 'OFF')
        )
      )
    );
  }

  root.append(h('h3', { class: 'section-title' }, 'Ore Table'));
  const table = h('div', { class: 'ore-table' });
  for (const ore of ores) {
    table.append(
      h(
        'div',
        { class: 'ore-row', style: { '--ore': ore.color } },
        h('span', { class: 'or-icon' }, ore.icon),
        h('span', { class: 'or-name' }, ore.name),
        h('span', { class: 'or-odds' }, fmtOdds(ore.odds)),
        h('span', { class: 'or-pay' }, `💰${fmt(ore.money)}`),
        h('span', { class: 'or-pay' }, `💠${fmt(ore.essence)}`)
      )
    );
  }
  root.append(table);
}

// --- spark clicker ----------------------------------------------------------------
// Its own minigame with its own content file: content/clicker.json decides the
// currency, the crit rules, the auto-click pacing and every row of the shop, in
// the order they are drawn here. Nothing about the shop is hardcoded, so adding
// an upgrade is a JSON edit and a reload.
//
// The half of the shop that matters pays back into the real game — Luck and Roll
// Speed are applied in deriveStats exactly like the Ascend Tree, so a clicker
// upgrade shows up on every roll from here on.
export function renderClicker(root, state, actions) {
  clear(root);
  const { profile } = state;
  const cfg = state.catalog.clicker || {};
  const cur = cfg.currency || { name: 'Sparks', icon: '⚡' };
  const cname = cur.name || 'Sparks';
  const icon = sparkIcon();
  const c = profile.clicker || {};
  const gifts = profile.stats?.clicker || {};
  const upgrades = state.catalog.clickerUpgrades || [];
  const sparks = Number(c.sparks) || 0;
  const perClick = Number(c.perClick) || 1;
  const perTap = Math.max(1, Number(c.clicksPerClick) || 1);
  const critChance = Number(c.critChance) || 0;
  const critMult = Number(c.critMult) || 0;
  const autoRate = Number(c.autoClickPerSec) || 0;

  if (!profile.clickerUnlocked) {
    root.append(
      h(
        'div',
        { class: 'clk-locked' },
        h('div', { class: 'cl-icon' }, '🕹'),
        h('h3', { class: 'section-title' }, 'Arcade Cabinet'),
        h(
          'p',
          { class: 'muted small' },
          'This machine is unplugged. Buy the 🕹 Arcade Cabinet node on the Ascend Tree and it powers on.'
        )
      )
    );
    return;
  }

  // --- purse ------------------------------------------------------------------
  const sparksNum = h('strong', { class: 'cp-num' }, fmt(sparks));
  const lifeNum = h('span', { class: 'cl-val' }, fmt(Number(c.totalSparks) || 0));
  root.append(
    h(
      'div',
      { class: 'clk-head' },
      h(
        'div',
        { class: 'mh-text' },
        h('h3', { class: 'section-title' }, `🕹 ${cname} Clicker`),
        h('p', { class: 'muted small' }, 'Click for Sparks, spend Sparks — on the machine and on the real game.')
      ),
      h('div', { class: 'clk-purse' }, sparksNum, h('span', { class: 'cp-sub' }, `${icon} ${cname}`))
    )
  );

  // --- the button ---------------------------------------------------------------
  const tapBits = [];
  if (perTap > 1) tapBits.push(`${perTap} clicks per tap`);
  if (critChance > 0) tapBits.push(`${Math.round(critChance * 1000) / 10}% crit ×${num1(critMult)}`);
  root.append(
    h(
      'button',
      {
        class: 'clk-big',
        onclick: (e) => actions.clickTap(e),
        title: 'One tap resolves every click the machine is worth.',
      },
      h('span', { class: 'cb-icon' }, icon),
      h('span', { class: 'cb-main' }, `+${num1(perClick * perTap)} ${cname}`),
      h('span', { class: 'cb-sub' }, tapBits.join(' · ') || 'click')
    )
  );

  // --- the machine's own auto clicker -------------------------------------------
  if (autoRate > 0) {
    const on = !!state.autoClick;
    root.append(
      h(
        'div',
        { class: `drill-strip clk-auto${on ? ' is-on' : ''}` },
        h('div', { class: 'ds-icon' }, '🤖'),
        h(
          'div',
          { class: 'ds-text' },
          h('strong', {}, `Auto Clicker · ${num1(autoRate)} ${cname.toLowerCase()}/s`),
          h(
            'p',
            { class: 'muted small' },
            on ? 'Running in the background — it keeps earning while you are on another tab.' : 'Idle. Flip it on to earn while you roll.'
          )
        ),
        h(
          'label',
          { class: 'ds-switch', title: 'Remembered on this device.' },
          h('input', {
            type: 'checkbox',
            checked: on,
            onchange: (e) => actions.toggleAutoClick(e.target.checked),
          }),
          h('span', {}, on ? 'RUNNING' : 'OFF')
        )
      )
    );
  }

  // --- lifetime ------------------------------------------------------------------
  root.append(
    h(
      'div',
      { class: 'clk-life' },
      h('span', { class: 'cl-item' }, 'Earned ', lifeNum),
      h('span', { class: 'cl-item' }, `Clicked ${fmt(Number(c.totalClicks) || 0)}`),
      h('span', { class: 'cl-item' }, `Best click ${fmt(Number(c.bestClick) || 0)}`)
    )
  );

  // --- what it pays back ---------------------------------------------------------
  const pct = (v) => Math.round(((Number(v) || 1) - 1) * 1000) / 10;
  const giftRows = [
    { icon: '🍀', name: 'Luck', text: `+${pct(gifts.luck)}%`, on: pct(gifts.luck) > 0 },
    {
      icon: '⏱',
      name: 'Roll Cooldown',
      text: `−${Math.round((1 - (Number(gifts.cooldown) || 1)) * 1000) / 10}%`,
      on: (Number(gifts.cooldown) || 1) < 0.999,
    },
    { icon: '💠', name: 'Essence', text: `+${pct(gifts.essence)}%`, on: pct(gifts.essence) > 0 },
    { icon: '💰', name: 'Sell Price', text: `+${pct(gifts.sell)}%`, on: pct(gifts.sell) > 0 },
    { icon: '⛏', name: 'Mining Pay', text: `+${pct(gifts.mine)}%`, on: pct(gifts.mine) > 0 },
  ];
  root.append(h('h3', { class: 'section-title' }, 'Pays Back Into The Game'));
  const giftBox = h('div', { class: 'clk-gifts' });
  for (const g of giftRows) {
    giftBox.append(
      h(
        'div',
        { class: `clk-gift${g.on ? ' is-on' : ''}`, title: g.name },
        h('span', { class: 'cg-icon' }, g.icon),
        h('span', { class: 'cg-name' }, g.name),
        h('b', { class: 'cg-val' }, g.text)
      )
    );
  }
  root.append(giftBox);

  // --- shop ----------------------------------------------------------------------
  root.append(h('h3', { class: 'section-title' }, 'Arcade Upgrades'));
  const shop = h('div', { class: 'clk-shop' });
  const cards = new Map();
  for (const def of upgrades) {
    const level = Number(c.levels?.[def.id]) || 0;
    const maxed = def.max > 0 && level >= def.max;
    const cost = clickerCost(def, level);
    const afford = sparks >= cost;
    let eff = `${clickerEffectLabel(def.effect, 1)} per level`;
    if (level > 0) eff += ` · now ${clickerEffectLabel(def.effect, level)}`;
    if (!(def.max > 0)) eff += ' · no cap';

    const lvl = h('span', { class: 'lvl' }, maxed ? 'MAX' : `Lv ${level}`);
    const btn = h(
      'button',
      {
        class: `buy-btn${maxed ? ' maxed' : ''}`,
        disabled: maxed || !afford,
        onclick: () => actions.clickBuy(def.id),
        title: maxed ? 'Already at the top of this one.' : `Buy for ${fmt(cost)} ${cname}`,
      },
      maxed ? 'MAXED' : `${icon} ${fmt(cost)}`
    );
    cards.set(def.id, { btn, lvl, def });
    shop.append(
      h(
        'div',
        { class: 'upg' },
        h('div', { class: 'upg-icon' }, def.icon || icon),
        h(
          'div',
          { class: 'upg-body' },
          h('strong', {}, def.name || def.id, lvl),
          h('p', {}, def.desc || ''),
          h('p', { class: 'clk-eff' }, eff)
        ),
        btn
      )
    );
  }
  root.append(shop);
  root.append(
    h(
      'p',
      { class: 'muted small clk-note' },
      'Sparks and upgrades are permanent — ascending does not touch them. The whole shop is data: edit content/clicker.json and reload.'
    )
  );

  // Auto clicks land about once a second. Repainting the panel that often would
  // eat a tap in flight, so main.js writes the moving numbers into these nodes.
  root.__clicker = { sparks: sparksNum, life: lifeNum, cards };
}

// --- ascend tree ---------------------------------------------------------------------
// Drawn into the full-screen overlay, not the side panel: a 13-node constellation
// needs a canvas, not a sidebar. Coordinates are the 0-100 percentages the content
// file ships (y = 88 is the bottom of the tree, y = 12 the top).
const SVG_NS = 'http://www.w3.org/2000/svg';

export function renderTreeCanvas(canvas, tip, state, actions) {
  clear(canvas);
  const nodes = state.catalog.tree || [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const levels = state.profile?.tree || {};
  const points = state.profile?.ascendPoints || 0;

  const hideTip = () => {
    tip.classList.remove('is-on');
    tip.setAttribute('aria-hidden', 'true');
  };

  // Prerequisite lines sit behind the nodes. The viewBox is the same 0-100 space
  // the nodes are positioned in, so a line is just two node coordinates.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'tree-links');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  for (const n of nodes) {
    for (const req of n.requires || []) {
      const from = byId[req];
      if (!from) continue;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(from.x));
      line.setAttribute('y1', String(from.y));
      line.setAttribute('x2', String(n.x));
      line.setAttribute('y2', String(n.y));
      line.setAttribute('class', `tree-link${(levels[req] || 0) > 0 && (levels[n.id] || 0) > 0 ? ' is-lit' : ''}`);
      svg.append(line);
    }
  }
  canvas.append(svg);

  for (const n of nodes) {
    const level = levels[n.id] || 0;
    const maxed = n.maxLevel > 0 && level >= n.maxLevel;
    const open = (n.requires || []).every((r) => (levels[r] || 0) > 0);
    const cost = treeCost(n, level);
    const afford = points >= cost;

    let mood = 'is-dim';
    if (!open) mood = 'is-locked';
    else if (maxed) mood = 'is-maxed';
    else if (level > 0) mood = afford ? 'is-owned is-afford' : 'is-owned';
    else if (afford) mood = 'is-afford';

    const btn = h(
      'button',
      {
        class: `tnode ${mood}`,
        style: { left: `${n.x}%`, top: `${n.y}%` },
        disabled: !open || maxed,
        'aria-label': `${n.name} — level ${level} of ${n.maxLevel}`,
        onclick: () => actions.buyNode(n.id),
      },
      h('span', { class: 'tn-icon' }, n.icon),
      h('span', { class: 'tn-lvl' }, maxed ? 'MAX' : `${level}/${n.maxLevel}`),
      !maxed && open ? h('span', { class: 'tn-cost' }, `✦${fmt(cost)}`) : null,
      h('span', { class: 'tn-lock' }, '🔒')
    );

    const showTip = () => {
      const single = n.maxLevel === 1 || n.effect?.type === 'unlock';
      const effect = single
        ? treeEffectLabel(n, 1)
        : `${treeEffectLabel(n, 1)} per level${level ? ` — currently ${treeEffectLabel(n, level)}` : ''}`;
      const missing = (n.requires || [])
        .filter((r) => (levels[r] || 0) < 1)
        .map((r) => byId[r]?.name || r);

      clear(tip);
      tip.append(
        h('div', { class: 'tt-head' }, h('span', { class: 'tt-icon' }, n.icon), h('b', {}, n.name)),
        h('p', { class: 'tt-desc' }, n.desc),
        h('div', { class: 'tt-eff' }, effect),
        maxed
          ? h('div', { class: 'tt-max' }, 'Fully upgraded')
          : h('div', { class: `tt-cost${afford ? '' : ' is-bad'}` }, `✦ ${fmt(cost)} → Lv ${level + 1}`),
        missing.length ? h('div', { class: 'tt-req' }, `Requires ${missing.join(' · ')}`) : null,
        h('div', { class: 'tt-pts' }, `✦ ${fmt(points)} available`)
      );
      const r = btn.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(r.left + r.width / 2, 150), innerWidth - 150)}px`;
      tip.style.top = `${Math.max(104, r.top - 12)}px`;
      tip.classList.add('is-on');
      tip.setAttribute('aria-hidden', 'false');
    };

    btn.addEventListener('mouseenter', showTip);
    btn.addEventListener('focus', showTip);
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('blur', hideTip);
    canvas.append(btn);
  }
}

// --- admin panel ---------------------------------------------------------------
// Rendered only when the server said `profile.isAdmin`, but that flag is a
// courtesy: every control below re-asks the server, so a name removed from
// admins.json starts collecting 403s on the very next click.
//
// Values typed into the fields live in `state.admin.form`, not in the DOM, so a
// re-render after an action never throws away what you were typing.

function adminSection(title, hint, ...kids) {
  return h(
    'div',
    { class: 'admin-card' },
    h('h3', { class: 'section-title' }, title),
    hint ? h('p', { class: 'muted small' }, hint) : null,
    ...kids
  );
}

function adminRow(...kids) {
  return h('div', { class: 'admin-row' }, ...kids);
}

function adminBtn(label, onclick, { kind = '', title = '', disabled = false } = {}) {
  return h(
    'button',
    { class: `mini-btn${kind ? ` ${kind}` : ''}`, title, disabled, onclick },
    label
  );
}

// Both controls bind to the panel's own scratch space: `a` is state.admin, not
// state, because that is what every call site in renderAdmin has to hand.
function adminField(a, key, props = {}) {
  const form = a.form;
  const node = h('input', { class: 'admin-input', ...props, value: form[key] ?? props.value ?? '' });
  node.addEventListener('input', () => {
    form[key] = node.value;
  });
  return node;
}

function adminPick(a, key, options, props = {}) {
  const form = a.form;
  const node = h('select', { class: 'admin-input', ...props });
  for (const o of options) node.append(h('option', { value: o.value }, o.label));
  const value = form[key] ?? options[0]?.value ?? '';
  node.value = value;
  form[key] = value;
  node.addEventListener('change', () => {
    form[key] = node.value;
  });
  return node;
}

const adminNum = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));

export function renderAdmin(root, state, actions) {
  clear(root);
  state.admin ||= { players: [], detail: null, server: null, admins: [], audit: [], form: {} };
  const a = state.admin;
  const run = (action, body) => actions.adminCall(action, body);
  const target = () => a.detail?.name || a.form.target || '';

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.6rem' } },
      'Server powers, applied by the server to the account you name. Who may open this panel lives in admins.json on the machine — take a name out and the panel stops working on that player’s next click.'
    )
  );

  // --- server ------------------------------------------------------------------
  const s = a.server;
  root.append(
    adminSection(
      'Server',
      `admins.json → ${a.adminsFile || 'admins.json'}`,
      h(
        'div',
        { class: 'admin-chips' },
        ...(s
          ? [
              h('span', { class: 'chip' }, `⏱ ${Math.floor((s.uptimeSec || 0) / 60)}m up`),
              h('span', { class: 'chip' }, `🎲 ${fmt(s.totalRolls || 0)} rolls`),
              h('span', { class: 'chip' }, `👤 ${s.accounts || 0} accounts`),
              h('span', { class: 'chip' }, `👻 ${s.guests || 0} guests`),
              h('span', { class: 'chip' }, `🔑 ${s.sessions || 0} sessions`),
              h('span', { class: 'chip' }, `💾 ${fmt(s.db?.writes || 0)} writes`),
            ]
          : [h('span', { class: 'chip' }, 'loading…')])
      ),
      h(
        'p',
        { class: 'muted small' },
        `On the list: ${(a.admins || []).length ? (a.admins || []).join(', ') : 'nobody — add your username to admins.json and save'}`
      ),
      adminRow(
        adminBtn('↻ Refresh', () => actions.adminRefresh()),
        adminBtn('💾 Save database now', () => run('save', {}))
      )
    )
  );

  // --- find a player -------------------------------------------------------------
  const find = adminField(a, 'target', { placeholder: 'username or player id', spellcheck: 'false' });
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actions.adminSelect(a.form.target || '');
  });
  const online = (a.players || []).filter((p) => p.online).slice(0, 14);
  root.append(
    adminSection(
      'Player',
      `${(a.players || []).length} known account${(a.players || []).length === 1 ? '' : 's'} · guests are memory-only and can never be admins`,
      adminRow(find, adminBtn('Load', () => actions.adminSelect(a.form.target || ''))),
      online.length
        ? h(
            'div',
            { class: 'admin-chips' },
            ...online.map((p) =>
              h(
                'button',
                { class: `chip admin-chip${a.detail?.id === p.id ? ' is-on' : ''}`, title: `Load ${p.name}`, onclick: () => actions.adminSelect(p.name) },
                `🟢 ${p.name}`
              )
            )
          )
        : null
    )
  );

  // --- the editor ------------------------------------------------------------------
  const d = a.detail;
  if (!d) {
    root.append(h('p', { class: 'muted small' }, 'Load a player to edit them.'));
  } else {
    const who = h(
      'div',
      { class: 'admin-who' },
      h('b', null, d.name),
      d.guest ? h('span', { class: 'chip' }, 'guest') : null,
      d.isAdmin ? h('span', { class: 'chip ok' }, 'admin') : null,
      h('span', { class: 'chip' }, d.online ? '🟢 online' : `last seen ${Math.max(0, Math.round((Date.now() - d.lastSeenAt) / 60000))}m ago`),
      h('span', { class: 'chip' }, `🔑 ${d.sessions} session${d.sessions === 1 ? '' : 's'}`),
      d.best ? h('span', { class: 'chip' }, `best 1 in ${fmt(d.best.odds)}`) : null
    );

    const stat = (label, value) => h('span', { class: 'chip' }, `${label} ${value}`);
    root.append(
      adminSection(
        `Editing · ${d.name}`,
        null,
        who,
        h(
          'div',
          { class: 'admin-chips' },
          stat('💠', fmt(d.essence)),
          stat('💰', fmt(d.money)),
          stat('🎲', fmt(d.totalRolls)),
          stat('✦', `${d.ascensions}`),
          stat('◆', fmt(d.ascendPoints)),
          stat('🌀', `${d.unique}/${(state.catalog.allAuras || state.catalog.auras).length}`),
          stat('🧤', `${d.gear}`),
          stat('🍀', `${Number(d.luck).toFixed(2)}×`)
        ),

        adminRow(
          adminField(a, 'essence', { type: 'number', value: String(d.essence) }),
          adminBtn('Set essence', () => run('set', { target: d.name, essence: adminNum(a.form.essence) })),
          adminField(a, 'money', { type: 'number', value: String(d.money) }),
          adminBtn('Set money', () => run('set', { target: d.name, money: adminNum(a.form.money) }))
        ),
        adminRow(
          adminBtn('+💰 1M', () => run('give', { target: d.name, money: 1e6 })),
          adminBtn('+💰 100M', () => run('give', { target: d.name, money: 1e8 })),
          adminBtn('+💠 1M', () => run('give', { target: d.name, essence: 1e6 })),
          adminBtn('+✦ 10', () => run('give', { target: d.name, ascendPoints: 10 }))
        ),

        adminRow(
          adminPick(
            a,
            'aura',
            (state.catalog.allAuras || state.catalog.auras).map((x) => ({
              value: x.id,
              label: `${x.craftOnly ? '✦ ' : ''}${x.name} · 1 in ${fmt(x.odds)}`,
            }))
          ),
          adminField(a, 'auraCount', { type: 'number', value: '10' }),
          adminBtn('Give auras', () => run('give', { target: d.name, auras: { [a.form.aura]: adminNum(a.form.auraCount) || 1 } })),
          adminBtn('Every aura', () => run('give', { target: d.name, allAuras: 1 }), { title: 'One of every aura in the game' })
        ),
        adminRow(
          adminPick(a, 'item', state.catalog.items.map((x) => ({ value: x.id, label: `${x.icon} ${x.name}` }))),
          adminField(a, 'itemCount', { type: 'number', value: '5' }),
          adminBtn('Give items', () => run('give', { target: d.name, items: { [a.form.item]: adminNum(a.form.itemCount) || 1 } })),
          adminBtn('Every item', () => run('give', { target: d.name, allItems: 1 }))
        ),
        adminRow(
          adminPick(a, 'upgrade', (state.catalog.upgrades || []).map((x) => ({ value: x.id, label: x.name }))),
          adminField(a, 'level', { type: 'number', value: '10' }),
          adminBtn('Set level', () => run('set', { target: d.name, levels: { [a.form.upgrade]: adminNum(a.form.level) || 0 } }))
        ),
        adminRow(
          adminPick(a, 'node', (state.catalog.tree || []).map((x) => ({ value: x.id, label: x.name }))),
          adminField(a, 'nodeLevel', { type: 'number', value: '1' }),
          adminBtn('Set tree node', () => run('set', { target: d.name, tree: { [a.form.node]: adminNum(a.form.nodeLevel) || 0 } })),
          adminBtn('Reroll mining vein', () => run('set', { target: d.name, mining: 'reset' }))
        ),

        adminRow(
          adminField(a, 'potionAdd', { type: 'number', value: '150000' }),
          adminField(a, 'potionRolls', { type: 'number', value: '1' }),
          adminBtn('✨ Give one-roll luck', () => run('buff', { target: d.name, add: adminNum(a.form.potionAdd), rolls: adminNum(a.form.potionRolls) }))
        ),
        adminRow(
          adminField(a, 'buffMult', { type: 'number', value: '2' }),
          adminField(a, 'buffMinutes', { type: 'number', value: '30' }),
          adminBtn('🧪 Give timed luck', () => run('buff', { target: d.name, mult: adminNum(a.form.buffMult), minutes: adminNum(a.form.buffMinutes) }))
        ),
        adminRow(
          adminPick(a, 'piece', (state.catalog.gear || []).map((x) => ({ value: x.id, label: `${x.icon} ${x.name}` }))),
          adminPick(a, 'quality', (state.catalog.gearQualities || []).map((x) => ({ value: x.id, label: x.name }))),
          adminBtn('⚒ Forge gear', () => run('gear', { target: d.name, piece: a.form.piece, quality: a.form.quality }))
        ),

        adminRow(
          adminField(a, 'rename', { placeholder: 'new username', value: d.name }),
          adminBtn('Rename', () => run('set', { target: d.name, name: (a.form.rename || '').trim() })),
          adminBtn(d.luckOff ? 'Luck on' : 'Luck off', () => run('set', { target: d.name, luckOff: !d.luckOff }))
        ),
        adminRow(
          adminBtn('Reset progress', () => run('reset', { target: d.name, mode: 'progress' }), { kind: 'danger', title: 'Wipe the run: levels, auras, items, gear, currency. The account and its ascensions stay.' }),
          adminBtn('Full reset', () => run('reset', { target: d.name, mode: 'full' }), { kind: 'danger', title: 'Wipe everything but the login itself.' }),
          adminBtn('Kick sessions', () => run('kick', { target: d.name }), { title: 'Log them out everywhere.' }),
          adminBtn('Delete account', () => run('delete', { target: d.name }), { kind: 'danger', title: 'Remove the account for good.' })
        )
      )
    );
  }

  // --- world -----------------------------------------------------------------
  const ov = a.biomeOverride;
  root.append(
    adminSection(
      'World',
      ov ? `Forced by ${ov.by || 'an admin'}${ov.until ? ` until ${new Date(ov.until).toLocaleTimeString()}` : ' until cleared'}` : 'The biome rotation is running normally.',
      adminRow(
        adminPick(a, 'biome', [
          { value: 'auto', label: '↻ Normal rotation' },
          ...(state.catalog.biomes || []).map((b) => ({ value: b.id, label: `${b.name} · ${b.luck}× luck` })),
        ]),
        adminField(a, 'biomeMinutes', { type: 'number', value: '10' }),
        adminBtn('Apply', () => run('biome', { biome: a.form.biome, minutes: adminNum(a.form.biomeMinutes) || 0 }))
      ),
      adminRow(
        adminField(a, 'announce', { placeholder: 'Announce something to every player’s feed', maxlength: '140' }),
        adminBtn('📣 Announce', () => run('announce', { text: a.form.announce || '' }))
      )
    )
  );

  // --- audit -----------------------------------------------------------------
  root.append(
    adminSection(
      'Audit log',
      'In memory, newest first — it is what answers “who gave whom 900 million essence”.',
      ...(a.audit || []).length
        ? (a.audit || [])
            .slice(0, 40)
            .map((e) =>
              h(
                'div',
                { class: 'admin-audit' },
                h('span', { class: 'muted' }, new Date(e.at).toLocaleTimeString()),
                h('b', null, e.by),
                h('span', null, e.action),
                e.target ? h('span', { class: 'muted' }, `→ ${e.target}`) : null,
                e.detail ? h('span', { class: 'admin-detail' }, e.detail) : null
              )
            )
        : [h('p', { class: 'muted small' }, 'Nothing has been done yet.')]
    )
  );
}

export const VIEWS = {
  inventory: renderInventory,
  bestiary: renderBestiary,
  crafting: renderCrafting,
  gear: renderGear,
  upgrades: renderUpgrades,
  shop: renderShop,
  mining: renderMining,
  clicker: renderClicker,
  leaderboard: renderLeaderboard,
  achievements: renderAchievements,
  admin: renderAdmin,
};

export function renderView(name, root, state, actions) {
  (VIEWS[name] || renderInventory)(root, state, actions);
}
