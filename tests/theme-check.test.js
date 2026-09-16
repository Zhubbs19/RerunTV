// theme-check.js pure layer — the §4.4 pair table over resolved token values,
// gradients sampled at every stop, transparent surfaces shown through, and
// exemptions reported rather than hidden (docs/design/04 §4.4, §7).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'display/theme-check.js')).href);

// A readable dark theme, as a browser would hand the values back.
const good = () => ({
  '--text': 'rgb(255, 255, 255)',
  '--text-muted': 'rgb(185, 202, 238)',
  '--surface-0': 'rgb(6, 19, 47)',
  '--surface-1': 'rgb(10, 36, 86)',
  '--surface-2': 'rgb(18, 59, 145)',
  '--surface-3': 'rgb(23, 70, 167)',
  '--surface-panel': 'linear-gradient(rgb(23, 63, 134) 0%, rgb(12, 40, 95) 62%, rgb(7, 24, 57) 100%)',
  '--control-text': 'rgb(185, 202, 238)',
  '--control-bg': 'rgb(10, 27, 61)',
  '--selected-text': 'rgb(29, 23, 0)',
  '--selected-bg': 'linear-gradient(rgb(255, 226, 124), rgb(246, 198, 45))',
  '--guide-grid-bg': 'linear-gradient(rgb(7, 24, 57), rgb(11, 37, 84))',
  '--guide-rail-text': 'rgb(255, 255, 255)',
  '--guide-rail-bg': 'rgb(10, 27, 61)',
  '--guide-cell-text': 'rgb(255, 255, 255)',
  '--guide-cell-bg': 'rgba(0, 0, 0, 0)',
  '--guide-selected-text': 'rgb(27, 23, 4)',
  '--guide-selected-bg': 'rgb(246, 198, 45)',
  '--focus-ring': 'rgb(118, 168, 255)',
  '--focus-halo': 'rgb(6, 19, 47)',
  '--danger-text': 'color(srgb 0.933 0.349 0.455)',
});

test('a readable theme passes every pair', async () => {
  const { checkThemeTokens, THEME_CHECK_PAIRS, themeCheckBadge } = await load();
  const result = checkThemeTokens(good());
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.passed, THEME_CHECK_PAIRS.length);
  assert.equal(themeCheckBadge(result), null);
});

test('a gradient fails on its worst stop, not its average', async () => {
  const { checkThemeTokens } = await load();
  const tokens = good();
  // Dark text on a gold bar that fades to navy at the bottom.
  tokens['--selected-bg'] = 'linear-gradient(rgb(255, 226, 124), rgb(6, 19, 47))';
  const { failures } = checkThemeTokens(tokens);
  const f = failures.find((x) => x.pair === 'selected-text/selected-bg');
  assert.ok(f, 'the navy stop is found');
  assert.equal(f.bg, '#06132f');
  assert.ok(f.ratio < 2);
});

test('a transparent guide cell is judged against the grid behind it', async () => {
  const { checkThemeTokens } = await load();
  const tokens = good();
  tokens['--guide-cell-text'] = 'rgb(20, 20, 20)';
  const f = checkThemeTokens(tokens).failures.find((x) => x.pair === 'guide-cell-text/guide-cell-bg');
  assert.ok(f, 'dark text on a transparent cell over a dark grid fails');
  assert.notEqual(f.bg, '#000000', 'the grid showed through, not black');
});

test('color(srgb …) text is read, not skipped', async () => {
  const { checkThemeTokens } = await load();
  const tokens = good();
  tokens['--text-muted'] = 'color(srgb 0.1 0.15 0.3)';
  const f = checkThemeTokens(tokens).failures.find((x) => x.pair === 'text-muted/surface-1');
  assert.ok(f);
});

test('focus ring needs 3:1, and exemptions are reported with their reason', async () => {
  const { checkThemeTokens, themeCheckBadge } = await load();
  const tokens = good();
  tokens['--focus-ring'] = 'rgb(30, 50, 90)';
  const plain = checkThemeTokens(tokens);
  assert.ok(plain.failures.some((f) => f.pair === 'focus-ring/surface-0' && f.min === 3));
  assert.equal(themeCheckBadge(plain), 'low');

  const exempt = checkThemeTokens(tokens, { exempt: {
    'focus-ring/surface-0': 'period hardware drew no focus ring',
    'focus-ring/focus-halo': 'same',
  } });
  assert.ok(exempt.failures.length >= 1, 'still listed');
  assert.ok(exempt.failures.every((f) => f.exempt));
  assert.equal(themeCheckBadge(exempt), 'low-exempt');

  const blankReason = checkThemeTokens(tokens, { exempt: { 'focus-ring/surface-0': '  ' } });
  assert.equal(blankReason.failures.find((f) => f.pair === 'focus-ring/surface-0').exempt, null, 'an exemption needs a reason');
});

test('a missing token is unresolved, never a silent pass', async () => {
  const { checkThemeTokens } = await load();
  const tokens = good();
  tokens['--control-bg'] = '';
  const result = checkThemeTokens(tokens);
  assert.ok(result.unresolved.includes('control-text/control-bg'));
});
