const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyWindowUiScale,
  autoUiScaleForBounds,
  normalizeUiScalePreference,
  resolveUiScale,
} = require('../main/ui/scale');

test('automatic interface scale grows on high-resolution display canvases', () => {
  assert.equal(autoUiScaleForBounds({ width: 1600, height: 900 }), 1);
  assert.equal(autoUiScaleForBounds({ width: 1920, height: 1080 }), 1.25);
  assert.equal(autoUiScaleForBounds({ width: 2560, height: 1440 }), 1.5);
  assert.equal(autoUiScaleForBounds({ width: 3840, height: 2160 }), 2);
});

test('interface scale uses the limiting dimension and accepts manual overrides', () => {
  assert.equal(autoUiScaleForBounds({ width: 3840, height: 900 }), 1);
  assert.equal(resolveUiScale('175', { width: 1280, height: 720 }), 1.75);
  assert.equal(normalizeUiScalePreference('999'), 'auto');
});

test('window scaling applies only when the resolved factor changes', () => {
  let zoomFactor = 1;
  let updates = 0;
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 3840, height: 2160 }),
    webContents: {
      getZoomFactor: () => zoomFactor,
      setZoomFactor: (value) => { zoomFactor = value; updates += 1; },
    },
  };
  assert.equal(applyWindowUiScale(window, 'auto'), 2);
  assert.equal(applyWindowUiScale(window, 'auto'), 2);
  assert.equal(updates, 1);
});
