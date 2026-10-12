// Artist / title / album / year from a track's own tags, so the Digital Music
// channel can search a library by year and album even when the filenames say
// nothing about either. Pure Buffer parsing, no dependencies, same reasoning as
// embedded-art.js (which this shares its ID3 and MP4 helpers with).
//
//   .mp3          ID3v2.2 / v2.3 / v2.4 text frames, ID3v1 at the tail as a fallback
//   .flac         VORBIS_COMMENT block
//   .ogg .opus    Vorbis / Opus comment packet
//   .m4a .aac     MP4 moov.udta.meta.ilst
//
// Reads go through `io.readRange(start, length)`, so a tag costs a few
// kilobytes of the file rather than the whole thing — this runs once per track
// on every station rescan. Like embedded-art.js, every reader gives up and
// returns what it has (possibly nothing) on anything it does not recognise.
const { synchsafe, walkAtoms } = require('./embedded-art.js');

const HEAD_BYTES = 64 * 1024;
// Text frames come before the (often large) picture frame in practice, so a
// capped read loses only the art that embedded-art.js reads separately.
const MAX_ID3_BYTES = 2 * 1024 * 1024;
const MAX_BLOCK_BYTES = 1024 * 1024;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

const FIELDS = ['artist', 'title', 'album', 'albumArtist', 'year'];

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

// "1997", "1997-05-12", "1997/2003", "12 May 1997" all mean 1997.
function yearOf(value) {
  const match = String(value || '').match(/\b(1[89]\d{2}|20\d{2})\b/);
  return match ? match[1] : null;
}

function finish(raw) {
  const out = {};
  FIELDS.forEach((field) => {
    const value = field === 'year' ? yearOf(raw.year) : clean(raw[field]);
    if (value) out[field] = value;
  });
  return out;
}

// ---------- ID3v2 ----------

function swap16(buf) {
  const even = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  return even.swap16();
}

function decodeId3Text(frame) {
  if (!frame.length) return null;
  const encoding = frame[0];
  const body = frame.subarray(1);
  let text;
  if (encoding === 0) text = body.toString('latin1');
  else if (encoding === 3) text = body.toString('utf8');
  else if (encoding === 2) text = swap16(body).toString('utf16le');
  else if (encoding === 1) {
    if (body[0] === 0xfe && body[1] === 0xff) text = swap16(body.subarray(2)).toString('utf16le');
    else if (body[0] === 0xff && body[1] === 0xfe) text = body.subarray(2).toString('utf16le');
    else text = body.toString('utf16le');
  } else return null;
  // v2.4 separates multiple values with a null; the first is the one to show.
  return clean(text.replace(/^﻿/, '').split('\u0000')[0]);
}

function undoUnsync(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    out.push(buf[i]);
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
}

const ID3_FRAMES = {
  2: { TT2: 'title', TP1: 'artist', TP2: 'albumArtist', TAL: 'album', TYE: 'year', TOR: 'originalYear' },
  3: { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TYER: 'year', TORY: 'originalYear' },
  4: { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TDRC: 'year', TDOR: 'originalYear' },
};

function readId3Text(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return {};
  const version = buf[3];
  if (version < 2 || version > 4) return {};
  const flags = buf[5];
  let tag = buf.subarray(10, Math.min(10 + synchsafe(buf, 6), buf.length));
  // Whole-tag unsynchronisation (v2.2/v2.3). v2.4 flags it per frame instead.
  if ((flags & 0x80) && version < 4) tag = undoUnsync(tag);
  let cursor = 0;
  if ((flags & 0x40) && version > 2) {
    if (tag.length < 4) return {};
    cursor += version === 4 ? synchsafe(tag, 0) : tag.readUInt32BE(0) + 4;
  }
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  const wanted = ID3_FRAMES[version];
  const out = {};
  while (cursor + headerLength <= tag.length) {
    const id = tag.toString('latin1', cursor, cursor + idLength);
    if (id.charCodeAt(0) === 0) break;
    let size;
    if (version === 2) size = (tag[cursor + 3] << 16) | (tag[cursor + 4] << 8) | tag[cursor + 5];
    else if (version === 4) size = synchsafe(tag, cursor + 4);
    else size = tag.readUInt32BE(cursor + 4);
    if (size <= 0 || cursor + headerLength + size > tag.length) break;
    const field = wanted[id];
    if (field && !out[field]) {
      const frameFlags = version === 2 ? 0 : tag.readUInt16BE(cursor + 8);
      let frame = tag.subarray(cursor + headerLength, cursor + headerLength + size);
      if (version === 4 && (frameFlags & 0x01)) frame = frame.subarray(4);
      if (version === 4 && (frameFlags & 0x02)) frame = undoUnsync(frame);
      const text = decodeId3Text(frame);
      if (text) out[field] = text;
    }
    cursor += headerLength + size;
  }
  // Remasters and compilations carry the reissue date in TDRC/TYER; when the
  // tagger also recorded the original release, that is the year people mean.
  if (out.originalYear && yearOf(out.originalYear)) out.year = out.originalYear;
  delete out.originalYear;
  return out;
}

