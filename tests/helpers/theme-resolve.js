// Shared by the theme token and contrast tests: a small stand-in for the
// browser's custom-property cascade over tokens.css and the theme packs.
// tokenBlock() reads custom properties from innermost blocks with a given
// selector; resolver() follows var() chains (with fallbacks) and throws on a
// cycle or an unresolvable reference, which in CSS would silently drop the
// property.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function tokenBlock(css, selectors) {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const text = stripComments(css);
  let m;
  while ((m = re.exec(text))) {
    const list = m[1].split(',').map((s) => s.trim());
    if (!list.some((s) => selectors.includes(s))) continue;
    for (const decl of m[2].split(/;(?![^(]*\))/)) {
      const at = decl.indexOf(':');
      if (at === -1) continue;
      const name = decl.slice(0, at).trim();
      if (name.startsWith('--')) out[name] = decl.slice(at + 1).trim();
    }
  }
  return out;
}

function resolver(tokens) {
  const cache = new Map();
  const resolve = (name, stack = []) => {
    if (cache.has(name)) return cache.get(name);
    if (stack.includes(name)) throw new Error(`cycle: ${[...stack, name].join(' → ')}`);
    if (!(name in tokens)) return undefined;
    const value = substitute(tokens[name], [...stack, name]);
    cache.set(name, value);
    return value;
  };
  const substitute = (value, stack) => {
    let text = value;
    for (let guard = 0; guard < 200; guard += 1) {
      const i = text.lastIndexOf('var(');
      if (i === -1) break;
      let depth = 0;
      let j = i + 3;
      for (; j < text.length; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      const inner = text.slice(i + 4, j);
      const comma = inner.indexOf(',');
      const ref = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
      let replacement = resolve(ref, stack);
      if (replacement === undefined) replacement = fallback;
      if (replacement === undefined) throw new Error(`unresolved ${ref} in ${stack[stack.length - 1]}`);
      text = text.slice(0, i) + replacement + text.slice(j + 1);
    }
    return text.replace(/\s+/g, ' ').trim();
  };
  return resolve;
}

function themeDirs() {
  return fs.readdirSync(path.join(root, 'plugins'))
    .filter((d) => d.startsWith('theme-') && fs.existsSync(path.join(root, 'plugins', d, 'style.css')))
    .sort();
}

function packTokens(dir) {
  const id = dir.replace(/^theme-/, '');
  return tokenBlock(read('plugins', dir, 'style.css'), [`html[data-theme="${id}"]`, `:root[data-theme="${id}"]`]);
}

// What a pack's renderer.js passes to registerThemePack, run against a stub
// (theme renderers are plain scripts that only register).
function packDefinition(dir) {
  const file = path.join(root, 'plugins', dir, 'renderer.js');
  if (!fs.existsSync(file)) return {};
  let captured = {};
  const noop = () => {};
  const window = { RCBPlugins: { ctx: new Proxy({}, { get: () => noop }), registerThemePack: (id, def) => { captured = def; } } };
  // import.meta only exists in a module; a URL string stands in for it.
  const src = fs.readFileSync(file, 'utf8').replace(/import\.meta\.url/g, JSON.stringify(pathToFileURL(file).href));
  new Function('window', 'URL', src)(window, URL);
  return captured;
}

module.exports = { root, read, stripComments, tokenBlock, resolver, themeDirs, packTokens, packDefinition };
