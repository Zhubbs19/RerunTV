// TV-mode input glue (docs/design/01 §5). In TV mode every remote button is
// normalized to a RemoteKey (remote-input.js), routed by what's on screen to an
// action, and run here. Anything the keyboard handler already does well —
// moving focus in the TV menu, tuning with Enter, closing with Escape — is
// routed as 'key:<Key>' and handed to that same handler, so there is one
// implementation of each behaviour, not two.
//
// Desktop mode is untouched: routeKeydown returns false and app.js's
// handleKey sees the event exactly as before.
//
// TV-only behaviour (with a remote that has just D-pad, OK, Back, CH±, Play):
//   ◀ on live TV opens the guide, ▶ shows the channel banner;
//   holding OK opens the TV menu (a short press still does what Enter does);
//   Play/Pause, Menu and Settings toggle the TV menu;
//   Back closes the top overlay, and on bare live TV asks before leaving;
//   CH± pages the guide a screenful while ▲▼ move one row;
//   a held channel key changes one channel per CHANNEL_REPEAT_MS.
import {
  detailsOverlayEl, guideGrid, guideRowsEl, pluginChannelContainerEl, setupScreen, shortcutsOverlayEl, tvScreen,
} from '../core/dom.js';
import { getChannel } from '../core/channels.js';
import { showDetailsForCurrentChannel } from './details.js';
import {
  focusGuideSearch, openGuideGrid, openGuideProgramActions, openGuideReminders, pageGuideSelection,
  shiftGuideDay, showGuideOverlay,
} from '../guide/guide.js';
import { powerOff } from '../playback/power.js';
import {
  CHANNEL_REPEAT_MS, createLongPressTracker, hasLongPress, normalizeAndroidKeyCode, normalizeKey,
  optionalGroupOf, pluginActionFor, rawKeyId, routeRemoteKey,
} from '../remote/input.js';
import { createRemoteProfile } from '../remote/profile.js';
import { S } from '../core/state.js';
import { KEY_ACTIONS } from '../core/keymap.js';
import { gamepadSettings } from './gamepad.js';
import { enterTimeMachine, scrubProgramBoundary, scrubStep } from '../playback/timemachine.js';
import { closeTvMenu, openTvMenu } from './menu.js';
import { isTvMode, onUsageModeChange } from './usage-mode.js';
import { isVirtualChannel, triggerVirtualChannelAction, virtualChannelHandlesActions } from '../playback/virtual.js';
import { bannerHubOpen, bannerKey, openBannerHub } from './banner-hub.js';
import { moveFocusSpatially, registerModal, topModal } from '../ui/focus.js';
import { registerOverlaySurface } from '../display/overlay-signal.js';
import { currentUiMode } from '../cable-guide/mode.js';
import { CABLE_GUIDE_UI } from '../cable-guide/model.js';

// app.js's keyboard handler, set by installTvInput; `key:` actions are sent to it.
let keyboardHandler = null;

// ---------- TV modals ----------
/**
 * Any full-screen TV overlay (a kit Dialog or ModalSurface: learn mode,
 * handoff, the on-screen keyboard, the first-run wizard, setup's confirms)
 * joins the modal stack in ui/focus.js and gets the dialog context: D-pad
 * moves focus by position, OK presses the focused control, Back cancels. The
 * most recently opened one on screen is the one that answers. The stack lives
 * in ui/focus.js, which imports nothing, so overlays in an import cycle with
 * this module can register while it is still evaluating.
 * Thin alias of ui/focus.js's registerModal, which is what every overlay in the tree calls
 * directly (nothing imports this one). Kept as the name the docs and CLAUDE.md mention; prefer
 * registerModal in new code.
 * @param {object} modal The overlay's hooks, `{ isOpen, element, cancel }`.
 * @returns {Function} Removes it from the stack.
 */
export function registerTvModal(modal) {
  return registerModal(modal);
}

/**
 * Gets the TV modal that answers input now.
 * @returns {?object} The top open modal, `{ isOpen, element, cancel }`, or null.
 */
function openModal() {
  return topModal();
}
// Long-press state per key, and the timers that fire a hold at 500 ms.
const longPress = createLongPressTracker();
const holdTimers = new Map();
let lastChannelKeyAt = 0;

// ---------- This device's remote (docs/design/01 §5.2) ----------
// Which buttons this remote has actually delivered, plus learn-mode
// overrides. Stored per client, so hints never advertise a button this
// remote lacks and a re-mapped button stays re-mapped.
const profile = createRemoteProfile(safeStorage());

/**
 * Checks that local storage can be used before handing it to the remote profile.
 * @returns {?Storage} `window.localStorage`, or null when it is blocked.
 */
function safeStorage() {
  try {
    window.localStorage.getItem('reruntv.probe');
    return window.localStorage;
  } catch (e) {
    return null; // private window or blocked storage: this session only
  }
}

/**
 * Gets this device's remote profile: the buttons seen and learn-mode overrides.
 * @returns {object} The profile from `createRemoteProfile`.
 */
export function remoteProfile() {
  return profile;
}

// Raw input taps: the Remote test screen watches every event, and learn mode
// grabs the next button pressed. Both see events before routing, and a sink
// swallows them so a test/capture can't also change channel.
const rawListeners = new Set();
let captureNext = null;

/**
 * Listens to every raw remote input before routing, for the Remote test screen.
 * @param {(info: object) => void} fn Called with each event's raw info.
 * @returns {Function} Stops listening.
 */
export function onRemoteInput(fn) {
  rawListeners.add(fn);
  return () => rawListeners.delete(fn);
}

// While set, every button goes to fn(info) and nothing is routed.
let inputSink = null;
/**
 * Sends every button to a sink instead of routing it, until cleared.
 * @param {?Function} fn The sink, or null to route normally again.
 */
