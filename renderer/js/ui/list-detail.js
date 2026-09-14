// ListDetail (docs/design/04 §3; the pattern from docs/design/03 §4): a list
// of rows beside the selected row's detail pane, one behaviour for every
// collection — channels, the ad pool, presets, flows, backups, plugins.
//
// The markup contract:
//   [data-ui-list-detail]    the wrapper (narrow windows swap list ↔ detail)
//     [data-ui-list]         the list pane; rows inside it, .selected on the chosen one
//     [data-ui-detail]       the detail pane
//
// Behaviour (listDetailBehavior), the same on every collection:
//   J/K       ▼/▲ in a list (the list's own arrow handling moves)
//   Enter     on the already-chosen row: into its detail's first control
//   Esc       inside a detail: back to the chosen row of its list
//   narrow    below 900 px choosing a row opens its detail, with a Back button
//
// ListDetail({ items, key, renderRow, renderDetail, selected, onSelect }) builds
// the markup for new lists, rows with ▲▼ Home End built in; reconcileList()
// updates rows by key without rebuilding the ones that didn't change.
import { h, rovingIndex } from './kit-core.js';

// ---------- Pure ----------
// How to get from the rows on screen (keys, in order) to the wanted ones.
// Rows keep their element when their key survives.
export function reconcilePlan(currentKeys, nextKeys) {
  const nextSet = new Set(nextKeys);
  const currentSet = new Set(currentKeys);
  return {
    remove: currentKeys.filter((k) => !nextSet.has(k)),
    create: nextKeys.filter((k) => !currentSet.has(k)),
    order: nextKeys.slice(),
  };
}

// J/K as arrows; null for any other key.
export function listLetterKey(key) {
  if (key === 'j') return 'ArrowDown';
  if (key === 'k') return 'ArrowUp';
  return null;
}

// ---------- DOM ----------
export function reconcileList(container, items, { key, render, update } = {}) {
  const existing = new Map();
  Array.from(container.children).forEach((el) => { if (el.dataset.key !== undefined) existing.set(el.dataset.key, el); });
  const nextKeys = items.map((item) => String(key(item)));
  const plan = reconcilePlan(Array.from(existing.keys()), nextKeys);
  plan.remove.forEach((k) => existing.get(k).remove());
  let cursor = null;
  items.forEach((item, i) => {
    const k = nextKeys[i];
    let el = existing.get(k);
    if (!el) { el = render(item); el.dataset.key = k; } else if (update) update(el, item);
    const expected = cursor ? cursor.nextElementSibling : container.firstElementChild;
    if (el !== expected) container.insertBefore(el, expected);
    cursor = el;
  });
}

const WRAPPER = '[data-ui-list-detail]';
const LIST = '[data-ui-list]';
const DETAIL = '[data-ui-detail]';

function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(el.type);
}

