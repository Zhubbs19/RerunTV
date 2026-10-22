// Usage mode and "Screen & speakers": target screen, audio output, TV mode
// screen, screen off action, screen edges and the audio leveler. Split out of
// settings.js.
import { S, dispatch } from '../core/state.js';
import { getAudioOutputChoice, isAudioOutputPresent, listAudioOutputs, setAudioOutput } from '../display/audio-output.js';
import { getTvModeScreen, setTvModeScreen, getUsageModePreference, onUsageModeChange, setTvPreview, setUsageModePreference, usageMode, usageModeSource } from '../tv/usage-mode.js';
import { flashScreenEdgeGuide, getCurrentScreen, getScreenEdge, getScreenOffAction, onCurrentScreenChange, setScreenEdge, setScreenOffAction } from '../display/tv-screen.js';
import { applyLeveler } from '../playback/leveler.js';

// Usage mode is per device (usage-mode.js), not config: a laptop and the
// living-room box sharing one channels.json can be in different modes.
const usageModeSelectEl = document.getElementById('usage-mode-select');
const usageModeStatusEl = document.getElementById('usage-mode-status');
export function renderUsageModeSetting() {
  if (!usageModeSelectEl) return;
  usageModeSelectEl.value = getUsageModePreference();
  if (usageModeStatusEl) usageModeStatusEl.textContent = `NOW: ${usageMode().toUpperCase()} (${usageModeSource().toUpperCase()})`;
}
usageModeSelectEl?.addEventListener('change', () => {
  setUsageModePreference(usageModeSelectEl.value);
  renderUsageModeSetting();
});
onUsageModeChange(() => renderUsageModeSetting());
// Preview TV mode (docs/design/01 §8): session only, straight to live TV.
document.getElementById('tv-preview-btn')?.addEventListener('click', () => {
  setTvPreview(true);
  window.dispatchEvent(new CustomEvent('reruntv:watch-tv'));
});
renderUsageModeSetting();

// ---------- Screen & speakers ----------
// Host window only: a LAN viewer has no OS window to place and plays sound
// wherever its own browser does. Both lists are re-read whenever a select
// gets focus, since screens and speakers come and go (a TV switched off).
const screenTargetSelect = document.getElementById('screen-target-select');
const screenTargetHelp = document.getElementById('screen-target-help');
const audioOutputSelect = document.getElementById('audio-output-select');
const audioOutputHelp = document.getElementById('audio-output-help');
const SCREEN_HELP = 'RerunTV opens on this screen, and goes back to it when it reconnects, like after the TV wakes up.';
const AUDIO_HELP = 'Play through the TV’s speakers without changing the Windows default. Set on this computer only.';
let screenOptions = [];
let audioOptions = [];

function screenName(screen) {
  const name = screen.label || (screen.primary ? 'Main screen' : 'Screen');
  return `${name.toUpperCase()} — ${screen.width}×${screen.height}`;
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.text;
    return el;
  }));
  select.value = value;
}

async function renderScreenTarget() {
  const row = screenTargetSelect && screenTargetSelect.closest('.setting-row');
  if (!row) return;
  const info = window.api && window.api.listScreens ? await window.api.listScreens().catch(() => null) : null;
  row.hidden = !info;
  if (!info) return;
  const preferred = info.preferred;
  const current = info.screens.find((screen) => screen.current);
  screenOptions = [{ value: '', text: 'LAST ONE USED', ref: null }];
  info.screens.forEach((screen) => {
    screenOptions.push({ value: screen.id, text: `${screenName(screen)}${screen.current ? ' (HERE NOW)' : ''}`, ref: { id: screen.id, label: screen.label } });
  });
  const preferredConnected = preferred && info.screens.some((screen) => screen.id === preferred.id || (preferred.label && screen.label === preferred.label));
  if (preferred && !preferredConnected) {
    screenOptions.push({ value: preferred.id, text: `${(preferred.label || 'Saved screen').toUpperCase()} (NOT CONNECTED)`, ref: preferred });
  }
  const selected = !preferred ? ''
    : (info.screens.find((screen) => screen.id === preferred.id) || info.screens.find((screen) => preferred.label && screen.label === preferred.label) || preferred).id;
  fillSelect(screenTargetSelect, screenOptions, selected);
  if (info.pendingReturn) {
    screenTargetHelp.textContent = `Waiting for ${info.pendingReturn.label || 'the saved screen'} to reconnect. RerunTV moves there as soon as it does.`;
  } else if (!preferred && current) {
    screenTargetHelp.textContent = `${SCREEN_HELP} Now on ${current.label || 'this screen'}.`;
  } else {
    screenTargetHelp.textContent = SCREEN_HELP;
  }
}

