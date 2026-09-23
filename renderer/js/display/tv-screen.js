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

function readJson(key, fallback) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null');
    return value == null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
}

export function getCurrentScreen() {
  return currentScreen ? { ...currentScreen } : null;
}

export function onCurrentScreenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Screen edges ----------

function edgesMap() {
  const map = readJson(EDGES_KEY, {});
  return map && typeof map === 'object' ? map : {};
}

// Percent trimmed from each edge, 0..SCREEN_EDGE_MAX, for `screen` (default:
// the one the window is on). Matched by id, then by name.
export function getScreenEdge(screen = currentScreen) {
  if (!screen) return 0;
  const map = edgesMap();
  const entry = map[String(screen.id)]
    || Object.values(map).find((e) => e && screen.label && e.label === screen.label);
  const pct = entry ? Number(entry.pct) : 0;
  return Number.isFinite(pct) ? Math.min(SCREEN_EDGE_MAX, Math.max(0, pct)) : 0;
}

export function setScreenEdge(pct, screen = currentScreen) {
  if (!screen) return;
  const map = edgesMap();
  const value = Math.min(SCREEN_EDGE_MAX, Math.max(0, Number(pct) || 0));
  if (value) map[String(screen.id)] = { label: screen.label || '', pct: value };
  else delete map[String(screen.id)];
  writeJson(EDGES_KEY, map);
  applyScreenEdge();
}

function applyScreenEdge() {
  const pct = getScreenEdge();
  const root = document.documentElement;
  if (pct) root.style.setProperty('--screen-edge', String(pct / 100));
  else root.style.removeProperty('--screen-edge');
  applyDisplayModeSettled();
}

// A white frame on #app's edges, for lining the picture up with the TV's.
let guideTimer = null;
export function flashScreenEdgeGuide(ms = 4000) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.add('screen-edge-guide');
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => app.classList.remove('screen-edge-guide'), ms);
}

// ---------- Following the TV's power ----------

export function getScreenOffAction() {
  const value = readJson(POWER_KEY, 'move');
  return SCREEN_OFF_ACTIONS.includes(value) ? value : 'move';
}

export function setScreenOffAction(action) {
  writeJson(POWER_KEY, SCREEN_OFF_ACTIONS.includes(action) ? action : 'move');
}

function onScreenPower({ state } = {}) {
  if (state === 'lost') {
    if (getScreenOffAction() !== 'standby' || !S.isPoweredOn) return;
    standbyFromScreen = true;
    powerOff();
  } else if (state === 'returned') {
    const wake = standbyFromScreen && !S.isPoweredOn;
    standbyFromScreen = false;
    if (wake) powerOn();
  }
}

// ---------- Install ----------

function setCurrent(ref) {
  currentScreen = ref ? { id: String(ref.id), label: String(ref.label || '') } : null;
  applyScreenEdge();
  listeners.forEach((fn) => { try { fn(getCurrentScreen()); } catch (e) { console.warn('[tv-screen] listener failed', e); } });
}

// Called from app.js once the TV screen is up, host window only.
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
