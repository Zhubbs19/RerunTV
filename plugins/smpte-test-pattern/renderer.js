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
  canvas.width = canvas.clientWidth || 640;
  canvas.height = canvas.clientHeight || 360;
  const w = canvas.width, h = canvas.height;
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

window.RCBPlugins.registerSettingsPanel('smpte-test-pattern', {
  render(container, ctx) {
    if (!ctx.S.config.testPattern) ctx.S.config.testPattern = {};
    const cfg = ctx.S.config.testPattern;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">SMPTE TEST PATTERN</label>
      <span class="panel-status">Shows color bars instead of a plain "NO SIGNAL" card when you tune to a channel number that isn't set up yet.</span>
    `;
    const enabledEl = container.querySelector('[data-el="enabled"]');
    enabledEl.checked = cfg.enabled !== false;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
    });
  },
});
