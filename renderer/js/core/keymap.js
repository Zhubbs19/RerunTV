// Remappable single-key shortcuts for live TV (SETTINGS › System › Keys).
// handleKey (app.js) switches on the default letters, so a remap is a
// translation in front of it: the key you chose is turned back into the
// default letter the action already answers to, and a default letter you
// moved away from does nothing (until it is given to another action). Pure,
// so it is tested; the on-screen hint bar is rewritten from the same table.

// id, the key it ships on, the hint bar item showing it, and its name.
export const KEY_ACTIONS = [
  { id: 'guide', key: 'g', hint: 'guide', label: 'Open the guide' },
  { id: 'setup', key: 's', hint: 'setup', label: 'Open setup' },
  { id: 'mute', key: 'm', hint: 'mute', label: 'Mute' },
  { id: 'crt', key: 'c', hint: 'crt', label: 'CRT effect on/off' },
  { id: 'picture', key: 'v', hint: 'picture-mode', label: 'Picture mode' },
  { id: 'aspect', key: 'a', hint: 'aspect', label: 'Aspect ratio' },
  { id: 'sleep', key: 'z', hint: 'sleep', label: 'Sleep timer' },
  { id: 'fullscreen', key: 'f', hint: 'fullscreen', label: 'Fullscreen' },
  { id: 'power', key: 'p', hint: 'power', label: 'Power off' },
  { id: 'logo', key: 'o', hint: 'overlay-editor', label: 'Logo placement editor' },
  { id: 'timemachine', key: 't', hint: 'time-machine', label: 'Time machine / play' },
  { id: 'calendar', key: 'd', hint: null, label: 'Time machine calendar' },
  { id: 'startover', key: 'j', hint: 'restart', label: 'Start the show over' },
  { id: 'live', key: 'l', hint: null, label: 'Back to live' },
  { id: 'scan', key: 'n', hint: 'scan', label: 'Scan channels' },
  { id: 'details', key: 'i', hint: null, label: 'Show details' },
  { id: 'aircheck', key: 'x', hint: 'air-check', label: 'Mark an air check' },
  { id: 'hidehints', key: 'h', hint: 'hide-hints', label: 'Hide the hint bar' },
];

// Keys that already mean something else (plug-in hotkeys, volume, the menu,
// the channel digits), so they can't be handed out.
export const RESERVED_KEYS = new Set(['b', 'e', 'k', 'u', 'r', '+', '=', '-', '_', '?', '[', ']', ' ', '.', '/', ',']);

export function effectiveKey(keyMap, action) {
  const mapped = keyMap && keyMap[action.id];
  return typeof mapped === 'string' && mapped.length === 1 ? mapped.toLowerCase() : action.key;
}

// Whether `key` can be given to `actionId` given the current map. Returns
// null when fine, otherwise a short reason.
export function keyProblem(keyMap, actionId, key) {
  const k = String(key || '').toLowerCase();
  if (k.length !== 1) return 'Press a single letter or symbol key.';
  if (/[0-9]/.test(k)) return 'Digits are for typing channel numbers.';
  if (RESERVED_KEYS.has(k)) return `${k.toUpperCase()} is used by something else.`;
  const taken = KEY_ACTIONS.find((a) => a.id !== actionId && effectiveKey(keyMap, a) === k);
  if (taken) return `${k.toUpperCase()} already does "${taken.label}".`;
  return null;
}

// A function from a pressed key to the key handleKey should see.
export function buildKeyTranslator(keyMap) {
  const alias = new Map(); // pressed -> default letter
  const dead = new Set(); // default letters no longer answered
  KEY_ACTIONS.forEach((action) => {
    const eff = effectiveKey(keyMap, action);
    if (eff === action.key) return;
    alias.set(eff, action.key);
    dead.add(action.key);
  });
  // A default letter that another action was moved onto still works.
  alias.forEach((_default, pressed) => dead.delete(pressed));
  if (!alias.size && !dead.size) return { active: false, translate: (key) => key };
  return {
    active: true,
    translate(key) {
      if (typeof key !== 'string' || key.length !== 1) return key;
      const lower = key.toLowerCase();
      let out = lower;
      if (alias.has(lower)) out = alias.get(lower);
      else if (dead.has(lower)) return '';
      return key === lower ? out : out.toUpperCase();
    },
  };
}

// The hint bar text for an action with its key swapped in: "G GUIDE" -> "Y GUIDE".
export function hintWithKey(originalText, defaultKey, newKey) {
  const prefix = `${defaultKey.toUpperCase()} `;
  return originalText.startsWith(prefix) ? `${newKey.toUpperCase()} ${originalText.slice(prefix.length)}` : originalText;
}
