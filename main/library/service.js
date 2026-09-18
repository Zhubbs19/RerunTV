// The library's host-side API (docs/design/07). One object, called the same
// way from the Electron window (IPC `library:call`) and from a paired LAN
// control panel (`POST /api/control/library/<method>`), so there is one set of
// rules rather than two.
//
// Nothing here moves, renames or deletes a media file. Scanning READS — a
// directory listing, a stat, and the first megabyte of files whose stat moved.
// "Moving a root" is text: the person moved the files themselves and is telling
// the library where they went.
//
// Electron-free: storage directory, listers and fingerprinting are injected.
const fs = require('fs');
const path = require('path');
const { createLibraryStore } = require('./store');
const { scanRoot, applyScan, describeScan } = require('./scan');
const identity = require('./identity');
const { planMigration, finalizeMigration } = require('./migrate');

// A scan walks a whole root before it reads anything, and stops early rather
// than reading an unexpectedly enormous tree. A root is normally one show or
// movie folder; hitting this means somebody pointed a root at a whole drive,
// which should be a deliberate choice (`maxFiles` raises it), not an accident.
const DEFAULT_MAX_SCAN_FILES = 5000;

// Methods a LAN control panel may call. Everything that rewrites the whole
// library, or all of config at once, stays on the host window.
const REMOTE_METHODS = new Set([
  'status', 'getIndex', 'scanRoot', 'applyItemUpdates', 'saveQuery', 'removeQuery', 'resolveReview', 'lastScan',
]);

function walkLocal(root, extensions, maxFiles) {
  const out = [];
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '_originals_backup') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (out.length >= maxFiles) { truncated = true; break; }
      try {
        const stat = fs.statSync(full);
        out.push({ ref: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (e) { /* vanished between listing and stat */ }
    }
    if (truncated) break;
  }
  return { entries: out.sort((a, b) => a.ref.localeCompare(b.ref)), truncated };
}

