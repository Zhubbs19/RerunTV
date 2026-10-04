// Rare, brief glitches with no real-world trigger — "the antenna having a
// bad day," unlike plugins/noaa-weather's signal degradation (a persistent,
// real-severe-weather-triggered effect). Deliberately independent of
// noaa-weather: no shared state, no import between them. Three independent
// effect types share one random scheduler, picking randomly among whichever
// are enabled each time it fires (see cfg()/fireGlitch below) rather than
// three separate timers:
//  - static: the original canvas-noise tear burst (same technique as
//    noaa-weather's sdDrawNoise).
//  - roll: a brief vertical picture-roll/color-sync drift (a CSS transform
//    on .crt, not a canvas effect).
//  - dropout: a brief audio wow-and-flutter pitch-wobble plus a couple of
//    volume dips, applied directly to the real <video> element's own
//    playbackRate/volume — this was scoped down from a literal "desync
//    audio from video" idea (confirmed infeasible: no API separates a
//    single <video> element's own audio/video timing) to this achievable,
//    still-convincing "something's wrong with the feed" substitute.
const GLITCH_CANVAS_W = 160;
const GLITCH_CANVAS_H = 90;
const GLITCH_DRAW_INTERVAL_MS = 90;
const GLITCH_DURATION_MS = 900;
const ROLL_DURATION_MS = 700;
const DROPOUT_DURATION_MS = 1200;
const DROPOUT_STEP_MS = 60;

const rootEl = document.createElement('div');
rootEl.className = 'signal-glitch-overlay hidden';
rootEl.innerHTML = `<canvas class="signal-glitch-canvas" width="${GLITCH_CANVAS_W}" height="${GLITCH_CANVAS_H}"></canvas>`;
document.querySelector('.crt').appendChild(rootEl);
const canvas = rootEl.querySelector('canvas');
const ctx2d = canvas.getContext('2d');

let drawTimer = null;
let scheduleTimer = null;

function drawNoise() {
  const w = canvas.width, h = canvas.height;
  const imgData = ctx2d.createImageData(w, h);
  const buf = imgData.data;
  for (let i = 0; i < buf.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
  }
  ctx2d.putImageData(imgData, 0, 0);
  // A couple of torn/shifted bands — same technique as noaa-weather's
  // higher-severity levels and showStaticBurst's (playback.js) 'tear' style.
  const bands = 1 + Math.floor(Math.random() * 2);
  for (let b = 0; b < bands; b++) {
    const bandY = Math.floor(Math.random() * h);
    const bandH = 1 + Math.floor(Math.random() * 4);
    const xShift = ((Math.random() * 14) - 7) | 0;
    ctx2d.drawImage(canvas, 0, bandY, w, bandH, xShift, bandY, w, bandH);
  }
}

// "Glitch length" (settings): every effect's duration is its base length times
// this, so a glitch can be a flicker or a proper dropout.
function lengthScale() {
  const n = Number((window.RCBPlugins.ctx.getPluginSettings('signal-glitches') || {}).lengthScale);
  return Number.isFinite(n) ? Math.min(4, Math.max(0.25, n)) : 1;
}

function cfg() {
  const settings = window.RCBPlugins.ctx.getPluginSettings('signal-glitches');
  const effects = settings.effects || {};
  return {
    enabled: !!settings.enabled,
    minIntervalMin: settings.minIntervalMin || 20,
    maxIntervalMin: settings.maxIntervalMin || 60,
    intensity: settings.intensity != null ? settings.intensity : 100,
    // 'static' defaults on (it's the original, already-shipped effect);
    // the two new ones default off so an existing user's behavior doesn't
    // silently change just from upgrading this plugin.
    effectStatic: effects.static !== false,
    effectRoll: !!effects.roll,
    effectDropout: !!effects.dropout,
  };
}

function isEligibleNow() {
  const S = window.RCBPlugins.ctx.S;
  if (!S.isPoweredOn || S.easActive || S.creditsSpeedupActive) return false;
  const guideGrid = document.getElementById('guide-grid');
  if (guideGrid && !guideGrid.classList.contains('hidden')) return false;
  return true;
}

