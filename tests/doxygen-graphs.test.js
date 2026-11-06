// scripts/doxygen-graphs.js: the call and class graphs `npm run docs` adds to the code reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource, linkModules, callGraphDot, fileGraphDot, classGraphDot, insertIntoMember } = require('../scripts/doxygen-graphs');

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

test('a call graph groups boxes by file and only takes a second step when the first is small', () => {
  const graph = graphOf({
    'a.js': "import { far } from './b.js';\nexport function a() { b(); far(); }\nfunction b() { c(); }\nfunction c() { d(); }\nfunction d() {}",
    'b.js': 'export function far() {}',
  });
  const dot = callGraphDot('a.js::a', graph.calls, graph.nodes, (k) => `${k}.html`, false);
  assert.match(dot, /n0 \[label=<a\(\)>, fillcolor="#f6c90e"/);
  assert.match(dot, /n1 \[label=<b\(\)>.*href="a\.js::b\.html"/);
  assert.match(dot, /label=<c\(\)>/); // a second step: a calls only two functions
  assert.doesNotMatch(dot, /d\(\)/); // a third step is never drawn
  // One frame per file, the graph's own file first; boxes carry only their names.
  assert.ok(dot.indexOf('>a.js</FONT>') < dot.indexOf('>b.js</FONT>'));
  assert.match(dot, /label=<far\(\)>/);
  assert.equal(callGraphDot('a.js::d', graph.calls, graph.nodes, () => null, false), null);
});

test('a busy function gets one step and a "+N more" box instead of a tangle', () => {
  const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const graph = graphOf({
    'a.js': `function hub() { ${names.map((n) => `${n}();`).join(' ')} }\n${names.map((n) => `function ${n}() { leaf(); }`).join('\n')}\nfunction leaf() {}`,
  });
  const dot = callGraphDot('a.js::hub', graph.calls, graph.nodes, () => null, false);
  assert.match(dot, /label=<\+ 10 more>/);
  assert.doesNotMatch(dot, /leaf\(\)/);
  // Edges at the subject share one end, so the list meets it as one trunk.
  assert.match(dot, /n0 -> more \[style=dashed, sametail=subject\]/);
  assert.match(dot, /n0 -> n1 \[sametail=subject\]/);
  const callers = callGraphDot('a.js::leaf', graph.callers, graph.nodes, () => null, true);
  assert.match(callers, /more -> n0 \[style=dashed, samehead=subject\]/);
});

test('a file graph lists files by folder, and summarizes by folder past its limit', () => {
  const few = fileGraphDot('src/a.js', new Set(['src/b.js', 'lib/c.js']), (f) => `${f}.html`, (d) => `${d}.dir`, false);
  assert.match(few, /focus \[label=<src\/a\.js>/);
  assert.match(few, />lib<\/FONT>/);
  assert.match(few, /label=<c\.js>, href="lib\/c\.js\.html"/);
  assert.match(few, /focus -> f0;/);
  const many = new Set(Array.from({ length: 40 }, (_, i) => (i < 25 ? `ui/x${i}.js` : `core/y${i}.js`)));
  const summary = fileGraphDot('src/a.js', many, () => null, (d) => `${d}.dir`, true);
  assert.match(summary, /label=<ui\/ {2}<FONT COLOR="#b4bce6">25 files<\/FONT>>, href="ui\.dir"/);
  assert.match(summary, /d0 -> focus;/);
  assert.equal(fileGraphDot('src/a.js', new Set(), () => null, () => null, false), null);
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

test('a class graph lists the properties its methods create, then its methods', () => {
  const source = [
    'class Box {',
    '  size = 1;',
    '  constructor(o) { this.host = o; this.onTick = () => { this.count = 0; }; }',
    '  open() { function inner() { this.notMine = 1; } this.host = 2; }',
    '}',
  ].join('\n');
  const modules = new Map([['a.js', analyzeSource(source, 'a.js', () => null)]]);
  assert.deepEqual(modules.get('a.js').classes.get('Box').fields, ['size', 'host', 'onTick', 'count']);
  const dot = classGraphDot('a.js::Box', linkModules(modules), modules, () => null);
  assert.ok(dot.indexOf('>size</FONT>') < dot.indexOf('<HR/>'));
  assert.ok(dot.indexOf('<HR/>') < dot.indexOf('>open()</FONT>'));
});
