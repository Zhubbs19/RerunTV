// The companion app's full-control routes (plugins/companion-app): reading and
// driving the box's screen (/api/ui), the schedule calendar (/api/calendar),
// remote buttons by name (POST /command { remote }) and the renderer question
// broker they share. The plugin's real request handler is driven through a
// fake server, so nothing binds a port (the installed app owns 8725).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const { calendarCommands, blocksForPhone, cleanTrigger } = require('../plugins/companion-app/calendar-ops');
const { createControlRoutes, createQueryBroker, cleanUiAction } = require('../plugins/companion-app/control-routes');
const { createConfigHost } = require('../main/config/host');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.document = globalThis.document || { getElementById: () => null };
const commandsUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', 'commands.js')).href;

// ---------- Fakes ----------

function fakeReq(method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { host: 'box.test', ...headers }, socket: { remoteAddress: '192.168.1.20' } });
}

function fakeRes() {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const res = {
    status: null, headers: {}, body: '', headersSent: false, done,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; return this; },
    end(text = '') { this.body = String(text); finish(this); return this; },
    json() { return JSON.parse(this.body); },
    destroy() { finish(this); },
  };
  return res;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
}

function sampleConfig() {
  return {
    channels: [{
      number: 5, name: 'Rewind', files: [],
      folders: [{ id: 'f1', source: 'local', ref: path.join(path.sep, 'media', 'rewind'), label: 'Rewind' }],
      blocks: [
        {
          id: 'blk-xmas', name: 'Christmas', priority: 10, mode: 'daily',
          trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 },
          files: [{ path: path.join(path.sep, 'media', 'xmas', 'Day 01.mkv'), duration: 1200 }],
          dayOverrides: {},
        },
      ],
    }],
  };
}

function routesWith(overrides = {}) {
  const calls = { ask: [], apply: [] };
  const config = overrides.config || sampleConfig();
  const handle = createControlRoutes({
    ask: async (kind, args) => { calls.ask.push({ kind, args }); return overrides.ask ? overrides.ask(kind, args) : { kind }; },
    loadConfig: () => config,
    applyCommands: async (batch, meta) => {
      calls.apply.push({ batch, meta });
      return overrides.apply ? overrides.apply(batch, meta) : { ok: true, revision: 8 };
    },
    getRevision: () => 7,
    readJsonBody,
    buildRoots: () => [{ id: '0', label: 'Rewind', path: path.join(path.sep, 'media') }],
    resolveWithinRoot: (root, rel) => (rel.includes('..') ? null : path.join(root.path, rel)),
    isDirectory: (abs) => !abs.endsWith('.mkv'),
    clientFor: () => 'companion:test',
  });
  return { handle, calls, config };
}

async function call(handle, method, url, body) {
  const req = fakeReq(method, url, body);
  const res = fakeRes();
  const handled = await handle(req, res, new URL(url, 'http://box.test'));
  if (handled) await res.done;
  return { handled, res };
}

// ---------- calendar-ops ----------

test('calendar ops become the same block commands the box editors record', () => {
  const config = sampleConfig();
  const out = calendarCommands(config, 5, [
    { op: 'create', fields: { name: ' Game night ', trigger: { type: 'dayOfWeek', startHour: 20, endHour: 23, days: [5, 5, 6] } } },
    { op: 'update', id: 'blk-xmas', fields: { priority: 20, mode: 'weekly' } },
    { op: 'overrideDay', id: 'blk-xmas', key: '12-05', override: { file: config.channels[0].blocks[0].files[0].path, title: 'Snow day', skip: false } },
    { op: 'overrideDay', id: 'blk-xmas', key: '12-06', override: null },
    { op: 'remove', id: 'blk-xmas' },
  ], { makeId: () => 'blk-new' });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.created, ['blk-new']);
  assert.deepEqual(out.commands.map((c) => c.type), ['block.create', 'item.set', 'block.overrideDay', 'block.overrideDay', 'block.remove']);
  const created = out.commands[0].block;
  assert.equal(created.name, 'Game night');
  assert.deepEqual(created.trigger, { type: 'dayOfWeek', startHour: 20, endHour: 23, days: [5, 6] });
  assert.equal(created.priority, 0, 'a weekly block starts at the same priority core gives one');
  assert.deepEqual(created.files, []);
  assert.deepEqual(out.commands[1], { type: 'item.set', collection: 'blocks', channel: 5, id: 'blk-xmas', fields: { priority: 20, mode: 'weekly' } });
  assert.equal(out.commands[2].override.title, 'Snow day');
  assert.equal(out.commands[3].override, null);
});