function readId3v1(tail) {
  if (!tail || tail.length < 128) return {};
  const tag = tail.subarray(tail.length - 128);
  if (tag.toString('latin1', 0, 3) !== 'TAG') return {};
  const field = (start, end) => clean(tag.toString('latin1', start, end).split('\u0000')[0]);
  return { title: field(3, 33), artist: field(33, 63), album: field(63, 93), year: field(93, 97) };
}

// ---------- Vorbis comments (FLAC, Ogg Vorbis, Opus) ----------

const VORBIS_KEYS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist',
  DATE: 'year', YEAR: 'year', ORIGINALDATE: 'originalYear', ORIGINALYEAR: 'originalYear',
};

function readVorbisComment(buf, start) {
  const out = {};
  let p = start;
  if (p + 4 > buf.length) return out;
  const vendorLength = buf.readUInt32LE(p);
  p += 4 + vendorLength;
  if (p + 4 > buf.length) return out;
  const count = buf.readUInt32LE(p);
  p += 4;
  for (let i = 0; i < count && p + 4 <= buf.length; i++) {
    const length = buf.readUInt32LE(p);
    p += 4;
    if (p + length > buf.length) break;
    const entry = buf.toString('utf8', p, p + length);
    p += length;
    const eq = entry.indexOf('=');
    if (eq < 1) continue;
    const field = VORBIS_KEYS[entry.slice(0, eq).toUpperCase()];
    if (field && !out[field]) out[field] = clean(entry.slice(eq + 1));
  }
  if (out.originalYear && yearOf(out.originalYear)) out.year = out.originalYear;
  delete out.originalYear;
  return out;
}

async function readFlacTags(io) {
  let offset = 4;
  for (let guard = 0; guard < 64 && offset + 4 <= io.size; guard++) {
    // eslint-disable-next-line no-await-in-loop
    const header = await io.readRange(offset, 4);
    if (header.length < 4) break;
    const isLast = (header[0] & 0x80) !== 0;
    const type = header[0] & 0x7f;
    const length = (header[1] << 16) | (header[2] << 8) | header[3];
    if (type === 4) {
      // eslint-disable-next-line no-await-in-loop
      const body = await io.readRange(offset + 4, Math.min(length, MAX_BLOCK_BYTES));
      return readVorbisComment(body, 0);
    }
    if (isLast) break;
    offset += 4 + length;
  }
  return {};
}

// Reassembles Ogg packets from page segments until `count` packets are whole.
// The comment packet is the second one in both Vorbis and Opus streams.
function oggPackets(buf, count) {
  const packets = [];
  let parts = [];
  let offset = 0;
  while (offset + 27 <= buf.length && packets.length < count) {
    if (buf.toString('latin1', offset, offset + 4) !== 'OggS') break;
    const segments = buf[offset + 26];
    const table = offset + 27;
    let data = table + segments;
    if (data > buf.length) break;
    for (let i = 0; i < segments && packets.length < count; i++) {
      const length = buf[table + i];
      parts.push(buf.subarray(data, Math.min(data + length, buf.length)));
      data += length;
      if (length < 255) { packets.push(Buffer.concat(parts)); parts = []; }
    }
    offset = data;
  }
  // A comment packet cut off by the read still has its text fields up front.
  if (packets.length < count && parts.length) packets.push(Buffer.concat(parts));
  return packets;
}

