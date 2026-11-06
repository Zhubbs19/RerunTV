// Call graphs and class graphs for the code reference (`npm run docs`, scripts/build-docs.js).
//
// Doxygen can't draw these for JavaScript. Its code parser loses a function's body after
// `export`, and it links a call to whichever function has that bare name, which in this codebase
// (many `render`, `init`, `load` functions) draws wrong edges. So this works from the JavaScript
// itself: espree parses each documented file, every import and require is followed to the file and
// export it names (re-exports included), and a reference counts only when it resolves to a real
// top-level function, class or method. A local variable with the same name shadows it.
//
// After Doxygen has written the HTML, `addGraphs` finds each function's and class's section in it,
// renders the graphs with Graphviz in parallel batches, and adds them as the same collapsible
// sections Doxygen uses for its own graphs, in the site palette.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse, resolveModule, instanceFields } = require('./doxygen-filter');

// Graph limits, chosen for readability: a second step out is only drawn when the first step has at
// most SECOND_STEP_LIMIT functions; a graph keeps at most MAX_NODES boxes (the rest become one
// "+N more" box); a file graph lists files up to MAX_FILES and summarizes by folder past that.
const SECOND_STEP_LIMIT = 6;
const MAX_NODES = 20;
const MAX_FILES = 30;

// The site palette (site/src/style.css).
const PALETTE = {
  cell: '#2a3a9a', cell2: '#23307f', bg2: '#111a48', rule: '#3a4bb0', text: '#eef1ff', dim: '#b4bce6',
  yellow: '#f6c90e', ink: '#1a1400', cyan: '#5fd6ff', edge: '#9fb0ff', head: '#0a0f2c',
};

// ---------- Reading the code ----------

/**
 * Calls `visit` for every AST node below `node`, depth first, with the node's parent and the key
 * it sits under.
 * @param {object} node An espree node.
 * @param {Function} visit Called as visit(child, parent, key).
 */
function walk(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child.type === 'string') {
        visit(child, node, key);
        walk(child, visit);
      }
    }
  }
}

/**
 * The names a binding pattern declares (`a`, `{ b, c: d }`, `[e, ...f]`, `g = 1`).
 * @param {object} pattern An espree pattern node.
 * @param {string[]} [out=[]] Names collected so far.
 * @returns {string[]} The declared names.
 */
function patternNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of pattern.elements) patternNames(e, out); break;
    case 'AssignmentPattern': patternNames(pattern.left, out); break;
    case 'RestElement': patternNames(pattern.argument, out); break;
    default: break;
  }
  return out;
}

/**
 * Whether an Identifier node is a reference to a binding, not a property name, object key or label.
 * @param {object} parent The identifier's parent node.
 * @param {string} key The parent key the identifier sits under.
 * @returns {boolean} True for a reference.
 */
function isReference(parent, key) {
  if ((parent.type === 'MemberExpression') && key === 'property' && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
    && key === 'key' && !parent.computed) return false;
  if (/^(LabeledStatement|BreakStatement|ContinueStatement)$/.test(parent.type)) return false;
  if (/^(ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier|ExportSpecifier)$/.test(parent.type)) return false;
  return true;
}

const isFunctionNode = (node) => node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');
const isModuleExports = (node) => node && node.type === 'MemberExpression' && !node.computed
  && node.object.type === 'Identifier' && node.object.name === 'module' && node.property.name === 'exports';
const keyName = (key) => (key.type === 'Identifier' ? key.name
  : key.type === 'Literal' && /^[A-Za-z_$][\w$]*$/.test(String(key.value)) ? String(key.value) : null);

/**
 * The repo file a `require('./x')` call (or `require('./x').name`) loads, and the export it reads.
 * @param {object} node The initializer expression.
 * @param {string} relPath The requiring file.
 * @param {Function} resolve Resolves a specifier to a repo path (or null).
 * @returns {?{ file: string, name: string }} The file and export ('*' for the whole module).
 */
function requireTarget(node, relPath, resolve) {
  let name = '*';
  if (node && node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    name = node.property.name;
    node = node.object;
  }
  if (!node || node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'require') return null;
  const arg = node.arguments[0];
  const file = arg && arg.type === 'Literal' && typeof arg.value === 'string' ? resolve(relPath, arg.value) : null;
  return file ? { file, name } : null;
}

/**
 * Reads one file's top-level functions, classes, exports and imports, and what each function or
 * method refers to (still unresolved: local names, imported bindings, `this.method`).
 * @param {string} source The file's text.
 * @param {string} relPath The file, relative to the repo root with `/` separators.
 * @param {Function} [resolve=resolveModule] Resolves an import specifier to a repo path, or null.
 * @returns {?object} { functions, classes, exports, reexports, imports, deps }, or null if it can't be parsed.
 */
