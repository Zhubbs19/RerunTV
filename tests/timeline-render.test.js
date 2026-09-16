// timeline-render.js — placement shared by ON AIR, the guide and the scrubber.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'timeline/render.js')).href);

test('spans clamp to the window and convert to percentages', async () => {
  const { clampSpan, spanPercent } = await load();
  assert.deepEqual(clampSpan(-5, 5, 0, 100), { start: 0, end: 5 });
  assert.equal(clampSpan(100, 120, 0, 100), null);
  assert.deepEqual(spanPercent(25, 75, 0, 100), { left: 25, width: 50 });
  assert.deepEqual(spanPercent(50, 50.1, 0, 100, { minWidthPct: 0.5 }), { left: 50, width: 0.5 });
  assert.equal(spanPercent(0, 10, 20, 30), null);
});

test('pointer fractions map to times, clamped', async () => {
  const { timeAtFraction, breakMarkClass } = await load();
  assert.equal(timeAtFraction(0.5, 1000, 2000), 1500);
  assert.equal(timeAtFraction(-1, 1000, 2000), 1000);
  assert.equal(timeAtFraction(3, 1000, 2000), 2000);
  assert.equal(timeAtFraction(NaN, 1000, 2000), 1000);
  assert.equal(breakMarkClass('channelId'), 'tl-break tl-break-channelId');
});
