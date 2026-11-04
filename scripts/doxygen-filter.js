#!/usr/bin/env node
// Doxygen input filter for the app's JavaScript (the Doxyfile's FILTER_PATTERNS; `npm run docs`).
//
//   node scripts/doxygen-filter.js <file.js>
//
// Doxygen has no JavaScript parser: it reads .js as C++ and finds nothing in it. This parses the
// file with espree (ESLint's parser) and prints C++-shaped declarations Doxygen can read, one for
// each top-level function, class, class member and variable, on the line where it starts. Every
// other line comes out blank, so line numbers match the real file and the source browser (which
// shows the unfiltered file) links to the right place.
//
// The codebase's ordinary comments become the docs, so nothing has to be rewritten for Doxygen:
// - the first comment block in a file, before any code, documents the file;
// - a comment block directly above a declaration (no blank line between) documents it;
// - a `//` comment after a one-line variable or class field documents that member.
// Doxygen's markup characters in those comments are escaped outside `code spans`, so `<dir>` or
// `@name` prints as written. JSDoc `@param {Type} name` and `@returns {Type}` tags still work.
//
// A function or variable that is not exported (ES `export`, or a name in CommonJS
// `module.exports`) is printed `static`, so Doxygen lists a file's internal helpers apart from
// what it exports.
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const ROOT = path.join(__dirname, '..');

// JSDoc tags Doxygen also understands. Any other `@word` in a comment is escaped.
const DOC_TAGS = /^@(param|returns?|throws|see|deprecated|example|todo|note|since|warning)\b/;

// Names that would derail Doxygen's C++ parser if printed as a declaration's name.
const CPP_KEYWORDS = new Set([
  'auto', 'bool', 'char', 'class', 'const', 'default', 'delete', 'double', 'enum', 'explicit',
  'extern', 'float', 'friend', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'operator',
  'private', 'protected', 'public', 'register', 'short', 'signed', 'sizeof', 'static', 'struct',
  'template', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
]);

function parse(source) {
  const options = { ecmaVersion: 'latest', comment: true, loc: true, range: true };
  let firstError = null;
  for (const sourceType of ['module', 'commonjs']) {
    try {
      return { ast: espree.parse(source, { ...options, sourceType }) };
    } catch (err) {
      firstError = firstError || err;
    }
  }
  return { error: firstError };
}

// Escapes Doxygen's markup characters, except inside `code spans`.
function escapeText(text) {
  return text.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(/[\\<>&#%$@]/g, '\\$&'))).join('');
}

// One line of comment text as Doxygen doc text.
function docText(raw) {
  const lead = raw.match(/^\s*/)[0];
  const text = raw.slice(lead.length);
  if (/^[-=]{3,}/.test(text)) return ''; // a `// ---------- Section ----------` divider
  const param = text.match(/^@(?:param|arg|argument)\s+\{([^}]*)\}\s+\[?([\w$.]+)[^\s\]]*\]?(.*)$/);
  if (param) return `${lead}@param ${param[2]} \`${param[1]}\`${escapeText(param[3])}`;
  const returns = text.match(/^@returns?\s+\{([^}]*)\}(.*)$/);
  if (returns) return `${lead}@returns \`${returns[1]}\`${escapeText(returns[2])}`;
  const tag = text.match(DOC_TAGS);
  if (tag) return lead + tag[0] + escapeText(text.slice(tag[0].length));
  return lead + escapeText(text);
}

// Marks a doc block's first sentence (or first paragraph) as its brief, in place. Doxygen's own
// JAVADOC_AUTOBRIEF can't do this: it ends the sentence at a `. ` or `? ` inside a code span.
function markBrief(entries) {
  const first = entries.findIndex((e) => e.text);
  if (first < 0 || entries[first].text.startsWith('@')) return;
  const more = (i) => entries.some((e, j) => j > i && e.text);
  for (let i = first; i < entries.length; i++) {
    const text = entries[i].text;
    if (!text) { // the first paragraph ends without a full stop
      if (more(i)) entries[i - 1].text += ' \\details';
      break;
    }
    const end = sentenceEnd(text);
    if (end < 0) continue;
    if (text.slice(end).trim()) entries[i].text = `${text.slice(0, end)} \\details ${text.slice(end).trimStart()}`;
    else if (more(i)) entries[i].text += ' \\details';
    break;
  }
  entries[first].text = `\\brief ${entries[first].text}`;
}

