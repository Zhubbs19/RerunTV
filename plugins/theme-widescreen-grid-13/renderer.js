const { playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('widescreen-grid-13', {
  label: "WIDESCREEN GRID '13",
  preview: { background: '#06132f', accent: '#f6d34a', secondary: '#76a8ff' },
  group: 'REAL CABLE-BOX UI',
  crtBias: { scanlines: 0.35, vignette: 0.5, grain: 0.2, flicker: 0.15, curvatureFloor: 0 },
  staticStyle: 'acquire',
  channelChangeSfx() {
    playTone({ freq: 660, duration: 45, type: 'sine', gain: 0.05 });
    setTimeout(() => playTone({ freq: 990, duration: 70, type: 'sine', gain: 0.05 }), 40);
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 300 : 900, endFreq: isOn ? 900 : 260, duration: 190, type: 'sine', gain: 0.05 });
  },
  ambientTexture: { type: 'tone', freq: 8900, gain: 0.002 },
});
