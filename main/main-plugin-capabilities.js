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
const { isPathContained, stripExeSuffix } = require('./main-path-safety');
const { recordDiagnostic } = require('./main-diagnostics');

// Capabilities schema: manifest `"capabilities"` is an object with any of
// `ipc`/`spawn`/`net`/`mediaSource` (each an array of `{ <value-key>: "...",
// why: "..." }`) declaring exactly what a plugin's main.js needs to touch —
//   ipc:         [{ channel: "my-plugin:start", why: "..." }]  — an ipcMain.handle/.on channel name
//   spawn:       [{ bin: "ffmpeg", why: "..." }]                — a child-process executable, matched by basename
//   net:         [{ port: 8723, why: "..." }]                   — a port this plugin's own HTTP server binds
//   mediaSource: [{ providerId: "my-source", why: "..." }]        — registers as a channel media-content source
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
    ipc: [], spawn: [], net: [], mediaSource: [],
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
  const caps = capabilities || { ipc: [], spawn: [], net: [] };
  return {
    allowedIpc: new Set(caps.ipc.map((e) => e.channel)),
    allowedSpawn: new Set(caps.spawn.map((e) => stripExeSuffix(String(e.bin)))),
    allowedPorts: new Set(caps.net.map((e) => e.port)),
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
    return nodeSpawn(bin, args, opts);
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

// Reads are intentionally unrestricted (existsSync/readFile/readdirSync take
// whatever path is passed) — checking whether a user-configured executable
// exists (a plugin's own custom-binary-path setting) is a legitimate need
// with no folder to scope it to in advance. Writes are scoped to the
// plugin's own dataDir (null if the manifest declared none, meaning no
// filesystem write access at all), rejecting any path that resolves outside
// it (including via `..`).
function createCheckedFs(pluginId, dataDir) {
  function resolveDataPath(relPath) {
    if (!dataDir) throw new Error(`Plugin "${pluginId}" has no "dataDir" declared in manifest.json — nowhere to write plugin data.`);
    const resolved = path.resolve(dataDir, relPath);
    if (!isPathContained(dataDir, resolved)) {
      throw new Error(`Plugin "${pluginId}" tried to write outside its own data folder ("${relPath}").`);
    }
    return resolved;
  }
  return {
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
}

module.exports = {
  normalizeCapabilities, capabilitiesSignature, capabilityError, allowedSetsFor,
  createCheckedSpawn, createCheckedServer, createCheckedFs,
};
