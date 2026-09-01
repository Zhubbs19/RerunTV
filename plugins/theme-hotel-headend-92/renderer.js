const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('hotel-headend-92', {
  label: "HOTEL HEADEND '92",
  group: 'REAL CABLE-BOX UI',
  preview: { background: '#082f35', accent: '#ffd86a', secondary: '#85e1d0' },
  crtBias: { scanlines: 1.16, vignette: 1.2, grain: 1.12, flicker: 1.02, curvatureFloor: 14 },
  staticStyle: 'soft',
  guidePreviewDefault: false,
  captionStyle: {
    background: '#06333a', color: '#fff7d7', fontFamily: 'Arial, sans-serif',
    fontSize: '1.15em', textTransform: 'uppercase', padding: '.2em .45em',
    textShadow: '2px 2px #00191d',
  },
  channelChangeSfx() {
    playNoiseBurst({ duration: 24, gain: .065, filterFreq: 1250 });
    playTone({ freq: 430, duration: 54, type: 'square', gain: .04 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 170 : 520, endFreq: isOn ? 560 : 140, duration: 205, type: 'triangle', gain: .05 });
  },
});
