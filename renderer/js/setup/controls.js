// Widescreen fill and logo bug options, keyboard shortcut editor, panel reset
// buttons and "Tuning & controls". Split out of settings.js.
import { updateLogoBug } from '../playback/broadcast-fx.js';
import { applyAspectMode, applyPictureMode, applyCrtState, applyHintBarState, applyVolume, applyTvBezel } from '../playback/power.js';
import { S, commitInPlace, dispatch } from '../core/state.js';
import { applyBakedBars } from '../playback/bars.js';
import { KEY_ACTIONS, effectiveKey, keyProblem } from '../core/keymap.js';
import { applyKeyHints } from '../core/key-remap.js';
import { defaultForPath } from '../core/setting-defaults.js';
import { renderHighlights } from '../update/highlights.js';
import { formatChannelNumber, sortedChannels, getChannel } from '../core/channels.js';
import { updateTimeShiftBadge } from '../playback/timemachine.js';
import { parsePositiveInt } from './util.js';
import { hidePinLockScreen } from './pin-lock.js';
import { detailsEnabledEl, upNextDurationSlider, staticDurationSlider, staticDurationVal, staticEnabledEl, staticIntensitySlider, player, stationIdEnabledEl, stationIdIntervalEl, timeMachineBadgeEl, aspectBarsEl, aspectAutofillEl, aspectAutofillMaxEl, logoBugFollowPictureEl, logoBugRefHeightEl, logoBugDefaultSizeEl, logoBugVaryEl, logoBugHideBreaksEl, logoBugHideNumberEl, startupChannelEl, entryDelayEl, scanDwellEl, sleepStepsEl, volumeStepEl, volumeMaxEl, rememberChannelVolumeEl, tuneFadeInEl, sleepFadeOutEl, triviaEnabledEl, triviaIntervalEl, upNextEnabledEl, pinCancelBtn, pinCodeInputEl, pinCodeRevealBtn, pinLockEnabledEl } from '../core/dom.js';
import { renderSettingsPanels } from './settings.js';
import { refreshDependentControls } from './dependent-controls.js';