// listDetailBehavior({ rows, selectedRow }) — rows/selectedRow are the
// selectors for the collections' rows (default [data-ui-row] and its
// .selected). Returns the pieces a screen wires into its own key handling,
// so ordering against its other shortcuts stays the screen's call:
//   { closeDetail(wrapper, { focusRow }), handleEscape(event), handleListKey(event, key),
//     install(root) }  — install adds the narrow-window Back buttons and row clicks.
export function listDetailBehavior({ rows = '[data-ui-row]', selectedRow = '[data-ui-row].selected' } = {}) {
  function closeDetail(wrapper, { focusRow = true } = {}) {
    if (!wrapper || !wrapper.classList.contains('is-detail-open')) return;
    wrapper.classList.remove('is-detail-open');
    if (focusRow) wrapper.querySelector(selectedRow)?.focus();
  }

  // Esc inside a detail pane: back to the selected row of its list.
  function handleEscape(event) {
    const active = document.activeElement;
    if (event.key !== 'Escape' || !active || active === document.body) return false;
    const detail = active.closest(DETAIL);
    const wrapper = detail && detail.closest(WRAPPER);
    const list = wrapper && wrapper.querySelector(LIST);
    const row = list && list.querySelector(selectedRow);
    if (!row) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeDetail(wrapper, { focusRow: false });
    row.focus();
    return true;
  }

  // J/K and Enter-into-detail for a focused row in a list. key is the
  // lower-cased single-character key or the key name.
  function handleListKey(event, key) {
    const active = document.activeElement;
    const list = active && active.closest && active.closest(LIST);
    if (!list) return false;
    const arrow = listLetterKey(key);
    if (arrow) {
      event.preventDefault();
      active.dispatchEvent(new KeyboardEvent('keydown', { key: arrow, bubbles: true, cancelable: true }));
      return true;
    }
    if (event.key === 'Enter' && active.matches(selectedRow)) {
      const wrapper = list.closest(WRAPPER);
      const detail = wrapper && wrapper.querySelector(DETAIL);
      const usable = (el) => !el.disabled && el.offsetParent !== null && el.type !== 'hidden';
      const first = detail && (Array.from(detail.querySelectorAll('input, select, textarea, button')).find(usable)
        || Array.from(detail.querySelectorAll('[tabindex="0"]')).find(usable));
      if (first) {
        event.preventDefault();
        event.stopImmediatePropagation();
        first.focus();
        return true;
      }
    }
    return false;
  }

  function openFromRow(event) {
    const row = event.target.closest && event.target.closest(rows);
    if (!row) return;
    // A row's own checkbox, drag handle and buttons keep their own jobs.
    if (event.target.closest('input, select, textarea') || (event.target.closest('button') && !event.target.closest('button').matches(rows))) return;
    const wrapper = row.closest(WRAPPER);
    if (!wrapper || row.closest(DETAIL)) return;
    wrapper.classList.add('is-detail-open'); // wide layouts ignore the class
  }

  function install(root) {
    root.querySelectorAll(WRAPPER).forEach((wrapper) => {
      if (wrapper.querySelector(':scope > .list-detail-back')) return;
      const back = h('button', { type: 'button', className: 'btn list-detail-back', text: '‹ BACK TO LIST' });
      back.addEventListener('click', () => closeDetail(wrapper));
      wrapper.prepend(back);
    });
    // Capture phase: a channel row is re-rendered by its own click handler, so
    // by the time the event bubbled the row would already be detached.
    root.addEventListener('click', openFromRow, true);
    root.addEventListener('keydown', (event) => { if (event.key === 'Enter') openFromRow(event); }, true);
  }

  return { closeDetail, handleEscape, handleListKey, install, isTypingTarget };
}

// ListDetail({ items, key, renderRow, renderDetail, selected, onSelect, label })
// → wrapper with refresh(items, selected). Rows get ▲▼ Home End (wrapping),
// Enter/Space to choose; the shared behaviour above covers the rest once the
// screen has installed it.
export function ListDetail({ items = [], key = (item) => item.id, renderRow, renderDetail, selected = null, onSelect, label = '', className = '' } = {}) {
  const list = h('div', { className: 'list-detail-list', attrs: { role: 'listbox', 'aria-label': label || undefined }, dataset: { uiList: '' } });
  const detail = h('div', { className: 'list-detail-detail', dataset: { uiDetail: '' } });
  const wrapper = h('div', { className: ['list-detail', className].filter(Boolean).join(' '), dataset: { uiListDetail: '' } }, list, detail);
  let current = selected;
  let currentItems = items;

  function paintSelection() {
    Array.from(list.children).forEach((row) => {
      const on = row.dataset.key === String(current);
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', String(on));
    });
    detail.replaceChildren();
    const item = currentItems.find((it) => String(key(it)) === String(current));
    if (item && renderDetail) detail.appendChild(renderDetail(item));
  }

  list.addEventListener('keydown', (event) => {
    const rowEls = Array.from(list.children);
    const at = rowEls.indexOf(event.target);
    if (at === -1) return;
    const to = rovingIndex(rowEls.length, at, event.key, { orientation: 'vertical', wrap: true });
    if (to !== null) { event.preventDefault(); rowEls[to].focus(); return; }
    if (event.key === ' ' || (event.key === 'Enter' && !event.target.classList.contains('selected'))) {
      event.preventDefault();
      event.target.click();
    }
  });

  function refresh(nextItems = currentItems, nextSelected = current) {
    currentItems = nextItems;
    current = nextSelected;
    reconcileList(list, currentItems, {
      key,
      render: (item) => {
        const row = renderRow(item);
        row.dataset.uiRow = '';
        row.setAttribute('role', 'option');
        if (!row.hasAttribute('tabindex')) row.tabIndex = 0;
        row.addEventListener('click', () => {
          current = key(item);
          paintSelection();
          if (onSelect) onSelect(item);
        });
        return row;
      },
    });
    paintSelection();
  }
  refresh();
  wrapper.refresh = refresh;
  return wrapper;
}
