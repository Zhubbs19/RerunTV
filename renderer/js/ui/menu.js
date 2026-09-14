// Menu and MenuButton (docs/design/04 §3). One list-of-actions popup for the
// whole app: a row's ⋯ menu, the guide's shorts list and program actions, the
// banner hub's actions. Groups are separated by a rule; the last group is
// where destructive items go (styled danger).
//
// Two ways to drive it:
// - focus: true (MenuButton, desktop menus): items take real focus; ▲▼ Home
//   End move, Enter/Space runs, Esc/Tab close and return focus to the opener.
// - focus: false (guide, banner hub): the owner already routes keys (the
//   guide grid, tv-input's banner context), so the menu only highlights and the
//   owner calls menu.key('up'|'down'|'ok'|'back'|…). Anything else closes it.
//
// classes lets a surface keep its long-standing look (.row-menu for setup,
// .guide-run-list over the TV picture) while sharing behaviour.
import { h, rovingIndex } from './kit-core.js';

// ---------- Pure ----------
// Where a popup of `size` goes beside `anchor`, inside `bounds` (all rects in
// the same coordinates). prefer: 'below' | 'above'. align: 'start' | 'end'.
export function placePopup(anchor, size, bounds, { prefer = 'below', align = 'start', gap = 4, margin = 8 } = {}) {
  const minLeft = bounds.left + margin;
  const maxLeft = bounds.left + bounds.width - size.width - margin;
  const rawLeft = align === 'end' ? anchor.left + anchor.width - size.width : anchor.left;
  const left = Math.max(minLeft, Math.min(rawLeft, maxLeft));
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= bounds.top + bounds.height - margin;
  const fitsAbove = above >= bounds.top + margin;
  let top;
  if (prefer === 'above') top = fitsAbove ? above : (fitsBelow ? below : Math.max(bounds.top + margin, bounds.top + bounds.height - size.height - margin));
  else top = fitsBelow ? below : (fitsAbove ? above : Math.max(bounds.top + margin, bounds.top + bounds.height - size.height - margin));
  return { left, top: Math.max(bounds.top + margin, top) };
}

// Index of the next enabled item for a remote/keyboard key, or null.
export function menuMove(items, current, key) {
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i !== -1);
  if (!enabled.length) return null;
  const at = enabled.indexOf(current);
  const to = rovingIndex(enabled.length, at, key, { orientation: 'vertical', wrap: true });
  return to === null ? null : enabled[to];
}

const DEFAULT_CLASSES = { root: 'row-menu', item: 'row-menu-item', rule: 'row-menu-rule', heading: 'row-menu-heading', active: 'active', danger: 'is-danger' };

let openMenu = null; // the one focus-mode menu open at a time
let globalListeners = false;

function installGlobalListeners() {
  if (globalListeners) return;
  globalListeners = true;
  document.addEventListener('pointerdown', (event) => {
    if (openMenu && !openMenu.contains(event.target)) openMenu.close();
  }, true);
  window.addEventListener('blur', () => { if (openMenu) openMenu.close(); });
  document.addEventListener('scroll', (event) => {
    if (openMenu && !openMenu.popup.contains(event.target)) openMenu.close();
  }, true);
  // Shift+F10 / the ContextMenu key on a focused row opens that row's ⋯ menu.
  document.addEventListener('keydown', (event) => {
    if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    const row = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-row-menu]');
    const button = row && row.querySelector('.row-menu-btn');
    if (!button) return;
    event.preventDefault();
    button.click();
  });
}

