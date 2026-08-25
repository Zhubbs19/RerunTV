const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

test('support bundle redaction removes secrets, authorization, and user-specific paths', () => {
  const { redactDiagnosticValue } = require(path.join(ROOT, 'main', 'main-diagnostics.js'));
  const redacted = redactDiagnosticValue({
    token: 'raw-token',
    nested: { authorization: 'Bearer abcdefghijklmnop', message: 'failed at C:\\Users\\Casey\\Videos\\show.mkv' },
    url: 'https://person:password@example.test/path',
  }, { homePath: 'C:\\Users\\Casey' });
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.nested.authorization, '[REDACTED]');
  assert.match(redacted.nested.message, /\[USER_PATH\]/);
  assert.doesNotMatch(redacted.url, /person:password/);
});
const { compareConfigs } = require('../main/config-diff');

test('backup comparison reports channel, schedule, and settings changes', () => {
  const current = { theme: 'old', channels: [{ number: 2, name: 'TWO', files: [{}], blocks: [] }, { number: 4, name: 'REMOVE', files: [], blocks: [] }] };
  const snapshot = { theme: 'new', channels: [{ number: 2, name: 'TWO HD', files: [{}, {}], blocks: [{ id: 'prime' }] }, { number: 7, name: 'ADD', files: [], blocks: [] }] };
  const diff = compareConfigs(current, snapshot);
  assert.equal(diff.addedChannels[0].number, 7);
  assert.equal(diff.removedChannels[0].number, 4);
  assert.equal(diff.renamedChannels[0].to, 'TWO HD');
  assert.equal(diff.fileCountChanges[0].snapshot, 2);
  assert.equal(diff.scheduleChanges[0].number, 2);
  assert.deepEqual(diff.settingsChanges, ['theme']);
});

test('packaged startup awaits the updater gate before creating the full window', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  const updaterCall = main.indexOf('await initAutoUpdater');
  const windowCall = main.indexOf('createWindow();', updaterCall);
  assert.ok(updaterCall >= 0, 'main startup must await initAutoUpdater');
  assert.ok(windowCall > updaterCall, 'full window must be created after the updater gate');
  assert.match(main.slice(updaterCall, windowCall), /if \(installingUpdate\) return;/);
});

test('deploy releases describe the changes in the exact commit being built', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-installer.yml'), 'utf8');
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /--target "\$\{\{ github\.sha \}\}"/);
  assert.doesNotMatch(workflow, /Automated alpha build from deploy branch/);
});

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
  assert.equal(themeDirs.length, 22);
  for (const entry of themeDirs) {
    const stylePath = path.join(ROOT, 'plugins', entry.name, 'style.css');
    const css = fs.readFileSync(stylePath, 'utf8');
    assert.match(css, /--setup-nav-bg\s*:/, `${entry.name} is missing --setup-nav-bg`);
    assert.match(css, /--setup-overflow-shadow\s*:/, `${entry.name} is missing --setup-overflow-shadow`);
  }
});

test('theme registration ids match their scoped CSS selectors', () => {
  const themeDirs = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('theme-'));
  for (const entry of themeDirs) {
    const dir = path.join(ROOT, 'plugins', entry.name);
    const renderer = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
    const match = renderer.match(/registerThemePack\(['"]([^'"]+)['"]/);
    assert.ok(match, `${entry.name} does not register a theme pack`);
    assert.match(css, new RegExp(`data-theme=["']${match[1]}["']`), `${entry.name} CSS does not target ${match[1]}`);
  }
});

test('guide exposes semantic composition tokens for theme plugins', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'tokens.css'), 'utf8');
  const guide = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'guide.css'), 'utf8');
  for (const name of ['grid-bg', 'channel-bg', 'channel-fg', 'program-bg', 'program-alt-bg', 'selection-bg', 'selection-fg', 'timebar-bg', 'row-height', 'row-gap']) {
    assert.match(tokens, new RegExp(`--guide-${name}\\s*:`), `tokens.css is missing --guide-${name}`);
    assert.match(guide, new RegExp(`var\\(--guide-${name}`), `guide.css does not consume --guide-${name}`);
  }
});

