// Music Choice channel (plugins/music-choice-channel): the tag reader behind
// search-by-year/album, and the pure search/on-demand helpers in renderer.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pluginDir = path.join(__dirname, '..', 'plugins', 'music-choice-channel');
const { readTrackTags, bufferIo, yearOf } = require(path.join(pluginDir, 'tags.js'));

// ---------- Tag fixtures ----------

function synchsafeBytes(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function id3v23(frames, { padding = 16 } = {}) {
  const body = Buffer.concat([...frames.map(([id, text, enc = 0]) => {
    const payload = enc === 1
      ? Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      : Buffer.concat([Buffer.from([enc]), Buffer.from(text, enc === 3 ? 'utf8' : 'latin1')]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 'latin1');
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }), Buffer.alloc(padding)]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synchsafeBytes(body.length), body]);
}

function id3v24(frames) {
  const body = Buffer.concat(frames.map(([id, text]) => {
    const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 'latin1');
    synchsafeBytes(payload.length).copy(header, 4);
    return Buffer.concat([header, payload]);
  }));
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), synchsafeBytes(body.length), body]);
}

function id3v1({ title = '', artist = '', album = '', year = '' }) {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 0, 'latin1');
  tag.write(title, 3, 30, 'latin1');
  tag.write(artist, 33, 30, 'latin1');
  tag.write(album, 63, 30, 'latin1');
  tag.write(year, 93, 4, 'latin1');
  return tag;
}

function vorbisComment(entries) {
  const vendor = Buffer.from('test vendor');
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)];
  parts[0].writeUInt32LE(vendor.length);
  parts[2].writeUInt32LE(entries.length);
  entries.forEach((e) => {
    const b = Buffer.from(e, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    parts.push(len, b);
  });
  return Buffer.concat(parts);
}

function flacBlock(type, body, last) {
  const header = Buffer.from([(last ? 0x80 : 0) | type, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

function oggPage(packetData, lacing) {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), packetData]);
}

function lacingFor(length, terminate) {
  const out = [];
  let left = length;
  while (left >= 255) { out.push(255); left -= 255; }
  if (terminate) out.push(left);
  else if (left) throw new Error('an unterminated packet must fill whole segments');
  return out;
}

function atom(type, ...children) {
  const body = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function mp4Text(type, text) {
  const data = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(text, 'utf8')]);
  return atom(type, atom('data', data));
}

// An io that records how many bytes were actually read.
function countingIo(buf) {
  const io = bufferIo(buf);
  io.bytesRead = 0;
  const read = io.readRange;
  io.readRange = async (start, length) => {
    const out = await read(start, length);
    io.bytesRead += out.length;
    return out;
  };
  return io;
}

// ---------- tags.js ----------

test('ID3v2.3 text frames, including UTF-16 with a BOM', async () => {
  const buf = Buffer.concat([
    id3v23([['TIT2', 'Wonderwall'], ['TPE1', 'Oasis'], ['TALB', "(What's the Story) Morning Glory?"], ['TYER', '1995'], ['TPE2', 'Oasis', 1]]),
    Buffer.alloc(4096),
  ]);
  assert.deepEqual(await readTrackTags(bufferIo(buf)), {
    artist: 'Oasis', title: 'Wonderwall', album: "(What's the Story) Morning Glory?", albumArtist: 'Oasis', year: '1995',
  });
});

test('ID3v2.4 prefers the original release year over a reissue date', async () => {
  const buf = Buffer.concat([id3v24([['TIT2', 'Beyoncé Song'], ['TDRC', '2011-06-24'], ['TDOR', '2003']]), Buffer.alloc(512)]);
  const tags = await readTrackTags(bufferIo(buf));
  assert.equal(tags.title, 'Beyoncé Song');
  assert.equal(tags.year, '2003');
});

test('ID3v1 at the tail fills fields v2 lacked, and v2 wins where both exist', async () => {
  const buf = Buffer.concat([id3v23([['TIT2', 'From V2']]), Buffer.alloc(2048), id3v1({ title: 'From V1', artist: 'V1 Artist', album: 'V1 Album', year: '1987' })]);
  assert.deepEqual(await readTrackTags(bufferIo(buf)), { title: 'From V2', artist: 'V1 Artist', album: 'V1 Album', year: '1987' });
});

