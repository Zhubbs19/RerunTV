// Tabs (docs/design/04 §3): a tab bar with the ARIA tabs pattern. Only the
// active tab is a Tab stop; ◀▶ (▲▼ when vertical) Home End move *and*
// activate, like a native OS tab strip. Two ways in:
//   Tabs({ items: [{ id, label, panel }], selected, orientation, onSelect })
//     builds a bar.
//   enhanceTabs(bar, { tabSelector, panelFor }) adopts static markup whose
//     .active class other code moves (the setup sidebar and sub-tab bars).
import { h, nextId, rovingIndex } from './kit-core.js';

function wireBar(bar, { tabs, orientation, activate, isActive, panelFor }) {
  bar.setAttribute('role', 'tablist');
  if (orientation === 'vertical') bar.setAttribute('aria-orientation', 'vertical');
  const all = () => tabs();
  all().forEach((tab) => {
    tab.setAttribute('role', 'tab');
    const panel = panelFor && panelFor(tab);
    if (!panel) return;
    if (!tab.id) tab.id = nextId('tab');
    if (!panel.id) panel.id = nextId('tabpanel');
    tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
  });
  const sync = () => {
    const list = all();
    const active = list.find(isActive) || list[0];
    list.forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab === active));
      tab.tabIndex = tab === active ? 0 : -1;
    });
  };
  sync();
  bar.addEventListener('click', sync);
  bar.addEventListener('keydown', (event) => {
    const list = all();
    const at = list.indexOf(document.activeElement);
    if (at === -1) return;
    const to = rovingIndex(list.length, at, event.key, { orientation });
    if (to === null) return;
    event.preventDefault();
    list[to].focus();
    activate(list[to]);
  });
  return sync;
}

export function enhanceTabs(bar, { tabSelector, panelFor } = {}) {
  if (!bar) return () => {};
  const orientation = bar.getAttribute('aria-orientation') === 'vertical' ? 'vertical' : 'horizontal';
  return wireBar(bar, {
    tabs: () => Array.from(bar.querySelectorAll(tabSelector)),
    orientation,
    activate: (tab) => tab.click(),
    isActive: (tab) => tab.classList.contains('active'),
    panelFor,
  });
}

export function Tabs({ items = [], selected, orientation = 'horizontal', onSelect, label = '', className = '', tabClassName = 'btn' } = {}) {
  const bar = h('div', { className: ['ui-tabs', className].filter(Boolean).join(' '), attrs: { 'aria-label': label || undefined } });
  let current = selected !== undefined ? selected : items[0] && items[0].id;
  const buttons = items.map((item) => {
    const tab = h('button', { type: 'button', className: ['ui-tab', tabClassName].filter(Boolean).join(' '), text: item.label, dataset: { tab: item.id } });
    tab.addEventListener('click', () => select(item.id, true));
    bar.appendChild(tab);
    return tab;
  });
  const paint = () => {
    buttons.forEach((tab, i) => {
      tab.classList.toggle('active', items[i].id === current);
      if (items[i].panel) items[i].panel.hidden = items[i].id !== current;
    });
    sync();
  };
  function select(id, fromUser) {
    if (id === current && fromUser) return;
    current = id;
    paint();
    if (fromUser && onSelect) onSelect(id);
  }
  const sync = wireBar(bar, {
    tabs: () => buttons,
    orientation,
    activate: (tab) => tab.click(),
    isActive: (tab) => tab.dataset.tab === current,
    panelFor: (tab) => { const item = items.find((i) => i.id === tab.dataset.tab); return item && item.panel; },
  });
  paint();
  bar.select = (id) => select(id, false);
  bar.selected = () => current;
  return bar;
}
