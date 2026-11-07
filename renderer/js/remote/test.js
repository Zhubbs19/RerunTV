// Remote test and learn mode (docs/design/01 §5.2, §5.2a step B0).
//
// Remote test: every button press is shown as it arrives — which physical key
// it was, what it normalized to, and whether the page would have routed it —
// so the unknown rows of the reference remote's table get filled in from the
// real hardware instead of guessed. Finishing saves the capture on the host
// as `<userData>/remote-profiles/<name>-<when>.json`, the fixture the input
// matrix replays.
//
// Learn mode: "press the button you want for GUIDE" writes a per-device
// override for a button the automatic mapping gets wrong.
import { tvScreen } from '../core/dom.js';
import { captureNextButton, remoteProfile, setRemoteInputSink } from '../tv/input.js';
import { ModalSurface } from '../ui/dialog.js';

// The buttons a capture wants to see. Not every remote has them all — what's
// missing is exactly what the capture is for.
const WANTED = [
  'up', 'down', 'left', 'right', 'ok', 'back', 'chUp', 'chDown', 'playPause',
  'guide', 'info', 'menu', 'settings', 'last', 'exit',
  'digit0', 'digit1', 'digit2', 'digit3', 'digit4', 'digit5', 'digit6', 'digit7', 'digit8', 'digit9',
  'red', 'green', 'yellow', 'blue', 'rewind', 'fastForward', 'record', 'captions',
  'volUp', 'volDown', 'mute', 'power', 'search', 'home',
];

// Buttons a remote can be expected to have; learn mode offers these.
const ASSIGNABLE = [
  'guide', 'info', 'menu', 'back', 'ok', 'chUp', 'chDown', 'last', 'playPause',
  'rewind', 'fastForward', 'record', 'captions', 'red', 'green', 'yellow', 'blue', 'search', 'exit',
];

// What each button is called on screen: its legend on a remote, not the
// internal name ("chUp", "digit0").
const KEY_NAMES = {
  up: '▲', down: '▼', left: '◀', right: '▶', ok: 'OK', back: 'BACK', chUp: 'CH ▲', chDown: 'CH ▼',
  playPause: 'PLAY/PAUSE', guide: 'GUIDE', info: 'INFO', menu: 'MENU', settings: 'SETTINGS', last: 'LAST',
  exit: 'EXIT', red: 'RED', green: 'GREEN', yellow: 'YELLOW', blue: 'BLUE', rewind: 'REW', fastForward: 'FF',
  record: 'REC', captions: 'CC', volUp: 'VOL +', volDown: 'VOL −', mute: 'MUTE', power: 'POWER',
  search: 'SEARCH', home: 'HOME',
};

/**
 * How the remote test shows a button: its symbol or label, a digit's number, else the key in capitals.
 * @param {string} key The RemoteKey name.
 * @returns {string} The text shown.
 */
function keyName(key) {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  return /^digit\d$/.test(key) ? key.slice(5) : String(key).toUpperCase();
}

const MAX_SHOWN = 14;
const FINISH_PRESSES = 3;
const FINISH_WINDOW_MS = 2500;

let overlay = null;
let events = [];
let stopSink = null;
let backPresses = [];

/**
 * Creates an element with an optional class name and text.
 * @param {string} tag Tag name.
 * @param {string} [className] Class attribute.
 * @param {?string} [text] Text content.
 * @returns {HTMLElement} The new element.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Closes the remote test overlay, detaches the input sink and drops the capture.
 */
function close() {
  setRemoteInputSink(null);
  stopSink = null;
  if (overlay) { overlay.remove(); overlay = null; }
  events = [];
  backPresses = [];
}

/**
 * Whether the remote test overlay is showing.
 * @returns {boolean} True while it is open.
 */
export function remoteTestOpen() {
  return !!overlay;
}

/**
 * Formats one captured button press as a line for the event list.
 * @param {object} info The press as the remote input sink received it.
 * @returns {string} Source key, hold info and the key it mapped to.
 */
function describe(info) {
  const source = info.source === 'android' ? `android ${info.keyCode}` : (info.key || info.keyCode || info.source);
  const held = info.longPress ? ' · HELD' : (info.holdMs ? ` · ${Math.round(info.holdMs)}ms` : '');
  return `${source}${held}  →  ${info.remoteKey ? keyName(info.remoteKey) : 'not mapped'}`;
}

