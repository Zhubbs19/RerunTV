// contrast.js — colour parsing, gradients, compositing and WCAG ratios
// (docs/design/04 §4.4). The regressions this guards: color(srgb …) (what a
// computed color-mix() becomes) parsing as "no colour" and passing silently,
// and gradients being skipped as "unknown".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'display/contrast.js')).href);
const near = (actual, expected, tolerance = 0.6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test('parses hex, rgb in both syntaxes, hsl, names and transparent', async () => {
  const { parseColor } = await load();
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#06132f'), { r: 6, g: 19, b: 47, a: 1 });
  near(parseColor('#00000080').a, 0.5, 0.01);
  assert.deepEqual(parseColor('rgb(246, 211, 74)'), { r: 246, g: 211, b: 74, a: 1 });
  assert.deepEqual(parseColor('rgba(0,0,0,.65)'), { r: 0, g: 0, b: 0, a: 0.65 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  const red = parseColor('hsl(0, 100%, 50%)');
  near(red.r, 255); near(red.g, 0); near(red.b, 0);
  assert.equal(parseColor('transparent').a, 0);
  assert.deepEqual(parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor('var(--gold)'), null);
  assert.equal(parseColor('180deg'), null);
});

test('reads color(srgb …), the computed form of color-mix()', async () => {
  const { parseColor } = await load();
  const c = parseColor('color(srgb 0.5 0.25 1)');
  near(c.r, 127.5); near(c.g, 63.75); near(c.b, 255);
  assert.equal(c.a, 1);
  assert.equal(parseColor('color(srgb 1 1 1 / 0.3)').a, 0.3);
});

test('computes color-mix(in srgb) with percentage normalization', async () => {
  const { parseColor } = await load();
  const half = parseColor('color-mix(in srgb, #ffffff, #000000)');
  near(half.r, 127.5);
  const accent30 = parseColor('color-mix(in srgb, #f6d34a 30%, #ffffff)');
  near(accent30.r, 0.3 * 246 + 0.7 * 255);
  near(accent30.b, 0.3 * 74 + 0.7 * 255);
  const oneSided = parseColor('color-mix(in srgb, red 25%, blue)');
  near(oneSided.r, 63.75); near(oneSided.b, 191.25);
  const under = parseColor('color-mix(in srgb, red 20%, blue 30%)');
  near(under.a, 0.5, 0.001);
  near(under.r, 102); // 20/50 of red
});

test('gradient stops: every colour, directions and positions skipped', async () => {
  const { gradientStops, backgroundLayers } = await load();
  const stops = gradientStops('linear-gradient(180deg, #102e69 0%, rgba(7, 24, 57, 0.5) 45% 60%, color(srgb 1 0 0))');
  assert.equal(stops.length, 3);
  assert.deepEqual(stops[0], { r: 16, g: 46, b: 105, a: 1 });
  assert.equal(stops[1].a, 0.5);
  near(stops[2].r, 255);
  assert.equal(gradientStops('radial-gradient(circle at top, #fff, transparent)').length, 2);
  assert.equal(gradientStops('#fff'), null);
  const layers = backgroundLayers('linear-gradient(180deg, rgba(255,255,255,.12), transparent 50%), linear-gradient(#315dac, #173f86)');
  assert.equal(layers.length, 2);
  assert.equal(layers[1].length, 2);
  assert.deepEqual(backgroundLayers('none'), []);
  assert.deepEqual(backgroundLayers('#123b91'), [[{ r: 18, g: 59, b: 145, a: 1 }]]);
});

test('WCAG ratios and compositing', async () => {
  const { contrastRatio, parseColor, composite, worstContrast, flattenLayers, backgroundLayers, toHex } = await load();
  near(contrastRatio(parseColor('#fff'), parseColor('#000')), 21, 0.01);
  near(contrastRatio(parseColor('#777'), parseColor('#fff')), 4.48, 0.01);
  assert.equal(toHex(composite(parseColor('rgba(255,255,255,0.5)'), parseColor('#000'))), '#808080');

  // A gold-to-dark gradient: white text passes on the dark end, fails on the
  // gold end, and the worst stop is the answer.
  const bgs = flattenLayers(backgroundLayers('linear-gradient(#ffe27c, #06132f)'));
  assert.equal(bgs.length, 2);
  const worst = worstContrast(parseColor('#fff'), bgs);
  assert.ok(worst.ratio < 1.5);
  assert.equal(toHex(worst.bg), '#ffe27c');

  // A transparent layer shows what's underneath, not black.
  const cells = flattenLayers(backgroundLayers('transparent'), flattenLayers(backgroundLayers('#123b91')));
  assert.equal(toHex(cells[0]), '#123b91');

  // Translucent text is judged as it actually shows.
  const faint = worstContrast(parseColor('rgba(255,255,255,0.2)'), [parseColor('#000')]);
  assert.ok(faint.ratio < 2);
});
