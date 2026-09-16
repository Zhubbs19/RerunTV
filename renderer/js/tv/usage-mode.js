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
//   2. a launch flag: ?mode=tv|desktop in the page URL (the Electron main
//      process adds it for `--mode=tv`, a browser client can type it)
//   3. client identity: the Android TV WebView's RerunTV-AndroidTV UA
//      (tv-client-viewport.js), Samsung Tizen and LG webOS TV browsers
//   4. desktop
// Nothing ever switches mode silently; a heuristic may only *suggest* it.

export const USAGE_MODES = ['desktop', 'tv'];
export const USAGE_MODE_PREFERENCES = ['auto', 'desktop', 'tv'];
const STORAGE_KEY = 'reruntv.usageMode';

const TV_USER_AGENTS = [
  [/RerunTV-AndroidTV/i, 'Android TV client'],
  [/Tizen/i, 'Samsung TV browser'],
  [/Web0S|webOS/i, 'LG TV browser'],
];

// Pure: every input is passed in, so node:test can cover the precedence.
export function resolveUsageMode({ preference, query, userAgent } = {}) {
  if (preference === 'desktop' || preference === 'tv') return { mode: preference, source: 'device choice' };
  const flag = parseModeFlag(query);
  if (flag) return { mode: flag, source: 'launch flag' };
  const identity = TV_USER_AGENTS.find(([pattern]) => pattern.test(userAgent || ''));
  if (identity) return { mode: 'tv', source: identity[1] };
  return { mode: 'desktop', source: 'default' };
}

export function parseModeFlag(query) {
  if (!query) return null;
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const value = (params.get('mode') || '').toLowerCase();
  return value === 'tv' || value === 'desktop' ? value : null;
}

// ---------- This device ----------

let current = { mode: 'desktop', source: 'default' };
const listeners = new Set();

function readPreference() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return USAGE_MODE_PREFERENCES.includes(value) ? value : 'auto';
  } catch (e) {
    return 'auto';
  }
}

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

function environment(preference) {
  return {
    preference,
    query: typeof location !== 'undefined' ? location.search : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

// Called once, as early as app.js runs, before anything renders.
export function initUsageMode() {
  return stamp(resolveUsageMode(environment(readPreference())));
}

export function usageMode() {
  return current.mode;
}

export function usageModeSource() {
  return current.source;
}

export function isTvMode() {
  return current.mode === 'tv';
}

export function getUsageModePreference() {
  return readPreference();
}

// ---------- Preview (docs/design/01 §8) ----------
// TV mode for this session only, from a desk: layouts and plugin panels can be
// checked without a TV, and the device's own choice is left alone. Ending the
// preview (or any real choice) goes back to what the device resolves to.
let previewing = false;

export function isPreviewingTvMode() {
  return previewing;
}

export function setTvPreview(on) {
  previewing = !!on;
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('tv-preview', previewing);
  if (previewing) return stamp({ mode: 'tv', source: 'preview' });
  return stamp(resolveUsageMode(environment(readPreference())));
}

// 'auto' forgets this device's choice and falls back to flag/identity.
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

export function onUsageModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
