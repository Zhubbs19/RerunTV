// Token layer (docs/design/04 §4.2–4.3): semantic tokens alias the palette
// tokens every existing theme pack sets, so a pack that only knows --gold and
// --ink looks exactly the same through the semantic names core CSS now reads.
// A tiny custom-property resolver stands in for the browser: token blocks
// from tokens.css plus each pack's html[data-theme="id"] block, var() chains
// followed with cycle detection (a self-referencing alias is guaranteed
// invalid in CSS and silently drops the property).
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, stripComments, tokenBlock, resolver, themeDirs: listThemeDirs, packTokens } = require('./helpers/theme-resolve.js');

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

const tokensCss = read('renderer', 'css', 'tokens.css');
const coreTokens = tokenBlock(tokensCss, [':root']);
const bodyTokens = tokenBlock(tokensCss, ['body']);
const tvTokens = tokenBlock(tokensCss, ['html[data-mode="tv"]']);
const themeDirs = listThemeDirs();

const packBlock = packTokens;

// What html computes (core :root + the pack's block), and what body sees:
// html's resolved values inherited, then body's own declarations.
function cascade(pack) {
  const htmlTokens = { ...coreTokens, ...pack };
  const atHtml = resolver(htmlTokens);
  const inherited = {};
  Object.keys(htmlTokens).forEach((name) => { const v = atHtml(name); if (v !== undefined) inherited[name] = v; });
  const atBody = resolver({ ...inherited, ...bodyTokens });
  return { atHtml, atBody };
}

test('core tokens resolve with no cycles, desktop, TV and body', () => {
  const { atHtml, atBody } = cascade({});
  Object.keys(coreTokens).forEach((name) => assert.doesNotThrow(() => atHtml(name), name));
  Object.keys(bodyTokens).forEach((name) => assert.doesNotThrow(() => atBody(name), name));
  const tv = resolver({ ...coreTokens, ...tvTokens });
  Object.keys(tvTokens).forEach((name) => assert.doesNotThrow(() => tv(name), name));
});

test('a pack that sets palette names still drives every semantic token (all 25 packs)', () => {
  assert.ok(themeDirs.length >= 25, `found ${themeDirs.length} theme packs`);
  for (const dir of themeDirs) {
    const pack = packBlock(dir);
    const { atHtml, atBody } = cascade(pack);
    for (const [semantic, legacy] of Object.entries(ALIASES)) {
      if (legacy in pack && !(semantic in pack)) {
        assert.equal(atHtml(semantic), atHtml(legacy), `${dir}: ${semantic} doesn't follow the pack's ${legacy}`);
      }
      // The palette name reads back the semantic value for plugin CSS inside body.
      if (legacy in bodyTokens) assert.equal(atBody(legacy), atHtml(semantic), `${dir}: body ${legacy} ≠ ${semantic}`);
    }
  }
});

test('a converted pack sets semantic names only, and palette readers still see them', () => {
  const { atHtml, atBody } = cascade({ '--accent': '#ff0000', '--surface-1': '#010203', '--guide-rail-text': '#abcdef' });
  assert.equal(atHtml('--accent'), '#ff0000');
  assert.equal(atBody('--gold'), '#ff0000');
  assert.equal(atBody('--ink'), '#010203');
  assert.equal(atBody('--guide-channel-fg'), '#abcdef');
  assert.equal(atHtml('--warning'), '#ff0000', 'derived tokens follow the semantic name');
  // With neither, the core default shows.
  const plain = cascade({});
  assert.equal(plain.atHtml('--accent'), '#f5d327');
  assert.equal(plain.atBody('--gold'), '#f5d327');
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
