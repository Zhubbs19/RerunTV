// One-time generator for tests/ui/fixtures/test-logo.png — a tiny hand-encoded
// 16x16 solid-color PNG, no dependencies beyond Node's built-in zlib. Run
// once via `node tests/ui/fixtures/make-fixtures.js`; the output PNG is checked
// into nothing (tests/ui/ is gitignored) but is small enough to just regenerate
// if it's ever missing.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crcBuf]);
}

function makePng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'test-logo.png'), makePng(32, 32, [245, 211, 39]));
fs.writeFileSync(path.join(outDir, 'test-overlay.png'), makePng(48, 48, [111, 224, 242]));
console.log('wrote fixtures to', outDir);
