// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). Distinct from the pre-existing
// "cyberpunk-synth" pack (violet/pink/cyan, angular, ITC-style borderImage)
// — this one leans darker/blacker with magenta as the dominant accent and
// a softer neon glow rather than a hard edge. See plugins.js's
// registerThemePack doc comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('outrun-synthwave', {
  label: 'OUTRUN SYNTHWAVE (SINCERE 80s NEON)',
  group: 'STYLIZED',
  preview: { background: '#0d0221', accent: '#ff2ec4', secondary: '#2ee6ff' },
  // An arcade-cabinet monitor — glowing, moderately curved, a bit soft.
  crtBias: { scanlines: 1.2, vignette: 1.3, grain: 0.8, flicker: 0.9, curvatureFloor: 18 },
  channelChangeSfx() { playTone({ freq: 110, endFreq: 660, duration: 150, type: 'sawtooth', gain: .045 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 80 : 620, endFreq: isOn ? 620 : 70, duration: 380, type: 'sawtooth', gain: .04 }); },
});
