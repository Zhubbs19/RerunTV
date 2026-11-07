// Shutting down the PC from the box (SYSTEM › POWER, docs/design/03 §4).
//
// A PC under a TV is used like a cable box, and a cable box's power button is
// the last thing pressed at night. This gives that press somewhere to go: a
// SHUT DOWN PC action in the TV menu (desktop grid and the TV-mode SYSTEM
// section), an opt-in that makes the box's own power-off do the same, and the
// companion remote's button. All of them land on one countdown in the main
// process (main/system/shutdown.js), reached through window.api; what this
// file owns is the confirm, the on-screen countdown with CANCEL, and the two
// settings under config.pcPower:
//   enabled          — the whole feature; off until switched on in setup
//   shutDownWithBox  — power-off (P, the remote's power key, the TV menu's
//                      POWER OFF) also starts the countdown. Auto standby and
//                      "when the screen turns off" never do.
//
// Host window only: window.api.shutdownPc is a host-only contract method, so a
// LAN viewer or control client simply has none of this.
import { S, dispatch, saveConfigNow } from '../core/state.js';
import { Dialog, ModalSurface } from '../ui/dialog.js';
import { Button } from '../ui/button.js';
import { h, isTvMode } from '../ui/kit-core.js';
import { powerOn } from './power.js';

export const PC_SHUTDOWN_DELAY_SEC = 20;

// ---------- Settings ----------

/**
 * Reports whether this window can shut down the PC at all (host window only).
 * @returns {boolean} True when `window.api.shutdownPc` exists.
 */
export function pcShutdownAvailable() {
  return !!(window.api && typeof window.api.shutdownPc === 'function');
}

/**
 * Reports whether PC shutdown is available and switched on in setup.
 * @returns {boolean} True when `pcPower.enabled` is set on the host.
 */
export function pcShutdownEnabled() {
  return pcShutdownAvailable() && !!(S.config.pcPower && S.config.pcPower.enabled);
}

/**
 * Turns the PC-shutdown feature on or off (an undoable settings command).
 * @param {boolean} value The new setting.
 */
export function setPcShutdownEnabled(value) {
  dispatch({ type: 'settings.set', path: ['pcPower', 'enabled'], value: !!value });
}

/**
 * Reports whether powering off the box also starts the PC shutdown countdown.
 * @returns {boolean} True when the feature and `pcPower.shutDownWithBox` are both on.
 */
export function shutsDownPcWithBox() {
  return pcShutdownEnabled() && !!(S.config.pcPower && S.config.pcPower.shutDownWithBox);
}

/**
 * Sets whether powering off the box also shuts down the PC (an undoable settings command).
 * @param {boolean} value The new setting.
 */
export function setShutsDownPcWithBox(value) {
  dispatch({ type: 'settings.set', path: ['pcPower', 'shutDownWithBox'], value: !!value });
}

// ---------- Keys over live TV ----------
/**
 * Keeps keys inside a modal over live TV in desktop mode; Escape cancels.
 *
 * A modal over the TV screen in desktop mode would otherwise hand every key to
 * handleKey (app.js): Enter on CANCEL would also wake the box, an arrow would
 * change channel behind the dialog. In TV mode the modal stack (tv/input.js)
 * already routes the D-pad, OK and Back before handleKey, so nothing is held
 * back there.
 * @param {HTMLElement} el The modal element to guard.
 * @param {Function} onCancel Called when Escape is pressed.
 */
