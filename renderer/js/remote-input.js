// Remote input, the pure half (docs/design/01 §5). Raw events from any source
// become a RemoteKey — a closed vocabulary of physical buttons — and a
// RemoteKey plus the screen's context becomes an action id. No DOM here, so
// node:test covers the tables; tv-input.js is the glue that reads the context
// off the page and runs the actions.
//
// Sources that reach normalizeKey today: keyboards (Arrow*, Enter, Escape…),
// TV browsers and WebViews that report remote buttons as KeyboardEvent.key
// names (ChannelUp, MediaPlayPause, ColorF0Red, GoBack…) or only as legacy
// keyCodes (Tizen 10009 Return, webOS 461 Back, 403–406 colour keys), and the
// Android TV client, which posts RemoteKey names straight through
// window.RerunTVInput.native (tv-input.js).

export const REMOTE_KEYS = [
  'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'info', 'guide',
  'chUp', 'chDown', 'volUp', 'volDown', 'mute',
  'digit0', 'digit1', 'digit2', 'digit3', 'digit4', 'digit5', 'digit6', 'digit7', 'digit8', 'digit9', 'dot',
  'playPause', 'play', 'pause', 'stop', 'rewind', 'fastForward', 'prev', 'next', 'record',
  'red', 'green', 'yellow', 'blue', 'settings', 'search', 'exit', 'tv', 'captions', 'audioTrack', 'power', 'last',
];

const BY_KEY = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Up: 'up', Down: 'down', Left: 'left', Right: 'right', // older WebViews
  Enter: 'ok', Select: 'ok', Accept: 'ok',
  Escape: 'back', GoBack: 'back', BrowserBack: 'back', Exit: 'exit',
  Home: 'home', ContextMenu: 'menu', Info: 'info', Guide: 'guide',
  ChannelUp: 'chUp', ChannelDown: 'chDown', PageUp: 'chUp', PageDown: 'chDown',
  AudioVolumeUp: 'volUp', AudioVolumeDown: 'volDown', AudioVolumeMute: 'mute', VolumeUp: 'volUp', VolumeDown: 'volDown', VolumeMute: 'mute',
  MediaPlayPause: 'playPause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
  MediaRewind: 'rewind', MediaFastForward: 'fastForward', MediaTrackPrevious: 'prev', MediaTrackNext: 'next', MediaRecord: 'record',
  ColorF0Red: 'red', ColorF1Green: 'green', ColorF2Yellow: 'yellow', ColorF3Blue: 'blue',
  Settings: 'settings', BrowserSearch: 'search', ClosedCaptionToggle: 'captions', Subtitle: 'captions',
  AudioTrack: 'audioTrack', Power: 'power', Backspace: 'last',
};

// Which RemoteKeys only some remotes have — hints for them stay hidden until
// this device has actually sent one (doc 01 §5.2: hints show only what the
// current remote delivers).
export const OPTIONAL_KEY_GROUPS = {
  colour: ['red', 'green', 'yellow', 'blue'],
};

export function optionalGroupOf(remoteKey) {
  return Object.keys(OPTIONAL_KEY_GROUPS).find((group) => OPTIONAL_KEY_GROUPS[group].includes(remoteKey)) || null;
}

// Legacy keyCodes some TV browsers report with an unhelpful key ("Unidentified").
const BY_KEY_CODE = {
  10009: 'back', 461: 'back', // Samsung Return, LG Back
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
  427: 'chUp', 428: 'chDown', 457: 'info', 458: 'guide',
  415: 'play', 19: 'pause', 413: 'stop', 412: 'rewind', 417: 'fastForward', 10252: 'playPause',
};

