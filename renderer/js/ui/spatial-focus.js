// Spatial focus and focus scopes (docs/design/01 §6.6; a minimal version of
// docs/design/04's FocusScope/SpatialFocus — C4 replaces it when it's built).
//
// D-pad movement picks the nearest focusable control in the pressed direction
// by on-screen position, so any dialog layout (a row of buttons, a grid, a
// list) works without per-dialog key tables. A focus scope keeps Tab inside a
// modal and puts focus on its safe default, never a destructive action.

// ---------- Pure ----------
// rects: [{ left, top, width, height }]; returns the index to move to, or the
// current index when nothing lies that way.
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

// The control a dialog should focus when it opens: the one marked
// data-default, else the first that isn't destructive.
export function defaultFocusIndex(items) {
  const marked = items.findIndex((item) => item.isDefault);
  if (marked !== -1) return marked;
  const safe = items.findIndex((item) => !item.isDanger);
  return safe === -1 ? 0 : safe;
}

// ---------- DOM ----------
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-2"])';

function focusables(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0 && !el.closest('.hidden'));
}

// Moves focus inside container; returns true if focus moved.
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

// Traps Tab inside a modal and focuses its safe default. Returns release(),
// which restores focus to what had it before.
export function createFocusScope(container) {
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
  const items = focusables(container);
  const idx = defaultFocusIndex(items.map((el) => ({
    isDefault: el.hasAttribute('data-default'),
    isDanger: el.classList.contains('danger') || el.classList.contains('tv-exit-prompt-exit'),
  })));
  if (items[idx]) items[idx].focus();
  return function release() {
    container.removeEventListener('keydown', onKey, true);
    if (previous && previous.isConnected && previous.focus) previous.focus({ preventScroll: true });
  };
}
