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

const testRun = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', ...testFiles], {
  cwd: root, stdio: 'inherit',
});
process.exit(testRun.status == null ? 1 : testRun.status);
