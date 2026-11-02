// TMDB Metadata's search (plugins/tmdb-metadata/main.js): a year in a file
// name comes out of the query and ranks the results instead.
const test = require('node:test');
const assert = require('node:assert/strict');

const { activate, __test: { splitYear, rankByYear } } = require('../plugins/tmdb-metadata/main.js');

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

function searchHandler(responses) {
  const queries = [];
  let handler = null;
  activate({
    ipcMain: { handle: (channel, fn) => { if (channel === 'tmdb:search') handler = fn; } },
    fetchJsonCached: async (key, url) => {
      const q = decodeURIComponent(/query=([^&]*)/.exec(url)[1]);
      queries.push(q);
      return { results: responses[q] || [] };
    },
  });
  return { search: (query) => handler(null, { apiKey: 'k', query }), queries };
}

test('search drops the year, ranks by it, and retries the name as written when nothing is found', async () => {
  const { search, queries } = searchHandler({
    'Some Special': [
      { media_type: 'movie', id: 1, title: 'Some Special', release_date: '1998-12-01' },
      { media_type: 'tv', id: 2, name: 'Some Special', first_air_date: '1964-12-06' },
    ],
    'Outpost: 1999': [{ media_type: 'tv', id: 3, name: 'Outpost: 1999', first_air_date: '1975-09-04' }],
  });
  const { results } = await search('Some Special 1964');
  assert.deepEqual(queries, ['Some Special']);
  assert.equal(results[0].id, 2, 'the 1964 result is first');
  const retry = await search('Outpost: 1999');
  assert.deepEqual(queries.slice(1), ['Outpost:', 'Outpost: 1999']);
  assert.equal(retry.results[0].id, 3);
});