function guardTvKeys(el, onCancel) {
  el.addEventListener('keydown', (event) => {
    if (isTvMode()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
    const activates = (event.key === 'Enter' || event.key === ' ') && event.target && event.target.tagName === 'BUTTON';
    if (!activates && event.key !== 'Tab') event.preventDefault();
    event.stopPropagation();
  });
}

// ---------- Countdown overlay ----------

let overlay = null;        // ModalSurface while the countdown shows
let countEl = null;
// Interval that refreshes the on-screen count.
let tick = null;
// The last shutdown status received from the main process.
let current = { pending: false, at: null };
// True when the box powered itself off to start this countdown, so a cancel
// brings the picture back instead of leaving a dark screen.
let poweredOffForShutdown = false;

/**
 * Seconds left before the PC shuts down.
 * @param {?object} status A shutdown status `{ pending, at }`, `at` in epoch milliseconds.
 * @returns {number} Whole seconds remaining, 0 when nothing is pending.
 */
function remainingSec(status) {
  if (!status || !status.pending || !status.at) return 0;
  // Real time on purpose: this is a wall-clock deadline the OS holds, not
  // schedule time, so the time machine must not shift it.
  return Math.max(0, Math.ceil((status.at - Date.now()) / 1000));
}

/**
 * Updates the countdown number on screen.
 */
function renderCount() {
  if (countEl) countEl.textContent = String(remainingSec(current));
}

/**
 * Opens the countdown overlay with its CANCEL button, if it is not already open.
 */
function openOverlay() {
  if (overlay) return;
  overlay = ModalSurface({ className: 'confirm-dialog pc-shutdown-overlay', label: 'Shutting down this PC', onCancel: () => cancelPcShutdown() });
  const box = h('div', { className: 'confirm-dialog-box confirm-dialog-danger pc-shutdown-box' });
  box.appendChild(h('div', { className: 'confirm-dialog-title', text: 'SHUTTING DOWN THIS PC' }));
  countEl = h('div', { className: 'pc-shutdown-count', attrs: { 'aria-live': 'polite' } });
  box.appendChild(countEl);
  box.appendChild(h('div', { className: 'confirm-dialog-message', text: 'The computer turns off when the count reaches zero. Cancel here, with Back, or from the remote.' }));
  const row = h('div', { className: 'confirm-dialog-actions pc-shutdown-actions' });
  row.appendChild(Button({ label: 'CANCEL', variant: 'primary', isDefault: true, onPress: () => cancelPcShutdown() }));
  box.appendChild(row);
  overlay.el.appendChild(box);
  guardTvKeys(overlay.el, () => cancelPcShutdown());
  overlay.open();
  renderCount();
  clearInterval(tick);
  tick = setInterval(renderCount, 250);
}

/**
 * Closes the countdown overlay and stops its refresh timer.
 */
function closeOverlay() {
  clearInterval(tick); tick = null;
  if (overlay) overlay.close();
  overlay = null;
  countEl = null;
}

/**
 * Every status change, from this window or a remote, lands here.
 * @param {?object} status The shutdown status `{ pending, at }` from the main process.
 */
function applyStatus(status) {
  const wasPending = current.pending;
  current = status && typeof status === 'object' ? status : { pending: false, at: null };
  if (current.pending) {
    if (!wasPending) {
      // The OS will close the app without asking; make sure nothing typed in
      // the last few seconds is still waiting in the save debounce.
      Promise.resolve(saveConfigNow()).catch(() => {});
    }
    openOverlay();
    renderCount();
    return;
  }
  closeOverlay();
  if (wasPending && poweredOffForShutdown && !S.isPoweredOn) powerOn();
  poweredOffForShutdown = false;
}

// ---------- Actions ----------

/**
 * Starts the countdown without asking: the caller has confirmed already (the
 * dialog below, the setting, or the phone's own confirm).
 * @param {object} [opts={}] Where the request came from.
 * @param {string} [opts.source='box'] Who asked, passed to the main process (for example 'menu' or 'power-off').
 * @param {boolean} [opts.poweredOffBox=false] True when the box powered off to start this, so a cancel turns it back on.
 * @returns {Promise<boolean>} True when the countdown started.
 */
export async function startPcShutdown({ source = 'box', poweredOffBox = false } = {}) {
  if (!pcShutdownEnabled()) return false;
  poweredOffForShutdown = !!poweredOffBox;
  let status;
  try {
    status = await window.api.shutdownPc({ delaySec: PC_SHUTDOWN_DELAY_SEC, source });
  } catch (e) {
    status = { pending: false, error: e && e.message ? e.message : String(e) };
  }
  applyStatus(status);
  if (status && status.error && !status.pending) console.warn('[pc-power]', status.error);
  return !!(status && status.pending);
}

/**
 * Asks the main process to cancel a pending shutdown and applies the resulting status.
 * @returns {Promise<void>}
 */
export async function cancelPcShutdown() {
  if (!pcShutdownAvailable()) return;
  let status;
  try { status = await window.api.cancelPcShutdown(); } catch (e) { status = { pending: false }; }
  applyStatus(status);
}

/**
 * Reports whether a shutdown countdown is running.
 * @returns {boolean} True while the countdown is pending.
 */
export function pcShutdownPending() {
  return !!current.pending;
}

/**
 * The TV menu's SHUT DOWN PC: confirm, then count down. Resolves true once
 * the countdown is running.
 * @returns {Promise<boolean>} True when the countdown is running, false if declined or disabled.
 */
export async function confirmPcShutdown() {
  if (!pcShutdownEnabled()) return false;
  if (current.pending) return true;
  const dialog = Dialog({
    title: 'SHUT DOWN THIS PC',
    message: `The computer shuts down after a ${PC_SHUTDOWN_DELAY_SEC}-second countdown. You can cancel from the screen or the remote until then.`,
    kind: 'confirm-danger',
    danger: true,
    dismissValue: false,
    actions: [
      { label: 'KEEP WATCHING', value: false, isDefault: true },
      { label: 'SHUT DOWN', variant: 'danger', value: true },
    ],
  });
  guardTvKeys(dialog.el, () => dialog.close(false));
  const ok = await dialog.result;
  if (!ok) return false;
  return startPcShutdown({ source: 'menu' });
}

// ---------- Install ----------

/**
 * Called from app.js once the TV screen is up, host window only. A countdown
 * a remote started before this window opened still shows.
 */
export function installPcPower() {
  if (!pcShutdownAvailable()) return;
  if (typeof window.api.onPcShutdownChanged === 'function') window.api.onPcShutdownChanged(applyStatus);
  Promise.resolve(window.api.getPcShutdownStatus()).then(applyStatus).catch(() => {});
}
