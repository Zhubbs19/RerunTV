// Theme + border pack — pure CSS palette (style.css), no behavioral hooks:
// cyberpunk-synth was always one of the "pre-existing color-only" themes,
// unchanged by this migration. See plugins.js's registerThemePack doc
// comment for the full field contract.
window.RCBPlugins.registerThemePack('cyberpunk-synth', {
  group: 'STYLIZED',
  label: '80s NEON CYBERPUNK (SYNTHWAVE PINK/CYAN)',
  borderImage: new URL('./border.svg', import.meta.url).href,
});
