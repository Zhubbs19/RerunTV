// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('passport-03', {
  label: "PASSPORT '03",
  // A newer set than Prevue's era but still a real tube — moderate bias.
  crtBias: { scanlines: 1.1, vignette: 1.15, grain: 1.2, flicker: 1.1, curvatureFloor: 12 },
});
