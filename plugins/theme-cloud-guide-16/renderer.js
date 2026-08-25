const { playTone } = window.RCBPlugins.ctx;

// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('cloud-guide-16', {
  label: "CLOUD GUIDE '16",
  group: 'REAL CABLE-BOX UI',
  preview: { background: '#080b12', accent: '#4f83ff', secondary: '#48d17a' },
  // A modern flat panel rendering a cloud-composited guide — minimal CRT
  // character, same territory as Ops Dashboard.
  crtBias: { scanlines: 0.3, vignette: 0.4, grain: 0.2, flicker: 0.2, curvatureFloor: 0 },
  staticStyle: 'acquire',
  channelChangeSfx() {
    playTone({ freq: 720, endFreq: 940, duration: 85, type: 'sine', gain: 0.035 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 380 : 760, endFreq: isOn ? 760 : 320, duration: 160, type: 'sine', gain: 0.035 });
  },
});
