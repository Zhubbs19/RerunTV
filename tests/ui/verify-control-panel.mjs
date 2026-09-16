// Scratch driver: the LAN control panel as a real second browser client of the
// real host (docs/design/06 §3, phase 1). It drives the actual setup shell in a
// separate browser — its own cookie jar, its own window.api, its own S.config
// and its own undo history — while the Electron window is open on the same
// host, which is the only way to see two real clients reconcile.
//
// It has to be a SEPARATE browser: Electron's CDP supports neither
// Target.createBrowserContext nor Target.createTarget, so the Electron browser
// cannot be given a second page at all (the same family of gap as the missing
// Browser.* window methods — see tests/ui/README.md). Playwright-core ships no
// browsers of its own either, so this drives an installed Edge or Chrome and
// skips its browser-side checks if neither is present.
//
// Run it through the wrapper, never directly:
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource "C:\Users\zhubb\Apps\RerunTV\userData" `
//     -Script verify-control-panel.mjs
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const VIEWER_PORT = 8724;
const base = `http://127.0.0.1:${VIEWER_PORT}`;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];

async function launchRealBrowser() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) { /* try the next one */ }
  }
  return null;
}
let hostPage = null;
for (let i = 0; i < 60 && !hostPage; i += 1) {
  hostPage = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!hostPage) await new Promise((r) => setTimeout(r, 500));
}
if (!hostPage) { console.log('FAIL could not find the renderer page'); process.exit(1); }

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) { try { await fn(); } catch (e) { record(name, false, e.message.split('\n')[0]); } }

await wait(3500);
await hostPage.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await hostPage.locator('#update-changelog:not(.hidden)').count()) await hostPage.locator('#update-changelog-done').click();

// Both pairing codes come off the loopback server page, as a person at the
// host machine would read them.
const dashboard = await (await fetch(`${base}/server`)).text();
const [viewCode, controlCode] = [...dashboard.matchAll(/<div class="code">(\d{8})<\/div>/g)].map((m) => m[1]);

const realBrowser = await launchRealBrowser();
if (!realBrowser) {
  console.log('SKIP no installed Edge or Chrome to drive a browser control panel with');
  console.log('\n0/0 checks passed');
  await browser.close();
  process.exit(0);
}
// One context, and therefore one `reruntv_viewer` cookie: the control checks
// all run first, then the page re-pairs as a viewer for the refusal checks.
const panelContext = await realBrowser.newContext();
const panel = await panelContext.newPage();

const panelErrors = [];
const httpFailures = [];
// Deliberate refusals: the viewer steps at the end ask for things a view
// session must not get, and a 403 there is the feature working.
let expectingRefusals = false;
panel.on('pageerror', (e) => panelErrors.push(e.message));
panel.on('console', (m) => {
  const text = m.text();
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  if (/\[config\] the host refused/.test(text)) return;
  // "Failed to load resource" carries no URL; the response listener below does.
  if (/Failed to load resource/.test(text)) return;
  panelErrors.push(`[${m.type()}] ${text}`);
});
panel.on('response', (response) => {
  if (response.status() < 400) return;
  if (expectingRefusals && response.status() === 403) return;
  httpFailures.push(`HTTP ${response.status()} ${response.url()}`);
});

await step('a control-paired browser gets the editor at /control', async () => {
  await panel.goto(`${base}/?pair=${controlCode}`, { waitUntil: 'domcontentloaded' });
  await panel.goto(`${base}/control`, { waitUntil: 'load' });
  await panel.waitForFunction(() => window.api && window.S && window.S.config, null, { timeout: 20000 });
  await wait(2500);
  const shape = await panel.evaluate(() => ({
    controlClient: window.__controlClient === true,
    isViewer: window.__isViewer === true,
    setupVisible: !document.getElementById('setup-screen').classList.contains('hidden'),
    channels: (window.S.config.channels || []).length,
    paused: document.getElementById('player') ? document.getElementById('player').paused : true,
  }));
  record('it boots as a control client', shape.controlClient, JSON.stringify(shape));
  record('it opens the setup shell rather than the picture', shape.setupVisible && shape.paused, JSON.stringify(shape));
  record('it loaded the real lineup', shape.channels > 0, `${shape.channels} channels`);
});

