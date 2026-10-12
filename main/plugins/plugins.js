// Plugin discovery + main-process plugin loading.
//
// A plugin is a folder under getPluginsDir() (userData/plugins/<id>/) with a
// manifest.json:
//   { "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
//     "description": "...", "style": "style.css", "renderer": "index.js",
//     "settings": "settings.js", "main": "main.js" }
// All four entry points are optional — a plugin can be pure CSS, runtime
// renderer UI, settings UI, main-process integration, or any mix.
//
// Trust model: by default, main.js plugin code runs via require() in the
// Electron main process — full Node/Electron access (ipcMain, child_process,
// fs, the works), same privilege level as the app's own code, no sandbox
// between plugins or between a plugin and the app (Phase 1 — a same-process
// capabilities check, buildCheckedCtx() below, not a hard boundary).
// manifest.json's "isolated": true (Phase 2, see the `isolated` field below
// and main-plugin-isolation.js) instead forks main.js into its own real OS
// process with Node's --experimental-permission flags actually enforcing
// what it declared — a genuine boundary, not just a same-process check. Only
// install plugins you trust regardless of which mode they use; see
// PLUGIN_DEVELOPMENT.md's "Trust model" section for the full picture.
const { app, ipcMain, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { activateIsolatedPlugin, callAnyService, claimServiceKey } = require('./isolation');
const { isPathContained } = require('../util/path-safety');
const { createLanAccess, isLanServiceEnabled } = require('../lan/security');
const {
  normalizeCapabilities, capabilitiesSignature, capabilityError, allowedSetsFor, resolveUserPaths,
  createCheckedSpawn, createCheckedServer, createCheckedFs,
} = require('./capabilities');
const { recordDiagnostic } = require('../diagnostics/diagnostics');
const { configHost } = require('../config/config');
const { getMainWindow } = require('../config/window-ref');
const { callMediaService } = require('../media/dispatch');

function getPluginsDir() {
  return path.join(app.getPath('userData'), 'plugins');
}

function ensurePluginsDir() {
  const dir = getPluginsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Plugins the app ships with itself (./plugins/<id>/, bundled the same way
// as main-*.js — included in electron-builder's `files`), as opposed to
// third-party plugins a user drops into userData/plugins/ by hand. App-owned
// copies are refreshed whenever their shipped source hash changes; an
// untracked folder that collides with a bundled id is adopted on the next
// start and synced to the shipped source (see the enrol branch in the seeding
// function below), so a copy that fell out of the ledger can't stay frozen. Local edits to an app-owned bundled copy survive ordinary
// restarts, but a later app update to that same plugin intentionally wins.
// In a packaged build, plugins/ is unpacked from the asar (package.json's
// asarUnpack — the seeding copy below uses fs.cpSync, which doesn't get
// Electron's usual transparent asar-read redirection the way readFile/
// readdir do), so __dirname still points inside the virtual app.asar/
// namespace even though the real files live at app.asar.unpacked/ on disk.
// Rewriting the path is the standard fix for exactly this Electron/asar
// mismatch. In dev (unpackaged), __dirname never contains '.asar' at all,
// so this is a no-op there.
const BUNDLED_PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins').replace('app.asar', 'app.asar.unpacked');

// Whether `id` ships with the app's own ./plugins/ folder (as opposed to a
// user-installed one, by hand or via INSTALL FROM ZIP) — used by the PLUGINS
// tab to decide whether FULLY UNINSTALL is offered at all. A bundled plugin
// can't actually be removed that way: seedBundledPlugins() above
// unconditionally re-copies any bundled folder that's missing from
// userData/plugins/ on every boot, so deleting one only for it to silently
// reappear (still enabled, still approved) would be confusing rather than
// destructive-but-honest. Disabling is the real "off switch" for those.
function isBundledPluginId(id) {
  try {
    return fs.statSync(path.join(BUNDLED_PLUGINS_DIR, id)).isDirectory();
  } catch (e) {
    return false;
  }
}

// Tracks which userData/plugins/<id> folders THIS mechanism installed, so a
// bundled plugin removed from a later build (e.g. the FOSS repo dropping a
// plugin from its own plugins/ folder) can be cleaned up automatically on
// the next boot — without ever touching a folder the user installed
// themselves (by hand or INSTALL FROM ZIP), which is never in this list
// regardless of whether its id happens to collide with a formerly-bundled
// one. A plain JSON file rather than a config field: this is loader
// bookkeeping, not user-facing config, and keeping it here means it doesn't
// need to coordinate with channels.json's own separate load/save timing.
// Read/write are both best-effort. A missing/corrupt ledger makes existing
// folders untracked and therefore preserves them; genuinely missing bundled
// folders can still be seeded safely on that boot.
// Plugins whose feature is now part of RerunTV itself. An installed copy is
// skipped by discoverPlugins() so it can't register the same IPC channels
// or show a second, older entry point in PLUG-INS.
const FOLDED_INTO_CORE = {
  'video-splicer': 'the Video Splicer is built in now (setup › LIBRARY › SPLICER).',
};
const reportedFoldedIntoCore = new Set();

function seededManifestPath() {
  return path.join(getPluginsDir(), '.bundled-manifest.json');
}
function loadSeededManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(seededManifestPath(), 'utf-8'));
    if (Array.isArray(parsed)) return new Map(parsed.map((id) => [id, null]));
    if (parsed && parsed.version === 2 && parsed.plugins && typeof parsed.plugins === 'object') {
      return new Map(Object.entries(parsed.plugins));
    }
    return new Map();
  } catch (e) {
    return new Map();
  }
}
function saveSeededManifest(entries) {
  try {
    const plugins = Object.fromEntries(Array.from(entries).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(seededManifestPath(), JSON.stringify({ version: 2, plugins }));
  } catch (e) { /* best-effort — worst case, next boot re-derives from scratch */ }
}

// Per-file content hash, cached on (mtime, size) so a discovery pass that
// finds nothing changed (the common case — boot, every PLUGINS-tab rescan,
// every LAN /api/plugins request) never re-reads file bytes it already
// hashed. Keyed on absolute path; the cache lives for the process lifetime
// since the plugin file set is small and stable.
const fileHashCache = new Map();
function hashFileCached(absolute) {
  const stat = fs.statSync(absolute);
  const cached = fileHashCache.get(absolute);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.hash;
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  fileHashCache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

function hashDirectory(dir) {
  const hash = crypto.createHash('sha256');
  function visit(current, relative = '') {
    fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const rel = path.join(relative, entry.name);
        hash.update(rel.replace(/\\/g, '/'));
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) visit(absolute, rel);
        else if (entry.isFile()) hash.update(hashFileCached(absolute));
      });
  }
  visit(dir);
  return hash.digest('hex');
}

