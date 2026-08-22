// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('frutiger-aero', {
  label: 'FRUTIGER AERO (GLOSSY 2000s OPTIMISM)',
  // A glossy flat panel — the least CRT-like bias on the page, on purpose.
  crtBias: { scanlines: 0.3, vignette: 0.35, grain: 0.2, flicker: 0.2, curvatureFloor: 0 },
});