function readOggTags(head) {
  const comment = oggPackets(head, 2)[1];
  if (!comment) return {};
  if (comment.toString('latin1', 0, 7) === '\u0003vorbis') return readVorbisComment(comment, 7);
  if (comment.toString('latin1', 0, 8) === 'OpusTags') return readVorbisComment(comment, 8);
  return {};
}

// ---------- MP4 / M4A ----------

const MP4_KEYS = { '©nam': 'title', '©ART': 'artist', aART: 'albumArtist', '©alb': 'album', '©day': 'year' };

function readIlst(moov) {
  const out = {};
  const visit = (start, end) => walkAtoms(moov, start, end, (type, body, atomEnd) => {
    if (type === 'udta' || type === 'ilst') return visit(body, atomEnd);
    // 'meta' is a full atom — see embedded-art.js's readMp4.
    if (type === 'meta') return visit(body + 4, atomEnd);
    const field = MP4_KEYS[type];
    if (!field) return undefined;
    walkAtoms(moov, body, atomEnd, (childType, childBody, childEnd) => {
      if (childType !== 'data' || childBody + 8 > childEnd || out[field]) return undefined;
      out[field] = clean(moov.toString('utf8', childBody + 8, childEnd));
      return true;
    });
    return undefined;
  });
  visit(0, moov.length);
  return out;
}

async function readMp4Tags(io) {
  let offset = 0;
  for (let guard = 0; guard < 1000 && offset + 8 <= io.size; guard++) {
    // eslint-disable-next-line no-await-in-loop
    const header = await io.readRange(offset, 16);
    if (header.length < 8) break;
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let bodyStart = offset + 8;
    if (size === 1) {
      if (header.length < 16) break;
      size = Number(header.readBigUInt64BE(8));
      bodyStart = offset + 16;
    } else if (size === 0) {
      size = io.size - offset;
    }
    if (size < 8) break;
    if (type === 'moov') {
      const length = offset + size - bodyStart;
      if (length > MAX_MOOV_BYTES) break;
      // eslint-disable-next-line no-await-in-loop
      return readIlst(await io.readRange(bodyStart, length));
    }
    offset += size;
  }
  return {};
}

// ---------- Entry point ----------

// `io` is { size, readRange(start, length) -> Promise<Buffer> }. The container
// is sniffed from its magic bytes, not the extension, same as embedded-art.js.
async function readTrackTags(io) {
  if (!io || !(io.size > 0)) return {};
  const head = await io.readRange(0, Math.min(HEAD_BYTES, io.size));
  if (head.length < 12) return {};
  let raw = {};
  if (head.toString('latin1', 0, 3) === 'ID3') {
    const tagBytes = 10 + synchsafe(head, 6);
    const full = tagBytes <= head.length ? head : await io.readRange(0, Math.min(tagBytes, MAX_ID3_BYTES, io.size));
    raw = readId3Text(full);
  } else if (head.toString('latin1', 0, 4) === 'fLaC') {
    raw = await readFlacTags(io);
  } else if (head.toString('latin1', 0, 4) === 'OggS') {
    raw = readOggTags(head.length >= io.size ? head : await io.readRange(0, Math.min(4 * HEAD_BYTES, io.size)));
  } else if (head.toString('latin1', 4, 8) === 'ftyp') {
    raw = await readMp4Tags(io);
  }
  // An MP3 can carry ID3v1 at the end instead of (or as well as) v2 at the
  // front; v2 wins field by field wherever both exist.
  const missing = FIELDS.some((field) => !raw[field]);
  if (missing && io.size >= 128 && head.toString('latin1', 0, 4) !== 'fLaC' && head.toString('latin1', 4, 8) !== 'ftyp') {
    const v1 = readId3v1(await io.readRange(io.size - 128, 128));
    FIELDS.forEach((field) => { if (!raw[field] && v1[field]) raw[field] = v1[field]; });
  }
  return finish(raw);
}

// An `io` over a Buffer already in memory — for tests, and for a host whose
// ctx.fs predates readRange.
function bufferIo(buf) {
  return { size: buf.length, readRange: async (start, length) => buf.subarray(start, start + length) };
}

module.exports = { readTrackTags, bufferIo, readId3Text, readId3v1, readVorbisComment, readOggTags, readIlst, yearOf };
