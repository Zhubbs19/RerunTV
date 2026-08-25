// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('ops-dashboard', {
  label: 'OPS DASHBOARD (BROADCAST AUTOMATION)',
  group: 'BROADCAST/STUDIO',
  preview: { background: '#12151c', accent: '#5b8dee', secondary: '#8891a4' },
  // A modern flat panel — almost no CRT character at all, the cleanest bias
  // of the nine.
  crtBias: { scanlines: 0.4, vignette: 0.5, grain: 0.3, flicker: 0.3, curvatureFloor: 0 },
  channelChangeSfx() { playTone({ freq: 880, duration: 38, type: 'sine', gain: .035 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 440 : 880, endFreq: isOn ? 880 : 400, duration: 130, type: 'sine', gain: .035 }); },
});
