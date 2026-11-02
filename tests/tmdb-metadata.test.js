// TMDB Metadata (plugins/tmdb-metadata): the search, the details a match
// fetches, and how a match turns into file fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { activate, __test: { splitYear, rankByYear, usRating, episodeFrom } } = require('../plugins/tmdb-metadata/main.js');

test('years at either end of a name come out of the query', () => {
  assert.deepEqual(splitYear('Some Special 1964'), { title: 'Some Special', year: 1964 });
  assert.deepEqual(splitYear('Some Film (2004)'), { title: 'Some Film', year: 2004 });
  assert.deepEqual(splitYear('(2001). Some Film'), { title: 'Some Film', year: 2001 });
  assert.deepEqual(splitYear('1977 - Some Film, The Long One'), { title: 'Some Film, The Long One', year: 1977 });
  assert.deepEqual(splitYear('An Episode (February 13, 1943)'), { title: 'An Episode', year: 1943 });
  assert.deepEqual(splitYear('Some Special (1965, HD)'), { title: 'Some Special', year: 1965 });
  assert.deepEqual(splitYear('Some.Film.1998'), { title: 'Some Film', year: 1998 });
});

test('a title that is or contains a non-year number is left alone', () => {
  assert.deepEqual(splitYear('1917'), { title: '1917', year: null });
  assert.deepEqual(splitYear('Runner 2049'), { title: 'Runner 2049', year: null }, 'past next year is not a release year');
  assert.deepEqual(splitYear('Plain Title'), { title: 'Plain Title', year: null });
});

test('results from the named year come first, then a year either side', () => {
  const ranked = rankByYear([{ year: '1998' }, { year: '1964' }, { year: '' }, { year: '1965' }], 1964).map((r) => r.year);
  assert.deepEqual(ranked, ['1964', '1965', '1998', '']);
  const same = [{ year: '1' }, { year: '2' }];
  assert.equal(rankByYear(same, null), same);
});

test('the kind a file looks like breaks ties, after the year', () => {
  const results = [
    { id: 1, mediaType: 'tv', year: '1971' },
    { id: 2, mediaType: 'movie', year: '1983' },
    { id: 3, mediaType: 'tv', year: '1983' },
  ];
  assert.deepEqual(rankByYear(results, null, 'movie').map((r) => r.id), [2, 1, 3]);
  assert.deepEqual(rankByYear(results, 1983, 'tv').map((r) => r.id), [3, 2, 1], 'the year still comes first');
});

function handlers(responses) {
  const paths = [];
  const handle = {};
  activate({
    ipcMain: { handle: (channel, fn) => { handle[channel] = fn; } },
    fetchJsonCached: async (key, url) => {
      paths.push(url.replace('https://api.themoviedb.org/3/', ''));
      const query = /search\/multi\?query=([^&]*)/.exec(url);
      if (query) return { results: responses[decodeURIComponent(query[1])] || [] };
      const hit = Object.keys(responses).find((p) => url.includes(p));
      if (!hit) throw new Error('404');
      return responses[hit];
    },
  });
  return { search: (query) => handle['tmdb:search'](null, { apiKey: 'k', query }), details: (opts) => handle['tmdb:getCredits'](null, { apiKey: 'k', ...opts }), paths };
}

test('search drops the year, ranks by it, and retries the name as written when nothing is found', async () => {
  const { search, paths } = handlers({
    'Some Special': [
      { media_type: 'movie', id: 1, title: 'Some Special', release_date: '1998-12-01' },
      { media_type: 'tv', id: 2, name: 'Some Special', first_air_date: '1964-12-06' },
    ],
    'Outpost: 1999': [{ media_type: 'tv', id: 3, name: 'Outpost: 1999', first_air_date: '1975-09-04' }],
  });
  const { results } = await search('Some Special 1964');
  assert.equal(results[0].id, 2, 'the 1964 result is first');
  const retry = await search('Outpost: 1999');
  assert.equal(paths.length, 3, 'the stripped query, then the name as written');
  assert.equal(retry.results[0].id, 3);
});

test('ratings: a show’s US rating, and a film’s certification as a TV rating', () => {
  assert.equal(usRating('tv', { content_ratings: { results: [{ iso_3166_1: 'GB', rating: '12' }, { iso_3166_1: 'US', rating: 'TV-Y7-FV' }] } }), 'TV-Y7');
  assert.equal(usRating('tv', { content_ratings: { results: [{ iso_3166_1: 'US', rating: 'NR' }] } }), null);
  const film = { release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, certification: '' }, { type: 3, certification: 'PG-13' }] }] } };
  assert.equal(usRating('movie', film), 'TV-14');
  assert.equal(usRating('movie', { release_dates: { results: [] } }), null);
});

