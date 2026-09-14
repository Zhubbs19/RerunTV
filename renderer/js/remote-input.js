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
  left: 'guide.open', right: 'banner.show',
  ok: 'key:Enter', 'long:ok': 'menu.open',
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
  red: 'guide.dayBack', green: 'guide.dayForward', yellow: 'key:b', blue: 'key:d',
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

const DIALOG = {
  left: 'focus.prev', up: 'focus.prev', right: 'focus.next', down: 'focus.next',
  ok: 'focus.activate', back: 'dialog.cancel', exit: 'dialog.cancel',
};

const TEXT = { back: 'key:Escape', exit: 'key:Escape' };

export const CONTEXT_ACTIONS = {
  watching: WATCHING, timeMachine: TIME_MACHINE, guide: GUIDE, menu: MENU, details: DETAILS, dialog: DIALOG, text: TEXT,
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
