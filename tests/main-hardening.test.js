// Main-process hardening: atomic writes, path containment, body limits, range
// parsing, remote command denial, plugin sandbox arguments, LAN session TTLs,
// credential redaction, CSRF headers and the other small pure pieces behind them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const root = path.join(__dirname, '..');
const mainFile = (...parts) => path.join(root, 'main', ...parts);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-main-'));
}

// ---------- atomic-write ----------

test('atomicWriteFileSync replaces a file and leaves no temp files behind', () => {
  const { atomicWriteFileSync, atomicWriteJsonSync } = require(mainFile('util', 'atomic-write.js'));
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  atomicWriteFileSync(file, 'one');
  atomicWriteFileSync(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  atomicWriteJsonSync(path.join(dir, 'nested', 'x.json'), { a: 1 }, { mkdir: true, space: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'nested', 'x.json'), 'utf8')), { a: 1 });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteFile (async) serializes concurrent writers without corrupting the target', async () => {
  const { atomicWriteFile } = require(mainFile('util', 'atomic-write.js'));
  const dir = tempDir();
  const file = path.join(dir, 'cache.json');
  await Promise.all(Array.from({ length: 12 }, (_, i) => atomicWriteFile(file, JSON.stringify({ i, pad: 'x'.repeat(2000) }))));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Number.isInteger(parsed.i), 'a complete document from one of the writers');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed atomic write cleans its temp file and keeps the original', async () => {
  const { atomicWriteFileSync, atomicWriteFile } = require(mainFile('util', 'atomic-write.js'));
  const dir = tempDir();
  const target = path.join(dir, 'is-a-directory');
  fs.mkdirSync(target);
  assert.throws(() => atomicWriteFileSync(target, 'data'));
  await assert.rejects(() => atomicWriteFile(target, 'data'));
  assert.deepEqual(fs.readdirSync(dir), ['is-a-directory']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- isPathContained ----------

test('isPathContained handles siblings, roots, separators and the base itself', () => {
  const { isPathContained } = require(mainFile('util', 'path-safety.js'));
  const base = path.resolve(path.join(path.sep, 'srv', 'plugins'));
  assert.equal(isPathContained(base, base), true);
  assert.equal(isPathContained(base, path.join(base, 'a', 'b.js')), true);
  assert.equal(isPathContained(base, `${base}-evil`), false, 'a sibling that merely shares the prefix');
  assert.equal(isPathContained(base, path.join(base, '..', 'plugins2', 'x')), false);
  assert.equal(isPathContained(base, path.resolve(base, '..')), false);
  const fsRoot = path.parse(base).root;
  assert.equal(isPathContained(fsRoot, path.join(fsRoot, 'anything')), true, 'a filesystem root contains its children');
  assert.equal(isPathContained(`${base}${path.sep}`, path.join(base, 'x')), true, 'a base with a trailing separator');
});

// ---------- readJsonBody ----------

function fakeRequest(chunks) {
  const req = Readable.from(chunks.map((c) => Buffer.from(c)), { objectMode: false });
  req.destroy = () => { req.destroyed = true; };
  return req;
}

test('readJsonBody parses a small body and rejects one past the limit', async () => {
  const { readJsonBody, MAX_JSON_BODY_BYTES } = require(mainFile('util', 'http.js'));
  assert.deepEqual(await readJsonBody(fakeRequest(['{"a":', '1}'])), { a: 1 });
  assert.deepEqual(await readJsonBody(fakeRequest([])), {}, 'an empty body is an empty object');
  const huge = fakeRequest(['{"pad":"', 'x'.repeat(MAX_JSON_BODY_BYTES + 10), '"}']);
  await assert.rejects(() => readJsonBody(huge), /too large/);
  await assert.rejects(() => readJsonBody(fakeRequest(['{not json'])));
});

// ---------- Range parsing ----------

test('parseRangeHeader understands suffix ranges and flags malformed ones', () => {
  const { parseRangeHeader, resolveProviderRange } = require(mainFile('media', 'protocol.js'));
  const suffix = parseRangeHeader('bytes=-500');
  assert.deepEqual(suffix.match.slice(1, 3), ['', '500']);
  assert.equal(parseRangeHeader('bytes=oops').malformed, true);
  assert.equal(parseRangeHeader('').match, null);

  assert.deepEqual(resolveProviderRange(null, NaN), { start: 0, endRequested: null });
  assert.deepEqual(resolveProviderRange(suffix.match, NaN), { suffixNeedsTotal: true }, 'a suffix needs the total size');
  assert.deepEqual(resolveProviderRange(suffix.match, 10000), { start: 9500, endRequested: 9999 });
  assert.deepEqual(resolveProviderRange(suffix.match, 100), { start: 0, endRequested: 99 }, 'a suffix longer than the file is the whole file');
  assert.equal(resolveProviderRange(parseRangeHeader('bytes=-0').match, 100).invalid, true);
  assert.equal(resolveProviderRange(parseRangeHeader('bytes=9-3').match, 100).invalid, true);
  assert.equal(resolveProviderRange(parseRangeHeader('bytes=500-').match, 100).invalid, true, 'start past the end');
  assert.deepEqual(resolveProviderRange(parseRangeHeader('bytes=10-').match, NaN), { start: 10, endRequested: null });
});

// ---------- remote command denial ----------

test('remoteDenial blocks administration commands and whole-section settings writes', () => {
  const { remoteDenial } = require(mainFile('config', 'host.js'));
  for (const type of ['plugin.setApproval', 'plugin.setEnabled', 'plugin.forget', 'plugin.setSettings', 'config.patch']) {
    assert.ok(remoteDenial({ type }), type);
  }
  for (const section of ['network', 'updates', 'pinLock', 'pcPower']) {
    assert.ok(remoteDenial({ type: 'settings.set', path: [section, 'x'], value: 1 }), section);
  }
  assert.equal(remoteDenial({ type: 'channel.rename', channel: 5, name: 'x' }), null);
  assert.equal(remoteDenial({ type: 'settings.set', path: ['theme'], value: 'x' }), null);
  assert.equal(remoteDenial(null), null);
  assert.equal(remoteDenial({}), null);
});

// ---------- saves ----------

test('reconcileSave refuses things that are not a lineup, and an unreadable-config stand-in', async () => {
  const { createConfigHost } = require(mainFile('config', 'host.js'));
  let saved = 0;
  const host = createConfigHost({ load: () => ({ channels: [] }), save: () => { saved += 1; }, loadCommands: async () => ({}) });
  for (const bad of [null, [], 'text', {}, { channels: 'nope' }]) {
    const result = await host.reconcileSave(bad, undefined);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.reason, 'invalid');
  }
  const stub = await host.reconcileSave({ channels: [], _configLoadError: true }, undefined);
  assert.equal(stub.reason, 'unreadable');
  assert.equal(saved, 0, 'nothing was written');
  const ok = await host.reconcileSave({ channels: [] }, undefined);
  assert.equal(ok.ok, true, 'an empty first-run lineup is still a lineup');
  assert.equal(saved, 1);
});