test('details: cast and rating in one call, the episode from its cached season', async () => {
  const { details, paths } = handlers({
    'tv/7?append_to_response=credits,content_ratings': {
      credits: { cast: [{ name: 'A' }, { name: 'B' }] },
      content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-PG' }] },
    },
    'tv/7/season/2': { episodes: [{ episode_number: 1, name: 'The First', overview: 'It begins.', air_date: '2005-09-20' }] },
  });
  const out = await details({ id: 7, mediaType: 'tv', season: 2, episode: 1 });
  assert.deepEqual(out, {
    cast: ['A', 'B'],
    rating: 'TV-PG',
    episode: { season: 2, number: 1, name: 'The First', overview: 'It begins.', airDate: '2005-09-20' },
  });
  assert.deepEqual(paths, ['tv/7?append_to_response=credits,content_ratings', 'tv/7/season/2']);
  assert.equal((await details({ id: 7, mediaType: 'tv', season: 9, episode: 1 })).episode, null, 'an unknown season keeps the show match');
  assert.equal(episodeFrom({ episodes: [] }, 1, 1), null);
});

// ---------- Renderer ----------

let registered = null;
const titleMatchUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'library', 'title-match.js')).href;
async function loadRenderer(settings = {}) {
  globalThis.window = {
    RCBPlugins: {
      ctx: {
        S: { config: {} },
        ipc: { available: () => false },
        settings: { getPluginSettings: () => settings },
        titleMatch: await import(titleMatchUrl),
      },
      registerTitleRowAction: (id, def) => { registered = def; },
    },
  };
  return import(pathToFileURL(path.join(__dirname, '..', 'plugins', 'tmdb-metadata', 'renderer.js')).href);
}

test('the plugin registers its TITLES row action on ctx v11', async () => {
  await loadRenderer();
  assert.ok(registered && typeof registered.renderRowCell === 'function' && typeof registered.renderBulkAction === 'function');
  const manifest = require('../plugins/tmdb-metadata/manifest.json');
  assert.equal(manifest.minCtxVersion, 11, 'it reads files through ctx.titleMatch');
});

test('a match fills the episode’s details, and only empty titles and ratings', async () => {
  const r = await loadRenderer();
  const prefs = { episodeDetails: true, fillRatings: true };
  const match = { id: 7, mediaType: 'tv', posterUrl: 'p', overview: 'The show.' };
  const details = { cast: ['A'], rating: 'TV-PG', episode: { season: 2, number: 1, name: 'The First', overview: 'It begins.', airDate: '2005-09-20' } };
  assert.deepEqual(r.fieldsFromMatch({ path: 'x.mkv' }, match, details, prefs), {
    tmdb: { id: 7, mediaType: 'tv', posterUrl: 'p', cast: ['A'], episode: { season: 2, number: 1, name: 'The First', airDate: '2005-09-20' } },
    description: 'It begins.',
    title: 'The First',
    rating: 'TV-PG',
  });
  const kept = r.fieldsFromMatch({ path: 'x.mkv', title: 'Mine', rating: 'TV-G', description: 'Old' }, match, details, prefs);
  assert.deepEqual(Object.keys(kept), ['tmdb'], 'a set title, rating and description stay');
  const off = r.fieldsFromMatch({ path: 'x.mkv' }, match, details, { episodeDetails: false, fillRatings: false });
  assert.equal(off.description, 'The show.', 'with episode details off the show overview is used');
  assert.equal(off.tmdb.episode, undefined);
  assert.equal(off.rating, undefined);
});

test('a bulk match revisits a show-level match an episode can improve on', async () => {
  const r = await loadRenderer();
  const prefs = { episodeDetails: true, fillRatings: true };
  assert.equal(r.needsMatch({ path: 'S01E01.mkv' }, prefs), true);
  assert.equal(r.needsMatch({ path: 'S01E01.mkv', description: 'd', tmdb: { mediaType: 'tv' } }, prefs), true);
  assert.equal(r.needsMatch({ path: 'S01E01.mkv', description: 'd', tmdb: { mediaType: 'tv', episode: {} } }, prefs), false);
  assert.equal(r.needsMatch({ path: 'film.mkv', description: 'd', tmdb: { mediaType: 'movie' } }, prefs), false);
  assert.equal(r.needsMatch({ path: 'S01E01.mkv', description: 'd', tmdb: { mediaType: 'tv' } }, { episodeDetails: false }), false);
});
