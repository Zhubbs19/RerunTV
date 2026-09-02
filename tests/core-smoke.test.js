const test = require('node:test');
const assert = require('node:assert/strict');

const { compareConfigs } = require('../main/config-diff');
const { createLanAccess, isLanServiceEnabled } = require('../main/main-lan-security');
const { createViewerProjection } = require('../main/main-viewer-projection');
const { normalizeUpdateStrategy, prepareVersionTransition, rememberDownloadedRelease } = require('../main/main-updater-state');

test('LAN services remain opt-in and pairing codes are short numeric secrets', () => {
  assert.equal(isLanServiceEnabled({}, 'viewer'), false);
  assert.equal(isLanServiceEnabled({ network: { viewerEnabled: true } }, 'viewer'), true);
  assert.match(createLanAccess('test').pairingCode, /^\d{8}$/);
});

test('viewer projection removes credentials and replaces local paths with opaque ids', () => {
  const projection = createViewerProjection(Buffer.alloc(32, 7));
  const rawPath = 'C:\\Users\\person\\Videos\\episode-01.mp4';
  const projected = projection.project({
    apiToken: 'secret',
    display: { customCssPath: 'C:\\private.css' },
    channels: [{ files: [{ path: rawPath, duration: 123 }] }],
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('C:\\\\Users'), false);
  assert.match(projected.channels[0].files[0].path, /^viewer:/);
  assert.equal(projection.resolve(projected.channels[0].files[0].path), rawPath);
  assert.equal(projection.resolve(projected.channels[0].files[0].path.slice('viewer:'.length)), rawPath);
});

test('backup comparison reports lineup, schedule, and setting changes', () => {
  const current = { theme: 'old', channels: [{ number: 2, name: 'TWO', files: [{}], blocks: [] }] };
  const snapshot = { theme: 'new', channels: [{ number: 2, name: 'TWO HD', files: [{}, {}], blocks: [{ id: 'prime' }] }] };
  const diff = compareConfigs(current, snapshot);
  assert.equal(diff.renamedChannels[0].to, 'TWO HD');
  assert.equal(diff.fileCountChanges[0].snapshot, 2);
  assert.equal(diff.scheduleChanges[0].number, 2);
  assert.deepEqual(diff.settingsChanges, ['theme']);
});

test('downloaded updates produce one post-update notice and preserve strategy migration', () => {
  const state = { lastSeenVersion: '1.4.0' };
  rememberDownloadedRelease(state, { version: '1.5.0', releaseName: 'RerunTV', releaseNotes: 'Improved guide' });
  prepareVersionTransition(state, '1.5.0');
  assert.equal(state.pendingNotice.toVersion, '1.5.0');
  const once = JSON.stringify(state);
  prepareVersionTransition(state, '1.5.0');
  assert.equal(JSON.stringify(state), once);
  assert.equal(normalizeUpdateStrategy({ mode: 'manual' }), 'manual');
});
