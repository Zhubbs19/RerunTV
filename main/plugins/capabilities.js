// Everything related to a plugin's declared `capabilities` (manifest.json's
// ipc/spawn/net block) — normalizing it, signing it for the approval-prompt
// comparison, and building the capability-checked spawn/http/fs primitives a
// plugin's ctx is wrapped in. Split out of main-plugins.js (which still owns
// discovery/seeding/loading/zip-install — this file is just the capabilities
// slice of that) so each piece can be read/reviewed independently.
//
// Pure Node, no Electron dependency — same reasoning as main-mime.js/
// main-http-util.js/main-path-safety.js: this is required from BOTH
// main-plugins.js (the same-process, Electron-main-process path for a
// non-isolated plugin) and plugin-isolation-runtime.js (the entire, non-
// Electron contents of an isolated plugin's own forked OS process). The
// spawn/createServer/fs wrappers below are used almost verbatim by both —
// only the IPC half differs structurally between them (main-plugins.js calls
// the real ipcMain directly; the isolated runtime proxies IPC registration
// over RPC instead), which is why ipcMain-checking itself isn't here.
const path = require('path');
const fs = require('fs');
const { spawn: nodeSpawn } = require('child_process');
const http = require('http');
const { isPathContained, stripExeSuffix } = require('../util/path-safety');
const { recordDiagnostic } = require('../diagnostics/diagnostics');

// Capabilities schema: manifest `"capabilities"` is an object with any of
// `ipc`/`spawn`/`net`/`mediaSource` (each an array of `{ <value-key>: "...",
// why: "..." }`) declaring exactly what a plugin's main.js needs to touch —
//   ipc:         [{ channel: "my-plugin:start", why: "..." }]  — an ipcMain.handle/.on channel name
//   spawn:       [{ bin: "ffmpeg", why: "..." }]                — a child-process executable, matched by basename
//   net:         [{ port: 8723, why: "..." }]                   — a port this plugin's own HTTP server binds
//   mediaSource: [{ providerId: "my-source", why: "..." }]        — registers as a channel media-content source
//   system:      [{ action: "shell.openExternal", why: "..." }]   — one of the OS-level actions proxied to an
//                                                                   isolated plugin's ctx.shell/ctx.desktopCapturer
//                                                                   ("shell.openExternal" or
//                                                                   "desktopCapturer.getSources") — see
//                                                                   main-plugin-isolation.js's
//                                                                   registerChildInitiatedHandlers
// A malformed entry (missing its value key or `why`) is dropped rather than
// erroring the whole manifest — same "degrade gracefully" spirit as every
// other optional manifest field. `dataDir` is what scopes file writes; it
// isn't part of this object since it already has its own top-level field.
//
// Unlike ipc/spawn/net, mediaSource is declarative metadata only — it
// doesn't gate a runtime-checked wrapper the way createCheckedSpawn/
// createCheckedServer do below. Its job is (a) surfacing in the capability
// approval prompt so the user consciously accepts "this plugin can supply
// channel media" (worth being explicit about since outbound network access
// to fetch that media isn't gated by anything today — see
// main-media-dispatch.js's header comment), (b) letting the setup UI
// enumerate available providers without calling into any plugin, and (c)
// letting main-media-dispatch.js reject a ref whose providerId was never
// actually declared/approved. It rides the same capabilitiesSignature()
// JSON blob as every other capability type below, so a plugin update that
// adds/removes/renames a providerId re-triggers the approval prompt exactly
// like adding an ipc channel or spawn binary does — no separate plumbing
// needed for that.
function normalizeCapabilities(raw) {
  const caps = raw && typeof raw === 'object' ? raw : {};
  function normalizeList(list, valueKey) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e === 'object' && typeof e[valueKey] !== 'undefined' && typeof e.why === 'string' && e.why)
      .map((e) => ({ [valueKey]: e[valueKey], why: e.why, ...(e.displayName ? { displayName: e.displayName } : {}) }));
  }
  return {
    ipc: normalizeList(caps.ipc, 'channel'),
    spawn: normalizeList(caps.spawn, 'bin'),
    net: normalizeList(caps.net, 'port'),
    mediaSource: normalizeList(caps.mediaSource, 'providerId'),
    system: normalizeList(caps.system, 'action'),
  };
}

