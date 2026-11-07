// The app's SQLite file, <userData>/rerun.db, opened through Node's built-in
// node:sqlite. Being built in matters: there's no native module to rebuild for
// every Electron upgrade, and it needs no command-line flag, which the
// packaged build couldn't pass anyway (its fuses turn off NODE_OPTIONS).
//
// What lives here, each of which used to be a JSON file rewritten whole on
// every change:
//   cache     regenerable caches (the web API response cache, the leveler's
//             loudness and the black-bar crop measurements), one row per entry
//   history   the viewing log (main/diagnostics/history.js), one row per programme
//   library   the media library index (main/library/store.js), one row per
//             item, series, saved query and preset
//
// channels.json is deliberately NOT here and isn't meant to move: the command
// layer, undo, the config host's replay, /api/config and the rotating backups
// all treat it as one JSON document.
//
// Electron-free, with the directory injected, so the unit tests drive it under
// plain node. If node:sqlite can't be loaded or the file can't be opened, each
// user falls back (caches and history to memory, the library to its JSON
// file) rather than failing its caller.
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
const PRUNE_DEBOUNCE_MS = 2000;
// SQLite result codes that mean the file itself is damaged, as opposed to busy
// or unreachable for the moment.
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

// Schema steps, applied in order from PRAGMA user_version. Append only: a
// shipped step never changes, the next change is a new step.
const MIGRATIONS = [
  // 1: caches.
  `CREATE TABLE IF NOT EXISTS cache (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (ns, key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS cache_age ON cache (ns, at);`,
  // 2: viewing history. Columns rather than a JSON blob, so "what did I watch
  // on channel 12 last week" is an indexed query.
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    view_at INTEGER NOT NULL,
    channel_number REAL,
    channel_name TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    duration_s REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_at ON history (at);`,
  // 3: the library index. kind is items/series/queries/presets, or meta for
  // the roots list and the index's own schemaVersion.
  `CREATE TABLE IF NOT EXISTS library (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID;`,
];
const SCHEMA_VERSION = MIGRATIONS.length;

let sqlite = null;
let sqliteLoadError = null;
try {
  sqlite = require('node:sqlite');
} catch (e) {
  sqliteLoadError = e;
}

// resolved dir -> { db, tooNew, tables: Map(ns -> table) }. db is null when
// SQLite is unavailable or the file couldn't be used.
const handles = new Map();

/**
 * The error raised when the file was written by a newer schema than this build knows.
 * @param {number} version The schema version found in the file.
 * @returns {Error} An error with code `DB_SCHEMA_TOO_NEW`.
 */
function tooNewError(version) {
  const error = new Error(`${DB_FILE} is schema ${version}, newer than this build understands (${SCHEMA_VERSION})`);
  error.code = 'DB_SCHEMA_TOO_NEW';
  return error;
}

/**
 * Runs fn inside one transaction.
 * @param {object} db The open `DatabaseSync`.
 * @param {Function} fn The work to run; its return value is passed through.
 * @returns {*} What `fn` returned.
 * @throws {Error} Whatever `fn` threw, after rolling back.
 */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Sets the connection pragmas and runs any pending `MIGRATIONS` steps.
 * @param {object} db The open `DatabaseSync`.
 * @throws {Error} When the file is newer than this build (`DB_SCHEMA_TOO_NEW`) or a step fails.
 */
function applySchema(db) {
  db.exec('PRAGMA busy_timeout = 2000');
  // Checked before anything writes: even switching the journal mode rewrites
  // the file header, and a newer build's file must be left byte-for-byte alone.
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > SCHEMA_VERSION) throw tooNewError(version);
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL in WAL mode can lose the last commits on power loss but never
  // corrupts the file.
  db.exec('PRAGMA synchronous = NORMAL');
  for (let step = version; step < SCHEMA_VERSION; step += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[step]);
      db.exec(`PRAGMA user_version = ${step + 1}`);
    });
  }
}

/**
 * Opens `file` and brings its schema up to date, closing it again on failure.
 * @param {string} file The database file path.
 * @returns {object} The open `DatabaseSync`.
 * @throws {Error} When the file cannot be opened or migrated.
 */
function openFile(file) {
  const db = new sqlite.DatabaseSync(file);
  try {
    applySchema(db);
    return db;
  } catch (e) {
    try { db.close(); } catch (e2) { /* already unusable */ }
    throw e;
  }
}

/**
 * True when a SQLite error means the file itself is corrupt or not a database.
 * @param {?Error} error The error caught while opening.
 * @returns {boolean} Whether the file is damaged.
 */
function isDamaged(error) {
  return !!error && (error.errcode === SQLITE_CORRUPT || error.errcode === SQLITE_NOTADB);
}

/**
 * Only a damaged file is moved aside (never deleted) for a fresh one. It can
 * hold the library, so a lock, a permissions problem or a file from a newer
 * build is left exactly where it is.
 * @param {string} dir The resolved directory holding rerun.db.
 * @returns {object} The open `DatabaseSync`.
 * @throws {Error} When opening fails for a reason other than damage.
 */
function openOrReplace(dir) {
  const file = path.join(dir, DB_FILE);
  try {
    return openFile(file);
  } catch (e) {
    if (!isDamaged(e)) throw e;
    console.error(`${file} is damaged (${e.message}); setting it aside and starting a fresh one`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const name of DB_FILES) {
      try { fs.renameSync(path.join(dir, name), path.join(dir, `${name}.unreadable-${stamp}`)); } catch (e2) { /* not there */ }
    }
    return openFile(file);
  }
}

/**
 * The cached handle for `dir`, opening the database on first use.
 * Never throws: a failure leaves `db` null for the rest of the session.
 * @param {string} dir The directory holding rerun.db.
 * @returns {object} `{ dir, db, tooNew, tables }`.
 */
function getHandle(dir) {
  const key = path.resolve(dir);
  let handle = handles.get(key);
  if (handle) return handle;
  let db = null;
  let tooNew = false;
  if (sqlite) {
    try {
      fs.mkdirSync(key, { recursive: true });
      db = openOrReplace(key);
    } catch (e) {
      tooNew = e.code === 'DB_SCHEMA_TOO_NEW';
      console.error(`SQLite storage unavailable this session (${e.message}); falling back`);
    }
  } else {
    console.error('node:sqlite could not be loaded; falling back this session:', sqliteLoadError && sqliteLoadError.message);
  }
  handle = { dir: key, db, tooNew, tables: new Map() };
  handles.set(key, handle);
  return handle;
}

/**
 * The open database for <dir>/rerun.db, for modules with their own tables
 * (history, library). { db: null } when SQLite can't be used this session;
 * tooNew is true when that's because a newer build wrote the file.
 * @param {string} dir The directory holding rerun.db.
 * @returns {object} `{ db, tooNew }`.
 */
function getDatabase(dir) {
  const handle = getHandle(dir);
  return { db: handle.db, tooNew: handle.tooNew };
}

/**
 * Parses a stored JSON value, or `undefined` when it does not parse.
 * @param {string} text The stored text.
 * @returns {*} The parsed value, or undefined.
 */
function parseValue(text) {
  try { return JSON.parse(text); } catch (e) { return undefined; }
}

/**
 * True when `field` is a plain identifier, safe to splice into a JSON path.
 * @param {*} field The field name to check.
 * @returns {boolean} Whether it is safe.
 */
function isSafeField(field) {
  return typeof field === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
}

/**
 * One namespace of the cache table, keyed by string. Values are anything
 * JSON.stringify accepts; `at` (ms) is when the entry was written and is what
 * the oldest-first cap uses.
 * @param {object} db The open `DatabaseSync`.
 * @param {string} ns The namespace.
 * @param {number} maxEntries The oldest-first cap; 0 for none.
 * @returns {object} The table API: `get`, `set`, `count`, `countWithField`, `merge`, `prune`, `pruneSoon`, `dispose`.
 */
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
      transaction(db, () => {
        for (const [key, value, at] of entries) {
          mergeStmt.run(ns, String(key), Math.round(Number(at) || 0), JSON.stringify(value));
          n += 1;
        }
      });
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

/**
 * Same API, kept in memory: the fallback when SQLite isn't available.
 * @param {number} maxEntries The oldest-first cap; 0 for none.
 * @returns {object} The same table API as `sqlTable`.
 */
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

/**
 * Brings a pre-SQLite JSON cache file in once, then removes it. `toEntries`
 * turns the parsed file into [key, value, at] triples (or returns null for a
 * file it doesn't recognise, which is then just removed). A file that won't
 * parse is removed too — it was only ever a cache.
 * @param {object} table The cache table to merge into.
 * @param {string} file The legacy JSON file path.
 * @param {Function} toEntries Turns the parsed file into `[key, value, at]` triples, or null.
 * @returns {number} How many entries were merged.
 */
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

/**
 * The cache namespace `ns` in <dir>/rerun.db, created on first use and shared
 * by every later call for the same dir and ns.
 *   maxEntries   oldest-first cap (by `at`); 0 or absent for none
 *   importFrom   { file, toEntries } — a legacy JSON cache to bring in once
 * @param {string} dir The directory holding rerun.db.
 * @param {string} ns The namespace.
 * @param {object} [opts] Options.
 * @param {number} [opts.maxEntries=0] Oldest-first cap.
 * @param {?object} [opts.importFrom=null] `{ file, toEntries }` legacy JSON cache to import once.
 * @returns {object} The table API.
 */
function cacheTable(dir, ns, { maxEntries = 0, importFrom = null } = {}) {
  const handle = getHandle(dir);
  let table = handle.tables.get(ns);
  if (table) return table;
  table = handle.db ? sqlTable(handle.db, ns, maxEntries) : memoryTable(maxEntries);
  handle.tables.set(ns, table);
  if (importFrom && importFrom.file) importJsonFile(table, importFrom.file, importFrom.toEntries);
  return table;
}

/**
 * A consistent single-file copy of <dir>/rerun.db at `destFile`, safe to take
 * while the database is open and being written. False when there's no database.
 * @param {string} dir The directory holding rerun.db.
 * @param {string} destFile Where to write the copy.
 * @returns {boolean} True when a copy was written.
 */
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

/**
 * Closes every open database (a clean close folds the WAL back into the main
 * file). For app quit and tests; a later cacheTable() call reopens.
 */
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
  SCHEMA_VERSION,
  cacheTable,
  closeAll,
  getDatabase,
  transaction,
  /**
   * Whether node:sqlite loaded this session (when it didn't, every table falls back).
   * @returns {boolean} True when SQLite is available.
   */
  isSqliteAvailable: () => !!sqlite,
  snapshotDb,
};