test('FLAC: walks past a large picture block to the Vorbis comment without reading it', async () => {
  const picture = flacBlock(6, Buffer.alloc(3 * 1024 * 1024));
  const comment = flacBlock(4, vorbisComment(['TITLE=Clair de Lune', 'ARTIST=Debussy', 'DATE=1905-01-01', 'ALBUMARTIST=Various']), true);
  const buf = Buffer.concat([Buffer.from('fLaC'), flacBlock(0, Buffer.alloc(34)), picture, comment, Buffer.alloc(1024)]);
  const io = countingIo(buf);
  const tags = await readTrackTags(io);
  assert.deepEqual(tags, { artist: 'Debussy', title: 'Clair de Lune', albumArtist: 'Various', year: '1905' });
  assert.ok(io.bytesRead < 200 * 1024, `read ${io.bytesRead} bytes of a ${buf.length}-byte file`);
});

test('Ogg Vorbis: a comment packet that spans two pages is reassembled', async () => {
  const ident = Buffer.concat([Buffer.from('\u0001vorbis', 'latin1'), Buffer.alloc(23)]);
  const comment = Buffer.concat([Buffer.from('\u0003vorbis', 'latin1'), vorbisComment(['TITLE=Split Song', 'ARTIST=Pager', `ALBUM=${'x'.repeat(300)}`, 'DATE=1999'])]);
  const cut = 255 * 1;
  const page1 = oggPage(ident, lacingFor(ident.length, true));
  const page2 = oggPage(comment.subarray(0, cut), lacingFor(cut, false));
  const page3 = oggPage(comment.subarray(cut), lacingFor(comment.length - cut, true));
  const tags = await readTrackTags(bufferIo(Buffer.concat([page1, page2, page3, Buffer.alloc(256)])));
  assert.equal(tags.title, 'Split Song');
  assert.equal(tags.artist, 'Pager');
  assert.equal(tags.year, '1999');
});

test('MP4: finds moov after mdat and reads the ilst', async () => {
  const ftyp = atom('ftyp', Buffer.from('M4A \u0000\u0000\u0000\u0000', 'latin1'));
  const mdat = atom('mdat', Buffer.alloc(2 * 1024 * 1024));
  const ilst = atom('ilst', mp4Text('\u00a9nam', 'Hey Ya!'), mp4Text('\u00a9ART', 'OutKast'), mp4Text('\u00a9alb', 'Speakerboxxx'), mp4Text('\u00a9day', '2003-09-23T07:00:00Z'));
  const meta = atom('meta', Buffer.alloc(4), atom('hdlr', Buffer.alloc(25)), ilst);
  const moov = atom('moov', atom('mvhd', Buffer.alloc(100)), atom('udta', meta));
  const io = countingIo(Buffer.concat([ftyp, mdat, moov]));
  assert.deepEqual(await readTrackTags(io), { artist: 'OutKast', title: 'Hey Ya!', album: 'Speakerboxxx', year: '2003' });
  assert.ok(io.bytesRead < 200 * 1024, `read ${io.bytesRead} bytes`);
});

test('malformed or unknown input yields no tags rather than throwing', async () => {
  const cases = [
    Buffer.alloc(0),
    Buffer.from('ID3\u0003\u0000\u0000\u007f\u007f\u007f\u007fTIT2', 'latin1'),
    Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x84, 0xff, 0xff, 0xff])]),
    Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from([0, 0, 0, 3])]),
    Buffer.from('RIFF....WAVEfmt '.repeat(20)),
  ];
  for (const buf of cases) {
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await readTrackTags(bufferIo(buf)), {});
  }
});

test('yearOf takes the four-digit year out of any date shape', () => {
  assert.equal(yearOf('1997'), '1997');
  assert.equal(yearOf('1997-05-12'), '1997');
  assert.equal(yearOf('12 May 2004'), '2004');
  assert.equal(yearOf('20th anniversary'), null);
});

// ---------- renderer.js (pure parts) ----------

async function loadRenderer() {
  globalThis.window = globalThis.window || {};
  window.RCBPlugins = { registerChannelType() {}, ctx: { settings: { getPluginSettings: () => ({}), updatePluginSettings() {} } } };
  return import(pathToFileURL(path.join(pluginDir, 'renderer.js')).href);
}