// Integrity records live outside plugin folders so plugin code cannot edit
// its own expected hash. ZIP installs are recorded immediately after a
// successful extraction; manually copied plugins must be explicitly trusted
// once. A later byte change blocks main/renderer/CSS activation until the
// user reviews and trusts the new hash.
function integrityManifestPath() {
  return path.join(getPluginsDir(), '.plugin-integrity.json');
}
function loadIntegrityManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(integrityManifestPath(), 'utf-8'));
    return parsed && parsed.version === 1 && parsed.plugins && typeof parsed.plugins === 'object'
      ? parsed.plugins : {};
  } catch (e) { return {}; }
}
function saveIntegrityManifest(plugins) {
  fs.writeFileSync(integrityManifestPath(), JSON.stringify({ version: 1, plugins }, null, 2));
}
function recordPluginIntegrity(id, hash) {
  const plugins = loadIntegrityManifest();
  plugins[id] = { hash, trustedAt: new Date().toISOString() };
  saveIntegrityManifest(plugins);
}
function removePluginIntegrity(id) {
  const plugins = loadIntegrityManifest();
  if (plugins[id]) { delete plugins[id]; saveIntegrityManifest(plugins); }
}

// Refreshing an app-owned copy REPLACES it rather than copying over it.
// fs.cpSync only adds and overwrites; a file the bundled source no longer
// ships stays behind forever. That is not cosmetic: the leftover changes the
// installed folder's hash, so discoverPlugins() reads the copy as 'modified'
// and loadMainPlugins() then refuses to activate it until the user approves
// an integrity change they never made. Found exactly that way — the
// ffmpeg-transcode plugin's settings UI was split out of a renderer.js that
// the bundled source stopped shipping, the orphan survived the update, and
// the plugin every ffmpeg feature depends on (codec fix, caption extraction,
// thumbnail capture, recording) silently stopped loading.
//
// Removing the old copy first is an OPTIMISATION for clearing orphans, not a
// requirement, and it must never be load-bearing: fs.rmSync on Windows
// throws whenever anything in the tree is still open, which for a folder the
// app itself just loaded from is entirely possible. So a failed removal
// falls back to the overwrite-in-place this used to do — the orphan survives
// another boot, which is the old behaviour and survivable, rather than the
// removal taking the whole app down with it.
function replaceBundledCopy(sourceDir, destDir) {
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
  } catch (e) {
    recordDiagnostic('plugin-loader', 'log', `Could not clear ${path.basename(destDir)} before refreshing it; overwriting in place instead (${e.message})`);
  }
  fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
}

