const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPersonalService } = require('../main/personal/service');

function fixture(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-personal-'));
  let clock = 1000;
  const events = [];
  const service = createPersonalService({ dir: path.join(root, 'profiles'), getConfig: () => config, now: () => ++clock, publish: (channel, data) => events.push({ channel, data }) });
  return { root, service, events };
}

test('first use migrates legacy personal values into Everyone outside channels.json', async (t) => {
  const config = { channels: [{ number: 5, favorite: true }, { number: 6 }], reminders: [{ id: 'r1' }], airChecks: [{ id: 'a1' }] };
  const { root, service } = fixture(config); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profiles = await service.call('listProfiles');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'everyone');
  const everyone = await service.call('getProfile', { id: 'everyone' });
  assert.deepEqual(everyone.state.favorites, [5]);
  assert.deepEqual(everyone.state.reminders, [{ id: 'r1' }]);
  assert.deepEqual(everyone.state.airChecks, [{ id: 'a1' }]);
  assert.equal(config.channels[0].favorite, true, 'migration never mutates broadcast config');
});

test('profiles use hashed PINs and personal commands are revision checked', async (t) => {
  const { root, service, events } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = await service.call('createProfile', { name: 'Kids', pin: '1234', restriction: 'kids' });
  const bytes = fs.readFileSync(path.join(root, 'profiles', `${created.id}.json`), 'utf8');
  assert.equal(bytes.includes('"1234"'), false);
  const changed = await service.call('command', { profileId: created.id, baseRevision: created.revision, command: { type: 'favorite.toggle', channel: 7 } });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.profile.state.favorites, [7]);
  const stale = await service.call('command', { profileId: created.id, baseRevision: created.revision, command: { type: 'favorite.toggle', channel: 8 } });
  assert.equal(stale.reason, 'stale');
  await assert.rejects(service.call('updateProfile', { id: created.id, currentPin: '9999', name: 'Nope' }), /incorrect/);
  assert.ok(events.some((event) => event.channel === 'personal:changed'));
});

test('recording requests and resume points remain profile scoped', async (t) => {
  const { root, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const everyone = await service.call('getProfile', { id: 'everyone' });
  let result = await service.call('command', { profileId: 'everyone', baseRevision: everyone.revision, command: { type: 'recording.request', requestType: 'series', channel: 9, start: 10, end: 20, seriesId: 'show' } });
  assert.equal(result.profile.state.recordingRequests[0].type, 'series');
  result = await service.call('command', { profileId: 'everyone', baseRevision: result.profile.revision, command: { type: 'resume.set', key: 'tape:a', positionMs: 4500 } });
  assert.equal(result.profile.state.resumePoints['tape:a'].positionMs, 4500);
});

test('shared sessions restrict tune changes to the leader', async (t) => {
  const { root, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = await service.call('session', { action: 'start', clientId: 'tv', channel: 7, timeOffsetMs: -5000 });
  const joined = await service.call('session', { action: 'join', id: session.id, clientId: 'phone' });
  assert.deepEqual(joined.members, ['tv', 'phone']);
  await assert.rejects(service.call('session', { action: 'tune', id: session.id, clientId: 'phone', channel: 8 }), /leader/);
  const tuned = await service.call('session', { action: 'tune', id: session.id, clientId: 'tv', channel: 8, timeOffsetMs: 0 });
  assert.equal(tuned.channel, 8);
});

test('presence lists active screens for handoff and expires stale ones', async (t) => {
  let now = 1000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-personal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPersonalService({ dir: path.join(root, 'profiles'), now: () => now });
  let clients = await service.call('presence', { action: 'register', clientId: 'tv', label: 'Living room TV', profileId: 'everyone' });
  assert.equal(clients.length, 1);
  assert.equal(clients[0].label, 'Living room TV');
  now += 61000;
  clients = await service.call('presence', { action: 'list' });
  assert.deepEqual(clients, []);
});
