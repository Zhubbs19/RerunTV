// Theme + border pack — see plugins.js's registerThemePack doc comment for
// the full field contract. One of the four "full behavior" eras — every
// field below is migrated verbatim from core (power.js's THEME_CRT_BIAS,
// playback.js's STATIC_STYLE_BY_THEME, audio.js's
// themeChannelChangeSfx/themePowerSfx, vintage-audio's
// THEME_TEXTURE_PROFILES), not reinterpreted.
const { playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('digital-satellite-2000s', {
  label: 'DIGITAL SATELLITE (2001 ICE BLUE)',
  group: 'ERA (BY DECADE)',
  preview: { background: '#000d1a', accent: '#00bfff', secondary: '#7fd4ff' },

  crtBias: { scanlines: 0.5, vignette: 0.6, grain: 0.4, flicker: 0.3, curvatureFloor: 0 },

  // No snow at all — a near-black field with a bright band sweeping
  // downward (searching for a lock) and a text readout, instead of the
  // analog eras' noise (see showStaticBurst, playback.js).
  staticStyle: 'acquire',

  // Two crisp ascending digital blips — a lock-on chirp.
  channelChangeSfx() {
    playTone({
      freq: 1200, duration: 45, type: 'square', gain: 0.08,
    });
    setTimeout(() => playTone({
      freq: 1800, duration: 70, type: 'square', gain: 0.09,
    }), 55);
  },

  // A crisp two-tone digital chirp — "acquiring"/"releasing" the link.
  powerSfx(isOn) {
    playTone({
      freq: isOn ? 400 : 1400, endFreq: isOn ? 1400 : 400, duration: 260, type: 'square', gain: 0.08,
    });
  },

  borderImage: new URL('./border.svg', import.meta.url).href,
});