// A stable string identifying exactly what a plugin's manifest currently
// declares — compared against what the user has previously approved
// (config.plugins.approvedCapabilities, see main.js) to decide whether a
// fresh approval prompt is needed. Changes whenever the declared
// capabilities actually change (a plugin update adding a new port/channel/
// binary re-prompts), not on every boot.
function capabilitiesSignature(capabilities) {
  return JSON.stringify(capabilities || {
    ipc: [], spawn: [], net: [], mediaSource: [], system: [],
  });
}

// Shared error shape for every "tried to touch something undeclared" throw
// below (and for the IPC-channel check each ctx builder does inline, since
// that part isn't shared — see this file's header comment).
function capabilityError(pluginId, kind, value, field) {
  return new Error(`Plugin "${pluginId}" tried to ${kind} "${value}" without declaring it in manifest.json's capabilities.${field} — add it there (with a "why") first.`);
}

// Derives the three lookup sets a ctx builder checks every spawn/listen/IPC
// call against, from a manifest's (already-normalized) capabilities object.
function allowedSetsFor(capabilities) {
  const caps = capabilities || {
    ipc: [], spawn: [], net: [], system: [],
  };
  return {
    allowedIpc: new Set(caps.ipc.map((e) => e.channel)),
    allowedSpawn: new Set(caps.spawn.map((e) => stripExeSuffix(String(e.bin)))),
    allowedPorts: new Set(caps.net.map((e) => e.port)),
    allowedSystem: new Set((caps.system || []).map((e) => e.action)),
  };
}

// A same-process check, not a hard OS security boundary on its own — a
// same-process (non-isolated) plugin could still `require('child_process')`
// directly and bypass this entirely; an isolated plugin additionally has
// Node's --experimental-permission enforcing "may spawn at all" for real at
// the OS level (see main-plugin-isolation.js's execArgv), but that model's
// granularity stops there — it can't scope "may spawn ffmpeg" vs "may spawn
// anything," which is exactly what the per-binary check here still does.
function createCheckedSpawn(pluginId, allowedSpawn) {
  return function checkedSpawn(bin, args, opts) {
    const base = stripExeSuffix(path.basename(bin));
    if (!allowedSpawn.has(base)) throw capabilityError(pluginId, 'spawn', bin, 'spawn');
    recordDiagnostic('plugin-capability', 'log', `${pluginId} spawned declared binary ${base}`);
    // A declared binary is launched directly. A plugin-supplied shell:true would
    // let "ffmpeg" smuggle arbitrary shell syntax, and detached:true would let the
    // child outlive the app, so both are overridden.
    const { shell, detached, ...safeOpts } = opts || {};
    return nodeSpawn(bin, args, { ...safeOpts, shell: false, detached: false });
  };
}

function createCheckedServer(pluginId, allowedPorts) {
  return function checkedCreateServer(handler) {
    const server = http.createServer(handler);
    const realListen = server.listen.bind(server);
    server.listen = (port, ...rest) => {
      if (!allowedPorts.has(port)) throw capabilityError(pluginId, 'listen on port', port, 'net');
      recordDiagnostic('plugin-capability', 'log', `${pluginId} listened on declared port ${port}`);
      return realListen(port, ...rest);
    };
    return server;
  };
}

