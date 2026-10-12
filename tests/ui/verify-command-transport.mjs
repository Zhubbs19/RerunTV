// Scratch driver: the host command write path in the real app
// (docs/design/05 §2.2-2.3, step 6). Everything here goes through the real
// sandboxed preload, the real ipcMain handlers and the real channels.json —
// the node:test suite covers the same protocol against injected storage, and
// this is what says it is actually wired up.
//
// Run it through the wrapper, never directly:
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource "<installed-app-dir>\userData" `
//     -Script verify-command-transport.mjs
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
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
  // The refusal paths below deliberately log a warning; that is the feature
  // working, not a runtime error.
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
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

const st = () => 'app://bundle/renderer/js/core/state.js';

await step('the command endpoint is on the real sandboxed preload', async () => {
  const shape = await page.evaluate(() => ({
    applyConfigCommands: typeof window.api.applyConfigCommands,
    getConfigSnapshot: typeof window.api.getConfigSnapshot,
    saveConfig: typeof window.api.saveConfig,
  }));
  record('window.api exposes applyConfigCommands and getConfigSnapshot',
    shape.applyConfigCommands === 'function' && shape.getConfigSnapshot === 'function', JSON.stringify(shape));
});

await step('a dispatched edit reaches channels.json as a command', async () => {
  const r = await page.evaluate(async (mod) => {
    const state = await import(mod);
    const channel = window.S.config.channels[0];
    const original = channel.name;
    // Get past the session's first write, which is deliberately a whole-config
    // save (the host has never been told the defaults this renderer applied).
    await state.saveConfigNow();
    const revBefore = await window.api.getConfigRevision();

    state.dispatch({ type: 'channel.rename', channel: channel.number, name: `${original} TRANSPORT` }, { delay: 0 });
    await new Promise((resolve) => { setTimeout(resolve, 600); });

    const revAfter = await window.api.getConfigRevision();
    const onDisk = await window.api.loadConfig();
    const diskName = (onDisk.channels.find((c) => c.number === channel.number) || {}).name;

    // Put it back through the same path.
    state.dispatch({ type: 'channel.rename', channel: channel.number, name: original }, { delay: 0 });
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    const restored = await window.api.loadConfig();
    return {
      number: channel.number, original, diskName, revBefore, revAfter,
      restoredName: (restored.channels.find((c) => c.number === channel.number) || {}).name,
      rendererRevision: state.getHostRevision(),
    };
  }, st());
  record('the edit is on disk', r.diskName === `${r.original} TRANSPORT`, JSON.stringify(r));
  record('the host revision advanced, so it came through the command path', r.revAfter > r.revBefore, `${r.revBefore} -> ${r.revAfter}`);
  record('the renderer adopted the revision from its own echo', r.rendererRevision >= r.revAfter, `renderer ${r.rendererRevision}`);
  record('the edit was undone cleanly', r.restoredName === r.original, r.restoredName);
});

await step('a redelivered batch is answered, not applied twice', async () => {
  const r = await page.evaluate(async () => {
    const id = `verify-dup-${Date.now()}`;
    const entry = { id: `verify-ad-${Date.now()}`, path: 'C:/verify/transport.mp4', kind: 'commercial' };
    const base = await window.api.getConfigRevision();
    const batch = [{ type: 'item.insert', collection: 'pool', item: entry }];

    const first = await window.api.applyConfigCommands(batch, { id, baseRevision: base, client: 'verify-driver' });
    const again = await window.api.applyConfigCommands(batch, { id, baseRevision: base, client: 'verify-driver' });
    const onDisk = await window.api.loadConfig();
    const count = ((onDisk.interstitials || {}).pool || []).filter((p) => p.id === entry.id).length;

    // Clean up through the same path.
    await window.api.applyConfigCommands([{ type: 'item.remove', collection: 'pool', id: entry.id }],
      { id: `verify-cleanup-${Date.now()}`, baseRevision: await window.api.getConfigRevision(), client: 'verify-driver' });
    return { first: first.ok, firstRev: first.revision, again: again.ok, duplicate: again.duplicate, againRev: again.revision, count };
  });
  record('the first delivery applied', r.first === true, JSON.stringify(r));
  record('the redelivery is reported as a duplicate at the same revision',
    r.duplicate === true && r.againRev === r.firstRev, JSON.stringify(r));
  record('a non-idempotent insert ran exactly once', r.count === 1, `found ${r.count}`);
});

await step('a stale client is refused when it touches what another client changed', async () => {
  const r = await page.evaluate(async () => {
    const channel = window.S.config.channels[0];
    const original = channel.name;
    const base = await window.api.getConfigRevision();

    const laptop = await window.api.applyConfigCommands(
      [{ type: 'channel.rename', channel: channel.number, name: 'FROM THE LAPTOP' }],
      { id: `verify-laptop-${Date.now()}`, baseRevision: base, client: 'verify-laptop' });
    const phone = await window.api.applyConfigCommands(
      [{ type: 'channel.rename', channel: channel.number, name: 'FROM THE PHONE' }],
      { id: `verify-phone-${Date.now()}`, baseRevision: base, client: 'verify-phone' });

    const onDisk = await window.api.loadConfig();
    const diskName = (onDisk.channels.find((c) => c.number === channel.number) || {}).name;
    await window.api.applyConfigCommands(
      [{ type: 'channel.rename', channel: channel.number, name: original }],
      { id: `verify-restore-${Date.now()}`, baseRevision: await window.api.getConfigRevision(), client: 'verify-laptop' });
    return { laptop: laptop.ok, phone: phone.ok, reason: phone.reason, conflictsWith: phone.conflictsWith, diskName };
  });
  record('the first client applied', r.laptop === true, JSON.stringify(r));
  record('the second is refused as a conflict, naming what it clashed with',
    r.phone === false && r.reason === 'conflict' && Array.isArray(r.conflictsWith) && r.conflictsWith.length === 1, JSON.stringify(r));
  record('nothing was overwritten', r.diskName === 'FROM THE LAPTOP', r.diskName);
});

await step('two clients editing different channels both apply', async () => {
  const r = await page.evaluate(async () => {
    const [a, b] = window.S.config.channels;
    if (!b) return { skipped: true };
    const names = [a.name, b.name];
    const base = await window.api.getConfigRevision();
    const first = await window.api.applyConfigCommands([{ type: 'channel.rename', channel: a.number, name: 'COMPAT A' }],
      { id: `verify-compat-a-${Date.now()}`, baseRevision: base, client: 'verify-laptop' });
    const second = await window.api.applyConfigCommands([{ type: 'channel.rename', channel: b.number, name: 'COMPAT B' }],
      { id: `verify-compat-b-${Date.now()}`, baseRevision: base, client: 'verify-phone' });
    const onDisk = await window.api.loadConfig();
    const seen = [a, b].map((ch) => (onDisk.channels.find((c) => c.number === ch.number) || {}).name);
    await window.api.applyConfigCommands([
      { type: 'channel.rename', channel: a.number, name: names[0] },
      { type: 'channel.rename', channel: b.number, name: names[1] },
    ], { id: `verify-compat-restore-${Date.now()}`, baseRevision: await window.api.getConfigRevision(), client: 'verify-laptop' });
    return { first: first.ok, second: second.ok, seen };
  });
  if (r.skipped) record('two clients editing different channels both apply', true, 'skipped: one channel only');
  else record('both applied despite sharing a base revision',
    r.first === true && r.second === true && r.seen[0] === 'COMPAT A' && r.seen[1] === 'COMPAT B', JSON.stringify(r));
});

await step('the renderer resyncs from the host after its own batch is refused', async () => {
  const r = await page.evaluate(async (mod) => {
    const state = await import(mod);
    const channel = window.S.config.channels[0];
    const original = channel.name;

    // Another client moves first, so the renderer's next batch is stale.
    await window.api.applyConfigCommands([{ type: 'channel.rename', channel: channel.number, name: 'MOVED ELSEWHERE' }],
      { id: `verify-elsewhere-${Date.now()}`, baseRevision: await window.api.getConfigRevision(), client: 'verify-other-device' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    // The renderer heard that on config:applied, so make it genuinely stale by
    // sending a batch built against a revision from before it.
    const stale = await window.api.applyConfigCommands([{ type: 'channel.rename', channel: channel.number, name: 'STALE WRITE' }],
      { id: `verify-stale-${Date.now()}`, baseRevision: 0, client: state.getClientId() });
    await state.resyncFromHost(stale.reason);

    const onDisk = await window.api.loadConfig();
    const diskName = (onDisk.channels.find((c) => c.number === channel.number) || {}).name;
    const rendererName = (window.S.config.channels.find((c) => c.number === channel.number) || {}).name;
    await window.api.applyConfigCommands([{ type: 'channel.rename', channel: channel.number, name: original }],
      { id: `verify-final-${Date.now()}`, baseRevision: await window.api.getConfigRevision(), client: 'verify-other-device' });
    return {
      refused: stale.ok, reason: stale.reason, diskName, rendererName,
      canUndo: state.canUndo(), revision: state.getHostRevision(), hostRevision: await window.api.getConfigRevision(),
    };
  }, st());
  record('the stale batch was refused', r.refused === false && !!r.reason, JSON.stringify(r));
  record('the renderer now matches the host exactly', r.rendererName === r.diskName, JSON.stringify(r));
  record('and its undo history was dropped with the config it described', r.canUndo === false, `canUndo ${r.canUndo}`);
});

await step('the host applies its own commands through the real module path', async () => {
  // This is the regression the reorganization introduced: main/config/config.js
  // resolved renderer/js/commands.js from the wrong directory, so every
  // configHost.applyCommands() call rejected and plugin approval silently
  // failed. Nothing but a real IPC round trip proves the path resolves.
  const r = await page.evaluate(async () => {
    const fake = `verify-transport-fake-${Date.now()}`;
    const before = await window.api.getConfigRevision();
    const reply = await window.api.pluginsApproveCapabilities(fake, 'sig-transport');
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const onDisk = await window.api.loadConfig();
    const after = await window.api.getConfigRevision();
    const stored = (onDisk.plugins.approvedCapabilities || {})[fake];
    // Read before the cleanup revoke below, whose own broadcast would remove it again.
    const inRenderer = (window.S.config.plugins.approvedCapabilities || {})[fake];
    await window.api.pluginsRevokeCapabilities(fake);
    return { fake, stored, before, after, replyOk: !!reply, inRenderer };
  });
  record('a host command applied and reached disk', r.stored === 'sig-transport' && r.after > r.before, JSON.stringify(r));
  record('and the renderer received it on config:applied', r.inRenderer === 'sig-transport', JSON.stringify(r));
});

await step("a plugin's own command is named, undoable and confined to its settings", async () => {
  const r = await page.evaluate(async () => {
    const state = await import('app://bundle/renderer/js/core/state.js');
    const commands = await import('app://bundle/renderer/js/core/commands.js');
    const id = `verify-plugin-${Date.now()}`;
    const ctx = window.RCBPlugins.ctx;

    ctx.commands.register(id, 'setEra', {
      apply(settings, cmd) {
        const before = settings.era;
        settings.era = cmd.era;
        return [{ name: 'setEra', era: before === undefined ? null : before }];
      },
      describe(settings, cmd) { return `Switch to the ${cmd.era} era`; },
      touches() { return ['era']; },
    });

    const channelsBefore = JSON.stringify(window.S.config.channels);
    const themeBefore = window.S.config.theme;
    ctx.commands.dispatch(id, 'setEra', { era: '1999' });
    const label = state.undoLabel();
    const applied = window.S.config.pluginSettings[id].era;
    const touches = commands.commandTouches({ type: ctx.commands.type(id, 'setEra'), era: '1999' });
    await new Promise((resolve) => { setTimeout(resolve, 900); });
    const onDisk = await window.api.loadConfig();
    const persisted = (onDisk.pluginSettings || {})[id];

    state.performUndo();
    await new Promise((resolve) => { setTimeout(resolve, 900); });
    const afterUndo = window.S.config.pluginSettings[id].era;

    return {
      ctxVersion: window.RCBPlugins.version, label, applied, touches, persisted,
      afterUndo, channelsUnchanged: JSON.stringify(window.S.config.channels) === channelsBefore,
      themeUnchanged: window.S.config.theme === themeBefore,
    };
  });
  record('ctx is at v7 or later', r.ctxVersion >= 7, `v${r.ctxVersion}`);
  record("the step carries the plugin's own label", r.label === 'Switch to the 1999 era', r.label);
  record('it wrote only that plugin\'s settings', r.applied === '1999' && r.channelsUnchanged && r.themeUnchanged, JSON.stringify(r));
  record('its touch tokens stay inside that plugin',
    r.touches.length === 1 && r.touches[0].startsWith('plugins/') && r.touches[0].endsWith('/settings/era'), JSON.stringify(r.touches));
  record('it reached channels.json as plugin settings the host understands',
    r.persisted && r.persisted.era === '1999', JSON.stringify(r.persisted));
  record('and it undoes precisely', r.afterUndo === null, String(r.afterUndo));
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length) console.log(`renderer runtime errors: ${errors.length}\n${errors.slice(0, 10).join('\n')}`);
else console.log('renderer runtime errors: 0');
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