test('library-sync and curation run stamps do not make viewers refetch', () => {
  const { viewerRelevantKey } = require(mainFile('config', 'host.js'));
  const hash = (text) => text;
  const a = { channels: [], librarySync: { enabled: true, lastRunAt: 'a', lastReason: 'x', lastSummary: { n: 1 } }, curationProfiles: [{ id: 1, lastRunAt: 1 }] };
  const b = { channels: [], librarySync: { enabled: true, lastRunAt: 'b', lastReason: 'y', lastSummary: { n: 2 } }, curationProfiles: [{ id: 1, lastRunAt: 2 }] };
  assert.equal(viewerRelevantKey(a, hash), viewerRelevantKey(b, hash));
  const c = { ...b, librarySync: { enabled: false, lastRunAt: 'b' } };
  assert.notEqual(viewerRelevantKey(a, hash), viewerRelevantKey(c, hash), 'a real setting still counts');
});

test('a sharp channel-count drop is recognised, ordinary edits are not', () => {
  const { isSharpChannelDrop } = require(mainFile('config', 'config.js'));
  assert.equal(isSharpChannelDrop(40, 3), true);
  assert.equal(isSharpChannelDrop(40, 20), true);
  assert.equal(isSharpChannelDrop(40, 39), false);
  assert.equal(isSharpChannelDrop(3, 0), false, 'a tiny lineup is not worth a forced snapshot');
  assert.equal(isSharpChannelDrop(null, 0), false);
});

