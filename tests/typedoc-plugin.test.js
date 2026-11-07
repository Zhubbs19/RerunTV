// scripts/typedoc-plugin.mjs: how the code reference reads this codebase's own comment conventions.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => Promise.all([
  import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'typedoc-plugin.mjs')).href),
  import('typedoc'),
]);

// A TypeScript SourceFile for some JavaScript, the way TypeDoc sees it.
const sourceOf = (ts, lines) => ts.createSourceFile('x.js', lines.join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

test('a file\'s leading // block is its description, even sitting on the first declaration', async () => {
  const [{ headerComment }, { TypeScript: ts }] = await load();
  assert.equal(headerComment(sourceOf(ts, [
    '// What this file is for.',
    '// More about it.',
    '',
    '// Not part of the header: a blank line came first.',
    'const a = 1;',
  ])), 'What this file is for.\nMore about it.');
  assert.equal(headerComment(sourceOf(ts, ['// Header on the first line.', 'const a = 1;'])), 'Header on the first line.');
  assert.equal(headerComment(sourceOf(ts, ['/*', ' * A block header.', ' */', '', 'const a = 1;'])).trim(), 'A block header.');
});

test('a JSDoc block directly on the first declaration documents that declaration, not the file', async () => {
  const [{ headerComment }, { TypeScript: ts }] = await load();
  assert.equal(headerComment(sourceOf(ts, ['/** Adds two numbers. */', 'export function add(a, b) {}'])), '');
  assert.equal(headerComment(sourceOf(ts, ['#!/usr/bin/env node', 'const a = 1;'])), '');
  assert.equal(headerComment(sourceOf(ts, ['const a = 1; // trailing'])), '');
});

test('module loads are not documented as constants', async () => {
  const [{ isModuleLoad }, { TypeScript: ts }] = await load();
  const inits = sourceOf(ts, [
    "const fs = require('node:fs');",
    "const join = require('node:path').join;",
    "const mod = await import('./x.js');",
    'const LIMIT = 5;',
  ]).statements.map((s) => s.declarationList.declarations[0].initializer);
  assert.deepEqual(inits.map((i) => isModuleLoad(i)), [true, true, true, false]);
});
