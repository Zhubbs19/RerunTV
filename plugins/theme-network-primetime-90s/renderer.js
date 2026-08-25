// Theme + border pack — see plugins.js's registerThemePack doc comment for
// the full field contract. One of the four "full behavior" eras — every
// field below is migrated verbatim from core (power.js's THEME_CRT_BIAS,
// playback.js's STATIC_STYLE_BY_THEME, audio.js's
// themeChannelChangeSfx/themePowerSfx). No ambientTexture — this is the one
// "full" era vintage-audio's old THEME_TEXTURE_PROFILES never covered (a
// glossy broadcast doesn't hiss or pop at all, deliberately silent).
const { playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('network-primetime-90s', {
  label: 'NETWORK PRIME TIME (1996 CREAM & BRICK)',
  preview: { background: '#100805', accent: '#e76f61', secondary: '#e9c46a' },
  group: 'ERA (BY DECADE)',

  crtBias: { scanlines: 0.8, vignette: 0.85, grain: 0.6, flicker: 0.5, curvatureFloor: 0 },

  // A quick, low-opacity blip instead of a full static burst — network
  // broadcast didn't cut to visible tuning noise between its own channels
  // the way cable/UHF did.
  staticStyle: 'quiet',

  // A clean three-note chime, not noise at all — network broadcast didn't
  // sound like tuning static between its own channels.
  channelChangeSfx() {
    [880, 1108.73, 1318.51].forEach((freq, i) => {
      setTimeout(() => playTone({
        freq, duration: 90, type: 'sine', gain: 0.1,
      }), i * 45);
    });
  },

  // A soft glossy chime sweep — a network ident's musical stinger, not a
  // mechanical or electronic sound at all.
  powerSfx(isOn) {
    const notes = isOn ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25];
    notes.forEach((freq, i) => {
      setTimeout(() => playTone({
        freq, duration: 220, type: 'sine', gain: 0.1,
      }), i * 90);
    });
  },

  borderImage: new URL('./border.svg', import.meta.url).href,
});
