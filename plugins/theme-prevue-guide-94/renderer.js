// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('prevue-guide-94', {
  label: "SCROLLING GUIDE '94",
  group: 'REAL CABLE-BOX UI',
  preview: { background: '#060a1c', accent: '#ffd23f', secondary: '#8fa4ff' },
  // The oldest signal chain on the page (a headend Amiga's overlay
  // inserted onto a live analog feed) — the heaviest CRT bias of the nine.
  crtBias: { scanlines: 1.3, vignette: 1.3, grain: 1.6, flicker: 1.4, curvatureFloor: 20 },
  channelChangeSfx() { playNoiseBurst({ duration: 24, gain: .12, filterFreq: 1100 }); playTone({ freq: 420, duration: 55, type: 'square', gain: .045 }); },
  powerSfx(isOn) { playNoiseBurst({ duration: 32, gain: .13, filterFreq: 500 }); playTone({ freq: isOn ? 90 : 300, endFreq: isOn ? 300 : 70, duration: 260, type: 'triangle', gain: .05 }); },
});
