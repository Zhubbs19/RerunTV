// Phase 2 plugin sandboxing — this file is the ENTIRE contents of an isolated
// plugin's own OS process (forked via Electron's utilityProcess.fork() in
// main-plugin-isolation.js, one process per isolated plugin). It never gets
// the `electron` module — utilityProcess-forked scripts don't have it (Phase
// 1's handoff notes confirmed this empirically: `require('electron').app` is
// undefined in this context) — so every piece of `ctx` that genuinely needs
// Electron (ipcMain, desktopCapturer, shell, app, the real BrowserWindow) is
// proxied over `process.parentPort`, Electron's message-passing channel for a
// forked utility process, using the generic request/event RPC in
// rpc-channel.js. Everything that's pure Node with no Electron dependency
// (fs, http, child_process, and this app's own main-mime.js/main-http-util.js/
// main-lan.js) runs natively right here — that's the whole reason Phase 2 is
// actually SIMPLER than Phase 1 for those: no JS-level capability-checking
// trick is needed for what Node's own --experimental-permission flags (see
// main-plugin-isolation.js's execArgv) can enforce for real at the OS/runtime
// level instead.
//
// See PLUGIN_DEVELOPMENT.md's "Isolated plugins" section for the ctx surface
// this hands a plugin's activate(ctx) — this file is the reference
// implementation of that contract, not just an internal detail.
const path = require('path');
const { createRpc } = require('./rpc-channel');
const { mimeFor } = require('./main-mime');
const { readJsonBody, serveStaticFile } = require('./main-http-util');
const { getLanAddresses } = require('./main-lan');
const { createLanAccess, isLanServiceEnabled } = require('./main-lan-security');
const {
  capabilityError, allowedSetsFor, createCheckedSpawn, createCheckedServer, createCheckedFs,
} = require('./main-plugin-capabilities');
// Pure Node npm packages, no Electron dependency — same reasoning as
// getLanAddresses/getViewerUrls above: an isolated plugin's process can
// require() these fresh right here rather than needing them proxied over
// RPC. Missing from this file's ctx (see buildCtx() below) was a real bug —
// party-channel (manifest.json: "isolated": true) destructures both from
// ctx, so its QR code (QRCode.toDataURL) and party-page photo/video upload
// parsing (busboy) were silently failing in every isolated run: the
// undefined reference threw inside a try/catch that swallows the error and
// returns an empty result, so nothing surfaced as a visible error anywhere
// — found live as "the party channel's QR code never displays."
const QRCode = require('qrcode');
const busboy = require('busboy');

const rpc = createRpc(
  (msg) => process.parentPort.postMessage(msg),
  (cb) => process.parentPort.on('message', (e) => cb(e.data)),
);

const ipcHandleFns = new Map();
const ipcOnFns = new Map();
const beforeQuitListeners = [];
const serviceProviderFns = new Map(); // key -> fn, for ctx.registerService()
const partyRouteHandlers = []; // [{method, pathname, handler}], for ctx.registerPartyRoute()

rpc.handle('ipc:call', async ({ channel, args }) => {
  const fn = ipcHandleFns.get(channel);
  if (!fn) throw new Error(`Isolated plugin has no local handler for ipc channel "${channel}"`);
  // The real ipcMain.handle(channel, fn) signature is fn(event, ...args) — no
  // real IpcMainInvokeEvent crosses this boundary (it's not serializable and
  // no plugin here actually uses it), so `event` is always null.
  return fn(null, ...(args || []));
});
rpc.on('ipc:on-fire', ({ channel, args }) => {
  const fn = ipcOnFns.get(channel);
  if (fn) fn(null, ...(args || []));
});
rpc.on('app:before-quit', () => {
  beforeQuitListeners.forEach((fn) => { try { fn(); } catch (e) { /* one bad listener shouldn't block the others */ } });
});
rpc.handle('services:invoke', async ({ key, args }) => {
  const fn = serviceProviderFns.get(key);
  if (!fn) throw new Error(`Isolated plugin has no local service provider for "${key}"`);
  return fn(...(args || []));
});
rpc.handle('party:invokeRoute', async (reqDescriptor) => {
  const route = partyRouteHandlers.find((r) => r.method === reqDescriptor.method && r.pathname === reqDescriptor.pathname);
  if (!route) throw new Error(`Isolated plugin has no route registered for ${reqDescriptor.method} ${reqDescriptor.pathname}`);
  return route.handler(reqDescriptor);
});

