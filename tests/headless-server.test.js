const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { startViewerServer } = require('../main/main-viewer-server');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
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
