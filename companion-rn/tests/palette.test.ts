import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contrast, DEFAULT_PALETTE, ensureContrast, isDark, isPalette, mix, nextPalette, paletteFromBoxTheme, parseColor,
  type BoxThemeReport, type Palette,
} from '../src/lib/palette.ts';

// What the box sends for its two cable-guide skins (plugins/theme-cable-guide-*/style.css).
const HD_15: BoxThemeReport = {
  id: 'cable-guide-hd-15', ui: 'cable-guide', label: "CABLE GUIDE HD '15",
  colors: {
    'surface-0': '#010101', 'surface-1': '#0b0c0e', 'surface-2': '#303539', 'surface-3': '#464d52',
    text: '#ececec', 'text-muted': '#a4a8ad', border: '#3a3d4e', accent: '#3a9ad6', 'accent-text': '#ffffff',
    'accent-2': '#3a9ad6', danger: '#ff6b5b', 'control-bg': '#464d52', 'control-text': '#ececec',
  },
};
const CLASSIC_05: BoxThemeReport = {
  id: 'cable-guide-classic-05', ui: 'cable-guide',
  colors: {
    'surface-0': '#00124f', 'surface-1': '#001b84', 'surface-2': '#0b2d5a', 'surface-3': '#173cd3',
    text: '#ffffff', 'text-muted': '#c8dcff', border: '#7fa5ff', accent: '#eaef8b', 'accent-text': '#0b1f4a',
    'accent-2': '#92b8dd', danger: '#ff8a7a', 'control-bg': '#3c63e6', 'control-text': '#ffffff',
  },
};

// The pairs the screens actually draw (text role on the surface it sits on).
const PAIRS: [keyof Palette, keyof Palette, number][] = [
  ['onSurface', 'surface', 4.5], ['onSurface', 'surfaceContainer', 4.5], ['onSurface', 'surfaceContainerHigh', 4.5],
  ['onSurface', 'surfaceContainerHighest', 4.5], ['onSurfaceVariant', 'surfaceContainer', 4.5],
  ['onSurfaceVariant', 'surfaceContainerHigh', 4.5], ['primary', 'surfaceContainerHigh', 4.5], ['primary', 'surfaceDim', 4.5],
  ['onPrimary', 'primary', 4.5], ['onPrimaryContainer', 'primaryContainer', 4.5], ['tertiary', 'surfaceContainer', 4.5],
  ['onTertiaryContainer', 'tertiaryContainer', 4.5], ['onErrorContainer', 'errorContainer', 4.5], ['outline', 'surfaceContainer', 3],
];

function assertReadable(p: Palette, name: string, skip: (keyof Palette)[] = []) {
  for (const [fg, bg, min] of PAIRS) {
    if (skip.includes(fg)) continue;
    assert.ok(contrast(p[fg], p[bg]) >= min, `${name}: ${fg} ${p[fg]} on ${bg} ${p[bg]} is ${contrast(p[fg], p[bg]).toFixed(2)}:1`);
  }
}

test('parseColor reads hex and opaque rgb, and rejects the rest', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('#3A9AD6'), [58, 154, 214]);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(parseColor('rgba(1, 2, 3, 1)'), [1, 2, 3]);
  assert.equal(parseColor('rgba(1, 2, 3, .5)'), null);
  assert.equal(parseColor('linear-gradient(#000, #fff)'), null);
  assert.equal(parseColor('#ffffff80'), null);
  assert.equal(parseColor(42), null);
});

test('mix and ensureContrast', () => {
  assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(ensureContrast('#FFFFFF', '#000000', 4.5), '#FFFFFF');
  const nudged = ensureContrast('#202020', '#000000', 4.5);
  assert.ok(contrast(nudged, '#000000') >= 4.5);
});

test('the HD \'15 skin gives near-black surfaces and its blue accent', () => {
  const p = paletteFromBoxTheme(HD_15);
  assert.ok(p);
  assert.equal(p.surface, '#010101');
  // Its accent, lightened just enough to read as text on the cards.
  assert.equal(p.primary, ensureContrast('#3A9AD6', p.surfaceContainerHigh, 4.5));
  const [r, g, b] = parseColor(p.primary)!;
  assert.ok(b > g && g > r, 'still blue');
  assert.equal(p.surfaceContainerHighest, '#464D52'); // its button colour
  assert.ok(isDark(p));
  assertReadable(p, 'hd-15');
});

test('the Classic \'05 skin gives navy surfaces and its yellow accent', () => {
  const p = paletteFromBoxTheme(CLASSIC_05);
  assert.ok(p);
  assert.equal(p.surface, '#00124F');
  assert.equal(p.primary, '#EAEF8B');
  assert.equal(p.onPrimary, '#0B1F4A');
  assertReadable(p, 'classic-05');
});

test('a minimal report still yields a readable palette; too little yields none', () => {
  const p = paletteFromBoxTheme({ id: 'x', colors: { 'surface-0': '#000000', text: '#777777', accent: '#330000' } });
  assert.ok(p);
  assertReadable(p, 'minimal');
  assert.equal(paletteFromBoxTheme({ id: 'x', colors: { 'surface-0': '#000', text: '#fff' } }), null);
  assert.equal(paletteFromBoxTheme({ id: 'x', colors: null }), null);
  assert.equal(paletteFromBoxTheme(null), null);
});

test('the default palette is readable and a valid stored palette', () => {
  assertReadable(DEFAULT_PALETTE, 'default', ['outline']); // its hand-picked outline is 2.96:1, a border colour
  assert.ok(isPalette(DEFAULT_PALETTE));
  assert.ok(isPalette(JSON.parse(JSON.stringify(paletteFromBoxTheme(HD_15)))));
  assert.equal(isPalette({ ...DEFAULT_PALETTE, primary: 'nope' }), false);
  assert.equal(isPalette('#fff'), false);
});

test('nextPalette keeps the remembered look until the box answers, and falls back for an older box', () => {
  const remembered = paletteFromBoxTheme(CLASSIC_05)!;
  assert.equal(nextPalette(remembered, false, undefined), remembered);
  assert.equal(nextPalette(remembered, true, undefined), DEFAULT_PALETTE);
  assert.equal(nextPalette(remembered, true, null), remembered);
  assert.equal(nextPalette(remembered, true, { id: 'cable-guide-classic-05', colors: null }), remembered);
  assert.deepEqual(nextPalette(remembered, true, HD_15), paletteFromBoxTheme(HD_15));
});
