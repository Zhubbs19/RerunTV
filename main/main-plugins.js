// Plugin discovery + main-process plugin loading.
//
// A plugin is a folder under getPluginsDir() (userData/plugins/<id>/) with a
// manifest.json:
//   { "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
//     "description": "...", "style": "style.css", "renderer": "index.js",
//     "main": "main.js" }
// All three of style/renderer/main are optional — a plugin can be pure CSS,
// pure renderer UI, pure main-process integration, or any mix.
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
const { app, ipcMain, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { activateIsolatedPlugin } = require('./main-plugin-isolation');

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
// third-party plugins a user drops into userData/plugins/ by hand. Copied
// into userData/plugins/ once on first boot after they're introduced, same
// one-way "never overwrite" semantics as the userData migration copy in
// main.js — so a user who edits a bundled plugin's installed copy has that
// respected on every later boot, not stomped by a re-seed.
// In a packaged build, plugins/ is unpacked from the asar (package.json's
// asarUnpack — the seeding copy below uses fs.cpSync, which doesn't get
// Electron's usual transparent asar-read redirection the way readFile/
// readdir do), so __dirname still points inside the virtual app.asar/
// namespace even though the real files live at app.asar.unpacked/ on disk.
// Rewriting the path is the standard fix for exactly this Electron/asar
// mismatch. In dev (unpackaged), __dirname never contains '.asar' at all,
// so this is a no-op there.
const BUNDLED_PLUGINS_DIR = path.join(__dirname, '..', 'plugins').replace('app.asar', 'app.asar.unpacked');

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
// Read/write are both best-effort — a missing or corrupt manifest just means
// this boot treats every currently-bundled id as newly-seeded (see
// seedBundledPlugins() below), which only affects the auto-removal below,
// never the copy-in step.
function seededManifestPath() {
  return path.join(getPluginsDir(), '.bundled-manifest.json');
}
function loadSeededManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(seededManifestPath(), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
function saveSeededManifest(ids) {
  try {
    fs.writeFileSync(seededManifestPath(), JSON.stringify(ids.slice().sort()));
  } catch (e) { /* best-effort — worst case, next boot re-derives from scratch */ }
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
  const seeded = new Set(loadSeededManifest());

  for (const folder of folders) {
    const destDir = path.join(dest, folder.name);
    if (!fs.existsSync(destDir)) fs.cpSync(path.join(BUNDLED_PLUGINS_DIR, folder.name), destDir, { recursive: true });
    seeded.add(folder.name); // whether freshly copied or already present — either way it's bundled-sourced
  }

  // A previously-seeded id whose bundled source no longer exists — remove
  // the stale installed copy. Only ever acts on ids THIS mechanism added to
  // the manifest; a third-party plugin's id is never in it, so it's never a
  // candidate here no matter what. This only catches removals going
  // forward, from whatever this manifest already knew about — a folder that
  // was already stale before this tracking existed isn't retroactively
  // identified (no history to check it against), and needs a one-time
  // manual cleanup the same way it always did.
  for (const id of Array.from(seeded)) {
    if (bundledIds.has(id)) continue;
    try { fs.rmSync(path.join(dest, id), { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    seeded.delete(id);
  }

  saveSeededManifest(Array.from(seeded));
}

// Capabilities schema: manifest `"capabilities"` is an object with any of
// `ipc`/`spawn`/`net` (each an array of `{ <value-key>: "...", why: "..." }`)
// declaring exactly what a plugin's main.js needs to touch —
//   ipc:   [{ channel: "my-plugin:start", why: "..." }]     — an ipcMain.handle/.on channel name
//   spawn: [{ bin: "ffmpeg", why: "..." }]                  — a child-process executable, matched by basename
//   net:   [{ port: 8723, why: "..." }]                     — a port this plugin's own HTTP server binds
// A malformed entry (missing its value key or `why`) is dropped rather than
// erroring the whole manifest — same "degrade gracefully" spirit as every
// other optional manifest field. `dataDir` (see discoverPlugins() below) is
// what scopes file writes; it isn't part of this object since it already
// has its own top-level field.
function normalizeCapabilities(raw) {
  const caps = raw && typeof raw === 'object' ? raw : {};
  function normalizeList(list, valueKey) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e === 'object' && typeof e[valueKey] !== 'undefined' && typeof e.why === 'string' && e.why)
      .map((e) => ({ [valueKey]: e[valueKey], why: e.why }));
  }
  return {
    ipc: normalizeList(caps.ipc, 'channel'),
    spawn: normalizeList(caps.spawn, 'bin'),
    net: normalizeList(caps.net, 'port'),
  };
}

// A stable string identifying exactly what a plugin's manifest currently
// declares — compared against what the user has previously approved
// (config.plugins.approvedCapabilities, see main.js) to decide whether a
// fresh approval prompt is needed. Changes whenever the declared
// capabilities actually change (a plugin update adding a new port/channel/
// binary re-prompts), not on every boot.
function capabilitiesSignature(capabilities) {
  return JSON.stringify(capabilities || { ipc: [], spawn: [], net: [] });
}

// Reads every <pluginsDir>/<folder>/manifest.json, returning {id, name,
// version, description, style, renderer, main, dir, error} per entry — a
// malformed manifest or duplicate id shows up as `error` rather than
// throwing, so one broken plugin folder can't take the rest down with it.
function discoverPlugins() {
  const dir = ensurePluginsDir();
  const seen = new Set();
  const results = [];
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
      results.push({
        id: manifest.id,
        name: manifest.name || manifest.id,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        // Optional grouping hint for the PLUGINS tab UI — one of
        // 'channel'/'onscreen'/'system'. Purely cosmetic (no behavior keys
        // off it), so an unset or unrecognized value just falls into an
        // "OTHER" bucket in the UI rather than erroring — a third-party
        // plugin author doesn't have to know this taxonomy for their
        // plugin to work correctly, only to be grouped less precisely.
        category: typeof manifest.category === 'string' ? manifest.category : null,
        style: manifest.style || null,
        renderer: manifest.renderer || null,
        main: manifest.main || null,
        dependsOn: Array.isArray(manifest.dependsOn) ? manifest.dependsOn : [],
        // A root-level userData/ folder this plugin owns beyond its own
        // plugins/<id>/ folder (a download cache, guest uploads, …) — see
        // pluginDeclaredDataDirs() in main.js, which reads this same field
        // to carry the folder along during the portable-userData migration.
        dataDir: typeof manifest.dataDir === 'string' ? manifest.dataDir : null,
        // What this plugin's main.js declares it needs to touch — enforced
        // by buildCheckedCtx() below, and shown to the user as an approval
        // prompt (setup-plugins.js) before a NEW or CHANGED capabilities
        // set is allowed to activate. Every entry needs a human-readable
        // `why` so the approval prompt means something. Malformed/missing
        // capabilities normalizes to "declares nothing" (an empty object)
        // rather than erroring the whole manifest — a plugin with no
        // capabilities block just can't do anything requiring one.
        capabilities: normalizeCapabilities(manifest.capabilities),
        // Phase 2 sandboxing (see [[retro_cable_box_plugin_sandboxing_phase2]]):
        // a plugin whose manifest sets "isolated": true runs its main.js in
        // its own forked OS process (main-plugin-isolation.js) instead of
        // require()d straight into this one — see loadMainPlugins() below.
        // Purely additive: a plugin with no "isolated" field (or any
        // non-`true` value) keeps running exactly the Phase 1 same-process
        // buildCheckedCtx() path, unchanged.
        isolated: manifest.isolated === true,
        // See isBundledPluginId() above — gates whether the PLUGINS tab
        // offers FULLY UNINSTALL (bundled plugins would just come back).
        bundled: isBundledPluginId(manifest.id),
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
    remaining = remaining.filter((p) => {
      if (p.dependsOn.every((depId) => placed.has(depId))) {
        ordered.push(p);
        placed.add(p.id);
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
// Windows executables carry a .exe suffix a manifest author shouldn't have
// to declare twice (once for dev, once for a packaged Windows build) — a
// declared "ffmpeg" matches a spawned "ffmpeg.exe" and vice versa.
function stripExeSuffix(basename) {
  return basename.toLowerCase().endsWith('.exe') ? basename.slice(0, -4).toLowerCase() : basename.toLowerCase();
}

function buildCheckedCtx(baseCtx, manifest, pluginDir) {
  const caps = manifest.capabilities || { ipc: [], spawn: [], net: [] };
  const allowedIpc = new Set(caps.ipc.map((e) => e.channel));
  const allowedSpawn = new Set(caps.spawn.map((e) => stripExeSuffix(String(e.bin))));
  const allowedPorts = new Set(caps.net.map((e) => e.port));
  const dataDir = manifest.dataDir ? path.join(baseCtx.app.getPath('userData'), manifest.dataDir) : null;
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });

  function declareError(kind, value, field) {
    return new Error(`Plugin "${manifest.id}" tried to ${kind} "${value}" without declaring it in manifest.json's capabilities.${field} — add it there (with a "why") first.`);
  }

  const checkedIpcMain = {
    handle: (channel, fn) => {
      if (!allowedIpc.has(channel)) throw declareError('register IPC channel', channel, 'ipc');
      return ipcMain.handle(channel, fn);
    },
    on: (channel, fn) => {
      if (!allowedIpc.has(channel)) throw declareError('register IPC channel', channel, 'ipc');
      return ipcMain.on(channel, fn);
    },
  };

  function checkedSpawn(bin, args, opts) {
    const base = stripExeSuffix(path.basename(bin));
    if (!allowedSpawn.has(base)) throw declareError('spawn', bin, 'spawn');
    // eslint-disable-next-line global-require
    return require('child_process').spawn(bin, args, opts);
  }

  function checkedCreateServer(handler) {
    // eslint-disable-next-line global-require
    const server = require('http').createServer(handler);
    const realListen = server.listen.bind(server);
    server.listen = (port, ...rest) => {
      if (!allowedPorts.has(port)) throw declareError('listen on port', port, 'net');
      return realListen(port, ...rest);
    };
    return server;
  }

  function resolveDataPath(relPath) {
    if (!dataDir) throw new Error(`Plugin "${manifest.id}" has no "dataDir" declared in manifest.json — nowhere to write plugin data.`);
    const resolved = path.resolve(dataDir, relPath);
    if (resolved !== dataDir && !resolved.startsWith(dataDir + path.sep)) {
      throw new Error(`Plugin "${manifest.id}" tried to write outside its own data folder ("${relPath}").`);
    }
    return resolved;
  }
  // Reads are intentionally unrestricted (existsSync/readFile/readdirSync
  // take whatever path is passed) — checking whether a user-configured
  // executable exists (a plugin's own custom-binary-path setting) is a
  // legitimate need with no folder to scope it to in advance. Writes are
  // scoped to the plugin's own dataDir, rejecting any path that resolves
  // outside it (including via `..`).
  const checkedFs = {
    existsSync: (p) => fs.existsSync(p),
    readFile: (p, ...rest) => fs.readFile(p, ...rest),
    readFileSync: (p, ...rest) => fs.readFileSync(p, ...rest),
    readdirSync: (p, ...rest) => fs.readdirSync(p, ...rest),
    writeFile: (relPath, ...rest) => fs.writeFile(resolveDataPath(relPath), ...rest),
    writeFileSync: (relPath, ...rest) => fs.writeFileSync(resolveDataPath(relPath), ...rest),
    mkdirSync: (relPath, ...rest) => fs.mkdirSync(resolveDataPath(relPath), ...rest),
    createWriteStream: (relPath, ...rest) => fs.createWriteStream(resolveDataPath(relPath), ...rest),
    unlink: (relPath, ...rest) => fs.unlink(resolveDataPath(relPath), ...rest),
    dataDir,
  };

  return {
    ...baseCtx, pluginDir,
    ipcMain: checkedIpcMain, spawn: checkedSpawn, createServer: checkedCreateServer, fs: checkedFs,
  };
}

// Runs every discovered plugin's main.js (if present, not disabled, and
// already approved for its current declared capabilities — see
// capabilitiesSignature() above) via require(), calling its exported
// activate(ctx) if the module provides one. A throw during require() or
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
  const plugins = orderByDependencies(discoverPlugins().filter((p) => !p.error && p.main && !disabled.has(p.id)));
  const loadErrors = {};
  const needsApproval = [];
  const baseCtx = { ipcMain, app, shell, desktopCapturer, ...extraCtx };
  const appRootDir = path.join(__dirname, '..');
  for (const p of plugins) {
    const signature = capabilitiesSignature(p.capabilities);
    const hasAnyCapability = p.capabilities.ipc.length || p.capabilities.spawn.length || p.capabilities.net.length;
    if (hasAnyCapability && approved[p.id] !== signature) {
      needsApproval.push(p.id);
      continue; // eslint-disable-line no-continue
    }
    const pluginDir = path.join(getPluginsDir(), p.dir);
    if (p.isolated) {
      // eslint-disable-next-line no-await-in-loop
      const result = await activateIsolatedPlugin(p, pluginDir, baseCtx, extraCtx.services, appRootDir);
      if (!result.ok) loadErrors[p.id] = result.error;
      continue; // eslint-disable-line no-continue
    }
    const mainPath = path.join(pluginDir, p.main);
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(mainPath);
      if (mod && typeof mod.activate === 'function') {
        mod.activate(buildCheckedCtx(baseCtx, p, pluginDir));
      }
    } catch (e) {
      loadErrors[p.id] = e.message;
    }
  }
  return { loadErrors, needsApproval };
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
function installPluginFromZip(zipPath, opts) {
  opts = opts || {};
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    return { success: false, error: `Couldn't open that file as a zip (${e.message}).` };
  }
  const entries = zip.getEntries();

  // Find manifest.json either at the archive root or exactly one level deep
  // inside a single top-level folder — reject anything else (multiple
  // top-level folders, no manifest at all) as too ambiguous to auto-detect.
  let sourcePrefix = null;
  const rootManifest = entries.find((e) => !e.isDirectory && e.entryName === 'manifest.json');
  if (rootManifest) {
    sourcePrefix = '';
  } else {
    const topDirs = new Set();
    entries.forEach((e) => {
      const firstSlash = e.entryName.indexOf('/');
      if (firstSlash > 0) topDirs.add(e.entryName.slice(0, firstSlash));
    });
    if (topDirs.size === 1) {
      const dir = [...topDirs][0];
      const nested = entries.find((e) => !e.isDirectory && e.entryName === `${dir}/manifest.json`);
      if (nested) sourcePrefix = `${dir}/`;
    }
  }
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

  const destDir = path.join(ensurePluginsDir(), manifest.id);
  if (fs.existsSync(destDir) && !opts.overwrite) {
    return { success: false, alreadyExists: true, id: manifest.id, name: manifest.name || manifest.id };
  }

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
      if (!outPath.startsWith(destDir + path.sep) && outPath !== destDir) {
        throw new Error(`Refusing to extract "${entry.entryName}" — path escapes the plugin folder.`);
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, entry.getData());
    });
  } catch (e) {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (e2) { /* best-effort cleanup of a partial extract */ }
    return { success: false, error: `Extraction failed (${e.message}).` };
  }

  return { success: true, id: manifest.id, name: manifest.name || manifest.id };
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
  const p = discoverPlugins().find((x) => x.id === id && !x.error);
  if (!p) return { success: false, error: `Plugin "${id}" not found.` };
  if (p.bundled) return { success: false, error: `"${p.name}" ships with the app and can't be fully uninstalled — disable it instead.` };
  const pluginDir = path.join(getPluginsDir(), p.dir);
  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  } catch (e) {
    return { success: false, error: `Couldn't remove the plugin folder (${e.message}).` };
  }
  return { success: true, id, name: p.name };
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
function registerFallbackHandlers(inactiveIds, ipcMain) {
  const inactive = new Set(inactiveIds || []);
  discoverPlugins().forEach((p) => {
    if (p.error || !p.main) return;
    if (!inactive.has(p.id)) return; // active plugins register their own real handlers via activate()
    try {
      const mod = require(path.join(getPluginsDir(), p.dir, p.main));
      if (mod && typeof mod.registerFallback === 'function') mod.registerFallback(ipcMain);
    } catch (e) {
      // Broken plugin main.js — main-plugins.js's own loadMainPlugins() (for
      // active plugins) already surfaces load errors in the PLUGINS tab;
      // an inactive/disabled one failing to even require() here just means
      // no fallback for it, not a crash.
    }
  });
}

module.exports = {
  getPluginsDir, ensurePluginsDir, discoverPlugins, loadMainPlugins, seedBundledPlugins, installPluginFromZip,
  uninstallPlugin, registerFallbackHandlers,
};
