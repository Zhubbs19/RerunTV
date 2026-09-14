// On-screen keyboard (docs/design/01 §3, §6.4): text entry with a D-pad, for
// renaming a channel or typing call letters from the couch. A dialog in the
// TV modal registry, so ◀▲▼▶ move between keys by position, OK types, Back
// cancels. Returns a promise of the text, or null when cancelled.
// A C4 component (docs/design/04) will replace this markup.
import { tvScreen } from '../dom.js';
import { OSK_ROWS, applyOskKey } from '../tv-setup-model.js';
import { registerTvModal } from '../tv-input.js';
import { createFocusScope } from './spatial-focus.js';

let overlay = null;
let finish = null;

function isOpen() {
  return !!overlay;
}

function close(result) {
  const done = finish;
  finish = null;
  if (overlay) {
    if (overlay._releaseScope) overlay._releaseScope();
    overlay.remove();
    overlay = null;
  }
  if (done) done(result);
}

export function openOnScreenKeyboard({ title = 'ENTER TEXT', value = '', maxLength = 60 } = {}) {
  if (overlay) close(null);
  return new Promise((resolve) => {
    finish = resolve;
    let text = String(value || '').toUpperCase().slice(0, maxLength);
    overlay = document.createElement('div');
    overlay.className = 'osk';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const panel = document.createElement('div');
    panel.className = 'osk-panel';
    const heading = document.createElement('div');
    heading.className = 'osk-title';
    heading.textContent = title;
    const field = document.createElement('div');
    field.className = 'osk-field';
    field.setAttribute('aria-live', 'polite');
    const paint = () => { field.textContent = text || ' '; field.dataset.empty = text ? '' : '1'; };
    paint();
    panel.append(heading, field);
    OSK_ROWS.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      row.forEach((key) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `osk-key${key.length > 1 ? ' wide' : ''}`;
        btn.textContent = key;
        if (key === 'DONE') btn.setAttribute('data-default', '');
        btn.addEventListener('click', () => {
          const result = applyOskKey(text, key, { maxLength });
          text = result.value;
          paint();
          if (result.done) close(text);
        });
        rowEl.appendChild(btn);
      });
      panel.appendChild(rowEl);
    });
    // A keyboard still types directly (desktop, or a Bluetooth keyboard).
    overlay.addEventListener('keydown', (event) => {
      if (event.key.length === 1 && /[a-z0-9 \-&'.]/i.test(event.key)) {
        text = applyOskKey(text, event.key === ' ' ? 'SPACE' : event.key.toUpperCase(), { maxLength }).value;
        paint();
        event.preventDefault();
        event.stopPropagation();
      } else if (event.key === 'Backspace') {
        text = applyOskKey(text, 'DELETE').value;
        paint();
        event.preventDefault();
        event.stopPropagation();
      }
    });
    overlay.appendChild(panel);
    (tvScreen.querySelector('.crt') || tvScreen).appendChild(overlay);
    overlay._releaseScope = createFocusScope(overlay);
    // Start on the first letter, not DONE, so typing is one OK away.
    const first = overlay.querySelector('.osk-key');
    if (first) first.focus();
  });
}

registerTvModal({ isOpen, element: () => overlay, cancel: () => close(null) });
