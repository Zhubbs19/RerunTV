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

test('listings: the picture lands in the grid\'s hole even when the grid and screen differ', async () => {
  const { listingsPictureBox } = await load();
  // Same box, no scale: the hole and the picture are the same rect.
  const same = listingsPictureBox({ left: 100, top: 50, width: 960, height: 540 }, { left: 100, top: 50, width: 960, height: 540 }, 960, 'hd');
  assert.deepEqual(same.hole, { left: 604, top: 0, width: 328, height: 184 });
  assert.deepEqual(same.picture, { left: 604, top: 0, width: 328, height: 184 });
  // EXTEND GUIDE TO FULL SCREEN: the grid covers the window, the screen is pillarboxed inside it.
  const extended = listingsPictureBox({ left: 0, top: 0, width: 1920, height: 1080 }, { left: 240, top: 0, width: 1440, height: 1080 }, 1440, 'hd');
  assert.deepEqual(extended.picture, { left: 1208 - 240, top: 0, width: 656, height: 368 });
  // A simulated resolution scales the screen 2x on screen: local pixels are half.
  const scaled = listingsPictureBox({ left: 0, top: 0, width: 1280, height: 720 }, { left: 0, top: 0, width: 1280, height: 720 }, 640, 'hd');
  assert.equal(scaled.picture.width, Math.round(scaled.hole.width / 2));
  assert.equal(listingsPictureBox(null, { left: 0, top: 0, width: 10, height: 10 }, 10), null);
});

test('program info: tiles pick an icon from the label, or the plugin\'s own', async () => {
  const { actionIcon, actionMeaning, stepTile } = await load();
  assert.equal(actionIcon('WATCH FROM START'), 'start');
  assert.equal(actionIcon('RECORD SERIES'), 'series');
  assert.equal(actionIcon('RECORD ONCE'), 'record');
  assert.equal(actionIcon('REMIND ME'), 'remind');
  assert.equal(actionIcon('REMINDER SET'), 'remind');
  assert.equal(actionIcon('GUIDE −24 HOURS'), 'day-back');
  assert.equal(actionIcon('GUIDE +24 HOURS'), 'day-ahead');
  assert.equal(actionIcon('TV MENU'), 'menu');
  assert.equal(actionIcon('TUNE'), 'play');
  assert.equal(actionIcon('SOMETHING NEW'), null, 'unknown labels get a text tile');
  assert.equal(actionIcon('SOMETHING NEW', 'lock'), 'lock', 'a plugin can name its icon');
  assert.equal(actionIcon('RECORD', 'not-an-icon'), 'record', 'an unknown icon name falls back to the label');
  assert.equal(actionMeaning('RECORD SERIES'), 'Record series');
  assert.equal(actionMeaning('TV MENU'), 'TV menu');
  assert.equal(stepTile(0, 5, -1), 0);
  assert.equal(stepTile(4, 5, 1), 4);
  assert.equal(stepTile(2, 5, 1), 3);
  assert.equal(stepTile(0, 0, 1), -1);
});

test('guide ranges read compactly, the way the real guides wrote them', async () => {
  const { guideRange, guideDayLabel } = await load();
  const d = (h, m = 0) => new Date(2026, 9, 31, h, m);
  assert.equal(guideRange(d(12), d(13)), '12-1p');
  assert.equal(guideRange(d(15, 30), d(16)), '3:30-4p');
  assert.equal(guideRange(d(20), d(22)), '8-10p');
  assert.equal(guideRange(d(9, 43), d(11, 9)), '9:43-11:09a');
  assert.equal(guideRange(d(11, 30), d(12, 30)), '11:30a-12:30p', 'am/pm on both ends when it crosses noon');
  assert.equal(guideRange(new Date(2026, 9, 31, 23, 30), new Date(2026, 10, 1, 0, 30)), '11:30p-12:30a');
  assert.equal(guideRange(d(20), d(21, 30), true), '20:00-21:30');
  assert.equal(guideDayLabel(d(20).getTime(), d(9).getTime()), 'Today');
  assert.equal(guideDayLabel(new Date(2026, 10, 1, 8).getTime(), d(9).getTime()), 'Sunday');
});

test('result lists print a short airing day', async () => {
  const { guideShortDay } = await load();
  const now = new Date(2026, 9, 31, 9).getTime();
  assert.equal(guideShortDay(new Date(2026, 9, 31, 22).getTime(), now), 'Today');
  assert.equal(guideShortDay(new Date(2026, 10, 1, 8).getTime(), now), 'Sun');
  assert.equal(guideShortDay(new Date(2026, 10, 6, 23).getTime(), now), 'Fri');
  assert.equal(guideShortDay(new Date(2026, 10, 7, 1).getTime(), now), '11/7');
});

