#!/usr/bin/env node
// Builds the HTML code reference with Doxygen (`npm run docs`) into docs/api/html.
//
// Needs Doxygen on PATH (https://www.doxygen.nl/download.html, or `winget install
// DimitriVanHeesch.Doxygen`, `brew install doxygen`, `apt-get install doxygen`). The Doxyfile at
// the repo root holds the settings. This adds two things to it: the package version, and an
// exclusion for every gitignored path, so local-only plugins and scratch files never end up in
// the reference. Doxygen's warnings go to docs/api/warnings.log.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'api');
const { version } = require('../package.json');

const probe = spawnSync('doxygen', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error('Doxygen is not installed or not on PATH. Install it (https://www.doxygen.nl/download.html)'
    + ' and run `npm run docs` again.');
  process.exit(1);
}

const ignored = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
  cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const excludes = ignored.status === 0
  ? ignored.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''))
  : [];
if (ignored.status !== 0) console.warn('Not a git checkout: gitignored files are not left out of the reference.');

fs.rmSync(path.join(outDir, 'html'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const warnings = path.join(outDir, 'warnings.log');
const config = path.join(outDir, 'Doxyfile.generated');
const quote = (p) => `"${p.split(path.sep).join('/')}"`;
fs.writeFileSync(config, [
  `@INCLUDE = ${quote(path.join(root, 'Doxyfile'))}`,
  `PROJECT_NUMBER = ${version}`,
  `WARN_LOGFILE = ${quote(warnings)}`,
  ...excludes.map((p) => `EXCLUDE += ${quote(p)}`),
  '',
].join('\n'));

const run = spawnSync('doxygen', [config], { cwd: root, stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status == null ? 1 : run.status);

const count = fs.existsSync(warnings) ? (fs.readFileSync(warnings, 'utf8').match(/warning:/g) || []).length : 0;
console.log(`Code reference (Doxygen ${probe.stdout.trim().split(' ')[0]}): docs/api/html/index.html`);
if (count) console.log(`${count} Doxygen warning(s) in docs/api/warnings.log`);
