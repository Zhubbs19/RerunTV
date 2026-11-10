// Game controllers as a remote (docs/design/01 §5.2 "Gamepad", Phase E).
// Out of the box a standard pad is: A=OK, B=Back, X=Info, Y=Guide,
// LB/RB=CH−/CH+, LT/RT=rewind/fast-forward, Menu=TV menu, View=Back, D-pad and
// left stick move, right stick up/down is the volume, left stick click mutes
// and right stick click is the last channel. Every one of those can be changed
// in SYSTEM › REMOTE & KEYS › GAME CONTROLLER (`config.gamepad.buttons`).
//
// Uses the browser Gamepad API's standard mapping; an Android TV controller
// also arrives as KEYCODE_BUTTON_* through the client, which remote/input.js
// maps the same way.
//
// The tables and the mapper are pure (node:test covers them); installGamepad
// is the polling loop. What a press then does is tv/input.js's gamepadInput.
import { KEY_ACTIONS } from '../core/keymap.js';

/**
 * @typedef {object} GamepadControl One physical control of a standard-mapping pad.
 * @property {string} id Button index (`'0'`…`'16'`) or stick direction (`'axis3-'`).
 * @property {string} label The name printed on a standard controller.
 * @property {string} target What it does until reassigned (a target id, or `'none'`).
 */

/** @type {GamepadControl[]} */
export const GAMEPAD_CONTROLS = [
  { id: '0', label: 'A', target: 'ok' },
  { id: '1', label: 'B', target: 'back' },
  { id: '2', label: 'X', target: 'info' },
  { id: '3', label: 'Y', target: 'guide' },
  { id: '4', label: 'LB', target: 'chDown' },
  { id: '5', label: 'RB', target: 'chUp' },
  { id: '6', label: 'LT', target: 'rewind' },
  { id: '7', label: 'RT', target: 'fastForward' },
  { id: '8', label: 'View', target: 'back' },
  { id: '9', label: 'Menu', target: 'menu' },
  { id: '10', label: 'Left stick click', target: 'mute' },
  { id: '11', label: 'Right stick click', target: 'last' },
  { id: '12', label: 'D-pad up', target: 'up' },
  { id: '13', label: 'D-pad down', target: 'down' },
  { id: '14', label: 'D-pad left', target: 'left' },
  { id: '15', label: 'D-pad right', target: 'right' },
  { id: '16', label: 'Home button', target: 'none' },
  { id: 'axis1-', label: 'Left stick up', target: 'up' },
  { id: 'axis1+', label: 'Left stick down', target: 'down' },
  { id: 'axis0-', label: 'Left stick left', target: 'left' },
  { id: 'axis0+', label: 'Left stick right', target: 'right' },
  { id: 'axis3-', label: 'Right stick up', target: 'volUp' },
  { id: 'axis3+', label: 'Right stick down', target: 'volDown' },
  { id: 'axis2-', label: 'Right stick left', target: 'none' },
  { id: 'axis2+', label: 'Right stick right', target: 'none' },
];

const DEFAULT_TARGETS = Object.fromEntries(GAMEPAD_CONTROLS.map((control) => [control.id, control.target]));

