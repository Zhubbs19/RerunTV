// FocusScope and SpatialFocus (docs/design/04 §3, the TV focus engine from
// docs/design/01 §6.6), plus the modal stack every full-screen overlay joins.
//
// D-pad movement picks the nearest focusable control in the pressed direction
// by on-screen position, so any dialog layout (a row of buttons, a grid, a
// list) works without per-dialog key tables. A focus scope keeps Tab inside a
// modal and puts focus on its safe default, never a destructive action.
//
// This module imports nothing, on purpose: tv-input.js and the overlays that
// register with it import each other in a cycle, and a registry here can't be
// caught mid-evaluation.

// ---------- Pure ----------
/**
 * Picks the nearest rect in a direction, favouring ones straight ahead over diagonals.
 * rects: [{ left, top, width, height }]; returns the index to move to, or the
 * current index when nothing lies that way.
 * @param {Array<object>} rects Element rects (`left`, `top`, `width`, `height`).
 * @param {number} current Index of the focused rect.
 * @param {string} direction `'up'`, `'down'`, `'left'` or `'right'`.
 * @returns {number} The index to move to; 0 or -1 when `current` is out of range.
 */
export function nextSpatialIndex(rects, current, direction) {
  const from = rects[current];
  if (!from) return rects.length ? 0 : -1;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = current;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    if (i === current) return;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let primary;
    let secondary;
    if (direction === 'up') { primary = -dy; secondary = Math.abs(dx); }
    else if (direction === 'down') { primary = dy; secondary = Math.abs(dx); }
    else if (direction === 'left') { primary = -dx; secondary = Math.abs(dy); }
    else if (direction === 'right') { primary = dx; secondary = Math.abs(dy); }
    else return;
    if (primary <= 1) return; // not in that direction
    // Distance along the direction counts, but drifting sideways costs more,
    // so ▼ from a button goes to the one below it rather than one diagonally.
    const score = primary + secondary * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/**
 * The control a dialog should focus when it opens: the one marked
 * data-default, else the first that isn't destructive.
 * @param {Array<object>} items `{ isDefault, isDanger }` per control.
 * @returns {number} The index to focus (0 if every control is destructive).
 */
export function defaultFocusIndex(items) {
  const marked = items.findIndex((item) => item.isDefault);
  if (marked !== -1) return marked;
  const safe = items.findIndex((item) => !item.isDanger);
  return safe === -1 ? 0 : safe;
}

// ---------- Modal stack ----------
// Any full-screen overlay (Dialog, the on-screen keyboard, learn mode,
// handoff, the wizard) registers here. tv-input.js gives the top open one the
// dialog context: D-pad moves focus by position, OK presses the focused
// control, Back calls cancel().
// var, not const: registration can happen while an importer in a cycle is
// still evaluating.
// eslint-disable-next-line no-var
var modals;

/**
 * Adds an overlay to the modal stack.
 * @param {object} modal The overlay's hooks.
 * @param {() => boolean} modal.isOpen Whether it is showing.
 * @param {() => HTMLElement} modal.element Returns its root element.
 * @param {Function} modal.cancel Called when Back is pressed.
 * @returns {Function} Removes it from the stack.
 */
export function registerModal({ isOpen, element, cancel }) {
  const modal = { isOpen, element, cancel };
  modals = modals || [];
  modals.push(modal);
  return () => { const i = modals.indexOf(modal); if (i !== -1) modals.splice(i, 1); };
}

/**
 * The most recently registered modal that is open.
 * @returns {?object} Its `{ isOpen, element, cancel }`, or null.
 */
export function topModal() {
  if (!modals) return null;
  for (let i = modals.length - 1; i >= 0; i -= 1) {
    try { if (modals[i].isOpen()) return modals[i]; } catch (e) { /* a broken modal can't block input */ }
  }
  return null;
}

// ---------- DOM ----------
// Selector for elements that can take focus inside a modal.
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-2"])';

/**
 * The visible focusable elements inside a container, in document order.
 * @param {Element} container The container to search.
 * @returns {HTMLElement[]} Focusable elements that are rendered and not inside `.hidden`.
 */
export function focusables(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0 && !el.closest('.hidden'));
}

/**
 * Whether a control is marked destructive, so it never takes default focus.
 * @param {Element} el The control.
 * @returns {boolean} True for a destructive control.
 */
function isDanger(el) {
  return el.hasAttribute('data-danger') || el.classList.contains('danger') || el.classList.contains('btn-danger')
    || el.classList.contains('is-danger') || el.classList.contains('tv-exit-prompt-exit');
}

/**
 * Moves focus inside container; returns true if focus moved.
 * @param {?Element} container The container to move within.
 * @param {string} direction `'up'`, `'down'`, `'left'` or `'right'`.
 * @returns {boolean} True if focus moved.
 */
export function moveFocusSpatially(container, direction) {
  if (!container) return false;
  const items = focusables(container);
  if (!items.length) return false;
  const current = items.indexOf(document.activeElement);
  if (current === -1) { items[0].focus(); return true; }
  const rects = items.map((el) => el.getBoundingClientRect());
  const next = nextSpatialIndex(rects, current, direction);
  if (next === current) return false;
  items[next].focus();
  if (items[next].scrollIntoView) items[next].scrollIntoView({ block: 'nearest' });
  return true;
}

// The spatial focus engine as one object: `move` (DOM) and `nextIndex` (pure).
export const SpatialFocus = { move: moveFocusSpatially, nextIndex: nextSpatialIndex };

/**
 * Focuses a container's safe default control (see defaultFocusIndex).
 * @param {Element} container The container.
 */
export function focusDefault(container) {
  const items = focusables(container);
  const idx = defaultFocusIndex(items.map((el) => ({ isDefault: el.hasAttribute('data-default'), isDanger: isDanger(el) })));
  if (items[idx]) items[idx].focus();
}

/**
 * Traps Tab inside a modal and focuses its safe default. Returns release(),
 * which restores focus to what had it before.
 * @param {Element} container The modal's root element.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.initialFocus=true] Whether to focus the safe default now.
 * @returns {Function} release(): removes the trap and restores the previous focus.
 */
export function FocusScope(container, { initialFocus = true } = {}) {
  const previous = document.activeElement;
  const onKey = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables(container);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    const next = event.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : (idx + 1) % items.length;
    event.preventDefault();
    event.stopPropagation();
    items[next].focus();
  };
  container.addEventListener('keydown', onKey, true);
  if (initialFocus) focusDefault(container);
  return function release() {
    container.removeEventListener('keydown', onKey, true);
    if (previous && previous.isConnected && previous.focus) previous.focus({ preventScroll: true });
  };
}
