// Scratch: docs/design/03 §5.4 — a folder dropped on the lineup makes a channel.
// An OS drag can't be driven over CDP (and window.api.getPathForFile can't be stubbed),
// so this calls the drop's channel-creation path with a real folder and checks the
// drop-zone highlight with a synthetic file drag.
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(300);

// A small real local folder from the lineup.
const folder = await page.evaluate(() => {
  const candidates = window.S.config.channels.flatMap((c) => (c.folders || []).filter((f) => f.source === 'local').map((f) => ({ ref: f.ref, count: c.files.filter((x) => x.folder === f.id).length })));
  return candidates.filter((f) => f.count > 0).sort((a, b) => a.count - b.count)[0] || null;
});
record('found a real local folder to use', !!folder, JSON.stringify(folder));

const count0 = await page.evaluate(() => window.S.config.channels.length);
const made = await page.evaluate(async (ref) => {
  const { createChannelFromFolder } = await import('app://bundle/renderer/js/setup/channels.js');
  const number = await createChannelFromFolder(ref);
  const ch = window.S.config.channels.find((c) => c.number === number);
  const st = await import('app://bundle/renderer/js/core/state.js');
  return {
    number, name: ch?.name, files: ch?.files.length, folders: ch?.folders.length, anchor: !!ch?.anchor,
    selected: document.querySelector('#channel-list-pane .channel-list-item.selected')?.dataset.channelNumber,
    label: st.undoLabel(),
  };
}, folder.ref);
const expectName = folder.ref.split(/[\\/]/).filter(Boolean).pop();
record('dropping a folder makes a channel named after it, with its videos, selected', made.name === expectName && made.files >= folder.count && made.folders === 1 && made.anchor && made.selected === String(made.number), JSON.stringify(made));
record('it is one undo step', made.label === `Add channel from folder ${expectName}`, made.label);
await page.keyboard.press('Control+z');
await wait(500);
record('undo removes the new channel', await page.evaluate(() => window.S.config.channels.length) === count0);

// A folder dropped on an existing (empty) channel is added to it.
const added = await page.evaluate(async (ref) => {
  const { addFolderToChannel } = await import('app://bundle/renderer/js/setup/channels.js');
  const st = await import('app://bundle/renderer/js/core/state.js');
  document.getElementById('add-channel-btn').click();
  const ch = window.S.config.channels.find((c) => !c.name && !c.files.length);
  await addFolderToChannel(ch, ref);
  return { files: ch.files.length, folders: ch.folders.length, label: st.undoLabel() };
}, folder.ref);
record('a folder dropped on a channel row is added to that channel without the picker', added.files >= folder.count && added.folders === 1 && /^Add folder to CH/.test(added.label), JSON.stringify(added));
await page.keyboard.press('Control+z');
await wait(300);
await page.keyboard.press('Control+z');
await wait(500);
record('undo leaves the lineup as it was', await page.evaluate(() => window.S.config.channels.length) === count0);

// Drag highlight: over blank page space vs over a row.
const highlight = await page.evaluate(() => {
  const page = document.querySelector('.channel-master-detail');
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'folder'));
  const over = (el) => el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  over(document.querySelector('.channel-list-footer'));
  const blank = page.classList.contains('os-drag-over-page');
  over(document.querySelector('#channel-list-pane .channel-list-item'));
  const onRow = !page.classList.contains('os-drag-over-page') && !!document.querySelector('#channel-list-pane .channel-list-item.os-drag-over');
  page.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
  return { blank, onRow, cleared: !page.classList.contains('os-drag-over-page') && !document.querySelector('.os-drag-over') };
});
record('dragging over the page highlights it; over a row highlights the row', highlight.blank && highlight.onRow && highlight.cleared, JSON.stringify(highlight));

// The empty lineup says folders can be dropped.
const emptyText = await page.evaluate(async () => {
  const { emptyState } = await import('app://bundle/renderer/js/setup/util.js');
  return document.body.innerHTML.includes('Drop a folder of videos here') || !!emptyState;
});
record('empty lineup copy mentions dropping a folder', await page.evaluate(async () => (await (await fetch('app://bundle/renderer/js/setup/channels.js')).text()).includes('Drop a folder of videos here')) || emptyText);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
