// viewNow() freeze (core/state.js): a parked time machine scrub stands still until something else moves the offset.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', 'state.js')).href);

test('a frozen view does not advance with the wall clock', async () => {
  const { S, viewNow } = await load();
  const target = Date.now() - 3600000;
  S.timeOffsetMs = target - Date.now();
  S.frozenViewMs = target;
  S.frozenOffsetMs = S.timeOffsetMs;
  const a = viewNow();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(viewNow(), a);
  assert.equal(a, target);
  S.frozenViewMs = null; S.timeOffsetMs = 0;
});

test('any other write to the offset ends the freeze', async () => {
  const { S, viewNow } = await load();
  const target = Date.now() - 3600000;
  S.timeOffsetMs = target - Date.now();
  S.frozenViewMs = target;
  S.frozenOffsetMs = S.timeOffsetMs;
  S.timeOffsetMs += 5000; // the shuttle, the guide, an air check
  const v = viewNow();
  assert.ok(Math.abs(v - (Date.now() + S.timeOffsetMs)) < 50);
  S.frozenViewMs = null; S.timeOffsetMs = 0;
});

test('with no freeze, the clock runs as before', async () => {
  const { S, viewNow } = await load();
  S.frozenViewMs = null; S.timeOffsetMs = 1000;
  assert.ok(Math.abs(viewNow() - (Date.now() + 1000)) < 50);
  S.timeOffsetMs = 0;
});