function analyzeSource(source, relPath, resolve = resolveModule) {
  const { ast } = parse(source.replace(/^\uFEFF/, ''));
  if (!ast) return null;
  const functions = new Map(); // name -> { name, fn }
  const classes = new Map(); // name -> { name, superName, methods: Map name -> fn }
  const exportsMap = new Map(); // exported name -> local name
  const reexports = []; // { name ('*' for all), from: { file, name } }
  const imports = new Map(); // local name -> { file, name ('*' or 'default' or a name) }
  const deps = new Set(); // every repo file this one imports or requires at the top level

  const addFunction = (name, fn) => { if (name && !functions.has(name)) functions.set(name, { name, fn }); };
  const addClass = (name, cls) => {
    if (!name || classes.has(name)) return;
    const methods = new Map();
    const fields = [];
    for (const m of cls.body.body) {
      const methodName = m.computed || !m.key ? null : keyName(m.key);
      const fn = m.type === 'MethodDefinition' ? m.value : m.type === 'PropertyDefinition' && isFunctionNode(m.value) ? m.value : null;
      if (methodName && fn) methods.set(m.kind === 'constructor' ? name : methodName, fn);
      else if (methodName && m.type === 'PropertyDefinition') fields.push(methodName);
    }
    fields.push(...instanceFields(cls).map((f) => f.name));
    const superName = cls.superClass ? source.slice(cls.superClass.range[0], cls.superClass.range[1]) : null;
    classes.set(name, { name, superName, methods, fields });
  };
  const addObjectFunctions = (obj) => {
    for (const p of obj.properties) {
      if (p.type !== 'Property' || p.computed) continue;
      const name = keyName(p.key);
      if (isFunctionNode(p.value)) { addFunction(name, p.value); exportsMap.set(name, name); }
      else if (p.value.type === 'Identifier') exportsMap.set(name, p.value.name);
    }
  };
  const declare = (decl, isExported) => {
    if (decl.type === 'FunctionDeclaration') {
      const name = decl.id ? decl.id.name : 'defaultExport';
      addFunction(name, decl);
      if (isExported) exportsMap.set(name, name);
      return name;
    }
    if (decl.type === 'ClassDeclaration') {
      const name = decl.id ? decl.id.name : 'DefaultExport';
      addClass(name, decl);
      if (isExported) exportsMap.set(name, name);
      return name;
    }
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        const target = requireTarget(d.init, relPath, resolve);
        if (target) deps.add(target.file);
        if (target && d.id.type === 'Identifier') imports.set(d.id.name, target);
        else if (target && d.id.type === 'ObjectPattern') {
          for (const p of d.id.properties) {
            if (p.type === 'Property' && !p.computed && p.value.type === 'Identifier') imports.set(p.value.name, { file: target.file, name: keyName(p.key) });
          }
        }
        if (d.id.type !== 'Identifier') continue;
        if (isFunctionNode(d.init)) addFunction(d.id.name, d.init);
        else if (d.init && d.init.type === 'ClassExpression') addClass(d.id.name, d.init);
        if (isExported) exportsMap.set(d.id.name, d.id.name);
      }
    }
    return null;
  };

  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration') {
      const file = resolve(relPath, stmt.source.value);
      if (!file) continue;
      deps.add(file);
      for (const s of stmt.specifiers) {
        const name = s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported.name || s.imported.value);
        imports.set(s.local.name, { file, name });
      }
    } else if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) declare(stmt.declaration, true);
      const from = stmt.source ? resolve(relPath, stmt.source.value) : null;
      if (from) deps.add(from);
      for (const s of stmt.specifiers) {
        const exported = s.exported.name || s.exported.value;
        const local = s.local.name || s.local.value;
        if (stmt.source) { if (from) reexports.push({ name: exported, from: { file: from, name: local } }); }
        else exportsMap.set(exported, local);
      }
    } else if (stmt.type === 'ExportAllDeclaration') {
      const from = resolve(relPath, stmt.source.value);
      if (from) deps.add(from);
      if (from) reexports.push({ name: stmt.exported ? stmt.exported.name : '*', from: { file: from, name: '*' } });
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (d.type === 'Identifier') exportsMap.set('default', d.name);
      else if (d.type === 'ObjectExpression') addObjectFunctions(d);
      else if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') exportsMap.set('default', declare(d, true));
    } else if (stmt.type === 'ExpressionStatement') {
      const e = stmt.expression;
      const required = requireTarget(e, relPath, resolve);
      if (required) deps.add(required.file);
      if (e.type === 'AssignmentExpression' && isModuleExports(e.left)) {
        if (e.right.type === 'ObjectExpression') addObjectFunctions(e.right);
        else if (e.right.type === 'Identifier') exportsMap.set('default', e.right.name);
        else if (isFunctionNode(e.right) && e.right.id) { addFunction(e.right.id.name, e.right); exportsMap.set('default', e.right.id.name); }
        else if (e.right.type === 'ClassExpression' && e.right.id) { addClass(e.right.id.name, e.right); exportsMap.set('default', e.right.id.name); }
      } else if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && !e.callee.computed
        && e.callee.object.name === 'Object' && e.callee.property.name === 'assign' && isModuleExports(e.arguments[0])
        && e.arguments[1] && e.arguments[1].type === 'ObjectExpression') {
        addObjectFunctions(e.arguments[1]);
      } else if (e.type === 'AssignmentExpression' && e.left.type === 'MemberExpression' && !e.left.computed
        && ((e.left.object.type === 'Identifier' && e.left.object.name === 'exports') || isModuleExports(e.left.object))) {
        const name = e.left.property.name;
        if (isFunctionNode(e.right)) { addFunction(name, e.right); exportsMap.set(name, name); }
        else if (e.right.type === 'ClassExpression') { addClass(name, e.right); exportsMap.set(name, name); }
        else if (e.right.type === 'Identifier') exportsMap.set(name, e.right.name);
      }
    } else {
      declare(stmt, false);
    }
  }

  // What each function and method refers to, as unresolved references.
  const refsOf = (fn, className) => {
    const shadowed = new Set(fn.params.flatMap((p) => patternNames(p)));
    walk(fn.body, (node) => {
      if (node.type === 'VariableDeclarator') patternNames(node.id).forEach((n) => shadowed.add(n));
      else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) shadowed.add(node.id.name);
      else if (isFunctionNode(node) || node.type === 'FunctionDeclaration') node.params.flatMap((p) => patternNames(p)).forEach((n) => shadowed.add(n));
      else if (node.type === 'CatchClause' && node.param) patternNames(node.param).forEach((n) => shadowed.add(n));
    });
    const refs = [];
    const seen = new Set();
    const add = (ref) => { const k = JSON.stringify(ref); if (!seen.has(k)) { seen.add(k); refs.push(ref); } };
    walk(fn.body, (node, parent, key) => {
      if (node.type === 'Identifier' && isReference(parent, key) && !shadowed.has(node.name)) {
        const isNew = parent.type === 'NewExpression' && key === 'callee';
        // `ns.name` on a whole imported module: the export it names. (On a named import, which is
        // some exported value, the member is that value's own property, so it isn't followed.)
        const imp = imports.get(node.name);
        if (parent.type === 'MemberExpression' && key === 'object' && !parent.computed && imp && (imp.name === '*' || imp.name === 'default')) {
          add({ kind: 'import', local: node.name, member: parent.property.name, isNew: false });
        } else {
          add({ kind: 'name', name: node.name, isNew });
        }
      } else if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'ThisExpression' && className) {
        add({ kind: 'this', className, name: node.property.name });
      }
    });
    return refs;
  };
  for (const f of functions.values()) f.refs = refsOf(f.fn, null);
  for (const c of classes.values()) {
    c.methodRefs = new Map();
    for (const [name, fn] of c.methods) c.methodRefs.set(name, refsOf(fn, c.name));
  }
  return { functions, classes, exports: exportsMap, reexports, imports, deps };
}

