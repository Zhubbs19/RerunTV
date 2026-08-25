// Theme + border pack — pure CSS palette (style.css), no behavioral hooks:
// midnight-oled was always one of the "pre-existing color-only" themes,
// unchanged by this migration. See plugins.js's registerThemePack doc
// comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;
window.RCBPlugins.registerThemePack('midnight-oled', {
  label: 'MIDNIGHT LUXURY (OLED INDIGO & GLASS)',
  group: 'STYLIZED',
  preview: { background: '#030406', accent: '#818cf8', secondary: '#38bdf8' },
  borderImage: new URL('./border.svg', import.meta.url).href,
  channelChangeSfx() { playTone({ freq: 520, endFreq: 760, duration: 90, type: 'sine', gain: .028 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 320 : 720, endFreq: isOn ? 720 : 280, duration: 180, type: 'sine', gain: .028 }); },
});
