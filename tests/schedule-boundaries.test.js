// schedule.js boundary math: the daily/weekly fast path must still notice a
// different block taking over, never return a time at/before fromMs, and the
// DST / wraparound edge cases of the broadcast-hours gate stay finite.
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const HOUR = 3600000;
const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.mp4`, duration: 1200 }));

function chan(extra = {}) {
  return { number: 5, name: 'T', anchor: new Date(2026, 0, 1).getTime(), blocks: [], files: files(3), ...extra };
}

test('nextSourceBoundary: DST fall-back day stays strictly after fromMs', async () => {
  const sched = await load('core/schedule.js');
  const ch = chan({
    blocks: [{
      id: 'd', mode: 'daily', priority: 1, anchor: new Date(2026, 9, 1).getTime(), files: files(40),
      trigger: { type: 'dateRange', startMonth: 10, startDay: 1, endMonth: 12, endDay: 31 },
    }],
  });
  const dayStart = new Date(2026, 10, 1, 0, 0, 0, 0).getTime(); // 25-hour day
  for (let h = 0; h < 26; h++) {
    const from = dayStart + h * HOUR;
    const next = sched.nextSourceBoundary(ch, from);
    assert.ok(next > from, `boundary after ${new Date(from).toISOString()}`);
  }
});

test('nextSourceBoundary: another block taking over before the daily unlock is detected', async () => {
  const sched = await load('core/schedule.js');
  const ch = chan({
    blocks: [
      {
        id: 'd', mode: 'daily', priority: 1, anchor: new Date(2026, 9, 1).getTime(), files: files(40),
        trigger: { type: 'dateRange', startMonth: 10, startDay: 1, endMonth: 12, endDay: 31 },
      },
      {
        id: 'hi', priority: 5, anchor: new Date(2026, 9, 1).getTime(), files: files(2),
        trigger: { type: 'dayOfWeek', startHour: 14, endHour: 16 },
      },
    ],
  });
  const from = new Date(2026, 9, 10, 9, 0, 0, 0).getTime();
  assert.equal(sched.resolveActiveSource(ch, from).key.toString().startsWith('d'), true);
  const next = sched.nextSourceBoundary(ch, from);
  assert.equal(next, new Date(2026, 9, 10, 14, 0, 0, 0).getTime());
});

test('nextBroadcastHoursBoundary: finite on the DST day and wraps midnight', async () => {
  const sched = await load('core/schedule.js');
  const ch = chan({ broadcastHours: { enabled: true, startHour: 6, endHour: 2 } });
  const dayStart = new Date(2026, 10, 1, 0, 0, 0, 0).getTime();
  for (let h = 0; h < 26; h++) {
    const from = dayStart + h * HOUR;
    const next = sched.nextBroadcastHoursBoundary(ch, from);
    assert.ok(Number.isFinite(next) && next > from, `finite boundary from ${new Date(from).toISOString()}`);
  }
  // 23:00 is on air; the next flip is the 02:00 sign-off the next day.
  const from = new Date(2026, 9, 10, 23, 0, 0, 0).getTime();
  assert.equal(sched.nextBroadcastHoursBoundary(ch, from), new Date(2026, 9, 11, 2, 0, 0, 0).getTime());
});

test('pickDeterministic: same args, same pick; negative slots wrap', async () => {
  const inter = await load('core/interstitials.js');
  const pool = [{ id: 'a', weight: 2 }, { id: 'b' }, { id: 'c', weight: 3 }];
  for (let slot = -7; slot < 20; slot++) {
    assert.equal(inter.pickDeterministic(pool, 'seed', slot), inter.pickDeterministic(pool, 'seed', slot));
    assert.ok(inter.pickDeterministic(pool, 'seed', slot));
  }
  assert.equal(inter.pickDeterministic([], 'seed', 3), null);
});

test('boundarySlot: ordinal wraps cleanly across the loop point', async () => {
  const inter = await load('core/interstitials.js');
  const A = 1000000;
  const source = { files: files(3), anchor: A };
  const total = 3 * 1200 * 1000;
  const last = inter.boundarySlot(source, A + total - 1000);
  const first = inter.boundarySlot(source, A + total + 1000);
  assert.equal(last.ordinal, 2);
  assert.equal(first.ordinal, 3);
  assert.ok(first.fileStartMs === A + total && last.fileEndMs === A + total);
});
