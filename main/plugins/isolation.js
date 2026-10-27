// Phase 2 plugin sandboxing — host side. A plugin manifest with
// `"isolated": true` runs its main.js in its own real OS process (Electron's
// utilityProcess.fork(), a genuine forked Node process — not a same-process
// require() with a JS-level capability check, which is all Phase 1 offered)
// instead of loadMainPlugins()'s normal require()+buildCheckedCtx() path in
// main-plugins.js. Why:
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
const { createRpc, cloneableServiceSnapshot } = require('./rpc-channel');
const { recordConnection } = require('../lan/connections');
const { recordDiagnostic } = require('../diagnostics/diagnostics');
const { allowedSetsFor, capabilityError, resolveUserPaths } = require('./capabilities');
const { isolatedConfigView } = require('./config-view');
const { isAllowedExternalUrl } = require('../util/fetch-guards');
const bridge = require('./bridge');

const RUNTIME_SCRIPT = path.join(__dirname, 'isolation-runtime.js');
// A hung/broken isolated plugin (forked but never emitting 'runtime-ready',
// or activate() inside it never resolving) must not block the rest of boot
// forever — loadMainPlugins() awaits this per plugin in a loop, and that in
// turn gates createWindow()/the headless "ready" log for every mode. Found
// live: a stuck personal plugin silently prevented the whole app — desktop
// and headless alike — from ever finishing boot.
const ACTIVATION_TIMEOUT_MS = 15000;

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
const partyRouteOwners = new Map(); // "METHOD pathname" -> plugin id
const beforeQuitChildren = new Set(); // childRpc instances that asked for the before-quit event
const runningChildren = new Set(); // { child, pluginId } — for teardown + diagnostics
// First-writer-owns-it for ctx.services keys, shared with the non-isolated
// path (main-plugins.js's registerService uses the same map). Without this,
// any plugin — isolated or not, regardless of its own declared capabilities
// — could overwrite a key another plugin already published (e.g.
// ffmpeg-transcode's ffmpegPath, which callers hand straight to spawn()) and
// have its own value trusted in that key's place. A key with no owner yet
// is free for the first publisher to claim; after that, only the same
// plugin id may republish it (a legitimate re-resolve, e.g. after ffmpeg's
// static path changes) — anyone else's write is dropped.
const serviceOwners = new Map(); // key -> pluginId

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
//
// `helperBinaries` are the individual executable FILES core itself already
// resolved and is handing this child in its own init payload (today: the
// ffmpeg binary, either bundled or found on PATH, plus whatever path the
// user configured for it). They are granted read because a plugin has to be
// able to check that a binary core told it about actually exists before
// spawning it — and a plugin that couldn't check would still be allowed to
// spawn it, so this reveals nothing it doesn't already have. Found the hard
// way: this build doesn't bundle ffmpeg, so the ffmpeg-transcode plugin
// resolves a system one from PATH, and every such path sits outside the two
// directories below. fs.existsSync() doesn't throw under the permission
// model, it just answers false — so the plugin concluded the binary wasn't
// there and refused to activate, silently taking the codec fix, caption
// extraction, thumbnail capture and recording down with it. Each entry is
// one exact file, never a directory.
function buildExecArgv(manifest, appRootDir, pluginDir, dataDir, helperBinaries = [], userDirs = []) {
  // Packaged plugins are seeded under portable userData/plugins, which is a
  // sibling of resources/app.asar rather than a child of appRootDir. Grant
  // the plugin's own directory explicitly so the runtime can require its
  // entry point and read its bundled assets without broadening access to the
  // rest of userData.
  const readPaths = [appRootDir, pluginDir];
  const writePaths = [];
  if (dataDir) { readPaths.push(dataDir); writePaths.push(dataDir); }
  helperBinaries.filter(Boolean).forEach((binary) => readPaths.push(binary));
  // Folders the user chose for this plugin through its own settings — see
  // resolveUserPaths (main-plugin-capabilities.js). Read as well as write:
  // a plugin that puts its output somewhere has to be able to list it again.
  // The flag value is comma-separated, so a folder whose name contains a comma
  // would be read as several grants; only absolute, comma-free folders are used.
  userDirs.filter((dir) => typeof dir === 'string' && dir && !dir.includes(',') && path.isAbsolute(dir))
    .forEach((dir) => { readPaths.push(dir); writePaths.push(dir); });
  const args = [
    '--experimental-permission',
    `--allow-fs-read=${readPaths.join(',')}`,
  ];
  if (writePaths.length) args.push(`--allow-fs-write=${writePaths.join(',')}`);
  const caps = manifest.capabilities || { spawn: [] };
  if (caps.spawn && caps.spawn.length) args.push('--allow-child-process');
  return args;
}