export function setRemoteInputSink(fn) {
  inputSink = typeof fn === 'function' ? fn : null;
}

/**
 * Learn mode: the next button pressed is handed to fn({ rawId, remoteKey }).
 * @param {(info: object) => void} fn Called once with the next button's info.
 * @returns {Function} Cancels the capture if it has not fired.
 */
export function captureNextButton(fn) {
  captureNext = typeof fn === 'function' ? fn : null;
  return () => { if (captureNext === fn) captureNext = null; };
}

/**
 * Passes a raw input to every raw listener; a listener that throws is logged and skipped.
 * @param {object} info The raw input info.
 */
function emitRaw(info) {
  rawListeners.forEach((fn) => { try { fn(info); } catch (e) { console.warn('[tv-input] raw listener failed', e); } });
}

// Back leaves straight away instead of asking (docs/design/01 §12), per device.
const BACK_EXITS_KEY = 'reruntv.backExitsImmediately';
/**
 * Reads whether Back on live TV leaves without asking, on this device.
 * @returns {boolean} True when set.
 */
export function backExitsImmediately() {
  try { return window.localStorage.getItem(BACK_EXITS_KEY) === '1'; } catch (e) { return false; }
}
/**
 * Saves whether Back on live TV leaves without asking, on this device.
 * @param {boolean} on True to leave without asking.
 */
export function setBackExitsImmediately(on) {
  try {
    if (on) window.localStorage.setItem(BACK_EXITS_KEY, '1');
    else window.localStorage.removeItem(BACK_EXITS_KEY);
  } catch (e) { /* storage unavailable */ }
}

// ---------- Context ----------

/**
 * Tests whether a text input, text area or editable element has focus.
 * @returns {boolean} True when one does.
 */
function textFieldFocused() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/**
 * 'none' means TV routing stands aside and the keyboard handler decides (setup
 * screen, standby wake, PIN entry, a plugin's own modal).
 * @returns {string} The routing context: `dialog`, `text`, `menu`, `details`, `guide`, `banner`, `timeMachine`, `plugin`, `watching` or `none`.
 */
export function currentContext() {
  if (exitPromptOpen() || openModal()) {
    // A text field inside a dialog keeps digits, ".", Backspace and arrows (Back
    // still leaves the field first, then cancels the dialog).
    const modal = openModal();
    const el = document.activeElement;
    const root = modal && (typeof modal.element === 'function' ? modal.element() : modal.element);
    if (!exitPromptOpen() && modal && textFieldFocused() && (!root || root.contains(el))) return 'text';
    return 'dialog';
  }
  if (!tvScreen || tvScreen.classList.contains('hidden')) return 'none';
  if (!S.isPoweredOn || S.pinLockActive) return 'none';
  if (pluginChannelContainerEl && pluginChannelContainerEl.querySelector('.preview-modal:not(.hidden)')) return 'none';
  if (!shortcutsOverlayEl.classList.contains('hidden')) return 'menu';
  if (textFieldFocused()) return 'text';
  if (!detailsOverlayEl.classList.contains('hidden')) return 'details';
  if (!guideGrid.classList.contains('hidden')) return 'guide';
  if (bannerHubOpen()) return 'banner';
  if (S.timeMachineOn) return 'timeMachine';
  // A plugin channel owns its own arrows and OK (ctx onKey/onOk); TV mode only
  // adds the ways out of it.
  if (isVirtualChannel(S.currentNumber)) return 'plugin';
  return 'watching';
}

// Plugin channels: channel rocker, menu and the long-press menu work; every
// other key goes to the plugin exactly as it does on a keyboard.
const PLUGIN_ACTIONS = {
  chUp: 'key:ArrowUp', chDown: 'key:ArrowDown', menu: 'menu.toggle', playPause: 'menu.toggle', settings: 'menu.toggle',
  guide: 'guide.open', 'long:ok': 'menu.open', back: 'exit.prompt',
};

// When the plugin doesn't take an action, core does what it would have:
// ▲▼ change channel, ◀▶/OK reach the plugin's onKey, Back asks to leave.
const PLUGIN_ACTION_FALLBACK = {
  'move.up': 'key:ArrowUp', 'move.down': 'key:ArrowDown', 'move.left': 'key:ArrowLeft', 'move.right': 'key:ArrowRight',
  select: 'key:Enter', back: 'exit.prompt', info: 'info.show',
  // Play/pause opened the menu on a plugin channel before plugins could take
  // it, so a plugin that declines keeps that.
  'media.playPause': 'menu.toggle',
};

/**
 * Maps a remote key to an action for a context. Plugin channels get their own table and may take actions first.
 * @param {string} context The routing context from `currentContext`.
 * @param {string} remoteKey The RemoteKey name.
 * @param {boolean} longPressed True for a long press.
 * @returns {?string} The action name, or null when the key does nothing there.
 */
function route(context, remoteKey, longPressed) {
  if (context === 'plugin') {
    if (longPressed && PLUGIN_ACTIONS[`long:${remoteKey}`]) return PLUGIN_ACTIONS[`long:${remoteKey}`];
    const action = !longPressed && pluginActionFor(remoteKey);
    if (action && virtualChannelHandlesActions(S.currentNumber)) return `plugin.action:${action}`;
    return PLUGIN_ACTIONS[remoteKey] || null;
  }
  return routeRemoteKey(context, remoteKey, { longPress: longPressed, buttons: S.config && S.config.remote && S.config.remote.buttons });
}

/**
 * Tests whether a key has a long-press action in a context, so its press must wait for the hold.
 * @param {string} context The routing context.
 * @param {string} remoteKey The RemoteKey name.
 * @returns {boolean} True when it has one.
 */
