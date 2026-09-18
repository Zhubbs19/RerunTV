// TV-client support shared by Electron IPC and the LAN viewer server
// (docs/design/01): saving a Remote-test capture from any client, and the
// "edit on your phone or computer" handoff info (URL + QR).
//
// Handoff prefers a one-time link straight into the web control panel
// (docs/design/06 §4): the caller mints a control-scope pairing URL (same
// mechanism as the Settings panel's "control pairing code", just pre-filled)
// so scanning the QR opens directly into an already-writable session, no
// second code entry. It falls back to the Companion page (remote control +
// settings) when the viewer/control service isn't available — e.g. LAN
// viewer access is off, or a plugin caller has no control scope to offer.
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

// accessUrls: [{ name, url }] — pass control-scope viewer URLs (each already
// carrying a one-time pairing code, see main.js's viewerControlAccessUrls) to
// hand off straight into an editable session; pass the Companion's own
// access URLs as a fallback when no control-scope link is available.
// deepLink: an optional task path appended before any pairing-code query string.
// writable: true when accessUrls are control-scope links, for the label text.
async function handoffInfo(accessUrls, QRCode, { deepLink = '', writable = false } = {}) {
  const first = (accessUrls || []).find((entry) => entry && entry.url);
  if (!first) return { url: '', qrDataUrl: '', label: 'Turn on "Share with devices on this network" in Settings to edit from a phone or computer.' };
  const url = deepLink ? insertDeepLink(first.url, deepLink) : first.url;
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360 });
  } catch (e) { /* the URL text still works */ }
  const label = writable
    ? 'Scan with your phone, or open this address on a computer on the same network — it opens straight into an editable setup screen.'
    : 'Scan with your phone, or open this address on a computer on the same network.';
  return { url, qrDataUrl, label };
}

// Splices a path onto the URL's origin+path, ahead of its own query string
// (a control-scope URL carries `?pair=<code>`, which must stay last so the
// pairing code is still read on the far side).
function insertDeepLink(url, deepLink) {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}${deepLink}`;
  return parsed.toString();
}

module.exports = { prepareRemoteProfile, saveRemoteProfile, handoffInfo, MAX_PROFILE_BYTES };