// Resolves and invokes a published/registered service by key, regardless of
// whether it lives same-process (a plain function in `pluginServices`) or in
// an isolated plugin's own process (proxied through its childRpc) — the
// exact body of the `services:call` RPC handler below, lifted out so
// main-media-dispatch.js (media-source provider dispatch) and
// buildCheckedCtx()'s ctx.callService (main-plugins.js, the non-isolated
// path) can both reuse this one resolution order instead of each
// reimplementing it. `args` is an explicit array (not rest-params) so an
// optional trailing `timeoutMsOverride` can't be mistaken for a call
// argument; it's passed straight through to childRpc.request() for the
// isolated-provider case — see rpc-channel.js's comment on why a
// media-source call needs more headroom than this channel's default.
// Shared with main-plugins.js's non-isolated registerService, so ownership
// of a services key is enforced the same way regardless of which process
// published it first. Returns false (write refused) if another plugin
// already owns this key.
function claimServiceKey(pluginId, key) {
  const owner = serviceOwners.get(key);
  if (owner && owner !== pluginId) return false;
  serviceOwners.set(key, pluginId);
  return true;
}

function claimPartyRoute(pluginId, routeKey) {
  const owner = partyRouteOwners.get(routeKey);
  if (owner && owner !== pluginId) return false;
  partyRouteOwners.set(routeKey, pluginId);
  return true;
}

function callAnyService(pluginServices, key, args, timeoutMsOverride) {
  if (typeof pluginServices[key] === 'function') return pluginServices[key](...(args || []));
  const provider = serviceProviders.get(key);
  if (!provider) return Promise.reject(new Error(`No plugin has published a "${key}" service.`));
  return provider.request('services:invoke', { key, args: args || [] }, timeoutMsOverride);
}

