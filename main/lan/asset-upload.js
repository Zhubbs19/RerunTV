// Asset upload for the LAN control panel (docs/design/06 §5, doc 12's
// deferred "Priority 3" item 1).
//
// The folder browser (control-browse.js) covers the ordinary case — a logo
// or overlay that is already somewhere on the host's disk. This covers the
// other case: a file that only exists on the device doing the editing (a
// photo just taken on a phone, say). Deliberately narrow: images only, size-
// capped, and busboy (already a dependency — see plugins/party-channel's
// LAN upload route, the precedent this follows) does the multipart parsing
// rather than a hand-rolled one on a LAN-facing server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
// The assets folder as a whole is capped too: a paired editor could otherwise
// upload 8 MB files until the host's disk is full.
const MAX_ASSETS_TOTAL_BYTES = 200 * 1024 * 1024;

function assetsFolderBytes(dir) {
  let total = 0;
  try {
    fs.readdirSync(dir).forEach((name) => {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) total += st.size;
      } catch (e) { /* vanished mid-scan */ }
    });
  } catch (e) { /* folder not created yet */ }
  return total;
}
// SVG excluded on purpose: it can carry <script>, and this file is later
// referenced from real app surfaces (channel logo/overlay), not just shown
// back to the uploader in a sandboxed guest page the way party-channel's
// bulletin photos are.
const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// The declared multipart type is whatever the client says it is. Check the
// bytes: an image upload that is really an HTML page, script or executable is
// refused before it can be referenced from a real app surface.
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return '.gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function fileMatchesExt(destPath, ext) {
  let fd;
  try {
    fd = fs.openSync(destPath, 'r');
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, 0);
    return sniffImageExt(head.subarray(0, read)) === ext;
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
  }
}

// Bytes promised to uploads that are still streaming. The folder-size check
// alone reads only finished files, so several concurrent uploads could each
// pass it and together overshoot the cap.
let reservedBytes = 0;

function randomName(ext) {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

// req/res are the raw Node request/response; busboy is the dependency
// (ctx.busboy in a plugin, require('busboy') in core) so this file stays
// testable without pulling in the real HTTP machinery.
function receiveAssetUpload(assetsDir, req, busboy) {
  return new Promise((resolve) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_ASSET_BYTES, files: 1 } });
    } catch (e) {
      resolve({ ok: false, status: 400, error: 'Bad upload request' });
      return;
    }
    let settled = false;
    let sawFile = false;
    let tooBig = false;
    let cleanup = null; // set once a destination file exists
    let reserved = 0;
    const release = () => { reservedBytes -= reserved; reserved = 0; };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      release();
      resolve(result);
    };

    bb.on('file', (_name, fileStream, info) => {
      sawFile = true;
      const ext = EXT_BY_MIME[info.mimeType];
      if (!ext) {
        fileStream.resume(); // drain and discard — unsupported type
        finish({ ok: false, status: 415, error: 'Only PNG, JPEG, WebP or GIF images are accepted.' });
        return;
      }
      const fileName = randomName(ext);
      fs.mkdirSync(assetsDir, { recursive: true });
      if (assetsFolderBytes(assetsDir) + reservedBytes + MAX_ASSET_BYTES > MAX_ASSETS_TOTAL_BYTES) {
        fileStream.resume();
        finish({ ok: false, status: 507, error: 'The assets folder is full. Remove some uploaded images first.' });
        return;
      }
      reserved = MAX_ASSET_BYTES;
      reservedBytes += reserved;
      const destPath = path.join(assetsDir, fileName);
      const writeStream = fs.createWriteStream(destPath);
      cleanup = () => {
        fileStream.unpipe(writeStream);
        writeStream.destroy();
        fs.unlink(destPath, () => {});
      };
      fileStream.on('limit', () => { tooBig = true; });
      fileStream.pipe(writeStream);
      writeStream.on('finish', () => {
        if (tooBig) { fs.unlink(destPath, () => {}); finish({ ok: false, status: 413, error: 'That file is too large (8 MB limit).' }); return; }
        if (!fileMatchesExt(destPath, ext)) {
          fs.unlink(destPath, () => {});
          finish({ ok: false, status: 415, error: 'That file is not really a PNG, JPEG, WebP or GIF image.' });
          return;
        }
        finish({ ok: true, path: destPath, fileName });
      });
      writeStream.on('error', (e) => {
        fs.unlink(destPath, () => {});
        finish({ ok: false, status: 500, error: e.message });
      });
      fileStream.on('error', () => writeStream.destroy());
    });

    bb.on('error', (e) => finish({ ok: false, status: 400, error: e.message }));
    bb.on('close', () => { if (!sawFile) finish({ ok: false, status: 400, error: 'No file received.' }); });
    // A client that drops mid-upload must not leave a truncated file behind or
    // a promise that never settles.
    req.on('aborted', () => {
      if (cleanup && !settled) cleanup();
      finish({ ok: false, status: 400, error: 'Upload aborted' });
    });
    req.on('error', () => {
      if (cleanup && !settled) cleanup();
      finish({ ok: false, status: 400, error: 'Upload failed' });
    });
    req.pipe(bb);
  });
}

module.exports = { receiveAssetUpload, sniffImageExt, getReservedBytes: () => reservedBytes, MAX_ASSET_BYTES, MAX_ASSETS_TOTAL_BYTES, EXT_BY_MIME };