test('the pre-update backup skips caches, credentials and huge files', () => {
  const { shouldSkipFromUpdateBackup } = require(mainFile('config', 'config.js'));
  const dir = (name) => ({ isDirectory: () => true, isFile: () => false, size: 0, name });
  const file = (size = 10) => ({ isDirectory: () => false, isFile: () => true, size });
  for (const name of ['cache', 'Cache', 'thumb-cache', 'cache-v2', 'tmp', 'node_modules']) {
    assert.equal(shouldSkipFromUpdateBackup(path.join('plugins', name), dir(name)), true, name);
  }
  for (const name of ['party', 'archive-media', 'backups']) {
    assert.equal(shouldSkipFromUpdateBackup(path.join('x', name), dir(name)), false, name);
  }
  for (const name of ['token.json', 'oauth-credentials.json', 'client_secret.json', 'id.pem', 'api-key.txt']) {
    assert.equal(shouldSkipFromUpdateBackup(path.join('x', name), file()), true, name);
  }
  assert.equal(shouldSkipFromUpdateBackup(path.join('x', 'settings.json'), file()), false);
  assert.equal(shouldSkipFromUpdateBackup(path.join('x', 'big.bin'), file(300 * 1024 * 1024)), true);
});

// ---------- plugin sandbox arguments ----------

test('buildExecArgv grants only absolute, comma-free folders', () => {
  const { buildExecArgv } = require(mainFile('plugins', 'isolation.js'));
  const app = path.resolve('app');
  const pluginDir = path.resolve('plugins', 'p');
  const good = path.resolve('music');
  const args = buildExecArgv({ capabilities: { spawn: [] } }, app, pluginDir, null, [], [good, `${good},evil`, 'relative/dir', '', null]);
  const read = args.find((arg) => arg.startsWith('--allow-fs-read='));
  const write = args.find((arg) => arg.startsWith('--allow-fs-write='));
  assert.ok(read.includes(good));
  assert.ok(!read.includes('evil'), 'a comma would split into a second grant');
  assert.ok(!read.includes('relative'));
  assert.equal(write, `--allow-fs-write=${good}`);
  assert.ok(!args.includes('--allow-child-process'));
  const withSpawn = buildExecArgv({ capabilities: { spawn: [{ bin: 'ffmpeg', why: 'x' }] } }, app, pluginDir, null);
  assert.ok(withSpawn.includes('--allow-child-process'));
});

test('normalizeFallbackIpc keeps only JSON-serialisable answers on string channels', () => {
  const { normalizeFallbackIpc } = require(mainFile('plugins', 'plugins.js'));
  const cyclic = {}; cyclic.self = cyclic;
  assert.deepEqual(normalizeFallbackIpc({ 'a:b': { ok: 1 }, 'c:d': undefined, bad: cyclic }), { 'a:b': { ok: 1 }, 'c:d': null });
  assert.deepEqual(normalizeFallbackIpc(null), {});
  assert.deepEqual(normalizeFallbackIpc([1, 2]), {});
  assert.deepEqual(normalizeFallbackIpc('x'), {});
});

test('an isolated plugin sees its own settings and shared sections, not other plugins or credentials', () => {
  const { isolatedConfigView } = require(mainFile('plugins', 'config-view.js'));
  const config = {
    channels: [{ number: 5, name: 'Rewind', quickAccess: true, files: [{ path: 'C:\\a.mp4' }], apiToken: 'zzz' }],
    ffmpeg: { ffmpegPath: 'C:\\ff.exe' },
    party: { enabled: true, soundboardFolder: 'C:\\sounds', adminPassword: 'hunter2' },
    tmdb: { apiKey: 'SECRET' },
    pinLock: { enabled: true, pin: '1234' },
    pluginSettings: { mine: { tapesDir: 'D:\\tapes', apiKey: 'own-key' }, other: { apiKey: 'theirs' } },
  };
  const view = isolatedConfigView(config, 'mine');
  assert.deepEqual(view.channels, [{ number: 5, name: 'Rewind', quickAccess: true }]);
  assert.equal(view.ffmpeg.ffmpegPath, 'C:\\ff.exe');
  assert.equal(view.party.soundboardFolder, 'C:\\sounds');
  assert.equal(view.party.adminPassword, undefined);
  assert.equal(view.tmdb, undefined);
  assert.equal(view.pinLock, undefined);
  assert.deepEqual(view.pluginSettings, { mine: { tapesDir: 'D:\\tapes', apiKey: 'own-key' } }, 'its own credentials stay its own');
  assert.equal(JSON.stringify(view).includes('theirs'), false);
});

