const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;

// Skin for the cable-guide layout (renderer/css/cable-guide.css). `ui` turns
// that layout on while this is the box theme; `guideLayout: 'classic'` picks
// the SD-era structure (two-line cells, filled category cells, pill buttons,
// five guide rows).
window.RCBPlugins.registerThemePack('cable-guide-classic-05', {
  label: "CABLE GUIDE CLASSIC '05",
  group: 'CABLE GUIDE (NEW LAYOUT)',
  preview: { background: '#001b84', accent: '#eaef8b', secondary: '#92b8dd' },
  ui: 'cable-guide',
  guideLayout: 'classic',
  // A mid-2000s digital box on a tube set.
  crtBias: { scanlines: 0.7, vignette: 0.8, grain: 0.55, flicker: 0.4, curvatureFloor: 4 },
  staticStyle: 'quiet',
  guidePreviewDefault: true,
  captionStyle: {
    background: 'rgba(0, 18, 79, .88)', color: '#ffffff',
    fontFamily: "'Istok Web', 'Trebuchet MS', sans-serif", fontSize: '1.05em', padding: '.15em .4em',
    textShadow: '1px 1px #000000',
  },
  channelChangeSfx() {
    playNoiseBurst({ duration: 12, gain: 0.04, filterFreq: 1800 });
    playTone({ freq: 700, duration: 44, type: 'sine', gain: 0.04 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 330 : 760, endFreq: isOn ? 820 : 280, duration: 210, type: 'sine', gain: 0.04 });
  },
});
