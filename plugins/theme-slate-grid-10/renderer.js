const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('slate-grid-10', {
  label: "SLATE GRID '10",
  preview: { background: '#0b1019', accent: '#d9ed3f', secondary: '#43a7ff' },
  group: 'REAL CABLE-BOX UI',
  crtBias: { scanlines: 0.75, vignette: 0.8, grain: 0.4, flicker: 0.3, curvatureFloor: 3 },
  staticStyle: 'quiet',
  channelChangeSfx() {
    playNoiseBurst({ duration: 14, gain: 0.07, filterFreq: 1200 });
    playTone({ freq: 520, endFreq: 760, duration: 65, type: 'triangle', gain: 0.06 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 220 : 760, endFreq: isOn ? 760 : 180, duration: 220, type: 'triangle', gain: 0.065 });
  },
});
