// Scratch unit check for plugins/digital-music-channel/embedded-art.js.
// Plain Node, no Electron — the parser is pure Buffer work, so it is worth
// testing against hand-built tags rather than hoping a real library happens
// to contain every shape. Run: node tests/ui/verify-embedded-art.js
const assert = require('node:assert');
const { extractEmbeddedArt } = require('../plugins/digital-music-channel/embedded-art.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG magic + IHDR start
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`[FAIL] ${name} — ${e.message}`);
  }
}

// ---------- builders ----------
function synchsafeBytes(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

function id3v2(version, frames) {
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, 0]),
    synchsafeBytes(frames.length), frames,
  ]);
}
function apicFrame({ version = 3, mime = 'image/png', pictureType = 3, data = PNG, flags = 0 } = {}) {
  const body = Buffer.concat([
    Buffer.from([0]), Buffer.from(`${mime}\0`, 'latin1'),
    Buffer.from([pictureType]), Buffer.from([0]), data,
  ]);
  const size = version === 4 ? synchsafeBytes(body.length) : u32(body.length);
  const fl = Buffer.alloc(2); fl.writeUInt16BE(flags);
  return Buffer.concat([Buffer.from('APIC', 'latin1'), size, fl, body]);
}
function picFrameV22({ code = 'PNG', pictureType = 3, data = PNG } = {}) {
  const body = Buffer.concat([
    Buffer.from([0]), Buffer.from(code, 'latin1'),
    Buffer.from([pictureType]), Buffer.from([0]), data,
  ]);
  return Buffer.concat([
    Buffer.from('PIC', 'latin1'),
    Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
}
function flacPicture({ pictureType = 3, mime = 'image/png', data = PNG, last = true } = {}) {
  const body = Buffer.concat([
    u32(pictureType), u32(mime.length), Buffer.from(mime, 'latin1'),
    u32(0), u32(10), u32(10), u32(24), u32(0), u32(data.length), data,
  ]);
  const header = Buffer.from([(last ? 0x80 : 0) | 6, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), header, body]);
}
function atom(type, payload) {
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]);
}
function mp4Cover({ dataType = 13, data = JPEG } = {}) {
  const dataAtom = atom('data', Buffer.concat([u32(dataType), u32(0), data]));
  return Buffer.concat([
    atom('ftyp', Buffer.from('M4A isom', 'latin1')),
    atom('moov', atom('udta', atom('meta', Buffer.concat([
      u32(0), // meta is a full atom: version + flags before its children
      atom('ilst', atom('covr', dataAtom)),
    ])))),
  ]);
}

// ---------- ID3 ----------
check('ID3v2.3 APIC', () => {
  const pic = extractEmbeddedArt(id3v2(3, apicFrame({ version: 3 })));
  assert.ok(pic, 'no picture found');
  assert.strictEqual(pic.mime, 'image/png');
  assert.ok(pic.data.equals(PNG), 'wrong bytes');
});

check('ID3v2.4 APIC (synchsafe frame size)', () => {
  const pic = extractEmbeddedArt(id3v2(4, apicFrame({ version: 4 })));
  assert.ok(pic, 'no picture found');
  assert.ok(pic.data.equals(PNG));
});

check('ID3v2.2 PIC (3-char id and format code)', () => {
  const pic = extractEmbeddedArt(id3v2(2, picFrameV22()));
  assert.ok(pic, 'no picture found');
  assert.strictEqual(pic.mime, 'image/png');
  assert.ok(pic.data.equals(PNG));
});

check('prefers the front cover over other picture types', () => {
  const back = apicFrame({ version: 3, pictureType: 4, data: JPEG, mime: 'image/jpeg' });
  const front = apicFrame({ version: 3, pictureType: 3, data: PNG, mime: 'image/png' });
  const pic = extractEmbeddedArt(id3v2(3, Buffer.concat([back, front])));
  assert.ok(pic.data.equals(PNG), 'took the back cover');
});

check('falls back to a non-front picture when that is all there is', () => {
  const pic = extractEmbeddedArt(id3v2(3, apicFrame({ version: 3, pictureType: 4, data: JPEG, mime: 'image/jpeg' })));
  assert.ok(pic && pic.data.equals(JPEG));
});

