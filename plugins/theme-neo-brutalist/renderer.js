// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('neo-brutalist', {
  label: 'NEO-BRUTALIST (RAW CONSOLE)',
  // Not a period CRT pastiche — a flat raw-HTML aesthetic, so CRT texture
  // stays minimal rather than heavy.
  crtBias: { scanlines: 0.3, vignette: 0.3, grain: 0.4, flicker: 0.2, curvatureFloor: 0 },
});
