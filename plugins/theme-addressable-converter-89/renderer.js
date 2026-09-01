const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('addressable-converter-89', {
  label: "ADDRESSABLE CONVERTER '89",
  group: 'REAL CABLE-BOX UI',
  preview: { background: '#090909', accent: '#ffb000', secondary: '#ff4136' },
  crtBias: { scanlines: 1.2, vignette: 1.18, grain: 1.16, flicker: 1.08, curvatureFloor: 13 },
  staticStyle: 'coarse',
  guidePreviewDefault: false,
  captionStyle: {
    background: '#000000', color: '#ffb000',
    fontFamily: 'monospace', fontSize: '1.15em', textTransform: 'uppercase',
    padding: '0.15em 0.35em', textShadow: '2px 2px #000000',
  },
  channelChangeSfx() {
    playNoiseBurst({ duration: 30, gain: 0.09, filterFreq: 1050 });
    playTone({ freq: 920, duration: 38, type: 'square', gain: 0.045 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 120 : 480, endFreq: isOn ? 420 : 90, duration: 170, type: 'square', gain: 0.05 });
  },
});
