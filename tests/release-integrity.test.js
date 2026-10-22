const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('the release plugin allowlist exactly matches tracked plugin manifests', () => {
  const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'bundled-plugins.json'), 'utf8')).plugins;
  const tracked = execFileSync('git', ['ls-files', 'plugins/*/manifest.json'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean).map((entry) => entry.split('/')[1]).sort();
  assert.deepEqual([...new Set(allowlist)].sort(), tracked);
});

function loadBuilderConfig(env) {
  const configPath = path.join(ROOT, 'electron-builder.config.js');
  const saved = process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS;
  if (env === undefined) delete process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS;
  else process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS = env;
  delete require.cache[require.resolve(configPath)];
  try {
    return require(configPath);
  } finally {
    if (saved === undefined) delete process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS;
    else process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS = saved;
    delete require.cache[require.resolve(configPath)];
  }
}

test('the default package is deterministic and personal plugins require an explicit flavor', () => {
  const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'bundled-plugins.json'), 'utf8')).plugins;
  const config = loadBuilderConfig(undefined);
  const pluginGlobs = config.files.filter((entry) => entry.startsWith('plugins/'));
  assert.deepEqual(pluginGlobs.slice().sort(), allowlist.map((id) => `plugins/${id}/**/*`).sort());
  assert.ok(!config.files.includes('plugins/**/*'), 'the default build must not ship every local plugin');

  const personal = loadBuilderConfig('1');
  assert.ok(personal.files.includes('plugins/**/*'), 'the personal flavor ships every local plugin');

  assert.equal(config.win.icon, 'build/icon.png');
  assert.ok(fs.statSync(path.join(ROOT, config.win.icon)).size > 1000);
});

test('only the Windows installer is configured, matching what CI builds and the docs claim', () => {
  const config = loadBuilderConfig(undefined);
  assert.equal(config.win.target, 'nsis');
  assert.equal(config.mac, undefined);
  assert.equal(config.linux, undefined);
  assert.equal(config.publish.provider, 'github');
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-installer.yml'), 'utf8');
  assert.match(workflow, /electron-builder --win\b/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /\bdmg\b|AppImage/);
});

test('the installer name template is the one the release workflow and updater feed rely on', () => {
  const config = loadBuilderConfig(undefined);
  assert.equal(config.artifactName, '${productName}-Setup-${version}.${ext}');
  assert.ok(!/\s/.test(config.productName), 'a space in the product name would be dot-mangled by GitHub uploads');
});

test('CI uses the tracked test gate and deterministic builder config', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-installer.yml'), 'utf8');
  assert.match(workflow, /run:\s+npm test/);
  assert.match(workflow, /--config electron-builder\.config\.js/);
});

test('isolated service and Party route registrations both enforce ownership', () => {
  const isolation = fs.readFileSync(path.join(ROOT, 'main', 'plugins/isolation.js'), 'utf8');
  assert.match(isolation, /services:registerProvider[\s\S]*?claimServiceKey\(manifest\.id, key\)/);
  assert.match(isolation, /party:registerRoute[\s\S]*?claimPartyRoute\(manifest\.id, routeKey\)/);
  assert.match(isolation, /partyRouteOwners\.delete\(key\)/);
});

test('the privileged renderer cannot navigate or open child windows', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /will-navigate/);
  assert.match(main, /app:\/\/bundle\//);
});

test('packaged builds turn off the Node-as-exe and inspector fuses', () => {
  const config = require(path.join(ROOT, 'electron-builder.config.js'));
  assert.equal(config.electronFuses.runAsNode, false);
  assert.equal(config.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(config.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  // Helpers must be started through utilityProcess, which these fuses don't affect.
  const sources = ['main/main.js', 'main/plugins/isolation.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /ELECTRON_RUN_AS_NODE/);
});
