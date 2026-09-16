// Theme packs keep the token contract (docs/design/04 §4.1, §4.4, §7): CSS is
// token blocks, slot decorations, native field chrome and keyframes only, and
// every theme clears the contrast pairs or exempts a pair with a reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const h = require('./helpers/theme-resolve.js');

const load = (file) => import(pathToFileURL(path.join(h.root, 'renderer', 'js', file)).href);

// Packs converted to the contract so far (§6 steps 3–4). Step 5 empties this
// list's complement: every first-party pack.
const CONVERTED = new Set(['widescreen-grid-13']);

// Pairs a theme may exempt (decision for doc 04): decoration and display-scale
// pairs only. Body text, selected labels and the guide's rail/cell text must pass.
const NEVER_EXEMPT = new Set([
  'text/surface-0', 'text/surface-1', 'text/surface-2', 'text/surface-3', 'text/surface-panel',
  'text-muted/surface-1', 'selected-text/selected-bg', 'guide-rail-text/guide-rail-bg', 'guide-cell-text/guide-cell-bg',
  'guide-selected-text/guide-selected-bg',
]);

test('the contract lint accepts the reference shapes and rejects structural rules', async () => {
  const { lintThemeCss } = await load('display/theme-contract.js');
  const ok = `
    html[data-theme="x"] { --accent: #fff; --guide-row-height: 40px; }
    html[data-theme="x"][data-mode="tv"] { --guide-row-height: 64px; }
    html[data-theme="x"] [data-slot="guide-banner"] { border: 0; background: #000; animation: spin 1s; }
    html[data-theme="x"] :is([data-slot="guide-hint"], [data-slot="hint-bar"]) { color: #fff; }
    html[data-theme="x"] [data-slot="power-fx"]::after { content: ''; box-shadow: 0 0 4px red; }
    html[data-theme="x"] :is(input, select, textarea):focus { outline: 2px solid red; border-color: red; }
    @keyframes spin { to { transform: rotate(1turn); left: 3px; } }
    @media (prefers-reduced-motion: reduce) { html[data-theme="x"] [data-slot="guide-banner"] { animation: none; } }`;
  assert.deepEqual(lintThemeCss('x', ok), []);
  const bad = (css) => lintThemeCss('x', css).map((p) => p.problem);
  assert.match(bad('html[data-theme="x"] .btn { color: red; }')[0], /not a token block/);
  assert.match(bad('html[data-theme="x"] [data-slot="guide-banner"] { left: 5%; }')[0], /layout/);
  assert.match(bad('html[data-theme="x"] [data-slot="nope"] { color: red; }')[0], /unknown slot/);
  assert.match(bad('html[data-theme="x"] { color: red; }')[0], /tokens only/);
  assert.match(bad('html[data-theme="x"] { --space-2: 9px; }')[0], /density/);
  assert.match(bad('.guide-overlay { color: red; }')[0], /not scoped/);
  assert.match(bad('@media (max-width: 600px) { html[data-theme="x"] { --accent: red; } }')[0], /unsupported/);
});

test('converted packs keep the contract', async () => {
  const { lintThemeCss } = await load('display/theme-contract.js');
  for (const dir of h.themeDirs()) {
    const id = dir.replace(/^theme-/, '');
    if (!CONVERTED.has(id)) continue;
    const problems = lintThemeCss(id, h.read('plugins', dir, 'style.css'));
    assert.deepEqual(problems, [], `${dir}:\n${problems.map((p) => `  ${p.selector} — ${p.problem}`).join('\n')}`);
  }
});

test('every theme clears the contrast pairs, or exempts an allowed pair with a reason', async () => {
  const { checkThemeTokens, THEME_CHECK_TOKENS } = await load('display/theme-check.js');
  const core = h.tokenBlock(h.read('renderer', 'css', 'tokens.css'), [':root']);
  const report = [];
  for (const dir of ['', ...h.themeDirs()]) {
    const pack = dir ? h.packTokens(dir) : {};
    const def = dir ? h.packDefinition(dir) : {};
    const exempt = def.contrastExempt || {};
    Object.entries(exempt).forEach(([pair, reason]) => {
      assert.ok(!NEVER_EXEMPT.has(pair), `${dir}: ${pair} can't be exempted`);
      assert.ok(typeof reason === 'string' && reason.trim().length >= 10, `${dir}: exemption for ${pair} needs a real reason`);
    });
    const resolve = h.resolver({ ...core, ...pack });
    const tokens = {};
    THEME_CHECK_TOKENS.forEach((name) => { tokens[name] = resolve(name) || ''; });
    const result = checkThemeTokens(tokens, { exempt });
    assert.deepEqual(result.unresolved, [], `${dir || 'default'}: unresolved pairs`);
    result.failures.filter((f) => !f.exempt).forEach((f) => report.push(`${dir || 'default'} ${f.pair} ${f.ratio}:1 < ${f.min} (${f.fg} on ${f.bg})`));
  }
  assert.deepEqual(report, []);
});