function longPressable(context, remoteKey) {
  if (context === 'plugin') return !!PLUGIN_ACTIONS[`long:${remoteKey}`];
  return hasLongPress(context, remoteKey);
}

// ---------- Actions ----------

/**
 * Hands a key to the keyboard handler as a minimal keydown-shaped event.
 * @param {string} key The `KeyboardEvent.key` value.
 * @param {?object} source The originating event, for `repeat` and `preventDefault`.
 */
function sendKey(key, source) {
  if (!keyboardHandler) return;
  keyboardHandler({
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: !!(source && source.repeat),
    preventDefault() { if (source && source.preventDefault) source.preventDefault(); },
  });
}

/**
 * Moves the guide selection by about a screenful of rows.
 * @param {number} direction 1 to page down, -1 to page up.
 */
function pageGuide(direction) {
  const rows = guideRowsEl ? Array.from(guideRowsEl.children).filter((el) => el.classList.contains('guide-row')) : [];
  const total = rows.length;
  if (!total) return;
  // A screenful less the margin row, so the row paged to lands on screen.
  const perScreen = Math.floor((guideRowsEl.clientHeight || 0) / Math.max(1, rows[0].offsetHeight || 1)) || 6;
  const step = Math.max(1, Math.min(total - 1, perScreen - 1));
  pageGuideSelection(direction, step);
}

/**
 * Lists the TV menu's buttons.
 * @returns {HTMLElement[]} The `.tv-menu-btn` elements.
 */
function menuButtons() {
  return Array.from(shortcutsOverlayEl.querySelectorAll('.tv-menu-btn'));
}

const ACTIONS = {
  // A remote button set to DO NOTHING (SYSTEM › REMOTE & KEYS).
  none: () => {},
  'guide.open': () => openGuideGrid(),
  'banner.show': () => showGuideOverlay(S.currentNumber, getChannel(S.currentNumber)),
  'banner.open': () => openBannerHub(),
  'banner.key.left': () => bannerKey('left'),
  'banner.key.right': () => bannerKey('right'),
  'banner.key.up': () => bannerKey('up'),
  'banner.key.down': () => bannerKey('down'),
  'banner.key.ok': () => bannerKey('ok'),
  'banner.key.back': () => bannerKey('back'),
  'info.show': () => showDetailsForCurrentChannel(),
  'menu.open': () => openTvMenu(),
  'menu.toggle': () => (shortcutsOverlayEl.classList.contains('hidden') ? openTvMenu() : closeTvMenu()),
  'menu.again': (source) => runAction(currentUiMode() === CABLE_GUIDE_UI ? 'key:?' : 'key:Escape', source),
  'menu.first': () => { const b = menuButtons(); if (b[0]) b[0].focus(); },
  'menu.last': () => { const b = menuButtons(); if (b.length) b[b.length - 1].focus(); },
  'timeMachine.open': () => { if (!S.timeMachineOn) enterTimeMachine(); },
  'guide.pageUp': () => pageGuide(-1),
  'guide.pageDown': () => pageGuide(1),
  'guide.programActions': () => openGuideProgramActions(),
  'scrub.back': (source) => scrubStep(-1, { repeat: !!(source && source.repeat) }),
  'scrub.forward': (source) => scrubStep(1, { repeat: !!(source && source.repeat) }),
  'scrub.prevProgram': () => scrubProgramBoundary(-1),
  'scrub.nextProgram': () => scrubProgramBoundary(1),
  'guide.dayBack': () => shiftGuideDay(-1),
  'guide.dayForward': () => shiftGuideDay(1),
  'guide.filter': () => focusGuideSearch(),
  'guide.reminders': () => openGuideReminders(),
  'exit.prompt': () => showExitPrompt(),
  'focus.prev': () => moveDialogFocus(-1),
  'focus.next': () => moveDialogFocus(1),
  // Spatial first; a layout with nothing that way falls back to list order.
  'focus.up': () => moveFocusSpatially(activeDialogEl(), 'up') || moveDialogFocus(-1),
  'focus.down': () => moveFocusSpatially(activeDialogEl(), 'down') || moveDialogFocus(1),
  'focus.left': () => arrowsToControl('ArrowLeft') || moveFocusSpatially(activeDialogEl(), 'left') || moveDialogFocus(-1),
  'focus.right': () => arrowsToControl('ArrowRight') || moveFocusSpatially(activeDialogEl(), 'right') || moveDialogFocus(1),
  'focus.activate': () => { const el = document.activeElement; const dialog = activeDialogEl(); if (dialog && dialog.contains(el) && el.click) el.click(); },
  'dialog.cancel': () => {
    const modal = !exitPromptOpen() && openModal();
    if (modal) modal.cancel();
    else hideExitPrompt();
  },
};

// Held-key rates (docs/design/01 §5.3): channel changes stay deliberate,
// focus movement speeds up after 400 ms so a long list isn't a chore, and
// volume repeats at 8 Hz.
const FOCUS_ACCELERATE_AFTER_MS = 400;
const VOLUME_REPEAT_MS = 125;
let holdStartedAt = new Map();
let lastVolumeKeyAt = 0;

/**
 * Runs a routed action: a `key:` action goes to the keyboard handler with held-key rate limits, a `plugin.action:` goes to the plugin channel with a core fallback, anything else runs from `ACTIONS`.
 * @param {?string} action The action name.
 * @param {?object} source The originating event, for `repeat`.
 * @returns {boolean} True when the action was run.
 */
