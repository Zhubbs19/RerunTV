#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const testsDir = path.join(root, 'tests');
const testFiles = fs.existsSync(testsDir)
  ? fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.js')).map((name) => path.join(testsDir, name))
  : [];

if (!testFiles.length) {
  console.error('Refusing a false-green test run: no tracked tests/*.test.js files were found.');
  process.exit(1);
}

const contractCheck = spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-plugin-contracts.js')], {
  cwd: root, stdio: 'inherit',
});
if (contractCheck.status !== 0) process.exit(contractCheck.status || 1);

// Stricter than the app runs: a deprecated Node API, including ones only flagged as
// "pending", throws instead of printing a warning, so tests fail on it.
const strict = ['--throw-deprecation', '--pending-deprecation'];
// `--coverage` (npm run test:coverage, and CI) adds Node's line/branch/function report
// for the app code the tests load.
const coverage = process.argv.includes('--coverage')
  ? ['--experimental-test-coverage', '--test-coverage-exclude=tests/**', '--test-coverage-exclude=node_modules/**']
  : [];

const testRun = spawnSync(process.execPath, ['--experimental-vm-modules', ...strict, '--test', ...coverage, ...testFiles], {
  cwd: root, stdio: 'inherit',
});
process.exit(testRun.status == null ? 1 : testRun.status);