async function renderAudioOutput() {
  const row = audioOutputSelect && audioOutputSelect.closest('.setting-row');
  if (!row) return;
  row.hidden = !!window.__isViewer;
  if (window.__isViewer) return;
  const outputs = await listAudioOutputs();
  const choice = getAudioOutputChoice();
  audioOptions = [{ value: '', text: 'SYSTEM DEFAULT', device: null }];
  outputs.forEach((device) => audioOptions.push({ value: device.deviceId, text: device.label.toUpperCase(), device }));
  let selected = '';
  if (choice) {
    const match = outputs.find((d) => d.deviceId === choice.deviceId) || outputs.find((d) => choice.label && d.label === choice.label);
    if (match) selected = match.deviceId;
    else {
      audioOptions.push({ value: choice.deviceId, text: `${(choice.label || 'Saved output').toUpperCase()} (NOT CONNECTED)`, device: choice });
      selected = choice.deviceId;
    }
  }
  fillSelect(audioOutputSelect, audioOptions, selected);
  audioOutputHelp.textContent = choice && !isAudioOutputPresent()
    ? 'That output isn’t connected, so sound plays through the system default until it’s back.'
    : AUDIO_HELP;
}

const tvModeScreenSelect = document.getElementById('tv-mode-screen-select');
const tvModeScreenHelp = document.getElementById('tv-mode-screen-help');
const TV_SCREEN_HELP = 'Use the remote-friendly TV layout while the window is on this screen, and the desktop layout everywhere else.';
let tvScreenOptions = [];

async function renderTvModeScreen() {
  const row = tvModeScreenSelect && tvModeScreenSelect.closest('.setting-row');
  if (!row) return;
  const info = window.api && window.api.listScreens ? await window.api.listScreens().catch(() => null) : null;
  row.hidden = !info;
  if (!info) return;
  const chosen = getTvModeScreen();
  tvScreenOptions = [{ value: '', text: 'OFF', ref: null }];
  info.screens.forEach((screen) => tvScreenOptions.push({ value: screen.id, text: screenName(screen), ref: { id: screen.id, label: screen.label } }));
  let selected = '';
  if (chosen) {
    const match = info.screens.find((screen) => screen.id === chosen.id) || info.screens.find((screen) => chosen.label && screen.label === chosen.label);
    if (match) selected = match.id;
    else {
      tvScreenOptions.push({ value: chosen.id, text: `${(chosen.label || 'Saved screen').toUpperCase()} (NOT CONNECTED)`, ref: chosen });
      selected = chosen.id;
    }
  }
  fillSelect(tvModeScreenSelect, tvScreenOptions, selected);
  const pref = getUsageModePreference();
  tvModeScreenHelp.textContent = chosen && pref !== 'auto'
    ? `Usage mode is set to ${pref.toUpperCase()} in System › This device, which wins over this. Set it to AUTO to use this.`
    : TV_SCREEN_HELP;
}

tvModeScreenSelect?.addEventListener('focus', () => renderTvModeScreen());
tvModeScreenSelect?.addEventListener('change', () => {
  const option = tvScreenOptions.find((o) => o.value === tvModeScreenSelect.value);
  setTvModeScreen(option ? option.ref : null);
  renderTvModeScreen();
  renderUsageModeSetting();
});