function seedBundledPlugins() {
  let folders;
  try {
    folders = fs.readdirSync(BUNDLED_PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return; // no bundled plugins directory (e.g. stripped from a custom build)
  }
  const dest = ensurePluginsDir();
  const bundledIds = new Set(folders.map((f) => f.name));
  const seeded = loadSeededManifest();

  for (const folder of folders) {
    // Per plugin, so one unwritable or locked folder costs that plugin's
    // refresh rather than the app's boot. This runs before any window
    // exists, inside the startup promise, so an escaping throw here is not a
    // visible error — it is an app that simply never appears.
    try {
      seedOneBundledPlugin(folder.name, dest, seeded);
    } catch (e) {
      recordDiagnostic('plugin-loader', 'error', `Could not seed bundled plugin ${folder.name}: ${e.message}`);
    }
  }

  // A previously-seeded id whose bundled source no longer exists — remove
  // the stale installed copy. Only ever acts on ids THIS mechanism added to
  // the manifest; a third-party plugin's id is never in it, so it's never a
  // candidate here no matter what. This only catches removals going
  // forward, from whatever this manifest already knew about — a folder that
  // was already stale before this tracking existed isn't retroactively
  // identified (no history to check it against), and needs a one-time
  // manual cleanup the same way it always did.
  for (const id of Array.from(seeded.keys())) {
    if (bundledIds.has(id)) continue;
    try { fs.rmSync(path.join(dest, id), { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    seeded.delete(id);
  }

  try {
    saveSeededManifest(seeded);
  } catch (e) {
    recordDiagnostic('plugin-loader', 'error', `Could not save the bundled-plugin ledger: ${e.message}`);
  }
}

// One bundled plugin's copy brought up to date. Split out so the caller can
// contain a failure to this plugin instead of the whole seeding pass.
function seedOneBundledPlugin(name, dest, seeded) {
  const sourceDir = path.join(BUNDLED_PLUGINS_DIR, name);
  const destDir = path.join(dest, name);
  const sourceHash = hashDirectory(sourceDir);
  if (!fs.existsSync(destDir)) {
    fs.cpSync(sourceDir, destDir, { recursive: true });
    seeded.set(name, sourceHash);
  } else if (seeded.has(name)) {
    // A null hash is the old v1 array ledger: refresh once while upgrading
    // it so existing installs receive newly added settings/runtime files.
    if (seeded.get(name) !== sourceHash) replaceBundledCopy(sourceDir, destDir);
    seeded.set(name, sourceHash);
  } else {
    // destDir already exists but was never enrolled in this ledger — e.g.
    // it was placed there before this tracking existed, or by some path
    // other than this function's own !existsSync branch above. Without
    // this branch such a folder is permanently invisible to the refresh
    // check above (which requires seeded.has() first) and silently never
    // receives any bundled-source update again, no matter how the repo's
    // copy changes. Found live: gdrive-media-source's installed copy sat
    // frozen since its first install, missing a manifest capability
    // (system/shell.openExternal) the repo copy later added for its own
    // SIGN IN button, which made every sign-in attempt fail with a
    // capability-denied error and no obvious cause. Enroll it now and
    // sync it to match the bundled source immediately, same as any other
    // first-party plugin under a bundled id is expected to track.
    replaceBundledCopy(sourceDir, destDir);
    seeded.set(name, sourceHash);
  }
}

// Capability normalization/signing (normalizeCapabilities, used below, and
// capabilitiesSignature, used by main.js/loadMainPlugins()) now live in
// main-plugin-capabilities.js alongside the rest of the capability-checking
// logic — see that file's header comment for why it's a separate module.

// Reads every <pluginsDir>/<folder>/manifest.json, returning {id, name,
// version, description, style, renderer, settings, main, dir, error} per entry — a
// malformed manifest or duplicate id shows up as `error` rather than
// throwing, so one broken plugin folder can't take the rest down with it.
function isSafeDataDirName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function discoverPlugins() {
  const dir = ensurePluginsDir();
  const seen = new Set();
  const results = [];
  const integrityManifest = loadIntegrityManifest();
  const seededManifest = loadSeededManifest();
  let folders;
  try {
    folders = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return results;
  }
  for (const folder of folders) {
    const pluginDir = path.join(dir, folder.name);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (!manifest.id || typeof manifest.id !== 'string') {
        results.push({ dir: folder.name, error: 'manifest.json is missing a string "id".' });
        continue;
      }
      if (seen.has(manifest.id)) {
        results.push({ dir: folder.name, error: `Duplicate plugin id "${manifest.id}" (already loaded from another folder).` });
        continue;
      }
      seen.add(manifest.id);
      if (FOLDED_INTO_CORE[manifest.id]) {
        // Left on disk (it may hold the person's own edits) but never loaded:
        // core now owns its IPC channels and its data folder.
        if (!reportedFoldedIntoCore.has(manifest.id)) {
          reportedFoldedIntoCore.add(manifest.id);
          recordDiagnostic('plugin-loader', 'log', `Skipped the old ${manifest.name || manifest.id} plugin: ${FOLDED_INTO_CORE[manifest.id]}`);
        }
        continue;
      }
      // A matching source id alone is not ownership: an untracked folder may
      // intentionally collide with a bundled id and seedBundledPlugins()
      // promises not to adopt it. Only the external seeding ledger proves
      // this installed copy is app-owned.
      const bundled = isBundledPluginId(manifest.id) && seededManifest.has(folder.name);
      const integrityHash = hashDirectory(pluginDir);
      const integrityRecord = integrityManifest[manifest.id];
      const bundledSourceMatches = bundled && seededManifest.get(folder.name) === integrityHash;
      const integrityStatus = bundledSourceMatches ? 'bundled'
        : integrityRecord && integrityRecord.hash === integrityHash ? 'verified'
          : bundled || integrityRecord ? 'modified' : 'unverified';
      results.push({
        id: manifest.id,
        name: manifest.name || manifest.id,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        // Optional one-line version of description for the plugin list.
        summary: typeof manifest.summary === 'string' ? manifest.summary : '',
        // Optional grouping hint for the PLUGINS tab UI — one of
        // 'channel'/'onscreen'/'system'. Purely cosmetic (no behavior keys
        // off it), so an unset or unrecognized value just falls into an
        // "OTHER" bucket in the UI rather than erroring — a third-party
        // plugin author doesn't have to know this taxonomy for their
        // plugin to work correctly, only to be grouped less precisely.
        category: typeof manifest.category === 'string' ? manifest.category : null,
        style: manifest.style || null,
        renderer: manifest.renderer || null,
        settings: manifest.settings || null,
        main: manifest.main || null,
        dependsOn: Array.isArray(manifest.dependsOn) ? manifest.dependsOn : [],
        // A root-level userData/ folder this plugin owns beyond its own
        // plugins/<id>/ folder (a download cache, guest uploads, …) — see
        // pluginDeclaredDataDirs() in main-config.js, which reads this same
        // field to carry the folder along during the portable-userData
        // migration.
        // A single plain folder name under userData; anything else (separators,
        // "..", absolute paths) is dropped so it can never aim outside it.
        dataDir: typeof manifest.dataDir === 'string' && isSafeDataDirName(manifest.dataDir) ? manifest.dataDir : null,
        userPaths: typeof manifest.userPaths === 'string' ? manifest.userPaths : null,
        // What this plugin's main.js declares it needs to touch — enforced
        // by buildCheckedCtx() below, and shown to the user as an approval
        // prompt (setup-plugins.js) before a NEW or CHANGED capabilities
        // set is allowed to activate. Every entry needs a human-readable
        // `why` so the approval prompt means something. Malformed/missing
        // capabilities normalizes to "declares nothing" (an empty object)
        // rather than erroring the whole manifest — a plugin with no
        // capabilities block just can't do anything requiring one.
        capabilities: normalizeCapabilities(manifest.capabilities),
        // Phase 2 sandboxing :
        // a plugin whose manifest sets "isolated": true runs its main.js in
        // its own forked OS process (main-plugin-isolation.js) instead of
        // require()d straight into this one — see loadMainPlugins() below.
        // Purely additive: a plugin with no "isolated" field (or any
        // non-`true` value) keeps running exactly the Phase 1 same-process
        // buildCheckedCtx() path, unchanged.
        isolated: manifest.isolated === true,
        // See isBundledPluginId() above — gates whether the PLUGINS tab
        // offers FULLY UNINSTALL (bundled plugins would just come back).
        bundled,
        integrityHash,
        integrityStatus,
        dir: folder.name,
      });
    } catch (e) {
      results.push({ dir: folder.name, error: `Couldn't parse manifest.json: ${e.message}` });
    }
  }
  return results;
}

// A plugin can declare manifest `"dependsOn": ["other-plugin-id"]` to be
// activated after the plugins it depends on — e.g. an audio-piping channel
// plugin depending on ffmpeg-transcode having already published
// ctx.services.ffmpegPath by the time they run. Stable Kahn's-algorithm-style
// pass: repeatedly peel off any not-yet-placed plugin whose deps are all
// already placed. A plugin with a missing/disabled/circular dependency is
// still appended at the end (rather than dropped) so its own activate()
// gets a chance to run and surface a clear error, instead of it silently
// vanishing from the list.
function orderByDependencies(plugins) {
  const placed = new Set();
  const ordered = [];
  let remaining = plugins.slice();
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    remaining = remaining.filter((plugin) => {
      if (plugin.dependsOn.every((depId) => placed.has(depId))) {
        ordered.push(plugin);
        placed.add(plugin.id);
        progress = true;
        return false;
      }
      return true;
    });
  }
  ordered.push(...remaining);
  return ordered;
}

// Wraps the ipcMain/spawn/http/fs surface a plugin's activate(ctx) receives
// with versions that check every call against that plugin's own declared
// `capabilities` (manifest.json) before letting it through — an
// undeclared channel/binary/port throws immediately, caught by
// loadMainPlugins() the same way any other activate()-time error is (that
// one plugin fails to load, everything else is unaffected). This is a
// same-process check, not a hard OS security boundary — a plugin could
// still `require('fs')`/`require('child_process')` directly instead of
// using ctx and bypass it entirely. What it DOES give: every first-party
// plugin converted to use ctx.fs/ctx.spawn/ctx.createServer/ctx.ipcMain
// (rather than requiring those modules itself) can no longer touch
// anything it didn't declare by accident, and the declaration itself is
// what the approval prompt (setup-plugins.js) shows the user before a new
// or changed capability set is allowed to activate at all.
function buildCheckedCtx(baseCtx, manifest, pluginDir) {
  const { allowedIpc, allowedSpawn, allowedPorts } = allowedSetsFor(manifest.capabilities);
  const dataDir = typeof manifest.dataDir === 'string' && isSafeDataDirName(manifest.dataDir)
    ? path.join(baseCtx.app.getPath('userData'), manifest.dataDir) : null;
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const userDirs = resolveUserPaths(manifest, baseCtx);

  // The only piece NOT shared with plugin-isolation-runtime.js's buildCtx()
  // (see main-plugin-capabilities.js's header comment) — this same-process
  // path calls the real ipcMain directly, where an isolated plugin instead
  // proxies IPC registration over RPC to the host.
  const checkedIpcMain = {
    handle: (channel, fn) => {
      if (!allowedIpc.has(channel)) throw capabilityError(manifest.id, 'register IPC channel', channel, 'ipc');
      recordDiagnostic('plugin-capability', 'log', `${manifest.id} registered declared IPC handler ${channel}`);
      return ipcMain.handle(channel, fn);
    },
    on: (channel, fn) => {
      if (!allowedIpc.has(channel)) throw capabilityError(manifest.id, 'register IPC channel', channel, 'ipc');
      recordDiagnostic('plugin-capability', 'log', `${manifest.id} registered declared IPC listener ${channel}`);
      return ipcMain.on(channel, fn);
    },
  };

  // ctx.services itself (not just ctx.registerService) has to be gated — a
  // plugin's own convention (e.g. ffmpeg-transcode) is to publish with a
  // plain `ctx.services.ffmpegPath = ...` property assignment, which
  // bypasses registerService() entirely on the non-isolated path. Wrapping
  // the shared object in a Proxy per plugin, same idea as the isolated
  // runtime's own services Proxy (plugin-isolation-runtime.js), closes that
  // for direct assignment too while still reading/writing through to the
  // one real shared object every other consumer (main.js, media-dispatch)
  // already holds a direct reference to.
  const checkedServices = new Proxy(baseCtx.services, {
    set(target, prop, value) {
      if (!claimServiceKey(manifest.id, prop)) {
        recordDiagnostic('plugin-capability', 'error', `Plugin "${manifest.id}" tried to publish services key "${String(prop)}", already owned by another plugin — write ignored.`);
        return true;
      }
      target[prop] = value;
      return true;
    },
  });

  // Keep renderer notifications identical in both plugin modes. Isolated
  // plugins get this helper through the RPC bridge; same-process plugins
  // should not have to branch on execution mode or reach through the raw
  // BrowserWindow just to publish a status update.
  const sendToMainWindow = (channel, data) => {
    const mainWindow = typeof baseCtx.getMainWindow === 'function'
      ? baseCtx.getMainWindow()
      : null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  return {
    ...baseCtx, pluginDir,
    ipcMain: checkedIpcMain,
    spawn: createCheckedSpawn(manifest.id, allowedSpawn),
    createServer: createCheckedServer(manifest.id, allowedPorts),
    fs: createCheckedFs(manifest.id, dataDir, userDirs),
    createLanAccess,
    isLanServiceEnabled,
    sendToMainWindow,
    services: checkedServices,
    // Symmetric with the isolated runtime's ctx.registerService/callService
    // (plugin-isolation-runtime.js) — same shared baseCtx.services object
    // and the same cross-process-aware resolution (callAnyService,
    // main-plugin-isolation.js), so a plugin author (e.g. a media-source
    // provider) writes identical activate(ctx) code whether or not its
    // manifest sets "isolated": true.
    registerService: (key, fn) => { checkedServices[key] = fn; },
    callService: (key, ...args) => callAnyService(baseCtx.services, key, args),
  };
}

// Runs every discovered plugin's main.js (if present, not disabled, and
// already approved for its current declared capabilities — see
// capabilitiesSignature(), main-plugin-capabilities.js) via require(),
// calling its exported activate(ctx) if the module provides one. A throw
// during require() or
// activate() is caught and attached to that plugin's entry (surfaced in
// the PLUGINS setup panel) rather than crashing boot — one bad plugin
// shouldn't take the whole app down.
// `approvedSignatures` is `config.plugins.approvedCapabilities`
// ({id: signature}, see main.js) — a plugin whose current manifest
// capabilities don't match what's there is skipped (not activated) and
// returned in `needsApproval` instead, same "restart to activate" flow as
// a fresh install already uses (see setup-plugins.js).
// `extraCtx` is merged into every plugin's activate(ctx) alongside the
// standard {ipcMain, app, pluginDir} — e.g. { fetchJsonCached } so plugins
// that fetch external JSON APIs share the same disk cache/timeout/offline-
// fallback behavior as the app's own former TMDB/NOAA integrations, without
// each plugin needing a fragile relative require() across the app root.
// extraCtx.services is expected to be a single shared plain object passed by
// reference — a plugin can publish a capability onto it (e.g.
// `ctx.services.ffmpegPath = ...`) for a later-activated dependent plugin
// (or core, after loadMainPlugins() returns) to read.
// Async because an isolated plugin (see the `isolated` field above) has to
// actually fork a real OS process and wait for it to finish activate() —
// that can't be synchronous the way require()+activate() for a same-process
// plugin is. Activation still runs strictly one plugin at a time, in
// dependency order (awaited in the loop below, not fired off in parallel) —
// this is deliberate, not just the easiest way to write it: it's what makes
// the "a publisher always finishes activating before a dependent reader
// starts" guarantee ctx.services (and an isolated plugin's servicesSnapshot,
// see main-plugin-isolation.js) relies on still hold exactly as it did in
// Phase 1's synchronous loop.
async function loadMainPlugins(disabledIds, extraCtx, approvedSignatures) {
  const disabled = new Set(disabledIds || []);
  const approved = approvedSignatures || {};
  // Read once and reused for both this function's own filtered list and
  // the full list handed back to the caller — registerFallbackHandlers()
  // (main.js) used to independently call discoverPlugins() again right
  // after this returns, meaning every boot re-read + re-parsed every
  // plugin's manifest.json a second time for no reason.
  const allPlugins = discoverPlugins();
  const plugins = orderByDependencies(allPlugins.filter((plugin) => !plugin.error && plugin.main && !disabled.has(plugin.id)));
  const loadErrors = {};
  const needsApproval = [];
  const needsIntegrityApproval = [];
  // providerId -> pluginId, for every mediaSource capability entry belonging
  // to a plugin that actually activated (not skipped for approval, not
  // errored) — main-media-dispatch.js's dispatch layer checks a
  // `mediasource:<providerId>:...` ref's providerId against this before
  // ever calling into it, so a malformed/spoofed ref in a hand-edited
  // config can't probe for providers that were never actually declared and
  // approved (defense in depth — see main-plugin-capabilities.js's
  // mediaSource doc comment for the full rationale).
  const activatedMediaSourceProviders = {};
  // Every port a successfully activated plugin declared in its manifest's
  // capabilities.net (the same list the approval prompt already showed the
  // user, with the "why" for each) — collected so main.js can build the
  // renderer's media-src CSP allowance dynamically instead of the static
  // meta-tag port list this used to require hand-maintaining (see
  // index.html's CSP comment and main-protocol.js's setAllowedMediaSrcPorts).
  const activatedNetPorts = [];
  const baseCtx = { ipcMain, app, shell, desktopCapturer, ...extraCtx };
  // plugins.js is now main/plugins/plugins.js.  Isolated workers need the
  // application root in their read permission set so Node can resolve the
  // app's bundled dependencies from node_modules; main/ alone is too narrow
  // and makes the worker exit before activate() can report a useful error.
  const appRootDir = path.join(__dirname, '..', '..');
  for (const plugin of plugins) {
    if (plugin.integrityStatus === 'unverified' || plugin.integrityStatus === 'modified') {
      needsIntegrityApproval.push(plugin.id);
      continue; // eslint-disable-line no-continue
    }
    const signature = capabilitiesSignature(plugin.capabilities);
    const hasAnyCapability = plugin.capabilities.ipc.length || plugin.capabilities.spawn.length
      || plugin.capabilities.net.length || plugin.capabilities.mediaSource.length
      || (plugin.capabilities.system && plugin.capabilities.system.length);
    if (hasAnyCapability && approved[plugin.id] !== signature) {
      needsApproval.push(plugin.id);
      continue; // eslint-disable-line no-continue
    }
    const pluginDir = path.join(getPluginsDir(), plugin.dir);
    let activated = false;
    if (plugin.isolated) {
      // eslint-disable-next-line no-await-in-loop
      const result = await activateIsolatedPlugin(plugin, pluginDir, baseCtx, extraCtx.services, appRootDir);
      if (!result.ok) loadErrors[plugin.id] = result.error;
      else activated = true;
    } else {
      const mainPath = path.join(pluginDir, plugin.main);
      try {
        // eslint-disable-next-line import/no-dynamic-require, global-require
        const mod = require(mainPath);
        if (mod && typeof mod.activate === 'function') {
          const activation = mod.activate(buildCheckedCtx(baseCtx, plugin, pluginDir));
          if (activation && typeof activation.catch === 'function') {
            activation.catch((err) => { loadErrors[plugin.id] = err && err.message ? err.message : String(err); });
          }
        }
        activated = true;
      } catch (e) {
        loadErrors[plugin.id] = e.message;
      }
    }
    if (activated) {
      recordDiagnostic('plugin-loader', 'log', `Activated ${plugin.id}`, { isolated: !!plugin.isolated });
      (plugin.capabilities.mediaSource || []).forEach((e) => { activatedMediaSourceProviders[e.providerId] = plugin.id; });
      (plugin.capabilities.net || []).forEach((e) => { activatedNetPorts.push(e.port); });
    }
  }
  return {
    loadErrors, needsApproval, needsIntegrityApproval, allPlugins, activatedMediaSourceProviders, activatedNetPorts,
  };
}

// Installs a plugin from a .zip a user picked (PLUGINS tab "INSTALL FROM
// ZIP…" button, see setup-plugins.js). Two shapes are accepted: manifest.json
// right at the zip's root, or nested one level inside a single top-level
// folder (the common case when a zip tool preserves the source folder name,
// e.g. "my-plugin/manifest.json") — auto-detected rather than requiring the
// user to know which their zip tool produced. The install target is always
// named after manifest.json's own `id`, not the zip's filename or internal
// folder name, so re-zipping the same plugin under a different name doesn't
// create a duplicate install.
// Finds manifest.json either at the archive root or exactly one level deep
// inside a single top-level folder — returns the entry-name prefix to strip
// off every extracted path ('' for root, 'dir/' for one level deep), or null
// if neither shape matches (multiple top-level folders, no manifest at all —
// too ambiguous to auto-detect).
function findManifestPrefix(entries) {
  const rootManifest = entries.find((e) => !e.isDirectory && e.entryName === 'manifest.json');
  if (rootManifest) return '';
  const topDirs = new Set();
  entries.forEach((e) => {
    const firstSlash = e.entryName.indexOf('/');
    if (firstSlash > 0) topDirs.add(e.entryName.slice(0, firstSlash));
  });
  if (topDirs.size === 1) {
    const dir = [...topDirs][0];
    const nested = entries.find((e) => !e.isDirectory && e.entryName === `${dir}/manifest.json`);
    if (nested) return `${dir}/`;
  }
  return null;
}

function installPluginFromZip(zipPath, opts) {
  opts = opts || {};
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    return { success: false, error: `Couldn't open that file as a zip (${e.message}).` };
  }
  const entries = zip.getEntries();

  const sourcePrefix = findManifestPrefix(entries);
  if (sourcePrefix === null) {
    return { success: false, error: "Couldn't find manifest.json in that zip (checked the root and one folder deep)." };
  }

  let manifest;
  try {
    const manifestEntry = entries.find((e) => e.entryName === `${sourcePrefix}manifest.json`);
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  } catch (e) {
    return { success: false, error: `manifest.json in that zip isn't valid JSON (${e.message}).` };
  }
  if (!manifest.id || typeof manifest.id !== 'string') {
    return { success: false, error: 'manifest.json in that zip is missing a string "id".' };
  }

  const pluginsDir = ensurePluginsDir();
  const destDir = path.join(pluginsDir, manifest.id);
  // manifest.id becomes a directory name under the shared plugins folder — a
  // crafted id like "../../../../some/other/folder" must not be allowed to
  // point destDir (and the rmSync/mkdirSync/writeFileSync below) outside it.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id) || manifest.id.includes('..')
    || path.resolve(destDir) === path.resolve(pluginsDir) || !isPathContained(pluginsDir, destDir)) {
    return { success: false, error: 'manifest.json "id" must not contain path separators or ".." segments.' };
  }
  if (fs.existsSync(destDir) && !opts.overwrite) {
    return { success: false, alreadyExists: true, id: manifest.id, name: manifest.name || manifest.id };
  }

  // The approval signature covers declared capabilities only. A re-install that
  // flips isolation or widens dataDir/userPaths changes what the plugin may touch
  // without changing that signature, so note it and make the caller revoke approval.
  const sandboxShape = (m) => JSON.stringify([!!(m && m.isolated), (m && m.dataDir) || null, (m && m.userPaths) || null]);
  let shapeChanged = false;
  try {
    const oldManifest = JSON.parse(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf-8'));
    shapeChanged = sandboxShape(oldManifest) !== sandboxShape(manifest);
  } catch (e) { /* no previous install to compare */ }

  try {
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    entries.forEach((entry) => {
      if (entry.isDirectory || !entry.entryName.startsWith(sourcePrefix)) return;
      const rel = entry.entryName.slice(sourcePrefix.length);
      if (!rel) return;
      const outPath = path.join(destDir, rel);
      // Same containment check used throughout this app's own extraction/
      // path-serving code — a malicious zip entry name containing ../ must
      // never be allowed to write outside destDir.
      if (!isPathContained(destDir, outPath)) {
        throw new Error(`Refusing to extract "${entry.entryName}" — path escapes the plugin folder.`);
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, entry.getData());
    });
    recordPluginIntegrity(manifest.id, hashDirectory(destDir));
  } catch (e) {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (e2) { /* best-effort cleanup of a partial extract */ }
    return { success: false, error: `Extraction failed (${e.message}).` };
  }

  return { success: true, id: manifest.id, name: manifest.name || manifest.id, shapeChanged };
}

// Permanently deletes a plugin's own folder under userData/plugins/ — the
// PLUGINS tab's FULLY UNINSTALL action (setup-plugins.js), distinct from
// disabling (which keeps the files, just skips activation). Refuses a
// bundled plugin outright rather than deleting and having it silently
// reappear on the next boot (see isBundledPluginId() above) — the renderer
// already hides the button for those, but the main process re-checks here
// too since this is a destructive filesystem operation that shouldn't trust
// the caller alone.
function uninstallPlugin(id) {
  const plugin = discoverPlugins().find((x) => x.id === id || (x.error && x.dir === id));
  if (!plugin) return { success: false, error: `Plugin "${id}" not found.` };
  if (!plugin.dir || /[\/]/.test(plugin.dir) || plugin.dir === '.' || plugin.dir === '..') return { success: false, error: `Plugin "${id}" not found.` };
  if (plugin.bundled || isBundledPluginId(plugin.id || plugin.dir) || isBundledPluginId(plugin.dir)) return { success: false, error: `"${plugin.name || plugin.dir}" ships with the app and can't be fully uninstalled — disable it instead.` };
  const pluginDir = path.join(getPluginsDir(), plugin.dir);
  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    removePluginIntegrity(id);
  } catch (e) {
    return { success: false, error: `Couldn't remove the plugin folder (${e.message}).` };
  }
  return { success: true, id, name: plugin.name };
}

// A plugin whose main.js is NOT active (disabled, missing, or its own
// manifest/require failed) still gets a chance to register safe fallback
// IPC handlers for whatever channels its renderer side calls unconditionally
// — e.g. a music-channel plugin inactive still needs its own
// getStreamUrl-style channel to resolve to '' rather than reject with a raw
// "no handler registered" error. A plugin opts in by exporting
// `registerFallback(ipcMain)` alongside `activate(ctx)` — this generalizes
// what used to be a single hardcoded core function naming each plugin that
// needed one and its exact channels/fallback values by hand, into something
// any plugin (first- or third-party) can join without a core code change.
//
// Deliberately does NOT call activate() here — an inactive plugin should
// stay fully inert (no server started, no process spawned); require()ing
// its main.js only to read registerFallback is safe under the same
// "side effects live in activate(), not at module scope" convention every
// plugin's main.js is already expected to follow (see
// PLUGIN_DEVELOPMENT.md). A plugin with no registerFallback export, or
// whose main.js fails to even require(), is silently skipped — its
// renderer-side calls will simply reject with the default "no handler"
// error, same as before this mechanism existed for it.
// `inactiveIds` covers both disabled plugins and ones pending a capabilities
// approval prompt (loadMainPlugins()'s `needsApproval`, see main.js) — both
// need the same safe fallback while they're not actually running.
// `plugins` is optional — pass loadMainPlugins()'s own returned `allPlugins`
// (it already did the discoverPlugins() scan this boot) to skip a redundant
// re-scan/re-parse of every manifest.json; omit it to have this do its own
// discoverPlugins() call, e.g. if this is ever invoked standalone.
function registerFallbackHandlers(inactiveIds, ipcMain, plugins) {
  const inactive = new Set(inactiveIds || []);
  // A plugin whose activate() threw may already own some of its channels;
  // registering a second handler for one of those throws, which would skip every
  // channel after it. Each registration is tried on its own instead.
  const tolerantIpc = {
    handle: (channel, fn) => { try { ipcMain.handle(channel, fn); } catch (e) { /* already registered */ } },
    handleOnce: (channel, fn) => { try { ipcMain.handleOnce(channel, fn); } catch (e) { /* already registered */ } },
    on: (...a) => ipcMain.on(...a),
    once: (...a) => ipcMain.once(...a),
    removeHandler: (...a) => ipcMain.removeHandler(...a),
    removeListener: (...a) => ipcMain.removeListener(...a),
  };
  (plugins || discoverPlugins()).forEach((plugin) => {
    if (plugin.error || !plugin.main) return;
    if (!inactive.has(plugin.id)) return; // active plugins register their own real handlers via activate()
    try {
      const mod = require(path.join(getPluginsDir(), plugin.dir, plugin.main));
      if (mod && typeof mod.registerFallback === 'function') mod.registerFallback(tolerantIpc);
    } catch (e) {
      // Broken plugin main.js — main-plugins.js's own loadMainPlugins() (for
      // active plugins) already surfaces load errors in the PLUGINS tab;
      // an inactive/disabled one failing to even require() here just means
      // no fallback for it, not a crash.
    }
  });
}

// `deps` carries accessors (not raw values) for everything main.js populates
// inside app.whenReady() AFTER this is called — pluginMainLoadErrors,
// pluginsNeedingApproval, activatedMediaSourceProviders, and pluginServicesRef
// are all `let`s in main.js reassigned once loadMainPlugins() itself resolves,
// so capturing their current (still-initial) value here instead of a getter
// would silently freeze every one of these handlers on stale boot-time data.
function registerPluginsIpc(ipcMain, deps) {
  const {
    getPluginMainLoadErrors, getPluginsNeedingApproval, getActivatedMediaSourceProviders, getPluginServicesRef,
  } = deps;

  // See this file's own header comment for the discovery/loading model, the
  // declared-capabilities check (buildCheckedCtx above) a plugin's fs/spawn/
  // http/ipcMain access is run through, and the trust-model note (this is a
  // same-process check, not a hard sandbox — see that comment for why).
  // Enabling/disabling here only edits config.plugins.disabled — actually
  // starting/stopping a main-process plugin's activate() side effects
  // (spawned processes, registered ipcMain handlers) requires a restart,
  // which the PLUGINS setup panel says explicitly.
  ipcMain.handle('plugins:list', async () => {
    const pluginMainLoadErrors = getPluginMainLoadErrors();
    const pluginsNeedingApproval = getPluginsNeedingApproval();
    return discoverPlugins().map((p) => (
      p.error ? p : {
        ...p,
        loadError: pluginMainLoadErrors[p.id] || null,
        needsApproval: pluginsNeedingApproval.includes(p.id),
        needsIntegrityApproval: p.integrityStatus === 'unverified' || p.integrityStatus === 'modified',
      }
    ));
  });

  // Generic passthrough to any of a media-source provider's own registered
  // EXTRA service verbs — pickFolder, getFetchProgress, getLocalCachePath,
  // getDisplayName, and any plugin-invented verb (configure/signIn/status/
  // listFolders/...), reached from setup-channels.js's CHOOSE SOURCE flow and
  // a plugin's own settings-panel renderer.js. Gated by callMediaService's
  // own assertKnownProvider check, same defense-in-depth as every other
  // media-source dispatch call — but that alone isn't enough here: the four
  // RESERVED core verbs (list/probe/readRange/checkAvailable) must stay
  // unreachable through this generic door. In particular, readRange is only
  // ever meant to be called by serveFileViaPlugin (main-protocol.js), which
  // wraps it in a chunk-size cap specifically because an uncapped Range
  // crossing the plugin-process RPC boundary risks a multi-gigabyte
  // structured-clone payload — calling it directly through this passthrough
  // would bypass that cap entirely (found in review, never actually
  // exploited, but a real gap: nothing else in the dispatch chain enforces
  // the cap, only this call site's own choice of arguments does).
  const RESERVED_MEDIA_SOURCE_VERBS = new Set(['list', 'probe', 'readRange', 'checkAvailable']);
  ipcMain.handle('mediaSource:callHook', async (event, providerId, verb, args) => {
    if (RESERVED_MEDIA_SOURCE_VERBS.has(verb)) {
      throw new Error(`"${verb}" is a reserved media-source verb and can't be called via mediaSource:callHook — it's only ever invoked internally by core's own dispatch layer.`);
    }
    recordDiagnostic('plugin-capability', 'log', `${providerId} called media-source hook ${verb}`);
    // Sign-in, folder pickers and collection scans wait on a person or a slow
    // provider, well past the 20s default RPC timeout.
    const SLOW_HOOKS = new Set(['signIn', 'configure', 'listFolders', 'pickFolder', 'scanCollection']);
    return callMediaService(getPluginServicesRef(), providerId, verb, args || [], SLOW_HOOKS.has(verb) ? 6 * 60 * 1000 : undefined);
  });

  // A filtered projection of the same discoverPlugins() data plugins:list
  // already exposes — no new discovery mechanism, just narrowed to
  // {providerId, displayName, pluginId} for every mediaSource capability
  // entry belonging to a plugin that's actually activated right now
  // (activatedMediaSourceProviders, populated once at boot — see
  // loadMainPlugins()'s doc comment above). A provider a plugin merely
  // *declares* but that's disabled/errored/awaiting approval doesn't show up
  // here — the CHANNELS tab's CHOOSE SOURCE picker (setup-channels.js) should
  // never offer something it can't actually call.
  ipcMain.handle('plugins:listMediaSourceProviders', async () => {
    const activatedMediaSourceProviders = getActivatedMediaSourceProviders();
    const providers = [];
    discoverPlugins().forEach((p) => {
      if (p.error || !p.capabilities || !p.capabilities.mediaSource) return;
      p.capabilities.mediaSource.forEach((entry) => {
        if (activatedMediaSourceProviders[entry.providerId] !== p.id) return;
        providers.push({ providerId: entry.providerId, displayName: entry.displayName || entry.providerId, pluginId: p.id });
      });
    });
    return providers;
  });

  // Persists the user's approval of exactly this plugin's *current* declared
  // capabilities (setup-plugins.js's approval prompt) — keyed by a signature
  // of the capabilities themselves (capabilitiesSignature, above), not just
  // the plugin id, so a later update that adds a new port/channel/binary
  // re-prompts instead of silently inheriting a stale approval. Takes effect
  // on next launch, same "restart to activate" convention as installing or
  // enabling a plugin already uses.
  // Applied as a host command (config-host.js), so a renderer save already
  // in flight can't revert it; the returned hostUpdate lets the renderer
  // apply the same change to its own copy straight away.
  ipcMain.handle('plugins:approveCapabilities', async (event, id, signature) => {
    // The renderer only names a plugin; what gets approved is computed here from
    // the plugin's own manifest, so a compromised or buggy caller can't approve
    // a capability set the user was never shown.
    const target = typeof id === 'string' ? discoverPlugins().find((p) => !p.error && p.id === id) : null;
    if (!target) return { ok: false, error: 'Unknown plugin.' };
    if (signature !== capabilitiesSignature(target.capabilities)) {
      return { ok: false, error: 'The permissions this plugin declares changed since they were shown — reopen the PLUGINS tab and review them again.' };
    }
    const hostUpdate = await configHost.applyCommands({ type: 'plugin.setApproval', id, signature }, { source: 'plugins' });
    return { ok: true, hostUpdate };
  });

  // The undo-approval counterpart to plugins:approveCapabilities above —
  // drops the stored signature so the plugin reverts to needing a fresh
  // approval (same inactive treatment as never having approved it at all, or
  // as being disabled) until re-approved. Also takes effect on next launch.
  ipcMain.handle('plugins:revokeCapabilities', async (event, id) => {
    const hostUpdate = await configHost.applyCommands({ type: 'plugin.setApproval', id, signature: null }, { source: 'plugins' });
    return { ok: true, hostUpdate };
  });

  ipcMain.handle('plugins:approveIntegrity', async (event, id, hash) => {
    const plugin = discoverPlugins().find((entry) => !entry.error && entry.id === id);
    if (!plugin || plugin.integrityHash !== hash) {
      throw new Error('Plugin files changed again before integrity approval could be saved.');
    }
    recordPluginIntegrity(id, hash);
    return true;
  });

  // Permanently deletes a plugin's own folder (setup-plugins.js's FULLY
  // UNINSTALL action, behind its own themed danger-confirm dialog since this
  // can't be undone) — see uninstallPlugin() above for why a bundled plugin
  // refuses this. Also clears any config.plugins state referencing the
  // now-gone id so a stale disabled/approved entry doesn't linger forever.
  ipcMain.handle('plugins:uninstall', async (event, id) => {
    const result = uninstallPlugin(id);
    if (result.success) {
      result.hostUpdate = await configHost.applyCommands({ type: 'plugin.forget', id }, { source: 'plugins' });
    }
    return result;
  });

  ipcMain.handle('plugins:openFolder', async () => {
    await shell.openPath(getPluginsDir());
    return true;
  });

  // opts: { zipPath, overwrite }. Without zipPath, opens the file picker
  // first (the normal first call from the renderer's INSTALL FROM ZIP…
  // button) — the response always echoes back whichever zipPath was used, so
  // if the result comes back { alreadyExists: true } the renderer can show
  // its own themed confirm dialog and call again with { zipPath, overwrite:
  // true } to actually overwrite, without re-prompting the file picker a
  // second time for the same file. Main-process code has no themed-dialog
  // access of its own, so the confirm step has to happen in the renderer.
  ipcMain.handle('plugins:installFromZip', async (event, opts) => {
    opts = opts || {};
    let zipPath = opts.zipPath;
    if (!zipPath) {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openFile'],
        filters: [{ name: 'Plugin (zip)', extensions: ['zip'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
      [zipPath] = result.filePaths;
    }
    const installed = installPluginFromZip(zipPath, { overwrite: opts.overwrite });
    if (installed.success && installed.shapeChanged) {
      installed.hostUpdate = await configHost.applyCommands({ type: 'plugin.setApproval', id: installed.id, signature: null }, { source: 'plugins' });
    }
    return { zipPath, ...installed };
  });

  ipcMain.handle('plugins:setEnabled', async (event, id, enabled) => {
    const hostUpdate = await configHost.applyCommands({ type: 'plugin.setEnabled', id, enabled: !!enabled }, { source: 'plugins' });
    return { ok: true, hostUpdate };
  });
}

module.exports = {
  getPluginsDir, ensurePluginsDir, discoverPlugins, loadMainPlugins, seedBundledPlugins, installPluginFromZip,
  uninstallPlugin, registerFallbackHandlers, recordPluginIntegrity, registerPluginsIpc,
};
