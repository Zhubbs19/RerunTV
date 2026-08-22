// Phase 2 plugin sandboxing — host side. A plugin manifest with
// `"isolated": true` runs its main.js in its own real OS process (Electron's
// utilityProcess.fork(), a genuine forked Node process — not a same-process
// require() with a JS-level capability check, which is all Phase 1 offered)
// instead of loadMainPlugins()'s normal require()+buildCheckedCtx() path in
// main-plugins.js. See [[retro_cable_box_plugin_sandboxing_phase2]] for why:
// Node has no supported way to sandbox arbitrary require()d code within the
// same process, so genuine isolation needs a real process boundary.
//
// Everything an isolated plugin's activate(ctx) can touch that actually needs
// Electron (ipcMain, desktopCapturer, shell, the main window) is proxied over
// an RPC channel (rpc-channel.js) riding Electron's utilityProcess message
// port — see plugin-isolation-runtime.js, the counterpart script that runs
// INSIDE the forked process and is the other half of every handler
// registered below.
const path = require('path');
const { app, ipcMain, shell, desktopCapturer } = require('electron');
const { utilityProcess } = require('electron');
const { createRpc } = require('./rpc-channel');
const { recordConnection } = require('./main-connections');

const RUNTIME_SCRIPT = path.join(__dirname, 'plugin-isolation-runtime.js');

// Module-level (not per-call) registries — deliberately shared across every
// isolated plugin activated this boot, since a cross-plugin capability
// (one plugin calling another's published service, or registering a route
// on another plugin's own server) has to be resolvable regardless of which
// isolated process published it first. `pluginServices` itself is the SAME
// shared object main-plugins.js's non-isolated buildCheckedCtx() path reads
// and writes — passed in by main.js — so a value-typed service (ffmpegPath)
// published by an isolated plugin is visible to a same-process plugin
// reading ctx.services.ffmpegPath and vice versa, with no separate storage.
const serviceProviders = new Map(); // key -> childRpc (isolated function-valued providers only)
const partyRouteRegistry = new Map(); // "METHOD pathname" -> childRpc
const beforeQuitChildren = new Set(); // childRpc instances that asked for the before-quit event
const runningChildren = new Set(); // { child, pluginId } — for teardown + diagnostics

function stripExeSuffix(basename) {
  return basename.toLowerCase().endsWith('.exe') ? basename.slice(0, -4).toLowerCase() : basename.toLowerCase();
}

// Node's --experimental-permission model is coarser than Phase 1's per-value
// JS checks (it can't scope "may spawn ffmpeg" vs "may spawn anything" — only
// "may spawn at all"), but what it DOES give is real, OS-enforced: a plugin
// that bypasses ctx.fs/ctx.spawn entirely and calls require('fs')/
// require('child_process') directly — which defeated Phase 1's same-process
// check completely — throws here instead. fs-read is scoped to this app's own
// install directory (needed for node_modules resolution + this app's own
// electron-free main-*.js helpers the runtime requires — see
// plugin-isolation-runtime.js) plus the plugin's own folder, which is
// necessarily broader than "just this plugin" but still meaningfully narrower
// than the unrestricted filesystem access every plugin had before Phase 2.
// fs-write is scoped to the plugin's declared dataDir ONLY (no dataDir
// declared means no filesystem write access at all, full stop — stronger
// than Phase 1, which always allowed writes as long as they targeted SOME
// dataDir; here there isn't one to target). child-process spawn is only
// granted at all if the manifest declares at least one capabilities.spawn
// entry.
function buildExecArgv(manifest, appRootDir, dataDir) {
  const readPaths = [appRootDir];
  const writePaths = [];
  if (dataDir) { readPaths.push(dataDir); writePaths.push(dataDir); }
  const args = [
    '--experimental-permission',
    `--allow-fs-read=${readPaths.join(',')}`,
  ];
  if (writePaths.length) args.push(`--allow-fs-write=${writePaths.join(',')}`);
  const caps = manifest.capabilities || { spawn: [] };
  if (caps.spawn && caps.spawn.length) args.push('--allow-child-process');
  return args;
}

