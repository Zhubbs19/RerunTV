// The library index on disk (docs/design/07 §3, contract C6).
//
// The `library` table in <userData>/rerun.db (main/util/db.js), with its own
// `schemaVersion` — deliberately NOT part of channels.json. Two reasons, both
// structural:
//
//   * C6 says schedule math reads only `ch.files`. Keeping the catalogue in a
//     separate file makes that hard to violate by accident: nothing on the
//     playback path ever loads this.
//   * channels.json is rewritten on every debounced edit and backed up on every
//     write. A catalogue of tens of thousands of items does not belong in that
//     loop.
//
// The index is still loaded whole and edited in memory (items are mutated in
// place, which is why `generation` exists). What changed is save(): it used
// to rewrite all of `library/index.json`, pretty-printed, for one edit; now it
// compares each item, series, query and preset with what was last saved and
// writes only the rows that differ, in one transaction, so a crash leaves
// either the old rows or the new ones. An existing index.json is imported on
// first load and kept beside the database as index.json.pre-sqlite. If SQLite
// can't be used this session, the store falls back to that JSON file exactly
// as before.
//
// Electron-free: the directories are injected, so tests drive it directly and
// the headless host uses it unchanged.
const crypto = require('crypto');
const fs = require('fs');
const { atomicWriteFileSync } = require('../util/atomic-write');
const { getDatabase, transaction } = require('../util/db');
const path = require('path');

// Version of the index layout this build reads and writes.
const SCHEMA_VERSION = 1;

/**
 * The three id-keyed maps have NO prototype. Item ids come from filenames and
 * from migration, so "__proto__" is a reachable key — and on an ordinary object
 * `items['__proto__']` returns Object.prototype, which is truthy. Every
 * existence check in this file would then be wrong for that one id. A
 * null-prototype map removes the whole class rather than requiring each site to
 * remember hasOwnProperty. JSON.stringify, Object.keys and Object.values all
 * work on them unchanged.
 * @param {?object} [source] Entries to copy in.
 * @returns {object} A null-prototype map.
 */
function idMap(source) {
  return Object.assign(Object.create(null), source || undefined);
}

/**
 * A fresh index with no roots, items, series, queries or presets.
 * @returns {object} The empty index.
 */
function emptyIndex() {
  return { schemaVersion: SCHEMA_VERSION, roots: [], items: idMap(), series: idMap(), queries: idMap(), presets: idMap() };
}

/**
 * Own-property check that is safe on null-prototype maps.
 * @param {object} map The map.
 * @param {string} key The key.
 * @returns {boolean} True when `map` has `key` of its own.
 */
function has(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * Ids are random, not derived from the ref or the fingerprint. A derived id
 * would change when a file moves or is re-encoded, which is precisely when
 * every channel referencing it must keep working.
 * @param {string} prefix Id prefix, such as `itm` or `root`.
 * @returns {string} A new random id.
 */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Anything absent is filled in rather than assumed: a hand-edited or
 * partially-written index must not crash the app, and a missing section is
 * indistinguishable from an empty one.
 * @param {*} raw A parsed index, possibly partial.
 * @returns {object} A complete index.
 */
function normalize(raw) {
  const base = emptyIndex();
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : SCHEMA_VERSION,
    roots: Array.isArray(raw.roots) ? raw.roots.filter((root) => root && root.id) : [],
    items: idMap(raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : null),
    series: idMap(raw.series && typeof raw.series === 'object' && !Array.isArray(raw.series) ? raw.series : null),
    queries: idMap(raw.queries && typeof raw.queries === 'object' && !Array.isArray(raw.queries) ? raw.queries : null),
    // Channel presets a person saved (docs/design/08): path-free templates,
    // keyed by their own id. Built-in and plugin presets never land here.
    presets: idMap(raw.presets && typeof raw.presets === 'object' && !Array.isArray(raw.presets) ? raw.presets : null),
  };
}

/**
 * Future schema bumps land here. v1 is the first, so there is nothing to do
 * yet; the branch exists so the next one has an obvious home and a test.
 * @param {object} index A normalised index.
 * @returns {object} The same index, at `SCHEMA_VERSION`.
 * @throws {Error} With code `LIBRARY_SCHEMA_TOO_NEW` when it was written by a newer build.
 */
