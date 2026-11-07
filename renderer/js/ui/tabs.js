// Tabs (docs/design/04 §3): a tab bar with the ARIA tabs pattern. Only the
// active tab is a Tab stop; ◀▶ (▲▼ when vertical) Home End move *and*
// activate, like a native OS tab strip. Two ways in:
//   Tabs({ items: [{ id, label, panel }], selected, orientation, onSelect })
//     builds a bar.
//   enhanceTabs(bar, { tabSelector, panelFor }) adopts static markup whose
//     .active class other code moves (the setup sidebar and sub-tab bars).
import { h, nextId, rovingIndex } from './kit-core.js';

/**
 * Applies the ARIA tabs pattern to a bar: roles, panel links, roving tabindex and arrow keys.
 * @param {HTMLElement} bar The tab bar.
 * @param {object} opts Wiring.
 * @param {() => HTMLElement[]} opts.tabs Returns the current tab elements.
 * @param {string} opts.orientation `'horizontal'` or `'vertical'`.
 * @param {(tab: HTMLElement) => void} opts.activate Activates a tab.
 * @param {(tab: HTMLElement) => boolean} opts.isActive Whether a tab is the active one.
 * @param {(tab: HTMLElement) => ?HTMLElement} [opts.panelFor] The panel a tab controls.
 * @returns {Function} sync(): re-applies `aria-selected` and tabindex to match the active tab.
 */
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

/**
 * Adopts a static tab bar whose `.active` class other code moves.
 * @param {?HTMLElement} bar The tab bar.
 * @param {object} [opts] Options.
 * @param {string} opts.tabSelector Selector for the tabs inside the bar.
 * @param {(tab: HTMLElement) => ?HTMLElement} [opts.panelFor] The panel a tab controls.
 * @returns {Function} sync(), to call after the active tab changes elsewhere.
 */
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

/**
 * Builds a tab bar that shows one item's panel at a time.
 * @param {object} [opts] Options.
 * @param {Array<object>} [opts.items=[]] `{ id, label, panel }` tabs.
 * @param {string} [opts.selected] Id of the active tab; defaults to the first.
 * @param {string} [opts.orientation='horizontal'] `'horizontal'` or `'vertical'`.
 * @param {(id: string) => void} [opts.onSelect] Called when the user picks a tab.
 * @param {string} [opts.label=''] Accessible name.
 * @param {string} [opts.className=''] Extra classes on the bar.
 * @param {string} [opts.tabClassName='btn'] Classes on each tab.
 * @returns {HTMLElement} The bar, with `.select(id)` and `.selected()`.
 */
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