test('shell.openExternal accepts only http, https and mailto links', () => {
  const { isAllowedExternalUrl } = require(mainFile('util', 'fetch-guards.js'));
  for (const ok of ['https://example.com/a?b=1', 'http://example.com', 'mailto:a@example.com']) assert.equal(isAllowedExternalUrl(ok), true, ok);
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'smb://host/share', 'javascript:alert(1)', 'ms-msdt:/id', 'vscode://x', '', 'not a url', null, 42]) {
    assert.equal(isAllowedExternalUrl(bad), false, String(bad));
  }
});

test('credential headers do not follow a redirect to another origin', () => {
  const { optionsForRedirect, stripCredentialHeaders } = require(mainFile('util', 'fetch-guards.js'));
  const opts = { headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'application/json' } };
  assert.deepEqual(optionsForRedirect(opts, 'https://a.example/x', 'https://a.example/y').headers, opts.headers, 'same origin keeps them');
  assert.deepEqual(optionsForRedirect(opts, 'https://a.example/x', 'https://b.example/y').headers, { Accept: 'application/json' });
  assert.deepEqual(stripCredentialHeaders([['cookie', 'a=b'], ['accept', 'x']]), [['accept', 'x']]);
  const headers = stripCredentialHeaders(new Headers({ Authorization: 'x', Accept: 'y' }));
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('accept'), 'y');
});

test('readBodyTextLimited refuses an oversized body, declared or streamed', async () => {
  const { readBodyTextLimited } = require(mainFile('util', 'fetch-guards.js'));
  assert.equal(await readBodyTextLimited(new Response('{"a":1}'), 100), '{"a":1}');
  await assert.rejects(() => readBodyTextLimited(new Response('x'.repeat(500)), 100), /too large/);
  const declared = new Response('hi', { headers: { 'content-length': '999999999' } });
  await assert.rejects(() => readBodyTextLimited(declared, 100), /too large/);
});

// ---------- LAN sessions ----------

