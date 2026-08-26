// Guide/OSD era skin. Swaps the palette tokens in tokens.css by setting a
// data-theme attribute on <html> — see the [data-theme="analog-90s"]
// override block there. Set on <html> (not just #tv-screen) so the setup
// screen re-skins along with the TV screen.
import { applyCrtState, applyTvBezel } from './power.js';
import { getThemePack, runCoreHooks } from './plugins.js';
import { S } from './state.js';
import { player } from './dom.js';
import { getChannel } from './channels.js';
import { effectiveThemeId } from './broadcast-identity.js';

export function applyTheme({ boxOnly = false } = {}) {
  const themeId = effectiveThemeId(S.config, S.currentNumber, boxOnly);
  document.documentElement.dataset.theme = themeId;
  // Lets main-process-owned windows that can't reach the plugin registry
  // themselves (the frameless auto-update progress popup, main-updater.js)
  // re-skin to match instead of always showing their hardcoded fallback
  // palette. Same three-color swatch the theme browser already uses for its
  // preview cards (setup-settings.js) — packs that don't define one report
  // null, and the progress window just keeps its default colors.
  if (window.api && window.api.reportThemeColors) {
    const pack = getThemePack(themeId);
    window.api.reportThemeColors((pack && pack.preview) || null);
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