test('opening the guide starts in grid navigation instead of search mode', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const guide = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'guide.js'), 'utf8');
  assert.match(markup, /id="guide-grid"[^>]*tabindex="-1"/);
  assert.match(guide, /requestAnimationFrame\(\(\) => guideGrid\.focus\(\{ preventScroll: true \}\)\)/);
  assert.doesNotMatch(guide, /requestAnimationFrame\(\(\) => guideSearchEl\.focus/);
  assert.match(guide, /if \(e\.key === '\/'\)[\s\S]*?guideSearchEl\.focus\(\)/);
});

test('plugin catalog scales with category, state, and text filters', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const plugins = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-plugins.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  assert.match(markup, /id="plugins-state-filter"/);
  assert.match(markup, /id="plugins-results-count"/);
  assert.match(plugins, /pluginsStateFilterEl/);
  assert.match(plugins, /matchesState/);
  assert.match(plugins, /plugin-row-status/);
  assert.match(css, /grid-template-columns:\s*repeat\(2/);
});

test('research-driven cable themes use neutral names and behavioral identity', () => {
  const themeDirs = [
    'theme-passport-03', // legacy internal id retained for stored-config compatibility
    'theme-aqua-grid-06', 'theme-slate-grid-10', 'theme-dark-grid-12',
    'theme-widescreen-grid-13', 'theme-cloud-guide-16',
  ];
  for (const dirName of themeDirs) {
    const dir = path.join(ROOT, 'plugins', dirName);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const renderer = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
    assert.doesNotMatch(`${manifest.name}\n${manifest.description}`, /passport|pioneer|i-guide|contour|optimum|navigator black/i);
    assert.match(renderer, /channelChangeSfx/);
    assert.match(renderer, /powerSfx/);
    assert.match(css, /\.guide-overlay/);
    assert.match(css, /\.channel-entry/);
    assert.match(css, /\.tv-menu-btn:focus-visible/);
    assert.match(css, /:is\(\.btn, \.setup-tab-btn, \.setup-subtab-btn/);
    assert.match(css, /:is\(input, select, textarea\):focus/);
  }
});

test('theme selection is searchable and theme plugins expose font overrides', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const pluginSettings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-plugin-settings.js'), 'utf8');
  const themes = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'themes.js'), 'utf8');
  assert.match(markup, /id="theme-browser-search"/);
  assert.match(markup, /id="theme-browser-close"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-controls="theme-browser"/);
  assert.match(settings, /renderThemeBrowser/);
  assert.match(settings, /aria-pressed/);
  assert.match(settings, /event\.key === 'Tab'/);
  assert.match(settings, /theme-browser-open/);
  assert.match(pluginSettings, /THEME TYPOGRAPHY/);
  assert.match(pluginSettings, /themeFontOverrides/);
  assert.match(themes, /themeFontOverrides/);
});

test('every bundled theme provides tuning and power sound identity', () => {
  const themeDirs = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('theme-'));
  for (const entry of themeDirs) {
    const renderer = fs.readFileSync(path.join(ROOT, 'plugins', entry.name, 'renderer.js'), 'utf8');
    assert.match(renderer, /channelChangeSfx/, `${entry.name} is missing a channel-change sound`);
    assert.match(renderer, /powerSfx/, `${entry.name} is missing a power sound`);
  }
});

test('theme controls preserve semantic button states and expose motion identity', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'tokens.css'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  for (const token of ['button-fg', 'button-primary-fg', 'button-danger-fg', 'button-disabled-fg',
    'motion-control-duration', 'motion-control-ease', 'motion-control-hover',
    'motion-control-active', 'motion-card-duration', 'motion-card-ease',
    'motion-digit-duration', 'motion-digit-ease']) {
    assert.match(tokens, new RegExp(`--${token}\\s*:`), `tokens.css is missing --${token}`);
  }
  assert.match(setup, /html\[data-theme\] \.btn\.btn-primary/);
  assert.match(setup, /html\[data-theme\] \.btn\.btn-danger/);
  assert.match(setup, /html\[data-theme\] \.btn:disabled/);

  const themeDirs = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('theme-'));
  for (const entry of themeDirs) {
    const css = fs.readFileSync(path.join(ROOT, 'plugins', entry.name, 'style.css'), 'utf8');
    for (const token of ['motion-control-duration', 'motion-control-ease', 'motion-control-hover',
      'motion-control-active', 'motion-card-duration', 'motion-card-ease',
      'motion-digit-duration', 'motion-digit-ease']) {
      assert.match(css, new RegExp(`--${token}\\s*:`), `${entry.name} is missing --${token}`);
    }
  }
});

