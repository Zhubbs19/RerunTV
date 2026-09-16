// Guide/OSD era skin. Swaps the palette tokens in tokens.css by setting a
// data-theme attribute on <html> — see the [data-theme="analog-90s"]
// override block there. Set on <html> (not just #tv-screen) so the setup
// screen re-skins along with the TV screen.
import { applyCrtState, applyTvBezel } from '../playback/power.js';
import { getThemePack, pluginStylesReady, runCoreHooks, themePackEntries } from '../plugin/host.js';
import { checkThemesWhenIdle } from './theme-check.js';
import { S } from '../core/state.js';
import { player } from '../core/dom.js';
import { getChannel } from '../core/channels.js';
import { effectiveThemeId } from './identity.js';

// The palette the frameless update-progress window (main-updater.js) knows,
// by its long-standing names. Read from body, where those names are
// read-aliases of the semantic tokens (tokens.css), so a converted pack that
// only sets --accent/--surface-1 reports correctly too.
const REPORTED_THEME_VARS = [
  '--ink', '--ink-deep', '--gold', '--cyan', '--paper', '--paper-dim', '--line',
  '--gradient-page', '--gradient-panel',
];

export function applyTheme({ boxOnly = false } = {}) {
  const themeId = effectiveThemeId(S.config, S.currentNumber, boxOnly);
  document.documentElement.dataset.theme = themeId;
  // A pack's guide composition (registerThemePack's guideLayout, docs/design/04
  // §4.1): layout is core's, chosen by name, never a theme's structural CSS.
  const pack = getThemePack(themeId);
  if (pack && typeof pack.guideLayout === 'string') document.documentElement.dataset.guideLayout = pack.guideLayout;
  else delete document.documentElement.dataset.guideLayout;
  // Lets main-process-owned windows that can't reach the renderer's CSS at
  // all (the frameless auto-update progress popup, main-updater.js) re-skin
  // to match instead of always showing their hardcoded fallback palette —
  // reads the SAME resolved custom properties every theme pack already
  // overrides for the real screens, so this works for every pack, not just
  // ones that also declare a theme-browser preview swatch.
  if (window.api && window.api.reportThemeColors) {
    const computed = getComputedStyle(document.body || document.documentElement);
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

// Contrast-checks every theme pack once its stylesheet has loaded, in idle
// time (theme-check.js). Results feed the theme browser's "Low contrast"
// badge and Plug-ins › Diagnostics; a failing theme still loads.
export async function startThemeCheck() {
  try {
    await pluginStylesReady();
    return await checkThemesWhenIdle(themePackEntries());
  } catch (e) {
    console.error('[theme-check] could not run', e);
    return [];
  }
}
