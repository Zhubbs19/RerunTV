// Where the live picture sits while a cable-guide page is up: a box in the
// header's top-right corner (cable-guide/model.js pictureBoxRect). Published
// so overlay plugins can stay clear of it, two ways:
//   html[data-picture-box] plus --picture-box-left/-top/-width/-height (px,
//     relative to the .crt screen) — for CSS
//   'picture-box-change' core hook — called with the rect, or null when the
//     picture is full screen again
// Pages call showPictureBox() when they open and hidePictureBox() when they
// close; moving #player into the box is the page's job (step 2 onward).
import { runCoreHooks } from '../plugin/host.js';
import { GRID_UNITS, pictureBoxRect, sameRect } from './model.js';

// The published picture box in `.crt` local pixels, or null while the picture is full screen.
let current = null;

/**
 * The grid width the page CSS is using right now (cable-guide.css sets
 * --grid-units per usage mode), so the box lands where the header leaves it.
 * @returns {number} The `--grid-units` value, or `GRID_UNITS` when unset.
 */
export function gridUnits() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--grid-units'));
  return value > 0 ? value : GRID_UNITS;
}

/**
 * Publishes a picture box as CSS variables and the 'picture-box-change' hook, if it changed.
 * @param {?object} rect `{ left, top, width, height }` in `.crt` local pixels, or null to clear.
 */
function write(rect) {
  if (sameRect(rect, current)) return;
  current = rect;
  const root = document.documentElement;
  if (rect) {
    root.dataset.pictureBox = 'on';
    for (const key of ['left', 'top', 'width', 'height']) root.style.setProperty(`--picture-box-${key}`, `${rect[key]}px`);
  } else {
    delete root.dataset.pictureBox;
    for (const key of ['left', 'top', 'width', 'height']) root.style.removeProperty(`--picture-box-${key}`);
  }
  runCoreHooks('picture-box-change', rect ? { ...rect } : null);
}

/**
 * For a page that works out its own box (listings.js aligns it with a hole in
 * #guide-grid); rect is in the .crt's local pixels, or null.
 * @param {?object} rect `{ left, top, width, height }`, or null to clear.
 */
export function setPictureBox(rect) {
  write(rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null);
}

/**
 * Publishes the standard header-corner picture box for a screen.
 * @param {?HTMLElement} screenEl The `.crt` element; defaults to the TV screen's.
 * @returns {?object} The published rect, or null when there is no screen.
 */
export function showPictureBox(screenEl) {
  const crt = screenEl || document.querySelector('#tv-screen .crt');
  if (!crt) return null;
  write(pictureBoxRect(crt.clientWidth, crt.clientHeight, document.documentElement.dataset.guideLayout, gridUnits()));
  return current;
}

/**
 * Clears the picture box so the picture is full screen again.
 */
export function hidePictureBox() {
  write(null);
}

/**
 * Returns a copy of the published picture box.
 * @returns {?object} `{ left, top, width, height }`, or null when none is published.
 */
export function pictureBox() {
  return current ? { ...current } : null;
}
