// Usage mode — contract C1 (docs/design/01-usage-modes-desktop-and-tv.md).
//
// 'desktop' (pointer + keyboard at a desk) or 'tv' (a remote across the
// room). A mode is a presentation + input profile for the whole app, not a
// skin: CSS keys on html[data-mode], and tv-input.js routes remote buttons to
// actions only in TV mode. It is resolved per client device and never stored
// in channels.json, so a laptop can edit in desktop mode while the living-room
// box plays in TV mode.
//
// Resolution, strongest first:
//   1. this device's own choice (localStorage, per client — Electron keeps it
//      in its own userData, a browser/WebView in its origin storage)
//   2. this device's TV screen: the Electron window is on the screen picked
//      in PICTURE & SOUND › "TV mode on" (a PC driving a TV over HDMI as a
//      second screen). Off that screen, the steps below decide as usual.
//   3. a launch flag: ?mode=tv|desktop in the page URL (the Electron main
//      process adds it for `--mode=tv`, a browser client can type it)
//   4. client identity: the Android TV WebView's RerunTV-AndroidTV UA
//      (tv-client-viewport.js), Samsung Tizen and LG webOS TV browsers
//   5. desktop
// Nothing ever switches mode silently; a heuristic may only *suggest* it.

export const USAGE_MODES = ['desktop', 'tv'];
export const USAGE_MODE_PREFERENCES = ['auto', 'desktop', 'tv'];
const STORAGE_KEY = 'reruntv.usageMode';
const TV_SCREEN_KEY = 'reruntv.tvModeScreen';

// [user-agent pattern, source label] pairs that identify a TV client.
const TV_USER_AGENTS = [
  [/RerunTV-AndroidTV/i, 'Android TV client'],
  [/Tizen/i, 'Samsung TV browser'],
  [/Web0S|webOS/i, 'LG TV browser'],
];

/**
 * Resolves the usage mode from this device's inputs, strongest first.
 * Pure: every input is passed in, so node:test can cover the precedence.
 * @param {object} [env] The device's inputs.
 * @param {string} [env.preference] Stored device choice: `'auto'`, `'desktop'` or `'tv'`.
 * @param {string} [env.query] The page URL's query string.
 * @param {string} [env.userAgent] The browser user agent.
 * @param {boolean} [env.onTvScreen=false] Whether the window is on this device's TV screen.
 * @returns {object} `{ mode, source }`: the mode and a short label for what decided it.
 */
export function resolveUsageMode({ preference, query, userAgent, onTvScreen = false } = {}) {
  if (preference === 'desktop' || preference === 'tv') return { mode: preference, source: 'device choice' };
  if (onTvScreen) return { mode: 'tv', source: 'TV screen' };
  const flag = parseModeFlag(query);
  if (flag) return { mode: flag, source: 'launch flag' };
  const identity = TV_USER_AGENTS.find(([pattern]) => pattern.test(userAgent || ''));
  if (identity) return { mode: 'tv', source: identity[1] };
  return { mode: 'desktop', source: 'default' };
}

/**
 * Reads a `mode=tv|desktop` launch flag from a query string.
 * @param {?string} query The query string, with or without a leading `?`.
 * @returns {?string} `'tv'`, `'desktop'`, or null when absent or invalid.
 */
export function parseModeFlag(query) {
  if (!query) return null;
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const value = (params.get('mode') || '').toLowerCase();
  return value === 'tv' || value === 'desktop' ? value : null;
}

// ---------- This device ----------

// The resolved mode for this device and the onUsageModeChange subscribers.
let current = { mode: 'desktop', source: 'default' };
const listeners = new Set();

/**
 * This device's stored mode choice.
 * @returns {string} `'auto'`, `'desktop'` or `'tv'`; `'auto'` when unset or storage fails.
 */
function readPreference() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return USAGE_MODE_PREFERENCES.includes(value) ? value : 'auto';
  } catch (e) {
    return 'auto';
  }
}

/**
 * Makes a resolved mode current: sets `html[data-mode]` and, if the mode changed, notifies
 * listeners and fires a `usage-mode-change` window event.
 * @param {object} resolved `{ mode, source }` from resolveUsageMode or a preview.
 * @returns {string} The mode now in effect.
 */
function stamp(resolved) {
  const previous = current.mode;
  current = resolved;
  if (typeof document !== 'undefined') document.documentElement.dataset.mode = resolved.mode;
  if (previous !== resolved.mode) {
    listeners.forEach((fn) => { try { fn(resolved.mode, resolved); } catch (e) { console.warn('[usage-mode] listener failed', e); } });
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('usage-mode-change', { detail: { ...resolved } }));
    }
  }
  return resolved.mode;
}

/**
 * Gathers this device's inputs for resolveUsageMode.
 * @param {string} preference The device choice to use.
 * @returns {object} `{ preference, onTvScreen, query, userAgent }`.
 */