// Menu({ label, heading, groups: [[{ label, time, run, disabled, title,
//   danger, className }]], focus, classes, role, onClose })
// → { popup, open({ anchor, point, container, prefer, align, initialIndex }),
//     close({ restoreFocus }), key(action), isOpen() }
export function Menu({ label = '', heading = '', groups = [], focus = true, classes = {}, role, className = '', onClose } = {}) {
  const cls = { ...DEFAULT_CLASSES, ...classes };
  const items = [];
  let elements = [];
  let index = -1;
  let opener = null;
  let open = false;

  const popup = h('div', {
    className: [cls.root, className].filter(Boolean).join(' '),
    attrs: { role: role || (focus ? 'menu' : 'listbox'), 'aria-label': label || heading || undefined },
  });
  if (heading) popup.appendChild(h('div', { className: cls.heading, text: heading }));
  groups.filter((group) => group && group.length).forEach((group, gi) => {
    if (gi > 0) popup.appendChild(h('div', { className: cls.rule, attrs: { role: 'separator' } }));
    group.forEach((item) => {
      const i = items.length;
      items.push(item);
      const el = h('button', {
        type: 'button',
        className: [cls.item, item.danger ? cls.danger : '', item.className || ''].filter(Boolean).join(' '),
        tabIndex: -1,
        disabled: !!item.disabled,
        attrs: { role: focus ? 'menuitem' : 'option', title: item.title || undefined, 'data-danger': item.danger || undefined },
      });
      if (item.time) el.appendChild(h('span', { className: 'guide-run-time', text: item.time }));
      if (focus && !item.time) el.textContent = item.label;
      else el.appendChild(h('span', { className: 'guide-run-title', text: item.label }));
      el.addEventListener('click', (event) => { event.stopPropagation(); run(i); });
      if (!focus) el.addEventListener('mousemove', () => { if (index !== i) highlight(i); });
      popup.appendChild(el);
      elements.push(el);
    });
  });

  function highlight(i) {
    index = i;
    elements.forEach((el, n) => {
      const on = n === i;
      el.classList.toggle(cls.active, on);
      if (!focus) el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const el = elements[i];
    if (!el) return;
    if (focus) el.focus({ preventScroll: true });
    else if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); // a long shorts list scrolls inside itself
  }

  function run(i) {
    const item = items[i];
    if (!item || item.disabled) return;
    close();
    if (item.run) item.run();
  }

  function close({ restoreFocus = false } = {}) {
    if (!open) return;
    open = false;
    popup.remove();
    if (openMenu === api) openMenu = null;
    if (opener) opener.setAttribute('aria-expanded', 'false');
    if (restoreFocus && opener) opener.focus({ preventScroll: true });
    if (onClose) onClose();
  }

  // Keys for owner-driven menus (and the focus-mode keydown below).
  function key(action) {
    if (!open) return false;
    const keyName = { up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End' }[action] || action;
    if (keyName === 'ArrowUp' || keyName === 'ArrowDown' || keyName === 'Home' || keyName === 'End') {
      // Owner-driven lists stop at the ends (the guide's popover never wrapped).
      if (!focus && ((keyName === 'ArrowUp' && index <= firstEnabled()) || (keyName === 'ArrowDown' && index >= lastEnabled()))) return true;
      const to = menuMove(items, index, keyName);
      if (to !== null) highlight(to);
      return true;
    }
    if (action === 'ok' || keyName === 'Enter') { run(index); return true; }
    close({ restoreFocus: focus });
    return true;
  }
  const firstEnabled = () => items.findIndex((item) => !item.disabled);
  const lastEnabled = () => { for (let i = items.length - 1; i >= 0; i -= 1) if (!items[i].disabled) return i; return -1; };

  if (focus) {
    popup.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const to = menuMove(items, index, event.key);
        if (to !== null) highlight(to);
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
      }
    });
  }

  const api = {
    popup,
    contains: (node) => popup.contains(node) || (opener && opener.contains(node)),
    isOpen: () => open,
    key,
    close,
    // anchor: an element or rect; point: { x, y } for a right-click; container:
    // where the popup lives (document.body by default, fixed-position then).
    // place: false leaves position to the surface's CSS (the banner hub's
    // actions sit at a fixed spot above the channel banner).
    open({ anchor = null, point = null, container = null, prefer = 'below', align = 'start', initialIndex = 0, openerEl = null, place = true } = {}) {
      if (open) close();
      if (focus) { if (openMenu) openMenu.close(); installGlobalListeners(); }
      opener = openerEl;
      const host = container || document.body;
      if (place) popup.style.position = container ? 'absolute' : 'fixed';
      host.appendChild(popup);
      open = true;
      if (focus) openMenu = api;
      if (!place) {
        if (opener) opener.setAttribute('aria-expanded', 'true');
        highlight(items[initialIndex] && !items[initialIndex].disabled ? initialIndex : firstEnabled());
        return api;
      }
      const size = popup.getBoundingClientRect();
      const hostRect = container ? container.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      let anchorRect;
      if (point) anchorRect = { left: point.x, top: point.y, width: 0, height: 0 };
      else if (anchor && anchor.getBoundingClientRect && anchor.isConnected) anchorRect = anchor.getBoundingClientRect();
      else if (anchor && typeof anchor.left === 'number') anchorRect = anchor;
      else anchorRect = hostRect;
      const local = { left: anchorRect.left - hostRect.left, top: anchorRect.top - hostRect.top, width: anchorRect.width, height: anchorRect.height };
      const spot = placePopup(local, size, { left: 0, top: 0, width: hostRect.width, height: hostRect.height }, { prefer, align: point ? 'start' : align, gap: point ? 0 : 4 });
      popup.style.left = `${spot.left}px`;
      popup.style.top = `${spot.top}px`;
      if (opener) opener.setAttribute('aria-expanded', 'true');
      const start = items[initialIndex] && !items[initialIndex].disabled ? initialIndex : firstEnabled();
      highlight(Math.max(-1, Math.min(items.length - 1, start)));
      return api;
    },
  };
  return api;
}

// MenuButton({ label, groups, icon }) — a ⋯ button that opens a focus-mode
// Menu beside itself. Returns { button, open, openAt } (openAt for a row's
// contextmenu event).
export function MenuButton({ label, groups, icon = '⋯', className = '' } = {}) {
  const button = h('button', {
    type: 'button',
    className: ['btn', 'row-menu-btn', className].filter(Boolean).join(' '),
    text: icon,
    title: label,
    attrs: { 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  });
  let menu = null;
  const build = () => Menu({ label, groups: typeof groups === 'function' ? groups() : groups, focus: true });
  function openMenuAt(point = null) {
    const wasOpen = menu && menu.isOpen();
    if (menu) menu.close();
    if (wasOpen && !point) return;
    menu = build();
    menu.open({ anchor: button, point, align: 'end', openerEl: button });
  }
  button.addEventListener('click', (event) => { event.stopPropagation(); openMenuAt(); });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); openMenuAt(); }
  });
  return {
    button,
    open: () => openMenuAt(),
    openAt: (event) => { event.preventDefault(); openMenuAt({ x: event.clientX, y: event.clientY }); },
  };
}
