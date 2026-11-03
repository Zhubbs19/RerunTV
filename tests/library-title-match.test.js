// How a file is read for an online catalogue (renderer/js/library/title-match.js,
// ctx.titleMatch for metadata plugins).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'library', 'title-match.js')).href);

test('season and episode come from series details or the file name', async () => {
  const { episodeOf } = await load();
  assert.deepEqual(episodeOf({ path: 'D:/TV/Some Show/Season 02/Some.Show.S02E01.Pilot.mkv' }), { season: 2, episode: 1 });
  assert.deepEqual(episodeOf({ path: 'D:/x/3x07.mkv' }), { season: 3, episode: 7 });
  assert.equal(episodeOf({ path: 'D:/Cartoons/Old_Cartoons_-_S1953E05_-_Title.mp4' }), null, 'a season-as-year has no catalogue season');
  assert.deepEqual(episodeOf({ path: 'D:/x/pilot.mkv', series: { name: 'S', season: 1, episode: 4 } }), { season: 1, episode: 4 });
  assert.equal(episodeOf({ path: 'D:/Movies/Some Film 1080p.mkv' }), null);
});

test('an episode is searched by its show; anything else by its title or name', async () => {
  const { searchQueryFor } = await load();
  assert.equal(searchQueryFor({ path: 'D:/TV/Some Show/Season 02/Some.Show.S02E01.Pilot.mkv', title: 'Pilot' }), 'Some Show');
  assert.equal(searchQueryFor({ path: 'D:/TV/Some Show (1990)/Season 1/S01E03.mkv' }), 'Some Show (1990)', 'the folder past season folders');
  assert.equal(searchQueryFor({ path: 'D:/x/S01E03.mkv', series: { name: 'Given Name', season: 1, episode: 3 } }), 'Given Name');
  assert.equal(searchQueryFor({ path: 'D:/Movies/Some Film (1998).mkv' }), 'Some Film (1998)', 'a year stays for splitYear');
  assert.equal(searchQueryFor({ path: 'D:/Movies/Some Film [1080p].mkv' }), 'Some Film');
  assert.equal(searchQueryFor({ path: 'D:/Movies/x.mkv', title: 'Typed Title' }), 'Typed Title');
});

test('a film for feature length, a show for an episode', async () => {
  const { preferredKind } = await load();
  assert.equal(preferredKind({ path: 'D:/x/S01E02.mkv', duration: 1300 }), 'tv');
  assert.equal(preferredKind({ path: 'D:/Movies/Some Film.mkv', duration: 5600 }), 'movie');
  assert.equal(preferredKind({ path: 'D:/x/short.mkv', duration: 600 }), null);
});

test('years come out of a query and rank results', async () => {
  const { splitYear, rankByYear } = await load();
  const now = new Date('2026-11-03T00:00:00Z');
  assert.deepEqual(splitYear('Some Special 1964', now), { title: 'Some Special', year: 1964 });
  assert.deepEqual(splitYear('(1995). Some Film', now), { title: 'Some Film', year: 1995 });
  assert.deepEqual(splitYear('An Episode (February 13, 1943)', now), { title: 'An Episode', year: 1943 });
  assert.deepEqual(splitYear('1917', now), { title: '1917', year: null });
  assert.deepEqual(splitYear('Runner 2049', now), { title: 'Runner 2049', year: null });
  const results = [{ id: 1, mediaType: 'tv', year: '1971' }, { id: 2, mediaType: 'movie', year: '1983' }, { id: 3, mediaType: 'tv', year: '1983' }];
  assert.deepEqual(rankByYear(results, 1983, 'tv').map((r) => r.id), [3, 2, 1]);
  assert.deepEqual(rankByYear(results, null, 'movie').map((r) => r.id), [2, 1, 3]);
});

test('catalogue summaries become plain text', async () => {
  const { plainSummary } = await load();
  assert.equal(plainSummary('<p>It <b>begins</b> &amp; ends.</p><p>Second&nbsp;part&#39;s here.</p>'), "It begins & ends. Second part's here.");
  assert.equal(plainSummary('Cut off <script src="x"'), 'Cut off');
  assert.equal(plainSummary(null), '');
});