function environment(preference) {
  return {
    preference,
    onTvScreen: isOnTvScreen(),
    query: typeof location !== 'undefined' ? location.search : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

/**
 * Called once, as early as app.js runs, before anything renders.
 * @returns {string} The resolved mode.
 */
export function initUsageMode() {
  return stamp(resolveUsageMode(environment(readPreference())));
}

/**
 * The current usage mode.
 * @returns {string} `'desktop'` or `'tv'`.
 */
export function usageMode() {
  return current.mode;
}

/**
 * What decided the current mode, e.g. `'device choice'` or `'launch flag'`.
 * @returns {string} The source label.
 */
export function usageModeSource() {
  return current.source;
}

/**
 * Whether the app is in TV mode.
 * @returns {boolean} True in TV mode (including a preview).
 */
export function isTvMode() {
  return current.mode === 'tv';
}

/**
 * This device's stored mode choice.
 * @returns {string} `'auto'`, `'desktop'` or `'tv'`.
 */
export function getUsageModePreference() {
  return readPreference();
}

// ---------- Preview (docs/design/01 §8) ----------
// TV mode for this session only, from a desk: layouts and plugin panels can be
// checked without a TV, and the device's own choice is left alone. Ending the
// preview (or any real choice) goes back to what the device resolves to.
let previewing = false;

/**
 * Whether a TV-mode preview is running this session.
 * @returns {boolean} True while previewing.
 */
export function isPreviewingTvMode() {
  return previewing;
}

/**
 * Starts or ends a session-only TV-mode preview; ending it re-resolves the device's mode.
 * @param {boolean} on True to preview TV mode.
 * @returns {string} The mode now in effect.
 */
export function setTvPreview(on) {
  previewing = !!on;
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('tv-preview', previewing);
  if (previewing) return stamp({ mode: 'tv', source: 'preview' });
  return stamp(resolveUsageMode(environment(readPreference())));
}

/**
 * Stores this device's mode choice and applies it, ending any preview.
 * 'auto' forgets this device's choice and falls back to flag/identity.
 * @param {string} preference `'auto'`, `'desktop'` or `'tv'`.
 * @returns {string} The mode now in effect.
 * @throws {Error} When `preference` is not one of USAGE_MODE_PREFERENCES.
 */
export function setUsageModePreference(preference) {
  if (!USAGE_MODE_PREFERENCES.includes(preference)) throw new Error(`Unknown usage mode "${preference}"`);
  if (previewing) {
    previewing = false;
    if (typeof document !== 'undefined') document.documentElement.classList.remove('tv-preview');
  }
  try {
    if (preference === 'auto') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch (e) { /* storage unavailable: still applies for this session */ }
  return stamp(resolveUsageMode(environment(preference)));
}

/**
 * Subscribes to mode changes.
 * @param {(mode: string, resolved: object) => void} fn Called with the new mode and `{ mode, source }`.
 * @returns {Function} Unsubscribes the listener.
 */
export function onUsageModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- TV screen (Electron window only) ----------
// { id, label } of the screen that means TV mode on this device, per device
// like the mode choice itself. The window's current screen comes from main
// (screen-placement.js), so dragging the window onto the TV flips the layout.
let currentScreen = null;

/**
 * Whether two screen refs name the same display, by id or by label.
 * @param {?object} a A `{ id, label }` screen ref.
 * @param {?object} b Another `{ id, label }` screen ref.
 * @returns {boolean} True when they match.
 */
function sameScreen(a, b) {
  if (!a || !b) return false;
  return String(a.id) === String(b.id) || (!!a.label && a.label === b.label);
}

/**
 * The screen stored as this device's TV screen.
 * @returns {?object} `{ id, label }` with string fields, or null when unset.
 */
export function getTvModeScreen() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TV_SCREEN_KEY) || 'null');
    return parsed && parsed.id != null ? { id: String(parsed.id), label: String(parsed.label || '') } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Whether the window is currently on this device's TV screen.
 * @returns {boolean} True when the current screen matches the stored one.
 */
function isOnTvScreen() {
  return sameScreen(currentScreen, getTvModeScreen());
}

/**
 * Re-resolves the mode unless a preview is running.
 */
function restamp() {
  if (!previewing) stamp(resolveUsageMode(environment(readPreference())));
}

/**
 * Stores which screen means TV mode on this device and re-resolves the mode.
 * ref null turns the rule off.
 * @param {?object} ref `{ id, label }` of the screen.
 */
export function setTvModeScreen(ref) {
  try {
    if (ref && ref.id != null) window.localStorage.setItem(TV_SCREEN_KEY, JSON.stringify({ id: String(ref.id), label: String(ref.label || '') }));
    else window.localStorage.removeItem(TV_SCREEN_KEY);
  } catch (e) { /* storage unavailable */ }
  restamp();
}

/**
 * Tracks which screen the window is on so moving it onto the TV screen flips the mode.
 * Called once from app.js, host window only.
 */
export function installTvScreenRule() {
  const api = typeof window !== 'undefined' ? window.api : null;
  if (!api || typeof api.listScreens !== 'function') return;
  if (typeof api.onScreenChange === 'function') {
    api.onScreenChange((ref) => { currentScreen = ref; restamp(); });
  }
  Promise.resolve(api.listScreens()).then((info) => {
    const here = info && info.screens.find((screen) => screen.current);
    if (here && !currentScreen) { currentScreen = { id: here.id, label: here.label }; restamp(); }
  }).catch(() => {});
}
