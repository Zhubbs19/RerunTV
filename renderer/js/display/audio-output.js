// Which speakers the box plays through (PICTURE & SOUND › Sound output).
// A PC driving a TV over HDMI usually keeps its desk speakers or headset as
// the Windows default, so without this the TV sat silent unless the Windows
// default was switched by hand every session.
//
// Per device, like the usage mode: kept in this client's localStorage, never
// channels.json, since an audio device id only means something on this
// machine. Host window only; a LAN viewer plays wherever its browser does.
//
// Every sound source is covered without each one knowing about this:
// HTMLMediaElement.prototype.play is wrapped so any <video>/<audio>/new Audio()
// (core or plugin) is pointed at the chosen device the first time it plays,
// and the shared AudioContext (core/audio.js) is pointed there when created.

const STORAGE_KEY = 'reruntv.audioOutput';

let choice = readChoice();
let resolvedId = '';
let present = false;
let installed = false;
const elements = new Set();
const contexts = new Set();

function readChoice() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    return parsed && typeof parsed.deviceId === 'string' ? { deviceId: parsed.deviceId, label: String(parsed.label || '') } : null;
  } catch (e) {
    return null;
  }
}

function writeChoice(next) {
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (e) { /* storage unavailable: the choice lasts this session */ }
}

// Real output devices, without Chromium's 'default'/'communications' aliases.
export async function listAudioOutputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Unnamed output' }));
  } catch (e) {
    return [];
  }
}

export function getAudioOutputChoice() {
  return choice ? { ...choice } : null;
}

// Whether the chosen device is connected right now (false when none is chosen).
export function isAudioOutputPresent() {
  return present;
}

// The id to hand setSinkId: the saved id, else a device with the saved label
// (a device can come back under a new id), else '' for the system default.
async function resolve() {
  if (!choice) { present = false; return ''; }
  const outputs = await listAudioOutputs();
  const match = outputs.find((d) => d.deviceId === choice.deviceId)
    || (choice.label ? outputs.filter((d) => d.label === choice.label) : []).find((d, i, all) => all.length === 1);
  present = !!match;
  return match ? match.deviceId : '';
}

function sinkElement(el, id) {
  if (typeof el.setSinkId !== 'function' || el.sinkId === id) return;
  el.setSinkId(id).catch((e) => console.warn('[audio-output] could not switch a media element', e && e.message));
}

function sinkContext(ctx, id) {
  if (typeof ctx.setSinkId !== 'function' || ctx.sinkId === id) return;
  ctx.setSinkId(id).catch((e) => console.warn('[audio-output] could not switch the audio context', e && e.message));
}

// force re-points everything even when sinkId already matches: when an HDMI
// device drops out and comes back, Chromium leaves elements on the fallback
// device while their sinkId still reads as the chosen one.
async function applyAll({ force = false } = {}) {
  const wasPresent = present;
  const id = await resolve();
  const reset = force || (present && !wasPresent);
  const targets = [...elements].map((ref) => ref.deref()).filter(Boolean);
  elements.forEach((ref) => { if (!ref.deref()) elements.delete(ref); });
  document.querySelectorAll('audio, video').forEach((el) => { if (!targets.includes(el)) targets.push(el); });
  resolvedId = id;
  await Promise.all(targets.map(async (el) => {
    if (typeof el.setSinkId !== 'function') return;
    if (reset && el.sinkId === id && id) await el.setSinkId('').catch(() => {});
    sinkElement(el, id);
  }));
  contexts.forEach((ctx) => {
    if (ctx.state === 'closed') { contexts.delete(ctx); return; }
    sinkContext(ctx, id);
  });
}

// Points a newly created AudioContext at the chosen device (core/audio.js).
export function applyAudioOutputToContext(ctx) {
  if (!ctx || !installed) return;
  contexts.add(ctx);
  sinkContext(ctx, resolvedId);
}

// choice: { deviceId, label } from listAudioOutputs(), or null for the system default.
export async function setAudioOutput(next) {
  choice = next && next.deviceId ? { deviceId: next.deviceId, label: String(next.label || '') } : null;
  writeChoice(choice);
  await applyAll({ force: true });
  return present;
}

// Called once from app.js, host window only.
export function installAudioOutput() {
  if (installed || typeof HTMLMediaElement === 'undefined') return;
  installed = true;
  const originalPlay = HTMLMediaElement.prototype.play;
  // Not awaited: play() keeps its synchronous side effects (paused flips at
  // once), which the playback watchdogs rely on. The switch lands a moment later.
  HTMLMediaElement.prototype.play = function play(...args) {
    if (!elements.has(this.__audioOutputRef)) {
      this.__audioOutputRef = new WeakRef(this);
      elements.add(this.__audioOutputRef);
    }
    if (resolvedId || this.sinkId) sinkElement(this, resolvedId);
    return originalPlay.apply(this, args);
  };
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { applyAll(); });
  }
  applyAll();
}
