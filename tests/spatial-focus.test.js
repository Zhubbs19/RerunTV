// ui/spatial-focus.js — D-pad focus moves to the nearest control that way,
// and dialogs default to a safe action (docs/design/01 §6.6).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'ui', 'spatial-focus.js')).href);

// A 3×2 grid of 100×40 buttons with 10 px gaps.
const grid = [0, 1, 2, 3, 4, 5].map((i) => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 50, width: 100, height: 40 }));

test('arrows move to the neighbour in that direction, and stop at an edge', async () => {
  const { nextSpatialIndex } = await load();
  assert.equal(nextSpatialIndex(grid, 0, 'right'), 1);
  assert.equal(nextSpatialIndex(grid, 0, 'down'), 3);
  assert.equal(nextSpatialIndex(grid, 4, 'up'), 1, 'straight up, not diagonal');
  assert.equal(nextSpatialIndex(grid, 5, 'left'), 4);
  assert.equal(nextSpatialIndex(grid, 2, 'right'), 2, 'nothing further right');
  assert.equal(nextSpatialIndex(grid, 0, 'up'), 0);
  assert.equal(nextSpatialIndex([], 0, 'up'), -1);
});

test('a vertical list and a row both work', async () => {
  const { nextSpatialIndex } = await load();
  const list = [0, 1, 2].map((i) => ({ left: 0, top: i * 60, width: 300, height: 50 }));
  assert.equal(nextSpatialIndex(list, 1, 'down'), 2);
  assert.equal(nextSpatialIndex(list, 1, 'up'), 0);
  assert.equal(nextSpatialIndex(list, 1, 'right'), 1);
  const row = [0, 1, 2].map((i) => ({ left: i * 160, top: 0, width: 150, height: 50 }));
  assert.equal(nextSpatialIndex(row, 0, 'right'), 1);
  assert.equal(nextSpatialIndex(row, 2, 'left'), 1);
});

test('a dialog defaults to its marked action, else the first safe one', async () => {
  const { defaultFocusIndex } = await load();
  assert.equal(defaultFocusIndex([{ isDanger: true }, { isDanger: false }]), 1);
  assert.equal(defaultFocusIndex([{}, { isDefault: true }]), 1);
  assert.equal(defaultFocusIndex([{ isDanger: true }]), 0);
});
