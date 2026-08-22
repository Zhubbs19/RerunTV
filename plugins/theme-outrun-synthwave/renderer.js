// Theme pack — palette (style.css) plus a CRT bias and a custom power-on/
// off line animation (also style.css). Distinct from the pre-existing
// "cyberpunk-synth" pack (violet/pink/cyan, angular, ITC-style borderImage)
// — this one leans darker/blacker with magenta as the dominant accent and
// a softer neon glow rather than a hard edge. See plugins.js's
// registerThemePack doc comment for the full field contract.
window.RCBPlugins.registerThemePack('outrun-synthwave', {
  label: 'OUTRUN SYNTHWAVE (SINCERE 80s NEON)',
  // An arcade-cabinet monitor — glowing, moderately curved, a bit soft.
  crtBias: { scanlines: 1.2, vignette: 1.3, grain: 0.8, flicker: 0.9, curvatureFloor: 18 },
});
