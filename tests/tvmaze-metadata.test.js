// TVmaze Episodes (plugins/tvmaze-metadata): the host lookups and how a match
// becomes file fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { activate, __test: { showFrom } } = require('../plugins/tvmaze-metadata/main.js');
const manifest = require('../plugins/tvmaze-metadata/manifest.json');

const SHOW = {
  id: 526, name: 'Workplace Comedy', premiered: '2005-03-24',
  network: { name: 'A Network', country: { code: 'US' } },
  schedule: { days: ['Thursday'], time: '21:00' },
  image: { medium: 'https://static.tvmaze.com/m.jpg' },
  summary: '<p>An office.</p>',
};

test('the manifest declares its host, channels and fallbacks', () => {
  assert.equal(manifest.minCtxVersion, 11);
  assert.deepEqual(manifest.capabilities.internet.map((c) => c.host), ['api.tvmaze.com']);
  assert.deepEqual(manifest.capabilities.ipc.map((c) => c.channel).sort(), ['tvmaze:episodes', 'tvmaze:search']);
  assert.deepEqual(Object.keys(manifest.fallbackIpc).sort(), ['tvmaze:episodes', 'tvmaze:search']);
});

test('a show keeps what a match and the program page need', () => {
  assert.deepEqual(showFrom(SHOW), {
    id: 526, name: 'Workplace Comedy', mediaType: 'tv', year: '2005', premiered: '2005-03-24',
    network: 'A Network', country: 'US', schedule: { days: ['Thursday'], time: '21:00' },
    summary: '<p>An office.</p>', imageUrl: 'https://static.tvmaze.com/m.jpg', url: null,
  });
  assert.equal(showFrom({ id: 1, name: 'Web Show', webChannel: { name: 'A Stream' } }).network, 'A Stream');
});

test('search and episode handlers call the public API and degrade to empty', async () => {
  const urls = [];
  const h = {};
  activate({
    ipcMain: { handle: (c, f) => { h[c] = f; } },
    fetchJsonCached: async (key, url) => {
      urls.push(url);
      if (url.includes('/search/shows')) return [{ score: 1, show: SHOW }];
      if (url.includes('/shows/526/episodes')) return [{ id: 9, season: 2, number: 1, name: 'The First', airdate: '2005-09-20', airtime: '21:00', summary: '<p>Awards.</p>' }];
      throw new Error('HTTP 404');
    },
  });
  const search = await h['tvmaze:search'](null, { query: 'Workplace Comedy' });
  assert.equal(search.results[0].id, 526);
  const eps = await h['tvmaze:episodes'](null, { showId: 526 });
  assert.equal(eps.episodes[0].name, 'The First');
  assert.deepEqual(await h['tvmaze:episodes'](null, { showId: 'x' }), { episodes: [] });
  assert.equal((await h['tvmaze:episodes'](null, { showId: 7 })).episodes.length, 0);
  assert.deepEqual(await h['tvmaze:search'](null, { query: '  ' }), { results: [] });
  assert.ok(urls[0].startsWith('https://api.tvmaze.com/search/shows?q=Workplace%20Comedy'));
  assert.ok(urls[1].endsWith('/shows/526/episodes?specials=1'));
});

let registered = null;
async function loadRenderer() {
  globalThis.window = {
    RCBPlugins: {
      ctx: {
        ipc: { available: () => false },
        settings: { getPluginSettings: () => ({}) },
        titleMatch: await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'library', 'title-match.js')).href),
      },
      registerTitleRowAction: (id, def) => { registered = { id, def }; },
    },
  };
  return import(pathToFileURL(path.join(__dirname, '..', 'plugins', 'tvmaze-metadata', 'renderer.js')).href);
}

test('an episode match fills empty details and records where and when it aired', async () => {
  const r = await loadRenderer();
  assert.equal(registered.id, 'tvmaze-metadata');
  const show = showFrom(SHOW);
  const episode = { id: 9, season: 2, number: 1, name: 'The First', airdate: '2005-09-20', airtime: '21:00', summary: '<p>Awards &amp; more.</p>' };
  const prefs = { episodeTitles: true, seriesNames: true };
  const fields = r.fieldsFromShow({ path: 'D:/TV/x/S02E01.mkv' }, show, episode, prefs);
  assert.deepEqual(fields, {
    tvmaze: {
      showId: 526, show: 'Workplace Comedy', network: 'A Network', country: 'US',
      schedule: { days: ['Thursday'], time: '21:00' }, imageUrl: 'https://static.tvmaze.com/m.jpg',
      episodeId: 9, season: 2, number: 1, airdate: '2005-09-20', airtime: '21:00',
    },
    description: 'Awards & more.',
    title: 'The First',
    series: { name: 'Workplace Comedy', season: 2, episode: 1 },
  });
  const kept = r.fieldsFromShow({ path: 'S02E01.mkv', title: 'Mine', description: 'Mine too', series: { name: 'Mine' } }, show, episode, prefs);
  assert.deepEqual(Object.keys(kept), ['tvmaze'], 'nothing set by hand is replaced');
  const showOnly = r.fieldsFromShow({ path: 'special.mkv' }, show, null, { episodeTitles: false, seriesNames: false });
  assert.deepEqual(showOnly, { tvmaze: { showId: 526, show: 'Workplace Comedy', network: 'A Network', country: 'US', schedule: { days: ['Thursday'], time: '21:00' }, imageUrl: 'https://static.tvmaze.com/m.jpg', airdate: '2005-03-24' }, description: 'An office.' });
});

test('episodes are found by season and number; bulk only looks up episodes that need it', async () => {
  const r = await loadRenderer();
  const list = [{ season: 1, number: 1 }, { season: 2, number: 1, name: 'Hit' }];
  assert.equal(r.findEpisode(list, { path: 'S02E01.mkv' }).name, 'Hit');
  assert.equal(r.findEpisode(list, { path: 'S09E01.mkv' }), null);
  assert.equal(r.findEpisode(list, { path: 'film.mkv' }), null);
  assert.equal(r.needsMatch({ path: 'S01E01.mkv' }), true);
  assert.equal(r.needsMatch({ path: 'film.mkv' }), false, 'not an episode');
  assert.equal(r.needsMatch({ path: 'S01E01.mkv', description: 'd' }), false);
  assert.equal(r.needsMatch({ path: 'S01E01.mkv', description: 'd', tmdb: { mediaType: 'tv' } }), true, 'a show-level description can be improved');
});
