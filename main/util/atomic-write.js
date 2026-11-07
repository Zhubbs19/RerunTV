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

/**
 * A unique temp file path beside `file`, made from the pid, the time and a counter.
 * @param {string} file The target file path.
 * @returns {string} The temp path to write before renaming.
 */
function tempPathFor(file) {
  tempCounter += 1;
  return `${file}.tmp-${process.pid}-${Date.now()}-${tempCounter}`;
}

/**
 * Coerces string or Buffer data to a Buffer.
 * @param {string|Buffer} data The data to write.
 * @param {string} [encoding] Text encoding for string data; utf8 when absent.
 * @returns {Buffer} The bytes to write.
 */
function toBuffer(data, encoding) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding || 'utf8');
}

/**
 * Same signature in both flavours: (file, data, { mode, encoding, mkdir }).
 * `data` is a string or Buffer; use serialize helpers below for JSON.
 * Synchronous flavour; sleeps between rename retries with `Atomics.wait`.
 * @param {string} file The target file path.
 * @param {string|Buffer} data The contents.
 * @param {object} [options] Write options.
 * @param {number} [options.mode=0o666] File mode for the new file.
 * @param {string} [options.encoding] Encoding for string data.
 * @param {boolean} [options.mkdir] Create the parent directory first.
 * @throws {Error} When the write fails or the rename keeps failing; the temp file is removed.
 */
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

/**
 * Asynchronous flavour of `atomicWriteFileSync`, with the same signature and guarantees.
 * @param {string} file The target file path.
 * @param {string|Buffer} data The contents.
 * @param {object} [options] Write options (`mode`, `encoding`, `mkdir`).
 * @returns {Promise<void>} Resolves once the file has been renamed into place.
 * @throws {Error} When the write fails or the rename keeps failing; the temp file is removed.
 */
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

/**
 * Serializes `value` as JSON, with a trailing newline when indented.
 * @param {*} value The value to serialize.
 * @param {number|string} [space] Indentation passed to `JSON.stringify`.
 * @returns {string} The JSON text.
 */
const jsonText = (value, space) => `${JSON.stringify(value, null, space)}${space ? '\n' : ''}`;

/**
 * Writes `value` as JSON to `file` atomically, synchronously.
 * @param {string} file The target file path.
 * @param {*} value The value to serialize.
 * @param {object} [options] `atomicWriteFileSync` options plus `space` for indentation.
 */
function atomicWriteJsonSync(file, value, options = {}) {
  atomicWriteFileSync(file, jsonText(value, options.space), options);
}

/**
 * Writes `value` as JSON to `file` atomically.
 * @param {string} file The target file path.
 * @param {*} value The value to serialize.
 * @param {object} [options] `atomicWriteFile` options plus `space` for indentation.
 * @returns {Promise<void>} Resolves once the file is in place.
 */
function atomicWriteJson(file, value, options = {}) {
  return atomicWriteFile(file, jsonText(value, options.space), options);
}

module.exports = {
  atomicWriteFile, atomicWriteFileSync, atomicWriteJson, atomicWriteJsonSync, tempPathFor,
};
