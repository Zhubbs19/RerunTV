// Viewing history — an append-only log of what actually went on screen.
//
// Deliberately NOT part of channels.json. That file is the user's
// configuration: it is diffed for diagnostics, snapshotted into rotating
// backups, replaced wholesale by undo/redo and restore, and polled every ten
// seconds by every LAN viewer. A row appended every time a programme changes
// would churn all of that for data no other part of the app reads, so
// history gets its own storage, its own IPC, and its own bounded rotation.
//
// Storage is the `history` table in <userData>/rerun.db (main/util/db.js), one
// row per programme. It used to be viewing-history.json, rewritten whole on a
// two-second debounce and capped at 2,000 entries to keep that rewrite cheap;
// that file is imported once and removed. If SQLite can't be used this
// session the log is kept in memory instead.
//
// Rotation is a plain cap on entry count rather than an age window: "the
// last N things I watched" is the question this answers, and a box left off
// for a month should still be able to answer it.
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const { getDatabase, transaction } = require('../util/db');

const HISTORY_FILE = 'viewing-history.json';
// Rows kept. A row is ~200 bytes, so this is about 10 MB at most.
const MAX_ENTRIES = 50000;
// What list() returns when the caller doesn't ask for a number: the old cap,
// which is what every reader was written against.
const DEFAULT_LIST_LIMIT = 2000;
const PRUNE_DEBOUNCE_MS = 5000;

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

// The renderer re-reports the same programme on any re-tune to the channel
// it is already on (a break ending, a block boundary, a drift correction
// that happens to re-enter playChannelLive). Collapsing a repeat of the
// same channel+file keeps the log readable as "what I watched" instead of
// "every time the player was touched".
function isRepeat(previous, clean) {
  return !!previous && previous.channelNumber === clean.channelNumber && previous.path === clean.path;
}

function clampLimit(limit) {
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_ENTRIES) : DEFAULT_LIST_LIMIT;
}

function rowToEntry(row) {
  return {
    at: Number(row.at),
    viewAt: Number(row.view_at),
    channelNumber: row.channel_number == null ? null : Number(row.channel_number),
    channelName: row.channel_name,
    title: row.title,
    path: row.path,
    durationS: Number(row.duration_s),
  };
}

function sqlLog(db, maxEntries) {
  const insert = db.prepare(`INSERT INTO history (at, view_at, channel_number, channel_name, title, path, duration_s)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const newest = db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT ?');
  const latestAt = db.prepare('SELECT max(at) AS at FROM history');
  const countRows = db.prepare('SELECT count(*) AS n FROM history');
  const prune = db.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)');
  let last;
  let pruneTimer = null;

  const run = (clean) => insert.run(clean.at, clean.viewAt, clean.channelNumber, clean.channelName, clean.title, clean.path, clean.durationS);
  const log = {
    last() {
      if (last === undefined) {
        const row = newest.get(1);
        last = row ? rowToEntry(row) : null;
      }
      return last;
    },
    push(clean) {
      run(clean);
      last = clean;
      log.pruneSoon();
    },
    // Oldest first; only rows newer than anything already logged, so an import
    // that somehow runs twice can't double the log.
    importEntries(entries) {
      const after = Number(latestAt.get().at);
      const fresh = entries.map(sanitize).filter((e) => !Number.isFinite(after) || e.at > after);
      transaction(db, () => fresh.forEach(run));
      last = undefined;
      log.prune();
      return fresh.length;
    },
    list(limit) {
      return newest.all(limit).map(rowToEntry);
    },
    count() {
      return Number(countRows.get().n);
    },
    clear() {
      db.exec('DELETE FROM history');
      last = null;
    },
    prune() {
      clearTimeout(pruneTimer);
      pruneTimer = null;
      prune.run(maxEntries);
    },
    pruneSoon() {
      if (pruneTimer) return;
      pruneTimer = setTimeout(() => {
        pruneTimer = null;
        try { log.prune(); } catch (e) { /* the next append tries again */ }
      }, PRUNE_DEBOUNCE_MS);
      if (pruneTimer.unref) pruneTimer.unref();
    },
  };
  return log;
}

function memoryLog(maxEntries) {
  let rows = [];
  return {
    last: () => rows[rows.length - 1] || null,
    push(clean) {
      rows.push(clean);
      if (rows.length > maxEntries) rows = rows.slice(-maxEntries);
    },
    importEntries(entries) {
      const after = rows.length ? rows[rows.length - 1].at : -Infinity;
      const fresh = entries.map(sanitize).filter((e) => e.at > after);
      rows = rows.concat(fresh).slice(-maxEntries);
      return fresh.length;
    },
    list: (limit) => rows.slice(-limit).reverse(),
    count: () => rows.length,
    clear() { rows = []; },
    prune() {},
    pruneSoon() {},
  };
}

// The viewing log for one userData folder. Electron-free so tests drive it.
function createViewingHistory({ dir, maxEntries = MAX_ENTRIES }) {
  const { db } = getDatabase(dir);
  const log = db ? sqlLog(db, maxEntries) : memoryLog(maxEntries);

  // The pre-SQLite log: { entries: [oldest … newest] }. Imported, then removed.
  const legacyFile = path.join(dir, HISTORY_FILE);
  if (fs.existsSync(legacyFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      if (Array.isArray(parsed && parsed.entries)) log.importEntries(parsed.entries);
    } catch (e) {
      console.error(`[history] could not import ${HISTORY_FILE}; dropping it:`, e.message);
    }
    // Kept only when there's nowhere durable to put it yet.
    if (db) {
      try { fs.rmSync(legacyFile, { force: true }); } catch (e) { /* next boot retries; the import skips rows it has */ }
    }
  }

  return {
    append(entry) {
      const clean = sanitize(entry);
      if (isRepeat(log.last(), clean)) return { ok: true, deduped: true };
      log.push(clean);
      return { ok: true, deduped: false };
    },
    // Newest first, because every caller wants "what did I watch recently".
    list: (limit) => log.list(clampLimit(limit)),
    // Oldest first: the whole log, for seeding a new household profile.
    all: () => log.list(maxEntries).reverse(),
    count: () => log.count(),
    clear: () => log.clear(),
  };
}

let shared = null;
// Opened on first use rather than at require() time: main.js's portable
// userData migration can still repoint app.getPath('userData') before then.
function viewingHistory() {
  if (!shared) shared = createViewingHistory({ dir: app.getPath('userData') });
  return shared;
}

function registerHistoryIpc() {
  ipcMain.handle('history:append', async (event, entry) => {
    try { return viewingHistory().append(entry); } catch (e) {
      console.error('[history] append failed:', e.message);
      return { ok: false, deduped: false };
    }
  });
  ipcMain.handle('history:list', async (event, limit) => viewingHistory().list(limit));
  ipcMain.handle('history:clear', async () => { viewingHistory().clear(); return true; });
}

module.exports = {
  createViewingHistory,
  HISTORY_FILE,
  registerHistoryIpc,
  viewingHistory,
};
