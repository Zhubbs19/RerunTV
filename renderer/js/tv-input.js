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
  detailsOverlayEl, guideGrid, guideRowsEl, pluginChannelContainerEl, shortcutsOverlayEl, tvScreen,
} from './dom.js';
import { getChannel } from './channels.js';
import { showDetailsForCurrentChannel } from './details.js';
import {
  openGuideGrid, openGuideProgramActions, pageGuideSelection, shiftGuideDay, showGuideOverlay,
} from './guide.js';
import { powerOff } from './power.js';
import {
  CHANNEL_REPEAT_MS, createLongPressTracker, hasLongPress, normalizeKey, optionalGroupOf, routeRemoteKey,
} from './remote-input.js';
import { S } from './state.js';
import { enterTimeMachine } from './timemachine.js';
import { closeTvMenu, openTvMenu } from './tv-menu.js';
import { isTvMode, onUsageModeChange } from './usage-mode.js';
import { isVirtualChannel } from './virtual.js';

let keyboardHandler = null;
const longPress = createLongPressTracker();
const holdTimers = new Map();
let lastChannelKeyAt = 0;

// ---------- Context ----------

function textFieldFocused() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// 'none' means TV routing stands aside and the keyboard handler decides (setup
// screen, standby wake, PIN entry, a plugin's own modal).
export function currentContext() {
  if (exitPromptOpen()) return 'dialog';
  if (!tvScreen || tvScreen.classList.contains('hidden')) return 'none';
  if (!S.isPoweredOn || S.pinLockActive) return 'none';
  if (pluginChannelContainerEl && pluginChannelContainerEl.querySelector('.preview-modal:not(.hidden)')) return 'none';
  if (!shortcutsOverlayEl.classList.contains('hidden')) return 'menu';
  if (textFieldFocused()) return 'text';
  if (!detailsOverlayEl.classList.contains('hidden')) return 'details';
  if (!guideGrid.classList.contains('hidden')) return 'guide';
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

function route(context, remoteKey, longPressed) {
  if (context === 'plugin') {
    if (longPressed && PLUGIN_ACTIONS[`long:${remoteKey}`]) return PLUGIN_ACTIONS[`long:${remoteKey}`];
    return PLUGIN_ACTIONS[remoteKey] || null;
  }
  return routeRemoteKey(context, remoteKey, { longPress: longPressed });
}

function longPressable(context, remoteKey) {
  if (context === 'plugin') return !!PLUGIN_ACTIONS[`long:${remoteKey}`];
  return hasLongPress(context, remoteKey);
}

// ---------- Actions ----------

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

function pageGuide(direction) {
  const rows = guideRowsEl ? Array.from(guideRowsEl.children).filter((el) => el.classList.contains('guide-row')) : [];
  const total = rows.length;
  if (!total) return;
  // A screenful less the margin row, so the row paged to lands on screen.
  const perScreen = Math.floor((guideRowsEl.clientHeight || 0) / Math.max(1, rows[0].offsetHeight || 1)) || 6;
  const step = Math.max(1, Math.min(total - 1, perScreen - 1));
  pageGuideSelection(direction, step);
}

function menuButtons() {
  return Array.from(shortcutsOverlayEl.querySelectorAll('.tv-menu-btn'));
}

const ACTIONS = {
  'guide.open': () => openGuideGrid(),
  'banner.show': () => showGuideOverlay(S.currentNumber, getChannel(S.currentNumber)),
  'info.show': () => showDetailsForCurrentChannel(),
  'menu.open': () => openTvMenu(),
  'menu.toggle': () => (shortcutsOverlayEl.classList.contains('hidden') ? openTvMenu() : closeTvMenu()),
  'menu.first': () => { const b = menuButtons(); if (b[0]) b[0].focus(); },
  'menu.last': () => { const b = menuButtons(); if (b.length) b[b.length - 1].focus(); },
  'timeMachine.open': () => { if (!S.timeMachineOn) enterTimeMachine(); },
  'guide.pageUp': () => pageGuide(-1),
  'guide.pageDown': () => pageGuide(1),
  'guide.programActions': () => openGuideProgramActions(),
  'guide.dayBack': () => shiftGuideDay(-1),
  'guide.dayForward': () => shiftGuideDay(1),
  'exit.prompt': () => showExitPrompt(),
  'focus.prev': () => moveDialogFocus(-1),
  'focus.next': () => moveDialogFocus(1),
  'focus.activate': () => { const el = document.activeElement; if (exitPromptEl && exitPromptEl.contains(el) && el.click) el.click(); },
  'dialog.cancel': () => hideExitPrompt(),
};

function runAction(action, source) {
  if (!action) return false;
  if (action.startsWith('key:')) {
    const key = action.slice(4);
    if ((key === 'ArrowUp' || key === 'ArrowDown') && (currentContext() === 'watching' || currentContext() === 'plugin')) {
      const now = performance.now();
      if (source && source.repeat && now - lastChannelKeyAt < CHANNEL_REPEAT_MS) return true;
      lastChannelKeyAt = now;
    }
    sendKey(key, source);
    return true;
  }
  const fn = ACTIONS[action];
  if (!fn) return false;
  fn();
  return true;
}

// ---------- Keyboard-shaped events ----------

// From app.js's keydown listener. true = handled here; the keyboard handler
// must not see this event.
export function routeKeydown(event) {
  if (!isTvMode()) return false;
  const remoteKey = normalizeKey(event);
  if (!remoteKey) return false;
  noteRemoteKey(remoteKey);
  const context = currentContext();
  if (context === 'none') return false;
  // The exit prompt is modal: keys it doesn't use must not reach live TV behind it.
  if (context === 'dialog' && !route(context, remoteKey, false)) { event.preventDefault(); return true; }

  if (longPressable(context, remoteKey)) {
    // A synthetic event (the legacy Android bridge, touch controls) never
    // gets a keyup, so it can't be held: it acts as a short press now.
    if (!event.isTrusted) return runShort(context, remoteKey, event);
    event.preventDefault();
    if (event.repeat || longPress.isDown(remoteKey)) return true;
    const at = performance.now();
    longPress.press(remoteKey, at);
    clearTimeout(holdTimers.get(remoteKey));
    holdTimers.set(remoteKey, setTimeout(() => {
      holdTimers.delete(remoteKey);
      if (longPress.hold(remoteKey, performance.now())) runAction(route(currentContext(), remoteKey, true), null);
    }, 500));
    return true;
  }

  return runShort(context, remoteKey, event);
}

function runShort(context, remoteKey, event) {
  const action = route(context, remoteKey, false);
  if (!action) return false;
  if (event && event.preventDefault && !action.startsWith('key:')) event.preventDefault();
  return runAction(action, event);
}

export function routeKeyup(event) {
  if (!isTvMode()) return false;
  const remoteKey = normalizeKey(event);
  if (!remoteKey || !longPress.isDown(remoteKey)) return false;
  clearTimeout(holdTimers.get(remoteKey));
  holdTimers.delete(remoteKey);
  const result = longPress.release(remoteKey, performance.now());
  if (result === 'short') runShort(currentContext(), remoteKey, null);
  else if (result === 'long-late') runAction(route(currentContext(), remoteKey, true), null);
  event.preventDefault();
  return true;
}

// ---------- Native bridge (Android TV client) ----------
// The Android client posts RemoteKey names here instead of synthesizing
// letters, once it sees `version` (android-tv-client MainActivity). It returns
// what happened so the client can fall back: 'handled', 'ignored', or 'exit'
// (only after the person chose EXIT in the prompt).
function nativeInput(evt) {
  const remoteKey = evt && typeof evt.key === 'string' ? evt.key : null;
  if (!remoteKey) return 'ignored';
  noteRemoteKey(remoteKey);
  // Back on the setup screen: close a dialog if one is open, otherwise go
  // back to live TV — setup is a desk task (doc 01 §6.4), not a place to be
  // stranded with a remote.
  if (remoteKey === 'back' && tvScreen && tvScreen.classList.contains('hidden') && !exitPromptOpen()) {
    if (document.querySelector('.confirm-dialog')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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

// A remote button only some remotes have (colour keys) marks this device as
// having it, which un-hides the hints for it (overlays.css/guide.css
// [data-hint-requires]). Per session, not stored: a different remote next time
// shouldn't inherit hints for buttons it lacks.
function noteRemoteKey(remoteKey) {
  const group = optionalGroupOf(remoteKey);
  if (group) document.documentElement.classList.add(`remote-has-${group}`);
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

function exitCapability() {
  if (window.AndroidRemoteBridge && typeof window.AndroidRemoteBridge.exitApp === 'function') {
    return () => window.AndroidRemoteBridge.exitApp();
  }
  if (window.api && typeof window.api.quitApp === 'function' && !window.__isViewer) return () => window.api.quitApp();
  return null;
}

export function exitPromptOpen() {
  return !!exitPromptEl && !exitPromptEl.classList.contains('hidden');
}

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
  return el;
}

export function showExitPrompt() {
  if (!exitPromptEl) exitPromptEl = buildExitPrompt();
  const actions = exitPromptEl.querySelector('.tv-exit-prompt-actions');
  actions.innerHTML = '';
  const add = (label, run, className = '') => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tv-menu-btn ${className}`.trim();
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

function moveDialogFocus(direction) {
  if (!exitPromptEl) return;
  const buttons = Array.from(exitPromptEl.querySelectorAll('button'));
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  buttons[(index + direction + buttons.length) % buttons.length].focus();
}

// ---------- Pointer ----------
// TV mode hides the cursor after 3 s without pointer movement; moving the
// pointer (an air mouse, LG's Magic Remote) brings it back.
let cursorTimer = null;
function onPointerMove() {
  document.documentElement.classList.remove('cursor-idle');
  clearTimeout(cursorTimer);
  if (!isTvMode()) return;
  cursorTimer = setTimeout(() => document.documentElement.classList.add('cursor-idle'), 3000);
}

// ---------- Install ----------

export function installTvInput({ handleKey }) {
  keyboardHandler = handleKey;
  window.addEventListener('keyup', routeKeyup);
  window.addEventListener('mousemove', onPointerMove, { passive: true });
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
  window.RerunTVInput = Object.freeze({
    version: 1,
    native: (evt) => {
      try { return nativeInput(evt); } catch (e) { console.warn('[tv-input] native event failed', e); return 'ignored'; }
    },
    mode: () => (isTvMode() ? 'tv' : 'desktop'),
  });
}
