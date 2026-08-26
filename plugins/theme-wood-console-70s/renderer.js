// Theme + border pack — see plugins.js's registerThemePack doc comment for
// the full field contract. One of the four "full behavior" eras (the other
// six pre-existing themes are palette-only) — every field below is migrated
// verbatim from core (power.js's THEME_CRT_BIAS, playback.js's
// STATIC_STYLE_BY_THEME, audio.js's themeChannelChangeSfx/themePowerSfx,
// vintage-audio's THEME_TEXTURE_PROFILES), not reinterpreted.
const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('wood-console-70s', {
  label: 'WOOD-GRAIN CONSOLE (1978 FOREST & BRASS)',
  preview: { background: '#050f0a', accent: '#b5893a', secondary: '#e8dcae' },
  group: 'ERA (BY DECADE)',

  // 1978 — no such thing as picture-in-picture yet.
  guidePreviewDefault: false,

  crtBias: { scanlines: 1.1, vignette: 1.15, grain: 1.3, flicker: 1.2, curvatureFloor: 0 },

  // Rolling-band static — an older, less coherent tube's tuning noise.
  staticStyle: 'roll',

  // A mechanical relay "thunk" — a physical turret-dial channel click, not
  // an electronic blip.
  channelChangeSfx() {
    playNoiseBurst({ duration: 18, gain: 0.22, filterFreq: 500 });
    playTone({ freq: 150, endFreq: 60, duration: 90, type: 'triangle', gain: 0.18 });
  },

  // A heavier mechanical relay thunk for both directions — same physical
  // language as the channel-change click, just bigger.
  powerSfx(isOn) {
    playNoiseBurst({ duration: 30, gain: 0.3, filterFreq: 350 });
    playTone({
      freq: isOn ? 55 : 90, endFreq: isOn ? 90 : 45, duration: 260, type: 'triangle', gain: 0.16,
    });
  },

  ambientTexture: {
    type: 'noise', filterType: 'lowpass', filterFreq: 220, gain: 0.022,
    crackle: { minMs: 4000, maxMs: 14000, gain: [0.05, 0.09], filterFreq: [150, 500] },
  },

  borderImage: new URL('./border.svg', import.meta.url).href,
});
