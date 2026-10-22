'use strict';
// A setup module that nothing imports never runs, so any listeners it wires at import time
// (DONE, ADD CHANNEL, the bulk bar, ...) silently disappear. This happened when channels.js
// was split; fail loudly if it happens again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'renderer', 'js');

// Modules that are loaded some other way (script tags, other windows, tests) and have always
// been unreferenced from other renderer modules.
const LOADED_ELSEWHERE = new Set([
  'api-contract.js', 'browser-api-shim.js', 'core/programming-rules.js', 'display/theme-contract.js',
  'tv/client-viewport.js', 'update/progress.js',
]);

function listJs(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) return listJs(path.join(dir, entry.name), rel);
    return entry.name.endsWith('.js') ? [rel] : [];
  });
}

test('every renderer module is imported by something (or is known to load elsewhere)', () => {
  const files = listJs(ROOT);
  const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
  const orphans = files.filter((file) => {
    if (LOADED_ELSEWHERE.has(file)) return false;
    const stem = path.posix.basename(file, '.js');
    const pattern = new RegExp(`['"][^'"]*/${stem}\.js['"]`);
    return ![...sources].some(([other, text]) => other !== file && pattern.test(text));
  });
  assert.deepEqual(orphans, [], `these modules are never imported, so their listeners never run: ${orphans.join(', ')}`);
});
