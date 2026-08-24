import { player } from './dom.js';
import { getThemePack } from './plugins.js';
import { S } from './state.js';
import { channelIdentity, effectiveThemeId } from './broadcast-identity.js';

// Also re-syncs S.sfxGain's level with the current mute/volume state on
// every call, as a side effect — every one-shot SFX calls this right before
// playing, so that's how a one-shot always reads the right level without a
// separate mute/volume-change listener of its own. refreshSfxGainLevel()
// below exists only because a *persistent* node (the tape-hiss loop) can't
// rely on "the next unrelated SFX happens to trigger a refresh" and needs it
// proactively instead.
export function getAudioCtx() {
  if (!S.audioCtx) {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.sfxGain = S.audioCtx.createGain();
    S.sfxGain.connect(S.audioCtx.destination);
  }
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
  S.sfxGain.gain.value = player.muted ? 0 : (typeof S.config.volume === 'number' ? S.config.volume : 1);
  return S.audioCtx;
}

export function playTone(opts) {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const durationSec = opts.duration / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type || 'sine';
  osc.frequency.setValueAtTime(opts.freq, now);
  if (opts.endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.endFreq), now + durationSec);
  gain.gain.setValueAtTime(opts.gain != null ? opts.gain : 0.2, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
  osc.connect(gain).connect(S.sfxGain);
  osc.start(now);
  osc.stop(now + durationSec);
}

export function playNoiseBurst(opts) {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const durationSec = opts.duration / 1000;
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  let node = src;
  if (opts.filterFreq) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = opts.filterFreq;
    node.connect(filter);
    node = filter;
  }

  const peakGain = opts.gain != null ? opts.gain : 0.2;
  const gain = ctx.createGain();
  // A brief fade-in instead of stepping straight to full volume — an
  // instant onset on raw noise reads as a harsh click/pop.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + Math.min(0.01, durationSec / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
  node.connect(gain).connect(S.sfxGain);
  src.start(now);
}

// Theme-aware channel-change/power SFX — supplied by the active theme
// pack's `channelChangeSfx`/`powerSfx` fields (registerThemePack,
// plugins.js). A color-only pack simply omits them, in which case
// sfxChannelChange()/sfxPowerOff() below fall through to the plain generic
// sound every theme originally had.
function themeChannelChangeSfx() {
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber));
  if (pack && pack.channelChangeSfx) { pack.channelChangeSfx(window.RCBPlugins.ctx); return true; }
  return false;
}
export function sfxChannelChange() {
  const identity = channelIdentity(S.config, S.currentNumber);
  if (identity && identity.tuneSfx === 'silent') return;
  if (identity && identity.tuneSfx === 'soft') { playTone({ freq: 620, duration: 70, type: 'sine', gain: 0.07 }); return; }
  if (identity && identity.tuneSfx === 'analog') { playNoiseBurst({ duration: 180, gain: 0.1, filterFreq: 1100 }); return; }
  if (identity && identity.tuneSfx === 'digital') { playTone({ freq: 520, endFreq: 980, duration: 90, type: 'square', gain: 0.06 }); return; }
  if (themeChannelChangeSfx()) return;
  playNoiseBurst({ duration: 130, gain: 0.07, filterFreq: 1400 });
}
export function sfxVolumeTick(up) { playTone({ freq: up ? 900 : 500, duration: 45, type: 'sine', gain: 0.12 }); }
export function sfxGuideToggle(opening) { playTone({ freq: opening ? 650 : 480, duration: 55, type: 'sine', gain: 0.1 }); }

function themePowerSfx(isOn) {
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber));
  if (pack && pack.powerSfx) { pack.powerSfx(isOn, window.RCBPlugins.ctx); return true; }
  return false;
}
export function sfxPowerOff() {
  if (themePowerSfx(false)) return;
  playNoiseBurst({ duration: 25, gain: 0.25 });
  playTone({ freq: 880, endFreq: 80, duration: 320, type: 'sine', gain: 0.12 });
}
export function sfxPowerOn() {
  if (themePowerSfx(true)) return;
  playNoiseBurst({ duration: 25, gain: 0.25 });
  playTone({ freq: 120, endFreq: 880, duration: 380, type: 'sine', gain: 0.12 });
}
export function playEasTone(durationMs) {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const durationSec = durationMs / 1000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
  gain.gain.setValueAtTime(0.15, now + durationSec - 0.1);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
  gain.connect(S.sfxGain);

  S.easOscillators = [853, 960].map((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + durationSec);
    return osc;
  });
}

