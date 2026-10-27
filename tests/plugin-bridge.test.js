// The generic plugin bridge (main/plugins/bridge.js), the internet capability
// and its in-process guard (capabilities.js, net-guard.js), and the
// plain-language permission summary (renderer/js/plugin/permissions.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const bridge = require('../main/plugins/bridge.js');
const caps = require('../main/plugins/capabilities.js');
const { connectTarget, udpTarget, createActivityBatcher } = require('../main/plugins/net-guard.js');

test('a call reaches only the handler its own plugin registered', async () => {
  bridge.resetForTests();
  bridge.registerPluginHandler('demo', 'demo:search', async (event, args) => ({ echo: args }));
  assert.deepEqual(await bridge.invoke(null, 'demo', 'demo:search', [{ q: 'jazz' }]), { echo: [{ q: 'jazz' }] });
  // Another plugin naming the same channel is refused.
  await assert.rejects(bridge.invoke(null, 'evil', 'demo:search', []), /no approved, running handler/);
  await assert.rejects(bridge.invoke(null, 'demo', 'demo:undeclared', []), /no approved, running handler/);
  await assert.rejects(bridge.invoke(null, '', 'demo:search', []), /needs a plugin id/);
  const activity = bridge.getActivity('demo');
  assert.equal(activity.calls, 1);
  assert.equal(activity.refused, 1);
  assert.equal(bridge.getActivity('evil').refused, 1);
});

test('an inactive plugin answers with its fallback value, and an exited one stops answering', async () => {
  bridge.resetForTests();
  bridge.registerPluginFallback('demo', 'demo:tune', { error: 'off' });
  const reply = await bridge.invoke(null, 'demo', 'demo:tune', []);
  assert.deepEqual(reply, { error: 'off' });
  reply.error = 'mutated';
  assert.deepEqual(await bridge.invoke(null, 'demo', 'demo:tune', []), { error: 'off' }, 'each answer is a copy');
  bridge.registerPluginHandler('demo', 'demo:stop', async () => true);
  bridge.unregisterPlugin('demo');
  await assert.rejects(bridge.invoke(null, 'demo', 'demo:stop', []));
});

test('network activity is recorded per plugin and blocked hosts are returned for logging', () => {
  bridge.resetForTests();
  const blocked = bridge.recordNetwork('demo', [
    { host: 'de1.api.directory.example.org', allowed: true, count: 3 },
    { host: 'evil.example', allowed: false, count: 1 },
  ]);
  bridge.recordNetwork('demo', [{ host: 'de1.api.directory.example.org', allowed: true, count: 2 }, null, { host: 5 }]);
  assert.deepEqual(blocked, ['evil.example']);
  const a = bridge.getActivity('demo');
  assert.deepEqual(a.hosts.map((h) => [h.host, h.count]), [['de1.api.directory.example.org', 5]]);
  assert.deepEqual(a.blocked.map((h) => [h.host, h.count]), [['evil.example', 1]]);
});

test('the internet capability is optional and leaves existing approval signatures alone', () => {
  const before = caps.normalizeCapabilities({ ipc: [{ channel: 'a:b', why: 'x' }] });
  assert.equal('internet' in before, false);
  assert.equal(caps.capabilitiesSignature(before), '{"ipc":[{"channel":"a:b","why":"x"}],"spawn":[],"net":[],"mediaSource":[],"system":[]}');
  const withNet = caps.normalizeCapabilities({
    internet: [
      { host: '*.API.Directory.Example.ORG', why: 'search' },
      { host: 'https://bad.example/path', why: 'dropped' },
      { host: 'no-why.example' },
      { host: '*', why: 'stations' },
    ],
  });
  assert.deepEqual(withNet.internet.map((e) => e.host), ['*.api.directory.example.org', '*']);
  assert.deepEqual(caps.allowedSetsFor(before).allowedHosts, null);
});

test('host matching: exact names, wildcard domains (apex included), and anywhere', () => {
  const pats = ['*.api.directory.example.org', 'covers.example.net'];
  assert.ok(caps.hostAllowed('de1.api.directory.example.org', pats));
  assert.ok(caps.hostAllowed('API.directory.example.org.', pats));
  assert.ok(caps.hostAllowed('covers.example.net', pats));
  assert.ok(!caps.hostAllowed('evilapi.directory.example.org', pats));
  assert.ok(!caps.hostAllowed('example.net', pats));
  assert.ok(!caps.hostAllowed('127.0.0.1', pats));
  assert.ok(caps.hostAllowed('anything.example', ['*']));
  assert.equal(caps.isValidHostPattern('::1'), false, 'IPv6 literals are not valid patterns, so never declared');
  assert.equal(caps.isValidHostPattern('a.example:443'), false);
});

test('the guard reads every net.Socket#connect argument shape', () => {
  assert.deepEqual(connectTarget([{ host: 'a.example', port: 443 }]), { host: 'a.example' });
  assert.deepEqual(connectTarget([[{ host: 'b.example', port: 80 }, () => {}]]), { host: 'b.example' });
  assert.deepEqual(connectTarget([80, 'c.example']), { host: 'c.example' });
  assert.deepEqual(connectTarget([80]), { host: 'localhost' });
  assert.deepEqual(connectTarget([{ port: 80 }]), { host: 'localhost' });
  assert.deepEqual(connectTarget(['\\\\.\\pipe\\x']), { pipe: true });
  assert.deepEqual(connectTarget([{ path: '/tmp/s' }]), { pipe: true });
  assert.equal(udpTarget(['hello', 5353, '224.0.0.251'], 1), '224.0.0.251');
  assert.equal(udpTarget([Buffer.from('x'), 0, 1, 5353, 'host.example'], 1), 'host.example');
});

