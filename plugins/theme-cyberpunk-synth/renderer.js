// Theme + border pack — pure CSS palette (style.css), no behavioral hooks:
// cyberpunk-synth was always one of the "pre-existing color-only" themes,
// unchanged by this migration. See plugins.js's registerThemePack doc
// comment for the full field contract.
const { playTone } = window.RCBPlugins.ctx;

window.RCBPlugins.registerThemePack('cyberpunk-synth', {
  group: 'STYLIZED',
  label: '80s NEON CYBERPUNK (SYNTHWAVE PINK/CYAN)',
  preview: { background: '#06020c', accent: '#ffbe0b', secondary: '#00f0ff' },
  borderImage: new URL('./border.svg', import.meta.url).href,
  channelChangeSfx() { playTone({ freq: 220, endFreq: 1320, duration: 130, type: 'sawtooth', gain: .045 }); },
  powerSfx(isOn) { playTone({ freq: isOn ? 110 : 880, endFreq: isOn ? 880 : 90, duration: 330, type: 'sawtooth', gain: .045 }); },
});
