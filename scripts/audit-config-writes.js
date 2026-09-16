#!/usr/bin/env node
// Counts the renderer's remaining untyped config writes: call sites that mutate
// S.config in place and then call saveConfigDebounced(), which the undo layer
// turns into an anonymous config.patch diff. docs/design/05 step 5 converts
// these to named commands (dispatch, commitInPlace) file by file; this is the
// burn-down report. All renderer files reached zero in step 5; the ceiling test
// keeps it there.
//
//   node scripts/audit-config-writes.js           per-file counts, largest first
//   node scripts/audit-config-writes.js --update  also rewrite the ceiling file
//
// tests/config-writes.test.js fails if any file goes above its recorded
// ceiling, so a converted file can't quietly regress. Lower the ceiling (with
// --update) after converting call sites.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer', 'js');
const CEILING_FILE = path.join(ROOT, 'tests', 'config-writes-ceiling.json');
// The funnel itself and the command layer mention the name without being callers.
const IGNORED = new Set(['core/state.js', 'core/commands.js']);

function rendererFiles(dir = RENDERER, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return rendererFiles(path.join(dir, entry.name), `${name}/`);
    return entry.isFile() && name.endsWith('.js') && !IGNORED.has(name) ? [name] : [];
  }).sort();
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function countLabelledPatches() {
  const counts = {};
  for (const name of rendererFiles()) {
    const source = stripComments(fs.readFileSync(path.join(RENDERER, name), 'utf8'));
    const n = (source.match(/(?<![\w.])commitConfigPatch\(/g) || []).length;
    if (n) counts[name] = n;
  }
  return counts;
}

function countUntypedWrites() {
  const counts = {};
  for (const name of rendererFiles()) {
    const source = stripComments(fs.readFileSync(path.join(RENDERER, name), 'utf8'));
    // Calls only, not the import line.
    const n = (source.match(/(?<![\w.])saveConfigDebounced\(/g) || []).length;
    if (n) counts[name] = n;
  }
  return counts;
}

function readCeiling() {
  try { return JSON.parse(fs.readFileSync(CEILING_FILE, 'utf8')); } catch { return {}; }
}

module.exports = { countUntypedWrites, countLabelledPatches, readCeiling, CEILING_FILE };

if (require.main === module) {
  const counts = countUntypedWrites();
  const ceiling = readCeiling();
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  rows.forEach(([name, n]) => {
    const was = ceiling[name];
    const delta = was == null ? ' (new)' : n < was ? ` (was ${was})` : n > was ? ` (ABOVE ceiling ${was})` : '';
    console.log(`${String(n).padStart(4)}  ${name}${delta}`);
  });
  console.log(`${String(total).padStart(4)}  total untyped config writes in renderer/js`);
  // Not a regression: whole-config transforms (curation, tag rename, resync,
  // import, relink) recorded as one labelled config.patch on purpose.
  const patches = Object.entries(countLabelledPatches());
  console.log(`${String(patches.reduce((sum, [, n]) => sum + n, 0)).padStart(4)}  labelled whole-config patches (commitConfigPatch): ${patches.map(([name, n]) => `${name} ${n}`).join(', ')}`);
  if (process.argv.includes('--update')) {
    fs.writeFileSync(CEILING_FILE, `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, CEILING_FILE)}`);
  }
}
