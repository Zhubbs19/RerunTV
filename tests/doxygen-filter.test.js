// scripts/doxygen-filter.js: the JavaScript-to-Doxygen translation behind `npm run docs`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterSource } = require('../scripts/doxygen-filter');

const lines = (text) => text.split('\n');

test('keeps the line count, so source links and line numbers match the real file', () => {
  const source = [
    '// Header.',
    'const fs = require(\'fs\');',
    '',
    'function a() {',
    '  return `x',
    'y`;',
    '}',
    '',
  ].join('\r\n');
  assert.equal(lines(filterSource(source, 'x.js')).length, source.split('\r\n').length);
});

test('the first comment block documents the file, a comment directly above documents the declaration', () => {
  const out = lines(filterSource([
    '// What this file is for. More about it.',
    '',
    '// Adds two numbers.',
    'export function add(a, b = 1) {',
    '  return a + b;',
    '}',
    '',
    '// Not attached: a blank line follows.',
    '',
    'function helper({ x, y }, ...rest) {}',
  ].join('\n'), 'renderer/js/x.js'));
  assert.equal(out[0], '/// \\file renderer/js/x.js \\brief What this file is for. \\details More about it.');
  assert.equal(out[2], '/// \\brief Adds two numbers.');
  assert.equal(out[3], 'function add(a, b = 1);');
  assert.equal(out[4], '');
  assert.equal(out[7], '');
  assert.equal(out[9], 'static function helper({x, y}, ...rest);');
});

test('CommonJS exports are not static, everything else is', () => {
  const out = lines(filterSource([
    'function shared() {}',
    'function internal() {}',
    'const LIMIT = 5; // how many',
    'module.exports = { shared, wrap(a) { return a; } };',
  ].join('\n'), 'main/x.js'));
  assert.equal(out[0], 'function shared();');
  assert.equal(out[1], 'static function internal();');
  assert.equal(out[2], 'static const LIMIT = 5; ///< how many');
  assert.equal(out[3], 'function wrap(a);');
});

test('classes keep their members, private ones under private:', () => {
  const out = lines(filterSource([
    'export class Box extends Base {',
    '  // Builds one.',
    '  constructor(opts) { super(); }',
    '  static async load(path) {}',
    '  get size() { return 0; }',
    '  #secret() {}',
    '  count = 0;',
    '}',
  ].join('\n'), 'x.js'));
  assert.deepEqual(out, [
    'class Box : public Base { public:',
    '  /// \\brief Builds one.',
    'Box(opts);',
    'static async load(path);',
    'get size();',
    'private: secret(); public:',
    'count;',
    '};',
  ]);
});

test('escapes Doxygen markup outside code spans and keeps JSDoc tags', () => {
  const out = lines(filterSource([
    '/**',
    ' * Runs <dir> for @owner #1 & `<kept> @as-is`.',
    ' * @param {string} name the name',
    ' * @returns {number} a count',
    ' */',
    'export function run(name) {}',
  ].join('\n'), 'x.js'));
  assert.equal(out[1], ' /// \\brief Runs \\<dir\\> for \\@owner \\#1 \\& `<kept> @as-is`. \\details');
  assert.equal(out[2], ' /// @param name `string` the name');
  assert.equal(out[3], ' /// @returns `number` a count');
  assert.equal(out[5], 'function run(name);');
});

test('a sentence end inside a code span does not end the brief', () => {
  const out = lines(filterSource([
    '// File header.',
    '',
    '// Returns `{ a?, b? }` or `x.<y>` for the caller. Details here.',
    'export const f = () => {};',
  ].join('\n'), 'x.js'));
  assert.equal(out[2],'/// \\brief Returns `{ a?, b? }` or `x.<y>` for the caller. \\details Details here.');
});

test('relative imports and requires of repo files become #include lines for the dependency graphs', () => {
  const out = lines(filterSource([
    "import { S } from './state.js';",
    "import fs from 'node:fs';",
    'import {',
    '  dispatch,',
    "} from './commands.js';",
    "export { formatClock } from './util.js';",
    "import { gone } from './missing.js';",
  ].join('\n'), 'renderer/js/core/x.js'));
  assert.deepEqual(out, [
    '#include "renderer/js/core/state.js"',
    '',
    '#include "renderer/js/core/commands.js"',
    '',
    '',
    '#include "renderer/js/core/util.js"',
    '',
  ]);
  const cjs = lines(filterSource([
    "const { loadConfig } = require('./config');",
    "const path = require('node:path');",
    "require('../util/db');",
  ].join('\n'), 'main/config/x.js'));
  assert.deepEqual(cjs, ['#include "main/config/config.js"', '', '#include "main/util/db.js"']);
});

test('a file it cannot parse comes out blank instead of failing the build', () => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.deepEqual(lines(filterSource('function (\n', 'bad.js')), ['', '']);
  } finally {
    process.stderr.write = write;
  }
});
