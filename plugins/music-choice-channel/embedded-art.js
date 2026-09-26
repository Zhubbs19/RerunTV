// Cover art stored inside a track's own tags, for the Music Choice channel's
// on-screen slide. Pure Buffer parsing, no dependencies — this app ships no
// tag reader and pulling one in for three container formats is not worth a
// dependency.
//
// Covers the containers the plugin's own scanner accepts that actually carry
// artwork in practice:
//
//   .mp3          ID3v2.2 (PIC) / v2.3 / v2.4 (APIC)
//   .flac         METADATA_BLOCK_PICTURE
//   .m4a .aac     MP4 moov.udta.meta.ilst.covr
//
// .wav and .ogg are not parsed. WAV essentially never carries art, and Ogg
// keeps it base64-encoded inside a Vorbis comment packet, which is a
// different parse again. Both simply report "no embedded art" and fall back
// to a sidecar image, which is the honest answer rather than a wrong one.
//
// Every reader is written to give up and return null on anything it does not
// recognise rather than guess: a malformed or unusual tag should cost a
// missing cover, never a thrown error on the channel.

// Picture type 3 is "front cover" in both ID3 and FLAC. A file can carry
// several images (back cover, artist, media); prefer the front cover and
// fall back to whatever came first.
const FRONT_COVER = 3;

function isSupportedImageMime(mime) {
  return /^image\/(jpeg|jpg|png|gif|webp|bmp)$/i.test(mime);
}

// ---------- ID3v2 (.mp3, and .aiff which this plugin does not scan) ----------

// Sizes in an ID3v2 header, and in v2.4 frame headers, are "synchsafe": seven
// bits per byte, the top bit always clear, so a size can never be mistaken
// for an MPEG frame sync.
function synchsafe(buf, offset) {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14)
    | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

// Terminator width depends on the text encoding byte that opened the field:
// the two UTF-16 encodings terminate on a two-byte null, the others on one.
function descriptionEnd(buf, start, encoding, limit) {
  const wide = encoding === 1 || encoding === 2;
  if (wide) {
    for (let i = start; i + 1 < limit; i += 2) {
      if (buf[i] === 0 && buf[i + 1] === 0) return i + 2;
    }
    return -1;
  }
  for (let i = start; i < limit; i++) {
    if (buf[i] === 0) return i + 1;
  }
  return -1;
}

function readId3Picture(frame, version) {
  if (frame.length < 4) return null;
  const encoding = frame[0];
  let cursor = 1;
  let mime;
  if (version === 2) {
    // v2.2 stores a three-character format code ("JPG", "PNG") in place of a
    // MIME type.
    const code = frame.slice(1, 4).toString('latin1').toUpperCase();
    mime = code === 'PNG' ? 'image/png' : code === 'JPG' ? 'image/jpeg' : `image/${code.toLowerCase()}`;
    cursor = 4;
  } else {
    const mimeEnd = frame.indexOf(0, cursor);
    if (mimeEnd < 0) return null;
    mime = frame.slice(cursor, mimeEnd).toString('latin1').trim().toLowerCase();
    // Some taggers write a bare "JPG"/"PNG" here instead of a MIME type.
    if (!mime.includes('/')) mime = mime === 'png' ? 'image/png' : 'image/jpeg';
    cursor = mimeEnd + 1;
  }
  if (cursor >= frame.length) return null;
  const pictureType = frame[cursor];
  cursor += 1;
  const dataStart = descriptionEnd(frame, cursor, encoding, frame.length);
  if (dataStart < 0 || dataStart >= frame.length) return null;
  return { mime, pictureType, data: frame.slice(dataStart) };
}

function readId3(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const version = buf[3];
  if (version < 2 || version > 4) return null;
  const flags = buf[5];
  const tagSize = synchsafe(buf, 6);
  const tagEnd = Math.min(10 + tagSize, buf.length);
  let cursor = 10;

  // Extended header, if present. v2.4 writes its own size as synchsafe and
  // counts itself; v2.3 writes a plain size that does not.
  if (flags & 0x40) {
    if (cursor + 4 > tagEnd) return null;
    cursor += version === 4 ? synchsafe(buf, cursor) : buf.readUInt32BE(cursor) + 4;
  }

  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  const wanted = version === 2 ? 'PIC' : 'APIC';
  let fallback = null;

  while (cursor + headerLength <= tagEnd) {
    const id = buf.toString('latin1', cursor, cursor + idLength);
    // A run of zero bytes is the padding that ends the frame area.
    if (id.charCodeAt(0) === 0) break;
    let size;
    if (version === 2) {
      size = (buf[cursor + 3] << 16) | (buf[cursor + 4] << 8) | buf[cursor + 5];
    } else if (version === 4) {
      size = synchsafe(buf, cursor + 4);
    } else {
      size = buf.readUInt32BE(cursor + 4);
    }
    if (size <= 0 || cursor + headerLength + size > tagEnd) break;
    if (id === wanted) {
      const frameFlags = version === 2 ? 0 : buf.readUInt16BE(cursor + 8);
      let frame = buf.slice(cursor + headerLength, cursor + headerLength + size);
      // A v2.4 frame may be unsynchronised (0x02) or carry a four-byte data
      // length indicator (0x01) before its content.
      if (version === 4 && (frameFlags & 0x01)) frame = frame.slice(4);
      if (version === 4 && (frameFlags & 0x02)) {
        const undone = [];
        for (let i = 0; i < frame.length; i++) {
          undone.push(frame[i]);
          if (frame[i] === 0xff && frame[i + 1] === 0x00) i++;
        }
        frame = Buffer.from(undone);
      }
      const pic = readId3Picture(frame, version);
      if (pic && pic.data.length) {
        if (pic.pictureType === FRONT_COVER) return pic;
        if (!fallback) fallback = pic;
      }
    }
    cursor += headerLength + size;
  }
  return fallback;
}