test('every bundled theme exposes complete selection and composition metadata', () => {
  const themeDirs = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('theme-'));
  for (const entry of themeDirs) {
    const dir = path.join(ROOT, 'plugins', entry.name);
    const renderer = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
    assert.match(renderer, /group\s*:/, `${entry.name} has no theme-browser group`);
    assert.match(renderer, /preview\s*:\s*\{[^}]*background\s*:[^}]*accent\s*:[^}]*secondary\s*:/s,
      `${entry.name} has no representative three-color preview`);
    assert.match(css, /--font-body\s*:/, `${entry.name} has no readable body-font choice`);
    assert.match(css, /--radius-sm\s*:/, `${entry.name} has no explicit control geometry`);
    for (const token of ['grid-bg', 'channel-bg', 'channel-fg', 'channel-subtle', 'program-bg',
      'program-alt-bg', 'selection-bg', 'selection-fg', 'timebar-bg', 'row-height', 'row-gap']) {
      assert.match(css, new RegExp(`--guide-${token}\\s*:`), `${entry.name} is missing --guide-${token}`);
    }
  }
});

test('theme browser paints swatches from each theme preview rather than the active theme', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  assert.match(settings, /--theme-preview-bg/);
  assert.match(settings, /--theme-preview-accent/);
  assert.match(settings, /--theme-preview-secondary/);
  assert.match(css, /var\(--theme-preview-bg\)/);
  assert.match(css, /var\(--theme-preview-accent\)/);
  assert.match(css, /var\(--theme-preview-secondary\)/);
});