// What a control can be given. A RemoteKey acts by what is on screen, exactly
// like that button on a remote; `action:<id>` is one of the keyboard shortcuts
// (core/keymap.js), for things a remote has no button for.
const REMOTE_TARGETS = [
  ['ok', 'OK / Select'], ['back', 'Back'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['menu', 'TV menu'], ['guide', 'Guide'], ['info', 'Info'],
  ['chUp', 'Channel up'], ['chDown', 'Channel down'], ['last', 'Last channel'],
  ['volUp', 'Volume up'], ['volDown', 'Volume down'], ['mute', 'Mute'],
  ['rewind', 'Rewind'], ['fastForward', 'Fast-forward'], ['record', 'Record'],
  ['captions', 'Captions'], ['audioTrack', 'Audio track'],
];
// Shortcuts a RemoteKey above already covers.
const COVERED_ACTIONS = new Set(['guide', 'mute', 'details']);

/**
 * @typedef {object} GamepadTarget Something a control can be assigned to.
 * @property {string} id `'none'`, a RemoteKey, or `action:<KEY_ACTIONS id>`.
 * @property {string} label Its name in the editor.
 * @property {string} group `'remote'`, `'shortcut'` or `'none'`.
 */

/** @type {GamepadTarget[]} */
export const GAMEPAD_TARGETS = [
  { id: 'none', label: 'Nothing', group: 'none' },
  ...REMOTE_TARGETS.map(([id, label]) => ({ id, label, group: 'remote' })),
  ...KEY_ACTIONS.filter((action) => !COVERED_ACTIONS.has(action.id)).map((action) => ({ id: `action:${action.id}`, label: action.label, group: 'shortcut' })),
];
const TARGET_IDS = new Set(GAMEPAD_TARGETS.map((target) => target.id));

// Targets that repeat while the control is held.
const REPEATING = new Set(['up', 'down', 'left', 'right', 'volUp', 'volDown']);

export const STICK_DEADZONE = 0.5;
export const DEADZONE_MIN = 0.2;
export const DEADZONE_MAX = 0.9;
export const REPEAT_DELAY_MS = 400;
export const REPEAT_RATE_MS = 120;

/**
 * What a control does, given the saved assignments.
 * @param {?object} bindings `config.gamepad.buttons` (control id → target id).
 * @param {string|number} control The control id.
 * @returns {?string} A RemoteKey or `action:<id>`, or null when it does nothing.
 */
export function gamepadTarget(bindings, control) {
  const saved = bindings && bindings[control];
  const target = typeof saved === 'string' && TARGET_IDS.has(saved) ? saved : DEFAULT_TARGETS[control];
  return target && target !== 'none' ? target : null;
}

/**
 * The target id a control ships with.
 * @param {string|number} control The control id.
 * @returns {string} A target id; `'none'` for a control that isn't in the table.
 */
export function defaultGamepadTarget(control) {
  return DEFAULT_TARGETS[control] || 'none';
}

/**
 * The game-controller settings with defaults filled in and values clamped.
 * @param {?object} config The app config.
 * @returns {{enabled: boolean, deadzone: number, background: boolean, buttons: object}} The settings.
 */
export function gamepadSettings(config) {
  const g = (config && config.gamepad) || {};
  const deadzone = Number.isFinite(g.deadzone) ? Math.min(DEADZONE_MAX, Math.max(DEADZONE_MIN, g.deadzone)) : STICK_DEADZONE;
  return {
    enabled: g.enabled !== false,
    deadzone,
    background: !!g.background,
    buttons: g.buttons && typeof g.buttons === 'object' ? g.buttons : {},
  };
}

/**
 * A controller's name without the driver details browsers append to it.
 * @param {string} id `Gamepad.id`, such as "Wireless Controller (STANDARD GAMEPAD Vendor: 0000 Product: 0000)".
 * @returns {string} The short name.
 */
export function gamepadName(id) {
  const name = String(id || '').replace(/\s*\([^)]*(?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '').trim();
  return name || 'Game controller';
}

/**
 * pad: { buttons: [{ pressed, value }], axes: [x, y, x2, y2] } (a Gamepad snapshot).
 * Returns a function (pad, now, live) → events. Each event is one control going
 * down (`repeat: false`), repeating while held (`repeat: true`, directions and
 * volume only) or coming back up (`release: true`); `key` is what the control
 * is assigned to (null when nothing) and `button` is the control id.
 * @param {object} [opts] Options.
 * @param {number} [opts.deadzone=STICK_DEADZONE] Stick travel that counts as a direction.
 * @param {number} [opts.repeatDelay=REPEAT_DELAY_MS] Hold time before a control repeats.
 * @param {number} [opts.repeatRate=REPEAT_RATE_MS] Time between repeats.
 * @param {?object} [opts.bindings=null] Control id → target id assignments.
 * @returns {Function} The mapper `(pad, now, live) => events`; `live.deadzone` and `live.bindings` override the options for that call, so a settings change applies to the next frame.
 */
export function createGamepadMapper({ deadzone = STICK_DEADZONE, repeatDelay = REPEAT_DELAY_MS, repeatRate = REPEAT_RATE_MS, bindings = null } = {}) {
  const held = new Map(); // control → { since, lastSent }
  return function update(pad, now, live = {}) {
    const zone = Number.isFinite(live.deadzone) ? live.deadzone : deadzone;
    const map = live.bindings || bindings;
    const down = new Set();
    (pad && pad.buttons ? pad.buttons : []).forEach((b, i) => {
      if (b && (b.pressed || b.value > 0.5)) down.add(String(i));
    });
    ((pad && pad.axes) || []).slice(0, 4).forEach((value, i) => {
      if (value <= -zone) down.add(`axis${i}-`);
      if (value >= zone) down.add(`axis${i}+`);
    });

    const events = [];
    down.forEach((control) => {
      const key = gamepadTarget(map, control);
      const state = held.get(control);
      if (!state) {
        held.set(control, { since: now, lastSent: now });
        events.push({ key, button: control, repeat: false });
      } else if (REPEATING.has(key) && now - state.since >= repeatDelay && now - state.lastSent >= repeatRate) {
        state.lastSent = now;
        events.push({ key, button: control, repeat: true });
      }
    });
    Array.from(held.keys()).forEach((control) => {
      if (down.has(control)) return;
      held.delete(control);
      events.push({ key: gamepadTarget(map, control), button: control, repeat: false, release: true });
    });
    return events;
  };
}

/**
 * One mapper per physical pad. The mapper keeps per-control held state, so sharing one across pads
 * made a second controller's button look "already held" (swallowing its first press) and let
 * one pad's release drop the other's hold. Keyed by pad.index (falling back to id); pads that
 * have gone away are pruned so a reconnect starts clean.
 * @param {object} [options] `createGamepadMapper` options for each pad.
 * @returns {object} `{ update(pad, now, live), prune(pads), size() }`.
 */
export function createPadMappers(options) {
  const mappers = new Map();
  const keyOf = (pad) => (pad.index != null ? pad.index : pad.id);
  return {
    update(pad, now, live) {
      const k = keyOf(pad);
      let mapper = mappers.get(k);
      if (!mapper) { mapper = createGamepadMapper(options); mappers.set(k, mapper); }
      return mapper(pad, now, live);
    },
    prune(pads) {
      const live = new Set(pads.map(keyOf));
      Array.from(mappers.keys()).forEach((k) => { if (!live.has(k)) mappers.delete(k); });
    },
    size: () => mappers.size,
  };
}

// ---------- Polling ----------

// The settings screen watches these to show which pad is connected and to
// light up the row of the button just pressed.
const activityListeners = new Set();

/**
 * Listens for controllers connecting or disconnecting and for every control press, whether or not the press was acted on.
 * @param {(info: {type: string, button?: string, key?: ?string}) => void} fn Called with `{ type: 'pads' }` or `{ type: 'press', button, key }`.
 * @returns {Function} Stops listening.
 */
export function onGamepadActivity(fn) {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

/**
 * Tells every activity listener; one that throws is logged and skipped.
 * @param {object} info The activity.
 */
function emitActivity(info) {
  activityListeners.forEach((fn) => { try { fn(info); } catch (e) { console.warn('[gamepad] listener failed', e); } });
}

/**
 * The controllers the browser reports right now. A pad only appears once one of its buttons has been pressed with this window in front.
 * @returns {Array<{index: number, id: string, name: string, standard: boolean}>} The connected pads.
 */
export function connectedGamepads() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  return Array.from(navigator.getGamepads() || []).filter(Boolean).map((pad) => ({
    index: pad.index, id: pad.id, name: gamepadName(pad.id), standard: pad.mapping === 'standard',
  }));
}

/**
 * Polls connected controllers each animation frame and hands each control event to `send`. Polling stops when the last pad goes away.
 *
 * Presses are dropped while the controller is switched off, or while this window is not in front (so a game being played on the same PC doesn't change channels) unless the "in the background" setting is on. Releases always go through, so a hold never sticks.
 * @param {object} opts Options.
 * @param {(event: {key: ?string, button: string, repeat: boolean, release?: boolean}) => void} opts.send Receives each event (tv/input.js's `gamepadInput`).
 * @param {() => object} opts.settings Returns the current `gamepadSettings()`.
 */
export function installGamepad({ send, settings }) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  const mappers = createPadMappers();
  let polling = false;
  const poll = () => {
    const pads = Array.from(navigator.getGamepads() || []).filter(Boolean);
    mappers.prune(pads);
    if (!pads.length) { polling = false; return; }
    const now = performance.now();
    const cfg = settings();
    const active = cfg.enabled && (cfg.background || document.hasFocus());
    pads.forEach((pad) => {
      mappers.update(pad, now, { deadzone: cfg.deadzone, bindings: cfg.buttons }).forEach((event) => {
        if (!event.release && !event.repeat && activityListeners.size) emitActivity({ type: 'press', button: event.button, key: event.key });
        if (active || event.release) send(event);
      });
    });
    requestAnimationFrame(poll);
  };
  const start = () => {
    emitActivity({ type: 'pads' });
    if (!polling) { polling = true; requestAnimationFrame(poll); }
  };
  window.addEventListener('gamepadconnected', start);
  window.addEventListener('gamepaddisconnected', () => emitActivity({ type: 'pads' }));
  if (Array.from(navigator.getGamepads() || []).some(Boolean)) start();
}
