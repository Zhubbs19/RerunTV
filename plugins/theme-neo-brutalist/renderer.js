// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('neo-brutalist', {
  label: 'NEO-BRUTALIST (RAW CONSOLE)',
  group: 'STYLIZED',
  preview: { background: '#ffffff', accent: '#8a7000', secondary: '#d61f56' },
  // Not a period CRT pastiche — a flat raw-HTML aesthetic, so CRT texture
  // stays minimal rather than heavy.
  crtBias: { scanlines: 0.3, vignette: 0.3, grain: 0.4, flicker: 0.2, curvatureFloor: 0 },
  channelChangeSfx() { playNoiseBurst({ duration: 12, gain: .1, filterFreq: 900 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 120 : 260, endFreq: isOn ? 260 : 90, duration: 120, type: 'square', gain: .07 }); },
});