function migrate(index) {
  if (index.schemaVersion > SCHEMA_VERSION) {
    // Written by a newer build. Refusing is better than silently dropping
    // fields this version does not understand on the next save.
    const error = new Error(`library/index.json is schema v${index.schemaVersion}; this build understands v${SCHEMA_VERSION}`);
    error.code = 'LIBRARY_SCHEMA_TOO_NEW';
    throw error;
  }
  index.schemaVersion = SCHEMA_VERSION;
  return index;
}

// The id-keyed sections, each stored as one row per entry.
const KINDS = ['items', 'series', 'queries', 'presets'];
/**
 * Row key for the `saved` snapshot: kind and id, NUL-separated.
 * @param {string} kind Section name, or `meta`.
 * @param {string} id Entry id.
 * @returns {string} The row key.
 */
const rowKey = (kind, id) => `${kind}\u0000${id}`;

/**
 * Error for a stored library newer than this build understands.
 * @param {string} message The error message.
 * @returns {Error} An error with code `LIBRARY_SCHEMA_TOO_NEW`.
 */
function schemaTooNew(message) {
  const error = new Error(message);
  error.code = 'LIBRARY_SCHEMA_TOO_NEW';
  return error;
}

/**
 * Every row the index would store, as serialized JSON. The meta rows hold the
 * roots list (order matters) and the index's own schemaVersion.
 * @param {object} index The index.
 * @returns {Map<string, string>} Row key to JSON text.
 */
function indexRows(index) {
  const rows = new Map();
  rows.set(rowKey('meta', 'schemaVersion'), JSON.stringify(index.schemaVersion));
  rows.set(rowKey('meta', 'roots'), JSON.stringify(index.roots));
  for (const kind of KINDS) {
    for (const [id, value] of Object.entries(index[kind])) rows.set(rowKey(kind, id), JSON.stringify(value));
  }
  return rows;
}

/**
 * `dir` is the library folder (scan log, metadata caches, the pre-SQLite
 * index.json); `dbDir` is where rerun.db lives — userData in the app, the
 * same temp folder in tests.
 * Creates the library store: loads the index lazily (SQLite, else the JSON fallback), edits it in memory and saves only changed rows.
 * @param {object} opts Options.
 * @param {string} opts.dir The library folder.
 * @param {string} [opts.dbDir=opts.dir] Folder holding rerun.db.
 * @param {Function} [opts.now] Clock in ms.
 * @returns {object} The store API (`load`, `save`, `stats`, `generation`, root, item, series, query and preset methods).
 */
