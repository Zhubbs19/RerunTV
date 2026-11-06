'use strict';
// The box theme report the phone companion reads off /state (`theme`), so its
// colours follow the box (renderer/js/display/companion-theme.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const h = require('./helpers/theme-resolve.js');

const load = () => import(pathToFileURL(path.join(h.root, 'renderer', 'js', 'display', 'companion-theme.js')).href);

test('solidColor keeps plain colours and takes a gradient\'s first stop', async () => {
  const { solidColor } = await load();
  assert.equal(solidColor('#207BAA'), '#207baa');
  assert.equal(solidColor(' #fff '), '#fff');
  assert.equal(solidColor('rgb(58, 154, 214)'), 'rgb(58, 154, 214)');
  assert.equal(solidColor('rgba(1, 2, 3, 1)'), 'rgba(1, 2, 3, 1)');
  assert.equal(solidColor('linear-gradient(180deg, #3c63e6 0%, #173cd3 55%, #1230b0 100%)'), '#3c63e6');
  assert.equal(solidColor('linear-gradient(135deg, rgb(209, 38, 161) 0%, #724bca 100%)'), 'rgb(209, 38, 161)');
});

test('solidColor drops see-through, malformed and non-colour values', async () => {
  const { solidColor } = await load();
  assert.equal(solidColor('rgba(1, 1, 1, .92)'), null);
  assert.equal(solidColor('rgb(1 1 1 / 50%)'), null);
  assert.equal(solidColor('linear-gradient(180deg, rgba(255, 255, 255, .22) 0 1px, #000 1px)'), null);
  assert.equal(solidColor('#ffffff80'), null);
  assert.equal(solidColor('#fff extra'), null);
  assert.equal(solidColor('red'), null);
  assert.equal(solidColor('url(x.png)'), null);
  assert.equal(solidColor(''), null);
  assert.equal(solidColor(undefined), null);
  assert.equal(solidColor(`#${'a'.repeat(500)}`), null);
});

test('the report carries the box theme id, layout and its colour tokens', async () => {
  const { companionThemeReport } = await load();
  const vars = { '--surface-0': '#010101', '--text': ' #ececec', '--accent': '#3a9ad6', '--control-bg': 'linear-gradient(#464d52, #000)', '--danger': 'rgba(0,0,0,.5)' };
  const report = companionThemeReport({
    boxThemeId: 'cable-guide-hd-15', paintedThemeId: 'cable-guide-hd-15', uiMode: 'cable-guide', label: "CABLE GUIDE HD '15",
    readVar: (name) => vars[name] ?? '',
  });
  assert.deepEqual(report, {
    id: 'cable-guide-hd-15', ui: 'cable-guide', label: "CABLE GUIDE HD '15",
    colors: { 'surface-0': '#010101', text: '#ececec', accent: '#3a9ad6', 'control-bg': '#464d52' },
  });
});

test('while a channel identity theme is painted, the box theme keeps its last colours', async () => {
  const { companionThemeReport } = await load();
  const previous = { id: 'analog-90s', ui: 'legacy', label: null, colors: { accent: '#ffb000' } };
  const readVar = () => '#123456';
  const kept = companionThemeReport({ boxThemeId: 'analog-90s', paintedThemeId: 'vhs-retro-80s', uiMode: 'legacy', readVar, previous });
  assert.deepEqual(kept.colors, { accent: '#ffb000' });
  // A different box theme does not inherit another theme's colours.
  const fresh = companionThemeReport({ boxThemeId: 'master-control', paintedThemeId: 'vhs-retro-80s', uiMode: 'legacy', readVar, previous });
  assert.deepEqual(fresh, { id: 'master-control', ui: 'legacy', label: null, colors: null });
  assert.equal(companionThemeReport({ boxThemeId: null, paintedThemeId: null, uiMode: 'legacy', readVar }), null);
  assert.equal(companionThemeReport({ boxThemeId: 'x', paintedThemeId: 'x', uiMode: 'odd', readVar: () => '' }).ui, 'legacy');
});

test('every installed theme pack reports the surface, text and accent the phone needs', async () => {
  const { companionThemeReport, COMPANION_THEME_TOKENS } = await load();
  const core = h.tokenBlock(h.read('renderer', 'css', 'tokens.css'), [':root']);
  const missing = [];
  for (const dir of ['', ...h.themeDirs()]) {
    const resolve = h.resolver({ ...core, ...(dir ? h.packTokens(dir) : {}) });
    const id = dir ? dir.replace(/^theme-/, '') : 'digital-2000s';
    const report = companionThemeReport({
      boxThemeId: id, paintedThemeId: id, uiMode: 'legacy',
      readVar: (name) => resolve(name) || '',
    });
    for (const name of ['surface-0', 'text', 'accent']) {
      if (!report.colors || !report.colors[name]) missing.push(`${id}: ${name}`);
    }
    Object.keys(report.colors || {}).forEach((name) => assert.ok(COMPANION_THEME_TOKENS.includes(name)));
  }
  assert.deepEqual(missing, []);
});
