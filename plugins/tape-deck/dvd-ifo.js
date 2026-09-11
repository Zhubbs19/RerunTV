// Reads a DVD-Video disc's own structure out of its IFO files: what titles
// are on it, where each one's chapters fall, and which audio and subtitle
// streams it carries.
//
// Pure byte parsing over Buffers — no I/O, no ffmpeg, no Electron — so it can
// be unit-tested with plain node. Everything that has to actually touch a
// disc lives in main.js.
//
// What this deliberately does NOT do is navigate the disc's own menu. A
// pressed menu is a video background plus a subpicture overlay drawing the
// button highlights plus button geometry plus a small virtual machine that
// runs the disc's own bytecode. Reproducing that needs libdvdnav, a
// subpicture decoder and a VM interpreter. The deck builds its menu from the
// title and chapter structure below instead. The raw PGC command table and
// the per-PGC data a navigator would need are still handed back untouched
// (see `raw` on each title), so that project stays possible without
// re-deriving any of this.
//
// Offsets follow the DVD-Video specification. Sector numbers inside an IFO
// are relative to the start of that IFO, in 2048-byte sectors.

const SECTOR = 2048;

// Every read goes through these. An IFO from a scratched disc, a truncated
// rip, or something that simply is not an IFO must produce a clear refusal
// rather than plausible-looking nonsense derived from whatever bytes are
// there — a wrong chapter table is worse than no chapter table.
function u8(buf, at) {
  if (at < 0 || at + 1 > buf.length) throw new RangeError(`byte ${at} past end of ${buf.length}`);
  return buf.readUInt8(at);
}

function u16(buf, at) {
  if (at < 0 || at + 2 > buf.length) throw new RangeError(`uint16 at ${at} past end of ${buf.length}`);
  return buf.readUInt16BE(at);
}

function u32(buf, at) {
  if (at < 0 || at + 4 > buf.length) throw new RangeError(`uint32 at ${at} past end of ${buf.length}`);
  return buf.readUInt32BE(at);
}

// DVD times are BCD — 0x23 means 23, not 35 — with the frame rate packed
// into the top two bits of the frames byte.
function bcd(value) {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

function readPlaybackSeconds(buf, at) {
  const hours = bcd(u8(buf, at));
  const minutes = bcd(u8(buf, at + 1));
  const seconds = bcd(u8(buf, at + 2));
  const frameByte = u8(buf, at + 3);
  // 0b11 = 30fps (NTSC, really 29.97), 0b10 = 25fps (PAL). Anything else
  // means the field is not a time at all, so the frames contribute nothing
  // rather than an invented fraction.
  const rateCode = (frameByte >> 6) & 0x03;
  const fps = rateCode === 3 ? 30000 / 1001 : rateCode === 2 ? 25 : 0;
  const frames = bcd(frameByte & 0x3f);
  return hours * 3600 + minutes * 60 + seconds + (fps ? frames / fps : 0);
}

const AUDIO_CODINGS = { 0: 'ac3', 2: 'mpeg1', 3: 'mpeg2', 4: 'lpcm', 6: 'dts' };
const SUBPICTURE_CODINGS = { 0: 'rle', 1: 'extended' };

// A two-letter ISO 639-1 code, stored as raw ASCII. Zeroes mean the disc
// did not say, which is common and not an error.
function languageCode(buf, at) {
  try {
    const a = u8(buf, at);
    const b = u8(buf, at + 1);
    if (a < 0x41 || b < 0x41) return null;
    return String.fromCharCode(a, b).toLowerCase();
  } catch (e) {
    return null;
  }
}

function readAudioAttributes(buf, at, count) {
  const streams = [];
  for (let i = 0; i < count && i < 8; i++) {
    const base = at + i * 8;
    try {
      const first = u8(buf, base);
      const second = u8(buf, base + 1);
      streams.push({
        index: i,
        coding: AUDIO_CODINGS[(first >> 5) & 0x07] || 'unknown',
        channels: (second & 0x07) + 1,
        // Bit 2 of the first byte says whether the language field is even
        // populated; without it those two bytes are leftovers, not a code.
        language: ((first >> 2) & 0x03) === 1 ? languageCode(buf, base + 2) : null,
      });
    } catch (e) {
      break; // a truncated table gives up the rest, it does not sink the title
    }
  }
  return streams;
}

function readSubpictureAttributes(buf, at, count) {
  const streams = [];
  for (let i = 0; i < count && i < 32; i++) {
    const base = at + i * 6;
    try {
      const first = u8(buf, base);
      streams.push({
        index: i,
        coding: SUBPICTURE_CODINGS[(first >> 5) & 0x07] || 'unknown',
        language: (first & 0x03) === 1 ? languageCode(buf, base + 2) : null,
      });
    } catch (e) {
      break;
    }
  }
  return streams;
}

// ---------- VIDEO_TS.IFO (the disc's own index) ----------

// TT_SRPT is the disc-wide title list: for each title, which title set holds
// it, which title it is within that set, and how many chapters it has.
function readTitleSearchPointers(buf, at) {
  const count = u16(buf, at);
  const titles = [];
  for (let i = 0; i < count; i++) {
    const base = at + 8 + i * 12;
    try {
      titles.push({
        title: i + 1,
        playbackType: u8(buf, base),
        angles: u8(buf, base + 1),
        chapters: u16(buf, base + 2),
        vts: u8(buf, base + 6),
        vtsTitle: u8(buf, base + 7),
        startSector: u32(buf, base + 8),
      });
    } catch (e) {
      break;
    }
  }
  return titles;
}

// Parses VIDEO_TS.IFO. Returns { titleSets, titles } or { error }.
function parseVideoTsIfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SECTOR) {
    return { error: 'VIDEO_TS.IFO is too short to be a DVD index.' };
  }
  if (buffer.toString('latin1', 0, 12) !== 'DVDVIDEO-VMG') {
    return { error: 'That is not a DVD-Video index file (VIDEO_TS.IFO).' };
  }
  try {
    const titleSets = u16(buffer, 0x3e);
    const ttSrptSector = u32(buffer, 0xc4);
    if (!ttSrptSector) return { error: 'This disc lists no titles.' };
    const titles = readTitleSearchPointers(buffer, ttSrptSector * SECTOR);
    if (!titles.length) return { error: 'This disc lists no titles.' };
    return { titleSets, titles };
  } catch (e) {
    return { error: `VIDEO_TS.IFO could not be read: ${e.message}` };
  }
}

