// The registered id is retained for compatibility with existing configs;
// the displayed theme name is intentionally provider-neutral.
const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('passport-03', {
  label: "COBALT GRID '03",
  group: 'REAL CABLE-BOX UI',
  preview: { background: '#05132e', accent: '#ffd23f', secondary: '#4da3ff' },
  // A newer set than Prevue's era but still a real tube — moderate bias.
  crtBias: { scanlines: 1.1, vignette: 1.15, grain: 1.2, flicker: 1.1, curvatureFloor: 12 },
  staticStyle: 'quiet',
  channelChangeSfx() {
    playNoiseBurst({ duration: 18, gain: 0.08, filterFreq: 1400 });
    playTone({ freq: 620, duration: 58, type: 'square', gain: 0.055 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 260 : 760, endFreq: isOn ? 760 : 220, duration: 210, type: 'square', gain: 0.05 });
  },
});