// ---------- Widescreen fill and logo bug options (Display) ----------
// Re-frames the picture and re-places the bug so the change shows at once.
function reframePicture() {
  if (player.videoWidth) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  updateLogoBug(getChannel(S.currentNumber));
}
const setDisplay = (key, value) => dispatch({ type: 'settings.set', path: ['display', key], value });
const BARS_HELP = 'Finds black bars that are part of the video itself and frames the picture without them. Each file is checked once in the background.';
export async function renderBakedBarsStatus() {
  const help = document.getElementById('aspect-bars-help');
  if (!help) return;
  const status = window.api && window.api.getCropStatus ? await window.api.getCropStatus().catch(() => null) : null;
  if (!status) {
    help.textContent = window.__isViewer ? 'Frames the picture on the box itself, not on this device.' : BARS_HELP;
  } else if (!status.available) {
    help.textContent = 'Needs ffmpeg to check files. Install it from Plug-ins › FFmpeg Transcode.';
  } else if (S.config.display.removeBakedBars && status.queued) {
    help.textContent = `${BARS_HELP} ${status.checked} checked (${status.withBars} with bars), ${status.queued} to go.`;
  } else if (status.checked) {
    help.textContent = `${BARS_HELP} ${status.checked} checked, ${status.withBars} with bars.`;
  } else {
    help.textContent = BARS_HELP;
  }
}
aspectBarsEl.addEventListener('change', () => {
  setDisplay('removeBakedBars', aspectBarsEl.checked);
  applyBakedBars();
  setTimeout(renderBakedBarsStatus, 500);
});
aspectAutofillEl.addEventListener('change', () => { setDisplay('autoFillWidescreen', aspectAutofillEl.checked); reframePicture(); });
aspectAutofillMaxEl.addEventListener('change', () => {
  const pct = Math.round(Math.min(60, Math.max(2, parseFloat(aspectAutofillMaxEl.value) || 30)));
  aspectAutofillMaxEl.value = pct;
  setDisplay('autoFillMaxCropPct', pct);
  reframePicture();
});
logoBugFollowPictureEl.addEventListener('change', () => { setDisplay('logoBugFollowPicture', logoBugFollowPictureEl.checked); applyBakedBars(); });
logoBugRefHeightEl.addEventListener('change', () => { setDisplay('logoBugReferenceHeight', logoBugRefHeightEl.value === 'auto' ? undefined : Number(logoBugRefHeightEl.value)); reframePicture(); });
logoBugDefaultSizeEl.addEventListener('input', () => {
  const size = parseInt(logoBugDefaultSizeEl.value, 10);
  const readout = document.getElementById('logo-bug-default-size-value');
  if (readout) readout.textContent = `${size} PX`;
  const profiles = (S.config.display.logoBugProfiles || []).map((p) => ({ ...p }));
  let target = profiles.find((p) => !p.aspect && !p.resolution);
  if (!target) { target = { id: 'default', aspect: null, resolution: null, x: 94, y: 90, size }; profiles.push(target); }
  target.size = size;
  delete target.width;
  delete target.height;
  dispatch({ type: 'settings.set', path: ['display', 'logoBugProfiles'], value: profiles }, { coalesce: 'display:logoBugDefaultSize' });
  reframePicture();
});
logoBugVaryEl.addEventListener('change', () => { setDisplay('logoBugVaryWithContent', logoBugVaryEl.checked); reframePicture(); });
logoBugHideBreaksEl.addEventListener('change', () => setDisplay('logoBugHideOnBreaks', logoBugHideBreaksEl.checked));
logoBugHideNumberEl.addEventListener('change', () => { setDisplay('logoBugHideNumber', logoBugHideNumberEl.checked); reframePicture(); });

// ---------- Help › What's new: things to try ----------
const helpHighlightsEl = document.getElementById('help-highlights');
if (helpHighlightsEl) renderHighlights(helpHighlightsEl);

// ---------- Keyboard shortcuts (System › Keys) ----------
// One capture at a time. The old per-click closure removed its own listener only
// when a key arrived, so re-rendering (or leaving the tab) mid-capture leaked a
// capture-phase keydown handler that swallowed the next keystroke anywhere.
let cancelKeyCapture = null;
function endKeyCapture() {
  if (cancelKeyCapture) { const cancel = cancelKeyCapture; cancelKeyCapture = null; cancel(); }
}
// Navigating away from the Keys sub-tab abandons a capture in progress.
document.addEventListener('click', (event) => {
  if (cancelKeyCapture && event.target.closest && event.target.closest('[data-subtab], [data-tab]')) endKeyCapture();
}, true);

