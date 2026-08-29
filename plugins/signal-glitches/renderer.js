// Rare, brief static/tearing bursts with no real-world trigger — "the
// antenna having a bad day," unlike plugins/noaa-weather's signal
// degradation (which is a persistent, real-severe-weather-triggered
// effect). This plugin is deliberately independent of noaa-weather: no
// shared state, no import between them — just the same canvas-noise
// rendering technique (see noaa-weather/renderer.js's sdDrawNoise) applied
// to a random ambient timer instead of real alert data.
const GLITCH_CANVAS_W = 160;
const GLITCH_CANVAS_H = 90;
const GLITCH_DRAW_INTERVAL_MS = 90;
const GLITCH_DURATION_MS = 900;

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

function cfg() {
  const settings = window.RCBPlugins.ctx.getPluginSettings('signal-glitches');
  return {
    enabled: !!settings.enabled,
    minIntervalMin: settings.minIntervalMin || 20,
    maxIntervalMin: settings.maxIntervalMin || 60,
    intensity: settings.intensity != null ? settings.intensity : 100,
  };
}

function isEligibleNow() {
  const S = window.RCBPlugins.ctx.S;
  if (!S.isPoweredOn || S.easActive) return false;
  const guideGrid = document.getElementById('guide-grid');
  if (guideGrid && !guideGrid.classList.contains('hidden')) return false;
  return true;
}

function fireGlitch() {
  const { intensity } = cfg();
  if (!isEligibleNow()) { scheduleNext(); return; }
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
  }, GLITCH_DURATION_MS);
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
// enabled/interval fields change, instead of waiting for whatever delay was
// already in flight from before the edit.
export function rearmSignalGlitches() {
  scheduleNext();
}

scheduleNext();