test('sticky setup navigation only paints its opaque theme surface after sticking', () => {
  const setup = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  assert.match(setup, /syncSetupNavStickySurface/);
  assert.match(setup, /classList\.toggle\('is-stuck'/);
  assert.match(css, /\.setup-nav\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(css, /\.setup-nav::before[\s\S]*?background:\s*var\(--setup-nav-bg\)/);
  assert.match(css, /\.setup-nav\.is-stuck::before\s*\{\s*opacity:\s*1/);
  assert.match(css, /0 0 0 100vmax var\(--setup-nav-bg\)/);
  assert.match(css, /top:\s*-24px/);
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

test('channel display mode is applied before virtual channels can return', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'playback.js'), 'utf8');
  const resetAt = source.indexOf('S.currentPlayerChannelNumber = null;');
  const applyAt = source.indexOf('applyDisplayMode();', resetAt);
  const virtualAt = source.indexOf('if (isVirtualChannel(number))', resetAt);
  assert.ok(resetAt >= 0 && applyAt > resetAt && virtualAt > applyAt,
    'display mode must be applied after stale metadata is cleared and before the virtual-channel return');
});

test('plugin styles are self-contained and do not borrow cross-plugin keyframes', () => {
  const partyManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'party-channel', 'manifest.json'), 'utf8'));
  const partyCss = fs.readFileSync(path.join(ROOT, 'plugins', 'party-channel', partyManifest.style), 'utf8');
  const overlaysCss = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'overlays.css'), 'utf8');
  const setupCss = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  const screensaverCss = fs.readFileSync(path.join(ROOT, 'plugins', 'screensaver', 'style.css'), 'utf8');
  assert.match(partyCss, /\.party-channel\s*\{/);
  assert.doesNotMatch(overlaysCss, /\.party-channel\s*\{/);
  assert.doesNotMatch(setupCss, /\.party-join-box\s*\{/);
  assert.match(screensaverCss, /@keyframes\s+screensaver-lineup-cycle/);
  assert.doesNotMatch(screensaverCss, /animation:\s*landing-promo-cycle/);
});

test('isolated plugins can read their packaged userData plugin directory', () => {
  const { buildExecArgv } = require(path.join(ROOT, 'main', 'main-plugin-isolation.js'));
  const appRoot = path.join('C:', 'Apps', 'RerunTV', 'resources', 'app.asar');
  const pluginDir = path.join('C:', 'Apps', 'RerunTV', 'userData', 'plugins', 'party-channel');
  const dataDir = path.join('C:', 'Apps', 'RerunTV', 'userData', 'party-uploads');
  const args = buildExecArgv({ capabilities: { spawn: [] } }, appRoot, pluginDir, dataDir);
  const readArg = args.find((arg) => arg.startsWith('--allow-fs-read='));

  assert.ok(readArg, 'isolated runtime must declare filesystem read permissions');
  assert.match(readArg, new RegExp(pluginDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.doesNotMatch(readArg, /userData(?:,|$)/i, 'permission must remain scoped below userData');
});

test('Party channel exposes and renders the host pairing code on CH 94', () => {
  const main = fs.readFileSync(path.join(ROOT, 'plugins', 'party-channel', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(ROOT, 'plugins', 'party-channel', 'renderer.js'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'plugins', 'party-channel', 'settings.js'), 'utf8');
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

  assert.match(main, /pairingCode:\s*access\.pairingCode/);
  assert.match(renderer, /const PARTY_CH = 94;/);
  assert.match(renderer, /partyPairingCodeEl\.textContent = info\.pairingCode/);
  assert.match(settings, /joinCodeEl/);
  assert.match(markup, /id="party-pairing-code"/);
  assert.doesNotMatch(`${settings}\n${markup}`, /CH\s*5\b/);
});

test('logo bug position and resize editor supports pointer input', () => {
  const editor = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-util.js'), 'utf8');
  const setupCss = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  const displayMode = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'display-mode.js'), 'utf8');

  assert.match(editor, /addEventListener\('pointerdown'/);
  assert.match(editor, /addEventListener\('pointermove'/);
  assert.match(editor, /addEventListener\('pointercancel'/);
  assert.match(editor, /EDIT ON CURRENT CHANNEL/);
  assert.match(editor, /LIVE OVERLAY LAYOUT/);
  assert.match(editor, /applyDisplayModeSettled/);
  assert.match(editor, /OVERLAY ELEMENT/);
  assert.match(editor, /AUTO MATCH CONTENT/);
  assert.match(editor, /SNAP GRID/);
  assert.match(editor, /overlaySnapIncrement/);
  assert.match(editor, /function snapPercent/);
  assert.match(editor, /function snapLogoSize/);
  assert.match(editor, /function snapScale/);
  assert.match(editor, /nextEvent\.altKey/);
  assert.match(editor, /\['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'\]/);
  assert.doesNotMatch(editor, /logobug-editor-preview/);
  assert.doesNotMatch(editor, /logobug[\s\S]{0,8000}addEventListener\('mousedown'/);
  assert.match(setupCss, /\.logobug-live-overlay\s*\{/);
  assert.match(setupCss, /\.logobug-live-anchor-nw/);
  assert.match(setupCss, /--overlay-grid-step/);
  assert.match(setupCss, /\.logobug-live-overlay\.snap-enabled/);
  assert.doesNotMatch(setupCss, /\.logobug-editor-preview/);
  assert.match(displayMode, /resolveContentDisplayMode/);
  assert.match(displayMode, /OVERLAY_LAYOUT_TARGETS/);
});

test('Preview Guide channel exposes a complete broadcast-guide composition', () => {
  const renderer = fs.readFileSync(path.join(ROOT, 'plugins', 'prevue', 'renderer.js'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'plugins', 'prevue', 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'plugins', 'prevue', 'style.css'), 'utf8');
  for (const marker of ['landing-identity', 'landing-spotlight', 'landing-listing-head', 'lr-progress']) {
    assert.match(renderer, new RegExp(marker));
    assert.match(css, new RegExp(`\\.${marker}`));
  }
  assert.match(renderer, /ctx\.viewNow\(\)/);
  assert.match(renderer, /rotateSpotlight/);
  assert.match(renderer, /scrollPace/);
  assert.match(renderer, /stopTimers\(\)/);
  assert.match(settings, /GUIDE STATION LABEL/);
  assert.match(settings, /LISTING CRAWL SPEED/);
  assert.match(settings, /ROTATE THE NOW-PLAYING SPOTLIGHT/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-height:\s*620px\)/);
});

test('overlay editor snapping and custom no-signal copy are configurable', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const editor = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-util.js'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const playback = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'playback.js'), 'utf8');
  const panels = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-panels.js'), 'utf8');
  assert.match(editor, /SNAP GRID/);
  assert.match(editor, /\[0, 'OFF'\].*\[1, '1%'\].*\[2\.5, '2\.5%'\].*\[5, '5%'\].*\[10, '10%'\]/s);
  assert.match(editor, /overlaySnapIncrement/);
  assert.match(editor, /nextEvent\.altKey/);
  assert.match(markup, /id="no-signal-title-input"/);
  assert.match(markup, /id="no-signal-message-input"/);
  assert.match(markup, /\{channel\}/);
  assert.match(settings, /noSignalTitleInput\.addEventListener\('input'/);
  assert.match(settings, /noSignalCopyReset\.addEventListener\('click'/);
  assert.match(playback, /function genericNoSignalCopy/);
  assert.match(playback, /function channelNoSignalCopy/);
  assert.match(playback, /channel\.broadcastIdentity/);
  assert.match(playback, /replaceAll\('\{channel\}'/);
  assert.match(panels, /NO SIGNAL HEADING/);
  assert.match(panels, /NO SIGNAL DETAIL/);
  assert.match(panels, /'noSignalTitle'/);
  assert.match(panels, /'noSignalMessage'/);
});

test('guide genre colors are opt-in, customizable, and scoped per theme', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const guide = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'guide.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'guide.css'), 'utf8');
  const genres = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'guide-genres.js'), 'utf8');
  assert.match(markup, /id="guide-genre-colors-enabled"/);
  assert.match(markup, /id="guide-genre-color-list"/);
  assert.match(settings, /guideGenreStyles/);
  assert.match(settings, /activeGuideGenreThemeId/);
  assert.match(settings, /file\.facets\?\.genre/);
  assert.match(guide, /guideGenreStyleForFile/);
  assert.match(guide, /document\.documentElement\.dataset\.theme/);
  assert.match(css, /\.guide-entry-genre:not\(\.sel\)/);
  assert.match(genres, /DEFAULT_GUIDE_GENRES/);
  assert.match(genres, /guideGenreTextColor/);
});

test('hint bar supports optional asymmetric slide timing', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const power = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'power.js'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'guide.css'), 'utf8');
  for (const id of ['hintbar-slide-enabled', 'hintbar-show-duration', 'hintbar-hide-duration']) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
  assert.match(power, /--hint-bar-show-duration/);
  assert.match(power, /--hint-bar-hide-duration/);
  assert.match(power, /classList\.toggle\('is-hidden'/);
  assert.match(settings, /hintBarSlideEnabledEl\.addEventListener\('change'/);
  assert.match(settings, /hintBarShowDurationEl\.addEventListener\('input'/);
  assert.match(settings, /hintBarHideDurationEl\.addEventListener\('input'/);
  assert.match(css, /\.hint-bar\.is-hidden/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('channel tuning skips static safely when its canvas has no layout size', () => {
  const playback = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'playback.js'), 'utf8');
  assert.match(playback, /staticCanvas\.width < 1 \|\| staticCanvas\.height < 1/);
  assert.match(playback, /staticReady = true;[\s\S]*?staticCanvas\.style\.opacity = '0';[\s\S]*?return;/);
});

test('Help uses focused subtabs and update search navigates to its panel', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  for (const name of ['guide', 'shortcuts', 'updates', 'releases']) {
    assert.match(markup, new RegExp(`data-subtab="${name}"`));
    assert.match(markup, new RegExp(`data-subtab-panel="${name}"`));
  }
  assert.match(settings, /\['help', 'updates', '#check-updates-btn'/);
});

test('dense setup areas use task-focused subtabs', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  for (const name of ['status', 'monitor', 'telemetry', 'installed', 'appearance', 'diagnostics']) {
    assert.match(markup, new RegExp(`data-subtab="${name}"`));
    assert.match(markup, new RegExp(`data-subtab-panel="${name}"`));
  }
  assert.match(markup, /class="setup-subtab-btn active" data-subtab="presets"/);
  assert.doesNotMatch(markup, /programming-path-picker/);
});

test('custom sound profiles cover global events, channel overrides, and theme ambience', () => {
  const audio = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'audio.js'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  const panels = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-panels.js'), 'utf8');
  const ambient = fs.readFileSync(path.join(ROOT, 'plugins', 'vintage-audio', 'renderer.js'), 'utf8');
  assert.match(audio, /CUSTOM_SOUND_SLOTS/);
  for (const slot of ['button', 'channelTune', 'card', 'notification', 'powerOn', 'guideOpen']) {
    assert.match(audio, new RegExp(`['"]${slot}['"]`));
  }
  assert.match(settings, /custom-sounds-list/);
  assert.match(panels, /CUSTOM TUNE SOUND/);
  assert.match(panels, /CUSTOM CARD SOUND/);
  assert.match(ambient, /themeAmbient !== false/);
});

test('titles, taxonomy uses, ad pool, and flow steps share lazy media thumbnails', () => {
  const util = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-util.js'), 'utf8');
  const interstitials = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-interstitials.js'), 'utf8');
  const panels = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-panels.js'), 'utf8');
  const taxonomy = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-tagtaxonomy.js'), 'utf8');
  const flows = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-interstitials-flowbuilder.js'), 'utf8');
  const setupCss = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'setup.css'), 'utf8');
  assert.match(util, /export function buildMediaThumbnail/);
  assert.match(util, /IntersectionObserver/);
  assert.match(util, /media\.currentTime/);
  assert.match(interstitials, /buildInterstitialThumbnail/);
  assert.match(panels, /title-row-thumbnail/);
  assert.match(taxonomy, /tagtaxonomy-usage-thumbnail/);
  assert.match(flows, /flowStepPreviewPaths/);
  assert.match(flows, /flow-step-previews/);
  assert.match(setupCss, /\.media-thumbnail\s*\{/);
  assert.match(setupCss, /\.interstitial-thumbnail\s*\{/);
});

test('shared CSS defines every semantic token used by core components', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'tokens.css'), 'utf8');
  for (const name of ['panel-2', 'selection', 'gold-dim', 'border', 'bg', 'text', 'shadow-soft', 'shadow-hard-md']) {
    assert.match(tokens, new RegExp(`--${name}\\s*:`), `tokens.css is missing --${name}`);
  }
  assert.match(tokens, /prefers-reduced-motion[\s\S]*animation-duration:\s*0\.01ms\s*!important/);
});

test('migrated legacy plugin bundle uses current settings, isolation, and renderer service contracts', () => {
  const ids = [
    'spotify-connect', 'ticker', 'video-splicer', 'youtube-music', 'area-51',
    'breaking-news', 'eas-alerts', 'hbo', 'party-jukebox', 'pay-per-view', 'shopping-network',
  ];
  ids.forEach((id) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '1.1.0', `${id} was not migrated to the current bundled revision`);
  });

  for (const id of ['spotify-connect', 'video-splicer', 'youtube-music', 'eas-alerts']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.settings, 'settings.js');
    const settings = fs.readFileSync(path.join(ROOT, 'plugins', id, manifest.settings), 'utf8');
    assert.match(settings, new RegExp(`registerPluginSettings\\('${id}'`));
  }

  const splicer = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'video-splicer', 'manifest.json'), 'utf8'));
  assert.equal(splicer.isolated, true);
  assert.equal(splicer.dataDir, 'video-splicer');
  assert.ok(splicer.dependsOn.includes('ffmpeg-transcode'));
  assert.ok(splicer.capabilities.net.some(({ port }) => port === 4173));

  const pluginApi = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'plugins.js'), 'utf8');
  const jukebox = fs.readFileSync(path.join(ROOT, 'plugins', 'party-jukebox', 'renderer.js'), 'utf8');
  const onlineAudio = fs.readFileSync(path.join(ROOT, 'plugins', 'youtube-music', 'renderer.js'), 'utf8');
  assert.match(pluginApi, /registerRendererService/);
  assert.match(pluginApi, /getRendererService/);
  assert.match(jukebox, /getRendererService\('online-audio-queue'\)/);
  assert.match(onlineAudio, /registerRendererService\('online-audio-queue'/);
  assert.doesNotMatch(onlineAudio, /RCBPlugins\.youtubeMusic\s*=/);

  const premiumManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'hbo', 'manifest.json'), 'utf8'));
  assert.equal(premiumManifest.name, 'Premium Movie Showcase');
});
