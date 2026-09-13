#!/usr/bin/env node
// Counts the renderer's remaining untyped config writes: call sites that mutate
// S.config in place and then call saveConfigDebounced(), which the undo layer
// turns into an anonymous config.patch diff. docs/design/05 step 5 converts
// these to named commands (dispatch) file by file; this is the burn-down report.
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
const IGNORED = new Set(['state.js', 'commands.js']);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function countUntypedWrites() {
  const counts = {};
  for (const name of fs.readdirSync(RENDERER).sort()) {
    if (!name.endsWith('.js') || IGNORED.has(name)) continue;
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

module.exports = { countUntypedWrites, readCeiling, CEILING_FILE };

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
  if (process.argv.includes('--update')) {
    fs.writeFileSync(CEILING_FILE, `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, CEILING_FILE)}`);
  }
}
