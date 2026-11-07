// Which screen the window lives on, and getting back to it. A desktop PC that
// also drives a TV over HDMI is a common way to run the box: the TV sleeps or
// is switched off, Windows drops that display and shoves the window onto the
// desk monitor, and nothing used to bring it back. The saved position then got
// overwritten with the desk monitor's, so the next launch forgot the TV too.
//
// window-state.json keeps one record (normal bounds, maximized, fullscreen)
// per screen, so returning to a screen restores how the window was there, and
// a forced move onto the desk monitor never overwrites the TV's record. The
// screen choice lives in that file as well, not in channels.json: a display
// id means nothing on another machine or to a LAN viewer.
//
// Pure planning helpers first (tests/screen-placement.test.js), then the
// controller that wires them to one BrowserWindow and Electron's screen events.

const MAX_SCREEN_RECORDS = 8;
// Windows settles a hot-plugged display's metrics over a moment; moving onto it
// straight from display-added can land on stale bounds.
const DISPLAY_SETTLE_MS = 1200;
// After a display is removed, the OS relocates the window on its own schedule.
const RELOCATE_SETTLE_MS = 500;

/**
 * Reduces an Electron display to the `{ id, label }` reference that is saved.
 * @param {?object} display The display.
 * @returns {?object} `{ id, label }`, or null.
 */
function displayRef(display) {
  return display ? { id: String(display.id), label: String(display.label || '') } : null;
}

/**
 * Compares two displays or references by id.
 * @param {?object} a The first display.
 * @param {?object} b The second display.
 * @returns {boolean} True when both exist and share an id.
 */
function sameDisplay(a, b) {
  return !!(a && b && String(a.id) === String(b.id));
}

/**
 * Finds a saved screen among the connected ones, by id or else by a unique label.
 * @param {Array<object>} displays The connected displays.
 * @param {?object} ref The saved `{ id, label }`.
 * @returns {?object} The display, or null.
 */
function findDisplay(displays, ref) {
  if (!ref) return null;
  const byId = displays.find((d) => String(d.id) === String(ref.id));
  if (byId) return byId;
  // A reconnected monitor can come back with a new id. Its friendly name is
  // the fallback, but only when exactly one connected screen carries it.
  if (!ref.label) return null;
  const byLabel = displays.filter((d) => d.label === ref.label);
  return byLabel.length === 1 ? byLabel[0] : null;
}

/**
 * Checks for a rectangle with finite `x`, `y`, `width` and `height`.
 * @param {*} b The candidate.
 * @returns {boolean} True for a usable rectangle.
 */
function isBounds(b) {
  return !!b && ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]));
}

/**
 * Area two rectangles share.
 * @param {object} a The first rectangle.
 * @param {object} b The second rectangle.
 * @returns {number} The overlap in square pixels, 0 when they don't touch.
 */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The screen holding most of `bounds`, or null when it's on none of them.
 * @param {Array<object>} displays The connected displays.
 * @param {?object} bounds The window rectangle.
 * @returns {?object} The display, or null.
 */
function displayForBounds(displays, bounds) {
  if (!isBounds(bounds)) return null;
  let best = null;
  let bestArea = 0;
  displays.forEach((d) => {
    const area = overlapArea(bounds, d.bounds);
    if (area > bestArea) { best = d; bestArea = area; }
  });
  return best;
}

/**
 * Normal bounds on `display`: the saved ones when they still sit mostly on
 * its work area (clamped to fit), otherwise the work area scaled by `fill`
 * and centred. fill 1 is the whole work area, which is what a fresh box opens
 * at; a forced relocation uses less so it reads as a window, not a takeover.
 * @param {object} display The target display.
 * @param {?object} saved The saved normal bounds for it.
 * @param {number} [fill=1] Fraction of the work area to use without saved bounds.
 * @returns {object} `{ x, y, width, height }`.
 */
