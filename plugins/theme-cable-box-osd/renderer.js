// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('cable-box-osd', {
  label: 'CABLE BOX OSD (ANALOG TELETEXT)',
  group: 'ERA (BY DECADE)',
  preview: { background: '#000000', accent: '#ffe33d', secondary: '#35f4e6' },
  // A real TV displaying an overlay menu — moderate CRT character, a touch
  // of curvature since consumer sets of this era were rarely flat.
  crtBias: { scanlines: 1.1, vignette: 1.1, grain: 1.1, flicker: 1.0, curvatureFloor: 10 },
  channelChangeSfx() { playTone({ freq: 540, duration: 55, type: 'square', gain: .06 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 180 : 620, endFreq: isOn ? 620 : 150, duration: 190, type: 'square', gain: .055 }); },
});
