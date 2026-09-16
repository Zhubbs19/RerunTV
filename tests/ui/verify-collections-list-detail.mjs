// Scratch: docs/design/03 step 5 — ad pool and presets as list + detail.
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
await page.locator('.setup-tab-btn[data-tab="programming"]').click();
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="pool"]').click();
await wait(800);

const pool = () => page.evaluate(() => ({
  rows: document.querySelectorAll('#interstitials-list .interstitial-card').length,
  openInList: document.querySelectorAll('#interstitials-list .interstitial-card.open').length,
  selected: document.querySelector('#interstitials-list .interstitial-card.selected')?.dataset.itemId,
  detail: document.querySelector('#interstitials-detail .interstitial-card.open')?.dataset.itemId,
  detailHasEditor: !!document.querySelector('#interstitials-detail .interstitial-card-body select'),
  poolSize: window.S.config.interstitials.pool.length,
  expandAll: !!document.getElementById('interstitials-expand-all-btn'),
}));

let p = await pool();
record('the pool is a list of summaries beside one editor (the selection)', p.rows > 0 && p.openInList === 0 && p.selected && p.selected === p.detail && p.detailHasEditor && !p.expandAll, JSON.stringify(p));
await page.screenshot({ path: path.join('tests/ui/screenshots', 'pool-list-detail.png') });

const third = await page.evaluate(() => document.querySelectorAll('#interstitials-list .interstitial-card')[2]?.dataset.itemId);
await page.locator(`#interstitials-list .interstitial-card[data-item-id="${third}"] .interstitial-card-summary`).click();
await wait(300);
p = await pool();
record('clicking an entry shows its editor', p.detail === third && p.selected === third, p.detail);

// Editing in the detail pane saves and updates the list summary.
const weightBefore = await page.evaluate((id) => window.S.config.interstitials.pool.find((e) => e.id === id).weight || 1, third);
await page.evaluate(() => {
  const input = document.querySelector('#interstitials-detail input[title="How often this entry is picked relative to others"]');
  input.value = '7';
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await wait(300);
const edited = await page.evaluate((id) => ({ weight: window.S.config.interstitials.pool.find((e) => e.id === id).weight, summary: document.querySelector(`#interstitials-list .interstitial-card[data-item-id="${id}"] .interstitial-card-meta`)?.textContent }), third);
record('editing in the detail pane saves and the list row reflects it', edited.weight === 7 && /WT 7/.test(edited.summary || ''), JSON.stringify(edited));
await page.evaluate(async (w) => { const st = await import('app://bundle/renderer/js/core/state.js'); st.performUndo(); }, weightBefore);

// A filter that hides the selection moves it to what's shown.
const hidden = await page.evaluate(async () => {
  const typeSel = document.getElementById('interstitials-filter-type');
  const selectedType = window.S.config.interstitials.pool.find((e) => e.id === document.querySelector('#interstitials-list .interstitial-card.selected').dataset.itemId).type;
  const other = Array.from(typeSel.options).map((o) => o.value).find((v) => v !== 'any' && v !== selectedType && window.S.config.interstitials.pool.some((e) => e.type === v));
  if (!other) return { skipped: true };
  typeSel.value = other;
  typeSel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const detailId = document.querySelector('#interstitials-detail .interstitial-card')?.dataset.itemId;
  const detailType = window.S.config.interstitials.pool.find((e) => e.id === detailId)?.type;
  typeSel.value = 'any';
  typeSel.dispatchEvent(new Event('change', { bubbles: true }));
  return { other, detailType };
});
record('filtering away the selection selects an entry the filter shows', hidden.skipped || hidden.detailType === hidden.other, JSON.stringify(hidden));

// Add selects the new entry; remove (with undo) keeps a valid selection.
await page.locator('#interstitials-add-entry-btn').click();
await wait(400);
p = await pool();
const newest = await page.evaluate(() => window.S.config.interstitials.pool[window.S.config.interstitials.pool.length - 1].id);
record('+ ADD ENTRY selects the new entry', p.detail === newest, p.detail);
await page.locator('#interstitials-detail .interstitial-card-summary .remove-btn').click();
await wait(300);
const confirm = page.locator('.confirm-dialog button', { hasText: /REMOVE|OK|CONFIRM|YES/ }).last();
if (await confirm.count()) await confirm.click();
await wait(500);
p = await pool();
record('removing it from the detail pane keeps a valid selection', !!p.detail && p.detail !== newest && p.poolSize === p.poolSize, `now ${p.detail}`);

// Presets.
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="presets"]').click();
await wait(500);
const presets = await page.evaluate(() => ({
  rows: document.querySelectorAll('#presets-list .interstitial-card').length,
  openInList: document.querySelectorAll('#presets-list .interstitial-card.open').length,
  selected: document.querySelector('#presets-list .interstitial-card.selected')?.dataset.itemId,
  detail: document.querySelector('#presets-detail .interstitial-card.open')?.dataset.itemId,
  editor: !!document.querySelector('#presets-detail input[placeholder="e.g. 30-MIN CARTOON, 2 EPS"]'),
  expandAll: !!document.getElementById('presets-expand-all-btn'),
}));
record('presets are a list beside the selected preset\'s editor', presets.rows > 0 && presets.openInList === 0 && presets.selected === presets.detail && presets.editor && !presets.expandAll, JSON.stringify(presets));
await page.screenshot({ path: path.join('tests/ui/screenshots', 'presets-list-detail.png') });

// Keyboard: Enter on a focused summary selects it.
const secondPreset = await page.evaluate(() => document.querySelectorAll('#presets-list .interstitial-card')[1]?.dataset.itemId);
if (secondPreset) {
  await page.locator(`#presets-list .interstitial-card[data-item-id="${secondPreset}"] .interstitial-card-summary`).focus();
  await page.keyboard.press('Enter');
  await wait(300);
  const kb = await page.evaluate(() => document.querySelector('#presets-detail .interstitial-card')?.dataset.itemId);
  record('Enter on a focused preset selects it', kb === secondPreset, kb);
}

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