// ---------- VTS_xx_0.IFO (one title set) ----------

// The program chain: how many programs (chapters) and cells it has, how long
// it runs, and where each cell sits. Chapter start times come from summing
// cell durations, because a cell is the smallest unit the disc times.
function readProgramChain(buf, at) {
  const programs = u8(buf, at + 2);
  const cells = u8(buf, at + 3);
  const totalSeconds = readPlaybackSeconds(buf, at + 4);
  const commandTableOffset = u16(buf, at + 0xe4);
  const programMapOffset = u16(buf, at + 0xe6);
  const cellPlaybackOffset = u16(buf, at + 0xe8);

  // Which cell each program starts at, 1-based.
  const programStartCells = [];
  for (let i = 0; i < programs; i++) programStartCells.push(u8(buf, at + programMapOffset + i));

  const cellSeconds = [];
  const cellSectors = [];
  for (let i = 0; i < cells; i++) {
    const base = at + cellPlaybackOffset + i * 24;
    cellSeconds.push(readPlaybackSeconds(buf, base + 4));
    cellSectors.push({ first: u32(buf, base + 8), last: u32(buf, base + 20) });
  }

  // Elapsed time at the start of each cell, so a chapter's start is just a
  // lookup rather than a second pass.
  const cellStarts = [];
  let elapsed = 0;
  for (let i = 0; i < cells; i++) { cellStarts.push(elapsed); elapsed += cellSeconds[i]; }

  return {
    programs,
    cells,
    totalSeconds,
    cellSeconds,
    cellSectors,
    chapterStarts: programStartCells.map((cell) => cellStarts[cell - 1] || 0),
    // Untouched, for a future navigator — see this file's header.
    commandTableOffset,
  };
}

