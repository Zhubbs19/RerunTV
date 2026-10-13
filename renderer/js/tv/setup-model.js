// Pure helpers for TV-mode setup (docs/design/01 §6.4): stepping a value with
// ◀▶, cycling a choice, editing text on the on-screen keyboard, and the
// first-run wizard's steps. No DOM, so node:test covers them.

// ◀▶ on a numeric setting: one step, clamped.
export function stepNumber(value, direction, { min = 0, max = 100, step = 5 } = {}) {
  const current = Number.isFinite(Number(value)) ? Number(value) : min;
  const next = Math.round((current + direction * step) / step) * step;
  return Math.max(min, Math.min(max, next));
}

// ◀▶ / OK on a choice: the next (or previous) option, wrapping.
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

// One key applied to the text. Returns { value, done }.
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

// info: { remoteKey, longPress }. Returns the next check index.
export function advanceRemoteCheck(index, info) {
  const want = REMOTE_CHECK[index];
  if (!want || !info) return index;
  if (info.remoteKey !== want.key) return index;
  if (want.longPress && !info.longPress) return index;
  if (!want.longPress && info.longPress) return index;
  return index + 1;
}
