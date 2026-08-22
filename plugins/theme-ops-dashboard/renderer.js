// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('ops-dashboard', {
  label: 'OPS DASHBOARD (BROADCAST AUTOMATION)',
  // A modern flat panel — almost no CRT character at all, the cleanest bias
  // of the nine.
  crtBias: { scanlines: 0.4, vignette: 0.5, grain: 0.3, flicker: 0.3, curvatureFloor: 0 },
});
