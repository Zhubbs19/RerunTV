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

test('the default package is deterministic and personal plugins require an explicit flavor', () => {
  const config = fs.readFileSync(path.join(ROOT, 'electron-builder.config.js'), 'utf8');
  assert.match(config, /RERUNTV_INCLUDE_LOCAL_PLUGINS/);
  assert.match(config, /bundled-plugins\.json/);
  assert.match(config, /build\/icon\.png/);
  assert.ok(fs.statSync(path.join(ROOT, 'build', 'icon.png')).size > 1000);
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