// ---------- Linking files together ----------

/**
 * Builds the call graph across files: who calls what, and which classes create which.
 * @param {Map<string, object>} modules repo path -> the analyzeSource result for that file.
 * @returns {{ calls: Map<string, Set<string>>, callers: Map<string, Set<string>>, creates: Map<string, Set<string>>, nodes: Map<string, object> }}
 *   Graph keys are `file::name` for a function and `file::Class.method` for a method; class keys
 *   are `file::Class`. `nodes` describes each key: { file, name, kind: 'function'|'method'|'class', className }.
 */
function linkModules(modules) {
  const nodes = new Map();
  for (const [file, mod] of modules) {
    for (const name of mod.functions.keys()) nodes.set(`${file}::${name}`, { file, name, kind: 'function' });
    for (const c of mod.classes.values()) {
      nodes.set(`${file}::${c.name}`, { file, name: c.name, kind: 'class' });
      for (const m of c.methods.keys()) {
        nodes.set(`${file}::${c.name}.${m}`, { file, name: m === c.name ? 'constructor' : m, kind: 'method', className: c.name });
      }
    }
  }

  // An export of a file, as a graph key (or null), following re-exports.
  const resolveExport = (file, name, depth = 0) => {
    const mod = modules.get(file);
    if (!mod || depth > 6) return null;
    const local = mod.exports.get(name);
    if (local) return localKey(file, local, depth);
    for (const r of mod.reexports) {
      if (r.name === name) return r.from.name === '*' ? null : resolveExport(r.from.file, r.from.name, depth + 1);
      if (r.name === '*') { const hit = resolveExport(r.from.file, name, depth + 1); if (hit) return hit; }
    }
    // A CommonJS module's own functions are reachable as `module.name` too.
    return mod.functions.has(name) && mod.exports.size === 0 ? `${file}::${name}` : null;
  };
  // A file-level name, as a graph key: its own function or class, or what it imported under it.
  const localKey = (file, name, depth = 0) => {
    const mod = modules.get(file);
    if (!mod) return null;
    if (mod.functions.has(name)) return `${file}::${name}`;
    if (mod.classes.has(name)) return `${file}::${name}`;
    const imp = mod.imports.get(name);
    if (imp && imp.name !== '*') return resolveExport(imp.file, imp.name, depth + 1);
    if (imp && imp.name === '*') return resolveExport(imp.file, 'default', depth + 1);
    return null;
  };

  const calls = new Map();
  const creates = new Map();
  const link = (from, ref, file) => {
    let to = null;
    if (ref.kind === 'name') to = localKey(file, ref.name);
    else if (ref.kind === 'import') {
      const imp = modules.get(file).imports.get(ref.local);
      to = resolveExport(imp.file, ref.member);
    } else if (ref.kind === 'this') {
      const methodKey = `${file}::${ref.className}.${ref.name}`;
      to = nodes.has(methodKey) ? methodKey : null;
    }
    if (!to || to === from || !nodes.has(to)) return;
    const target = nodes.get(to);
    if (target.kind === 'class') {
      if (!creates.has(from)) creates.set(from, new Set());
      creates.get(from).add(to);
      // A `new X()` is also a call to X's constructor.
      const ctor = `${to}.${target.name}`;
      if (nodes.has(ctor) && ctor !== from) to = ctor; else return;
    }
    if (!calls.has(from)) calls.set(from, new Set());
    calls.get(from).add(to);
  };
  for (const [file, mod] of modules) {
    for (const f of mod.functions.values()) for (const ref of f.refs) link(`${file}::${f.name}`, ref, file);
    for (const c of mod.classes.values()) {
      for (const [m, refs] of c.methodRefs) for (const ref of refs) link(`${file}::${c.name}.${m}`, ref, file);
    }
  }
  const callers = new Map();
  for (const [from, tos] of calls) {
    for (const to of tos) {
      if (!callers.has(to)) callers.set(to, new Set());
      callers.get(to).add(from);
    }
  }
  return { calls, callers, creates, nodes };
}

