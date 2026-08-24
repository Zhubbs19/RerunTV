// Theme + border pack — pure CSS palette (style.css), no behavioral hooks:
// emerald-matrix was always one of the "pre-existing color-only" themes,
// unchanged by this migration. See plugins.js's registerThemePack doc
// comment for the full field contract.
window.RCBPlugins.registerThemePack('emerald-matrix', {
  group: 'STYLIZED',
  label: '90s CYBER TERMINAL (MATRIX PHOSPHOR GREEN)',
  borderImage: new URL('./border.svg', import.meta.url).href,
});