/**
 * Redraws the recent-press list, the wanted-buttons grid and the counter.
 */
function render() {
  if (!overlay) return;
  const list = overlay.querySelector('.remote-test-events');
  list.innerHTML = '';
  events.slice(-MAX_SHOWN).reverse().forEach((info) => {
    list.appendChild(el('div', `remote-test-event${info.remoteKey ? '' : ' unmapped'}`, describe(info)));
  });
  const grid = overlay.querySelector('.remote-test-grid');
  grid.innerHTML = '';
  const seen = new Set(events.map((e) => e.remoteKey).filter(Boolean));
  WANTED.forEach((key) => {
    grid.appendChild(el('span', `remote-test-key${seen.has(key) ? ' seen' : ''}`, keyName(key)));
  });
  overlay.querySelector('.remote-test-count').textContent = `${seen.size} of ${WANTED.length} buttons seen · ${events.length} presses`;
}

/**
 * Saves the capture on the host as a remote profile fixture, shows the result, then closes.
 * @returns {Promise<void>} Resolves once the save attempt is reported.
 */
async function finish() {
  const seen = {};
  events.forEach((info) => { if (info.remoteKey) seen[info.remoteKey] = (seen[info.remoteKey] || 0) + 1; });
  const capture = {
    name: (navigator.userAgent.match(/RerunTV-AndroidTV/) ? 'android-tv' : 'remote'),
    client: navigator.userAgent,
    seen,
    overrides: remoteProfile().overrides(),
    events: events.map((info) => ({
      source: info.source, key: info.key, keyCode: info.keyCode, scanCode: info.scanCode,
      remoteKey: info.remoteKey, repeat: info.repeat, longPress: info.longPress, holdMs: info.holdMs, at: info.at,
    })),
  };
  const status = overlay ? overlay.querySelector('.remote-test-status') : null;
  if (status) status.textContent = 'Saving…';
  let result = { ok: false, error: 'no host' };
  try {
    result = (window.api && window.api.saveRemoteProfile) ? await window.api.saveRemoteProfile(capture) : result;
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  if (status) {
    status.textContent = result && result.ok
      ? `Saved on the host: ${result.path || 'userData/remote-profiles'}`
      : `Could not save (${(result && result.error) || 'unknown'}). The capture is still on screen.`;
  }
  // Leave the result up briefly, then close.
  setTimeout(close, result && result.ok ? 2200 : 4000);
}

/**
 * Opens the remote test overlay and routes every button press into it until Back is pressed three times quickly.
 */
export function openRemoteTest() {
  if (overlay) return;
  overlay = el('div', 'remote-test');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="remote-test-panel">
      <div class="remote-test-title">REMOTE TEST</div>
      <div class="remote-test-help">Press every button on your remote, one at a time. Nothing else happens while this is open.<br>Press BACK three times quickly to finish and save.</div>
      <div class="remote-test-count"></div>
      <div class="remote-test-grid"></div>
      <div class="remote-test-events"></div>
      <div class="remote-test-status"></div>
    </div>`;
  (tvScreen.querySelector('.crt') || tvScreen).appendChild(overlay);
  events = [];
  backPresses = [];
  render();

  stopSink = (info) => {
    if (info.action === 'up') return;
    events.push(info);
    if (info.remoteKey === 'back') {
      const now = info.at || Date.now();
      backPresses = backPresses.filter((t) => now - t < FINISH_WINDOW_MS);
      backPresses.push(now);
      if (backPresses.length >= FINISH_PRESSES) { finish(); return; }
    }
    render();
  };
  setRemoteInputSink(stopSink);
}

// ---------- Learn mode ----------

// Learn-mode state: the panel element, the pending capture's cancel function and its modal surface.
let learnOverlay = null;
let cancelCapture = null;
let learnSurface = null;

/**
 * Whether the learn-mode (customize buttons) panel is showing.
 * @returns {boolean} True while it is open.
 */
export function learnModeOpen() {
  return !!learnOverlay;
}

/**
 * Closes learn mode, cancelling any capture in progress.
 */
export function closeLearnMode() {
  clearInterval(captureTicker);
  captureTicker = null;
  if (cancelCapture) { cancelCapture(); cancelCapture = null; }
  if (learnSurface) { learnSurface.close(); learnSurface = null; }
  learnOverlay = null;
}

/**
 * Redraws the list of assignable buttons with each one's current binding.
 * @param {string} [focusKey] Remote key whose row should get focus after the rebuild.
 */
function renderLearn(focusKey) {
  if (!learnOverlay) return;
  const profile = remoteProfile();
  const list = learnOverlay.querySelector('.remote-learn-list');
  list.innerHTML = '';
  const overrides = profile.overrides();
  const byKey = {};
  Object.entries(overrides).forEach(([rawId, remoteKey]) => { byKey[remoteKey] = rawId; });
  ASSIGNABLE.forEach((remoteKey, i) => {
    const item = el('button', 'remote-learn-item');
    item.type = 'button';
    item.tabIndex = i === 0 ? 0 : -1;
    item.append(el('span', 'remote-learn-key', keyName(remoteKey)));
    item.append(el('span', 'remote-learn-binding', byKey[remoteKey] ? byKey[remoteKey] : (profile.has(remoteKey) ? 'this remote has it' : 'not seen yet')));
    item.addEventListener('click', () => startCapture(remoteKey));
    item.addEventListener('focus', () => { learnOverlay.querySelector('.remote-learn-status').textContent = `OK to reassign ${keyName(remoteKey)}`; });
    list.appendChild(item);
  });
  // Rebuilding the list drops focus; put it back on the row just edited.
  const target = focusKey ? Array.from(list.children).find((b) => b.firstChild && b.firstChild.textContent === keyName(focusKey)) : null;
  if (target) target.focus({ preventScroll: true });
}

// Capture swallows every button, Back included, so it can't be cancelled with
// one: it gives up on its own after this long (the status line counts down).
const CAPTURE_TIMEOUT_S = 8;
let captureTicker = null;

/**
 * Waits for the next button press and saves it as this device's override for a remote key.
 * Gives up after `CAPTURE_TIMEOUT_S` seconds.
 * @param {string} remoteKey The remote key being reassigned.
 */
function startCapture(remoteKey) {
  if (!learnOverlay) return;
  const status = learnOverlay.querySelector('.remote-learn-status');
  if (cancelCapture) cancelCapture();
  clearInterval(captureTicker);
  let left = CAPTURE_TIMEOUT_S;
  const prompt = () => { status.textContent = `Press the button you want for ${keyName(remoteKey)}… (cancels in ${left}s)`; };
  prompt();
  captureTicker = setInterval(() => {
    left -= 1;
    if (left > 0) { prompt(); return; }
    clearInterval(captureTicker);
    captureTicker = null;
    if (cancelCapture) { cancelCapture(); cancelCapture = null; }
    renderLearn(remoteKey);
    status.textContent = 'Nothing pressed — cancelled.';
  }, 1000);
  cancelCapture = captureNextButton((info) => {
    cancelCapture = null;
    clearInterval(captureTicker);
    captureTicker = null;
    if (!info.rawId) { renderLearn(remoteKey); status.textContent = 'That button could not be identified — try another.'; return; }
    remoteProfile().setOverride(info.rawId, remoteKey);
    renderLearn(remoteKey);
    status.textContent = `${info.rawId} now means ${keyName(remoteKey)}.`;
  });
}

/**
 * Opens the learn-mode panel for reassigning buttons on this device.
 */
export function openLearnMode() {
  if (learnOverlay) return;
  learnSurface = ModalSurface({ className: 'remote-learn', label: 'Customize buttons', host: () => tvScreen.querySelector('.crt') || tvScreen, onCancel: closeLearnMode });
  learnOverlay = learnSurface.el;
  learnOverlay.innerHTML = `
    <div class="remote-learn-panel">
      <div class="remote-test-title">CUSTOMIZE BUTTONS</div>
      <div class="remote-test-help">Pick what to reassign, then press the button on your remote. Back closes.</div>
      <div class="remote-learn-list"></div>
      <div class="remote-learn-status"></div>
      <button type="button" class="remote-learn-reset">RESET ALL BUTTONS</button>
    </div>`;
  learnOverlay.querySelector('.remote-learn-reset').addEventListener('click', () => {
    remoteProfile().resetOverrides();
    renderLearn();
    learnOverlay.querySelector('.remote-learn-status').textContent = 'Every button is back to its default.';
  });
  renderLearn();
  learnSurface.open();
}

/**
 * Closes the remote test overlay without saving.
 */
export function closeRemoteTest() {
  close();
}