// Where the first sentence on a line ends (just past its `.`, `?` or `!`), or -1.
function sentenceEnd(text) {
  let code = false;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '`') code = !code;
    else if (!code && /[.?!]/.test(text[k]) && (k + 1 === text.length || /\s/.test(text[k + 1]))
      && !/\b(e\.g|i\.e|vs|cf)\.$/i.test(text.slice(0, k + 1))) return k + 1;
  }
  return -1;
}

// A comment's text, one entry per source line, with the comment markers removed.
function commentLines(comment) {
  if (comment.type === 'Line') return [comment.value.replace(/^\/?/, '').replace(/^ /, '')];
  return comment.value.split(/\r?\n/).map((line, i) => {
    const text = i === 0 ? line.replace(/^[*!]/, '') : line.replace(/^\s*\*(?!\/)/, '');
    return text.trim() ? text.replace(/^ /, '') : '';
  });
}

// Comments that start their own line, grouped: a run of `//` lines with no gap, or one `/* */`.
function commentBlocks(comments, lines) {
  const blocks = [];
  for (const c of comments) {
    if (c.type !== 'Line' && c.type !== 'Block') continue;
    const start = c.loc.start.line;
    if (lines[start - 1].slice(0, c.loc.start.column).trim()) continue; // trailing comment
    const last = blocks[blocks.length - 1];
    if (c.type === 'Line' && last && last.type === 'Line' && last.end === start - 1) {
      last.comments.push(c);
      last.end = start;
    } else {
      blocks.push({ type: c.type, start, end: c.loc.end.line, comments: [c], jsdoc: c.type === 'Block' && c.value.startsWith('*') });
    }
  }
  return blocks;
}

