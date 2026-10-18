// The library index on disk (docs/design/07 §3, contract C6).
//
// `userData/library/index.json`, with its own `schemaVersion` — deliberately
// NOT part of channels.json. Two reasons, both structural:
//
//   * C6 says schedule math reads only `ch.files`. Keeping the catalogue in a
//     separate file makes that hard to violate by accident: nothing on the
//     playback path ever loads this.
//   * channels.json is rewritten on every debounced edit and backed up on every
//     write. A catalogue of tens of thousands of items does not belong in that
//     loop.
//
// Electron-free: the directory is injected, so tests drive it directly and the
// headless host uses it unchanged. Writes are temp-then-rename, matching
// main/config/config.js's writeConfigFile — a crash mid-write leaves the old
// index intact rather than a truncated one.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

// The three id-keyed maps have NO prototype. Item ids come from filenames and
// from migration, so "__proto__" is a reachable key — and on an ordinary object
// `items['__proto__']` returns Object.prototype, which is truthy. Every
// existence check in this file would then be wrong for that one id. A
// null-prototype map removes the whole class rather than requiring each site to
// remember hasOwnProperty. JSON.stringify, Object.keys and Object.values all
// work on them unchanged.
function idMap(source) {
  return Object.assign(Object.create(null), source || undefined);
}

function emptyIndex() {
  return { schemaVersion: SCHEMA_VERSION, roots: [], items: idMap(), series: idMap(), queries: idMap(), presets: idMap() };
}

function has(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// Ids are random, not derived from the ref or the fingerprint. A derived id
// would change when a file moves or is re-encoded, which is precisely when
// every channel referencing it must keep working.
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// Anything absent is filled in rather than assumed: a hand-edited or
// partially-written index must not crash the app, and a missing section is
// indistinguishable from an empty one.
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

// Future schema bumps land here. v1 is the first, so there is nothing to do
// yet; the branch exists so the next one has an obvious home and a test.
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

function createLibraryStore({ dir, now = () => Date.now() }) {
  const indexPath = path.join(dir, 'index.json');
  let index = null;
  // Bumped on every mutation, exactly like the renderer's S.configGeneration
  // (CLAUDE.md). Anything that derives something from the library — a query's
  // results, a channel's candidate list — keys its cache on this rather than on
  // object identity, because items are mutated in place here too.
  let generation = 0;
  let loadError = null;

  function load() {
    if (index) return index;
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

  function save() {
    const current = load();
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `index.json.tmp-${process.pid}-${now()}`);
    fs.writeFileSync(temp, JSON.stringify(current, null, 2), 'utf-8');
    fs.renameSync(temp, indexPath);
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