// KeyboardEvent-like {key, keyCode} -> RemoteKey or null. Modifier combos are
// never a remote button (Shift+Up is "favourites" on a keyboard), so they
// stay with the keyboard handler.
export function normalizeKey(event) {
  if (!event || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const { key } = event;
  if (typeof key === 'string' && key.length === 1) {
    if (key >= '0' && key <= '9') return `digit${key}`;
    if (key === '.') return 'dot';
    return null;
  }
  if (key && BY_KEY[key]) return BY_KEY[key];
  if (event.keyCode && BY_KEY_CODE[event.keyCode]) return BY_KEY_CODE[event.keyCode];
  return null;
}

// ---------- Contexts and actions ----------
// Contexts, most specific first (tv-input.js decides which applies):
//   text      a focused text field — the field owns every key but back
//   dialog    the exit prompt, a confirm dialog
//   menu      the TV menu
//   details   the details card
//   guide     the full guide grid
//   timeMachine  live TV with the time machine open
//   watching  live TV, nothing open
//
// An action id is either a TV-mode action ('guide.open', 'menu.toggle',
// 'exit.prompt', 'guide.pageUp' …) or 'key:<Key>' — "hand this key to the
// existing keyboard handler", which is how everything that already works on a
// keyboard (focus movement in the menu, Enter to tune, Escape to close) keeps
// one implementation.

const WATCHING = {
  up: 'key:ArrowUp', down: 'key:ArrowDown', chUp: 'key:ArrowUp', chDown: 'key:ArrowDown',
  left: 'guide.open', right: 'banner.open',
  // OK opens the banner hub (docs/design/01 §6.1): browse channels with ◀▶
  // without tuning, OK tunes, ▼ opens the programme's actions.
  ok: 'banner.open', 'long:ok': 'menu.open',
  back: 'exit.prompt', exit: 'exit.prompt',
  menu: 'menu.toggle', playPause: 'menu.toggle', settings: 'menu.toggle',
  guide: 'guide.open', info: 'info.show', last: 'key:Backspace',
  mute: 'key:m', volUp: 'key:+', volDown: 'key:-',
  rewind: 'timeMachine.open', fastForward: 'timeMachine.open', record: 'key:x',
  dot: 'key:.',
};

// docs/design/11 §3.1: ◀▶ step the scrubber (accelerating while held), ▲▼ jump
// program starts, OK plays from there, Back returns to live. Rewind/FF keep
// the VCR-style shuttle; CH± still changes channel.
const TIME_MACHINE = {
  ...WATCHING,
  left: 'scrub.back', right: 'scrub.forward', up: 'scrub.prevProgram', down: 'scrub.nextProgram',
  rewind: 'key:ArrowLeft', fastForward: 'key:ArrowRight',
  back: 'key:Escape', exit: 'key:Escape', ok: 'key:Enter', play: 'key:t', pause: 'key:t',
  red: 'key:[', green: 'key:]',
};

// docs/design/11 §2.3. Hold OK opens the highlighted program's actions (Info,
// Record, Remind, Watch from start, ±24 h, TV menu); red/green step a day
// where a remote has colour keys. Dock/full page and search live in the TV
// menu while the guide is open (tv-menu.js).
const GUIDE = {
  up: 'key:ArrowUp', down: 'key:ArrowDown', left: 'key:ArrowLeft', right: 'key:ArrowRight',
  chUp: 'guide.pageUp', chDown: 'guide.pageDown',
  ok: 'key:Enter', 'long:ok': 'guide.programActions', info: 'key:i',
  back: 'key:Escape', exit: 'key:Escape', guide: 'key:Escape',
  menu: 'menu.toggle', playPause: 'menu.toggle', settings: 'menu.toggle',
  // docs/design/01 §6.2's colour mapping: red/green step a day, yellow filters,
  // blue lists reminders. Breaks and dock/full page live in the TV menu.
  red: 'guide.dayBack', green: 'guide.dayForward', yellow: 'guide.filter', blue: 'guide.reminders',
};

// The banner hub owns its own keys while it is up (banner-hub.js).
const BANNER = {
  left: 'banner.key.left', right: 'banner.key.right', up: 'banner.key.up', down: 'banner.key.down',
  ok: 'banner.key.ok', back: 'banner.key.back', exit: 'banner.key.back',
  chUp: 'key:ArrowUp', chDown: 'key:ArrowDown',
  menu: 'menu.toggle', playPause: 'menu.toggle', settings: 'menu.toggle',
  guide: 'guide.open', info: 'info.show', 'long:ok': 'menu.open',
};

const MENU = {
  up: 'key:ArrowUp', down: 'key:ArrowDown', left: 'key:ArrowLeft', right: 'key:ArrowRight',
  ok: 'key:Enter', back: 'key:Escape', exit: 'key:Escape',
  menu: 'key:Escape', playPause: 'key:Escape', settings: 'key:Escape',
  chUp: 'menu.first', chDown: 'menu.last',
};

const DETAILS = {
  back: 'key:Escape', exit: 'key:Escape', info: 'key:Escape', ok: 'key:Escape',
  menu: 'menu.toggle', playPause: 'menu.toggle',
};

// Dialogs move focus by on-screen position (ui/spatial-focus.js), so a row, a
// list or a grid of buttons all work with the D-pad.
const DIALOG = {
  left: 'focus.left', up: 'focus.up', right: 'focus.right', down: 'focus.down',
  ok: 'focus.activate', back: 'dialog.cancel', exit: 'dialog.cancel',
};

const TEXT = { back: 'key:Escape', exit: 'key:Escape' };

export const CONTEXT_ACTIONS = {
  watching: WATCHING, banner: BANNER, timeMachine: TIME_MACHINE, guide: GUIDE, menu: MENU, details: DETAILS, dialog: DIALOG, text: TEXT,
};

// null means "not a remote concern here": the event goes to the keyboard
// handler untouched (in the text context, the field gets it).
export function routeRemoteKey(context, remoteKey, { longPress = false } = {}) {
  const table = CONTEXT_ACTIONS[context];
  if (!table || !remoteKey) return null;
  if (longPress && table[`long:${remoteKey}`]) return table[`long:${remoteKey}`];
  if (remoteKey.startsWith('digit')) return context === 'watching' || context === 'timeMachine' ? `key:${remoteKey.slice(5)}` : null;
  return table[remoteKey] || null;
}

// Whether a key has a long-press meaning in a context — only those keys wait
// for keyup (or a hold) before acting; every other key acts on keydown.
export function hasLongPress(context, remoteKey) {
  const table = CONTEXT_ACTIONS[context];
  return !!(table && table[`long:${remoteKey}`]);
}

// ---------- Long press ----------
// Detected in JS from keydown/keyup timing so it behaves the same for every
// source (doc 01 §5.3). Pure: the caller passes timestamps and schedules the
// timer; this only decides.
export const LONG_PRESS_MS = 500;

export function createLongPressTracker(thresholdMs = LONG_PRESS_MS) {
  const down = new Map(); // remoteKey -> { at, fired }
  return {
    // true if this keydown starts a press (not an auto-repeat of one in progress)
    press(remoteKey, at) {
      if (down.has(remoteKey)) return false;
      down.set(remoteKey, { at, fired: false });
      return true;
    },
    // Called by the hold timer (and on repeats): true exactly once, when the
    // hold crosses the threshold.
    hold(remoteKey, at) {
      const entry = down.get(remoteKey);
      if (!entry || entry.fired || at - entry.at < thresholdMs) return false;
      entry.fired = true;
      return true;
    },
    // 'short' if the key was released before it counted as held, 'long' if the
    // long action already fired, null if this key wasn't being tracked.
    release(remoteKey, at) {
      const entry = down.get(remoteKey);
      if (!entry) return null;
      down.delete(remoteKey);
      if (entry.fired) return 'long';
      return at - entry.at >= thresholdMs ? 'long-late' : 'short';
    },
    isDown(remoteKey) {
      return down.has(remoteKey);
    },
    reset() {
      down.clear();
    },
  };
}

// Channel changes from a held rocker or D-pad: one per interval, however fast
// the source repeats (doc 01 §5.3 — was CHANNEL_DEBOUNCE_MS in the Android
// client only).
export const CHANNEL_REPEAT_MS = 300;

// ---------- Android KeyEvent codes ----------
// The Android TV client posts raw KeyEvent codes (docs/design/01 §5.1, Phase
// B): normalization lives here, where it is testable and shared, instead of a
// Kotlin table. Gamepads on Android TV arrive as KEYCODE_BUTTON_* and map to
// the same RemoteKeys as the browser Gamepad API source (gamepad.js).
export const ANDROID_KEYCODES = {
  19: 'up', 20: 'down', 21: 'left', 22: 'right', 23: 'ok', 66: 'ok', 160: 'ok',
  4: 'back', 111: 'back',
  166: 'chUp', 167: 'chDown', 92: 'chUp', 93: 'chDown', 229: 'last', 67: 'last',
  165: 'info', 172: 'guide', 82: 'menu', 176: 'settings', 84: 'search', 170: 'tv',
  183: 'red', 184: 'green', 185: 'yellow', 186: 'blue',
  85: 'playPause', 126: 'play', 127: 'pause', 86: 'stop', 89: 'rewind', 90: 'fastForward',
  87: 'next', 88: 'prev', 130: 'record', 175: 'captions', 222: 'audioTrack',
  24: 'volUp', 25: 'volDown', 164: 'mute', 91: 'mute', 26: 'power',
  7: 'digit0', 8: 'digit1', 9: 'digit2', 10: 'digit3', 11: 'digit4', 12: 'digit5', 13: 'digit6', 14: 'digit7', 15: 'digit8', 16: 'digit9',
  144: 'digit0', 145: 'digit1', 146: 'digit2', 147: 'digit3', 148: 'digit4', 149: 'digit5', 150: 'digit6', 151: 'digit7', 152: 'digit8', 153: 'digit9',
  56: 'dot', 158: 'dot',
  // Gamepad buttons (A/B/X/Y, bumpers, triggers, Start/Select).
  96: 'ok', 97: 'back', 99: 'info', 100: 'guide', 102: 'chDown', 103: 'chUp', 104: 'rewind', 105: 'fastForward', 108: 'menu', 109: 'back',
};

export function normalizeAndroidKeyCode(keyCode) {
  return ANDROID_KEYCODES[Number(keyCode)] || null;
}

// A stable id for "this physical button on this source", which learn mode
// keys its overrides on (remote-profile.js).
export function rawKeyId(evt) {
  if (!evt) return null;
  if (evt.source === 'android' && Number.isFinite(Number(evt.keyCode))) return `android:${Number(evt.keyCode)}`;
  if (evt.source === 'gamepad' && evt.button != null) return `gamepad:${evt.button}`;
  if (evt.source === 'cec' && evt.code != null) return `cec:${evt.code}`;
  if (typeof evt.key === 'string' && evt.key && evt.key !== 'Unidentified') return `key:${evt.key}`;
  if (evt.keyCode) return `keyCode:${evt.keyCode}`;
  return null;
}

// ---------- Plugin channel actions ----------
// What a plugin channel's onAction(action, ctx) receives in TV mode
// (docs/design/01 §6.6): actions, not raw keys, so a plugin never has to
// guess which remote sent what. keyForAction gives the keyboard key an older
// onKey plugin already understands, which is how a plugin can adopt actions
// by forwarding to its existing onKey.
export const PLUGIN_CHANNEL_ACTIONS = {
  up: 'move.up', down: 'move.down', left: 'move.left', right: 'move.right',
  ok: 'select', back: 'back', info: 'info',
};

const ACTION_KEYS = {
  'move.up': 'ArrowUp', 'move.down': 'ArrowDown', 'move.left': 'ArrowLeft', 'move.right': 'ArrowRight',
  select: 'Enter', back: 'Escape', info: 'i',
};

export function pluginActionFor(remoteKey) {
  return PLUGIN_CHANNEL_ACTIONS[remoteKey] || null;
}

export function keyForAction(action) {
  return ACTION_KEYS[action] || null;
}
