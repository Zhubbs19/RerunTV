// Entry point for the cable-guide UI's shared pieces. Pages (listings,
// program info, menus — later build steps) import from here; app.js calls
// installCableGuide() once at boot.
import { registerCoreHook } from '../plugin/host.js';
import { LEGACY_UI } from './model.js';
import { syncListingsPicture } from './listings.js';
import { hidePictureBox, pictureBox, showPictureBox } from './picture-box.js';
import { installSetupShell } from './setup-shell.js';

export { createGuideHeader } from './header.js';
export { hidePictureBox, pictureBox, showPictureBox } from './picture-box.js';
export { currentUiMode } from './mode.js';

let installed = false;

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
  installSetupShell();
}
