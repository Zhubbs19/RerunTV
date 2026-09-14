// The component kit's pure logic (docs/design/04 §3): list/tab/menu key
// movement, number stepping, popup placement, keyed list reconciliation, the
// dialog's safe default, and the status bar's task line. The key tables are
// the desktop behaviour the kit took over from row-menu.js, setup-keyboard.js
// and guide.js, so these also pin that desktop keys didn't change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const uiDir = path.join(__dirname, '..', 'renderer', 'js', 'ui');
const load = (name) => import(pathToFileURL(path.join(uiDir, name)).href);

test('every kit module imports without touching the DOM', async () => {
  for (const file of fs.readdirSync(uiDir).filter((f) => f.endsWith('.js'))) {
    await assert.doesNotReject(load(file), file);
  }
});

test('rovingIndex: arrows wrap by default, Home/End, orientation, other keys null', async () => {
  const { rovingIndex } = await load('kit-core.js');
  assert.equal(rovingIndex(3, 0, 'ArrowDown'), 1);
  assert.equal(rovingIndex(3, 2, 'ArrowDown'), 0, 'wraps like the old tab bars and row menus');
  assert.equal(rovingIndex(3, 0, 'ArrowUp'), 2);
  assert.equal(rovingIndex(3, 1, 'Home'), 0);
  assert.equal(rovingIndex(3, 1, 'End'), 2);
  assert.equal(rovingIndex(3, 1, 'ArrowRight'), null, 'vertical lists ignore ◀▶');
  assert.equal(rovingIndex(3, 1, 'ArrowRight', { orientation: 'horizontal' }), 2);
  assert.equal(rovingIndex(3, 2, 'ArrowDown', { wrap: false }), 2);
  assert.equal(rovingIndex(3, -1, 'ArrowDown'), 0, 'nothing focused yet: first');
  assert.equal(rovingIndex(3, -1, 'ArrowUp'), 2);
  assert.equal(rovingIndex(0, 0, 'ArrowDown'), null);
  assert.equal(rovingIndex(3, 1, 'Enter'), null);
});

test('stepValue clamps, snaps to the step and keeps float noise out', async () => {
  const { stepValue } = await load('kit-core.js');
  assert.equal(stepValue(0.1, { min: 0, max: 1, step: 0.1 }, 1), 0.2);
  assert.equal(stepValue(0.2, { min: 0, max: 1, step: 0.1 }, 1), 0.3, 'not 0.30000000000000004');
  assert.equal(stepValue(1, { min: 0, max: 1, step: 0.1 }, 1), 1);
  assert.equal(stepValue(0, { min: 0, max: 10, step: 1 }, -1), 0);
  assert.equal(stepValue(7, { min: 0, max: 10, step: 5 }, 0), 5, 'snaps a typed value');
  assert.equal(stepValue('3', { step: 1 }, 1), 4);
});

test('Slider readout formats', async () => {
  const { formatReadout } = await load('controls.js');
  assert.equal(formatReadout(1500, (v) => `${v}ms`), '1500ms');
  assert.equal(formatReadout(0.35, 'percent'), '35%');
  assert.equal(formatReadout(4), '4');
});

test('menuMove skips disabled items and wraps (the ⋯ row menu keys)', async () => {
  const { menuMove } = await load('menu.js');
  const items = [{ label: 'a' }, { label: 'b', disabled: true }, { label: 'c' }];
  assert.equal(menuMove(items, 0, 'ArrowDown'), 2);
  assert.equal(menuMove(items, 2, 'ArrowDown'), 0);
  assert.equal(menuMove(items, 0, 'ArrowUp'), 2);
  assert.equal(menuMove(items, 2, 'Home'), 0);
  assert.equal(menuMove(items, 0, 'End'), 2);
  assert.equal(menuMove(items, 0, 'Tab'), null);
  assert.equal(menuMove([{ disabled: true }], 0, 'ArrowDown'), null);
});

test('placePopup: below-end for a ⋯ button, above a guide cell, flips and clamps', async () => {
  const { placePopup } = await load('menu.js');
  const screen = { left: 0, top: 0, width: 1280, height: 720 };
  const size = { width: 200, height: 120 };
  // ⋯ button at the right of a row: right-aligned below it.
  assert.deepEqual(placePopup({ left: 1000, top: 100, width: 30, height: 30 }, size, screen, { align: 'end' }), { left: 830, top: 134 });
  // Near the bottom: flips above the button.
  assert.deepEqual(placePopup({ left: 1000, top: 650, width: 30, height: 30 }, size, screen, { align: 'end' }), { left: 830, top: 526 });
  // Guide cell prefers above when there's room, else below.
  assert.deepEqual(placePopup({ left: 300, top: 400, width: 120, height: 40 }, size, screen, { prefer: 'above' }), { left: 300, top: 276 });
  assert.deepEqual(placePopup({ left: 300, top: 60, width: 120, height: 40 }, size, screen, { prefer: 'above' }), { left: 300, top: 104 });
  // Kept inside: never off the right edge or above the top margin.
  assert.equal(placePopup({ left: 1250, top: 100, width: 20, height: 20 }, size, screen).left, 1072);
  const tall = placePopup({ left: 0, top: 300, width: 10, height: 10 }, { width: 100, height: 700 }, screen);
  assert.equal(tall.top, 12, 'too tall either way: bottom-aligned inside the margin');
});

test('reconcilePlan keeps surviving keys and lists removals and creations', async () => {
  const { reconcilePlan, listLetterKey } = await load('list-detail.js');
  assert.deepEqual(reconcilePlan(['a', 'b', 'c'], ['c', 'a', 'd']), { remove: ['b'], create: ['d'], order: ['c', 'a', 'd'] });
  assert.deepEqual(reconcilePlan([], ['x']), { remove: [], create: ['x'], order: ['x'] });
  assert.equal(listLetterKey('j'), 'ArrowDown');
  assert.equal(listLetterKey('k'), 'ArrowUp');
  assert.equal(listLetterKey('l'), null);
});

test('dialogs never start on a destructive action', async () => {
  const { dialogDefaultIndex } = await load('dialog.js');
  assert.equal(dialogDefaultIndex([{ label: 'CANCEL' }, { label: 'REMOVE', variant: 'danger' }]), 0);
  assert.equal(dialogDefaultIndex([{ label: 'CANCEL' }, { label: 'OK', variant: 'primary', isDefault: true }]), 1);
  assert.equal(dialogDefaultIndex([{ label: 'DELETE', variant: 'danger', isDefault: true }, { label: 'KEEP' }]), 1, 'isDefault on a danger action is ignored');
  assert.equal(dialogDefaultIndex([{ label: 'OK', variant: 'danger' }]), 0, 'a lone button is still focusable');
});

test('status bar text', async () => {
  const { taskLine, saveStateText } = await load('toast.js');
  assert.equal(taskLine([]), '');
  assert.equal(taskLine(['SCANNING']), 'SCANNING');
  assert.equal(taskLine(['SCANNING', 'SYNCING LIBRARY']), 'SYNCING LIBRARY (+1 MORE)');
  assert.equal(saveStateText('saving'), 'SAVING…');
  assert.equal(saveStateText('saved'), 'SAVED');
});

test('the stand-ins the kit replaced are gone', () => {
  const js = path.join(__dirname, '..', 'renderer', 'js');
  for (const gone of ['ui/spatial-focus.js', 'ui/row-menu.js', 'ui/setting-row.js', 'setup-narrow.js']) {
    assert.ok(!fs.existsSync(path.join(js, gone)), `${gone} was absorbed into the kit`);
  }
});
