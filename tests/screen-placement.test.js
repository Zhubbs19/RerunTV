// Screen placement (main/ui/screen-placement.js): a PC driving a TV over HDMI
// as a second screen. The TV sleeping must not lose the window's place on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  boundsFor, displayForBounds, findDisplay, planLaunch, recordState, trackScreenPlacement,
} = require('../main/ui/screen-placement');

const desk = { id: 1, label: 'DELL U2720Q', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
const tv = { id: 2, label: 'HISENSE', bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 2 };

test('screens are found by id, then by a unique label', () => {
  assert.equal(findDisplay([desk, tv], { id: '2', label: 'X' }), tv);
  assert.equal(findDisplay([desk, tv], { id: '99', label: 'HISENSE' }), tv);
  assert.equal(findDisplay([desk, { ...tv, label: 'DELL U2720Q' }], { id: '99', label: 'DELL U2720Q' }), null);
  assert.equal(findDisplay([desk], { id: '2', label: 'HISENSE' }), null);
});

test('bounds belong to the screen holding most of them', () => {
  assert.equal(displayForBounds([desk, tv], { x: 1800, y: 0, width: 1000, height: 500 }), tv);
  assert.equal(displayForBounds([desk, tv], { x: -5000, y: 0, width: 100, height: 100 }), null);
});

test('saved bounds are kept when they fit, else the work area is used', () => {
  assert.deepEqual(boundsFor(tv, { x: 2000, y: 100, width: 800, height: 600 }), { x: 2000, y: 100, width: 800, height: 600 });
  assert.deepEqual(boundsFor(tv, { x: 0, y: 0, width: 800, height: 600 }), tv.workArea);
  assert.deepEqual(boundsFor(desk, null, 0.5), { x: 480, y: 260, width: 960, height: 520 });
});

test('launch goes back to the last screen and restores its fullscreen', () => {
  const state = recordState({}, tv, { bounds: { x: 2000, y: 50, width: 1200, height: 800 }, isMaximized: false, isFullScreen: true });
  const plan = planLaunch({ displays: [desk, tv], state, cursorDisplay: desk });
  assert.equal(plan.display, tv);
  assert.equal(plan.isFullScreen, true);
  assert.equal(plan.pendingReturn, null);
});

test('with the TV off at launch the window opens on the desk and waits for it', () => {
  const state = recordState({}, tv, { bounds: { x: 2000, y: 50, width: 1200, height: 800 }, isMaximized: false, isFullScreen: true });
  const plan = planLaunch({ displays: [desk], state, cursorDisplay: desk });
  assert.equal(plan.display, desk);
  assert.equal(plan.isFullScreen, false);
  assert.deepEqual(plan.pendingReturn, { id: '2', label: 'HISENSE' });
});

test('a chosen screen beats the last one used', () => {
  const state = { ...recordState({}, desk, { bounds: desk.workArea, isMaximized: true, isFullScreen: false }), preferred: { id: '2', label: 'HISENSE' } };
  assert.equal(planLaunch({ displays: [desk, tv], state, cursorDisplay: desk }).display, tv);
});

test('an old single-record window-state.json still places the window', () => {
  const plan = planLaunch({ displays: [desk, tv], state: { x: 2100, y: 10, width: 1000, height: 700, isMaximized: true }, cursorDisplay: desk });
  assert.equal(plan.display, tv);
  assert.equal(plan.isMaximized, true);
  assert.deepEqual(plan.bounds, { x: 2100, y: 10, width: 1000, height: 700 });
});

test('a pending return keeps last pointed at the missing screen', () => {
  const onTv = recordState({}, tv, { bounds: tv.workArea, isMaximized: false, isFullScreen: true });
  const onDesk = recordState(onTv, desk, { bounds: desk.workArea, isMaximized: false, isFullScreen: false }, { pending: true });
  assert.deepEqual(onDesk.last, { id: '2', label: 'HISENSE' });
  assert.equal(onDesk.screens['2'].isFullScreen, true);
});

// ---------- Controller, against a fake window and screen ----------

function fakeScreen(displays) {
  const s = new EventEmitter();
  s.displays = displays;
  s.getAllDisplays = () => s.displays;
  s.getPrimaryDisplay = () => s.displays[0];
  return s;
}

function fakeWindow(bounds) {
  const w = new EventEmitter();
  w.bounds = { ...bounds };
  w.full = false;
  w.max = false;
  w.isDestroyed = () => false;
  w.isMinimized = () => false;
  w.isFullScreen = () => w.full;
  w.isMaximized = () => w.max;
  w.setFullScreen = (on) => { w.full = on; };
  w.maximize = () => { w.max = true; };
  w.unmaximize = () => { w.max = false; };
  w.getBounds = () => ({ ...w.bounds });
  w.getNormalBounds = () => ({ ...w.bounds });
  w.setBounds = (b) => { w.bounds = { ...b }; };
  return w;
}

test('the TV going away and coming back returns the window to fullscreen on it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const screen = fakeScreen([desk, tv]);
  const state = recordState({}, tv, { bounds: tv.workArea, isMaximized: false, isFullScreen: true });
  const plan = planLaunch({ displays: screen.displays, state, cursorDisplay: desk });
  const win = fakeWindow(plan.bounds);
  win.full = true;
  const saves = [];
  trackScreenPlacement(win, { screen, state, saveState: (s) => saves.push(s), plan });

  // TV sleeps: Windows drops it and moves the window onto the desk.
  screen.displays = [desk];
  screen.emit('display-removed', {}, tv);
  assert.equal(win.full, false, 'fullscreen must not follow the window onto the desk monitor');
  win.bounds = { x: 100, y: 100, width: 1200, height: 800 };
  t.mock.timers.tick(500);
  assert.equal(displayForBounds([desk], win.bounds), desk);
  t.mock.timers.tick(500);
  assert.deepEqual(saves.at(-1).last, { id: '2', label: 'HISENSE' }, 'the TV stays the launch target');
  assert.equal(saves.at(-1).screens['2'].isFullScreen, true, "the TV's record survives the forced move");

  // TV wakes up.
  screen.displays = [desk, tv];
  screen.emit('display-added', {}, tv);
  t.mock.timers.tick(1200);
  assert.equal(displayForBounds(screen.displays, win.bounds), tv);
  assert.equal(win.full, true);
});

