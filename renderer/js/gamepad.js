// Game controllers as a remote (docs/design/01 §5.2 "Gamepad", Phase E).
// A=OK, B=Back, X=Info, Y=Guide, LB/RB=CH−/CH+, LT/RT=rewind/fast-forward,
// Start=TV menu, Select=Back, D-pad and left stick move (with a deadzone and
// key repeat). Uses the browser Gamepad API's standard mapping; an Android TV
// controller also arrives as KEYCODE_BUTTON_* through the client, which
// remote-input.js maps the same way.
//
// The mapper is pure (node:test covers it); installGamepad is the polling loop.

// Standard-mapping button index → RemoteKey.
export const GAMEPAD_BUTTONS = {
  0: 'ok', 1: 'back', 2: 'info', 3: 'guide', 4: 'chDown', 5: 'chUp', 6: 'rewind', 7: 'fastForward',
  8: 'back', 9: 'menu', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
};
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

export const STICK_DEADZONE = 0.5;
export const REPEAT_DELAY_MS = 400;
export const REPEAT_RATE_MS = 120;

// pad: { buttons: [{ pressed }], axes: [x, y, …] } (a Gamepad snapshot).
// Returns a function (pad, now) → [{ key, button, repeat }] of presses to send.
export function createGamepadMapper({ deadzone = STICK_DEADZONE, repeatDelay = REPEAT_DELAY_MS, repeatRate = REPEAT_RATE_MS } = {}) {
  const held = new Map(); // key → { since, lastSent }
  return function update(pad, now) {
    const down = new Map(); // key → button id (for learn mode)
    (pad && pad.buttons ? pad.buttons : []).forEach((b, i) => {
      const key = GAMEPAD_BUTTONS[i];
      if (key && b && (b.pressed || b.value > 0.5)) down.set(key, i);
    });
    const [x = 0, y = 0] = (pad && pad.axes) || [];
    if (x <= -deadzone) down.set('left', 'axis0-');
    if (x >= deadzone) down.set('right', 'axis0+');
    if (y <= -deadzone) down.set('up', 'axis1-');
    if (y >= deadzone) down.set('down', 'axis1+');

    const events = [];
    down.forEach((button, key) => {
      const state = held.get(key);
      if (!state) {
        held.set(key, { since: now, lastSent: now });
        events.push({ key, button, repeat: false });
      } else if (DIRECTIONS.has(key) && now - state.since >= repeatDelay && now - state.lastSent >= repeatRate) {
        state.lastSent = now;
        events.push({ key, button, repeat: true });
      }
    });
    Array.from(held.keys()).forEach((key) => { if (!down.has(key)) held.delete(key); });
    return events;
  };
}

// In desktop mode a controller still works (§8 "remote-in-desktop"), as the
// keys the keyboard handler already knows.
const DESKTOP_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape',
  info: 'i', guide: 'g', chUp: 'PageUp', chDown: 'PageDown', menu: '?',
};

export function installGamepad({ isTvMode }) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  const mapper = createGamepadMapper();
  let polling = false;
  const poll = () => {
    const pads = Array.from(navigator.getGamepads() || []).filter(Boolean);
    if (!pads.length) { polling = false; return; }
    const now = performance.now();
    pads.forEach((pad) => {
      mapper(pad, now).forEach(({ key, button, repeat }) => {
        if (isTvMode() && window.RerunTVInput) {
          window.RerunTVInput.native({ source: 'gamepad', key, button, repeat });
        } else if (DESKTOP_KEYS[key]) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: DESKTOP_KEYS[key], repeat, bubbles: true }));
        }
      });
    });
    requestAnimationFrame(poll);
  };
  const start = () => { if (!polling) { polling = true; requestAnimationFrame(poll); } };
  window.addEventListener('gamepadconnected', start);
  if (Array.from(navigator.getGamepads() || []).some(Boolean)) start();
}
