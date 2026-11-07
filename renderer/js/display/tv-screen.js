// Two things for a PC driving a TV over HDMI (PICTURE & SOUND › SCREEN &
// SPEAKERS), both per device in localStorage and host window only:
//
// Screen edges. Many TVs trim a few percent off each edge of an HDMI picture
// (overscan), which cuts into the clock, hint bar and logo bug. Shrinking
// #app, the box every overlay is positioned in, pulls all of it in together,
// and applyDisplayMode re-measures #app so the picture follows. Kept per
// screen: the TV overscans, the desk monitor doesn't.
//
// Following the TV's power. When the window's screen goes away (the TV was
// switched off and Windows dropped it) the box can go to standby with it, and
// come back on when the screen returns. Only a standby this caused is undone,
// so a box someone switched off by hand stays off.

import { S } from '../core/state.js';
import { applyDisplayModeSettled } from './mode.js';
import { powerOff, powerOn } from '../playback/power.js';

const EDGES_KEY = 'reruntv.screenEdges';
const POWER_KEY = 'reruntv.screenOffAction';
export const SCREEN_EDGE_MAX = 6;
export const SCREEN_OFF_ACTIONS = ['move', 'standby'];

let currentScreen = null;
let standbyFromScreen = false;
const listeners = new Set();

/**
 * Reads a JSON value from localStorage.
 * @param {string} key The storage key.
 * @param {*} fallback Returned when the key is missing, null or unreadable.
 * @returns {*} The stored value or the fallback.
 */
function readJson(key, fallback) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null');
    return value == null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

/**
 * Writes a JSON value to localStorage, ignoring storage errors.
 * @param {string} key The storage key.
 * @param {*} value The value to store.
 */
function writeJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
}

/**
 * Returns the screen the window is on.
 * @returns {?object} A copy of `{ id, label }`, or `null` before it is known.
 */
export function getCurrentScreen() {
  return currentScreen ? { ...currentScreen } : null;
}

/**
 * Subscribes to changes of the window's screen.
 * @param {(screen: ?object) => void} fn Called with the new `{ id, label }` or `null`.
 * @returns {Function} Unsubscribes.
 */
export function onCurrentScreenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Screen edges ----------

/**
 * Reads the stored per-screen edge trims.
 * @returns {object} Screen id to `{ label, pct }`.
 */
function edgesMap() {
  const map = readJson(EDGES_KEY, {});
  return map && typeof map === 'object' ? map : {};
}

/**
 * Percent trimmed from each edge, 0..SCREEN_EDGE_MAX, for `screen` (default:
 * the one the window is on). Matched by id, then by name.
 * @param {?object} [screen] The screen `{ id, label }`; defaults to the current one.
 * @returns {number} The trim percentage.
 */
export function getScreenEdge(screen = currentScreen) {
  if (!screen) return 0;
  const map = edgesMap();
  const entry = map[String(screen.id)]
    || Object.values(map).find((e) => e && screen.label && e.label === screen.label);
  const pct = entry ? Number(entry.pct) : 0;
  return Number.isFinite(pct) ? Math.min(SCREEN_EDGE_MAX, Math.max(0, pct)) : 0;
}

/**
 * Stores the edge trim for a screen and applies it.
 * A trim of zero removes the screen's entry.
 * @param {number} pct Percent trimmed from each edge, clamped to 0..`SCREEN_EDGE_MAX`.
 * @param {?object} [screen] The screen `{ id, label }`; defaults to the current one.
 */
export function setScreenEdge(pct, screen = currentScreen) {
  if (!screen) return;
  const map = edgesMap();
  const value = Math.min(SCREEN_EDGE_MAX, Math.max(0, Number(pct) || 0));
  if (value) map[String(screen.id)] = { label: screen.label || '', pct: value };
  else delete map[String(screen.id)];
  writeJson(EDGES_KEY, map);
  applyScreenEdge();
}

/**
 * Sets `--screen-edge` for the current screen and re-measures the picture.
 */
function applyScreenEdge() {
  const pct = getScreenEdge();
  const root = document.documentElement;
  if (pct) root.style.setProperty('--screen-edge', String(pct / 100));
  else root.style.removeProperty('--screen-edge');
  applyDisplayModeSettled();
}

// A white frame on #app's edges, for lining the picture up with the TV's.
let guideTimer = null;
/**
 * Shows the edge-alignment frame on `#app` for a while.
 * @param {number} [ms=4000] How long the frame stays up.
 */
export function flashScreenEdgeGuide(ms = 4000) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.add('screen-edge-guide');
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => app.classList.remove('screen-edge-guide'), ms);
}

// ---------- Following the TV's power ----------

/**
 * Returns what happens when the window's screen goes away.
 * @returns {string} `'move'` or `'standby'`.
 */
export function getScreenOffAction() {
  const value = readJson(POWER_KEY, 'move');
  return SCREEN_OFF_ACTIONS.includes(value) ? value : 'move';
}

/**
 * Stores what happens when the window's screen goes away.
 * @param {string} action `'move'` or `'standby'`; anything else stores `'move'`.
 */
export function setScreenOffAction(action) {
  writeJson(POWER_KEY, SCREEN_OFF_ACTIONS.includes(action) ? action : 'move');
}

/**
 * Follows the TV's power: standby when the screen is lost, wake when it returns.
 * Only wakes the box if this module put it in standby.
 * @param {object} [event] The screen power event.
 * @param {string} event.state `'lost'` or `'returned'`.
 */
function onScreenPower({ state } = {}) {
  if (state === 'lost') {
    if (getScreenOffAction() !== 'standby' || !S.isPoweredOn) return;
    standbyFromScreen = true;
    powerOff({ reason: 'screen' });
  } else if (state === 'returned') {
    const wake = standbyFromScreen && !S.isPoweredOn;
    standbyFromScreen = false;
    if (wake) powerOn();
  }
}

// ---------- Install ----------

/**
 * Records the window's current screen, reapplies its edge trim and tells listeners.
 * @param {?object} ref The screen `{ id, label }`, or `null`.
 */
function setCurrent(ref) {
  currentScreen = ref ? { id: String(ref.id), label: String(ref.label || '') } : null;
  applyScreenEdge();
  listeners.forEach((fn) => { try { fn(getCurrentScreen()); } catch (e) { console.warn('[tv-screen] listener failed', e); } });
}

/**
 * Called from app.js once the TV screen is up, host window only.
 */
export function installTvScreen() {
  const api = window.api;
  if (!api || typeof api.listScreens !== 'function') return;
  if (typeof api.onScreenChange === 'function') api.onScreenChange(setCurrent);
  if (typeof api.onScreenPower === 'function') api.onScreenPower(onScreenPower);
  Promise.resolve(api.listScreens()).then((info) => {
    if (!info) return;
    const here = info.screens.find((screen) => screen.current);
    if (here && !currentScreen) setCurrent(here);
    // The PC started with the TV still off: the window is waiting on the
    // desk for it, so the box waits in standby too.
    if (info.pendingReturn && getScreenOffAction() === 'standby') onScreenPower({ state: 'lost' });
  }).catch(() => {});
}
