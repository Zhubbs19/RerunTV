// The app's SQLite file, <userData>/rerun.db, opened through Node's built-in
// node:sqlite. Being built in matters: there's no native module to rebuild for
// every Electron upgrade, and it needs no command-line flag, which the
// packaged build couldn't pass anyway (its fuses turn off NODE_OPTIONS).
//
// Today it holds only regenerable caches (the web API response cache, the
// leveler's loudness and the black-bar crop measurements). Each used to be a
// JSON file rewritten whole for every new entry, which for the API cache meant
// several megabytes per metadata lookup. Here each entry is one row.
//
// channels.json is deliberately NOT here and isn't meant to move: the command
// layer, undo, the config host's replay, /api/config and the rotating backups
// all treat it as one JSON document.
//
// Electron-free, with the directory injected, so the unit tests drive it under
// plain node. If node:sqlite can't be loaded or the file can't be opened, a
// cache falls back to memory for the session rather than failing its caller.
//
// The update-install safety copy (main/config/config.js) must not file-copy an
// open database in WAL mode, so it skips these files and calls snapshotDb(),
// which writes a consistent single-file copy with VACUUM INTO.
const fs = require('fs');
const path = require('path');

const DB_FILE = 'rerun.db';
// The database and the two files SQLite keeps beside it while it's open in WAL
// mode. A clean close folds -wal back in and removes both.
const DB_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`];
const SCHEMA_VERSION = 1;
const PRUNE_DEBOUNCE_MS = 2000;

let sqlite = null;
let sqliteLoadError = null;
try {
  sqlite = require('node:sqlite');
} catch (e) {
  sqliteLoadError = e;
}

// resolved dir -> { db, tables: Map(ns -> table) }. db is null when SQLite is unavailable.
const handles = new Map();

function createSchema(db) {
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL in WAL mode can lose the last commits on power loss but never
  // corrupts the file — the right trade for caches written many times a minute.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 2000');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error(`${DB_FILE} is schema ${version}, newer than this build understands (${SCHEMA_VERSION})`);
  db.exec(`CREATE TABLE IF NOT EXISTS cache (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (ns, key)
  ) WITHOUT ROWID`);
  db.exec('CREATE INDEX IF NOT EXISTS cache_age ON cache (ns, at)');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function openFile(file) {
  const db = new sqlite.DatabaseSync(file);
  try {
    createSchema(db);
    return db;
  } catch (e) {
    try { db.close(); } catch (e2) { /* already unusable */ }
    throw e;
  }
}

// A file that won't open (corrupt, or from a newer build) is moved aside, not
// deleted, and a fresh one started — everything in it today is regenerable.
function openOrReplace(dir) {
  const file = path.join(dir, DB_FILE);
  try {
    return openFile(file);
  } catch (e) {
    console.error(`Could not open ${file}; setting it aside and starting a fresh one:`, e.message);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const name of DB_FILES) {
      try { fs.renameSync(path.join(dir, name), path.join(dir, `${name}.unreadable-${stamp}`)); } catch (e2) { /* not there */ }
    }
    return openFile(file);
  }
}

function getHandle(dir) {
  const key = path.resolve(dir);
  let handle = handles.get(key);
  if (handle) return handle;
  let db = null;
  if (sqlite) {
    try {
      fs.mkdirSync(key, { recursive: true });
      db = openOrReplace(key);
    } catch (e) {
      console.error('SQLite storage unavailable; caches will be kept in memory this session:', e.message);
    }
  } else {
    console.error('node:sqlite could not be loaded; caches will be kept in memory this session:', sqliteLoadError && sqliteLoadError.message);
  }
  handle = { dir: key, db, tables: new Map() };
  handles.set(key, handle);
  return handle;
}

function parseValue(text) {
  try { return JSON.parse(text); } catch (e) { return undefined; }
}

function isSafeField(field) {
  return typeof field === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
}

// One namespace of the cache table, keyed by string. Values are anything
// JSON.stringify accepts; `at` (ms) is when the entry was written and is what
// the oldest-first cap uses.
function sqlTable(db, ns, maxEntries) {
  const getStmt = db.prepare('SELECT at, value FROM cache WHERE ns = ? AND key = ?');
  const setStmt = db.prepare(`INSERT INTO cache (ns, key, at, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (ns, key) DO UPDATE SET at = excluded.at, value = excluded.value`);
  // Used by the JSON import: never let an older file entry replace a newer row.
  const mergeStmt = db.prepare(`INSERT INTO cache (ns, key, at, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (ns, key) DO UPDATE SET at = excluded.at, value = excluded.value WHERE excluded.at > cache.at`);
  const countStmt = db.prepare('SELECT count(*) AS n FROM cache WHERE ns = ?');
  const pruneStmt = db.prepare(`DELETE FROM cache WHERE ns = ? AND key IN
    (SELECT key FROM cache WHERE ns = ? ORDER BY at ASC LIMIT ?)`);
  const countWhere = new Map();
  let pruneTimer = null;

  const table = {
    get(key) {
      const row = getStmt.get(ns, String(key));
      if (!row) return null;
      const value = parseValue(row.value);
      return value === undefined ? null : { at: Number(row.at), value };
    },
    set(key, value, at = Date.now()) {
      setStmt.run(ns, String(key), Math.round(Number(at) || 0), JSON.stringify(value));
      if (maxEntries) table.pruneSoon();
    },
    count() {
      return Number(countStmt.get(ns).n);
    },
    // Rows whose value has a non-null top-level `field`.
    countWithField(field) {
      if (!isSafeField(field)) throw new Error(`countWithField: unsupported field name ${field}`);
      let stmt = countWhere.get(field);
      if (!stmt) {
        stmt = db.prepare(`SELECT count(*) AS n FROM cache WHERE ns = ? AND json_extract(value, '$.${field}') IS NOT NULL`);
        countWhere.set(field, stmt);
      }
      return Number(stmt.get(ns).n);
    },
    // Many writes as one transaction. `entries` yields [key, value, at].
    merge(entries) {
      let n = 0;
      db.exec('BEGIN');
      try {
        for (const [key, value, at] of entries) {
          mergeStmt.run(ns, String(key), Math.round(Number(at) || 0), JSON.stringify(value));
          n += 1;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      if (maxEntries) table.prune();
      return n;
    },
    prune() {
      clearTimeout(pruneTimer);
      pruneTimer = null;
      if (!maxEntries) return 0;
      const over = table.count() - maxEntries;
      if (over <= 0) return 0;
      pruneStmt.run(ns, ns, over);
      return over;
    },
    // Writes come in bursts (a bulk metadata match, a loudness sweep), so the cap
    // is enforced once the burst settles rather than per row.
    pruneSoon() {
      if (pruneTimer) return;
      pruneTimer = setTimeout(() => {
        pruneTimer = null;
        try { table.prune(); } catch (e) { /* a missed prune just waits for the next write */ }
      }, PRUNE_DEBOUNCE_MS);
      if (pruneTimer.unref) pruneTimer.unref();
    },
    dispose() {
      clearTimeout(pruneTimer);
      pruneTimer = null;
    },
  };
  return table;
}

// Same API, kept in memory: the fallback when SQLite isn't available.
function memoryTable(maxEntries) {
  const rows = new Map();
  const table = {
    get(key) {
      const row = rows.get(String(key));
      return row ? { at: row.at, value: row.value } : null;
    },
    set(key, value, at = Date.now()) {
      rows.set(String(key), { at: Math.round(Number(at) || 0), value: JSON.parse(JSON.stringify(value)) });
      if (maxEntries) table.prune();
    },
    count() { return rows.size; },
    countWithField(field) {
      let n = 0;
      for (const row of rows.values()) if (row.value && row.value[field] != null) n += 1;
      return n;
    },
    merge(entries) {
      let n = 0;
      for (const [key, value, at] of entries) {
        const existing = rows.get(String(key));
        const when = Math.round(Number(at) || 0);
        if (!existing || when > existing.at) rows.set(String(key), { at: when, value: JSON.parse(JSON.stringify(value)) });
        n += 1;
      }
      if (maxEntries) table.prune();
      return n;
    },
    prune() {
      const over = rows.size - (maxEntries || Infinity);
      if (over <= 0) return 0;
      [...rows.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, over).forEach(([key]) => rows.delete(key));
      return over;
    },
    pruneSoon() { table.prune(); },
    dispose() {},
  };
  return table;
}

// Brings a pre-SQLite JSON cache file in once, then removes it. `toEntries`
// turns the parsed file into [key, value, at] triples (or returns null for a
// file it doesn't recognise, which is then just removed). A file that won't
// parse is removed too — it was only ever a cache.
function importJsonFile(table, file, toEntries) {
  if (!fs.existsSync(file)) return 0;
  let imported = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = toEntries(parsed);
    if (entries) imported = table.merge(entries);
  } catch (e) {
    console.error(`Could not import ${path.basename(file)} into ${DB_FILE}; dropping it (it is only a cache):`, e.message);
  }
  try { fs.rmSync(file, { force: true }); } catch (e) { /* next boot tries again; the merge never replaces newer rows */ }
  return imported;
}

// The cache namespace `ns` in <dir>/rerun.db, created on first use and shared
// by every later call for the same dir and ns.
//   maxEntries   oldest-first cap (by `at`); 0 or absent for none
//   importFrom   { file, toEntries } — a legacy JSON cache to bring in once
function cacheTable(dir, ns, { maxEntries = 0, importFrom = null } = {}) {
  const handle = getHandle(dir);
  let table = handle.tables.get(ns);
  if (table) return table;
  table = handle.db ? sqlTable(handle.db, ns, maxEntries) : memoryTable(maxEntries);
  handle.tables.set(ns, table);
  if (importFrom && importFrom.file) importJsonFile(table, importFrom.file, importFrom.toEntries);
  return table;
}

// A consistent single-file copy of <dir>/rerun.db at `destFile`, safe to take
// while the database is open and being written. False when there's no database.
function snapshotDb(dir, destFile) {
  const key = path.resolve(dir);
  const handle = handles.get(key);
  if (handle && handle.db) {
    handle.db.prepare('VACUUM INTO ?').run(destFile);
    return true;
  }
  const file = path.join(key, DB_FILE);
  if (!sqlite || !fs.existsSync(file)) return false;
  const db = new sqlite.DatabaseSync(file);
  try {
    db.prepare('VACUUM INTO ?').run(destFile);
  } finally {
    db.close();
  }
  return true;
}

// Closes every open database (a clean close folds the WAL back into the main
// file). For app quit and tests; a later cacheTable() call reopens.
function closeAll() {
  for (const handle of handles.values()) {
    handle.tables.forEach((table) => table.dispose());
    if (handle.db) {
      try { handle.db.close(); } catch (e) { /* already closed */ }
    }
  }
  handles.clear();
}

module.exports = {
  DB_FILE,
  DB_FILES,
  cacheTable,
  closeAll,
  isSqliteAvailable: () => !!sqlite,
  snapshotDb,
};
