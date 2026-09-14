// main-tv-client.js — Remote-test captures saved on the host and the
// phone/computer handoff info (docs/design/01 §5.2a step B0, §7).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRemoteProfile, saveRemoteProfile, handoffInfo } = require('../main/main-tv-client.js');

test('a capture is validated, trimmed and named safely', () => {
  assert.equal(prepareRemoteProfile(null).ok, false);
  assert.equal(prepareRemoteProfile([1, 2]).ok, false);
  assert.equal(prepareRemoteProfile({ events: 'x'.repeat(300 * 1024) }).ok, false);
  const r = prepareRemoteProfile({ name: '../Hisense 50QD6030G!', events: Array.from({ length: 2500 }, (_, i) => ({ i })) }, Date.UTC(2026, 8, 14));
  assert.equal(r.ok, true);
  assert.equal(r.profile.name, 'hisense-50qd6030g');
  assert.equal(r.profile.events.length, 2000);
  assert.equal(r.profile.events[0].i, 500, 'keeps the most recent events');
  assert.match(r.fileName, /^hisense-50qd6030g-2026-09-14T00-00-00-000Z\.json$/);
});

test('saving writes under userData/remote-profiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-profile-'));
  try {
    const r = saveRemoteProfile(dir, { name: 'hisense', seen: { ok: 3 } });
    assert.equal(r.ok, true);
    assert.equal(path.dirname(r.path), path.join(dir, 'remote-profiles'));
    assert.deepEqual(JSON.parse(fs.readFileSync(r.path, 'utf8')).seen, { ok: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff points at the first access URL, with a QR, and explains when there is none', async () => {
  const QRCode = { toDataURL: async (url) => `data:qr,${url}` };
  const none = await handoffInfo([], QRCode);
  assert.equal(none.url, '');
  assert.match(none.label, /Companion/);
  const info = await handoffInfo([{ name: 'Wi-Fi', url: 'http://192.168.1.5:8725/' }], QRCode, { deepLink: '/control/channels/7' });
  assert.equal(info.url, 'http://192.168.1.5:8725/control/channels/7');
  assert.equal(info.qrDataUrl, 'data:qr,http://192.168.1.5:8725/control/channels/7');
});
