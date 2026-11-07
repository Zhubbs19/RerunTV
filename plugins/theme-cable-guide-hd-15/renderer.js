// Theme pack for the HD cable-guide skin: palette, layout choice, CRT bias and
// sounds. See plugins.js's registerThemePack doc comment for the fields.

const { playTone } = window.RCBPlugins.ctx;

// Skin for the cable-guide layout (renderer/css/cable-guide.css). `ui` turns
// that layout on while this is the box theme; `guideLayout: 'hd'` picks the
// HD structure (one-line cells, category edge ticks, square corners).
window.RCBPlugins.registerThemePack('cable-guide-hd-15', {
  label: "CABLE GUIDE HD '15",
  group: 'CABLE GUIDE (NEW LAYOUT)',
  preview: { background: '#010101', accent: '#207baa', secondary: '#3a9ad6' },
  ui: 'cable-guide',
  guideLayout: 'hd',
  // An HD flat panel: next to no CRT character.
  crtBias: { scanlines: 0.2, vignette: 0.3, grain: 0.15, flicker: 0.1, curvatureFloor: 0 },
  staticStyle: 'acquire',
  guidePreviewDefault: true,
  captionStyle: {
    background: 'rgba(1, 1, 1, .85)', color: '#ffffff',
    fontFamily: "'Roboto Condensed', Arial, sans-serif", fontSize: '1.05em', padding: '.15em .4em',
  },
  channelChangeSfx() {
    playTone({ freq: 880, duration: 40, type: 'sine', gain: 0.03 });
  },
  powerSfx(isOn) {
    playTone({ freq: isOn ? 520 : 880, endFreq: isOn ? 880 : 520, duration: 140, type: 'sine', gain: 0.03 });
  },
});
