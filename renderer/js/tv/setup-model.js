// Pure helpers for TV-mode setup (docs/design/01 §6.4): stepping a value with
// ◀▶, cycling a choice, editing text on the on-screen keyboard, and the
// first-run wizard's steps. No DOM, so node:test covers them.

/**
 * ◀▶ on a numeric setting: one step, clamped.
 * @param {*} value The current value; a non-numeric value starts from `min`.
 * @param {number} direction +1 or -1.
 * @param {object} [opts] Range options.
 * @param {number} [opts.min=0] Lowest allowed value.
 * @param {number} [opts.max=100] Highest allowed value.
 * @param {number} [opts.step=5] Step size; the result snaps to a multiple of it.
 * @returns {number} The stepped, clamped value.
 */
export function stepNumber(value, direction, { min = 0, max = 100, step = 5 } = {}) {
  const current = Number.isFinite(Number(value)) ? Number(value) : min;
  const next = Math.round((current + direction * step) / step) * step;
  return Math.max(min, Math.min(max, next));
}

/**
 * ◀▶ / OK on a choice: the next (or previous) option, wrapping.
 * @param {Array<*>} options The available options in order.
 * @param {*} current The current option.
 * @param {number} [direction=1] +1 for next, -1 for previous.
 * @returns {*} The neighbouring option, or `current` when there are no options.
 */
export function cycleChoice(options, current, direction = 1) {
  if (!options || !options.length) return current;
  const idx = options.indexOf(current);
  const from = idx === -1 ? (direction > 0 ? -1 : 0) : idx;
  return options[((from + direction) % options.length + options.length) % options.length];
}

// ---------- On-screen keyboard ----------
export const OSK_ROWS = [
  ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
  ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'],
  ['U', 'V', 'W', 'X', 'Y', 'Z', '1', '2', '3', '4'],
  ['5', '6', '7', '8', '9', '0', '-', '&', '\'', '.'],
  ['SPACE', 'DELETE', 'CLEAR', 'DONE'],
];

// For a text box that isn't just a name (a search, a message, a folder): the
// same keyboard with lower case and symbols. The first key of the bottom row
// switches layer and shows the one it switches to.
const OSK_LETTER_ROWS = OSK_ROWS.slice(0, 3);
const OSK_SYMBOL_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
  ['-', '_', '=', '+', '/', '\\', ':', ';', '?', '~'],
  ['.', ',', '\'', '"', '<', '>', '[', ']', '{', '}'],
];
export const OSK_LAYERS = ['upper', 'lower', 'symbols'];
// The key that leaves each layer, labelled with where it goes.
export const OSK_LAYER_KEYS = { upper: 'abc', lower: '#+=', symbols: 'ABC' };

/**
 * The layer after `layer`, wrapping.
 * @param {string} layer An OSK_LAYERS id.
 * @returns {string} The next layer id; `'upper'` for an unknown one.
 */
export function nextOskLayer(layer) {
  const i = OSK_LAYERS.indexOf(layer);
  return OSK_LAYERS[(i + 1) % OSK_LAYERS.length] || 'upper';
}

/**
 * The key rows of one layer of the full keyboard.
 * @param {string} layer An OSK_LAYERS id.
 * @returns {string[][]} Rows of key labels; the bottom row starts with the layer key.
 */
export function oskLayerRows(layer) {
  const bottom = [OSK_LAYER_KEYS[layer] || OSK_LAYER_KEYS.upper, 'SPACE', 'DELETE', 'CLEAR', 'DONE'];
  if (layer === 'symbols') return [...OSK_SYMBOL_ROWS, bottom];
  const letters = OSK_LETTER_ROWS.map((row) => row.map((key) => (layer === 'lower' ? key.toLowerCase() : key)));
  return [...letters, OSK_ROWS[3], bottom];
}

/**
 * One key applied to the text. Returns { value, done }.
 * @param {?string} value The text so far.
 * @param {string} key An OSK_ROWS key: a character, SPACE, DELETE, CLEAR or DONE.
 * @param {object} [opts] Limits.
 * @param {number} [opts.maxLength=60] Characters past this are ignored.
 * @returns {object} `{ value, done }`: the new text and whether DONE was pressed.
 */
export function applyOskKey(value, key, { maxLength = 60 } = {}) {
  const text = String(value || '');
  if (key === 'DONE') return { value: text, done: true };
  if (key === 'DELETE') return { value: text.slice(0, -1), done: false };
  if (key === 'CLEAR') return { value: '', done: false };
  const add = key === 'SPACE' ? ' ' : key;
  if (typeof add !== 'string' || add.length !== 1) return { value: text, done: false };
  if (text.length >= maxLength) return { value: text, done: false };
  return { value: text + add, done: false };
}

// ---------- First-run wizard (§6.5) ----------
export const WIZARD_STEPS = ['welcome', 'channels', 'comfort', 'updates', 'remote', 'done'];

/**
 * The wizard step after `step`.
 * @param {string} step A WIZARD_STEPS id.
 * @returns {string} The next step id, or `'done'` for the last or an unknown step.
 */
export function nextWizardStep(step) {
  const i = WIZARD_STEPS.indexOf(step);
  return i === -1 || i === WIZARD_STEPS.length - 1 ? 'done' : WIZARD_STEPS[i + 1];
}

// The remote check: press OK, press Back, hold OK. Each prompt advances when
// its button arrives, which is also what seeds this device's remote profile.
export const REMOTE_CHECK = [
  { prompt: 'Press OK', key: 'ok', longPress: false },
  { prompt: 'Press BACK', key: 'back', longPress: false },
  { prompt: 'Now press and HOLD OK', key: 'ok', longPress: true },
];

/**
 * Advances the remote check when the pressed button matches the current prompt.
 * info: { remoteKey, longPress }. Returns the next check index.
 * @param {number} index The current REMOTE_CHECK index.
 * @param {?object} info The button that arrived.
 * @param {string} info.remoteKey The normalized remote key name.
 * @param {boolean} info.longPress Whether it was a long press.
 * @returns {number} `index + 1` on a match, otherwise `index`.
 */
export function advanceRemoteCheck(index, info) {
  const want = REMOTE_CHECK[index];
  if (!want || !info) return index;
  if (info.remoteKey !== want.key) return index;
  if (want.longPress && !info.longPress) return index;
  if (!want.longPress && info.longPress) return index;
  return index + 1;
}
