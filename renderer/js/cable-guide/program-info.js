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
import { iconSvg } from './icons.js';


function tileHtml(item, index) {
  const icon = actionIcon(item.label, item.icon);
  const inner = icon
    ? iconSvg(icon)
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