function runAction(action, source) {
  if (!action) return false;
  if (action.startsWith('key:')) {
    const key = action.slice(4);
    const context = currentContext();
    const now = performance.now();
    if ((key === 'ArrowUp' || key === 'ArrowDown') && (context === 'watching' || context === 'plugin' || context === 'banner')) {
      if (source && source.repeat && now - lastChannelKeyAt < CHANNEL_REPEAT_MS) return true;
      lastChannelKeyAt = now;
    }
    if (key === '+' || key === '-') {
      if (source && source.repeat && now - lastVolumeKeyAt < VOLUME_REPEAT_MS) return true;
      lastVolumeKeyAt = now;
    }
    // Focus movement in a list: a held key repeats faster once it has been
    // down a moment, by sending a second step per repeat.
    const focusMove = (key === 'ArrowUp' || key === 'ArrowDown') && (context === 'guide' || context === 'menu' || context === 'dialog');
    if (focusMove) {
      if (!source || !source.repeat) holdStartedAt.set(key, now);
      else if (now - (holdStartedAt.get(key) || now) > FOCUS_ACCELERATE_AFTER_MS) sendKey(key, source);
    } else if (!source || !source.repeat) {
      holdStartedAt.delete(key);
    }
    sendKey(key, source);
    return true;
  }
  if (action.startsWith('plugin.action:')) {
    const name = action.slice('plugin.action:'.length);
    if (triggerVirtualChannelAction(S.currentNumber, name)) return true;
    return runAction(PLUGIN_ACTION_FALLBACK[name], source);
  }
  const fn = ACTIONS[action];
  if (!fn) return false;
  fn(source);
  return true;
}

// ---------- Keyboard-shaped events ----------

/**
 * From app.js's keydown listener. true = handled here; the keyboard handler
 * must not see this event.
 * @param {KeyboardEvent} event The keydown event.
 * @returns {boolean} True when handled here.
 */
export function routeKeydown(event) {
  const raw = { source: 'keyboard', key: event.key, keyCode: event.keyCode, code: event.code, repeat: !!event.repeat, action: 'down' };
  const captured = tapRawInput(raw, normalizeKey(event));
  if (captured) { if (event.preventDefault) event.preventDefault(); return true; }
  if (!isTvMode()) return false;
  const remoteKey = resolveRemoteKey(raw, normalizeKey(event));
  if (!remoteKey) return false;
  noteRemoteKey(remoteKey);
  const context = currentContext();
  if (context === 'none') return false;
  // The exit prompt is modal: keys it doesn't use must not reach live TV behind it.
  if (context === 'dialog' && !route(context, remoteKey, false)) {
    // The parental-lock keypad is a modal, but its digits and Backspace belong
    // to the keyboard handler's PIN entry.
    if (S.pinLockActive && !exitPromptOpen()) return false;
    event.preventDefault();
    return true;
  }

  if (longPressable(context, remoteKey)) {
    // A synthetic event (the legacy Android bridge, touch controls) never
    // gets a keyup, so it can't be held: it acts as a short press now.
    if (!event.isTrusted) return runShort(context, remoteKey, event);
    event.preventDefault();
    if (event.repeat || longPress.isDown(remoteKey)) return true;
    beginHold(remoteKey);
    return true;
  }

  return runShort(context, remoteKey, event);
}

/**
 * Starts timing a key that has a long-press action: the long action fires once it has been down 500 ms, and `endHold` runs the short one if it comes up sooner.
 * @param {string} remoteKey The RemoteKey name.
 */
function beginHold(remoteKey) {
  longPress.press(remoteKey, performance.now());
  clearTimeout(holdTimers.get(remoteKey));
  holdTimers.set(remoteKey, setTimeout(() => {
    holdTimers.delete(remoteKey);
    if (longPress.hold(remoteKey, performance.now())) runAction(route(currentContext(), remoteKey, true), null);
  }, 500));
}

/**
 * Finishes a key `beginHold` is timing: runs the short action, or a long action that fired late.
 * @param {string} remoteKey The RemoteKey name.
 * @returns {boolean} True when the key was being timed.
 */
function endHold(remoteKey) {
  if (!longPress.isDown(remoteKey)) return false;
  clearTimeout(holdTimers.get(remoteKey));
  holdTimers.delete(remoteKey);
  const result = longPress.release(remoteKey, performance.now());
  if (result === 'short') runShort(currentContext(), remoteKey, null);
  else if (result === 'long-late') runAction(route(currentContext(), remoteKey, true), null);
  return true;
}

/**
 * Runs the short-press action for a key.
 * @param {string} context The routing context.
 * @param {string} remoteKey The RemoteKey name.
 * @param {?object} event The originating event, if any.
 * @returns {boolean} True when an action ran.
 */
function runShort(context, remoteKey, event) {
  const action = route(context, remoteKey, false);
  if (!action) return false;
  if (event && event.preventDefault && !action.startsWith('key:')) event.preventDefault();
  return runAction(action, event);
}

/**
 * A tap for the Remote test screen and learn mode. Returns true when the
 * event was consumed by one of them and must not be routed.
 * @param {object} raw The raw input info.
 * @param {?string} remoteKey The RemoteKey it maps to, if any.
 * @returns {boolean} True when consumed.
 */
function tapRawInput(raw, remoteKey) {
  const rawId = rawKeyId(raw);
  const info = { ...raw, rawId, remoteKey: remoteKey || null, at: Date.now() };
  if (rawListeners.size) emitRaw(info);
  if (captureNext && raw.action === 'down' && !raw.repeat) {
    const fn = captureNext;
    captureNext = null;
    try { fn(info); } catch (e) { console.warn('[tv-input] capture failed', e); }
    return true;
  }
  if (inputSink) {
    try { inputSink(info); } catch (e) { console.warn('[tv-input] input sink failed', e); }
    return true;
  }
  return false;
}

