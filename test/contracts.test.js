const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

test('every plugin manifest entry points to an existing file', () => {
  for (const base of [path.join(ROOT, 'plugins'), path.join(ROOT, 'plugin-dev-kit', 'starter-plugin')]) {
    const dirs = base.endsWith('starter-plugin') ? [base]
      : fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name));
    for (const dir of dirs) {
      const manifestPath = path.join(dir, 'manifest.json');
      assert.ok(fs.existsSync(manifestPath), `${dir} is missing manifest.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(typeof manifest.id, 'string', `${manifestPath} needs an id`);
      for (const key of ['main', 'renderer', 'settings', 'style']) {
        if (manifest[key]) assert.ok(fs.existsSync(path.join(dir, manifest[key])), `${manifest.id}.${key} is missing ${manifest[key]}`);
      }
    }
  }
});

test('every bundled theme defines the P3 setup-shell tokens', () => {
  const themeDirs = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('theme-'));
  assert.equal(themeDirs.length, 18);
  for (const entry of themeDirs) {
    const stylePath = path.join(ROOT, 'plugins', entry.name, 'style.css');
    const css = fs.readFileSync(stylePath, 'utf8');
    assert.match(css, /--setup-nav-bg\s*:/, `${entry.name} is missing --setup-nav-bg`);
    assert.match(css, /--setup-overflow-shadow\s*:/, `${entry.name} is missing --setup-overflow-shadow`);
  }
});

test('bundled seeding upgrades an old ledger and refreshes changed app-owned files', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-seed-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const originalLoad = Module._load;
  const electron = {
    app: { getPath: () => temp }, ipcMain: {}, shell: {}, desktopCapturer: {}, utilityProcess: {},
  };
  Module._load = function mocked(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  const modulePath = path.join(ROOT, 'main', 'main-plugins.js');
  delete require.cache[require.resolve(modulePath)];
  const pluginModule = require(modulePath);
  const { seedBundledPlugins } = pluginModule;
  seedBundledPlugins();
  const id = 'breaking-news';
  const installed = path.join(temp, 'plugins', id, 'manifest.json');
  fs.writeFileSync(installed, '{"broken":true}');
  fs.writeFileSync(path.join(temp, 'plugins', '.bundled-manifest.json'), JSON.stringify([id]));
  seedBundledPlugins();
  assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(path.join(ROOT, 'plugins', id, 'manifest.json')));
  const ledger = JSON.parse(fs.readFileSync(path.join(temp, 'plugins', '.bundled-manifest.json'), 'utf8'));
  assert.equal(ledger.version, 2);
  assert.match(ledger.plugins[id], /^[a-f0-9]{64}$/);
  fs.appendFileSync(installed, '\n');
  let entry = pluginModule.discoverPlugins().find((p) => p.id === id);
  assert.equal(entry.bundled, true);
  assert.equal(entry.integrityStatus, 'modified');
  pluginModule.recordPluginIntegrity(id, entry.integrityHash);
  entry = pluginModule.discoverPlugins().find((p) => p.id === id);
  assert.equal(entry.integrityStatus, 'verified');
});

test('third-party integrity changes move from unverified to verified to blocked', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-integrity-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const pluginsDir = path.join(temp, 'plugins');
  const pluginDir = path.join(pluginsDir, 'sample-third-party');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin-dev-kit', 'starter-plugin'), pluginDir, { recursive: true });
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.id = 'sample-third-party';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const originalLoad = Module._load;
  const electron = { app: { getPath: () => temp }, ipcMain: {}, shell: {}, desktopCapturer: {}, utilityProcess: {} };
  Module._load = function mocked(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = path.join(ROOT, 'main', 'main-plugins.js');
  delete require.cache[require.resolve(modulePath)];
  const plugins = require(modulePath);
  Module._load = originalLoad;

  let entry = plugins.discoverPlugins().find((p) => p.id === manifest.id);
  assert.equal(entry.integrityStatus, 'unverified');
  plugins.recordPluginIntegrity(entry.id, entry.integrityHash);
  entry = plugins.discoverPlugins().find((p) => p.id === manifest.id);
  assert.equal(entry.integrityStatus, 'verified');
  fs.appendFileSync(path.join(pluginDir, 'renderer.js'), '\n// changed after trust\n');
  entry = plugins.discoverPlugins().find((p) => p.id === manifest.id);
  assert.equal(entry.integrityStatus, 'modified');
});

function loadPreloadApi(t) {
  let exposed;
  const originalLoad = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (request === 'electron') return {
      contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'api') exposed = value; } },
      ipcRenderer: { invoke() {}, on() {}, send() {} },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  const preloadPath = path.join(ROOT, 'main', 'preload.js');
  delete require.cache[require.resolve(preloadPath)];
  require(preloadPath);
  return exposed;
}

function loadBrowserApi() {
  const sandbox = {
    window: {}, console, fetch: () => Promise.reject(new Error('not called')),
    document: { fullscreenElement: null, documentElement: {}, exitFullscreen() {} },
    screen: { orientation: {} }, Promise, Error,
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'api-contract.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'browser-api-shim.js'), 'utf8'), sandbox);
  return sandbox.window.api;
}

test('preload and generated browser viewer match the shared API contract', (t) => {
  const contract = require(path.join(ROOT, 'renderer', 'js', 'api-contract.js'));
  const preloadKeys = Object.keys(loadPreloadApi(t));
  const browserKeys = Object.keys(loadBrowserApi());
  const contractKeys = Object.keys(contract.methods);
  const viewerKeys = contractKeys.filter((key) => contract.methods[key].viewer !== 'host-only');
  assert.deepEqual(preloadKeys.sort(), contractKeys.sort());
  assert.deepEqual(browserKeys.sort(), viewerKeys.sort());
});

test('plugin registration is awaited before the first TV tune path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'app.js'), 'utf8');
  const loadAt = source.indexOf('await loadPlugins();');
  const firstViewerTuneAt = source.indexOf('if (window.__isViewer)', loadAt);
  const firstHostTuneAt = source.indexOf('showTvScreen();', firstViewerTuneAt);
  assert.ok(loadAt >= 0 && firstViewerTuneAt > loadAt && firstHostTuneAt > loadAt);
});

test('untrusted plugin UI and CSS are blocked in both renderer load phases', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'plugins.js'), 'utf8');
  assert.equal((source.match(/needsIntegrityApproval/g) || []).length >= 2, true);
});