// A plugin may declare manifest `"userPaths": "<settings key>"` — the name of
// one of its OWN settings holding a folder (or a list of folders) the user
// picked for it, e.g. where a recorder should put its output. Those folders
// are granted read and write alongside its dataDir.
//
// Two things this deliberately is not. It is not a way for a plugin to widen
// its own access at will: the value comes from the plugin's settings, which
// only the user edits through its settings panel. And it is not dynamic —
// an isolated plugin's OS-level permissions are fixed when its process is
// forked, so a folder changed now takes effect at the next restart, which is
// what a plugin's settings UI should say.
function resolveUserPaths(manifest, baseCtx) {
  if (typeof manifest.userPaths !== 'string' || !manifest.userPaths) return [];
  let configured;
  try {
    const stored = (baseCtx.loadConfig().pluginSettings || {})[manifest.id] || {};
    configured = stored[manifest.userPaths];
  } catch (e) {
    return []; // unreadable config at boot costs the grant, not the plugin
  }
  const candidates = (Array.isArray(configured) ? configured : [configured])
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => path.resolve(entry.trim()));
  return candidates.filter((dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (e) {
      return false; // a folder that cannot be created is not granted
    }
  });
}

// Reads are intentionally unrestricted (existsSync/readFile/readdirSync take
// whatever path is passed) — checking whether a user-configured executable
// exists (a plugin's own custom-binary-path setting) is a legitimate need
// with no folder to scope it to in advance. Writes are scoped to the
// plugin's own dataDir (null if the manifest declared none, meaning no
// filesystem write access at all) plus any folder the USER chose for this
// plugin through its own settings (manifest `userPaths`, resolved below),
// rejecting any path that resolves outside all of them (including via `..`).
//
// A relative path still resolves against dataDir, exactly as before. An
// absolute path is now accepted too, but only when it lands inside one of
// those roots — which is what lets a plugin write its output to a folder the
// user picked without having to pretend it is relative to anything.
function createCheckedFs(pluginId, dataDir, userDirs = []) {
  const writeRoots = [dataDir, ...userDirs].filter(Boolean);
  function resolveDataPath(relPath) {
    if (!writeRoots.length) throw new Error(`Plugin "${pluginId}" has no "dataDir" declared in manifest.json — nowhere to write plugin data.`);
    const resolved = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : path.resolve(dataDir || writeRoots[0], relPath);
    if (!writeRoots.some((root) => isPathContained(root, resolved))) {
      throw new Error(`Plugin "${pluginId}" tried to write outside its own data folder and configured folders ("${relPath}").`);
    }
    return resolved;
  }
  return {
    existsSync: (p) => fs.existsSync(p),
    readFile: (p, ...rest) => fs.readFile(p, ...rest),
    readFileSync: (p, ...rest) => fs.readFileSync(p, ...rest),
    readdirSync: (p, ...rest) => fs.readdirSync(p, ...rest),
    statSync: (p, ...rest) => fs.statSync(p, ...rest),
    // Up to `length` bytes from `start`, resolved as a Buffer that is shorter
    // at end of file. Same unrestricted read as readFile, just bounded, so a
    // tag or header reader does not have to pull a whole media file into
    // memory to look at its first few kilobytes.
    readRange: async (p, start, length) => {
      const handle = await fs.promises.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.max(0, Math.floor(length) || 0));
        const { bytesRead } = await handle.read(buf, 0, buf.length, Math.max(0, Math.floor(start) || 0));
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    writeFile: (relPath, ...rest) => fs.writeFile(resolveDataPath(relPath), ...rest),
    writeFileSync: (relPath, ...rest) => fs.writeFileSync(resolveDataPath(relPath), ...rest),
    mkdirSync: (relPath, ...rest) => fs.mkdirSync(resolveDataPath(relPath), ...rest),
    createWriteStream: (relPath, ...rest) => fs.createWriteStream(resolveDataPath(relPath), ...rest),
    unlink: (relPath, ...rest) => fs.unlink(resolveDataPath(relPath), ...rest),
    dataDir,
    // Where this plugin may actually write, dataDir included — a plugin with
    // a user-chosen output folder needs to know which one it got.
    writeDirs: writeRoots,
  };
}

module.exports = {
  normalizeCapabilities, capabilitiesSignature, capabilityError, allowedSetsFor, resolveUserPaths,
  createCheckedSpawn, createCheckedServer, createCheckedFs,
};
