// remote-profile.js and the Android keycode half of remote-input.js
// (docs/design/01 §5.1–5.2).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

test('Android keycodes normalize to RemoteKeys, gamepad buttons included', async () => {
  const { normalizeAndroidKeyCode, rawKeyId } = await load('remote-input.js');
  assert.equal(normalizeAndroidKeyCode(19), 'up');
  assert.equal(normalizeAndroidKeyCode(23), 'ok');
  assert.equal(normalizeAndroidKeyCode(4), 'back');
  assert.equal(normalizeAndroidKeyCode(166), 'chUp');
  assert.equal(normalizeAndroidKeyCode(85), 'playPause');
  assert.equal(normalizeAndroidKeyCode(183), 'red');
  assert.equal(normalizeAndroidKeyCode(14), 'digit7');
  assert.equal(normalizeAndroidKeyCode(96), 'ok', 'gamepad A');
  assert.equal(normalizeAndroidKeyCode(103), 'chUp', 'gamepad RB');
  assert.equal(normalizeAndroidKeyCode(3), null, 'Home is never ours');
  assert.equal(rawKeyId({ source: 'android', keyCode: 172 }), 'android:172');
  assert.equal(rawKeyId({ key: 'ArrowUp' }), 'key:ArrowUp');
  assert.equal(rawKeyId({ key: 'Unidentified', keyCode: 10009 }), 'keyCode:10009');
  assert.equal(rawKeyId({ source: 'gamepad', button: 0 }), 'gamepad:0');
});

test('the profile records delivered buttons and persists them', async () => {
  const { createRemoteProfile, PROFILE_STORAGE_KEY } = await load('remote-profile.js');
  const storage = fakeStorage();
  const p = createRemoteProfile(storage);
  assert.equal(p.note('guide'), true);
  assert.equal(p.note('guide'), false);
  assert.equal(p.note('notAKey'), false);
  assert.equal(p.has('guide'), true);
  assert.equal(p.has('red'), false);
  const again = createRemoteProfile(storage);
  assert.deepEqual(again.seenKeys(), ['guide']);
  assert.ok(storage.data[PROFILE_STORAGE_KEY]);
});

test('learn-mode overrides map a physical button to a RemoteKey, and reset', async () => {
  const { createRemoteProfile } = await load('remote-profile.js');
  const storage = fakeStorage();
  const p = createRemoteProfile(storage);
  assert.equal(p.setOverride('android:302', 'guide'), true);
  assert.equal(p.setOverride('android:303', 'bogus'), false);
  assert.equal(createRemoteProfile(storage).overrideFor('android:302'), 'guide');
  p.resetOverrides();
  assert.equal(createRemoteProfile(storage).overrideFor('android:302'), null);
  assert.equal(p.overrideFor(null), null);
});

test('a corrupt or old stored profile starts fresh', async () => {
  const { createRemoteProfile, PROFILE_STORAGE_KEY } = await load('remote-profile.js');
  assert.deepEqual(createRemoteProfile(fakeStorage({ [PROFILE_STORAGE_KEY]: '{not json' })).seenKeys(), []);
  assert.deepEqual(createRemoteProfile(fakeStorage({ [PROFILE_STORAGE_KEY]: JSON.stringify({ version: 0, seen: { ok: 1 } }) })).seenKeys(), []);
});