function filterSource(source, relPath) {
  source = source.replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  const out = lines.map(() => '');
  const { ast, error } = parse(source);
  if (!ast) {
    process.stderr.write(`${relPath}: warning: not documented, espree could not parse it (${error.message})\n`);
    return out.join('\n');
  }

  const put = (line, text) => { out[line - 1] = out[line - 1] ? `${out[line - 1]} ${text}` : text; };
  const src = (node) => source.slice(node.range[0], node.range[1]);
  const blocks = commentBlocks(ast.comments, lines);
  const blockEndingAt = new Map(blocks.map((b) => [b.end, b]));
  const trailing = new Map();
  for (const c of ast.comments) {
    if (c.type === 'Line' && lines[c.loc.start.line - 1].slice(0, c.loc.start.column).trim()) trailing.set(c.loc.start.line, c);
  }

  // The first comment block before any code is the file's doc, unless it is a JSDoc block sitting
  // directly on the first declaration.
  const firstCode = ast.body.length ? ast.body[0].loc.start.line : Infinity;
  const first = blocks[0];
  const header = first && first.start < firstCode && !(first.jsdoc && first.end === firstCode - 1) ? first : null;
  const used = new Set(header ? [header] : []);

  const writeBlock = (block, prefix = '') => {
    used.add(block);
    const entries = block.comments.flatMap((c) => commentLines(c).map((text, i) => ({ line: c.loc.start.line + i, text: text && docText(text) })));
    markBrief(entries);
    entries.forEach(({ line, text }, i) => {
      const indent = lines[line - 1].match(/^\s*/)[0];
      const lead = i === 0 && prefix ? ` ${prefix}` : '';
      out[line - 1] = `${indent}///${lead}${text ? ` ${text}` : ''}`;
    });
  };
  const docAbove = (node) => {
    const block = blockEndingAt.get(node.loc.start.line - 1);
    if (block && !used.has(block)) writeBlock(block);
  };
  const docAfter = (node) => {
    const line = node.loc.start.line;
    const c = trailing.get(line);
    if (c && node.loc.end.line === line && c.range[0] >= node.range[1]) put(line, `///< ${docText(commentLines(c)[0])}`);
  };

  // A short, single-line initializer or default value Doxygen can print as written.
  const shortValue = (node) => {
    const text = src(node);
    return text.length <= 48 && !/[\n{};`]|\/[/*]/.test(text) ? text : '';
  };
  const keyName = (key) => (key.type === 'Identifier' || key.type === 'PrivateIdentifier' ? key.name
    : key.type === 'Literal' && /^[A-Za-z_$][\w$]*$/.test(String(key.value)) ? String(key.value) : null);
  const param = (p) => {
    switch (p.type) {
      case 'Identifier': return p.name;
      case 'AssignmentPattern': {
        const value = shortValue(p.right);
        return param(p.left) + (value ? ` = ${value}` : '');
      }
      case 'RestElement': return `...${param(p.argument)}`;
      case 'ObjectPattern': return `{${p.properties.map((q) => (q.type === 'RestElement' ? param(q) : keyName(q.key) || '?')).join(', ')}}`;
      case 'ArrayPattern': return `[${p.elements.map((e) => (e ? param(e) : '')).join(', ')}]`;
      default: return '?';
    }
  };
  const params = (fn) => fn.params.map(param).join(', ');
  const isFunction = (node) => node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');
  const isRequire = (node) => {
    while (node && (node.type === 'MemberExpression' || node.type === 'AwaitExpression')) node = node.object || node.argument;
    return node && ((node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') || node.type === 'ImportExpression');
  };
  const usable = (name) => name && !CPP_KEYWORDS.has(name);

  // ---------- What the file exports ----------
  const exported = new Set();
  const isModuleExports = (node) => node.type === 'MemberExpression' && !node.computed
    && node.object.type === 'Identifier' && node.object.name === 'module' && node.property.name === 'exports';
  const exportTarget = (node) => { // `module.exports.x` / `exports.x` -> 'x'
    if (node.type !== 'MemberExpression' || node.computed) return null;
    const obj = node.object;
    return (obj.type === 'Identifier' && obj.name === 'exports') || isModuleExports(obj) ? node.property.name : null;
  };
  const exportedObjects = []; // `module.exports = {...}` / `export default {...}`: their inline functions get documented
  for (const stmt of ast.body) {
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration) {
      for (const s of stmt.specifiers) if (s.local.type === 'Identifier') exported.add(s.local.name);
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (d.type === 'Identifier') exported.add(d.name);
      else if (d.type === 'ObjectExpression') exportedObjects.push(d);
    } else if (stmt.type === 'ExpressionStatement') {
      const e = stmt.expression;
      let value = null;
      if (e.type === 'AssignmentExpression' && isModuleExports(e.left)) value = e.right;
      else if (e.type === 'CallExpression' && src(e.callee) === 'Object.assign' && e.arguments[0] && isModuleExports(e.arguments[0])) value = e.arguments[1];
      else if (e.type === 'AssignmentExpression' && exportTarget(e.left) && e.right.type === 'Identifier') exported.add(e.right.name);
      if (value && value.type === 'Identifier') exported.add(value.name);
      if (value && value.type === 'ObjectExpression') {
        exportedObjects.push(value);
        for (const p of value.properties) if (p.type === 'Property' && p.value.type === 'Identifier') exported.add(p.value.name);
      }
    }
  }

  // ---------- Declarations ----------
  const writeFunction = (node, name, fn, isExported) => {
    if (!usable(name)) return;
    docAbove(node);
    put(node.loc.start.line, `${isExported ? '' : 'static '}${fn.async ? 'async ' : ''}function ${name}(${params(fn)});`);
  };
  const writeClass = (node, name, cls) => {
    if (!usable(name)) return;
    docAbove(node);
    const base = cls.superClass && (cls.superClass.type === 'Identifier' || cls.superClass.type === 'MemberExpression')
      ? ` : public ${src(cls.superClass).replace(/\./g, '::')}` : '';
    put(node.loc.start.line, `class ${name}${base} { public:`);
    for (const m of cls.body.body) {
      const memberName = m.computed || !m.key ? null : keyName(m.key);
      if (!usable(memberName)) continue;
      const mods = m.static ? 'static ' : '';
      let decl = null;
      if (m.type === 'MethodDefinition') {
        const prefix = m.kind === 'get' || m.kind === 'set' ? `${m.kind} ` : m.value.async ? 'async ' : '';
        decl = `${mods}${prefix}${m.kind === 'constructor' ? name : memberName}(${params(m.value)});`;
      } else if (m.type === 'PropertyDefinition') {
        decl = isFunction(m.value) ? `${mods}${m.value.async ? 'async ' : ''}${memberName}(${params(m.value)});` : `${mods}${memberName};`;
      }
      if (!decl) continue;
      docAbove(m);
      put(m.loc.start.line, m.key.type === 'PrivateIdentifier' ? `private: ${decl} public:` : decl);
      if (m.type === 'PropertyDefinition') docAfter(m);
    }
    put(cls.loc.end.line, '};');
  };
  const writeVariables = (node, decl, isExported) => {
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || !usable(d.id.name) || isRequire(d.init)) continue;
      const at = decl.declarations.length === 1 ? node : d;
      const visible = isExported || exported.has(d.id.name);
      if (isFunction(d.init)) writeFunction(at, d.id.name, d.init, visible);
      else if (d.init && d.init.type === 'ClassExpression') writeClass(at, d.id.name, d.init);
      else {
        docAbove(at);
        const value = d.init && shortValue(d.init);
        put(d.loc.start.line, `${visible ? '' : 'static '}${decl.kind} ${d.id.name}${value ? ` = ${value}` : ''};`);
        docAfter(at);
      }
    }
  };
  const writeDeclaration = (node, decl, isExported) => {
    if (decl.type === 'FunctionDeclaration') {
      writeFunction(node, decl.id ? decl.id.name : 'defaultExport', decl, isExported || exported.has(decl.id.name));
    } else if (decl.type === 'ClassDeclaration') {
      writeClass(node, decl.id ? decl.id.name : 'DefaultExport', decl);
    } else if (decl.type === 'VariableDeclaration') {
      writeVariables(node, decl, isExported);
    }
  };

  for (const stmt of ast.body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) writeDeclaration(stmt, stmt.declaration, true);
    else if (stmt.type === 'ExportDefaultDeclaration') writeDeclaration(stmt, stmt.declaration, true);
    else if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression') {
      const e = stmt.expression; // `exports.x = ...`, `module.exports = function name() {...}`
      const name = exportTarget(e.left) || (isModuleExports(e.left) && e.right.id && e.right.id.name);
      if (name && isFunction(e.right)) writeFunction(stmt, name, e.right, true);
      else if (name && e.right.type === 'ClassExpression') writeClass(stmt, name, e.right);
    } else writeDeclaration(stmt, stmt, false);
  }
  for (const obj of exportedObjects) {
    for (const p of obj.properties) {
      const name = p.type === 'Property' && !p.computed && keyName(p.key);
      if (name && isFunction(p.value)) writeFunction(p, name, p.value, true);
    }
  }

  if (header) writeBlock(header, `\\file ${relPath}`);
  return out.join('\n');
}

module.exports = { filterSource };

if (require.main === module) {
  const file = path.resolve(process.argv[2]);
  const rel = path.relative(ROOT, file);
  const relPath = (rel.startsWith('..') ? path.basename(file) : rel).split(path.sep).join('/');
  process.stdout.write(filterSource(fs.readFileSync(file, 'utf8'), relPath));
}
