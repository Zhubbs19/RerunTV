const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUpdateStrategy, prepareVersionTransition, rememberDownloadedRelease, releaseNotesText,
} = require('../main/main-updater-state');

test('update state turns a downloaded old-to-new transition into one post-update changelog', () => {
  const state = { lastSeenVersion: '1.4.0' };
  rememberDownloadedRelease(state, {
    version: '1.5.0',
    releaseName: 'A clearer RerunTV',
    releaseNotes: { version: '1.5.0', note: '- Better setup navigation\n- Safer restores' },
    releaseDate: '2026-08-24T12:00:00Z',
  });
  prepareVersionTransition(state, '1.5.0');
  assert.equal(state.lastSeenVersion, '1.5.0');
  assert.deepEqual(state.pendingNotice, {
    fromVersion: '1.4.0', toVersion: '1.5.0', name: 'A clearer RerunTV',
    notes: 'Version 1.5.0\n- Better setup navigation\n- Safer restores',
    publishedAt: '2026-08-24T12:00:00Z',
  });
  assert.equal(state.downloadedRelease, undefined);
  const once = JSON.stringify(state);
  prepareVersionTransition(state, '1.5.0');
  assert.equal(JSON.stringify(state), once, 'same-version relaunch must not create a second notice');
});

test('fresh installs establish a silent baseline and normalize release-note shapes', () => {
  const state = {};
  prepareVersionTransition(state, '2.0.0');
  assert.deepEqual(state, { lastSeenVersion: '2.0.0' });
  assert.equal(releaseNotesText(['One', { version: '2.0.0', note: 'Two' }]), 'One\n\nVersion 2.0.0\nTwo');
});

test('update strategies preserve legacy choices and default new installs to pre-launch', () => {
  assert.equal(normalizeUpdateStrategy(null), 'startup-auto');
  assert.equal(normalizeUpdateStrategy({}), 'startup-auto');
  assert.equal(normalizeUpdateStrategy({ mode: 'auto', showLaunchPopup: true }), 'background-notify');
  assert.equal(normalizeUpdateStrategy({ mode: 'auto', showLaunchPopup: false }), 'background-auto');
  assert.equal(normalizeUpdateStrategy({ mode: 'manual' }), 'manual');
  assert.equal(normalizeUpdateStrategy({ mode: 'off' }), 'off');
  assert.equal(normalizeUpdateStrategy({ strategy: 'startup-auto', mode: 'off' }), 'startup-auto');
});