function fireStaticGlitch(intensity) {
  rootEl.classList.remove('hidden');
  canvas.style.setProperty('--glitch-opacity', String(Math.max(0, Math.min(1, intensity / 100)) * 0.7));
  drawNoise();
  clearInterval(drawTimer);
  drawTimer = setInterval(drawNoise, GLITCH_DRAW_INTERVAL_MS);
  if (window.playNoiseBurst) window.playNoiseBurst({ duration: 180, gain: 0.05, filterFreq: 2200 });
  setTimeout(() => {
    clearInterval(drawTimer);
    drawTimer = null;
    rootEl.classList.add('hidden');
    scheduleNext();
  }, GLITCH_DURATION_MS * lengthScale());
}

function firePictureRoll(intensity) {
  const crt = document.querySelector('.crt');
  if (!crt) { scheduleNext(); return; }
  // Scales the keyframe's translateY/hue-rotate amounts (style.css) via a
  // CSS custom property — same shared INTENSITY slider the static effect
  // uses, just applied to a transform instead of canvas opacity.
  crt.style.setProperty('--glitch-roll-intensity', String(Math.max(0, Math.min(1, intensity / 100))));
  crt.classList.add('signal-glitch-rolling');
  setTimeout(() => {
    crt.classList.remove('signal-glitch-rolling');
    scheduleNext();
  }, ROLL_DURATION_MS * lengthScale());
}

// Directly modulates the real <video> element's own playbackRate/volume —
// affects whatever's actually playing (content or a bumper), not a
// synthesized SFX layered on top. Restores both to whatever they were
// immediately before this fired; a real volume/rate change made by the
// user mid-wobble (rare, ~1.2s window) could get momentarily overwritten by
// that restore, same acceptable trade-off scheduleCreditsSpeedup already
// makes with playbackRate — isEligibleNow's creditsSpeedupActive check
// keeps the two features from ever fighting over it at the same time.
function fireAudioDropout(intensity) {
  const { player } = window.RCBPlugins.ctx;
  if (!player) { scheduleNext(); return; }
  const scale = Math.max(0, Math.min(1, intensity / 100));
  const originalRate = player.playbackRate;
  const originalVolume = player.volume;
  let elapsed = 0;
  const wobbleTimer = setInterval(() => {
    elapsed += DROPOUT_STEP_MS;
    player.playbackRate = Math.max(0.5, originalRate + (Math.random() - 0.5) * 0.12 * scale);
    player.volume = Math.random() < 0.15 * scale ? originalVolume * (1 - 0.8 * scale) : originalVolume;
    if (elapsed >= DROPOUT_DURATION_MS * lengthScale()) {
      clearInterval(wobbleTimer);
      player.playbackRate = originalRate;
      player.volume = originalVolume;
      scheduleNext();
    }
  }, DROPOUT_STEP_MS);
}

function fireGlitch() {
  const c = cfg();
  if (!isEligibleNow()) { scheduleNext(); return; }
  const available = [];
  if (c.effectStatic) available.push(() => fireStaticGlitch(c.intensity));
  if (c.effectRoll) available.push(() => firePictureRoll(c.intensity));
  if (c.effectDropout) available.push(() => fireAudioDropout(c.intensity));
  if (!available.length) { scheduleNext(); return; }
  available[Math.floor(Math.random() * available.length)]();
}

function scheduleNext() {
  clearTimeout(scheduleTimer);
  const { enabled, minIntervalMin, maxIntervalMin } = cfg();
  if (!enabled) return;
  const lo = Math.min(minIntervalMin, maxIntervalMin);
  const hi = Math.max(minIntervalMin, maxIntervalMin);
  const delayMs = (lo + Math.random() * (hi - lo)) * 60000;
  scheduleTimer = setTimeout(fireGlitch, delayMs);
}

// Exported so the settings panel can re-arm the timer immediately after the
// enabled/interval/effect fields change, instead of waiting for whatever
// delay was already in flight from before the edit.
export function rearmSignalGlitches() {
  scheduleNext();
}

scheduleNext();
