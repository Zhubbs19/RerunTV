// Carries the sound-output choice (PICTURE & SOUND › Sound output) from a
// source userData into the test window that the wrapper just launched.
//
// The choice lives in the renderer's localStorage ('reruntv.audioOutput',
// renderer/js/display/audio-output.js), which Chromium keeps in
// <userData>/Local Storage/leveldb. The wrappers deliberately do not copy
// that folder: it also holds per-device state (usage mode, TV screen,
// profile, remote profile) that would change what every driver is testing,
// and a live app holds it open. Without the choice a test window plays
// through the Windows default device, which on a PC driving a TV over HDMI
// is usually not where the person is listening.
//
// So this reads just that one entry out of the source store (a small
// best-effort scan of the leveldb files for the key, no leveldb library) and
// sets it in the running app over CDP, applying it live with
// setAudioOutput() so the player is re-pointed without a reload. Device ids
// are salted per Chromium profile, so the id itself never matches in the
// throwaway profile; audio-output.js then matches the saved label, which is
// what this is really carrying.
//
// Usage: node tests/ui/lib/carry-audio-output.mjs <sourceUserDataDir> <cdpPort>
// Exit code is always 0 unless the arguments are wrong: a missing choice or
// an unreadable store is reported and the run goes on.
import fs from 'node:fs';
import path from 'node:path';
import { connectToApp } from './cdp.mjs';

export const ORIGIN = 'app://bundle';
export const STORAGE_KEY = 'reruntv.audioOutput';

// Chromium's leveldb layout for one localStorage entry: the key is
// '_' + origin + '\0' + (0x01 for Latin-1 | 0x00 for UTF-16LE) + name, and the
// value is the same one-byte encoding prefix followed by the text.
function decodeStored(buf) {
  if (!buf.length) return '';
  const body = buf.subarray(1);
  return buf[0] === 0 ? body.toString('utf16le') : body.toString('latin1');
}

function readVarint(buf, at) {
  let value = 0;
  let shift = 0;
  let i = at;
  while (i < buf.length) {
    const b = buf[i];
    i += 1;
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return { value, next: i };
    shift += 7;
    if (shift > 35) break;
  }
  return null;
}

// Every occurrence of the entry in one file, as { offset, value } with value
// null for a deletion. Handles both files leveldb writes:
// - *.log: a batch entry is [type 1=put|0=delete][varint keyLen][key][varint valLen][value]
// - *.ldb: a block entry is [varint shared][varint nonShared][varint valLen][keyDelta][value],
//   where the key carries an 8-byte trailer (sequence << 8 | type) after the user key.
function scanFile(file, keyBytes) {
  const buf = fs.readFileSync(file);
  const isLog = /\.log$/i.test(file);
  const hits = [];
  let at = buf.indexOf(keyBytes);
  while (at !== -1) {
    const afterKey = at + keyBytes.length;
    if (isLog) {
      const type = buf[at - 2];
      if (buf[at - 1] === keyBytes.length && (type === 0 || type === 1)) {
        if (type === 0) hits.push({ offset: at, value: null });
        else {
          const len = readVarint(buf, afterKey);
          if (len && afterKey + len.value <= buf.length) hits.push({ offset: at, value: decodeStored(buf.subarray(len.next, len.next + len.value)) });
        }
      }
    } else {
      // The trailer's low byte is the type: 1 for a value, 0 for a deletion.
      const type = buf[afterKey];
      if (afterKey + 8 <= buf.length && (type === 0 || type === 1)) {
        // Walk back over the three varints to find valLen: the last one before the key.
        let back = at - 1;
        const varints = [];
        while (back >= 0 && varints.length < 3) {
          let start = back;
          while (start > 0 && (buf[start - 1] & 0x80)) start -= 1;
          varints.unshift(readVarint(buf, start));
          back = start - 1;
        }
        const valLen = varints[varints.length - 1];
        if (type === 0) hits.push({ offset: at, value: null });
        else if (valLen && afterKey + 8 + valLen.value <= buf.length) hits.push({ offset: at, value: decodeStored(buf.subarray(afterKey + 8, afterKey + 8 + valLen.value)) });
      }
    }
    at = buf.indexOf(keyBytes, at + 1);
  }
  return hits;
}

// The stored string for `name` under `origin`, or null when the store has
// none (or no store exists). The write-ahead log is newer than any table, and
// within a file the last record wins.
export function readLocalStorageEntry(userDataDir, name = STORAGE_KEY, origin = ORIGIN) {
  const dir = path.join(userDataDir, 'Local Storage', 'leveldb');
  if (!fs.existsSync(dir)) return null;
  const keyBytes = Buffer.concat([Buffer.from(`_${origin}\0`, 'latin1'), Buffer.from([1]), Buffer.from(name, 'latin1')]);
  const files = fs.readdirSync(dir).filter((f) => /\.(ldb|log)$/i.test(f));
  const tables = files.filter((f) => /\.ldb$/i.test(f)).sort();
  const logs = files.filter((f) => /\.log$/i.test(f)).sort();
  let latest = null;
  for (const f of [...tables, ...logs]) {
    let hits = [];
    try { hits = scanFile(path.join(dir, f), keyBytes); } catch (e) { /* unreadable: skip the file */ }
    if (hits.length) latest = hits[hits.length - 1].value;
  }
  return latest;
}

async function main() {
  const [sourceDir, port] = process.argv.slice(2);
  if (!sourceDir || !port) {
    console.error('usage: carry-audio-output.mjs <sourceUserDataDir> <cdpPort>');
    process.exit(2);
  }
  const stored = readLocalStorageEntry(sourceDir);
  let choice = null;
  try { choice = stored ? JSON.parse(stored) : null; } catch (e) { choice = null; }
  if (!choice || typeof choice.deviceId !== 'string') {
    console.log('  (no sound-output choice saved in the source profile; the test window uses the Windows default device)');
    return;
  }
  const session = await connectToApp(port, { timeoutMs: 30000 });
  try {
    const result = await session.evaluate(`(async () => {
      const choice = ${JSON.stringify(choice)};
      const ao = await import('./js/display/audio-output.js');
      const present = await ao.setAudioOutput(choice);
      const sinkId = (document.getElementById('player') || {}).sinkId;
      return { present, sinkId, stored: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) };
    })()`, { awaitPromise: true });
    const label = choice.label || choice.deviceId;
    if (result.present) console.log(`  Sound output carried over: "${label}" (player sinkId ${result.sinkId || 'default'})`);
    else console.log(`  Sound output "${label}" is saved but not connected right now; the test window falls back to the Windows default device`);
  } finally {
    session.close();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
if (invokedDirectly) {
  main().catch((e) => { console.log(`  (could not carry the sound output over: ${e.message})`); });
}
