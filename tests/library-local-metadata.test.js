// Local metadata: NFO sidecars and container tags (docs/design/07 §5 step 2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseNfo, parseFfmetadata, tagsToFields, cleanTagTitle, normalizeRating, createLocalMetadataReader,
} = require('../main/library/local-metadata');

const EPISODE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<episodedetails>
  <title>The Big Move &amp; Other Plans</title>
  <showtitle>Workplace Comedy</showtitle>
  <season>2</season>
  <episode>1</episode>
  <aired>2005-09-20</aired>
  <plot><![CDATA[The staff throws an <awards> night.]]></plot>
  <mpaa>TV-14</mpaa>
  <uniqueid type="tvdb" default="true">123456</uniqueid>
  <actor><name>First Actor</name><role>Boss</role></actor>
  <actor><name>Second Actor</name><role>Clerk</role></actor>
  <fileinfo><streamdetails><video><title>not a title</title></video></streamdetails></fileinfo>
</episodedetails>`;

const SHOW_NFO = `<tvshow>
  <title>Workplace Comedy</title>
  <plot>A mockumentary about an office.</plot>
  <genre>Comedy</genre><genre>Comedy / Satire</genre>
  <mpaa>US:TV-PG / GB:12</mpaa>
  <studio>A Network</studio>
  <premiered>2005-03-24</premiered>