/**
 * Learn-mode overrides win over the automatic mapping.
 * @param {object} raw The raw input info.
 * @param {?string} fallback The automatic RemoteKey.
 * @returns {?string} The RemoteKey to use.
 */
function resolveRemoteKey(raw, fallback) {
  return profile.overrideFor(rawKeyId(raw)) || fallback;
}

/**
 * Finishes a long-press key on keyup: runs the short action, or a long action that fired late. TV mode only.
 * @param {KeyboardEvent} event The keyup event.
 * @returns {boolean} True when handled here.
 */
export function routeKeyup(event) {
  if (!isTvMode()) return false;
  const remoteKey = resolveRemoteKey({ source: 'keyboard', key: event.key, keyCode: event.keyCode, code: event.code }, normalizeKey(event));
  if (!remoteKey || !endHold(remoteKey)) return false;
  event.preventDefault();
  return true;
}

// ---------- Native bridge (Android TV client) ----------
/**
 * The Android client posts RemoteKey names here instead of synthesizing
 * letters, once it sees `version` (android-tv-client MainActivity). It returns
 * what happened so the client can fall back: 'handled', 'ignored', or 'exit'
 * (only after the person chose EXIT in the prompt).
 * @param {?object} evt The posted event: raw Android fields (`source`, `keyCode`, `scanCode`, `repeat`, `longPress`, `holdMs`, `action`) or a RemoteKey `key`.
 * @returns {string} `handled` or `ignored`.
 */
function nativeInput(evt) {
  if (!evt) return 'ignored';
  // Version 2 clients post raw Android KeyEvent codes and let this side
  // normalize (docs/design/01 §5.1); a RemoteKey name is still accepted, which
  // is what the phone remote and the touch controls send.
  const raw = {
    source: evt.source || (evt.keyCode != null ? 'android' : 'bridge'),
    key: typeof evt.key === 'string' ? evt.key : null,
    keyCode: evt.keyCode != null ? Number(evt.keyCode) : null,
    scanCode: evt.scanCode != null ? Number(evt.scanCode) : null,
    repeat: !!evt.repeat,
    longPress: !!evt.longPress,
    holdMs: Number.isFinite(evt.holdMs) ? evt.holdMs : null,
    action: evt.action === 'up' ? 'up' : 'down',
  };
  const automatic = raw.keyCode != null && raw.source === 'android'
    ? normalizeAndroidKeyCode(raw.keyCode)
    : (typeof evt.key === 'string' ? evt.key : null);
  const captured = tapRawInput(raw, automatic);
  if (captured) return 'handled';
  const remoteKey = resolveRemoteKey(raw, automatic);
  if (!remoteKey) return 'ignored';
  if (raw.action === 'up') return 'ignored';
  return pressRemoteKey(remoteKey, { repeat: raw.repeat, longPress: raw.longPress });
}

/**
 * Acts on one press of a RemoteKey from a source that isn't the keyboard: routes it by what is on screen, or hands it to the keyboard handler where no context claims it.
 * @param {string} remoteKey The RemoteKey name.
 * @param {object} [press={}] Press details.
 * @param {boolean} [press.repeat=false] True for an auto-repeat of a held button.
 * @param {boolean} [press.longPress=false] True when the source already timed this as a long press.
 * @returns {string} `handled` or `ignored`.
 */
function pressRemoteKey(remoteKey, { repeat = false, longPress: held = false } = {}) {
  const evt = { repeat, longPress: held };
  noteRemoteKey(remoteKey);
  // Back on the setup screen: close a dialog if one is open, otherwise go
  // back to live TV — setup is a desk task (doc 01 §6.4), not a place to be
  // stranded with a remote.
  if (remoteKey === 'back' && tvScreen && tvScreen.classList.contains('hidden') && !exitPromptOpen()) {
    const modal = openModal();
    if (modal) {
      modal.cancel();
    } else {
      window.dispatchEvent(new CustomEvent('reruntv:watch-tv'));
    }
    return 'handled';
  }
  const context = currentContext();
  if (context === 'none') {
    const legacy = LEGACY_KEYS[remoteKey];
    if (legacy && keyboardHandler) sendKey(legacy, null);
    return legacy ? 'handled' : 'ignored';
  }
  const action = route(context, remoteKey, !!evt.longPress) || (evt.longPress ? route(context, remoteKey, false) : null);
  if (!action) {
    const legacy = LEGACY_KEYS[remoteKey];
    if (legacy && keyboardHandler) { sendKey(legacy, { repeat: !!evt.repeat }); return 'handled'; }
    return 'ignored';
  }
  runAction(action, { repeat: !!evt.repeat });
  return 'handled';
}

// ---------- Game controllers ----------
// In desktop mode a controller still works (docs/design/01 §8
// "remote-in-desktop"), as the keys the keyboard handler already knows.
const GAMEPAD_DESKTOP_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape',
  info: 'i', guide: 'g', chUp: 'PageUp', chDown: 'PageDown', menu: '?', last: 'Backspace',
  volUp: '+', volDown: '-', mute: 'm', record: 'r', captions: 'k', audioTrack: 'u',
};

/**
 * The keyboard key a controller button stands for in desktop mode. The triggers open the time machine, then shuttle once it is open, as they do in TV mode.
 * @param {string} remoteKey The RemoteKey name.
 * @returns {?string} The `KeyboardEvent.key` value, or null.
 */
function gamepadDesktopKey(remoteKey) {
  if (remoteKey === 'rewind' || remoteKey === 'fastForward') {
    if (!S.timeMachineOn) return 't';
    return remoteKey === 'rewind' ? 'ArrowLeft' : 'ArrowRight';
  }
  return GAMEPAD_DESKTOP_KEYS[remoteKey] || null;
}

