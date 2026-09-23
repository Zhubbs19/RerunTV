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

function displayRef(display) {
  return display ? { id: String(display.id), label: String(display.label || '') } : null;
}

function sameDisplay(a, b) {
  return !!(a && b && String(a.id) === String(b.id));
}

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

function isBounds(b) {
  return !!b && ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]));
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// The screen holding most of `bounds`, or null when it's on none of them.
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

// Normal bounds on `display`: the saved ones when they still sit mostly on
// its work area (clamped to fit), otherwise the work area scaled by `fill`
// and centred. fill 1 is the whole work area, which is what a fresh box opens
// at; a forced relocation uses less so it reads as a window, not a takeover.
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

// The saved record for `display`. A window-state.json written before
// per-screen records existed has only top-level bounds, which count for
// whichever screen they sit on.
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

// Where the window opens. The target is the chosen screen, else the one it
// was last on. When the target isn't connected (the TV is off at launch) the
// window opens where the cursor is and `pendingReturn` names the screen to
// move to once it appears.
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

// Returns a new state with `display`'s record updated. `last` stays put while
// a return is pending, so a relaunch still aims for the missing screen. The
// top-level bounds mirror the latest record for anything reading the old shape.
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

// Takes over window-state persistence for `win` and follows screens coming
// and going. `plan` is planLaunch's result, used to create the window.
function trackScreenPlacement(win, { screen, state: initialState, saveState, plan, kiosk = false }) {
  let state = initialState || {};
  let pending = plan.pendingReturn || null;
  let current = plan.display;
  // Where the window was put by launch or the last relocation. In automatic
  // mode, the user moving it off this screen cancels a pending return.
  let landed = plan.display;
  let relocating = false;
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
    current = d;
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
    current = display;
    landed = display;
    later(() => { relocating = false; persist(); }, RELOCATE_SETTLE_MS);
  };

  const onRemoved = (event, removed) => {
    if (win.isDestroyed() || !sameDisplay(removed, current)) return;
    // Automatic mode returns to whatever screen went away; a chosen screen
    // only pulls the window back to itself.
    if (!state.preferred || sameDisplay(removed, state.preferred)) pending = displayRef(removed);
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