check('skips a leading text frame to reach the picture', () => {
  const title = Buffer.concat([
    Buffer.from('TIT2', 'latin1'), u32(6), Buffer.alloc(2), Buffer.from([0]), Buffer.from('Hello', 'latin1'),
  ]);
  const pic = extractEmbeddedArt(id3v2(3, Buffer.concat([title, apicFrame({ version: 3 })])));
  assert.ok(pic && pic.data.equals(PNG));
});

check('accepts a bare "JPG" where a MIME type belongs', () => {
  const pic = extractEmbeddedArt(id3v2(3, apicFrame({ version: 3, mime: 'JPG', data: JPEG })));
  assert.ok(pic, 'no picture found');
  assert.strictEqual(pic.mime, 'image/jpeg');
});

check('handles a UTF-16 description (two-byte terminator)', () => {
  const body = Buffer.concat([
    Buffer.from([1]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3]),
    Buffer.from([0xff, 0xfe, 0, 0]), // BOM then the empty description's terminator
    PNG,
  ]);
  const fl = Buffer.alloc(2);
  const frame = Buffer.concat([Buffer.from('APIC', 'latin1'), u32(body.length), fl, body]);
  const pic = extractEmbeddedArt(id3v2(3, frame));
  assert.ok(pic, 'no picture found');
  assert.ok(pic.data.equals(PNG), 'description terminator mis-scanned');
});

check('ID3 with no picture frame reports nothing', () => {
  const title = Buffer.concat([
    Buffer.from('TIT2', 'latin1'), u32(6), Buffer.alloc(2), Buffer.from([0]), Buffer.from('Hello', 'latin1'),
  ]);
  assert.strictEqual(extractEmbeddedArt(id3v2(3, title)), null);
});

// ---------- FLAC ----------
check('FLAC METADATA_BLOCK_PICTURE', () => {
  const pic = extractEmbeddedArt(flacPicture());
  assert.ok(pic, 'no picture found');
  assert.strictEqual(pic.mime, 'image/png');
  assert.ok(pic.data.equals(PNG));
});

check('FLAC walks past an earlier block to reach the picture', () => {
  const streaminfo = Buffer.concat([Buffer.from([0, 0, 0, 10]), Buffer.alloc(10)]);
  const withPicture = flacPicture();
  const buf = Buffer.concat([Buffer.from('fLaC', 'latin1'), streaminfo, withPicture.slice(4)]);
  const pic = extractEmbeddedArt(buf);
  assert.ok(pic && pic.data.equals(PNG));
});

// ---------- MP4 ----------
check('MP4 covr atom (jpeg)', () => {
  const pic = extractEmbeddedArt(mp4Cover());
  assert.ok(pic, 'no picture found');
  assert.strictEqual(pic.mime, 'image/jpeg');
  assert.ok(pic.data.equals(JPEG));
});

check('MP4 covr atom (png data type)', () => {
  const pic = extractEmbeddedArt(mp4Cover({ dataType: 14, data: PNG }));
  assert.ok(pic, 'no picture found');
  assert.strictEqual(pic.mime, 'image/png');
});

// ---------- Robustness: garbage must never throw ----------
check('unrecognised and malformed input returns null rather than throwing', () => {
  assert.strictEqual(extractEmbeddedArt(Buffer.alloc(0)), null);
  assert.strictEqual(extractEmbeddedArt(Buffer.from('not audio at all', 'latin1')), null);
  assert.strictEqual(extractEmbeddedArt(Buffer.from('RIFF....WAVEfmt ', 'latin1')), null);
  // A truncated tag: header claims far more than the buffer holds.
  const truncated = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafeBytes(9999), Buffer.from('APIC', 'latin1')]);
  assert.strictEqual(extractEmbeddedArt(truncated), null);
  // A frame whose declared size runs past the tag.
  const overrun = id3v2(3, Buffer.concat([Buffer.from('APIC', 'latin1'), u32(9999), Buffer.alloc(2), PNG]));
  assert.strictEqual(extractEmbeddedArt(overrun), null);
  // Random bytes behind each container's magic.
  const noise = require('node:crypto').randomBytes(512);
  extractEmbeddedArt(Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafeBytes(512), noise]));
  extractEmbeddedArt(Buffer.concat([Buffer.from('fLaC', 'latin1'), noise]));
  extractEmbeddedArt(Buffer.concat([u32(520), Buffer.from('ftyp', 'latin1'), noise]));
});

check('a non-image MIME type in a picture frame is rejected', () => {
  assert.strictEqual(extractEmbeddedArt(id3v2(3, apicFrame({ version: 3, mime: 'text/plain' }))), null);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
