// What every metadata source knows about one program, merged for the screens
// (renderer/js/library/program-details.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'library', 'program-details.js')).href);

test('air dates read like a listing', async () => {
  const { formatAirDate } = await load();
  assert.equal(formatAirDate('2005-09-20'), 'September 20, 2005');
  assert.equal(formatAirDate('1964'), '1964');
  assert.equal(formatAirDate(''), '');
  assert.equal(formatAirDate('garbage'), '');
});

test('sources merge: series, episode, air date, network, cast and images', async () => {
  const { programDetails, episodeLabel, creditSentences } = await load();
  const details = programDetails({
    title: 'The First Day',
    series: { name: 'Workplace Comedy', season: 2, episode: 1 },
    tmdb: { cast: ['Ann Lee', ' ', 'Bo Ray'], posterUrl: 'https://image.tmdb.org/p.jpg', episode: { season: 2, number: 1, name: 'The First Day', airDate: '2005-09-21' } },
    tvmaze: { show: 'Workplace Comedy', network: 'A Network', airdate: '2005-09-20', imageUrl: 'https://static.tvmaze.com/i.jpg', schedule: { days: ['Thursday'], time: '21:00' } },
    poster: 'D:/TV/Workplace Comedy/poster.jpg',
  });
  assert.equal(details.seriesName, 'Workplace Comedy');
  assert.equal(details.episodeTitle, 'The First Day');
  assert.equal(episodeLabel(details), 'S2 E1');
  assert.deepEqual(details.firstAired, { date: '2005-09-20', network: 'A Network' }, 'TVmaze’s date, which comes with its network');
  assert.deepEqual(details.cast, ['Ann Lee', 'Bo Ray']);
  assert.equal(details.imageUrl, 'https://image.tmdb.org/p.jpg', 'a TMDB poster first');
  assert.equal(details.posterPath, 'D:/TV/Workplace Comedy/poster.jpg');
  assert.equal(creditSentences(details), 'Starring Ann Lee and Bo Ray. First aired September 20, 2005 on A Network.');
});

test('a bare file has nothing to show', async () => {
  const { programDetails, episodeLabel, creditSentences } = await load();
  const details = programDetails({ path: 'x.mkv', title: 'A Film' });
  assert.equal(details.seriesName, null);
  assert.equal(details.episodeTitle, null, 'a title with no series is not an episode title');
  assert.equal(episodeLabel(details), '');
  assert.equal(creditSentences(details), '');
  assert.equal(programDetails(null).imageUrl, null);
  assert.equal(creditSentences(programDetails({ tmdb: { episode: { airDate: '1964' } } })), 'First aired in 1964.');
  assert.equal(programDetails({ tvmaze: { imageUrl: 'https://static.tvmaze.com/i.jpg' } }).imageUrl, 'https://static.tvmaze.com/i.jpg');
});