// ---------- FLAC ----------

function readFlac(buf) {
  if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  let cursor = 4;
  let fallback = null;
  while (cursor + 4 <= buf.length) {
    const header = buf[cursor];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (buf[cursor + 1] << 16) | (buf[cursor + 2] << 8) | buf[cursor + 3];
    const body = cursor + 4;
    if (body + length > buf.length) break;
    if (type === 6 && length > 32) {
      let p = body;
      const pictureType = buf.readUInt32BE(p); p += 4;
      const mimeLength = buf.readUInt32BE(p); p += 4;
      const mime = buf.toString('latin1', p, p + mimeLength).toLowerCase(); p += mimeLength;
      const descLength = buf.readUInt32BE(p); p += 4 + descLength;
      p += 16; // width, height, colour depth, indexed colours
      const dataLength = buf.readUInt32BE(p); p += 4;
      if (p + dataLength <= buf.length && dataLength > 0) {
        const pic = { mime, pictureType, data: buf.slice(p, p + dataLength) };
        if (pictureType === FRONT_COVER) return pic;
        if (!fallback) fallback = pic;
      }
    }
    if (isLast) break;
    cursor = body + length;
  }
  return fallback;
}

// ---------- MP4 / M4A ----------

// Walks sibling atoms inside [start, end), calling visit(type, bodyStart,
// bodyEnd). Returning a value from visit stops the walk and hands it back.
function walkAtoms(buf, start, end, visit) {
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = buf.readUInt32BE(cursor);
    const type = buf.toString('latin1', cursor + 4, cursor + 8);
    let body = cursor + 8;
    if (size === 1) {
      // 64-bit size. Only the low half can be meaningful at Buffer scale.
      if (cursor + 16 > end) break;
      size = Number(buf.readBigUInt64BE(cursor + 8));
      body = cursor + 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < 8 || cursor + size > end) break;
    const result = visit(type, body, cursor + size);
    if (result !== undefined) return result;
    cursor += size;
  }
  return undefined;
}

function readMp4(buf) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const findCovr = (start, end) => walkAtoms(buf, start, end, (type, body, atomEnd) => {
    if (type === 'moov' || type === 'udta' || type === 'ilst') return findCovr(body, atomEnd);
    // 'meta' is a full atom: four bytes of version and flags sit before its
    // children, and walking from `body` without skipping them misreads the
    // first child's header.
    if (type === 'meta') return findCovr(body + 4, atomEnd);
    if (type !== 'covr') return undefined;
    return walkAtoms(buf, body, atomEnd, (childType, childBody, childEnd) => {
      if (childType !== 'data' || childBody + 8 > childEnd) return undefined;
      // Well-known data type: 13 is JPEG, 14 is PNG.
      const dataType = buf.readUInt32BE(childBody) & 0x00ffffff;
      const data = buf.slice(childBody + 8, childEnd);
      if (!data.length) return undefined;
      return { mime: dataType === 14 ? 'image/png' : 'image/jpeg', pictureType: FRONT_COVER, data };
    });
  });
  return findCovr(0, buf.length) || null;
}

// Single entry point: sniff the container from its magic bytes rather than
// trusting the file extension, since a mislabelled file is common enough in
// a personal library and the wrong parser just returns null anyway.
function extractEmbeddedArt(buf) {
  if (!buf || buf.length < 12) return null;
  let pic = null;
  if (buf.toString('latin1', 0, 3) === 'ID3') pic = readId3(buf);
  else if (buf.toString('latin1', 0, 4) === 'fLaC') pic = readFlac(buf);
  else if (buf.toString('latin1', 4, 8) === 'ftyp') pic = readMp4(buf);
  if (!pic || !pic.data || !pic.data.length) return null;
  if (!isSupportedImageMime(pic.mime)) return null;
  return pic;
}

module.exports = { extractEmbeddedArt, readId3, readFlac, readMp4, synchsafe, walkAtoms };
