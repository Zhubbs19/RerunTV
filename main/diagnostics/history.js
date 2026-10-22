// Viewing history — an append-only log of what actually went on screen.
//
// Deliberately NOT part of channels.json. That file is the user's
// configuration: it is diffed for diagnostics, snapshotted into rotating
// backups, replaced wholesale by undo/redo and restore, and polled every ten
// seconds by every LAN viewer. A row appended every time a programme changes
// would churn all of that for data no other part of the app reads, so
// history gets its own file, its own IPC, and its own bounded rotation.
//
// Rotation is a plain cap on entry count rather than an age window: "the
// last N things I watched" is the question this answers, and a box left off
// for a month should still be able to answer it.
const fs = require('fs');
const { atomicWriteFile, atomicWriteFileSync } = require('../util/atomic-write');
const path = require('path');
const { app, ipcMain } = require('electron');

const HISTORY_FILE = 'viewing-history.json';
const MAX_ENTRIES = 2000;
// Channel surfing produces one append per tune, so writes are batched rather
// than hitting the disk per row. Short enough that a crash loses at most a
// couple of seconds of log, long enough that a run up the dial is one write.
const WRITE_DEBOUNCE_MS = 2000;

let entries = null;
let writeTimer = null;
let writing = false;
let writeAgain = false;

function historyPath() {
  return path.join(app.getPath('userData'), HISTORY_FILE);
}

function load() {
  if (entries) return entries;
  try {
    const raw = fs.readFileSync(historyPath(), 'utf8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  } catch (e) {
    // Missing is the normal first-run case; corrupt is not worth surfacing
    // for a log nothing depends on — start clean and carry on.
    entries = [];
  }
  return entries;
}

async function flush() {
  if (writing) { writeAgain = true; return; }
  writing = true;
  try {
    await atomicWriteFile(historyPath(), JSON.stringify({ entries: load() }), { encoding: 'utf8' });
  } catch (e) {
    console.error('[history] write failed:', e.message);
  } finally {
    writing = false;
    if (writeAgain) { writeAgain = false; scheduleFlush(); }
  }
}

function scheduleFlush() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
}

function sanitize(entry) {
  const clean = {};
  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  clean.at = Number.isFinite(entry && entry.at) ? entry.at : Date.now();
  clean.viewAt = Number.isFinite(entry && entry.viewAt) ? entry.viewAt : clean.at;
  clean.channelNumber = Number.isFinite(entry && entry.channelNumber) ? entry.channelNumber : null;
  clean.channelName = str(entry && entry.channelName, 80);
  clean.title = str(entry && entry.title, 200);
  clean.path = str(entry && entry.path, 1024);
  clean.durationS = Number.isFinite(entry && entry.durationS) ? Math.max(0, entry.durationS) : 0;
  return clean;
}

function append(entry) {
  const list = load();
  const clean = sanitize(entry);
  const previous = list[list.length - 1];
  // The renderer re-reports the same programme on any re-tune to the channel
  // it is already on (a break ending, a block boundary, a drift correction
  // that happens to re-enter playChannelLive). Collapsing a repeat of the
  // same channel+file keeps the log readable as "what I watched" instead of
  // "every time the player was touched".
  if (previous && previous.channelNumber === clean.channelNumber && previous.path === clean.path) {
    return { ok: true, deduped: true };
  }
  list.push(clean);
  while (list.length > MAX_ENTRIES) list.shift();
  scheduleFlush();
  return { ok: true, deduped: false };
}

// Newest first, because every caller wants "what did I watch recently".
function list(limit) {
  const all = load();
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_ENTRIES) : MAX_ENTRIES;
  return all.slice(-capped).reverse();
}

function clear() {
  entries = [];
  scheduleFlush();
}

function registerHistoryIpc() {
  ipcMain.handle('history:append', async (event, entry) => append(entry));
  ipcMain.handle('history:list', async (event, limit) => list(limit));
  ipcMain.handle('history:clear', async () => { clear(); return true; });
}

// Called on quit so a batched write in flight isn't lost with the process.
function flushHistoryNow() {
  clearTimeout(writeTimer);
  if (!entries) return;
  try {
    atomicWriteFileSync(historyPath(), JSON.stringify({ entries }), { encoding: 'utf8' });
  } catch (e) {
    console.error('[history] final write failed:', e.message);
  }
}

module.exports = { registerHistoryIpc, flushHistoryNow, HISTORY_FILE };
