// Scratch: docs/design/03 step 5 — flows and backups as list + detail.
import { chromium } from 'playwright-core';
import path from 'node:path';

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

// Flows.
await page.locator('.setup-tab-btn[data-tab="programming"]').click();
const flowsSubtab = page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="flows"]');
if (await flowsSubtab.count()) await flowsSubtab.click();
await wait(800);
const flows = () => page.evaluate(() => ({
  rows: document.querySelectorAll('#flow-list .flow-list-item').length,
  flowCount: (window.S.config.interstitials.flows || []).length,
  selected: document.querySelector('#flow-list .flow-list-item.selected')?.dataset.flowId,
  selectValue: document.getElementById('flow-template-select').value,
  nameInput: document.getElementById('flow-name-input')?.value,
  listVisible: document.getElementById('flow-list').getBoundingClientRect().width > 0,
  detailBeside: document.querySelector('.flow-detail').getBoundingClientRect().left > document.getElementById('flow-list').getBoundingClientRect().left,
}));
let f = await flows();
record('flows are a list beside the selected flow\'s editor', f.rows === f.flowCount && f.rows > 0 && f.selected === f.selectValue && f.listVisible && f.detailBeside, JSON.stringify(f));
await page.screenshot({ path: path.join('test/screenshots', 'flows-list-detail.png') });
if (f.rows > 1) {
  const second = await page.evaluate(() => document.querySelectorAll('#flow-list .flow-list-item')[1].dataset.flowId);
  await page.locator(`#flow-list .flow-list-item[data-flow-id="${second}"]`).click();
  await wait(300);
  f = await flows();
  const name = await page.evaluate((id) => window.S.config.interstitials.flows.find((x) => x.id === id).name || '', second);
  record('clicking a flow opens it in the editor', f.selected === second && f.selectValue === second && f.nameInput === name, JSON.stringify(f));
  await page.keyboard.press('ArrowUp');
  await wait(300);
  f = await flows();
  const first = await page.evaluate(() => window.S.config.interstitials.flows[0].id);
  const focused = await page.evaluate(() => document.activeElement?.dataset?.flowId);
  record('ArrowUp moves the selection and keeps focus in the list', f.selected === first && focused === first, `${f.selected} focus ${focused}`);
}
const renamed = await page.evaluate(async () => {
  const input = document.getElementById('flow-name-input');
  const old = input.value;
  input.value = `${old} X`;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const row = document.querySelector('#flow-list .flow-list-item.selected .flow-list-name').textContent;
  const st = await import('app://bundle/renderer/js/state.js');
  st.performUndo();
  return { row, old };
});
record('typing a flow name updates its list row', renamed.row === `${renamed.old} X`, JSON.stringify(renamed));

// Backups.
await page.locator('.setup-tab-btn[data-tab="audio"]').click();
const backupsSubtab = page.locator('[data-tab-panel="audio"] .setup-subtab-btn[data-subtab="backups"]');
if (await backupsSubtab.count()) await backupsSubtab.click();
await wait(1500);
const backups = () => page.evaluate(() => ({
  rows: document.querySelectorAll('#backups-list .backup-list-item').length,
  selected: document.querySelector('#backups-list .backup-list-item.selected')?.dataset.backupFile,
  listButtons: document.querySelectorAll('#backups-list button:not(.row-menu-btn)').length,
  detailButtons: Array.from(document.querySelectorAll('#backups-detail button')).map((b) => b.textContent),
  preview: document.querySelector('#backups-detail .backup-preview')?.textContent || '',
}));
let b = await backups();
record('backups are compact rows beside one detail pane', b.rows > 0 && b.selected && b.listButtons === 0 && b.detailButtons.includes('RESTORE') && b.detailButtons.includes('DELETE'), JSON.stringify({ ...b, preview: b.preview.slice(0, 60) }));
record('the detail shows the restore preview inline', /CHANNELS/.test(b.preview), b.preview.slice(0, 120));
await page.screenshot({ path: path.join('test/screenshots', 'backups-list-detail.png') });
if (b.rows > 1) {
  const second = await page.evaluate(() => document.querySelectorAll('#backups-list .backup-list-item')[1].dataset.backupFile);
  await page.locator('#backups-list .backup-list-item.selected').focus();
  await page.keyboard.press('ArrowDown');
  await wait(1200);
  b = await backups();
  record('ArrowDown selects the next snapshot and re-previews it', b.selected === second && /CHANNELS/.test(b.preview), b.selected);
}

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
