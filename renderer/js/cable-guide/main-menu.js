// The TV menu on the cable-guide layout, drawn inside the legacy
// #shortcuts-overlay. tv/menu.js still owns the items, submenus and what
// they do; this file only draws them the cable-guide way and turns keys
// into the callbacks menu.js gives it.
//
// Two states, as on the boxes it copies: the first Menu press shows the
// Quick Menu (one row of icon tiles over the picture), the next shows the
// Main Menu (a full page: the shared header with the picture in its corner,
// two columns of five, More Choices for the next page). Pages of settings
// are `Label:  < value >` rows that ◀▶ change.
import { escapeHtml } from '../core/util.js';
import { createGuideHeader } from './header.js';
import { iconSvg } from './icons.js';
import { MENU_PAGE, MENU_ROWS, menuLabel, menuMove, menuPageOf } from './model.js';
import { hidePictureBox, showPictureBox } from './picture-box.js';
import { syncListingsPicture } from './listings.js';
import { currentMessageCount } from './page.js';

let mode = null; // 'quick' | 'main' | null
let host = null;
let quickEl = null;
let mainEl = null;
let header = null;
let view = null;
let layout = 'grid';
let focus = 0;
let callbacks = {};
let tiles = [];
let resizeWatch = null;

/**
 * Names the cable-guide menu that is up.
 * @returns {?string} 'quick', 'main', or null when neither is open.
 */
export function cgMenuMode() {
  return mode;
}

/**
 * The Main Menu item in focus (tv/menu.js redraws at it when the layout
 * changes under the menu).
 * @returns {number} The focused item's index.
 */
export function cgMenuFocus() {
  return focus;
}

/**
 * Finds the screen element a menu overlay sits in.
 * @param {HTMLElement} el The menu's host overlay.
 * @returns {?HTMLElement} The `.crt` element.
 */
function crtOf(el) {
  return el.closest('.crt') || document.querySelector('#tv-screen .crt');
}

// ---------- Quick Menu ----------

/**
 * Opens the Quick Menu: one row of icon tiles over the picture.
 * @param {HTMLElement} overlay The `#shortcuts-overlay` element.
 * @param {Array<object>} quickTiles The tiles (`label`, `icon`, `help`, `disabled`, `toMain`, `run`).
 * @param {object} cb Callbacks from tv/menu.js (`toMain`, `close`).
 */
export function openQuickMenu(overlay, quickTiles, cb) {
  host = overlay;
  closeMain();
  mode = 'quick';
  tiles = quickTiles;
  callbacks = cb;
  focus = 0;
  host.classList.add('cg-menu-open', 'cg-quick-open');
  host.classList.remove('cg-main-open');
  if (!quickEl) {
    quickEl = document.createElement('div');
    quickEl.className = 'cg-quick';
    quickEl.setAttribute('role', 'toolbar');
    quickEl.setAttribute('aria-label', 'Quick Menu');
    host.appendChild(quickEl);
  }
  hidePictureBox();
  paintQuick();
}

/**
 * Redraws the Quick Menu tiles and the focused tile's line.
 */
function paintQuick() {
  const current = tiles[focus] || {};
  quickEl.innerHTML = `
    <div class="cg-quick-title">Quick Menu</div>
    <div class="cg-quick-tiles">${tiles.map((t, i) => `<button type="button" class="cg-tile${i === focus ? ' focus' : ''}${t.disabled ? ' cg-tile-muted' : ''}" data-index="${i}" aria-label="${escapeHtml(t.label)}">${iconSvg(t.icon)}</button>`).join('')}</div>
    <div class="cg-quick-line"><span class="cg-quick-name">${escapeHtml(current.label || '')}</span>${current.help ? ` - ${escapeHtml(current.help)}` : ''}</div>`;
  quickEl.querySelectorAll('.cg-tile').forEach((tile) => {
    const i = Number(tile.dataset.index);
    tile.addEventListener('pointermove', (e) => {
      if ((e.movementX || e.movementY) && focus !== i) { focus = i; paintQuick(); }
    });
    tile.addEventListener('click', (e) => { e.stopPropagation(); focus = i; runTile(); });
  });
}

/**
 * Runs the focused Quick Menu tile, or moves on to the Main Menu for its More tile.
 */
function runTile() {
  const tile = tiles[focus];
  if (!tile || tile.disabled) return;
  if (tile.toMain) { callbacks.toMain(); return; }
  callbacks.close();
  tile.run();
}

// ---------- Main Menu ----------

