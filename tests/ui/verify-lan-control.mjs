// Scratch driver: the LAN control scope and command endpoint in the real app
// (docs/design/06 §4, 05 §2.4). The point of doing this live rather than only
// in node:test is that a browser on the LAN and the Electron window are two
// real clients of one host, so this is where doc 05 §5's acceptance criterion
// ("both see each other's changes within 1 s") can actually be observed.
//
// Run it through the wrapper, never directly:
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource "<installed-app-dir>\userData" `
//     -Script verify-lan-control.mjs
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const VIEWER_PORT = 8724;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.log('FAIL could not find the renderer page'); process.exit(1); }

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning')
    && !/\[config-host\]|\[config\] the host refused/.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`);
});

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
async function step(name, fn) { try { await fn(); } catch (e) { record(name, false, e.message.split('\n')[0]); } }

await wait(3500);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();

const base = `http://127.0.0.1:${VIEWER_PORT}`;
const api = (path, token, options = {}) => fetch(`${base}${path}`, {
  ...options,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    Accept: 'application/json',
  },
});
const postCommands = (token, body) => api('/api/commands', token, { method: 'POST', body: JSON.stringify(body) });

// The control code is only ever rendered on the loopback server page, which
// refuses every non-loopback request. This driver runs on the host, so it can
// read it the same way a person sitting at the machine would.
let viewCode = '';
let controlCode = '';
let viewToken = '';
let controlToken = '';

await step('the host offers a separate control pairing code, loopback only', async () => {
  const dashboard = await (await fetch(`${base}/server`)).text();
  const codes = [...dashboard.matchAll(/<div class="code">(\d{8})<\/div>/g)].map((m) => m[1]);
  [viewCode, controlCode] = codes;
  record('the server page shows two distinct pairing codes',
    codes.length === 2 && viewCode !== controlCode, `${codes.length} codes`);
  record('the page labels the control code as the one that can change settings',
    /CONTROL PAIRING CODE/.test(dashboard) && /TV PAIRING CODE/.test(dashboard));
});

await step('each code pairs a session at its own scope', async () => {
  const viewer = await (await api(`/?pair=${viewCode}`)).json();
  const controller = await (await api(`/?pair=${controlCode}`)).json();
  viewToken = viewer.token;
  controlToken = controller.token;
  record('the view code yields a view session', viewer.scope === 'view', JSON.stringify({ scope: viewer.scope }));
  record('the control code yields a control session', controller.scope === 'control', JSON.stringify({ scope: controller.scope }));
  record('and they are different tokens', !!viewToken && !!controlToken && viewToken !== controlToken);
});

await step('a view session cannot write, however it asks', async () => {
  const channelNumber = await page.evaluate(() => window.S.config.channels[0].number);
  const before = await page.evaluate((n) => (window.S.config.channels.find((c) => c.number === n) || {}).name, channelNumber);

  const write = await postCommands(viewToken, {
    commands: [{ type: 'channel.rename', channel: channelNumber, name: 'VIEWER SHOULD NOT WRITE' }],
    id: `viewer-${Date.now()}`, baseRevision: 0, client: 'verify-viewer',
  });
  const controlConfig = await api('/api/control/config', viewToken);
  const controlState = await api('/api/control/state', viewToken);
  const after = await page.evaluate(async (n) => {
    const fresh = await window.api.loadConfig();
    return (fresh.channels.find((c) => c.number === n) || {}).name;
  }, channelNumber);

  record('POST /api/commands is refused for a view session', write.status === 403, `HTTP ${write.status}`);
  record('so are the control read routes',
    controlConfig.status === 403 && controlState.status === 403, `${controlConfig.status}/${controlState.status}`);
  record('and nothing was written', after === before, `${before} -> ${after}`);
});