/**
 * Sends a key through the window's keydown listeners as the default key, whatever the keyboard is remapped to, so the setup screen's own keyboard navigation sees it too.
 * @param {string} key The `KeyboardEvent.key` value.
 * @param {boolean} repeat True for an auto-repeat.
 */
function dispatchDefaultKey(key, repeat) {
  window.__remoteKeyDispatch = true;
  try { window.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true })); } finally { window.__remoteKeyDispatch = false; }
}

// ---------- A controller on text boxes and the setup screen ----------
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'password', 'number', 'url', 'email', 'tel', '']);

/**
 * Tests whether an element is a text box the on-screen keyboard can fill in.
 * @param {?Element} el The element.
 * @returns {boolean} True for an editable text input or text area.
 */
function isTextBox(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(String(el.getAttribute('type') || '').toLowerCase());
}

/**
 * A title for the keyboard from the text box's label, accessible name or placeholder.
 * @param {HTMLElement} el The text box.
 * @returns {string} The title, upper-cased.
 */
function textBoxTitle(el) {
  const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
  const text = (label && label.textContent) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || 'Enter text';
  return text.replace(/\s+/g, ' ').replace(/[….:]+$/g, '').trim().toUpperCase().slice(0, 60);
}

/**
 * Opens the on-screen keyboard for a text box and writes the result back as if it had been typed. Does nothing when the element isn't a text box, the setting is off or a dialog is already up.
 * @param {?Element} el The focused element.
 * @returns {boolean} True when the keyboard was opened.
 */
function editWithKeyboard(el) {
  if (!isTextBox(el) || !gamepadSettings(S.config).keyboard || openModal() || exitPromptOpen()) return false;
  import('../ui/on-screen-keyboard.js').then(async ({ openOnScreenKeyboard }) => {
    const text = await openOnScreenKeyboard({
      title: textBoxTitle(el), value: el.value, maxLength: el.maxLength > 0 ? el.maxLength : 120, mixedCase: true, mask: el.type === 'password',
    });
    if (!el.isConnected) return;
    if (text != null && text !== el.value) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (el.isConnected) el.focus({ preventScroll: true });
  }).catch((e) => console.warn('[tv-input] on-screen keyboard failed', e));
  return true;
}

/**
 * Steps a list or slider one place, as its own arrow keys would, and reports the change.
 * @param {HTMLElement} el The focused control.
 * @param {number} direction 1 for the next value, -1 for the previous.
 * @param {boolean} wrap Whether a list goes round from its last choice to its first.
 * @returns {boolean} True when `el` was a list or slider.
 */
function stepControl(el, direction, wrap) {
  const changed = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (el.tagName === 'SELECT') {
    const options = Array.from(el.options);
    let i = el.selectedIndex;
    for (let n = 0; n < options.length; n += 1) {
      i += direction;
      if (wrap) i = (i + options.length) % options.length;
      if (i < 0 || i >= options.length) return true;
      if (!options[i].disabled) break;
    }
    if (i !== el.selectedIndex) { el.selectedIndex = i; changed(); }
    return true;
  }
  if (el.tagName === 'INPUT' && el.type === 'range') {
    const step = Number(el.step) || 1;
    const next = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + direction * step));
    if (String(next) !== el.value) { el.value = String(next); changed(); }
    return true;
  }
  return false;
}

const SETUP_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

/**
 * A controller on the setup screen, which is otherwise a keyboard-and-mouse place: the D-pad or stick moves between its controls by position, ◀▶ change a list or slider, and A presses the focused control. Other buttons (B, the shortcuts) keep what they did.
 * @param {string} remoteKey The RemoteKey name.
 * @returns {boolean} True when the press was used here.
 */
function gamepadOnSetup(remoteKey) {
  if (!setupScreen || setupScreen.classList.contains('hidden') || openModal() || exitPromptOpen()) return false;
  const direction = SETUP_DIRECTIONS.has(remoteKey) ? remoteKey : null;
  if (!direction && remoteKey !== 'ok') return false;
  // Shows where focus is, which the page only does by itself after a key press.
  document.documentElement.classList.add('gamepad-nav');
  const el = document.activeElement;
  const inSetup = !!el && el !== document.body && setupScreen.contains(el);
  if (direction) {
    if (inSetup && (direction === 'left' || direction === 'right') && stepControl(el, direction === 'right' ? 1 : -1, false)) return true;
    if (!inSetup && el && el.blur) el.blur();
    moveFocusSpatially(setupScreen, direction);
    return true;
  }
  if (!inSetup) { moveFocusSpatially(setupScreen, 'down'); return true; }
  if (stepControl(el, 1, true)) return true;
  if (el.click) el.click();
  return true;
}

/**
 * One control event from a game controller (tv/gamepad.js): a press, a repeat while held, or a release.
 *
 * The Remote test and learn mode see it first, as `gamepad:<control>`. A control assigned to a keyboard shortcut (`action:<id>`) sends that shortcut's default key. Otherwise it is a remote button: routed by what is on screen in TV mode, with hold-for-long-press, and turned into the keyboard's keys in desktop mode.
 * @param {?object} evt The event: `{ key, button, repeat, release }`, where `key` is a RemoteKey, `action:<id>` or null.
 * @returns {string} `handled` or `ignored`.
 */
