import { h, clear, fmt, fmtOdds } from './dom.js';
import { upgradeCost, sellPrice, getAura, getItem } from './catalog.js';

// ---------------------------------------------------------------------------
// Right-hand panel views. Pure render: they read `state` and write DOM, and
// signal intent through the `actions` callbacks passed in by main.js.
// ---------------------------------------------------------------------------

export function renderInventory(root, state, actions) {
  clear(root);
  const owned = state.catalog.auras.filter((a) => state.profile.inventory[a.id]);
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
  root.append(h('h3', { class: 'section-title' }, 'Auras'));
  if (!owned.length) {
    root.append(h('p', { class: 'muted small' }, 'No auras yet. Hit ROLL to get your first one.'));
    return;
  }

  const grid = h('div', { class: 'view-grid' });
  for (const aura of owned) {
    const slot = state.profile.inventory[aura.id];
    const price = sellPrice(aura.odds);
    grid.append(
      h(
        'div',
        {
          class: `card${state.newAuras.has(aura.id) ? ' is-new' : ''}`,
          style: { '--aura': aura.color },
          title: `${aura.tierName} · rolled ${slot.count}×\nbest ${fmtOdds(slot.bestOdds)}`,
        },
        h('div', { class: 'c-name' }, aura.name),
        h('div', { class: 'c-odds' }, fmtOdds(slot.bestOdds)),
        h('div', { class: 'c-count' }, `×${fmt(slot.count)}`),
        h('button', { class: 'mini-btn sell', onclick: () => actions.sell(aura.id, 1), title: `Sell 1 for ${fmt(price)} money` }, `Sell 💰${fmt(price)}`)
      )
    );
  }
  root.append(grid);
}

export function renderBestiary(root, state) {
  clear(root);
  const grid = h('div', { class: 'view-grid' });

  // Rarest first — the pool is already sorted that way from the server.
  for (const aura of state.catalog.auras) {
    const slot = state.profile.inventory[aura.id];
    const live = state.oddsById[aura.id];
    const odds = live ? live.odds : aura.odds;

    grid.append(
      h(
        'div',
        {
          class: `card${slot ? '' : ' is-locked'}`,
          style: { '--aura': aura.color },
          title: slot
            ? `${aura.tierName} · owned ×${slot.count}`
            : `${aura.tierName} · not yet rolled`,
        },
        h('div', { class: 'c-name' }, slot ? aura.name : '? ? ?'),
        h('div', { class: 'c-odds' }, fmtOdds(odds)),
        h('div', { class: 'c-count' }, slot ? `×${fmt(slot.count)}` : '—')
      )
    );
  }

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.5rem' } },
      'Odds shown are live — they already include your luck and the current biome. ' +
        'Biome-native auras listed outside their biome are Breakthroughs and much rarer.'
    ),
    grid
  );
}

export function renderCrafting(root, state, actions) {
  clear(root);
  const { profile } = state;
  const recipes = state.catalog.recipes || [];

  root.append(
    h(
      'p',
      { class: 'muted small', style: { marginBottom: '0.5rem' } },
      'Combine auras (and items) into rarer ones. Selling duplicates is the main way to earn money.'
    )
  );

  for (const recipe of recipes) {
    const moneyCost = recipe.money || 0;
    let canAfford = profile.money >= moneyCost;
    const inputNodes = [];

    for (const inp of recipe.inputs || []) {
      const have = inp.aura ? profile.inventory[inp.aura]?.count || 0 : profile.items[inp.item] || 0;
      const enough = have >= inp.count;
      if (!enough) canAfford = false;
      const label = inp.aura ? getAura(inp.aura)?.name || inp.aura : `${getItem(inp.item)?.icon || ''} ${getItem(inp.item)?.name || inp.item}`;
      inputNodes.push(
        h('span', { class: `chip ${enough ? 'ok' : 'no'}` }, `${label} ${have}/${inp.count}`)
      );
    }
    if (!canAfford) canAfford = profile.money >= moneyCost;

    const out = recipe.output;
    const outLabel = out.aura
      ? getAura(out.aura)?.name || out.aura
      : `${getItem(out.item)?.icon || ''} ${getItem(out.item)?.name || out.item}`;
    const outColor = out.aura ? getAura(out.aura)?.color : '#ffd700';

    root.append(
      h(
        'div',
        { class: 'craft-row' },
        h('div', { class: 'craft-io' }, ...(recipe.inputs || []).map((inp) =>
          h('span', { class: 'chip', style: { color: inp.aura ? getAura(inp.aura)?.color : '#ffd700' } },
            `${inp.aura ? getAura(inp.aura)?.name : getItem(inp.item)?.name}×${inp.count}`)
        )),
        h('div', { class: 'craft-arrow' }, '→'),
        h('div', { class: 'craft-out' }, h('span', { class: 'chip', style: { color: outColor } }, `${outLabel}${out.count > 1 ? `×${out.count}` : ''}`)),
        h('div', { class: 'craft-cost' }, moneyCost ? `💰${fmt(moneyCost)}` : 'free'),
        h(
          'button',
          { class: 'buy-btn', disabled: !canAfford, onclick: () => actions.craft(recipe.id) },
          'Craft'
        )
      )
    );
    // inputNodes unused but kept for clarity of intent
    void inputNodes;
  }
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

  root.append(
    h(
      'button',
      {
        class: 'ascend-btn',
        disabled: !ready,
        onclick: () => actions.ascend(),
        title: 'Resets levels and essence. Your collection, money and records are kept.',
      },
      ready
        ? `✦ ASCEND → ${nextMult.toFixed(2)}× LUCK`
        : `Ascend at ${fmt(req)} rolls (${fmt(profile.totalRolls)}/${fmt(req)})`
    )
  );
}

export function renderLeaderboard(root, state, actions) {
  clear(root);
  const rows = state.world.leaderboard || [];

  if (!rows.length) {
    root.append(h('p', { class: 'muted small' }, 'Nobody on the board yet. Roll something rare.'));
    return;
  }

  rows.forEach((row, i) => {
    const aura = row.bestAuraId ? state.auraById[row.bestAuraId] : null;
    root.append(
      h(
        'div',
        { class: `lb-row${row.id === state.profile.id ? ' me' : ''}` },
        h('div', { class: 'lb-rank' }, i + 1),
        h(
          'div',
          { class: 'lb-name' },
          row.name,
          row.guest ? h('span', { class: 'guest-tag' }, 'guest') : null,
          h('small', {}, `${fmt(row.totalRolls)} rolls · ${row.unique}/${row.totalAuras}`)
        ),
        h(
          'div',
          { class: 'lb-best', style: aura ? { color: aura.color } : null },
          aura ? `${aura.name} ${fmtOdds(row.bestOdds)}` : '—'
        )
      )
    );
  });

  root.append(
    h(
      'button',
      { class: 'ghost-btn', style: { marginTop: '0.5rem' }, onclick: () => actions.refreshWorld() },
      '↻ Refresh'
    )
  );
}

export const VIEWS = {
  inventory: renderInventory,
  bestiary: renderBestiary,
  crafting: renderCrafting,
  upgrades: renderUpgrades,
  shop: renderShop,
  leaderboard: renderLeaderboard,
};

export function renderView(name, root, state, actions) {
  (VIEWS[name] || renderInventory)(root, state, actions);
}