</tvshow>`;

test('an episode NFO gives title, series, codes, airdate, plot, rating, cast and ids', () => {
  const nfo = parseNfo(EPISODE_NFO);
  assert.equal(nfo.kind, 'episode');
  assert.equal(nfo.title, 'The Big Move & Other Plans');
  assert.equal(nfo.series, 'Workplace Comedy');
  assert.equal(nfo.season, 2);
  assert.equal(nfo.episode, 1);
  assert.equal(nfo.aired, '2005-09-20');
  assert.equal(nfo.year, 2005);
  assert.equal(nfo.description, 'The staff throws an <awards> night.', 'CDATA keeps its angle brackets as text');
  assert.equal(nfo.rating, 'TV-14');
  assert.deepEqual(nfo.cast, ['First Actor', 'Second Actor']);
  assert.deepEqual(nfo.ids, { tvdb: '123456' });
});

test('a tvshow NFO names the series, never an episode title', () => {
  const nfo = parseNfo(SHOW_NFO);
  assert.equal(nfo.kind, 'series');
  assert.equal(nfo.series, 'Workplace Comedy');
  assert.equal(nfo.title, undefined);
  assert.deepEqual(nfo.genre, ['Comedy', 'Satire'], 'genres are split and de-duplicated');
  assert.equal(nfo.rating, 'TV-PG', 'the US entry wins');
  assert.equal(nfo.year, 2005);
});

test('a multi-episode NFO joins the titles and keeps the first codes', () => {
  const nfo = parseNfo('<episodedetails><title>Part One</title><season>1</season><episode>5</episode></episodedetails>\n<episodedetails><title>Part Two</title><season>1</season><episode>6</episode></episodedetails>');
  assert.equal(nfo.title, 'Part One / Part Two');
  assert.equal(nfo.episode, 5);
});

test('a non-XML NFO keeps only an IMDb link, and junk gives nothing', () => {
  assert.deepEqual(parseNfo('  ** some ascii art **\nhttps://www.imdb.com/title/tt0123456/\n'), { kind: null, ids: { imdb: 'tt0123456' } });
  assert.equal(parseNfo('just text'), null);
  assert.equal(parseNfo(''), null);
});

test('a movie NFO maps its film rating to the TV rating a network airs it under', () => {
  const nfo = parseNfo('<movie><title>A Film</title><year>1998</year><mpaa>Rated PG-13</mpaa><genre>Drama</genre></movie>');
  assert.equal(nfo.kind, 'movie');
  assert.equal(nfo.title, 'A Film');
  assert.equal(nfo.rating, 'TV-14');
  assert.equal(nfo.year, 1998);
});

test('ratings normalize to the box vocabulary or stay unset', () => {
  assert.equal(normalizeRating('TV14'), 'TV-14');
  assert.equal(normalizeRating('tv-y7-fv'), 'TV-Y7');
  assert.equal(normalizeRating('G'), 'TV-G');
  assert.equal(normalizeRating('PG13'), 'TV-14');
  assert.equal(normalizeRating('R'), 'TV-MA');
  assert.equal(normalizeRating('NC-17'), 'TV-MA');
  assert.equal(normalizeRating('GB:15'), null);
  assert.equal(normalizeRating('Not Rated'), null);
  assert.equal(normalizeRating(''), null);
});

test('ffmetadata output: the global section only, unescaped', () => {
  const tags = parseFfmetadata([
    ';FFMETADATA1',
    'title=Two \\= Three\\; really',
    'description=Line one\\',
    'line two',
    'Show=Some Series',
    '[STREAM]',
    'title=a stream title',
    '[CHAPTER]',
    'TIMEBASE=1/1000',
    'title=Chapter 1',
  ].join('\n'));
  assert.deepEqual(tags, { title: 'Two = Three; really', description: 'Line one\nline two', show: 'Some Series' });
});

test('tag titles that encoders and release groups leave behind are rejected', () => {
  assert.equal(cleanTagTitle('Cartoon Archive Project - https://example.org/details/abc'), null);
  assert.equal(cleanTagTitle('SomeSite.com | Show.Name.S02E01.720p.WEBRip-GRP'), null);
  assert.equal(cleanTagTitle('Show.Name.S07E18.1080p.BluRay.x265-GRP'), null);
  assert.equal(cleanTagTitle('Show Name S03E11 - Team Release'), null, 'an episode code means a filename');
  assert.equal(cleanTagTitle('00:00:00.211'), null);
  assert.equal(cleanTagTitle('Chapter 3'), null);
  assert.equal(cleanTagTitle('Some Film 2-Movie Collection'), null, "a box set's name");
  assert.equal(cleanTagTitle('The Complete Series'), null);
  assert.equal(cleanTagTitle('A Movie Title - GRP'), 'A Movie Title', 'a trailing group tag is dropped');
  assert.equal(cleanTagTitle('A Holiday Film (2004)'), 'A Holiday Film', 'and a trailing year');
  assert.equal(cleanTagTitle('Hoppy Days'), 'Hoppy Days');
  assert.equal(cleanTagTitle("What's Up, Dog?"), "What's Up, Dog?");
});

test('tag fields: comments are ignored, descriptions need substance', () => {
  const fields = tagsToFields({
    title: 'A Real Title', comment: 'license:https://example.org/', date: '1995', description: 'short',
    season_number: '3', episode_sort: '7', genre: 'Animation;Family',
  });
  assert.deepEqual(fields, { title: 'A Real Title', season: 3, episode: 7, year: 1995, genre: ['Animation', 'Family'] });
  assert.equal(tagsToFields({ description: 'A long enough description of what happens in it.' }).description,
    'A long enough description of what happens in it.');
});

function tempTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-meta-'));
  Object.entries(files).forEach(([rel, body]) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  });
  return dir;
}

test('the reader merges own NFO over tags over tvshow.nfo, and names each source', async () => {
  const dir = tempTree({
    'Workplace Comedy/tvshow.nfo': SHOW_NFO,
    'Workplace Comedy/Season 02/S02E01.mkv': 'x',
    'Workplace Comedy/Season 02/S02E01.nfo': EPISODE_NFO,
    'Workplace Comedy/Season 02/S02E02.mkv': 'x',
  });
  const reader = createLocalMetadataReader({
    dir: null,
    getFfmpegPath: () => 'ffmpeg',
    runTags: async (ffmpeg, file) => (file.endsWith('S02E02.mkv') ? ';FFMETADATA1\ntitle=Second Episode\ndate=2005-09-27\n' : ''),
  });
  const ep1 = path.join(dir, 'Workplace Comedy/Season 02/S02E01.mkv');
  const ep2 = path.join(dir, 'Workplace Comedy/Season 02/S02E02.mkv');
  const { results, tagsAvailable } = await reader.read([ep1, ep2]);
  assert.equal(tagsAvailable, true);

  assert.equal(results[ep1].fields.title, 'The Big Move & Other Plans');
  assert.equal(results[ep1].sources.title, 'S02E01.nfo');
  assert.equal(results[ep1].fields.rating, 'TV-14', "the episode's own rating beats the show's");
  assert.equal(results[ep1].fields.description, 'The staff throws an <awards> night.');
  assert.equal(results[ep1].kind, 'episode');

  assert.equal(results[ep2].fields.title, 'Second Episode');
  assert.equal(results[ep2].sources.title, 'embedded tags');
  assert.equal(results[ep2].fields.aired, '2005-09-27');
  assert.equal(results[ep2].fields.series, 'Workplace Comedy');
  assert.equal(results[ep2].sources.series, 'tvshow.nfo', 'found two folders up, past the season folder');
  assert.equal(results[ep2].fields.rating, 'TV-PG');
  assert.equal(results[ep2].fields.description, 'A mockumentary about an office.', "the show's overview fills in");
  assert.equal(results[ep2].fields.year, 2005, "tags' own year came first");
});

test("a tag date near the file's own modified time is an encode date and is dropped", async () => {
  const dir = tempTree({ 'd/old.mp4': 'x' });
  const reader = createLocalMetadataReader({
    dir: null, getFfmpegPath: () => 'ffmpeg', runTags: async () => `title=Old Cartoon\ndate=${new Date().getFullYear()}-01-02\n`,
  });
  const ref = path.join(dir, 'd/old.mp4');
  const { results } = await reader.read([ref]);
  assert.deepEqual(results[ref].fields, { title: 'Old Cartoon' });
});

test('movie.nfo applies only to the single video in its folder', async () => {
  const movieNfo = '<movie><title>Only Film</title></movie>';
  const dir = tempTree({
    'One/movie.nfo': movieNfo, 'One/film.mkv': 'x',
    'Many/movie.nfo': movieNfo, 'Many/a.mkv': 'x', 'Many/b.mkv': 'x',
  });
  const reader = createLocalMetadataReader({ dir: null });
  const { results } = await reader.read([path.join(dir, 'One/film.mkv'), path.join(dir, 'Many/a.mkv')]);
  assert.equal(results[path.join(dir, 'One/film.mkv')].fields.title, 'Only Film');
  assert.equal(results[path.join(dir, 'Many/a.mkv')], null);
});

test('posters: the file’s own, a single-movie folder’s, then the show’s past a season folder', async () => {
  const dir = tempTree({
    'Show/poster.jpg': 'x', 'Show/Season 1/S01E01.mkv': 'x', 'Show/Season 1/S01E02.mkv': 'x', 'Show/Season 1/S01E02-thumb.png': 'x',
    'Film/film.mkv': 'x', 'Film/Folder.JPG': 'x',
    'Mixed/a.mkv': 'x', 'Mixed/b.mkv': 'x', 'Mixed/poster.jpg': 'x',
  });
  const reader = createLocalMetadataReader({ dir: null });
  const refs = ['Show/Season 1/S01E01.mkv', 'Show/Season 1/S01E02.mkv', 'Film/film.mkv', 'Mixed/a.mkv'].map((r) => path.join(dir, r));
  const { results } = await reader.read(refs);
  assert.equal(results[refs[0]].fields.poster, path.join(dir, 'Show/poster.jpg'));
  assert.equal(results[refs[0]].sources.poster, 'poster.jpg');
  assert.equal(results[refs[1]].fields.poster, path.join(dir, 'Show/Season 1/S01E02-thumb.png'), 'an episode thumbnail beats the show poster');
  assert.equal(results[refs[2]].fields.poster, path.join(dir, 'Film/Folder.JPG'), 'names match whatever their case');
  assert.equal(results[refs[3]], null, 'a folder of several films has no one poster');
});

test('a tag title shared by several files in a batch is a collection name and is dropped', async () => {
  const dir = tempTree({ 'c/1.mp4': 'x', 'c/2.mp4': 'x', 'c/3.mp4': 'x', 'c/4.mp4': 'x' });
  const reader = createLocalMetadataReader({
    dir: null,
    getFfmpegPath: () => 'ffmpeg',
    runTags: async (ffmpeg, file) => (file.endsWith('4.mp4') ? 'title=Its Own Title\n' : 'title=The Collection\ndate=1950\n'),
  });
  const refs = ['1', '2', '3', '4'].map((n) => path.join(dir, `c/${n}.mp4`));
  const { results } = await reader.read(refs);
  assert.equal(results[refs[0]].fields.title, undefined);
  assert.equal(results[refs[0]].fields.year, 1950, 'other fields survive');
  assert.equal(results[refs[3]].fields.title, 'Its Own Title');
});

test('results are cached until the file or a sidecar changes', async () => {
  const dir = tempTree({ 'm/a.mkv': 'x', 'm/a.nfo': '<movie><title>Before</title></movie>' });
  let runs = 0;
  const reader = createLocalMetadataReader({
    dir, getFfmpegPath: () => 'ffmpeg', runTags: async () => { runs += 1; return ''; },
  });
  const ref = path.join(dir, 'm/a.mkv');
  assert.equal((await reader.read([ref])).results[ref].fields.title, 'Before');
  await reader.read([ref]);
  assert.equal(runs, 1, 'the second read is a cache hit');
  fs.writeFileSync(path.join(dir, 'm/a.nfo'), '<movie><title>After, longer</title></movie>');
  assert.equal((await reader.read([ref])).results[ref].fields.title, 'After, longer');
  assert.equal(runs, 2);
});

test('without ffmpeg only sidecars are read, and missing files give null', async () => {
  const dir = tempTree({ 'x/a.mkv': 'x' });
  const reader = createLocalMetadataReader({ dir: null, runTags: async () => { throw new Error('must not run'); } });
  const { results, tagsAvailable } = await reader.read([path.join(dir, 'x/a.mkv'), path.join(dir, 'x/gone.mkv')]);
  assert.equal(tagsAvailable, false);
  assert.equal(results[path.join(dir, 'x/a.mkv')], null);
  assert.equal(results[path.join(dir, 'x/gone.mkv')], null);
});

// ---------- Renderer side ----------

const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };
const loadRenderer = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

test('a reading fills only the empty details of a playlist entry', async () => {
  const { fileFieldsFromLocal, describeFilled } = await loadRenderer('library/local-metadata.js');
  const reading = { fields: { title: 'Pilot', description: 'It begins.', rating: 'TV-PG', series: 'A Show', season: 1, episode: 1 } };
  assert.deepEqual(fileFieldsFromLocal({ path: 'x.mkv' }, reading), {
    title: 'Pilot', description: 'It begins.', rating: 'TV-PG', series: { name: 'A Show', season: 1, episode: 1 },
  });
  assert.deepEqual(fileFieldsFromLocal({ path: 'x.mkv', title: 'Mine', rating: 'NONE', description: '  ' }, reading), {
    description: 'It begins.', series: { name: 'A Show', season: 1, episode: 1 },
  }, "a hand-set title and an explicit NONE rating stay");
  assert.equal(fileFieldsFromLocal({ path: 'x.mkv', title: 'Mine', description: 'd', rating: 'TV-G', series: { name: 'S' } }, reading), null);
  assert.equal(fileFieldsFromLocal({ path: 'x.mkv' }, null), null);
  assert.equal(describeFilled([{ title: 1, rating: 1 }, { title: 1 }]), '2 titles and 1 rating');
});

test('reads are batched a folder at a time', async () => {
  const { batchByFolder, localPathOf } = await loadRenderer('library/local-metadata.js');
  const refs = [String.raw`C:\a\1.mkv`, String.raw`C:\b\1.mkv`, String.raw`C:\a\2.mkv`, String.raw`C:\b\2.mkv`, String.raw`C:\c\1.mkv`];
  assert.deepEqual(batchByFolder(refs, 4), [[refs[0], refs[2], refs[1], refs[3]], [refs[4]]]);
  assert.equal(batchByFolder(new Array(5).fill(0).map((_, i) => `/big/${i}.mkv`), 2).length, 3, 'a folder larger than a batch is split');
  assert.equal(localPathOf('mediasource:prov:abc/1.mkv'), null);
  assert.equal(localPathOf(refs[0]), refs[0]);
});

test('REVIEW suggests NFO details over path guesses, naming the source', async () => {
  const { analyzeItem, suggestGroups, acceptGroup } = await loadRenderer('library/tagging.js');
  const item = (id, file, local) => ({
    id, ref: ['D:', 'TV Shows', 'Some Show (1990)', 'Season 1', file].join('\\'), duration: 1320, provenance: {}, local,
  });
  const show = { series: 'The Real Show Name', rating: 'TV-PG' };
  const items = [
    item('a', 'Some.Show.S01E01.mkv', { kind: 'episode', fields: { ...show, title: 'Pilot', description: 'First one.', season: 1, episode: 1 }, sources: { series: 'tvshow.nfo', rating: 'tvshow.nfo', title: 'S01E01.nfo', description: 'S01E01.nfo', season: 'S01E01.nfo', episode: 'S01E01.nfo' } }),
    item('b', 'Some.Show.S01E02.mkv', { fields: { ...show }, sources: { series: 'tvshow.nfo', rating: 'tvshow.nfo' } }),
  ];
  const a = analyzeItem(items[0]);
  assert.equal(a.series, 'The Real Show Name');
  assert.equal(a.reasons.series, 'tvshow.nfo');
  assert.equal(a.title, 'Pilot');
  assert.equal(analyzeItem({ ...items[0], local: null }).series, 'Some Show', 'without evidence the folder decides');

  const [group] = suggestGroups(items);
  assert.equal(group.label, 'The Real Show Name');
  assert.equal(group.fields.rating, 'TV-PG');
  assert.equal(group.reasons.rating, 'tvshow.nfo');
  assert.equal(group.perItem.a.description, 'First one.');

  const updates = acceptGroup(group, Object.fromEntries(items.map((i) => [i.id, i])));
  const first = updates.find((u) => u.id === 'a').fields;
  assert.equal(first.rating, 'TV-PG');
  assert.equal(first.description, 'First one.');
  assert.equal(first.title, 'Pilot');
  assert.equal(first.provenance.description, 'user-accepted');
  assert.deepEqual(first.series, { name: 'The Real Show Name', season: 1, episode: 1 });
});
