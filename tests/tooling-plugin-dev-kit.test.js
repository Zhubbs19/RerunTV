// The copyable starter plugins in plugin-dev-kit/ must pass the same manifest
// validation as the bundled plugins (scripts/validate-plugin-contracts.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-plugin-contracts.js');

function runValidator(root) {
  return spawnSync(process.execPath, [VALIDATOR], {
    encoding: 'utf8',
    env: { ...process.env, ...(root ? { RERUNTV_VALIDATE_ROOT: root } : {}) },
  });
}

// A scratch tree with just what the validator reads: the kit, the API contract
// pair, and an (empty) plugins/ directory.
function scratchTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'renderer', 'js'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'main', 'preload.js'), path.join(dir, 'main', 'preload.js'));
  fs.copyFileSync(path.join(ROOT, 'renderer', 'js', 'api-contract.js'), path.join(dir, 'renderer', 'js', 'api-contract.js'));
  fs.cpSync(path.join(ROOT, 'plugin-dev-kit'), path.join(dir, 'plugin-dev-kit'), { recursive: true });
  return dir;
}

test('the validator accepts the repo, including plugin-dev-kit', () => {
  const result = runValidator();
  assert.equal(result.status, 0, result.stderr);
});

test('the starter plugin manifest is well formed and declares the IPC channel it registers', () => {
  const kit = path.join(ROOT, 'plugin-dev-kit', 'starter-plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'starter-plugin');
  for (const key of ['style', 'renderer', 'settings', 'main']) {
    assert.ok(fs.existsSync(path.join(kit, manifest[key])), `${key} file ${manifest[key]} exists`);
  }
  const channels = manifest.capabilities.ipc.map((entry) => entry.channel);
  assert.deepEqual(channels, ['starter-plugin:ping']);
  assert.ok(manifest.capabilities.ipc.every((entry) => entry.why && entry.why.trim()));
});

test('a scratch copy of the kit passes, and a broken kit manifest fails the validator', (t) => {
  const dir = scratchTree(t);
  const ok = runValidator(dir);
  assert.equal(ok.status, 0, ok.stderr);

  const manifestPath = path.join(dir, 'plugin-dev-kit', 'starter-plugin', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.id = 'Not_A_Valid-Id';
  delete manifest.capabilities;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const bad = runValidator(dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /plugin-dev-kit\/starter-plugin\/manifest\.json/);
  assert.match(bad.stderr, /never declares it/);
});

test('every plugin-dev-kit directory is covered by the validator (no silently skipped starters)', () => {
  const kitDirs = fs.readdirSync(path.join(ROOT, 'plugin-dev-kit'), { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(kitDirs.length >= 1);
  for (const entry of kitDirs) {
    assert.ok(fs.existsSync(path.join(ROOT, 'plugin-dev-kit', entry.name, 'manifest.json')), `${entry.name} has a manifest`);
  }
  assert.match(fs.readFileSync(VALIDATOR, 'utf8'), /MANIFEST_ROOTS\s*=\s*\[[^\]]*'plugin-dev-kit'/);
});
