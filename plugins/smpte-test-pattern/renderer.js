// Classic 75% SMPTE color bars — flat rects, not a broadcast-accurate 100%/
// 7.5% IRE reference signal, but immediately recognizable. Migrated as-is
// from the old core playback.js. Only ever drawn for a channel number that
// isn't configured at all (playback.js's tuneToChannel `!ch` branch fires
// the generic 'draw-test-pattern' core hook there, see registerCoreHook
// below) — a real channel's own failure states keep using the plain
// no-signal card, so this never competes with or duplicates any of those.
// Draws onto the core-owned
// #test-pattern-canvas element (core still owns show/hide of that canvas,
// same as before) since a canvas + its CRT power-off hide rule didn't need
// to move to be plugin-owned in spirit.
const SMPTE_TOP_COLORS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
const SMPTE_BOTTOM_COLORS = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];

function draw() {
  const canvas = document.getElementById('test-pattern-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  // A flat-fillRect color-bar pattern is meant to read as sharp reference
  // bars, not chunky/pixelated (unlike the deliberately-chunky static/noise
  // canvases elsewhere in this app) — sizing the backing store to CSS pixels
  // alone leaves it soft on a HiDPI/4K display once Chromium scales it back
  // up to physical pixels. devicePixelRatio here is cheap (this canvas is
  // solid-color rects, not per-pixel noise) so there's no perf tradeoff like
  // there would be for the static-noise canvases.
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((canvas.clientWidth || 640) * dpr);
  const h = Math.round((canvas.clientHeight || 360) * dpr);
  canvas.width = w;
  canvas.height = h;
  const barW = w / SMPTE_TOP_COLORS.length;
  const topH = h * 0.66;
  const bottomH = h * 0.25;
  SMPTE_TOP_COLORS.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * barW, 0, barW + 1, topH);
  });
  SMPTE_BOTTOM_COLORS.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * barW, topH, barW + 1, bottomH);
  });
  // Bottom strip: a small black/white/gray step wedge, the other classic
  // SMPTE element.
  const wedgeY = topH + bottomH;
  const wedgeH = h - wedgeY;
  const wedgeColors = ['#131359', '#ffffff', '#131313', '#131313', '#131313', '#131313', '#131313'];
  wedgeColors.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * barW, wedgeY, barW + 1, wedgeH);
  });
}

// Core fires this generic event (registerCoreHook, plugins.js) instead of
// calling into this plugin by name.
window.RCBPlugins.registerCoreHook('draw-test-pattern', draw);
