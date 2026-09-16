// Scratch: docs/design/03 §5.4 — empty collections show one sentence and one action that works.
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
const emptyIn = (sel) => page.evaluate((q) => {
  const el = document.querySelector(`${q} .empty-state`);
  return el ? { text: el.querySelector('.empty-state-text')?.textContent, action: el.querySelector('.empty-state-action')?.textContent, visible: el.offsetParent !== null } : null;
}, sel);

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

// Channels: a filter with no matches, then its CLEAR FILTER.
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await page.locator('#channel-filter').fill('zzzz-nothing');
await wait(400);
let e = await emptyIn('#channel-list');
record('channels: no-match filter shows a sentence and CLEAR FILTER', e && e.action === 'CLEAR FILTER' && /No channels match/.test(e.text), JSON.stringify(e));
await page.locator('#channel-list .empty-state-action').click();
await wait(400);
record('CLEAR FILTER brings the channels back', await page.evaluate(() => document.querySelectorAll('#channel-list-pane .channel-list-item').length > 1 && document.getElementById('channel-filter').value === ''));

// Pool: search with no matches, then CLEAR FILTERS.
await page.locator('.setup-tab-btn[data-tab="programming"]').click();
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="pool"]').click();
await page.locator('#interstitials-search').fill('zzzz-nothing');
await wait(400);
e = await emptyIn('#interstitials-list');
record('pool: no matches shows CLEAR FILTERS', e && e.action === 'CLEAR FILTERS', JSON.stringify(e));
await page.locator('#interstitials-list .empty-state-action').click();
await wait(400);
record('CLEAR FILTERS brings the entries back', await page.evaluate(() => document.querySelectorAll('#interstitials-list .interstitial-card').length > 0 && document.getElementById('interstitials-search').value === ''));

// Presets: search with no matches.
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="presets"]').click();
await page.locator('#presets-search').fill('zzzz-nothing');
await wait(400);
e = await emptyIn('#presets-list');
record('presets: no matches shows CLEAR SEARCH', e && e.action === 'CLEAR SEARCH', JSON.stringify(e));
await page.locator('#presets-list .empty-state-action').click();
await wait(300);

// Flows: a new flow has no steps; + SHOW SEGMENT adds one.
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="flows"]').click();
await wait(300);
await page.locator('#flow-create-btn').click();
await wait(600);
// + NEW FLOW starts from a template, so empty the new flow's steps (throwaway config).
await page.evaluate(async () => {
  const flows = window.S.config.interstitials.flows;
  flows[flows.length - 1].steps = [];
  (await import('app://bundle/renderer/js/setup/flowbuilder.js')).renderFlowsList();
});
await wait(300);
e = await emptyIn('#flow-timeline-canvas');
record('a new flow shows a sentence and + SHOW SEGMENT', e && e.action === '+ SHOW SEGMENT', JSON.stringify(e));
if (e) {
  await page.locator('#flow-timeline-canvas .empty-state-action').click();
  await wait(400);
  record('+ SHOW SEGMENT adds the first step', await page.evaluate(() => !document.querySelector('#flow-timeline-canvas .empty-state') && document.querySelectorAll('#flow-timeline-canvas [class*="flow-step"]').length > 0));
}

// Backups can't be emptied from the page (window.api is frozen by the preload),
// so check the helper the empty backups list uses.
const helper = await page.evaluate(async () => {
  const { emptyState } = await import('app://bundle/renderer/js/setup/util.js');
  let ran = false;
  const el = emptyState('Nothing here.', { label: 'DO IT', run: () => { ran = true; } });
  el.querySelector('button').click();
  return { cls: el.className, text: el.querySelector('p').textContent, ran };
});
record('emptyState builds one sentence and a working primary action', helper.ran && helper.text === 'Nothing here.' && /empty-state/.test(helper.cls), JSON.stringify(helper));

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
