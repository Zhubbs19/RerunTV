// Listings by Time on the cable-guide layout. The guide itself is the legacy
// #guide-grid (guide/guide.js), restyled by cable-guide.css, so every guide
// feature, hook and plugin marker keeps working; this file only does what CSS
// can't: keep the live picture lined up with the hole the page leaves for it.
//
// The hole is a mask on #guide-grid (--listings-hole-* in grid pixels); #player is
// placed under it through the published picture box (--picture-box-*, in the
// .crt's local pixels), which also tells overlay plugins to keep clear.
import { CABLE_GUIDE_UI, listingsPictureBox } from './model.js';
import { currentUiMode } from './mode.js';
import { gridUnits, pictureBox, setPictureBox } from './picture-box.js';

// The sides of the picture hole, as CSS custom property suffixes.
const HOLE_VARS = ['left', 'top', 'width', 'height'];

/**
 * Removes the picture hole from the guide grid.
 * @param {HTMLElement} grid The `#guide-grid` element.
 */
function clearHole(grid) {
  HOLE_VARS.forEach((key) => grid.style.removeProperty(`--listings-hole-${key}`));
}

/**
 * Tells whether the full guide should show the live picture in its corner.
 * @param {HTMLElement} grid The `#guide-grid` element.
 * @param {HTMLElement} crt The screen's `.crt` element.
 * @returns {boolean} True on the cable-guide layout with the full guide open and the preview allowed.
 */
export function listingsShowPicture(grid, crt) {
  return currentUiMode() === CABLE_GUIDE_UI
    && !grid.classList.contains('hidden')
    && grid.classList.contains('full')
    && !crt.classList.contains('guide-preview-hidden');
}

/**
 * Call after anything that can move or resize the grid or the screen, and on
 * close. Cheap: two rect reads, and the published box only changes when the
 * numbers do.
 * @param {?HTMLElement} grid The `#guide-grid` element.
 * @param {?HTMLElement} crt The screen's `.crt` element.
 */
export function syncListingsPicture(grid, crt) {
  if (!grid || !crt) return;
  if (!listingsShowPicture(grid, crt)) {
    clearHole(grid);
    if (pictureBox()) setPictureBox(null);
    return;
  }
  const box = listingsPictureBox(grid.getBoundingClientRect(), crt.getBoundingClientRect(), crt.offsetWidth,
    document.documentElement.dataset.guideLayout, gridUnits());
  if (!box) return;
  HOLE_VARS.forEach((key) => grid.style.setProperty(`--listings-hole-${key}`, `${box.hole[key]}px`));
  setPictureBox(box.picture);
}