export function gamepadInput(evt) {
  if (!evt) return 'ignored';
  const target = typeof evt.key === 'string' ? evt.key : null;
  const shortcut = target && target.startsWith('action:') ? KEY_ACTIONS.find((action) => action.id === target.slice(7)) : null;
  const automatic = target && !target.startsWith('action:') ? target : null;
  const raw = {
    source: 'gamepad', button: evt.button, key: automatic, keyCode: null, scanCode: null,
    repeat: !!evt.repeat, longPress: false, holdMs: null, action: evt.release ? 'up' : 'down',
  };
  if (tapRawInput(raw, automatic)) return 'handled';
  // A learn-mode override for this button wins over its assignment.
  const override = profile.overrideFor(rawKeyId(raw));
  const remoteKey = override || automatic;
  if (raw.action === 'up') return remoteKey && endHold(remoteKey) ? 'handled' : 'ignored';

  if (!remoteKey) {
    // Shortcuts belong to live TV: not behind a dialog, and never twice from one press.
    if (!shortcut || raw.repeat || !keyboardHandler || exitPromptOpen() || openModal()) return 'ignored';
    sendKey(shortcut.key, null);
    return 'handled';
  }

  // A press on a text box opens the on-screen keyboard for it, wherever it is.
  if (remoteKey === 'ok' && !raw.repeat && editWithKeyboard(document.activeElement)) return 'handled';
  // The setup screen: the D-pad moves between its controls and A presses them.
  if (gamepadOnSetup(remoteKey)) return 'handled';

  if (!isTvMode()) {
    // A dialog on top (a confirm, the on-screen keyboard) takes the D-pad, A
    // and B the way it does in TV mode.
    if (exitPromptOpen() || openModal()) return pressRemoteKey(remoteKey, { repeat: raw.repeat });
    const key = gamepadDesktopKey(remoteKey);
    if (!key) return 'ignored';
    dispatchDefaultKey(key, raw.repeat);
    return 'handled';
  }

  if (longPress.isDown(remoteKey)) return 'handled'; // being timed: repeats wait for the release
  if (!raw.repeat) {
    const context = currentContext();
    if (context !== 'none' && longPressable(context, remoteKey)) {
      noteRemoteKey(remoteKey);
      beginHold(remoteKey);
      return 'handled';
    }
  }
  return pressRemoteKey(remoteKey, { repeat: raw.repeat });
}

/**
 * Every delivered button is recorded for this device and marks the page, which
 * un-hides hints for it ([data-hint-requires], guide.css/overlays.css). A hint
 * for a button this remote has never sent stays hidden (docs/design/01 §5.2).
 * @param {string} remoteKey The RemoteKey name.
 */
function noteRemoteKey(remoteKey) {
  profile.note(remoteKey);
  markRemoteKey(remoteKey);
}

/**
 * Marks the page as having a remote key (and its optional group), un-hiding the hints that need it.
 * @param {string} remoteKey The RemoteKey name.
 */
function markRemoteKey(remoteKey) {
  const root = document.documentElement;
  root.classList.add(`remote-has-${remoteKey}`);
  const group = optionalGroupOf(remoteKey);
  if (group) root.classList.add(`remote-has-${group}`);
  [remoteKey, group].filter(Boolean).forEach((name) => {
    document.querySelectorAll(`[data-hint-requires="${name}"]`).forEach((el) => el.classList.add('hint-available'));
  });
}

/**
 * Marks every key this device's remote has sent before.
 */
function applyKnownRemoteKeys() {
  profile.seenKeys().forEach(markRemoteKey);
}

// Keys a context doesn't route still reach the keyboard handler in the shape
// it knows (digits during PIN entry, arrows on the setup screen).
const LEGACY_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape',
  chUp: 'ArrowUp', chDown: 'ArrowDown', last: 'Backspace',
  digit0: '0', digit1: '1', digit2: '2', digit3: '3', digit4: '4', digit5: '5', digit6: '6', digit7: '7', digit8: '8', digit9: '9',
};

// ---------- Exit prompt ----------
// Back owns leaving (doc 01 §5.3): from bare live TV it asks, so leaving is
// always possible and never accidental. EXIT appears only where this client
// can actually close itself.
let exitPromptEl = null;
let exitPromptReturnFocus = null;

/**
 * Finds how this client can close itself.
 * @returns {?Function} A function that exits, or null when it cannot.
 */
function exitCapability() {
  if (window.AndroidRemoteBridge && typeof window.AndroidRemoteBridge.exitApp === 'function') {
    return () => window.AndroidRemoteBridge.exitApp();
  }
  if (window.api && typeof window.api.quitApp === 'function' && !window.__isViewer) return () => window.api.quitApp();
  return null;
}

/**
 * Tests whether the exit prompt is showing.
 * @returns {boolean} True when it is.
 */
export function exitPromptOpen() {
  return !!exitPromptEl && !exitPromptEl.classList.contains('hidden');
}

/**
 * Builds the exit prompt's element and registers it as an overlay surface.
 * @returns {HTMLElement} The prompt element, hidden.
 */
function buildExitPrompt() {
  const el = document.createElement('div');
  el.id = 'tv-exit-prompt';
  el.className = 'tv-exit-prompt hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'tv-exit-prompt-title');
  el.innerHTML = `
    <div class="tv-exit-prompt-panel">
      <div class="tv-exit-prompt-title" id="tv-exit-prompt-title">LEAVE RERUNTV?</div>
      <div class="tv-exit-prompt-actions"></div>
      <div class="tv-exit-prompt-hint">BACK TO KEEP WATCHING</div>
    </div>`;
  (tvScreen.querySelector('.crt') || tvScreen).appendChild(el);
  registerOverlaySurface('exit', el);
  return el;
}

/**
 * Shows the exit prompt with KEEP WATCHING focused, STANDBY and, where possible, EXIT. With "Back exits immediately" on, leaves or goes to standby without asking.
 */
