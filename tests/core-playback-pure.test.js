// Pure pieces of the playback audit fixes: setViewedTime/canPlay (core/state.js), the drift
// watchdog's decision (playback/drift-model.js), viewing-history dedupe (playback/history.js)
// and per-pad gamepad mappers (tv/gamepad.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

test('setViewedTime is absolute: a parked scrub no longer makes a jump land short', async () => {
  const { S, viewNow, setViewedTime } = await load('core/state.js');
  S.timeOffsetMs = 0;
  // A scrub parked 10 minutes back, then left alone while the wall clock runs on.
  const frozenAt = Date.now() - 10 * 60000;
  S.timeOffsetMs = frozenAt - Date.now();
  S.frozenOffsetMs = S.timeOffsetMs;
  S.frozenViewMs = frozenAt;
  assert.equal(viewNow(), frozenAt, 'frozen view stands still');
  await new Promise((r) => setTimeout(r, 40)); // wall clock moves on

  // The old relative form: offset += target - viewNow(), where viewNow() is the frozen moment.
  const target = Date.now() - 30 * 60000;
  const relative = S.timeOffsetMs + (target - viewNow());
  S.frozenViewMs = null; // relative form's result, read once the freeze is dropped
  const relativeLands = Date.now() + relative;
  assert.ok(Math.abs(relativeLands - target) >= 20, 'relative form drifts by the time spent parked');

  S.frozenViewMs = frozenAt;
  S.frozenOffsetMs = S.timeOffsetMs;
  setViewedTime(target);
  assert.equal(S.frozenViewMs, null, 'freeze dropped');
  assert.ok(Math.abs(viewNow() - target) < 25, 'lands on the target');
  S.timeOffsetMs = 0;
});

test('setViewedTime ignores a non-finite target and canPlay needs power and no Setup', async () => {
  const { S, setViewedTime, canPlay } = await load('core/state.js');
  S.timeOffsetMs = 1234;
  setViewedTime(NaN);
  assert.equal(S.timeOffsetMs, 1234);
  S.timeOffsetMs = 0;
  S.isPoweredOn = true; S.isSetupOpen = false;
  assert.equal(canPlay(), true);
  S.isSetupOpen = true;
  assert.equal(canPlay(), false);
  S.isSetupOpen = false; S.isPoweredOn = false;
  assert.equal(canPlay(), false);
  S.isPoweredOn = true;
});

test('the drift watchdog resumes a paused player, nudges a starved one and seeks a drifted one', async () => {
  const { decideDriftAction } = await load('playback/drift-model.js');
  const base = { paused: false, seeking: false, ended: false, readyState: 4, currentTime: 100, duration: 1500, expected: 100.5, stallTicks: 0 };
  assert.equal(decideDriftAction(base), 'none');
  assert.equal(decideDriftAction({ ...base, paused: true }), 'resume');
  assert.equal(decideDriftAction({ ...base, paused: true, readyState: 0 }), 'none', 'nothing loaded to resume');
  assert.equal(decideDriftAction({ ...base, paused: true, expected: 1498 }), 'none', 'tail guard');
  assert.equal(decideDriftAction({ ...base, seeking: true, paused: true }), 'none');
  assert.equal(decideDriftAction({ ...base, ended: true, paused: true }), 'none');
  assert.equal(decideDriftAction({ ...base, readyState: 2 }), 'none', 'first starved tick only counts');
  assert.equal(decideDriftAction({ ...base, readyState: 2, stallTicks: 1 }), 'nudge');
  assert.equal(decideDriftAction({ ...base, expected: 110 }), 'seek');
  assert.equal(decideDriftAction({ ...base, expected: 1499 }), 'none');
  assert.equal(decideDriftAction({ ...base, duration: NaN }), 'none');
  assert.equal(decideDriftAction({ ...base, expected: NaN }), 'none');
});

test('viewing history skips a post-break retune of the same programme but not a new airing', async () => {
  const history = await load('playback/history.js');
  const rows = [];
  globalThis.window.api = { historyAppend: (entry) => { rows.push(entry); return Promise.resolve(); } };
  history.resetViewingDedupe();
  const ch = { number: 12, name: 'Twelve' };
  const file = { path: 'show.mp4', duration: 1500 };
  const start = 1_700_000_000_000;

  history.recordViewing(ch, file, start);
  history.recordViewing(ch, file, start + 300);   // resumed after a break: float-noise sized difference
  history.recordViewing(ch, file, start + 1500);  // within the 2s tolerance
  assert.equal(rows.length, 1, 'same airing logged once');

  history.recordViewing(ch, file, start + 60 * 60000); // the next loop of the same file
  assert.equal(rows.length, 2, 'a genuinely new airing logs again');

  history.recordViewing({ number: 13 }, file, start + 60 * 60000);
  assert.equal(rows.length, 3, 'a different channel logs');

  history.recordViewing(ch, file); // no start supplied: old behaviour, always records
  history.recordViewing(ch, file);
  assert.equal(rows.length, 5);
  assert.equal(history.isSameViewing(null, { channelNumber: 1 }), false);
});

test('each gamepad gets its own mapper, so one pad\'s hold cannot mask another\'s press', async () => {
  const { createPadMappers } = await load('tv/gamepad.js');
  const mappers = createPadMappers();
  const pressedA = { index: 0, id: 'pad-a', buttons: [{ pressed: true }], axes: [0, 0] };
  const pressedB = { index: 1, id: 'pad-b', buttons: [{ pressed: true }], axes: [0, 0] };

  assert.deepEqual(mappers.update(pressedA, 0).map((e) => e.key), ['ok']);
  // With a shared mapper this second pad's A would read as still held by the first.
  assert.deepEqual(mappers.update(pressedB, 1).map((e) => e.key), ['ok']);
  assert.equal(mappers.size(), 2);

  // Pad A releases; pad B's hold must survive that.
  mappers.update({ ...pressedA, buttons: [{ pressed: false }] }, 20);
  assert.deepEqual(mappers.update(pressedB, 40), [], 'B is still held, not re-fired');

  mappers.prune([pressedB]);
  assert.equal(mappers.size(), 1, 'a disconnected pad is dropped');
});
