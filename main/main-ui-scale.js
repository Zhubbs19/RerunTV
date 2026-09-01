// App-wide interface scaling for high-resolution displays. BrowserWindow
// bounds are expressed in device-independent pixels, so this naturally
// respects Windows/macOS display scaling: a 4K TV at 100% still reports a
// very large canvas and gets enlarged UI, while a 4K desktop already set to
// 200% reports roughly a 1080p-sized canvas and does not get scaled twice.

const UI_SCALE_FACTORS = Object.freeze({
  '100': 1,
  '125': 1.25,
  '150': 1.5,
  '175': 1.75,
  '200': 2,
});

function autoUiScaleForBounds({ width = 0, height = 0 } = {}) {
  // The interface was originally tuned around a 1600x900 canvas. Scale in
  // discrete steps so small window resizes do not make text subtly breathe.
  const fit = Math.min(width / 1600, height / 900);
  if (fit >= 2) return 2;
  if (fit >= 1.7) return 1.75;
  if (fit >= 1.45) return 1.5;
  if (fit >= 1.2) return 1.25;
  return 1;
}

function resolveUiScale(preference, bounds) {
  return UI_SCALE_FACTORS[String(preference)] || autoUiScaleForBounds(bounds);
}

function normalizeUiScalePreference(preference) {
  const value = String(preference || 'auto');
  return value === 'auto' || Object.prototype.hasOwnProperty.call(UI_SCALE_FACTORS, value)
    ? value
    : 'auto';
}

function applyWindowUiScale(window, preference = 'auto') {
  if (!window || window.isDestroyed()) return 1;
  const normalized = normalizeUiScalePreference(preference);
  const factor = resolveUiScale(normalized, window.getContentBounds());
  if (window.webContents.getZoomFactor() !== factor) window.webContents.setZoomFactor(factor);
  return factor;
}

module.exports = {
  UI_SCALE_FACTORS,
  applyWindowUiScale,
  autoUiScaleForBounds,
  normalizeUiScalePreference,
  resolveUiScale,
};
