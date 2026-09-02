const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { startViewerServer } = require('../main/main-viewer-server');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const { body, ...requestOptions } = options;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, ...requestOptions }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('headless dashboard is loopback-ready and stops only with its page token', async () => {
  let stopRequests = 0;
  let pairingChecks = 0;
  const runtime = startViewerServer({}, {
    host: '127.0.0.1',
    port: 0,
    access: {
      pairingCode: '123456',
      authorize: async () => { pairingChecks += 1; return false; },
    },
    getControlState: () => ({
      viewerUrls: [{ name: 'Ethernet', url: 'http://192.168.1.2:8724/?pair=example' }],
    }),
    requestStop: () => { stopRequests += 1; },
  });

  try {
    assert.equal(await runtime.ready, true);
    const port = runtime.server.address().port;
    const dashboard = await request(port, '/server');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.body, /RERUNTV SERVER/);
    assert.match(dashboard.body, /123456/);
    assert.match(dashboard.body, /192\.168\.1\.2:8724/);
    assert.equal(pairingChecks, 0, 'loopback dashboard should not enter viewer pairing');

    const denied = await request(port, '/server/stop', { method: 'POST' });
    assert.equal(denied.status, 405);
    assert.equal(stopRequests, 0);

    const token = dashboard.body.match(/X-RerunTV-Control':'([^']+)'/)?.[1];
    assert.ok(token, 'dashboard contains a one-time local stop token');
    const accepted = await request(port, '/server/stop', {
      method: 'POST', headers: { 'X-RerunTV-Control': token },
    });
    assert.equal(accepted.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopRequests, 1);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
  }
});

test('viewer pairing page supports the native Android TV keyboard', async () => {
  const runtime = startViewerServer({}, { host: '127.0.0.1', port: 0 });
  try {
    assert.equal(await runtime.ready, true);
    const response = await request(runtime.server.address().port, '/');
    assert.equal(response.status, 200);
    assert.match(response.body, /autofocus/);
    assert.match(response.body, /inputmode="numeric"/);
    assert.match(response.body, /Select the code box with OK to use your TV keyboard/);
    assert.match(response.body, /type="submit">PAIR DEVICE/);
    assert.match(response.body, /@media\(min-width:900px\)/);
    assert.doesNotMatch(response.body, /class="keypad"/);
    assert.doesNotMatch(response.body, /new KeyboardEvent/);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
  }
});

test('headless viewer bridges TV state and Companion remote commands', async () => {
  const services = {};
  const runtime = startViewerServer(services, {
    host: '127.0.0.1',
    port: 0,
    access: { authorize: async () => true },
  });
  try {
    assert.equal(await runtime.ready, true);
    const port = runtime.server.address().port;
    const initial = JSON.parse((await request(port, '/api/remote-events')).body);
    assert.deepEqual(initial, { cursor: 0, events: [] });

    assert.equal(services.viewerRemoteBridge.publish('remote:command', { key: 'g' }), true);
    const queued = JSON.parse((await request(port, `/api/remote-events?after=${initial.cursor}`)).body);
    assert.equal(queued.events.length, 1);
    assert.deepEqual(queued.events[0], {
      sequence: 1,
      channel: 'remote:command',
      data: { key: 'g' },
    });

    const state = JSON.stringify({ number: 5, name: 'Cartoons', powered: true });
    const posted = await request(port, '/api/remote-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(state) },
      body: state,
    });
    assert.equal(posted.status, 204);
    assert.deepEqual(services.viewerRemoteBridge.getState(), { number: 5, name: 'Cartoons', powered: true });
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
  }
});

