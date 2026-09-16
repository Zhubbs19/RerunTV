// On-screen keyboard (docs/design/01 §3, §6.4): text entry with a D-pad, for
// renaming a channel or typing call letters from the couch. A kit
// ModalSurface of kit Buttons, so ◀▲▼▶ move between keys by position, OK
// types, Back cancels. Returns a promise of the text, or null when cancelled.
import { OSK_ROWS, applyOskKey } from '../tv/setup-model.js';
import { Button } from './button.js';
import { ModalSurface } from './dialog.js';
import { h } from './kit-core.js';

let surface = null;
let finish = null;

function close(result) {
  const done = finish;
  finish = null;
  if (surface) { surface.close(); surface = null; }
  if (done) done(result);
}

export function onScreenKeyboardOpen() {
  return !!surface;
}

export function openOnScreenKeyboard({ title = 'ENTER TEXT', value = '', maxLength = 60 } = {}) {
  if (surface) close(null);
  return new Promise((resolve) => {
    finish = resolve;
    let text = String(value || '').toUpperCase().slice(0, maxLength);
    // On the page, not inside the TV screen: it can open over the docked guide.
    surface = ModalSurface({ className: 'osk', label: title, onCancel: () => close(null) });
    const field = h('div', { className: 'osk-field', attrs: { 'aria-live': 'polite' } });
    const paint = () => { field.textContent = text || ' '; field.dataset.empty = text ? '' : '1'; };
    paint();
    const panel = h('div', { className: 'osk-panel' }, h('div', { className: 'osk-title', text: title }), field);
    OSK_ROWS.forEach((row) => {
      panel.appendChild(h('div', { className: 'osk-row' }, row.map((key) => Button({
        label: key,
        isDefault: key === 'DONE',
        bare: true,
        className: `osk-key${key.length > 1 ? ' wide' : ''}`,
        onPress: () => {
          const result = applyOskKey(text, key, { maxLength });
          text = result.value;
          paint();
          if (result.done) close(text);
        },
      }))));
    });
    // A keyboard still types directly (desktop, or a Bluetooth keyboard).
    surface.el.addEventListener('keydown', (event) => {
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
    surface.el.appendChild(panel);
    surface.open({ initialFocus: false });
    // Start on the first letter, not DONE, so typing is one OK away.
    const first = surface.el.querySelector('.osk-key');
    if (first) first.focus();
  });
}
