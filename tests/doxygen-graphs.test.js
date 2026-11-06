// scripts/doxygen-graphs.js: the call and class graphs `npm run docs` adds to the code reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource, linkModules, callGraphDot, insertIntoMember } = require('../scripts/doxygen-graphs');

// A tiny repo: each entry is a file's source. Imports resolve between these files only.
function graphOf(files) {
  const resolve = (from, spec) => {
    const dir = from.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '..') dir.pop();
      else if (part !== '.') dir.push(part);
    }
    const base = dir.join('/');
    return [base, `${base}.js`].find((p) => p in files) || null;
  };
  const modules = new Map(Object.entries(files).map(([file, src]) => [file, analyzeSource(src, file, resolve)]));
  return linkModules(modules);
}
const callsOf = (graph, key) => [...(graph.calls.get(key) || [])].sort();

test('links calls inside a file and across ES module imports, re-exports and namespaces', () => {
  const graph = graphOf({
    'a.js': [
      "import { helper as h } from './b.js';",
      "import * as util from './util.js';",
      "import fmt from './fmt.js';",
      'export function outer(x) {',
      '  inner(x);',
      '  [1].map(inner);',
      '  util.clamp(h(x));',
      '  return fmt(x);',
      '}',
      'function inner(y) { return y; }',
    ].join('\n'),
    'b.js': "export { helper } from './c.js';",
    'c.js': 'export function helper(v) { return v; }',
    'util.js': 'export const clamp = (v) => v;',
    'fmt.js': 'export default function format(v) { return String(v); }',
  });
  assert.deepEqual(callsOf(graph, 'a.js::outer'), ['a.js::inner', 'c.js::helper', 'fmt.js::format', 'util.js::clamp']);
  assert.deepEqual([...graph.callers.get('c.js::helper')], ['a.js::outer']);
});

test('follows CommonJS requires, destructured or whole-module', () => {
  const graph = graphOf({
    'main/a.js': [
      "const { loadConfig } = require('./config');",
      "const db = require('./db');",
      'function boot() { loadConfig(); db.open(); }',
      'module.exports = { boot };',
    ].join('\n'),
    'main/config.js': 'function loadConfig() {}\nmodule.exports = { loadConfig };',
    'main/db.js': 'exports.open = function () {};',
  });
  assert.deepEqual(callsOf(graph, 'main/a.js::boot'), ['main/config.js::loadConfig', 'main/db.js::open']);
});

test('a local variable or parameter with the same name hides the top-level function', () => {
  const graph = graphOf({
    'a.js': [
      'function render() {}',
      'function draw(render) { render(); }',
      'function paint() { const render = () => 1; return render(); }',
      'function show() { return render(); }',
    ].join('\n'),
  });
  assert.deepEqual(callsOf(graph, 'a.js::draw'), []);
  assert.deepEqual(callsOf(graph, 'a.js::paint'), []);
  assert.deepEqual(callsOf(graph, 'a.js::show'), ['a.js::render']);
});

test('a property or object key named like a function is not a call to it', () => {
  const graph = graphOf({
    'a.js': 'function load() {}\nfunction run(o) { o.load(); return { load: 1 }; }',
  });
  assert.deepEqual(callsOf(graph, 'a.js::run'), []);
});

test('methods call each other through this, and new X() links classes and constructors', () => {
  const graph = graphOf({
    'a.js': [
      'class Framer { constructor() {} push() {} }',
      'export class Session {',
      '  constructor() { this.framer = new Framer(); }',
      '  connect() { this.send(); }',
      '  send() {}',
      '}',
    ].join('\n'),
    'b.js': "import { Session } from './a.js';\nexport function start() { return new Session(); }",
  });
  assert.deepEqual(callsOf(graph, 'a.js::Session.connect'), ['a.js::Session.send']);
  assert.deepEqual(callsOf(graph, 'a.js::Session.Session'), ['a.js::Framer.Framer']);
  assert.deepEqual([...graph.creates.get('b.js::start')], ['a.js::Session']);
  assert.deepEqual([...graph.creates.get('a.js::Session.Session')], ['a.js::Framer']);
});

test('a call graph draws the subject in yellow and stops at its depth limit', () => {
  const graph = graphOf({ 'a.js': 'function a() { b(); }\nfunction b() { c(); }\nfunction c() { d(); }\nfunction d() {}' });
  const dot = callGraphDot('a.js::a', graph.calls, graph.nodes, (k) => `${k}.html`, false);
  assert.match(dot, /n0 \[label=<a\(\)>, fillcolor="#f6c90e"/);
  assert.match(dot, /n1 \[label=<b\(\)>.*href="a\.js::b\.html"/);
  assert.match(dot, /n2 \[label=<c\(\)>, style="filled,rounded,dashed"/); // c calls d, which is a third step out
  assert.doesNotMatch(dot, /d\(\)/);
  assert.equal(callGraphDot('a.js::d', graph.calls, graph.nodes, () => null, false), null);
});

test('graph sections go at the end of the right member', () => {
  const page = [
    '<h2 class="memtitle"><span class="permalink"><a href="#a1">x</a></span>one()</h2>',
    '<div class="memitem">',
    '<div class="memproto">p</div><div class="memdoc">',
    '<p>One.</p>',
    '</div>',
    '</div>',
    '<h2 class="memtitle"><span class="permalink"><a href="#a2">x</a></span>two()</h2>',
    '<div class="memitem">',
    '<div class="memproto">p</div><div class="memdoc">',
    '<p>Two.</p>',
    '</div>',
    '</div>',
    '<!-- contents -->',
  ].join('\n');
  const out = insertIntoMember(page, 'a2', 'GRAPH');
  assert.ok(out.includes('<p>Two.</p>\nGRAPH</div>\n</div>\n<!-- contents -->'));
  assert.equal(insertIntoMember(page, 'missing', 'GRAPH'), page);
});