// ---- handlers for requests/events the CHILD initiates ----
// Split out of activateIsolatedPlugin() below — this whole block wires up
// what happens when the forked process calls back into the host (an IPC
// registration, a service publish, a party route claim, ...); none of it
// touches that function's own per-activation state (settle/resolve, the
// handshake), so it was just adding to how far you had to scroll to find
// where activation itself actually starts and ends.
function registerChildInitiatedHandlers(childRpc, baseCtx, pluginServices, manifest) {
  // The client-side check in plugin-isolation-runtime.js's ctx.ipcMain only
  // stops a plugin going through ctx — nothing stops its own code calling
  // process.parentPort.postMessage() directly to emit this same RPC event
  // for a channel it never declared. Re-checking here, on the host, against
  // the real manifest is the only check that actually holds across that
  // bypass, since this is the process that performs the real
  // ipcMain.handle()/on() registration.
  const { allowedIpc, allowedSystem } = allowedSetsFor(manifest.capabilities);
  childRpc.on('ipc:handle-register', ({ channel }) => {
    if (!allowedIpc.has(channel)) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', capabilityError(manifest.id, 'register IPC channel', channel, 'ipc').message);
      return;
    }
    ipcMain.handle(channel, async (event, ...args) => childRpc.request('ipc:call', { channel, args }));
    bridge.registerPluginHandler(manifest.id, channel, (event, args) => childRpc.request('ipc:call', { channel, args }));
  });
  childRpc.on('ipc:on-register', ({ channel }) => {
    if (!allowedIpc.has(channel)) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', capabilityError(manifest.id, 'register IPC channel', channel, 'ipc').message);
      return;
    }
    ipcMain.on(channel, (event, ...args) => childRpc.emit('ipc:on-fire', { channel, args }));
    bridge.registerPluginHandler(manifest.id, channel, (event, args) => { childRpc.emit('ipc:on-fire', { channel, args }); });
  });
  // Unlike ipc:handle-register/ipc:on-register above, these two proxy
  // straight to a real OS-level action with no per-call value to check
  // against (there's no "channel name" to allowlist — the action itself is
  // the whole capability) — gated on capabilities.system so a plugin has to
  // declare (and the user approve) "shell.openExternal"/
  // "desktopCapturer.getSources" the same way it would ipc/spawn/net, rather
  // than getting both for free just by being isolated.
  childRpc.handle('desktopCapturer:getSources', async ({ opts }) => {
    if (!allowedSystem.has('desktopCapturer.getSources')) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', capabilityError(manifest.id, 'use', 'desktopCapturer.getSources', 'system').message);
      throw capabilityError(manifest.id, 'use', 'desktopCapturer.getSources', 'system');
    }
    const sources = await desktopCapturer.getSources(opts);
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnailDataUrl: s.thumbnail.toDataURL() }));
  });
  childRpc.handle('shell:openExternal', async ({ url }) => {
    if (!allowedSystem.has('shell.openExternal')) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', capabilityError(manifest.id, 'use', 'shell.openExternal', 'system').message);
      throw capabilityError(manifest.id, 'use', 'shell.openExternal', 'system');
    }
    // The capability approves "may open links", not "may launch anything": a
    // file:, smb: or custom-protocol URL can run local programs.
    if (!isAllowedExternalUrl(url)) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', `Plugin "${manifest.id}" asked to open a non-web URL; refused.`);
      throw new Error('Only http, https and mailto links can be opened.');
    }
    shell.openExternal(url);
    return true;
  });
  childRpc.on('app:on-before-quit-register', () => { beforeQuitChildren.add(childRpc); });
  childRpc.on('sendToMainWindow', ({ channel, data }) => {
    const mainWindow = baseCtx.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, data);
    // Tagged here with this child's own id, so a plugin can't send as another.
    mainWindow.webContents.send('plugins:event', bridge.eventEnvelope(manifest.id, channel, data));
  });
  // The connections this plugin's process made or was refused (net-guard.js).
  // Reported by the plugin's own process, so it's a record for the user, not
  // a security control in itself; the refusal itself happened in-process.
  childRpc.on('net:activity', (batch) => {
    bridge.recordNetwork(manifest.id, batch).forEach((host) => {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', `Plugin "${manifest.id}" was blocked from connecting to ${host}, which its manifest doesn't list in capabilities.internet.`);
    });
  });
  childRpc.handle('fetchJsonCached', async ({
    key, url, opts, ttlMs,
  }) => baseCtx.fetchJsonCached(`${manifest.id}:${String(key)}`, url, opts, ttlMs));
  // A reduced view, not the whole config: see plugins/config-view.js.
  childRpc.handle('loadConfig', async () => isolatedConfigView(await baseCtx.loadConfig(), manifest.id));
  childRpc.on('trackConnection', ({ serverName, ip, userAgent }) => recordConnection(serverName, ip, userAgent));
  childRpc.on('services:publish', ({ key, value }) => {
    if (!claimServiceKey(manifest.id, key)) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', `Plugin "${manifest.id}" tried to publish services key "${key}", already owned by another plugin — write ignored.`);
      return;
    }
    pluginServices[key] = value;
  });
  childRpc.on('services:registerProvider', ({ key }) => {
    if (!claimServiceKey(manifest.id, key)) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', `Plugin "${manifest.id}" tried to register services provider "${key}", already owned by another plugin — registration ignored.`);
      return;
    }
    serviceProviders.set(key, childRpc);
  });
  childRpc.handle('services:call', async ({ key, args }) => callAnyService(pluginServices, key, args || []));
  childRpc.on('party:registerRoute', ({ method, pathname }) => {
    const routeKey = `${method} ${pathname}`;
    if (!claimPartyRoute(manifest.id, routeKey)) {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', `Plugin "${manifest.id}" tried to register Party route "${routeKey}", already owned by another plugin — registration ignored.`);
      return;
    }
    partyRouteRegistry.set(routeKey, childRpc);
  });
  childRpc.handle('party:dispatchRoute', async (reqDescriptor) => {
    const owner = partyRouteRegistry.get(`${reqDescriptor.method} ${reqDescriptor.pathname}`);
    if (!owner) return null; // no plugin claimed this route — caller falls through to static-file serving
    return owner.request('party:invokeRoute', reqDescriptor);
  });
}

// Runs one isolated plugin's main.js in its own forked process and waits for
// it to finish activate() (or fail) before returning — same "one plugin's
// failure doesn't take the rest down" contract loadMainPlugins() already
// gives non-isolated plugins, just async now since forking a real process
// can't be synchronous. `baseCtx` is the same {fetchJsonCached, loadConfig,
// ...} extraCtx object main.js builds for the non-isolated path; `manifest`
// is one entry from discoverPlugins(); `pluginDir` is its absolute install
// path; `pluginServices` is the single shared services object.
// The executables core resolves for plugins to spawn — read-granted above so
// an isolated plugin can stat one before spawning it. A config read that
// fails (a corrupt or missing config at boot) costs the user-configured
// override, not the whole activation.
function helperBinaryPaths(baseCtx) {
  const paths = [baseCtx.ffmpegStaticPath];
  try {
    const configured = (baseCtx.loadConfig().ffmpeg || {}).ffmpegPath;
    if (configured) paths.push(configured);
  } catch (e) { /* no configured override available — the resolved path above still applies */ }
  return paths;
}

function activateIsolatedPlugin(manifest, pluginDir, baseCtx, pluginServices, appRootDir) {
  return new Promise((resolve) => {
    // Single plain folder name only (discovery already filters it; re-checked here
    // because this is what actually becomes a filesystem permission).
    const safeDataDir = typeof manifest.dataDir === 'string' && /^[A-Za-z0-9._-]+$/.test(manifest.dataDir) && manifest.dataDir !== '.' && manifest.dataDir !== '..';
    const dataDir = safeDataDir ? path.join(baseCtx.app.getPath('userData'), manifest.dataDir) : null;
    if (dataDir) require('fs').mkdirSync(dataDir, { recursive: true });
    const userDirs = resolveUserPaths(manifest, baseCtx);

    let child;
    try {
      child = utilityProcess.fork(RUNTIME_SCRIPT, [], {
        serviceName: `plugin:${manifest.id}`,
        execArgv: buildExecArgv(manifest, appRootDir, pluginDir, dataDir, helperBinaryPaths(baseCtx), userDirs),
        stdio: 'pipe',
      });
    } catch (e) {
      resolve({ ok: false, error: `couldn't fork isolated process: ${e.message}` });
      return;
    }

    // Surfaced the same way a same-process plugin's console output already
    // is — not routed anywhere fancier, just so a dev console shows it
    // rather than it vanishing silently into the child's own pipe.
    if (child.stdout) child.stdout.on('data', (d) => {
      recordDiagnostic(`plugin:${manifest.id}`, 'log', String(d).trim());
      process.stdout.write(`[${manifest.id}] ${d}`);
    });
    if (child.stderr) child.stderr.on('data', (d) => {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', String(d).trim());
      process.stderr.write(`[${manifest.id}] ${d}`);
    });

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(activationTimer);
      resolve(result);
    };
    const activationTimer = setTimeout(() => {
      recordDiagnostic(`plugin:${manifest.id}`, 'error', `Plugin "${manifest.id}" did not finish activating within ${ACTIVATION_TIMEOUT_MS}ms — killing it and continuing boot.`);
      try { child.kill(); } catch (e) { /* already gone */ }
      settle({ ok: false, error: `isolated process did not finish activating within ${ACTIVATION_TIMEOUT_MS}ms` });
    }, ACTIVATION_TIMEOUT_MS);

    const childRpc = createRpc(
      (msg) => {
        try { child.postMessage(msg); } catch (e) {
          const error = `could not send activation data to isolated process: ${e.message}`;
          recordDiagnostic(`plugin:${manifest.id}`, 'error', error);
          if (!settled) {
            try { child.kill(); } catch (killError) { /* already gone */ }
            settle({ ok: false, error });
          }
        }
      },
      (cb) => child.on('message', (msg) => cb(msg)),
    );

    // Install the completion listener before any runtime-ready path can send
    // init. A plugin whose activate() is synchronous can answer immediately;
    // registering this after sendInitWhenReady() would lose that result and
    // turn a successful activation into a timeout.
    childRpc.on('activate-result', (result) => {
      if (result.ok) {
        runningChildren.add({ child, pluginId: manifest.id });
      } else {
        // A failed activation leaves a live process that may already hold
        // service/route registrations; kill it (the exit handler below purges
        // them) rather than leaving a half-started plugin answering calls.
        try { child.kill(); } catch (e) { /* already gone */ }
      }
      settle(result);
    });

    // The child can emit runtime-ready as soon as its script starts. Keep
    // that event even if it arrives while the host is still registering the
    // handlers the activated plugin will use. Previously the listener was
    // attached after registerChildInitiatedHandlers(), so a fast child could
    // win the race, have its event dropped by createRpc(), and then sit idle
    // until the activation timeout.
    let runtimeReady = false;
    let hostHandlersReady = false;
    const sendInitWhenReady = () => {
      if (!runtimeReady || !hostHandlersReady) return;
      childRpc.emit('init', {
        manifest,
        pluginDir,
        dataDir,
        userDirs,
        remotePort: baseCtx.remotePort,
        ffmpegStaticPath: baseCtx.ffmpegStaticPath,
        viewerUrls: typeof baseCtx.getViewerUrls === 'function' ? baseCtx.getViewerUrls() : [],
        servicesSnapshot: cloneableServiceSnapshot(pluginServices),
      });
    };
    childRpc.on('runtime-ready', () => {
      runtimeReady = true;
      sendInitWhenReady();
    });

    child.on('exit', (code) => {
      runningChildren.forEach((entry) => { if (entry.child === child) runningChildren.delete(entry); });
      // This plugin's process is gone — purge every shared registry entry
      // that still points at its childRpc, so a later services:call/
      // party:dispatchRoute routed here fails fast instead of hanging (see
      // childRpc.dispose() below) or, worse, silently resolving against a
      // dead process. Any request currently in flight TO this child (e.g.
      // another plugin awaiting a service call this one was providing) is
      // rejected immediately rather than waiting out its own timeout.
      serviceProviders.forEach((provider, key) => { if (provider === childRpc) serviceProviders.delete(key); });
      partyRouteRegistry.forEach((owner, key) => {
        if (owner !== childRpc) return;
        partyRouteRegistry.delete(key);
        partyRouteOwners.delete(key);
      });
      beforeQuitChildren.delete(childRpc);
      bridge.unregisterPlugin(manifest.id);
      childRpc.dispose(`plugin "${manifest.id}" process exited (code ${code})`);
      settle({ ok: false, error: `isolated process exited (code ${code}) before finishing activation` });
    });

    registerChildInitiatedHandlers(childRpc, baseCtx, pluginServices, manifest);
    hostHandlersReady = true;
    sendInitWhenReady();
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

module.exports = {
  activateIsolatedPlugin, wireAppQuitPropagation, callAnyService, buildExecArgv, claimServiceKey,
};
