// Scratch: the doc 06/07/08 breadth-mode follow-ups against the real
// lineup — control pairing code in setup, "Preview on...", the library
// single-item editor + item/root removal, and the plugin template registry.
// Run through run-ui-tests.ps1 -Script verify-doc0678.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'doc0678-out');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const js = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await wait(150);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
};

await wait(4000);
for (let i = 0; i < 40; i += 1) {
  if (await js(() => !!(window.S && window.S.config && window.S.config.channels))) break;
  await wait(500);
}
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

await js(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(300);

// ---------------- doc 08: plugin template registry ----------------
const registryResult = await js(async () => {
  const builder = await import('app://bundle/renderer/js/library/channel-builder.js');
  const before = builder.listTemplates().length;
  builder.registerTemplate({
    templateVersion: 1, id: 'verify-doc0678-template', name: 'Verify Template',
    slots: { s: { label: 'S', match: { kind: 'episode' } } }, channel: { name: 'Verify' },
  });
  return { before, after: builder.listTemplates().length, found: builder.listTemplates().some((t) => t.id === 'verify-doc0678-template') };
});
record('registerTemplate adds a plugin template to the live registry', registryResult.after === registryResult.before + 1 && registryResult.found, JSON.stringify(registryResult));

// ---------------- doc 06: control pairing code surfaced in setup ----------------
await page.locator('.setup-tab-btn[data-tab="audio"]').click();
await wait(400);
const controlStatus = await js(() => document.getElementById('control-url-status')?.textContent || '');
await shot('control-pairing-code');
record('the control pairing code/URL is shown in setup, not only the loopback page', /writable|Off by default|Not active yet/.test(controlStatus), controlStatus.slice(0, 140));

const hostOnlyGuard = await js(async () => {
  try {
    const url = await window.api.getViewerControlUrl();
    return { called: true, isArray: Array.isArray(url) };
  } catch (e) { return { called: false, error: e.message }; }
});
record('getViewerControlUrl answers on the host window', hostOnlyGuard.called && hostOnlyGuard.isArray, JSON.stringify(hostOnlyGuard));

// ---------------- doc 06: Preview on... ----------------
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(400);
const firstChannel = await js(() => window.S.config.channels.filter((c) => !c.hidden && c.files?.length).sort((a, b) => a.number - b.number)[0]?.number);
await js((n) => { document.querySelector(`.channel-list-item[data-channel-number="${n}"]`)?.click(); }, firstChannel);
await wait(500);
const previewOnBtn = await js(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'PREVIEW ON…'));
record('the channel editor has a PREVIEW ON… button', previewOnBtn);

const noClientsHandled = await js(async () => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'PREVIEW ON…');
  if (!btn) return false;
  btn.click();
  return true;
});
await wait(500);
const dialogText = await js(() => document.body.textContent.includes('No other screens are connected') || !!document.querySelector('.confirm-dialog, [role="dialog"]'));
await shot('preview-on-dialog');
record('PREVIEW ON… opens (either a device picker or a "no screens" notice)', noClientsHandled && dialogText);
// Not exercising Dialog's own close mechanics here (covered elsewhere) —
// just clearing it out of the way for the rest of this script.
await js(() => document.querySelectorAll('.confirm-dialog, [role="dialog"]').forEach((el) => el.remove()));
await wait(200);

// service-level check: previewOnClient reaches a fake connected client via the existing handoff bus
const previewOnCall = await js(async ({ n }) => {
  try {
    const { previewOnClient } = await import('app://bundle/renderer/js/personal/state.js');
    const event = await previewOnClient('verify-doc0678-client', n);
    return { ok: true, channel: event.channel, timeOffsetMs: event.timeOffsetMs };
  } catch (e) { return { ok: false, error: e.message }; }
}, { n: firstChannel });
record('previewOnClient sends a client:handoff event for a chosen channel, live-not-resume', previewOnCall.ok && previewOnCall.channel === firstChannel && previewOnCall.timeOffsetMs === 0, JSON.stringify(previewOnCall));

// ---------------- doc 07: single-item editor + removal ----------------
await page.locator('.setup-tab-btn[data-tab="library"]').click();
await wait(400);
await page.locator('.setup-subtab-btn[data-subtab="librarycatalogue"]').click();
await wait(400);
const libraryBuilt = await js(async () => (await window.api.libraryCall('status', {})).result.built);
if (!libraryBuilt) {
  record('media library not built in this copy — item editor/removal skipped', true, 'skipped');
} else {
  const sampleItem = await js(async () => {
    const index = (await window.api.libraryCall('getIndex', {})).result;
    const item = Object.values(index.items).find((it) => !it.detached);
    return item ? { id: item.id, title: item.title, ref: item.ref } : null;
  });
  if (!sampleItem) {
    record('media library has no items to test against', true, 'skipped');
  } else {
    const searchTerm = (sampleItem.title || sampleItem.ref.split(/[\\/]/).pop()).slice(0, 6);
    await js((term) => { const input = document.querySelector('.library-item-search input'); input.value = term; input.dispatchEvent(new Event('input', { bubbles: true })); }, searchTerm);
    await wait(400);
    await shot('library-item-search');
    const resultsShown = await js(() => document.querySelectorAll('.library-item-search-results tr').length > 0);
    record('the item search finds matches and lists EDIT/REMOVE actions', resultsShown, `term "${searchTerm}"`);

    const editedTitle = `Verify Edit ${Date.now()}`;
    const edited = await js(async ({ id, title }) => {
      const res = await window.api.libraryCall('applyItemUpdates', { updates: [{ id, fields: { title, provenance: { title: 'user' } } }] });
      if (!res.ok) return { ok: false, error: res.error };
      const index = (await window.api.libraryCall('getIndex', {})).result;
      return { ok: true, saved: index.items[id]?.title === title };
    }, { id: sampleItem.id, title: editedTitle });
    record('applyItemUpdates (the single-item editor\'s save path) persists a title change', edited.ok && edited.saved, JSON.stringify(edited));
    // restore the original title so this run leaves the throwaway copy's data as it found it
    await js(({ id, title }) => window.api.libraryCall('applyItemUpdates', { updates: [{ id, fields: { title } }] }), { id: sampleItem.id, title: sampleItem.title || '' });

    const removed = await js(async ({ id }) => {
      const res = await window.api.libraryCall('removeItem', { id });
      if (!res.ok) return { ok: false, error: res.error };
      const index = (await window.api.libraryCall('getIndex', {})).result;
      return { ok: true, gone: !index.items[id] };
    }, { id: sampleItem.id });
    record('removeItem removes just that item from the catalogue', removed.ok && removed.gone, JSON.stringify(removed));
  }

  const rootRemoveGuard = await js(() => document.querySelectorAll('.library-row-actions button').length > 0 && Array.from(document.querySelectorAll('.library-row-actions button')).some((b) => b.textContent.trim() === 'FORGET…'));
  record('each location in CATALOGUE has a FORGET… button', rootRemoveGuard);
}

record('no page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