await step('the panel sees real host paths, not the viewer projection', async () => {
  const tally = await panel.evaluate(() => {
    const walk = (node, acc = { real: 0, opaque: 0 }) => {
      if (typeof node === 'string') {
        if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(node)) acc.real += 1;
        else if (/^viewer:/.test(node)) acc.opaque += 1;
      } else if (node && typeof node === 'object') Object.values(node).forEach((child) => walk(child, acc));
      return acc;
    };
    return walk(window.S.config);
  });
  record('an editor can see and change real paths', tally.real > 0 && tally.opaque === 0, JSON.stringify(tally));
});

await step('an edit made in the browser reaches disk and the Electron window', async () => {
  const number = await panel.evaluate(() => window.S.config.channels[0].number);
  const original = await panel.evaluate((n) => window.S.config.channels.find((c) => c.number === n).name, number);

  const t0 = Date.now();
  await panel.evaluate(async (args) => {
    const state = await import('/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: args.n, name: 'EDITED IN THE BROWSER' }, { delay: 0 });
  }, { n: number });

  let sawAt = null;
  for (let i = 0; i < 40 && !sawAt; i += 1) {
    const name = await hostPage.evaluate((n) => (window.S.config.channels.find((c) => c.number === n) || {}).name, number);
    if (name === 'EDITED IN THE BROWSER') sawAt = Date.now();
    else await wait(50);
  }
  const onDisk = await hostPage.evaluate(async (n) => {
    const fresh = await window.api.loadConfig();
    return (fresh.channels.find((c) => c.number === n) || {}).name;
  }, number);

  record('the browser edit reached channels.json', onDisk === 'EDITED IN THE BROWSER', onDisk);
  record('and the Electron window saw it', !!sawAt, sawAt ? `${sawAt - t0} ms` : 'never arrived');

  await panel.evaluate(async (args) => {
    const state = await import('/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: args.n, name: args.original }, { delay: 0 });
  }, { n: number, original });
  await wait(700);
});

await step("an edit made on the host reaches the browser panel's own S.config", async () => {
  const number = await hostPage.evaluate(() => window.S.config.channels[0].number);
  const original = await hostPage.evaluate((n) => window.S.config.channels.find((c) => c.number === n).name, number);

  const t0 = Date.now();
  await hostPage.evaluate(async (n) => {
    const state = await import('app://bundle/renderer/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: n, name: 'EDITED ON THE HOST' }, { delay: 0 });
  }, number);

  let sawAt = null;
  for (let i = 0; i < 60 && !sawAt; i += 1) {
    const name = await panel.evaluate((n) => (window.S.config.channels.find((c) => c.number === n) || {}).name, number);
    if (name === 'EDITED ON THE HOST') sawAt = Date.now();
    else await wait(50);
  }
  record('the panel received the host edit over config:applied', !!sawAt, sawAt ? `${sawAt - t0} ms` : 'never arrived');
  record('and it is not an undo step of the panel',
    await panel.evaluate(async () => {
      const state = await import('/js/core/state.js');
      return state.undoLabel() !== 'Rename CH';
    }));

  await hostPage.evaluate(async (args) => {
    const state = await import('app://bundle/renderer/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: args.n, name: args.original }, { delay: 0 });
  }, { n: number, original });
  await wait(700);
});

await step('undo in the browser panel reaches the host', async () => {
  const number = await panel.evaluate(() => window.S.config.channels[0].number);
  const original = await panel.evaluate((n) => window.S.config.channels.find((c) => c.number === n).name, number);
  await panel.evaluate(async (n) => {
    const state = await import('/js/core/state.js');
    state.dispatch({ type: 'channel.rename', channel: n, name: 'ABOUT TO BE UNDONE' }, { delay: 0 });
  }, number);
  await wait(700);
  await panel.evaluate(async () => {
    const state = await import('/js/core/state.js');
    state.performUndo();
  });
  await wait(900);
  const onDisk = await hostPage.evaluate(async (n) => {
    const fresh = await window.api.loadConfig();
    return (fresh.channels.find((c) => c.number === n) || {}).name;
  }, number);
  record('undo travelled to the host as its own commands', onDisk === original, `${onDisk} (expected ${original})`);
});

await step('the host folder browser stands in for the native file dialog', async () => {
  // window.api.selectFolder() is what every "add a folder" button calls. On the
  // host that opens an Electron dialog; here it must open the host browser.
  await panel.evaluate(() => { window.__pickResult = window.api.selectFolder(); });
  await panel.waitForSelector('.control-picker-list', { timeout: 15000 });
  await panel.waitForFunction(
    () => document.querySelectorAll('.control-picker-list .btn').length > 0,
    null, { timeout: 15000 },
  );
  const shape = await panel.evaluate(() => {
    const rows = [...document.querySelectorAll('.control-picker-list .btn')];
    return {
      rows: rows.length,
      first: rows[0] ? rows[0].textContent.trim() : '',
      // "Use this folder" is disabled until the user is actually inside one.
      confirmDisabled: [...document.querySelectorAll('.control-picker-dialog .confirm-dialog-actions button')].pop().disabled,
    };
  });
  record('selectFolder() opens the host folder browser', shape.rows > 0, JSON.stringify(shape));
  // The row label carries a folder glyph before the path, so this looks for a
  // host path anywhere in it rather than anchoring to the start.
  record('it lists real host folders', /[A-Za-z]:[\\/]/.test(shape.first), shape.first);
  record('choosing is disabled until a folder is open', shape.confirmDisabled === true, String(shape.confirmDisabled));

  // Open the first root, then take it.
  await panel.evaluate(() => document.querySelector('.control-picker-list .btn').click());
  await panel.waitForFunction(
    () => /[A-Za-z]:[\\/]/.test(document.querySelector('.control-picker-path').textContent || ''),
    null, { timeout: 15000 },
  );
  const chosen = await panel.evaluate(async () => {
    const buttons = [...document.querySelectorAll('.control-picker-dialog .confirm-dialog-actions button')];
    buttons[buttons.length - 1].click();
    return window.__pickResult;
  });
  record('it resolves to a real host path', typeof chosen === 'string' && /^[A-Za-z]:[\\/]/.test(chosen), String(chosen));
});

// ---- From here the page re-pairs as a VIEWER, so it is a different session
// with a different scope on the same host. Nothing above runs after this.
expectingRefusals = true;
await step('a view-paired browser is refused the editor entirely', async () => {
  await panel.goto(`${base}/?pair=${viewCode}`, { waitUntil: 'domcontentloaded' });
  const response = await panel.goto(`${base}/control`, { waitUntil: 'domcontentloaded' });
  const body = await panel.evaluate(() => document.body.innerText);
  record('/control answers 403 for a view session', response.status() === 403, `HTTP ${response.status()}`);
  record('and says why, without serving any of the editor', /not paired for control/i.test(body), body.slice(0, 80));
});

await step('a viewer that reaches the bundle anyway still cannot write', async () => {
  await panel.goto(`${base}/`, { waitUntil: 'load' });
  await panel.waitForFunction(() => window.api && window.S && window.S.config, null, { timeout: 20000 });
  await wait(2000);
  const number = await hostPage.evaluate(() => window.S.config.channels[0].number);
  const before = await hostPage.evaluate((n) => window.S.config.channels.find((c) => c.number === n).name, number);
  const result = await panel.evaluate((n) => window.api.applyConfigCommands(
    [{ type: 'channel.rename', channel: n, name: 'VIEWER SHOULD NOT WRITE' }],
    { id: `viewer-${Date.now()}`, baseRevision: 0, client: 'verify-viewer' },
  ), number);
  await wait(400);
  const after = await hostPage.evaluate(async (n) => {
    const fresh = await window.api.loadConfig();
    return (fresh.channels.find((c) => c.number === n) || {}).name;
  }, number);
  record('the shim reports the refusal rather than pretending to save',
    result && result.ok === false && result.reason === 'read-only', JSON.stringify(result));
  record('and nothing was written', after === before, `${before} -> ${after}`);
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (panelErrors.length) console.log(`control-panel runtime errors: ${panelErrors.length}\n${panelErrors.slice(0, 10).join('\n')}`);
else console.log('control-panel runtime errors: 0');
if (httpFailures.length) console.log(`unexpected HTTP failures: ${httpFailures.length}\n${httpFailures.slice(0, 10).join('\n')}`);
else console.log('unexpected HTTP failures: 0');
await panelContext.close();
await realBrowser.close();
await browser.close();
process.exit(failed.length || panelErrors.length || httpFailures.length ? 1 : 0);
