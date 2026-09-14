// Usage modes and remote input (docs/design/01): the mode resolver's
// precedence, key normalization across remotes, per-context routing, and
// long-press timing. All pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

test('the mode resolves device choice > launch flag > client identity > desktop', async () => {
  const { resolveUsageMode, parseModeFlag } = await load('usage-mode.js');
  const androidTv = 'Mozilla/5.0 (Linux; Android 11) Chrome/120 RerunTV-AndroidTV/1.0';
  assert.deepEqual(resolveUsageMode({}), { mode: 'desktop', source: 'default' });
  assert.equal(resolveUsageMode({ userAgent: androidTv }).mode, 'tv');
  assert.equal(resolveUsageMode({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)' }).source, 'Samsung TV browser');
  assert.equal(resolveUsageMode({ userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV)' }).source, 'LG TV browser');
  assert.deepEqual(resolveUsageMode({ query: '?mode=tv' }), { mode: 'tv', source: 'launch flag' });
  assert.equal(resolveUsageMode({ query: '?mode=desktop', userAgent: androidTv }).mode, 'desktop', 'a flag beats identity');
  assert.deepEqual(resolveUsageMode({ preference: 'desktop', query: '?mode=tv', userAgent: androidTv }), { mode: 'desktop', source: 'device choice' });
  assert.equal(resolveUsageMode({ preference: 'auto', query: '?mode=tv' }).mode, 'tv', 'auto defers to the flag');
  assert.equal(parseModeFlag('?foo=1&mode=TV'), 'tv');
  assert.equal(parseModeFlag('?mode=phone'), null);
});

test('remote buttons normalize the same from a keyboard, a TV browser and legacy keyCodes', async () => {
  const { normalizeKey } = await load('remote-input.js');
  const cases = [
    [{ key: 'ArrowLeft' }, 'left'], [{ key: 'Enter' }, 'ok'], [{ key: 'Escape' }, 'back'], [{ key: 'GoBack' }, 'back'],
    [{ key: 'ChannelUp' }, 'chUp'], [{ key: 'PageDown' }, 'chDown'], [{ key: 'MediaPlayPause' }, 'playPause'],
    [{ key: 'ColorF0Red' }, 'red'], [{ key: '7' }, 'digit7'], [{ key: '.' }, 'dot'], [{ key: 'Backspace' }, 'last'],
    [{ key: 'Unidentified', keyCode: 10009 }, 'back'], [{ key: 'Unidentified', keyCode: 461 }, 'back'],
    [{ key: 'Unidentified', keyCode: 406 }, 'blue'],
    [{ key: 'g' }, null], [{ key: 'ArrowUp', shiftKey: true }, null], [{ key: '1', ctrlKey: true }, null],
  ];
  cases.forEach(([event, expected]) => assert.equal(normalizeKey(event), expected, JSON.stringify(event)));
});

test('the same button means different things per context, and D-pad differs from the CH rocker in the guide', async () => {
  const { routeRemoteKey, hasLongPress } = await load('remote-input.js');
  assert.equal(routeRemoteKey('watching', 'up'), 'key:ArrowUp');
  assert.equal(routeRemoteKey('watching', 'chUp'), 'key:ArrowUp');
  assert.equal(routeRemoteKey('watching', 'left'), 'guide.open');
  assert.equal(routeRemoteKey('watching', 'ok'), 'key:Enter');
  assert.equal(routeRemoteKey('watching', 'ok', { longPress: true }), 'menu.open');
  assert.equal(routeRemoteKey('watching', 'back'), 'exit.prompt');
  assert.equal(routeRemoteKey('watching', 'digit4'), 'key:4');
  assert.equal(routeRemoteKey('guide', 'up'), 'key:ArrowUp');
  assert.equal(routeRemoteKey('guide', 'chUp'), 'guide.pageUp');
  assert.equal(routeRemoteKey('guide', 'back'), 'key:Escape');
  assert.equal(routeRemoteKey('guide', 'digit4'), null);
  assert.equal(routeRemoteKey('timeMachine', 'left'), 'key:ArrowLeft', 'the time machine keeps ◀▶ for shuttling');
  assert.equal(routeRemoteKey('menu', 'playPause'), 'key:Escape');
  assert.equal(routeRemoteKey('dialog', 'right'), 'focus.next');
  assert.equal(routeRemoteKey('text', 'left'), null, 'a text field keeps its arrows');
  assert.equal(routeRemoteKey('text', 'back'), 'key:Escape');
  assert.equal(hasLongPress('watching', 'ok'), true);
  assert.equal(hasLongPress('watching', 'up'), false);
});

test('D-pad + OK + Back reach the guide, the TV menu and a way out from live TV', async () => {
  const { routeRemoteKey } = await load('remote-input.js');
  const minimal = ['up', 'down', 'left', 'right', 'ok', 'back'];
  const reached = new Set();
  minimal.forEach((key) => {
    reached.add(routeRemoteKey('watching', key));
    reached.add(routeRemoteKey('watching', key, { longPress: true }));
  });
  ['guide.open', 'menu.open', 'exit.prompt', 'key:ArrowUp', 'key:Enter'].forEach((action) => assert.ok(reached.has(action), action));
});

test('long press fires once past the threshold; a quick release is short', async () => {
  const { createLongPressTracker } = await load('remote-input.js');
  const t = createLongPressTracker(500);
  assert.equal(t.press('ok', 0), true);
  assert.equal(t.press('ok', 50), false, 'auto-repeat is not a new press');
  assert.equal(t.hold('ok', 300), false);
  assert.equal(t.hold('ok', 520), true);
  assert.equal(t.hold('ok', 900), false, 'only once');
  assert.equal(t.release('ok', 950), 'long');
  t.press('ok', 1000);
  assert.equal(t.release('ok', 1200), 'short');
  t.press('ok', 2000);
  assert.equal(t.release('ok', 2600), 'long-late', 'held long but the timer never ran');
  assert.equal(t.release('ok', 2700), null);
});

test('guide actions follow doc 11 §2.3: hold OK for program actions, colour keys step a day', async () => {
  const { routeRemoteKey, hasLongPress, optionalGroupOf } = await load('remote-input.js');
  assert.equal(routeRemoteKey('guide', 'ok'), 'key:Enter', 'a short OK still tunes');
  assert.equal(routeRemoteKey('guide', 'ok', { longPress: true }), 'guide.programActions');
  assert.equal(hasLongPress('guide', 'ok'), true);
  assert.equal(routeRemoteKey('guide', 'red'), 'guide.dayBack');
  assert.equal(routeRemoteKey('guide', 'green'), 'guide.dayForward');
  assert.equal(routeRemoteKey('guide', 'info'), 'key:i');
  assert.equal(routeRemoteKey('guide', 'chDown'), 'guide.pageDown');
  assert.equal(routeRemoteKey('guide', 'playPause'), 'menu.toggle', 'the TV menu holds dock, breaks and search');
  assert.equal(optionalGroupOf('blue'), 'colour');
  assert.equal(optionalGroupOf('ok'), null);
});