const screenOffActionSelect = document.getElementById('screen-off-action-select');
const screenEdgeSlider = document.getElementById('screen-edge-slider');
const screenEdgeValue = document.getElementById('screen-edge-value');
const screenEdgeHelp = document.getElementById('screen-edge-help');
const SCREEN_EDGE_HELP = 'If the TV cuts off the clock or banners, pull everything in until the white frame shows on all four sides. Saved for this screen only.';

function renderScreenPowerAndEdges() {
  const hostWindow = !!(window.api && window.api.listScreens);
  [screenOffActionSelect, screenEdgeSlider].forEach((el) => {
    const row = el && el.closest('.setting-row');
    if (row) row.hidden = !hostWindow;
  });
  if (!hostWindow) return;
  if (screenOffActionSelect) screenOffActionSelect.value = getScreenOffAction();
  if (screenEdgeSlider) {
    const screen = getCurrentScreen();
    const pct = getScreenEdge();
    screenEdgeSlider.value = String(pct);
    screenEdgeValue.textContent = `${pct}%`;
    screenEdgeHelp.textContent = screen && screen.label
      ? `${SCREEN_EDGE_HELP} Now adjusting ${screen.label}.`
      : SCREEN_EDGE_HELP;
  }
}

screenOffActionSelect?.addEventListener('change', () => setScreenOffAction(screenOffActionSelect.value));
screenEdgeSlider?.addEventListener('input', () => {
  setScreenEdge(Number(screenEdgeSlider.value));
  screenEdgeValue.textContent = `${Number(screenEdgeSlider.value)}%`;
  flashScreenEdgeGuide();
});
screenEdgeSlider?.addEventListener('focus', () => flashScreenEdgeGuide());
onCurrentScreenChange(() => renderScreenPowerAndEdges());

const audioLevelerSelect = document.getElementById('audio-leveler-select');
audioLevelerSelect?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['audioLeveler'], value: audioLevelerSelect.value });
  applyLeveler();
  setTimeout(renderAudioLeveler, 500);
});

const LEVELER_HELP = 'Evens out loud and quiet shows and commercials. Each file is measured once in the background. CONSISTENT plays everything a little quieter so quiet shows never fall short at high volume.';

async function renderAudioLeveler() {
  if (!audioLevelerSelect) return;
  audioLevelerSelect.value = S.config.audioLeveler || 'off';
  const help = document.getElementById('audio-leveler-help');
  if (!help) return;
  const status = window.api && window.api.getLoudnessStatus ? await window.api.getLoudnessStatus().catch(() => null) : null;
  if (!status) {
    help.textContent = window.__isViewer ? 'Levels the sound on the box itself, not on this device.' : LEVELER_HELP;
  } else if (!status.available) {
    help.textContent = 'Needs ffmpeg to measure files. Install it from Plug-ins › FFmpeg Transcode.';
  } else if (S.config.audioLeveler && S.config.audioLeveler !== 'off' && status.queued) {
    help.textContent = `${LEVELER_HELP} ${status.measured} measured, ${status.queued} to go.`;
  } else {
    help.textContent = LEVELER_HELP;
  }
}

export function renderScreenSpeakersSettings() {
  renderScreenPowerAndEdges();
  renderAudioLeveler();
  Promise.all([renderScreenTarget(), renderTvModeScreen(), renderAudioOutput()]).then(() => {
    const panel = document.getElementById('screen-speakers-panel');
    if (panel) panel.hidden = [...panel.querySelectorAll('.setting-row')].every((row) => row.hidden);
  });
}

screenTargetSelect?.addEventListener('focus', () => renderScreenTarget());
screenTargetSelect?.addEventListener('change', async () => {
  const option = screenOptions.find((o) => o.value === screenTargetSelect.value);
  if (window.api && window.api.setPreferredScreen) await window.api.setPreferredScreen(option ? option.ref : null);
  renderScreenTarget();
});
audioOutputSelect?.addEventListener('focus', () => renderAudioOutput());
audioOutputSelect?.addEventListener('change', async () => {
  const option = audioOptions.find((o) => o.value === audioOutputSelect.value);
  await setAudioOutput(option ? option.device : null);
  renderAudioOutput();
});
