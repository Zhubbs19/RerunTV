// Program info on the cable-guide layout: what the legacy guide shows as a
// program-actions popover becomes a page inside #guide-grid. The guide's own
// header (title, time, channel, rating, description) stays on top; below it
// sit the full description and a row of square action tiles, with the
// focused tile's meaning on one line underneath.
//
// It takes the same items the popover would (label, run, className, icon),
// so plugin actions from the guide-program-actions hook come along, and it
// returns the same controller shape guide.js keeps in `popover`.
import { escapeHtml } from '../core/util.js';
import { actionIcon, actionMeaning, stepTile } from './model.js';

const ICONS = {
  back: '<path d="M8 4 2 10l6 6v-4h10V8H8z"/>',
  play: '<path d="M5 3v14l12-7z"/>',
  start: '<path d="M3 3h2v14H3zM18 3v14L7 10z"/>',
  info: '<path d="M9 8h2v8H9zm0-4h2v2H9z"/><path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>',
  record: '<circle cx="10" cy="10" r="6" class="cg-icon-rec"/>',
  series: '<circle cx="7" cy="10" r="4.5" class="cg-icon-rec"/><circle cx="14" cy="10" r="4.5" class="cg-icon-rec"/>',
  remind: '<path d="M10 19a2 2 0 0 0 2-2H8a2 2 0 0 0 2 2zm6-5V9a6 6 0 0 0-4.5-5.8V2.5a1.5 1.5 0 0 0-3 0v.7A6 6 0 0 0 4 9v5l-2 2v1h16v-1z"/>',
  list: '<path d="M3 4h14v2H3zm0 5h14v2H3zm0 5h14v2H3z"/>',
  'day-back': '<path d="M12 4 6 10l6 6V4z"/><path d="M15 4h2v12h-2z"/>',
  'day-ahead': '<path d="M8 4l6 6-6 6V4z"/><path d="M3 4h2v12H3z"/>',
  menu: '<path d="M2 3h7v6H2zm9 0h7v6h-7zM2 11h7v6H2zm9 0h7v6h-7z"/>',
  favorite: '<path d="M10 18 8.6 16.7C3.4 12 0 9 0 5.3 0 2.3 2.4 0 5.5 0 7.2 0 8.9.8 10 2.1 11.1.8 12.8 0 14.5 0 17.6 0 20 2.3 20 5.3c0 3.7-3.4 6.7-8.6 11.4z" transform="scale(.9) translate(1.1 1.5)"/>',
  lock: '<path d="M15 8h-1V6a4 4 0 0 0-8 0v2H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1zM8 6a2 2 0 0 1 4 0v2H8z"/>',
  mark: '<path d="M5 2h10v16l-5-4-5 4z"/>',
};

function tileHtml(item, index) {
  const icon = actionIcon(item.label, item.icon);
  const inner = icon
    ? `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[icon]}</svg>`
    : `<span class="cg-tile-text">${escapeHtml(String(item.label).slice(0, 4))}</span>`;
  const muted = item.className && item.className.split(/\s+/).includes('past') ? ' cg-tile-muted' : '';
  return `<button type="button" class="cg-tile${muted}" data-index="${index}" aria-label="${escapeHtml(actionMeaning(item.label))}">${inner}</button>`;
}

export function openProgramInfo({ grid, items, description = '', onClose }) {
  const back = { label: 'Back', icon: 'back', run: () => {} };
  const all = [back, ...items];
  let index = all.length > 1 ? 1 : 0;
  let closed = false;

  const el = document.createElement('div');
  el.className = 'cg-program-info';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Program info');
  el.innerHTML = `
    <div class="cg-info-desc"></div>
    <div class="cg-tiles" role="toolbar" aria-label="Program actions">${all.map(tileHtml).join('')}</div>
    <div class="cg-tile-meaning"></div>`;
  const descEl = el.querySelector('.cg-info-desc');
  descEl.textContent = description || 'No description available.';
  descEl.classList.toggle('cg-info-desc-empty', !description);
  const tiles = Array.from(el.querySelectorAll('.cg-tile'));
  const meaning = el.querySelector('.cg-tile-meaning');

  const paint = () => {
    tiles.forEach((tile, i) => tile.classList.toggle('focus', i === index));
    meaning.textContent = actionMeaning(all[index] && all[index].label === 'Back' ? 'Go back to the guide' : all[index].label);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    grid.classList.remove('cg-info-open');
    el.remove();
    if (onClose) onClose();
  };

  const activate = (i) => {
    const item = all[i];
    close();
    if (item && item !== back) item.run();
  };

  tiles.forEach((tile, i) => {
    // Only a real mouse move takes focus. The page can open under a resting
    // pointer, and Chromium's synthetic moves after layout carry no movement.
    tile.addEventListener('pointermove', (e) => {
      if (!e.movementX && !e.movementY) return;
      if (index !== i) { index = i; paint(); }
    });
    tile.addEventListener('click', (e) => { e.stopPropagation(); activate(i); });
  });

  grid.appendChild(el);
  grid.classList.add('cg-info-open');
  paint();

  const controller = {
    // guide.js's popover contract: 'up' | 'down' | 'ok' | 'close'.
    key(action) {
      if (action === 'ok') activate(index);
      else if (action === 'close') close();
    },
    // Full key events, so left/right can walk the tiles.
    handleKey(e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        index = stepTile(index, tiles.length, e.key === 'ArrowLeft' ? -1 : 1);
        paint();
        return true;
      }
      if (e.key === 'Enter' || e.key === ' ') { activate(index); return true; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return true;
      close();
      return true;
    },
    close,
  };
  return controller;
}
