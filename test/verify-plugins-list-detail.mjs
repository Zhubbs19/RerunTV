// Scratch: docs/design/03 step 5 — installed plugins as list + detail.
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
await page.locator('.setup-tab-btn[data-tab="plugins"]').click();
await wait(2000);

const state = () => page.evaluate(() => ({
  rows: document.querySelectorAll('#plugins-list .plugin-entry').length,
  selected: document.querySelector('#plugins-list .plugin-entry.selected')?.dataset.pluginId,
  selectedCount: document.querySelectorAll('#plugins-list .plugin-entry.selected').length,
  rowButtons: document.querySelectorAll('#plugins-list button').length,
  rowCheckboxes: document.querySelectorAll('#plugins-list input[type=checkbox]').length,
  detailName: document.querySelector('#plugins-detail .plugin-detail-heading .plugin-row-name')?.textContent,
  detailHasDetails: !!document.querySelector('#plugins-detail .plugin-row-details'),
  settingsChildren: document.querySelector('#plugins-detail .plugin-settings-panel')?.children.length ?? null,
}));
let s = await state();
record('plugins are compact rows beside one detail pane', s.rows > 0 && s.selectedCount === 1 && s.rowButtons === 0 && s.rowCheckboxes > 0 && s.detailHasDetails && !!s.detailName, JSON.stringify(s));
await page.screenshot({ path: path.join('test/screenshots', 'plugins-list-detail.png') });

// Pick a plugin that has settings and click it.
const withSettings = await page.evaluate(() => Array.from(document.querySelectorAll('#plugins-list .plugin-entry')).find((e) => e.showPluginSettings && !e.classList.contains('selected') && !e.classList.contains('filtered-out'))?.dataset.pluginId);
if (withSettings) {
  await page.locator(`#plugins-list .plugin-entry[data-plugin-id="${withSettings}"] .plugin-row-name`).click();
  await wait(500);
  s = await state();
  record('clicking a plugin shows its settings in the detail pane', s.selected === withSettings && s.settingsChildren > 0, JSON.stringify(s));
  await page.screenshot({ path: path.join('test/screenshots', 'plugins-list-detail-settings.png') });
}

// Keyboard.
await page.locator('#plugins-list .plugin-entry.selected .plugin-row').focus();
const before = (await state()).selected;
await page.keyboard.press('ArrowDown');
await wait(300);
s = await state();
const focusedId = await page.evaluate(() => document.activeElement?.closest('.plugin-entry')?.dataset.pluginId);
record('ArrowDown moves the selection and focus', s.selected !== before && focusedId === s.selected, `${before} -> ${s.selected}`);

// Checkbox still stages a change without changing selection.
const toggled = await page.evaluate(async () => {
  const entry = document.querySelectorAll('#plugins-list .plugin-entry:not(.selected):not(.filtered-out)')[0];
  const box = entry.querySelector('input[type=checkbox]');
  const selected = document.querySelector('#plugins-list .plugin-entry.selected').dataset.pluginId;
  box.click();
  const save = document.getElementById('plugins-save-btn');
  const shown = !save.classList.contains('hidden');
  box.click();
  return { shown, stillSelected: document.querySelector('#plugins-list .plugin-entry.selected').dataset.pluginId === selected, hiddenAgain: save.classList.contains('hidden') };
});
record('the enable checkbox stages a change and leaves the selection alone', toggled.shown && toggled.stillSelected && toggled.hiddenAgain, JSON.stringify(toggled));

// Filtering the selection away selects what's shown.
const filtered = await page.evaluate(async () => {
  const input = document.getElementById('plugins-filter-input');
  const other = Array.from(document.querySelectorAll('#plugins-list .plugin-entry:not(.selected):not(.filtered-out)')).pop();
  input.value = other.dataset.pluginId;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const selected = document.querySelector('#plugins-list .plugin-entry.selected')?.dataset.pluginId;
  const detailId = document.querySelector('#plugins-detail .plugin-detail') === other.pluginDetail;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return { want: other.dataset.pluginId, selected, detailId };
});
record('filtering away the selection selects a shown plugin', filtered.selected === filtered.want && filtered.detailId, JSON.stringify(filtered));

// RESCAN keeps the selection.
const keep = (await state()).selected;
await page.locator('#plugins-rescan-btn').click();
await wait(1500);
s = await state();
record('RESCAN keeps the selected plugin', s.selected === keep, `${keep} -> ${s.selected}`);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