function renderKeymapEditor() {
  const host = document.getElementById('keymap-editor');
  if (!host) return;
  endKeyCapture();
  const map = S.config.keyMap || {};
  host.innerHTML = '';
  const message = document.createElement('div');
  message.className = 'keymap-message panel-status';
  KEY_ACTIONS.forEach((action) => {
    const row = document.createElement('div');
    row.className = 'keymap-row';
    const label = document.createElement('span');
    label.className = 'keymap-label';
    label.textContent = action.label;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn keymap-key';
    const current = effectiveKey(map, action);
    button.textContent = current.toUpperCase();
    button.classList.toggle('keymap-changed', current !== action.key);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn keymap-reset';
    reset.textContent = current === action.key ? '' : `RESET (${action.key.toUpperCase()})`;
    reset.hidden = current === action.key;
    reset.addEventListener('click', () => {
      dispatch({ type: 'settings.set', path: ['keyMap', action.id], value: undefined });
      applyKeyHints();
      renderKeymapEditor();
    });
    button.addEventListener('click', () => {
      endKeyCapture();
      button.textContent = 'PRESS A KEY…';
      message.textContent = '';
      const onKey = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation(); // no other capture-phase handler (setup shortcuts) also sees this key
        window.removeEventListener('keydown', onKey, true);
        cancelKeyCapture = null;
        if (event.key === 'Escape') { renderKeymapEditor(); return; }
        const problem = keyProblem(S.config.keyMap || {}, action.id, event.key);
        if (problem) { renderKeymapEditor(); const m = document.querySelector('#keymap-editor .keymap-message'); if (m) m.textContent = problem; return; }
        const chosen = event.key.toLowerCase();
        dispatch({ type: 'settings.set', path: ['keyMap', action.id], value: chosen === action.key ? undefined : chosen });
        applyKeyHints();
        renderKeymapEditor();
      };
      window.addEventListener('keydown', onKey, true);
      cancelKeyCapture = () => {
        window.removeEventListener('keydown', onKey, true);
        if (button.isConnected) button.textContent = current.toUpperCase();
      };
    });
    row.append(label, button, reset);
    host.appendChild(row);
  });
  host.appendChild(message);
}
document.querySelector('.setup-subtab-btn[data-subtab="keys"]')?.addEventListener('click', renderKeymapEditor);

// ---------- Reset a panel to its defaults ----------
// A panel marked data-reset-keys='[["display","clock24"],…]' gets a RESET
// button listing the settings it owns. Resetting removes those keys, so every
// reader falls back to its own default, as one undoable step (UNDO below).
function resetPanelKeys(panel) {
  let paths = [];
  try { paths = JSON.parse(panel.dataset.resetKeys || '[]'); } catch (e) { paths = []; }
  // The ones that differ from their default (or, with no default, that are set at all).
  const present = paths.filter((path) => {
    let node = S.config;
    for (const key of path) {
      if (node == null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false;
      node = node[key];
    }
    const fallback = defaultForPath(path, S.config);
    return fallback === undefined || JSON.stringify(fallback) !== JSON.stringify(node);
  });
  return present;
}

document.querySelectorAll('.panel[data-reset-keys]').forEach((panel) => {
  const row = document.createElement('div');
  row.className = 'panel-body panel-reset-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn panel-reset-btn';
  button.textContent = 'RESET THIS PANEL TO DEFAULTS';
  row.appendChild(button);
  panel.appendChild(row);
  const refreshState = () => {
    const count = resetPanelKeys(panel).length;
    button.disabled = count === 0;
    button.title = count ? `Puts ${count} changed setting${count === 1 ? '' : 's'} back to default (undoable)` : 'Already at the defaults';
  };
  button.addEventListener('click', () => {
    const present = resetPanelKeys(panel);
    if (!present.length) return;
    const title = (panel.querySelector('.panel-toggle')?.textContent || 'panel').trim().toLowerCase();
    dispatch(present.map((path) => ({ type: 'settings.set', path, value: defaultForPath(path, S.config) })), { label: `Reset ${title}` });
    applyAspectMode();
    applyPictureMode();
    applyCrtState();
    applyHintBarState();
    applyVolume();
    renderSettingsPanels();
    renderKeymapEditor();
    applyKeyHints();
    reframePicture();
    button.textContent = 'RESET ✓ (UNDO BELOW)';
    setTimeout(() => { button.textContent = 'RESET THIS PANEL TO DEFAULTS'; refreshState(); }, 2500);
  });
  // The state follows config changes from anywhere (edits, undo, search).
  refreshState();
  panel.addEventListener('mouseenter', refreshState);
  panel.addEventListener('change', () => setTimeout(refreshState, 200));
  panel.addEventListener('input', () => setTimeout(refreshState, 300));
  window.addEventListener('reruntv:config-replaced', refreshState);
});

// ---------- Tuning & controls (System) ----------
const controlsCfg = () => S.config.controls || {};

export function renderControlsPanel() {
  const c = controlsCfg();
  startupChannelEl.innerHTML = '';
  const addOption = (value, label) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    startupChannelEl.appendChild(opt);
  };
  addOption('last', 'LAST CHANNEL WATCHED');
  addOption('first', 'FIRST CHANNEL');
  for (const ch of sortedChannels()) addOption(String(ch.number), `CH ${formatChannelNumber(ch.number)}${ch.name ? ` · ${ch.name}` : ''}`);
  // A channel number may be saved as text (the Companion's Settings editor does).
  const startupRaw = c.startupChannel;
  const startup = typeof startupRaw === 'string' && startupRaw.trim() !== '' && Number.isFinite(Number(startupRaw)) ? Number(startupRaw) : startupRaw;
  startupChannelEl.value = typeof startup === 'number' ? String(startup) : (startup === 'first' ? 'first' : 'last');
  if (startupChannelEl.value === '') startupChannelEl.value = 'last';
  entryDelayEl.value = ((Number.isFinite(c.entryDelayMs) ? c.entryDelayMs : 800) / 1000).toFixed(1);
  scanDwellEl.value = Number.isFinite(c.scanDwellSec) ? c.scanDwellSec : 8;
  sleepStepsEl.value = (Array.isArray(c.sleepSteps) && c.sleepSteps.length ? c.sleepSteps : [30, 60, 90, 120]).join(', ');
  volumeStepEl.value = Number.isFinite(c.volumeStepPct) ? c.volumeStepPct : 10;
  volumeMaxEl.value = Number.isFinite(c.volumeMaxPct) ? c.volumeMaxPct : 100;
  rememberChannelVolumeEl.checked = !!c.rememberChannelVolume;
  sleepFadeOutEl.checked = c.sleepFadeOut !== false;
  tuneFadeInEl.value = String(Number.isFinite(c.tuneFadeInMs) ? c.tuneFadeInMs : 0);
}

