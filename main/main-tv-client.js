// TV-client support shared by Electron IPC and the LAN viewer server
// (docs/design/01): saving a Remote-test capture from any client, and the
// "edit on your phone or computer" handoff info (URL + QR).
//
// Handoff points at the Companion page (remote control + settings) until the
// web control panel (docs/design/06) exists; then the same call returns a
// deep link into it and no screen needs to change.
const fs = require('fs');
const path = require('path');

const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_EVENTS = 2000;

// Pure: validates and shapes a capture before it's written. Returns
// { ok: true, profile, fileName } or { ok: false, error }.
function prepareRemoteProfile(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Profile must be an object' };
  const json = JSON.stringify(input);
  if (json.length > MAX_PROFILE_BYTES) return { ok: false, error: 'Profile is too large' };
  const name = String(input.name || 'remote').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'remote';
  const events = Array.isArray(input.events) ? input.events.slice(-MAX_EVENTS) : [];
  const profile = {
    name,
    capturedAt: new Date(now).toISOString(),
    client: typeof input.client === 'string' ? input.client.slice(0, 200) : '',
    seen: input.seen && typeof input.seen === 'object' ? input.seen : {},
    overrides: input.overrides && typeof input.overrides === 'object' ? input.overrides : {},
    events,
  };
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return { ok: true, profile, fileName: `${name}-${stamp}.json` };
}

function saveRemoteProfile(userDataDir, input, now = Date.now()) {
  const prepared = prepareRemoteProfile(input, now);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const dir = path.join(userDataDir, 'remote-profiles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, prepared.fileName);
  fs.writeFileSync(file, `${JSON.stringify(prepared.profile, null, 2)}\n`);
  return { ok: true, path: file };
}

// accessUrls: [{ name, url }] (the Companion's pairing-aware access URLs).
// deepLink: an optional task path for when doc 06's panel exists.
async function handoffInfo(accessUrls, QRCode, { deepLink = '' } = {}) {
  const first = (accessUrls || []).find((entry) => entry && entry.url);
  if (!first) return { url: '', qrDataUrl: '', label: 'Turn on the Companion app in Settings to edit from a phone or computer.' };
  const url = deepLink ? `${first.url.replace(/\/$/, '')}${deepLink}` : first.url;
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360 });
  } catch (e) { /* the URL text still works */ }
  return { url, qrDataUrl, label: 'Scan with your phone, or open this address on a computer on the same network.' };
}

module.exports = { prepareRemoteProfile, saveRemoteProfile, handoffInfo, MAX_PROFILE_BYTES };