test('in automatic mode, dragging the window elsewhere cancels the return', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const screen = fakeScreen([desk]);
  const state = recordState({}, tv, { bounds: tv.workArea, isMaximized: false, isFullScreen: true });
  const plan = planLaunch({ displays: screen.displays, state, cursorDisplay: desk });
  const third = { ...tv, id: 3, label: 'LG', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
  screen.displays = [desk, third];
  const win = fakeWindow(plan.bounds);
  const placement = trackScreenPlacement(win, { screen, state, saveState: () => {}, plan });
  assert.ok(placement.listScreens().pendingReturn);
  win.bounds = { x: -1800, y: 0, width: 1000, height: 700 };
  win.emit('move');
  t.mock.timers.tick(500);
  assert.equal(placement.listScreens().pendingReturn, null);
});

test('choosing a connected screen moves the window there now', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const screen = fakeScreen([desk, tv]);
  const plan = planLaunch({ displays: screen.displays, state: null, cursorDisplay: desk });
  const win = fakeWindow(plan.bounds);
  const saves = [];
  const placement = trackScreenPlacement(win, { screen, state: null, saveState: (s) => saves.push(s), plan });
  const listed = placement.setPreferred({ id: '2', label: 'HISENSE' });
  assert.equal(displayForBounds(screen.displays, win.bounds), tv);
  assert.deepEqual(saves.at(-1).preferred, { id: '2', label: 'HISENSE' });
  assert.equal(listed.screens.find((s) => s.id === '2').width, 3840);
});