test('calendar ops refuse what the phone may not set', () => {
  const config = sampleConfig();
  const bad = [
    [{ op: 'update', id: 'blk-xmas', fields: { files: [] } }, 400, /can't be changed/],
    [{ op: 'update', id: 'blk-xmas', fields: { folder: 'C:\\' } }, 400, /can't be changed/],
    [{ op: 'update', id: 'blk-xmas', fields: { mode: 'forever' } }, 400, /Mode/],
    [{ op: 'update', id: 'blk-xmas', fields: { trigger: { type: 'dayOfWeek', startHour: 25, endHour: 2 } } }, 400, /Hours/],
    [{ op: 'create', fields: { name: 'No trigger' } }, 400, /needs a trigger/],
    [{ op: 'remove', id: 'blk-gone' }, 409, /no longer/],
    [{ op: 'overrideDay', id: 'blk-xmas', key: '12-5', override: null }, 400, /MM-DD/],
    [{ op: 'overrideDay', id: 'blk-xmas', key: '12-05', override: { file: '/etc/passwd' } }, 400, /isn't in this block/],
    [{ op: 'overrideDay', id: 'blk-xmas', key: '12-05', override: { unlockTime: 'noon' } }, 400, /HH:MM/],
    [{ op: 'rename' }, 409, /no longer/],
  ];
  for (const [op, status, message] of bad) {
    const out = calendarCommands(config, 5, [op]);
    assert.equal(out.status, status, JSON.stringify(op));
    assert.match(out.error, message);
  }
  assert.equal(calendarCommands(config, 99, [{ op: 'remove', id: 'x' }]).status, 404);
  assert.equal(calendarCommands(config, 5, []).status, 400);
});

test('a date-range trigger keeps only its own fields, including the narrowing', () => {
  assert.deepEqual(cleanTrigger({
    type: 'dateRange', startMonth: 11, startDay: 1, endMonth: 12, endDay: 31, startRule: 'thanksgiving',
    startHour: 18, endHour: 22, days: [], extra: 'dropped',
  }).trigger, { type: 'dateRange', startMonth: 11, startDay: 1, endMonth: 12, endDay: 31, startRule: 'thanksgiving', startHour: 18, endHour: 22 });
  assert.match(cleanTrigger({ type: 'dateRange', startMonth: 13, startDay: 1, endMonth: 1, endDay: 1 }).error, /month/);
  assert.match(cleanTrigger({ type: 'weekly' }).error, /date range or a weekly time/);
});

test('the phone sees every block field it edits, with titles for the file picker', () => {
  const [block] = blocksForPhone(sampleConfig().channels[0]);
  assert.equal(block.id, 'blk-xmas');
  assert.equal(block.fileCount, 1);
  assert.deepEqual(block.files.map((f) => f.title), ['Day 01']);
  assert.equal(block.mode, 'daily');
});

test('calendar commands apply cleanly through core commands and the config host as a remote client', async () => {
  let disk = JSON.stringify(sampleConfig());
  const host = createConfigHost({
    load: () => JSON.parse(disk),
    save: (config) => { disk = JSON.stringify(config); },
    loadCommands: () => import(commandsUrl),
  });
  const config = JSON.parse(disk);
  const { commands } = calendarCommands(config, 5, [
    { op: 'create', fields: { name: 'Game night', trigger: { type: 'dayOfWeek', startHour: 20, endHour: 23, days: [5] } } },
    { op: 'overrideDay', id: 'blk-xmas', key: '12-05', override: { title: 'Snow day' } },
    { op: 'update', id: 'blk-xmas', fields: { name: 'Advent' } },
  ], { makeId: () => 'blk-new' });
  const result = await host.applyCommands(commands, { origin: 'client', remote: true, client: 'companion:test', baseRevision: host.getRevision() });
  assert.equal(result.ok, true, result.message);
  const saved = JSON.parse(disk).channels[0];
  assert.deepEqual(saved.blocks.map((b) => b.id), ['blk-xmas', 'blk-new']);
  assert.equal(saved.blocks[0].name, 'Advent');
  assert.equal(saved.blocks[0].dayOverrides['12-05'].title, 'Snow day');

  // A batch from a phone that missed a newer edit to the same block is refused, not merged.
  const stale = await host.applyCommands(calendarCommands(JSON.parse(disk), 5, [{ op: 'remove', id: 'blk-new' }]).commands, {
    origin: 'client', remote: true, client: 'companion:other', baseRevision: 0,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'conflict');
});

// ---------- Query broker ----------

test('the query broker matches answers to questions and gives up without a renderer', async () => {
  const sent = [];
  const broker = createQueryBroker({ send: (m) => { sent.push(m); return true; }, timeoutMs: 1000 });
  const answer = broker.ask('ui.snapshot', { a: 1 });
  assert.equal(sent[0].action, 'companion-query');
  assert.equal(sent[0].kind, 'ui.snapshot');
  assert.equal(broker.receive({ id: 'nope', ok: true }), false);
  assert.equal(broker.receive({ id: sent[0].id, ok: true, result: { items: [] } }), true);
  assert.deepEqual(await answer, { items: [] });

  const failing = broker.ask('ui.act', {});
  broker.receive({ id: sent[1].id, ok: false, error: 'The screen changed.' });
  await assert.rejects(failing, /The screen changed/);
  assert.equal(broker.pendingCount(), 0);

  const headless = createQueryBroker({ send: () => false });
  assert.equal(await headless.ask('ui.snapshot'), undefined);

  const slow = createQueryBroker({ send: () => true, timeoutMs: 10 });
  await assert.rejects(slow.ask('calendar.month'), (e) => e.status === 504);
});

// ---------- Routes ----------

test('GET /api/ui returns the renderer snapshot, or 503 on a box with no screen', async () => {
  const { handle } = routesWith({ ask: () => ({ id: 3, items: [{ index: 0, label: 'CHANNELS' }] }) });
  const { res } = await call(handle, 'GET', '/api/ui');
  assert.equal(res.status, 200);
  assert.equal(res.json().items[0].label, 'CHANNELS');

  const { handle: headless } = routesWith({ ask: () => undefined });
  assert.equal((await call(headless, 'GET', '/api/ui')).res.status, 503);

  const { handled } = await call(handle, 'GET', '/api/elsewhere');
  assert.equal(handled, false);
});

test('POST /api/ui checks the action before it reaches the screen', async () => {
  const { handle, calls } = routesWith({ ask: (kind, args) => ({ id: 4, acted: args }) });
  const ok = await call(handle, 'POST', '/api/ui', { op: 'set', snapshot: 3, index: 2, value: 'loop' });
  assert.equal(ok.res.status, 200);
  assert.deepEqual(calls.ask[0], { kind: 'ui.act', args: { op: 'set', snapshot: 3, index: 2, value: 'loop' } });

  const typed = await call(handle, 'POST', '/api/ui', { op: 'text', text: 'Saturday morning', submit: true });
  assert.equal(typed.res.status, 200);
  assert.deepEqual(calls.ask[1].args, { op: 'text', text: 'Saturday morning', submit: true });

  for (const body of [{ op: 'click', snapshot: 1, index: 0 }, { op: 'activate' }, { op: 'set', snapshot: 1, index: 0, value: {} }, { op: 'text', text: 5 }]) {
    assert.equal((await call(handle, 'POST', '/api/ui', body)).res.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.ask.length, 2, 'refused actions never reach the renderer');
  assert.deepEqual(cleanUiAction({ op: 'activate', snapshot: 1, index: 0, value: 'ignored' }).args, { op: 'activate', snapshot: 1, index: 0 });
});

test('a renderer refusal comes back to the phone as an error, not a crash', async () => {
  const { handle } = routesWith({ ask: () => { throw Object.assign(new Error('Plug-ins can only be changed on the host.'), { status: 409 }); } });
  const { res } = await call(handle, 'POST', '/api/ui', { op: 'activate', snapshot: 1, index: 0 });
  assert.equal(res.status, 409);
  assert.match(res.json().error, /on the host/);
});

test('GET /api/calendar lists the blocks with the host revision, and the month when the renderer answers', async () => {
  const month = { year: 2026, month: 12, days: [{ day: 1, blockId: 'blk-xmas' }] };
  const { handle, calls } = routesWith({ ask: () => month });
  const { res } = await call(handle, 'GET', '/api/calendar?channel=5&year=2026&month=12');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.revision, 7);
  assert.equal(body.channel.name, 'Rewind');
  assert.deepEqual(body.blocks.map((b) => b.id), ['blk-xmas']);
  assert.deepEqual(body.month, month);
  assert.deepEqual(calls.ask[0], { kind: 'calendar.month', args: { channel: 5, year: 2026, month: 12 } });

  const { handle: headless } = routesWith({ ask: () => undefined });
  const offline = (await call(headless, 'GET', '/api/calendar?channel=5')).res.json();
  assert.equal(offline.month, null, 'a headless box still lists blocks to edit');
  assert.equal(offline.blocks.length, 1);

  assert.equal((await call(handle, 'GET', '/api/calendar?channel=42')).res.status, 404);
});

test('POST /api/calendar applies the commands as this phone, at the revision it read', async () => {
  const { handle, calls } = routesWith();
  const { res } = await call(handle, 'POST', '/api/calendar', {
    channel: 5, baseRevision: 7, id: 'batch-1', ops: [{ op: 'update', id: 'blk-xmas', fields: { name: 'Advent' } }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, revision: 8, created: [] });
  assert.equal(calls.apply[0].batch[0].type, 'item.set');
  assert.deepEqual(calls.apply[0].meta, { source: 'companion', client: 'companion:test', baseRevision: 7, id: 'batch-1' });

  const bad = await call(handle, 'POST', '/api/calendar', { channel: 5, baseRevision: 7, ops: [{ op: 'update', id: 'blk-xmas', fields: { files: [] } }] });
  assert.equal(bad.res.status, 400);
  assert.equal(calls.apply.length, 1, 'an invalid op is never sent to the config host');
});

test('config host refusals map to HTTP statuses the phone can explain', async () => {
  for (const [reason, status] of [['forbidden', 403], ['conflict', 409], ['stale-window', 409], ['invalid', 400]]) {
    const { handle } = routesWith({ apply: () => ({ ok: false, reason, message: `refused: ${reason}` }) });
    const { res } = await call(handle, 'POST', '/api/calendar', { channel: 5, baseRevision: 7, ops: [{ op: 'remove', id: 'blk-xmas' }] });
    assert.equal(res.status, status, reason);
    assert.equal(res.json().reason, reason);
  }
});

test('POST /api/calendar/folder only takes a folder inside a channel root', async () => {
  const { handle, calls } = routesWith({ ask: () => ({ started: true }) });
  const ok = await call(handle, 'POST', '/api/calendar/folder', { channel: 5, blockId: 'blk-xmas', root: '0', path: 'xmas' });
  assert.equal(ok.res.status, 202);
  assert.deepEqual(calls.ask[0], { kind: 'calendar.setFolder', args: { channel: 5, blockId: 'blk-xmas', folder: path.join(path.sep, 'media', 'xmas') } });

  for (const body of [
    { channel: 5, blockId: 'blk-xmas', root: '0', path: '../etc' },
    { channel: 5, blockId: 'blk-xmas', root: '9', path: 'xmas' },
    { channel: 5, blockId: 'blk-xmas', root: '0', path: 'xmas/Day 01.mkv' },
    { channel: 5, root: '0', path: 'xmas' },
  ]) {
    assert.equal((await call(handle, 'POST', '/api/calendar/folder', body)).res.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.ask.length, 1);
});

// ---------- The plugin's own server ----------

async function startPlugin({ withWindow = true } = {}) {
  let handler = null;
  const sent = [];
  const listeners = {};
  const applied = [];
  const webContents = { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) };
  const ctx = {
    ipcMain: { on: (channel, fn) => { listeners[channel] = fn; } },
    createServer: (fn) => { handler = fn; return { on() {}, listen() {} }; },
    getMainWindow: () => (withWindow ? { isDestroyed: () => false, webContents } : null),
    trackConnection() {},
    readJsonBody,
    serveStatic: (dir, pathname, req, res) => res.writeHead(404).end(),
    loadConfig: () => sampleConfig(),
    mimeFor: () => 'application/octet-stream',
    getLanAddresses: () => [],
    createLanAccess: () => ({ authorize: async () => true, pairingUrl: (u) => u }),
    isLanServiceEnabled: () => true,
    getInstalledThemes: () => [],
    getSettingsCatalogue: async () => ({}),
    applyConfigCommands: async (batch, meta) => { applied.push({ batch, meta }); return { ok: true, revision: 2 }; },
    getConfigRevision: () => 1,
    services: {},
    fs: { dataDir: path.join(__dirname, 'no-such-dir') },
  };
  // A fresh copy per test: the module keeps the last pushed state.
  delete require.cache[require.resolve('../plugins/companion-app/main.js')];
  await require('../plugins/companion-app/main.js').activate(ctx);
  const request = async (method, url, body) => {
    const res = fakeRes();
    handler(fakeReq(method, url, body), res);
    await res.done;
    return res;
  };
  return { request, sent, listeners, applied };
}

test('POST /command { remote } relays a known RemoteKey and refuses anything else', async () => {
  const { request, sent } = await startPlugin();
  assert.equal((await request('POST', '/command', { remote: 'ok', long: true })).status, 204);
  assert.deepEqual(sent.at(-1), { channel: 'remote:command', data: { remote: 'ok', long: true } });
  assert.equal((await request('POST', '/command', { remote: 'power' })).status, 400, 'power stays the POWER key, not a remote name');
  assert.equal((await request('POST', '/command', { remote: 'formatDisk' })).status, 400);
  assert.equal(sent.length, 1);
  // The old key relay is unchanged.
  assert.equal((await request('POST', '/command', { key: 'g' })).status, 204);
  assert.deepEqual(sent.at(-1).data, { key: 'g', shift: false, ctrl: false, alt: false });
});

test('GET /state advertises the new features, and a renderer answer never lands in the state', async () => {
  const { request, sent, listeners } = await startPlugin();
  listeners['remote:state']({}, { number: 5, name: 'Rewind' });
  let state = JSON.parse((await request('GET', '/state')).body);
  assert.deepEqual(state.features, ['remote-keys', 'ui', 'calendar']);
  assert.equal(state.number, 5);

  const pending = request('GET', '/api/ui');
  await new Promise((resolve) => setImmediate(resolve));
  const query = sent.find((m) => m.data && m.data.action === 'companion-query');
  assert.ok(query, 'GET /api/ui asks the renderer on remote:command');
  listeners['remote:state']({}, { companionReply: { id: query.data.id, ok: true, result: { id: 1, items: [] } } });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { id: 1, items: [] });
  state = JSON.parse((await request('GET', '/state')).body);
  assert.equal(state.companionReply, undefined);
  assert.equal(state.number, 5);
});

test('the plugin hands calendar edits to the config host and the UI routes say when there is no screen', async () => {
  const { request, applied } = await startPlugin({ withWindow: false });
  const res = await request('POST', '/api/calendar', { channel: 5, baseRevision: 1, ops: [{ op: 'remove', id: 'blk-xmas' }] });
  assert.equal(res.status, 200);
  assert.equal(applied[0].batch[0].type, 'block.remove');
  assert.match(applied[0].meta.client, /^companion:[0-9a-f]{12}$/);
  assert.equal((await request('GET', '/api/ui')).status, 503);
});
