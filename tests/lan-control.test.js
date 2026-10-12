// The LAN control scope and command endpoint (docs/design/06 §4, 05 §2.4).
//
// Two things are being checked here and they are different: that a `view`
// session cannot write, however it asks, and that a `control` session goes
// through exactly the same host command protocol the Electron renderer does.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { startViewerServer } = require('../main/lan/viewer-server');
const { createLanAccess } = require('../main/lan/security');
const { createConfigHost } = require('../main/config/host');

const commandsUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core/commands.js')).href;

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const { body, ...requestOptions } = options;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, ...requestOptions }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
        json() { try { return JSON.parse(this.body); } catch (e) { return null; } },
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function baseConfig() {
  return {
    channels: [{ number: 5, name: 'Rewind', path: 'C:\\Media\\Rewind', files: [] }],
    plugins: { disabled: [] },
    pluginSettings: { weather: { apiKey: 'super-secret', units: 'F' } },
  };
}

// A viewer server with a real two-scope access object and a real config host.
async function startTestHost() {
  const disk = { raw: JSON.stringify(baseConfig()) };
  const services = {};
  const host = createConfigHost({
    load: () => JSON.parse(disk.raw),
    save: (config) => { disk.raw = JSON.stringify(config); },
    loadCommands: () => import(commandsUrl),
  });
  const access = createLanAccess('viewer', { scopes: ['view', 'control'] });
  const runtime = startViewerServer(services, {
    host: '127.0.0.1',
    port: 0,
    access,
    loadConfig: () => JSON.parse(disk.raw),
    // The route supplies origin and remote; this is the same pass-through
    // main.js uses, so the test drives the real authorization path.
    applyCommands: (batch, meta) => host.applyCommands(batch, meta),
    getRevision: () => host.getRevision(),
    snapshot: () => host.snapshot(),
  });
  assert.equal(await runtime.ready, true);
  return { runtime, access, host, disk, services, port: runtime.server.address().port };
}

// Pairs a fresh device at one scope and returns its bearer token.
async function pair(port, code) {
  const response = await request(port, `/?pair=${code}`, { headers: { Accept: 'application/json' } });
  return response.json();
}

