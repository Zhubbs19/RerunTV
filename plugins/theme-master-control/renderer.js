// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('master-control', {
  label: 'MASTER CONTROL (AMBER BROADCAST CONSOLE)',
  group: 'BROADCAST/STUDIO',
  preview: { background: '#0a0c0e', accent: '#e8a33d', secondary: '#4caf7d' },
  // A clean broadcast reference monitor — light on scanline/vignette/grain,
  // no curvature floor. The calmest, least-distorted bias of the nine.
  crtBias: { scanlines: 0.7, vignette: 0.8, grain: 0.5, flicker: 0.6, curvatureFloor: 0 },
  channelChangeSfx() { playTone({ freq: 440, duration: 45, type: 'triangle', gain: .05 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 160 : 520, endFreq: isOn ? 520 : 140, duration: 220, type: 'triangle', gain: .05 }); },
});