await step('a control session writes, and the Electron window sees it within a second', async () => {
  const channelNumber = await page.evaluate(() => window.S.config.channels[0].number);
  const original = await page.evaluate((n) => (window.S.config.channels.find((c) => c.number === n) || {}).name, channelNumber);
  const revision = (await (await api('/api/control/state', controlToken)).json()).revision;

  const t0 = Date.now();
  const applied = await postCommands(controlToken, {
    commands: [{ type: 'channel.rename', channel: channelNumber, name: 'EDITED FROM THE LAN' }],
    id: `lan-${Date.now()}`, baseRevision: revision, client: 'verify-ipad',
  });
  const body = await applied.json();

  // The host broadcasts config:applied to every Electron renderer. Watch the
  // window's own S.config, not the disk.
  let sawAt = null;
  for (let i = 0; i < 20 && !sawAt; i += 1) {
    const name = await page.evaluate((n) => (window.S.config.channels.find((c) => c.number === n) || {}).name, channelNumber);
    if (name === 'EDITED FROM THE LAN') sawAt = Date.now();
    else await wait(50);
  }

  record('the LAN edit applied', applied.status === 200 && body.ok === true, `HTTP ${applied.status} ${JSON.stringify(body.reason || '')}`);
  record('the Electron window received it within 1 s', !!sawAt && sawAt - t0 < 1000, sawAt ? `${sawAt - t0} ms` : 'never arrived');
  record('and it is not an undo step of the host window',
    await page.evaluate(async () => {
      const state = await import('app://bundle/renderer/js/core/state.js');
      return state.undoLabel() !== 'Rename CH';
    }));

  // Put it back from the LAN side.
  await postCommands(controlToken, {
    commands: [{ type: 'channel.rename', channel: channelNumber, name: original }],
    id: `lan-restore-${Date.now()}`, baseRevision: (await (await api('/api/control/state', controlToken)).json()).revision, client: 'verify-ipad',
  });
  await wait(200);
});

