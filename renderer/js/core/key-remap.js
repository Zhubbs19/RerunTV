// The DOM side of key remapping (core/keymap.js is the pure half): rewrites a
// real keystroke into the key handleKey expects, and the hint bar to show the
// keys you actually chose.
import { KEY_ACTIONS, buildKeyTranslator, effectiveKey, hintWithKey } from './keymap.js';
import { S } from './state.js';

let cachedJson = null;
let cachedTranslator = null;

function translator() {
  const map = (S.config && S.config.keyMap) || {};
  const json = JSON.stringify(map);
  if (json !== cachedJson) {
    cachedJson = json;
    cachedTranslator = buildKeyTranslator(map);
  }
  return cachedTranslator;
}

// Same event, with `key` swapped for what the action answers to by default.
// Ctrl/Alt/Meta combinations are never remapped.
export function remapKeyboardEvent(e) {
  const t = translator();
  if (!t.active || e.ctrlKey || e.altKey || e.metaKey) return e;
  const key = t.translate(e.key);
  if (key === e.key) return e;
  return new Proxy(e, {
    get(target, prop) {
      if (prop === 'key') return key;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// "G GUIDE" becomes "Y GUIDE" when the guide key is Y; reverts when reset.
export function applyKeyHints() {
  const map = (S.config && S.config.keyMap) || {};
  KEY_ACTIONS.forEach((action) => {
    if (!action.hint) return;
    document.querySelectorAll(`[data-hint-key="${action.hint}"]`).forEach((span) => {
      if (span.dataset.hintOriginal == null) span.dataset.hintOriginal = span.textContent;
      span.textContent = hintWithKey(span.dataset.hintOriginal, action.key, effectiveKey(map, action));
    });
  });
}
