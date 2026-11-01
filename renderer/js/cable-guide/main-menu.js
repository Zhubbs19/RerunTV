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

export function cgMenuMode() {
  return mode;
}

function crtOf(el) {
  return el.closest('.crt') || document.querySelector('#tv-screen .crt');
}

// ---------- Quick Menu ----------
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

function runTile() {
  const tile = tiles[focus];
  if (!tile || tile.disabled) return;
  if (tile.toMain) { callbacks.toMain(); return; }
  callbacks.close();
  tile.run();
}

// ---------- Main Menu ----------
function layoutOf(v) {
  if (typeof v.columns === 'number' && v.columns > 1) return v.columns;
  return v.items.some((item) => typeof item.adjust === 'function') ? 'rows' : 'grid';
}

// "TV MENU · CHANNELS" → "Channels"; the root is "Main Menu".
function whereOf(v) {
  const parts = String(v.title || '').split(' · ').filter((p) => p && p !== 'TV MENU');
  return parts.length ? parts.map(menuLabel).join(' › ') : 'Main Menu';
}

function itemName(item) {
  if (item.name) return menuLabel(item.name);
  const label = String(item.label || '');
  const colon = typeof item.adjust === 'function' ? label.indexOf(': ') : -1;
  return menuLabel(colon > 0 ? label.slice(0, colon) : label);
}

function itemValue(item) {
  if (item.value != null) return menuLabel(String(item.value));
  const label = String(item.label || '');
  const colon = label.indexOf(': ');
  return colon > 0 ? menuLabel(label.slice(colon + 2)) : '';
}

function itemHelp(item) {
  if (item.help) return item.help;
  if (typeof item.adjust === 'function') return 'Press ◀ ▶ to change this setting.';
  if (item.submenu) return 'Press OK to open.';
  return '';
}

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
// Returns true when the key was the menu's.
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
    focus = (focus + (e.shiftKey ? -1 : 1) + items.length) % items.length;
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
function closeMain() {
  if (resizeWatch) { resizeWatch.disconnect(); resizeWatch = null; }
  if (header) { header.destroy(); header = null; }
  if (mainEl) { mainEl.remove(); mainEl = null; }
  hidePictureBox();
}

export function closeCgMenu() {
  closeMain();
  if (quickEl) { quickEl.remove(); quickEl = null; }
  if (host) host.classList.remove('cg-menu-open', 'cg-quick-open', 'cg-main-open');
  mode = null;
  view = null;
  tiles = [];
}
