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
import { tvScreen } from './dom.js';
import { captureNextButton, remoteProfile, setRemoteInputSink } from './tv-input.js';
import { ModalSurface } from './ui/dialog.js';

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

const MAX_SHOWN = 14;
const FINISH_PRESSES = 3;
const FINISH_WINDOW_MS = 2500;

let overlay = null;
let events = [];
let stopSink = null;
let backPresses = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function close() {
  setRemoteInputSink(null);
  stopSink = null;
  if (overlay) { overlay.remove(); overlay = null; }
  events = [];
  backPresses = [];
}

export function remoteTestOpen() {
  return !!overlay;
}

function describe(info) {
  const source = info.source === 'android' ? `android ${info.keyCode}` : (info.key || info.keyCode || info.source);
  const held = info.longPress ? ' · HELD' : (info.holdMs ? ` · ${Math.round(info.holdMs)}ms` : '');
  return `${source}${held}  →  ${info.remoteKey || 'not mapped'}`;
}

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
    grid.appendChild(el('span', `remote-test-key${seen.has(key) ? ' seen' : ''}`, key));
  });
  overlay.querySelector('.remote-test-count').textContent = `${seen.size} of ${WANTED.length} buttons seen · ${events.length} presses`;
}

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

let learnOverlay = null;
let cancelCapture = null;
let learnSurface = null;

export function learnModeOpen() {
  return !!learnOverlay;
}

export function closeLearnMode() {
  if (cancelCapture) { cancelCapture(); cancelCapture = null; }
  if (learnSurface) { learnSurface.close(); learnSurface = null; }
  learnOverlay = null;
}

function renderLearn() {
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
    item.append(el('span', 'remote-learn-key', remoteKey.toUpperCase()));
    item.append(el('span', 'remote-learn-binding', byKey[remoteKey] ? byKey[remoteKey] : (profile.has(remoteKey) ? 'this remote has it' : 'not seen yet')));
    item.addEventListener('click', () => startCapture(remoteKey));
    item.addEventListener('focus', () => { learnOverlay.querySelector('.remote-learn-status').textContent = `OK to reassign ${remoteKey.toUpperCase()}`; });
    list.appendChild(item);
  });
}

function startCapture(remoteKey) {
  if (!learnOverlay) return;
  const status = learnOverlay.querySelector('.remote-learn-status');
  status.textContent = `Press the button you want for ${remoteKey.toUpperCase()}…`;
  if (cancelCapture) cancelCapture();
  cancelCapture = captureNextButton((info) => {
    cancelCapture = null;
    if (!info.rawId) { status.textContent = 'That button could not be identified — try another.'; return; }
    remoteProfile().setOverride(info.rawId, remoteKey);
    status.textContent = `${info.rawId} now means ${remoteKey.toUpperCase()}.`;
    renderLearn();
  });
}

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

export function closeRemoteTest() {
  close();
}


