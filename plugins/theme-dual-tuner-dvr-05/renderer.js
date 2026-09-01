const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('dual-tuner-dvr-05', {
  label: "DUAL-TUNER DVR '05",
  group: 'REAL CABLE-BOX UI',
  preview: { background: '#06152d', accent: '#ffe65b', secondary: '#74b8e8' },
  crtBias: { scanlines: .82, vignette: .9, grain: .72, flicker: .58, curvatureFloor: 6 },
  staticStyle: 'quiet',
  guidePreviewDefault: true,
  captionStyle: {
    background: 'rgba(4, 12, 27, .88)', color: '#ffffff',
    fontFamily: 'Arial, sans-serif', fontSize: '1.05em', padding: '.18em .42em',
    textShadow: '1px 2px #000000',
  },
  channelChangeSfx() {
    playNoiseBurst({ duration: 14, gain: .045, filterFreq: 1800 });
    playTone({ freq: 660, duration: 46, type: 'sine', gain: .045 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 310 : 740, endFreq: isOn ? 820 : 260, duration: 230, type: 'sine', gain: .045 });
  },
});
