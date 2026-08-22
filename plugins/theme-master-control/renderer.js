// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('master-control', {
  label: 'MASTER CONTROL (AMBER BROADCAST CONSOLE)',
  // A clean broadcast reference monitor — light on scanline/vignette/grain,
  // no curvature floor. The calmest, least-distorted bias of the nine.
  crtBias: { scanlines: 0.7, vignette: 0.8, grain: 0.5, flicker: 0.6, curvatureFloor: 0 },
});
