// On-screen keyboard (docs/design/01 §3, §6.4): text entry with a D-pad, for
// renaming a channel or typing call letters from the couch. A kit
// ModalSurface of kit Buttons, so ◀▲▼▶ move between keys by position, OK
// types, Back cancels. Returns a promise of the text, or null when cancelled.
import { OSK_LAYER_KEYS, OSK_ROWS, applyOskKey, nextOskLayer, oskLayerRows } from '../tv/setup-model.js';
import { Button } from './button.js';
import { ModalSurface } from './dialog.js';
import { h } from './kit-core.js';

// The open keyboard's modal surface and the resolver of its promise.
let surface = null;
let finish = null;

/**
 * Closes the keyboard and resolves its promise.
 * @param {?string} result The typed text, or null when cancelled.
 */
function close(result) {
  const done = finish;
  finish = null;
  if (surface) { surface.close(); surface = null; }
  if (done) done(result);
}

/**
 * Whether the on-screen keyboard is showing.
 * @returns {boolean} True while open.
 */
export function onScreenKeyboardOpen() {
  return !!surface;
}

/**
 * Opens the on-screen keyboard, cancelling any one already open.
 * @param {object} [opts] Options.
 * @param {string} [opts.title='ENTER TEXT'] Title above the field.
 * @param {string} [opts.value=''] Starting text (upper-cased unless `mixedCase`).
 * @param {number} [opts.maxLength=60] Maximum length.
 * @param {boolean} [opts.mixedCase=false] Keeps the text's case and adds lower-case and symbol layers, for a text box that isn't just a name.
 * @param {boolean} [opts.mask=false] Shows dots instead of the text, for a password.
 * @returns {Promise<?string>} The text on DONE, or null when cancelled.
 */
export function openOnScreenKeyboard({ title = 'ENTER TEXT', value = '', maxLength = 60, mixedCase = false, mask = false } = {}) {
  if (surface) close(null);
  return new Promise((resolve) => {
    finish = resolve;
    let text = (mixedCase ? String(value || '') : String(value || '').toUpperCase()).slice(0, maxLength);
    let layer = 'upper';
    // On the page, not inside the TV screen: it can open over the docked guide.
    surface = ModalSurface({ className: 'osk', label: title, onCancel: () => close(null) });
    const field = h('div', { className: 'osk-field', attrs: { 'aria-live': mask ? 'off' : 'polite' } });
    const paint = () => { field.textContent = (mask ? '•'.repeat(text.length) : text) || ' '; field.dataset.empty = text ? '' : '1'; };
    paint();
    const keys = h('div', { className: 'osk-keys' });
    const panel = h('div', { className: 'osk-panel' }, h('div', { className: 'osk-title', text: title }), field, keys);
    const drawKeys = () => {
      keys.textContent = '';
      (mixedCase ? oskLayerRows(layer) : OSK_ROWS).forEach((row) => {
        keys.appendChild(h('div', { className: 'osk-row' }, row.map((key) => {
          const layerKey = mixedCase && key === OSK_LAYER_KEYS[layer];
          return Button({
            label: key,
            isDefault: key === 'DONE',
            bare: true,
            className: `osk-key${key.length > 1 ? ' wide' : ''}`,
            attrs: layerKey ? { 'data-osk-layer': '1', 'aria-label': 'Switch letters, lower case and symbols' } : {},
            onPress: () => {
              if (layerKey) {
                layer = nextOskLayer(layer);
                drawKeys();
                // Redrawing dropped focus: stay on the key just pressed.
                const again = keys.querySelector('[data-osk-layer]');
                if (again) again.focus();
                return;
              }
              const result = applyOskKey(text, key, { maxLength });
              text = result.value;
              paint();
              if (result.done) close(text);
            },
          });
        })));
      });
    };
    drawKeys();
    // A keyboard still types directly (desktop, or a Bluetooth keyboard).
    surface.el.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const typed = mixedCase ? event.key.length === 1 : (event.key.length === 1 && /[a-z0-9 \-&'.]/i.test(event.key));
      if (typed) {
        const key = event.key === ' ' ? 'SPACE' : (mixedCase ? event.key : event.key.toUpperCase());
        text = applyOskKey(text, key, { maxLength }).value;
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