function createLibraryStore({ dir, dbDir = dir, now = () => Date.now() }) {
  const indexPath = path.join(dir, 'index.json');
  let index = null;
  // The rows as last read or written: rowKey -> JSON text. save() writes only
  // the differences against it. null on the JSON fallback.
  let saved = null;
  let db = null;
  // Bumped on every mutation, exactly like the renderer's S.configGeneration
  // (CLAUDE.md). Anything that derives something from the library — a query's
  // results, a channel's candidate list — keys its cache on this rather than on
  // object identity, because items are mutated in place here too.
  let generation = 0;
  let loadError = null;

  // The pre-SQLite path, and the fallback when SQLite can't be used.
  function loadJsonFile() {
    try {
      index = migrate(normalize(JSON.parse(fs.readFileSync(indexPath, 'utf-8'))));
      loadError = null;
    } catch (e) {
      if (e.code === 'LIBRARY_SCHEMA_TOO_NEW') throw e;
      if (e.code !== 'ENOENT') {
        // A corrupt index is recoverable — it is derived from media that is
        // still on disk — but it is not throwaway: somebody's tags and review
        // decisions live here. Preserve the bytes before starting fresh, the
        // same way config.js preserves a corrupt channels.json.
        loadError = e.message;
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(indexPath, `${indexPath}.corrupt-${now()}`);
        } catch (copyError) { /* nothing more to do; we still start fresh */ }
        console.error(`[library] index.json could not be read (${e.message}) — starting a fresh index; the old bytes were preserved alongside it`);
      }
      index = emptyIndex();
    }
    return index;
  }

  function readRows() {
    const raw = { roots: [] };
    KINDS.forEach((kind) => { raw[kind] = Object.create(null); });
    const rows = new Map();
    for (const row of db.prepare('SELECT kind, id, value FROM library').all()) {
      let value;
      try { value = JSON.parse(row.value); } catch (e) {
        console.error(`[library] skipping an unreadable ${row.kind} row (${row.id}): ${e.message}`);
        continue;
      }
      rows.set(rowKey(row.kind, row.id), row.value);
      if (row.kind === 'meta') raw[row.id] = value;
      else if (KINDS.includes(row.kind)) raw[row.kind][row.id] = value;
    }
    return { raw, rows };
  }

  function writeRows(next) {
    const upsert = db.prepare(`INSERT INTO library (kind, id, value) VALUES (?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value`);
    const remove = db.prepare('DELETE FROM library WHERE kind = ? AND id = ?');
    const split = (key) => { const i = key.indexOf('\u0000'); return [key.slice(0, i), key.slice(i + 1)]; };
    let written = 0;
    transaction(db, () => {
      for (const [key, value] of next) {
        if (saved.get(key) === value) continue;
        upsert.run(...split(key), value);
        written += 1;
      }
      for (const key of saved.keys()) {
        if (next.has(key)) continue;
        remove.run(...split(key));
        written += 1;
      }
    });
    saved = next;
    return written;
  }

  // A pre-SQLite index.json found beside the database. Into an empty table it
  // is imported and kept as index.json.pre-sqlite; a corrupt one has already
  // been preserved by loadJsonFile. If the table already has a library (an
  // older build wrote index.json after a downgrade) the file is set aside
  // rather than allowed to overwrite it.
  function importLegacyIndex(tableHasLibrary) {
    if (!fs.existsSync(indexPath)) return;
    if (tableHasLibrary) {
      const aside = `${indexPath}.ignored-${now()}`;
      console.error(`[library] found index.json beside a library already in rerun.db; keeping the database and moving the file to ${aside}`);
      try { fs.renameSync(indexPath, aside); } catch (e) { /* tried again next boot */ }
      return;
    }
    loadJsonFile(); // throws LIBRARY_SCHEMA_TOO_NEW and leaves the file alone
    if (!loadError) writeRows(indexRows(index));
    try {
      if (loadError) fs.rmSync(indexPath, { force: true }); // its bytes are in index.json.corrupt-*
      else fs.renameSync(indexPath, `${indexPath}.pre-sqlite`);
    } catch (e) { /* next boot sees a library in the table and sets the file aside */ }
  }

  function load() {
    if (index) return index;
    const database = getDatabase(dbDir);
    if (database.tooNew) throw schemaTooNew('rerun.db was written by a newer build; the library is not loaded so nothing in it is dropped');
    if (!database.db) return loadJsonFile();
    db = database.db;
    const { raw, rows } = readRows();
    saved = rows;
    const tableHasLibrary = rows.has(rowKey('meta', 'schemaVersion'));
    if (tableHasLibrary) {
      if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) {
        index = null;
        throw schemaTooNew(`the library in rerun.db is schema v${raw.schemaVersion}; this build understands v${SCHEMA_VERSION}`);
      }
      index = migrate(normalize(raw));
      loadError = null;
    } else {
      index = emptyIndex();
    }
    importLegacyIndex(tableHasLibrary);
    return index;
  }

  function save() {
    const current = load();
    if (saved) {
      writeRows(indexRows(current));
      return current;
    }
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(indexPath, JSON.stringify(current, null, 2), { encoding: 'utf-8' });
    return current;
  }

  function touch() {
    generation += 1;
  }

  // ---------- Roots ----------

  function addRoot({ ref, kind = 'local', id = null, label = null }) {
    const current = load();
    const existing = current.roots.find((root) => root.ref === ref);
    if (existing) return existing;
    const root = { id: id || newId('root'), ref, kind, label: label || null, addedAt: now() };
    current.roots.push(root);
    touch();
    return root;
  }

  function removeRoot(rootId) {
    const current = load();
    const before = current.roots.length;
    current.roots = current.roots.filter((root) => root.id !== rootId);
    // Items are left behind on purpose. A root is often removed because a drive
    // is temporarily unplugged, and dropping every item would throw away the
    // tags and review decisions attached to them — then relink them all on
    // reconnect. `orphanedItems` reports them; deleting is an explicit act.
    if (current.roots.length !== before) touch();
    return current.roots.length !== before;
  }

  function getRoot(rootId) {
    return load().roots.find((root) => root.id === rootId) || null;
  }

  // Items whose root is no longer registered.
  function orphanedItems() {
    const current = load();
    const known = new Set(current.roots.map((root) => root.id));
    return Object.values(current.items).filter((item) => !known.has(item.root));
  }

  // ---------- Items ----------

  function getItem(itemId) {
    const items = load().items;
    return has(items, itemId) ? items[itemId] : null;
  }

  function findByRef(ref) {
    return Object.values(load().items).find((item) => item.ref === ref) || null;
  }

  function itemsInRoot(rootId) {
    return Object.values(load().items).filter((item) => item.root === rootId);
  }

  function allItems() {
    return Object.values(load().items);
  }

  // Adds an item and returns it. `id` is generated unless the caller supplies
  // one (migration does, so a re-run produces the same library).
  function addItem(fields) {
    const current = load();
    const id = fields.id || newId('itm');
    if (has(current.items, id)) throw new Error(`library: item ${id} already exists`);
    // defineProperty, not assignment: an id like "__proto__" coming from a
    // filename must define an own property rather than reach the prototype.
    Object.defineProperty(current.items, id, {
      value: { ...fields, id, addedAt: fields.addedAt || now() },
      enumerable: true, configurable: true, writable: true,
    });
    touch();
    return current.items[id];
  }

  // Merges `fields` into an existing item, in place — object identity survives,
  // which is why `generation` exists (CLAUDE.md's config-mutation rule applies
  // here for the same reason).
  function updateItem(itemId, fields) {
    const item = getItem(itemId);
    if (!item) return null;
    Object.assign(item, fields, { id: itemId });
    touch();
    return item;
  }

  function removeItem(itemId) {
    const current = load();
    if (!has(current.items, itemId)) return false;
    delete current.items[itemId];
    touch();
    return true;
  }

  // ---------- Series and saved queries ----------

  function upsertSeries(seriesId, fields) {
    const current = load();
    const id = seriesId || newId('ser');
    const existing = has(current.series, id) ? current.series[id] : null;
    if (existing) Object.assign(existing, fields);
    else {
      Object.defineProperty(current.series, id, {
        value: { ...fields, id }, enumerable: true, configurable: true, writable: true,
      });
    }
    touch();
    return current.series[id];
  }

  function upsertQuery(queryId, fields) {
    const current = load();
    const id = queryId || newId('q');
    const existing = has(current.queries, id) ? current.queries[id] : null;
    if (existing) Object.assign(existing, fields);
    else {
      Object.defineProperty(current.queries, id, {
        value: { ...fields, id }, enumerable: true, configurable: true, writable: true,
      });
    }
    touch();
    return current.queries[id];
  }

  function removeQuery(queryId) {
    const current = load();
    if (!has(current.queries, queryId)) return false;
    delete current.queries[queryId];
    touch();
    return true;
  }

  // ---------- Channel presets ----------
  // A preset is stored whole, under its own id, and replaced whole: the
  // renderer validates the shape (channel-builder.js) before it gets here.
  function upsertPreset(preset) {
    const current = load();
    const id = String(preset.id);
    Object.defineProperty(current.presets, id, {
      value: { ...preset, id }, enumerable: true, configurable: true, writable: true,
    });
    touch();
    return current.presets[id];
  }

  function removePreset(presetId) {
    const current = load();
    if (!has(current.presets, presetId)) return false;
    delete current.presets[presetId];
    touch();
    return true;
  }

  return {
    SCHEMA_VERSION,
    indexPath,
    load,
    save,
    // 'sqlite', or 'json' when this session fell back to index.json.
    backend: () => { load(); return saved ? 'sqlite' : 'json'; },
    // What a cache keys on. Never reset, only increased.
    generation: () => generation,
    // Non-null when the index on disk could not be read and a fresh one was
    // started; the setup screen surfaces it rather than failing silently.
    lastLoadError: () => loadError,
    stats: () => {
      const current = load();
      return {
        roots: current.roots.length,
        items: Object.keys(current.items).length,
        series: Object.keys(current.series).length,
        queries: Object.keys(current.queries).length,
        presets: Object.keys(current.presets).length,
      };
    },
    addRoot, removeRoot, getRoot, orphanedItems,
    getItem, findByRef, itemsInRoot, allItems, addItem, updateItem, removeItem,
    upsertSeries, upsertQuery, removeQuery, upsertPreset, removePreset,
  };
}

module.exports = { createLibraryStore, emptyIndex, normalize, migrate, newId, SCHEMA_VERSION };