// Runs one isolated plugin's main.js in its own forked process and waits for
// it to finish activate() (or fail) before returning — same "one plugin's
// failure doesn't take the rest down" contract loadMainPlugins() already
// gives non-isolated plugins, just async now since forking a real process
// can't be synchronous. `baseCtx` is the same {fetchJsonCached, loadConfig,
// ...} extraCtx object main.js builds for the non-isolated path; `manifest`
// is one entry from discoverPlugins(); `pluginDir` is its absolute install
// path; `pluginServices` is the single shared services object.
function activateIsolatedPlugin(manifest, pluginDir, baseCtx, pluginServices, appRootDir) {
  return new Promise((resolve) => {
    const dataDir = manifest.dataDir ? path.join(baseCtx.app.getPath('userData'), manifest.dataDir) : null;
    if (dataDir) require('fs').mkdirSync(dataDir, { recursive: true });

    let child;
    try {
      child = utilityProcess.fork(RUNTIME_SCRIPT, [], {
        serviceName: `plugin:${manifest.id}`,
        execArgv: buildExecArgv(manifest, appRootDir, dataDir),
        stdio: 'pipe',
      });
    } catch (e) {
      resolve({ ok: false, error: `couldn't fork isolated process: ${e.message}` });
      return;
    }

    // Surfaced the same way a same-process plugin's console output already
    // is — not routed anywhere fancier, just so a dev console shows it
    // rather than it vanishing silently into the child's own pipe.
    if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(`[${manifest.id}] ${d}`));
    if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(`[${manifest.id}] ${d}`));

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on('exit', (code) => {
      runningChildren.forEach((entry) => { if (entry.child === child) runningChildren.delete(entry); });
      settle({ ok: false, error: `isolated process exited (code ${code}) before finishing activation` });
    });

    const childRpc = createRpc(
      (msg) => { try { child.postMessage(msg); } catch (e) { /* child likely already gone */ } },
      (cb) => child.on('message', (msg) => cb(msg)),
    );

    // ---- handlers for requests/events the CHILD initiates ----
    childRpc.on('ipc:handle-register', ({ channel }) => {
      ipcMain.handle(channel, async (event, ...args) => childRpc.request('ipc:call', { channel, args }));
    });
    childRpc.on('ipc:on-register', ({ channel }) => {
      ipcMain.on(channel, (event, ...args) => childRpc.emit('ipc:on-fire', { channel, args }));
    });
    childRpc.handle('desktopCapturer:getSources', async ({ opts }) => {
      const sources = await desktopCapturer.getSources(opts);
      return sources.map((s) => ({ id: s.id, name: s.name, thumbnailDataUrl: s.thumbnail.toDataURL() }));
    });
    childRpc.handle('shell:openExternal', async ({ url }) => { shell.openExternal(url); return true; });
    childRpc.on('app:on-before-quit-register', () => { beforeQuitChildren.add(childRpc); });
    childRpc.on('sendToMainWindow', ({ channel, data }) => {
      const mainWindow = baseCtx.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
    });
    childRpc.handle('fetchJsonCached', async ({
      key, url, opts, ttlMs,
    }) => baseCtx.fetchJsonCached(key, url, opts, ttlMs));
    childRpc.handle('loadConfig', async () => baseCtx.loadConfig());
    childRpc.on('trackConnection', ({ serverName, ip, userAgent }) => recordConnection(serverName, ip, userAgent));
    childRpc.on('services:publish', ({ key, value }) => { pluginServices[key] = value; });
    childRpc.on('services:registerProvider', ({ key }) => { serviceProviders.set(key, childRpc); });
    childRpc.handle('services:call', async ({ key, args }) => {
      if (typeof pluginServices[key] === 'function') return pluginServices[key](...(args || []));
      const provider = serviceProviders.get(key);
      if (!provider) throw new Error(`No plugin has published a "${key}" service.`);
      return provider.request('services:invoke', { key, args });
    });
    childRpc.on('party:registerRoute', ({ method, pathname }) => {
      partyRouteRegistry.set(`${method} ${pathname}`, childRpc);
    });
    childRpc.handle('party:dispatchRoute', async (reqDescriptor) => {
      const owner = partyRouteRegistry.get(`${reqDescriptor.method} ${reqDescriptor.pathname}`);
      if (!owner) return null; // no plugin claimed this route — caller falls through to static-file serving
      return owner.request('party:invokeRoute', reqDescriptor);
    });

    // ---- handshake ----
    childRpc.on('runtime-ready', () => {
      childRpc.emit('init', {
        manifest,
        pluginDir,
        dataDir,
        remotePort: baseCtx.remotePort,
        ffmpegStaticPath: baseCtx.ffmpegStaticPath,
        servicesSnapshot: { ...pluginServices },
      });
    });
    childRpc.on('activate-result', (result) => {
      if (result.ok) runningChildren.add({ child, pluginId: manifest.id });
      settle(result);
    });
  });
}

// Called once at boot, after every app.whenReady() setup, so a listener
// registered here fires before any isolated plugin's own before-quit cleanup
// would otherwise be needed — mirrors the "electronApp.on('before-quit', ...)"
// pattern non-isolated plugins already use, just fanned out to every
// isolated child that asked for it instead of
// running inline.
function wireAppQuitPropagation() {
  app.on('before-quit', () => {
    beforeQuitChildren.forEach((childRpc) => childRpc.emit('app:before-quit', {}));
  });
}

module.exports = { activateIsolatedPlugin, wireAppQuitPropagation };
