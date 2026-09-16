const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.document = globalThis.document || { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

test('series DVR expands matching airings over the rolling window', async () => {
  const dvr = await load('personal/dvr.js');
  const start = new Date(2026, 0, 5).getTime();
  const channel = { number: 7, anchor: start, files: [
    { path: 'a.mkv', item: 'show', title: 'Pilot', duration: 1800, series: { name: 'Show' } },
    { path: 'b.mkv', item: 'other', title: 'Other', duration: 1800, series: { name: 'Other' } },
  ], blocks: [], broadcastHours: { enabled: false } };
  const rows = dvr.expandRecordingRequests([{ id: 'r', type: 'series', channel: 7, seriesId: 'Show', start, end: start + 1800000, enabled: true }], [channel], start, start + 7200000);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.title === 'Pilot'));
});

test('simulated tuner conflicts are optional', async () => {
  const dvr = await load('personal/dvr.js');
  const airings = [{ start: 0, end: 10 }, { start: 2, end: 8 }, { start: 3, end: 7 }];
  assert.deepEqual(dvr.recordingConflicts(airings, 0), []);
  assert.equal(dvr.recordingConflicts(airings, 2).length, 1);
});
