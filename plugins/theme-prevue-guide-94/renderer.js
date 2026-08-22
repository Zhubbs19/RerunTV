// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('prevue-guide-94', {
  label: "PREVUE GUIDE '94",
  // The oldest signal chain on the page (a headend Amiga's overlay
  // inserted onto a live analog feed) — the heaviest CRT bias of the nine.
  crtBias: { scanlines: 1.3, vignette: 1.3, grain: 1.6, flicker: 1.4, curvatureFloor: 20 },
});
