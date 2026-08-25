// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('frutiger-aero', {
  label: 'FRUTIGER AERO (GLOSSY 2000s OPTIMISM)',
  group: 'STYLIZED',
  preview: { background: '#eaf9f0', accent: '#127a6c', secondary: '#0e6f80' },
  // A glossy flat panel — the least CRT-like bias on the page, on purpose.
  crtBias: { scanlines: 0.3, vignette: 0.35, grain: 0.2, flicker: 0.2, curvatureFloor: 0 },
  channelChangeSfx() { playTone({ freq: 640, endFreq: 1040, duration: 110, type: 'sine', gain: .035 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 420 : 980, endFreq: isOn ? 980 : 360, duration: 240, type: 'sine', gain: .035 }); },
});