/**
 * Picks how a menu view is laid out.
 * @param {object} v The menu view (`items`, optional `columns`).
 * @returns {string|number} A column count for a keypad, 'rows' when any item has a value to change, otherwise 'grid'.
 */
function layoutOf(v) {
  if (typeof v.columns === 'number' && v.columns > 1) return v.columns;
  return v.items.some((item) => typeof item.adjust === 'function') ? 'rows' : 'grid';
}

/**
 * "TV MENU · CHANNELS" → "Channels"; the root is "Main Menu".
 * @param {object} v The menu view.
 * @returns {string} The header's where line.
 */
function whereOf(v) {
  if (v.where) return v.where;
  const parts = String(v.title || '').split(' · ').filter((p) => p && p !== 'TV MENU');
  return parts.length ? parts.map(menuLabel).join(' › ') : 'Main Menu';
}

/**
 * Gives a menu item's display name, without the value part of a `Label: value` setting.
 * @param {object} item The menu item.
 * @returns {string} The name in menu case.
 */
function itemName(item) {
  // Text that is the viewer's own (a channel's name) is shown as written.
  if (item.text) return item.text;
  if (item.name) return menuLabel(item.name);
  const label = String(item.label || '');
  const colon = typeof item.adjust === 'function' ? label.indexOf(': ') : -1;
  return menuLabel(colon > 0 ? label.slice(0, colon) : label);
}

/**
 * Gives a setting item's current value.
 * @param {object} item The menu item.
 * @returns {string} The value in menu case, or '' when the item has none.
 */
function itemValue(item) {
  if (item.value != null) return menuLabel(String(item.value));
  const label = String(item.label || '');
  const colon = label.indexOf(': ');
  return colon > 0 ? menuLabel(label.slice(colon + 2)) : '';
}

/**
 * Gives the header help line for a menu item.
 * @param {object} item The menu item.
 * @returns {string} The item's own help, or a hint for how to use it.
 */
function itemHelp(item) {
  if (item.help) return item.help;
  if (typeof item.adjust === 'function') return 'Press ◀ ▶ to change this setting.';
  if (item.submenu) return 'Press OK to open.';
  return '';
}

/**
 * Draws a Main Menu view as a full page, replacing the Quick Menu.
 * @param {HTMLElement} overlay The `#shortcuts-overlay` element.
 * @param {object} v The menu view (`title`, `items`, optional `columns`).
 * @param {number} focusIndex The item to focus.
 * @param {object} cb Callbacks from tv/menu.js (`activate`, `adjust`, `back`, `close`).
 */
export function renderMainMenu(overlay, v, focusIndex, cb) {
  host = overlay;
  callbacks = cb;
  view = v;
  layout = layoutOf(v);
  focus = Math.max(0, Math.min(v.items.length - 1, focusIndex || 0));
  if (quickEl) { quickEl.remove(); quickEl = null; }
  if (!mainEl) {
    mainEl = document.createElement('div');
    mainEl.className = 'cg-surface cg-menu';
    mainEl.innerHTML = '<div class="cg-frame"><div class="cg-menu-items" role="menu"></div><div class="cg-more"></div></div>';
    header = createGuideHeader();
    mainEl.querySelector('.cg-frame').prepend(header.el);
    header.setMessages(currentMessageCount());
    host.appendChild(mainEl);
  }
  mode = 'main';
  host.classList.add('cg-menu-open', 'cg-main-open');
  host.classList.remove('cg-quick-open');
  showPictureBox(crtOf(host));
  // The screen can still be settling (or be resized) while the page is up;
  // keep the picture box on its current size.
  if (!resizeWatch && typeof ResizeObserver !== 'undefined') {
    resizeWatch = new ResizeObserver(() => { if (mode === 'main') showPictureBox(crtOf(host)); });
    resizeWatch.observe(crtOf(host));
  }
  paintMain();
}

/**
 * Redraws the Main Menu's current page and the header for the focused item.
 */