// Parses a VTS_xx_0.IFO. Returns { audio, subtitles, programChains, pttByTitle }
// or { error }. `pttByTitle` maps a title's number WITHIN this set to the
// chapters it is made of.
function parseVtsIfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SECTOR) {
    return { error: 'A title-set index (VTS_xx_0.IFO) is too short.' };
  }
  if (buffer.toString('latin1', 0, 12) !== 'DVDVIDEO-VTS') {
    return { error: 'That is not a DVD-Video title-set index (VTS_xx_0.IFO).' };
  }
  try {
    const audioCount = u16(buffer, 0x202);
    const subtitleCount = u16(buffer, 0x254);
    const audio = readAudioAttributes(buffer, 0x204, audioCount);
    const subtitles = readSubpictureAttributes(buffer, 0x256, subtitleCount);

    const pttSector = u32(buffer, 0xc8);
    const pgcitSector = u32(buffer, 0xcc);

    // Part-of-title tables: for each title in this set, the (chain, program)
    // pair each of its chapters lives at.
    const pttByTitle = [];
    if (pttSector) {
      const pttAt = pttSector * SECTOR;
      const titleCount = u16(buffer, pttAt);
      // The table's own end, as a byte address relative to its start.
      const tableEnd = pttAt + u32(buffer, pttAt + 4) + 1;
      for (let i = 0; i < titleCount; i++) {
        const offset = u32(buffer, pttAt + 8 + i * 4);
        const entriesAt = pttAt + offset;
        // No per-title length is stored, so a title's chapters run until the
        // next title's table starts, and the last one runs to the table end.
        const limit = i + 1 < titleCount
          ? pttAt + u32(buffer, pttAt + 8 + (i + 1) * 4)
          : tableEnd;
        const chapters = [];
        for (let at = entriesAt; at + 4 <= limit && at + 4 <= buffer.length; at += 4) {
          chapters.push({ pgcn: u16(buffer, at), pgn: u16(buffer, at + 2) });
        }
        pttByTitle.push(chapters);
      }
    }

    const programChains = [];
    if (pgcitSector) {
      const pgcitAt = pgcitSector * SECTOR;
      const pgcCount = u16(buffer, pgcitAt);
      for (let i = 0; i < pgcCount; i++) {
        const entryAt = pgcitAt + 8 + i * 8;
        const offset = u32(buffer, entryAt + 4);
        try {
          programChains.push(readProgramChain(buffer, pgcitAt + offset));
        } catch (e) {
          programChains.push(null); // one unreadable chain, not a dead title set
        }
      }
    }

    return { audio, subtitles, programChains, pttByTitle };
  } catch (e) {
    return { error: `A title-set index could not be read: ${e.message}` };
  }
}

// ---------- putting a disc together ----------

// Combines the disc index with each title set's own index into the list the
// deck's menu is built from. `vtsBuffers` maps a title-set number to that
// set's VTS_xx_0.IFO contents.
//
// A title whose set is missing or unreadable is still listed, with whatever
// the disc index alone knows (its chapter count), because a disc with one bad
// title set is still worth playing the rest of.
function readDiscStructure(videoTsBuffer, vtsBuffers) {
  const index = parseVideoTsIfo(videoTsBuffer);
  if (index.error) return index;

  const sets = new Map();
  const setErrors = [];
  Object.entries(vtsBuffers || {}).forEach(([number, buffer]) => {
    const parsed = parseVtsIfo(buffer);
    if (parsed.error) setErrors.push(`VTS ${number}: ${parsed.error}`);
    else sets.set(Number(number), parsed);
  });

  const titles = index.titles.map((entry) => {
    const set = sets.get(entry.vts);
    const base = {
      title: entry.title,
      vts: entry.vts,
      angles: entry.angles,
      chapterCount: entry.chapters,
      chapters: [],
      durationS: 0,
      audio: set ? set.audio : [],
      subtitles: set ? set.subtitles : [],
    };
    if (!set) return base;

    const ptt = set.pttByTitle[entry.vtsTitle - 1] || [];
    // Every chapter of a title normally lives in one chain; the first
    // chapter's chain is the one that holds the title's runtime.
    const chainNumber = ptt.length ? ptt[0].pgcn : 0;
    const chain = chainNumber ? set.programChains[chainNumber - 1] : null;
    if (!chain) return base;

    base.durationS = chain.totalSeconds;
    base.chapters = ptt.map((part, i) => ({
      chapter: i + 1,
      startS: chain.chapterStarts[part.pgn - 1] || 0,
    }));
    // Trust the disc index's own count if the tables disagree; a chapter list
    // shorter than the count just means some were unreadable.
    if (!base.chapters.length && entry.chapters > 0) {
      base.chapters = [{ chapter: 1, startS: 0 }];
    }
    base.raw = { programChain: chain };
    return base;
  });

  return { titleSets: index.titleSets, titles, warnings: setErrors };
}

// The IFO files a disc needs read, given its title-set count. Named the way
// they appear in a VIDEO_TS folder.
function ifoFileNames(titleSets) {
  const names = ['VIDEO_TS.IFO'];
  for (let i = 1; i <= titleSets && i <= 99; i++) {
    names.push(`VTS_${String(i).padStart(2, '0')}_0.IFO`);
  }
  return names;
}

module.exports = {
  parseVideoTsIfo,
  parseVtsIfo,
  readDiscStructure,
  ifoFileNames,
  readPlaybackSeconds,
};
