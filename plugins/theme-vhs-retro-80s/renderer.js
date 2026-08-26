// Theme + border pack — pure CSS palette (style.css), no behavioral hooks:
// vhs-retro-80s was always one of the "pre-existing color-only" themes,
// unchanged by this migration. See plugins.js's registerThemePack doc
// comment for the full field contract.
const { playNoiseBurst, playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('vhs-retro-80s', {
  label: '80s RADICAL VHS (HOT CORAL & PURPLE)',
  group: 'STYLIZED',
  preview: { background: '#090514', accent: '#ffe600', secondary: '#33ffff' },
  borderImage: new URL('./border.svg', import.meta.url).href,
  // 80s VHS-era box — no picture-in-picture.
  guidePreviewDefault: false,
  channelChangeSfx() { playNoiseBurst({ duration: 28, gain: .13, filterFreq: 800 }); playTone({ freq: 180, endFreq: 90, duration: 100, type: 'triangle', gain: .05 }); },
  powerSfx(isOn) { playNoiseBurst({ duration: 38, gain: .14, filterFreq: 380 }); playTone({ freq: isOn ? 70 : 220, endFreq: isOn ? 220 : 60, duration: 300, type: 'triangle', gain: .05 }); },
});