function track(p, extra = {}) {
  return { path: p, durationSec: 200, ...extra };
}

const stations = [
  {
    id: 'a',
    tracks: [
      track('C:/Music/Oasis - Wonderwall (1995).mp3'),
      track('C:/Music/Oasis/Be Here Now/02 D\'You Know What I Mean.mp3', { tags: { year: '1997' } }),
      track('C:/Music/x.mp3', { tags: { artist: 'Beyoncé', title: 'Crazy in Love', album: 'Dangerously in Love', year: '2003' }, tagsRead: true }),
    ],
  },
  {
    id: 'b',
    tracks: [
      // The same file in a second station is still one song.
      track('C:/Music/Oasis - Wonderwall (1995).mp3'),
      track('C:/Music/Blur - Song 2 (1997).mp3'),
    ],
  },
];

test('parseYearQuery understands years, decades and ranges', async () => {
  const { parseYearQuery } = await loadRenderer();
  assert.deepEqual(parseYearQuery('1997'), { from: 1997, to: 1997 });
  assert.deepEqual(parseYearQuery('1990s'), { from: 1990, to: 1999 });
  assert.deepEqual(parseYearQuery("'90s"), { from: 1990, to: 1999 });
  assert.deepEqual(parseYearQuery('00s'), { from: 2000, to: 2009 });
  assert.deepEqual(parseYearQuery('1999 - 1995'), { from: 1995, to: 1999 });
  assert.deepEqual(parseYearQuery('1995 to 1999'), { from: 1995, to: 1999 });
  assert.equal(parseYearQuery('oasis'), null);
  assert.equal(parseYearQuery('1234'), null);
});

test('trackMetaOf: hand-set fields, then tags, then the filename', async () => {
  const { trackMetaOf } = await loadRenderer();
  const meta = trackMetaOf(track('C:/Music/Oasis - Wonderwall (1995).mp3', { title: 'Hand Set', tags: { artist: 'Tag Artist', year: '1996' } }));
  assert.equal(meta.title, 'Hand Set');
  assert.equal(meta.artist, 'TAG ARTIST');
  assert.equal(meta.year, '1996');
  assert.equal(trackMetaOf(track('C:/Music/Oasis - Wonderwall (1995).mp3')).year, '1995');
});

test('searchLibrary: songs by text (accents ignored) and by year, deduplicated across stations', async () => {
  const { buildLibraryIndex, searchLibrary } = await loadRenderer();
  const index = buildLibraryIndex(stations);
  assert.equal(index.length, 4);
  assert.deepEqual(searchLibrary(index, 'beyonce', 'songs').map((r) => r.label), ['Crazy in Love']);
  assert.deepEqual(searchLibrary(index, '1997', 'songs').map((r) => r.label).sort(), ["D'You Know What I Mean", 'Song 2']);
  const all = searchLibrary(index, '', 'songs');
  assert.equal(all.length, 4);
  // Picking a song keeps playing the results after it.
  assert.equal(all[0].tracks.length, 4);
  assert.equal(all[3].tracks.length, 1);
});

test('searchLibrary: artists, albums and years group and play everything in the group', async () => {
  const { buildLibraryIndex, searchLibrary } = await loadRenderer();
  const index = buildLibraryIndex(stations);
  const oasis = searchLibrary(index, 'oasis', 'artists');
  assert.deepEqual(oasis.map((r) => r.label), ['OASIS']);
  assert.equal(oasis[0].tracks.length, 2);
  assert.deepEqual(searchLibrary(index, 'dangerously', 'albums').map((r) => r.label), ['Dangerously in Love']);
  const years = searchLibrary(index, '90s', 'years');
  assert.deepEqual(years.map((r) => r.label), ['THE 1990s', '1995', '1997']);
  assert.equal(years[0].tracks.length, 3);
  assert.equal(years[2].tracks.length, 2);
});

test('rotationQueueFrom continues the loop from the song that was playing', async () => {
  const { rotationQueueFrom, computeStationPlayback } = await loadRenderer();
  const station = { anchorMs: 0, tracks: [track('1'), track('2'), track('3')] };
  const pb = computeStationPlayback(station, 250 * 1000);
  assert.equal(pb.index, 1);
  assert.deepEqual(rotationQueueFrom(station, pb).map((t) => t.path), ['2', '3', '1']);
});
