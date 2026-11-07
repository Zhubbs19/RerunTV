// Entry point for the cable-guide UI's shared pieces. Pages (listings,
// program info, menus — later build steps) import from here; app.js calls
// installCableGuide() once at boot.
import { registerCoreHook } from '../plugin/host.js';
import { CABLE_GUIDE_UI, LEGACY_UI } from './model.js';
import { currentUiMode } from './mode.js';
import { wholeRows } from './page.js';
import { syncListingsPicture } from './listings.js';
import { hidePictureBox, pictureBox, showPictureBox } from './picture-box.js';
import { installSetupShell } from './setup-shell.js';

export { createGuideHeader } from './header.js';
export { hidePictureBox, pictureBox, showPictureBox } from './picture-box.js';
export { currentUiMode } from './mode.js';

// Set once `installCableGuide()` has run.
let installed = false;

/**
 * Installs the cable-guide UI's shared pieces once: the layout-change hook and the setup shell.
 */
export function installCableGuide() {
  if (installed) return;
  installed = true;
  // Switching to a legacy theme while a cable-guide page is up must not leave
  // overlay plugins dodging a picture box that no longer exists.
  registerCoreHook('ui-mode-change', (mode) => { if (mode === LEGACY_UI) hidePictureBox(); });
  // Switching TV / desktop mode changes the grid (--grid-units) without
  // resizing the screen, so the pages' resize watches never fire: put the
  // picture back where the header now leaves room for it.
  window.addEventListener('usage-mode-change', () => {
    if (!pictureBox()) return;
    const grid = document.getElementById('guide-grid');
    const crt = document.querySelector('#tv-screen .crt');
    if (grid && !grid.classList.contains('hidden') && grid.classList.contains('full')) syncListingsPicture(grid, crt);
    else showPictureBox(crt);
  });
  // The full guide shows whole channel rows above its hint line; the Mini
  // Guide already sizes itself to three.
  const guide = document.getElementById('guide-grid');
  const guideRows = guide && guide.querySelector('.guide-rows');
  // A layout or dock change resizes the grid, which re-fits it.
  if (guideRows) wholeRows(guideRows, () => currentUiMode() === CABLE_GUIDE_UI && guide.classList.contains('full') && !guide.classList.contains('docked'));
  installSetupShell();
}
