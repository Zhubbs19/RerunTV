// Theme + border pack — see plugins.js's registerThemePack doc comment for
// the full field contract. This era has a CSS palette (style.css) plus one
// behavioral hook migrated from the old core THEME_TEXTURE_PROFILES
// (renderer/js's vintage-audio plugin) — ambient tape-hiss texture. No
// crtBias/staticStyle/channelChangeSfx/powerSfx: analog-90s was always one
// of the "pre-existing color-only" themes for those, unchanged by this
// migration — the field is simply omitted, which core's registry lookups
// treat identically to "no pack registered" for that field.
window.RCBPlugins.registerThemePack('analog-90s', {
  label: 'ANALOG BARKER (EARLY 90s AMBER)',
  group: 'ERA (BY DECADE)',
  preview: { background: '#000000', accent: '#ffb000', secondary: '#4be37a' },
  borderImage: new URL('./border.svg', import.meta.url).href,
});
