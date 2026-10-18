// The artist / song card's pure part (playback/track-card.js): what a
// playlist entry says about itself, from library metadata or its filename.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || {};
if (!globalThis.document.getElementById) globalThis.document.getElementById = () => null;
if (!globalThis.document.querySelector) globalThis.document.querySelector = () => null;

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
let trackInfoFor;
test.before(async () => { ({ trackInfoFor } = await load('playback/track-card.js')); });

test('library metadata wins when the item was tagged', () => {
  const info = trackInfoFor({ path: 'C:/Media/Music Videos/whatever.mp4', artist: 'Talking Heads', title: 'Once in a Lifetime', album: 'Remain in Light', facets: { era: '1980s' } });
  assert.deepEqual(info, { artist: 'Talking Heads', title: 'Once in a Lifetime', album: 'Remain in Light', year: '1980s' });
});

test('an "Artist - Title" filename is parsed, with the junk people leave on it stripped', () => {
  const info = trackInfoFor({ path: 'C:/Media/Music Videos/Prince - 1999 (Official Video) [HD] (1982).mp4' });
  assert.equal(info.artist, 'Prince');
  assert.equal(info.title, '1999');
  assert.equal(info.year, '1982');
  assert.equal(info.album, '');
});

test('a plain title still gets a card; nothing at all does not', () => {
  assert.deepEqual(trackInfoFor({ path: 'C:/Media/Clips/Intermission.mp4' }), { artist: '', title: 'Intermission', album: '', year: '' });
  assert.equal(trackInfoFor({ path: '' }), null);
  assert.equal(trackInfoFor(null), null);
});