function fakeRes() {
  const res = { statusCode: null, headers: {}, body: '', ended: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (code, headers = {}) => { res.statusCode = code; Object.entries(headers).forEach(([k, v]) => { res.headers[k.toLowerCase()] = v; }); return res; };
  res.end = (body = '') => { res.body = String(body); res.ended = true; return res; };
  return res;
}

function fakeReq({ method = 'GET', headers = {}, ip = '192.168.1.9', url = '/' } = {}) {
  return { method, url, headers: { host: 'box.local:8080', ...headers }, socket: { remoteAddress: ip } };
}

async function pairVia(access, code, extra = {}) {
  const req = fakeReq({ headers: { accept: 'application/json', ...extra } });
  const res = fakeRes();
  await access.authorize(req, res, new URL(`http://box.local:8080/?pair=${code}`), 'read');
  return JSON.parse(res.body);
}

test('control sessions expire in 7 days even when the service TTL is 90, and expiresIn says so', async () => {
  const { createLanAccess, CONTROL_SESSION_MAX_AGE_MS } = require(mainFile('lan', 'security.js'));
  const day = 24 * 60 * 60 * 1000;
  const access = createLanAccess('viewer', { scopes: ['view', 'control'], sessionTtlMs: 90 * day });
  const view = await pairVia(access, access.pairingCodes.view);
  const control = await pairVia(access, access.pairingCodes.control);
  assert.equal(view.scope, 'view');
  assert.equal(view.expiresIn, 90 * 24 * 60 * 60);
  assert.equal(control.scope, 'control');
  assert.equal(control.expiresIn, CONTROL_SESSION_MAX_AGE_MS / 1000);
  const listed = access.listSessions();
  const controlRow = listed.find((s) => s.scope === 'control');
  assert.ok(controlRow.expiresAt - controlRow.createdAt <= CONTROL_SESSION_MAX_AGE_MS);
  assert.equal(JSON.stringify(listed).includes(control.token), false, 'a listing never carries a usable token');
});

test('a control session does not slide past its maximum age and can be revoked', async () => {
  const { createLanAccess } = require(mainFile('lan', 'security.js'));
  const access = createLanAccess('viewer', { scopes: ['view', 'control'], sessionTtlMs: 1000, controlSessionMaxAgeMs: 400 });
  const control = await pairVia(access, access.pairingCodes.control);
  const authed = () => fakeReq({ headers: { authorization: `Bearer ${control.token}` } });
  assert.equal(access.scopeOf(authed()), 'control');
  await new Promise((resolve) => setTimeout(resolve, 150));
  await access.authorize(authed(), fakeRes(), new URL('http://box.local:8080/api/x'), 'read'); // would renew a view session
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(access.scopeOf(authed()), '', 'expired at createdAt + max age, not extended by activity');

  const second = await pairVia(access, access.pairingCodes.view);
  assert.equal(access.revokeAll('control'), 0);
  assert.equal(access.revokeAll(), 1);
  assert.equal(access.isAuthenticated(fakeReq({ headers: { authorization: `Bearer ${second.token}` } })), false);
});

test('persisted legacy control sessions are clamped to the new maximum age', () => {
  const { createLanAccess, CONTROL_SESSION_MAX_AGE_MS } = require(mainFile('lan', 'security.js'));
  const dir = tempDir();
  const file = path.join(dir, 'sessions.json');
  const farFuture = Date.now() + 90 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify({ tok: { expiresAt: farFuture, scope: 'control' }, old: farFuture }));
  const access = createLanAccess('viewer', { scopes: ['view', 'control'], sessionsFile: file, sessionTtlMs: 90 * 24 * 60 * 60 * 1000 });
  const rows = access.listSessions();
  const control = rows.find((r) => r.scope === 'control');
  assert.ok(control.expiresAt <= Date.now() + CONTROL_SESSION_MAX_AGE_MS + 1000);
  assert.equal(rows.find((r) => r.scope === 'view').expiresAt, farFuture, 'a view session keeps its TTL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every mutating request must be same-origin; JSON is required where the route says so', async () => {
  const { createLanAccess, originMatchesHost, hasJsonContentType, hasMultipartContentType } = require(mainFile('lan', 'security.js'));
  assert.equal(originMatchesHost(fakeReq()), true, 'no Origin: a native client');
  assert.equal(originMatchesHost(fakeReq({ headers: { origin: 'http://box.local:8080' } })), true);
  assert.equal(originMatchesHost(fakeReq({ headers: { origin: 'http://evil.example' } })), false);
  assert.equal(originMatchesHost(fakeReq({ headers: { origin: 'null' } })), false);
  assert.equal(hasJsonContentType(fakeReq({ headers: { 'content-type': 'application/json; charset=utf-8' } })), true);
  assert.equal(hasJsonContentType(fakeReq({ headers: { 'content-type': 'text/plain' } })), false);
  assert.equal(hasJsonContentType(fakeReq({ headers: { 'content-type': 'application/x-www-form-urlencoded' } })), false);
  assert.equal(hasMultipartContentType(fakeReq({ headers: { 'content-type': 'multipart/form-data; boundary=x' } })), true);

  const access = createLanAccess('viewer', { scopes: ['view', 'control'] });
  const cross = fakeRes();
  const passed = await access.authorize(fakeReq({ method: 'POST', headers: { origin: 'http://evil.example' } }), cross, new URL('http://box.local:8080/api/commands'), 'write');
  assert.equal(passed, false);
  assert.equal(cross.statusCode, 403, 'refused before a pairing guess can be spent');

  const json = fakeRes();
  assert.equal(access.requireWriteHeaders(fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' } }), json), true);
  const form = fakeRes();
  assert.equal(access.requireWriteHeaders(fakeReq({ method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } }), form), false);
  const upload = fakeRes();
  assert.equal(access.requireWriteHeaders(fakeReq({ method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } }), upload, { allowMultipart: true }), true);
  const uploadCross = fakeRes();
  assert.equal(access.requireWriteHeaders(fakeReq({ method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'multipart/form-data; boundary=x' } }), uploadCross, { allowMultipart: true }), false, 'multipart is exempt from the type rule, never from Origin');
});

// ---------- viewer-facing redaction and plugin files ----------

test('viewer redaction is word-aware: credentials go, keyMap and friends stay', () => {
  const { isSensitiveKey, sanitizeViewerConfig } = require(mainFile('lan', 'viewer-projection.js'));
  for (const key of ['apiKey', 'licenseKey', 'password', 'passcode', 'webhookUrl', 'sessionToken', 'Authorization', 'client_secret', 'pinLock', 'cookie', 'pass']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ['keyMap', 'quickAccess', 'bypass', 'arrowKeys', 'channels', 'volume']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
  const cleaned = sanitizeViewerConfig({
    keyMap: { a: 1 },
    pluginSettings: { x: { harmless: 'sk-abcdefghijklmnopqrstuvwxyz', name: 'Living room', path: 'D:/x/y.mp4' } },
  });
  assert.deepEqual(cleaned, { keyMap: { a: 1 }, pluginSettings: { x: { name: 'Living room', path: 'D:/x/y.mp4' } } });
});

test('the viewer plugin list carries only what its loader reads', () => {
  const { projectPluginForViewer } = require(mainFile('lan', 'plugin-files.js'));
  const row = projectPluginForViewer({
    id: 'p', name: 'P', version: '1', description: 'd', dir: 'p', renderer: 'renderer.js', style: 's.css', settings: 'settings.js',
    main: 'main.js', dataDir: 'secret-data', userPaths: 'x', capabilities: { net: [{ port: 1 }] }, integrityHash: 'abc', loadError: 'C:\\secret\\path: boom',
  });
  assert.equal(row.main, undefined);
  assert.equal(row.dataDir, undefined);
  assert.equal(row.capabilities, undefined);
  assert.equal(row.integrityHash, undefined);
  assert.equal(row.loadError.includes('secret'), false);
  assert.equal(row.renderer, 'renderer.js');
  assert.equal(projectPluginForViewer({ dir: 'broken', error: 'x'.repeat(500) }).error.length, 160);
});

test('LAN plugin files: browser-side assets only, never the main entry or hidden files', () => {
  const { resolveViewerPluginFile } = require(mainFile('lan', 'plugin-files.js'));
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'p', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p', 'manifest.json'), JSON.stringify({ id: 'p', main: 'main.js', renderer: 'renderer.js' }));
  ['main.js', 'renderer.js', 'lib/helper.mjs', 'style.css', 'logo.png', 'notes.exe'].forEach((name) => fs.writeFileSync(path.join(dir, 'p', name), 'x'));
  assert.ok(resolveViewerPluginFile(dir, 'p/renderer.js'));
  assert.ok(resolveViewerPluginFile(dir, 'p/lib/helper.mjs'));
  assert.ok(resolveViewerPluginFile(dir, 'p/logo.png'));
  assert.equal(resolveViewerPluginFile(dir, 'p/main.js'), null, 'the manifest-declared main entry');
  assert.equal(resolveViewerPluginFile(dir, 'p/./main.js'), null);
  assert.equal(resolveViewerPluginFile(dir, 'p/lib/../main.js'), null, 'dot segments are refused outright');
  assert.equal(resolveViewerPluginFile(dir, 'p/notes.exe'), null, 'not a web asset');
  assert.equal(resolveViewerPluginFile(dir, 'p/.secret.json'), null);
  assert.equal(resolveViewerPluginFile(dir, 'p/node_modules/x.js'), null);
  assert.equal(resolveViewerPluginFile(dir, '../outside.js'), null);
  assert.equal(resolveViewerPluginFile(dir, 'p'), null, 'a folder alone is not a file');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- folder browsing roots ----------

test('browse roots come from folder and file keys without touching the disk, and honour the allow-list', () => {
  const { browseRoots, rootsFromConfig } = require(mainFile('lan', 'control-browse.js'));
  const base = path.resolve(path.sep, 'media');
  const config = {
    title: path.join(base, 'not-a-root-just-a-title'),
    channels: [
      { number: 1, folders: [path.join(base, 'shows')], files: [{ path: path.join(base, 'loose', 'a.mp4') }] },
      { number: 2, note: path.join(base, 'ignored') },
    ],
  };
  const derived = [...rootsFromConfig(config)].sort();
  assert.deepEqual(derived, [path.join(base, 'loose'), path.join(base, 'shows')].sort());
  assert.deepEqual(browseRoots(config), derived);

  const allowed = path.join(base, 'shows');
  config.network = { controlBrowseRoots: [allowed, 'relative/is/ignored'] };
  assert.deepEqual(browseRoots(config), [allowed], 'only the declared tree: the loose-files directory is not offered');
});

// ---------- uploads ----------

test('uploaded images are verified by their bytes, not their declared type', () => {
  const { sniffImageExt } = require(mainFile('lan', 'asset-upload.js'));
  const pad = (buf) => Buffer.concat([buf, Buffer.alloc(16)]);
  assert.equal(sniffImageExt(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))), '.png');
  assert.equal(sniffImageExt(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), '.jpg');
  assert.equal(sniffImageExt(pad(Buffer.from('GIF89a'))), '.gif');
  assert.equal(sniffImageExt(pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))), '.webp');
  assert.equal(sniffImageExt(pad(Buffer.from('<html><script>'))), null);
  assert.equal(sniffImageExt(pad(Buffer.from('MZ\x90\x00'))), null);
  assert.equal(sniffImageExt(Buffer.from('short')), null);
});

