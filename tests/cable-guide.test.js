// The cable-guide UI's foundation:
// the theme picks the layout, the two skin packs, the live-picture box
// geometry, the header clock, the overlay signal's open set, and the rule that
// cable-guide.css can never touch the legacy layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const h = require('./helpers/theme-resolve.js');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'cable-guide/model.js')).href);
const SKINS = { 'theme-cable-guide-hd-15': 'hd', 'theme-cable-guide-classic-05': 'classic' };

test('a pack with ui "cable-guide" turns the layout on; anything else is legacy', async () => {
  const { uiModeForPack, CABLE_GUIDE_UI, LEGACY_UI } = await load();
  assert.equal(uiModeForPack({ ui: 'cable-guide' }), CABLE_GUIDE_UI);
  assert.equal(uiModeForPack({ ui: 'something-else' }), LEGACY_UI);
  assert.equal(uiModeForPack({}), LEGACY_UI);
  assert.equal(uiModeForPack(null), LEGACY_UI, 'the core default theme has no pack');
});

test('a channel identity theme paints on legacy only; the box skin keeps the cable-guide layout', async () => {
  const { paintedThemeId } = await load();
  assert.equal(paintedThemeId({ uiMode: 'legacy', boxThemeId: 'analog-90s', channelThemeId: 'wood-console-70s' }), 'wood-console-70s');
  assert.equal(paintedThemeId({ uiMode: 'cable-guide', boxThemeId: 'cable-guide-hd-15', channelThemeId: 'wood-console-70s' }), 'cable-guide-hd-15');
});

test('the picture box sits in the header corner on the 60-unit grid', async () => {
  const { pictureBoxRect } = await load();
  assert.deepEqual(pictureBoxRect(960, 540, 'hd'), { left: 604, top: 0, width: 328, height: 184 });
  assert.deepEqual(pictureBoxRect(960, 540, 'classic'), { left: 604, top: 14, width: 328, height: 157 });
  assert.deepEqual(pictureBoxRect(1920, 1080, 'hd'), { left: 1208, top: 0, width: 656, height: 368 });
  assert.equal(pictureBoxRect(0, 540), null);
  assert.equal(pictureBoxRect(960, 100, 'hd').height, 100, 'never taller than the screen');
});

test('sameRect compares by value and treats null as no box', async () => {
  const { sameRect } = await load();
  assert.ok(sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 4 }));
  assert.ok(!sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 5 }));
  assert.ok(sameRect(null, null));
  assert.ok(!sameRect(null, { left: 0, top: 0, width: 0, height: 0 }));
});

test('the header clock reads like a guide: 8:01pm, or 20:01 on a 24-hour box', async () => {
  const { guideClock } = await load();
  assert.equal(guideClock(new Date(2026, 9, 31, 20, 1)), '8:01pm');
  assert.equal(guideClock(new Date(2026, 9, 31, 0, 5)), '12:05am');
  assert.equal(guideClock(new Date(2026, 9, 31, 12, 0)), '12:00pm');
  assert.equal(guideClock(new Date(2026, 9, 31, 20, 1), true), '20:01');
  assert.equal(guideClock(new Date(2026, 9, 31, 7, 9), true), '07:09');
});

test('the overlay signal lists connected, visible surfaces once each, sorted', async () => {
  const { openSurfaceNames } = await load();
  assert.deepEqual(openSurfaceNames([
    ['menu', { connected: true, hidden: false }],
    ['guide', { connected: true, hidden: false }],
    ['pin', { connected: true, hidden: true }],
    ['exit', { connected: false, hidden: false }],
    ['guide', { connected: true, hidden: false }],
  ]), ['guide', 'menu']);
  assert.deepEqual(openSurfaceNames([]), []);
});

test('both skins register the cable-guide layout with their structure', () => {
  for (const [dir, layout] of Object.entries(SKINS)) {
    const def = h.packDefinition(dir);
    assert.equal(def.ui, 'cable-guide', `${dir} turns the layout on`);
    assert.equal(def.guideLayout, layout, `${dir} picks the ${layout} structure`);
    assert.ok(def.captionStyle, `${dir} styles captions (closed-captions plugin)`);
    const manifest = JSON.parse(h.read('plugins', dir, 'manifest.json'));
    assert.equal(manifest.id, dir);
    assert.equal(manifest.category, 'theme');
  }
});

test('every --cg-* token cable-guide.css reads is defined by the fallback block and by both skins', () => {
  const css = h.stripComments(h.read('renderer', 'css', 'cable-guide.css'));
  const used = new Set(css.match(/var\(--cg-[a-z0-9-]+/g).map((m) => m.slice(4)));
  const fallback = h.tokenBlock(css, [':where(html[data-ui="cable-guide"])']);
  assert.ok(used.size > 10);
  used.forEach((name) => assert.ok(name in fallback, `fallback block lacks ${name}`));
  for (const dir of Object.keys(SKINS)) {
    const pack = h.packTokens(dir);
    Object.keys(fallback).forEach((name) => assert.ok(name in pack, `${dir} lacks ${name}`));
  }
});

test('cable-guide.css only ever applies under html[data-ui="cable-guide"]', () => {
  const css = h.stripComments(h.read('renderer', 'css', 'cable-guide.css'));
  const topLevel = (list) => list.split(/,(?![^(]*\))/).map((s) => s.trim());
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => topLevel(m[1])).filter(Boolean);
  assert.ok(selectors.length > 10);
  selectors.forEach((sel) => assert.match(sel, /^(?::where\()?html\[data-ui="cable-guide"\]/, sel));
});

test('the page starts on the legacy layout and loads the cable-guide sheet', () => {
  const html = h.read('renderer', 'index.html');
  assert.match(html, /<html data-ui="legacy">/);
  assert.match(html, /href="css\/cable-guide\.css"/);
});

test('the skins\' fonts are bundled and credited', () => {
  const tokens = h.read('renderer', 'css', 'tokens.css');
  for (const file of ['roboto-condensed-regular-400', 'roboto-condensed-bold-700', 'arimo-regular-400', 'arimo-bold-700']) {
    assert.match(tokens, new RegExp(`fonts/${file}\\.woff2`), `${file} has an @font-face`);
    const buf = fs.readFileSync(path.join(h.root, 'renderer', 'fonts', `${file}.woff2`));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${file} is a WOFF2 file`);
  }
  const ofl = h.read('renderer', 'fonts', 'OFL.txt');
  assert.match(ofl, /Arimo\s+Copyright 2020 The Arimo Project Authors/);
  assert.match(ofl, /Roboto Condensed\s+Copyright 2011 Google Inc\./);
});