test('menu labels read in title case, keeping abbreviations', async () => {
  const { menuLabel } = await load();
  assert.equal(menuLabel('CHANNELS ›'), 'Channels');
  assert.equal(menuLabel('LAST CH'), 'Last CH');
  assert.equal(menuLabel('CUSTOM CSS'), 'Custom CSS');
  assert.equal(menuLabel('PICTURE & SOUND ›'), 'Picture & Sound');
  assert.equal(menuLabel('PROFILE: EVERYONE ›'), 'Profile: Everyone');
  assert.equal(menuLabel('CONTINUE ON… ›'), 'Continue on…');
  assert.equal(menuLabel('SHUT DOWN PC'), 'Shut Down PC');
  assert.equal(menuLabel('RETURN TO LIVE'), 'Return to Live');
  assert.equal(menuLabel('CH ▲'), 'CH ▲');
});

test('Main Menu arrows: two columns of five, filled down, paged', async () => {
  const { menuMove } = await load();
  const n = 13; // page 1: 0-4 | 5-9; page 2: 10-12 | —
  assert.deepEqual(menuMove(0, n, 'ArrowDown'), { index: 1, edge: null });
  assert.deepEqual(menuMove(4, n, 'ArrowDown'), { index: 10, edge: null }, 'off the bottom of the left column: next page');
  assert.deepEqual(menuMove(9, n, 'ArrowDown'), { index: 12, edge: null }, 'next page has no right column: its last item');
  assert.deepEqual(menuMove(10, n, 'ArrowUp'), { index: 4, edge: null }, 'off the top: previous page, same column');
  assert.deepEqual(menuMove(2, n, 'ArrowRight'), { index: 7, edge: null });
  assert.deepEqual(menuMove(7, n, 'ArrowLeft'), { index: 2, edge: null });
  assert.deepEqual(menuMove(2, n, 'ArrowLeft'), { index: 2, edge: 'left' }, 'left of the left column: back');
  assert.deepEqual(menuMove(11, n, 'ArrowRight'), { index: 11, edge: 'right' }, 'a page with one column has nothing to the right');
  assert.deepEqual(menuMove(0, 3, 'ArrowUp'), { index: 0, edge: null });
});

test('settings rows and fixed grids', async () => {
  const { menuMove } = await load();
  assert.deepEqual(menuMove(4, 8, 'ArrowDown', 'rows'), { index: 5, edge: null });
  assert.deepEqual(menuMove(3, 8, 'ArrowLeft', 'rows'), { index: 3, edge: 'left' });
  assert.deepEqual(menuMove(3, 8, 'ArrowRight', 'rows'), { index: 3, edge: 'right' });
  // The number pad: 3 wide.
  assert.deepEqual(menuMove(4, 12, 'ArrowDown', 3), { index: 7, edge: null });
  assert.deepEqual(menuMove(3, 12, 'ArrowLeft', 3), { index: 3, edge: 'left' });
  assert.deepEqual(menuMove(11, 12, 'ArrowDown', 3), { index: 11, edge: null });
});

test('Listings by Channel: OK watches, rewinds, or sets / clears a reminder', async () => {
  const { byChannelAction } = await load();
  const e = (start, end) => ({ start, end });
  assert.equal(byChannelAction(e(0, 100), 50, false, false), 'watch');
  assert.equal(byChannelAction(e(0, 100), 150, true, false), 'rewind');
  assert.equal(byChannelAction(e(0, 100), 150, false, false), 'none', 'aired, no time machine');
  assert.equal(byChannelAction(e(200, 300), 150, false, false), 'remind');
  assert.equal(byChannelAction(e(200, 300), 150, false, true), 'unremind');
});

test('legacy layout hides every part only the cable-guide layout uses', () => {
  const css = h.stripComments(h.read('renderer', 'css', 'guide.css'));
  const rule = css.match(/([^{}]+)\{\s*display:\s*none;\s*\}/g).find((r) => r.includes('.guide-brand'));
  ['.guide-brand', '.guide-info-rating', '.guide-info-desc', '.guide-th-day', '.guide-th-now', '.cg-flip', '.cg-program-info']
    .forEach((sel) => assert.ok(rule && rule.includes(sel), `${sel} is hidden on the legacy layout`));
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
  assert.equal(guideClock(new Date(2026, 9, 31, 20, 1), false, true), '8:01p', 'the Mini Guide\'s short form');
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
