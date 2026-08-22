// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). See plugins.js's registerThemePack
// doc comment for the full field contract.
window.RCBPlugins.registerThemePack('cloud-guide-16', {
  label: "CLOUD GUIDE '16",
  // A modern flat panel rendering a cloud-composited guide — minimal CRT
  // character, same territory as Ops Dashboard.
  crtBias: { scanlines: 0.3, vignette: 0.4, grain: 0.2, flicker: 0.2, curvatureFloor: 0 },
});