// ---------- diagnostics ----------

test('diagnostics scrub pairing codes and tokens from URLs, including in the log ring', () => {
  const diagnostics = require(mainFile('diagnostics', 'diagnostics.js'));
  const line = 'Watch at http://192.168.1.2:8080/?pair=12345678&x=1 then ?token=abc&key=def';
  const out = diagnostics.redactString(line, []);
  assert.equal(out.includes('12345678'), false);
  assert.equal(out.includes('abc'), false);
  assert.ok(out.includes('x=1'), 'unrelated parameters survive');
  diagnostics.recordDiagnostic('t', 'log', 'open http://a/?pair=99999999');
  assert.equal(diagnostics.getMainLogs().some((entry) => entry.message.includes('99999999')), false);
});

// ---------- updater ----------

test('theme colour reports keep only known variables with safe values', () => {
  const { sanitizeThemeColors } = require(mainFile('updater', 'updater.js'));
  const cleaned = sanitizeThemeColors({
    '--ink': '#112233',
    '--gold': 'red; } body { display:none',
    '--cyan': 'url(http://evil/x.png)',
    '--paper': '<script>',
    '--gradient-page': 'linear-gradient(180deg, #000, #111)',
    '--bogus': '#fff',
  });
  assert.deepEqual(cleaned, { '--ink': '#112233', '--gradient-page': 'linear-gradient(180deg, #000, #111)' });
  assert.equal(sanitizeThemeColors('nope'), null);
  assert.equal(sanitizeThemeColors([]), null);
  assert.equal(sanitizeThemeColors({}), null);
});

// ---------- ffmpeg install ----------

test('ffmpeg downloads are verified against a published SHA-256 when there is one', async () => {
  const { parseSha256, sha256Hex, verifyDownload } = require(mainFile('media', 'ffmpeg-install.js'));
  const buffer = Buffer.from('zip bytes');
  const digest = sha256Hex(buffer);
  assert.equal(parseSha256(`${digest.toUpperCase()}  ffmpeg.zip\n`), digest);
  assert.equal(parseSha256('not a digest'), null);
  const serving = (text, ok = true) => async () => ({ ok, text: async () => text });
  assert.deepEqual(await verifyDownload(buffer, 'https://x/y.sha256', serving(`${digest} *ffmpeg.zip`)), { verified: true });
  await assert.rejects(() => verifyDownload(buffer, 'https://x/y.sha256', serving('0'.repeat(64))), /checksum/);
  assert.equal((await verifyDownload(buffer, 'https://x/y.sha256', serving('', false))).verified, false, 'an unreachable checksum file does not block the install');
  assert.equal((await verifyDownload(buffer, null)).verified, false);
});