test('LAN viewer boot guards host-only Companion event subscriptions', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'app.js'), 'utf8');
  assert.match(appJs, /window\.api\.onCompanionApplySettings\?\.\(/);
  assert.match(appJs, /window\.api\.onCompanionTriggerNews\?\.\(/);
  assert.match(appJs, /window\.api\.onCompanionSetTicker\?\.\(/);
});

test('browser viewer relays state and polls headless remote events', () => {
  const shim = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'browser-api-shim.js'), 'utf8');
  const companion = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'companion-app', 'main.js'), 'utf8');
  assert.match(shim, /fetch\('\/api\/remote-state'/);
  assert.match(shim, /fetch\(`\/api\/remote-events/);
  assert.match(shim, /onViewerEvent\('remote:command'/);
  assert.match(companion, /bridge\.publish\(channel, data\)/);
  assert.match(companion, /viewerRemoteBridge/);
});

test('Android TV viewport setup is allowed by the renderer CSP', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const viewportScript = fs.readFileSync(path.join(root, 'renderer', 'js', 'tv-client-viewport.js'), 'utf8');
  assert.match(html, /<script src="js\/tv-client-viewport\.js"><\/script>/);
  assert.match(viewportScript, /RerunTV-AndroidTV/);
  assert.match(viewportScript, /width=1920/);
});

test('companion remote exposes explicit setup exit and interface scale choices', () => {
  const root = path.join(__dirname, '..');
  const remoteHtml = fs.readFileSync(path.join(root, 'plugins', 'companion-app', 'remote', 'index.html'), 'utf8');
  const remoteJs = fs.readFileSync(path.join(root, 'plugins', 'companion-app', 'remote', 'remote.js'), 'utf8');
  const pluginMain = fs.readFileSync(path.join(root, 'plugins', 'companion-app', 'main.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'renderer', 'js', 'app.js'), 'utf8');

  assert.match(remoteHtml, /data-action="watch-tv"/);
  assert.match(remoteJs, /display\.uiScale/);
  assert.match(remoteJs, /action: 'watch-tv'/);
  assert.match(pluginMain, /body\?\.action === 'watch-tv'/);
  assert.match(appJs, /cmd\?\.action === 'watch-tv'/);
  assert.match(appJs, /setUiScale\?\./);
});

test('packaged installs include launchers that target the installed executable', () => {
  const root = path.join(__dirname, '..');
  const builder = fs.readFileSync(path.join(root, 'electron-builder.config.js'), 'utf8');
  const serverLauncher = fs.readFileSync(path.join(root, 'run-server.bat'), 'utf8');
  const headlessLauncher = fs.readFileSync(path.join(root, 'run-headless.bat'), 'utf8');

  assert.match(builder, /extraFiles:\s*\['run-server\.bat', 'run-headless\.bat'\]/);
  assert.match(serverLauncher, /RerunTV\.exe" --server/);
  assert.match(headlessLauncher, /RerunTV\.exe" --headless/);
});

test('Windows startup launches server control mode and keeps the updater gate', () => {
  const root = path.join(__dirname, '..');
  const startup = fs.readFileSync(path.join(root, 'main', 'main-startup-server.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'main', 'preload.js'), 'utf8');

  assert.match(startup, /STARTUP_ARGS\s*=\s*Object\.freeze\(\['--server', '--login-startup'\]\)/);
  assert.match(startup, /app\.setLoginItemSettings/);
  assert.match(startup, /app\.getLoginItemSettings/);
  assert.match(main, /const STARTUP_UPDATE_UI = !HEADLESS \|\| SERVER_CONTROL/);
  assert.match(main, /if \(STARTUP_UPDATE_UI\)[\s\S]*initAutoUpdater/);
  assert.match(preload, /startupServer:getStatus/);
  assert.match(preload, /startupServer:setEnabled/);
});

test('Windows startup remains checked when Electron drops login-item arguments on readback', () => {
  const electronPath = require.resolve('electron');
  const originalElectron = require.cache[electronPath];
  require.cache[electronPath] = { exports: { app: {} } };
  const modulePath = require.resolve('../main/main-startup-server');
  delete require.cache[modulePath];
  const { statusFromLoginSettings } = require(modulePath);
  delete require.cache[modulePath];
  if (originalElectron) require.cache[electronPath] = originalElectron;
  else delete require.cache[electronPath];

  const status = statusFromLoginSettings({
    openAtLogin: false,
    executableWillLaunchAtLogin: true,
    launchItems: [{
      name: 'RerunTV Server',
      path: 'C:\\Users\\Example\\RerunTV.exe',
      args: [],
      enabled: true,
    }],
  }, 'c:\\users\\example\\reruntv.exe');

  assert.deepEqual(status, { enabled: true, launchAllowed: true });
});

test('isolated plugin handshake listeners are installed before readiness events can race', () => {
  const root = path.join(__dirname, '..');
  const host = fs.readFileSync(path.join(root, 'main', 'main-plugin-isolation.js'), 'utf8');
  const child = fs.readFileSync(path.join(root, 'main', 'plugin-isolation-runtime.js'), 'utf8');

  const hostListener = host.indexOf("childRpc.on('runtime-ready'");
  const hostResultListener = host.indexOf("childRpc.on('activate-result'");
  const hostHandlers = host.lastIndexOf('registerChildInitiatedHandlers(childRpc');
  assert.ok(hostListener !== -1 && hostListener < hostHandlers);
  assert.ok(hostResultListener !== -1 && hostResultListener < hostHandlers);

  const childListener = child.indexOf("rpc.on('init'");
  const childReady = child.indexOf("rpc.emit('runtime-ready'");
  assert.ok(childListener !== -1 && childListener < childReady);
});

test('isolated plugin service snapshots omit host-only function bridges', () => {
  const { cloneableServiceSnapshot } = require('../main/rpc-channel');
  const snapshot = cloneableServiceSnapshot({
    ffmpegPath: 'C:\\ffmpeg.exe',
    viewerUrls: [{ url: 'http://127.0.0.1:8724' }],
    viewerRemoteBridge: { sendCommand() {} },
  });

  assert.deepEqual(snapshot, {
    ffmpegPath: 'C:\\ffmpeg.exe',
    viewerUrls: [{ url: 'http://127.0.0.1:8724' }],
  });
});
