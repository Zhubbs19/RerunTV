// Guide/OSD era skin. Swaps the palette tokens in tokens.css by setting a
// data-theme attribute on <html> — see the [data-theme="analog-90s"]
// override block there. Set on <html> (not just #tv-screen) so the setup
// screen re-skins along with the TV screen.
import { applyCrtState, applyTvBezel } from './power.js';
import { runCoreHooks } from './plugins.js';
import { S } from './state.js';
import { player } from './dom.js';
import { getChannel } from './channels.js';

export function applyTheme() {
  document.documentElement.dataset.theme = S.config.theme || 'digital-2000s';
  // The theme engine's audio side (tape hiss/crackle for an analog-feeling
  // theme vs. clean silence for a digital one) is plugin-owned.
  runCoreHooks('theme-audio-refresh');
  // Re-derive the CRT picture bias (power.js) for the newly active theme —
  // applyCrtState() reads S.config.theme itself, so this just needs to fire
  // on every theme switch, not only when a slider moves.
  applyCrtState();
  // Deliberately does NOT touch AUTO resolution/aspect (display-mode.js) —
  // a theme switch should only change the FRAME around whatever the video
  // already is, never the video's own simulated resolution/pixelation.
  if (player.videoWidth && player.videoHeight) {
    applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  }
}
