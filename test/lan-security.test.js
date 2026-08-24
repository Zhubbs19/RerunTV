const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createLanAccess, isLanServiceEnabled } = require('../main/main-lan-security');
const { createViewerProjection } = require('../main/main-viewer-projection');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('LAN services are opt-in', () => {
  assert.equal(isLanServiceEnabled({}, 'viewer'), false);
  assert.equal(isLanServiceEnabled({ network: { viewerEnabled: true } }, 'viewer'), true);
  assert.equal(isLanServiceEnabled({ party: { enabled: true } }, 'party'), true);
});

test('pairing exchanges a short code for an HttpOnly session and rate limits it', async (t) => {
  const access = createLanAccess('test', { readLimit: 2, writeLimit: 10 });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!(await access.authorize(req, res, url))) return;
    res.writeHead(200).end('private');
  });
  t.after(() => server.close());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const unpaired = await fetch(base);
  assert.match(await unpaired.text(), /pairing code/i);

  const paired = await fetch(access.pairingUrl(base), { redirect: 'manual' });
  assert.equal(paired.status, 303);
  const cookie = paired.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);

  const ok = await fetch(base, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(ok.status, 200);
  const second = await fetch(base, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(second.status, 200);
  const limited = await fetch(base, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(limited.status, 429);
});

test('viewer projection removes credentials and replaces media references with opaque ids', () => {
  const projection = createViewerProjection(Buffer.alloc(32, 7));
  const rawPath = 'C:\\Users\\person\\Videos\\Show\\episode-01.mp4';
  const projected = projection.project({
    apiToken: 'secret', display: { customCssPath: 'C:\\private.css' },
    party: { soundboardFolder: 'C:\\sounds' },
    channels: [{ files: [{ path: rawPath, duration: 123 }], folders: [{ id: 'folder-1', source: 'local', ref: 'C:\\Users\\person\\Videos' }] }],
  });
  const text = JSON.stringify(projected);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('C:\\\\Users'), false);
  assert.equal(projected.display.customCssPath, null);
  assert.equal(projected.channels[0].files[0].title, 'episode-01');
  assert.match(projected.channels[0].files[0].path, /^viewer:/);
  assert.equal(projection.resolve(projected.channels[0].files[0].path), rawPath);
  assert.equal(projection.resolve(rawPath), null);
});

test('viewer HTTP serves renderer and plugin assets only after pairing', async (t) => {
  const root = path.join(__dirname, '..');
  const originalLoad = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (request === './main-config' && /main-viewer-server\.js$/.test(parent.filename)) {
      return { loadConfig: () => ({ channels: [] }) };
    }
    if (request === './main-connections' && /main-viewer-server\.js$/.test(parent.filename)) {
      return { trackConnection() {} };
    }
    if (request === './main-protocol' && /main-viewer-server\.js$/.test(parent.filename)) {
      return {
        serveFile: async (file) => {
          try { return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) }; }
          catch (e) { return { status: 404, headers: {}, body: Buffer.from('Not found') }; }
        },
        serveMediaRef: async () => ({ status: 404, headers: {}, body: Buffer.from('Not found') }),
        pipeWebResponse: async (response, res) => res.writeHead(response.status, response.headers).end(response.body),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const serverModulePath = path.join(root, 'main', 'main-viewer-server.js');
  delete require.cache[require.resolve(serverModulePath)];
  const { startViewerServer } = require(serverModulePath);
  Module._load = originalLoad;

  const runtime = startViewerServer({}, {
    port: 0, host: '127.0.0.1', pluginsDir: path.join(root, 'plugins'),
    listPlugins: () => [{ id: 'breaking-news' }],
    loadConfig: () => ({ apiKey: 'hidden', channels: [{ files: [{ path: 'C:\\private\\episode.mp4' }] }] }),
  });
  t.after(() => runtime.server.close());
  await new Promise((resolve) => runtime.server.once('listening', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;

  const denied = await fetch(base);
  assert.match(await denied.text(), /pairing code/i);
  const paired = await fetch(runtime.access.pairingUrl(base), { redirect: 'manual' });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie };
  const renderer = await fetch(base, { headers });
  assert.equal(renderer.status, 200);
  assert.match(await renderer.text(), /<!DOCTYPE html>/i);
  const pluginAsset = await fetch(`${base}/plugins/breaking-news/manifest.json`, { headers });
  assert.equal(pluginAsset.status, 200);
  const config = await (await fetch(`${base}/api/config`, { headers })).json();
  assert.equal(JSON.stringify(config).includes('hidden'), false);
  assert.match(config.channels[0].files[0].path, /^viewer:/);
  const rawPathAttempt = await fetch(`${base}/media?p=${encodeURIComponent('C:\\private\\episode.mp4')}`, { headers });
  assert.equal(rawPathAttempt.status, 400);
});
