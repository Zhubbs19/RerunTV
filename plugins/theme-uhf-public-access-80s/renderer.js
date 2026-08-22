// Theme + border pack — see plugins.js's registerThemePack doc comment for
// the full field contract. One of the four "full behavior" eras — every
// field below is migrated verbatim from core (power.js's THEME_CRT_BIAS,
// playback.js's STATIC_STYLE_BY_THEME, audio.js's
// themeChannelChangeSfx/themePowerSfx, vintage-audio's
// THEME_TEXTURE_PROFILES), not reinterpreted.
const { S, playNoiseBurst, playTone, getAudioCtx } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('uhf-public-access-80s', {
  label: 'LATE-NIGHT UHF (1988 MAGENTA & CYAN)',
  group: 'ERA (BY DECADE)',

  crtBias: { scanlines: 1.15, vignette: 1.2, grain: 1.5, flicker: 1.3, curvatureFloor: 15 },

  // Bad-tracking horizontal tear bands — "a signal that can't quite hold."
  staticStyle: 'tear',

  // A gritty FM warble — manual oscillator (not the plain playTone helper)
  // for the frequency-ramp sweep, plus a noise-burst tail.
  channelChangeSfx() {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.16);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(S.sfxGain);
    osc.start(now);
    osc.stop(now + 0.22);
    playNoiseBurst({ duration: 220, gain: 0.05, filterFreq: 2600 });
  },

  // A degauss-like buzz-and-click — the CRT-demagnetizing thud real sets
  // made on power-up, plus the gritty warble on power-down.
  powerSfx(isOn) {
    playNoiseBurst({ duration: isOn ? 220 : 90, gain: 0.14, filterFreq: 180 });
    playTone({
      freq: isOn ? 70 : 260, endFreq: isOn ? 260 : 70, duration: 300, type: 'sawtooth', gain: 0.08,
    });
  },

  ambientTexture: {
    type: 'noise', filterType: 'highpass', filterFreq: 2000, gain: 0.03,
    crackle: { minMs: 1500, maxMs: 6000, gain: [0.05, 0.1], filterFreq: [1200, 5000] },
  },

  borderImage: 'app://plugins/theme-uhf-public-access-80s/border.svg',
});