function createLibraryService({
  dir,
  videoExtensions,
  listProvider = null,     // async (root) -> [{ ref, etag?, size? }]
  now = () => Date.now(),
  maxScanFiles = DEFAULT_MAX_SCAN_FILES,
}) {
  const store = createLibraryStore({ dir, now });
  const scanLogPath = path.join(dir, 'last-scan.json');
  let lastScanReports = {};
  try { lastScanReports = JSON.parse(fs.readFileSync(scanLogPath, 'utf-8')); } catch (e) { lastScanReports = {}; }
  let scanning = null;

  function persistScanLog() {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${scanLogPath}.tmp-${process.pid}-${now()}`;
    fs.writeFileSync(temp, JSON.stringify(lastScanReports, null, 2), 'utf-8');
    fs.renameSync(temp, scanLogPath);
  }

  const api = {
    status() {
      const stats = store.stats();
      return {
        built: stats.items > 0,
        stats,
        roots: store.load().roots,
        orphaned: store.orphanedItems().length,
        loadError: store.lastLoadError(),
        scanning: scanning ? { root: scanning.rootId, done: scanning.done, total: scanning.total } : null,
        generation: store.generation(),
      };
    },

    getIndex() {
      return store.load();
    },

    lastScan({ rootId } = {}) {
      return rootId ? lastScanReports[rootId] || null : lastScanReports;
    },

    // Plans the migration from the host's own config. The caller verifies each
    // channel with diffSchedules before committing; see migrate.js.
    planMigration({ config }) {
      if (!config || !Array.isArray(config.channels)) throw new Error('A config with channels is required.');
      return planMigration(config, { now });
    },

    // Keeps only the channels the caller verified as identical (migrate.js).
    // Here rather than in the renderer because migrate.js is CommonJS; it is
    // pure, so this writes nothing.
    finalizeMigration({ original, plan, verdicts }) {
      if (!original || !Array.isArray(original.channels)) throw new Error('The config the plan was made from is required.');
      if (!plan || !plan.config || !plan.index) throw new Error('A migration plan is required.');
      return finalizeMigration(original, plan, verdicts || {});
    },

    // Saves a finalized migration's index. Refuses to overwrite a library that
    // already has items unless told to — a second build must not silently drop
    // tags and review decisions made since the first.
    commitMigration({ index, replace = false }) {
      if (!index || typeof index !== 'object') throw new Error('An index is required.');
      if (store.stats().items > 0 && !replace) throw new Error('The library is already built. Rebuilding it would discard tags and review decisions.');
      const current = store.load();
      current.roots = index.roots || [];
      Object.keys(current.items).forEach((id) => { delete current.items[id]; });
      Object.values(index.items || {}).forEach((item) => {
        Object.defineProperty(current.items, item.id, { value: item, enumerable: true, configurable: true, writable: true });
      });
      store.save();
      return store.stats();
    },

    async scanRoot({ rootId, maxFiles = maxScanFiles }) {
      const root = store.getRoot(rootId);
      if (!root) throw new Error('That root is not in the library.');
      if (scanning) throw new Error('A scan is already running.');
      scanning = { rootId, done: 0, total: 0 };
      try {
        let list;
        let fingerprint;
        let truncated = false;
        if (root.kind === 'provider') {
          if (!listProvider) throw new Error('This provider cannot be listed from here yet.');
          const listed = await listProvider(root);
          list = async () => listed.map((entry) => ({ ref: entry.ref, size: entry.size ?? null, mtimeMs: null }));
          const byRef = new Map(listed.map((entry) => [entry.ref, entry]));
          fingerprint = async (ref) => identity.fingerprintProvider({ id: root.source, etag: (byRef.get(ref) || {}).etag, size: (byRef.get(ref) || {}).size });
        } else {
          if (!fs.existsSync(root.ref)) throw new Error(`${root.ref} is not reachable. Is the drive connected?`);
          const walked = walkLocal(root.ref, videoExtensions, maxFiles);
          truncated = walked.truncated;
          if (truncated) {
            // Refuse rather than scan part of it: a partial scan cannot tell
            // "not read yet" from "gone", and reading an entire drive's worth of
            // first megabytes should be a choice somebody made on purpose.
            throw new Error(`${root.ref} has more than ${maxFiles} media files. Scan a smaller folder, or raise the limit deliberately.`);
          }
          list = async () => walked.entries;
          fingerprint = identity.fingerprintLocal;
        }
        const report = await scanRoot({
          store,
          root,
          list,
          fingerprint,
          onProgress: (p) => { scanning.done = p.done; scanning.total = p.total; },
        });
        const applied = applyScan(store, report, { now });
        // Adopted and refreshed fingerprints are stored by applyScan; a
        // `same` reached through adoption carries its fingerprint too.
        store.save();
        const summary = {
          rootId,
          ref: root.ref,
          at: now(),
          text: describeScan(report),
          applied,
          review: {
            ambiguous: report.ambiguous,
            replaced: report.replaced,
          },
          missing: report.missing,
          errors: report.errors,
          // Items added without a duration — durations are probed by a client
          // that can decode (the renderer), then sent back through
          // applyItemUpdates.
          needsDuration: report.added.filter((entry) => !(entry.duration > 0)).map((entry) => entry.item),
        };
        lastScanReports[rootId] = summary;
        persistScanLog();
        return summary;
      } finally {
        scanning = null;
      }
    },

    // Writes item fields: accepted tagging suggestions, probed durations,
    // hand edits. Only known fields — ids, refs and fingerprints are identity
    // and are never set this way.
    applyItemUpdates({ updates }) {
      const allowed = new Set(['title', 'tags', 'facets', 'kind', 'series', 'rating', 'description', 'duration', 'provenance']);
      let changed = 0;
      (updates || []).forEach(({ id, fields }) => {
        if (!store.getItem(id) || !fields) return;
        const clean = {};
        Object.keys(fields).forEach((key) => { if (allowed.has(key)) clean[key] = fields[key]; });
        if (!Object.keys(clean).length) return;
        store.updateItem(id, clean);
        changed += 1;
      });
      if (changed) store.save();
      return { changed };
    },

    saveQuery({ id = null, name, where, order = 'series' }) {
      if (!name || !String(name).trim()) throw new Error('A saved query needs a name.');
      if (!where || typeof where !== 'object' || Array.isArray(where) || !Object.keys(where).length) {
        throw new Error('A saved query needs at least one condition.');
      }
      const saved = store.upsertQuery(id, { name: String(name).trim(), where, order, updatedAt: now() });
      store.save();
      return saved;
    },

    removeQuery({ id }) {
      const removed = store.removeQuery(id);
      if (removed) store.save();
      return { removed };
    },

    // A person's decision about a review entry from the last scan.
    //   ambiguous: { kind: 'ambiguous', ref, itemId }  — this file IS that item
    //   replaced:  { kind: 'replaced', itemId, keep }   — keep the old metadata
    //              for the new content, or catalogue the new content separately
    // Returns the items whose duration is now unknown or stale, for the caller
    // to probe exactly as it does after a scan.
    resolveReview({ rootId, kind, ref, itemId, keep = false, fingerprint = null }) {
      const report = lastScanReports[rootId];
      if (!report) throw new Error('There is no scan to review for that root.');
      const needsDuration = [];
      if (kind === 'ambiguous') {
        const entry = report.review.ambiguous.find((e) => e.ref === ref);
        if (!entry || !entry.items.includes(itemId)) throw new Error('That choice is not one the scan offered.');
        store.updateItem(itemId, { ref, movedAt: now() });
        report.review.ambiguous = report.review.ambiguous.filter((e) => e !== entry);
      } else if (kind === 'replaced') {
        const entry = report.review.replaced.find((e) => e.item === itemId);
        if (!entry) throw new Error('That item is not waiting for review.');
        if (keep) {
          // Same metadata, different bytes: a re-encode can change the length.
          store.updateItem(itemId, { fingerprint: entry.fingerprint || fingerprint });
          needsDuration.push(itemId);
        } else {
          // The old item keeps its metadata but no longer claims this file
          // (`detached`, so scans stop matching it); the new content is
          // catalogued fresh with nothing inherited.
          store.updateItem(itemId, { detached: true, detachedAt: now() });
          const fresh = store.addItem({ ref: entry.ref, root: rootId, fingerprint: entry.fingerprint, duration: null, provenance: {} });
          needsDuration.push(fresh.id);
        }
        report.review.replaced = report.review.replaced.filter((e) => e !== entry);
      } else {
        throw new Error(`Unknown review kind "${kind}".`);
      }
      store.save();
      persistScanLog();
      return { remaining: report.review.ambiguous.length + report.review.replaced.length, needsDuration };
    },

    // Forgets a location. Items stay (store.removeRoot's own doc: a root is
    // often removed because a drive is unplugged, and dropping every item
    // would throw away tags and review decisions over that) — the caller
    // decides separately whether to also removeItem() each now-orphaned one.
    removeRoot({ id }) {
      if (!id) throw new Error('A location id is required.');
      const removed = store.removeRoot(id);
      if (removed) store.save();
      return { removed, orphaned: store.orphanedItems().length };
    },

    // Forgets one catalogue item and its tags/review history. Never touches
    // any channel's materialized `files` (C6) — a channel that already
    // played this item keeps its own path/duration entry exactly as it was;
    // only a later rematerialize (a previewed, undoable command) would stop
    // offering it as a candidate.
    removeItem({ id }) {
      if (!id) throw new Error('An item id is required.');
      const removed = store.removeItem(id);
      if (removed) store.save();
      return { removed };
    },

    // Applies a root move the renderer planned and previewed (root-move.js).
    moveRoot({ index }) {
      if (!index || !Array.isArray(index.roots)) throw new Error('A planned index is required.');
      const current = store.load();
      current.roots = index.roots;
      Object.values(index.items || {}).forEach((item) => {
        if (current.items[item.id]) store.updateItem(item.id, { ref: item.ref, fingerprint: item.fingerprint });
      });
      store.save();
      return store.stats();
    },
  };

  // The single entry point both transports use. `remote` is set by the LAN
  // route itself, never by the caller.
  async function call(method, payload = {}, { remote = false } = {}) {
    if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`Unknown library method "${method}".`);
    if (remote && !REMOTE_METHODS.has(method)) throw new Error('That library action can only be done on the host.');
    return api[method](payload || {});
  }

  return { call, api, store, REMOTE_METHODS };
}

// One IPC channel for the whole API. Errors travel back as { error } rather
// than as rejections, because Electron flattens a thrown Error to its message
// with an "Error invoking remote method" prefix the setup screen would show.
function registerLibraryIpc(ipcMain, { getService }) {
  ipcMain.handle('library:call', async (event, method, payload) => {
    try {
      return { ok: true, result: await getService().call(method, payload) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { createLibraryService, registerLibraryIpc, walkLocal, DEFAULT_MAX_SCAN_FILES, REMOTE_METHODS };