function boundsFor(display, saved, fill = 1) {
  const area = display.workArea;
  if (isBounds(saved) && overlapArea(saved, area) >= (saved.width * saved.height) / 2) {
    const width = Math.min(saved.width, area.width);
    const height = Math.min(saved.height, area.height);
    return {
      x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
      width,
      height,
    };
  }
  const width = Math.round(area.width * fill);
  const height = Math.round(area.height * fill);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * The saved record for `display`. A window-state.json written before
 * per-screen records existed has only top-level bounds, which count for
 * whichever screen they sit on.
 * @param {?object} state The window-state.json contents.
 * @param {?object} display The display.
 * @param {Array<object>} displays The connected displays.
 * @returns {?object} `{ bounds, isMaximized, isFullScreen }`, or null.
 */
function recordFor(state, display, displays) {
  if (!state || !display) return null;
  const screens = state.screens || {};
  if (screens[String(display.id)]) return screens[String(display.id)];
  if (display.label) {
    const byLabel = Object.values(screens).filter((r) => r && r.label === display.label);
    if (byLabel.length === 1) return byLabel[0];
  }
  if (!state.screens && isBounds(state) && sameDisplay(displayForBounds(displays, state), display)) {
    return { bounds: { x: state.x, y: state.y, width: state.width, height: state.height }, isMaximized: !!state.isMaximized, isFullScreen: false };
  }
  return null;
}

/**
 * Where the window opens. The target is the chosen screen, else the one it
 * was last on. When the target isn't connected (the TV is off at launch) the
 * window opens where the cursor is and `pendingReturn` names the screen to
 * move to once it appears.
 * @param {object} opts Inputs.
 * @param {Array<object>} opts.displays The connected displays.
 * @param {?object} opts.state The window-state.json contents.
 * @param {?object} opts.cursorDisplay The display under the cursor.
 * @returns {object} `{ display, bounds, isMaximized, isFullScreen, pendingReturn }`.
 */
function planLaunch({ displays, state, cursorDisplay }) {
  const s = state || {};
  const legacy = !s.screens && isBounds(s) ? displayRef(displayForBounds(displays, s)) : null;
  const target = s.preferred || s.last || legacy;
  const onTarget = findDisplay(displays, target);
  const display = onTarget || cursorDisplay || displays[0];
  const record = recordFor(s, display, displays);
  return {
    display,
    bounds: boundsFor(display, record && record.bounds),
    isMaximized: !!(record && record.isMaximized),
    isFullScreen: !!(record && record.isFullScreen),
    pendingReturn: target && !onTarget ? target : null,
  };
}

/**
 * Returns a new state with `display`'s record updated. `last` stays put while
 * a return is pending, so a relaunch still aims for the missing screen. The
 * top-level bounds mirror the latest record for anything reading the old shape.
 * @param {?object} state The current window state.
 * @param {object} display The display the window is on.
 * @param {object} placement The window's `{ bounds, isMaximized, isFullScreen }`.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.pending=false] Whether a return to another screen is pending.
 * @returns {object} The new window state.
 */
function recordState(state, display, { bounds, isMaximized, isFullScreen }, { pending = false } = {}) {
  const prev = state || {};
  const id = String(display.id);
  const screens = { ...(prev.screens || {}) };
  delete screens[id];
  screens[id] = { label: String(display.label || ''), bounds: { ...bounds }, isMaximized: !!isMaximized, isFullScreen: !!isFullScreen };
  const ids = Object.keys(screens);
  ids.slice(0, Math.max(0, ids.length - MAX_SCREEN_RECORDS)).forEach((old) => { delete screens[old]; });
  return {
    ...bounds,
    isMaximized: !!isMaximized,
    screens,
    last: pending && prev.last ? prev.last : displayRef(display),
    preferred: prev.preferred || null,
  };
}

// ---------- Controller ----------

/**
 * Takes over window-state persistence for `win` and follows screens coming
 * and going. `plan` is planLaunch's result, used to create the window.
 * onScreenChange({ id, label }) fires whenever the window ends up on a
 * different screen than before. onScreenPower('lost' | 'returned', { id, label })
 * fires when the screen the window was on goes away, and when that screen
 * comes back and the window returns to it (the renderer can follow the TV's
 * power with the box's own).
 * @param {BrowserWindow} win The main window.
 * @param {object} opts Wiring.
 * @param {object} opts.screen Electron's `screen` module.
 * @param {?object} opts.state The loaded window state.
 * @param {Function} opts.saveState Persists a new window state.
 * @param {object} opts.plan The `planLaunch` result.
 * @param {boolean} [opts.kiosk=false] Whether the window is in kiosk mode (fullscreen is left alone).
 * @param {Function} [opts.onScreenChange] See above.
 * @param {Function} [opts.onScreenPower] See above.
 * @returns {object} `{ listScreens, setPreferred }`.
 */
function trackScreenPlacement(win, {
  screen, state: initialState, saveState, plan, kiosk = false,
  onScreenChange = () => {}, onScreenPower = () => {},
}) {
  let state = initialState || {};
  let pending = plan.pendingReturn || null;
  let current = plan.display;
  // Where the window was put by launch or the last relocation. In automatic
  // mode, the user moving it off this screen cancels a pending return.
  let landed = plan.display;
  let relocating = false;
  const setCurrent = (display) => {
    const changed = !sameDisplay(display, current);
    current = display;
    if (changed) onScreenChange(displayRef(display));
  };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };

  const persist = () => {
    if (win.isDestroyed() || relocating || win.isMinimized()) return;
    const d = displayForBounds(screen.getAllDisplays(), win.getBounds());
    if (!d) return;
    if (pending && !state.preferred && landed && !sameDisplay(d, landed)) pending = null;
    setCurrent(d);
    state = recordState(state, d, {
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    }, { pending: !!pending });
    saveState(state);
  };

  let saveTimer = null;
  const persistDebounced = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 500);
  };

  // restore: bring back the maximized/fullscreen state saved for that screen.
  // A forced relocation onto the desk monitor skips it, so it stays a window.
  const moveTo = (display, { fill = 1, restore = true } = {}) => {
    if (win.isDestroyed()) return;
    relocating = true;
    const record = recordFor(state, display, screen.getAllDisplays());
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const bounds = boundsFor(display, record && record.bounds, fill);
    // Twice: Windows sizes the first setBounds across screens with different
    // scale factors against the old screen's DPI.
    win.setBounds(bounds);
    win.setBounds(bounds);
    if (restore && record && record.isMaximized) win.maximize();
    if (restore && record && record.isFullScreen && !kiosk) win.setFullScreen(true);
    setCurrent(display);
    landed = display;
    later(() => { relocating = false; persist(); }, RELOCATE_SETTLE_MS);
  };

  const onRemoved = (event, removed) => {
    if (win.isDestroyed() || !sameDisplay(removed, current)) return;
    // Automatic mode returns to whatever screen went away; a chosen screen
    // only pulls the window back to itself.
    if (!state.preferred || sameDisplay(removed, state.preferred)) pending = displayRef(removed);
    onScreenPower('lost', displayRef(removed));
    relocating = true;
    // Fullscreen would otherwise follow the window onto the desk monitor and
    // cover it.
    if (win.isFullScreen() && !kiosk) win.setFullScreen(false);
    later(() => {
      const displays = screen.getAllDisplays();
      const d = displayForBounds(displays, win.getBounds()) || screen.getPrimaryDisplay();
      moveTo(d, { fill: 0.7, restore: false });
    }, RELOCATE_SETTLE_MS);
  };

  const onAdded = () => {
    if (!pending) return;
    later(() => {
      if (!pending) return;
      const d = findDisplay(screen.getAllDisplays(), pending);
      if (!d) return;
      pending = null;
      moveTo(d);
      onScreenPower('returned', displayRef(d));
    }, DISPLAY_SETTLE_MS);
  };

  screen.on('display-removed', onRemoved);
  screen.on('display-added', onAdded);
  win.on('resize', persistDebounced);
  win.on('move', persistDebounced);
  win.on('enter-full-screen', persistDebounced);
  win.on('leave-full-screen', persistDebounced);
  win.on('close', () => { clearTimeout(saveTimer); persist(); });
  win.on('closed', () => {
    screen.removeListener('display-removed', onRemoved);
    screen.removeListener('display-added', onAdded);
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
  });

  return {
    listScreens() {
      const primary = screen.getPrimaryDisplay();
      const displays = screen.getAllDisplays();
      return {
        preferred: state.preferred || null,
        pendingReturn: pending,
        screens: displays.map((d) => ({
          id: String(d.id),
          label: String(d.label || ''),
          width: Math.round(d.size.width * d.scaleFactor),
          height: Math.round(d.size.height * d.scaleFactor),
          primary: sameDisplay(d, primary),
          current: sameDisplay(d, current),
        })),
      };
    },
    // ref null goes back to automatic (the last screen used). Choosing a
    // connected screen moves the window there now; a missing one is waited for.
    setPreferred(ref) {
      const next = ref && ref.id != null ? { id: String(ref.id), label: String(ref.label || '') } : null;
      state = { ...state, preferred: next };
      saveState(state);
      pending = null;
      if (next) {
        const d = findDisplay(screen.getAllDisplays(), next);
        if (d && !sameDisplay(d, current)) moveTo(d);
        else if (!d) pending = next;
      }
      return this.listScreens();
    },
  };
}

module.exports = {
  boundsFor,
  displayForBounds,
  displayRef,
  findDisplay,
  planLaunch,
  recordFor,
  recordState,
  trackScreenPlacement,
};
