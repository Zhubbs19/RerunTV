// The tape deck's DVD IFO parser, checked against synthetic discs. Plain
// node:test, so it runs in the same `npm test` gate CI uses — byte parsing is
// easy to regress and needs no Electron to cover.
//
// What this does and does not prove: the fixtures are built to the same byte
// layout the parser reads, so this catches an off-by-one, a wrong field
// width, a bad BCD decode or a regression, and it cannot catch a field being
// at the wrong offset in the real DVD-Video format. The deck covers that gap
// from the other side at runtime — a title whose IFO runtime disagrees with
// what ffmpeg actually decoded loses its chapters rather than getting wrong
// ones (see discChapters in plugins/tape-deck/main.js, and the end-to-end
// disc checks in tests/ui/verify-recording.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVideoTsIfo, parseVtsIfo, readDiscStructure, ifoFileNames, readPlaybackSeconds,
} = require('../plugins/tape-deck/dvd-ifo');
// Shared with the end-to-end driver so the layout is written down once.
const { buildVideoTsIfo, buildVtsIfo, writeTime, SECTOR } = require('./ui/lib/dvd-fixture');

test('BCD playback times decode, frame rate included', () => {
  const buf = Buffer.alloc(8);
  writeTime(buf, 0, 1, 23, 45, 15);
  const seconds = readPlaybackSeconds(buf, 0);
  assert.equal(Math.floor(seconds), 1 * 3600 + 23 * 60 + 45);
  // 15 frames at 29.97fps is half a second, not 15 of anything.
  assert.ok(seconds % 1 > 0.4 && seconds % 1 < 0.6, `frames decoded as ${seconds % 1}`);
});

test('a non-DVD file is refused rather than parsed', () => {
  assert.match(parseVideoTsIfo(Buffer.alloc(SECTOR)).error, /not a DVD-Video index/);
  assert.match(parseVtsIfo(Buffer.alloc(SECTOR)).error, /not a DVD-Video title-set index/);
  assert.match(parseVideoTsIfo(Buffer.alloc(10)).error, /too short/);
  assert.match(parseVideoTsIfo(null).error, /too short/);
});

test('the disc index lists its titles', () => {
  const ifo = buildVideoTsIfo([
    { vts: 1, vtsTitle: 1, chapters: 3, angles: 1 },
    { vts: 2, vtsTitle: 1, chapters: 1, angles: 1 },
  ]);
  const parsed = parseVideoTsIfo(ifo);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.titleSets, 2);
  assert.deepEqual(parsed.titles[0], {
    title: 1, playbackType: 0, angles: 1, chapters: 3, vts: 1, vtsTitle: 1, startSector: 0,
  });
  assert.equal(parsed.titles[1].vts, 2);
});

test('a title set reports its audio and subtitle streams', () => {
  const ifo = buildVtsIfo({
    audio: [
      { codingBits: 0, channels: 6, hasLanguage: true, language: 'en' },
      { codingBits: 4, channels: 2, hasLanguage: false, language: '  ' },
    ],
    subtitles: [{ codingBits: 0, hasLanguage: true, language: 'fr' }],
    titles: [{ chapters: [{ pgcn: 1, pgn: 1 }], programStartCells: [1], cellSeconds: [10], total: [0, 0, 10] }],
  });
  const parsed = parseVtsIfo(ifo);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.audio[0], { index: 0, coding: 'ac3', channels: 6, language: 'en' });
  // Without the language-present bit those two bytes are leftovers, not a code.
  assert.deepEqual(parsed.audio[1], { index: 1, coding: 'lpcm', channels: 2, language: null });
  assert.deepEqual(parsed.subtitles[0], { index: 0, coding: 'rle', language: 'fr' });
});

test('chapter start times come from the cells before them', () => {
  const vts = buildVtsIfo({
    titles: [{
      chapters: [{ pgcn: 1, pgn: 1 }, { pgcn: 1, pgn: 2 }, { pgcn: 1, pgn: 3 }],
      programStartCells: [1, 3, 5],
      cellSeconds: [30, 30, 45, 45, 20],
      total: [0, 2, 50],
    }],
  });
  const chain = parseVtsIfo(vts).programChains[0];
  assert.equal(chain.programs, 3);
  assert.equal(chain.cells, 5);
  // Chapter 2 starts after two 30s cells; chapter 3 after two more of 45s.
  assert.deepEqual(chain.chapterStarts.map(Math.round), [0, 60, 150]);
  assert.equal(Math.round(chain.totalSeconds), 170);
});

test('a whole disc assembles into titles with chapters', () => {
  const videoTs = buildVideoTsIfo([
    { vts: 1, vtsTitle: 1, chapters: 3 },
    { vts: 1, vtsTitle: 2, chapters: 2 },
  ]);
  const vts1 = buildVtsIfo({
    audio: [{ codingBits: 0, channels: 2, hasLanguage: true, language: 'en' }],
    titles: [
      {
        chapters: [{ pgcn: 1, pgn: 1 }, { pgcn: 1, pgn: 2 }, { pgcn: 1, pgn: 3 }],
        programStartCells: [1, 2, 3],
        cellSeconds: [60, 120, 60],
        total: [0, 4, 0],
      },
      {
        chapters: [{ pgcn: 2, pgn: 1 }, { pgcn: 2, pgn: 2 }],
        programStartCells: [1, 2],
        cellSeconds: [90, 90],
        total: [0, 3, 0],
      },
    ],
  });
  const disc = readDiscStructure(videoTs, { 1: vts1 });
  assert.equal(disc.error, undefined);
  const [first, second] = disc.titles;
  assert.deepEqual(first.chapters.map((c) => Math.round(c.startS)), [0, 60, 180]);
  assert.equal(Math.round(first.durationS), 240);
  assert.equal(first.audio[0].language, 'en');
  assert.deepEqual(second.chapters.map((c) => Math.round(c.startS)), [0, 90]);
  assert.equal(Math.round(second.durationS), 180);
});

test('a missing title set still leaves its titles listed', () => {
  // One bad title set is not a reason to refuse the whole disc.
  const disc = readDiscStructure(buildVideoTsIfo([{ vts: 1, vtsTitle: 1, chapters: 5 }]), {});
  assert.equal(disc.error, undefined);
  assert.equal(disc.titles[0].chapterCount, 5);
  assert.equal(disc.titles[0].chapters.length, 0);
  assert.equal(disc.titles[0].durationS, 0);
});

test('an unreadable title set is reported, not thrown', () => {
  const disc = readDiscStructure(
    buildVideoTsIfo([{ vts: 1, vtsTitle: 1, chapters: 1 }]),
    { 1: Buffer.alloc(SECTOR) },
  );
  assert.equal(disc.error, undefined);
  assert.match(disc.warnings[0], /VTS 1/);
  assert.equal(disc.titles.length, 1);
});

test('the IFO file list matches a VIDEO_TS folder', () => {
  assert.deepEqual(ifoFileNames(0), ['VIDEO_TS.IFO']);
  assert.deepEqual(ifoFileNames(2), ['VIDEO_TS.IFO', 'VTS_01_0.IFO', 'VTS_02_0.IFO']);
  assert.equal(ifoFileNames(200).length, 100);
});