await step('the LAN endpoint enforces the same duplicate and conflict rules', async () => {
  const channelNumber = await page.evaluate(() => window.S.config.channels[0].number);
  const original = await page.evaluate((n) => (window.S.config.channels.find((c) => c.number === n) || {}).name, channelNumber);
  const revision = (await (await api('/api/control/state', controlToken)).json()).revision;
  const id = `lan-dup-${Date.now()}`;
  const batch = { commands: [{ type: 'channel.rename', channel: channelNumber, name: 'DUP TEST' }], id, baseRevision: revision, client: 'verify-ipad' };

  const first = await (await postCommands(controlToken, batch)).json();
  const again = await (await postCommands(controlToken, batch)).json();
  record('a redelivered batch is answered at the same revision',
    again.duplicate === true && again.revision === first.revision, JSON.stringify({ first: first.revision, again: again.revision, duplicate: again.duplicate }));

  // The host window moves, then the LAN client sends something built before it.
  await page.evaluate(async (n) => {
    const state = await import('app://bundle/renderer/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: n, name: 'HOST WINDOW WINS' }, { delay: 0 });
  }, channelNumber);
  await wait(800);

  const stale = await postCommands(controlToken, {
    commands: [{ type: 'channel.rename', channel: channelNumber, name: 'STALE LAN WRITE' }],
    id: `lan-stale-${Date.now()}`, baseRevision: revision, client: 'verify-ipad',
  });
  const staleBody = await stale.json();
  const onDisk = await page.evaluate(async (n) => {
    const fresh = await window.api.loadConfig();
    return (fresh.channels.find((c) => c.number === n) || {}).name;
  }, channelNumber);

  record('a stale LAN batch comes back 409 with a typed reason',
    stale.status === 409 && staleBody.reason === 'conflict', `HTTP ${stale.status} ${staleBody.reason}`);
  record("and the host window's edit stands", onDisk === 'HOST WINDOW WINS', onDisk);

  await page.evaluate(async (args) => {
    const state = await import('app://bundle/renderer/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: args.n, name: args.original }, { delay: 0 });
  }, { n: channelNumber, original });
  await wait(800);
});

await step('control config carries real paths but no credentials; the viewer projection is untouched', async () => {
  const control = await (await api('/api/control/config', controlToken)).json();
  const viewer = await (await api('/api/config', viewToken)).json();
  // Look anywhere, not just at channels[].path — a real lineup keeps its media
  // under `folders` and per-file `path`, so pinning this to one key would let
  // the check pass without ever seeing a path.
  // Walk the real values rather than the JSON text, so backslash escaping
  // cannot quietly make the check match nothing.
  const tally = (node, acc = { real: 0, opaque: 0 }) => {
    if (typeof node === 'string') {
      if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(node)) acc.real += 1;
      else if (/^viewer:/.test(node)) acc.opaque += 1;
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach((child) => tally(child, acc));
    }
    return acc;
  };
  const controlTally = tally(control.config);
  const viewerTally = tally(viewer);
  const { real: controlReal, opaque: controlOpaque } = controlTally;
  const { real: viewerReal, opaque: viewerOpaque } = viewerTally;
  const hasSecret = JSON.stringify(control.config).match(/"(?:apiKey|token|secret|password)"\s*:/i);

  record('a control client sees real host paths and no opaque refs',
    controlReal > 0 && controlOpaque === 0, `${controlReal} real, ${controlOpaque} opaque`);
  record('a viewer still sees only opaque refs, never a host path',
    viewerOpaque > 0 && viewerReal === 0, `${viewerReal} real, ${viewerOpaque} opaque`);
  record('no credential-shaped key survives into the control config', !hasSecret, hasSecret ? hasSecret[0] : 'none');
  record('control state reports the revision a client builds batches against', Number.isInteger(control.revision), String(control.revision));
});

await step('a remote editor cannot do the administration it is not paired for', async () => {
  const revision = (await (await api('/api/control/state', controlToken)).json()).revision;
  const attempts = [
    ['plugin permissions', { type: 'plugin.setApproval', id: 'verify-evil', signature: 'granted-from-afar' }],
    ['enabling a plugin', { type: 'plugin.setEnabled', id: 'verify-evil', enabled: true }],
    ['network services', { type: 'settings.set', path: ['network', 'viewerEnabled'], value: false }],
    ['update settings', { type: 'settings.set', path: ['updates', 'strategy'], value: 'startup-auto' }],
    ['the PIN lock', { type: 'settings.set', path: ['pinLock', 'enabled'], value: false }],
  ];
  const outcomes = [];
  for (const [label, command] of attempts) {
    const response = await postCommands(controlToken, {
      commands: [command], id: `verify-forbid-${label.replace(/\W/g, '')}-${Date.now()}`, baseRevision: revision, client: 'verify-ipad',
    });
    outcomes.push({ label, status: response.status, reason: (await response.json()).reason });
  }
  record('every administration command is refused over the LAN',
    outcomes.every((o) => o.status === 409 && o.reason === 'forbidden'), JSON.stringify(outcomes));

  // And the host is genuinely unchanged by the attempts.
  const after = await page.evaluate(async () => {
    const fresh = await window.api.loadConfig();
    return {
      approvals: Object.keys(fresh.plugins.approvedCapabilities || {}).filter((id) => id.startsWith('verify-evil')).length,
      viewerEnabled: fresh.network && fresh.network.viewerEnabled,
    };
  });
  record('the host is unchanged by them', after.approvals === 0 && after.viewerEnabled !== false, JSON.stringify(after));
});

await step('folder browsing is confined to what the host shares', async () => {
  const top = await (await api('/api/control/browse?kind=folder', controlToken)).json();
  record('the top level lists the roots, not a filesystem root',
    Array.isArray(top.roots) && top.roots.length > 0 && top.path === null, JSON.stringify({ roots: top.roots.length, path: top.path }));

  const root = top.roots[0];
  const inside = await (await api(`/api/control/browse?kind=video&path=${encodeURIComponent(root)}`, controlToken)).json();
  record('a root can be listed', Array.isArray(inside.entries), `${(inside.entries || []).length} entries in ${root}`);

  const escapes = ['C:\\Windows', 'C:\\Windows\\System32', `${root}\\..\\..`, 'C:\\'];
  const refusals = [];
  for (const target of escapes) {
    const response = await api(`/api/control/browse?path=${encodeURIComponent(target)}`, controlToken);
    refusals.push({ target, status: response.status });
  }
  record('nothing outside the roots is listable', refusals.every((r) => r.status === 400), JSON.stringify(refusals));

  const scanRefused = await api(`/api/control/scan?path=${encodeURIComponent('C:\\Windows')}`, controlToken);
  record('and a folder that was never listed cannot be scanned', scanRefused.status === 400, `HTTP ${scanRefused.status}`);
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length) console.log(`renderer runtime errors: ${errors.length}\n${errors.slice(0, 10).join('\n')}`);
else console.log('renderer runtime errors: 0');
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
