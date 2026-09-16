// Builds a synthetic DVD-Video structure: the IFO index files, and (given an
// ffmpeg) real DVD-compliant VOBs to go with them.
//
// Shared by the parser's unit checks (tests/ui/verify-dvd-ifo.js) and the tape
// deck's end-to-end driver, so the byte layout is written down once. The
// layout here matches what plugins/tape-deck/dvd-ifo.js reads, which makes
// these fixtures a check of the parsing CODE rather than of the specification
// reading behind it — see verify-dvd-ifo.js's header for what that does and
// does not cover.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SECTOR = 2048;

function toBcd(value) {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

// hh:mm:ss plus frames, with the rate code the format packs into the top two
// bits of the frames byte (0b11 = 30fps).
function writeTime(buf, at, h, m, s, frames = 0) {
  buf.writeUInt8(toBcd(h), at);
  buf.writeUInt8(toBcd(m), at + 1);
  buf.writeUInt8(toBcd(s), at + 2);
  buf.writeUInt8(0xc0 | toBcd(frames), at + 3);
}

// VIDEO_TS.IFO — the disc's own index. `titles` are
// { vts, vtsTitle, chapters, angles?, startSector? }.
function buildVideoTsIfo(titles) {
  const buf = Buffer.alloc(SECTOR * 2);
  buf.write('DVDVIDEO-VMG', 0, 'latin1');
  buf.writeUInt16BE(titles.reduce((max, t) => Math.max(max, t.vts), 0), 0x3e);
  buf.writeUInt32BE(1, 0xc4); // TT_SRPT lives in sector 1

  const at = SECTOR;
  buf.writeUInt16BE(titles.length, at);
  buf.writeUInt32BE(8 + titles.length * 12 - 1, at + 4);
  titles.forEach((t, i) => {
    const base = at + 8 + i * 12;
    buf.writeUInt8(0, base);
    buf.writeUInt8(t.angles || 1, base + 1);
    buf.writeUInt16BE(t.chapters, base + 2);
    buf.writeUInt8(t.vts, base + 6);
    buf.writeUInt8(t.vtsTitle, base + 7);
    buf.writeUInt32BE(t.startSector || 0, base + 8);
  });
  return buf;
}

// VTS_xx_0.IFO — one title set. Each title is
// { chapters: [{pgcn, pgn}], programStartCells: [n], cellSeconds: [n], total: [h, m, s] }.
function buildVtsIfo({ audio = [], subtitles = [], titles = [] }) {
  // Header, PTT table, PGC table, then one sector per program chain.
  const buf = Buffer.alloc(SECTOR * (3 + titles.length + 1));
  buf.write('DVDVIDEO-VTS', 0, 'latin1');

  buf.writeUInt16BE(audio.length, 0x202);
  audio.forEach((a, i) => {
    const base = 0x204 + i * 8;
    buf.writeUInt8(((a.codingBits & 0x07) << 5) | (a.hasLanguage ? 0x04 : 0), base);
    buf.writeUInt8((a.channels || 1) - 1, base + 1);
    if (a.hasLanguage) buf.write(a.language, base + 2, 'latin1');
  });

  buf.writeUInt16BE(subtitles.length, 0x254);
  subtitles.forEach((sub, i) => {
    const base = 0x256 + i * 6;
    buf.writeUInt8(((sub.codingBits & 0x07) << 5) | (sub.hasLanguage ? 0x01 : 0), base);
    if (sub.hasLanguage) buf.write(sub.language, base + 2, 'latin1');
  });

  buf.writeUInt32BE(1, 0xc8); // VTS_PTT_SRPT
  buf.writeUInt32BE(2, 0xcc); // VTS_PGCIT

  const pttAt = SECTOR;
  buf.writeUInt16BE(titles.length, pttAt);
  let cursor = 8 + titles.length * 4;
  const offsets = [];
  titles.forEach((t) => { offsets.push(cursor); cursor += t.chapters.length * 4; });
  buf.writeUInt32BE(cursor - 1, pttAt + 4);
  titles.forEach((t, i) => {
    buf.writeUInt32BE(offsets[i], pttAt + 8 + i * 4);
    t.chapters.forEach((chapter, c) => {
      const at = pttAt + offsets[i] + c * 4;
      buf.writeUInt16BE(chapter.pgcn, at);
      buf.writeUInt16BE(chapter.pgn, at + 2);
    });
  });

  const pgcitAt = SECTOR * 2;
  buf.writeUInt16BE(titles.length, pgcitAt);
  titles.forEach((t, i) => {
    const chainOffset = SECTOR * (i + 1);
    buf.writeUInt32BE(0, pgcitAt + 8 + i * 8);
    buf.writeUInt32BE(chainOffset, pgcitAt + 8 + i * 8 + 4);

    const at = pgcitAt + chainOffset;
    buf.writeUInt8(t.programStartCells.length, at + 2);
    buf.writeUInt8(t.cellSeconds.length, at + 3);
    writeTime(buf, at + 4, ...t.total);
    const programMapOffset = 0x100;
    const cellPlaybackOffset = 0x200;
    buf.writeUInt16BE(0, at + 0xe4);
    buf.writeUInt16BE(programMapOffset, at + 0xe6);
    buf.writeUInt16BE(cellPlaybackOffset, at + 0xe8);
    t.programStartCells.forEach((cell, p) => buf.writeUInt8(cell, at + programMapOffset + p));
    t.cellSeconds.forEach((secs, c) => {
      const cellAt = at + cellPlaybackOffset + c * 24;
      writeTime(buf, cellAt + 4, 0, Math.floor(secs / 60), secs % 60, 0);
      buf.writeUInt32BE(c * 1000, cellAt + 8);
      buf.writeUInt32BE((c + 1) * 1000 - 1, cellAt + 20);
    });
  });
  return buf;
}

// A complete VIDEO_TS folder on disk, with a real DVD-compliant VOB. One
// title set, one title, chapters as given.
//
// `claimedSeconds` is what the IFO says the title runs for and defaults to
// the VOB's real length. Setting it to something else is how the deck's
// "do the disc's own tables agree with what actually decoded" check gets
// tested from the failing side.
function writeVideoTsFolder(destDir, { ffmpegPath, seconds = 8, chapterSeconds = [0], claimedSeconds = null }) {
  fs.mkdirSync(destDir, { recursive: true });
  const claimed = claimedSeconds == null ? seconds : claimedSeconds;

  // Cells sized so the chapter starts land where the caller asked.
  const cellSeconds = chapterSeconds.map((start, i) => (
    (i + 1 < chapterSeconds.length ? chapterSeconds[i + 1] : claimed) - start
  ));
  const videoTs = buildVideoTsIfo([{ vts: 1, vtsTitle: 1, chapters: chapterSeconds.length }]);
  const vts = buildVtsIfo({
    audio: [{ codingBits: 0, channels: 2, hasLanguage: true, language: 'en' }],
    titles: [{
      chapters: chapterSeconds.map((_, i) => ({ pgcn: 1, pgn: i + 1 })),
      programStartCells: chapterSeconds.map((_, i) => i + 1),
      cellSeconds,
      total: [0, Math.floor(claimed / 60), Math.round(claimed % 60)],
    }],
  });
  fs.writeFileSync(path.join(destDir, 'VIDEO_TS.IFO'), videoTs);
  fs.writeFileSync(path.join(destDir, 'VTS_01_0.IFO'), vts);

  // A genuine MPEG-2 program stream at DVD parameters, which is exactly what
  // a VOB is — so the deck's rip path is exercised for real rather than
  // against a stand-in.
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=704x480:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-target', 'ntsc-dvd', '-shortest',
    path.join(destDir, 'VTS_01_1.VOB'),
  ], { stdio: 'pipe' });

  return destDir;
}

module.exports = { buildVideoTsIfo, buildVtsIfo, writeVideoTsFolder, writeTime, SECTOR };