const setControl = (key, value, opts) => dispatch({ type: 'settings.set', path: ['controls', key], value }, opts);
const clampNum = (el, min, max, fallback) => {
  const n = parseFloat(el.value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
};

startupChannelEl.addEventListener('change', () => {
  const v = startupChannelEl.value;
  setControl('startupChannel', v === 'last' || v === 'first' ? v : Number(v));
});
entryDelayEl.addEventListener('change', () => {
  const sec = clampNum(entryDelayEl, 0.2, 3, 0.8);
  entryDelayEl.value = sec.toFixed(1);
  setControl('entryDelayMs', Math.round(sec * 1000));
});
scanDwellEl.addEventListener('change', () => {
  const sec = Math.round(clampNum(scanDwellEl, 2, 60, 8));
  scanDwellEl.value = sec;
  setControl('scanDwellSec', sec);
});
sleepStepsEl.addEventListener('change', () => {
  const steps = [...new Set(sleepStepsEl.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 1440).map(Math.round))].sort((a, b) => a - b);
  const value = steps.length ? steps : [30, 60, 90, 120];
  sleepStepsEl.value = value.join(', ');
  setControl('sleepSteps', value);
});
volumeStepEl.addEventListener('change', () => {
  const pct = Math.round(clampNum(volumeStepEl, 1, 25, 10));
  volumeStepEl.value = pct;
  setControl('volumeStepPct', pct);
});
rememberChannelVolumeEl.addEventListener('change', () => setControl('rememberChannelVolume', rememberChannelVolumeEl.checked));
sleepFadeOutEl.addEventListener('change', () => setControl('sleepFadeOut', sleepFadeOutEl.checked));
tuneFadeInEl.addEventListener('change', () => setControl('tuneFadeInMs', parseInt(tuneFadeInEl.value, 10) || 0));
volumeMaxEl.addEventListener('input', () => {
  const pct = parseInt(volumeMaxEl.value, 10);
  setControl('volumeMaxPct', pct, { coalesce: 'settings:volumeMax' });
  // Lowering the ceiling pulls an over-limit volume down with it.
  if (typeof S.config.volume === 'number' && S.config.volume > pct / 100) {
    S.config.volume = pct / 100;
    commitInPlace({ type: 'settings.set', path: ['volume'], value: S.config.volume }, { skipUndo: true });
    applyVolume();
  }
});

timeMachineBadgeEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['timeMachine', 'showTimeShiftBadge'], value: timeMachineBadgeEl.checked });
  updateTimeShiftBadge();
});
upNextEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['upNext', 'enabled'], value: upNextEnabledEl.checked });
});
upNextDurationSlider?.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['upNext', 'duration'], value: parseInt(upNextDurationSlider.value, 10) || 8000 }, { coalesce: 'settings:upNext.duration' });
});
detailsEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['details', 'enabled'], value: detailsEnabledEl.checked });
});
stationIdEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['stationId', 'enabled'], value: stationIdEnabledEl.checked });
});
stationIdIntervalEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['stationId', 'intervalMinutes'], value: (stationIdIntervalEl.value = parsePositiveInt(stationIdIntervalEl.value, 15)) });
});
staticEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['staticEffect', 'enabled'], value: staticEnabledEl.checked });
  refreshDependentControls();
});
staticIntensitySlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['staticEffect', 'intensity'], value: parseInt(staticIntensitySlider.value, 10) }, { coalesce: 'settings:staticEffect.intensity' });
});
if (staticDurationSlider) {
  staticDurationSlider.addEventListener('input', () => {
    const ms = parseInt(staticDurationSlider.value, 10);
    dispatch({ type: 'settings.set', path: ['staticEffect', 'durationMs'], value: ms }, { coalesce: 'settings:staticEffect.durationMs' });
    if (staticDurationVal) staticDurationVal.textContent = ms === 0 ? '0ms (INSTANT)' : `${ms}ms`;
  });
}
triviaEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['trivia', 'enabled'], value: triviaEnabledEl.checked });
});
triviaIntervalEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['trivia', 'intervalMinutes'], value: (triviaIntervalEl.value = parsePositiveInt(triviaIntervalEl.value, 20)) });
});

if (pinLockEnabledEl) pinLockEnabledEl.addEventListener('change', () => { dispatch({ type: 'settings.set', path: ['pinLock', 'enabled'], value: pinLockEnabledEl.checked }); });
if (pinCodeInputEl) pinCodeInputEl.addEventListener('input', () => {
  // The keypad only accepts exactly four digits, so anything else would lock channels for good.
  pinCodeInputEl.value = pinCodeInputEl.value.replace(/\D/g, '').slice(0, 4);
  if (!/^\d{4}$/.test(pinCodeInputEl.value)) return;
  dispatch({ type: 'settings.set', path: ['pinLock', 'code'], value: pinCodeInputEl.value }, { coalesce: 'settings:pinLock.code', label: 'Change PIN' });
});
// The PIN is masked by default — it sits on a settings page that is itself
// reachable without the lock, so a plain text input meant anyone glancing at
// the screen could read the code the lock exists to keep. SHOW is for the
// person who set it and forgot it.
if (pinCodeRevealBtn && pinCodeInputEl) {
  pinCodeRevealBtn.addEventListener('click', () => {
    const revealed = pinCodeInputEl.type === 'text';
    pinCodeInputEl.type = revealed ? 'password' : 'text';
    pinCodeRevealBtn.textContent = revealed ? 'SHOW' : 'HIDE';
    pinCodeRevealBtn.setAttribute('aria-pressed', String(!revealed));
    pinCodeRevealBtn.setAttribute('aria-label', revealed ? 'Show PIN' : 'Hide PIN');
  });
}
if (pinCancelBtn) pinCancelBtn.addEventListener('click', hidePinLockScreen);
