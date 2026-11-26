// guide/program-search.js: title matches first, and each result says where it matched.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.window.api = globalThis.window.api || {};
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

test('title matches come first, and description and tag matches say so', async () => {
  const { searchUpcomingPrograms } = await load('guide/program-search.js');
  const anchor = Date.UTC(2026, 0, 1);
  const channel = {
    number: 5,
    name: 'Movies',
    anchor,
    files: [
      { path: 'a.mp4', title: 'The Singer', duration: 3600, description: 'A rock star on tour.' },
      { path: 'b.mp4', title: 'Boulder Run', duration: 3600, tags: ['rock-climbing'] },
      { path: 'c.mp4', title: 'Rocky', duration: 3600 },
      { path: 'd.mp4', title: 'Quiet Pond', duration: 3600 },
    ],
  };
  const results = searchUpcomingPrograms([channel], 'ROCK', anchor, { horizonMs: 4 * 3600000 });
  assert.deepEqual(results.map((r) => [r.title, r.match]), [
    ['Rocky', 'title'],
    ['The Singer', 'description'],
    ['Boulder Run', 'tags'],
  ]);
});
