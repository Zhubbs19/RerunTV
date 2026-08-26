// Guide/OSD era skin. Swaps the palette tokens in tokens.css by setting a
// data-theme attribute on <html> — see the [data-theme="analog-90s"]
// override block there. Set on <html> (not just #tv-screen) so the setup
// screen re-skins along with the TV screen.
import { applyCrtState, applyTvBezel } from './power.js';
import { runCoreHooks } from './plugins.js';
import { S } from './state.js';
import { player } from './dom.js';
import { getChannel } from './channels.js';
import { effectiveThemeId } from './broadcast-identity.js';

// The exact custom properties every theme pack's `html[data-theme="X"]`
// block overrides (see e.g. plugins/theme-analog-90s/style.css) — core's
// own palette contract, not the separate/optional `preview` swatch
// (registerThemePack, plugins.js) that only feeds the theme browser's card
// art and most packs never bother declaring.
const REPORTED_THEME_VARS = [
  '--ink', '--ink-deep', '--gold', '--cyan', '--paper', '--paper-dim', '--line',
  '--gradient-page', '--gradient-panel',
];

export function applyTheme({ boxOnly = false } = {}) {
  const themeId = effectiveThemeId(S.config, S.currentNumber, boxOnly);
  document.documentElement.dataset.theme = themeId;
  // Lets main-process-owned windows that can't reach the renderer's CSS at
  // all (the frameless auto-update progress popup, main-updater.js) re-skin
  // to match instead of always showing their hardcoded fallback palette —
  // reads the SAME resolved custom properties every theme pack already
  // overrides for the real screens, so this works for every pack, not just
  // ones that also declare a theme-browser preview swatch.
  if (window.api && window.api.reportThemeColors) {
    const computed = getComputedStyle(document.documentElement);
    const colors = {};
    REPORTED_THEME_VARS.forEach((name) => {
      const value = computed.getPropertyValue(name).trim();
      if (value) colors[name] = value;
    });
    window.api.reportThemeColors(colors);
  }
  const fontOverrides = S.config.display && S.config.display.themeFontOverrides
    ? S.config.display.themeFontOverrides[themeId] || {}
    : {};
  for (const [token, key] of [['--font-display', 'display'], ['--font-ui', 'ui'], ['--font-body', 'body']]) {
    const value = fontOverrides[key];
    if (value) document.documentElement.style.setProperty(token, value);
    else document.documentElement.style.removeProperty(token);
  }
  // The theme engine's audio side (tape hiss/crackle for an analog-feeling
  // theme vs. clean silence for a digital one) is plugin-owned.
  runCoreHooks('theme-audio-refresh');
  // Re-derive the CRT picture bias (power.js) for the newly active theme —
  // applyCrtState() resolves the effective box/channel theme itself, so this
  // fires on every theme switch, not only when a slider moves.
  applyCrtState();
  // Deliberately does NOT touch AUTO resolution/aspect (display-mode.js) —
  // a theme switch should only change the FRAME around whatever the video
  // already is, never the video's own simulated resolution/pixelation.
  if (player.videoWidth && player.videoHeight) {
    applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  }
}

window.applyTheme = applyTheme;
