// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('cable-box-osd', {
  label: 'CABLE BOX OSD (ANALOG TELETEXT)',
  // A real TV displaying an overlay menu — moderate CRT character, a touch
  // of curvature since consumer sets of this era were rarely flat.
  crtBias: { scanlines: 1.1, vignette: 1.1, grain: 1.1, flicker: 1.0, curvatureFloor: 10 },
});
