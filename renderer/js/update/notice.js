// The "update ready" toast (index.html #update-toast) and its wiring to
// main-updater.js's 'updates:status' IPC event. Kept separate from app.js
// (which just calls initUpdateNotice() once at boot) the same way
// migration-toast's own logic lives inline in app.js but this one is
// meaty enough — a real decision with two buttons, not just a dismiss —
// to earn its own file.
import { showSetupScreen } from '../app.js';
import { renderHighlights } from './highlights.js';
import { playConfiguredSound } from '../core/audio.js';
import { readableReleaseNotes } from '../core/util.js';
import {
  updateToastEl, updateToastTextEl, updateToastViewNotesBtn, updateToastInstallBtn, updateToastDismissBtn,
  updateChangelogEl, updateChangelogVersionEl, updateChangelogTitleEl, updateChangelogBodyEl,
  updateChangelogViewAllBtn, updateChangelogDoneBtn,
} from '../core/dom.js';

import { isTvMode } from '../tv/usage-mode.js';
import { focusDefault, registerModal } from '../ui/focus.js';

// In TV mode the toast is a modal (D-pad focus, OK presses, Back = LATER) and
// goes away on its own so it can't hold the remote hostage over live TV.
const TV_TOAST_AUTO_HIDE_MS = 20000;
let toastTimer = null;
let pendingPostUpdate = null;
let postUpdatePreviouslyFocused = null;

function hideToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  if (updateToastEl) updateToastEl.classList.add('hidden');
}

function showToast(version) {
  if (!updateToastEl) return;
  // Explicit about what clicking Install actually does — the NSIS installer
  // itself now runs silently (main-updater.js's quitAndInstall(true, true)),
  // so there's no wizard of its own to explain this; this toast is the only
  // place the user learns it before the app closes out from under them.
  updateToastTextEl.textContent = `RerunTV v${version} is downloaded. Install now to restart and reopen automatically, or choose Later to keep watching.`;
  updateToastEl.classList.remove('hidden');
  playConfiguredSound('notification');
  if (isTvMode()) {
    focusDefault(updateToastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TV_TOAST_AUTO_HIDE_MS);
  }
}

async function jumpToReleaseNotes() {
  hideToast();
  await showSetupScreen();
  const helpTabBtn = document.querySelector('.setup-tab-btn[data-tab="help"]');
  if (helpTabBtn) helpTabBtn.click();
  document.getElementById('help-release-notes-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function acknowledgePostUpdate() {
  if (!pendingPostUpdate) return;
  const version = pendingPostUpdate.toVersion;
  pendingPostUpdate = null;
  try { await window.api.acknowledgePostUpdateNotice(version); } catch (e) { /* retry on next launch */ }
}

async function closePostUpdate({ openReleaseNotes = false } = {}) {
  if (!updateChangelogEl || updateChangelogEl.classList.contains('hidden')) return;
  updateChangelogEl.classList.add('hidden');
  await acknowledgePostUpdate();
  if (postUpdatePreviouslyFocused && postUpdatePreviouslyFocused.isConnected) {
    postUpdatePreviouslyFocused.focus({ preventScroll: true });
  }
  postUpdatePreviouslyFocused = null;
  if (openReleaseNotes) await jumpToReleaseNotes();
}

function showPostUpdate(notice) {
  if (!updateChangelogEl || !notice) return;
  pendingPostUpdate = notice;
  postUpdatePreviouslyFocused = document.activeElement;
  const from = notice.fromVersion ? `v${notice.fromVersion}` : null;
  const to = notice.toVersion ? `v${notice.toVersion}` : '';
  updateChangelogVersionEl.textContent = from ? `${from}  →  ${to}` : to;
  updateChangelogTitleEl.textContent = notice.name || `WHAT'S NEW IN RERUNTV ${to}`;
  updateChangelogBodyEl.textContent = readableReleaseNotes(notice.notes);
  const highlightsEl = document.getElementById('update-changelog-highlights');
  if (highlightsEl) renderHighlights(highlightsEl, { onGo: () => closePostUpdate(), showSetup: showSetupScreen });
  updateChangelogEl.classList.remove('hidden');
  playConfiguredSound('notification');
  updateChangelogDoneBtn.focus({ preventScroll: true });
}

function trapPostUpdateFocus(event) {
  if (!updateChangelogEl || updateChangelogEl.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation(); // else the same Back also reaches the TV exit prompt
    closePostUpdate();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [updateChangelogViewAllBtn, updateChangelogDoneBtn].filter(Boolean);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
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
  if (updateChangelogDoneBtn) updateChangelogDoneBtn.addEventListener('click', () => closePostUpdate());
  if (updateChangelogViewAllBtn) {
    updateChangelogViewAllBtn.addEventListener('click', () => closePostUpdate({ openReleaseNotes: true }));
  }
  if (updateChangelogEl) updateChangelogEl.addEventListener('keydown', trapPostUpdateFocus);
  if (updateChangelogEl) {
    registerModal({ isOpen: () => !updateChangelogEl.classList.contains('hidden'), element: () => updateChangelogEl, cancel: () => closePostUpdate() });
  }
  if (updateToastEl) {
    registerModal({
      isOpen: () => isTvMode() && !updateToastEl.classList.contains('hidden'),
      element: () => updateToastEl,
      cancel: hideToast,
    });
  }

  window.api.onUpdateStatus((status) => {
    if (status.state === 'downloaded' && status.showPopup) showToast(status.version);
    // showPopup: false means main-updater.js already set
    // autoUpdater.autoInstallOnAppQuit — it'll install quietly next quit,
    // nothing for this toast to do.
  });

  // Invoke rather than relying on a boot event: the listener is registered
  // only after config/plugin initialization, while the main process detects
  // the version transition earlier. Pulling the persisted notice cannot race.
  window.api.getPostUpdateNotice().then(showPostUpdate).catch(() => {});
}
