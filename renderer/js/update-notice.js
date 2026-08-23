// The "update ready" toast (index.html #update-toast) and its wiring to
// main-updater.js's 'updates:status' IPC event. Kept separate from app.js
// (which just calls initUpdateNotice() once at boot) the same way
// migration-toast's own logic lives inline in app.js but this one is
// meaty enough — a real decision with two buttons, not just a dismiss —
// to earn its own file.
import { showSetupScreen } from './app.js';
import {
  updateToastEl, updateToastTextEl, updateToastViewNotesBtn, updateToastInstallBtn, updateToastDismissBtn,
} from './dom.js';

function hideToast() {
  if (updateToastEl) updateToastEl.classList.add('hidden');
}

function showToast(version) {
  if (!updateToastEl) return;
  updateToastTextEl.textContent = `RerunTV v${version} has been downloaded and is ready to install.`;
  updateToastEl.classList.remove('hidden');
}

async function jumpToReleaseNotes() {
  hideToast();
  await showSetupScreen();
  const helpTabBtn = document.querySelector('.setup-tab-btn[data-tab="help"]');
  if (helpTabBtn) helpTabBtn.click();
  document.getElementById('help-release-notes-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Called once at boot (app.js) — a no-op for the LAN viewer (window.api's
// browser-api-shim doesn't implement onUpdateStatus at all: a viewer is a
// read-only browser tab, never the thing that gets installed/restarted).
export function initUpdateNotice() {
  if (!window.api.onUpdateStatus) return;

  if (updateToastDismissBtn) updateToastDismissBtn.addEventListener('click', hideToast);
  if (updateToastViewNotesBtn) updateToastViewNotesBtn.addEventListener('click', jumpToReleaseNotes);
  if (updateToastInstallBtn) {
    updateToastInstallBtn.addEventListener('click', () => {
      // No confirmation dialog here — clicking this button (as opposed to
      // Later/dismiss) already is the confirmation. quitAndInstall() closes
      // every window; nothing left to do on this side once it's called.
      window.api.installUpdateNow();
    });
  }

  window.api.onUpdateStatus((status) => {
    if (status.state === 'downloaded' && status.showPopup) showToast(status.version);
    // showPopup: false means main-updater.js already set
    // autoUpdater.autoInstallOnAppQuit — it'll install quietly next quit,
    // nothing for this toast to do.
  });
}
