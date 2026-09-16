// tv-suggest.js — the "Switch to TV mode?" suggestion only appears for a
// fullscreen, pointer-free, remote-driven session, and never in TV mode
// (docs/design/01 §4). Plus doc 01 §6.2's guide colour keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { documentElement: { dataset: {} } };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const base = { mode: 'desktop', fullscreen: true, dismissed: false, pointerAt: false, remoteKeys: 5, firstRemoteAt: 0, now: 12000 };

test('suggests only for a fullscreen session driven by arrows alone for 10 s', async () => {
  const { shouldSuggestTvMode, isRemoteLikeKey } = await load('tv/suggest.js');
  assert.equal(shouldSuggestTvMode(base), true);
  assert.equal(shouldSuggestTvMode({ ...base, now: 9000 }), false, 'not yet 10 s');
  assert.equal(shouldSuggestTvMode({ ...base, pointerAt: true }), false, 'a pointer means a desk');
  assert.equal(shouldSuggestTvMode({ ...base, fullscreen: false }), false);
  assert.equal(shouldSuggestTvMode({ ...base, mode: 'tv' }), false);
  assert.equal(shouldSuggestTvMode({ ...base, dismissed: true }), false);
  assert.equal(shouldSuggestTvMode({ ...base, remoteKeys: 2 }), false);
  assert.equal(shouldSuggestTvMode({ ...base, firstRemoteAt: null }), false);
  assert.equal(isRemoteLikeKey('ArrowLeft'), true);
  assert.equal(isRemoteLikeKey('g'), false);
});

test('guide colour keys follow doc 01 §6.2 and OK on live TV opens the banner hub', async () => {
  const { routeRemoteKey } = await load('remote/input.js');
  assert.equal(routeRemoteKey('guide', 'yellow'), 'guide.filter');
  assert.equal(routeRemoteKey('guide', 'blue'), 'guide.reminders');
  assert.equal(routeRemoteKey('guide', 'red'), 'guide.dayBack');
  assert.equal(routeRemoteKey('banner', 'left'), 'banner.key.left');
  assert.equal(routeRemoteKey('banner', 'down'), 'banner.key.down');
});