// ---------- Drawing ----------

/**
 * Escapes text for a Graphviz HTML-like label.
 * @param {string} text Plain text.
 * @returns {string} The escaped text.
 */
function dotHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Escapes text for a quoted Graphviz attribute.
 * @param {string} text Plain text.
 * @returns {string} The escaped text.
 */
function dotString(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The shared top of every graph: transparent background and the site palette.
 * @param {string} rankdir 'LR' or 'TB'.
 * @returns {string[]} DOT lines.
 */
function graphHead(rankdir) {
  return [
    'digraph G {',
    `  graph [rankdir=${rankdir}, bgcolor="transparent", nodesep=0.14, ranksep=0.6, pad=0.1, newrank=true, fontname="Helvetica,Arial,sans-serif"];`,
    `  node [shape=box, style="filled,rounded", fontname="Helvetica,Arial,sans-serif", fontsize=11, height=0.3, margin="0.12,0.05", fillcolor="${PALETTE.cell}", color="${PALETTE.cyan}", fontcolor="${PALETTE.text}", penwidth=1];`,
    `  edge [color="${PALETTE.edge}", arrowsize=0.7, penwidth=1.3];`,
  ];
}

/**
 * A node's label: its name, plus its file in small text when it lives in another file than the
 * graph's subject.
 * @param {object} node The node description from linkModules.
 * @param {string} homeFile The file of the function the graph is about.
 * @param {boolean} focus True for the graph's subject.
 * @returns {string} A Graphviz HTML-like label.
 */
function nodeLabel(node, homeFile, focus) {
  const name = node.kind === 'method' ? `${node.className}.${node.name}()` : node.kind === 'class' ? node.name : `${node.name}()`;
  if (node.file === homeFile) return `<${dotHtml(name)}>`;
  const color = focus ? PALETTE.ink : PALETTE.dim;
  return `<${dotHtml(name)}<BR/><FONT POINT-SIZE="8" COLOR="${color}">${dotHtml(node.file)}</FONT>>`;
}

/**
 * A function's or method's name as it appears in a call graph box.
 * @param {object} node The node description from linkModules.
 * @returns {string} `name()`, or `Class.name()` for a method.
 */
function shortName(node) {
  return node.kind === 'method' ? `${node.className}.${node.name}()` : `${node.name}()`;
}

/**
 * Lays out boxes grouped in one labelled frame per file (or folder), so a box only needs its own
 * name. The frame of the graph's own file comes first.
 * @param {string[]} lines DOT lines to add to.
 * @param {Array<{ id: string, group: string, attrs: string[] }>} boxes The boxes.
 * @param {string} home The group drawn first.
 * @param {Function} [groupHref] Returns a link for a group's frame, or null.
 */
function clusteredBoxes(lines, boxes, home, groupHref = () => null) {
  const groups = new Map();
  for (const box of boxes) {
    if (!groups.has(box.group)) groups.set(box.group, []);
    groups.get(box.group).push(box);
  }
  const names = [...groups.keys()].sort((a, b) => (a === home ? -1 : b === home ? 1 : a.localeCompare(b)));
  names.forEach((group, i) => {
    const href = groupHref(group);
    lines.push(`  subgraph cluster_${i} {`);
    lines.push(`    label=<<FONT POINT-SIZE="9" COLOR="${PALETTE.cyan}">${dotHtml(group)}</FONT>>; labeljust=l; style="rounded,filled"; fillcolor="${PALETTE.bg2}"; color="${PALETTE.rule}"; penwidth=1; margin=8;`);
    if (href) lines.push(`    href="${dotString(href)}";`);
    for (const box of groups.get(group)) lines.push(`    ${box.id} [${box.attrs.join(', ')}];`);
    lines.push('  }');
  });
}

/**
 * The DOT source for one function's call graph (what it calls) or caller graph (what calls it).
 * Boxes are grouped by file. A second step out is drawn only when the first is small (at most
 * SECOND_STEP_LIMIT functions), and past MAX_NODES boxes the rest become one "+N more" box, so a
 * busy function still gets a short, straight list instead of a tangle.
 * @param {string} key The function's graph key.
 * @param {Map<string, Set<string>>} edges `calls` for a call graph, `callers` for a caller graph.
 * @param {Map<string, object>} nodes Node descriptions from linkModules.
 * @param {Function} hrefOf Returns a node's documentation link, or null.
 * @param {boolean} reverse True for a caller graph (arrows point at the subject).
 * @returns {?string} DOT source, or null when there is nothing to draw.
 */
function callGraphDot(key, edges, nodes, hrefOf, reverse) {
  const home = nodes.get(key).file;
  const order = (keys) => [...(keys || [])].filter((k) => nodes.has(k) && k !== key).sort((a, b) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    const fa = na.file === home ? '' : na.file;
    const fb = nb.file === home ? '' : nb.file;
    return fa.localeCompare(fb) || shortName(na).localeCompare(shortName(nb));
  });
  const first = order(edges.get(key));
  if (!first.length) return null;
  const keep = [key];
  const drawn = [];
  let more = 0;
  for (const k of first) {
    if (keep.length > MAX_NODES) { more++; continue; }
    keep.push(k);
    drawn.push([key, k]);
  }
  if (first.length <= SECOND_STEP_LIMIT) {
    for (const k of first) {
      for (const n of order(edges.get(k))) {
        if (!keep.includes(n)) {
          if (keep.length > MAX_NODES) continue;
          keep.push(n);
        }
        drawn.push([k, n]);
      }
    }
  }
  const id = new Map(keep.map((k, i) => [k, `n${i}`]));
  const lines = graphHead('LR');
  const boxes = keep.map((k) => {
    const node = nodes.get(k);
    const attrs = [`label=<${dotHtml(shortName(node))}>`];
    if (k === key) attrs.push(`fillcolor="${PALETTE.yellow}"`, `fontcolor="${PALETTE.ink}"`, `color="${PALETTE.yellow}"`, 'penwidth=1.5');
    const href = k === key ? null : hrefOf(k);
    if (href) attrs.push(`href="${dotString(href)}"`, `tooltip="${dotString(`${shortName(node)} in ${node.file}`)}"`);
    return { id: id.get(k), group: node.file, attrs };
  });
  clusteredBoxes(lines, boxes, home);
  if (more) {
    lines.push(`  more [label=<+ ${more} more>, shape=box, style="rounded,dashed", fillcolor="transparent", color="${PALETTE.rule}", fontcolor="${PALETTE.dim}"];`);
    lines.push(reverse ? `  more -> ${id.get(key)} [style=dashed, samehead=subject];` : `  ${id.get(key)} -> more [style=dashed, sametail=subject];`);
  }
  // Edges at the subject share one end point, so a long list of callers or callees meets it as
  // one trunk instead of a fan of separate arrowheads.
  for (const [a, b] of drawn) {
    const trunk = a === key ? (reverse ? ' [samehead=subject]' : ' [sametail=subject]') : '';
    lines.push(reverse ? `  ${id.get(b)} -> ${id.get(a)}${trunk};` : `  ${id.get(a)} -> ${id.get(b)}${trunk};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * The DOT source for a file's imports (what it imports) or importers (what imports it), one step
 * out, grouped by folder. Past MAX_FILES files it shows one box per folder with a count instead.
 * @param {string} file The file the graph is about.
 * @param {Set<string>} related The files it imports, or the files that import it.
 * @param {Function} fileHref Returns a file's documentation link, or null.
 * @param {Function} dirHref Returns a folder's documentation link, or null.
 * @param {boolean} reverse True for "what imports this file" (arrows point at the file).
 * @returns {?string} DOT source, or null when there is nothing to draw.
 */
function fileGraphDot(file, related, fileHref, dirHref, reverse) {
  const files = [...related].filter((f) => f !== file).sort();
  if (!files.length) return null;
  const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
  const baseOf = (f) => f.slice(f.lastIndexOf('/') + 1);
  const lines = graphHead('LR');
  const link = (to) => (reverse ? `  ${to} -> focus;` : `  focus -> ${to};`);
  lines.push(`  focus [label=<${dotHtml(file)}>, fillcolor="${PALETTE.yellow}", fontcolor="${PALETTE.ink}", color="${PALETTE.yellow}", penwidth=1.5];`);
  if (files.length <= MAX_FILES) {
    const boxes = files.map((f, i) => {
      const href = fileHref(f);
      const attrs = [`label=<${dotHtml(baseOf(f))}>`];
      if (href) attrs.push(`href="${dotString(href)}"`, `tooltip="${dotString(f)}"`);
      return { id: `f${i}`, group: dirOf(f), attrs };
    });
    clusteredBoxes(lines, boxes, dirOf(file), dirHref);
    boxes.forEach((b) => lines.push(link(b.id)));
  } else {
    const counts = new Map();
    for (const f of files) counts.set(dirOf(f), (counts.get(dirOf(f)) || 0) + 1);
    [...counts.keys()].sort().forEach((dir, i) => {
      const n = counts.get(dir);
      const href = dirHref(dir);
      const attrs = [`label=<${dotHtml(dir)}/  <FONT COLOR="${PALETTE.dim}">${n} file${n === 1 ? '' : 's'}</FONT>>`];
      if (href) attrs.push(`href="${dotString(href)}"`);
      lines.push(`  d${i} [${attrs.join(', ')}];`);
      lines.push(link(`d${i}`));
    });
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * The DOT source for one class: the class with its properties and methods, the class it extends, the classes it
 * creates, and the classes and functions that create it.
 * @param {string} key The class's graph key.
 * @param {object} graph The linkModules result.
 * @param {Map<string, object>} modules repo path -> analyzeSource result.
 * @param {Function} hrefOf Returns a node's documentation link, or null.
 * @returns {string} DOT source.
 */
function classGraphDot(key, graph, modules, hrefOf) {
  const { nodes, creates } = graph;
  const node = nodes.get(key);
  const cls = modules.get(node.file).classes.get(node.name);
  const lines = graphHead('TB');
  const methods = [...cls.methods.keys()].map((m) => (m === cls.name ? 'constructor()' : `${m}()`));
  const row = (text, color = PALETTE.text) => `<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="10" COLOR="${color}">${dotHtml(text)}</FONT></TD></TR>`;
  // A UML-style box: properties, a rule, then methods.
  const fieldRows = cls.fields.map((f) => row(f, PALETTE.cyan)).join('');
  const rule = fieldRows && methods.length ? `<HR/>` : '';
  const rows = fieldRows + rule + methods.map((m) => row(m)).join('');
  lines.push(`  focus [shape=plain, style="", label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" COLOR="${PALETTE.yellow}" BGCOLOR="${PALETTE.cell}">`
    + `<TR><TD BGCOLOR="${PALETTE.yellow}"><FONT COLOR="${PALETTE.ink}"><B>${dotHtml(cls.name)}</B></FONT></TD></TR>`
    + `${rows || `<TR><TD><FONT POINT-SIZE="9" COLOR="${PALETTE.dim}">(no members)</FONT></TD></TR>`}</TABLE>>];`);
  let n = 0;
  const added = new Map();
  const box = (k, label) => {
    if (added.has(k)) return added.get(k);
    const id = `n${n++}`;
    added.set(k, id);
    const href = k && hrefOf(k);
    const attrs = [`label=${label}`];
    if (href) attrs.push(`href="${dotString(href)}"`);
    if (!k) attrs.push('style="filled,rounded,dashed"', `fillcolor="${PALETTE.head}"`, `fontcolor="${PALETTE.dim}"`);
    lines.push(`  ${id} [${attrs.join(', ')}];`);
    return id;
  };
  if (cls.superName) {
    const baseKey = (() => {
      const mod = modules.get(node.file);
      if (mod.classes.has(cls.superName)) return `${node.file}::${cls.superName}`;
      const imp = mod.imports.get(cls.superName);
      return imp ? [...nodes.keys()].find((k) => k.startsWith(`${imp.file}::`) && nodes.get(k).kind === 'class' && nodes.get(k).name === imp.name) || null : null;
    })();
    const id = box(baseKey, baseKey ? nodeLabel(nodes.get(baseKey), node.file, false) : `<${dotHtml(cls.superName)}>`);
    lines.push(`  focus -> ${id} [arrowhead=empty, arrowsize=0.9, label=<<FONT POINT-SIZE="8" COLOR="${PALETTE.dim}">extends</FONT>>];`);
  }
  // Other classes that extend this one.
  for (const [k, other] of nodes) {
    if (other.kind !== 'class' || k === key) continue;
    const sub = modules.get(other.file).classes.get(other.name);
    if (sub.superName === cls.name && (other.file === node.file || modules.get(other.file).imports.get(cls.name))) {
      const id = box(k, nodeLabel(other, node.file, false));
      lines.push(`  ${id} -> focus [arrowhead=empty, arrowsize=0.9, label=<<FONT POINT-SIZE="8" COLOR="${PALETTE.dim}">extends</FONT>>];`);
    }
  }
  // What this class creates, and what creates it. A method's `new` counts for its class.
  const ownerOf = (k) => { const d = nodes.get(k); return d.kind === 'method' ? `${d.file}::${d.className}` : k; };
  const made = new Set();
  const makers = new Set();
  for (const [from, tos] of creates) {
    for (const to of tos) {
      if (ownerOf(from) === key && to !== key) made.add(to);
      if (to === key && ownerOf(from) !== key) makers.add(ownerOf(from));
    }
  }
  for (const k of [...made].sort()) {
    lines.push(`  focus -> ${box(k, nodeLabel(nodes.get(k), node.file, false))} [style=dashed, label=<<FONT POINT-SIZE="8" COLOR="${PALETTE.dim}">creates</FONT>>];`);
  }
  for (const k of [...makers].sort()) {
    lines.push(`  ${box(k, nodeLabel(nodes.get(k), node.file, false))} -> focus [style=dashed, label=<<FONT POINT-SIZE="8" COLOR="${PALETTE.dim}">creates</FONT>>];`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Renders DOT files to SVG with Graphviz, several `dot` processes at once, each given a batch of
 * files (one process per graph would take minutes for a few thousand graphs).
 * @param {string} dir The folder holding the .dot files; each `x.dot` gets an `x.dot.svg`.
 * @param {string[]} names The .dot file names.
 * @param {string} dotCommand The dot executable.
 * @returns {Promise<void>} Resolves when every batch has finished.
 */
async function renderAll(dir, names, dotCommand) {
  const batches = [];
  for (let i = 0; i < names.length; i += 200) batches.push(names.slice(i, i + 200));
  const workers = Math.max(1, Math.min(os.cpus().length, 8));
  let next = 0;
  const run = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      await new Promise((resolve, reject) => {
        const child = spawn(dotCommand, ['-Tsvg', '-O', ...batch], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`dot failed (${code}): ${err.slice(0, 500)}`))));
      });
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
}

/**
 * Turns a Graphviz SVG into markup to put inside an HTML page: no XML prolog or comments, ids made
 * unique to this graph, and the dark color scheme.
 * @param {string} svg The SVG file's text.
 * @param {string} prefix A prefix that makes this graph's ids unique on its page.
 * @returns {string} The inline SVG.
 */
function inlineSvg(svg, prefix) {
  return svg
    .replace(/<\?xml[^>]*>\s*/, '')
    .replace(/<!DOCTYPE[^>]*>\s*/, '')
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace(/\sid="/g, ` id="${prefix}`)
    .replace(/<svg\b/, '<svg class="rtv-graph" role="img"')
    .trim();
}

// ---------- Putting the graphs in the pages ----------

/**
 * Reads which page and anchor documents each function, class and method, from Doxygen's HTML.
 * @param {string} htmlDir The generated HTML folder.
 * @returns {{ files: Map<string, object>, classes: Map<string, object[]>, dirs: Map<string, string> }}
 *   File pages by repo path and class pages by class name, each { page, anchors: Map name -> anchor },
 *   and folder pages by repo path.
 */
function readPages(htmlDir) {
  const files = new Map();
  const classes = new Map();
  const dirs = new Map();
  for (const page of fs.readdirSync(htmlDir)) {
    if (!page.endsWith('.html') || page.endsWith('_source.html')) continue;
    const html = fs.readFileSync(path.join(htmlDir, page), 'utf8');
    const title = (html.match(/<title>[^:<]*: ([^<]*)<\/title>/) || [])[1];
    if (!title) continue;
    const fileMatch = title.match(/^(.*) File Reference$/);
    const classMatch = title.match(/^(.*) Class Reference$/);
    const dirMatch = title.match(/^(.*) Directory Reference$/);
    if (dirMatch) { dirs.set(decodeEntities(dirMatch[1]).replace(/\/$/, ''), page); continue; }
    if (!fileMatch && !classMatch) continue;
    const anchors = new Map();
    for (const m of html.matchAll(/<h2 class="memtitle"><span class="permalink"><a href="#(\w+)">[^<]*<\/a><\/span>([\w$]+)/g)) {
      if (!anchors.has(m[2])) anchors.set(m[2], m[1]);
    }
    const entry = { page, anchors };
    if (fileMatch) files.set(decodeEntities(fileMatch[1]), entry);
    else {
      const name = decodeEntities(classMatch[1]);
      if (!classes.has(name)) classes.set(name, []);
      classes.get(name).push(entry);
    }
  }
  return { files, classes, dirs };
}

/**
 * Decodes the few HTML entities Doxygen writes in page titles.
 * @param {string} text Title text.
 * @returns {string} Plain text.
 */
function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * One collapsible graph section in Doxygen's own markup (dynsections.js opens and closes it).
 * @param {string} id A page-unique id.
 * @param {string} heading The section's heading.
 * @param {string} svg The inline SVG.
 * @returns {string} HTML.
 */
function graphSection(id, heading, svg) {
  return `${MARK_START}<div id="${id}" class="dynheader closed"><span class="dynarrow"><span class="arrowhead closed"></span></span>${heading}</div>\n`
    + `<div id="${id}-summary" class="dynsummary">\n</div>\n`
    + `<div id="${id}-content" class="dyncontent hidden">\n<div class="center rtv-graph-box">${svg}</div>\n</div>\n${MARK_END}`;
}

// Comments around every added section, so a re-run (`--brand-only`) can take the old ones out.
const MARK_START = '<!--rtv-graph-->';
const MARK_END = '<!--/rtv-graph-->';
const MARKED = /<!--rtv-graph-->[\s\S]*?<!--\/rtv-graph-->/g;

/**
 * Inserts HTML at the end of one member's documentation block (just before its memdoc closes).
 * @param {string} html The page.
 * @param {string} anchor The member's anchor id.
 * @param {string} insert The HTML to add.
 * @returns {string} The page with the HTML added, or unchanged if the member wasn't found.
 */
function insertIntoMember(html, anchor, insert) {
  const start = html.indexOf(`<h2 class="memtitle"><span class="permalink"><a href="#${anchor}">`);
  if (start < 0) return html;
  const doc = html.indexOf('<div class="memdoc">', start);
  if (doc < 0) return html;
  // The member ends where the next member, section or the page contents begin.
  const ends = ['<h2 class="memtitle">', '<h2 class="groupheader">', '<!-- contents -->', '<hr/>The documentation for this']
    .map((s) => html.indexOf(s, doc)).filter((i) => i > 0);
  const end = ends.length ? Math.min(...ends) : html.length;
  const close = html.lastIndexOf('</div>\n</div>', end);
  if (close < doc) return html;
  return html.slice(0, close) + insert + html.slice(close);
}

/**
 * Adds call, caller and class graphs to the generated code reference.
 * @param {object} opts
 * @param {string} opts.root The repo root.
 * @param {string} opts.htmlDir The generated HTML folder (docs/api/html).
 * @param {string} opts.dotCommand The Graphviz dot executable.
 * @returns {Promise<{ functions: number, classes: number }>} How many call/caller and class graphs were added.
 */
async function addGraphs({ root, htmlDir, dotCommand }) {
  const pages = readPages(htmlDir);
  const modules = new Map();
  for (const file of pages.files.keys()) {
    if (!/\.(c|m)?js$/.test(file)) continue;
    let source;
    try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    const mod = analyzeSource(source, file);
    if (mod) modules.set(file, mod);
  }
  const graph = linkModules(modules);
  const { nodes, calls, callers } = graph;

  // Where each node is documented. A class or method needs a class page for its name; when two
  // classes share a name, neither gets one (the page can't be told apart).
  const classPage = (name) => { const p = pages.classes.get(name); return p && p.length === 1 ? p[0] : null; };
  const placeOf = (key) => {
    const node = nodes.get(key);
    if (node.kind === 'function') {
      const page = pages.files.get(node.file);
      const anchor = page && page.anchors.get(node.name);
      return anchor ? { page: page.page, anchor } : null;
    }
    const page = classPage(node.kind === 'class' ? node.name : node.className);
    if (!page) return null;
    if (node.kind === 'class') return { page: page.page, anchor: null };
    const anchor = page.anchors.get(node.name === 'constructor' ? node.className : node.name);
    return anchor ? { page: page.page, anchor } : null;
  };
  const hrefOf = (key) => { const p = placeOf(key); return p ? (p.anchor ? `${p.page}#${p.anchor}` : p.page) : null; };

  // Write every graph's DOT file, render them all, then put each SVG in its page.
  const work = path.join(htmlDir, '..', 'graphs-tmp');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const jobs = []; // { page, anchor, heading, name, kind }
  const addJob = (place, heading, dot, kind) => {
    const name = `g${jobs.length}.dot`;
    fs.writeFileSync(path.join(work, name), dot);
    jobs.push({ ...place, heading, name, kind });
  };
  let functionGraphs = 0;
  for (const key of nodes.keys()) {
    const node = nodes.get(key);
    if (node.kind === 'class') continue;
    const place = placeOf(key);
    if (!place || !place.anchor) continue;
    const what = node.kind === 'method' ? 'method' : 'function';
    const out = callGraphDot(key, calls, nodes, hrefOf, false);
    const into = callGraphDot(key, callers, nodes, hrefOf, true);
    if (out) addJob(place, `What this ${what} calls:`, out, 'member');
    if (into) addJob(place, `What calls this ${what}:`, into, 'member');
    if (out || into) functionGraphs++;
  }
  // Each file's imports and importers, among the documented files.
  const importers = new Map();
  for (const [file, mod] of modules) {
    for (const dep of mod.deps) {
      if (!modules.has(dep)) continue;
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep).add(file);
    }
  }
  const fileHref = (f) => (pages.files.has(f) ? pages.files.get(f).page : null);
  const dirHref = (d) => pages.dirs.get(d) || null;
  for (const [file, mod] of modules) {
    const place = { page: pages.files.get(file).page, anchor: null };
    const out = fileGraphDot(file, new Set([...mod.deps].filter((d) => modules.has(d))), fileHref, dirHref, false);
    const into = fileGraphDot(file, importers.get(file) || new Set(), fileHref, dirHref, true);
    if (out) addJob(place, 'What this file imports:', out, 'file');
    if (into) addJob(place, 'What imports this file:', into, 'file');
  }
  let classGraphs = 0;
  for (const key of nodes.keys()) {
    if (nodes.get(key).kind !== 'class') continue;
    const place = placeOf(key);
    if (!place) continue;
    addJob(place, `Class graph for ${dotHtml(nodes.get(key).name)}:`, classGraphDot(key, graph, modules, hrefOf), 'class');
    classGraphs++;
  }
  await renderAll(work, jobs.map((j) => j.name), dotCommand);

  const byPage = new Map();
  for (const job of jobs) {
    if (!byPage.has(job.page)) byPage.set(job.page, []);
    byPage.get(job.page).push(job);
  }
  for (const page of new Set([...byPage.keys(), ...[...pages.files.values(), ...[...pages.classes.values()].flat()].map((p) => p.page)])) {
    const file = path.join(htmlDir, page);
    const before = fs.readFileSync(file, 'utf8');
    let html = before.replace(MARKED, '').replace(/<div class="textblock"><\/div>/g, '');
    const top = []; // file and class graphs, which go at the top of the page
    (byPage.get(page) || []).forEach((job, i) => {
      const svg = inlineSvg(fs.readFileSync(path.join(work, `${job.name}.svg`), 'utf8'), `rtvg${i}-`);
      const section = graphSection(`rtv-graph-${i}`, job.heading, svg);
      if (job.kind === 'member') html = insertIntoMember(html, job.anchor, section);
      else top.push(section);
    });
    if (top.length) html = html.replace('<div class="contents">', `<div class="contents">\n<div class="textblock">${top.join('')}</div>`);
    if (html !== before) fs.writeFileSync(file, html);
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { functions: functionGraphs, classes: classGraphs };
}

module.exports = { analyzeSource, linkModules, callGraphDot, fileGraphDot, classGraphDot, insertIntoMember, addGraphs };
