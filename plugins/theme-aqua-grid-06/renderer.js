const { playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('aqua-grid-06', {
  label: "AQUA GRID '06",
  preview: { background: '#03263e', accent: '#dff27d', secondary: '#69d7e6' },
  group: 'REAL CABLE-BOX UI',
  crtBias: { scanlines: 1.1, vignette: 1.05, grain: 0.8, flicker: 0.55, curvatureFloor: 7 },
  staticStyle: 'quiet',
  channelChangeSfx() {
    playTone({ freq: 880, duration: 42, type: 'square', gain: 0.065 });
    setTimeout(() => playTone({ freq: 1320, duration: 48, type: 'square', gain: 0.055 }), 44);
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 420 : 1100, endFreq: isOn ? 1100 : 360, duration: 180, type: 'square', gain: 0.055 });
  },
  ambientTexture: { type: 'tone', freq: 7800, gain: 0.003 },
  captionStyle: {
    background: 'rgba(0, 20, 45, .9)', color: '#fff',
    fontFamily: "'Archivo Narrow', sans-serif", fontSize: '4.4cqw', padding: '.12em .3em',
  },
});