// The spawn/createServer/fs capability-checking below is shared with
// buildCheckedCtx() in main-plugins.js (the same-process path used by
// non-isolated plugins) via main-plugin-capabilities.js — see that file's
// header comment. The JS-level check is still worth doing here even though
// --experimental-permission (main-plugin-isolation.js's execArgv) also
// enforces fs-read/fs-write/child-process at the OS level, because the
// permission model's granularity stops at "can spawn a child process at
// all," not "can spawn THIS specific binary" — the per-binary check still
// matters and can only happen here.
function buildCtx(manifest, pluginDir, init) {
  const { allowedIpc, allowedSpawn, allowedPorts } = allowedSetsFor(manifest.capabilities);
  const dataDir = init.dataDir || null;

  // ctx.services stays a plain values-only store, seeded from whatever the
  // host had already published (from earlier-activated plugins, same-process
  // or isolated alike) at the moment this plugin was forked — safe because
  // activation is still strictly sequential per dependsOn order (see
  // main-plugin-isolation.js), so a publisher genuinely always finishes
  // activating before a dependent reader is even forked. A plugin publishing
  // a value here (`ctx.services.x = "..."`) only updates this process's own
  // local copy AND tells the host, for the NEXT plugin's snapshot — it does
  // NOT retroactively update any process already running. Function-valued
  // capabilities (the one case that can't be snapshotted as a value) use
  // ctx.registerService()/ctx.callService() instead — see below.
  const services = new Proxy({ ...(init.servicesSnapshot || {}) }, {
    set(target, prop, value) {
      target[prop] = value;
      rpc.emit('services:publish', { key: prop, value });
      return true;
    },
  });

  return {
    pluginDir,
    app: {
      on(event, fn) {
        if (event !== 'before-quit') return;
        beforeQuitListeners.push(fn);
        rpc.emit('app:on-before-quit-register', {});
      },
    },
    ipcMain: {
      handle(channel, fn) {
        if (!allowedIpc.has(channel)) throw capabilityError(manifest.id, 'register IPC channel', channel, 'ipc');
        ipcHandleFns.set(channel, fn);
        rpc.emit('ipc:handle-register', { channel });
      },
      on(channel, fn) {
        if (!allowedIpc.has(channel)) throw capabilityError(manifest.id, 'register IPC channel', channel, 'ipc');
        ipcOnFns.set(channel, fn);
        rpc.emit('ipc:on-register', { channel });
      },
    },
    shell: { openExternal: (url) => rpc.request('shell:openExternal', { url }) },
    desktopCapturer: { getSources: (opts) => rpc.request('desktopCapturer:getSources', { opts }) },
    // Replaces the old getMainWindow() + "mainWindow && !mainWindow.isDestroyed()"
    // dance every same-process plugin used to do before every
    // webContents.send() — there's no real BrowserWindow handle to hand
    // across a process boundary, and the host already safely no-ops this if
    // the window is gone, so there's nothing left for the plugin to check.
    sendToMainWindow: (channel, data) => rpc.emit('sendToMainWindow', { channel, data }),
    fetchJsonCached: (key, url, opts, ttlMs) => rpc.request('fetchJsonCached', { key, url, opts, ttlMs }),
    loadConfig: () => rpc.request('loadConfig', {}),
    trackConnection: (serverName, req) => {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      rpc.emit('trackConnection', { serverName, ip, userAgent: req.headers['user-agent'] || '' });
    },
    mimeFor,
    readJsonBody,
    serveStatic: serveStaticFile,
    getLanAddresses,
    getViewerUrls: () => init.viewerUrls || [],
    createLanAccess,
    isLanServiceEnabled,
    QRCode,
    busboy,
    remotePort: init.remotePort,
    ffmpegStaticPath: init.ffmpegStaticPath,
    services,
    registerService(key, fn) {
      serviceProviderFns.set(key, fn);
      rpc.emit('services:registerProvider', { key });
    },
    callService(key, ...args) { return rpc.request('services:call', { key, args }); },
    registerPartyRoute(method, pathname, handler) {
      partyRouteHandlers.push({ method, pathname, handler });
      rpc.emit('party:registerRoute', { method, pathname });
    },
    dispatchPartyRoute(reqDescriptor) { return rpc.request('party:dispatchRoute', reqDescriptor); },
    spawn: createCheckedSpawn(manifest.id, allowedSpawn),
    createServer: createCheckedServer(manifest.id, allowedPorts),
    fs: createCheckedFs(manifest.id, dataDir),
  };
}

async function main() {
  // Register the method listener before announcing readiness. The transport
  // listener already exists after createRpc(), but that alone is not enough:
  // createRpc intentionally drops an event whose method listener does not
  // exist yet. A fast host could answer runtime-ready with init while this
  // process was descheduled between emit() and new Promise(), losing init
  // forever and leaving activation stuck until the host timeout.
  const initPromise = new Promise((resolve) => {
    rpc.on('init', (payload) => resolve(payload));
  });
  rpc.emit('runtime-ready', {});
  const init = await initPromise;

  let result;
  try {
    const manifest = init.manifest;
    const pluginDir = init.pluginDir;
    const mainPath = path.join(pluginDir, manifest.main);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(mainPath);
    const ctx = buildCtx(manifest, pluginDir, init);
    if (mod && typeof mod.activate === 'function') {
      await mod.activate(ctx);
    }
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: (e && e.stack) || String(e) };
  }
  rpc.emit('activate-result', result);
}

main();

// A plugin process that throws outside of activate() (a stray unhandled
// rejection in a spawned child's own callback, etc.) shouldn't take down the
// whole app — it already can't, since it's a separate OS process — but it
// should at least exit cleanly rather than hang as a zombie the host has to
// notice via its own 'exit' listener.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[plugin-isolation-runtime] uncaught exception: ${err && err.stack}\n`);
});
