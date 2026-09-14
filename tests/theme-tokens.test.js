// Token layer (docs/design/04 §4.2–4.3): semantic tokens alias the palette
// tokens every existing theme pack sets, so a pack that only knows --gold and
// --ink looks exactly the same through the semantic names core CSS now reads.
// A tiny custom-property resolver stands in for the browser: token blocks
// from tokens.css plus each pack's html[data-theme="id"] block, var() chains
// followed with cycle detection (a self-referencing alias is guaranteed
// invalid in CSS and silently drops the property).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// Every alias the step-1 codemod introduced: semantic name → palette token.
const ALIASES = {
  '--surface-0': '--ink-deep', '--surface-1': '--ink', '--surface-2': '--cell', '--surface-3': '--cell-alt',
  '--surface-panel': '--gradient-panel', '--text': '--paper', '--text-muted': '--paper-dim',
  '--accent': '--gold', '--accent-rgb': '--gold-rgb', '--accent-text': '--gold-ink',
  '--accent-2': '--cyan', '--accent-2-rgb': '--cyan-rgb', '--focus-ring': '--cyan', '--border': '--line',
  '--danger-text': '--danger', '--control-bg': '--gradient-btn', '--control-text': '--button-fg',
  '--selected-bg': '--button-selected-bg', '--selected-text': '--button-selected-fg',
  '--guide-rail-bg': '--guide-channel-bg', '--guide-rail-text': '--guide-channel-fg',
  '--guide-rail-subtle': '--guide-channel-subtle', '--guide-cell-bg': '--guide-program-bg',
  '--guide-cell-alt-bg': '--guide-program-alt-bg', '--guide-cell-text': '--paper',
  '--guide-selected-bg': '--guide-selection-bg', '--guide-selected-text': '--guide-selection-fg',
};

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Declarations of custom properties in every innermost block whose selector
// list contains one of `selectors`.
function tokenBlock(css, selectors) {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
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
    for (let guard = 0; guard < 50; guard += 1) {
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

const tokensCss = read('renderer', 'css', 'tokens.css');
const coreTokens = tokenBlock(tokensCss, [':root']);
const tvTokens = tokenBlock(tokensCss, ['html[data-mode="tv"]']);
const themeDirs = fs.readdirSync(path.join(root, 'plugins')).filter((d) => d.startsWith('theme-') && fs.existsSync(path.join(root, 'plugins', d, 'style.css')));

function themeTokens(dir) {
  const css = read('plugins', dir, 'style.css');
  const id = dir.replace(/^theme-/, '');
  return { ...coreTokens, ...tokenBlock(css, [`html[data-theme="${id}"]`, `:root[data-theme="${id}"]`]) };
}

test('core tokens resolve with no cycles, desktop and TV', () => {
  const resolve = resolver(coreTokens);
  Object.keys(coreTokens).forEach((name) => assert.doesNotThrow(() => resolve(name), name));
  const tv = resolver({ ...coreTokens, ...tvTokens });
  Object.keys(tvTokens).forEach((name) => assert.doesNotThrow(() => tv(name), name));
});

test('every semantic token equals its palette token in the default and all 25 packs', () => {
  assert.ok(themeDirs.length >= 25, `found ${themeDirs.length} theme packs`);
  const cases = [['digital-2000s', coreTokens], ...themeDirs.map((dir) => [dir, themeTokens(dir)])];
  for (const [id, tokens] of cases) {
    const resolve = resolver(tokens);
    for (const [semantic, legacy] of Object.entries(ALIASES)) {
      assert.equal(resolve(semantic), resolve(legacy), `${id}: ${semantic} ≠ ${legacy}`);
    }
  }
});

test('density: desktop base, TV ×1.75 with 24px body and 64px targets; themes never set it', () => {
  assert.equal(coreTokens['--font-size-body'], '13px');
  assert.equal(tvTokens['--font-size-body'], '24px');
  assert.equal(tvTokens['--target-min'], '64px');
  assert.equal(tvTokens['--safe-x'], '5%');
  assert.equal(tvTokens['--space-4'], 'calc(16px * 1.75)');
  assert.ok(!('--tv-body' in coreTokens), 'the doc 01 stand-ins are folded in');
  const density = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--control-h', '--target-min', '--font-size-body', '--font-size-label', '--safe-x', '--safe-y', '--density'];
  for (const dir of themeDirs) {
    const css = stripComments(read('plugins', dir, 'style.css'));
    density.forEach((name) => assert.ok(!new RegExp(`${name}\\s*:`).test(css), `${dir} sets ${name}`));
  }
});

test('core CSS reads semantic names, not the palette tokens they alias', () => {
  const legacy = [...new Set(Object.values(ALIASES))].filter((n) => n !== '--danger' && !n.startsWith('--button-') && !n.startsWith('--guide-'));
  for (const file of ['setup.css', 'guide.css', 'overlays.css', 'tv.css', 'setup-plugin-settings.css', 'tokens.css']) {
    let css = stripComments(read('renderer', 'css', file));
    // tokens.css's own :root block defines the aliases; everything after it is fair game.
    if (file === 'tokens.css') css = css.slice(css.indexOf('html[data-mode="tv"]'));
    legacy.forEach((name) => {
      const hits = css.match(new RegExp(`var\\(${name}(?=[\\s,)])`, 'g'));
      assert.equal(hits, null, `${file} reads ${name}; use its semantic name`);
    });
  }
});
