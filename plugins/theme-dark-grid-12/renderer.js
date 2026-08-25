const { playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('dark-grid-12', {
  label: "DARK GRID '12",
  preview: { background: '#030407', accent: '#55d8ff', secondary: '#8b79ff' },
  group: 'REAL CABLE-BOX UI',
  crtBias: { scanlines: 0.5, vignette: 0.65, grain: 0.25, flicker: 0.2, curvatureFloor: 0 },
  staticStyle: 'acquire',
  channelChangeSfx() {
    playTone({ freq: 960, duration: 34, type: 'sine', gain: 0.045 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 360 : 720, endFreq: isOn ? 720 : 280, duration: 150, type: 'sine', gain: 0.045 });
  },
  ambientTexture: { type: 'tone', freq: 6200, gain: 0.0025 },
});