test('the activity batcher sends blocked attempts at once and groups the rest', async () => {
  const batches = [];
  const note = createActivityBatcher((b) => batches.push(b), 20);
  note('a.example', true);
  note('a.example', true);
  note('bad.example', false);
  assert.equal(batches.length, 1, 'a block flushes immediately, taking pending allowed ones with it');
  assert.deepEqual(batches[0].map((e) => [e.host, e.allowed, e.count]), [['a.example', true, 2], ['bad.example', false, 1]]);
  note('b.example', true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(batches[1].map((e) => e.host), ['b.example']);
});

// Run in a child process: installing the guard locks net.Socket.prototype
// for the rest of that process, which this test runner must not inherit.
test('an installed guard blocks undeclared hosts for net, http and fetch, and can\'t be undone', () => {
  const script = `
    const http = require('http');
    const net = require('net');
    const { installNetGuard } = require(${JSON.stringify(path.join(ROOT, 'main', 'plugins', 'net-guard.js'))});
    const seen = [];
    const server = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      installNetGuard({ pluginId: 't', patterns: ['127.0.0.1'], onActivity: (h, ok) => seen.push(h + ':' + ok) });
      const out = {};
      out.allowed = await new Promise((r) => http.get('http://127.0.0.1:' + port, (res) => { res.resume(); r(res.statusCode); }).on('error', (e) => r(e.code)));
      out.httpBlocked = await new Promise((r) => http.get('http://localhost:' + port, () => r('connected')).on('error', (e) => r(e.code)));
      out.netBlocked = await new Promise((r) => net.connect(port, 'localhost').on('connect', () => r('connected')).on('error', (e) => r(e.code)));
      try { await fetch('http://localhost:' + port); out.fetchBlocked = 'connected'; } catch (e) { out.fetchBlocked = (e.cause && e.cause.code) || e.message; }
      try { net.Socket.prototype.connect = () => 'bypassed'; } catch (e) { /* strict mode only */ }
      out.relocked = net.Socket.prototype.connect.name;
      out.seen = seen;
      server.close();
      process.stdout.write(JSON.stringify(out));
    });`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 }));
  assert.equal(out.allowed, 200);
  assert.equal(out.httpBlocked, 'ERR_PLUGIN_HOST_NOT_ALLOWED');
  assert.equal(out.netBlocked, 'ERR_PLUGIN_HOST_NOT_ALLOWED');
  assert.equal(out.fetchBlocked, 'ERR_PLUGIN_HOST_NOT_ALLOWED');
  assert.equal(out.relocked, 'guardedConnect', 'reassigning the patched method has no effect');
  assert.ok(out.seen.includes('127.0.0.1:true') && out.seen.includes('localhost:false'), out.seen.join(','));
});

async function permissions() {
  return import(pathToFileURL(path.join(ROOT, 'renderer', 'js', 'plugin', 'permissions.js')).href);
}

test('the permission summary says plainly where a plugin runs and what it can reach', async () => {
  const { describePermissions } = await permissions();
  const sandboxed = describePermissions({
    main: 'main.js', isolated: true, renderer: 'renderer.js', dataDir: null, integrityStatus: 'verified', integrityHash: 'abcdef0123456789',
    capabilities: {
      ipc: [{ channel: 'demo:search', why: 'search' }], spawn: [], net: [{ port: 8733, why: 'relay' }], mediaSource: [], system: [],
      internet: [{ host: '*.api.directory.example.org', why: 'directory' }, { host: '*', why: 'its streams' }],
    },
  });
  const byId = Object.fromEntries(sandboxed.sections.map((s) => [s.id, s]));
  assert.equal(sandboxed.fullAccess, false);
  assert.equal(byId.where.tone, 'ok');
  assert.equal(byId.screen.tone, 'warn');
  assert.equal(byId.internet.heading, 'Internet: any site');
  assert.ok(byId.internet.lines.some((l) => l.text === 'api.directory.example.org and its subdomains' && l.why === 'directory'));
  assert.match(byId.files.lines[0].text, /can.t save any/);
  assert.match(byId.origin.lines[0].text, /abcdef012345/);
  assert.ok(sandboxed.technical.some((t) => t.includes('demo:search')));

  const undeclared = describePermissions({ main: 'main.js', isolated: true, capabilities: {}, integrityStatus: 'bundled' });
  assert.equal(undeclared.sections.find((s) => s.id === 'internet').tone, 'warn');

  const full = describePermissions({ main: 'main.js', isolated: false, capabilities: {}, integrityStatus: 'unverified', integrityHash: 'x' });
  assert.equal(full.fullAccess, true);
  assert.equal(full.sections.find((s) => s.id === 'where').tone, 'danger');
  assert.equal(full.sections.find((s) => s.id === 'internet'), undefined, 'full access already covers it');
});

test('activity is described honestly, including when it is not watched', async () => {
  const { describeActivity } = await permissions();
  const watched = describeActivity({ main: 'm', isolated: true }, {
    calls: 2, refused: 1, hosts: [{ host: 'a.example', count: 4 }], blocked: [{ host: 'b.example', count: 1 }],
  });
  assert.deepEqual(watched.map((l) => l.tone), ['ok', 'warn', 'ok', 'danger']);
  assert.match(watched[3].text, /b\.example \(1\)/);
  const unwatched = describeActivity({ main: 'm', isolated: false }, null);
  assert.ok(unwatched.some((l) => /aren.t watched/.test(l.text)));
});
