// One media file in several playlists (renderer/js/library/file-copies.js):
// details saved on one entry reach every entry for the same path.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'library', 'file-copies.js')).href);

function lineup() {
  return {
    channels: [
      { number: 5, files: [{ path: 'D:/m/film.mkv', duration: 5400, description: 'Old text' }, { path: 'D:/m/other.mkv', duration: 60 }] },
      {
        number: 6,
        files: [{ path: 'D:/m/film.mkv', duration: 5400, description: 'Old text' }],
        blocks: [{ id: 'b1', files: [{ path: 'D:/m/film.mkv', duration: 5400, description: 'Written by hand' }] }],
      },
      { number: 7, files: [{ path: 'D:/m/film.mkv', duration: 5400 }] },
    ],
  };
}

test('every entry for a path is found, in channels and schedule blocks', async () => {
  const { fileCopies } = await load();
  const config = lineup();
  assert.equal(fileCopies(config, 'D:/m/film.mkv').length, 4);
  assert.equal(fileCopies(config, 'D:/m/missing.mkv').length, 0);
  assert.deepEqual(fileCopies(null, 'x'), []);
});

test('a match reaches every copy, and a hand-written description elsewhere stays', async () => {
  const { shareFileFields } = await load();
  const config = lineup();
  const source = config.channels[0].files[0];
  const tmdb = { id: 9, mediaType: 'movie', cast: ['A', 'B'] };
  const changed = shareFileFields(config, source, { tmdb, description: 'New overview' });
  assert.equal(changed.length, 4);
  const copies = [config.channels[0].files[0], config.channels[1].files[0], config.channels[1].blocks[0].files[0], config.channels[2].files[0]];
  copies.forEach((copy) => assert.deepEqual(copy.tmdb, tmdb));
  assert.equal(copies[0].description, 'New overview');
  assert.equal(copies[1].description, 'New overview', 'the same old text is replaced');
  assert.equal(copies[2].description, 'Written by hand', 'a different description is kept');
  assert.equal(copies[3].description, 'New overview', 'an empty one is filled');
  assert.notEqual(copies[1].tmdb, tmdb, 'each copy gets its own object');
  assert.equal(copies[0].duration, 5400);
  assert.equal(config.channels[0].files[1].tmdb, undefined, 'other files untouched');
  assert.equal(shareFileFields(config, source, { tmdb }).length, 0, 'nothing changes the second time');

  copies[3].title = 'A title of its own';
  copies[3].rating = 'TV-G';
  shareFileFields(config, source, { title: 'Episode Name', rating: 'TV-PG' });
  assert.equal(copies[1].title, 'Episode Name', 'an empty title is filled');
  assert.equal(copies[3].title, 'A title of its own', 'a title of its own is kept');
  assert.equal(copies[3].rating, 'TV-G', 'and so is a rating');
});

test('a new entry inherits what another copy already has, filling empty fields only', async () => {
  const { inheritFromCopies } = await load();
  const config = lineup();
  config.channels[1].files[0].tmdb = { id: 9, mediaType: 'movie' };
  config.channels[1].files[0].title = 'The Film';
  const fresh = { path: 'D:/m/film.mkv', duration: 5400, folder: 'f', title: 'My title' };
  const unknown = { path: 'D:/m/new.mkv', duration: 60, folder: 'f' };
  config.channels[2].files.push(fresh, unknown);
  assert.equal(inheritFromCopies(config, [fresh, unknown]), 1);
  assert.deepEqual(fresh.tmdb, { id: 9, mediaType: 'movie' });
  assert.equal(fresh.title, 'My title', 'a set title stays');
  assert.equal(fresh.description, 'Old text');
  assert.equal(unknown.tmdb, undefined);
});

test('the whole lineup shares existing details between copies, empty fields only', async () => {
  const { shareAcrossCopies } = await load();
  const config = lineup();
  config.channels[2].files[0].tmdb = { id: 9, mediaType: 'movie' };
  const filled = shareAcrossCopies(config);
  assert.equal(filled, 4, 'three copies gain the match, the fourth gains a description');
  assert.deepEqual(config.channels[0].files[0].tmdb, { id: 9, mediaType: 'movie' });
  assert.equal(config.channels[1].blocks[0].files[0].description, 'Written by hand');
  assert.equal(config.channels[2].files[0].description, 'Old text');
  assert.equal(shareAcrossCopies(config), 0, 'a second pass changes nothing');
});
