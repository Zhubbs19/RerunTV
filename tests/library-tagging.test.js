// Auto-tagging suggestions (docs/design/07 §5). Suggestions are grouped so a
// person reviews a series at a time; §8's criterion — 1,000 new episodes across
// series take fewer than 10 review actions — is checked here directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
let analyzeRef;
let suggestGroups;
let acceptGroup;
test.before(async () => {
  ({ analyzeRef, suggestGroups, acceptGroup } = await load('library/tagging.js'));
});

const item = (id, ref, duration, extra = {}) => ({ id, ref, duration, provenance: {}, ...extra });

test('series, season and episode come from the folder and the episode code', () => {
  const a = analyzeRef('J:\\Media Center\\TV Shows\\The Office (2005)\\Season 02\\The.Office.S02E01.The.Dundies.720p.mkv', 1300);
  assert.equal(a.series, 'The Office');
  assert.equal(a.season, 2);
  assert.equal(a.episode, 1);
  assert.equal(a.kind, 'episode');
  assert.equal(a.era, '2000s');
  assert.equal(a.title, 'The Dundies');
  assert.match(a.reasons.series, /folder/);
});

test('an episode code after an underscore is still an episode code', () => {
  // "_" is a word character, so a \b-bounded pattern never matched these.
  const a = analyzeRef('J:\\TV Shows\\Looney Tunes\\Looney_Tunes_-_S1953E05_-_Duck_Amuck.mp4', 420);
  assert.equal(a.episode, 5);
  assert.equal(a.year, 1953, 'a four-digit season is a year');
  assert.equal(a.season, undefined);
  assert.equal(a.era, '1950s');
  assert.equal(a.kind, 'short');
  const b = analyzeRef('mediasource:archive:blues-clues-s3/Blues_Clues_S03E52.mp4', 1400);
  assert.equal(b.series, 'Blues Clues', 'a provider ref names its series by filename prefix');
  assert.equal(b.episode, 52);
  assert.equal(b.title, undefined, 'the series name alone is not a title');
});

test('a resolution is not an episode code', () => {
  const a = analyzeRef('J:\\Movies\\Heat 1920x1080.mkv', 170 * 60);
  assert.equal(a.episode, undefined);
  assert.equal(a.kind, 'movie');
});

test('duration bands pick a kind, and sports needs length as well as a keyword', () => {
  assert.equal(analyzeRef('J:\\Ads\\spot.mp4', 30).kind, 'commercial');
  assert.equal(analyzeRef('J:\\Movies\\Its a Wonderful Life (1946).mkv', 7800).kind, 'movie');
  const game = analyzeRef('J:\\Media Center\\Sports\\WVU vs Pitt 2007.mkv', 10800);
  assert.equal(game.kind, 'other');
  assert.deepEqual(game.genre, ['sports']);
  const cartoon = analyzeRef('J:\\Media Center\\Cartoons\\Baseball Bugs.mkv', 420);
  assert.notEqual(cartoon.kind, 'other', 'a seven-minute cartoon called Baseball Bugs is not a game');
  assert.equal(cartoon.series, undefined, 'a genre folder is a collection, not a series');
  assert.equal(analyzeRef('J:\\x\\long.mkv', 72 * 60).kind, undefined, '70-75 minutes is not guessed');
});

test('one group per series, with only the fields the whole group agrees on', () => {
  const items = [
    item('a', 'J:\\TV Shows\\Office (2005)\\S01E01.mkv', 1300),
    item('b', 'J:\\TV Shows\\Office (2005)\\S01E02.mkv', 1310),
    item('c', 'J:\\TV Shows\\Office (2005)\\S01E03.mkv', 1290),
  ];
  const groups = suggestGroups(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Office');
  assert.deepEqual(groups[0].itemIds, ['a', 'b', 'c']);
  assert.equal(groups[0].fields.kind, 'episode');
  assert.equal(groups[0].fields.series, 'Office');
  assert.equal(groups[0].fields.era, '2000s');
  assert.equal(groups[0].perItem.b.episode, 2);
});

test('a field somebody set or accepted is never suggested again', () => {
  const items = [
    item('a', 'J:\\TV Shows\\Office (2005)\\S01E01.mkv', 1300, { kind: 'special', provenance: { kind: 'user' } }),
    item('b', 'J:\\TV Shows\\Office (2005)\\S01E02.mkv', 1310, { facets: { era: [] }, provenance: { era: 'user-accepted' } }),
  ];
  const [group] = suggestGroups(items);
  const updates = acceptGroup(group, Object.fromEntries(items.map((i) => [i.id, i])));
  const a = updates.find((u) => u.id === 'a');
  const b = updates.find((u) => u.id === 'b');
  assert.equal(a.fields.kind, undefined, 'the hand-set kind stays');
  assert.ok(!b.fields.facets || b.fields.facets.era === undefined || b.fields.facets.era.length === 0, 'the accepted-empty era stays');
  assert.equal(b.fields.provenance.kind, 'user-accepted');
});

test('accepting writes user-accepted provenance and skips excluded items', () => {
  const items = [
    item('a', 'J:\\TV Shows\\Office (2005)\\S01E01.mkv', 1300),
    item('b', 'J:\\TV Shows\\Office (2005)\\S01E02.mkv', 1310),
  ];
  const [group] = suggestGroups(items);
  const updates = acceptGroup(group, Object.fromEntries(items.map((i) => [i.id, i])), { exclude: ['b'] });
  assert.deepEqual(updates.map((u) => u.id), ['a']);
  assert.deepEqual(updates[0].fields.series, { name: 'Office', season: 1, episode: 1 });
  assert.equal(updates[0].fields.provenance.series, 'user-accepted');
  assert.equal(updates[0].fields.provenance.kind, 'user-accepted');
  // Accepted items are not suggested again.
  const after = items.map((i) => {
    const u = updates.find((x) => x.id === i.id);
    return u ? { ...i, ...u.fields } : i;
  });
  const afterById = Object.fromEntries(after.map((i) => [i.id, i]));
  const again = suggestGroups(after).flatMap((g) => acceptGroup(g, afterById));
  assert.deepEqual(again.map((u) => u.id), ['b'], 'the accepted item has nothing left to suggest; the excluded one still does');
});

test('§8: 1,000 new episodes across series take fewer than 10 review actions', () => {
  const shows = [
    ['The Office (2005)', 22, 201], ['Seinfeld (1989)', 23, 180], ['Friends (1994)', 22, 236],
    ['Cheers (1982)', 24, 275], ['Frasier (1993)', 22, 108],
  ];
  const items = [];
  shows.forEach(([show, minutes, count]) => {
    for (let n = 0; n < count; n += 1) {
      const season = Math.floor(n / 22) + 1;
      const episode = (n % 22) + 1;
      const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      items.push(item(`${show}-${n}`, `J:\\Media Center\\TV Shows\\${show}\\Season ${season}\\${show.replace(/ \(\d+\)/, '')} - ${code}.mkv`, minutes * 60 + (n % 7)));
    }
  });
  assert.equal(items.length, 1000);
  const groups = suggestGroups(items);
  assert.ok(groups.length < 10, `${groups.length} groups`);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const updates = groups.flatMap((group) => acceptGroup(group, byId));
  assert.equal(updates.length, 1000, 'every episode is covered by accepting its group once');
  assert.ok(updates.every((u) => u.fields.kind === 'episode' && u.fields.series && u.fields.series.name));
});
