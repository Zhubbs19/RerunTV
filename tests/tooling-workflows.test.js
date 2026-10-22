// Tooling checks: CI workflows, release docs and Dependabot stay consistent
// with one another. These read the files as text on purpose (a full YAML parser
// is not a dependency); each check targets a claim that would otherwise rot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const workflowFiles = fs.readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

// Actions that may stay on a version tag. Keep this empty: a pin that cannot
// be verified should be listed here deliberately, with the reason.
const UNPINNED_ALLOWED = new Set([]);

function usesLines(text) {
  return text.split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /^\s*-?\s*uses:\s*\S/.test(line) && !/^\s*#/.test(line));
}

test('every workflow action is pinned to a full commit SHA with a version comment', () => {
  assert.ok(workflowFiles.length >= 4, 'expected the ci, build, codeql and scorecard workflows at least');
  for (const name of workflowFiles) {
    for (const { line, index } of usesLines(read('.github', 'workflows', name))) {
      const ref = line.match(/uses:\s*(\S+)/)[1];
      if (ref.startsWith('./')) continue;
      const [action, version] = ref.split('@');
      if (UNPINNED_ALLOWED.has(action)) continue;
      assert.match(version || '', /^[0-9a-f]{40}$/, `${name}:${index} ${action} must be pinned by full commit SHA`);
      assert.match(line, /#\s*v\d/, `${name}:${index} ${action} needs a "# vX.Y.Z" comment so humans and Dependabot can read the pin`);
    }
  }
});

test('the same action is pinned to the same SHA in every workflow', () => {
  const seen = new Map();
  for (const name of workflowFiles) {
    for (const { line } of usesLines(read('.github', 'workflows', name))) {
      const [action, sha] = line.match(/uses:\s*(\S+)/)[1].split('@');
      if (seen.has(action)) assert.equal(sha, seen.get(action), `${action} is pinned inconsistently`);
      else seen.set(action, sha);
    }
  }
});

test('workflow tokens default to read-only and write scopes are granted per job', () => {
  for (const name of workflowFiles) {
    const text = read('.github', 'workflows', name);
    const top = text.match(/^permissions:\s*(.*)\n((?:[ \t]+.*\n)*)/m);
    assert.ok(top, `${name} must declare top-level permissions`);
    const topBlock = `${top[1]}\n${top[2]}`;
    assert.doesNotMatch(topBlock, /write/, `${name} must not grant write permissions at workflow level`);
  }
  const build = read('.github', 'workflows', 'build-installer.yml');
  const job = build.slice(build.indexOf('\njobs:'));
  assert.match(job, /permissions:\n\s+contents: write[^\n]*\n\s+id-token: write[^\n]*\n\s+attestations: write/);
});

test('RELEASING.md and the README claims are backed by build-installer.yml steps', () => {
  const releasing = read('RELEASING.md');
  const readme = read('README.md');
  const workflow = read('.github', 'workflows', 'build-installer.yml');
  const releaseCmd = workflow.slice(workflow.indexOf('gh release create'));

  // Checksums: written, listed in the release, and documented.
  assert.match(releasing + readme, /SHA256SUMS\.txt/);
  assert.match(workflow, /sha256sum [^\n]*> SHA256SUMS\.txt/);
  assert.match(releaseCmd, /dist\/SHA256SUMS\.txt/);

  // Attestation: documented verification needs a real attest step covering the installer.
  assert.match(releasing + readme, /gh attestation verify/);
  assert.match(workflow, /uses: actions\/attest-build-provenance@/);

  // The four assets RELEASING.md promises.
  for (const asset of ['"$installer"', '"$installer.blockmap"', 'dist/latest.yml', 'dist/SHA256SUMS.txt']) {
    assert.ok(releaseCmd.includes(asset), `release must attach ${asset}`);
  }
  assert.match(releasing, /all four/);

  // Documented order: tests, then build, then checksums/attestation, then release.
  const order = ['run: npm test', 'run: npx electron-builder --win', '- name: Write checksums', '- name: Attest build provenance', '- name: Create GitHub Release']
    .map((needle) => workflow.indexOf(needle));
  assert.ok(order.every((i) => i >= 0), 'every documented release step exists');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'release steps run in the documented order');
  assert.match(workflow, /--publish=never/);
});

test('the release build is gated on the unit tests after installing dependencies', () => {
  const workflow = read('.github', 'workflows', 'build-installer.yml');
  assert.ok(workflow.indexOf('run: npm ci') < workflow.indexOf('run: npm test'));
});

test('ci.yml runs the root tests and the companion app typecheck and tests', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  assert.match(ci, /run: npm test/);
  assert.match(ci, /working-directory: companion-rn/);
  assert.match(ci, /run: npm ci/);
  assert.match(ci, /run: npm run typecheck/);
  assert.match(ci, /cache-dependency-path: companion-rn\/package-lock\.json/);
});

test('CodeQL analyzes javascript-typescript and can upload results', () => {
  const codeql = read('.github', 'workflows', 'codeql.yml');
  assert.match(codeql, /javascript-typescript/);
  assert.match(codeql, /security-events: write/);
  assert.match(codeql, /codeql-action\/init@[0-9a-f]{40}/);
  assert.match(codeql, /codeql-action\/analyze@[0-9a-f]{40}/);
});

test('Dependabot covers every tracked package.json directory and the workflow actions', () => {
  const dependabot = read('.github', 'dependabot.yml');
  const manifests = execFileSync('git', ['ls-files', '--', '*package.json'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).filter((file) => !file.includes('node_modules'));
  assert.ok(manifests.length >= 2);
  const blocks = dependabot.split(/\n  - package-ecosystem:/).slice(1).map((b) => `package-ecosystem:${b}`);
  const npmDirs = blocks.filter((b) => /package-ecosystem: npm/.test(b)).map((b) => b.match(/directory: (\S+)/)[1]);
  for (const file of manifests) {
    const dir = `/${path.posix.dirname(file)}`.replace(/^\/\.$/, '/');
    assert.ok(npmDirs.includes(dir), `dependabot.yml has no npm entry for ${dir}`);
  }
  assert.ok(blocks.some((b) => /package-ecosystem: github-actions/.test(b) && /directory: \/\s*\n/.test(b)));
  for (const block of blocks) assert.match(block, /interval: weekly/);
});
