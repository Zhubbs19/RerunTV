// Crash-safe file replacement shared by every main-process JSON/state writer.
//
// Write to a unique temp file next to the target, fsync it, close it, then
// rename over the target. A power loss or crash can then leave either the old
// file or the new one, never a truncated hybrid. Windows refuses to rename over
// a file that an indexer, antivirus or backup tool briefly has open
// (EPERM/EBUSY/EACCES), so the rename is retried a few times with a short
// back-off before giving up.
//
// Electron-free on purpose: isolated plugin processes require() neighbours of
// this file, and the unit tests run it under plain node.
const fs = require('fs');
const path = require('path');

const RENAME_ATTEMPTS = 6;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
let tempCounter = 0;

function tempPathFor(file) {
  tempCounter += 1;
  return `${file}.tmp-${process.pid}-${Date.now()}-${tempCounter}`;
}

function toBuffer(data, encoding) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding || 'utf8');
}

// Same signature in both flavours: (file, data, { mode, encoding, mkdir }).
// `data` is a string or Buffer; use serialize helpers below for JSON.
function atomicWriteFileSync(file, data, options = {}) {
  const tempPath = tempPathFor(file);
  try {
    if (options.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tempPath, 'w', options.mode === undefined ? 0o666 : options.mode);
    try {
      fs.writeSync(fd, toBuffer(data, options.encoding));
      try { fs.fsyncSync(fd); } catch (e) { /* some filesystems cannot fsync; the rename is still atomic */ }
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tempPath, file);
        return;
      } catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= RENAME_ATTEMPTS) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch (e2) { /* temp never created or already renamed */ }
    throw e;
  }
}

async function atomicWriteFile(file, data, options = {}) {
  const tempPath = tempPathFor(file);
  try {
    if (options.mkdir) await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const fh = await fs.promises.open(tempPath, 'w', options.mode === undefined ? 0o666 : options.mode);
    try {
      await fh.writeFile(toBuffer(data, options.encoding));
      try { await fh.sync(); } catch (e) { /* see sync variant */ }
    } finally {
      await fh.close();
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.promises.rename(tempPath, file);
        return;
      } catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= RENAME_ATTEMPTS) throw e;
        await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
      }
    }
  } catch (e) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw e;
  }
}

const jsonText = (value, space) => `${JSON.stringify(value, null, space)}${space ? '\n' : ''}`;

function atomicWriteJsonSync(file, value, options = {}) {
  atomicWriteFileSync(file, jsonText(value, options.space), options);
}

function atomicWriteJson(file, value, options = {}) {
  return atomicWriteFile(file, jsonText(value, options.space), options);
}

module.exports = {
  atomicWriteFile, atomicWriteFileSync, atomicWriteJson, atomicWriteJsonSync, tempPathFor,
};
