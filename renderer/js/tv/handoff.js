// "Edit on your phone or computer" (docs/design/01 §7). Anything too heavy for
// a remote — folders, blocks, flows, the ad pool — is done on another device:
// this shows a QR and the address to open.
//
// It points at the Companion page (remote control + settings) today. When the
// web control panel (docs/design/06) exists, main-tv-client.js's handoffInfo
// gains a deep link per task and this screen doesn't change.
import { tvScreen } from '../core/dom.js';
import { ModalSurface } from '../ui/dialog.js';

// The open ModalSurface and its element, or null while closed.
let surface = null;
let overlay = null;

/**
 * Tests whether the handoff screen is open.
 * @returns {boolean} True while it is shown.
 */
export function handoffOpen() {
  return !!overlay;
}

/**
 * Closes the handoff screen.
 */
export function closeHandoff() {
  if (surface) { surface.close(); surface = null; }
  overlay = null;
}

/**
 * Opens the handoff screen and fills in the address and QR code from the host.
 * @param {object} [opts={}] Passed to `window.api.getHandoffInfo`.
 * @returns {Promise<void>} Resolves once the address is shown.
 */
export async function openHandoff(opts = {}) {
  if (overlay) return;
  surface = ModalSurface({ className: 'handoff', label: 'Edit on your phone or computer', host: () => tvScreen.querySelector('.crt') || tvScreen, onCancel: closeHandoff });
  overlay = surface.el;
  overlay.innerHTML = `
    <div class="handoff-panel">
      <div class="handoff-title">EDIT ON YOUR PHONE OR COMPUTER</div>
      <div class="handoff-body">
        <img class="handoff-qr hidden" alt="">
        <div class="handoff-text">
          <div class="handoff-url">Looking for this box's address…</div>
          <div class="handoff-label"></div>
        </div>
      </div>
      <button type="button" class="handoff-done">DONE</button>
    </div>`;
  const done = overlay.querySelector('.handoff-done');
  done.addEventListener('click', closeHandoff);
  surface.open();

  let info = { url: '', qrDataUrl: '', label: '' };
  try {
    if (window.api && window.api.getHandoffInfo) info = await window.api.getHandoffInfo(opts) || info;
  } catch (e) {
    info = { url: '', qrDataUrl: '', label: `Could not read this box's address (${e.message}).` };
  }
  if (!overlay) return;
  overlay.querySelector('.handoff-url').textContent = info.url || 'No address available';
  overlay.querySelector('.handoff-label').textContent = info.label || '';
  const img = overlay.querySelector('.handoff-qr');
  if (info.qrDataUrl) {
    img.src = info.qrDataUrl;
    img.alt = `QR code for ${info.url}`;
    img.classList.remove('hidden');
  }
}

