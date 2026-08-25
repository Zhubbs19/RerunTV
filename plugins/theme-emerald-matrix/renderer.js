// Theme + border pack — pure CSS palette (style.css), no behavioral hooks:
// emerald-matrix was always one of the "pre-existing color-only" themes,
// unchanged by this migration. See plugins.js's registerThemePack doc
// comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('emerald-matrix', {
  group: 'STYLIZED',
  label: '90s CYBER TERMINAL (MATRIX PHOSPHOR GREEN)',
  preview: { background: '#000502', accent: '#a3ff12', secondary: '#00ff66' },
  borderImage: new URL('./border.svg', import.meta.url).href,
  channelChangeSfx() { playTone({ freq: 1500, duration: 35, type: 'square', gain: .04 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 240 : 1200, endFreq: isOn ? 1200 : 180, duration: 180, type: 'square', gain: .04 }); },
});