function paintMain() {
  const items = view.items;
  const perPage = layout === 'rows' ? MENU_ROWS : (typeof layout === 'number' ? items.length : MENU_PAGE);
  const page = typeof layout === 'number' ? 0 : menuPageOf(focus, layout === 'rows' ? 'rows' : 'grid');
  const start = page * perPage;
  const shown = items.slice(start, start + perPage);
  const box = mainEl.querySelector('.cg-menu-items');
  box.className = `cg-menu-items cg-menu-${typeof layout === 'number' ? 'pad' : layout}`;
  box.style.gridTemplateColumns = typeof layout === 'number' ? `repeat(${layout}, 1fr)` : '';
  box.innerHTML = shown.map((item, k) => {
    const i = start + k;
    const cls = `${i === focus ? ' focus' : ''}${item.disabled ? ' cg-disabled' : ''}`;
    if (layout === 'rows') {
      const isValue = typeof item.adjust === 'function';
      return `<div class="cg-row${cls}" data-index="${i}" role="menuitem"><span class="cg-row-label">${escapeHtml(itemName(item))}${isValue ? ':' : ''}</span>`
        + (isValue
          ? `<span class="cg-row-value"><span class="cg-arrow" data-dir="-1">‹</span><span class="cg-value">${escapeHtml(itemValue(item))}</span><span class="cg-arrow" data-dir="1">›</span></span>`
          : '<span class="cg-row-value"><span class="cg-value cg-value-action">Open</span></span>')
        + '</div>';
    }
    return `<button type="button" class="cg-btn cg-menu-btn${cls}" data-index="${i}" role="menuitem">${escapeHtml(itemName(item))}</button>`;
  }).join('');
  const more = mainEl.querySelector('.cg-more');
  more.textContent = typeof layout !== 'number' && start + perPage < items.length ? 'More Choices' : '';
  box.querySelectorAll('[data-index]').forEach((el) => {
    const i = Number(el.dataset.index);
    el.addEventListener('pointermove', (e) => {
      if ((e.movementX || e.movementY) && focus !== i) { focus = i; paintMain(); }
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      focus = i;
      const arrow = e.target.closest('.cg-arrow');
      if (arrow && typeof items[i].adjust === 'function') callbacks.adjust(i, Number(arrow.dataset.dir));
      else callbacks.activate(i);
    });
  });
  const item = items[focus] || {};
  const name = item.label ? itemName(item) : '';
  header.setFocus({
    where: whereOf(view),
    name: typeof item.adjust === 'function' && name ? `${name}: ${itemValue(item)}` : name,
    help: itemHelp(item),
  });
}

// ---------- Keys ----------
/**
 * Returns true when the key was the menu's.
 * @param {KeyboardEvent} e The key event.
 * @returns {boolean} True when a menu was up and took the key.
 */
export function cgMenuKey(e) {
  if (mode === 'quick') {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      focus = Math.max(0, Math.min(tiles.length - 1, focus + (e.key === 'ArrowLeft' ? -1 : 1)));
      paintQuick();
    } else if (e.key === 'Enter' || e.key === ' ') runTile();
    else if (e.key === '?') callbacks.toMain();
    else if (e.key === 'Escape' || e.key === 'Backspace') callbacks.close();
    return true;
  }
  if (mode !== 'main') return false;
  const items = view.items;
  if (e.key === 'Enter' || e.key === ' ') { callbacks.activate(focus); return true; }
  if (e.key === '?') { callbacks.close(); return true; }
  if (e.key === 'Escape' || e.key === 'Backspace') { callbacks.back(); return true; }
  if (e.key === 'Tab') {
    e.preventDefault();
    // Past disabled entries (the number pad's blank key, an empty list's note).
    let next = focus;
    for (let n = 0; n < items.length; n += 1) {
      next = (next + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      if (!items[next].disabled) break;
    }
    focus = next;
    paintMain();
    return true;
  }
  const move = menuMove(focus, items.length, e.key, layout);
  if (move.edge && layout === 'rows' && typeof (items[focus] || {}).adjust === 'function') {
    callbacks.adjust(focus, move.edge === 'right' ? 1 : -1);
    return true;
  }
  if (move.edge === 'left') { callbacks.back(); return true; }
  if (move.index !== focus && move.index >= 0) { focus = move.index; paintMain(); }
  return true;
}

// ---------- Close ----------
/**
 * Removes the Main Menu page and its header, watcher and picture box.
 */
function closeMain() {
  if (resizeWatch) { resizeWatch.disconnect(); resizeWatch = null; }
  if (header) { header.destroy(); header = null; }
  if (mainEl) { mainEl.remove(); mainEl = null; }
  hidePictureBox();
  // The menu can open over the full guide (it steps aside, cable-guide.css);
  // hand the picture back to the guide's own hole.
  const grid = document.getElementById('guide-grid');
  if (grid) syncListingsPicture(grid, document.querySelector('#tv-screen .crt'));
}

/**
 * Closes whichever cable-guide menu is up and clears its state.
 */
export function closeCgMenu() {
  closeMain();
  if (quickEl) { quickEl.remove(); quickEl = null; }
  if (host) host.classList.remove('cg-menu-open', 'cg-quick-open', 'cg-main-open');
  mode = null;
  view = null;
  tiles = [];
}