const postCommands = (port, token, body) => request(port, '/api/commands', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const postPersonal = (port, token, method, body = {}) => request(port, `/api/personal/${method}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('the two pairing codes are different and each fixes its own session scope', async () => {
  const ctx = await startTestHost();
  try {
    assert.notEqual(ctx.access.pairingCodes.view, ctx.access.pairingCodes.control);
    const viewer = await pair(ctx.port, ctx.access.pairingCodes.view);
    const controller = await pair(ctx.port, ctx.access.pairingCodes.control);
    assert.equal(viewer.scope, 'view');
    assert.equal(controller.scope, 'control');
    assert.notEqual(viewer.token, controller.token);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a view session cannot write, read control config, or read control state', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.view);
    const write = await postCommands(ctx.port, token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Should not happen' }],
      id: 'viewer-write', baseRevision: 0, client: 'viewer',
    });
    assert.equal(write.status, 403);
    assert.equal(ctx.host.getRevision(), 0, 'nothing was applied');
    assert.equal(JSON.parse(ctx.disk.raw).channels[0].name, 'Rewind');

    for (const route of ['/api/control/config', '/api/control/state']) {
      const response = await request(ctx.port, route, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 403, route);
    }
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a view session is bound to one personal profile without gaining config control', async () => {
  const access = createLanAccess('viewer', { scopes: ['view', 'control'] });
  const profiles = {
    everyone: { id: 'everyone', name: 'Everyone', restriction: 'none', hasPin: false, revision: 0, state: { favorites: [] } },
    family: { id: 'family', name: 'Family', restriction: 'kids', hasPin: false, revision: 0, state: { favorites: [5] } },
  };
  let commandProfileId = null;
  const personalCall = async (method, payload) => {
    if (method === 'listProfiles') return Object.values(profiles).map(({ state, ...summary }) => summary);
    if (method === 'getProfile') return profiles[payload.id];
    if (method === 'command') { commandProfileId = payload.profileId; return { ok: true, profile: profiles[payload.profileId] }; }
    if (method === 'verifyProfile') return true;
    throw new Error(`unexpected ${method}`);
  };
  const runtime = startViewerServer({}, {
    host: '127.0.0.1', port: 0, access, personalCall, loadConfig: baseConfig,
  });
  assert.equal(await runtime.ready, true);
  const port = runtime.server.address().port;
  try {
    const viewer = await pair(port, access.pairingCodes.view);
    assert.equal((await postPersonal(port, viewer.token, 'getProfile')).json().result.id, 'everyone');
    assert.equal((await postPersonal(port, viewer.token, 'selectProfile', { id: 'family' })).json().result.id, 'family');
    const command = await postPersonal(port, viewer.token, 'command', { profileId: 'everyone', baseRevision: 0, command: { type: 'favorite.toggle', channel: 5 } });
    assert.equal(command.status, 200);
    assert.equal(commandProfileId, 'family', 'the host ignores a profile id supplied by the viewer');
    assert.equal((await postCommands(port, viewer.token, { commands: [{ type: 'channel.rename', channel: 5, name: 'No' }] })).status, 403);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
  }
});

test('an unpaired device reaches none of it', async () => {
  const ctx = await startTestHost();
  try {
    const write = await postCommands(ctx.port, 'not-a-real-token', {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Nope' }], id: 'x', baseRevision: 0, client: 'x',
    });
    assert.notEqual(write.status, 200);
    assert.equal(ctx.host.getRevision(), 0);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('entering the control code mints a new session and never widens the old one', async () => {
  const ctx = await startTestHost();
  try {
    const viewer = await pair(ctx.port, ctx.access.pairingCodes.view);
    // The same device now presents the control code. The token it gets back is
    // a different one; the token it held stays read-only.
    const upgraded = await pair(ctx.port, ctx.access.pairingCodes.control);
    assert.equal(upgraded.scope, 'control');
    assert.notEqual(upgraded.token, viewer.token);

    const withOldToken = await postCommands(ctx.port, viewer.token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Via the old token' }],
      id: 'old-token', baseRevision: 0, client: 'viewer',
    });
    assert.equal(withOldToken.status, 403, 'the view token is still only a view token');

    const withNewToken = await postCommands(ctx.port, upgraded.token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Via the new token' }],
      id: 'new-token', baseRevision: 0, client: 'controller',
    });
    assert.equal(withNewToken.status, 200);
    assert.equal(JSON.parse(ctx.disk.raw).channels[0].name, 'Via the new token');
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a control session writes through the same protocol as the Electron renderer', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);

    const applied = await postCommands(ctx.port, token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Toon Town' }],
      id: 'lan-1', baseRevision: 0, client: 'ipad',
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.json().ok, true);
    assert.equal(JSON.parse(ctx.disk.raw).channels[0].name, 'Toon Town');

    // Redelivery: answered, not applied again.
    const again = await postCommands(ctx.port, token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Toon Town' }],
      id: 'lan-1', baseRevision: 0, client: 'ipad',
    });
    assert.equal(again.json().duplicate, true);
    assert.equal(again.json().revision, applied.json().revision);

    // Another client got there first, so a stale batch is refused with a 409.
    await ctx.host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'From the host window' }],
      { origin: 'client', client: 'electron', id: 'desktop-1', baseRevision: ctx.host.getRevision() });
    const stale = await postCommands(ctx.port, token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Stale' }],
      id: 'lan-2', baseRevision: 1, client: 'ipad',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json().reason, 'conflict');
    assert.equal(JSON.parse(ctx.disk.raw).channels[0].name, 'From the host window');
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a LAN batch cannot claim to be a trusted host edit', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    await ctx.host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'Host first' }],
      { origin: 'client', client: 'electron', id: 'desktop-1', baseRevision: 0 });

    // origin: 'host' would skip conflict checking entirely. The route forces it.
    const sneaky = await postCommands(ctx.port, token, {
      commands: [{ type: 'channel.rename', channel: 5, name: 'Elevated' }],
      id: 'lan-sneaky', baseRevision: 0, client: 'ipad', origin: 'host',
    });
    assert.equal(sneaky.status, 409);
    assert.equal(JSON.parse(ctx.disk.raw).channels[0].name, 'Host first');
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('control config carries real paths but never credentials', async () => {
  const ctx = await startTestHost();
  try {
    const control = await pair(ctx.port, ctx.access.pairingCodes.control);
    const viewerPair = await pair(ctx.port, ctx.access.pairingCodes.view);

    const controlConfig = (await request(ctx.port, '/api/control/config', {
      headers: { Authorization: `Bearer ${control.token}` },
    })).json();
    assert.equal(controlConfig.config.channels[0].path, 'C:\\Media\\Rewind',
      'an editor has to be able to show and change a real path');
    assert.equal(controlConfig.config.pluginSettings.weather.apiKey, undefined,
      'credentials stay on the host');
    assert.equal(controlConfig.config.pluginSettings.weather.units, 'F');
    assert.equal(Number.isInteger(controlConfig.revision), true);

    // The viewer projection is untouched by any of this.
    const viewerConfig = (await request(ctx.port, '/api/config', {
      headers: { Authorization: `Bearer ${viewerPair.token}` },
    })).json();
    assert.match(viewerConfig.channels[0].path, /^viewer:/, 'a viewer still gets opaque refs');
    assert.equal(viewerConfig.pluginSettings.weather.apiKey, undefined);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a malformed or oversized command body is refused without touching config', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const empty = await postCommands(ctx.port, token, { commands: [], id: 'e', baseRevision: 0, client: 'ipad' });
    assert.equal(empty.status, 400);

    const notAnArray = await postCommands(ctx.port, token, { commands: { type: 'channel.rename' }, id: 'n', baseRevision: 0, client: 'ipad' });
    assert.equal(notAnArray.status, 400);

    const huge = await request(ctx.port, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ type: 'channel.rename', channel: 5, name: 'x'.repeat(300 * 1024) }], id: 'big', baseRevision: 0, client: 'ipad' }),
    }).catch((e) => ({ status: 0, error: e.message }));
    assert.notEqual(huge.status, 200);

    assert.equal(ctx.host.getRevision(), 0);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a sessions file written before scopes existed reads back as view-only', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-sessions-')), 'viewer.json');
  fs.writeFileSync(file, JSON.stringify({ 'legacy-token': Date.now() + 60000 }));

  const access = createLanAccess('viewer', { scopes: ['view', 'control'], sessionsFile: file });
  const asRequest = (token) => ({ headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(access.isAuthenticated(asRequest('legacy-token')), true, 'it is still a valid session');
  assert.equal(access.scopeOf(asRequest('legacy-token')), 'view', 'but never a writable one');
});

// ---------- The /control route (docs/design/06 §3) ----------

test('/control serves the renderer bundle to a control session and nobody else', async () => {
  const ctx = await startTestHost();
  try {
    const viewer = await pair(ctx.port, ctx.access.pairingCodes.view);
    const controller = await pair(ctx.port, ctx.access.pairingCodes.control);

    const denied = await request(ctx.port, '/control', { headers: { Authorization: `Bearer ${viewer.token}` } });
    assert.equal(denied.status, 403, 'a view session gets no editor');

    const served = await request(ctx.port, '/control', { headers: { Authorization: `Bearer ${controller.token}` } });
    assert.equal(served.status, 200);
    assert.match(served.body, /browser-api-shim\.js/, 'it is the same bundle, not a second app');
    assert.match(served.headers['content-type'], /text\/html/);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('/control is served unmodified, so its Content-Security-Policy still holds', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const served = await request(ctx.port, '/control', { headers: { Authorization: `Bearer ${token}` } });
    const index = await request(ctx.port, '/', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(served.body, index.body, 'nothing is injected into the page');
    // index.html's CSP has no 'unsafe-inline', so an injected marker script
    // would be blocked. The shim reads window.location instead.
    assert.match(served.body, /script-src 'self' app:/);
    assert.doesNotMatch(served.body, /<script>[^<]*__controlClient/);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('/control/ redirects to /control so the relative asset URLs resolve', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const trailing = await request(ctx.port, '/control/', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(trailing.status, 301);
    assert.equal(trailing.headers.location, '/control');
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('config:applied reaches a control session and is withheld from a viewer', async () => {
  const ctx = await startTestHost();
  try {
    const viewer = await pair(ctx.port, ctx.access.pairingCodes.view);
    const controller = await pair(ctx.port, ctx.access.pairingCodes.control);
    // Publish both kinds of event, as the host does on a write.
    ctx.services.viewerRemoteBridge.publish('config:changed', null);
    ctx.services.viewerRemoteBridge.publish('config:applied', {
      ok: true, revision: 1, commands: [{ type: 'channel.rename', channel: 5, name: 'Real value' }],
    });

    // No cursor means "tell me where you are"; after=0 replays from the start.
    const readEvents = (token) => request(ctx.port, '/api/remote-events?after=0', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());

    const asController = await readEvents(controller.token);
    const asViewer = await readEvents(viewer.token);

    assert.deepEqual(asController.events.map((e) => e.channel), ['config:changed', 'config:applied']);
    assert.deepEqual(asViewer.events.map((e) => e.channel), ['config:changed'],
      'a viewer never receives commands, which carry real config values');
    assert.equal(asViewer.cursor, asController.cursor,
      'the cursor still advances past a withheld event, so a viewer does not retry forever');
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

// ---------- What a remote editor may NOT do (docs/design/06 §4) ----------
// `control` is "may edit the lineup", not "is the administrator". The gate is
// keyed on `remote`, so the Electron window keeps all of these.

test('a remote client cannot touch plugin permissions, network, updates or the PIN lock', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const forbidden = [
      { type: 'plugin.setApproval', id: 'weather', signature: 'granted-from-afar' },
      { type: 'plugin.setEnabled', id: 'weather', enabled: true },
      { type: 'plugin.forget', id: 'weather' },
      { type: 'settings.set', path: ['network', 'viewerEnabled'], value: false },
      { type: 'settings.set', path: ['updates', 'strategy'], value: 'startup-auto' },
      { type: 'settings.set', path: ['pinLock', 'enabled'], value: false },
      { type: 'config.patch', ops: [{ p: ['theme'], v: 'x' }], undo: [{ p: ['theme'], v: 'y' }] },
    ];
    for (const command of forbidden) {
      const response = await postCommands(ctx.port, token, {
        commands: [command], id: `forbid-${command.type}-${Math.random()}`, baseRevision: ctx.host.getRevision(), client: 'ipad',
      });
      assert.equal(response.status, 409, command.type);
      assert.equal(response.json().reason, 'forbidden', command.type);
    }
    assert.equal(ctx.host.getRevision(), 0, 'not one of them was applied');
    assert.deepEqual(JSON.parse(ctx.disk.raw).plugins.disabled, []);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a forbidden command in a batch refuses the whole batch', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const response = await postCommands(ctx.port, token, {
      commands: [
        { type: 'channel.rename', channel: 5, name: 'Harmless' },
        { type: 'plugin.setApproval', id: 'weather', signature: 'sneaked-in' },
      ],
      id: 'mixed', baseRevision: 0, client: 'ipad',
    });
    assert.equal(response.status, 409);
    assert.equal(response.json().reason, 'forbidden');
    assert.equal(JSON.parse(ctx.disk.raw).channels[0].name, 'Rewind', 'the harmless half did not slip through');
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('the host window keeps every one of those, because it is not remote', async () => {
  const ctx = await startTestHost();
  try {
    // origin 'client' but no remote flag: the Electron renderer.
    const result = await ctx.host.applyCommands(
      [{ type: 'settings.set', path: ['network', 'viewerEnabled'], value: false }],
      { origin: 'client', client: 'electron', id: 'desktop-1', baseRevision: 0 },
    );
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(ctx.disk.raw).network.viewerEnabled, false);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

// ---------- Host folder browsing (docs/design/06 §5) ----------

test('browsing is confined to the roots the host shares', async () => {
  const path = require('node:path');
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const shared = path.join(__dirname, 'ui', 'fixtures');
    // Declared by the person at the host; a remote client cannot add one
    // (settings.set on `network` is in the remote-denied list above).
    const config = JSON.parse(ctx.disk.raw);
    config.network = { ...(config.network || {}), controlBrowseRoots: [shared] };
    ctx.disk.raw = JSON.stringify(config);

    const top = (await request(ctx.port, '/api/control/browse?kind=folder', { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(top.roots.includes(shared), 'a root the person at the host declared');
    assert.ok(top.roots.includes(path.dirname(JSON.parse(ctx.disk.raw).channels[0].path)),
      "and the directory this config's own media already lives in");
    assert.equal(top.path, null, 'the top level is the roots, not a filesystem root');

    const inside = (await request(ctx.port, `/api/control/browse?kind=image&path=${encodeURIComponent(shared)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    assert.ok(inside.entries.some((entry) => entry.name.endsWith('.png')), 'it lists the images it was asked for');
    assert.equal(inside.parent, null, 'there is no way up out of a root');

    for (const escape of [path.join(shared, '..'), path.join(shared, '..', '..'), 'C:\\Windows', '/etc']) {
      const refused = await request(ctx.port, `/api/control/browse?path=${encodeURIComponent(escape)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(refused.status, 400, escape);
      assert.match(refused.json().error, /not one this host shares/, escape);
    }
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('a view session cannot browse or scan the host at all', async () => {
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.view);
    for (const route of ['/api/control/browse', '/api/control/scan?path=C:\\']) {
      const response = await request(ctx.port, route, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 403, route);
    }
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});

test('scanning re-checks the folder against the roots rather than trusting the client', async () => {
  const path = require('node:path');
  const ctx = await startTestHost();
  try {
    const { token } = await pair(ctx.port, ctx.access.pairingCodes.control);
    const outside = path.join(__dirname, '..', 'main');
    const refused = await request(ctx.port, `/api/control/scan?path=${encodeURIComponent(outside)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(refused.status, 400, 'a folder that was never listed cannot be scanned');
    assert.match(refused.json().error, /not one this host shares/);
  } finally {
    await new Promise((resolve) => ctx.runtime.server.close(resolve));
  }
});