export function playNewsStinger(style) {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;

  if (style === 'alien-report') {
    // Sci-Fi frequency sweep with alien chirps
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(1600, now + 0.3);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.6);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.9);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
    osc.connect(gain).connect(S.sfxGain);
    osc.start(now);
    osc.stop(now + 1.0);
    return;
  }

  // Classic retro news fanfare: 4-note brassy triad + teletype clacks
  const notes = [
    { freq: 196.00, time: 0, duration: 0.14 },    // G3
    { freq: 261.63, time: 0.15, duration: 0.14 }, // C4
    { freq: 329.63, time: 0.30, duration: 0.14 }, // E4
    { freq: 392.00, time: 0.45, duration: 0.60 }, // G4
  ];

  notes.forEach((n) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(n.freq, now + n.time);

    // Add a slight octave overlay for brassy newsroom sound
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(n.freq * 2, now + n.time);

    const gain2 = ctx.createGain();

    gain.gain.setValueAtTime(0.0001, now + n.time);
    gain.gain.linearRampToValueAtTime(0.18, now + n.time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.time + n.duration);

    gain2.gain.setValueAtTime(0.0001, now + n.time);
    gain2.gain.linearRampToValueAtTime(0.06, now + n.time + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + n.time + n.duration);

    osc.connect(gain).connect(S.sfxGain);
    osc2.connect(gain2).connect(S.sfxGain);
    osc.start(now + n.time);
    osc.stop(now + n.time + n.duration);
    osc2.start(now + n.time);
    osc2.stop(now + n.time + n.duration);
  });

  // Teletype newsroom ticker clicks
  for (let i = 0; i < 8; i++) {
    setTimeout(() => {
      playNoiseBurst({ duration: 20, gain: 0.08, filterFreq: 2200 });
    }, 650 + i * 85);
  }
}

// Web Speech API runs through the OS's own TTS pipeline, not Web Audio, so
// it can't be routed through sfxGain — volume/mute are only applied as a
// snapshot at speak() time, not live. Acceptable for an ~15s alert readout.
export function speakEasMessage(text, onDone) {
  if (!window.speechSynthesis) { onDone(); return null; }
  window.speechSynthesis.cancel(); // clear anything stuck in the queue
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.95;
  utter.pitch = 0.85;
  utter.volume = player.muted ? 0 : (typeof S.config.volume === 'number' ? S.config.volume : 1);
  utter.onend = onDone;
  utter.onerror = onDone;
  window.speechSynthesis.speak(utter);
  return utter;
}

export function cancelEasSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

export function speakNewsMessage(text, onDone) {
  if (!window.speechSynthesis) { if (onDone) onDone(); return null; }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  utter.pitch = 0.95;
  utter.volume = player.muted ? 0 : (typeof S.config.volume === 'number' ? S.config.volume : 1);
  utter.onend = onDone || (() => {});
  utter.onerror = onDone || (() => {});
  window.speechSynthesis.speak(utter);
  return utter;
}

export function cancelNewsSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

export function playPurchaseConfirmSound() {
  // Cash register cha-ching + success chime
  playNoiseBurst({ duration: 40, gain: 0.15, filterFreq: 3000 });
  setTimeout(() => playTone({ freq: 1200, duration: 80, type: 'triangle', gain: 0.15 }), 50);
  setTimeout(() => playTone({ freq: 1600, duration: 300, type: 'sine', gain: 0.18 }), 120);
}

export function playPinUnlockSound() {
  playTone({ freq: 880, duration: 100, type: 'sine', gain: 0.15 });
  setTimeout(() => playTone({ freq: 1760, duration: 250, type: 'sine', gain: 0.18 }), 100);
}


export function playChannelClickSound() {
  if (S.config && S.config.vintageAudio && S.config.vintageAudio.clicks === false) return;
  playNoiseBurst({ duration: 35, gain: 0.25, filterFreq: 1200 });
  playTone({ freq: 880, endFreq: 440, duration: 40, type: 'square', gain: 0.15 });
}

// Re-syncs S.sfxGain's live level with the current mute/volume state.
// getAudioCtx() already does this as a side effect on every call (needed so
// one-shot SFX read the right level at the instant they fire), but a
// persistent node like the analog-90s tape hiss below needs it refreshed
// proactively the moment mute/volume changes, not just whenever the next
// unrelated SFX happens to trigger a refresh.
export function refreshSfxGainLevel() {
  if (S.audioCtx) getAudioCtx();
}