export function showExitPrompt() {
  // "Back exits immediately" (TV menu › Remote): leave without asking, or
  // drop to standby where this client can't close itself.
  if (backExitsImmediately()) {
    const exit = exitCapability();
    if (exit) exit(); else powerOff();
    return;
  }
  if (!exitPromptEl) exitPromptEl = buildExitPrompt();
  const actions = exitPromptEl.querySelector('.tv-exit-prompt-actions');
  actions.innerHTML = '';
  const add = (label, run, className = '') => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tv-menu-btn ${className}`.trim();
    btn.dataset.slot = 'tv-menu-button';
    btn.textContent = label;
    btn.addEventListener('click', () => { hideExitPrompt(); run(); });
    actions.appendChild(btn);
    return btn;
  };
  const keep = add('KEEP WATCHING', () => {});
  add('STANDBY', () => powerOff());
  const exit = exitCapability();
  if (exit) add('EXIT', exit, 'tv-exit-prompt-exit');
  exitPromptReturnFocus = document.activeElement;
  exitPromptEl.classList.remove('hidden');
  keep.focus(); // the safe choice is the default, never EXIT
}

/**
 * Hides the exit prompt and gives focus back to where it was.
 */
export function hideExitPrompt() {
  if (!exitPromptEl) return;
  exitPromptEl.classList.add('hidden');
  if (exitPromptReturnFocus && exitPromptReturnFocus.isConnected && exitPromptReturnFocus.focus) {
    exitPromptReturnFocus.focus({ preventScroll: true });
  } else if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  exitPromptReturnFocus = null;
}

/**
 * The modal currently on screen: the exit prompt, or learn mode's list.
 * @returns {?HTMLElement} The dialog's root element, or null.
 */
function activeDialogEl() {
  if (exitPromptOpen()) return exitPromptEl;
  const modal = openModal();
  return modal ? modal.element() : null;
}

/**
 * A focused kit control that uses ◀▶ itself (data-ui-arrows="horizontal":
 * Slider, Segmented, NumberStepper) gets the key instead of losing focus.
 * @param {string} key `ArrowLeft` or `ArrowRight`.
 * @returns {boolean} True when a control took the key.
 */
function arrowsToControl(key) {
  const el = document.activeElement;
  const dialog = activeDialogEl();
  if (!el || !dialog || !dialog.contains(el) || !el.closest('[data-ui-arrows="horizontal"]')) return false;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  if (el.type === 'range') {
    const step = Number(el.step) || 1;
    const next = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + (key === 'ArrowRight' ? step : -step)));
    if (String(next) !== el.value) {
      el.value = String(next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return true;
}

/**
 * Moves focus to the next or previous button in the active dialog, wrapping around.
 * @param {number} direction 1 for next, -1 for previous.
 */
function moveDialogFocus(direction) {
  const dialog = activeDialogEl();
  if (!dialog) return;
  const buttons = Array.from(dialog.querySelectorAll('button'));
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  const next = buttons[(index + direction + buttons.length) % buttons.length];
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

// ---------- Pointer ----------
// TV mode hides the cursor after 3 s without pointer movement; moving the
// pointer (an air mouse, LG's Magic Remote) brings it back.
let cursorTimer = null;
/**
 * Shows the cursor and, in TV mode, hides it again after 3 s without movement.
 */
function onPointerMove() {
  document.documentElement.classList.remove('cursor-idle');
  clearTimeout(cursorTimer);
  if (!isTvMode()) return;
  cursorTimer = setTimeout(() => document.documentElement.classList.add('cursor-idle'), 3000);
}

// ---------- Install ----------

/**
 * Installs TV-mode input: keyup and focus-loss handling, the idle cursor, CEC keys and the `window.RerunTVInput` bridge for the Android client.
 * @param {object} opts Options.
 * @param {Function} opts.handleKey The keyboard handler that `key:` actions are sent to.
 */
export function installTvInput({ handleKey }) {
  keyboardHandler = handleKey;
  window.addEventListener('keyup', routeKeyup);
  // A key held down when the window loses focus (or the tab is hidden) never delivers its
  // keyup, so the long-press tracker kept it "down" and the next real press was swallowed as a
  // repeat. Forget every in-flight hold whenever we stop being the foreground page.
  const forgetHolds = () => {
    longPress.reset();
    holdTimers.forEach((timer) => clearTimeout(timer));
    holdTimers.clear();
    holdStartedAt.clear();
  };
  window.addEventListener('blur', forgetHolds);
  document.addEventListener('visibilitychange', () => { if (document.hidden) forgetHolds(); });
  window.addEventListener('mousemove', onPointerMove, { passive: true });
  // The controller's focus outline on the setup screen goes once the mouse takes over.
  window.addEventListener('mousedown', () => document.documentElement.classList.remove('gamepad-nav'), true);
  onUsageModeChange((mode) => {
    longPress.reset();
    holdTimers.forEach((timer) => clearTimeout(timer));
    holdTimers.clear();
    if (mode !== 'tv') {
      hideExitPrompt();
      document.documentElement.classList.remove('cursor-idle');
    } else {
      onPointerMove();
    }
  });
  if (isTvMode()) onPointerMove();
  applyKnownRemoteKeys();
  // HDMI-CEC (--cec, main-cec.js): the TV's own remote, through HDMI.
  if (window.api && typeof window.api.onCecKey === 'function') {
    window.api.onCecKey((press) => { if (press && press.key) nativeInput({ source: 'cec', key: press.key, code: press.code }); });
  }
  window.RerunTVInput = Object.freeze({
    // 2: the client posts raw Android KeyEvent codes ({ source: 'android',
    // keyCode, action, repeatCount, longPress }) and this side normalizes.
    // 1 was RemoteKey names from the client's own Kotlin table.
    version: 2,
    native: (evt) => {
      try { return nativeInput(evt); } catch (e) { console.warn('[tv-input] native event failed', e); return 'ignored'; }
    },
    mode: () => (isTvMode() ? 'tv' : 'desktop'),
  });
}
