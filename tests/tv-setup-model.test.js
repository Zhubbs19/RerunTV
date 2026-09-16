// tv-setup-model.js — TV setup value stepping, the on-screen keyboard and the
// first-run wizard (docs/design/01 §6.4–6.5).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'tv/setup-model.js')).href);

test('◀▶ steps a number within its range and cycles a choice', async () => {
  const { stepNumber, cycleChoice } = await load();
  assert.equal(stepNumber(50, 1), 55);
  assert.equal(stepNumber(98, 1), 100);
  assert.equal(stepNumber(2, -1), 0);
  assert.equal(stepNumber(undefined, 1, { min: 15, max: 240, step: 15 }), 30);
  assert.equal(stepNumber(47, 1), 50, 'snaps to the step');
  assert.equal(cycleChoice(['a', 'b', 'c'], 'c', 1), 'a');
  assert.equal(cycleChoice(['a', 'b', 'c'], 'a', -1), 'c');
  assert.equal(cycleChoice(['a', 'b'], 'zzz', 1), 'a');
  assert.equal(cycleChoice([], 'x'), 'x');
});

test('the on-screen keyboard edits text and finishes on DONE', async () => {
  const { applyOskKey, OSK_ROWS } = await load();
  let r = applyOskKey('NIC', 'K');
  assert.deepEqual(r, { value: 'NICK', done: false });
  r = applyOskKey(r.value, 'SPACE');
  assert.equal(r.value, 'NICK ');
  assert.equal(applyOskKey('NICK', 'DELETE').value, 'NIC');
  assert.equal(applyOskKey('NICK', 'CLEAR').value, '');
  assert.deepEqual(applyOskKey('NICK', 'DONE'), { value: 'NICK', done: true });
  assert.equal(applyOskKey('ABCDEF', 'G', { maxLength: 6 }).value, 'ABCDEF', 'stops at the limit');
  assert.ok(OSK_ROWS.flat().includes('DONE'));
});

test('the wizard walks its steps and the remote check waits for each button', async () => {
  const { nextWizardStep, advanceRemoteCheck, REMOTE_CHECK } = await load();
  assert.equal(nextWizardStep('welcome'), 'channels');
  assert.equal(nextWizardStep('remote'), 'done');
  assert.equal(nextWizardStep('done'), 'done');
  let i = 0;
  i = advanceRemoteCheck(i, { remoteKey: 'up' });
  assert.equal(i, 0, 'a different button does nothing');
  i = advanceRemoteCheck(i, { remoteKey: 'ok' });
  assert.equal(i, 1);
  i = advanceRemoteCheck(i, { remoteKey: 'back' });
  assert.equal(i, 2);
  assert.equal(advanceRemoteCheck(i, { remoteKey: 'ok' }), 2, 'a short OK is not a hold');
  i = advanceRemoteCheck(i, { remoteKey: 'ok', longPress: true });
  assert.equal(i, REMOTE_CHECK.length);
});
